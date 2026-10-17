# 当前任务

目标：建立通用单元素 filter 训练框架，共享页面样本支持完整卡片、作者、搜索、我的个人入口、正文、评论、展开与跳转等目标。浏览器分语义使用和错误捕获/训练两种模式。首个实验只用微博完整卡片；外部程序负责页面遍历、节点取参、目标引用和 CDP 动作。filter 输入最小必要参数，输出 isTarget 与目标分数 confidence。class/id、账号名、完整 URL/图片名、绝对根路径与全局深度不输入模型；固定 UI 标记、语义属性与相对位置按目标声明并审计。

当前阶段：2026-10-17用户最新指令要求先完成整体规划设计，再由AGY Gemini 4整体评估/review，之后再决定推进。已停止实现。Git已初始化、本地main有设计基线，无remote。未提交的package/tsconfig、架构与测试草稿已归档到 /Volumes/Intel/playground/nnanything-runs/project-scaffold/unimplemented-scaffold-draft.tar.gz，未合入main；唯一外置worktree和自有分支已清理。没有src实现、依赖安装、采集、标注或训练。此前为脚手架启动实现早于用户期望，已纠正为设计优先；本轮不再实现。

## 已有材料

- docs/reviews/gemini4-design-review.md：用户指定AGY Gemini 4整体设计Review。新独立conversation 528f539f-1599-4673-83e1-9926c4d84689；首轮5P1+1P2，修订2后同Reviewer复核findings=[]。两轮SUCCESS/exit0、实际gemini-4-argon-medium，宿主校验schema/scope后裁决仅设计通过。原始结果已存docs/reviews/gemini4-design-v1.json和v2.json；不代表实现/训练验收。
- docs/design.md：最新总体设计入口，覆盖目标/目录/核心合同、两层建模与两阶段训练、teacher标注、监督回放与开发/测试/训练框架。D0设计评估后仍等待用户决定，不自动进入D1实现。
- research/github-semantic-anchors.md：2026-10-17 GitHub 只读调研；WebUI 主参考基础成分和采样，Web2Text 参考块/边证据与结构对照，Mind2Web 参考操作证据。实际解析 WebUI 一个公开 AX 样本，328 节点；没有运行第三方模型或下载完整数据集，业务标签仍需本地标定。
- research/compositional-recognition.md：整体与成分共生，关系直接入参；第一阶段使用可测关系，第二阶段再加入父子/兄弟预测摘要。第二阶段训练与有限推理轮次分开。
- research/semantic-query-contract.md：固定 target 分类、within 作用范围、one/all 查询、结构化返回与纠错；运行时搜索不依赖 LLM。中文描述仅解释用途，不作为匹配输入。读取值和动作与语义查询分开。
- 新增显式分类 post.card.advertisement、post.card.promotion、post.card.recommendation；识别保留具体节点及多标签供操作，不能只作为 organic 负例丢弃。推荐不自动等于付费广告或商业推广，未知标签不强行变负例。
- research/browser-semantic-modes.md：最新上层设计；两种模式、共享观测目录、多目标标签与边界、错误归因、旧新样本重拟合和独立黄金回归。两张流程图是设计图，不是 Handwired 内部数值连线。
- research/filter-wiring-audit.md：当前待审的稀疏数值连线与通用单轮反馈更新设计。拟议 10 个输入、10 个系数与 bias；Handwired 求连续分数，宿主做 sigmoid、损失和校准。
- research/weibo-filter/snapshot-001/：原始渲染 DOM、同次节点测量、随后捕获的视口截图。
- research/weibo-filter/seed-labels.json：15 个初始标注，3 正例、12 负例。包含平台广告和用户确认的商业推广；多数初始标注仍待复核。
- research/weibo-filter/user-visual-labels.json：用户截图确认的购物促销、科普荐读、社交推荐负例；后两张尚未关联到归档原始 DOM 节点。
- research/weibo-filter/visible-differences.md 和 visible-marker-comparison.json：当前可见差异。社交推荐在作者 header 前有约 33px 来源栏；作者资料区粉丝数不能混淆为来源栏。

## 当前设计与未知

用户确认推广范围包括科普/新闻荐读和“某某关注了”的推荐，不仅是付费广告或商业文案。要比较容器中实际呈现的标记后再选特征。少样本高效果是待测假设，不预设准确率。

推理与训练框架分开。首轮采用旧训练回放集与新训练样本重拟合，独立黄金集与新留出批次验收。顺序贝叶斯更新保留为另一路径，拟议对角高斯/拉普拉斯近似，不与全量回放叠加旧证据。新增标签与更正已吸收标签分开处理，后者不累计矛盾证据；校准不替代分类纠错。未训练点权重不冒称贝叶斯后验。

每次操作进入样本池；LLM 按操作链回溯失败、引用证据、区分失败 owner，选择性入集。保留成功样本供核实后回归。候选版本逐例比较 fixed/regressed/unresolved/retained/unassessed，并分别报告开发回放和独立回归。离线预测回放不重复真实网站动作，也不证明动作成功。只有输入足以判别时做参数修复，否则返回特征/连线审计。上述机制均为设计，尚无实际运行记录或版本比较结果。

来源槽位是否使用纯几何，还是允许固定 UI 标记词/局部图像识别，是用户审计项。图片广告没有 DOM 文字，不能声称 textContent 能识别它。纯几何和有限样本尚未证明足够区分所有来源状态。

两张当前数值/更新图已做文本单入口单出口与无环检查；未单独渲染验收。无算子性能、学习曲线或分类效果数据。

## 独立规划与资源

记录目录：/Volumes/Intel/playground/nnanything-runs/filter-wire-audit。
Opus 5.5 medium 实际因配额耗尽失败；按既定路由改为 Gemini 4 Argon medium，独立 conversation a30e71c9-05d0-4af1-a470-20804f27e544 完成初稿和修订。初稿有未经测量的性能宣称及硬门零梯度问题，未采纳；当前用户审计稿已删去这些问题并压缩候选输入。外部进程均已退出。

下一动作：当前D0总体设计与整体评估已完成，向用户交付设计与finding修订结果，等待用户决定。本轮不进入D1或恢复实现。旧10输入图只为卡片待审草案，各目标实际数值连线仍需后续审计。项目无remote，不猜测或创建远端。
