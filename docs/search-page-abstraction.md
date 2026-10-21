# 搜索页面抽象与参数化样本 v0.1

本合同维护跨页面搜索的最小抽象、样本配置及后续训练接点。可交互环境为`playground/browser/search-fixture/`，它是被观察的合成应用，不是搜索runner、DOM解析器或已训练模型。当前不修改`lib/`、权重和基础分类词表。配置能表达不同页面，只证明表示兼容，不能据此宣称模型已跨站泛化。

## 观察依据

2026-10-20本轮在同一Ego浏览器空间，通过原生键鼠实际查询微博“露营”、Google/Bing“camping checklist”。微博显示正文、图集、视频、用户旁栏、话题及智搜内容；Google包含图片区组与网页标题、来源、时间、摘要、分页；Bing包含带引用的分节回答、网页及子链接。搜索结果可能是多个不同集合，不要求每项都有独立标题或链接。

小红书本轮可见推荐瀑布，输入查询后仍为推荐页并出现登录提示，不能当作搜索成功。知乎本轮为登录页。两站现有本地历史材料可作结构线索：小红书历史搜索含笔记/用户入口及AI总结，知乎历史材料含问题/回答摘要、作者、赞同和展开。知乎历史document标题含查询，但若干内容与查询不同，故查询关联未经本轮确认，不能作为成功gold。历史材料均为顶层文档，裁剪及候选资格未完整测量；它们已经看过，不再当新独立集。

随后按历史真实搜索URL直接导航复核：小红书仍回到推荐页和登录遮罩；知乎出现搜索外壳、未搜到内容文案与登录面板并存。该并存状态不能证明真实无匹配，仍保留访问/覆盖不足。对应本地记录为p1/p2-direct-settled.local.json；没有绕过登录或调用私有API。

原始页面与截图仅保留在`/Volumes/Intel/playground/nnanything-runs/search-results-fixture-20261020/`。入仓内容、作者名称和SVG均原创。嵌套引用、无效点击、延迟/空/错误/阻断等边界包含合成扩展，不冒称全部来自本轮现场。当前没有取得小红书、知乎的新搜索结果验收。

## 四元素与对象结构

Goal是在显式范围内获取属于已提交查询、满足内容及覆盖条件的结果。精确子目标满足度为100，明确不满足为0，证据不足为null；根目标沿实际任务阈值和必要条件判断，不将子分数相加。State包含输入草稿、已提交查询、结果所属查询、加载/错误/阻断、当前批次及覆盖、文档/观测版本与关系证据。Action为当前输入、提交、读取、翻页、展开或重试。每步New State须重新观测，动作已发出不等于目标达成。

| 对象 | 稳定结构 | 关键边界 |
| --- | --- | --- |
| SearchScope | 编辑宿主、提交/过滤控制、结果集合及关联 | 旁边的评论框或备注不是查询宿主 |
| QueryState | draft、submitted、resultsFor、requestRevision，以及请求/显示/访问状态 | 输入相等不证明提交，旧结果不能归新查询；空文案可与登录阻断并存 |
| Collection | 集合引用、当前批次、顺序、hasMore、可见/已检查范围 | 当前批次完成不等于全部覆盖；条数不是全量完成证明 |
| ResultItem | 可独立读取的内容实体、可选字段和嵌套对象 | 不固定为某站帖子或标题摘要链接三元组 |
| ContentField | title/body/source/author/time/media/metric等可选槽位 | 正文可以没有标题；头像不等于正文图片；缺失不等于未观测 |
| Relation | owned、nested、citation、control，以及查询/集合关联 | DOM包含不是归属真值，引用来源不重复算搜索结果 |
| Evidence | document/observation/revision、来源与适用范围、known/unknown/conflict | 历史、预测、fixture内部真值不能冒充当前实际证据 |

未来标准观测值用`known(value) / unknown(reason) / conflict(refs)`显式区分。字段确实不存在可为known(absent)，未测不得补false或零。稳定接口不保证所有新语义都可表示；有整类场景无法区分时，先提供缺失表示的反例，再按模型演进合同修订受影响观测或wire。

请求状态、结果显示和访问条件分别观测。例如请求可为loading/settled/error/unknown；显示可为none/old/current/empty/partial/unknown；访问可为available/login_required/challenge/unknown。不能用一个互斥status枚举覆盖所有事实。fixture scenario只配置刺激方式，不作为学生的实际状态真值；单条“无结果”文字不足以压过登录或覆盖缺口。

## 参数结构与同一核心

