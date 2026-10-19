# 节点定义与合同清单 (lib/nodes/)

状态：候选内容，实施中复核（candidate under verification）。本文的 12 类、关系测量与 ignore 节点合同仍需完成本增量整体场景回归；候选 profile 不因合同更新自动采用。

本目录为 NNAnything 节点定义（`NodeDefinition`）的唯一源码根目录。
遵循 [可复用经验节点合同](../../docs/node-contract.md)，本文件是基础采样 3 节点、第一层 DOM 基础种类节点（`dom.basic_kinds@0.1.0`）与离线训练 6 节点（`training.*@0.1.0`）合同卡（身份、输入、输出、配置与状态、副作用、训练能力、兼容条件、验收）的规范真源，并索引已实现的算子。
详细算法设计与训练流程分别复用 [基础种类连线设计](../../docs/basic-kinds-wiring.md) 与 [训练 workflow 设计](../../docs/training-workflow.md)，本卡聚焦节点 I/O、配置与副作用契约。

---

## CLI 路径函数训练节点（0.1.0）

路径训练增量另有 `cli.path.prepare/fit/evaluate/save@0.1.0` 四节点及 `cli.path.resolve@0.1.0` 推理节点，owner为 `cli-path-training.ts`。完整路径算法、profile/wire和样本合同唯一维护于 [路径函数训练](../../docs/cli-path-training.md)。公开入口 `nnanything/cli-training`，不与DOM训练profile混用。

| operator | 输入schema/event → 输出schema/event | 配置、资源与effect |
| --- | --- | --- |
| `cli.path.prepare` | cli.path.training-request.v1 → cli.path.prepared.v1 | 显式分区样本与epochs/lr，零初始profile；无effect |
| `cli.path.fit` | cli.path.prepared.v1 → cli.path.candidate.v1 | 工厂注入显式Handwired源码根；filesystem.read；只拟合train动作行 |
| `cli.path.evaluate` | cli.path.candidate.v1 → cli.path.evaluation.v1 | 基线/冻结/候选，teacher-state和完整自主rollout分开；无业务effect |
| `cli.path.save` | cli.path.evaluation.v1 → cli.path.training-receipt.v1 | 显式输出根；filesystem.write；samples/weights/results create-new与部分保存诊断 |
| `cli.path.resolve` | cli.path.request.v1 → cli.path.result.v1 | 空config+显式path-controller profile绑定；无业务effect；错误动作保留失败trace |

训练执行 `workflows/cli-path-training.graph.json`，推理执行 `cli-path-resolve.graph.json`，不复制拓扑。内部数值结构单独由 `lib/nodes/trainable/cli-path-controller.ts` 管理。schema/阶段数据在领域节点校验，compile检查profile和effects，runner按既有失败合同收束。实际拟合、失效后端、冻结/回载、根目录/父路径、拒权与写入边界验收见 cli-path 系列测试及公开consumer。

## CLI Goal 动作与观测绑定节点（0.1.0）

首个结构化 Goal 切片另有 `cli.goal.select/execute/evaluate@0.1.0` 三节点及训练 `cli.goal.prepare/fit/evaluate/save@0.1.0` 四节点。它们保留为六参数 PWD 历史兼容基线，不是当前共享命令入口。完整兼容合同与历史实测唯一维护于 [Goal动作训练](../../docs/cli-goal-training.md)。当前 `pwd/cd/ls` 模型使用下方共享命令节点与 `cli.command-policy.v1`。

| operator | 输入schema/event → 输出schema/event | 配置、资源与effect |
| --- | --- | --- |
| `cli.goal.select` | cli.goal.step-request.v1 → cli.goal.selection.v1 | 空config+显式`cli-goal-policy` profile；读取显式Goal/State并输出3 features/2 scores/selectedAction；无effect |
| `cli.goal.execute` | cli.goal.selection.v1 → cli.goal.execution.v1 | 工厂注入显式session；REJECT或unsupported不执行；observe_cwd的PWD调用现有pwd adapter；无静态effect，业务授权由CLI session检查 |
| `cli.goal.evaluate` | cli.goal.execution.v1 → cli.goal.transition.v1 | 只把本次成功pwd观测绑定为新知识；失败保留旧知识；记录policy_error与GoalResult；无effect |
| `cli.goal.prepare` | cli.goal.training-request.v1 → cli.goal.prepared.v1 | 12/6 train/development、无holdout、零profile；无effect |
| `cli.goal.fit` | cli.goal.prepared.v1 → cli.goal.candidate.v1 | 显式Handwired源码根；filesystem.read；只拟合train的12行、6参数 |
| `cli.goal.training.evaluate` | cli.goal.candidate.v1 → cli.goal.evaluation.v1 | 零/冻结/候选均经同一step workflow；策略准确率与Goal成功分开；无静态effect |
| `cli.goal.save` | cli.goal.evaluation.v1 → cli.goal.training-receipt.v1 | 显式输出根；filesystem.write；samples/weights/results create-new与部分保存诊断 |

推理执行 `workflows/cli-goal-step.graph.json`（3N2E SESE），训练执行 `workflows/cli-goal-training.graph.json`（4N3E SESE），不复制拓扑。内部六参数电路由 `lib/nodes/trainable/cli-goal-policy.ts` 管理。真实执行、拒绝零调用、授权/执行失败、fresh-process回载和实际拟合证据见 `tests/cli-goal.test.mjs`、公开consumer与运行证据目录。

## CLI 共享命令节点（0.1.0）

公开入口为 `nnanything/cli-goal`。`createCliCommandPolicy` 使用同一 `cli.command-policy.v1` profile 完成 `pwd`、`cd`、`ls` 推理，`runCliCommandTraining` 按 PWD→CD→LS 名称扩展并增量拟合，参数为 4→9→16。模型只输出命令头与 typed directory 引用；固定语义调用、session 副作用和实际后条件由 harness 执行并观测。旧六参数 `createCliGoalPolicy`/`runCliGoalTraining` API 保留为兼容基线；新共享入口不按命令加载旧 profile。CWD 关系测量保留为独立概念测量，不产生命令候选。

