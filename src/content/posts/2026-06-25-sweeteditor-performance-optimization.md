---
title: "SweetEditor 性能优化：把 JNI/NAPI 调用压进可见范围"
date: "2026-06-25T12:00:00.000+08:00"
path: "2026/06/25/sweeteditor-performance-optimization/"
tags: ["心得", "SweetEditor", "性能优化", "跨平台"]
description: "记录 SweetEditor 如何通过视口裁剪、增量布局、测量缓存和批量 payload，把跨语言调用控制在可见范围内。"
---

SweetEditor 的性能设计里，有一个看起来很反直觉的点：Core 在 C++ 里，但字体测量会反调平台对象。Android 会从 C++ 通过 JNI 调 Java `TextMeasurer`，OHOS 会从 C++ 通过 NAPI 调 ArkTS 对象，Swing、WinForms、Apple、Flutter 也都有各自的测量回调。

如果只看这个事实，很容易得出一个粗糙结论：跨语言反调肯定慢，编辑器肯定撑不住。

真正写下来以后，我对这个问题的判断反而变得更明确。反调本身确实不是免费操作，尤其是 JNI / NAPI 这种边界，不应该出现在无限放大的热路径里。SweetEditor 的性能路径把这件事拆成可控范围：可见区域、dirty 标记、测量缓存、批量 payload 和平台原生绘制共同决定调用次数，避免每帧扫全文、每个字符都跨语言问一次宽度。

这里主要记录这套性能路径为什么能跑起来，以及它的边界在哪里。

<!--more-->

![SweetEditor 性能路径](/2026/06/25/sweeteditor-performance-optimization/performance-pipeline.svg)

## 第一层：编辑时只标记 dirty

编辑器性能最怕的是小操作牵连整篇文档。

SweetEditor 的 `Document` 里，逻辑行维护了 `is_char_dirty` 和 `is_layout_dirty`。当用户输入一个字符、删除一段文本、应用 decoration 或折叠状态变化时，Core 不会立刻把所有行重新拆分、重新测量、重新生成视觉行。它只会标记受影响的行。

真正的刷新发生在 `EditorCore::buildRenderModel()`。这一步本来就是平台准备绘制下一帧时才会调用的，Core 在这里统一处理 dirty 行、布局、可见范围、光标、selection 和 range effect。

这个设计把性能压力从“每次状态变化立刻重算”改成了“下一帧需要什么就算什么”。如果多次 decoration 更新、滚动、光标变化在同一帧内发生，平台层也可以只触发一次刷新。

## 第二层：布局从可见范围开始收口

`TextLayout::layoutVisibleLines()` 是性能路径里最关键的入口之一。它不会先把全文变成一个完整的视觉行数组再裁剪，而是在解析可见范围的过程中按需布局。

Core 维护行高、前缀 Y 坐标、滚动位置和 viewport。`resolveVisibleLines()` 会先定位第一条可见逻辑行，然后向后扫描。扫描过程中遇到 dirty 行才重新 `layoutLine()`；当累计位置超过 viewport 底部，就可以停止。后面的不可见行不会进入本帧的 `EditorRenderModel`。

在不开自动换行的横向滚动场景里，还会有一层 `cropVisualLineRuns()`。长行里的 `VisualRun` 如果完全在可见区域左侧或右侧，会被移除；如果一段文本 run 横跨可见边界，则会按可见列裁剪，并在裁剪后更新 `column`、`length`、`text` 和 `width`。

这点非常实际。代码编辑器经常有几万行文档，也经常有单行很长的 JSON、日志或压缩代码。如果渲染模型每帧都包含所有行、所有 run、所有 range effect，后面平台再怎么优化也救不回来。

## 第三层：反调平台测量，但结果会缓存

SweetEditor 选择平台原生渲染以后，字体测量必须交给平台。原因很简单：最终谁画字，谁最清楚这段字在当前字体、字号、style、fallback、缩放下有多宽。

Android 的 `TextMeasurer` 持有 `Paint`，测量时走 `Paint.measureText()`；Apple 使用 CoreText；Swing 用和绘制一致的 `Graphics2D` font render context；WinForms 用 GDI+ / TextRenderer；OHOS 用 ArkUI Canvas 的 `measureText()`；Avalonia 和 Flutter 也各自接自己的文字系统。

这个反调如果失控，确实会慢。SweetEditor 做了几层限制：

- 只有布局需要宽度时才测量，非布局路径不会随便问平台。
- `TextLayout` 内部有 `m_text_widths_`，按文本和 font style 缓存测量结果。
- 等宽字体下可以利用固定字符宽度减少重复测量。
- 可见区域外的行不会在本帧生成 run，自然也不会触发本帧测量。
- decoration、inlay、phantom text 等影响布局的内容进入 Core 后，也按 dirty 行和可见范围重算。

所以问题不能简化成“有没有 JNI/NAPI 反调”。真正要看的是反调发生在哪条路径、调用次数能不能被可见范围限制、结果能不能缓存、调用前有没有先用 Core 的 dirty 体系过滤掉不必要的布局。

## 第四层：复杂数据走二进制 payload

