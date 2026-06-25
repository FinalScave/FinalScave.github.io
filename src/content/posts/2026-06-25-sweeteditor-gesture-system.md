---
title: "SweetEditor 手势系统：从屏幕事件到编辑语义"
date: "2026-06-25T19:00:00.000+08:00"
path: "2026/06/25/sweeteditor-gesture-system/"
tags: ["心得", "SweetEditor", "手势", "跨平台"]
description: "记录 SweetEditor 如何把鼠标、触摸、滚轮、长按、拖拽、selection handle 等屏幕事件收敛成 Core 里的命中测试和编辑语义。"
---

IME 统一适配之后，我很快发现手势也是同一类问题。

平台给到 Core 的永远是屏幕事件：鼠标按下、触摸移动、滚轮、右键、两指缩放、三指快速滚动。这些事件本身还不够。编辑器真正关心的是它们落在当前文档、布局、选区、装饰元素里以后，到底代表什么含义。

同一个屏幕点，可能是普通文本，可能是 CodeLens，可能是 link，可能是 fold placeholder，可能是 gutter icon，也可能是 selection handle 或 scrollbar。一个 `TOUCH_MOVE`，可能是滚动，也可能是拖选，还可能只是长按后的轻微抖动。平台层如果太早下结论，后面每个平台都会长出一套自己的编辑器语义。

SweetEditor 的手势系统最后收敛成了几层：`GestureHandler` 只识别物理手势，`EditorInteraction` 结合布局和选区做语义分发，`TextLayout` 负责命中测试，`EditorCore` 根据 `GestureIntent` 修改光标、选区、折叠和返回 `EditorActionResult`。

<!--more-->

![SweetEditor 手势链路](/2026/06/25/sweeteditor-gesture-system/gesture-event-flow.svg)

## 物理手势先归一

`GestureHandler` 这一层很克制。它不知道文档内容，不知道 CodeLens，也不知道当前点是不是 link。它只看事件流、时间、距离、指针数量和修饰键，然后把平台事件归一成 `GestureType`。

鼠标路径里，`MOUSE_DOWN/MOUSE_MOVE/MOUSE_UP` 会变成 tap、double tap 或 drag select。`MOUSE_WHEEL` 会根据修饰键拆出不同含义：普通滚轮是纵向滚动，Shift 滚轮转成横向滚动，Ctrl 滚轮转成缩放。`MOUSE_RIGHT_DOWN` 直接变成 `CONTEXT_MENU`。

触摸路径更复杂一点。一根手指可能是 tap、double tap、long press 或 scroll；两根手指是 scale；三根及以上手指走 fast scroll。这里还有几个细节很容易出错：touch slop 决定轻微抖动是否算移动，double tap timeout 决定两次点击是否合并，long press 触发后不能立刻因为一点点移动就进入拖选，否则手机上长按选词会非常飘。

这一层的输出其实只是“手势发生了什么”。它还没有资格回答“文档应该怎么变”。

## 语义分发才是难点

`EditorInteraction` 拿到 `GestureResult` 以后，才开始把物理手势放回编辑器上下文里解释。

一个 tap 落在普通文本上，通常要移动光标；落在 fold gutter 或 fold placeholder 上，要切换折叠；落在 CodeLens 上，要保留命中目标，不应该顺手把光标挪过去；落在 link 上，还要看 Ctrl 或 Meta 是否按下，没有修饰键时它更像普通文本，有修饰键时才变成可点击目标。

这也是为什么 SweetEditor 里没有让平台直接说“我点中了某个东西”。平台最多知道屏幕点和原生手势，真正的目标判断必须结合 Core 的布局模型。CodeLens 是虚拟视觉行，fold tail 可能来自隐藏的源行，link run 可能因为自动换行被拆成多段，gutter icon 和 fold marker 又在文本区域外。平台层重新算一遍，迟早会和 Core 不一致。

`EditorCore::handleGestureEvent` 最后只消费一组比较明确的意图：`place_cursor`、`select_word`、`toggle_fold`、`cancel_linked_editing`。手势层不直接改文档文本，它只是把当前事件解释成这些意图，再由 Core 统一产生 `EditorActionResult`。这个结果里会带上光标、选区、滚动、缩放、hit target、pointer cursor、动画状态和是否需要重绘。

## 三种 hit test 不能混成一个

手势系统真正沉下来以后，最重要的拆分是三种命中测试。

`hitTestPointer` 解决的是“这个屏幕点对应哪个文档位置”。它主要服务普通点击、光标放置和缩放锚点。两指缩放时，SweetEditor 会先用 focus point 找到一个文档锚点，再在缩放后尽量把这个锚点维持在用户手指附近。缩放在这里不只是改 scale，它还要尽量保持用户正在看的位置稳定。

`hitTestTextBoundary` 解决的是“选区边界应该落在哪里”。这和普通点击不完全一样。拖选、selection handle 跨过 CodeLens 这种虚拟行时，不能把 CodeLens 文本当成文档字符，也不能让选区断在一个不存在的列上。它需要把 CodeLens、phantom line、fold projection 这些视觉元素映射回合法的文本边界。

`hitTestDecoration` 解决的是“这个点是不是命中了装饰或交互元素”。它返回 `HitTarget`，包括 inlay hint、CodeLens、link、gutter icon、fold gutter、fold placeholder。link 还有一个很实际的细节：返回的 column 会归一到 link span 的 canonical start column，不能取当前 run 的任意列，否则同一个跨行 link 的不同视觉片段会变成不同目标。

