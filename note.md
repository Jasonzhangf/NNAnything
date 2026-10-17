# 当前任务

## L1 Goal（最新授权）

D0设计基线已合入main并正常推送origin/main；原framework-m1工作树已remove/prune且路径不存在。用户要求review/提交后生成第一阶段能动Goal并直接执行。目标提示词保存docs/goals/l1-browser-candidates.md：只实现通用执行与七个手写候选节点，输出候选引用，不接模型、训练或动作。当前在唯一browser-l1独占树实施，复用有效独立计划及设计评估，不恢复旧M1全节点任务。

本轮独占记录 /Volumes/Intel/playground/nnanything-runs/browser-l1；D0必要证据仍在framework-m1记录目录，未将取消worker算模型不可用。下方D0不实现条款为历史阶段，当前L1实施由上述最新指令明确授权；后续L2-L4仍未启动。

2026-10-17 L1作者验收完成：Node22.22.2、TS5.9.3、实际Flowed1.15.0；公开load/compile/run、三种common算子和七个dom算子已实现。项目候选图升级0.1.0，仍7N6ESESE；validate/inspect各一次通过，其他design图不变。配置与程序定义进入同一compile，不新增调度器、AppSDK占位或不必要SHA校验。

原始验收：core-expert/test-final.log 48/48（28核心、20浏览器），build-final.log、demo-common.log（total18）、demo-browser.log均成功；browser-expert/final-tests.log 20/20、final-demo.log验证13槽位页面及6槽位显式数组，重复保留、deny优先、未知不复活。必要反例和红测分别在两组run；参考verification.md汇总。依赖缓存、GCM未完整实现及Flowedautomap问题都保留原错，由对应owner修复，不削弱断言。

父任务另通过公开包入口和真实Flowed消费本地微博保存观测：2000输入→2000槽位，605过滤、528自身跳过、867未知、0确定候选。缺fragments/clipping是观测证据不足，不能据此报告识别率或精确可见；原始登录态内容未进入Git。此项补充browser-expert的纯适配证据。

独立整体Review完成：Gemini4 medium新会话a225d760-ee1c-4383-9928-d1d9a1ec1cd5，实际gemini-4-argon-medium，SUCCESS/exit0；按canonical reviewOutputSchema/classifyReviewOutput核对scope与字段后宿主裁决PASS，findings=[]。原始结果docs/reviews/gemini4-l1-review.json，过程review/。实现提交ac95c28已ff-only合入main，并正常推送origin/main。主目录npm ci、构建及两个公开consumer成功，证据main-build/main-demo-common/main-demo-browser.log；未重复运行未变的测试。

独立结案经验审计完成：fresh oauth gpt-6.1-sol medium，只读审计相关规则链、原始失败、验收与交付记录；原文docs/reviews/l1-retrospective.md。已修project-governance.md四处失效D0状态，不新增门禁。npm条件交接、规则链未完成和文档虚构示例均归当轮执行与纠正，已有规则覆盖，不晋升模型永久能力。AGY文字编辑曾未按合同使用apply_patch；记为执行偏差，不为重建编辑过程重做正确文档，不复制已有编辑规则。未修改全局Skills、全局规则或受管记忆。

L1范围已完成验收、独立Review、main远端交付和结案审计；不启动L2。资源owner是本Goal，路径为/Volumes/Intel/playground/nnanything/browser-l1及本轮临时child homes；同域仅此一树。关闭工作树、分支和临时执行环境的最终核销回执统一记录于/Volumes/Intel/playground/nnanything-runs/browser-l1/note.md；必要原始验收与审计证据保留于该run目录，原始私有页面仍仅本地保存。

## 2026-10-17 D0最终范围（最新，覆盖下方M1实施授权）

用户将本轮终点明确为架构完整/计划完整，不实现；之后才从浏览器项目开始。进一步要求可复用经验节点、DAGpipe/AppSDK治理、范围内派发按全局原则无需单独许可、能动→核心→完善→兼容四层推进，以及消融不必要SHA/校验。

