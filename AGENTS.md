# NNAnything 项目规则

## 架构与目录写入边界

通用核心只负责事件、节点合同与DAG执行。浏览器适配器负责真实观测，filter负责纯判断，node负责workflow封装，训练模块负责拟合与评估。正式执行和训练复用workflow合同；节点内部数值wire与外部DAG分别管理。

| 目录／入口 | 唯一职责 |
| --- | --- |
| `workflows/` | DAG图与持久绑定配置；不存节点实现或训练数据 |
| `lib/core/`、`lib/workflow/` | 通用合同、事件、配置编译和Flowed执行；不内置站点语义 |
| `lib/adapters/browser/` | DOM观测、测量、采集包和浏览器资产解析 |
| `lib/adapters/cli/` | 固定CLI进程与文件系统基础观测；不实现语义评分或通用shell执行 |
| `lib/adapters/computer-use/` | 原生桌面视觉后续范围的文档占位；当前无实现 |
| `lib/filters/` | 候选过滤、规则匹配、基础种类、评分wire与profile迁移纯逻辑 |
| `lib/nodes/` | 可复用节点封装与节点合同卡；不重复实现filter算法 |
| `lib/nodes/trainable/` | 可训练节点结构；不存训练权重 |
| `lib/training/` | 样本合同、数值后端、训练profile加载、拟合、分区和评估逻辑 |
| `training/samples/` | 原始／派生训练样本和teacher证据；本地忽略 |
| `training/results/`、`training/weights/` | 比较报告与候选权重；本地忽略；当前离线候选不自动采用，后续统一升级条件沿docs/model-evolution.md |
| `extension/` | Chrome扩展入口和权限声明 |
| `playground/`、`tests/` | 公开consumer、合成fixture、合同及黑盒回归 |
| `scripts/`、`artifacts/`、`dist/` | 构建工具、浏览器构建产物、库编译产物；不作为业务源码目录 |
| `docs/`、`research/` | 架构合同与调研；真实页面资料按现有忽略规则留本地 |
| `.agents/skills/nnanything-training/` | 本项目训练方法、特征升级与增量策略的操作Skill |
| `.agents/skills/nnanything-design/` | 本项目语义能力、harness边界、连线图纸、样本及自进化的基础设计方法；不复制全局开发流程 |
| `note.md` | 单一项目进度与证据入口；任务过程放仓库外独占run目录 |

根目录条目只允许下列注册名单。Agent写入前先选择既有owner目录；禁止另建平行的src、tmp、output、runs或模型资产根。确需新增根级目录／文件时，先在当前授权方案中说明职责并更新本名单，再创建。子目录沿上表职责管理，不为每个样本文件建立注册表。`npm run build`在编译前执行`scripts/check-layout.mjs`，直接读取本名单；未注册项或登记源缺失会让构建失败，不自动删除或登记文件。目录边界检查只防根级漂移，不宣称是操作系统写权限隔离。

<!-- root-layout:start -->
```text
.git
.gitignore
.agents
AGENTS.md
README.md
note.md
package.json
package-lock.json
tsconfig.json
lib
workflows
extension
playground
scripts
tests
docs
research
training
artifacts
dist
node_modules
```
<!-- root-layout:end -->

## 本地设计与训练Skill

每个语义及训练设计均按本地设计 Skill 的标准流程治理：Goal/satisfactionThreshold/State/Action 四元素闭合、SESE、最小必要性。基础合同唯一源为 docs/design.md 1.1；流程拓扑唯一源为 workflows/project-design.graph.json，由 DAGpipe validate/inspect 管理。缺口先收束为未就绪，不以静态通过替代真实训练和行为验收。复用未变有效设计，不增加平行台账或冻结快照。

新增能力或修改语义I/O、状态、harness边界、特征/数值连线、workflow或自动采用条件前，读取[本地设计Skill](.agents/skills/nnanything-design/SKILL.md)。它维护基础设计方法；实际架构与采用规则分别由docs/design.md、docs/model-evolution.md维护。已有合同内的普通拟合不为此重做设计。

新增输入／wire、调整标签、训练、增量拟合和回归时，读取[训练Skill](.agents/skills/nnanything-training/SKILL.md)。算法合同仍由docs/basic-kinds-wiring.md维护，训练I/O合同由docs/training-workflow.md维护；Skill只维护操作方法，不复制第二套算法或规则正文。

