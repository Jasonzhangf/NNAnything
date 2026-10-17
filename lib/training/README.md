# 训练算子与适配合同实现目录 (lib/training/)

本目录规划存放离线训练的算法、数值后端适配和样本 schema。对外的 NodeDefinition 封装归 lib/nodes，本目录不维护第二套节点定义或注册入口。

当前增量仅包含样本 schema 与白名单投影逻辑（`lib/training/samples.ts`），不包含任何神经网络训练实现。

## 1. 职责与边界

1. **源码与数据物理隔离**：本目录位于 `lib/` 源码树下，仅包含训练流程的算子逻辑与契约。本地生成的样本数据、评估报告与权重产物物理存放在根目录的 `training/` 下（Git 忽略）。
2. 显式数值后端：涉及拟合与反向传播时，通过调用者明确提供的 Handwired 源码根配置（HANDWIRED_ROOT）加载本地内核。源码根未配置时明确报错，不自动搜索、复制/vendor 上游或伪造训练成功；本轮不实现加载器。
3. **校准与泛化诚实性**：
   - 每次参数重新拟合使旧校准状态自动失效；
   - 独立数据覆盖不足时明确标记为 `uncalibrated` 或 `development-only`，严禁伪造校准；
   - 新旧版本比较必须逐例输出 `fixed`、`regressed`、`retained`、`unresolved`、`unassessed`，严禁通过汇总 loss 掩盖关键用例退化。
4. **离线隔离**：训练算子仅在本地纯内存与离线文件上运行，严禁在训练或回放过程中触发任何浏览器动作或外部网络请求。

## 2. 样本 Schema 规范（已实现）与训练算子状态

1. **样本 Schema 与组装逻辑（`lib/training/samples.ts`，0.1.0 已实现并通过公开接口验收）**：
   - 定义单任务训练样本行结构 `TaskSampleRow`（`taskId`、`ruleId`、`inputRef`、`provenanceRef`、`sourceGroup`、`matchStatus`、`semanticLabel`、`matchedRuleIds`、`expectedLabel`、`labelState`、`labelProvenance`、`excludeReasons`、`studentObservation`）；
   - 任务监督映射：Filter 仅输出语义分类，本模块拥有将 `semanticLabel` 映射到具体训练任务正负监督（`positive` / `negative`）及 `expectedLabel` 的逻辑，每行完整保留上游语义分类结果；
   - 实现严格的学生观测白名单投影，确保仅保留 fresh tag/role/rect/fragments/clippedRect/parentRef（支持合法负视口 CSS 坐标 x, y），彻底剥离原始 class、id、账号、正文、URL 与绝对路径；
   - 实现端口数据校验（`TaskDataset`）。
2. **训练算子（待实现，保持设计态 0.1.0-design）**：
   - 后续离线训练流（`node-training.graph.json`）涉及的算子（`training.prepare`、`training.partition`、`training.fit`、`training.calibrate`、`training.compare` 等）属于 L2 范畴，本增量严格不实现，不建空 `.ts` 壳或伪造执行接口。
