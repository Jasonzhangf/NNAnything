# NNAnything

以filter为节点、以workflow统一执行应用和训练的框架。手写规则与可训练数值节点共用节点合同，各自保留I/O语义。第一个实验方向是网页DOM的结构化语义识别。

当前处于设计阶段。总体设计修订2已由AGY Gemini 4独立评估；最新修订4加入统一节点/workflow，以及单标签按序批处理与focus候选过滤，仍为待审草案。实现尚未开始，仓库没有可运行的推理、采集、标注或训练命令。

- [总体设计与分阶段计划](docs/design.md)
- [Filter节点与统一Workflow](docs/node-workflows.md)
- [Viewport、Focus、白黑名单与单标签合同](docs/focus-and-labeling.md)
- [Gemini 4 整体评估及修订结果](docs/reviews/gemini4-design-review.md)
- [结构化分类与查询合同](research/semantic-query-contract.md)
- [成分与关系阶段边界](research/compositional-recognition.md)
- [浏览器双模式与监督回归](research/browser-semantic-modes.md)
- [Handwired 卡片数值连线草案](research/filter-wiring-audit.md)
- [GitHub 项目与训练锚点](research/github-semantic-anchors.md)

应用通过workflow连接手写filter、取参、神经网络和操作节点；训练workflow处理目标节点I/O与候选profile。DOM应用的神经网络节点只判断当前节点的白名单参数，首期返回单标签/分数，二分类可提供isTarget视图。原始DOM、class/content用于标注，不直接输入模型。先审workflow与数值图，再实现和训练。

原始页面资料与后续训练产物默认保留本地，不入Git。当前仅有本地main，未配置远端。下一步是否进入工程骨架由用户决定。