| operator | I/O和职责 | effect和资源 |
| --- | --- | --- |
| `cli.command.select` | command_request → command_selection；同一共享 profile 选择命令头并记录策略错误 | 无effect |
| `cli.command.execute` | command_selection → command_execution；按 pwd/cd/ls 固定分流，绑定显式 session 与 directory | 业务 read/exec/session.write 由 sandbox 动态检查 |
| `cli.command.verify` | command_execution → command_transition；读取实际 pwd、CD 后新 PWD、LS 完整直接条目并验证 GoalResult | 无静态effect |
| `cli.command.training.partition` | command_training_request → command_partition；验证请求、预算、来源分区和共享候选形状 | 无effect |
| `cli.command.training.prepare` | command_partition → command_fit_data；只准备 train 及历史训练回放 | 无effect |
| `cli.command.training.prepare-verification` | command_partition → command_verification_data；可选验证资料仅供评价 | 无effect；缺资源明确 `not_provided` |
| `cli.command.training.fit` | command_fit_data → command_fitted；从上一阶段候选按名称扩展后真实拟合 | filesystem.read；显式 Handwired 源码根 |
| `cli.command.training.save` | command_fitted → command_candidate；独占保存样本与共享候选 | filesystem.write；显式 outputRoot |
| `cli.command.training.execute` | command_candidate + command_verification_data → command_executions；同一候选真实调用各命令 | 临时场景与 session 授权由 sandbox 检查，finally 清理 |
| `cli.command.training.verify` | command_executions → command_evaluation；逐命令比较策略、真实效果、历史回归和名称/类型 | 无effect |
| `cli.command.training.report` | command_evaluation → command_training_receipt；保存分命令结果、计时和清理证据 | filesystem.write |

推理执行 `workflows/cli-command-step.graph.json`（3N2E SESE，配置 `cli-command-step.workflow.json`），训练执行 `workflows/cli-filesystem-training.graph.json`（8N8E SESE，配置 `cli-filesystem-training.workflow.json`），不复制拓扑。内部多分类线性电路由 `lib/nodes/trainable/cli-command-policy.ts` 管理。`workflows/cli-filesystem-curriculum.graph.json` 只说明公开 consumer 的 PWD→CD→LS 顺序和 `sharedCandidate` 传递，不代表已有独立 Flowed 课程引擎。

`accepted` 只覆盖实际提供的评价分区；无 verification 资源时 `fullyVerified=false`。候选保持 `uncalibrated/not_applied`。固定调用、边界和后条件见[文件系统训练合同](../../docs/cli-filesystem-training.md)。作者测试为 `tests/cli-command.test.mjs`、`tests/cli-command-training.test.mjs` 及 CLI sandbox/binding/evaluation 用例；公开训练与新进程回载入口为 `playground/cli/command-learning/`。

## CLI 基础观测节点（0.1.0）

`cli.observe@0.1.0` 的实现 owner 为 `cli-observation.ts`。公开工厂 `createCliObservationNode({cwd})` 经 `nnanything/cli` 导出。`cwd` 为显式、固定的词法绝对路径，不读隐藏工作目录。节点没有 profile 或训练参数。

- 输入 `cli_request`：schema `cli/request/v1`，事件 `cli.request.v1`；请求联合为 pwd、path、attributes。未知字段、空路径与缺失链接策略均拒绝。
- 输出 `cli_observation`：schema `cli/result/v1`，事件 `cli.result.v1`；成功观测或带 operation/stage/code/message 的显式失败。合同和语义唯一入口为 [CLI 基础合同](../../docs/cli-foundation.md)。
- 依赖：纯路径交给 `filters/cli-path.ts`；实际 pwd 与 stat/lstat/readlink 交给 `adapters/cli/observation.ts`。节点只做合同与 workflow 封装。
- Effects：按请求从现有 context.grantedEffects 检查。path 无业务 IO；attributes 需 filesystem.read；pwd 需 filesystem.read 与 process.exec。静态 effects 为空，避免纯路径被全量 IO 权限阻断；动态权限在唯一观测适配器检查并返回 authorize 失败，不是取消权限检查。
- 图与兼容：只读取 `workflows/cli-foundation.graph.json` 与持久配置，1N0E；不在源码复制拓扑。没有节点内部数值图，不声明可训练。
- 验收：`tests/cli-foundation.test.mjs` 与 `playground/cli/foundation.mjs` 分别验证基础能力、真实进程、OS 属性、链接、拒权、错误隔离与无目标写入。

## 1. 基础规则采样流 3 节点合同卡（0.1.0）

本节是 3 个采样算子合同卡（身份、输入、输出、配置与状态、副作用、训练能力、兼容条件、验收）的唯一规范真源。
公共 API 通过 `nnanything/browser` 导出：`sampleMatchNode`、`sampleAssembleNode`、`createSampleSaveNode({ allowedRoot })`；主入口 `nnanything` 导出通用框架。

### 1.1 `sample.match`（按显式规则匹配 DOM 记录）

