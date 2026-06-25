---
title: "SweetEditor 平台层能力设计：Provider、Manager 和标准模型"
date: "2026-06-25T14:00:00.000+08:00"
path: "2026/06/25/sweeteditor-platform-capabilities/"
tags: ["心得", "SweetEditor", "平台层", "扩展设计"]
description: "记录 SweetEditor 平台层如何通过 Provider、Manager 和标准模型承接宿主扩展，同时避免平台扩展侵入 Core 布局和编辑语义。"
---

SweetEditor 把 Document、Layout、Decoration、IME、Undo 这些编辑语义尽量收到 C++ Core 以后，平台层并没有因此变成很薄的一层壳。

这点其实很容易误判。做跨平台架构时，很多人会自然追求“平台越薄越好”。但代码编辑器不是一个只负责显示文本的控件。语法高亮、diagnostic、inlay hint、phantom text、CodeLens、链接、补全、右键菜单、键盘映射、图标、主题、宿主 metadata，这些能力都要和平台、应用宿主、语言服务、甚至 AI 服务发生关系。

如果这些能力全部塞进 Core，C++ Core 会逐渐变成一个 IDE runtime。它需要知道语言服务、项目系统、异步任务、主题资源、图标资源、菜单模型、平台生命周期。这个方向看起来统一，实际上会把 Core 拖得非常重。

如果这些能力全部留在平台层，各平台又会开始重新理解编辑器几何和编辑语义。某个平台的 inlay hint 会影响测量，另一个平台只把它当 overlay 画；某个平台的 diagnostic 下划线走 Core range effect，另一个平台自己根据 range 算 rect；补全接受后有的平台走 `TextEdit`，有的平台根据 word range 猜替换区间。最后还是会回到多套编辑器的问题。

SweetEditor 平台层能力设计的重点，就是让宿主能力留在平台和应用侧，但写回 Core 的结果必须变成标准模型。
<!--more-->

![SweetEditor 平台 Provider 能力流转](/2026/06/25/sweeteditor-platform-capabilities/platform-provider-flow.svg)

## 平台层能力的边界

现在的 SweetEditor 平台层大致可以分成几块。

控件本身负责接入平台 UI 生命周期，比如 Android 的 `View`、Apple 的 `NSView` / `UIView`、Swing 的 `JComponent`、WinForms 的 `Control`、OHOS 的 ArkUI 组件。它们要处理焦点、尺寸、滚动、输入事件、重绘请求和资源释放。

桥接层负责把平台事件转成 Core 能理解的调用，再把 Core 返回的 `EditorActionResult`、`EditorRenderModel`、IME 同步信息、光标状态、selection 状态转回平台事件。

Renderer 负责原生绘制。它消费 Core 输出的视觉模型，用当前平台的文字系统和图形 API 画出文本、选区、range effect、gutter、fold marker、scrollbar 等元素。

Provider Manager 则是平台层最容易被低估的一块。它负责接住宿主提供的能力，比如 `DecorationProvider`、`CompletionProvider`、图标 provider、metadata、主题和语言配置。Provider 的结果不能直接改 renderer，也不能绕过 Core 改布局；它必须经过标准模型写回 Core，再由 Core 统一参与下一次布局和渲染模型生成。

这个边界让平台层既不是纯壳，也不是第二个 Core。平台层可以接入外部世界，但不能重新定义编辑器语义。

## DecorationProvider 为什么放在平台层

`DecorationProvider` 很适合放在平台层，因为 decoration 的来源通常不在 Core 里。

语法高亮可能来自 SweetLine，也可能来自平台宿主已有的 tokenizer。diagnostic 可能来自语言服务。inlay hint 可能来自 LSP、编译器或 AI 分析。CodeLens、链接、document highlight、fold range，也都可能依赖项目上下文、文件类型、用户设置和异步服务。

这些东西强行放进 C++ Core，会让 Core 依赖太多外部系统。Core 最应该知道的是 decoration 进入编辑器以后会怎样影响布局、命中测试和渲染，而不是 decoration 从哪里来。

所以平台层提供 provider，Core 消费标准 decoration。这个方向解决了两个问题。

宿主仍然可以按自己的方式生产数据。Android demo 可以接 SweetLine，桌面端可以接本地语言服务，未来也可以接远程分析或 AI 服务。只要最终变成 SweetEditor 的 `LineSpan`、`RangeEffect`、`InlayHint`、`PhantomText`、`CodeLens`、`Link` 等模型，Core 就能统一处理。

同时，影响布局和几何的部分不会留在平台 renderer 里。inlay hint 的宽度、phantom text 的位置、fold placeholder 的投影、diagnostic underline 的 rect，最后都由 Core 的 layout/render model 统筹。平台 renderer 只负责画，不负责重新解释它们。

## visibleLineRange 是 Provider 的输入边界

Provider 如果没有范围约束，很容易变成一个看似平台扩展、实际拖住编辑器状态的入口。

一个大文件滚动时，语法高亮或 diagnostic 不应该每次都扫描全文。SweetEditor 给 provider 的上下文里有 `visibleLineRange`、`totalLineCount`、`textChanges`、`languageConfiguration`、`editorMetadata` 等信息，就是为了让 provider 先回答当前视口最需要的东西。

