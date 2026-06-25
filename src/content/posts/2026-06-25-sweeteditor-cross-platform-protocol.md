---
title: "SweetEditor 跨平台协议：从手写桥接到生成式 CoreProtocol"
date: "2026-06-25T13:00:00.000+08:00"
path: "2026/06/25/sweeteditor-cross-platform-protocol/"
tags: ["心得", "SweetEditor", "协议", "跨平台"]
description: "记录 SweetEditor 从平台手写桥接到生成式 CoreProtocol 的过程，以及公共模型如何减少跨平台语义漂移。"
---

SweetEditor 做到多个平台以后，最早让我不舒服的地方出现在加能力的过程里：C++ 到 Java、Swift、ArkTS、C#、Dart 的调用还能封装，平台之间的细小漂移更难控制。

一个字段在 C++ 里叫 `visibleLineRange`，到某个平台上可能变成两个裸 `int`；一个 `RangeEffectRenderItem` 在 Core 里已经带着最终 `rect`，到平台 renderer 里又被人从 document range 反推了一次；一个 enum 在 Android 加了 fallback，WinForms 还停留在旧名字；一个 batch payload 里字符串到底按 UTF-8 还是平台字符串传，短期都能跑，长期都会变成问题。

这些问题不会在第一天就炸出来。它们通常是某个平台修了一个 bug，另一个平台没有；某个平台为了赶一个 demo 私下加了字段，协议生成器不知道；某个结构体里的字段顺序被改了，只有一个平台的 decoder 还按旧顺序读。等到编辑器能力开始叠加 IME、folding、inlay、diagnostic、linked editing、selection handle 以后，这种漂移就会从普通平台差异升级成长期维护成本。

SweetEditor 后来把跨平台协议收成 `CoreProtocol`，直接原因就是手写对齐已经压不住这类问题。
<!--more-->

![SweetEditor CoreProtocol 生成流程](/2026/06/25/sweeteditor-cross-platform-protocol/protocol-generation-flow.svg)

## 手写协议最先暴露的是漂移问题

跨平台编辑器里有两类数据很容易被低估。

第一类是看起来很简单的公共模型，比如 `Position`、`Range`、`TextChange`、`VisibleLineRange`。这些类型字段少，但出现频率高。一旦不同平台对起止列、闭开区间、UTF-8/UTF-16 column、空 range 的含义理解不一样，后面的 selection、diagnostic、IME、completion 都会跟着偏。

第二类是很大的渲染模型，比如 `EditorRenderModel`。它里面有可见视觉行、`VisualRun`、range effect、光标、选区手柄、gutter icon、fold marker、scrollbar 等结构。它不是一个适合靠 getter 慢慢取的对象，也不适合每个平台手写一套解码规则。

早期如果每个平台都靠自己的桥接层解释这些结构，短期确实更快。Android 可以按 JNI 的习惯写 Java class，Apple 可以按 Swift struct 写，OHOS 可以按 ArkTS object 写，WinForms 可以按 C# record 写。但这样做会把同一个事实复制到很多地方。

比如 `TextChangeKind` 增加一种来源，Core 需要知道，Provider 需要知道，平台事件也需要知道。再比如 `RangeEffectRenderItem.rect` 被定义成最终几何以后，所有 renderer 都必须遵守“直接画这个 rect，不从 range 反推”的规则。只要有一个平台没有跟上，视觉行为就会开始分叉。

真正麻烦的地方在于，这些分叉往往不是编译错误。它们会表现成某个平台某个输入法下 selection 位置不对，某个折叠场景 diagnostic 下划线少一段，某个横向滚动下长行高亮错位。排查时你先怀疑 renderer，再怀疑 layout，最后才发现只是协议语义漂了。

## 平台实现标准先写出协议语义

在生成器变得重要之前，SweetEditor 先需要一份平台实现标准。

标准文档做的事情很具体：平台必须使用生成出来的 `CoreProtocol`；公共类型不能私下定义二进制 schema；Core 已经给出的字段不能被平台重新解释；装饰、补全、链接、折叠、IME 等能力进入平台时，要遵守同一套模型边界。

这类标准看起来像文档工作，实际上是在给协议定语义。协议如果只描述“字段怎么传”，但不描述“字段代表什么、平台能不能重新解释、什么时候允许覆盖”，那它只能解决编解码问题，解决不了平台漂移。

举个例子，range effect 的标准里要求平台 renderer 使用 Core 输出的 rect。这个约束并不复杂，但它让“最终几何由谁决定”变成协议语义，而不是某个平台 renderer 的实现习惯。

所以 SweetEditor 的平台标准关注的是不能越界的协议语义。平台可以选择自己的原生绘制 API，可以有自己的生命周期和事件系统，但不能私下改 Core 已经定义好的编辑语义。

## 协议源最后回到 C++ 类型标注

真正开始收敛以后，SweetEditor 把协议源放回 C++ 头文件里。

`tools/se_protocol_gen/config.yml` 会读取 `foundation.h`、`editor_types.h`、`gesture.h`、`ime_types.h`、`linked_editing.h`、`search.h`、`editor_core.h`、`decoration.h`、`visual.h`、`protocol.h` 等输入，然后生成 Android、Swing、OHOS、Apple、WinForms、Avalonia、Dart 这些目标语言的协议代码。

C++ 作为源头有几个实际好处。