产品代码任务PID76674已SIGTERM停止，控制器回执exit-15；只产生thread/turn启动，无工具改产品、无src/tests/package/node_modules。没有依赖安装、训练或浏览器动作。本轮只交文档/设计图。

origin已按用户指定配置为https://github.com/Jasonzhangf/NNAnything.git；GitHub API显示空仓库/main且当前有push权限，分支列表为空。此事实覆盖历史“无remote”。本轮按正常main合流/push回执交付，不额外SHA比较。

独立Planner的plan-refined技术方案与design-only-plan、priority-plan补充合用，后两者覆盖实施时机/阶段范围；记录在 /Volumes/Intel/playground/nnanything-runs/framework-m1。项目内交付计划已落docs/implementation-plan.md；配置、经验节点、治理分别由workflow-config.md、node-contract.md、project-governance.md唯一维护。

6项交付已有5项完成：架构/选型、配置/目录、可复用经验节点、四层计划/治理、同一Gemini4设计Reviewer增量复核；剩余main/远端提交与清理。增量报告docs/reviews/gemini4-d0-incremental-review.json返回findings=[]，实际gemini-4-argon-medium、SUCCESS/exit0，宿主核对schema/scope后仅裁决DESIGN_PASS。针对性检查：文档本地链接和diff检查通过，无产品实现；新增能动候选图7节点6边已静态validate/inspect通过。原识别10/10、训练7/8、操作7/6图未变，复用已有结果。全部图仍为design，不冒称runtime绑定或效果验证。

当前AppSDK只落治理规则，未执行控制面prepare/init；需求文件不存在按规则跳过，不建占位。后续实际入驻沿正式prepare确认合同，不将此确认扩大为日常agent派发许可。当前主线不因辅助控制状态缺失阻断。

以下为前序范围与过程，不能用来恢复代码任务或推翻当前D0边界。

## 2026-10-17 Framework M1（最新授权）

用户要求“review后开始框架和第一批必要节点搭建”，并要求GitHub选型以避免重复造轮子。此前D0实现hold由此更新为：完整设计review通过后直接实施，无需再次请求实现许可。当前设计评估已通过，开始T1共享核心合同、脚手架与红测。

本轮独占树 /Volumes/Intel/playground/nnanything/framework-m1，分支feat/framework-m1；开工前只有主树注册，nnanything工作树目录为空。无remote，使用唯一集成main，不创建远端。独占记录 /Volumes/Intel/playground/nnanything-runs/framework-m1。Opus计划调用因RESOURCE_EXHAUSTED失败；按同源后备由独立Gemini4 medium规划（conversation 29d9463b-7c16-4ff3-9585-3dc8d2519468），接受plan-refined/plan.md。独立Gemini4medium设计Reviewer conversation64c8e121-d79f-47d0-b7bb-99fe0c2f24cd返回findings=[]，SUCCESS/exit0，宿主schema/scope校验后裁决DESIGN_PASS。原始结果docs/reviews/gemini4-framework-m1-design.json，不代表运行已验收。

候选：DAGpipe CLI静态图治理 + Flowed1.15.0异步依赖执行；不接Rust桥，不另写scheduler。源码证据见research/workflow-engines.md；当前产品范围和配置草案见docs/framework-m1.md。真实网页动作不在M1，首个实验target须由可测输入支持，不冒称organic/广告识别已可分。旧数值草案仍待适用性审计。

本地GCM观察已完成（实际子进程18139，exit0，报告位于本轮observe/report.md）；确认DAGpipe0.1.1无TS绑定及CLI执行，Handwired是零依赖单TS文件，支持真实前向/反传。只读观察不证明运行、效果或桥接性能；不采纳其范围外Rust consumer建议为M1前置。

以下记录为前序设计基线及历史证据；与上述最新授权冲突的D0停止条款不再作为实施hold。

