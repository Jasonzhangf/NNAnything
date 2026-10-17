# 真实参数与权重 Profile 唯一存放处 (training/weights/)

本目录为 NNAnything 项目所有可训练节点真实参数与权重 Profile 的**唯一合法存放位置**。

## 1. 结构与生命周期规范

1. **Profile 唯一性**：训练产出的权重文件（如 `*.weight.json`）统一保存在本目录下，供运行时工作流配置通过 `profileId` 显式引用加载。
2. **内容构成**：一个标准的权重 Profile 包含：
   - `profileId`：在调用者本次显式资源映射内唯一的 profile 标识，不建立全局注册表；
   - `targetOperator` 与 `contractVersion`：绑定的目标算子与契约版本；
   - `parameters`：数值参数矩阵或权重数组；
   - `calibration`：校准状态、阈值及置信度映射表（若未校准则显式标为 `uncalibrated`）；
   - `provenance`：拟合所用的样本集引用与基础 profile 引用。
3. **不可静默覆盖**：严禁自动覆盖已有 profile 文件。每次新的训练拟合生成新的独立 profile 文件；新拟合参数使旧校准状态自动失效。
4. **代码解耦**：禁止将权重硬编码进 TypeScript 源码（如 `lib/nodes/trainable/`），亦禁止在 `training/results/` 中重复堆积权重。

## 2. Git 忽略

本目录下所有权重 profile 资产均受 `.gitignore` 保护，本地保留，不入版本控制。本 `README.md` 纳入版本库作为规范基准。
