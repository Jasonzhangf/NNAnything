# NNAnything

以 filter 为基础节点、用事件传递输入输出、通过节点接续组合 workflow 的框架。画布、配置文件或代码都是可选的编辑方式。应用和训练共用节点/workflow 合同，各自保留 I/O 语义。黑白名单、DOM 拆分、判断与 operation 均由节点组合，不固定进核心。第一个实验方向是网页 DOM 的结构化候选与语义识别。

当前候选 7 节点、采样 3 节点与第一层 DOM 基础种类节点保持已交付。当前增量为第一层基础种类六节点离线训练框架（training.prepare / partition / fit / compare / assess / report @ 0.1.0）、6N6E SESE 训练工作流图与持久配置（绑定 0.1.0）、真实 Handwired 数值图反传与 Adam 优化器、TypeScript 动态源码加载器、公开训练 consumer 及已有 158 条复核样本的拟合试验证据。保存的候选 profile 绝不自动采用；第二层业务卡片组合语义（帖子、作者、评论、广告等）、WebUI、Rust 实现仍为后续规划。验收与交付结果由 parent 维护于 [note.md](note.md)。

新增 Chrome/Chromium 页面标注与采集入口，复用上述第一层分类器。支持类别色框、Focus、点选确认/纠错、未知批量采集和本地 JSON 导出。扩展构建与加载步骤见 [extension/README.md](extension/README.md)，节点与证据边界见 [docs/browser-overlay-m1.md](docs/browser-overlay-m1.md)。采集不会自动训练。

独立 CLI 基础入口为 `nnanything/cli`，从显式工作目录、pwd、纯路径解释和文件属性开始。运行 `npm run demo:cli` 可验证三项公开能力。合同和后续 help 学习范围见 [CLI 基础语义](docs/cli-foundation.md)。当前不包含搜索或训练；原生 Computer use 仅文档占位。

首个函数表达训练现由独立 `nnanything/cli-training` 提供：`cwd+input→词法绝对路径`。公开合成样本64train/16development/32holdout，真实Handwired动作拟合和新进程回载；运行 `npm run demo:path-training -- --handwired-root /absolute/handwired`。见 [路径训练合同与实测](docs/cli-path-training.md)。该模型不自动采用，也不替换CLI基础入口。

## 快速开始（L1 能动切片与离线训练）

基线要求：Node.js >= 20（ESM 模块规范）。测试环境已验证 Node 22（Bun 未经验证）；TypeScript 为已安装的 devDependency。

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

# 运行基础规则采样公开 Consumer（离线 DOM 记录规则匹配、样本组装与安全持久化）
npm run demo:sampling

# 运行基础种类公开 Consumer（离线合成候选数据与单节点工作流运行）
npm run demo:basic-kinds

