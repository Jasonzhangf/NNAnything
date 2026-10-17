# NNAnything

基于手写数值连线和可训练profile的通用单节点filter框架。第一个实验方向是网页DOM的结构化语义识别。

当前处于设计阶段。总体设计修订2已由AGY Gemini 4独立评估；最新修订3加入单标签按序批处理与focus候选过滤，仍为待审草案。实现尚未开始，仓库没有可运行的推理、采集、标注或训练命令。

- [总体设计与分阶段计划](docs/design.md)
- [Viewport、Focus、白黑名单与单标签合同](docs/focus-and-labeling.md)
- [Gemini 4 整体评估及修订结果](docs/reviews/gemini4-design-review.md)
- [结构化分类与查询合同](research/semantic-query-contract.md)
- [成分与关系阶段边界](research/compositional-recognition.md)
- [浏览器双模式与监督回归](research/browser-semantic-modes.md)
- [Handwired 卡片数值连线草案](research/filter-wiring-audit.md)
- [GitHub 项目与训练锚点](research/github-semantic-anchors.md)

运行时单个filter只判断一个节点的白名单参数，返回isTarget与confidence目标分数。原始DOM、class/content可用于标注，不直接输入模型。页面遍历、目标解析和操作由外部程序负责。先审图与合同，再实现和训练。

原始页面资料与后续训练产物默认保留本地，不入Git。当前仅有本地main，未配置远端。下一步是否进入工程骨架由用户决定。
