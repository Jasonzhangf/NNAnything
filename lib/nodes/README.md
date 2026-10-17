# 节点定义与合同清单 (lib/nodes/)

本目录为 NNAnything 节点定义（`NodeDefinition`）的唯一源码根目录。
遵循 [可复用经验节点合同](../../docs/node-contract.md)，本文件是三个基础采样节点卡（身份、输入、输出、配置与状态、副作用、训练能力、兼容条件、验收）的唯一真源，并索引已实现的 L1 节点。
其他文档与实施计划均通过链接引用本文件，不复制节点卡。

---

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

## 2. L1 与采样已实现节点索引

所有已实现的确定性节点（7 个 DOM 候选算子、3 个采样算子与 3 个通用算子）源码位于 `lib/nodes/`：

### 2.1 浏览器 DOM 候选与采样节点 (`lib/nodes/dom.ts`, `lib/nodes/sampling.ts`)
1. `dom.observe` (`0.1.0`): 适配保存的页面观测，保留白名单几何/结构，剥离原始 class/id/文本；
2. `dom.viewport` (`0.1.0`): 正面积相交计算视口槽位，父容器离屏不误剪可见后代；
3. `dom.focus` (`0.1.0`): 按 within/region 收缩关注范围，无归属依据拒绝 owned；
4. `dom.deny` (`0.1.0`): 评估黑名单，deny 优先于 allow，记录排除原因且不生成训练负标签；
5. `dom.allow` (`0.1.0`): 评估白名单，未配置不限制，显式空集合拒绝全部；
6. `dom.split` (`0.1.0`): 展开 DOM 层级候选，显式 nodeRefs 保持保长保序；
7. `dom.candidates` (`0.1.0`): 复检展开项规则，输出保序槽位与排除映射，不调用神经网络。
8. `sample.match` (`0.1.0`): 纯三值逻辑语义规则匹配，输出单语义分类与状态，彻底隔离 teacher 与学生特征，无训练极性概念；
9. `sample.assemble` (`0.1.0`): 单任务训练样本组装，按任务映射语义到正负监督并保留原始语义分类，候选资格优先级与学生观测白名单投影；
10. `sample.save` (`0.1.0`): 独占排他（wx）持久化 JSONL，受限根目录与防越界安全检查。

### 2.2 通用基础节点 (`lib/nodes/common.ts`)
1. `common.scale` (`1`): 数值缩放转换；
2. `common.sum` (`1`): 数值求和；
3. `common.count` (`1`): 数组元素计数。