跨语言边界还有另一类成本：复杂结构传输。

`EditorRenderModel` 不是一个小对象。它包含可见视觉行、run、range effect、cursor、selection handle、guide segment、gutter icon、fold marker、scrollbar 等数据。如果每个字段都走零散 JNI getter，或者每个 run 都从 C++ 单独返回一次，性能会非常难看。

SweetEditor 的做法是把复杂结果编码成紧凑二进制 payload。C API 的 `editor_build_render_model()` 返回 `const uint8_t* + out_size`，平台侧用生成出来的 `CoreProtocol` 一次解码。Android 虽然是 JNI 直连 C++ 对象，但复杂返回同样走 `ByteBuffer` 和 `CoreProtocol` 解码。

输入方向也类似。比如高亮、diagnostic、inlay hint、phantom text、CodeLens、links 都有 batch API。平台层把多行数据打包成一个 payload，再一次写进 Core，而不是每个 span 都跨语言调一次。

这就是为什么协议生成器和 batch API 不是“工程洁癖”。它们直接影响性能路径。如果平台层频繁做细粒度跨语言调用，那么 Core 再快也会被边界成本吃掉。

## 第五层：慢能力离开同步热路径

SweetEditor 里有 `DecorationProvider` 和 `CompletionProvider` 这类宿主扩展能力。它们天然可能慢：语法高亮、诊断、语义 token、AI 补全、远程服务，都不应该假设在一帧内完成。

从性能角度看，Provider 只需要守住一条线：它可以慢，但不能阻塞输入、滚动和绘制。滚动时请求应优先围绕 `visibleLineRange`，大文件高亮可以先给可见范围结果，再分批补齐；用户已经滚到别处以后，旧结果不能再写回当前 editor。

具体到 Provider、Manager、ApplyMode 怎么组织，平台层能力那篇会展开。放在性能路径里，只需要明确它不能变成同步热路径的一部分。

## 为什么选择平台原生渲染

性能问题里，平台原生渲染和跨语言回调是一组绑定取舍。

如果 SweetEditor 自己带一套统一渲染后端，字体测量可能可以完全留在 C++ 或统一图形栈里，JNI/NAPI 反调会少很多。但这会带来另一批成本：每个平台都要承载同一套渲染 runtime，文字质量、字体 fallback、emoji、输入法候选窗口坐标、系统缩放、无障碍和控件集成都会变得更重。

SweetEditor 选择平台原生渲染，是因为代码编辑器最终还是一个强文字控件。用户关心的是文字清晰、光标位置准、输入法候选框跟得上、滚动手感像本平台。用平台自己的文字系统画字，这些问题更容易贴近系统行为。

为了让这个选择不把性能拖垮，Core 就必须承担更多几何计算：

- Core 解析 selection、search、diagnostic、IME、linked editing 的可见矩形。
- Core 输出已经裁剪过的 `VisualLine` 和 `VisualRun`。
- Core 负责自动换行、折叠投影、hit test 和 cursor 坐标。
- 平台 renderer 只按模型画，不再从文档文本重新推 layout。

所以平台原生渲染在性能上的前提很明确：Core 要提前算好哪些东西该画在哪里，让平台只做它擅长的绘制。

## 反调 JNI/NAPI 为什么还能接受

回到开头那个问题：C++ 反调 Java 或 ArkTS 对象为什么还能快？

我的理解是，SweetEditor 避免了几个最危险的写法。

它没有在每次输入时全量重排文档。编辑只标记 dirty，下一帧按可见范围消费。它没有在每帧把全文传给平台画。`EditorRenderModel` 只包含可见区域。它没有把每个 span、每个 diagnostic 都拆成跨语言调用。复杂输入用 batch payload。它也没有让平台 renderer 重新计算 Core 已经给出的 range effect 几何。

反调平台测量仍然存在，但它被压在“可见 + dirty + 缓存”的范围内。对于代码编辑器，这个范围通常是几十行，而不是整篇文档。只要平台层不绕开这套路径，JNI/NAPI 的成本就不会自然膨胀到不可控。

当然，这个设计不是无条件快。如果一个 Provider 每次滚动都扫全文；如果平台每帧强制清空测量缓存；如果 renderer 忽略可见模型重新计算所有 range；如果每个 decoration 都走单独 native call，性能会很快掉下去。SweetEditor 的性能来自一组约束同时成立，而不是某一个技术点本身神奇。

## 后面还可以继续优化什么

现在的路径已经能支撑 SweetEditor 的主要场景，但还有不少可以继续推的地方。

比如更细的测量缓存失效策略，避免字体或 scale 变化时做过多清理；更稳定的长行分段缓存，减少横向滚动时的重复裁剪；Provider 侧更明确的大文档策略，区分可见范围快速结果和后台全量结果；平台 renderer 继续合并相邻 run，减少 draw call 和文本 layout 对象创建。

这些优化都要守住同一个边界：Core 负责统一几何和编辑语义，平台负责原生测量和绘制。性能问题不能靠打破边界来解决，否则短期快一点，后面会在跨平台一致性上还回来。
