---
title: "SweetEditor IME 统一适配：从强行统一 API 到 command/text_update 双模型"
date: "2026-06-25T10:00:00.000+08:00"
path: "2026/06/25/sweeteditor-ime-unified-adapter/"
tags: ["心得", "SweetEditor", "IME", "跨平台"]
description: "记录 SweetEditor 从强行统一 IME API 到拆出 command/text_update 双模型的过程，以及 Android、Apple、Flutter、Swing、WinForms、OHOS 等平台在 IME 语义上的差异。"
---
<p>最近 SweetEditor 的 IME 适配算是走完了一轮非常折磨人的收敛过程。<br>一开始我以为这只是把几个平台的输入法回调接到 C++ Core 上，最多处理一下 UTF-16 offset、候选词下划线、composition range 之类的问题，结果真正做起来才发现，API 数量只是表面问题，不同平台对“正在输入”这件事的语义根本不一样。</p>

<p>比如 Flutter Windows 上看起来基本正常，到了 Flutter Android 就会出现第一次输入无效、候选词不能正确替换、下划线残留、点击词语后高亮混乱等问题。<br>而当我尝试修 Flutter Android 的时候，又把 Native Android 搞坏了：在 Android 原生 Demo 里点击一个英文单词，然后继续通过输入法输入字符，结果没有在光标处插入，整个被标记的单词反而被替换掉。<br>这类问题如果只看单个平台，很容易误判成某一个回调处理错了，但把 Android、Flutter、Apple、Swing、WinForms、OHOS 全部放到一起看，就会发现真正的问题是：平台层和 Core 层都在猜 IME 的语义。</p>

<p>这几个事故就是入口。<br>Flutter Android 的 composing 为什么不能直接信，Native Android 的 <code>setComposingRegion</code> 为什么会把一个普通英文词替换掉，后面又为什么必须拆出 preedit、system mark、command 和 text_update。<br>这些坑串起来，基本就是 SweetEditor 这轮 IME 重构的主线。</p>

<!--more-->

<p><img src="/2026/06/25/sweeteditor-ime-unified-adapter/ime-protocol-flow.svg" alt="SweetEditor IME 统一输入协议"></p>

<h2>一开始的问题：composition 被塞进了太多含义</h2>

<p>在早期实现里，Core 侧有一个比较自然的想法：既然输入法有 composition，那编辑器里也维护一个 composition 就好了。<br>平台告诉我正在组合文本，我就更新 composition；平台告诉我提交文本，我就提交 composition；平台告诉我结束组合，我就结束 composition。<br>这个思路单独放在 Apple 或者桌面端的一部分场景里，看起来是可以工作的，因为这些平台的 marked text 或 composition string 比较像“真实预编辑文本”。</p>

<p>但是 Android 和 Flutter 很快就把这个模型击穿了。</p>

<p>Android 的 <code>InputConnection</code> 里有 <code>setComposingText</code>，也有 <code>setComposingRegion</code>。<br><code>setComposingText</code> 通常可以理解为输入法给了真实预编辑文本，比如拼音正在输入的那段内容。<br>可是 <code>setComposingRegion</code> 很多时候只是系统输入法在标记一个已有文档范围，例如当前词、候选目标词、纠错范围，它不一定包含光标，也不代表接下来所有文本都要替换这个范围。<br>如果 Core 把它也当成真实 composition，就会发生一种很恶心的问题：用户只是点了一下词语，系统输入法标了一个范围，编辑器却误以为这里已经进入可替换的预编辑状态，后面输入一个字符就把整个词替换掉。</p>

<p>Flutter 的情况也类似。<br>Flutter 给的是 <code>TextEditingValue</code>，里面有 text、selection、composing。<br>但这个 composing 在不同平台上的来源不完全一致，在 Flutter Windows 上它更像普通输入框里的预编辑范围，而在 Flutter Android 上，它经常更像 Android 输入法暴露出来的系统标记范围。<br>如果平台适配层看到 composing 就直接告诉 Core“这里是 preedit”，那么 Core 后面的所有判断都会走错。</p>