teacher 的 attributes 支持字符串、有限数值、布尔与 null；显式采集值 null 不等同字段未采集。

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "sample.match"`, `operator_version: "0.1.0"`。手写确定性语义分类规则匹配节点。<br>公开导出：`sampleMatchNode`（通过 `nnanything/browser`，内核纯函数 `evaluateSemanticRules` 独立可用，无 training 依赖）。<br>唯一 owner：`lib/filters/sample-match.ts`（规则求值内核）+ `lib/nodes/sampling.ts`（节点定义）。 |
| **输入** | 端口 `raw_records`，schemaId `sample/raw-dom-records/v1`，事件 `sample.raw-records.v1`。payload 为 `{ snapshotRef: string, sourceGroup: { snapshotRefs: string[], postRefs?: string[], adAssetRefs?: string[] }, records: RawDomRecord[] }`。snapshotRefs 必含当前 snapshotRef；来源数组保留顺序和值，不拼接 groupId。每项必填非空 nodeRef、provenanceRef；可选 candidateStatus 为 ok/filtered_out/skipped/unknown，缺省不等于通过 L1。teacher 字段为 `classList?: string[]`、`id?: string`、`tag?: string`、`role?: string`、`attributes?: Record<string, string | number | boolean | null>`；可选 studentObservation。index 按输入数组位置从0编号，保序且允许重复 nodeRef；原始 DOM 全局序号不成为学生特征。 |
| **输出** | 端口 `matched_records`（`schemaId: "sample/matched-records/v1"`, 事件类型 `"sample.matched-records.v1"`）。<br>payload 为 `{ snapshotRef, sourceGroup, ruleId, slots, matchedRefs }`。<br>`slots` 与输入严格保序等长，逐项全新构造，严禁浅拷贝透传 raw 记录。每项保留 `index`、`nodeRef`、`inputRef: { snapshotRef, nodeRef, index }`、`provenanceRef`、`sourceGroup`、可选 `candidateStatus`、投影后 `studentObservation`、`matchStatus`（`matched/unmatched/unknown/conflict`）、`semanticLabel: string | null`（仅当唯一确定命中单一语义分类时非空）、`matchedRuleIds: string[]`（基于 `ruleId`、`semanticLabel` 与条件位置派生的稳定规则 ID 集合）、`reasons: string[]`。<br>彻底无训练极性：Filter 仅输出语义分类与匹配状态，绝不输出正负极性（positive/negative），不包含置信度/概率值。<br>`matchedRefs` 是 `{ index, nodeRef }[]` 紧凑数组，包含所有状态为 `matchStatus === "matched"` 的槽位，严格保持原序且允许重复 `nodeRef`。<br>安全边界：彻底隔离 raw 与 teacher，下游槽位绝不含 raw classList、id、attributes、文本内容、URL 或捕获元数据。安全诊断：reason codes 仅使用受限语义枚举（`semantic_match`、`semantic_conflict`、`unresolved_competing_class`、`missing_teacher_field`、`no_rule_match`），缺测时仅报告字段名，不带出原始属性值或自由文本。 |
| **配置与状态** | 必填配置：`ruleId`（非空字符串）、`rules`（非空数组，每项包含 `semanticLabel` 与 `match` 条件数组，支持可选的单规则 `ruleId`）。禁止空规则数组、空条件对象或空谓词 map；严禁 `positiveMatch`、`negativeMatch` 或任何训练极性字段。<br>条件支持 `tag`、`role`、`classIncludes`（数组，AND 关系）、`classExcludes`（数组）、`idEquals`、`attributes`（键值对，AND 关系）。仅支持精确全等匹配与精确 class token 包含，不包含子串、正则、类型强制转换或脚本执行。<br>**三值逻辑求值与语义分类真值表（true / false / unknown）**：<br>1. 条件内 AND：任一 false 则整体为 false；否则任一引用缺失 teacher 字段则为 unknown；全部为 true 则整体为 true（false AND missing = false）；<br>2. 类别内 OR：同一 `semanticLabel` 的多条条件（或多条规则）取 OR。任一条件为 true 则该类为 true，收集其命中规则 ID；否则任一为 unknown 则该类为 unknown；全部为 false 则该类为 false（true OR missing = true）。同类别重复命中不产生 conflict；<br>3. 跨类别槽位仲裁：<br>&nbsp;&nbsp;- 恰好 1 个类别为 true 且 0 个类别为 unknown：`matchStatus: "matched"`，`semanticLabel` 为该类别名，`reasons: ["semantic_match"]`；<br>&nbsp;&nbsp;- 恰好 1 个类别为 true 且 >= 1 个竞争类别为 unknown：因缺失字段无法排除竞争类别，判定为 `matchStatus: "unknown"`，`semanticLabel: null`，`reasons: ["unresolved_competing_class", "missing_teacher_field"]`；<br>&nbsp;&nbsp;- >= 2 个不同类别为 true：判定为 `matchStatus: "conflict"`，`semanticLabel: null`，`reasons: ["semantic_conflict"]`；<br>&nbsp;&nbsp;- 0 个类别为 true 且 >= 1 个类别为 unknown：判定为 `matchStatus: "unknown"`，`semanticLabel: null`，`reasons: ["missing_teacher_field"]`；<br>&nbsp;&nbsp;- 0 个类别为 true 且 0 个类别为 unknown：判定为 `matchStatus: "unmatched"`，`semanticLabel: null`，`reasons: ["no_rule_match"]`。<br>未命中、未知或缺失绝不自动变成负例。 |
| **副作用** | 无（`effects: []`），纯内存确定性转换。 |
| **训练能力** | 手写规则节点，无可训练参数。`classIncludes`/`idEquals` 等站点规则仅限本节点作为 teacher 提议或筛选依据，严禁流入下游学生特征向量。 |
| **兼容条件** | 输入必须保持确定数组顺序与槽位映射，允许重复 `nodeRef`；更换分类规则时只需在 `WorkflowConfig` 中切换局部配置，无需修改算子实现。纯函数 `evaluateSemanticRules` 独立可用，无 `lib/training` 依赖。 |
| **验收** | 独立用例验证语义规则三值真值表（包含 false AND missing、true OR missing、同类复投无冲突、已知命中与竞争类别未知判定 unknown、多类命中 conflict）；验证 dense `matchedRefs` 与 `slots` 顺序和重复项映射一致性；验证 raw 字段不向下游泄露；验证绝无训练正负极性输出与置信度字段。 |

### 1.2 `sample.assemble`（组装单任务训练样本）

每行还保留上游受限语义 `reasons` 数组。它与 `matchStatus`、`semanticLabel`、`matchedRuleIds` 一起描述分类依据，不随训练任务映射改变。

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "sample.assemble"`, `operator_version: "0.1.0"`。单任务训练样本组装节点。<br>公开导出：`sampleAssembleNode`（通过 `nnanything/browser`）。<br>唯一 owner：`lib/training/samples.ts`（样本 schema 与白名单清洗）+ `lib/nodes/sampling.ts`（节点定义）。 |
| **输入** | 端口 `matched_records`（`schemaId: "sample/matched-records/v1"`, 事件类型 `"sample.matched-records.v1"`），接收 `sample.match` 输出的 slots 数组及元数据。 |
| **输出** | 端口 `task_samples`（`schemaId: "sample/task-dataset/v1"`, 事件类型 `"sample.task-dataset.v1"`）。<br>payload 为 `{ taskId: string, ruleId: string, items: TaskSampleRow[] }`；`items` 严格保持槽位长度与顺序，允许包含重复 `nodeRef`。<br>每项为完整行记录，同时保留上游语义分类与下游任务监督字段：`taskId`、`ruleId`、`inputRef`、`provenanceRef`、`sourceGroup`、`matchStatus`、`semanticLabel: string | null`、`matchedRuleIds: string[]`、`expectedLabel: string | null`、`labelState: "positive" | "negative" | "unlabeled" | "conflict" | "excluded"`、固定 `labelProvenance: "rule_proposed"`、`excludeReasons: string[]` 及可选 `studentObservation`。<br>**学生观测白名单投影**：全新独立对象，严格限定仅包含 `tag?: string | null`、`role?: string | null`、`parentRef?: string | null`、`rect?: { x, y, width, height } | null`、`clippedRect?: { x, y, width, height } | null`、`fragments?: { x, y, width, height }[] | null`；`x` 与 `y` 可为负视口 CSS 坐标（如元素上浮或部分偏出视口），`width` 与 `height` 必须为有限非负数值。多层嵌套对象（包括 rect 与 fragment 内部）均递归过滤多余属性。禁止 raw class、id、账号、正文、URL、绝对路径、全局深度或数值特征进入。 |
| **配置与状态** | 必填 `taskId`、`supervisionMap: Record<string, "positive" | "negative">`、`expectedLabels: { positive: string, negative: string }`。任务及期望标签非空，两个期望标签不同；映射允许为空，不要求包含正例。可选 `unmappedPolicy: "unlabeled" | "excluded"`，默认 unlabeled。配置不能改写 labelProvenance。<br>候选状态优先：filtered_out/skipped → excluded，记录 candidate_filtered_out/candidate_skipped；unknown → unlabeled。其他情况按上游结果：conflict → conflict；unknown/unmatched → unlabeled；matched 时由 supervisionMap 决定 positive/negative 及对应 expectedLabels。未映射语义按 unmappedPolicy 处理，绝不默认负例。所有非正负状态的 expectedLabel 为 null，未映射排除原因为 unmapped_semantic_label。<br>候选状态缺省不宣称运行或通过 L1 限制。重新映射只改变训练监督与排除结果，保留上游语义、状态、规则及 reasons；rule_proposed 不等同黄金真值。 |
| **副作用** | 无（`effects: []`）。 |
| **训练能力** | 手写数据组装节点，无可训练参数；仅负责按任务需求映射语义与输出规范样本，本节点不实现训练算法或权重调整。 |
| **兼容条件** | 每次运行严格绑定单一 `taskId` 与明确的 `supervisionMap`/`expectedLabels`，单任务单监督映射；不同任务通过不同配置复用同一上游 `MatchedRecords`，不把多任务混成多头隐式状态。 |
| **验收** | 验证输出样本彻底剥离 teacher 原始字段；正负例、unlabeled、excluded 及 null 标签映射符合优先级；被排除项不因规则命中而复活；未映射语义标签默认 unlabeled（或按配置 excluded），绝不自动变 negative；重复 `nodeRef` 完整保序；学生观测白名单投影剔除多余字段，支持合法负坐标 (x, y)。 |