目标：先定义通用框架，再确定最小基础节点，搭建网页与训练workflow，后续扩展其他场景。以有类型事件I/O的filter为节点，通过节点接续组合统一workflow；画布是可选呈现。正式应用、数据准备与训练共用合同。核心只提供端口、连线和有限DAG执行，不固定DOM/微博业务；黑白名单、DOM拆分、判断、operation均由使用者搭建。业务状态显式传递，操作后新观测验证，结束事件收束单次执行；下一次触发是新run。训练只处理目标节点I/O、参数及损失/后端合同。DOM是首应用，神经节点首期单标签且数组保序。class/id、账号名、完整URL/图片名、绝对根路径与全局深度不输入学生模型，标注/原始证据与其隔离。

当前阶段：2026-10-17用户最新指令要求先完成整体规划设计，再由AGY Gemini 4整体评估/review，之后再决定推进。已停止实现。Git已初始化、本地main有设计基线，无remote。未提交的package/tsconfig、架构与测试草稿已归档到 /Volumes/Intel/playground/nnanything-runs/project-scaffold/unimplemented-scaffold-draft.tar.gz，未合入main；唯一外置worktree和自有分支已清理。没有src实现、依赖安装、采集、标注或训练。此前为脚手架启动实现早于用户期望，已纠正为设计优先；本轮不再实现。

## 已有材料

- docs/canvas-events.md：修订6的最小事件合同与可选呈现、基础节点能力、状态与执行进度分离、判断与操作闭环示例。只规划基础节点，不做UI、消息中间件或独立复杂状态机。新增事件/层级拆分/操作设计尚未纳入Gemini整体复核。
- docs/node-workflows.md：修订6的统一架构；第6节明确框架→最小节点→网页与训练workflow的三项交付和验收。区分通用/场景/训练节点，两条workflow通过目标节点I/O与兼容profile对齐；后续场景按需增加节点及适配器。项目图规模未变：识别10节点10边、训练7节点8边、操作闭环7节点6边；operator仅设计引用，尚无实现/注册或运行时接入。执行后端适配仍须审查，未恢复实现。
- 修订5检查：修改后的识别图和新增操作图均通过dagpipe graph validate/inspect，单入口单出口且无环；训练图未变，复用上一轮静态结果。事件运行、操作行为和画布渲染均未验证；当前没有可执行实现。
- docs/focus-and-labeling.md：用户最新决定的设计增量。首期单任务单标签，数组保序；页面共享上下文→viewport/focus/deny/allow候选过滤→取参→分类。viewportOnly固定true，部分可见保留；排除当前节点不默认剪掉其后代；上下文不是额外分类目标；过滤记录不作为负例。总体设计修订3待审，修订2的Gemini4通过不自动覆盖新接口。
- 用户进一步确认：页面必须先经过一系列手写ManualFilter（viewport/focus/白黑名单），才进入NeuralNode。前者输出pass/reason，后者语义标签/分数；只读基础过滤所需观测，放行后才做完整取参与网络计算。
- docs/reviews/gemini4-design-review.md：用户指定AGY Gemini 4整体设计Review。新独立conversation 528f539f-1599-4673-83e1-9926c4d84689；首轮5P1+1P2，修订2后同Reviewer复核findings=[]。两轮SUCCESS/exit0、实际gemini-4-argon-medium，宿主校验schema/scope后裁决仅设计通过。原始结果已存docs/reviews/gemini4-design-v1.json和v2.json；不代表实现/训练验收。
- docs/design.md：最新总体设计入口，覆盖目标/目录/核心合同、两层建模与两阶段训练、teacher标注、监督回放与开发/测试/训练框架。D0设计评估后仍等待用户决定，不自动进入D1实现。
- research/github-semantic-anchors.md：2026-10-17 GitHub 只读调研；WebUI 主参考基础成分和采样，Web2Text 参考块/边证据与结构对照，Mind2Web 参考操作证据。实际解析 WebUI 一个公开 AX 样本，328 节点；没有运行第三方模型或下载完整数据集，业务标签仍需本地标定。
- research/compositional-recognition.md：整体与成分共生，关系直接入参；第一阶段使用可测关系，第二阶段再加入父子/兄弟预测摘要。第二阶段训练与有限推理轮次分开。
- research/semantic-query-contract.md：固定 target 分类、within 作用范围、one/all 查询、结构化返回与纠错；运行时搜索不依赖 LLM。中文描述仅解释用途，不作为匹配输入。读取值和动作与语义查询分开。
- 新增显式分类 post.card.advertisement、post.card.promotion、post.card.recommendation；识别保留具体节点及当前任务单标签供操作，不能只作为 organic 负例丢弃。旧研究中的多标签不属于首期合同。推荐不自动等于付费广告或商业推广，未知标签不强行变负例。
- research/browser-semantic-modes.md：最新上层设计；两种模式、共享观测目录、多目标标签与边界、错误归因、旧新样本重拟合和独立黄金回归。两张流程图是设计图，不是 Handwired 内部数值连线。
- research/filter-wiring-audit.md：当前待审的稀疏数值连线与通用单轮反馈更新设计。拟议 10 个输入、10 个系数与 bias；Handwired 求连续分数，宿主做 sigmoid、损失和校准。
- research/weibo-filter/snapshot-001/：原始渲染 DOM、同次节点测量、随后捕获的视口截图。
- research/weibo-filter/seed-labels.json：15 个初始标注，3 正例、12 负例。包含平台广告和用户确认的商业推广；多数初始标注仍待复核。
- research/weibo-filter/user-visual-labels.json：用户截图确认的购物促销、科普荐读、社交推荐负例；后两张尚未关联到归档原始 DOM 节点。
- research/weibo-filter/visible-differences.md 和 visible-marker-comparison.json：当前可见差异。社交推荐在作者 header 前有约 33px 来源栏；作者资料区粉丝数不能混淆为来源栏。

