# DOM 基础种类分层连线

当前实现目标是第一层基础种类。第二层再组合帖子、作者、评论、广告等应用语义。本文件是节点内部 wire 算法的唯一设计 owner；节点事件卡见 [节点清单](../lib/nodes/README.md)。

## 层级与执行顺序

| 属性大类 | 只在大类通过后计算的细类 |
| --- | --- |
| control | button、input、select |
| media | image、video、audio |
| navigation | link |
| text | text |
| structure | container、list、listitem |

```mermaid
flowchart TD
  S([输入单节点属性与缺测状态]):::boundary --> G{候选资格通过}:::decision
  G -->|否| X[保留排除或未知原因]:::action
  G -->|是| W[抽取明确命名的属性条件 wire]:::action
  W --> F[计算五个大类的分数区间]:::action
  F --> D{大类证据与间隔足够}:::decision
  D -->|否| X
  D -->|是| L[仅计算选中大类的细类分数区间]:::action
  L --> E{细类证据与间隔足够}:::decision
  E -->|否| X
  E -->|是| Y[输出一个基础种类及两层路径]:::action
  X --> Z([按原槽位返回判断与证据]):::success
  Y --> Z
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

这是真正的先粗后细计算。大类未通过时没有 leafScores。大类通过时，leafScores 只含该大类的细类。数组只是多次单节点计算，保留顺序、长度和重复引用。

进入分类器且观测可用的节点，语义标签始终是 11 个具体类别之一或 `other`。`unknown/conflict` 是判断状态，不是额外语义类别。当前未识别或证据冲突的节点输出 `other`，同时保留评分路径。上游排除、跳过或不可用项不属于已分类输入，标签仍为 null，不能用 other 掩盖采集失败。

## 输入与观测边界

公开节点接收现有 CandidateBatch，可在同一个对象增加 `itemObservations` 数组。既有候选链的输出可直接输入；未提供补充观测时，相关测量保持 null。补充项用 nodeRef 关联，不能覆盖 tag/role 或候选资格。tag/role 来自 batch.observation.nodes，几何与父子关系也只读取这份显式快照。引用不作为数值特征。

补充观测只允许 nodeRef、inputType、hrefPresent、contentEditable、directTextPresent、childElementCount、positiveAreaChildCount、repeatedChildGeometry、inVerifiedListParent。省略或 null 表示未测；false 和 0 表示明确测到不存在。计数只能来自完整的直接子元素观测，不能把截断快照中的条数当作完整数目。

- inputType 是采集器读取的 input.type 规范值；未读取为 null。浏览器默认 text 应显式提供 text。空字符串保持未知。
- hrefPresent 表示 href 属性存在，空 href 也为 true；不接受原始 URL。
- directTextPresent 只描述直接 Text 子节点是否有非空白文字，不读取或推导 aggregate textContent。
- positiveAreaChildCount 在直接子元素及其几何测量完整时提供。任一缺失就为 null。
- repeatedChildGeometry 描述完整直接子元素几何是否重复。它不证明语义列表。初版由调用者明确测量，本算法不发明布局采集器。
- inVerifiedListParent 描述直接父节点是否有 ul/ol/dl 或 list/feed/menu/tablist 声明。它不是第二轮模型历史判断。

未知字段拒绝。class/id/名字/正文/URL/根路径/深度不进入分类器。现有采样学生白名单不变。disabled/hidden 等状态只从已白名单观测读取。所有合格输入统一提取 wire 并评分；SVG、hidden、presentation/none 或 hidden input 都不能直接导致提前返回。基础种类不证明可点击、可操作或无遮挡。

## 数值 wire 与缺测

命名 wire 由 native tag、role、可编辑属性和局部组合条件构成。原子输出为 0、1 或 null。条件不适用时为 0；适用但未测时为 null。例如 input 类型三支路在 type 缺失时均为 null；非 input 节点均为 0。role=null 表示没有可用角色证据，不推测一个隐藏角色。contentEditable 缺测仅在 div/span 的可编辑支路产生不确定性。几何组合只用于中性 div，避免影响明确的原生控件。

`role_presentational`、`input_type_hidden`、`state_disabled`、`state_hidden` 是显式可配评分 wire。默认系数为 0，因为当前没有证据证明这些状态应改变基础种类；例如隐藏按钮仍可能是按钮。它们的值和缺测保留在 wires，完整系数保留在 profile。自定义非零系数会进入相同的区间计算，没有独立否决通道。原子属性的适用范围与具体类别裁决分开；任何单一属性都不硬返回一个类别或排除结果。

每个目标 c 有稀疏权重 w。初始权重手写，范围 [-1,1]。不加隐式 bias。对每个 wire x：

```text
lower(c) = clamp(sum(w*x for observed x) + sum(min(w,0) for missing x), 0, 1)
upper(c) = clamp(sum(w*x for observed x) + sum(max(w,0) for missing x), 0, 1)
```

该区间描述未知 wire 在 [0,1] 变化时的分数边界。它不是统计置信区间，也不是贝叶斯后验。相关 wire 的独立边界可能较宽，初版允许保守弃判。

每层先按 lower 排序。默认 minScore=0.60、minMargin=0.15。最高 lower 未达门限则 unknown；两类 lower 均达门限但间隔不足则 conflict；有竞争目标 upper 足以破坏胜者间隔则 unknown；否则选胜者。单候选类的竞争分数为 0。缺测仍留在 evidence.wires 与 activeTerms 中，不被改写为观测零。

默认稀疏系数由 `DEFAULT_BASIC_KIND_PROFILE` 单一维护。native 控件/图片/列表支持为 0.85，音视频为 0.90，明确文本/结构为 0.80，role 为 0.75~0.80。链接由 anchor(0.45)+href存在(0.35)组合；span 文本由 span(0.20)+直接无元素子节点(0.20)+直接文字(0.35)组合；div 容器由 div(0.25)+至少两个正面积直接子节点(0.45)组合，并由重复几何(-0.20)和列表父级(-0.45)抑制。重复几何单独最多支持 list 0.45，不能过默认门限。具体所有系数、候选 wire 和实际贡献都可从公开 profile 与每次输出读取。

## 输出与训练接点

每项保留 index、nodeRef、candidateStatus、candidateReasons、familyStatus、family、familyScores、judgmentStatus、basicKind、leafScores、score、margin、reasons、evidence。evidence 含 wire、缺测、实际权重项和两层决策路径。filtered_out/skipped 转为 excluded，上游 unknown 保持不可用，不能因补充属性而复活。输出只保留受限诊断，不透传原始观测。

`confidenceState=uncalibrated`，`calibratedConfidence=null`。数字分数不称为准确概率。未来训练可调整显式 profile 的 familyWeights/leafWeights，并用缺测 mask 学习部分证据下的权重。此次只实现一个 TypeScript 前向算法，不实现训练、Handwired 加载、梯度或校准。后续接 Handwired 时要保持相同 I/O 和 wire 意义，再验证前向与梯度；不能把当前可配参数声称为已训练网络。

示例：button hidden/disabled→control/button；input 缺 type→control/other 且判断状态 unknown；img role=button→大类 conflict，标签 other；a 缺 href 测量→other；div 只有重复几何→other；span 直接文字与零元素子节点均已测→text/text。SVG 默认按支持分数不足返回 other，补充 role=img 后可以沿媒体支路判为 image，没有按 SVG 名字提前否决。

`other` 是当前已知类别之外或尚不能消歧的残余标签，不伪造其数值置信度：score/margin 仍为 null，具体类别的分数区间仍完整可审计。预测 other 不能直接成为黄金 other 或训练负例。训练标签须由 teacher/人工确认，监督映射由训练任务负责。

当前标签集合对合格输入全覆盖，不等于已证明主流网站/主流页面的经验覆盖。新增种类时更新 BASIC_KIND_FAMILIES、所需的允许 wire 和 profile，保持框架核心不变；复核历史 other 中属于新类的样本，再做旧类与新类的来源隔离回归。新类别不能只改标签名而继续使用缺少该类别行的旧参数。当前没有运行增量训练。

旧微博快照缺 fragments/clippedRect。沿候选链保留 605 filtered_out、528 skipped、867 unknown，零合格分类。纯函数可另做属性诊断，但不能宣称这些是 workflow 合格结果或准确率。
