---
title: "SweetEditor 测试体系：跨平台编辑器怎么证明行为一致"
date: "2026-06-25T17:00:00.000+08:00"
path: "2026/06/25/sweeteditor-testing-consistency/"
tags: ["心得", "SweetEditor", "测试", "跨平台"]
description: "记录 SweetEditor 如何用 Core 单元测试、布局映射测试、编辑语义测试、协议快照和平台实现标准，证明跨平台编辑行为保持一致。"
---

跨平台编辑器最怕的一种状态，是每个平台的 demo 看起来都能跑，但没人能证明它们真的是同一个编辑器。

SweetEditor 前期也经常掉进这个状态。Android 上修了一个输入问题，Flutter Android 又冒出来；折叠在普通展示里正常，到了搜索高亮就不见了；CodeLens 只是加了一条虚拟行，结果选区手柄跨过去的时候边界错了。  
这些问题靠肉眼跑 demo 能发现一部分，但很难防止以后再次退回去。

所以我现在越来越倾向于把测试看成设计的一部分。它的价值不在覆盖率数字，而在把那些曾经击穿模型的边界固定下来。

<!--more-->

![SweetEditor 一致性测试闭环](/2026/06/25/sweeteditor-testing-consistency/testing-consistency-loop.svg)

## Core 行为必须先稳定

SweetEditor 的跨平台一致性，核心不在平台 UI 测试，而在 C++ Core 的行为测试。

原因很简单：文档编辑、layout、hit test、selection、folding、search、range effect、IME 状态这些东西，最终都应该由 Core 决定。平台层当然需要测试桥接和绘制，但如果 Core 行为没有先被固定，平台测试很容易变成“每个平台都用自己的方式把错行为稳定下来”。

`tests/CMakeLists.txt` 里现在把 `tests/core` 和 `tests/c_api` 都接到 `unit_tests`，再通过 Catch2 跑。这个测试层绕开了 UI 框架，可以直接构造 `EditorCore`、`TextLayout`、`Document`、decorations 和 render model。

这类测试的价值，是能把一个 bug 压成很小的输入输出。  
比如“折叠尾部输入分号后应该保持折叠”就不需要打开任何平台 demo，直接构造文档、设置 fold region、移动光标、插入文本，然后检查文档内容、隐藏状态和光标位置。

## 坐标测试不能只看截图

布局和坐标是最适合用单元测试打穿的部分。

`tests/core/layout/layout_mapping.cpp` 里有一组测试专门证明 `hitTestPointer` 和 `getPositionScreenCoord` 在不同布局模式下能互相对上。非 wrap 模式要测，wrap 模式也要测；水平裁剪以后要测；emoji modifier 这类 grapheme 不能被拆开；CodeLens 虚拟行不能把 line start 抢走；link hit 要能根据 canonical start column 找回目标。

这些测试比截图稳定。截图只能告诉你“看起来差不多”，但它不一定能证明点击某个像素会回到正确文档位置。编辑器坐标系统真正重要的是反向语义：用户点一下、拖一下、长按一下，Core 收到的 range 是否正确。

这里最典型的是折叠尾部测试。`TextLayout maps collapsed fold tail runs to their source line` 会验证 projected run 的 `source_line`，再检查屏幕坐标和 hit test 结果都回到隐藏源行。  
这个测试一旦在，就能防住很多看似无关的改动：改了 run 裁剪、改了 link hit、改了 selection rect，都不能顺手把 fold tail 的 source ownership 弄丢。

## 编辑测试要检查副作用

编辑测试如果只检查文档字符串，很容易漏掉真正的问题。

一次编辑会改变的不只是文本。它还可能改变 fold state、selection、cursor、undo stack、range effect、scroll、IME sync snapshot。SweetEditor 后来的很多测试都开始检查这些副作用。

比如折叠尾部编辑测试，不只检查文档是否变成 `};`，还要检查第 2 行仍然 hidden，光标是否移动到第 2 行的新列。多行投影编辑测试则反过来检查 fold region 是否展开。

