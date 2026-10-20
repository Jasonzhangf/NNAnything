# NNAnything 总体设计

版本：修订6架构基线。L1 能动切片已交付并验收，当前用户授权基础工作流资产设计与目录分类（nnanything-design-workflow-assets），2026-10-17。先定义通用框架，再确定最小基础节点，组合网页与训练workflow；以后扩展其他场景。以filter节点、事件I/O和统一workflow为主轴，画布是可选呈现。黑白名单、DOM拆分、判断及operation供使用者组合，不固定业务流程，详见[事件与呈现](canvas-events.md)及[节点与Workflow](node-workflows.md)。保留单标签、按序批处理和[Focus入口](focus-and-labeling.md)。

本文件是总体方案入口。具体目录、配置、节点与四层优先级以[实施计划](implementation-plan.md)、[节点合同](node-contract.md)和[项目治理](project-governance.md)为准；最新工作流真源见 [workflows/README.md](../workflows/README.md)，三类基础采样节点合同卡唯一真源见 [lib/nodes/README.md](../lib/nodes/README.md)。下方D1-D5为未来长期责任地图，不是当前执行授权。research保留详细依据，设计review不等于电路训练或产品可用。

2026-10-17 第一层基础种类算法与六节点离线训练已实现（详见[训练合同](training-workflow.md)）。6N6E SESE 工作流接入真实Handwired求值、反传与Adam。已有158项试验、六页201项评估及随后明确授权的MAP式增量实验已运行，范围和局限见[实验结果](training-m1-results.md)。阈值固定，置信度未校准，候选不自动采用。历史卡片sigmoid、alpha/beta或完整贝叶斯分布不作为本轮多分类实现。第二层业务语义、WebUI、Rust保持后续范围。

2026-10-19 新增结构化语义状态推理方向，以下1.1节为其目标合同。首个固定函数 `cwd+input→词法绝对路径` 已实现真实训练与回载，见[路径训练](cli-path-training.md)。历史独立 `observe_cwd→pwd` 实测见[Goal动作训练](cli-goal-training.md)（作为兼容基线保留）。当前正式收敛为全命令单一共享模型与权重profile，依序增量拟合PWD、CD、LS，唯一训练合同见[文件系统训练合同](cli-filesystem-training.md)。

## 1. 目标与边界

建立以有类型输入输出的filter为节点、以workflow组合执行的通用框架。节点定义处理能力，workflow定义应用流程；正式执行、数据准备、训练与监督均按workflow组织。基础核心不内置DOM、微博或业务类别。第一个playground是微博DOM语义，跨站验证在后。

节点通过类型化事件接收输入、读取明确状态、完成处理后发出输出。核心提供端口、连线和有限DAG执行，首期不引入消息中间件或独立复杂状态机。Workflow本质是节点接续，配置文件、代码或可选画布共用定义与执行合同。观测、选择、拆分/转换、判断、operation及验证作为基础能力按需组合；业务闭环可以是观测→判断→操作→新观测→验证→结束，下一次触发开启新的run，不给单次DAG加回边。

手写filter、特征转换、神经网络、拟合与评估均可封装为节点，保留各自输入输出含义。不是每个节点都可训练。节点级训练只消费输入与期望输出以及该节点的参数/损失/后端合同，不直接消费应用整页或执行动作。Workflow连线表达步骤依赖，Handwired内部连线表达数值与梯度，不能混为同一张训练图。

页面可作为浏览器识别层共享上下文。示例用viewport、focus、白名单/黑名单限制范围，再由拆分节点生成不同层级的DOM独立输入，并检查展开项的候选资格。父节点跳过自身不自动裁掉后代。每项复用同一处理节点，不为每个DOM元素新建画布节点。首期一个任务对每个节点输出一个标签，也支持节点数组按序返回；暂不做同节点多个标签同时输出。二分类是该任务合同的特例，isTarget可作为相应二分类视图。过滤掉的候选不是模型负例。

目标覆盖：帖子、作者、正文、互动、媒体、来源标记、搜索及个人入口。语义用固定类别和结构查询表达，正常推理不依赖LLM。广告/推广/推荐显式输出，不只作为普通帖负例丢弃。

两个浏览器模式：使用模式定位具体目标供程序读值/操作；监督模式记录每次操作、由LLM回溯失败、选择样本修复并比较版本。两模式共享原始样本、目标定义及profile。

本节D0浏览器基线的非目标：自动把任意JS编译为神经网络、一次性训练所有站点、把整个页面输入filter、运行时用LLM解释查询、替用户学习或更改已明确的业务策略（例如哪些内容应隐藏）。D0原轮次只交设计，不授权当时的实现；后续已明确授权的训练与能力以各自当前合同为准。

