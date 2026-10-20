# DOM 基础分类器的优先级实验

状态：实现与真实训练对照已完成，独立 Gemini 4 medium 整体 Review 通过，候选未采用。算法和训练合同分别由 basic-kinds-wiring.md 与 training-workflow.md 维护。旧设计及默认权重保持原入口。

外层观测、筛选、分类、展示和六节点训练图保持原有 SESE 拓扑。内部按以下顺序求值，所有出口汇入同一个结果。各阶段仍计算显式评分，原生标签不硬返回类别。

本轮现场复检补充的支撑缺口：知乎页脚多个链接之间的直接分隔文本会激活自身文本阶段。现有重复子项 wire 可作为文本的反向证据，但原稀疏参数表没有该地址。先补文本 family/leaf 的默认零系数地址，再用列表与正文反例训练；不改变阶段先后，也不把重复子项直接判为列表。微博侧栏、横向功能列表及可点击会员图标的 teacher 修正另存证据，不改旧黄金样本。

现场追加关系输入：只靠任意一对子项几何重复，会把混合内容容器和重复列表映射为相同 wire。补充浅层子项结构与自身内容存在性组成的同类比例，以及同位置多层显示比例；它们参与列表、混合容器和包装的评分。零面积支持节点仍保存，包装依据正面积子项与自身独立承载能力评分。排版、分隔、图形内部部件等用途作为 teacher 的反向证据另存，不从最终标签生成学生输入。历史缺测保留 null，新系数按名补零；外层 DAG 与四阶段先后保持不变。

自身提示信息也是独立内容证据：微博图形包装的 title 状态不能因无正文而丢失。新增 nullable 的标签存在性与有界图形后代存在性，以组合 wire 支持具名图形所有者；原始提示字符串只留 teacher 证据。只在实际看见图形标签、图形角色或 CSS 图像／mask 时确认图形，不把一般伪元素文字或 figure 分组直接当图片。显式按钮和输入仍在先前交互阶段评分；新地址迁移为零，历史未测保留 null。

本轮现场复检补充独立焦点图形的证据路线。焦点事实与自身图形内容分两条 wire 提取，仍在上图 `own_content` 阶段参与评分：

```text
own_focus_target = nullableOR(activeElementFocus, tabIndexFocus)
independent_graphic_content = nullableAND(selfGraphicEvidence, nullableOR(own_focus_target, ownLabelPresent))
```

`own_focus_target` 是通用独立焦点证据，登记 ignore 的反向贡献 support 路径。焦点不打开 direct_interaction 的 button/input/select/link，也不打开 meaningful_structure 的 container/list/listitem。`independent_graphic_content` 加入 image 的正向 support，并和 `own_focus_target` 一起登记 ignore 的反向贡献地址；该节点自身呈现图形且有独立目标价值时不落入 redundant_ignore。资源定义、SVG `text`、非图形 tag 和缺测操作数不取得正证据。阶段顺序、门限、margin、标签和 profile 结构不变；具体有限适用集合与零迁移地址沿 [基础种类连线](basic-kinds-wiring.md)。