### 1.3 `sample.save`（保存样本到本地目录）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "sample.save"`, `operator_version: "0.1.0"`。本地样本持久化节点。<br>公开导出：`createSampleSaveNode({ allowedRoot: string })`（工厂函数，通过 `nnanything/browser` 导出）。<br>唯一 owner：`lib/nodes/sampling.ts`。 |
| **输入** | 端口 `task_samples`（`schemaId: "sample/task-dataset/v1"`, 事件类型 `"sample.task-dataset.v1"`）。 |
| **输出** | 端口 `save_receipt`（`schemaId: "sample/save-receipt/v1"`, 事件类型 `"sample.save-receipt.v1"`）。<br>成功时 payload 返回 `{ savedPath, taskId, ruleId, totalSlots, counts: { positive, negative, unlabeled, conflict, excluded } }`。保留 positive/negative 等 5 态计数是合法的，因为持久化的是属于具体任务的训练样本行，不代表核心通用扩展。 |
| **配置与状态** | 持久配置仅接收 `fileName: string`（必须为相对路径）与 `writeMode: "create_new"`。固定格式为 JSONL。<br>工厂参数 `allowedRoot` 必须为已存在的规范绝对路径目录，调用者在外部预先创建好目录；节点不递归创建父目录。<br>安全检查：严格禁止绝对路径、URI 式路径、NUL 字符与 `..` 越界逃逸；使用路径组件检查禁止前缀同级目录（如 `samples-other`）；检查路径下已有目录组件，拒绝父路径符号链接与最终文件符号链接。<br>独占排他创建：使用底层 `wx` 标志打开文件，目标文件已存在或为终点符号链接时立即失败，不覆盖、不追加、不自动重试。<br>并发控制边界：调用者必须控制 `allowedRoot` 根目录不被并发进程替换或篡改，节点不宣称抗并发父目录置换。<br>I/O 故障显式暴露：遇到不确定 I/O 错误时直接返回 failed，不伪造成功回执；故障时磁盘上可能残留部分写入文件，不构建隐式回滚或重试框架。<br>统计与核验：`totalSlots === items.length`，`counts` 的 5 项数值之和必须严格等于 `totalSlots`。零项时写入空文件。 |
| **副作用** | 声明 `effects: ["filesystem.write"]`。<br>编译时必须由调用者在 `grantedEffects` 中显式授权，未授权时 `compileWorkflow` 直接拒绝（实际执行写入次数为 0）。 |
| **训练能力** | 手写 I/O 节点，无可训练参数。 |
| **兼容条件** | 事件级非 ok 输入（如 upstream skipped 或 unknown）遵循 runner 默认行为标记为 `skipped(upstream_not_ok)`，不执行文件写入。行级 unlabeled 记录属于正常 ok 数据集，正常落盘保存。 |
| **验收** | 验证未授权 `filesystem.write` 时编译失败且无写动作；验证路径穿越、符号链接、绝对路径被拦截；验证已有文件时 `wx` 独占创建拒绝；验证真实 JSONL 写入后行数与回执各状态计数完全吻合。 |