### 1.1 结构化语义的目标与状态推理

2026-10-19 冻结四元素基础合同：每个语义及其训练设计均围绕 `Goal / satisfactionThreshold / State / Action`，形成语义闭合、单入口单出口（SESE）且满足最小必要性的 DAG。该合同适用于浏览器、CLI 及后续 computer use；不表示所有场景已实现。治理过程唯一入口为[本地设计流程](../.agents/skills/nnanything-design/SKILL.md)，拓扑唯一真源为 `workflows/project-design.graph.json`，由 DAGpipe 校验管理。冻结指当前标准生效；后续按明确需求修订同一正文，不建立冻结快照或身份包装。

| 元素 | 必须明确的语义 |
| --- | --- |
| Goal | 目标及其满足度评价规则，包含必要条件与证据要求 |
| satisfactionThreshold（满足度阈值） | 0–100 的最低满足度；结果达到要求即可结束，更高不是必要目标 |
| State | 当前条件、对象及必要关系、知识与观测来源；实际结果以 New State 表达，未知不伪装为已知 |
| Action | 必要操作、对象和参数引用、适用条件及预期状态变化；计算或识别也可作为增加知识的操作 |

`satisfactionThreshold` 表示要求；`satisfaction` 表示实际满足度，是 Goal 对实际 State 的评价结果，不增加为第五个基础元素。满足度不等同于模型分数或动作执行成功。获取 cwd 等二元目标只用 0/100；search 等确有部分成果的目标才定义中间满足度。覆盖度只有在 Goal 明确定义时才代表满足度；搜索进度不能自动证明已找到目标。必要证据不足时保留未知，不编造数值。满足度达到阈值且 Goal 必要条件成立才算达标；满足度阈值不放宽权限、数据正确性或 Goal 的必要条件。

反向推理属于训练过程：由 Goal 与 satisfactionThreshold 要求反推达标 State、所需 Action 和前置 State，形成可学习关系及监督；它与数值梯度反向传播分别说明。推理使用学到的关系选择操作与参数，执行后用实际 New State 评价；预测不能替代实际结果。对象关系、动作条件及评价均归入四元素，不另立平行基础要素。纯分类及固定函数显式声明固定 Goal/satisfactionThreshold、输入 State、计算 Action 和知识输出，不强造环境操作或可训练头。

四元素不机械对应四个节点。仅当 State 或 satisfactionThreshold 会改变正确输出时，才需要相应的学生输入与区分样本；固定项可为显式配置。每个节点、输入、wire、边和验证步骤均须回答：删除后会破坏哪项语义闭合、必要可辨性或验收依据？无独立必要性则删除或复用。每次运行单入口单出口，达标、未达标、失败及证据不足均收束为明确结果；跨步迭代以实际 New State 开启新 run，不在单次 DAG 加回边。当前共享CLI命令切片已采用固定 satisfactionThreshold=100，并输出实际 satisfaction 100/0/null；该接入不表示自动采集或自动采用链已实现。

用户当前目标为结构化 `Goal → State → Action → New State`。手写基础概念、动作输入输出和执行结构；NN学习概念关系、动作与状态变化的关系，以及给定Goal/State的动作调用选择。全程使用结构化语义，不训练自然语言请求识别。概念层、动作层、推理层是此方向的三类训练职责，与下文浏览器基础语义/组合识别的两层分类对象不同。

所有注册CLI命令收敛为单一共享模型和权重profile（`cli.command-policy.v1`）。输入为结构化Goal与State；公开入口以`createCliCommandPolicy({profile,sandbox,session:S})`绑定显式资源，再调用`.step({goal,state,directory?:D})`。模型输出标准调用序列。序列首项为实际Shell命令名，后续项为有类型的简化位置参数。当前增量拟合命令头，参数引用机械绑定，实际New State由harness观测与验证；未另训练状态预测头。

| Goal | 显式资源信封条件 | 模型输出调用序列 | harness固定执行与实际New State验证 |
| --- | --- | --- | --- |
| `observe_cwd(S)` | 显式session S | `["pwd"]` | 读取S当前cwd，执行固定PWD观测；执行基准不变；新增实际cwd观测及证据 |
| `set_cwd(S,D)` | 显式session S与目录D | `["cd", D]` | 绑定D，执行固定CD脚本，成功后显式提交S的执行基准；在同一S重新执行真实PWD观测核对目标 |
| `list_directory(S,D)` | 显式session S与目录D | `["ls", D]` | 绑定D，通过固定结构化helper列举直接子条目；不解析`/bin/ls`面向人类文本；S状态及FS内容不变 |
| 未支持的语义Goal | 任意输入 | 无调用（`unsupported`） | 策略记录`unsupported`，不调用任何Shell命令，不修改任何状态 |