<p>这就是第一阶段最大的坑：composition 这个名字太诱人了，大家都觉得它表示“输入法正在组合文本”，但实际上在跨平台编辑器里，它可能表示真实预编辑文本，也可能只是候选词上下文，也可能只是系统为了候选栏和纠错服务临时标出来的一段范围。</p>

<h2>各个平台的 IME 行为差异</h2>

<p>先把平台行为摊开看，才能看出最初那个统一 API 为什么撑不住。<br>有的平台是在回调里把“我要做什么”说清楚了，有的平台只是把编辑后的文本状态交给控件，还有的平台两种情况都会出现。<br>这几类输入事实混在一个入口里时，适配层很容易开始替平台补语义。</p>

<p><img src="/2026/06/25/sweeteditor-ime-unified-adapter/ime-platform-editing-flows.svg" alt="各平台 IME 真实编辑过程对照"></p>

<p>Android 是这次最折磨人的平台。<br>输入法会直接操作一个 <code>Editable</code>，控件收到的常常已经是被系统改过的文本和 composing span。<code>commitText</code>、<code>setComposingText</code>、<code>setComposingRegion</code>、<code>finishComposingText</code>、<code>deleteSurroundingText</code> 这些 API 看起来都和文本有关，但语义并不在同一个层级。<br><code>commitText</code> 是明确提交，<code>deleteSurroundingText</code> 是明确删除，<code>replaceText</code> 是明确替换。<br>而 <code>setComposingRegion</code> 更像是“系统标记了一段范围”，它可以用于候选、纠错、当前词高亮，也可以只是为了给输入法提供上下文。</p>

<p>更麻烦的是，在 Android 上真实文本变化经常先发生在 <code>Editable</code> 里。<br>比如输入法调用 <code>setComposingText</code>，系统会先更新 <code>Editable</code> 的文本和 composing span；输入法调用 <code>setComposingRegion</code>，系统也会在 <code>Editable</code> 上打出 composing 相关标记。<br>如果平台适配层直接把这些标记都翻译成 Core 的 preedit，Core 就会把候选目标词、纠错范围、真实预编辑文本混成一类。<br>所以 Android 最后只能按混合模型处理：删除、显式替换这类语义明确的操作走 command，而 <code>Editable</code> 被 IME 修改后的文本窗口变化走 text_update，再由 Core 根据 range role、context revision 和文本差异判断真正的文档变化。</p>

<p>Apple 平台相对清晰一些。<br>iOS 的 <code>UITextInput</code> 和 macOS 的 <code>NSTextInputClient</code> 里，<code>setMarkedText</code> 通常就是预编辑文本，<code>insertText</code> 就是提交文本，<code>unmarkText</code> 就是结束 marked text。<br>当然这里也有 selection、replacementRange、markedTextRange 的细节，例如 macOS 的 <code>replacementRange</code> 可能要求在现有文档范围上建立 marked text，iOS 的 <code>selectedTextRange</code> 在 composing 时还要跟 marked selection 对齐。<br>但整体上，Apple 给的是比较明确的“设置 marked text / 插入文本 / 结束 marked text”，因此更适合映射成 command。</p>

<p>Swing 的思路也比较明确。<br><code>InputMethodEvent</code> 里有 <code>committedCharacterCount</code>，这意味着同一次事件里，前半段可能已经提交，后半段才是 composed text。<br>所以 Swing 适配层要做的事情是把 <code>committedCharacterCount</code> 之前的内容变成 commit，把剩余的 composed 部分变成 preedit，整段字符串不能一股脑塞给 Core。<br><code>InputMethodRequests</code> 更多是给输入法查询上下文，例如光标位置、已提交文本、选中文本，它不应该反过来让编辑器创建新的 composition。</p>

<p>WinForms 主要面对的是 Windows IME 消息。<br>如果走 IMM，就要区分 <code>GCS_COMPSTR</code> 和 <code>GCS_RESULTSTR</code>：前者是组合串，后者是结果串。<br><code>GCS_COMPSTR</code> 更适合转成 <code>SET_PREEDIT_TEXT</code>，<code>GCS_RESULTSTR</code> 则应该转成 <code>COMMIT_TEXT</code>。<br>这类平台最怕的是普通 <code>KeyPress</code> 和 IME composition 同时写文档，所以 SweetEditor 在 WinForms 里会在 Core 有 preedit 时抑制普通按键路径，避免同一个输入被处理两次。<br>WinForms 的难点不在读出组合串这一件事上，还在于保证文档修改只从一个入口发生。</p>

