# NNAnything

以 filter 为基础节点、用事件传递输入输出、通过节点接续组合 workflow 的框架。画布、配置文件或代码都是可选的编辑方式。应用和训练共用节点/workflow 合同，各自保留 I/O 语义。黑白名单、DOM 拆分、判断与 operation 均由节点组合，不固定进核心。第一个实验方向是网页 DOM 的结构化候选与语义识别。

当前 L1 已实现，通过作者验收与独立 Gemini 4 整体 Review。验收与交付结果见项目 [note.md](note.md)。

## 快速开始（L1 能动切片）

基线要求：Node.js >= 20（ESM 模块规范）。

```bash
# 安装依赖
npm ci

# 构建 TypeScript 源码
npm run build

# 类型检查
npm run typecheck

# 运行公开测试
npm test

# 运行基础核心公开 Consumer（非 DOM 事件流与调度）
npm run demo

# 运行浏览器候选公开 Consumer（离线页面观测与 7 节点候选链路）
npm run demo:browser
```

- 浏览器 Consumer 固定入口为 playground/browser/demo.mjs，负责完整演示保存观测加载、7 节点有限图编译运行及保序候选槽位输出。
- 公开 API 包含主入口 nnanything（事件模型、配置加载与编译执行基座）与浏览器子入口 nnanything/browser（7 个手写 DOM 算子定义）。

## 架构职责与 7 个候选节点

- DAGpipe：负责项目图拓扑静态检查与 SESE（单入口单出口）校验。公开图唯一真源集中于 `workflows/`（如 [dom-candidates.graph.json](workflows/dom-candidates.graph.json)）。
- Flowed (v1.15.0)：负责有限事件 DAG 的动态调度与异步扇入执行，保证每个 ARC 单次运行产出确定状态事件，单次运行有穷结束。
- L1 七个手写节点：
  1. dom.observe：读取保存的页面观测，保留必要几何、结构与安全属性，不传播原始 class、账号或正文。
  2. dom.viewport：正面积相交计算视口候选，父容器离屏不误剪可见后代。
  3. dom.focus：按 within 与 region 收缩关注范围，范围失效报 stale_scope，无依据不冒充 owned。
  4. dom.deny：评估黑名单规则，deny 优先于 allow，记录排除原因且不生成训练负标签。
  5. dom.allow：评估白名单规则，未配置不限制，显式空集合拒绝全部。
  6. dom.split：按 DOM 层级展开候选项，显式 nodeRefs 保持保长保序。
  7. dom.candidates：复检展开项规则，输出保序槽位与排除映射，不调用神经网络。

L1 边界：只交付手写候选过滤与执行基座。不包含语义分类（如 post.card、广告、推广）、不包含模型训练/校准/Handwired 后端、不包含活体浏览器操作、不包含画布与跨站泛化。

## 文档导航

### 1. L1 当前运行契约与使用指南
- [L1 浏览器候选切片使用指南](docs/l1-usage.md)
- [L1 能动切片目标与约束](docs/goals/l1-browser-candidates.md)
- [工作流清单与拓扑真源 (workflows/)](workflows/README.md)
- [L1 候选图真源 (7N6E SESE)](workflows/dom-candidates.graph.json)
- [节点定义与合同清单 (lib/nodes/)](lib/nodes/README.md)
- [可复用经验节点合同](docs/node-contract.md)
- [Workflow基础配置](docs/workflow-config.md)
- [Viewport、Focus、白黑名单与单标签合同](docs/focus-and-labeling.md)

### 2. 实施计划与工程治理
- [总体设计与分阶段计划](docs/design.md)
- [目录、首批节点与实施计划](docs/implementation-plan.md)
- [推进节奏、治理、交付与审批](docs/project-governance.md)
- [本轮Framework M1范围与验收](docs/framework-m1.md)

### 3. L2+ 长期设计与调研（后续计划，非当前交付）
- [Filter节点与统一Workflow](docs/node-workflows.md)
- [画布、事件输入输出与基础节点](docs/canvas-events.md)
- [现成Workflow框架选型依据](research/workflow-engines.md)
- [结构化分类与查询合同](research/semantic-query-contract.md)
- [成分与关系阶段边界](research/compositional-recognition.md)
- [浏览器双模式与监督回归](research/browser-semantic-modes.md)
- [Handwired 卡片数值连线草案](research/filter-wiring-audit.md)
- [GitHub 项目与训练锚点](research/github-semantic-anchors.md)
- [Gemini 4 整体评估及修订结果](docs/reviews/gemini4-design-review.md)
- [D0增量设计复核原始结果](docs/reviews/gemini4-d0-incremental-review.json)