在此共享模型中，模型只负责内部命令头路由与参数角色输出。`["cd", D]`是一次调用的参数序列，不是多步规划。CD后的PWD是harness固定后条件验证步骤，不冒称模型学会了多步规划。

读取与修改分开：pwd改变的是已知信息，不能误标为修改执行目录；cd改变指定会话的执行基准，不能通过一次性子进程中的cd冒充父会话已改变。执行器使用明确session资源，不隐式修改Agent父进程cwd。

训练/反馈样本统一为 `{goal, state_before, invocation, execution_result, observed_state_after, goal_result}`。NN预测调用序列，真正的New State由harness执行与OS观测提供；预测不能充当事实。目标检查器按结构化Goal验证，失败/未知均保留，不由模型自报成功。

实施状态：当前共享命令策略（`createCliCommandPolicy`）与多分类增量训练（`runCliCommandTraining`）已在`nnanything/cli-goal`实现。原有六参数二分类PWD API及模型保持兼容基线，新共享入口不调用旧profile。正式共享训练、保存后新进程回载及独立验证已有实测证据；候选保持`uncalibrated`与`not_applied`。

### 1.2 固定语义调用与全模型自进化

用户进一步明确：推理选择获取目标所需的语义命令头与位置参数；调用序列固定，由harness转换为实际固定CLI调用与语义操作（`cwd.get`、`cwd.set`、`directory.list`）。语义目标、调用选择、参数绑定、真实执行与效果验证分工明确。

所有接入CLI命令统一按[CLI调用参数简化](cli-call-contract.md)约定：输出`["command", ...params]`，S置于信封，不训练原生flags、shell脚本编写或输出正文解析。命令/argv/默认行为和机器回执由harness负责。

所有模型的目标架构均包含使用时采集、训练/使用版本隔离、独立配对比较及条件自动升级。有明确提升、所有必需旧能力无回归且证据完整时自动采用；冲突或回归保留当前版本，留证据交大模型判断。大模型可以修订设计连线，但先更新对应外层DAG、内部数值图和合同，再走实现、训练与验证，不能直接改在用版本。唯一完整合同见[语义调用与模型演进](model-evolution.md)。这是当前新设计要求，不冒称已有离线训练已实现自动升级。

### 1.3 本地基础设计入口

Shell 的领域目标进一步统一为 `file.property.xxx`，涵盖路径、目录及普通/特殊文件的属性观测与变化；不零散新增场景Goal。内容、用途及操作适用性归入同一属性体系。领域合同唯一源为 [cli-filesystem-semantics.md](cli-filesystem-semantics.md)，共享属性状态转换图为 `workflows/cli-file-property.graph.json`。类型共享推理合同，各自保留操作与真实效果语义；现有CLI接口未迁移，不将设计图标为运行能力。

新增能力或修改I/O、状态、harness、数值连线、workflow及采用规则，统一使用[本地设计Skill](../.agents/skills/nnanything-design/SKILL.md)。基础流程是现状/缺口→语义目标与效果→固定调用与执行责任→内部数值图及外层DAG→样本隔离与进化验收→图纸合同校验→可实施设计或具体缺口。持久过程图见[project-design.graph.json](../workflows/project-design.graph.json)。这是本项目设计方法，不代替独立Plan和已有开发交付流程，也不把设计图当已实现算子。

## 2. 手写入口、四层职责与两层训练

| 层次 | 处理对象 | 输出 | Owner |
| --- | --- | --- | --- |
| 手写预过滤 | 页面候选及viewport/focus/白黑名单规则 | 放行候选与排除原因；不产生语义负标签 | 浏览器候选程序 |
| 观测 | 节点及必要局部DOM/布局/属性/滚动 | 可测数值、局部结构与原始证据 | 站点/浏览器适配器 |
| 基础语义 | 单节点观测参数 | 作者、正文、互动、来源标记等目标分数 | 已声明目标filter |
| 组合识别 | 单节点参数、成分分数与关系摘要 | 完整对象、成分归属、广告/推广等组合目标分数 | 组合filter与外部上下文编排 |
| 策略操作 | 分类、具体节点引用、用户规则 | 查询、读取、展开、隐藏等动作 | 浏览器程序/调用者 |

基础语义和组合识别是两层可训练结构。浏览器已直接提供的img/button等事实直接读取；需要学习的是头像/配图、点赞/普通按钮等角色。仅为复述输入role而训练的分类器没有独立价值。