<p>OHOS 则有 preview text、周围文本、移动光标、选择范围等一组回调。<br>它的 <code>setPreviewText</code> / <code>finishTextPreview</code> 比较像 preedit 生命周期，<code>insertText</code>、<code>deleteLeft</code>、<code>deleteRight</code> 又更像明确 command。<br>这里比较麻烦的是回调里的范围有时看起来像文档绝对 offset，有时又像输入上下文本地 offset，所以适配层必须结合 <code>document_start_offset</code> 归一化，不能直接把平台 offset 当作文档 offset 使用。<br>如果这个归一化做错，Core 收到的 command 本身看起来是对的，但落到文档上就会删错或者选错范围。</p>

<p>Flutter 的麻烦在于它经常不给明确 command，只给一份文本状态或者文本 delta。<br>平台表达的是“输入框现在变成了这个文本，selection 是这个，composing 是这个”，并没有直接声明“我要 commit 这个文本”。<br>这对普通输入框很自然，但对一个自研编辑器 Core 来说，如果没有稳定的上下文窗口和 revision，就很容易把一次平台同步误认为一次用户输入。</p>

<p>Flutter 最容易误判的是 <code>composing</code>。<br>在 Windows 上，它通常比较接近真实 preedit，可以按 transient input 的方式处理；但在 Android 上，它经常继承了 Android <code>InputConnection</code> 的 system mark 行为，表现成候选目标范围或者系统高亮。<br>所以 SweetEditor 的 Flutter 适配层不能看到 <code>TextEditingValue.composing</code> 就直接声明 preedit，而要根据平台行为决定它是 <code>PREEDIT</code> 还是 <code>SYSTEM_MARK</code>。<br>Flutter 最后更适合走 text_update，也是因为平台给的是编辑后状态，Core 才能结合上下文判断它到底是插入、替换、提交 preedit，还是只是系统标记变化。</p>

<h2>调试过程：不能再相信自己的猜测</h2>

<p>我后来在 Android Demo 里加了 IME Trace。<br>思路很简单：拿系统 <code>EditText</code> 当基线，把输入法对系统控件的调用记录下来，再和 SweetEditor 的行为对比。<br>如果系统 <code>EditText</code> 在某个场景下并没有真正进入 <code>setComposingText</code>，那 SweetEditor 就不应该凭空创建一个可见 preedit。<br>如果系统只是调用了 <code>setComposingRegion</code> 标记当前词，那 SweetEditor 也不能把它当成可替换 composition。</p>

<p>最能说明问题的一条链路可以压缩成这样：</p>

<pre><code>文档状态：hello| world
Android IME:
  setComposingRegion(0, 5)
  commitText("X")

系统 EditText：helloX world
SweetEditor 旧模型：X world</code></pre>

<p>这条 trace 的价值不在于 offset 多难算，而在于它证明 <code>setComposingRegion(0, 5)</code> 本身没有“后续 commit 必须替换 hello”的语义。<br>旧模型把它当成 composition 以后，后面的每一步看起来都很合理，最后结果却错了。</p>

<p>这一步把排查方向从 offset 拉回了语义。<br>因为很多 IME 问题看起来都像“少同步了一次 selection”或者“range 偏移算错了”，但实际可能是语义错了。<br>offset 错了通常是局部 bug，语义错了就会出现非常玄学的连锁反应：修候选词会破坏删除，修删除会破坏英文输入，修 Flutter Android 又破坏 Native Android。</p>

<p>这轮调整大致分成几个阶段。<br>一开始重点还是把 Android composition 输入和回归问题补上，先让明显错误的输入路径回到可用状态。<br>后面开始把 composition controller 绑定到 editor core，并拆分 Core IME 实现，相当于把 preedit 生命周期从平台层往 Core 收。<br>再往后，sync snapshot 里重复的 text window 被去掉，文本窗口暴露策略集中到 Core，避免平台层自己拼上下文。<br>最后继续拆 action source 和 text change 语义，把“这次操作从哪里来”和“文档实际发生了什么变化”分开；Android system mark 删除、preedit sync、operation protocol 也沿着这个方向继续收口。<br>这些变化表面上分散在不同模块里，实际都是在把“猜测”从平台层和 Core 层里清出去。</p>