`cases.mjs`声明场景与配置，`page.mjs`的`renderPage(profile,scenario)`共享所有页面逻辑，`server.mjs`只选择配置，不按站点名切换解析器。参数分为：

- 内容与关系：groups/items/fields/children，主集合、旁栏、引用及原创显示内容。
- 表示：columns/maxWidth/cardBorder/fieldOrder/wrapperDepth及input.tag/type。
- 场景：normal/delayed/empty/error/blocked/ineffective，确定性查询延迟、两页批次和恢复行为。

五配置分别表达社交流、媒体瀑布、问题/回答、网页与图片区组、直接回答/引用/网页混合。核心完成后再增紧凑配置，复用现有维度；若必须改核心才能渲染，应记录具体缺失维度，不再称其为无需改核心的新增配置。此配置留出不是模型独立测试集；这些页面仍来自同一个实现家族。

fixture的字段role、item key和结构属于应用源/teacher，不能作为学生预测输入。页面仅呈现正常内容与自然HTML语义，不暴露teacher关系、expected ids、data-gold或内部profile。学生必须从实际观测和许可特征投影判断。场景选择区与搜索任务区隔离；case/profile身份、原始class/id/URL、账号名及固定位置不得作为数值答案线索。

## 交互与效果

输入草稿不改变旧结果归属；提交后显示加载及新查询，旧结果仍标旧查询。慢A、快B的迟到回调不能覆盖B。空结果、未提交、加载、错误与登录阻断分别显示；错误可原生重试，阻断保留输入但不模拟登录。主入口无效时真实点击不改变状态，备用入口可完成提交。两页分页属于明确的合成范围，新查询重置到第一页。相邻备注不变。

本版的内容响应按配置固定，不实现语义检索。`resultsFor`只表示此批应用响应属于哪次实际提交，不能据此推出内容相关性。训练/evaluator还须分别检查内容条件；可含不匹配结果这一事实不能被根目标标签掩盖。

页面自己的事件处理正常响应真实键鼠。Agent不得调用页面内部函数、JS设值或fetch替代动作。媒体是原创本地占位；视频仅封面预览，不证明播放。textarea与search input可在fixture中操作，但现有InputTextValue首轮合同仅普通text input且仍未实现，不能据此宣称项目学生已支持新宿主。

## 可训练边界

页面生成参数不等于模型权重。以下四个训练slot可复用统一infer/train生命周期；本轮只固定语义输入/输出，不注册模型、不虚构矩阵规模，不拟合。

| Slot | 许可输入及候选wire | 学习输出与反例 |
| --- | --- | --- |
| 内容角色 | L1实际结果、局部结构、文本/媒体形状、几何及known/value | result与field角色或unknown；正文/旁栏、标题缺失、头像/媒体对照 |
| 对象关系 | 候选对、显式关联、局部祖先/邻接、范围/引用证据及known/value | owned/nested/citation/control；包含但不归属、相同名字不同对象 |
| 查询关联 | 观察到的编辑/提交/结果范围与版本变化、查询比较事实 | edits/submits/results_for或DEFER；输入正确但未提交、推荐混入、旧结果同词 |
| 当前选择 | typed Goal、实际State、关系预测、启用技能和当前能力事实 | 当前动作/对象引用、NOOP/DEFER；歧义、缺测、旧引用、点击无效 |

语义模块可由手写teacher建立初始样本，经独立泛化验证后形成显式权重，再用后验样本后训练。权限、真实验收、预算和账本不学习。权重候选热重载和对照沿[有界决策合同](bounded-planning-decision.md)，训练与无回归采用沿[模型演进](model-evolution.md)；本轮不自动采用。

## 验收和后续缺口

自动检查公开HTTP资源边界、配置与同核渲染；浏览器黑盒用原生键鼠验证六表示、三个输入宿主以及延迟竞态、空/错误恢复/阻断/无效入口、分页重置和邻字段不变。根事实、阶段事实及覆盖分别记录，具名分母保存在[note.md](../note.md)。

后续样本按页面实现家族与关联episode先分区，再投影。改CSS或交换顺序不产生独立来源。合成teacher、历史资料、当前真实操作分别计数；分别评价边界、字段、归属、查询关联、实际效果与覆盖，unknown/conflict不归负例。用于修订的留出转回归，另留新材料。

现有[operation-episode](../workflows/operation-episode.graph.json)为闭合7N6E，拓扑不变，不另建执行引擎。搜索运行绑定、通用DOM语义识别、textarea/search原生能力、真实搜索训练/回载、跨站独立评价及自动采样/采用仍未完成。本轮样本与字段设计不替代这些验收。
