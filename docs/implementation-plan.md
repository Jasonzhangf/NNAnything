# D0交付与后续浏览器项目实施计划

## 2026-10-21 CLI只读精确查找下一批设计

已交付基础上的下一个最小组合为[单目录直接子项精确名称查找](cli-entry-search-design.md)：固定请求、四元素、准确结果/错误、5N4E内部责任图、Q0–Q6探索/实施路径、E01–E14失败模式及父Review验收。可直接交worker的完整提示词见[实施提示词](cli-entry-search-worker-prompt.md)。本轮仅设计，不实现/训练；实际调度复用既有recursive-goal和cli-file-property，保留全部原基础未验证项。

## 2026-10-21 Shell／文件系统第一层基础语义专项

与浏览器分层原则相同，Shell专项由[基础语义完成计划](cli-foundation-plan.md)维护21项S00–S20和worker提示词。起点为pwd、路径、目录/文件属性，区分O/D/L；词法/physical/存在性、身份/路径、mode/实际权限、格式/用途、执行/真实达成分别隔离。编程与日常role、修改操作和命令选择属于后续组合层，仍沿file.property及唯一共享policy，不复制selector。现有0.3.0切片及训练证据先核对复用，未验证不清零。

本轮仅规划，不实现/训练/操作用户文件。worker按用户分工交作者验收后的可审查候选，由原编排者继续review后集成main。21项当前待执行验收，不能据已有共享模型声称基础层完成。

## 2026-10-21 浏览器第一层基础语义专项

当前第一层未完成。逐项边界、19项任务F00–F18、依赖、隔离/组合验收及可交接提示词由[浏览器基础语义完成计划](browser-foundation-plan.md)维护。该专项区分对象种类、属性/内容、局部关系和事件事实；目标相关provider、操作选择及搜索留在后续层。最小回执知识实验已通过，只证明该有限语义可行，不代表全部基础层或旧F1通过。本文下方历史覆盖与队列保留原时点；冲突处按专项执行时核对实际入口，不把历史缺口当最新运行结论。

本轮用户只要求规划与落盘，不启动实现/训练。后续worker先完成作者验收并交可审查候选，由原编排者继续独立review，再集成main。当前19项均待执行验收，已有有效证据按兼容性复用，不强制重训。

## 2026-10-20 有界原型实施增量

用户在下节设计交付后要求实际原型及两域验证。Q24/Q25已接入显式有限结果模型与通用控制，Q26有finite合成域和真实cwd四场景证据，整体Review/main回执见note.md。Q27仅完成默认策略、共同infer/train接口、真实Handwired手工权重替换及候选热重载；真实偏好训练、后验评分/采集和自动采用仍未实施。N步可行前缀可执行，到边界用实际State重推，不要求N步内完成根。详细合同为[有界规划](bounded-goal-planning.md)和[决策单元](bounded-planning-decision.md)。下节H0–H6保留原设计批次范围，不代表本轮仍只做设计。

## 2026-10-20 人的语义评价与预测／执行双推理增补

本次用户在覆盖审计后新增：完整审已有/未来元素及评价标准，从人的可观察、可感知方向验收；基础职责独立，组合可重叠、覆盖或相互影响；多候选按满足度、显式尝试顺序和性格偏好选择；先做有界多路径预测，再沿路径单步执行，正常继续、分叉先检次优、无适用备选则重推演，指定checkpoint真实满足后展开下一段。该要求补充原Q1–Q23队列，不将其改成已实现。

标准唯一owner为[人的语义评价](semantic-evaluation.md)、[目标选择策略](goal-selection-policy.md)与[有界目标规划](bounded-goal-planning.md)。下节旧样本覆盖数字保持原范围，不能替代新的感知/组合/预测评价。目标satisfactionThreshold=90不等于所有模型90%准确率门槛；预测路线达到预期值不等于实际达成。

| 本轮项 | 产物/owner | 验收 |
| --- | --- | --- |
| H0 专项审计 | 外置run的elements/composition/evaluation/lookahead报告 | 已有与未来、人的判据、基础/组合风险和真实运行边界分开；复用有效旧训练证据 |
| H1 人的元素评价 | docs/semantic-evaluation.md | 12基础类+other、观测/关系/行为/CLI及未来占位有人的问题、必要证据、反例、unknown及分母 |
| H2 组合选择 | docs/goal-selection-policy.md | 基础无隐式耦合；组合干扰显式；实际/预期候选、同尺比较、同分与性格有确定规则 |
| H3 双推理及图 | docs/bounded-goal-planning.md、workflows/bounded-goal-planning.graph.json | 预测/执行I/O分离；N/分支覆盖/checkpoint/次优/重推演/根收回闭合，图一次静态校验 |
| H4 编码独立评价Review | 本地nnanything-design Skill | 既有milestone Review核验评估标准、oracle及逐例结果，不只看总分或测试绿 |
| H5 公共入口和自检 | design.md、AGENTS、图索引与note | 单一owner、案例一致、引用有效、设计与运行状态分开 |
| H6 独立设计审查及交付 | 独立Reviewer、父集成 | 完整设计一次Review；main/push与资源收口，未实现能力明确 |

H1/H4与H2/H3分别按依赖用互斥GCM worker并行；父负责公共入口和最终交付。计划、用户原文、审计及回执在`/Volumes/Intel/playground/nnanything-runs/human-semantic-evaluation-20261020`。本轮只设计，不修改运行策略、代码、训练样本或权重，不重复旧拟合/全量/原生验收。

