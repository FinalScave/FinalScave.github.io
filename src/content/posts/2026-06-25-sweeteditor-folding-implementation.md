---
title: "SweetEditor 折叠实现：隐藏逻辑行以后，光标和选区怎么办"
date: "2026-06-25T16:00:00.000+08:00"
path: "2026/06/25/sweeteditor-folding-implementation/"
tags: ["心得", "SweetEditor", "折叠", "编辑器"]
description: "记录 SweetEditor 折叠功能从隐藏逻辑行，到折叠尾部投影、source_line 映射、单行编辑保持折叠、多行编辑自动展开的实现过程。"
---

折叠功能很容易被低估。

刚开始看，它像是一个 UI 功能：把一段行隐藏掉，在起始行后面画一个 `...`，gutter 上画个箭头，点击以后展开或者收起。  
如果只是展示代码，这个理解大体够用。但编辑器里折叠不是展示状态，它会直接影响光标、选区、搜索、诊断、链接、手势命中和编辑行为。

真正麻烦的地方在于：被隐藏的逻辑行仍然存在于文档里。  
用户看不见它，不代表 Core 可以忘掉它；平台没有画它，不代表搜索、选区和编辑就不再经过它。

<!--more-->

![SweetEditor 折叠尾部投影](/2026/06/25/sweeteditor-folding-implementation/fold-tail-projection.svg)

## 折叠首先改变的是可见性

SweetEditor 里折叠区域由 Core 统一管理。`EditorCore::setFoldRegions`、`foldAt`、`unfoldAt`、`toggleFoldAt`、`foldAll`、`unfoldAll` 这些入口最后都会同步到同一套 fold state。

`syncFoldState()` 做的事情很直接：先重置所有行的隐藏状态，再根据 collapsed fold region 把 `start_line + 1` 到 `end_line` 标成 hidden，同时把相关行 layout dirty 掉。布局阶段如果发现某个 logical line 是 hidden，就把它的高度变成 0，清空 visual lines，然后让 visible range 跳过它。

这一步解决的是“哪些行不应该出现在屏幕上”。  
但它还没有解决“隐藏行里的文本如何参与语义”的问题。

比如折叠下面这段：

```text
if {
  body
} tail
```

只把第 1、2 行隐藏，然后在第 0 行后面画一个 placeholder，视觉上可以成立。但如果 `tail` 是闭合符号后面的真实代码，用户希望点它、选它、搜索它、在它后面输入内容。单纯隐藏行会把这些语义一起藏掉。

## 占位符不够，尾部文本要投影出来

SweetEditor 后来加了折叠尾部投影。核心思路是：折叠区域的结束行，如果在去掉前导空白后仍有可见文本，就把这段尾部文本接到折叠起始行的最后一个视觉行上。

对应到实现上，就是 `TextLayout::buildFoldTailProjection` 和 `appendFoldTailRuns`。

`buildFoldTailProjection` 会基于 collapsed fold region 找到 `end_line`，跳过结束行开头的空格和 tab，得到一个源行上的可见列范围。`appendFoldTailRuns` 再先追加一个 `FOLD_PLACEHOLDER`，然后把结束行尾部的 source-backed runs 追加到 owner line 的最后一条 visual line 上。

这一步有两个关键点。

第一，placeholder 本身不是文档文本。用户点到 `…`，不应该把光标放进文档里的某个列中。  
第二，投影出来的 `} tail` 是文档文本，只是视觉上被承载在第 0 行。它的 `source_line` 必须是第 2 行。

所以 `VisualRun` 里多了一个内部使用的 `source_line` 字段。默认情况下它等于 owner logical line；只有折叠投影这类场景，它才会指向隐藏源行。

这让 Core 能同时回答两个问题：这段 run 画在哪里，以及这段 run 属于哪里。

## 光标坐标要穿过投影

折叠以后，一个隐藏行的位置仍然可能是可见的。

`getPositionScreenCoord({line: 2, column: 1})` 如果落在投影尾部范围内，就不能因为第 2 行 hidden 而返回一个无效坐标，也不能把它映射到第 0 行的末尾。它要先通过 `resolveSourceVisualOwnerLine` 找到 owner line，再在 owner 的 visual runs 里找到 source line 为 2 的那段 run，最后返回那段文本对应的屏幕坐标。

