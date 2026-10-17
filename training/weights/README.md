# 真实参数与权重 Profile 唯一存放处 (training/weights/)

本目录为 NNAnything 项目所有可训练节点真实参数与权重 Profile 的**唯一合法存放位置**。

## 1. 结构与生命周期规范

1. **Profile 唯一性**：训练产出的权重文件（如 `*.weight.json`）统一保存在本目录下，供运行时工作流配置通过 `profileId` 显式引用加载。
2. **内容构成**：一个标准的权重 Profile 包含：
   - `profileId`：在调用者本次显式资源映射内唯一的 profile 标识，不建立全局注册表；
   - `targetOperator` 与 `contractVersion`：绑定的目标算子与契约版本；
   - `profile`：稀疏数值参数表（包含 `familyWeights` 与 `leafWeights`）；
   - `calibrated: false`：当前没有校准参数，分类结果的 calibratedConfidence 为 null；
   - `compatibility`：taskId、minScore 与 minMargin；
   - `baseProfileId`：本轮基础参数引用。拟合轨迹、样本覆盖和比较记录在对应结果报告中，权重资产不另设 calibration/provenance 字段。
3. **不可静默覆盖与拒绝自动采用**：
   - 严禁自动覆盖已有 profile 文件，使用 `wx` 独占排他创建，遇同名文件报错拒绝；
   - 每次新的训练拟合生成新的独立 profile 文件；新拟合参数使旧校准状态自动失效；
   - 保存的候选 profile 绝不自动替换现有基础 profile（回执标记 `candidateAdoption: "not_applied"`），必须由调用者显式更新配置并绑定新 profileId。
4. **代码解耦**：禁止将权重硬编码进 TypeScript 源码（如 `lib/nodes/trainable/`），亦禁止在 `training/results/` 中重复堆积权重。

## 2. Git 忽略

本目录下所有权重 profile 资产均受 `.gitignore` 保护，本地保留，不入版本控制。本 `README.md` 纳入版本库作为规范基准。
