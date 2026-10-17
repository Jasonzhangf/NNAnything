# 节点定义与合同清单 (lib/nodes/)

本目录为 NNAnything 节点定义（`NodeDefinition`）的唯一源码根目录。
遵循 [可复用经验节点合同](../../docs/node-contract.md)，本文件是三个基础采样节点卡（身份、输入、输出、配置与状态、副作用、训练能力、兼容条件、验收）的唯一真源，并索引已实现的 L1 节点。
其他文档与实施计划均通过链接引用本文件，不复制节点卡。

---

## 1. 基础规则采样流 3 节点合同卡（0.1.0-design 待实现）

> [!IMPORTANT]
> 以下 3 个采样算子目前均为设计态（`0.1.0-design`），未实现运行时代码。
> 运行时调用 `compileWorkflow` 会因缺失算子实现而明确拒绝。文档只可称“设计/待实现”，不可虚构已可运行。

### 1.1 `sample.match`（按显式规则匹配 DOM 记录）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "sample.match"`, `operator_version: "0.1.0-design"`。手写确定性规则匹配节点。<br>唯一 owner：`lib/filters/`（规则求值内核）+ `lib/nodes/`（节点定义与事件封装）。 |
| **输入** | 端口 `raw_records`（`schemaId: "sample/raw-dom-records/v1"`, 事件类型 `"sample.raw-records.v1"`）。payload 为 `{ snapshotRef, sourceGroup, records }`。`sourceGroup` 保留已知 snapshot/post/adAsset 来源关联引用，不把引用拼接成独立分组结论。每项包含 `nodeRef`、原始证据 `provenanceRef`、可选 `candidateStatus`、teacher 字段（`classList`、`id`、`tag`、`role`、`attributes`）与可选 `studentObservation`。`index` 按本次输入数组位置从 0 编号；同一 `nodeRef` 可重复，原始 DOM 的全局序号不作为数组位置或学生特征。 |
| **输出** | 端口 `matched_records`（`schemaId: "sample/matched-records/v1"`, 事件类型 `"sample.matched-records.v1"`）。payload 为 `{ snapshotRef, sourceGroup, ruleId, slots, matchedRefs }`；`slots` 与输入等长同序。每项保留 `index`、`nodeRef`、`inputRef: { snapshotRef, nodeRef, index }`、`provenanceRef`、来源关联、可选 `candidateStatus/studentObservation`、`matchStatus: matched/unmatched/unknown/conflict`、`matchedRuleIds`、`reasons`。`matched` 必须带 `matchPolarity: positive/negative`；其他状态为 null。`matchedRefs` 是 `{ index, nodeRef }[]` 的紧凑视图，允许重复。下游只接这些槽位及引用，不再接收 teacher 原始 class/id/正文。 |
| **配置与状态** | 必填配置：`ruleId`、`positiveMatch`（条件数组，项内字段 AND、数组间 OR，支持 `tag`、`role`、`classIncludes`、`classExcludes`、`idEquals`、`attributes`）、可选 `negativeMatch`。<br>正负规则同时命中同一节点时标 `matchStatus: "conflict"`；被测字段缺失（如未采集 `classList`）时标 `"unknown"`，严禁把缺测推断为 `"unmatched"`。 |
| **副作用** | 无（`effects: []`），纯内存确定性转换。 |
| **训练能力** | 手写规则节点，无可训练参数。`classIncludes`/`idEquals` 等站点规则仅限本节点作为 teacher 提议或筛选依据，严禁流入下游学生特征向量。 |
| **兼容条件** | 输入必须保持确定数组顺序与槽位映射，允许重复 `nodeRef`；更换任务时只需在 `WorkflowConfig` 中切换局部配置（如改筛广告容器或操作按钮），无需修改算子实现。 |
| **验收（未来实现时）** | 验证正例命中、负例命中（带 `matchPolarity: "negative"`）、正负冲突（`conflict`）、缺测字段（`unknown`）；验证 dense `matchedRefs` 与完整 `slots` 原 `index` 映射一致性。 |