# 运行基础种类离线训练公开 Consumer（6 节点工作流、Handwired 拟合与回载复核）
npm run demo:training -- --handwired-root <path-to-handwired>
```

- 浏览器 Consumer 固定入口为 playground/browser/demo.mjs，负责完整演示保存观测加载、7 节点有限图编译运行及保序候选槽位输出。
- 采样 Consumer 固定入口为 playground/sampling/demo.mjs，负责演示离线语义规则匹配、单任务训练样本组装与安全 JSONL 持久化（见 [playground/sampling/README.md](playground/sampling/README.md)）。
- 基础种类公开 Demo 入口为 npm run demo:basic-kinds，使用标准的 1 节点图与完整合成候选数据离线运行（见 [playground/basic-kinds/README.md](playground/basic-kinds/README.md)）；可选 --input 参数接收已保存的候选 batch。纯属性诊断调用不属于工作流合格分类。
- 离线训练公开 Demo 入口为 npm run demo:training（见 [playground/training/README.md](playground/training/README.md)）。默认使用合成样例数据（故意弱化基础参数以演示拟合）；`--input` 接入真实复核数据时使用真实手写基础权重；必须通过 `--handwired-root` 或 `HANDWIRED_ROOT` 环境变量显式指定 Handwired 源码根目录；输出根默认指向仓库内 `training/` 目录树（每次运行生成唯一 runId 资产）。
- 公开 API 包含主入口 nnanything（事件模型、配置加载与编译执行基座）、浏览器子入口 nnanything/browser（7 个手写 DOM 算子定义、3 个采样算子、基础种类算子 domBasicKindsNode、纯函数 classifyBasicKind、classifyBasicKindBatch、validateBasicKindProfile、默认配置与手写 profile）、以及训练子入口 nnanything/training（6 个训练算子工厂 createTrainingNodeDefinitions、多分类样本与请求校验器、分区/比较/评估/报告辅助函数及 loadTrainingProfiles）。

## 架构职责与已实现算子

- DAGpipe：负责项目图拓扑静态检查与 SESE（单入口单出口）校验。公开图唯一真源集中于 `workflows/`（如 [dom-candidates.graph.json](workflows/dom-candidates.graph.json)、[dom-rule-sampling.graph.json](workflows/dom-rule-sampling.graph.json)、[dom-basic-kinds.graph.json](workflows/dom-basic-kinds.graph.json)、[node-training.graph.json](workflows/node-training.graph.json)）。
- Flowed (v1.15.0)：负责有限事件 DAG 的动态调度与异步扇入执行，保证每个 ARC 单次运行产出确定状态事件，单次运行有穷结束。
- L1 七个候选节点：
  1. dom.observe：读取保存的页面观测，保留必要几何、结构与安全属性，不传播原始 class、账号或正文。
  2. dom.viewport：正面积相交计算视口候选，父容器离屏不误剪可见后代。
  3. dom.focus：按 within 与 region 收缩关注范围，范围失效报 stale_scope，无依据不冒充 owned。
  4. dom.deny：评估黑名单规则，deny 优先于 allow，记录排除原因且不生成训练负标签。
  5. dom.allow：评估白名单规则，未配置不限制，显式空集合拒绝全部。
  6. dom.split：按 DOM 层级展开候选项，显式 nodeRefs 保持保长保序。
  7. dom.candidates：复检展开项规则，输出保序槽位与排除映射，不调用神经网络。
- 基础规则采样三节点：
  8. sample.match：纯三值逻辑语义规则匹配，单项单语义分类，隔离 teacher 与学生特征。
  9. sample.assemble：单任务训练样本组装，按任务映射正负监督并保留原始语义分类。
  10. sample.save：独占排他（wx）持久化 JSONL，受限根目录与防越界安全检查。
- 第一层 DOM 基础种类节点：
  11. dom.basic_kinds：接收候选槽位与可选补充观测，执行两阶段（大类 -> 细类）确定性基础种类判断，输出保序槽位、分数区间、决策路径与审计证据。
- 基础种类离线训练六节点：
  12. training.prepare：准备多分类复核样本与学生观测投影，区分 candidate_qualified 与 properties_offline 范围。
  13. training.partition：按 snapshot/post/asset 来源闭包分组划分训练与评估用途，支持 source_group_holdout。
  14. training.fit：通过 Handwired Circuit evaluate/backprop 真实反传与 Adam 优化器拟合稀疏权重参数，输出候选 profile 与轨迹。
  15. training.compare：在相同样本上调用正式前向分类器逐例比对新旧输出（fixed/regressed/retained/unresolved/unassessed）。
  16. training.assess：评估指标改善、黄金样本退化与证据不足边界。
  17. training.report：独占写入候选权重 profile（*.weight.json）与训练报告（*.result.json），声明 filesystem.write。

边界说明：当前包含手写候选过滤、基础离线规则采样、第一层基础种类算法与六节点离线训练闭环。初始与候选参数保持未校准，不冒称概率；重新拟合使旧校准失效，候选不自动采用。已运行三站跨页评估及用户随后授权的MAP式增量实验，训练与留出分开，结果见下方实验记录。尚无第二层业务语义模型、WebUI、Rust、浏览器动作节点或跨站效果保证。

## 文档导航

### 1. L1 当前运行契约与使用指南
- [L1 浏览器候选切片使用指南](docs/l1-usage.md)
- [L1 能动切片目标与约束](docs/goals/l1-browser-candidates.md)
- [基础规则采样公开 Consumer 说明](playground/sampling/README.md)
- [第一层基础种类公开 Consumer 说明](playground/basic-kinds/README.md)
- [第一层基础种类离线训练公开 Consumer 说明](playground/training/README.md)
- [第一层DOM基础种类数值连线与算法设计](docs/basic-kinds-wiring.md)
- [第一层基础种类离线训练 workflow 设计与验收](docs/training-workflow.md)
- [真实训练、六页评估与MAP式增量实验](docs/training-m1-results.md)
- [工作流清单与拓扑真源 (workflows/)](workflows/README.md)
- [L1 候选图真源 (7N6E SESE)](workflows/dom-candidates.graph.json)
- [基础采样图真源 (3N2E SESE)](workflows/dom-rule-sampling.graph.json)
- [第一层基础种类图真源 (1N0E SESE)](workflows/dom-basic-kinds.graph.json)
- [基础种类离线训练图真源 (6N6E SESE)](workflows/node-training.graph.json)
- [节点定义与合同清单 (lib/nodes/)](lib/nodes/README.md)
- [训练算子与适配实现目录说明 (lib/training/)](lib/training/README.md)
- [真实权重资产目录说明 (training/weights/)](training/weights/README.md)
- [可复用经验节点合同](docs/node-contract.md)
- [Workflow基础配置](docs/workflow-config.md)
- [优先级分类器、训练对照与规模计时](docs/priority-classifier.md)
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
