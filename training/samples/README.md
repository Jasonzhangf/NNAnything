# 规范训练样本数据 (training/samples/)

本目录存放离线规则采样（如 `dom-rule-sampling`）或 teacher 标注流程生成的规范训练与评测样本数据。
本文件仅描述样本 Schema 与数据结构，不包含任何模型训练实现。

## 1. 样本记录格式规范

1. **存储格式**：严格使用 **JSONL**（JSON Lines）格式，每行一条独立紧凑的样本 JSON 记录。
2. **单任务单监督**：每次采样或标注严格绑定单一 `taskId` 与明确的 `supervisionMap` / `expectedLabels`，单任务单二元监督映射，禁止混入多头隐式状态。
3. **轻量记录边界**：
   - 每行保存 `taskId`、`ruleId`、`inputRef`（snapshotRef、nodeRef、输入数组 index）、`provenanceRef`、`sourceGroup`、`matchStatus`、`semanticLabel`、`matchedRuleIds`、`expectedLabel`、`labelState`、`labelProvenance`、`excludeReasons` 和可选 `studentObservation`。正例使用 expectedLabels.positive，显式负例使用 expectedLabels.negative，未映射（缺省）、未知、冲突或排除使用 null；Filter 仅负责无极性语义分类，下游组装按任务要求映射正负监督，每行完整独立保留上游语义分类结果；完整合同唯一维护于 [节点卡](../../lib/nodes/README.md)；
   - 学生观测 `studentObservation` 可选，白名单为 tag、role、rect、fragments、clippedRect、parentRef。x 与 y 允许为负视口 CSS 坐标（如元素上浮或部分偏出视口），width 与 height 必须为有限非负数值。不要求几何完整才能准备标注引用，也不假装已生成数值向量；
   - 原始 classList、id、账号/正文、完整 URL 和绝对根路径禁止进入学生观测，仅保留 teacher 证据引用。通用 tag、role 允许作为可测属性，不等同站点名称；
   - **标签提议**：脚本规则提议的标签统一标为 `rule_proposed`，严禁通过配置自称 `teacher_verified` 或 `golden`。
4. 来源分组：每行保留 sourceGroup 的快照、帖子及广告素材关联引用。后续 training.partition 计算这些关联的传递闭包再分区；采样时不把多个引用直接拼成独立 groupId。同帖、同快照或共享素材的关联样本不得随机跨训练与留出集。

### 示例（通用占位符，不包含私有类名或真实文本）

```json
{
  "taskId": "card.structure.sample",
  "ruleId": "rule.card.semantic.v1",
  "inputRef": { "snapshotRef": "snap-001", "nodeRef": "node-101", "index": 0 },
  "provenanceRef": "prov-snap-001-101",
  "sourceGroup": { "snapshotRefs": ["snap-001"] },
  "matchStatus": "matched",
  "semanticLabel": "post.card",
  "matchedRuleIds": ["rule.card.semantic.v1:post.card#0.0"],
  "reasons": ["semantic_match"],
  "expectedLabel": "target.card",
  "labelState": "positive",
  "labelProvenance": "rule_proposed",
  "excludeReasons": [],
  "studentObservation": {
    "tag": "article",
    "role": "article",
    "parentRef": "node-100",
    "rect": { "x": 100, "y": 200, "width": 600, "height": 400 },
    "clippedRect": { "x": 100, "y": 200, "width": 600, "height": 400 },
    "fragments": [{ "x": 100, "y": 200, "width": 600, "height": 400 }]
  }
}
```

## 2. 约定子目录（按需使用）

采样 consumer 默认在本目录创建独立输出子目录。后续可按实际用途组织子目录（如分区结果）；不提前创建全套空目录骨架。

## 3. Git 忽略

本目录下所有 `*.json`、`*.jsonl` 样本文件均已被 `.gitignore` 忽略，仅保留本 `README.md`。