手写预过滤位于神经网络入口之前：读取规则所需的基础几何/属性，示例顺序执行viewport、focus和白黑名单规则，拆分后对保留项做完整取参与神经网络求值。ManualFilter返回pass/reason；NeuralNode返回单标签/分数。规则链和模型职责分离，均可各自回放，但规则不冒称可训练分类器。每个步骤可独立节点化；此顺序约束本应用，不成为核心固定管线。

两层结构与两阶段开发不同：第一阶段只用自身和可测关系建立基线，先实现少数目标；第二阶段引入其他节点实际预测，训练组合/协同支路。第二阶段内部可使用有限推理轮次，但不等于只有第二次推理。完整卡片可保留直接识别基线，验证组合层是否有增益。

广告、推广和普通帖同样可以有作者、内容与互动。结构post.card不等于post.card.organic。用户指定排除某类内容属于明确策略，不与结构完整性混为一份标签。

卡片族采用共同的结构判定合同：post.card提供完整卡片结构支路，来源目标复用该支路而非独立重学边界。来源结果受结构结果约束，非卡片不输出为卡片子类；已确认广告/推广/推荐与organic互斥。训练保持连续logit和原始样本，不先硬删结构负例；推理的一致性组合由外部解析器完成，不改变当前被判断节点。组合分数属于新分数合同，不能沿用子支路的概率校准宣称。

organic是本实验的复合目标，不承诺只有一种实现。若结构/来源证据不足，不能用“所有来源filter低分”证明普通帖；解析器须保留未定情况。每个可训练目标有filter，但分类目录中的确定性原语或组合目标无需各自复制一套网络。

## 3. 分类、关系与查询

固定target沿用 [完整目录](../research/semantic-query-contract.md)。三组代表目标：

- 结构与内容：post.card、post.author.name、post.author.avatar、post.body及text/image/video/link成分。
- 交互：search.input、account.self.entry、post.comment.entry、post.repost.entry、post.like.entry、post.body.expand、navigation.entry；post.comment.item是实际评论容器，与评论入口分开。
- 内容来源：post.card.advertisement、post.card.promotion、post.card.recommendation、post.card.organic。它们是语义目录，实际单标签任务只选择明确互斥的子集；重叠含义不强塞进一次分类，未知不自动变负例。

查询字段为target、within、scopeMode=owned/subtree、cardinality=one/all、where.visible/enabled。within存在时缺省owned：枚举局部DOM后按该target声明的规范归属筛选，内嵌帖子和单条评论形成各自边界，不能把其作者认作外层作者。subtree显式表示纯DOM自身及后代，不承诺语义归属。最近候选祖先只是证据，不等于归属真值；归属未定且会影响one选择时返回ambiguous，不能默默跨边界或丢弃。

候选前置合同新增FocusSpec：viewportOnly固定true，within/region限制当前关注对象，deny优先allow，未配置allow不额外限制、显式空allow不产生候选。该合同与where.visible/enabled区分：前者限制是否进入分类，后者是查询/操作条件。部分可见即保留，过滤当前容器不默认裁掉其全部后代。排除与上下文规则沿增量合同。

one有多个合格结果返回ambiguous，零个返回not_found；不自动选最高分。目标未知/未支持返回unsupported_target，范围引用失效返回stale_scope，必要观测缺失而无法判断返回insufficient_observation。查询返回具体nodeRef与目标分数，读取和动作另行调用。

DOM节点、AX节点和可点击祖先可能不同。每个目标必须有规范边界；标注和推理使用同一种边界。姓名与完整URL可以在定位后读取，不作为身份捷径训练。

查询引用不会自动提升到可点击祖先。操作请求若需要另一个节点，显式要求相应操作目标（如navigation.entry），并带原节点的局部范围/关联依据，由适配器返回唯一可操作引用。无法确认时拒绝该动作并记录原因，不选择任意最近可点击祖先。

在已定位正文范围内，text/image/video/link优先使用DOM/AX事实筛选；涉及头像/徽标排除、播放器边界或链接行为歧义时才增加目标filter。读取目标与操作目标分开，不将href存在视为已证明导航成功。

关系直接进入参数：父子包含、相对尺寸/位置、兄弟对齐/间距、成分计数及局部共现。第二阶段再加入父级、子成分、兄弟上一轮的预测摘要。nodeRef/ownerRef只关联证据，不作为数值特征。DOM包含不自动证明语义part_of，须覆盖内嵌转发和评论区。

上下文编排在filter外完成，汇总成当前节点的固定维度参数。协同轮次同步读取上一轮结果，避免遍历顺序改变语义。初始分数来自基础观测；不无限迭代或把相关分数当独立似然反复相乘。准确轮数、摘要和每目标电路在后续审图时确定，本设计不伪称这些参数已验证。

## 4. 模块与目录规划

最新单源目录架构唯一维护于 [实施计划](implementation-plan.md) 第 2 节。以下为模块责任概览：

