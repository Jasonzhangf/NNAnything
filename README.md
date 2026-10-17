# NNAnything

以filter为基础节点、用事件传递输入输出、通过节点接续组合workflow的框架。画布、配置文件或代码都是可选的编辑方式。应用和训练共用节点/workflow合同，各自保留I/O语义。黑白名单、DOM拆分、判断与operation均由节点组合，不固定进核心。第一个实验方向是网页DOM的结构化语义识别。

当前交付D0：完整架构、目录与规则、节点合同、workflow配置和后续实施计划。用户明确本轮不实现，之后从浏览器场景开始，按“能动→核心功能→完善功能→提高兼容性”推进。没有产品源码、依赖安装或可运行命令。独立Gemini4已完成整体设计及最新增量复核，均无阻断项；通过只覆盖设计，不代表运行验收。

- [总体设计与分阶段计划](docs/design.md)
- [本轮Framework M1范围与验收](docs/framework-m1.md)
- [目录、首批节点与实施计划](docs/implementation-plan.md)
- [可复用经验节点合同](docs/node-contract.md)
- [Workflow基础配置](docs/workflow-config.md)
- [推进节奏、治理、交付与审批](docs/project-governance.md)
- [现成Workflow框架选型依据](research/workflow-engines.md)
- [Filter节点与统一Workflow](docs/node-workflows.md)
- [画布、事件输入输出与基础节点](docs/canvas-events.md)
- [Viewport、Focus、白黑名单与单标签合同](docs/focus-and-labeling.md)
- [Gemini 4 整体评估及修订结果](docs/reviews/gemini4-design-review.md)
- [本轮D0增量设计复核原始结果](docs/reviews/gemini4-d0-incremental-review.json)
- [结构化分类与查询合同](research/semantic-query-contract.md)
- [成分与关系阶段边界](research/compositional-recognition.md)
- [浏览器双模式与监督回归](research/browser-semantic-modes.md)
- [Handwired 卡片数值连线草案](research/filter-wiring-audit.md)
- [GitHub 项目与训练锚点](research/github-semantic-anchors.md)

应用通过workflow连接手写filter、取参、神经网络和操作节点；训练workflow处理目标节点I/O与候选profile。DOM应用的神经网络节点只判断当前节点的白名单参数，首期返回单标签/分数，二分类可提供isTarget视图。原始DOM、class/content用于标注，不直接输入模型。先审workflow与数值图，再实现和训练。

先定义框架合同，再确定两条workflow需要的最小节点集合，最后组合网页识别与节点训练示例。后续场景按需增加节点、样本编码和适配器，复用同一执行合同。详见[首期交付顺序](docs/node-workflows.md#6-首期顺序与验收)。

原始页面资料与后续训练产物默认保留本地，不入Git。远端为[Jasonzhangf/NNAnything](https://github.com/Jasonzhangf/NNAnything)。本轮在独占worktree整理设计，独立复核后合入main并推送。后续实现从最小浏览器切片开始；节点代码、规则、兼容profile和回归经验按合同分别积累。
