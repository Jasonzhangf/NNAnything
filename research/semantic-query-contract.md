# 结构化语义分类与查询合同

状态：待审设计，未实现。语义检索输入采用固定分类和结构字段；运行时不要求 LLM、自然语言解释或文本向量检索。

## 分类目录

以下名称是跨站目标类型，不包含站点名、DOM class/id 或实际账号名。站点适配由所选 profile 处理。点号表示分类命名空间，不表示 DOM 路径或祖先关系；不能据此前缀隐式推导其他标签。

| target | 规范节点边界 | 默认读取值 |
| --- | --- | --- |
| post.card | 完整帖子结构，含普通、广告、推广或推荐 | 无 |
| post.card.organic | 完整普通信息流卡片，排除本实验确认的广告/推广/推荐 | 无 |
| post.card.advertisement | 有证据确认的平台广告完整卡片，包括图片广告标记 | 无 |
| post.card.promotion | 有证据确认的商业推广、促销或导流完整卡片 | 无 |
| post.card.recommendation | 有荐读或社交推荐来源证据的完整卡片 | 无 |
| post.author.name | 某帖作者名称的文本元素 | text |
| post.author.avatar | 某帖作者头像的图像元素 | 无 |
| search.input | 搜索查询实际输入元素 | value |
| account.self.entry | 当前用户个人主页的操作入口 | 无 |
| post.body | 某帖正文区域 | text |
| post.body.text | 正文文字块的元素 | text |
| post.body.image | 正文图片元素，排除头像与状态徽标 | 无 |
| post.body.video | 视频元素或已声明的播放器边界 | 无 |
| post.body.link | 正文链接操作元素 | 无 |
| post.repost.entry | 帖子的转发入口 | 无 |
| post.like.entry | 帖子的点赞入口 | 无 |
| post.comment.item | 帖子的单条评论容器 | 无 |
| post.comment.entry | 某帖打开或聚焦评论的操作入口 | 无 |
| post.body.expand | 某帖展开折叠正文的操作入口 | 无 |
| navigation.entry | 页面或路由跳转的操作入口 | 无 |

目标是多标签集合。同一操作节点可同时命中 post.author.name 和 navigation.entry；头像图像与其可点击父链接是不同节点，不能因为同属一个头像区域就混用目标引用。界面状态与操作能力不塞进目标名称：例如 visible、enabled、expanded 是状态，click、fill 是动作。

广告和推广识别后保留具体卡片引用及对应标签，不能因为普通帖子 filter 返回 false 就从浏览器语义结果中丢弃。平台广告也可以同时是商业推广；荐读/社交推荐不自动证明商业推广或付费广告。对 organic 为 false 也不能反推出另外三个类别为 true，必须有各自的识别依据。未标定或证据不足的类别保持未知。

浏览器层可按同一 nodeRef 汇集多个 filter 的分类结果，每项保留独立 confidence。查全部广告可用 target=post.card.advertisement、cardinality=all；查推广使用 post.card.promotion。同一卡片在组合操作中由外部程序去重，filter 不承担去重或动作。识别不隐式触发隐藏、点击关闭、举报或其他操作；操作调用按分类显式选择目标。

每个 target 对应一份可审计的单节点 filter 合同、标签边界、输入和数值连线。已有 filter 输出仍为 `{ isTarget, confidence }`，不改成让 filter 从页面中生成 target 字符串。调用程序知道当前调用哪个目标的 filter，并关联 target 与 nodeRef。

## 查询字段

成分、归属关系与分阶段参数见 [成分与关系](compositional-recognition.md)。第一阶段使用可测关系，第二阶段增加邻近节点历史语义判断；目标目录不表示这些 filter 已实现。基础成分与业务目标的外部参考见 [GitHub 训练锚点](github-semantic-anchors.md)。

| 字段 | 类型或取值 | 含义 |
| --- | --- | --- |
| target | 分类目录中的固定字符串 | 必填，按类型精确匹配 |
| within | nodeRef，可省略 | 作用范围；缺省为当前文档，元素范围包含自身和后代 |
| cardinality | one / all | 必填；one 必须恰好有一个合格结果，多个结果返回歧义 |
| where.visible | boolean，可省略 | 查询时对当前可见状态做结构化筛选 |
| where.enabled | boolean，可省略 | 查询时对当前可用状态做结构化筛选 |

阈值由已选 profile 的合同声明。查询不临时修改阈值，以免不同调用悄悄改变目标边界。within 只限制外部候选与解析范围，不作为节点身份特征输入网络。首轮用作用范围表达“属于哪一帖”，不另建通用关系查询语言。

找搜索框：

```json
{
  "target": "search.input",
  "cardinality": "one",
  "where": { "visible": true, "enabled": true }
}
```

找已识别帖子中的评论入口：

```json
{
  "target": "post.comment.entry",
  "within": "node:42",
  "cardinality": "one",
  "where": { "visible": true, "enabled": true }
}
```

node:42 是说明合同的示例引用，不是当前浏览器中的真实节点。实际引用由浏览器适配器分配，绑定当前文档/框架。它不要求包含根路径，也不进入训练。

## 返回与动作

```json
{
  "status": "ok",
  "matches": [
    {
      "target": "post.comment.entry",
      "nodeRef": "node:57",
      "confidence": 0.94
    }
  ]
}
```

示例分数只是接口示意，不是实测。confidence 是对应目标的分数，不承诺不同 filter 的未校准分数可以相互比较。

| status | 含义 |
| --- | --- |
| ok | one 恰好一个命中，或 all 有一个及以上命中 |
| not_found | 没有合格结果 |
| ambiguous | one 查询有多个合格结果；返回候选，不静默取最高分 |
| unsupported_target | 分类未知，或当前 profile 未提供该目标能力 |
| stale_scope | within 引用已失效，需要重新解析 |

all 可按当前 DOM 顺序返回，不赋予它额外语义排名。查询只返回节点，读取和动作使用独立结构接口。例如定位 post.author.name 后读取 text；定位 search.input 后执行 fill。读取值可以含真实姓名，训练特征仍排除账号身份。动作失败使用动作结果合同，不混入上述检索状态。

## 非 LLM 检索的执行方式

调用程序按 target 选择对应 filter 与 profile，枚举范围内的节点，取参，逐节点评分并按结构字段筛选。可将当前识别结果暂存为 target 到节点引用集合，供重复查询复用；首轮不要求持久索引。页面变化后按需重新识别，不能把旧引用当作当前元素。

这一过程使用固定字段比较、数值推理和 DOM 引用解析。LLM 参与目标设计、标定和错误分析；若调用者输入自然语言，可以在外层将其转换成上述查询。结构化调用者直接查询，无需调用 LLM。

## 训练标签与纠错字段

标签主键含样本引用、节点引用和 target；truth 为 true、false 或 unknown。未标定保持 unknown。同一节点可以对不同 target 具有不同 truth。

纠错按固定字段记录：target、scopeRef、predictedNodeRefs、expectedNodeRefs、errorType。errorType 初拟为 false_positive、false_negative、wrong_boundary、ambiguous、stale_node、candidate_miss、action_failed；错误原因未明确时使用 unknown，不自动形成训练标签。没有目标时 expectedNodeRefs 为空数组；尚不知道正确目标时该字段缺省，不能把这两种情况混用。

LLM 可另存标定说明作为证据。说明文字不进入查询匹配或 filter 输入。非 LLM 程序可以提交纠错记录，再沿 browser-semantic-modes.md 的核实、重拟合和独立回归路径处理。