<h2>preedit 和 system mark 必须分开</h2>

<p>真正让模型收住的一步，是把 marked range 从“一个范围”拆成“带角色的范围”：<code>PREEDIT</code> 和 <code>SYSTEM_MARK</code>。</p>

<p><code>PREEDIT</code> 表示真实预编辑文本。<br>它可以显示在文档里，可以被后续 preedit 更新替换，可以 finish，可以 commit。<br>例如 Apple 的 <code>setMarkedText</code>、Swing 的 composed text、Windows 的 <code>GCS_COMPSTR</code>，这些都比较适合进入 preedit 生命周期。</p>

<p><code>SYSTEM_MARK</code> 表示系统标记范围。<br>它可以用于候选词、纠错、当前词高亮，也可以只是输入法为了构造候选上下文而要求编辑器标出来的一段范围。<br>它能被同步给平台，让平台知道当前哪个词被系统认为是目标词，但它不能自动变成 Core 的 composition，更不能让后续普通输入默认替换整段文档文本。</p>

<p><img src="/2026/06/25/sweeteditor-ime-unified-adapter/ime-range-semantics.svg" alt="preedit 和 system mark 的边界"></p>

<p>回到刚才那条 trace，旧模型的问题就是没有记录 range role。<br>同样是 <code>setComposingRegion(0, 5)</code>，它在 Android 里可能只是当前词标记；到了旧 Core 里，却只剩下“有一段 composition range”这个事实。<br>于是 <code>hello</code> 被放进 preedit 生命周期，后面的 <code>commitText("X")</code> 就自然走成“替换当前 composition”。</p>

<p><img src="/2026/06/25/sweeteditor-ime-unified-adapter/android-system-mark-failure.svg" alt="Android system mark 被当成 composition 的事故对比"></p>

<p>新模型里，<code>setComposingRegion(0, 5)</code> 只能先变成 <code>SYSTEM_MARK</code>。<br>这个范围可以同步回平台，让 Android 输入法继续显示候选目标词或者下划线，但它不会让 Core 进入 preedit 生命周期。<br>后面如果平台只是调用 <code>commitText("X")</code>，Core 会按当前 selection 插入文本，并清掉 system mark。只有当平台明确发出 <code>REPLACE_TEXT</code>，或者 text_update 里的文本变化确实证明这个范围被替换了，Core 才会真正替换文档内容。</p>

<p>所以 SweetEditor 现在的 <code>ImeSyncSnapshot</code> 里同时带着 preedit range 和 system mark range。<br>同步平台状态时，平台需要知道真实 preedit 在哪里，也需要知道系统标记范围在哪里。<br>但 Core 必须清楚：这两个范围的生命周期和替换语义完全不同。</p>

<p>Android 适配层里还有一个很具体的细节：当当前 <code>Editable</code> 的 marked role 是 <code>SYSTEM_MARK</code>，并且输入法提交的是普通单字符时，需要先移除 composing span，再让 <code>commitText</code> 继续执行。<br>否则 Android 自己的 <code>Editable</code> 会倾向于把 composing range 当成替换目标，Core 后面收到 text_update 时就已经晚了。<br>这说明平台层虽然应该变薄，但不能完全无脑转发，它至少要保留“这个 composing span 到底是 preedit 还是 system mark”的事实。</p>

<h2>text_update 在 Core 里到底做了什么</h2>

<p>另一个容易被低估的点是，<code>text_update</code> 不能理解成“平台给了什么文本，Core 就把文档覆盖成什么文本”。<br>如果这么做，那它和普通输入框同步没有区别，也解释不了为什么要保存 <code>context_id</code>、<code>context_revision</code> 和 <code>document_start_offset</code>。<br>SweetEditor 的 text_update 更像是一次有上下文的文本差分：平台把某个 text window 的新状态发回来，Core 用这个状态和上一轮 <code>ImeInputContext</code> 做对比，再决定它应该变成哪种文档操作。</p>

