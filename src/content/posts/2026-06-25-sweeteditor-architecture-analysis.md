---
title: "SweetEditor 架构拆解：Core 管语义，平台管绘制"
date: "2026-06-25T11:00:00.000+08:00"
path: "2026/06/25/sweeteditor-architecture-analysis/"
tags: ["心得", "SweetEditor", "架构", "跨平台"]
description: "拆解 SweetEditor 的 C++ Core、平台桥接、布局、装饰和渲染模型，以及编辑语义和平台绘制之间的边界。"
---

SweetEditor 最早让我反复摇摆的地方，是 C++ Core 到底应该管到哪里。这里的 Core 指 SweetEditor 的编辑器核心，文档、布局、编辑语义和结构化渲染模型都在这一层；渲染后端不属于这里讨论的 Core。决定用 C++ 写 Core 只是起点，真正难的是 Core 和平台层的边界。

如果只是想在几个平台上画出差不多的代码编辑器，把文本内容、光标、选区、滚动都放在平台层，各自实现一份，也不是不能跑。Android 用 `View`，Apple 用 `NSView` / `UIView`，Swing 用 `JComponent`，WinForms 用 `Control`，每个平台都顺着自己的 UI 框架写，短期看起来最直接。

但是一旦进入真正的编辑器语义，事情很快就变了。折叠后的尾部占位符要参与 hit test，selection 要跨自动换行和折叠投影，Inlay Hint 会改变布局宽度，IME preedit 和 system mark 又会影响 range effect，linked editing、undo、diagnostic、search highlight 这些状态还要同时存在。把这些逻辑放在平台层，最后维护的就会变成多个行为略有差异的编辑器，只是表面上长得比较像。

SweetEditor 现在的架构，就是在这个压力下慢慢收出来的：C++ Core 负责编辑语义、文档模型、布局和结构化渲染模型；平台层负责输入桥接、字体测量和原生绘制。

<!--more-->

![SweetEditor Core 与平台层职责拆分](/2026/06/25/sweeteditor-architecture-analysis/core-platform-architecture.svg)

## Core 输出模型，平台负责绘制

SweetEditor 的 Core 有一个很重要的限制：它不依赖 Skia、OpenGL、Metal、CoreGraphics 或 Android Canvas。Core 甚至不直接测量字体宽度，它只通过 `TextMeasurer` 接口向平台询问宽度和字体指标。

这听起来有点绕。很多跨平台 UI 或编辑器项目会倾向于引入一个统一渲染层，这样所有平台画出来的东西天然一致。SweetEditor 走了另一条路：Core 只输出 `EditorRenderModel`，里面是可见视觉行、`VisualRun`、光标、选区手柄、range effect、gutter icon、fold marker、scrollbar 等结构化数据。平台拿到模型后，用自己平台最擅长的文字系统画出来。

这样拆分的收益落在几个具体问题上：

- 文字渲染质量交给平台，Android 继续走 `Canvas + Paint`，Apple 继续走 `CoreText + CoreGraphics`，Swing 走 Java2D，WinForms 走 GDI+，OHOS 走 ArkUI Canvas。
- 编辑行为只保留一份实现，光标移动、选区计算、折叠投影、range effect 几何、IME 状态不需要每个平台重写。
- 单元测试可以绕开 UI，直接测 Document、Layout、Decoration、Interaction、IME。
- 新平台的最小闭环变成“输入转发 + 字体测量 + 解码 render model + 绘制”，而不是重写整个编辑器。

这个选择也有代价。平台层必须实现准确的 `TextMeasurer`，测量和绘制用的字体配置要保持一致。协议层要稳定传输 `EditorRenderModel` 这种复杂结构。平台 renderer 也不能随便从文档 range 重新推几何，否则 Core 已经算好的折叠、自动换行、裁剪和投影关系就会被破坏。

## Document 是编辑语义的底座

`Document` 是 Core 里最底层的文本抽象。现在 SweetEditor 里有 `LineArrayDocument` 和 `PieceTableDocument` 两类实现：前者适合中小文件和按行操作，后者面向大文件和频繁编辑。

这里有一个容易误判的点：SweetEditor 并不是简单的“内部全 UTF-8”或者“内部全 UTF-16”。文档编辑入口主要使用 UTF-8，逻辑行缓存、布局测量和 `VisualRun.text` 使用 UTF-16，跨语言 payload 里的字符串字段又通常编码成 UTF-8。这个混合模型看起来不纯，但它对应的是不同层的现实需求。

文档存储关心编辑和内存；布局层关心平台字体测量和 UTF-16 column；平台协议关心跨语言传输和解码成本。把这几件事强行压成一种编码，反而会把复杂度转移到每一次编辑或每一次渲染上。

`LogicalLine` 里有两个 dirty 标记也很关键：`is_char_dirty` 和 `is_layout_dirty`。编辑发生时，Core 不会立刻把整篇文档重新布局，而是标记受影响的行。真正的字符刷新和布局重建，延迟到 `buildRenderModel()` 时按需执行。

放在架构里看，Core 已经不只是一个简单的文本容器，它还维护了文档、布局和渲染之间的失效关系。

## TextLayout 是最重的 Core 模块

`TextLayout` 做的事情比“把文本排成行”多很多。