未来接入在原队列后明确以下依赖，仍先图/gate/红测/实现/真实入口验收，再独立Review评价合理性：

| 新增队列 | 下一动作与依赖 | 最小验收与owner |
| --- | --- | --- |
| Q24 有界预测能力 | 选一个已验收领域，注册真实技能schema与结果范围模型，明确N和未覆盖结果；先有领域评价尺与样本 | 预测不产实际证据，缺技能/模型不造路线；转移预测与选择各有独立样本/权重及反例；领域planning adapter |
| Q25 计划控制接入 | Q24后接typed计划/cursor/checkpoint与现有continuation/ledger/retry资源 | 正常复用计划、真实分叉先检备选、无适用路径重推演、checkpoint成功再展开；不重置预算/派发；recursive-goal owner |
| Q26 双推理真实验收 | Q25及对应原子行为已验收，公开consumer与原生/OS实际后验就绪 | 正常不重推、次优切换、意外重算、短目标、未知effects/in-flight、抵消、根收回逐例验证；独立evaluator/Reviewer |
| Q27 当前候选/路径偏好学习 | H2设计及有可比较合法候选、明确用户偏好监督后实施，不以此训练循环 | 同尺/同分、风格差异与可接受集合oracle正确，真实拟合/回载/独立评价；组合策略owner；现F2不直接外推 |

## 2026-10-20 基础语义训练覆盖与执行计划

本节是当前覆盖与实施队列入口。领域算法、样本 schema、权重及评价规则仍由各领域合同维护，不在本节复制。独立规划及逐域采证保存在 `/Volumes/Intel/playground/nnanything-runs/basic-semantic-coverage-20261020/`。本轮 `.appsdk/requirements.json` 不存在，不建立需求占位。

“设计、实现、样本、真实拟合、新进程回载、独立验证、采用”分别验收。DAG 拓扑闭合不代表训练或能力完成。既有 `project-design` 7N6E、`operation-episode` 7N6E、DOM/CLI/浏览器领域图的静态回执可复用；本轮只修正文档和证据，不改变拓扑，不重复图校验。`operation-episode` 的运行绑定目前只支持 SetExpanded。

### 覆盖现状

