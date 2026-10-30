# 文件系统沙盒与共享命令模型增量训练

状态：实施合同。当前权威共享命令合同为 **Stage 2（`stage2-13x38`）**：**13 个 head、38 条 wire、13×38 共 494 参数**，在 Stage 1（`stage1-11x34`，11 head × 34 wire = 374 参数）基础上新增 `directory.select`、`file.select` 两个执行 head 与 `predicate.select.entry`、`selectorTargetType.unspecified`、`selectorTargetType.regular`、`selectorTargetType.directory` 四条 selector wire，经 `migrateCliCommandProfileStage1ToStage2` 按 `(head, wire)` 精确名称迁移（**374 个已有位置按名复制、120 个新增位置补零**）；Stage 1 `stage1-11x34` 仍作为显式旧边界（`stage: "stage1-11x34"`）按自身 11×34 矩阵推理。推理复用 `workflows/cli-file-property.graph.json`（6N5E），训练复用 `workflows/cli-filesystem-training.graph.json`（8N8E）。Stage 2 正式训练候选 `4e7e39ca-bd72-4785-a719-c621112159b8` 已从 Stage 1 候选 `7e34901c-68ca-401f-ab40-72189f4e904d` 按名迁移并在 8N8E 训练图完成 370 条样本真实执行（原 Stage 0–2 358 条 + append-only 追加 12 条未观测/过期目录阻断样本，`train` 246/246、`development` 124/124，原 358 条 238/238 与 120/120、追加 12 条 8/8 与 4/4），新进程回载 `reload.json` `executed=370`、`failed=0`，P3 名称偏好回归 24/24 且 `entry.inspect × search.nameNeedleSegment` 零梯度不变（`weightDelta=0`），P3 内容搜索回载 natural 与 forced-first 各 24/24，外部独立套件 95/95（历史 71 + Stage 2 24）并保留 5 项固定 `UNVERIFIED`（首跑失败候选 `4e249c32-0809-4016-beb6-5b3d336a9f16` 与原错例证据完整保留）。**历史阶段记录**：0.2.0 的 typed `file.property` PWD/CD/LS 6×14 切片、0.3.0 批次1 的 10×30 基础矩阵（300 参数，262 条样本，候选 `35bd5ad9-15dc-409e-9001-bcab24f75398`）、P3 增量 A/B/B2 的 10×31 矩阵（310 参数，候选 `39f1570f-be11-48a4-94cb-3b071982922b`、`fb73d4a0-cb66-4008-afa0-5569b2cdfcdc`）与 Stage 1 的 11×34 矩阵（374 参数，310 条样本，候选 `7e34901c-68ca-401f-ab40-72189f4e904d`）均作为历史基线保留，不再作为当前默认矩阵。所有候选都保持 `uncalibrated/not_applied`，训练报告保持 `fullyVerified=false`（`verification.status="not_provided"`）。实测计数、计时和run记录见[共享模型实测](cli-filesystem-training-results.md)，本文不重复历史表。本文是全命令统一共享模型与增量训练的唯一权威合同。总体Goal/State定义见[总体设计1.1](design.md#11-结构化语义的目标与状态推理)；调用与资源信封见[参数简化合同](cli-call-contract.md)；精确操作与固定映射见[语义目录](cli-semantic-operations.md)。
2026-10-19 至 2026-10-29 演进：PWD/CD/LS迁移、批次1路径词法原语与`entry.inspect`、Stage 1 `path.realpath` 及 Stage 2 单目录 `directory.select`/`file.select`（配合只读 Track B 关系评分 profile `39427f5c-f525-4f6a-af84-9664f820cc71`）已按阶段接入。所有新语义统一为[file.property.xxx](cli-filesystem-semantics.md)，内容、用途、条件与能力关联均归为属性判断和属性状态变化，复用`cli-file-property.graph.json`，不零散增加Goal。后续目录/文件写变更（P4–P6）、R用途、特殊文件扩展及自动采用仍为设计，不靠文档冒称已运行。

用户已选择真实文件系统中的专用沙盒目录，不声称硬件、虚拟机或操作系统权限隔离。PWD/CD/LS、路径原语、`entry.inspect`、`path.realpath` 与单目录 `directory.select`/`file.select` 的 `file.property` 切片已接入运行入口；后续 P4–P6 的 15 个写/字节/元数据操作与特殊文件扩展仍为设计，不将静态图校验称为这些未来执行器已实现。

## 0. 固定四元素与满足度评价

当前属性入口要求调用显式提供 `satisfactionThreshold`（有限 0..100），运行时不能从 profile 或环境选择。公开 `CliCommandGoalResult` 保存实际 `satisfaction: 0 | 100 | null` 与请求阈值；阈值只是最低要求，不替代实际事实。旧固定 `CLI_COMMAND_GOAL_CONFIG` 已退役。

### 0.1 历史运行切片与当前 Stage 2（`stage2-13x38`）合同注册

**历史切片**：0.2.0 切片只接 sessionCwd 的 `observed(this_run)`/`equals` 与 directory.entries 的 `observed(this_run)`（6×14=84 参数）；0.3.0 批次1新增 `path.resolve`、`path.relative`、`path.parts`、`entry.inspect`（10×30=300 参数）；P3 增量 A 追加 `search.nameNeedleSegment`（10×31=310 参数）；Stage 1（`stage1-11x34`）新增 `path.realpath` 及 `property.path.physical`、`predicate.observe.physical`、`predicate.observe.resolvedTarget`（11×34=374 参数，现作为显式旧边界 `stage: "stage1-11x34"` 保留按自身矩阵推理）。

**当前合同（`stage2-13x38`）**：在 `stage1-11x34` 基础上新增 `directory.select`、`file.select` 两个执行 head，以及 `predicate.select.entry` 与 `selectorTargetType.unspecified/regular/directory` 四条 selector wire，默认运行校验器 `validateCliCommandProfile` 接受 **13 个 head 与 38 条 wire（13×38 = 494 参数）**。运行证据见本文§6与 `note.md`。

| 项 | 当前注册值（`stage2-13x38`） |
| --- | --- |
| heads | `unsupported`, `DEFER`, `NOOP`, `pwd`, `cd`, `ls`, `path.resolve`, `path.relative`, `path.parts`, `path.realpath`, `entry.inspect`, `directory.select`, `file.select`（K=13） |
| wires | `bias`, `goalObserveCwd`, `goalSetCwd`, `goalListDirectory`（legacy，顺序固定） |
| property 块 | `property.path.absolute`, `property.path.relative`, `property.path.parent`, `property.path.name`, `property.path.physical`, `property.exists`, `property.type`, `property.directory.entries`, `property.size`, `property.mode`, `property.owner`, `property.times`, `property.link.target`, `property.entry.identity`, `property.relation.sessionCwd`（15列） |
| predicate 块 | `predicate.observe.absolute`, `predicate.observe.relative`, `predicate.observe.parts`, `predicate.observe.physical`, `predicate.observe.inspect`, `predicate.observe.resolvedTarget`, `predicate.observe.sessionCwd`, `predicate.equals.sessionCwd`, `predicate.observe.entries`, `predicate.select.entry`（10列） |
| selectorTargetType 块 | `selectorTargetType.unspecified`, `selectorTargetType.regular`, `selectorTargetType.directory`（3列） |
| state 块 | `state.hasFreshEvidence`, `state.knownValue`, `state.requiredConditionHolds`, `state.hasDestinationRef`（4列） |
| search | `search.nameNeedleSegment`（1列，P3 增量 A 引入） |
| interaction | `state.requiredConditionHolds*state.hasFreshEvidence`（1列） |
| 常量记录 | `hasSessionRef` 恒为 1，不注册；`followSymlinks` 是`entry.inspect` typed参数，不注册wire |
| 矩阵 | 当前 `stage2-13x38`：F=4+15+10+3+4+1+1=38；K=13；共 13×38 = 494 参数（显式旧边界 `stage1-11x34` 为 K=11、F=34、374 参数；历史 0.3.0 基础 10×30=300 与 P3 增量 A 10×31=310 仅作历史与离线迁移来源） |

Stage 1 已注册 `path.physical`、`observe.physical`、`observe.resolvedTarget` 与 `path.realpath`；Stage 2 已注册 `predicate.select.entry`、`selectorTargetType` 块（3列）与 `directory.select`、`file.select`。`requiredTargetType`、`observedType`、`combination` 块及 `file.property.links` 在当前 Stage 2 仍不注册，不预留占位列。未注册 property/predicate 返回 `unsupported`。同分顺序为 `unsupported` > `DEFER` > `NOOP` > 其余按 head 表。

未注册 property/predicate 由 harness 结构化判 `unsupported`，不进入打分；`scores`/`probabilities` 为按 head 长度的全 0 数组。只有已注册请求进入共享 softmax。

控制 head 与执行 head 进入同一全 head softmax，不按 P1-P6 分族 mask。guard 只在策略选择后拒绝不可执行/不符合目标约束的 head。

legacy 四 wire 从 typed 语义直接计算，不调用 `expectedCliCommand` 或 teacher head：

```text
bias = 1
goalObserveCwd = 1  <=>  sessionCwd + observed(this_run)
goalSetCwd    = 1  <=>  sessionCwd + equals
goalListDirectory = 1  <=>  directory.entries + observed(this_run)
```

顶层结果 `status` 统一 `achieved/unmet/unknown/rejected/failed`；旧公开 `unverified` 分支退役。`NOOP` 的 `invocation` 为 null 且零 executor；`DEFER` 返回 typed `binding_unresolved`。

### 0.2 单权重迁移规则（显式离线工具）

迁移按阶段显式离线执行，一律按 `(head, wire)` 精确名称查找复制，任何迁移都不得按索引复用权重：
1. **历史 `4×4 -> 6×14 -> 10×30 -> 10×31`**：旧 `cli.command-policy.v1` 4×4 对象经 `migrateLegacyCliCommandProfile` 复制 `[unsupported,pwd,cd,ls]×[bias,goalObserveCwd,goalSetCwd,goalListDirectory]` 到 6×14；6×14 的 84 个交叉位置经 `migrateCliCommandProfileV6` 按名复制，10×30 经 `migrateCliCommandProfileV10x30` 追加 `search.nameNeedleSegment` 到 10×31。旧六参数 `cli.goal-policy.v1` 没有迁移目标，物理退役。
2. **历史 `10×31 -> 11×34`（Stage 0 到 Stage 1）**：经 `migrateCliCommandProfileStage0ToStage1` 将 10×31 的 310 个已有 `(head, wire)` 位置按名复制到 `stage1-11x34`，新增 `path.realpath` 行与 `property.path.physical`、`predicate.observe.physical`、`predicate.observe.resolvedTarget` 三列共 64 个位置补零（`310 + 64 = 374`）。
3. **当前 `11×34 -> 13×38`（Stage 1 到 Stage 2）**：经 `migrateCliCommandProfileStage1ToStage2` 将保存的 `stage1-11x34` 候选（如 `7e34901c-68ca-401f-ab40-72189f4e904d`）中全部 **374 个已有 `(head, wire)` 交叉位置按精确名称原值复制**，新增 `directory.select`、`file.select` 两行与 `predicate.select.entry`、`selectorTargetType.unspecified`、`selectorTargetType.regular`、`selectorTargetType.directory` 四列共 **120 个新增位置补零**，合计 **494 参数**（`374 + 120 = 494`）。统一离线迁移入口为 `migrateCliCommandProfileToCurrent`。

默认运行入口 `validateCliCommandProfile(profile)`（默认 `stage = "stage2-13x38"`）只接受合法 `13×38` profile，拒绝未迁移的 `11×34`、`10×31`、`10×30`、`6×14`、`4×4` 与已废弃 `10×32` 形状，不静默迁移，也不接受默认替代。当调用者显式指定 `stage = "stage1-11x34"` 时，`validateCliCommandProfile(profile, "stage1-11x34")` 作为 Stage 1 显式旧边界校验并保持 `11×34` 矩阵按自身形状推理。

迁移后可复现旧行 logits 在对应语义样本上的数值。这不证明 softmax 概率不变，也不证明新增行不改变 argmax；两种预测对照（零权重与迁移后不更新参数）只做预测，不执行命令。

| 单元 | Goal / satisfactionThreshold | State | Action与达标事实 |
| --- | --- | --- | --- |
| PWD | `file.property.relation.sessionCwd` observed(this_run)；显式 0..100 | 显式S、旧知识及来源、harness执行条件 | 共享模型选`pwd`；harness执行本次真实观测；S.cwd/revision不变且证据属于本次S |
| CD | 同属性 equals 目标D；显式 0..100 | S当前执行基准、D typed绑定、授权及旧知识 | 共享模型选`cd`或`NOOP`；NOOP只在适用真观测证明已等于D时正确；执行时提交S并以同一回执验证后条件 |
| LS | `file.property.directory.entries` observed(this_run)；显式 0..100 | S、D、旧目录知识及执行条件 | 共享模型选`ls`；harness返回本次完整、有类型证据的直接列举，S不变 |
| CWD关系 | 正确判定候选知识是否属于查询S；100 | 查询引用、候选观测槽位；学生输入仍为`sameSession/hasObservation` | 计算既有六参数模型，输出`MATCH/NO_MATCH`；有监督时正确为100、错误为0，无评价真值时未知 |

PWD、LS 要求本请求的新证据；CD 在适用真观测证明已等于 D 时以 NOOP 完成，否则执行。旧知识、同目标 CD 或关系 `MATCH` 均不提前完成 `observed(this_run)`。State、授权与阈值进入当前切片；学生从 typed Goal/State 特征学习 head 选择。训练期反推关系为 `Goal + 阈值 → 必需实际New State/证据 → 所需命令 → harness前置条件`。这是监督和样本设计关系，不是数值梯度反传；既有Handwired梯度路径不变。

| 实际路径 | Goal结果 | 边界 |
| --- | --- | --- |
| PWD成功，本次观测有效且S未变 | `achieved / 100` | 写入本次cwd知识及来源 |
| PWD native OS失败 | `failed / 0` | 本请求新观测未完成；旧知识保留，不评价未知真实cwd |
| PWD grant拒绝、错命令头被guard拒绝或目标引用不匹配 | `rejected / 0` | 保留grant、`policy_error`或目标绑定错误，不执行错误动作 |
| 未支持或没有定义评价规则的 property/predicate | `unknown / null` | `execution_result.status=unsupported`，不调用executor |
| CD提交前native失败 | `failed / 0` | S不变；旧cwd已等于目标也不能算本请求完成 |
| CD提交前grant/绑定/guard拒绝 | `rejected / 0` | S不变，保留具体拒绝原因 |
| CD提交后同S新PWD与目标一致 | `achieved / 100` | 保留真实提交、新观测及副作用 |
| CD已提交，后续观测失败或证据不足 | `unknown / null` | 保留新S、实际`changed`及失败回执，不回滚 |
| CD后续观测有效且明确不匹配 | `unmet / 0` | 保留实际改变，不以未知覆盖已证失败 |
| LS完整且全部必要类型有证据，S未变 | `achieved / 100` | 写入本次完整目录知识 |
| LS native失败 | `failed / 0` | 本请求新列举未完成，旧知识保留 |
| LS grant/绑定/guard拒绝 | `rejected / 0` | 保留具体拒绝原因，旧知识保留 |
| LS partial、类型unknown或必要条目证据不足 | `unknown / null` | 不定义比例满足度，不覆盖旧完整知识 |
| 已证发生禁止的cwd/revision副作用 | `unmet / 0` | 必要条件为假，即使产生观测也不能达成 |

`equals`的正确动作表、证据适用性与受信来源机制见[属性合同](cli-filesystem-semantics.md)第6节；非法schema/旧Goal/旧profile的`TypeError`边界见[参数简化合同](cli-call-contract.md)§1.1。

`changed`只表示实际session的cwd/revision变化，不表示知识变化或目标成败。PWD/LS新增知识可以为`changed:false`；CD验证失败仍可能为`changed:true`。`satisfactionThreshold`只是调用者要求，不提高模型分数、执行成功或harness权限的效力，满足度也不代替真实Goal验收。

### 0.3 历史增量记录：P3 增量 A 候选名称关系 wire 与候选排序接点

`search.nameNeedleSegment` 是在 P3 增量 A 引入的 wire（在历史 `10×31` 中为第 31 列，在 Stage 1 `11×34` 中为第 33 列，在当前 Stage 2 `13×38` 中为第 37 列）。它来自候选`basename`去掉扩展名后按`-`分段，是否有一段与当前 needle 精确相等，大小写敏感、不做 Unicode 折叠；只读已观测名称与请求，绝不读文件正文。取值 0 或 1，维度为1。

同一 profile 承载两种严格分离的计算上下文：

- 原子命令选头：所有常规命令/选择样本中 `search.nameNeedleSegment` 恒为 0。头监督不能产生同一 `entry.inspect` 下两个候选的排序梯度。
- 候选参数排序：其余维全为 0，只输入名称关系列，取 `entry.inspect` 行的候选效用 `u(c) = w_name × search.nameNeedleSegment(c)`。这是纯数值函数，无执行权限，不构成第二个 selector、controller 或执行循环。

唯一接入点在既有搜索 `nextAction` 中「尚未开始的合法候选」选择处。优先级不变：stale 复核 > 未完成分块续读 > `one` 已有命中收束 > 对剩余合法未开始候选评分 > 同分沿用稳定词法顺序。评分不得抢占未完成分块，不得把低分候选从覆盖集合删除。权重为 0 或同分时回退词法顺序，旧回归不受影响。`file.read` 仍为 `deterministic_exec`、`selectedHead:null`，不新增命令行 head。

在历史 P3 阶段，保存结构为 10×31（310 参数）；进入 Stage 1（`11×34`）与当前 Stage 2（`13×38`，494 参数）后，该系数按 `(head="entry.inspect", wire="search.nameNeedleSegment")` 精确按名保留（`w_name = 2.9020536351949002`），并在 Stage 1/Stage 2 交叉熵训练中保持零梯度不变（`weightDelta = 0`）。旧 10×30/10×31/11×34 候选只能经显式离线迁移工具转换到当前 13×38；运行入口拒绝未迁移的旧形状与已废弃10×32形状，不静默迁移、不默认替代。原历史候选 `35bd5ad9-15dc-409e-9001-bcab24f75398` 继续为 `uncalibrated/not_applied`，后续偏好候选见 §0.4。

两个CLI可训练单元按公共设计资料流和升级对象流挂接，不复制公共规则：

| 单元 | 设计流程 | 单元升级与冲突 | 当前状态 | 具体缺口 |
| --- | --- | --- | --- | --- |
| 共享命令模型 | `workflows/project-design.graph.json` | `workflows/model-evolution.graph.json`、`workflows/model-conflict-design.graph.json` | 离线增量训练、保存后新进程回载、独立评价及旧命令回归已有证据；候选`uncalibrated/not_applied` | 使用样本自动采集、显式当前版本引用、自动配对比较采用、自动冲突移交及LLM裁决执行链未实现 |
| CWD关系模型 | `workflows/project-design.graph.json` | `workflows/model-evolution.graph.json`、`workflows/model-conflict-design.graph.json` | 六参数关系分类、历史离线评价及回载证据保留；不作为命令selector | 使用样本自动采集、显式当前版本引用、自动比较采用、自动冲突移交及LLM裁决执行链未实现 |

下一步顺序沿公共合同：先补自动使用采集及使用/候选隔离，再补当前版本与配对比较/自动采用，最后补冲突裁决执行链。当前不得把自动升级、自动采集或LLM裁决写成已完成。

### 0.4 历史增量记录：P3 增量 B 候选偏好样本、成对损失与准入

三沙盒配方唯一真源是 P3 Plan §6.3，本文不复制第二套分区、名称或字节表。训练/开发/测试环境均使用 Plan §6.3.1 的生成式名称、needle、头标记、填充字节和 96-byte 内容；N/S/E/P 四种反馈只作为显式测试 IO 注入，不修改 Goal、profile、学生特征或磁盘内容。每个 fresh arm 使用独立计数器，`injected-first` 只在 forced 条件消费 slot 0 一次，之后解除。

候选特征必须在选择前记录。实现只在既有 `nextAction` 的「尚未开始的合法候选」选择点调用只读 `onDecision` 观察：快照包含全部合格候选的名称、路径和特征向量，以及本决策实际选中的候选。该观察没有选择权，不构成第二 selector、controller 或执行循环；`experimentCondition`、natural/forced、反馈条件和注入计数只写入证据字段，不进入 feature 向量。

每条决策样本按 Plan §6.2 保存 `sampleId/sourceGroup/partition/semanticFamily`、`episodeId/requestId/decisionOrdinal`、Goal/阈值/profile 引用、pre/actual State 引用、候选引用与 `featuresByCandidate`、选中候选、实际调用与后验引用、反馈类型与成本计数。`preferencePair` 只来自已真实执行并由后验复核的候选：preferred 为命中候选，other 为已完整证负候选；短读、EIO、stale、未执行或仅预测的候选不得生成负偏好标签。配对差值为新增列上的 `delta = x(preferred) - x(other)`；`delta=0` 不进入有效训练行，全部行都为 0 的数据由 `prepareCliCandidatePreferenceDataset` 拒绝。测试来源不提供给 fitter。

读取路径的 IO 失败按领域事实收敛，不把错误改写成成功，也不让共享控制器把整个搜索终止。仅 `EIO` 属于可恢复读取码：该候选进入既有 `read_error` 状态，保留 `failureCode="EIO"`、`read=null`、`contains=null`、`scan=null` 与原失败回执，`evaluateRead` 以“已记录失败”满足本次读取尝试，控制器随后按既有优先级选择其他合法候选。`EIO` 不产生证负、不重试同一对象、不记为负偏好；其后的合法命中与完整证负仍按真实后验生成 `preferencePair`。`EACCES`、`SANDBOX_ESCAPE` 等权限或越界错误不属于可恢复读取码，仍按原错误码终止并保留在失败诊断中。恢复由领域事实与共享 `recursive-goal` 的既有推进完成，不新增 selector、controller 或执行循环。

成对偏好损失为 `L = log(1 + exp(-(u(preferred) - u(other))))`，其中 `u = w_name * x`，`x` 只取 `search.nameNeedleSegment`。在零初始化且 `delta=1` 时，`dL/dw = -0.5`。拟合复用既有 Handwired 求值与反传电路；只更新 `entry.inspect` 行 `search.nameNeedleSegment` 列的一个参数，其余参数冻结。固定预算为 200 epochs、learning rate 0.1；非有限 loss/梯度或没有真实参数更新时停止，不得以“loss 下降”替代参数更新证据。

准入至少要求一条经后验复核且 `delta≠0` 的有效配对，本轮训练数据要求 `delta=1`。历史 P3 保存候选由当时 `10×31` 校验读回；在当前 Stage 2（`13×38`）下，公开 `validateCliCommandProfile` 默认校验 `13×38`（并支持显式 `stage1-11x34` 旧边界），P3 内容搜索 consumer（`playground/cli/content-search/reload-p3.mjs`）直接支持当前 `13×38` 候选并在离线迁移入口支持将历史 `10×31`/`11×34` 按名迁移后复验。缺文件、坏 JSON、错误 wire 顺序、错误矩阵形状或加载失败均显式失败，不 fallback 到默认或上一份 profile。保存候选保持 `uncalibrated/not_applied`，训练报告保持 `fullyVerified=false`。

## 1. 统一共享命令模型

本项目使用单一共享模型与权重profile承载所有已注册的CLI命令与当前控制结果：

- 合同标识：`cli.command-policy.v1`
- 命令头（heads，当前 `stage2-13x38` 共 13 个）：`unsupported`, `DEFER`, `NOOP`, `pwd`, `cd`, `ls`, `path.resolve`, `path.relative`, `path.parts`, `path.realpath`, `entry.inspect`, `directory.select`, `file.select`
- 输入连线（wires，当前 `stage2-13x38` 共 38 条）：4 条 legacy + 15 条 property + 10 条 predicate + 3 条 selectorTargetType + 4 条 state + 1 条 search + 1 条 interaction，共 38
- 参数结构：当前权威结构为 **Stage 2 `stage2-13x38`（13×38，共 494 个参数）**；Stage 1 显式旧边界为 `stage1-11x34`（11×34，共 374 个参数）；历史 0.3.0 基础结构（10×30，300 参数）与历史 P3 结构（10×31，310 参数）仅保留为历史记录与离线迁移输入
- 状态属性：`calibration: "uncalibrated"`, `adoption: "not_applied"`
- 同分规则：稳定顺序，`unsupported`优先；结果严格按teacher计分

模型接收 typed `file.property` Goal与State；profile、sandbox与会话在策略工厂绑定：`createCliCommandPolicy({ profile, sandbox, session: S, stage?, entrySelectProfiles? })`，每次调用只传`step({ goal, satisfactionThreshold, state })`。请求没有`resources`、`directories` 或独立 `directory` 字段。所有head的模型输出调用序列首项取自命令头，legacy三head是小写实际Shell命令名，新增head使用稳定点号动作id；后续项是机械绑定的typed位置参数引用，模型不生成自由参数文本。调用首项与typed参数顺序见§2.2：
- `sessionCwd observed` → `["pwd"]`（harness执行固定PWD观测）
- `sessionCwd equals D` → `["cd", D]` 或 `NOOP`（已满足且证据适用时不执行；否则提交S并以同一回执验证）
- `directory.entries observed` → `["ls", D]`（harness通过固定编译结构化helper列举）
- `path.absolute observed` → `["path.resolve", P, PathText]`（固定词法解释器，不访问FS）
- `path.relative observed` → `["path.relative", from, to]`（固定`path.posix.relative`）
- `path.parent`或`path.name` observed → `["path.parts", P]`（固定dirname/basename）
- `path.physical observed` / `entry.identity observed (resolvedTarget)` → `["path.realpath", ref]`（Stage 1 接入，固定helper/OS realpath）
- `entry.inspect`属性 observed → `["entry.inspect", ref, followSymlinks]`（固定stat/lstat/readlink）
- `directory.entries matches entrySelector`（已具备当前目录有效完整 listing 与只读 Track B 关系评分 profile）→ `["directory.select", selector, candidates, coverage]` 或 `["file.select", selector, candidates, coverage]`（Stage 2 接入，纯关系选择节点，不执行 shell）
- 合法未绑定 `DirectoryQuery` 或 `select.entry` 缺少当前有效完整目录 listing → `DEFER`，`invocation: null`，零 executor
- 未注册 property/predicate → `unsupported`，`invocation: null`，`executorInvoked: false`

示例（set_cwd）：

```ts
const policy = createCliCommandPolicy({ profile, sandbox, session: S });
const transition = await policy.step({
  goal: {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: { kind: "cli.file-query", relation: "sessionCwd", session: S },
    requirement: { kind: "equals", expected: D },
  },
  satisfactionThreshold: 100,
  state: { session: S.sessionId, cwdObservation: null, directoryListing: null },
});
```

`DirectoryRef.path`在调用时相对S当前cwd解析；CD提交后，调用者必须重新绑定相对引用。`DirectoryQuery` 是合法但未完成的目录绑定，本轮进入 `DEFER`。命令头预测错误时，guard拒绝执行但仍记录`policy_error`，不能把错误伪装成`unsupported`或OS失败。

历史独立的二分类CD/LIST模型合同已退役。旧六参数PWD API（`cli.goal-policy.v1`）本轮物理退役；旧 4×4 共享 profile 只能经显式离线迁移工具转换。CWD关系是独立概念测量：`MATCH/NO_MATCH`，`x=[1, sameSession, hasObservation]`，共6个参数；历史16/8只是样本计数，不产生命令selector。

## 2. 递进增量训练（Curriculum）

历史共享候选曾按三阶段递进训练。0.2.0 迁移轮实施改为单阶段：从旧 4×4 候选显式迁移到 6×14 后一次真实拟合并保存同一 profile；0.3.0 批次1从 6×14 迁移到 10×30 并重新拟合；P3 扩展到 10×31；Stage 1 从 10×31 迁移到 11×34（374 参数）；当前 Stage 2 再从 Stage 1 11×34 经 `migrateCliCommandProfileStage1ToStage2` 迁移到 13×38（374 按名复制 + 120 补零 = 494 参数）并拟合。以下三阶段表只记录最早旧候选来源与旧能力回放，不再产生 4/9/16 参数的独立保存候选：

| 阶段 | 动作集合 | 输入wires | 参数规模 | 输入起点与扩展规则 | 训练资料构成 |
| --- | --- | --- | ---: | --- | --- |
| 1. PWD | `unsupported`, `pwd` | `bias`, `goalObserveCwd` | 2×2=4 | 零初始化 | PWD正例 + 真实unsupported负例 |
| 2. CD | 追加 `cd` | 追加 `goalSetCwd` | 3×3=9 | 加载上一阶段保存的PWD候选；按名称扩展，新增行与列补零 | CD新正例 + PWD历史行全量回放 + unsupported |
| 3. LS | 追加 `ls` | 追加 `goalListDirectory` | 4×4=16 | 加载上一阶段保存的CD候选；按名称扩展，新增行与列补零 | LS新正例 + PWD/CD历史行全量回放 + unsupported |

注意：按名称扩展补零仅保证初始结构兼容，绝不代表数学上必然无回归（补零仍可能改变softmax分母与argmax）。每阶段必须同时记录：
1. 扩展后冻结对照：使用扩展后的初始矩阵且不做参数更新（等价初始状态`epochs:0`），只做预测。
2. 零权重对照：只做预测，不执行命令。
3. 真实Handwired拟合后候选（200 epochs，lr 0.1，源码根 `/Volumes/extension/code/handwired`）。
4. 历史命令逐项回归与逐命令独立统计（fixed / regressed / retained / unresolved）。

数值拟合器自身的`epochs:0`路径由作者单独测试，不属于上述两个预测对照。

### 2.1 共享矩阵的唯一扩展规则

所有命令/操作选择只有同一`cli.command-policy.v1`共享profile。P1-P6是样本、统计和效果分组，不是部署单元；不得为P1-P6分别保存profile、路由selector或候选。B对象关系与R用途是独立概念模型，不输出命令head；C组合下一步若选命令，复用本节同一共享矩阵。

保留规则：保留旧 head/wire 的名称、语义和按名对应系数。`bias`、`goalObserveCwd`、`goalSetCwd`、`goalListDirectory`四条legacy wire按名保留并排在wire表最前。当前 Stage 2 采用§0.1的 13 head、15 property、10 predicate 与 3 selectorTargetType 固定顺序；旧行索引不作为迁移依据，迁移一律按name查找，不得按位置复用旧权重。旧 4×4、6×14、10×30、10×31 对象仅作显式离线迁移输入；Stage 1 `11×34` 既可作为显式旧边界（`stage: "stage1-11x34"`）按自身矩阵推理，也可经 `migrateCliCommandProfileStage1ToStage2` 按名迁移到 `13×38`。

当前 Stage 2 head表固定顺序为：`unsupported`、`DEFER`、`NOOP`、`pwd`、`cd`、`ls`、`path.resolve`、`path.relative`、`path.parts`、`path.realpath`、`entry.inspect`、`directory.select`、`file.select`。文件§2.2列出完整25操作设计目录；当前已注册这 13 个 head（含 3 个控制 head 与 10 个执行 head），其余 15 个写/字节/元数据操作在后续阶段（P4–P6）按依赖逐个扩展，不预留空行。`DEFER`与`NOOP`是控制head，不执行shell。四 head（`unsupported,pwd,cd,ls`）、6×14、10×30、10×31 是迁移前历史阶段，不是当前阶段。

wire表按固定块顺序拼接，块间不交错：

| 块 | wire | 注册条件 |
| --- | --- | --- |
| legacy | `bias`、`goalObserveCwd`、`goalSetCwd`、`goalListDirectory` | 恒存在 |
| property | `property.<属性键后缀>` | 当前阶段或必需旧回放实际使用该属性 |
| predicate | `predicate.<predicate标签>` | 当前阶段或必需旧回放实际使用该predicate |
| selectorTargetType | `selectorTargetType.unspecified/regular/directory` | 阶段含`select.entry`类predicate时整块注册 |
| requiredTargetType | `requiredTargetType.unspecified/regular/directory/symlink` | 阶段含P4目标类型条件时整块注册 |
| observedType | `observedType.regular/directory/symlink/character_device/block_device/fifo/socket/other/unobserved` | 阶段需要实际观测类型时整块注册 |
| state | `state.hasFreshEvidence`、`state.knownValue`、`state.requiredConditionHolds`、`state.hasSourceRef`、`state.hasDestinationRef`、`state.hasParentRef`、`state.hasSessionRef`、`state.hasPayload` | 逐条按阶段需要注册 |
| search | `search.nameNeedleSegment` | P3 增量 A 注册；值域0/1 |
| interaction | `state.requiredConditionHolds*state.hasFreshEvidence` | 两个乘数都注册且该交互非恒定时注册 |
| combination | `combo.predicate.<7项>`、`combo.state.<15项>` | 仅C阶段注册，逐条按需要 |

块内顺序固定：property按[属性合同](cli-filesystem-semantics.md)第2节目录次序，predicate按[属性训练设计](cli-property-training-design.md)的P1→P6表序，其余块按上表列出次序。合并算法为：按上述块顺序收集；同name且定义相同只保留首个，同name定义冲突报错。legacy四列及既有profile已注册列始终保留；新增可选wire若在当前阶段全部训练与必需旧回放行中恒定，则不注册，记录为常量。声明整块注册的类型块保留完整one-hot词表，不逐列消融。由此`F`可唯一计算：

```text
F = 4
  + N_property
  + N_predicate
  + 3*selectorBlock
  + 4*requiredTypeBlock
  + 9*observedTypeBlock
  + N_state + N_search + N_interaction
  + N_combination
K = 1(unsupported) + 2(DEFER,NOOP) + 3(pwd,cd,ls) + N_newExecutable
矩阵 = K × F
```

`N_*`是注册后的实际数量，`selectorBlock/requiredTypeBlock/observedTypeBlock`为0/1。只有实际阶段需要的wire才注册，不为未来块预留恒定空列。`N_search`当前为1，只注册`search.nameNeedleSegment`。在当前 Stage 2（`stage2-13x38`）中，`N_property=15`、`N_predicate=10`、`selectorBlock=1`（3列）、`requiredTypeBlock=0`、`observedTypeBlock=0`、`N_state=4`、`N_search=1`、`N_interaction=1`、`N_combination=0`，故 `F = 4 + 15 + 10 + 3 + 4 + 1 + 1 = 38`；`K = 1 + 2 + 3 + 7 = 13`；矩阵为 `13×38 = 494` 参数。

运行schema实现于`lib/filters/cli-command-policy.ts`的`validateCliCommandProfile`，默认（`stage = "stage2-13x38"`）接受§0.1登记的 13 个 head 与 38 条 wire（494 参数），并保存精确`properties`/`predicates`顺序；当显式传入 `stage = "stage1-11x34"` 时校验 Stage 1 的 11×34（374 参数）旧边界。Stage 1 的 11×34 候选由 `migrateCliCommandProfileStage1ToStage2` 显式转换到 13×38（374 按名复制 + 120 补零），10×31 由 `migrateCliCommandProfileStage0ToStage1` 转换，10×30 由 `migrateCliCommandProfileV10x30` 转换，0.2.0 的 6×14 与旧 4×4 分别由 `migrateCliCommandProfileV6`、`migrateLegacyCliCommandProfile`（或统一入口 `migrateCliCommandProfileToCurrent`）离线转换。默认运行入口拒绝未迁移的旧形状与已废弃 10×32 形状，不接受默认替代。`requiredTargetType`/`observedType`/`combination` 块及 P4–P6 剩余 15 个操作 head 仍为设计，不冒称已接入。

### 2.2 新动作进入同一heads词表（25精确操作映射）

新增动作不建第二套词表，直接进入§2.1的同一head表。`cwd.get`、`cwd.set`、`directory.list`复用既有`pwd`、`cd`、`ls`行，不再加同义别名；批次1注册`path.resolve`、`path.relative`、`path.parts`、`entry.inspect`，Stage 1 注册 `path.realpath`，Stage 2 注册 `directory.select`、`file.select`，其余 P4–P6 操作保留为后续设计，不进入当前 `stage2-13x38` profile。调用输出统一为`[head, ...typed位置参数]`；参数顺序按本表，对象值参数保持一个typed对象。模型不生成argv、flags、shell文本或可执行路径；harness只把选定head映射到固定adapter并按类型绑定参数，绝不根据Goal改选或补选动作。

| operation | head | 调用首项与typed参数（顺序） | adapter | 执行shell |
| --- | --- | --- | --- | --- |
| `cwd.get` | `pwd` | `["pwd"]` | 既有`/bin/pwd -P` | 是（legacy例外） |
| `cwd.set` | `cd` | `["cd", D]` | 既有固定CD脚本 | 是（legacy例外） |
| `directory.list` | `ls` | `["ls", D]` | 既有固定结构化helper | 否 |
| `path.resolve` | `path.resolve` | `["path.resolve", P, PathText]` | 既有词法解释器 | 否 |
| `path.relative` | `path.relative` | `["path.relative", from, to]` | 固定纯函数`path.posix.relative` | 否 |
| `path.parts` | `path.parts` | `["path.parts", P]` | 固定纯函数`dirname/basename` | 否 |
| `path.realpath` | `path.realpath` | `["path.realpath", ref]` | 固定helper/OS realpath | 否 |
| `entry.inspect` | `entry.inspect` | `["entry.inspect", ref, followSymlinks]` | 固定helper/OS stat/lstat/readlink | 否 |
| `directory.select` | `directory.select` | `["directory.select", selector, candidates, coverage]` | 纯关系节点 | 否 |
| `file.select` | `file.select` | `["file.select", selector, candidates, coverage]` | 纯关系节点 | 否 |
| `directory.create` | `directory.create` | `["directory.create", {parent:D,name}]` | 固定helper `fs.mkdir` | 否 |
| `file.create` | `file.create` | `["file.create", {parent:D,name}]` | 固定helper `O_CREAT\|O_EXCL` | 否 |
| `link.create` | `link.create` | `["link.create", {parent:D,name}, targetText]` | 固定helper `fs.symlink` | 否 |
| `file.link` | `file.link` | `["file.link", source, {parent:D,name}]` | 固定helper link | 否 |
| `entry.move` | `entry.move` | `["entry.move", source, {parent:D,name}]` | 固定helper/native no-replace rename | 否 |
| `entry.remove` | `entry.remove` | `["entry.remove", entry]` | 固定helper unlink/rmdir | 否 |
| `file.read` | `file.read` | `["file.read", file, offset, length]` | 固定helper read | 否 |
| `file.replace` | `file.replace` | `["file.replace", file, content]` | 固定helper truncate+write | 否 |
| `file.write` | `file.write` | `["file.write", file, offset, content]` | 固定helper positional write | 否 |
| `file.append` | `file.append` | `["file.append", file, content]` | 固定helper `O_APPEND` write | 否 |
| `file.truncate` | `file.truncate` | `["file.truncate", file, length]` | 固定helper `ftruncate` | 否 |
| `file.copy` | `file.copy` | `["file.copy", source, {parent:D,name}]` | 固定helper copy | 否 |
| `entry.mode.set` | `entry.mode.set` | `["entry.mode.set", entry, mode]` | 固定helper `fchmod` | 否 |
| `entry.owner.set` | `entry.owner.set` | `["entry.owner.set", entry, uid, gid]` | 固定helper `fchown` | 否 |
| `entry.times.set` | `entry.times.set` | `["entry.times.set", entry, atime, mtime]` | 固定helper `futimes` | 否 |

legacy三行的首项是实际小写命令名；新增行的首项是稳定语义动作id。两者都在同一head表，输出都沿用`[head, ...typed位置参数]`首项约定，因此不并存"原生命令名"与"语义动作id"两套写法，也不产生重复别名。head到adapter的映射固定在代码中；模型只能选head，不能选adapter、helper路径或OS API。

### 2.3 file.property迁移、对照与回归

扩展同一阶段时，输入是上一保存候选，按name迁移：对每个新head与wire，若旧profile已有同名行/列则复制旧交叉块，否则补零。历史批次1从旧6×14候选扩展到10×30（84复制+216补零），P3 增量 A 从10×30扩展到10×31（300复制+10补零），Stage 1 从10×31扩展到11×34（310复制+64补零=374）。**当前 Stage 2 从保存的 Stage 1 `11×34` 候选经 `migrateCliCommandProfileStage1ToStage2` 扩展到 `13×38`：374 个已有 `(head, wire)` 交叉位置按精确名称原值复制，新增 `directory.select`、`file.select` 两行与 `predicate.select.entry`、`selectorTargetType.unspecified/regular/directory` 四列共 120 个位置补零，合计 494 参数**。旧交叉块按name保留，不按索引复用；不改写、不重置已有系数。零填充只保证结构兼容，不保证softmax无回归：新增行/列会改变softmax分母与argmax，必须实测。

同一阶段必须回放全部必需旧行：`pwd`、`cd`、`ls`、真实`unsupported`、批次1四原语、Stage 1 `path.realpath`，并按新样本要求加入 Stage 2 的 `directory.select`、`file.select` 及未观测/过期目录 `DEFER` 行。旧行保留原teacher head，不得改标为REJECT。每阶段分别设计并记录下列四项：

1. 扩展后冻结对照：迁移后的初始矩阵、`epochs:0`、只预测。
2. 零基线对照：全零矩阵、只预测；不得把零模型当随机基线。
3. 真实训练：从上一保存候选（首次为零）按name迁移后，用Handwired真实拟合，固定epochs/lr并记录计时与行处理量。
4. 逐head、逐属性回归与新进程回载：保存候选后在新进程加载，按head和属性分别报告`fixed/regressed/retained/unresolved`，并对旧PWD/CD/LS/unsupported做命令级回归。

冻结与零基线只预测，不执行命令；真实训练与回载是独立步骤。不得用一次冻结通过代替真实拟合，也不得用零填充自称无回归。

### 2.4 控制head与guard

`unsupported`、`DEFER`、`NOOP`都是不执行shell的控制head。`unsupported`表示Goal kind、operation或property/predicate对不在注册词表；`DEFER`表示已注册语义缺必要对象、观测、参数或证据并返回typed缺口；`NOOP`表示当前State已满足Goal且证据适用。三者必须分开记录，不得互相冒充。

`FINISH`不是独立head。组合C只有在实际整体Goal条件成立时才允许结束，并以共享`NOOP`表达；预算或前沿耗尽而Goal未成立时返回`DEFER`与continuation，不返回`FINISH`或伪造成功。

guard在softmax之后拒绝不可执行或类型不匹配的调用；它不改变"全注册词表共同softmax"这一事实。禁止prepare按P1-P6或其他分组先过滤logits或硬mask使错误head不出现；teacher允许集合只用于损失与评价。被guard拒绝的错误head仍计一次策略错误并记录`policy_error`，不得改标为`unsupported`、`DEFER`或OS失败。

## 3. 样本分区与监督标签迁移

保留来源家族隔离：0.2.0共享数据集含4个train家族与2个development家族，同一家族不跨分区。0.3.0批次1新增4个train家族与2个development家族，每族34行，新增train136、dev68（合计262行）；Stage 1 新增 `path.realpath` 48行（合计310行）；Stage 2 新增单目录 `select.entry` 48行（原合计358行）并在 B2 `r2` 以 append-only 方式追加 12 条未观测/过期目录阻断样本（8 train + 4 dev，合计 370 行 = 246 train + 124 development）。正式共享run未提供可选verification资源；独立verification家族由独立作者另建，父级独立报告单独记录。
共享训练图适用于目录与文件属性单元，入口必须提供具体属性键、对象、Goal条件、satisfactionThreshold、可见State及可学习Action关系。训练期反推达标属性与前置条件；每项补齐自己的输入/wire/参数/损失后才可实施。当前图没有自动获得新属性模型或新harness，具体缺口沿属性合同第5节记录；完成训练与独立回载后再进入既有model-evolution单元升级流程。

普通属性单元现已由 [cli-property-training-design.md](cli-property-training-design.md) 补全B/P/R/C输入、监督和验证配方；批次1的路径与inspect输入、监督、分区和错误监督按§7补充。固定调用方案由 [cli-command-design.md](cli-command-design.md)维护。命令/操作选择只有一个owner：本文§2.1-2.4的同一`cli.command-policy.v1`共享矩阵；B对象关系（目录选择为 `cli.directory-select-relation.v1`，普通文件选择为 `cli.file-select-relation.v1`）与R用途是独立概念模型，其中 Track B 在 Stage 2 以只读 `entrySelectProfiles` 注入供 `directory.select`/`file.select` 执行候选评分，不替代共享命令矩阵选头；C组合下一步若选命令复用同一共享矩阵。`workflows/cli-filesystem-training.graph.json`与运行绑定均为`cli.command.*@0.3.0.0000`，8N8E拓扑和分区/拟合/保存/回载/评价/收口不变；R 及 P4–P6 剩余操作仍为设计，不写入当前真实图。

共享过程是单源单汇DAG。分区声明之后分成两条资料链：训练/开发准备与独立验证准备。拟合节点只收到训练资料；独立验证资料在候选形成后才与候选合流。验证不回流修改本轮参数。

每条样本按实际语义打标，严禁将支持的命令在其他命令训练中打上控制head：
- `sessionCwd observed` → `pwd`
- `sessionCwd equals`（适用证据不等或未知）→ `cd`
- `sessionCwd equals`（适用证据相等）→ `NOOP`
- `directory.entries observed` → `ls`
- `directory.entries matches entrySelector`（当前目录已有新鲜完整 listing，targetType 为 directory/regular）→ `directory.select` / `file.select`
- 合法未绑定 `DirectoryQuery` 或 `select.entry` 缺少当前新鲜完整目录 listing → `DEFER`
- 未注册 property/predicate → `unsupported`

数据集构成：
- 当前单阶段：每个来源家族覆盖已注册执行 head、NOOP、DEFER、unsupported 及 State 配对；train/dev/verification 家族不重叠。
- 具体行数由公开consumer的`makeCliCommandFixture`按场景生成；行数不是固定部署声明，只在报告中按实际计数。
- 旧 PWD/CD/LS/unsupported 历史行以 typed 语义转换版本回放，保证旧能力零回归。
- 验证集由独立作者配方另行提供，加上各命令专属失败探针；父级独立报告单独记录，不进入默认train/development分区。若调用者显式提供可选verification资源，receipt才记录`evaluation`分支。测试覆盖有限特征向量与真实环境变化（空格、中文、嵌套、链接等），不冒称未见语义泛化。

## 4. 真实文件系统沙盒与harness边界

沙盒执行器（`lib/adapters/cli/`）提供隔离的场景目录与显式session资源。每个分区与每条带副作用的样本独立创建目录与session：

- **PWD**：执行`/bin/pwd -P`，读取物理cwd观测。S.cwd保持不变。
- **path.resolve**：固定词法解释器`interpretCliPath`，入参为明确绝对base与原始PathText；不访问FS、不展开`~`/环境变量/glob；S与FS内容不变。
- **path.relative**：固定`path.posix.relative`，入参是两个明确绝对路径；结果可为空串，不得强制非空；同路径与交换参数必须产生可区分结果。
- **path.parts**：固定`dirname/basename`，入参是明确绝对路径；根显式为parent=`/`、name=`""`、isRoot=true；不得把`basename('/')`当作合同值。
- **path.realpath**：固定helper执行OS `realpath` 解析物理路径与链接目标身份；只读，不修改S或FS。
- **entry.inspect**：固定helper执行`stat`/`lstat`/`readlink`。先核对session/scenario、绝对绑定与对象身份；follow=true时先`lstat`来源条目，再`stat`目标，两种身份分别保存。只读，不打开FIFO/socket/设备字节流。旧四字段D缺身份时返回`binding_identity_missing`/unknown，不降级为P。
- **directory.select / file.select**：基于当前会话已观测的完整直接子条目 listing 与显式注入的只读 Track B 关系 profile（目录选择为 `cli.directory-select-relation.v1`，普通文件选择为 `cli.file-select-relation.v1`）执行确定性候选关系打分与选择，输出 `selectedEntry` 与 `selectedRef`；不启动外部进程，不扫描未观测磁盘目录。
- **CD**：执行固定zsh脚本，先验证目录类型与归属，成功后提交S.cwd与revision；紧接着在同一S上执行真实PWD验证后条件。提交前失败不修改S；提交后验证失败如实报告实际修改状态，不伪报回滚。
- **LS**：通过固定编译本地helper执行（`process.execPath + helperPath + D`），返回直接条目的结构化JSON（包含精确名称、由OS lstat观测的类型、coverage及errors）。不修改S.cwd，不修改文件系统。partial结果不能覆盖旧知识或冒充完整列举。严禁将`/bin/ls`面向人类的文本输出分词或flags称为NN训练。
- **失败与清理分类**：报告中严格区分native OS错误、grant授权拒绝、受控故障注入；native与注入不合并计数，fixture创建失败、清理失败与模型策略错误分别计数。清理失败显式暴露。

资产保存在既有目录，不新建根级资产目录：
- 样本：`training/samples/filesystem/<capability>/<run>/`
- 候选：`training/weights/filesystem/<capability>/<run>/candidate.json`
- 报告：`training/results/filesystem/<capability>/<run>/report.json`

## 5. 推理与训练DAG

- 推理DAG：`workflows/cli-file-property.graph.json`（6节点/5边，0.3.0）及`cli-file-property.workflow.json`，负责接收 typed `file.property` 请求，经绑定→选择→执行→观测→评价→报告收敛于统一SESE出口。当前 Stage 2（`stage2-13x38`）的 `directory.select`/`file.select` 及四条 selector wire 直接沿同一 6N5E 图运行，节点ID、ARC ID、边与端口不变。旧`cli-command-step`与`cli-goal-step`图及绑定已物理退役。
- 训练DAG：`workflows/cli-filesystem-training.graph.json`（8节点/8边，0.3.0）及同名workflow配置，接收调用者准备并分区的 typed dataset（当前 Stage 2 支持 `stage: "stage2-13x38"` 并保留 `stage: "stage1-11x34"` 边界，样本含 `select.entry` 路由与只读 Track B `entrySelectProfiles` 注入）。它不生成fixture，也不自行启动新进程回载；fixture由公开consumer的`makeCliCommandFixture`创建，保存候选后由consumer重新读取，并以新进程运行reload脚本。
- 训练图的 typed 任务分支：同一 8N8E 图同时承载 `task: "command"`（共享命令/选择交叉熵）与 `task: "candidate-preference"`（候选名称关系成对偏好）。偏好分支经 `partition → prepare → fit → save → execute → verify → report` 运行，`fit` 只更新 `entry.inspect × search.nameNeedleSegment` 一个系数，`execute` 用保存后的候选 profile 在同一 Handwired 电路复算每条配对效用并写 `executions.jsonl`，`report` 输出 `CliCandidatePreferenceTrainingReceipt`。两个分支共用同一图、同一分区与保存路径，不新建训练引擎；公开入口为 `nnanything/cli-goal` 的 `runCliCommandTraining` 与 consumer `playground/cli/command-learning/train.mjs`、`playground/cli/content-search/train-p3.mjs`。
- 阶段调度：`workflows/cli-filesystem-curriculum.graph.json`现为7节点/6边、0.2.0-design设计图（非真实训练图），只描述历史 PWD→CD→LS 顺序与后续属性单元；公开consumer只执行本轮单阶段迁移训练，不执行未来设计单元。
- 拟合迭代：epoch循环在数值拟合器内完成，不给外层workflow加回边。

## 6. 当前实施状态与验收底线

当前状态（Stage 2 `stage2-13x38`）：`cli.command-policy.v1` 当前权威 schema 为 **13 head × 38 wire = 494 参数**（`stage2-13x38`），同时保留 `stage1-11x34`（11×34 = 374 参数）作为显式旧边界按自身矩阵推理。Stage 2 正式候选 `4e7e39ca-bd72-4785-a719-c621112159b8` 从 Stage 1 候选 `7e34901c-68ca-401f-ab40-72189f4e904d` 经 `migrateCliCommandProfileStage1ToStage2` 按名迁移（374 复制 + 120 补零 = 494 参数），配合只读 Track B 候选 `39427f5c-f525-4f6a-af84-9664f820cc71`（`directory-candidate.json` 对应 `cli.directory-select-relation.v1`，`file-candidate.json` 对应 `cli.file-select-relation.v1`），以 200 epochs / lr 0.1 在 8N8E 训练图真实执行 370 条样本（原 358 条 + append-only 追加 12 条未观测/过期目录阻断样本）：`train` 246/246、`development` 124/124（原 358 条 238/238 与 120/120，追加 12 条 8/8 与 4/4），全部 13 个 head `regressed=0`、`unresolved=0`；新进程回载 `reload.json` `executed=370`、`failed=0`；P3 名称偏好回归 24/24 且 `entry.inspect × search.nameNeedleSegment` 保持 `weightBefore=weightAfter=2.9020536351949002`（`weightDelta=0`）；P3 内容搜索回载 natural 与 forced-first 各 24/24；外部独立套件通过 95/95（历史 71 = Stage 0 56 + Stage 1 15；Stage 2 新增 24）并保留 5 项固定 `UNVERIFIED`（首跑失败候选 `4e249c32-0809-4016-beb6-5b3d336a9f16` 及原错例证据完整保留）。候选 `4e7e39ca-bd72-4785-a719-c621112159b8` 保持 `calibration: "uncalibrated"`、`adoption: "not_applied"`，训练报告保持 `fullyVerified: false`（`verification.status: "not_provided"`）。

**历史阶段记录（不再作为当前默认矩阵）**：0.2.0 源码迁移为 typed `file.property` 单 profile（6×14，从 `d7c4a3e5-4111-4e09-857f-5f20f4fa18c0` 迁移）；0.3.0 批次1（10×30，300 参数）在训练图真实执行 262 条样本，候选 `35bd5ad9-15dc-409e-9001-bcab24f75398`；P3 增量 B/B2（10×31，310 参数）在 10×30 上追加 `search.nameNeedleSegment` 并只更新 `entry.inspect × search.nameNeedleSegment` 一项至 `2.902054`，产出候选 `39f1570f-be11-48a4-94cb-3b071982922b` 与 `fb73d4a0-cb66-4008-afa0-5569b2cdfcdc`；Stage 1（`stage1-11x34`，374 参数）接入 `path.realpath` 并真实执行 310 条样本、外部独立套件 71/71，产出候选 `7e34901c-68ca-401f-ab40-72189f4e904d`。所有历史候选均保持 `uncalibrated`/`not_applied` 与 `fullyVerified=false`。

历史独立PWD与CD实测数据保留为历史基线，不直接抄写为共享模型结果。`accepted`只表示train/dev与历史回归通过；未提供可选verification资源时`fullyVerified=false`。训练图的冻结/零权重对照只做预测，不执行命令；独立测试由父级独立报告另行记录，不声称在训练图内执行。

验收门槛：
1. 共享模型经统一公开入口在新进程加载并逐项验证：作者侧已执行；父级独立验证另行记录。
2. 历史必需能力零回归：旧 PWD/CD/LS/unsupported 及前序路径/inspect/realpath 回放零回归。
3. 真实argv、权限拒绝、受控注入和清理回执完整无遗漏：作者与sandbox用例覆盖。
4. 全仓基线用 `npm run test:full`。缺 `NN_HANDWIRED_ROOT`、`NN_CLI_COMMAND_PROFILE`、`NN_CWD_RELATION_PROFILE` 任一项时非零退出，不以 skip 冒充通过；迁移后记录数字为 255/255、0 跳过。默认 `npm test` 仍可在无资产环境运行，但其中的跳过项不计作通过。
5. 当前运行入口支持 `pwd`/`cd`/`ls`/`path.resolve`/`path.relative`/`path.parts`/`path.realpath`/`entry.inspect`/`directory.select`/`file.select` 与 `NOOP`/`DEFER`/`unsupported` 控制结果。后续 P4–P6 目录/文件写与字节/元数据操作、自动采样/采用及LLM冲突裁决仍未接入共享命令矩阵。自然语言识别、help泛化、browser与自动升级保持在范围外。

## 7. 批次1输入、监督与独立验收合同

### 7.1 四元素与可执行配对

| head | Goal property / target | 学生输入与允许Action | 实际New State与反例 |
| --- | --- | --- | --- |
| `path.resolve` | `path.absolute`；base为P，input为PathText；observed this_run | 明确base/input；只允许`["path.resolve",P,PathText]` | 记录本次absolute/parent；不读FS、不写exists；绝对input覆盖base，`/missing/../x`可成功，`~/$HOME/glob`保持字面 |
| `path.relative` | `path.relative`；from/to为P；observed this_run | 两个明确绝对路径；只允许`["path.relative",from,to]` | 保留本次relative；同路径为空串合法，交换方向必须改变预期，非绝对参数TypeError |
| `path.parts` | `path.parent`或`path.name`；P；observed this_run | 明确绝对P；只允许`["path.parts",P]` | 同回执保留parent/name/isRoot；根`/`为parent=`/`、name=`""`、isRoot=true；词法结果不证明目录归属 |
| `entry.inspect` | 8项inspect property之一；E/D/F/P ref与followSymlinks | 已观测对象引用、明确跟随模式、授权与旧属性；只允许`["entry.inspect",ref,followSymlinks]` | 本次stat/lstat/readlink机器证据按property投影；保留原ref、来源身份、结果身份、errno与观测方法；不写FS，不读FIFO/socket/设备字节流 |

`PathRef`、E/D/F引用、旧D兼容和身份校验沿[file.property合同](cli-filesystem-semantics.md)§7.2。`State`增加可选`pathKnowledge`与`entryKnowledge`槽；旧三字段请求解释为空新槽，返回统一规范State。身份、类型、sourceRun、sessionRevision与absolutePath只能来自sandbox绑定与真实观测，不由业务metadata、JSON回执或日志重建。旧D缺身份时进入`binding_identity_missing`，不得构造P替代。

### 7.2 监督与错误

每个新observed请求即使有旧知识也必须执行所选原语。路径head的监督来自typed Goal/State与独立例表，不把执行结果或teacher head送入学生输入。`entry.inspect`监督来自独立OS fixture和按property选定的typed Goal；expectedHead、目标路径答案、native errno与readlink输出不进入特征。OS失败仍可监督正确`entry.inspect`，不能把EACCES改标为`unsupported`。新普通观测缺旧知识时仍选inspect，不误标DEFER。

`exists`的follow投影、ENOENT/ENOTDIR/EACCES/EPERM/ELOOP、E/D/F失效、身份缺失、非适用字段、已证不匹配与guard拒绝沿[§7.4错误终点](cli-filesystem-semantics.md#74-os-错误与满足度终点)。阈值为0也必须取得必要本次事实；OS错误、属性值、实际满足度和policy score分别记录。

### 7.3 样本分区与独立验收

新增4个train家族与2个development家族，每族34行：resolve6、relative6、parts6、inspect16（8属性×2个适用状态）。新增train136、dev68；旧38 train/20 development语义行及标签/预算保持不变。resolve/relative/parts各为train正例6×4=24、dev正例6×2=12；inspect为train正64、dev32。其余行作为同一共享命令 softmax 的负例，实际计数在报告中按行统计，不造每head独立权重。新家族使用不同树/路径结构，换名不算独立家族。

独立作者另建至少4个verification来源家族，覆盖4个新head各两种结构及8个inspect属性；新增至少32场景与16失败/边界探针。旧34场景/16探针必须在新候选重跑并分开报告。候选保存后才接收独立配方；若配方用于调参则转回归并另留新验证。`block_device` native证据在macOS标`UNVERIFIED`；FIFO、socket、symlink使用沙盒真实fixture。候选保持`uncalibrated/not_applied`，真实拟合、回载与独立结果由I6/I7产生。