```mermaid
flowchart TD
  S([合格单节点属性与缺测状态]):::boundary --> W[提取自身与继承证据以及静态支撑门控]:::action
  W --> I{直接交互阶段}:::decision
  I -->|明确命中| O[记录输入、选择、按钮或链接]:::action
  I -->|强歧义或冲突| U[记录未知或冲突]:::failure
  I -->|无支撑或仅弱证据| C{自身内容阶段}:::decision
  C -->|明确命中| O
  C -->|强歧义或冲突| U
  C -->|无支撑或仅弱证据| G{列表与有意义分组阶段}:::decision
  G -->|明确命中| O
  G -->|强歧义或冲突| U
  G -->|无支撑或仅弱证据| R{冗余包装阶段}:::decision
  R -->|评分明确命中| D[记录忽略类别]:::action
  R -->|其余情况| U
  O --> Z([唯一类别、状态、分数及证据]):::boundary
  D --> Z
  U --> Z
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

支撑门控只看已观测的适用证据，不读取权重符号。无支撑的目标不参加该阶段；进入目标后仍保留缺测区间。弱证据是联合上界低于门限；强歧义和冲突立即停止，不进入忽略。结构阶段按有意义细类的联合区间评估，不能因忽略证据抬高共享 structure 分数而阻断最后的忽略分支。

三站清零增量沿用上述图。当前逐项复核275条后，15条期望类别缺少正向支撑：继承指针的多子包装、只有一个零面积直接子节点的包装、空的隐藏支持宿主和search分组。先补对应组合评分wire与稀疏地址；不改既有wire含义，不直接按属性返回类别。现有属性已能表达首轮这些组，暂不增加coincident子矩形输入。若拟合仍证实缺失辨别关系，再按实际反例扩展。原始缺测保留；公开采集另补所有合格候选的导出，供同帧旧新分类回归。

旧 profile 省略 topology 时保持旧两阶段算法。新 profile 明确使用 priority_staged_v1，初始稀疏系数全零。新权重资产使用 contractVersion 2，旧资产保持 1，交叉装载报错。扩展当前采用的 SVG-pair 资产不变。

实验比较三个对象：当前旧权重、旧结构从零重新拟合、新结构从零拟合。后两者使用同一训练数据和预算；旧 357 样本只评估。合成基础元素与缺测增强分别标记，不声称新增独立页面。失败候选保留 not_applied。

计时脚本使用单调时钟。分别记录数据准备、后端加载、电路构建、基线评估、训练梯度及更新、每轮评估、最终评估、对照和端到端耗时。每轮实际两次全量行评估；同时报告唯一源样本、增强与重复负载、完成轮数、参数量和真实行处理量。失败也保存已经完成的工作，不伪造取消或成功。

## 2026-10-18 实测

使用 Apple M3 Ultra、darwin arm64、Node 22.22.2、Handwired reference f32 后端。正式训练112行：96个非合成源样本、15个合成样本、1个缺测增强；111个唯一源标识不等于111个独立页面，合并来源关联为18组。357条旧黄金只评估，25条诊断不计准确率，其中10条另有训练teacher监督。

| 实验 | 行数 | 轮数 | 参数 | 拟合总时长 |
| --- | ---: | ---: | ---: | ---: |
| 旧结构全零重训 | 112 | 500 | 184 | 3.948 s |
| 新结构全零重训 | 112 | 500 | 258 | 5.288 s |
| 新结构规模32 | 32 | 100 | 258 | 0.324 s |
| 新结构规模64 | 64 | 100 | 258 | 0.624 s |
| 新结构全量唯一源 | 111 | 100 | 258 | 1.127 s |
| 新结构两倍重复负载 | 222 | 100 | 258 | 2.073 s |

两倍重复负载只有111个源标识，只测吞吐。正式500轮各有56,000梯度行、112,224总行遍历。整个对照与矩阵13.579 s，数据准备76.009 ms，对照及资产处理77.843 ms，矩阵4.157 s。旧结构首轮包含后端加载，后续复用模块缓存；参数数目也不同，不能把总时差全归因于路由。

| 模型 | 训练集明确判对 | 旧黄金明确判对 | 相对当前采用权重退化 |
| --- | ---: | ---: | ---: |
| 当前采用旧权重 | 51/112 | 274/357 | 基线 |
| 旧结构全零重训 | 23/112 | 110/357 | 164 |
| 新结构全零重训 | 111/112 | 161/357 | 116 |

严格计数要求类别正确且状态judged；48条黄金other仍为残余监督，unknown不算正确。因此这里是固定回归集的严格命中数，不是独立网页准确率。新结构修复3条、保留158条、退化116条、未解决80条；10条点赞teacher均可识别，两个原指定select反例均正确，仍不足以采用。

逐例检查确认：新候选nat_list、nat_container等原生路径系数仍为0；训练样本不覆盖这些激活方式。26条span回归在缺nonFormatDirectTextPresent时确定下界约0.579，低于0.6，保留unknown。结构与input也有训练共现依赖及历史缺测。结论是本次从零样本覆盖不足，不用硬返回或把null改false掩盖。后续应补非黄金基础路径与缺测反例，再独立留出验证；本轮不按黄金挑轮数或调门限。

本地完整报告：`training/results/priority-classifier/final/priority-benchmark-report.json`；候选资产：`training/weights/priority-classifier/final/`；复现输入：`training/samples/priority-classifier/`。它们按项目规则本地忽略。旧382条输出逐项不变；171项测试及UI类型检查通过。缺后端CLI非零且保存部分计时。候选保持uncalibrated/not_applied，当前扩展无需重载。
