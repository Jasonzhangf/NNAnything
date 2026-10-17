# 离线 DOM 候选 consumer

从项目根目录运行：

```sh
npm run build
node --test tests/browser*.test.mjs
node playground/browser/demo.mjs
```

demo 从公开 `nnanything` 和 `nnanything/browser` 加载 API。它读取本目录的合成观测与 `workflows/dom-candidates.workflow.json` 配置。配置只保存一份 `configs.focus`，通过 `configRef` 绑定规则节点。节点和边只从 `workflows/dom-candidates.graph.json` 加载。Flowed 负责运行，不在 consumer 中调度节点。

输入事件类型由 `DOM_CANDIDATE_REQUEST_EVENT_TYPE` 提供。payload 为 `{ observation, nodeRefs? }`。省略 `nodeRefs` 时输出 DOM 前序槽位，包括容器、后代和排除记录。显式数组保持长度、顺序和重复，不添加后代。

输出的 `candidateRefs` 对应 `status: "ok"` 槽位。其他槽位保留 `index`、`nodeRef`、`status`、`reasons` 和几何证据。零面积节点只跳过自身。`deny` 只排除命中节点；`excludeSubtrees` 排除命中节点及其全部 DOM 后代，但保留这些槽位的映射。`allow` 省略表示无限制，`allow: []` 拒绝剩余候选。未知或已排除的槽位不会被后续规则恢复。

`within` 使用 DOM 容器引用；`scopeMode: "subtree"` 使用祖先关系。失效引用返回 `unknown/stale_scope`。当前保存观测适配器没有语义归属测量，因此 `scopeMode: "owned"` 返回 `unknown/unsupported_scope`。这两个范围问题通过七节点传到出口，不作为运行异常。

`region` 是 `{ x, y, width, height }` CSS 矩形，只缩小 viewport。规则对象中的字段用 AND，条件数组用 OR。可用字段为 `nodeRef`、`tag`、`role`、`attributes`。安全属性为 `aria-disabled`、`aria-expanded`、`aria-hidden`、`aria-selected`、`contenteditable`、`disabled`、`hidden`、`tabindex`。未测到的规则字段产生未知，不能推断它不匹配。空条件、空属性条件和脚本字段会被拒绝。

观测使用同一 viewport CSS 坐标系的 `rect`、实际 `fragments` 和测得的 `clippedRect`。只知道总外接框时，候选资格保留未知。`clippedRect` 表示测得的裁剪范围，不能从 overflow 声明推测。片段和裁剪必须有共同的正面积交集。适配器还接受保存观测中的 `index/parent`、`clientRects/visibleRect` 字段；`documentScroll` 不改变已在 viewport 坐标系中的测量。

候选资格不证明可点击、无遮挡或任何语义类别。本 consumer 不采集页面，不执行浏览器动作，也不加载模型或训练数据。