## 当前设计与未知

用户确认推广范围包括科普/新闻荐读和“某某关注了”的推荐，不仅是付费广告或商业文案。要比较容器中实际呈现的标记后再选特征。少样本高效果是待测假设，不预设准确率。

推理与训练节点职责分开，workflow合同与执行基础共用。首轮采用旧训练回放集与新训练样本重拟合，独立黄金集与新留出批次验收。顺序贝叶斯更新保留为另一路径，拟议对角高斯/拉普拉斯近似，不与全量回放叠加旧证据。新增标签与更正已吸收标签分开处理，后者不累计矛盾证据；校准不替代分类纠错。未训练点权重不冒称贝叶斯后验。

每次操作进入样本池；LLM 按操作链回溯失败、引用证据、区分失败 owner，选择性入集。保留成功样本供核实后回归。候选版本逐例比较 fixed/regressed/unresolved/retained/unassessed，并分别报告开发回放和独立回归。离线预测回放不重复真实网站动作，也不证明动作成功。只有输入足以判别时做参数修复，否则返回特征/连线审计。上述机制均为设计，尚无实际运行记录或版本比较结果。

来源槽位是否使用纯几何，还是允许固定 UI 标记词/局部图像识别，是用户审计项。图片广告没有 DOM 文字，不能声称 textContent 能识别它。纯几何和有限样本尚未证明足够区分所有来源状态。

两张当前数值/更新图已做文本单入口单出口与无环检查；未单独渲染验收。无算子性能、学习曲线或分类效果数据。

## 独立规划与资源

记录目录：/Volumes/Intel/playground/nnanything-runs/filter-wire-audit。
Opus 5.5 medium 实际因配额耗尽失败；按既定路由改为 Gemini 4 Argon medium，独立 conversation a30e71c9-05d0-4af1-a470-20804f27e544 完成初稿和修订。初稿有未经测量的性能宣称及硬门零梯度问题，未采纳；当前用户审计稿已删去这些问题并压缩候选输入。外部进程均已退出。

下一动作：将修订6的框架→基础节点→两条workflow顺序、事件/可选画布、单标签/focus及可选层级拆分统一纳入下一轮整体设计评估；当前不为每次讨论增量单独派review。执行后端和具体端口合同在实现前收敛。本轮不进入D1或恢复实现。旧10输入图只为卡片待审草案，各目标实际数值连线仍需后续审计。项目无remote，不猜测或创建远端。
