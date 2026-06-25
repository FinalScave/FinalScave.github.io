---
title: "SweetEditor 的失败设计记录：哪些统一最终被拆掉"
date: "2026-06-25T18:00:00.000+08:00"
path: "2026/06/25/sweeteditor-failed-unifications/"
tags: ["心得", "SweetEditor", "架构", "复盘"]
description: "复盘 SweetEditor 里几次看似合理的统一设计，如何被 IME、协议、渲染、ActionResult、Provider 和折叠投影等真实问题逼到拆分。"
---

做 SweetEditor 的过程中，我越来越觉得失败设计值得单独记下来。

最终留下来的架构看起来通常比较完整，像是从一开始就知道边界应该怎么切。但真实过程很少这么顺。很多现在看起来明确的边界，都是先做过一个“更统一、更干净”的版本，然后被某个平台、某个交互、某个测试一点点击穿。

如果只记录最后的形态，会丢掉最有价值的部分：为什么当时那种看起来更简单的统一，后来一定要拆掉。

<!--more-->

![SweetEditor 失败统一设计拆分图](/2026/06/25/sweeteditor-failed-unifications/failed-unification-map.svg)

## IME 的统一入口先被拆开

IME 是最典型的一次。

早期模型想得很自然：平台有 composition，Core 也维护 composition；平台 set composing，Core 更新 composition；平台 commit text，Core 提交 composition。这个模型在 Apple 和一部分桌面场景里看起来能跑，因为 marked text 或 composition string 比较接近真实预编辑文本。

Android 很快把这个假设打穿。`setComposingRegion` 很多时候只是系统标记已有文档范围，例如当前词、候选目标词、纠错范围。它可以帮助输入法建立上下文，但它不等于用户正在输入的 preedit，更不等于后续 `commitText` 一定要替换这段范围。

Flutter 又把问题扩大了一层。`TextEditingValue.composing` 在不同平台上的来源不完全一致，Flutter Windows 更接近真实预编辑范围，Flutter Android 往往继承了 Android system mark 的行为。

最后 IME 协议被拆成两类入口：`command` 和 `text_update`。  
语义明确的删除、提交、替换、设置 preedit 走 command；平台已经改完文本状态，Core 需要根据上下文、revision 和窗口差异理解变化时，走 text_update。范围也被拆出角色，`PREEDIT` 和 `SYSTEM_MARK` 不再混在一个 composition 概念里。

这次拆分的意义不只是修 Android。它把“平台发来的事实”和“Core 推导出的编辑语义”分开了。之前的问题就在于平台层和 Core 层都在猜，中间没有明确的事实边界。

## 手写平台模型被生成式协议取代

协议层也经历过类似过程。

一开始各个平台维护自己的模型和编码器，看起来很灵活。Android 有 Java 模型，Apple 有 Swift 模型，Flutter 有 Dart 模型，Avalonia 和 WinForms 有 C# 模型，OHOS 有 ETS 模型。字段命名、枚举、可选值、解码逻辑都能按平台语言习惯来。

问题是 SweetEditor 的协议模型太多了。`EditorRenderModel`、`VisualRun`、`LayoutMetrics`、`ImeSyncSnapshot`、`EditorActionResult`、decorations、gesture、keymap，每一块都在变。只要 Core 改一个字段，就要人工同步多个平台。一个平台忘了更新，另一个平台把 optional 处理错，第三个平台枚举值顺序漂了，编译可能还能过，运行时已经不是同一套协议。

后来的协议收口基本就是这个问题的集中爆发。生成式 `CoreProtocol` 铺到 Android、Apple、Avalonia、Flutter、OHOS、Swing、WinForms，同时删除了大量手写 `ProtocolEncoder/ProtocolDecoder` 和分散模型。

生成式协议并没有让复杂度消失。它只是把复杂度搬到了 schema、generator、snapshot 和 golden fixture 里。  
这比把复杂度分散在七个平台上好，因为协议形状一旦变化，`schema.snapshot.json` 会直接暴露出来。

## 渲染几何不能交给平台重推

渲染层最早也有一个诱人的想法：Core 给平台 source range，平台根据自己的文字系统去算矩形和绘制。

这个想法的问题在普通文本里不明显，到了自动换行、水平裁剪、折叠投影以后就很明显。一个诊断 range 可能被拆成多个视觉段；一个搜索结果可能落在折叠尾部；一个 selection foreground 可能需要把 source text run 切开；一个 link active 状态可能和当前 hover hit target 绑定。

平台如果从 source range 重新推几何，就等于复制一份 Core layout。复制一份还不够，Android、Apple、Swing、WinForms、Flutter、OHOS、Avalonia 每个平台都要复制一份。