## 当前交付边界

Shell统一目标为 `file.property.xxx`，领域合同为 docs/cli-filesystem-semantics.md，共享状态转换图为 workflows/cli-file-property.graph.json。当前运行切片是 `cli-file-property` 6N5E `0.2.0`，只接 sessionCwd observed/equals 与 directory.entries observed。路径、目录、普通文件与Linux设备/FIFO/socket等共享属性目标框架，类型保留各自操作与验收语义。目录/文件完整常见操作设计沿 docs/cli-semantic-operations.md；内容、用途、条件和目标关联纳入属性/状态转换，不建零散Goal。新增属性算子、特殊文件操作、B对象查找及旧Goal兼容入口未实现，不把设计目录当运行API。

2026-10-19 新增独立 CLI 方向，用户将起点收敛为 pwd、文件路径与文件属性。当前 M0 只实现三项基础观测和独立测试，合同见 docs/cli-foundation.md；通用核心不内置 CLI 分支。help/说明泛化及其能力/参数角色学习、目录下文件/符号名称搜索仍为后续目标。路径动作训练见下方独立增量，不能据此冒称help或搜索已完成。Computer use 暂缓，仅 lib/adapters/computer-use/README.md 占位，不启动桌面观测或操作。CLI 任务的词语输入合同独立定义，不直接套用 DOM 学生身份字段禁令。

当前 CLI 设计按语义语言推进，不做自然语言请求识别。先定义精确单操作，再设计单个最低层次的模糊目标绑定；唯一合同为 docs/cli-semantic-operations.md。首轮“模糊”指目标未提供完整路径，在显式已观测范围内绑定目录，不含名称近似、隐式目录扫描或组合规划。该设计不等于已训练，也不扩大 M0 运行能力。

逐能力实施先完成精确 `path.resolve(cwd,input)` 的函数表达训练，合同与结果唯一入口为 docs/cli-path-training.md。学生只学习符号动作，名称复制、栈原语和分词是手写基础；teacher与POSIX oracle不得进入学生rollout，不以teacher修正替代模型错误。独立cli-training入口显式加载候选，M0和浏览器权重不变；目录绑定、help与组合操作继续后置。

后续推理按结构化Goal/State/Action/实际New State闭环训练，目标合同唯一入口为docs/design.md的1.1节。所有已注册CLI命令统一使用单一共享模型和权重profile（`cli.command-policy.v1`）：heads为`unsupported,DEFER,NOOP,pwd,cd,ls`，当前14条有序wire，单矩阵6×14共84参数。typed请求、合法未绑定DirectoryQuery、受信证据、NOOP/DEFER、阈值和统一status由docs/cli-filesystem-semantics.md、docs/cli-call-contract.md与docs/cli-filesystem-training.md共同定义；唯一训练图是8N8E `0.2.0`。`nnanything/cli-goal`已实现`createCliCommandPolicy`与`runCliCommandTraining`，本轮单候选真实训练、保存后新进程回载及作者回归已有证据。旧六参数PWD API、旧三个Goal kind、旧4×4运行对象、旧`cli-command-step`及旧cli-goal图已退役；旧4×4只做按名离线迁移。候选保持uncalibrated/not_applied，父级独立验证与局部Review已通过（34/34场景、16/16探针，3条P1关闭后复核零finding）。全仓基线用`npm run test:full`，缺显式资产即非零退出。不引入自然语言识别，不把模型预测的新状态或机械执行完成当作目标已达成。

当前页面审计按用户可观测前景限定：已确认完全遮挡项在DOM候选预处理排除，部分露出按区域保留，工具自身不遮挡站点目标。原DOM与排除证据仍保留，不转训练负例、ignore或other。后续已明确要求训练人类可观测／可交互的保留filter，输入覆盖viewport、最上层／露出区域及交互承载；阅读／显示也有价值，不等于只保留可点击元素。该训练是后续增量，不把本轮确定性遮挡修复冒称已训练。算法与限制唯一入口为docs/browser-overlay-m1.md。

