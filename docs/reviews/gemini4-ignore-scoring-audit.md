# NNAnything 离线 Ignore 评分实验方法论与结果独立审计

作者归档说明：本审计是受限离线实验的方法论核查，不是生产分类器Review PASS。审计期间作者进一步拆开了碰撞签名差异：154对不同签名中，133对有两侧已测且不同的关系值，21对仅因缺测覆盖不同。下文“154对被分离”仅指签名不同，不能将其全部理解为已有语义辨别证据。最终报告采用133／21／73的分项计数，拟合权重和预测未变。

## 1. 结论摘要

本次实验与文档交付属探索性离线评分与边界校准（`not_applied`、`uncalibrated`），未修改正式分类器词表、生产 profile 或浏览器扩展 UI。实验代码真实调用 Handwired（`/Volumes/extension/code/handwired`，300 epochs，`lr=0.05`），完整保留缺测区间（`null` 不转 `false`），保存回载与解析梯度均经数值验证一致。当前结果可在文档中作为受限探索性证据汇报，但方案 B 仍存在 `5/70` 保留项误判与 `3/45` 未定项误触发，不能作为自动过滤或直接合入生产分类器的依据。

## 2. 数值与代码核验

经直接复核 `ignore-scoring-experiment.mjs`、`experiment-comparison.json`、`feature-collision-report.json` 与 `teacher-proposals.json`，核心指标与代码实现完全吻合：

- 样本划分与防泄漏：152 条微博未知样本划分为 `37 ignore / 70 retain / 45 ambiguous`（全部 `accepted`，`provisionalRetain=0`）。拟合仅使用同页 `107` 条（`37 ignore + 70 retain`），`45 ambiguous` 不参与拟合。`357` 条旧黄金样本（`309 concrete / 48 other`）仅作事后回归评估，未参与拟合、调参或特征选择，无黄金数据泄漏。
- 同页重放指标（152 条，非独立留出）：
  - 条件 A（48 维局部 wire）：命中 `36/37` ignore（漏判 `nnanything-inspector-304` 分隔线容器），误判 `11/70` retain 为 ignore，在 `9/45` ambiguous 上触发 ignore。
  - 条件 B（48 维局部 + 4 维既有 `ExplorationInputV1` 关系投影）：命中 `37/37` ignore，误判 `5/70` retain 为 ignore，在 `3/45` ambiguous 上触发 ignore。
- 旧黄金回归（`357` 条 × `default/legacy` 双 profile）：A 与 B 在 `309` 条具体类别黄金样本上均为 `0 falseIgnore`，全部 `357` 条上 `0 baseline changes`、`0 newlyRegressedCorrectPrediction`。但旧黄金样本 `explorationInput=null`，4 条关系 wire 全部走缺测区间惩罚（`min` 减去 `ReLU(-w)*mask`），因此该零误伤仅证明缺测保守性，不能外推为跨页完整包含关系下的鲁棒性。
- 碰撞计数语义（`collisionReport`）：`227` 是笛卡尔反对偶对（`ignoreRow × comparisonRow`）数量，全部发生在 `teacher_ignore` 与 `teacher_retain` 之间（与 `concrete_gold` 碰撞为 `0`）。加入 4 维关系投影后，`154` 对被分离，剩余 `73` 对未解碰撞全部集中于 `29` 个 ignore 样本与同页 `5` 个 retain 样本之间。这解释了为何条件 B 恰好在该 `5` 个 retain 样本（`274/299/315` 弹窗文字外层 span、`422/424` 图片封面与槽位空 div）上完全同分并发生误判。该指标度量特征签名可分性，不等于分类准确率。

## 3. 方法论局限与边界审视

1. 外挂单行替代竞争 vs 真实单标签多分类：
   本次实验通过单行 `ignore` 电路与既有 family/leaf 最大上界比差（`lowerIgnore >= 0.6` 且 `lowerIgnore - strongestConcreteUpper >= 0.15`；未胜出时保持 baseline 原判 `other/unknown`）。这是合理的测试夹具修正，而非手工调权。但它存在结构局限：未将 `ignore` 纳入第一层分类器的统一监督与负例互斥约束，也未解决那 `70` 条 `retain` 样本（如 40 个 CSS 伪元素图标、背景图、复合控件容器）在正式分类器中仍处于 `unknown`（最高具体证据仅 `0.2~0.3`）的问题。
2. 静态表示下无法消解的碰撞与未定项：
   条件 B 误判的 `5` 个 retain 样本与误触发的 `3` 个 ambiguous 样本（`321` 类 checkbox 空层、`420` 叠层图片空 div、`534` 视频空层），在 52 维特征下与纯排版空 div 或普通单子 span 签名完全重合（`ignoreMin` 达 `0.747~0.787`）。静态 DOM 快照既无子层文本透传表示，也无委托事件监听或真实命中/遮挡证据。在无反例证明新特征收益前，不应盲目堆砌传感字段，但必须承认当前 52 维表示不足以安全启用自动忽略。
3. 用户最新“直接交互/读取目标”定义下的 Teacher 标注审视：
   用户明确目标为“是否需要作为 agent 独立交互/读取目标”。对照此定义，`teacher-proposals.json` 中部分 `retain` 标注具有可争辩性：例如 `274/299/315`（子 div 已承载可见文字 `图片/更多/公开` 的外层无属性 span）以及多处 `redundant_wrapper` 与 `retain` 边界，若子元素本身已是独立读取/点击目标且外层无独立目标价值，外层标 `retain` 偏保守；反之若外层承接委托点击而子层不承接，则需保留。鉴于静态快照无法证实事件委托与命中，当前应维持其临时提议（`notGolden=true`）与 `provisional` 定性，不在无交互证据下做主观重标。

## 4. 纠偏项、文档许可与下一步最小实验

| 审视项 | 审计结论与证据 | 最小动作建议 |
| --- | --- | --- |
| 实验数据与文档汇报许可 | 允许汇报。`docs/weibo-unknown-20261017.md` 与 `note.md` 已准确对齐“单分类器 `ignore` 类别、不建独立保留/忽略头、兄弟不合并、仅父子包含冗余评分”。 | 若将实验数值写入仓库文档，须同步注明：同页 107 拟合无留出、227→73 为特征对偶碰撞数而非错误率、旧黄金缺 `explorationInput` 故不代表跨页关系已验证、B 仍有 `5` 误判与 `3` 歧义触发。 |
| 残留碰撞根因定位 | `73` 对未解碰撞全部由 `5` 个 retain 样本（`274/299/315` 单子无自身文本 span；`422/424` 空图层 div）引起。 | 无需重跑大采集或新建框架。下一最小实验聚焦：(1) 区分“子节点自身已是候选且父节点无独立目标”与“子节点未单独成目标但含有效内容”；(2) 将已确认具体基础类别的样本（如 40 个伪元素图标、背景图、直接文本）与 `ignore` 共同放入同一基础分类器词表做联合拟合对比，检验真实多分类下的 `strongestConcreteUpper` 竞争表现。 |
| 本地 AGENTS / Skill 归属审计 | `AGENTS.md` 新增两段准确记录了用户关于 `ignore` 单分类器目标与 agent 交互目标的边界，废止了旧“独立保留/忽略训练头”；`.agents/skills/nnanything-training/SKILL.md` 未被污染，无重复规则或全局记忆越界修改。 | 保持当前 `AGENTS.md` 与 `docs/weibo-unknown-20261017.md` 归属不变，不修改全局记忆，不触发 `npm test` / `npm run build`。 |