---

## 2. 第一层 DOM 基础种类节点合同卡（0.1.0）

本节是第一层 DOM 基础种类算子 dom.basic_kinds@0.1.0 合同卡的唯一规范真源。
合格输入的基础语义标签为 12 个具体类别或 other，单项只有一个主标签。`structure/ignore` 是与其他细类同一两阶段电路的评分叶子，不是 tag 硬过滤、独立类别头或预处理删除。unknown/conflict 描述评分状态；被排除或不可用的候选不作分类，标签为 null。SVG、hidden、presentation/none 等属性都进入统一评分路径，不提前否决。默认没有经验证的辨别权重的状态 wire 显式赋 0，可通过 profile 调整。
算法完整设计与数值连线由 [docs/basic-kinds-wiring.md](../../docs/basic-kinds-wiring.md) 单一 owner 维护，本卡仅保留节点接口契约，不重复算法实现细节。
`nnanything/browser`保留`domBasicKindsNode`、`classifyBasicKind`、`classifyBasicKindBatch`、`validateBasicKindProfile`、默认profile/config与类别集合等公开API。`nnanything/browser`和`nnanything/browser-classify`另导出`LEGACY_BASIC_KIND_PROFILE`与`migrateBasicKindProfile`；`nnanything/training`也导出这两个训练接点。通用`nnanything`入口不导出DOM profile或迁移函数。旧权重资产在解析时补缺失的新目标与wire 0，新默认使用id `dom-basic-kinds-handwritten-v2`。
类型 SpecificBasicKindLabel 代表具体类别，BasicKindLabel 另含残余 other。unknown 与 conflict 保持判断状态，不能被改写为 judged other。other 预测保留具体类别区间和原因，不虚构置信度，也不自动成为监督真值。后续新增类别沿算法设计文档更新 taxonomy/wire/profile，并复核历史 other；不需要改通用 workflow 核心。

### 2.1 `dom.basic_kinds`（判断 DOM 基础种类）

| 合同维度 | 规范内容 |
| :--- | :--- |
| 身份 | `operator: "dom.basic_kinds"`, `operator_version: "0.1.0"`。第一层 DOM 基础种类判断节点。<br>公开导出：`domBasicKindsNode`（通过 `nnanything/browser`）。内核纯函数 `classifyBasicKind`（单节点）与 `classifyBasicKindBatch`（批次）独立可用。<br>唯一 owner：`lib/filters/basic-kinds.ts`（求值内核）+ `lib/nodes/basic-kinds.ts`（节点定义）。<br>算法设计真源：[docs/basic-kinds-wiring.md](../../docs/basic-kinds-wiring.md)。 |
| 输入 | 端口 `input`（工作流图中连线 ID 对应 `candidate_slots`），`schemaId: "dom/candidate-batch/v1"`，事件类型 `"dom.candidate-slots.v1"`。<br>接收现有 `CandidateBatch` 对象，支持在同一个根对象包含可选的 `itemObservations` 补充观测数组。<br>补充项允许 `nodeRef` 与 `BasicKindMeasurements` 的已声明字段。除既有文本、CSS、子计数、列表与 SVG 测量外，新增十项 nullable 测量：`pointerCursor`、`parentPointerCursor`、`tabIndexFocus`、`borderPresent`、`aspectRatio`、`descendantTextPresent`、`singleChildTag`、`singleChildSameRect`、`withinControlAncestor`、`inSvgAncestor`。`aspectRatio` 须在 [0,1]；wire 可为 [0,1] 连续值。禁止任意未知字段。省略或 null 表示未测；false 表示已观测不存在。<br>约束：补充项必须引用已有候选节点且 nodeRef 唯一；补充观测绝不能覆盖原始 tag、role 或候选资格。raw class/id 只作 teacher 或来源证据，不作学生输入。 |
| 输出 | 端口 `output`（工作流图中连线 ID 对应 `basic_kind_slots`），`schemaId: "dom/basic-kind-batch/v1"`，事件类型 `"dom.basic-kind-slots.v1"`。<br>payload 为 `{ taskId: string, profileId: string, slots: BasicKindSlot[] }`。<br>slots 保持输入顺序与长度。每项保留 `index`、`nodeRef`、`candidateStatus`、`candidateReasons`，以及来自核心算法的判断与证据字段：`familyStatus`、`family`、`familyScores`、`judgmentStatus`、`basicKind`、`leafScores`、`score`、`margin`、`confidenceState: "uncalibrated" \| "not_applicable"`、`calibratedConfidence: null`、`reasons`、`evidence: { stateFlags, wires, activeTerms, path }`。<br>无极性与无假置信度：节点不输出训练正负极性，不提供经过独立标定的概率或置信度。 |
| 配置与状态 | 必填配置：`taskId: string`、`minScore: number`、`minMargin: number`。默认门限分别为 0.60 与 0.15（`DEFAULT_BASIC_KIND_CONFIG`）。<br>可选 profileId 绑定：通过 `compileWorkflow` 的 profiles 映射传入完整的稀疏数值 profile（`BasicKindProfile`，含 familyWeights 与 leafWeights）；若未配置 profileId，默认使用手写稀疏权重表（`DEFAULT_BASIC_KIND_PROFILE`）。<br>执行模式：执行真正的两阶段粗细计算（大类 family -> 细类 leaf）；大类未通过时没有 leafScores，通过后 leafScores 仅包含该大类的细类。缺测特征保留为区间，不把缺测填 0。 |
| 副作用 | 无（`effects: []`），纯内存确定性转换。 |
| 训练能力 | 数值参数通过显式 profile 配置。离线训练框架已通过六节点与真实 Handwired Circuit 提供拟合路径，产出可被本节点加载的候选 profile；迁移补 0 的地址仍进入数值图，可被训练更新，但补 0 不等于已测量或已训练。当前默认 profile 仍是旧系数加显式 0，尚无已激活的 ignore 训练新权重。未校准（uncalibrated），候选 profile 不自动采用。 |
| 兼容条件 | 上游非 ok 事件按 Runner 默认规则判定为 skipped（`upstream_not_ok`），不产生副作用。<br>输入候选状态为 filtered_out 或 skipped 时映射为 excluded，unknown 保持 unknown，不因补充观测复活。<br>纯函数可做单属性诊断，但纯诊断调用不属于工作流合格分类。不包含第二层业务卡片语义（帖子、作者、评论、广告等），不执行活体网页采集。 |
| 验收 | 验证两阶段（大类 -> 细类）执行路径；验证属性缺测区间计算与保守弃判；验证 tag 与 role 冲突输出 conflict；验证稀疏 profile 独立覆写；验证非法特征字段抛错拦截；验证上游候选排除状态保持 excluded 且不复活。公开 demo 入口 `npm run demo:basic-kinds` 使用 1 节点图与完整合成候选数据离线运行验证。 |