当前授权包含第一层特征演进、旧profile按目标与wire名称迁移、历史样本回归和三站新场景诊断。新增输入保留缺测，旧系数不因新增wire错位；迁移补零与新规则默认系数分开。新页面留出，不因未知减少就宣称准确率提高。训练方法与增量标准流程由本地训练Skill维护，具体算法和I/O仍由既有合同文档维护。

用户在训练交付后明确新增Chrome/Chromium本地扩展：页面基础类别彩色标注、Focus焦点、点击采集与纠错、一键收集当前未知项。当前增量沿docs/browser-overlay-m1.md实现，只复用第一层分类器和候选规则；新增样本进入本地采集包，不自动训练。正确类别需用户明确确认；未知/标错未定类不能变黄金other或负例。原训练结果和旧黄金回归保留。扩展、网页测量和导出均不上传页面数据；仅顶层文档，未读iframe/shadow内部不冒称覆盖。训练WebUI与第二层业务语义仍为后续范围。

Agent现场采证与回归直接通过内置浏览器只读DOM，复用浏览器adapter和现有候选／分类workflow，在本地保存观测、逐例结果与采集包。扩展是用户验收入口；Agent自身执行闭环不得以用户重载扩展、打开面板或点击采集作为前置依赖。观测不足与分类unknown/conflict分别报告，不用强制ignore/other或丢弃观测不足来清零。

浏览器文件权重验收复用同一公开分类合同，通过显式option传入文件源，每次实际运行重新读取并解析该文件。读取、解析或合同失败时显式报错，不能使用上一次内存profile、内嵌默认权重或其他源作为本次结果。换权重不要求更新扩展；接口、观测能力或运行代码变化仍需相应构建与安装态验证。文件来源切换须使旧展示、采集资格与迟到结果失效。唯一合同为docs/browser-overlay-m1.md；设计、源码、编译产物、实际加载、采用和正式交付的状态分别以证据确认。

候选过滤、基础规则采样与第一层 DOM 基础种类算法已交付。用户已授权六节点离线训练框架、已有样本试验与微博/小红书/知乎跨页评估，随后明确要求检验增量更新。初次未见评估保留原始结果；增量实验显式划分新增训练与留出样本，旧黄金做回归。当前仅实现参数锚定的 MAP 式近似，不宣称完整贝叶斯后验。保存的候选 profile 不自动采用（not_applied）。第二层帖子/作者/评论/广告、WebUI、Rust 实现、登录区域、二维码用途与风控状态仍为后续范围。iframe 内部只有实际采到才可作为节点输入，覆盖未知不能标为 other。

项目远端为https://github.com/Jasonzhangf/NNAnything.git。训练必须有公开 consumer 真实拟合与回载证据，不以静态图校验冒称可运行。原始登录态页面、站点特定标注规则与样本产物保持本地。初始手写分数保持未校准（uncalibrated），不冒称经过独立标定的概率或置信度；重新拟合使旧校准自动失效。

通用递归 Goal 已独立实现并完成行为验收。公开入口为 `nnanything/recursive-goal` 的 `runRecursiveGoal`，调用者显式注入 adapter、技能、评价器、selector、comparators 与 effects 授权；`initialObservation` 只用于新请求并与 continuation 互斥。外层图/配置为 `0.1.0` 3N2E SESE，三个 `NodeDefinition` 唯一 owner 为 `lib/workflow/recursive-goal/module.ts`，不得在 `lib/nodes/` 复制实现。根 Goal/阈值/绑定不变，子条件须以真实 State、证据和 effects 反向满足；错误、根事实、control、effects 与 atomic ledger 分开。权限沿根、父、组合技能与子条件显式集合求交，空集合不继承权限。组合选择目前是固定有限规则，不宣称神经模型学会任意高级 Goal；browser/computer operation 未接入。验收证据见docs/recursive-goal-module.md；Review 与 main 交付回执统一由note.md维护。

## 唯一Owner与入口

- 可训练基本单元（最小神经元/神经元组）共同包含推理环、训练环、训练样本与权重，统一合同由 docs/design.md 1.1.1 维护。浏览器单步 SetExpanded 的关系/能力组合切片由 docs/browser-single-action-training.md 维护；当前已拟合独立50参数候选，未采用，不扩大为任意浏览器语义或已迁移全仓统一API。