| 路径 | 职责与禁止事项 |
| --- | --- |
| AGENTS.md | 项目边界、唯一owner、数据/标签/推理隔离；引用全局流程，不复制治理 |
| lib/core | 通用Node/Workflow事件端口、输入输出、参数/Profile与后端合同；不内置DOM类别 |
| lib/workflow | 通用事件关联、依赖执行、静态校验、分支/过滤结果与记录适配；不放站点规则 |
| lib/training | 节点训练算子与适配合同；只依赖通用节点样本合同 |
| lib/nodes/trainable | 可训练节点结构与Handwired电路定义；不存真实权重 |
| lib/nodes | 可复用节点定义（通用与DOM语义），三类采样节点卡见 [lib/nodes/README.md](../lib/nodes/README.md) |
| lib/filters | 纯内存确定性过滤规则与候选求值内核 |
| lib/adapters/browser | 页面观测输入与引用适配，供应用节点调用 |
| workflows | 项目DAG图与持久配置唯一真源，清单见 [workflows/README.md](../workflows/README.md) |
| training | 本地样本(samples/)、评估报告(results/)与真实权重(weights/)资产根目录 |
| tests | 公共consumer、基础反例、后续真实入口回归；不测试假训练/假点击成功 |
| docs / research | 当前方案与流程 / 原始调研依据；旧草案需明确适用范围 |
| data/raw、labels、datasets | 本地原始资料、规范标签、派生向量；默认不入Git |
| artifacts | 本地profile、评估报告、回放记录；按需另定哪些可共享 |
| playground | 小规模实验入口说明；代码开发仍用外置独占worktree |

画布只规划编辑/查看workflow这一责任，当前不新建UI目录或实现编辑器。先用可读定义表达节点与连线；后续UI不能维护第二份执行真源。

模块依赖草图：状态为设计候选，仅描述依赖，不证明已执行。