所以后来的标准变成：Core 输出最终几何，平台负责画。  
`RangeEffectRenderItem.rect` 是已经考虑 wrap、viewport、fold projection 的屏幕矩形；selection rect、cursor rect、fold marker、gutter icon、scrollbar 也都在 render model 里。平台可以用自己的 Canvas、CoreGraphics、Java2D、GDI+、ArkUI 绘制，但不能重新解释这些 rect 的来源。

这也是 SweetEditor 没有走统一渲染后端的原因之一。统一绘图后端能解决画法一致的问题，但它不能自动解决编辑语义一致。SweetEditor 更需要的是 Core 统一语义，平台保留原生绘制能力。

## Action 副作用不能靠方法名猜

平台层最开始很容易按方法名处理副作用。

比如 `insertText` 大概率需要 text changed，`setSelection` 大概率只需要 repaint，`setFoldRegions` 大概率需要 relayout，`search` 大概率需要 range effect 刷新。这个思路在少量 API 上还能勉强成立，但 API 多起来以后就开始出问题。

同一个调用可能同时影响文本、选区、滚动、折叠、IME sync、render model 和 platform event。IME 尤其麻烦：一次输入操作可能来自用户键盘，也可能来自平台同步；文本真的变了，还是只是 preedit 或 system mark 变了，也要区分。

ActionResult 模型就是在收这个问题。`EditorActionReason` 被拆成 `EditorActionSource` 和 `TextChangeKind`，`TextEditResult` 的 handled 状态也和 content-changing edits 分开。平台收到 `EditorActionResult` 后，应该按 result 里的信息决定是否 dispatch、repaint、relayout、sync IME，而不是按调用了哪个方法去猜。

这个拆分让我后来对 API 的看法变了：方法名只是入口，不能代表结果。  
真实编辑器里，结果应该由 Core 明确返回给平台。

## Provider 能力不能直接塞进 Core

Provider/Manager 这条线看起来不像失败设计，但其实也经历过摇摆。

补全、装饰、诊断、CodeLens、链接、折叠标记、gutter icon 这些能力都带有宿主特征。它们可能来自语言服务，可能来自插件，可能来自平台 app 自己。把这些能力直接塞进 Core，会让 Core 变成一个宿主容器；完全放在平台层，又会让 layout 和 render model 失去统一语义。

最后收出来的是 Provider、Manager 和标准模型三层。

Provider 负责给事实，例如某个 visible range 里有哪些 diagnostics、links、CodeLens、fold regions。Manager 负责缓存、归一化、调整文档编辑后的范围，并把这些事实喂给 layout 和 render composer。Core 对平台暴露标准模型，平台只实现获取数据和绘制结果。

这条线的经验是：宿主能力可以是外部的，但进入编辑器语义前必须变成标准模型。  
否则每个平台都会把“我的语言服务怎么返回数据”混进 layout 里，后面想做跨平台一致性就会很痛苦。

## 折叠不能只理解成隐藏

折叠一开始也很容易被统一成一个简单概念：折叠区域隐藏，起始行显示 placeholder。

后面证明这不够。折叠结束行的尾部文本可能需要显示，显示出来以后还要能被 hit test、选中、搜索、编辑。视觉上它挂在起始行后面，文档上它属于隐藏结束行。

如果折叠只是一组 hidden lines，就解释不了这个状态。  
折叠投影重构之后，`VisualRun` 有了 `source_line`，`TextLayout` 有了 fold tail projection，`EditorCore` 也能判断单行 projected tail edit 是否保持折叠，结构性编辑是否自动展开。

这次拆分和 IME 很像：视觉承载和语义来源被拆开了。  
一个 run 画在哪一行，和它属于哪一行，不能再被假设成同一件事。

## 后来沉淀下来的判断标准

这些失败设计表面上很分散：IME、协议、渲染、ActionResult、Provider、折叠。放在一起看，其实都在修同一个问题：我们太容易把名字相同的东西当成语义相同。

composition 听起来就是预编辑，实际可能只是 system mark。  
range 听起来足够画高亮，实际还缺 wrap、crop、fold projection 后的 final rect。  
method name 听起来能代表副作用，实际结果要看 Core 运行后的 action result。  
visual line 听起来对应一个 logical line，折叠尾部投影以后 source line 可能完全不同。  
平台协议模型听起来只是语言映射，实际每个字段都是跨平台契约。

后来我会先问几个问题：

- 这是平台给出的事实，还是 Core 推导出的语义？
- 这是文档范围，还是屏幕上的最终几何？
- 这是视觉承载位置，还是源文本所有权？
- 这是一次 API 调用，还是调用完成后的真实结果？
- 这个字段会不会需要在所有平台保持完全一致？

只要答案不同，就不要急着统一成一个概念。  
SweetEditor 现在很多看起来多出来的模型，都是这些问题逼出来的。复杂度没有减少，只是从临时判断搬到了协议、测试和标准模型里。

这类复杂度我现在更能接受。它至少是可解释、可测试、可复盘的。