反向的 hit test 也一样。用户点到折叠行尾部的 `tail`，`hitTestPointer` 应该返回第 2 行的列，而不是第 0 行。链接命中、选区矩形、文本边界命中也要走同一套 source-line 映射。

这也是折叠投影模型里改动最集中的地方。这里不只是加了一个绘制效果，还把 hit testing、cursor coordinates、link targets、selection rects 都接进了折叠投影语义里。

测试里也专门覆盖了这个点：`TextLayout maps collapsed fold tail runs to their source line` 会构造折叠区域，找到 `source_line == 2` 的 projected run，然后验证 `getPositionScreenCoord({2,0})` 和 `hitTestPointer` 都能落到尾部文本上。

## 单行尾部编辑保持折叠

折叠尾部能命中以后，接下来就会遇到更麻烦的问题：用户在投影尾部编辑时，折叠状态应该怎么办。

如果用户只是把光标放到 `} tail` 后面输入一个分号，这其实是结束行上的单行编辑。把整个折叠区域自动展开，体验会很突兀。用户明明只是在可见尾部补了一个字符，编辑器却展开了一大块代码。

所以 Core 里有一段专门的判断：单行编辑，并且 edit range 的 start/end 都落在同一个 fold tail projection 里时，允许保持折叠。文档照常修改源行，owner 行重新布局，隐藏源行仍然保持 height = 0。

对应测试是 `EditorCore keeps collapsed fold when editing a projected tail`：折叠 `{0,2}` 后，把光标放到第 2 行尾部，插入 `;`，最终文档变成：

```text
if {
  body
};
```

第 2 行仍然 hidden，光标位置回到第 2 行新的列上。视觉上用户只看到折叠起始行尾部多了一个分号。

## 结构性编辑必须展开

保持折叠只适合很窄的场景。只要编辑跨行，或者编辑范围不再完全落在投影尾部，Core 就会走 `autoUnfoldForEdit`。

这个边界很重要。折叠状态下可以允许“可见尾部的局部单行编辑”，但不能允许用户在隐藏结构里制造大段不可见修改。比如在投影尾部插入换行，文档结构已经变了，继续保持折叠会让用户看不到刚刚产生的新行，也会让后续 layout 和 selection 很难解释。

`EditorCore unfolds folded region for multiline projected tail edits` 就是压这个边界的测试。它验证了跨行编辑会让相关 folded region 展开，隐藏行重新可见。

这个选择看起来保守，但我觉得是对的。折叠可以隐藏结构，不能让结构性修改悄悄发生在用户看不见的地方。

## 选区和搜索也要走投影

折叠投影不是光标专用逻辑。

选区矩形通过 `getColumnSelectionRects` 生成时，也要从 source line 找到 owner visual line。否则选中第 2 行的 `tail` 时，Core 会找不到可见矩形，或者把矩形画到隐藏行不存在的位置。

搜索也是同一个问题。`EditorCore search renders matches projected into folded tail` 测的是这样一个场景：文档里有 `} tail`，折叠后只显示尾部，搜索 `tail` 时，当前命中 range 仍然是第 2 行的真实范围，但 render model 里要给出可见的搜索高亮 rect。

这类测试能防止一个很隐蔽的退化：某次改 layout 时，光标命中可能还正常，但搜索、selection、diagnostic 这些 range effect 不再经过 projection。用户看到的就是光标可以点进去，高亮却消失了。

## 这套设计的边界

SweetEditor 的折叠尾部投影没有试图把隐藏区域变成一个通用虚拟文档视图。它只做了很明确的一件事：把折叠结束行去掉前导空白后的尾部文本投影到起始行，让这段可见文本保持真实源行语义。

隐藏区域中间的内容不会被投影出来。跨行编辑会展开。结构性修改会展开。  
这让模型保持在一个可解释的范围内。

折叠功能最后收敛成了三层关系：

- fold state 决定哪些 logical line 参与 layout。
- fold placeholder 决定屏幕上如何提示“这里被折叠了”。
- fold tail projection 决定可见尾部文本如何回到隐藏源行。

只有这三层分开以后，光标、选区、搜索和编辑才不会互相污染。否则折叠就会变成一堆特判：点击时一个规则，绘制时一个规则，搜索时再补一个规则。短期能跑，后面一定会在某个组合场景里裂开。