再比如 CodeLens 相关测试，`handleGestureEvent tap on CodeLens keeps cursor unchanged` 确认点击 CodeLens 不会顺手移动光标；`line-start word selection end handle can cross CodeLens virtual line` 确认选区手柄穿过虚拟行时，文本边界仍然落到真实文档位置。

搜索和 range effect 也一样。`EditorCore search renders matches projected into folded tail` 压住的是一个很具体的行为：搜索命中在隐藏源行，视觉高亮要画在折叠投影尾部。这个测试如果只检查 search range，不检查 render model 里的 range effect，就等于漏掉了用户真正看到的东西。

## 协议也需要测试

跨平台项目还有一类很容易被低估的测试：协议快照。

SweetEditor 后来把各平台手写模型收成了生成式 `CoreProtocol`。协议收口的规模很大，Android、Swift、Dart、C#、ETS、Java 这些平台上的协议模型都被重新整理过。

这种改动如果没有快照，很难靠 review 看住。一个字段移动到另一个 namespace，一个枚举值改名，一个可选字段被错误地生成成必填，平台都可能还能编过，但运行时解码已经不一样了。

所以 `tools/se_protocol_gen/schema.snapshot.json` 和 `fixtures/golden.json` 很重要。它们不是业务测试，但它们能确认生成器输出的协议形状有没有变化。协议一变，变更必须暴露出来，不能偷偷混进某个平台的手写代码里。

这也是我后来更愿意接受“生成文件很多”的原因。手写文件少，看起来清爽；但如果每个平台都各自维护一份协议，真正的复杂度只是藏起来了。生成式协议至少能把复杂度集中到 schema、generator 和 snapshot 上。

## 平台标准也是测试的一部分

`docs/zh/platform-implementation-standard.md` 看起来是文档，但它实际也承担了一部分测试规格的角色。

比如平台必须把 `RangeEffectRenderItem.rect` 当成最终屏幕几何，不能根据 range 自己重推；所有 mutating `EditorCore` API 都要消费 `EditorActionResult`，不能按方法名猜是否 repaint、relayout、flush 或 IME sync；平台请求 provider 时，要遵守 visibleLineRange 和标准模型，不能把平台局部状态偷偷塞回 Core。

这些约束的重点很实际：把平台层的自由度压到正确范围里。

单元测试能证明 Core 输出是对的，但平台仍然可能不用它，或者半用半猜。平台标准就是告诉每个平台：哪些东西可以自己画，哪些东西必须按 Core 给出的结果消费。

## 性能测试也要围绕语义路径

性能测试如果只测“打开大文件快不快”，定位价值有限。

SweetEditor 的 `tests/perf/performance_baseline.cpp` 里有一个 `hitTest mapping on large wrapped layout`，它测的是大文档、自动换行场景下的 hit test 映射。这个点选得比较具体，因为 hit test 是用户交互的高频路径，而且它会穿过 layout cache、wrap、prefix index、TextMeasurer 和 run 映射。

性能基线应该尽量落在真实风险路径上。  
如果某次为了修折叠投影，把 `hitTestPointer` 改成每次线性扫描大量行，功能测试可能还会过，但性能基线会马上变得不对劲。

## 还缺的东西

现在这套测试还不是完整闭环。

IME 仍然需要更多真实设备矩阵。Android、Flutter Android、Apple、OHOS、WinForms、Swing 的输入法路径差异太大，单元测试能压住 Core 语义，但平台输入回调的真实顺序还是要靠 trace 和设备验证。

平台绘制也还可以补更稳定的截图或 golden。Core 已经输出 final geometry，但平台 renderer 仍然可能画错字体 baseline、selection foreground、active link underline 或 scrollbar hover。

Accessibility 也是后面要补的部分。屏幕上的视觉结构和辅助功能树之间还有一层映射，尤其是折叠、CodeLens、inlay hint 这些非普通文本元素，不能只靠 render model 自己正确。

但即使有这些缺口，Core 行为测试仍然是最重要的底座。  
跨平台一致性需要一批具体失败样本反复跑出来；只说“我在几个 demo 上试过了”，没有办法支撑后续重构。每次模型被真实场景击穿，都应该留下一个测试。这样下一次重构时，才知道自己有没有把老坑重新打开。