这不是说 provider 永远只能处理可见区域。某些能力确实需要全量分析，比如全文件 symbol、跨行 diagnostic、语义高亮缓存。但它们进入编辑器热路径时，仍然应该有可见区优先策略。用户正在看的几十行应该先回来，远处的结果可以异步补齐。

`visibleLineRange` 在这里更像是一条能力边界：Provider 可以有全量上下文，但它提交给编辑器的结果要知道自己服务的是哪段文档。这样 Manager 才能判断结果是否过期，Core 也不用接收一批和当前视口完全无关的临时装饰。

## Receiver 和 generation 是异步安全阀

Provider 不可能都同步完成。语义高亮、diagnostic、AI 补全、远程服务都有可能慢，也都有可能在返回时已经过期。

SweetEditor 平台实现标准里要求 provider manager 处理 stale/cancel。一次 decoration 请求发出以后，用户可能继续输入、滚动、切换文件、销毁 editor。旧请求返回时，如果还把结果写回当前 Core，就会污染新状态。

所以平台层需要 generation 或类似机制。每次请求带着当前 editor 状态的标识，返回时先判断是不是仍然有效。无效结果直接丢掉，有效结果再按 apply mode 写回 Core。

这件事放在平台层是合理的。Core 不应该知道平台的线程模型、Promise、Coroutine、Task、Handler、Dispatcher、生命周期回调。但 Core 需要保证一旦平台提交的是有效标准模型，它能稳定地合并和渲染。

这里的边界也很清楚：异步调度属于平台层，编辑语义落点属于 Core。

## ApplyMode 控制写回语义

`DecorationProvider` 不是简单地返回一堆 decoration 就结束了。结果怎么写回 Core，同样需要语义。

`MERGE` 表示在已有 decoration 上追加或合并，适合多个 provider 同时提供不同类型的装饰。`REPLACE_ALL` 表示某一类结果由当前 provider 全量负责，适合语法高亮这类需要整体替换的场景。`REPLACE_RANGE` 表示只替换某个范围内的结果，适合可见区域或分块计算。

如果没有 apply mode，平台层通常会走向两种坏结果。要么每次 provider 返回都粗暴清空全部 decoration，造成闪烁和不必要的重布局；要么一直追加，旧结果残留在文档里，滚动和编辑后出现幽灵高亮。

ApplyMode 把“结果如何覆盖旧状态”显性化以后，manager 就可以统一做合并，再通过 batch API 写回 Core。平台不会因为 provider 的实现方式不同而改变 Core 内部 decoration 的生命周期。

这也是 Provider-Manager 模式的价值。Provider 只生产结果，Manager 处理并发、过期、合并、批量提交和生命周期。否则每个 provider 都要理解 Core 的写回细节，后面很难维护。

## CompletionProvider 和 TextEdit 的替换边界

补全比 decoration 更容易暴露平台层边界。

一个 completion item 可能有 `label`、`insertText`、`textEdit`、`additionalTextEdits`。平台 UI 展示时关心 label、icon、detail、documentation；真正接受补全时，Core 或平台写回编辑操作关心的是替换范围和插入文本。

这里最危险的写法，是平台根据当前 word range 自己猜替换区间。英文变量名可能还能跑，遇到中文、emoji、snake case、member access、IME composition、snippet、已选中文本、多光标，猜出来的 range 很容易不对。

SweetEditor 更倾向于让 `textEdit` 成为最明确的替换语义。Completion item 如果提供了 `textEdit`，接受时就按它的 range 和 newText 执行；没有 `textEdit` 时，再退回 `insertText` 或 `label`。`additionalTextEdits` 也要作为独立编辑集合提交，而不是让平台 UI 自己拼字符串。

这个设计和 IME 文章里拆 command/text_update 的方向很像：平台可以负责交互和展示，但文本变化本身要变成明确的编辑语义。只要替换范围是猜的，跨平台一致性就会开始松动。

## 平台层厚在集成，薄在语义

SweetEditor 的平台层需要做很多事情：原生绘制、输入事件、IME 桥接、候选窗口坐标、右键菜单、selection handle、滚动条、主题资源、图标资源、provider 生命周期、异步调度、宿主 metadata、补全弹窗。这些能力如果都想塞进 Core，Core 会背上大量和编辑语义无关的环境知识。

但平台层也不能厚到重新实现编辑器。凡是会影响 document、layout、range geometry、undo、IME composition、selection、text edit 的东西，最终都要回到 Core 的标准模型。平台层厚在系统集成和宿主能力上，薄在编辑语义上。

## 后续边界

这套平台能力设计还有不少地方会继续被真实需求推着走。

比如无障碍还会要求平台暴露更细的语义树；Web 平台如果加入，事件模型和文字系统又会带来新的限制；更复杂的 AI provider 可能需要流式返回 decoration 或 completion；大型文件场景下，provider 还需要更明确的取消、降级和缓存策略。

但我觉得主线已经比较清楚：Provider 可以来自平台和宿主，结果必须归一到 Core 能理解的模型；平台负责生命周期和原生体验，Core 负责布局、几何和编辑语义。这个边界守住以后，SweetEditor 才能继续加能力，而不是在每个平台上各自长出一套插件系统和编辑器行为。