- 总体架构入口：docs/design.md；D0交付与后续浏览器范围：docs/framework-m1.md。
- 通用递归目标与节点反向满足：docs/recursive-goal-design.md；独立模块边界及错误返回唯一owner为docs/recursive-goal-module.md；外层workflows/recursive-goal.graph.json与配置为已实现的0.1.0。根Goal保持不变，每层仅选已启用技能，缺技能显式报错；cwd公开模块首例与历史外置probe的证据边界见docs/recursive-goal-cwd-validation.md。
- 通用节点/事件与workflow合同：docs/node-workflows.md、docs/canvas-events.md；持久基础配置：docs/workflow-config.md。
- 可复用经验节点合同：docs/node-contract.md；目录和实施顺序：docs/implementation-plan.md。
- 当前第一层训练合同、内部数值图与验收：docs/training-workflow.md；外层拓扑和配置：workflows/node-training.graph.json、node-training.workflow.json（算子与绑定均为 0.1.0）。
- 推进节奏、DAGpipe/AppSDK治理、交付与审批：docs/project-governance.md。
- 项目图拓扑与流程清单：workflows/*.graph.json 与 workflows/README.md；可执行绑定直接读取它，不在代码手抄另一套图。未实现算子保持design版本。
- 基础采样与训练节点完整合同卡唯一owner：lib/nodes/README.md。
- DOM focus/单标签与数组规则：docs/focus-and-labeling.md；首个结构实验电路：docs/structure-circuit-m1.md。research中的旧organic或多标签草案不得覆盖当前合同。
- 操作目标与元素必要性关系（四元素推理链、训练反推链与最小实施切片）：docs/operation-goal-necessity.md；当前为未就绪设计合同，无运行入口、未训练，L1词表/wire、L2与L3图纸分别由各自owner维护。
- 浏览器行为目录、单步意图选择及分类后元素保留结构：docs/browser-behavior-framework.md，固定为0.1.0-design；单步复用operation-episode的7N6E，接入通用递归框架。已有一次外部原生键鼠搜索合同实验，不代表项目L1/L2/operation运行验收；新结构尚非导出API。
- 统一CLI共享命令模型与文件系统训练合同唯一owner：docs/cli-filesystem-training.md；参数简化调用合同：docs/cli-call-contract.md。
- CLI旧实现到file.property迁移的审计、完成定义、收口步骤与残留退役顺序：docs/cli-migration.md；运行形状仍由上述领域合同维护，本页不复制词表或训练规则。
- 项目进度和证据汇总由note.md单一owner维护；任务过程材料放仓库外，不建立第二套治理台账。

## 后续实现必须保持的边界

所有接入CLI命令先按docs/cli-call-contract.md简化为固定语义操作和必要typed参数，NN只选择操作/参数引用；harness负责命令、argv、默认行为及机器回执，不将shell文本生成或输出内容解析混入当前训练。调用构造、OS结果与目标达成分别验收。

用户已明确所有模型包含自进化方向：使用时本地采集，固定语义调用由harness执行，训练候选与使用版本隔离；有明确提升、必需旧能力无回归且独立证据完整无冲突时自动升级，冲突保留并交大模型判断。大模型可修订设计连线，必须先改图纸，再实现、训练、独立验证。唯一合同docs/model-evolution.md；当前自动采用与全模型采集尚未实现，原离线候选继续not_applied，不能把设计状态写成已运行。

通用核心不内置DOM/站点类别。正式应用与训练使用同一workflow执行合同；候选采用Flowed调度，DAGpipe CLI负责静态图检查。画布可选。节点内部Handwired数值图和外部workflow分别管理，跨节点连线不自动反传。

节点须能独立消费明确I/O。配置、状态、profile和effects显式传递，不读取隐藏站点全局。复用需验证合同兼容，不宣称只换权重即可跨任意场景。经验修复按规则/参数/特征/连线的实际owner处理；未知和过滤不自动变负例。

Filter 与任务监督边界：Filter 只输出语义分类、识别状态及证据，不输出训练正负极性。正例、负例和期望输出由下游训练任务按语义及训练要求显式映射；保持单项单语义分类和数组保序要求。

用户已明确要求将无独立语义的排版或冗余包装元素通过多条件评分识别为`ignore`，展示端默认不画该元素的标注框，可开启查看。`ignore`是元素分类结果，不另设保留／忽略训练头；原始DOM、分类数组和后代保留，unknown/conflict不能直接转ignore。冗余证据只沿祖先—后代包含链判断，兄弟节点不归并，也不将按钮、图标、文本等独立成分按动作目标聚合。相同尺寸或单子节点只是评分依据，不能单一判死。词表与评分合同由docs/basic-kinds-wiring.md维护；实验、接入和实际采用状态由note.md及其证据维护，不能从本规则推断某个候选已经采用。

ignore的监督目标是“是否需要作为agent独立交互／读取目标”：直接承载点击、输入、内容显示／读取或状态观察的元素需保留，无独立目标价值的包装可忽略。折叠评论／回复的展开入口、滚动后的手动加载和重试文案属于交互目标；不能因是div/span文本或位于列表末尾而判忽略。协议级操作与鼠标键盘模拟是当前交互方式；静态DOM未证明委托事件、实际命中或遮挡时保留不确定，不能把无显式监听器等同无交互。识别与操作验证分开，本轮不实现operation。

键盘焦点是必须保留的交互目标。实际可聚焦的容器不能因无自身文字、单子节点或重复包装特征被监督为ignore。焦点事实沿显式输入和评分wire传递，以焦点正例、无焦点包装对照及历史样本回归检验；不通过删除焦点节点或隐藏误忽略来减少未知。当前事实涵盖已采到的焦点属性；未观测焦点不能补为false，也不能声称已覆盖所有动态焦点机制。

两层边界：第一层输出通用基础种类及判断证据；第二层组合基础成分与关系形成应用语义。当前只实现第一层，不能将旧 post.card 应用结构电路冒充通用基础种类算法。未知测量不能补0或转为负例。

基础分类器对合格输入输出一个具体类别或 other，并保留 unknown/conflict 等评分状态。other 预测不自动变黄金监督。所有分类属性走显式评分 wire，不按 SVG/hidden/role 等单一属性提前判死；前置 viewport/focus/黑白名单是独立筛选职责。无已验证辨别权重的状态属性保留可配系数，默认0，不编造类别否决。后续新增类别复核旧 other 样本及旧类回归；标签全覆盖不冒称主流页面已实测全覆盖。

学生特征禁止原始class/id、账号/正文名称、完整URL/图片名、绝对根路径和全局深度；这些资料仅可用于原始证据与teacher标注。单任务单标签，数组保序保留排除/未知；同来源关联组不得跨训练和独立回归。

使用Handwired必须显式配置源码根，缺失报错、不复制上游或假训练。新拟合使旧校准失效。离线训练/回放不触发浏览器operation。首个结构任务不冒称已解决普通帖/广告/推广来源分类。

代码开发、测试、独立Review、Git集成和独占worktree沿全局AGENTS与适用Skills。本项目不新增机器manifest、全局插件注册服务或另一套执行引擎。

## 推进与授权

单元升级另沿 workflows/model-evolution.graph.json 与 model-conflict-design.graph.json：自动使用采样及真实训练是必需环节；满足既有提升/无回归/证据条件自动升级，回归或冲突不得自动改权重，保留当前版本并交大模型裁决。唯一规则为 docs/model-evolution.md；当前仍为设计要求，不冒称自动链已实现。

需求优先级依次为能动、能有核心功能、完善功能、提高兼容性。先交最小能动切片，不提前扩展。各层验收沿docs/implementation-plan.md，安全和数据正确性不后移。

项目内agent派发只要符合全局派发原则、已有任务范围和文件owner，不需要单独授权。当前授权包括最小离线训练、已有样本试验、跨页评估与明确分区的增量实验，结果见 docs/training-m1-results.md；第二层业务卡片语义、WebUI、Rust 保持在范围外。完整重大实现milestone作者验收后整体Review一次，不逐节点加审批。

采用DAGpipe图治理与AppSDK需求/交付治理原则。有效.appsdk/requirements.json存在时通过正式入口读取适用项；当前未初始化AppSDK，不伪造受管状态、不建需求占位。首次入驻沿既有prepare确认合同，不把它变成日常派发许可。

本项目禁止不必要SHA/checksum、哈希清单、候选身份包装、冻结快照和重复校验。保留当前失败模式所需的真实入口、安全及数据正确性检查；有效未变证据直接复用。具体规则只维护于docs/project-governance.md，不新增另一套门禁。