它需要把一行里的文本、高亮 span、Inlay Hint、Phantom Text、CodeLens、折叠占位符合并成 `VisualRun`。如果开启自动换行，还要把这些 run 切成多个 `VisualLine`。如果某段代码被折叠，隐藏区域的尾部投影还要继续参与 hit test、selection rect 和编辑映射。

这也是为什么 SweetEditor 后来把 `RangeEffectRenderItem.rect` 定义成最终屏幕几何。selection、search match、document highlight、diagnostic、IME composition、linked editing 这些效果都要经过自动换行、折叠投影、视口裁剪以后才能画出来。平台 renderer 如果拿着原始文档 range 再算一次，必然会在某些场景下和 Core 不一致。

可以把布局层理解成下面这条链：

```text
LogicalLine
  -> VisualRun
  -> VisualLine
  -> visible EditorRenderModel
  -> platform native draw
```

这条链里，平台只消费最后的结果。Core 输出给平台的内容更接近一份已经计算好的绘制事实：这一帧可见区域里，run 和 range effect 几何都已经落定。

## Decoration 必须进入布局语义

代码编辑器里很多东西看起来像“装饰”，但它们会影响布局、命中测试和交互。

语法高亮本身可能只改变颜色，但粗体、斜体会改变测量结果；Inlay Hint 会插入额外宽度；Phantom Text 会显示未提交文本；CodeLens 是虚拟 visual line；折叠区域会隐藏逻辑行并产生占位符；diagnostic、document highlight、linked editing 会进入 range effect 通道。

所以 SweetEditor 把 `DecorationManager` 放在 Core 里，而不是完全丢给平台画。平台或宿主可以通过 `DecorationProvider` 提供装饰数据，但这些数据一旦进入 Core，就会参与统一布局和统一渲染模型。

这个边界很重要。平台可以决定“某种诊断下划线画成什么颜色”，但不能决定“这个 diagnostic range 在自动换行后的第几段可见矩形上”。前者是渲染风格，后者是编辑器几何语义。

## EditorCore 是协调器，不是万能类

`EditorCore` 组合了 `Document`、`TextLayout`、`DecorationManager`、`GestureHandler`、`UndoManager`、`CompositionController`。从外面看，它像是一个非常大的类；但从职责看，它更像是一个协调器。

用户输入进来以后，平台层把手势、键盘、IME、滚动、配置变更转给 Core。Core 修改文档或状态后，返回 `EditorActionResult`。这个结果里有 `contentChanged`、`cursorChanged`、`selectionChanged`、`needsRedraw`、`needsImeSync`、`changes` 等字段，平台根据这些字段派发事件、同步输入法、刷新 UI。

一帧渲染发生时，平台调用 `buildRenderModel()`。Core 在这里刷新 dirty 行、解析可见范围、生成视觉行、计算 cursor 和 selection、生成 guide 和 range effect，然后返回二进制 payload。平台解码后按照自己的绘制系统渲染。

这个闭环大概是：

```text
平台输入
  -> EditorCore
  -> EditorActionResult
  -> 平台事件分发 / IME 同步 / 请求重绘
  -> buildRenderModel()
  -> EditorRenderModel
  -> 平台原生绘制
```

有了这个闭环，平台层不需要理解文档编辑细节，也不需要知道一次操作到底展开了哪些折叠、调整了哪些 decoration、合并了哪些 undo。平台只根据结果字段做平台该做的事情。

## 统一几何，不统一绘制后端

这个问题我其实想过很多次。如果 SweetEditor 自己带一套统一渲染后端，平台层可能会更薄，渲染效果也更容易完全一致。

但代码编辑器的文字渲染和平台文字系统绑得很深。字体 fallback、emoji、合字、系统字体缩放、中文和英文混排、光标高度、输入法候选窗口位置，都会受到平台影响。统一绘制后端可以减少 renderer 工作量，同时也会把字体质量、输入法坐标、无障碍和原生控件集成这些问题带回 SweetEditor 自己身上。

SweetEditor 当前更偏向于统一几何计算，把最终绘制留给平台。Core 负责告诉平台画什么、画在哪里、语义是什么；平台负责用本平台 API 把它画出来。

平台自由度存在，但自由度被限制在 UI 和绘制表达上。只要平台开始重新解释 document range、自动换行或折叠投影，架构边界就会被打穿。

## 架构真正解决的问题

现在回头看，SweetEditor 的架构首先是在解决几个具体维护问题。

如果编辑语义分散在平台层，每个平台都会积累自己的小差异。Android 修一个 IME 行为，Flutter 可能仍然错；WinForms 改一个 selection 绘制，Swing 可能还在旧逻辑；Apple 处理 folded tail，其他平台可能没有同样的 hit test 语义。长期看，这些差异会吞掉所有维护精力。

把 Document、Layout、Decoration、Interaction、IME、Undo 放进 Core，平台差异就被压缩到输入事件、字体测量、二进制协议和原生绘制上。这个边界仍然很难，但它至少让问题可以定位：行为错了优先看 Core，画得不像优先看平台 renderer，数据错了看协议，输入法不一致看 IME 适配。

这个架构还有继续演进的空间。无障碍、Web、更多声明式平台、复杂异步 Provider 生命周期，都还会继续反推边界。但只要 Core 和平台层的分工不乱，SweetEditor 后续加能力时就不会变成每个平台各写一套编辑器。