<p>在 Core 里，它更接近下面这条流程：</p>

<ol>
  <li>先检查 <code>context_id</code> 和 <code>context_revision</code>。如果平台拿的是旧窗口，Core 不会硬套这个更新，而是要求 IME 重新同步。</li>
  <li>再用旧 text window 和新 text window 算一次 UTF-16 层面的 diff，找出变化发生在哪里。</li>
  <li>接着解释平台上报的 marked range：<code>PREEDIT</code> 进入 preedit 生命周期，<code>SYSTEM_MARK</code> 单独变化时通常只同步 selection 和 system mark，不产生 text change。</li>
  <li>最后把 diff 和 range role 合在一起判断文档操作：更新 preedit、提交 preedit、确认候选范围、普通替换，或者只要求平台重新同步。只有 diff 证明文本确实被替换时，system mark 对应的文档范围才会落成修改。</li>
</ol>

<p><code>text_update</code> 的核心难点其实在 diff 之后的解释。<br>同样是 text window 从 <code>enabled world</code> 变成 <code>enables world</code>，如果前面存在 system mark，就可能是在候选范围上确认了一个候选词；如果前面存在 preedit，就可能是提交预编辑；如果什么 range 都没有，那就是普通文档替换。<br>这些语义如果放在平台层猜，每个平台都要写一套状态机；放到 Core 里，至少可以用统一的上下文、统一的 range role 和统一的回归测试去约束。</p>

<h2>为什么最后拆成 command 和 text_update</h2>

<p>在统一协议时，一个很容易想到的方案是设计一个大而全的 <code>ImeMessage</code>，里面带一个 kind，所有平台事件都往里面塞。<br>但后面我把它拆成了两个入口：<code>ImeCommandMessage</code> 和 <code>ImeTextUpdateMessage</code>。<br>这个拆分的价值在于强制表达平台到底给了 Core 什么。</p>

<p><code>command</code> 表示平台给的是明确意图。<br>比如设置 selection、设置 preedit 文本、commit 文本、finish preedit、cancel preedit、设置 marked range、显式替换文本、删除周围文本、设置键盘脚本类型。<br>这类消息的重点是“我要做什么”。<br>Apple、Swing、WinForms、OHOS 的很多回调都比较适合走 command，Android 的删除和显式 replace 也适合走 command。</p>

<p><code>text_update</code> 表示平台给的是文本结果。<br>比如 Flutter 给了一个新的 <code>TextEditingValue</code>，或者 Android 的 <code>Editable</code> 被 IME 改完之后，平台层拿到的是一个 text window 的 snapshot 或 patch。<br>这类消息不描述操作意图，重点是“这段上下文现在变成了什么”。<br>Core 需要根据 <code>context_id</code>、<code>context_revision</code>、<code>document_start_offset</code>、selection、marked range 以及前后文本差异，推导出真正应该落到文档上的修改。</p>

<p>这两个入口不能混。<br>如果把 text update 当 command，就会假装平台有明确语义，最后只能靠猜。<br>如果把 command 当 text update，又会丢掉平台已经明确告诉你的意图，比如删除周围文本、提交预编辑、显式替换范围。<br>前者容易错误替换，后者容易重复提交或者漏掉组合状态。</p>

<p>现在 SweetEditor 的 C API 里也对应成两个入口：<code>editor_ime_handle_command_message</code> 和 <code>editor_ime_handle_text_update_message</code>。<br>这让 Android、Apple、Flutter、Swing、WinForms、OHOS 这些语言绑定都可以走同一套 Core 协议，但不要求它们假装自己拥有一样的 IME 模型。</p>

<h2>text window 和 context revision 的意义</h2>

<p>IME 适配还有一个非常容易被低估的问题：平台很多时候拿不到整篇文档，只能拿到光标附近的一段文本。<br>Android 的输入法需要 surrounding text，Flutter 的 delta 是围绕当前 editing value 的，OHOS 也会询问光标左侧和右侧文本。<br>所以 Core 暴露给平台的是 <code>ImeInputContext</code>，一段带 revision 的上下文窗口。</p>

