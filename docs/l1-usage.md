# NNAnything L1 浏览器候选切片使用指南

当前 L1 已实现，通过作者验收与独立 Gemini 4 整体 Review。验收与交付结果见项目 [note.md](../note.md)。

## 1. 架构职责划分

L1 目标是在无须引入神经网络、模型训练或活体浏览器操作的前提下，交付首个浏览器场景的确定性 DOM 候选过滤可运行切片。项目拓扑真源直接引用 [dom-candidates.graph.json](../workflows/dom-candidates.graph.json)（7 节点 6 边单入口单出口 SESE 链）。

### 1.1 DAGpipe 职责：静态拓扑检查
- 唯一真源：项目图拓扑以 [dom-candidates.graph.json](../workflows/dom-candidates.graph.json) 为单一真源，集中于 `workflows/` 目录，禁止在业务代码中硬编码或分叉拓扑结构。
- 静态检查：DAGpipe 静态检查粗图拓扑（单入口单出口、有向无环、输入输出 ARC 对应），不证明运行时 NodeDefinition 领域 schema 和 effects 绑定；运行绑定由 compileWorkflow 校验。
- L1 拓扑规格：当前图为 7 节点、6 边、1 个输入 ARC（request）与 1 个输出 ARC（candidate_slots）的单链 SESE 结构。

### 1.2 Flowed 职责：有限事件 DAG 执行内核
- 调度内核：基于 flowed@1.15.0 调度，负责根据编译后的工作流定义调度节点执行。
- 事件接续契约：单次运行是有限的，每个 ARC 在单次运行中仅产生一个确定状态的事件（ok、skipped、filtered_out 或 unknown）。
- 异步扇入：仅当节点声明的所有输入端口对应的事件全部到达后才触发节点执行。
- 无第二调度器：不手写第二套流程引擎，不设全局隐藏状态。

## 2. 7 个候选手写节点与输入输出契约

L1 实现了 7 个各司其职、可独立复用且具有明确 I/O 的手写节点，按照如下链路接续：

| 节点 (Operator) | 输入 ARC | 输出 ARC | 核心职责与设计边界 |
| :--- | :--- | :--- | :--- |
| dom.observe | request | observed | 适配保存的页面测量，规范化 viewport、结构、tag、role 与几何；不传播原始 class、账号或正文。节点缺测保留未知，非法输入明确拒绝。 |
| dom.viewport | observed | viewport_slots | 按正面积相交计算视口候选槽位；保留部分可见元素；父容器离屏或零几何仅跳过自身，不误剪可见后代；不假定相交等于可点击。 |
| dom.focus | viewport_slots | focused_slots | 结合 within 容器与 region 矩形收缩范围；引用失效报 stale_scope；在无语义归属依据时显式报 unsupported_scope，禁止将纯 DOM 子树冒充为 owned。 |
| dom.deny | focused_slots | denied_slots | 评估黑名单条件；命中即排除并记录 deny_match 排除原因；跳过自身与排除子树严格分离，不生成模型负标签。 |
| dom.allow | denied_slots | eligible_slots | 评估白名单条件；deny 优先于 allow；未配置 allow 时不作限制，显式空集合 allow: [] 拒绝全部；被 deny 或离屏项绝不可复活。 |
| dom.split | eligible_slots | expanded_slots | 按 DOM 层级展开候选项，保留中间容器及后代；若显式指定 nodeRefs 数组入口，则严格按输入保序，不强制拆分展开。 |
| dom.candidates | expanded_slots | candidate_slots | 对展开项复用相同规则链进行复检，输出包含 index、nodeRef、status 与 reasons 的槽位集合；无神经网络调用，无假标签与假置信度。 |

## 3. 环境要求与标准命令

系统基线环境要求 Node.js >= 20，使用 ESM 模块系统。

```bash
# 1. 安装依赖
npm ci

# 2. 编译 TypeScript 源码到 dist/
npm run build

# 3. 运行静态类型检查
npm run typecheck

# 4. 运行公开测试套件
npm test

# 5. 运行非 DOM 公开 Consumer（验证核心执行基座与事件流）
npm run demo

# 6. 运行浏览器候选 Consumer（验证真实观测适配、7 节点拓扑与槽位过滤）
npm run demo:browser
```