如果只保留一个 `hitTest`，这些语义会互相污染。点击 CodeLens 时需要命中 command，拖选跨过 CodeLens 时需要把它当成边界投影，普通文本定位时又应该跳过它。一个屏幕点在不同交互里本来就有不同含义，强行统一反而会把问题藏起来。

## selection handle 是单独通道

移动端选区手柄是最容易把手势系统写乱的地方。

它看起来也是一次触摸拖动，但语义和普通 drag select 不一样。普通拖选从当前光标或选区起点往外扩；handle drag 是抓住已有选区的一端移动。它还有自己的命中热区，手指实际按下的位置通常在手柄下面，不在文本边界上。

所以 SweetEditor 在事件进入 `GestureHandler` 之前，会先做 `hitTestHandle`。如果命中 start 或 end handle，后续 move 就不再走普通手势识别，而是直接进入 `dragHandleTo`。这里会根据 handle hit area 调整 y 坐标，再用 `hitTestTextBoundary` 得到新的选区边界。

还有一个很细但必须处理的状态：手柄可以拖过另一端。拖过以后 start/end 要交换，当前活跃的 handle 也要跟着切换，否则用户继续拖动时选区会反向跳。边缘滚动也在这一层处理，手指拖到 viewport 顶部或底部时，`tickEdgeScroll` 会持续滚动，并用最后的屏幕点重新计算选区。

这类细节单看代码不复杂，但如果拆错层，问题会非常隐蔽。比如 selection handle 穿过 CodeLens 虚拟行时，只有 `hitTestTextBoundary` 知道应该映射到相邻的真实文本边界；平台层拿屏幕 y 坐标自己猜，基本不可能长期一致。

## 长按和右键不能当普通 tap

长按最开始容易被写成“延迟触发一次 tap”。这个模型在编辑器里不够用。

移动端长按经常发生在已有选区内部。用户的意图通常是打开上下文菜单、拖动手柄或继续调整选区，而不是清掉选区再把光标放到手指下面。SweetEditor 现在会通过 `shouldPlaceCursorOnLongPress` 判断：如果长按点在已有选区内，就保留选区；如果在选区外，才按新的位置放置光标并清掉旧选区。

右键也是类似的边界。`MOUSE_RIGHT_DOWN` 会被解释成 `CONTEXT_MENU`，它会返回 decoration hit target，但不会像普通 tap 一样默认移动光标。这样平台可以拿到上下文菜单需要的目标信息，Core 也不会因为一次右键把用户刚选中的范围破坏掉。

这里的问题不大，但非常影响手感。编辑器交互里很多“看起来像点击”的动作，真实语义都不是点击。

## 滚动、缩放和动画也要回到 Core

手势系统里还有一类容易被低估的状态：滚动、缩放、fling 和 scrollbar。

滚动不能停在平台自己改 scroll offset。Core 需要知道新的 viewport，才能重新 layout visible lines、更新 scrollbar model、计算 pointer cursor、返回是否需要重绘。触摸滚动结束后还有 fling，`FlingAnimator` 会根据最近的采样计算速度，只有超过最小速度才启动惯性滚动。之后每一帧通过 `tickFling` 推进，再由 `EditorActionResult` 告诉平台继续动画。

缩放也不能只改 scale。两指缩放需要 focus point，需要锚定当前屏幕下对应的文本位置，否则用户捏合以后内容会从手指下滑走。Ctrl 滚轮缩放也走同一套语义，只是输入来源不同。

scrollbar 又是一个提前消费事件的例子。`EditorInteraction` 会先判断点是否落在 scrollbar 上，track tap 可以跳转，thumb drag 可以直接改滚动位置。这个判断必须发生在普通文本手势之前，否则拖动滚动条会被误识别成选区拖拽。

所以最终平台层不直接拥有滚动语义。平台传入 wheel、touch、direct scroll 或 direct scale，Core 决定视图状态怎么变，并把动画需求返回给平台。

## 平台层保留输入事实，Core 负责编辑语义

手势系统最后稳定下来的边界，其实和 IME、坐标、渲染几篇文章里的结论相通。

平台层最可靠的是输入事实：原生事件类型、屏幕坐标、指针数量、滚轮 delta、修饰键、触摸时间序列。Core 最可靠的是编辑语义：文档位置、视觉行、虚拟元素、折叠投影、选区、滚动边界、交互目标。

这两层一旦混起来，就会开始出现“某个平台能点，另一个平台不能点”“桌面能选中，移动端跨 CodeLens 就偏”“鼠标 hover 是手型，点击以后却移动光标”这种问题。表面上看是一个个小 bug，根上其实是语义归属不清。

现在的手势链路看起来多了一些模型：`GestureEvent`、`GestureResult`、`GestureIntent`、`HitTarget`、`EditorActionResult`。但这些模型把问题拆到了可测试的位置。`GestureHandler` 的测试压住滚轮修饰键、double tap、long press、fast scroll 和 fling；layout mapping 的测试压住 CodeLens、link、fold tail 的命中；EditorCore 的测试压住 CodeLens 点击不移动光标、link 的 Ctrl hover、长按保留选区、selection handle 穿过虚拟行这些组合场景。

做完这一轮以后，我对“统一手势 API”这件事反而没那么执着了。某个平台回调长什么样，只是输入来源的问题；屏幕事件进入编辑器以后被解释成什么语义，才决定用户看到的是不是同一套行为。这个语义只要能稳定地回到 Core，平台差异就只是输入来源和绘制方式的差异，不会再扩散成七套编辑器行为。