---

## 3. 基础种类离线训练流 6 节点合同卡（0.1.0）

本节是第一层基础种类离线训练流六算子（`training.*@0.1.0`）合同卡的规范真源。
六节点通过工厂函数 `createTrainingNodeDefinitions({ handwiredRoot, allowedRoot, onFitProgress })` 创建，通过 `nnanything/training` 公开导出。
详细多分类数据合同、分区算法、Handwired 损失与反传连线及结果结构由 [docs/training-workflow.md](../../docs/training-workflow.md) 唯一维护，本卡规范节点 I/O、配置与副作用边界。

### 3.1 `training.prepare`（准备节点输入与期望输出）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "training.prepare"`, `operator_version: "0.1.0"`。多分类复核样本准备与白名单投影算子。<br>唯一 owner：`lib/nodes/training.ts` + `lib/training/basic-kind-samples.ts`。详细数据结构见 [docs/training-workflow.md#4-复核多分类样本与来源分区](../../docs/training-workflow.md)。 |
| **输入** | 端口 `training_request`，schemaId `training/basic-kinds/request/v1`，事件 `training.request.v1`。payload 为 `BasicKindTrainingRequest`（包含 `taskId` 与 `rows: ReviewedBasicKindRow[]`）。 |
| **输出** | 端口 `samples`，schemaId `training/basic-kinds/samples/v1`，事件 `training.samples.v1`。payload 为 `BasicKindSamples`（包含 `taskId`、`inputScope`、保序 `rows`、纳入索引 `includedIndices` 及逐行 reasons）。 |
| **配置与状态** | 必填配置：`taskId: string`（必须为 `"dom.basic-kinds.v1"`）、`inputScope: "candidate_qualified" \| "properties_offline"`。<br>范围过滤：`candidate_qualified` 要求原候选资格为 ok；`properties_offline` 接收离线单节点合法属性与缺测。两种范围均要求 review.status 为 `verified` 且有明确 expectedLabel。 |
| **副作用** | 无（`effects: []`），纯内存转换。 |
| **验收** | 验证 teacher/raw 字段绝不进入学生属性；未复核/排除项正确记录原因且不计入 includedIndices；保序输出。 |

### 3.2 `training.partition`（按来源分组并划分用途）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "training.partition"`, `operator_version: "0.1.0"`。来源闭包分区算子。<br>唯一 owner：`lib/nodes/training.ts` + `lib/training/basic-kind-training.ts`。详细算法见 [docs/training-workflow.md#4-复核多分类样本与来源分区](../../docs/training-workflow.md)。 |
| **输入** | 端口 `samples`（`training/basic-kinds/samples/v1`）。声明 `acceptNonOkInputs: true`，上游非 ok 时透传不足原因。 |
| **输出** | 端口 `partitions`，schemaId `training/basic-kinds/partitions/v1`，事件 `training.partitions.v1`。payload 为 `BasicKindPartitions`（包含 `sourceClusters`、`trainIndices`、`evalIndices`、`evaluationMode`、`independentEvaluation`、`warnings`）。 |
| **配置与状态** | 必填配置：`mode: "source_group_holdout" \| "development_only"`、`seed: number`（uint32）、`evalFraction: number`、`allowInSampleEval: boolean`。<br>分组规则：按 snapshot/post/asset 关联传递闭包形成来源簇；不随机打散同一组 DOM 行；seed 洗牌。`source_group_holdout` 要求至少 2 个独立来源组且两侧非空，不满足时返回证据不足（status: unknown）。 |
| **副作用** | 无（`effects: []`）。 |
| **验收** | 验证跨页面/跨 frame 共享素材归同组；验证单来源组无法伪造独立验证；验证洗牌结果确定且无 hash 包装。 |