npm run demo:browser 固定执行入口为 playground/browser/demo.mjs。该 consumer 负责串联离线页面观测加载、图编译、运行及输出保序候选槽位与排除映射摘要。

## 4. 公开 API 契约与装配流程

### 4.1 入口分工
- 主入口 nnanything (dist/index.js)：提供通用核心事件模型与工作流生命周期 API（createWorkflowInputEvent、createEventEnvelope、compileWorkflow、runWorkflow、loadWorkflow 及相关 TS 类型）。
- 浏览器子入口 nnanything/browser (dist/browser.js)：提供浏览器场景所需的 7 个节点定义（NodeDefinition）及相关观测适配器。

### 4.2 工作流装配与执行步骤
装配与执行完整流程包含以下步骤：
1. loadWorkflow({ configPath, allowedRoot })：加载声明式工作流配置并解析图引用与节点配置绑定；亦可直接以 WorkflowDefinition 对象传入。
2. compileWorkflow(definition, { nodeDefinitions, grantedEffects })：静态校验节点绑定、端口 schema、事件类型与授权副作用（grantedEffects）。
3. createWorkflowInputEvent({ runId, eventId, port: "request", type, correlation, payload })：构建单入口输入事件，port 对应输入 ARC request。
4. runWorkflow(compiled, inputEvent)：传入编译产物与输入事件，驱动 Flowed 有限 DAG 运行并获取 WorkflowRunResult。

完整调用见[浏览器 consumer](../playground/browser/demo.mjs)及其[输入与规则说明](../playground/browser/README.md)。它从公开包入口加载 API，实际运行页面模式与显式数组模式。

## 5. 经验积累与关键回归用例

根据 [可复用经验节点合同](node-contract.md)，节点的规则演进和手写经验通过确定性的反例和回归用例保留，而不是黑盒模型调优。L1 的重点回归反例包括：

1. 父容器跳过不误剪可见后代：外层容器因高度为 0、display: contents 或滚动视口外被跳过自身时，仅跳过容器本身，仍必须继续遍历并保留其位于视口内的后代元素。
2. Deny 优先于 Allow：同一元素若同时匹配黑白名单，严格以黑名单（deny_match）排除；未配置 allow 不作限制，显式空集合 allow: [] 拒绝全部目标。
3. 部分视口相交可保留：已测几何片段、裁剪范围与 viewport 有共同正面积交集时通过，不要求完整展现。只有总外接框时保留未知，不宣称精确可见。
4. 失效 Scope 与非法归属拒绝：within 节点不存在时报错 stale_scope；在没有明确语义归属证据时请求 scopeMode: "owned" 显式返回 unsupported_scope，防止偷换为普通子树。
5. 显式输入保长保序：调用方传入固定 nodeRefs 数组时，输出槽位必须与输入保持一一对应的长度和顺序，被过滤项保留 status: "filtered_out" 与具体 reason，禁止压扁数组。
6. 观测缺失保持 Unknown：离线快照若未提供实际裁剪（clipping）或几何片段（fragments），相关属性保留 unknown/unassessed，不向调用方伪造精确可见或可点击。

## 6. L1 明确边界与非目标

| 维度 | L1 能动范围 | L2+ 计划范围（非当前目标） |
| :--- | :--- | :--- |
| 核心算法 | 7 个手写几何/规则过滤节点 | 神经网络分类器、数值特征向量、单标签推断 |
| 后端机制 | Flowed 1.15.0 事件调度 | Handwired 数值后端、梯度反传、校准投影 |
| 输出语义 | 候选引用、状态（ok/filtered_out/skipped/unknown）、排除原因 | 语义标签（post.card、广告、推广等）、confidence、isTarget |
| 浏览器环境 | 消费离线已保存的结构化观察 JSON | 活体浏览器连接、CDP 自动化、模拟点击/滚动、页面抓取 |
| 交互呈现 | 命令行 CLI (npm test / npm run demo:browser) | 可视化节点画布、图形界面 |
| 泛化能力 | 单一任务场景下的严格规则复现 | 跨站点通用适配、自动语义对齐 |