```mermaid
flowchart TD
  S([通用节点与数据合同]):::boundary --> C[工作流定义与核心执行边界]:::action
  C --> D[应用节点与数据准备定义]:::action
  C --> B[浏览器及取参适配定义]:::action
  C --> H[数值节点后端定义]:::action
  D --> T[节点训练及评估定义]:::action
  H --> T
  B --> U[应用工作流及监督证据定义]:::action
  D --> U
  T --> P[公共入口与消费合同检查]:::action
  U --> P
  H --> P
  P --> Z([框架设计与待实现清单]):::boundary
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

## 5. 核心数据合同

| 合同 | 必需含义 |
| --- | --- |
| NodeDefinition | 通用处理器的输入/输出、配置和参数合同；可选训练适配，不依赖应用 |
| WorkflowDefinition | 节点实例、数据依赖、配置/profile绑定、执行结果及错误出口；不把日志当控制真源 |
| FilterDefinition | 具体filter节点能力；神经网络节点另声明taskId/标签、按序特征/变换、手写数值图及可训练参数 |
| NumericInput | inputContract、当前节点的数值向量；不含页面、DOM对象、class/id或账号文本 |
| NodeResult / FilterResult | 按节点合同区分规则pass/reason、转换数据、语义label/分数、训练产物等；神经网络首期单标签，二分类可提供isTarget视图。应用批处理保序，不伪造分类 |
| Profile | 普通版本标识、target、兼容的输入/电路合同、权重、阈值、校准状态/参数与训练来源引用 |
| Snapshot | 采集批次、页面/帖子来源组、原始DOM/截图/布局等引用及各自时间；保留不同步限制 |
| LabelRecord | snapshot/node/target、truth=true/false/unknown、规则/LLM/用户来源、证据、复核状态 |
| Dataset | 规范标签引用、派生向量、group、用途分区；标签与原始字段不拼进特征向量 |
| OperationSample | episode/step、结构查询/动作/预期、当时profile和候选分数、FocusSpec及规则版本/排除记录、前后现场、实际结果 |
| FailureReview | 失败owner、errorType、首次偏离证据、标签提议与train/regression/investigate/duplicate处置 |
| Comparison | 同组样本当前/候选预测、真值、fixed/regressed/unresolved/retained/unassessed及分项指标 |

原始与学生数据使用两份不同合同：RawDomNodeEvidence可含class/id/text/url及原始DOM，只供teacher/标定与受控证据存储使用；StudentNodeObservation由取参器按显式白名单生成，只含已声明类型/属性编码和数值测量，不暴露原始对象或全部attributes。训练接口不接受RawDomNodeEvidence；NumericInput只由StudentNodeObservation及FeatureSchema生成。类型隔离不能证明取参值的真实来源，后续还需对原始名称/账号变化而允许观测不变的反例检验，防止编码旁路。

FeatureSchema逐项声明required、单位/变换和缺失处理。required缺失则返回取参失败，不调用filter；optional使用固定中性值和明确的availability位，并将该位纳入已审连线。已观察到不存在的成分计数0与没有观察到分开；不得传NaN/Infinity，或以0伪装未知。第一阶段不声明语义预测字段，第二阶段才按同一规则添加。

新增ScopeAnnotationCompleteness：snapshotId、scopeRef、target、boundaryContract、已穷尽的规范正例、eligibleCandidateRefs、excludedUnknownRefs（含未定等价包装）、ruleVersion、复核状态和证据。明确负例可以单独标注；自动补负例只允许在已核实完整的目标/范围内，对eligible集合减去正例与excludedUnknown集合，不能将未命中规则的所有节点直接置false。

Snapshot与规范LabelRecord及其更正记录是数据来源；Dataset向量是按inputContract生成的派生物，保留回到原始现场和标签的引用。证据或必要测量不足时不可声称能重新提取。

缺少数据和负面真值不同；expectedNodeRefs空数组表示无目标，缺省表示未确定。页面或节点引用失效时重新解析；不能把失效自动标成filter错误。

profile兼容检查只针对输入含义、顺序、变换和电路契约，防止错接线；不建立SHA/冻结快照或候选身份治理。

## 6. Handwired连接与训练路径

Handwired提供手工数值电路与参考反向传播，不是任意JS可训练编译器。已核查其reusable-layout示例；权重和输入分别连source cells，a*x经multiply，明确求和及折线经roundAffine/ReGLU。布尔阈值在损失梯度外，避免先硬截断导致误判无法纠正。

第一阶段优先可解释稀疏支路：自身类型/布局、局部结构/成分、相对关系、来源证据。每个目标声明使用的输入与权重，不能把同一个10输入卡片图用于所有语义目标。[旧卡片图](../research/filter-wiring-audit.md)是审计候选，不是已批准公共架构。

二分类首选连续logit z，宿主计算sigmoid/BCE并将梯度传回电路；Handwired不被宣称自带指数。未经独立校准的confidence保持目标分数语义。重复反馈不是新独立样本。

FilterDefinition声明每个参数的符号/区间约束。旧卡片草案中明确表示惩罚的am、ab、ap要求非负，拟合后投影到允许区间；其他参数的符号也需与支路语义一致或明确为有符号证据。不能一面称固定负向证据，一面允许权重无说明地反转。只投影权重，不对可训练分数先硬截断相乘。

权重拟合始终使用未校准logit z；每次生成新候选后，旧校准状态先失效。独立校准需满足目标合同的正负类、分组覆盖条件，并约束alpha>0。条件不足则alpha=1、beta=0、calibrated=false，分数保持未校准解释；阈值保留预先声明值，不在黄金集上补调。若有独立校准数据才重新拟合alpha/beta与预定阈值。单快照阶段只能报告开发拟合，不提供独立校准/泛化成绩。

训练workflow首先组织旧训练样本+新样本重拟合，各节点负责自身I/O及拟合/校准/评估能力。当前权重可热启动，这不等于贝叶斯更新。顺序近似贝叶斯作为后续独立训练策略：后验近似作先验，只加入未吸收的新标签；更正已吸收标签时按规范真值重建，不叠加矛盾证据。若全量回放则从基础先验计入全量规范标签，不再重复施加吸收同批旧数据的后验罚项。

训练路径设计候选：每轮单入口单出口，跨轮采用的profile成为下一轮输入。

```mermaid
flowchart TD
  S([规范标签与当前profile]):::boundary --> D[按来源分组 去重并划分用途]:::action
  D --> F[训练回放集与新样本拟合候选]:::action
  F --> G{独立校准覆盖条件满足?}:::decision
  G -->|是| C[约束正斜率校准与预定阈值选择]:::action
  G -->|否| U[alpha=1 beta=0 标记未校准]:::action
  C --> E[当前与候选在相同验收样本上配对比较]:::action
  U --> E
  E --> V{关键旧案例与目标指标满足?}:::decision
  V -->|是| A[提出采用候选]:::action
  V -->|否或证据不足| K[保留当前profile及差异记录]:::action
  A --> Z([返回本轮候选与评估结果]):::boundary
  K --> Z
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

当前离线训练仍不自动覆盖使用版本。后续统一采用策略由[模型演进合同](model-evolution.md)维护：有明确提升、必需旧能力零回归、独立证据完整且无冲突时自动升级；否则保留当前版本与差异。上图为已有训练产生候选的过程，不代表自动采用链已接通。不在设计中编造业务准确率数值目标。

## 7. 批量采集与teacher标注