| 能力 | 当前实现与训练证据 | 仍缺什么 | 唯一合同与证据 |
| --- | --- | --- | --- |
| DOM 基础分类 | 12 叶类加 other；已有真实 Handwired 拟合、来源组留出与历史回归；本轮新进程显式文件回载 M1/MAP，MAP 标签匹配356/357；默认仍为手写 v2 | audio 等类别缺监督，video/select 缺独立类别留出；既有样本已查看，不是本轮盲测 | [训练合同](training-workflow.md)、[历史实测](training-m1-results.md)、本轮 `c1/result.md`、`c1/evidence.json` |
| 可观测保留 | viewport/遮挡等确定性观测与候选过滤已存在 | 人类读取/交互保留的正式训练单元未实现；缺测不能当不保留 | [overlay 合同](browser-overlay-m1.md) |
| owned 与内容读取 | 归属和取值有设计；owned 当前明确返回 unsupported_scope | button.text、card.title、媒体取值的运行 API、归属证据和真实验收；原始取值不强造训练头 | [行为与元素合同](browser-behavior-framework.md)、[查询草案](../research/semantic-query-contract.md) |
| 浏览器 click | 仅 SetExpanded，50 参数候选，30 train/10 dev，新进程回载与独立受控原生验收 | 不能外推任意按钮用途或站点；训练输入仅 1 个 observed episode，其余为合成投影 | [单次训练](browser-single-action-training.md) |
| 单次失败反馈 F1 | 36 参数候选，真实拟合与回载；执行失败、无效果及未知分开 | 仅现有行为范围，不能据此说其它行为已学会失败 | [反馈合同](browser-feedback-strategy.md) |
| 渐进策略 F2 | 20 参数候选，36 train/12 dev，回载与原生重试/次选验收 | 原独立报告保留 22/24；两项 oracle 前提裁决及诊断对照单列，不能改称候选 24/24 | [策略合同](browser-progressive-strategy.md) |
| 浏览器 read/input/select/scroll/search/download/navigate | 八类行为目录已定义；其中上述七类没有项目原子能力完整训练闭环 | typed Goal、必要 State、行为及真实后条件；手工搜索案例不算项目 runner 验收 | [行为目录](browser-behavior-framework.md)、[必要性](operation-goal-necessity.md) |
| CLI 已注册切片 | pwd/cd/ls、path.resolve/relative/parts、entry.inspect；共享 10×30、300 参数；174 train/88 dev，262 条真实执行与新进程回载 | 原训练 report 仍 fullyVerified=false；外部独立套件 56/56 有限通过，5 项 UNVERIFIED 保留 | [CLI 训练](cli-filesystem-training.md)、[训练结果](cli-filesystem-training-results.md) |
| CLI 常见后续操作 | 路径、目录、普通/特殊文件的 file.property 设计目录已存在 | 物理路径、对象绑定、创建/移动/删除、内容读写、元数据设置及组合仍未训练或实现 | [操作目录](cli-semantic-operations.md)、[训练设计](cli-property-training-design.md) |
| 通用递归与单元接口 | 递归 Goal 生命周期已有运行验收；浏览器三类单元具备薄 infer/train 接口 | 有限规则 selector 不等于已训练任意递归；不因薄接口而全仓重构 | [递归模块](recursive-goal-module.md)、[基本单元](design.md#111-可训练基本单元与组合) |
| 使用采样与升级 | 分域有可选/注入采集入口；离线候选与使用版本隔离 | 全域默认采样、typed 当前版本、独立评价后的自动采用与冲突移交仍未接通 | [演进合同](model-evolution.md) |

L1 当前 canonical 的逐类覆盖如下。M1 为120 train/38 eval，MAP 为59 train/140 eval；本表 eval 指原 source-group 评价用途，不等于本轮独立盲测，也不与旧/新黄金相加。另批 wrapper/focus 的 ignore 实验不能混入本表。

| 类别 | M1 train/eval | MAP train/eval | 旧黄金/扩展黄金 |
| --- | --- | --- | --- |
| button | 12/6 | 8/11 | 18/19 |
| input | 8/0 | 1/5 | 8/6 |
| select | 0/0 | 3/0 | 0/3 |
| link | 12/6 | 6/15 | 18/21 |
| text | 25/12 | 15/42 | 37/57 |
| image | 12/6 | 6/14 | 18/20 |
| video | 1/0 | 0/0 | 1/0 |
| audio | 0/0 | 0/0 | 0/0 |
| container | 12/1 | 9/20 | 13/29 |
| list | 2/0 | 1/8 | 2/9 |
| listitem | 12/1 | 4/13 | 13/17 |
| ignore | 0/0 | 0/0 | 0/0 |
| other | 24/6 | 6/12 | 30/18 |

本轮通过公开 prepare/partition 重建上述分区，并在新进程用公开分类入口显式读取两份已拟合文件。M1 标签匹配342/357，MAP为356/357；MAP旧黄金158/158、新黄金198/199，唯一剩余错例为`weibo-search:306`的container/unknown。357条已评价项中MAP为308 judged、49 unknown、0 conflict；49 unknown含48个标签匹配的other，不得说成已明确识别。另2条ambiguous无gold、保持unassessed；prepare因未确认排除2条，分类器excluded为0。全部359条原始记录的候选资格未评价，本次仅`properties_offline`，不代表现场遮挡/iframe/shadow或完整候选链验收。两候选各评价359行，合计718条逐例输出保存在`c1/per-example.json`。

上述候选保持 `uncalibrated/not_applied`。本轮`fitted=false`、未调用fit；MAP的140条eval早已查看，旧黄金又含M1训练材料，仍需新鲜独立来源组。覆盖计数不表示网站总体准确率。样本来源、已有查看记录和用途必须保留；unknown、conflict、ambiguous、excluded不能并入负例或黄金other。

### 本轮执行单元

本轮完成覆盖审计、证据补齐和设计就绪收口。新行为实现、全目录拟合和自动采用不属于本轮交付。已有拟合有效且输入/连线/权重未变，不为补报告重训。

| ID | 任务及 owner | 依赖 | 验收 |
| --- | --- | --- | --- |
| C0 | 父 owner：本节及 note.md | 独立计划、C1–C4 | 全域覆盖、具名任务、先后依赖及证据入口完整；状态区分缺能力、缺证据和旧说明 |
| C1 | GCM L1：只读产品，写本地逐类矩阵及必要回载证据 | 既有候选/样本/公开入口 | 13 类分 train/dev/verification/旧黄金，来源及真实/合成分别计数；仅补缺失新进程回载，不改 gold 或权重 |
| C2 | GCM CLI：AGENTS.md、design.md 及确有漂移的入口状态句 | 当前 CLI 领域合同 | 当前 10×30、0.3.0 与历史 6×14 区分；不改原训练报告或未验证边界 |
| C3 | GCM browser：行为框架、必要性及单次训练合同 | 既有原子观测、当前 API 缺口 | read 只确定性取值；input保留INPUT/NOOP/DEFER当前选择训练，独立39参数设计；值复制/原生键盘/评价不训练；给出就绪结论 |
| C4 | GCM core：model-evolution.md | 当前采集、loader 与训练入口 | 首域接入任务及验收明确；无冲突透传与冲突移交区分；不放宽候选校验或实现第二引擎 |

C1–C4 使用独立 GCM worker 并发执行，文件 owner 不重合。父 owner 负责 C0、集成与清理。文档与补证任务采用针对性检查；不重复全仓测试、已有原生验收或真实拟合。若补证发现真实运行缺陷，保留原错并单独走图/gate/红测/实现/公开入口验收；本轮不能以文档改写掩盖缺陷。

### 后续实施队列

本表给出明确下一动作。列为后续不表示已授权执行真实用户文件变更。进入各增量时仍须满足四元素、SESE、最小必要性及真实训练验收。

| ID / 优先级 | 缺口与下一动作 | 必要依赖 | owner / 最小验收 |
| --- | --- | --- | --- |
| Q1 / P0 | 按 C1 矩阵补缺失类别监督和独立评价；audio/select/ignore 等按实际缺口处理 | 当前来源与分区事实 | training 领域；黄金真值有来源，类级留出独立，proposal 不替代 gold |
| Q2 / P1 | 定义并训练人类可观测的保留单元 | overlay 观测与缺测合同 | adapter/filter/training；读取、焦点、加载入口应保留，无独立价值包装作对照 |
| Q3 / P1 | 建立 owned、caption 归属与用途关系的可辨正反例 | 显式 scope/owner 边界 | browser 关系；相邻/嵌套不串归属，不足证据不绑定 |
| Q4 / P1 | 实现最小 text/media 属性取值 API | 原始读取与语义归属分开 | browser adapter；值与真实观测一致，失效/缺测明确；无需学习的取值用确定性机制 |
| Q5 / P1 | 由 C3 选择最小 read 状态读取切片 | 明确对象与实际状态证据 | browser operation；读 false 也完成，unknown/stale 不伪造结果，零网页输入 |
| Q6 / P1 | 实现一个明确编辑宿主的精确 input，再拟合INPUT/NOOP/DEFER当前策略 | 当前值、可编辑性、引用、原生执行器及训练领域绑定 | browser operation/training；独立39参数候选的真实拟合/回载、原生同对象值符合，邻输入不变，失败有反馈；不训练对象查找或键盘层序 |
| Q7 / P2 | 拆最小 select 状态设置 | 对象绑定/状态/失效合同 | browser operation；真实 selected/checked、禁用和错误对象反例 |
| Q8 / P2 | 训练单滚动宿主的当前行为选择 | 宿主、方向、边界及覆盖观测 | browser adapter；原生滚轮后可见范围或边界有证据 |
| Q9 / P2 | 组合固定范围单查询 search | input、提交行为、结果归属均验收 | 既有递归 runner；查询生效、结果关联、覆盖分别验证 |
| Q10 / P2 | 定义导航后的文档迁移与重绑，再实现 navigate | documentRef 失效规则 | browser adapter；实际位置/页面成立，旧引用零输入 |
| Q11 / P2 | 定义 download 的入口归属与产物回执，再实现 | 下载状态和本地结果观测 | browser adapter；原生触发、完成、产物分开验证，不直接请求 URL 替代 |
| Q12 / P1 | 接入 physical/realpath 及硬链接关系 | typed 引用、跟随链接和身份观测合同 | CLI 共享模型/adapter；词法/物理、断链、同对象关系可区分 |
| Q13 / P1 | 实现显式候选内 directory.select/file.select | 名称/类型/父级及覆盖证据 | CLI B 关系；同名异父、歧义、未知类型与覆盖不足；不隐式扫描 |
| Q14 / P2 | P4 创建/移动/删除/符号或硬链接逐个接入 | 精确参数、property/predicate、effects 合同；精确操作不强制等 Q13 | CLI adapter/共享训练；专用沙盒非目标不变，冲突/部分副作用真实返回 |
| Q15 / P2 | P5 先 read，再 replace/write/append/truncate/copy | Bytes、offset/length、覆盖边界 | CLI adapter/共享训练；EOF、区间外字节、前后缀及部分写入验收 |
| Q16 / P2 | P6 mode/owner/times 逐个接入 | 平台及权限条件 | CLI adapter；独立读回，拒权真实报告，不伪造 ctime/birthtime |
| Q17 / P2 | format/role/applicability/help 各选精确语义设计 | 可辨输入与真实用途证据 | CLI 语义/训练；同名不同用途、未知/冲突保留 |
| Q18 / P3 | 名称/符号搜索、遍历、树操作及保存/归档组合 | 所需原语独立验收 | 既有递归 runner；范围不完整、拒权、预算和部分副作用可收回 |
| Q19 / P2 | 仅在 host 前提成立时补 CLI 5 项未验证边界 | 各项实际 fixture 条件 | 既有独立套件；设备、other、大整数身份、内核零 I/O 分别报告，不重跑有效 56 例 |
| Q20 / P1 | 按 C4 选一个域接默认本地使用采集 | 显式 sink、版本与样本回执 | 既有 adapter/consumer；失败/未知保留，采集失败不改变业务结果 |
| Q21 / P2 | 选一域实现自动升级与冲突处理 | Q20、当前版本资源、独立配对评价 | 现有 loader/workflow；提升且无回归才采用，新请求生效，在途保留旧版本 |
| Q22 / P3 | 有具体组合选择任务后训练递归 selector | 有限技能集合、可辨选择反例 | 领域 selector/training；只学当前候选或 DEFER，不训练层序/是否继续 |
| Q23 / 暂缓 | Computer use、第二层业务语义、WebUI、Rust | 后续对应目标进入实施计划 | 既有 owner；本轮无操作或训练声明 |

实施顺序为基础观测/取值与单步行为，随后失败反馈，再接候选策略和递归组合。F1/F2 的结构可复用，不能把既有权重直接宣称适用于新行为。升级接入与能力扩展分开验收；条件不满足时继续显式报错，不自动扩大技能范围。

当前通用设计入口：新增或修改CLI、浏览器及其他模型能力时，先沿[本地设计Skill](../.agents/skills/nnanything-design/SKILL.md)形成语义/I/O/harness/图纸/样本与采用验收。跨模型演进架构唯一owner为[model-evolution.md](model-evolution.md)。本页继续维护阶段与文件导航，不另复制设计流程；下方D0/D1历史状态不覆盖后续已交付能力。

状态：2026-10-17，L1 候选 7 节点与采样 3 节点保持已交付。当前用户明确要求实现第一层 DOM 基础种类判断算法（dom-basic-kinds）、dom.basic_kinds@0.1.0 节点封装及公开 workflow 验收。区分历史 L2 复合卡片（post.card）计划与当前已确认的基础种类判断前置需求：第一层输出基础结构与类型（control、media、navigation、text、structure），第二层再组合帖子、作者、评论、广告等业务语义。历史 L2-L4 设计保持完整并明确为后续规划。远端为 Jasonzhangf/NNAnything。

本计划依据独立规划及其收敛决议。架构、目录职责与根目录注册名单由 [AGENTS.md](../AGENTS.md)唯一维护，第2节保留实施文件导航。工作流清单与真源索引见 [workflows/README.md](../workflows/README.md)，节点合同卡唯一真源见 [lib/nodes/README.md](../lib/nodes/README.md)，第一层基础种类算法真源见 [docs/basic-kinds-wiring.md](basic-kinds-wiring.md)。

2026-10-17 阶段更新：基础训练六节点闭环已实现（0.1.0），包含真实 Handwired Circuit evaluate/backprop 拟合、Adam 优化器、TypeScript 源码加载器、已有样本复核试验及回载验证。后续按需规划独立的 WebUI 阶段；UX 须单独设计后再实现。阶段顺序、范围与验收由第 8 节单一维护。

2026-10-20 独立递归 Goal 状态：RG-01 至 RG-07 的源码、公开 consumer 和行为验收已完成。`contracts.ts`、`errors.ts`、`module.ts`、`lib/recursive-goal.ts` 已接通；三个 `goal.recursive.bind/run/report@0.1.0` 的 `NodeDefinition` 唯一 owner 为 `lib/workflow/recursive-goal/module.ts`，对应图/配置为 0.1.0 3N2E SESE，不在 `lib/nodes/` 复制实现。cwd 与 finite-search 入口由 `playground/recursive-goal/` 提供，组合选择仍是固定有限规则。公开递归回归和正式全仓均通过，无跳过，最新实数与证据由模块合同第13节维护；RG-08独立验证及RG-09 Review/main/资源收口的具体回执由note.md维护。

## 1. 本轮D0的完成条件

| 项目 | D0交付 | 针对性验收 |
| --- | --- | --- |
| 通用框架 | Node/事件/状态/Workflow/Profile边界；Flowed选型及与DAGpipe分工 | 无DOM业务进入核心；正式和训练同一执行合同；未引入第二调度器 |
| 基础配置 | graphRef、局部configs、bindings及显式运行资源 | 图单一真源、端口按合同绑定、profile/effects不隐式获取；见workflow-config.md |
| 复用与经验 | 节点卡、参数/规则/特征修复owner、规范案例与回归积累 | 不将LLM提议直接变黄金；不将缺证据当负例或自动覆盖参数；见node-contract.md |
| 浏览器计划 | 四层优先级、首个能动切片、必要节点卡、每层验收及非目标 | 能动候选输出与语义识别分开，真实训练留在核心层；不能有假运行占位 |
| 流程与连线 | 能动候选图、完整识别图、训练图、操作图及结构电路候选 | 项目图为design，SESE静态检查；未变图复用有效结果；不宣称运行可用 |
| 规则与交付 | AGENTS、项目治理、独立设计增量Review、main合流和远端推送 | 本轮无src/package/依赖/训练；普通Git回执，无额外SHA核对；清理自有worktree |

当前没有AppSDK需求文件或控制面初始化。本轮采用其治理原则，不建占位文件、守护进程或受管状态。相关边界见[项目治理](project-governance.md)。

## 2. 实施文件导航

目录职责与根级写入边界以 [AGENTS.md](../AGENTS.md)为准。下列树仅提供实施文件导航，不是第二份根目录注册表。已实现模块存放真实源码；未实现目录仅放置单个 `README.md` 说明职责与契约，不创建空 `.ts` 壳、假参数、重复注册表或插件服务。

```text
NNAnything/
  AGENTS.md                                  # 项目边界与规则入口
  README.md                                  # 阶段与文档导航
  note.md                                    # 单一项目进度/证据汇总
  package.json                               # 导出 main="./dist/index.js" 与 "./browser"="./dist/browser.js"
  tsconfig.json                              # rootDir="lib", include=["lib/**/*.ts"]
  .gitignore                                 # 忽略规则与 training/{samples,results,weights}/** 忽略
  workflows/                                 # 项目 DAG 图 (.graph.json) 与持久配置 (.workflow.json) 唯一真源
    README.md                                # 流程清单、图与配置对应关系与状态说明
    dom-candidates.graph.json                # [已实现 0.1.0] L1 能动候选图 (7N6E SESE)
    dom-candidates.workflow.json             # [已实现 0.1.0] L1 持久配置 (graphRef="./dom-candidates.graph.json")
    dom-rule-sampling.graph.json             # [已实现 0.1.0] 基础规则采样图 (3N2E SESE)
    dom-rule-sampling.workflow.json          # [已配置 0.1.0] 采样持久配置与运行绑定
    dom-basic-kinds.graph.json               # [已实现 0.1.0] 第一层基础种类图 (1N0E SESE)
    dom-basic-kinds.workflow.json            # [已配置 0.1.0] 基础种类持久配置 (graphRef="./dom-basic-kinds.graph.json")
    dom-recognition.graph.json               # [设计态 0.1.0-design] 完整卡片识别流 (10N10E SESE)
    node-training.graph.json                 # [已实现 0.2.0] 目标节点训练流 (6N6E SESE)
    node-training.workflow.json              # [已配置 0.1.0] 目标节点训练持久配置与运行绑定
    operation-episode.graph.json             # [设计态 0.1.0-design] 操作闭环流 (7N6E SESE)
  lib/                                       # 库源码根目录
    index.ts                                 # 公开主入口：导出 core、workflow、nodes/common
    browser.ts                               # 公开 ./browser 入口：导出 adapters、filters、nodes/dom、采样及基础种类节点
    training.ts                              # 公开 ./training 入口：导出训练算子、schema 校验与分区/评估/报告函数
    core/                                    # 通用契约、事件信封、错误与基础 schema
    workflow/                                # 持久配置加载、DAG 校验、Flowed 编译与运行器
    nodes/                                   # 可复用 workflow 节点定义与合同清单
      README.md                              # 节点目录职责与采样/基础种类/训练节点完整合同卡唯一真源
      common.ts                              # common.scale / sum / count (1.0)
      dom.ts                                 # dom.observe / viewport / focus / deny / allow / split / candidates (0.1.0)
      sampling.ts                            # sample.match / assemble / save (0.1.0)
      basic-kinds.ts                         # dom.basic_kinds (0.1.0)
      training.ts                            # 六训练算子：training.prepare / partition / fit / compare / assess / report (0.1.0)
      trainable/                             # 可训练节点定义目录（存节点结构/特征，不存权重）
        README.md                            # 可训练节点与 Handwired 电路边界
    filters/                                 # 确定性过滤规则与候选槽位求值纯逻辑
      README.md                              # 规则内核与节点解耦说明
      focus.ts                               # 视口、focus、within、region 求值内核
      candidate-chain.ts                     # 7 节点过滤链求值内核
      sample-match.ts                        # 纯语义规则三值逻辑求值内核（无极性概念）
      basic-kinds.ts                         # DOM 基础种类两阶段求值纯内核（0.1.0）
    adapters/                                # 外部环境与原始观测输入适配
      browser/
        observation.ts                       # 页面观测数据适配与白名单清洗
    training/                                # 节点训练算子与数值后端适配目录
      README.md                              # 训练算子与 HANDWIRED_ROOT 边界
      samples.ts                             # 单任务样本 schema、任务监督映射与学生观测清洗
      basic-kind-samples.ts                  # 多分类复核样本 schema、学生投影与提取适配
      basic-kind-numeric.ts                  # 基础种类 Handwired 数值电路、梯度反传与 Adam 优化器
      basic-kind-training.ts                 # 来源分区、候选读取、比较、评估与写入逻辑
      handwired.ts                           # Handwired TS 源码内存转译与动态 ESM 加载器
  training/                                  # 本地训练数据与权重资产根目录（数据本地生成，Git 忽略）
    README.md                                # 本地训练资产三分类与隔离底线
    samples/                                 # 规则采样或 teacher 生成的规范样本（JSONL，Git 忽略）
      README.md                              # 样本记录格式、单任务单标签与来源关联引用
    results/                                 # 训练拟合、校准与新旧比较评估报告（Git 忽略）
      README.md                              # 评估报告与引用权重 profile 规范
    weights/                                 # 训练产出的真实参数/权重 profile 唯一存放处（Git 忽略）
      README.md                              # 权重 profile 结构与禁止自动覆盖规则
  playground/
    common/
      demo.mjs                               # 非 DOM 公开 consumer
    browser/
      README.md                              # 配置文件与图引用说明
      demo.mjs                               # 浏览器公开 consumer（configPath 指向 ../../workflows/dom-candidates.workflow.json）
      observation.fixture.json               # 离线观测样例数据
    sampling/
      README.md                              # 采样公开 consumer 说明与 CLI 契约
      demo.mjs                               # 基础规则采样公开 consumer
    basic-kinds/
      README.md                              # 基础种类公开 consumer 说明与 CLI 契约
      basic-kinds.fixture.json               # 离线合成候选样例数据
      demo.mjs                               # 第一层基础种类公开 consumer
    training/
      README.md                              # 离线训练公开 consumer 说明与 CLI 契约
      demo.mjs                               # 六节点离线训练、Handwired 拟合与回载公开 consumer
      reviewed.fixture.json                  # 离线合成多分类样例数据
  tests/                                     # 公开合同与黑盒用例
    basic-kinds.test.mjs                     # 第一层基础种类单元与工作流测试
  docs/                                      # 架构、合同与治理文档（图真源移入 workflows/）
    basic-kinds-wiring.md                    # 第一层基础种类数值连线与算法设计真源
    training-workflow.md                     # 第一层基础种类离线训练 workflow 设计与验收真源
  research/                                  # 调研依据与原始数据（本地忽略，绝不提交）
```

每个模块一个写owner。不同worker可按不重叠文件并行；共享基础合同由其owner先明确并验证，再派依赖任务。合同变化回到该owner，不跨节点回改其他模块真源。具体宿主派发和独占worktree规则沿全局合同。

## 3. 四层推进与停止点

| 层级 | 唯一行为交付 | 最小实现范围 | 验收与停止点 |
| --- | --- | --- | --- |
| L1 能动 | 给保存的页面测量，输出有序DOM候选引用、排除与未知原因 | 通用配置/执行基座、一个非DOMconsumer、网页观测和7个手写候选节点；不依赖模型或训练环境 | 公开入口跑完能动候选图，保序且规则正确；非法图/错端口/未授权effect明确拒绝。作者验收、整体milestone Review、main交付后停止本层 |
| L2 能有核心功能 | 识别完整卡片结构，训练同一节点并回载候选profile | L1后增加3个特征/分类/组装节点，完整10节点识别图；真实Handwired后端、规范样本及7节点训练图 | 前向/纠错梯度、来源分区、校准不足、旧新比较、同节点profile回载均有真实consumer证据；来源分类仍unsupported，单快照不报泛化成绩 |
| L3 完善功能 | 按实际任务补来源类别、语义查询与真实操作/监督修复 | 可辨广告/推广/推荐特征与数值支路、teacher准备、目标归属/查询、operation后观测验证、选择性入集 | 使用所选功能的真实目标与后条件验收；离线不动作，unknown不自动重放；不要求一次完成全部长期目录 |
| L4 提高兼容性 | 在已有效任务上扩展站点/DOM布局与环境适配 | 新场景观测/动作适配、兼容profile及对照样本；有收益证据后再选预测上下文、贝叶斯或可选画布 | 按同类目标做新站点/变体比较，不承诺零样本迁移，不改变通用核心来硬编码站点 |

L1 候选切片与采样增量已交付。当前用户明确授权实现第一层基础种类判断算法（dom-basic-kinds）与 dom.basic_kinds 节点；区分历史 L2 复合卡片（post.card）计划与当前基础种类前置条件。L2 复合语义识别模型、神经网络训练及活体网页操作保持后续规划，不自动成为本轮工作。阶段切换遵循当时已授权目标；目标已覆盖下一层时继续执行，不重复索取逐节点许可。安全、数据正确性及真实结果要求不按层级后移。

## 4. L1首个能动切片与节点卡

单入口是保存的页面观测引用、当前FocusSpec和可选显式nodeRefs。单出口是CandidateSlots：每项包含index/nodeRef、资格状态和原因，并保留遍历范围/排除子树记录。候选结果不含伪造语义标签、isTarget或confidence。

| operator候选 | 输入→输出 | 独立职责和必要反例 |
| --- | --- | --- |
| dom.observe | 请求/保存观测→PageObservation | 适配已有测量及明确覆盖范围，原始资料只做证据引用；引用失效、缺必需测量不假装成功 |
| dom.viewport | 观测范围→视口槽位/遍历上下文 | 正面积相交、部分可见保留；离屏父容器不误剪可见后代；遮挡/可点击性不由相交证明 |
| dom.focus | 视口范围+FocusSpec→关注范围 | within/region只缩小目标；失效范围stale_scope；owned所需归属缺失时明确不支持/证据不足，不能按subtree假扮owned |
| dom.deny | 范围+明确规则→排除记录 | 命中规则保留原因；跳过自身与排除子树分开；不能生成训练负标签 |
| dom.allow | 前序范围+明确规则→允许范围 | deny优先；未配置allow不额外限制，显式空集合拒绝全部；不能复活离屏/被拒项 |
| dom.split | 可遍历范围→确定顺序层级项 | 包括中间容器与后代，父子可重叠；显式单节点/数组入口不强制扩展；引用/路径不成为学习特征 |
| dom.candidates | 展开项+相同FocusSpec→CandidateSlots | 复检展开项防止复活排除目标；保留项序号及排除/未知记录；不调用神经网络 |

上述节点可复用同一规则处理实现的不同实例，不要求七套类层次。configs只保存一份FocusSpec，节点通过明确局部引用绑定；无站点隐藏全局。

[能动候选图](../workflows/dom-candidates.graph.json)为7节点6边单入口单出口设计图，与完整识别图承担不同结果合同。后续实现引用它，不用10节点图里的假分类节点拼出“能动”。

L1公开consumer须证明：非DOM流程可用；候选槽位顺序和排除映射正确；父级跳过不丢可见后代；deny/allow不冲突；async依赖齐备才执行；跳过/未知能结束；非法环、类型/引用错误和未授权副作用不被放行。原始现场缺裁剪/片段等证据时保留unassessed，不把单一外接框冒称精确可见或可操作。

L1就可以积累手写节点经验：例如父容器跳过导致漏候选的规范反例，归因给枚举owner，修规则后用同一输入回归。无需先有神经网络或自动监督服务。

## 5. L2核心层的组合计划

基础先独立验证再组合：显式Handwired加载与8输入9参数结构电路→特征/分类节点→规范样本与分区→拟合/校准/比较节点→两条workflow消费者。运行层与数值模块在共享合同明确后可按不同owner并行。

| 节点组 | 输入与输出 | 必需保障 |
| --- | --- | --- |
| dom.features / node.classify / dom.assemble | CandidateSlots+白名单观测→数值项→单标签结果→原槽位汇总 | 名称变化不改向量；缺测不调用模型；不压缩数组；profile不兼容拒绝 |
| training.prepare / partition | 规范节点输入+期望输出→准备样本→用途分区 | 未知标签保留但不参与拟合；按snapshot/post/adAsset传递闭包分组，不把未复核初始标注变黄金 |
| training.fit / calibrate | 训练分区+明确基础profile→候选参数→校准状态 | 真实Handwired反传；参数约束投影；新拟合清旧校准；独立覆盖不足用identity并明确uncalibrated |
| training.compare / assess / report | 同一留出样本的旧新输出→逐例结果→候选profile和报告 | fixed/regressed/unresolved/retained/unassessed均显式；证据不足不自动采用；所有必需产物沿事件传递不从隐藏状态获取 |

完整图见[识别](../workflows/dom-recognition.graph.json)与[训练](../workflows/node-training.graph.json)。基础规则采样流见[采样流](../workflows/dom-rule-sampling.graph.json)，第一层基础种类流见[基础种类流](../workflows/dom-basic-kinds.graph.json)。采样与基础种类节点完整合同卡见[lib/nodes/README.md](../lib/nodes/README.md)。第一层算法设计真源见[基础种类分层连线](basic-kinds-wiring.md)。同一目标节点定义、输入编码和兼容profile是流程的接点。训练只处理目标节点I/O；teacher标注是独立数据准备流程，模型不读原始class/content。

结构电路及w测量算法见[数值连线](structure-circuit-m1.md)。当前可分性、误判形态和样本量都需实施后验证；现有微博资料只有单来源组，不能报独立校准或泛化准确率。广告也可为完整卡片，结构结果不能代替普通帖/来源判断。

## 6. 未知、Owner与验证时机

| 未知 | Owner及动作 | 触发时机 |
| --- | --- | --- |
| Flowed在选定Node工具链上的实际运行与异常/扇入行为 | 执行层owner通过非DOM公开consumer验证，必要依赖只在实现时安装 | L1，阻断其受影响运行验收 |
| 原始测量的子树/祖先/裁剪覆盖不足 | 浏览器适配owner声明覆盖、补足必要观测或保留unknown，不能猜测缺失事实 | L1数据输入与L2取参 |
| 8维结构输入的实际可分性和所需样本 | 数值/数据owner复核结构标签，再按来源组开发与留出比较；不足则回特征/连线设计 | L2，不阻断D0架构交付 |
| 图片广告/推荐/商业推广的可辨特征 | 来源目标owner对照原始现场审特征、标注边界和数值支路，未支持前拒绝该target | L3所选来源任务启用前 |
| 独立校准的最低覆盖和指标界限 | 评估owner按目标/风险声明覆盖，使用多独立组检验；单快照始终开发态 | L2机制验证，L3真实数据启用前 |

## 7. D0收口与后续启动

本轮顺序：文档和新候选图定稿→针对性检查→原设计Reviewer对新增合同/范围/治理增量复核→提交合入main→推送origin/main→记录回执并清理自有worktree。未变图和选型证据复用，不因文档修改重跑业务或模型测试。

后续浏览器L1开工时以本计划、有效项目需求、图和适用治理规则形成具体执行派单。只实现能动切片，完成该层公开consumer验收和一次完整milestone Review再交付。不会因D0完成自动安装依赖、连接页面或启动L1代码任务。

## 8. 训练基础与后续 WebUI 阶段

本节记录训练推进与后续阶段。六节点离线训练、真实Handwired反传、Adam、显式TypeScript加载器与已有样本试验均已运行。用户随后授权跨页评估及增量实验，训练、留出与旧黄金回归分别记录，见[实验结果](training-m1-results.md)。保存候选不自动替换基础profile；置信度未校准；第二层业务语义、WebUI、Rust保持后续范围。

| 阶段 | 目标与交付 | 状态与依据 |
| --- | --- | --- |
| 训练基础能动 | 复用现有 workflow，接入真实 Handwired 前向、损失、反传和参数更新；保存并回载候选 profile | **已交付 (0.1.0)**：公开入口 `npm run demo:training` 完成真实拟合，输出状态与结果，同一分类节点加载候选验证 |
| 现有样本试验 | 按来源用 class/name 等 teacher 规则批量提议标签，复核后试训；报告按来源隔离的新旧结果 | **已交付 (0.1.0)**：158 条复核样本完成拟合试验（小红书 120 训练 108->120，知乎 38 留出 32->38，fixed 18 / regressed 0，仅 2 来源组，无 audio/select；未见页面跨页评估进行中） |
| WebUI 独立 UX 设计 | 在基础闭环可运行后，围绕配置、训练状态与结果检查设计任务路径、信息结构和原型 | 待规划：完成核心任务及状态设计，核对真实后端能力并进行 UX 审查后实现 |
| WebUI 首版 | 通过界面配置和启动训练，观察真实运行状态，检查结果及候选 profile 差异 | 待实施：用实际配置、样本与训练任务走通端到端操作和失败恢复 |

UX 的必要设计范围：

- 配置：选择目标节点、已有样本与标签来源、基础 profile 及训练参数。常用输入直接可见，进阶参数按需展开；具体表单字段来自已实现合同。
- 训练状况：展示未开始、运行中、完成、失败及相应的下一步；展示后端实际提供的进度、损失和指标。训练失败后保留可复用配置，说明失败影响与恢复动作。
- 结果检查：查看每类结果、other 与误判样本、旧新 profile 的改善和劣化，明确训练与验证样本的用途。
- UX 交付：核心任务路径、信息结构、低保真原型、主要状态与交互说明，以及基于这些任务的验收用例。先审任务与交互，再落实视觉和前端实现。

WebUI 以现有声明配置、workflow 执行合同、训练运行状态及评估产物为数据真源。界面能力与后端真实能力对应。画布编辑器按实际需要另行选择；当前 WebUI 的必要目标是配置与训练可视化。

基础阶段使用现有样本先验证效果；补采按发现的具体缺口启动，并通过可重复脚本输出相同数据合同。WebUI 首版按最小可用类别与现有样本开展，不要求先扩展采集规模。