### 3.3 `training.fit`（拟合目标节点参数）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "training.fit"`, `operator_version: "0.1.0"`。Handwired 数值电路拟合算子。<br>唯一 owner：`lib/nodes/training.ts` + `lib/training/basic-kind-numeric.ts`。详细反传与损失连线见 [docs/training-workflow.md#7-trainingfit-内部的手写数值连线](../../docs/training-workflow.md)。 |
| **输入** | 端口 `partitions`（`training/basic-kinds/partitions/v1`）。声明 `acceptNonOkInputs: true`。必须显式绑定基础 `BasicKindProfile`。 |
| **输出** | 端口 `candidate`，schemaId `training/basic-kinds/candidate/v1`，事件 `training.candidate.v1`。payload 为 `BasicKindCandidate`（包含 `candidateId`、`baseProfileId`、拟合后的 `profile`、`trajectory`、`lossBefore`、`lossAfter`、`sampleCoverage`）。 |
| **配置与状态** | 必填配置：`taskId`、固定推理门限 `minScore` / `minMargin`、优化目标 `objective`（targetScore, rivalCeiling, otherGap）与拟合超参 `fit`（epochs, learningRate, anchorLambda）。<br>执行模式：通过 `loadHandwired(handwiredRoot)` 动态加载 Handwired TS 源码，构建电路并执行 Circuit.evaluateReference → 损失导数 → Circuit.backpropagateReference → Adam 优化器更新 → 权重区间截断投影 [-1, 1]。 |
| **副作用** | 声明 `effects: ["filesystem.read"]`（读取 Handwired 本地源码根目录）。 |
| **验收** | 验证真实梯度来自 Handwired 而非固定系数假拟合；验证学习率/轮数有限循环收敛；验证缺失 handwiredRoot 时报错拒绝；验证候选 profile 不改写基础 profile。 |

### 3.4 `training.compare`（比较新旧节点在相同样本的输出）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "training.compare"`, `operator_version: "0.1.0"`。旧新候选逐例双轨比对算子。<br>唯一 owner：`lib/nodes/training.ts` + `lib/training/basic-kind-training.ts`。详细指标规范见 [docs/training-workflow.md#6-运行进度比较与保存](../../docs/training-workflow.md)。 |
| **输入** | 端口 0: `candidate`（`training/basic-kinds/candidate/v1`），端口 1: `partitions`（`training/basic-kinds/partitions/v1`）。声明 `acceptNonOkInputs: true`。绑定与 fit 相同的基础 `BasicKindProfile`。 |
| **输出** | 端口 `comparison`，schemaId `training/basic-kinds/comparison/v1`，事件 `training.comparison.v1`。payload 为 `BasicKindComparison`（包含 candidate、splits [train, eval]、旧新逐例判断明细及混淆/类别指标）。 |
| **配置与状态** | 必填配置：与 fit 相同的 `BasicKindTrainingConfig`。在相同样本上分别调用正式前向分类器求值，逐例输出 `fixed`、`regressed`、`retained`、`unresolved`、`unassessed`。 |
| **副作用** | 无（`effects: []`）。 |
| **验收** | 验证同一输入下双轨运行正式分类器；验证逐例迁移统计之和等于样本总数；验证分母为零时指标为 null 而非伪造 100%。 |

### 3.5 `training.assess`（评估修复退化与证据不足）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "training.assess"`, `operator_version: "0.1.0"`。证据边界与采用建议评估算子。<br>唯一 owner：`lib/nodes/training.ts` + `lib/training/basic-kind-training.ts`。详细规则见 [docs/training-workflow.md#6-运行进度比较与保存](../../docs/training-workflow.md)。 |
| **输入** | 端口 `comparison`（`training/basic-kinds/comparison/v1`）。声明 `acceptNonOkInputs: true`。 |
| **输出** | 端口 `assessment`，schemaId `training/basic-kinds/assessment/v1`，事件 `training.assessment.v1`。payload 为 `BasicKindAssessment`（包含 comparison、recommendation、evidenceStatus、summary）。 |
| **配置与状态** | 必填配置：`forbidGoldRegression: boolean`。核验是否有修复、黄金样本是否有退化、验证集是否独立充分。若退化或样本不足，输出收束为证据不足。 |
| **副作用** | 无（`effects: []`）。 |
| **验收** | 验证存在黄金退化时拒绝推荐；验证非 ok 上游收束为 evidence_insufficient 并保留原因。 |

### 3.6 `training.report`（保存候选参数与训练报告）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "training.report"`, `operator_version: "0.1.0"`。权重与报告本地持久化算子。<br>唯一 owner：`lib/nodes/training.ts` + `lib/training/basic-kind-training.ts`。写入安全见 [docs/training-workflow.md#6-运行进度比较与保存](../../docs/training-workflow.md)。 |
| **输入** | 端口 `assessment`（`training/basic-kinds/assessment/v1`）。声明 `acceptNonOkInputs: true`。 |
| **输出** | 端口 `training_result`，schemaId `training/basic-kinds/result/v1`，事件 `training.result.v1`。payload 为 `BasicKindTrainingReceipt`（包含 `persistStatus: "saved" \| "evidence_insufficient" \| "failed"`、`weightFileRef`、`resultFileRef`、`candidateAdoption: "not_applied"`、`calibrated: false`、`summary`）。 |
| **配置与状态** | 必填配置：`weightsDirectory: string`、`resultsDirectory: string`。工厂绑定规范根 `allowedRoot`。<br>写入规则：使用 `wx` 排他创建；先写权重资产 `*.weight.json`，再写报告资产 `*.result.json`。上游非 ok 时仅写证据不足报告，不写虚构权重。候选 profile 标记为 `not_applied`，绝不自动采用。 |
| **副作用** | 声明 `effects: ["filesystem.write"]`（独占写入 allowedRoot 下的权重与报告目录）。 |
| **验收** | 验证未授权 write 时拒绝执行；验证路径穿越被拦截；验证已有同名文件拒绝覆盖；验证非 ok 输入零权重写入。 |

---

## 4. 已实现节点清单索引

所有已实现的算子（7 个 DOM 候选、3 个采样、1 个基础种类、6 个离线训练与 3 个通用）源码位于 `lib/nodes/`：