数据准备workflow中的teacher与学生训练节点分开。微博teacher可用class token、结构、可见标记和内容定位规范节点，批量输出类别及真值；转换成学生白名单I/O样本后才交训练workflow。teacher只在采集标注侧运行，非LLM查询执行不调用teacher。

规则命中保留ruleId、源页面、节点边界和依据。抽查不同帖子形态及广告/推荐反例后提高规则标签可信度；未命中只能标unknown，只有证明某范围完整标注的target才可生成其余节点负例。标签冲突和等价包装边界待核实，不默认为负例。

规则能批量定位不代表准确率天然100%。teacher是否把嵌套转发作者认成外层作者、是否被站点class变更破坏、是否把正文提及广告误当来源标记，都要单独验证。人工确认的黄金集与规则派生开发样本分开，不能以teacher为唯一裁判证明学生泛化。

为同一页面保存多目标标签，未确认的其他类别保持unknown。已确认的广告/推广/推荐卡片保留各自正标签，也可对organic给负标签；不能从organic=false反推出任何具体来源类别为true。

采集前先用少量已有样本检验合同，不先构建大而空的数据设施。后续扩批时按独立帖子/广告素材/源页面状态分组，滚动和同帖不同节点不视为独立来源。

groupId取已知来源关联的传递闭包：同snapshot的节点必须同组；跨snapshot相同post或adAsset继续合组。不是将(snapshotId,postId,adAssetId)直接拼成互不相同的复合键。身份不清时保守合组或补证据，不声称已证明独立。小样本无需强行造四个非空分区；独立组不足时保留开发数据状态，推迟独立校准和泛化验收。

来源类别只在存在可区分的学生观测时启用。固定UI词仅限已声明局部槽位；图片广告标记需另审局部视觉/图像证据分支，几何或文件名不能替代识别。商业推广需明确可用的导流组件/结构或另经审计的商业语义证据；仅有“荐读”时只能确认recommendation，不能默认推导promotion。真实商业标签仍保留在标定层，缺乏可辨输入的目标保持未支持或待审，不伪造已识别结果。现有证据尚不能证明所有类别在当前特征下可分。

## 8. 监督回放与版本劣化

本节维护领域回放和归因边界；跨CLI、浏览器及所有可训练节点的采集、版本隔离、条件自动升级与大模型改图统一沿[模型演进合同](model-evolution.md)，不另设第二套采用规则。

每次查询/操作进入样本池，包含成功、失败、歧义、未知。保存当时证据，不能事后从变化页面伪造操作前状态。CDP成功回执不等于业务成功；expected后条件由动作/任务合同声明，无法判断保留unknown。

LLM按episode回溯首次偏离，区分filter、枚举器、范围解析器、执行器、页面环境与未知。只有证据足够的识别标签进入参数修复；其他问题转对应owner，不伪造成训练负例。成功样本经核实后也保留代表性回归，避免只观察失败分布。

旧训练回放集与新训练集共同拟合；校准集选分数解释/阈值；独立黄金集与新留出批次验收。用于调参或选择特征的样本降为开发证据，长期反复使用的黄金集也需新独立批次补充。

逐例报告修复、退化、仍错、保持正确、无法判断。每个target分别报精确率/召回率及源批次数；广告/推广报具体漏识别，普通帖报误收/误删；归属错误另计。不能以背景负例数量、loss下降或修复数抵消关键退化。

参数修复以外的归因也进入问题回归队列：枚举/范围错误交其owner，特征不足返回输入/连线审计；修订后用同一原始现场比较完整查询。Comparison分filter级与query级，分别关联输入/取参/枚举/解析合同版本。输入合同变化时，两版本各自从同一Snapshot重提适用特征；不能用新向量直接喂旧模型。缺测、目标边界不可比或缺少正确候选证据则标unassessed并计数，不能从分母静默消失或据此采用候选。

第二阶段的训练上下文由按来源group留出得到的实际预测生成，不使用黄金父子/成分标签代替。第一阶段与关系版本的对比保留相同目标边界和原始来源组，单独检查错误传播。

离线回放只复算节点/查询判断，不重复网站点击；真实动作回归另在受控场景验证。缺少布局/状态不能假装从HTML完整还原页面。现有样本可支持合同研究，不能提供独立泛化成绩。

## 9. 开发与测试框架规划

节点及数值后端开发起点拟用TypeScript ES modules、Bun test、tsc。Workflow通用执行后端仍需评估与既有DAGpipe能力的适配，不因两类workflow就建立两套引擎，也不提前写跨语言桥。D1先定义节点/workflow合同，不导入上游私有类型。D2数值节点采用显式HANDWIRED_ROOT本地源码根，经独立适配层加载src/runtime/numeric-ui-core.ts；路径由本地配置指定，缺失时显式报错，不自动搜索或复制/vendor上游。将来分发或上游接口变更需另审，不自行发包。

