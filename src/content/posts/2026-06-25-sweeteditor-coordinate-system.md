---
title: "SweetEditor 坐标系统：从文档位置到屏幕矩形"
date: "2026-06-25T15:00:00.000+08:00"
path: "2026/06/25/sweeteditor-coordinate-system/"
tags: ["心得", "SweetEditor", "坐标系统", "跨平台"]
description: "记录 SweetEditor 坐标系统如何从 line/column 转 x/y，收敛到文档位置、视觉行、VisualRun、source_line 和最终屏幕几何之间的双向映射。"
---

SweetEditor 里我最开始低估的一个东西，是坐标系统。

一开始看起来它只是一个很普通的问题：给一个 `TextPosition`，算出屏幕上的 `x/y`；给一个鼠标或者触摸点，反过来算出文档里的 line/column。只要字体宽度测准、滚动偏移扣掉、gutter 宽度加上，好像事情就结束了。

真正写起来以后才发现，编辑器里的坐标不是单纯的几何问题。它背后其实一直在问另一件事：屏幕上这块东西到底属于哪一段文档语义。

自动换行会把一个逻辑行拆成多个视觉行；横向裁剪会让一段文本只露出后半截；CodeLens 和 PhantomText 会出现在屏幕上，但它们不应该变成文档字符；Inlay Hint 会占宽度，却不参与普通文本命中；折叠以后更麻烦，隐藏的结束行尾部文本可能被投影到折叠起始行上。  
这些东西叠起来以后，`line/column <-> x/y` 这句话已经不够用了。

<!--more-->

![SweetEditor 坐标映射链路](/2026/06/25/sweeteditor-coordinate-system/coordinate-mapping-pipeline.svg)

## 文档位置和屏幕点中间隔着好几层

Core 里最稳定的语义位置是 `TextPosition{line, column}`。它表示文档里的逻辑行和列，和屏幕没有直接关系。布局阶段会把逻辑行变成 `VisualLine`，再拆成一组 `VisualRun`。到了这一步，文本才开始拥有实际的 `x/y/width`。

这中间有几层容易混起来：

- `logical_line` 表示文档里的真实行。
- `wrap_index` 表示这个逻辑行被自动换行后落在哪个视觉段。
- `VisualRun.column/length` 表示这段 run 对应的源文本列范围。
- `VisualRun.source_line` 表示这段 run 的文本来源，默认等于视觉行 owner，但折叠尾部会改成隐藏的源行。
- 屏幕上的 `x/y` 还要叠加 `textAreaX`、gutter、scroll、viewport 裁剪。

所以 `TextLayout::getPositionScreenCoord` 不能只看目标 line 的 layout 结果。它要先判断这个位置是否可见，是否在折叠投影里，是否需要从源行映射到 owner 行，再走 `columnToVisualLineX` 去找真实的 run 坐标。

反过来的 `hitTestPointer` 也一样。一个屏幕点落到某个视觉行以后，还要继续看它命中的 run 是真实文本、tab、link、inlay hint、fold placeholder，还是 CodeLens。只有真实参与文档语义的 run，才能直接变成文档位置。

## hit test 和坐标反查必须互相验证

坐标系统最怕的是两个方向各自看起来合理，组合起来却不闭合。

比如 `getPositionScreenCoord({line: 10, column: 4})` 算出来一个点，用户点回这个点附近时，`hitTestPointer` 应该回到同一个文档边界，至少也要回到同一个 grapheme 边界附近。否则光标绘制看起来没问题，真实点击却会落到旁边字符；选区手柄看起来拖到了某个位置，Core 收到的范围却偏了一列。

所以 `tests/core/layout/layout_mapping.cpp` 里有一组很关键的测试：非 wrap 模式下 hitTest 和 getPositionScreenCoord 要一致，wrap 模式下也要一致；emoji modifier 这种 grapheme 不能被拆到中间；横向裁剪以后，屏幕上只露出后半段文本，hit test 仍然要能回到正确列；monospace 左裁剪不能因为复杂 grapheme 宽度而多裁或者少裁。

这些测试看起来很细，但它们挡住的是同一类问题：坐标系统不能只在“普通 ASCII 单行文本”里正确。

一旦进入真实编辑器，用户点到的可能是自动换行后的第二视觉行，可能是被水平滚动裁掉前缀的文本，可能是 emoji 的组合字符，也可能是一个 link run 的中间。测试覆盖这些组合，才能证明 Core 输出的坐标模型经得住 demo 之外的真实路径。

## 虚拟文本不能抢走文档语义

