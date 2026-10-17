# 规范训练样本数据 (training/samples/)

本目录存放离线规则采样（如 `dom-rule-sampling`）或 teacher 标注流程生成的规范训练与评测样本数据。

## 1. 样本记录格式规范

1. **存储格式**：严格使用 **JSONL**（JSON Lines）格式，每行一条独立紧凑的样本 JSON 记录。
2. **单任务单标签**：每次采样或标注严格绑定单一 `taskId` 与单一 `targetLabel`，禁止混入多头隐式标签。
3. **轻量记录边界**：
   - 每行保存 `taskId`、`ruleId`、`inputRef`（snapshotRef、nodeRef、输入数组 index）、`expectedLabel`、`labelState`、`labelProvenance`、`provenanceRef`、`sourceGroup` 和排除原因。正例使用 targetLabel，显式负例使用 negativeLabel，未知/冲突/排除使用 null；完整合同唯一维护于 [节点卡](../../lib/nodes/README.md)；
   - 学生观测 `studentObservation` 可选，白名单为 tag、role、rect、fragments、clippedRect、parentRef。不要求几何完整才能准备标注引用，也不假装已生成数值向量；
   - 原始 classList、id、账号/正文、完整 URL 和绝对根路径禁止进入学生观测，仅保留 teacher 证据引用。通用 tag、role 允许作为可测属性，不等同站点名称；
   - **标签提议**：脚本规则提议的标签统一标为 `rule_proposed`，严禁通过配置自称 `teacher_verified` 或 `golden`。
4. 来源分组：每行保留 sourceGroup 的快照、帖子及广告素材关联引用。后续 training.partition 计算这些关联的传递闭包再分区；采样时不把多个引用直接拼成独立 groupId。同帖、同快照或共享素材的关联样本不得随机跨训练与留出集。

## 2. 约定子目录（按需使用）

后续实际生成样本时，可在本目录下按用途组织子目录（如 `training/samples/raw/` 存放采样原始输出、`training/samples/partitioned/` 存放按 group 划分后的分区），当前设计阶段**不需要提前创建全套空目录骨架**。

## 3. Git 忽略

本目录下所有 `*.json`、`*.jsonl` 样本文件均已被 `.gitignore` 忽略，仅保留本 `README.md`。