<p>这个 context 里有几个关键字段：<code>id</code>、<code>revision</code>、<code>document_start_offset</code>、<code>text</code>、<code>selection</code>、preedit range、system mark range。<br>平台看到的 offset 都是 text window 本地 UTF-16 offset，并非文档绝对 offset。<br>真正把本地 offset 转回文档位置的逻辑在 Core 里完成，这样平台层不需要自己推导文档坐标，也不需要知道 Core 内部如何分段、如何处理 UTF-16 长度和 grapheme 删除。</p>

<p><code>context_id</code> 和 <code>context_revision</code> 的作用是防止旧窗口污染新文档。<br>如果用户已经点到了另一个位置，或者文档已经因为其他操作发生变化，而输入法又拿着旧的 text window 回来提交更新，Core 就应该要求 resync，不能硬套这个 range。<br>这类问题在输入法里非常常见，因为 IME、平台控件、编辑器渲染和 Core 更新并不是完全同步的。</p>

<p>在这套模型里，text_update 只处理被 Core 认可的上下文窗口：先分析平台文本变化，再把变化转成文档操作。<br>它不能退化成平台文本覆盖文档，否则跨平台 IME 很难稳定。</p>

<h2>重构后的最终形态</h2>

<p>现在 SweetEditor 的 IME Core 大致分成几层。<br><code>ime_types.h</code> 定义跨平台协议类型，包括 command、text_update、input context、sync snapshot、marked range role。<br><code>CompositionController</code> 负责 preedit 生命周期、document range preedit、candidate commit window、删除行为、普通拉丁输入锁等细节。<br><code>EditorCore</code> 负责把平台消息转成 Core 内部编辑操作，并在操作结束后返回 <code>EditorActionResult</code> 和 <code>ImeSyncSnapshot</code>。</p>

<p>平台层则尽量变薄。<br>Android 保留 <code>Editable</code> 和系统 composing span，但把真实 preedit 与 system mark 分开同步。<br>Flutter 根据平台行为决定 composing role，Android 上更保守地把 composing 当 system mark，Windows 上则可以按 transient preedit 处理。<br>Apple、Swing、WinForms 更偏 command 模型。<br>OHOS 在 preview text 和 selection 回调里做 offset 归一化，然后交给 Core。</p>

<p>这个设计看起来比一开始复杂，但复杂度的位置变对了。<br>平台层不再维护一大堆猜测状态，Core 也不再把所有 marked range 都叫 composition。<br>真正复杂的部分集中在 Core 的 IME 模型里，并且可以通过单元测试覆盖，例如 system mark 不替换后续插入、preedit 覆盖 system mark 时只替换一次、stale context 请求重同步、document range preedit 提交不产生重复 text change 等。</p>

<h2>一些经验</h2>

<p>这次以后，我更倾向于先问几个很底层的问题，而不是一上来统一平台 API。<br>平台现在给的是操作意图，还是文本结果？这个范围是真实 preedit，还是 system mark？这个 offset 是文档绝对坐标，还是 text window 本地坐标？这个输入来自最新 context，还是旧 context？<br>这些问题如果答不清楚，适配层迟早会开始撒谎。</p>

<p>当这些问题都有明确答案之后，协议反而会变得稳定。<br>Android 可以继续用它的 <code>InputConnection</code>，Flutter 可以继续用它的 <code>TextEditingValue</code> 和 delta，Apple 可以继续用 marked text，Swing 和 WinForms 也可以保留自己的事件模型。<br>SweetEditor 不需要把所有平台变成同一种输入法，它只需要让平台把事实讲清楚。</p>

<p>所以最后拆成 <code>command</code> 和 <code>text_update</code>，对我来说更像是给协议加了一条约束：<br>不要把“平台做了什么”和“文本变成什么”混在一起。<br>前者是意图，后者是结果。<br>IME 适配最危险的地方，就是在这两者之间凭经验补语义。</p>

<p>这轮适配走下来确实很艰苦，但也让 SweetEditor 的输入协议变得比以前扎实很多。<br>以后再接新的平台，重点会落在判断平台能提供哪类事实，再选择 command 或 text_update，把剩下的判断交给 Core。<br>IME 没有变简单，只是复杂度被放回了它应该待的位置。</p>