公共模型本来就由 Core 使用，协议标注贴着真实类型走，不需要再维护一份外部 IDL。结构体字段、enum、payload 类型一旦变化，生成器能立刻看到。平台新增能力时，流程也会变得更直：

```text
C++ 类型和 API
  -> 协议 schema
  -> generated CoreProtocol
  -> 平台 wrapper / renderer / manager
  -> 平台实现标准补齐语义
```

这条链路还有一个现实价值：它强迫所有平台一次性面对新增字段。以前某个平台没跟上，可能只是运行时某个功能缺失；现在协议生成后，类型层面、decoder 层面、golden 层面会更早暴露出遗漏。

当然，C++ 头文件不是天然适合作 IDL。SweetEditor 需要用 `SE_PROTOCOL_*` 这类宏把哪些类型进入协议、哪些 payload 需要生成、哪些字段需要特殊处理标出来。这个方案不算最优雅，但它贴近现有 Core，改动成本也比较可控。

## 生成器做的不只是复制字段

如果协议生成器只是把 C++ struct 复制成 Java class 或 C# class，它的价值其实不大。SweetEditor 这里更重要的是 schema 层的校验和跨语言约束。

生成器需要理解 enum、struct、vector、optional、map-like entry、字符串、数值宽度和 payload 域。C++ 里的 `size_t` 不能直接照搬到所有语言里，平台侧要有明确的 wire 类型。字符串要统一编码。enum 要考虑未知值 fallback。结构体字段顺序要稳定。二进制 reader/writer 要在所有语言里保持一致。

这也是为什么生成器里会有 snapshot 和 golden 之类的检查。跨平台协议最怕“我觉得这次只是改了一个字段名”。对平台层来说，只要 wire format 或语义变了，就是协议变化。生成器把变化显性化以后，至少可以让这些变化在提交阶段就被看见。

还有一个容易忽略的点：生成代码本身也是文档。平台开发者打开 Android 的 `CoreProtocol`、OHOS 的 `CoreProtocol.ets`、Apple 的 Swift 模型、WinForms 的 C# decoder，看到的是同一套结构，只是语言表达不同。这比每个平台各写一份“看起来差不多”的模型可靠得多。

## 二进制 payload 让协议落到热路径上

SweetEditor 没有把跨语言传输改成 JSON 或普通对象树，核心原因还是热路径。性能文章里已经讲过调用次数的问题，这里更想看协议形态本身。

`EditorRenderModel` 每一帧都可能产生。它包含的对象数量和可见行、run、range effect 有关。如果用大量跨语言对象、getter、callback 来传，边界成本会被放大。二进制 payload 的好处很直接：Core 一次编码，平台一次拿到连续 buffer，再用生成出来的 reader 解码成本地模型。

输入方向也是同样的逻辑。语法高亮、diagnostic、inlay hint、phantom text、CodeLens、links 这些装饰数据如果逐条跨语言提交，调用次数会非常难看。batch payload 让平台先在本地收集，再一次性写回 Core。

这个设计没有把跨语言成本消灭，只是把成本从很多次小调用变成少数几次大 payload。对协议生成器来说，这也意味着 reader/writer、字段顺序、字符串编码和数值宽度必须保持稳定，不能依赖平台自己的对象布局。

二进制协议的代价也很明确。它没有 JSON 那么容易肉眼调试，字段兼容性需要更谨慎，平台 decoder 必须严格同步。SweetEditor 用生成器和标准文档去承担这部分复杂度，而不是把复杂度留给每个平台的手写桥接层。

## 标准化后的代价

协议标准化以后，开发体验并不是只有变好。

新增一个公共能力时，不能只改 Android demo 或只改某个平台 wrapper。你需要把 C++ 类型、C API、协议宏、生成器、目标语言代码、平台实现标准一起看一遍。某些字段如果只是平台私有 UI 状态，就不应该进协议；某些字段如果影响编辑语义，就不能只放在一个平台里。

这会让早期迭代变慢一点。比如做一个新的 range effect，最省事的写法是先在某个平台 renderer 里画出来。但如果它要参与 selection、hit test、折叠投影、可见区域裁剪，最后还是要回到 Core 模型。越早绕过协议，后面还债越麻烦。

标准化还有一个约束：平台层的自由度被明确限制了。平台可以扩展 UI，可以优化 native draw，可以把控件生命周期写得更贴合系统，但不应该修改协议模型的含义。这个边界有时会让平台代码写起来“不够顺手”，但它换来的是行为一致和后续排查路径清晰。

## 这个协议真正解决什么

现在回头看，`CoreProtocol` 解决的不是“怎么把 C++ 对象传给 Java/C#/Swift”这么单一的问题。它解决的是跨平台编辑器里同一套编辑语义如何被多个平台稳定消费。

Document、Layout、Decoration、IME、Search、Linked Editing 这些能力在 Core 里收敛以后，平台层需要消费的是统一结果，而不是重新发明一套结果。协议生成器把这件事落到类型和二进制格式上，平台实现标准把这件事落到行为边界上。

所以 SweetEditor 的跨平台协议最后变成了两层东西：一层是机器能检查的 generated protocol，一层是人必须遵守的平台实现标准。前者减少字段和编码漂移，后者减少语义和职责漂移。

这套东西肯定还有继续打磨的空间。生成器可以更严格，兼容策略可以更系统，协议调试工具也可以更好。但只要 SweetEditor 继续走多平台路线，协议就不能只是桥接层的附属品。它本身就是架构的一部分。
