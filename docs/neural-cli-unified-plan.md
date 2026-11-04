# NNAnything 统一决策目标与设计入口（新主线）

状态：目标与设计落盘，未实现、未训练、未恢复确定性产品。
日期：2026-11-04 PDT
唯一设计稿：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/unified-decision-design.html`
派单合同：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/unified-replan-dispatch.md`
当前项目 master：Jenny（本会话）。

## 目标

模型只完成当前一次决策；推理引擎维护 Goal 生命周期，推进拆解、执行、观察与下一步。

- 统一 64 维输入、两层隐藏层起步（隐藏层宽度仍为设计假设，不是已验收结构）。
- 同一推理代码按显式领域/职责/输入合同/模型版本路由加载兼容权重包。
- 动态技能选项与类型化参数绑定；每候选独立子 Goal；候选数变化不改变输出维。
- 训练与推理复用同一 encoder/forward/decoder；集合 loss 在合法候选组上归一化。
- D/R/E/A 保留为决策职责与可选路由键，不再默认五套异构输入网络。

## 授权与边界

- 用户最新授权：立即拆分任务、Jenny 落盘目标/设计/board、按语言独立 owner 并行准备语料。
- Alice 审计已明确：`emma-neural-cli-design-refinement.md` §1.9 原始语料准备可独立分发；结构诊断与正式训练仍不准入。
- 正式训练、产品恢复、确定性 nn-code 安装与调用恢复仍未批准。整改 gap 须独立监理复核并经用户明确审批后才执行。
- 旧确定性 calls/symbols/value-flow 产品路线停用，仅保留离线 proposal/baseline 与失败证据。

## 旧任务 superseded 映射

| 旧方向 | 新状态 |
| --- | --- |
| 五网络异构 spec（Rust+TS 首轮混训） | 作废；改为统一单步决策、TS/JS 首训 |
| 逐方向整图器 calls/symbols/value-flow 作为运行模型 | 降级为离线 proposal/baseline |
| 训练、自动采样、浏览器/值流产品推进 | 停工保留证据，不重启 |
| 旧五网络隐藏层宽度 | 取消默认 64；候选宽度待开发集选择 |

## 新任务责任与合同

| Owner | 任务 | 状态 | 依赖 | 交回文件 |
| --- | --- | --- | --- | --- |
| Alice | 统一架构 owner、设计审计、跨模块冲突消除 | 进行中（只读/设计） | 收到 Emma 交回即处理 | 本派单与统一架构稿 |
| Emma | 统一 64 维模型、动态技能/参数编码、单步 loss；TS/JS 原始语料 | 进行中（设计+语料） | 无 | `emma-unified-decision-contract.md` |
| David | 解析器→统一候选→候选子 Goal 适配详细接线 | 只读/文档 | 源码只读 | `david-candidate-goal-wiring.md` |
| Frank | 独立验收用例合同与历史证据盘点 | 已交回 | 无 | `frank-unified-acceptance-contract.md` |
| Bob | 日志/失败语料来源提炼（不调用停用 CLI） | 只读/文档 | 无 | `bob-log-corpus-gap.md` |
| Jenny | 目标/设计落盘、board 关联、容量/依赖调度、语料执行分派、集成管理 | 进行中（本文档） | 无 | `jenny-unified-plan-receipt.md` |

## 语言语料准备（Emma §1.9，已获准入）

- 每个语言只写 `training/samples/neural-cli/<language>/` 下自己的子目录；其他语言必须先在 `README.md` 写明 owner。
- 目录物理分离：`episode/`、`labels/`、`evidence/` 与 `student-rows/` 必须是独立目录与文件；fitter 只读 `student-rows/` 与显式允许字段。
- 学生特征行待 schema 定稿后再生成；原始 episode、标签、来源记录与分区先准备。
- 实际使用语料必须提交版本控制（`.gitignore` 已对 `training/samples/neural-cli/` 最小豁免）；未提交或未获批的本地语料不得进入训练。
- 每语言交回一个 `corpus-readiness-v1.json`；未达标交 `incomplete`，只停该语言。
- TS/JS 首轮 owner 为 Emma；其他语言先在 `README.md` 指定 owner。

## 未闭合缺口

- 64 维逐字段编码合同、技能能力/参数词表、实际路由条目、固定停止条件尚未定稿。
- 集合 loss 与反向传播的具体聚合接线未实现。
- 各语言 `corpus-readiness-v1.json` 尚无实际交回；当前仅 TS/JS 有空的目录骨架。
- 正式训练/产品恢复待用户明确审批。

## 文档归属

- 本文件为新主线目标入口，补充而非替代 `docs/design.md`、`docs/model-evolution.md`。
- 历史证据保留在 `note.md` 与 `research/`、各研究回执中，不销毁源码、语料、权重或失败证据。