### 1.2 `sample.assemble`（组装单任务训练样本）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "sample.assemble"`, `operator_version: "0.1.0-design"`。单任务训练样本组装节点。<br>唯一 owner：`lib/nodes/`（节点封装）+ `lib/training/`（样本 schema 规范）。 |
| **输入** | 端口 `matched_records`（`schemaId: "sample/matched-records/v1"`, 事件类型 `"sample.matched-records.v1"`），接收 `sample.match` 输出的完整槽位、原始记录引用及匹配状态。 |
| **输出** | 端口 `task_samples`（`schemaId: "sample/task-dataset/v1"`, 事件类型 `"sample.task-dataset.v1"`）。payload 为 `{ taskId, ruleId, items }`；`items` 保持槽位长度和顺序。每项是完整 JSONL 行对象：`taskId`、`ruleId`、`inputRef`、`provenanceRef`、`sourceGroup`、`expectedLabel`、`labelState`、固定 `labelProvenance: rule_proposed`、`excludeReasons` 及可选 `studentObservation`。正例 expectedLabel=targetLabel，显式负例=negativeLabel，unlabeled/conflict/excluded 均为 null。学生观测可选，仅白名单 tag/role/rect/fragments/clippedRect/parentRef；不含原始 class/id/正文或数值特征向量。来源引用传给后续 partition 计算关联闭包，本节点不拼接 groupId 或声称分区独立。 |
| **配置与状态** | 配置为 `taskId`、`targetLabel`、`negativeLabel`，两个标签须不同。每项最多一个标签；脚本结果固定 rule_proposed，配置不能自称已复核或黄金。未匹配或缺测为 unlabeled，正负同中为 conflict。若显式传入 candidateStatus=filtered_out/skipped，保留 excluded；candidateStatus=unknown 保留 unlabeled，不因 teacher 命中恢复资格。未传 candidateStatus 表示调用者未应用 L1 候选限制，不伪造已通过该限制。 |
| **副作用** | 无（`effects: []`）。 |
| **训练能力** | 手写数据组装节点，无可训练参数；产出符合白名单的结构化样本供后续离线训练消费。 |
| **兼容条件** | 每次运行严格绑定单一 `taskId` 与单一 `targetLabel`，单任务单标签；多类别任务通过不同配置文件重复运行同一工作流，不把多任务混成多头隐式状态。 |
| **验收（未来实现时）** | 验证输出样本不含 class/id/文本等 teacher 原始字段；正例、显式负例和 null 的 expectedLabel 映射正确；过滤/缺测不变负例或恢复资格；提议不自动升级黄金；每行含任务、规则、输入位置、证据与来源引用，重复 nodeRef 完整保留。 |

### 1.3 `sample.save`（保存样本到本地目录）

| 合同维度 | 规范内容 |
| :--- | :--- |
| **身份** | `operator: "sample.save"`, `operator_version: "0.1.0-design"`。本地样本持久化节点。<br>唯一 owner：`lib/nodes/`。 |
| **输入** | 端口 `task_samples`（`schemaId: "sample/task-dataset/v1"`, 事件类型 `"sample.task-dataset.v1"`）。 |
| **输出** | 端口 `save_receipt`（`schemaId: "sample/save-receipt/v1"`, 事件类型 `"sample.save-receipt.v1"`）。<br>成功时 payload 返回 `{ savedPath, taskId, ruleId, totalSlots, counts: { positive, negative, unlabeled, conflict, excluded } }`。 |
| **配置与状态** | 持久配置仅 `fileName`（相对调用者存储根的路径）和 `writeMode: create_new`；JSONL 格式固定。调用者显式绑定存储适配/节点工厂的允许根，当前采样场景使用 training/samples；配置不自授根目录。未来实现以独占创建 wx 拒绝覆盖，路径不能逃逸允许根，不追加、不自动重试。逐行保存 items 的完整对象，totalSlots=items.length，各状态 counts 之和等于 totalSlots。 |
| **副作用** | 声明 `effects: ["filesystem.write"]`。<br>编译时必须由调用者在 `grantedEffects` 中显式授权，未授权时 `compileWorkflow` 直接拒绝（实际写入次数为 0）。I/O 写入异常或结果不确定时直接暴露为错误，不自动重试、不伪造成功回执，也不构建复杂事务框架。 |
| **训练能力** | 手写 I/O 节点，无可训练参数。 |
| **兼容条件** | 保存 JSONL 样本至调用者明确授权的本地目录；本项目采样 workflow 将根绑定为 training/samples。非 ok 输入（如 skipped 或 unknown）沿当前 runner 默认行为记为 skipped(upstream_not_ok)，不原样透传 unknown。行级的未知样本仍可作为 expectedLabel=null 的待审记录保存，事件级 unknown 则不执行写入。 |
| **验收（未来实现时）** | 未授予 `filesystem.write` 时编译拒绝；文件已存在时 `create_new` 拒绝覆盖；正常写入后 JSONL 文件每行可解析且 `counts`/路径与回执完全一致。 |

---

## 2. L1 已实现节点简要索引（版本见各项）

L1 已交付的 10 个确定性节点（7 个 DOM 算子与 3 个通用算子）源码位于 `lib/nodes/`：

### 2.1 浏览器 DOM 候选节点 (`lib/nodes/dom.ts`)
1. `dom.observe` (`0.1.0`): 适配保存的页面观测，保留白名单几何/结构，剥离原始 class/id/文本；
2. `dom.viewport` (`0.1.0`): 正面积相交计算视口槽位，父容器离屏不误剪可见后代；
3. `dom.focus` (`0.1.0`): 按 within/region 收缩关注范围，无归属依据拒绝 owned；
4. `dom.deny` (`0.1.0`): 评估黑名单，deny 优先于 allow，记录排除原因且不生成训练负标签；
5. `dom.allow` (`0.1.0`): 评估白名单，未配置不限制，显式空集合拒绝全部；
6. `dom.split` (`0.1.0`): 展开 DOM 层级候选，显式 nodeRefs 保持保长保序；
7. `dom.candidates` (`0.1.0`): 复检展开项规则，输出保序槽位与排除映射，不调用神经网络。

### 2.2 通用基础节点 (`lib/nodes/common.ts`)
1. `common.scale` (`1`): 数值缩放转换；
2. `common.sum` (`1`): 数值求和；
3. `common.count` (`1`): 数组元素计数。