检查只覆盖本轮行为：

- 契约consumer：仅通过公开入口构造定义、样本、查询与训练任务；非法目标、非法字段、未知真值被正确区分。
- 数据隔离反例：class/rootPath等未声明字段不进入向量；teacher提议不自动晋升黄金；来源组不能横跨训练与验收。
- 数值基础：实际后端接入后检验前向与可纠错梯度、profile加载等公开行为；不在未接入时mock训练成功。
- 版本比较：真值与预测配对正确识别fixed/regressed，unknown不当负例；参数与输入合同变化分开。
- 真实consumer：实现后分别验证单节点推理、离线训练产物加载和适用浏览器解析/动作，不以单测替代。

开发顺序：有效需求/图→独立计划→基础反例→唯一owner实现→公开consumer验收→一次完整milestone审查→集成。当前用户另要求整体设计先由AGY Gemini 4评估，本轮到该评估和设计修订为止。

## 10. Git、目录规则与阶段计划

Git事实：本地main已初始化，远端origin由用户指定为https://github.com/Jasonzhangf/NNAnything.git。原始DOM/截图/JSON与训练产物默认忽略，不发布登录态页面。本轮review后仅提交设计/规则/图与计划，合入main并正常推送，不做额外SHA核对。

项目实现均在 /Volumes/Intel/playground/nnanything 下的唯一独占worktree进行，主树用于集成。过程日志在仓库外的独占run目录；不能以散落复制代替Git合流。规则不新增无关AppSDK治理、机器manifest或SHA绑定。

| 阶段 | 交付 | 推进条件 |
| --- | --- | --- |
| D0 当前交付 | 架构、配置、节点/经验合同、目录、四层计划与独立设计复核；main合流并推送指定远端 | 不实现，文档/新图针对性检查与review完成 |
| D1 能动（L1） | 通用最小执行、7个手写候选节点、非DOM与浏览器候选公开consumer；不依赖画布、模型或训练环境 | 有序候选/排除输出、基础边界有真实公开入口证据；完整milestone Review后交付 |
| D2 核心功能（L2） | 在D1上增加取参、真实Handwired节点与训练；完整10节点识别和7节点训练workflow、兼容profile回载 | 数值连线先审；节点独立I/O、网页识别与训练产物加载均有黑盒证据 |
| D3 微博采标实验 | teacher规则、独立样本、可复核标签、第一阶段目标训练报告 | 标签边界与teacher质量已检查 |
| D4 关系与监督 | 预测上下文支路、回溯选择性入集、版本配对回归 | 基础版本有效，关系收益有独立证据 |
| D5 跨站验证 | 新站profile及同类目标评估 | 单站结论明确，不预设迁移成功 |

D1不要求先实现全部20个目标；D2/D3的目标子集与样本预算按验收需要选择。运行与训练骨架先建立，teacher采标规模后扩展。当前不执行D1及后续阶段。

当前优先级与验收以[四层实施计划](implementation-plan.md)为准。网页节点、通用节点和训练节点共用合同但各有职责。新场景新增相应节点、编码和适配器，不在核心硬编码场景分支；profile仅在合同兼容时复用。D3/D4属于L3按需完善，D5属于L4兼容性；不按编号一次展开全部能力。

第4节是完整责任地图，不是D1要创建的全部空模块。D2才接后端与最小离线运行；D3再接teacher与批标，D4再接完整browser动作及supervision。远期模块先写边界说明，不为它们提前造空服务、注册表或假执行接口。

## 11. 需整体评估的问题

1. 两层训练与两阶段开发是否清楚，是否存在语义循环或不必要的目标分类器。
2. 通用filter接口、上下文外置、Handwired与站点teacher边界是否一致。
3. 规则标签、独立黄金、校准和新留出划分能否防止泄漏及虚假高分。
4. 单标签任务的互斥类别、规范节点、层级拆分与focus候选范围是否足以支持后续操作；重叠语义是否保留为独立任务目录而未错误互斥。
5. 监督回溯、参数修复和版本退化比较是否遗漏关键失败路径。
6. 目录、开发/测试/训练框架和阶段计划是否有过度设计或实现前必须解决的未知。
7. 事件I/O、状态传递、跳过/失败收束和操作后验证是否闭合；是否保持最小基础节点，而没有把示例业务或画布编辑器固化为核心执行机制。

目前未知：各目标最小特征、精确数值图与Handwired依赖接入、图片广告标记的识别方式、最少样本量、阈值/指标界限、跨站迁移效果。不得将这些未知写成已完成事实。