CodeLens、PhantomText、InlayHint 这一类视觉元素，最容易让坐标系统失真。

它们确实出现在屏幕上，也确实占高度或者占宽度，但它们不一定是文档文本。用户点在 CodeLens 行上时，编辑器要么触发 CodeLens 命令，要么把文本边界映射到相邻的真实文档位置，不能把 CodeLens 的字当成文档里的字符。

SweetEditor 现在通过 `VisualLineSemantics` 把这些行为显式拆开。普通内容行使用 `CONTENT` 策略；CodeLens 的 pointer hit 可以映射到 owner line start，但 text boundary 会映射到 previous visible line end；Phantom 行会映射到 owner line end，并且在文本语义里跳过。

这个拆分有点啰嗦，但它解决了一个很实际的问题：同一个视觉行，在不同交互里语义不一样。

点击 CodeLens 文本要命中 command；拖动选区手柄穿过 CodeLens 行时，它更像一条虚拟边界；计算文档文本范围时，它又应该完全跳过。如果只在平台层按屏幕坐标猜，很容易出现某个平台点 CodeLens 会移动光标，另一个平台点 CodeLens 会触发命令，第三个平台拖选区时又把边界算错。

这也是为什么平台层不能自己重新解释视觉行。Core 已经把 pointer hit、text boundary、decoration hit 这几类语义拆开了，平台只应该把原始指针事件交回来。

## range effect 的矩形要在 Core 里结算

诊断波浪线、搜索结果、当前匹配、文档高亮，这些最开始也很容易被理解成“给平台一个 range，平台自己画”。听起来省协议字段，平台也能用自己的文字 API 去取 rect。

但这个做法在 SweetEditor 里很快就撑不住。

一个 range 可能跨自动换行后的多个视觉段，可能被 viewport 裁掉一部分，可能落在折叠尾部投影上，也可能和 selection foreground、link foreground、active codelens 这些状态叠在一起。平台如果拿文档 range 自己推矩形，就必须复制一遍 Core 的 layout 语义。

现在的标准反过来了：`RangeEffectRenderItem.rect` 是 Core 已经算好的最终屏幕几何。平台拿到这个 rect 直接绘制，不再根据 source range 重算。

这件事在 `docs/zh/platform-implementation-standard.md` 里也被写成了平台约束。原因很简单：Core 才知道折叠投影、wrap、裁剪、range 分裂这些关系。平台重新推，短期可能少传几个字段，长期会制造七份不一致的编辑器。

## source_line 是折叠投影逼出来的字段

坐标系统真正被逼出 `source_line`，是在折叠尾部投影上。

一个折叠区域可能长这样：

```text
if {
  body
} tail
```

折叠以后，视觉上可能只显示：

```text
if { … } tail
```

这里的 `} tail` 在屏幕上属于第 0 行的最后一个视觉段，但在文档里属于第 2 行。用户点击 `tail`，光标应该落到第 2 行；搜索命中 `tail`，高亮矩形应该画在折叠后的可见尾部；用户在 `tail` 后面输入一个分号，如果只是单行尾部编辑，还应该保持折叠状态。

如果 `VisualRun` 只记录 owner logical line，这些都做不出来。在折叠投影模型里，`VisualRun` 加了内部使用的 source-line metadata：协议 payload 不变，但 Core 内部的 visual run 可以记录真实源行。  
同时，hit testing、cursor coordinates、link targets、selection rects 都改成通过 source line 映射，并补了 folded-tail layout mapping、editing behavior、render selection 相关测试。

`source_line` 的意义不在画图方便。它是坐标系统里的所有权信息：屏幕上这段文字由哪个视觉行承载，和它在文档里属于哪一行，是两件事。

## 平台层只应该消费最终模型

坐标系统收敛到现在这个形态以后，平台层的职责反而更清晰了。

平台要做的是字体测量、原生绘制、输入事件转发。Core 要做的是布局、坐标映射、语义命中、最终几何生成。平台可以决定一条波浪线用什么 API 画，可以决定鼠标 cursor 怎么设置，但不应该重新解释“这个屏幕点属于哪段文档文本”。

这也是跨平台编辑器里很现实的取舍：统一语义模型负责一致性，统一绘图后端反而不是核心矛盾。  
只要 hit test、selection rect、range effect rect、fold projection 都在 Core 里结算，各个平台即使用不同的绘制系统，用户感受到的编辑行为也会更接近同一个编辑器。

坐标系统最后变成了一个很朴素的边界：文档位置、视觉承载、源文本所有权、屏幕几何，四件事都要明牌。少掉任何一块，某个复杂场景里都会开始猜。
