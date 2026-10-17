# GitHub 网页语义项目与训练锚点

调研日期：2026-10-17。通过 agent-reach 的 GitHub / gh 后端搜索并读取公开仓库 README、相关源码及一个 WebUI 样本。未安装模型、未下载完整数据集、未运行其基准。下列可用性判断来自代码阅读，不代表 NNAnything 的实测效果。

## 选择

主参考选择 [WebUI](https://github.com/js0nwu/webui)：用它锚定基础成分、DOM/无障碍树/布局/截图之间的关联和采样格式。

关系模型参考 [Web2Text](https://github.com/dalab/web2text)：它把块特征和块间关系特征分开，分别训练，再做结构化推断，贴近本项目先基础、后关系的拆分。

操作监督参考 [Mind2Web](https://github.com/OSU-NLP-Group/Mind2Web)：参考单步操作、目标节点、正负候选和现场记录的绑定方式。

这些项目均未核实包含符合本项目定义的普通微博/广告/推广/推荐、作者、评论/转发/点赞业务标签。业务训练真值仍需在自己的页面样本上标定。外部预测或自动生成标签只能作为提议，不能自动晋升黄金标签。

## 项目证据与边界

| 项目 | 已核实内容 | 可参考部分 | 不直接采用的部分 |
| --- | --- | --- | --- |
| WebUI | README 描述约 400K Web UI；采集 AX tree、HTML、布局、样式、多视口截图；由 AX role 产生多标签 | 基础类别、节点关联、局部包装边界、按域划分数据 | 自动 AX 标签不是业务真值；视觉检测模型不是我们的单节点数值 filter |
| Web2Text | 手工块特征、树距离/共同祖先等边特征；unary/edge 网络；Viterbi 结构推断 | 自身与关系证据拆分；基础和结构版本对照 | 主要是内容/噪声二分类，不能直接得到作者、点赞或广告类别；不搬整页序列接口 |
| Mind2Web | raw_html、cleaned_html、CLICK/TYPE/SELECT、正负候选、backend_node_id；原始 trace/前后快照记录 | 操作样本合同、节点边界、元素与动作分开评估、跨网站划分 | 自然语言任务条件下的候选负例不等于固定语义类别负例；不引入运行时 LLM 依赖 |
| WebSRC | HTML、截图、bounding boxes；答案绑定 element_id 和字符偏移；定位最深包含答案节点 | 读值与节点定位分离、文本边界标注 | 是结构阅读问答，不是操作目标或社交成分标签目录 |
| DOM-Q-NET | local/neighbor/global 表示分离；有限 num_steps 的邻接消息传递 | 第二阶段有限轮次、基础与邻接支路消融 | MiniWoB++ 强化学习与整体图接口；使用 class/text embedding，违反本项目部分输入约束 |

### WebUI 核查

- [采集源码 crawler/process.js](https://github.com/js0nwu/webui/blob/main/crawler/process.js) 调用 Accessibility.getFullAXTree，并按 backendDOMNodeId 保存 boundingBox、boxModel 和 computed style；同时采集 HTML 和截图。
- [标注生成 scripts/screenrecognition/generate_dataset_web.py](https://github.com/js0nwu/webui/blob/main/scripts/screenrecognition/generate_dataset_web.py) 从未忽略、有 box 的 AX 叶节点出发，沿满足条件的单子父级提升，累积 role 标签并保存 content/padding/border/margin boxes。
- 这说明“名称文字元素”和“可点击父级”可能有不同规范边界。我们的 filter 不在内部迁移目标，边界仍需明确标注。
- 实际解析公开样本 sample/1656554031731/default_1280-720-axtree.json.gz：328 个 AX 节点，328 个带 backendDOMNodeId，327 个带 parentId。角色包括 link=30、img=3、StaticText=42、list=5、listitem=16、article=1、combobox=1。该数量是原始 AX 节点计数，不是最终可训练正例数。
- 默认训练类映射文件 metadata/screenrecognition/class_map.json 被数据加载源码引用，但本次访问该路径返回 404；不宣称已取得完整类别表。已验证的是采集方法、role 到标签的生成规则和样本中的角色。
- README 声明按 domain 分组后分为训练/验证/测试，避免同站类似页面跨集。我们首轮单站则按帖子和独立采集批次分组。

### Web2Text 核查

- [LeafBlockExtractor.scala](https://github.com/dalab/web2text/blob/master/src/main/scala/ch/ethz/dalab/web2text/features/extractor/LeafBlockExtractor.scala) 保存文字长度、标点/数字比例等固定特征。
- [NodeBlockExtractor.scala](https://github.com/dalab/web2text/blob/master/src/main/scala/ch/ethz/dalab/web2text/features/extractor/NodeBlockExtractor.scala) 含 link_density 和表单存在特征。
- [TreeDistanceExtractor.scala](https://github.com/dalab/web2text/blob/master/src/main/scala/ch/ethz/dalab/web2text/features/extractor/TreeDistanceExtractor.scala) 与 CommonAncestorExtractor.scala 提供成对关系证据，不依赖账号名称。
- [main.py](https://github.com/dalab/web2text/blob/master/src/main/python/main.py) 有 train_unary、train_edge，并在 test_structured 同时评估结构版本与 just unary。
- 它的关系机制是相邻文本块的成对势与结构推断，并非直接将兄弟节点“历史分类概率”输入本项目 filter。我们只参考分离证据和对照评估的方法，不冒称直接复用其结构。
- 英文大小写、停用词、固定统计归一化常数不能直接移用到中文社交页面。局部树距离与根到节点的绝对路径也不同；若采用仍须做特征消融。

### 操作与节点边界核查

- [Mind2Web README](https://github.com/OSU-NLP-Group/Mind2Web#data-fields) 明确 raw_html 与 cleaned_html 中正例可能不同，清洗可能丢失目标。我们保留原始 DOM，候选遗漏单独归因。
- [Mind2Web metric.py](https://github.com/OSU-NLP-Group/Mind2Web/blob/main/src/action_prediction/metric.py) 分别记录 element_acc、action_f1、step_acc，并计算按任务汇总的宏平均。模型选对元素与实际操作成功仍是不同证据。
- [WebSRC README](https://github.com/X-LANCE/WebSRC-Baseline#data-format-description) 以最深包含答案的标签加字符偏移定位文本，适合参考“作者名称元素”和“读取姓名”的分离。
- [DOM-Q-NET graph.py](https://github.com/Sheng-J/DOM-Q-NET/blob/master/models/graph.py) 按有限 num_steps 传递邻接信息；dom_qnet.py 可分别开关 local、neighbor、global。参考其消融方式，不复制全页神经网络。

## 对本项目的具体拆分

| 层 | 结构字段 | 锚点来源 | 监督来源 |
| --- | --- | --- | --- |
| 基础成分 | elementType：text、image、video、link、input、button、container；允许多类型 | WebUI AX/DOM 类别与采集方式 | 可观测属性和经复核的标注 |
| 业务目标 | target：post.card、post.author.name、post.comment.entry 等 | 本项目固定分类目录 | 用户定义边界，LLM 对原始现场标定 |
| 局部关系 | 包含、对齐、间距、局部树关系、part_of 归属 | Web2Text 的块/边拆分思路 | 几何测量与归属标注 |
| 语义上下文 | 父子/兄弟上一轮的预测分数摘要 | DOM-Q-NET 的有限邻接传播思路 | 实际预测产生上下文，关系标签监督 |
| 操作监督 | query、action、expected、selected、before/after、outcome | Mind2Web 的步级证据绑定 | 操作后条件、用户纠正、LLM 回溯 |

elementType 是候选基础分类，不需要把每一项都做成可训练 filter。浏览器已可靠提供的事实直接读取。不能把 role=link 同时作为输入和正确标签，然后声称训练解决了业务语义识别。

业务成分需要上下文：img 不等于 post.author.avatar；link 不等于 navigation.entry；button 不等于 post.like.entry。对这类映射按本项目已声明特征训练，并用独立反例验收。广告图标和商业推广尤其不能从通用 UI role 直接推导。

## 两阶段训练锚点

第一阶段：自身属性、可测成分和几何关系 → 单节点业务目标。保存父子/兄弟的原始关联和预测记录，但不依赖其他节点的语义判断。首个实现实验仍可只做微博卡片，并逐步增加目标。

第二阶段：在第一阶段可用后，增加上下文预测摘要 → 训练关系支路。作者/正文/互动成分帮助识别完整帖子，帖子上下文帮助识别成分。按有限轮次展开，保持每次 filter 调用只判断一个节点。

第二阶段必须与第一阶段在相同独立样本上配对比较 fixed/regressed、目标精确率/召回率、归属正确率和计算成本。关系输入使用实际预测，不能使用黄金父子标签冒充预测；训练上下文按页面/帖子分组留出生成，防止标签泄漏。

“训练锚点”首轮明确为类别定义、规范节点边界、原始样本/标签格式和可比较基线；不是直接采用第三方模型的结论作为真值。若以后需要蒸馏，须另验证教师在本任务上的质量。

## 复用边界与当前结果

代码阅读可继续；若实际导入第三方数据或复制代码，再按对应许可选择材料。已读元数据：Web2Text 和 WebSRC-Baseline 标注 MIT；Mind2Web README 区分 MIT 代码与 CC BY 4.0 数据；WebUI 的 COPYRIGHT.txt 有独立数据条款；DOM-Q-NET API 未返回许可证。当前没有复制第三方实现或导入完整数据集。

本次完成项目筛选、源码核查、一个公开样本解析及训练锚点映射。未证明少样本准确率、广告识别率或第二阶段收益。下一步按该映射审计各目标的最小输入和实际数值连线，再实现。