### 4.1 浏览器 DOM 候选、采样与基础种类节点 (`lib/nodes/dom.ts`, `lib/nodes/sampling.ts`, `lib/nodes/basic-kinds.ts`)
1. `dom.observe` (`0.1.0`): 适配保存的页面观测，保留白名单几何/结构，剥离原始 class/id/文本；
2. `dom.viewport` (`0.1.0`): 正面积相交计算视口槽位，父容器离屏不误剪可见后代；
3. `dom.focus` (`0.1.0`): 按 within/region 收缩关注范围，无归属依据拒绝 owned；
4. `dom.deny` (`0.1.0`): 评估黑名单，deny 优先于 allow，记录排除原因且不生成训练负标签；
5. `dom.allow` (`0.1.0`): 评估白名单，未配置不限制，显式空集合拒绝全部；
6. `dom.split` (`0.1.0`): 展开 DOM 层级候选，显式 nodeRefs 保持保长保序；
7. `dom.candidates` (`0.1.0`): 复检展开项规则，输出保序槽位与排除映射，不调用神经网络；
8. `sample.match` (`0.1.0`): 纯三值逻辑语义规则匹配，输出单语义分类与状态，彻底隔离 teacher 与学生特征，无训练极性概念；
9. `sample.assemble` (`0.1.0`): 单任务训练样本组装，按任务映射语义到正负监督并保留原始语义分类，候选资格优先级与学生观测白名单投影；
10. `sample.save` (`0.1.0`): 独占排他（wx）持久化 JSONL，受限根目录与防越界安全检查；
11. `dom.basic_kinds` (`0.1.0`): 接收候选槽位与可选补充观测，执行两阶段（大类 -> 细类）确定性基础种类判断，输出保序槽位、分数区间、决策路径与审计证据（`lib/nodes/basic-kinds.ts`）。

### 4.2 基础种类离线训练六节点 (`lib/nodes/training.ts`)
12. `training.prepare` (`0.1.0`): 多分类复核样本准备与学生属性投影，区分 candidate_qualified 与 properties_offline；
13. `training.partition` (`0.1.0`): 来源关联闭包分组与 train/eval 用途分区，支持 source_group_holdout；
14. `training.fit` (`0.1.0`): 接入 Handwired Circuit evaluate/backprop 真实梯度与 Adam 优化器拟合稀疏权重参数，输出候选 profile；
15. `training.compare` (`0.1.0`): 相同样本双轨调用正式前向分类器，逐例输出 fixed/regressed/retained/unresolved/unassessed；
16. `training.assess` (`0.1.0`): 评估指标改善、黄金退化与证据边界，收束证据不足；
17. `training.report` (`0.1.0`): 独占安全写入候选权重 profile 与训练评估报告，候选不自动采用。

### 4.3 通用基础节点 (`lib/nodes/common.ts`)
18. `common.scale` (`1`): 数值缩放转换；
19. `common.sum` (`1`): 数值求和；
20. `common.count` (`1`): 数组元素计数。

### 4.4 实时网页标注与采集节点（`lib/nodes/browser-overlay.ts`，0.1.0）

公开入口 `nnanything/browser-classify` 供浏览器 consumer 使用，排除 Node 磁盘 loader、训练 writer 与 Handwired 后端。通过显式资源创建节点定义，再编译项目图；不在 UI 手写第二条执行链。

| 算子 | 输入 → 输出 | 显式配置/资源 | effects |
| --- | --- | --- | --- |
| `browser.observe_live` | snapshot/document 引用 → 顶层实时 DOM 观测 | Document、Window、稳定引用表、排除宿主 | `browser.dom.read` |
| `browser.qualify_live` | 观测 → 保序候选帧 | FocusSpec（viewport、子树、黑白名单） | 无 |
| `browser.classify_live` | 候选帧 → 基础类别与评分证据 | BasicKindConfig、兼容 profile | 无 |
| `overlay.present` | 分类帧 → 色框、统计、Focus 与呈现回执 | 注入 present 回调 | `browser.overlay.present` |
| `browser.capture` | 当前帧与人工决定/未知收集/导出动作 → 采集回执 | 显式 BrowserCaptureSession 与 download 回调 | `browser.capture.download`（仅 export 调用下载） |

对应 `workflows/browser-visual-overlay.graph.json`（4N3E）和 `workflows/browser-capture.graph.json`（1N0E），本增量拓扑不变。节点不训练；采集只收合格候选。`collect_unresolved` 收集 qualified unknown 与 conflict，legacy `collect_unknown` 保持 unknown-only。未复核、待定和仅标错样本保留空黄金字段；用户明确确认具体类别后才可被现有 training.prepare 接纳。`other` 需理由。数组导出重排 index，证据与学生属性分开，class/id/正文不进入学生。ignore 默认不画框但可在图例查看，节点、子节点和关系仍保留。失效 Focus 返回不可采集状态，不扩大范围。iframe/shadow 内部保持未评估，不标 other。

公开 workflow consumer、2501 条导出及复核隔离测试：`tests/browser-overlay-foundation.test.mjs`。真实浏览器入口、安装及覆盖限制见 `extension/README.md` 和 `docs/browser-overlay-m1.md`。
## 探索输入扩展

实时观测节点资源可提供 `excludeRoots` 及 `excludeRootIds`；默认排除已知工具注释根，自己的 overlay 宿主继续由 `excludeHost` 提供。观测后在 adapter 边界调用共享纯呈现整形；`browser.qualify_live` 承载候选预处理，分类节点不重复整形。五项 nullable 呈现参数与十项关系/几何测量穿过采集、读取和 prepare；新增 wire 以显式 0 接入既有训练地址。完整算法与迁移由 `docs/basic-kinds-wiring.md` 维护，训练 I/O 由 `docs/training-workflow.md` 维护。

既有实时观测与采集节点随样本携带可选 `ExplorationInputV1`，无需新增 operator 或修改 DAG。adapter 内纯 builder 保留所有包装及内容节点、直接和跨层包含边、局部组成与缺测边界；实时资源可配置 `maxRelationHops`，默认 4，采集包记录实际值。没有自动忽略、预测类别输入或权重修改。导出与 prepare 保留新字段；第一层 fit 只消费 `properties` 与 `expectedLabel`，关系输入要另行训练并验证后才能宣称有效。完整合同见 `docs/training-workflow.md` 的探索输入节。
