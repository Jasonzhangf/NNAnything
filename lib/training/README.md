# 训练算子与适配合同实现目录 (lib/training/)

本目录存放离线训练的算法、数值后端适配和多分类样本 schema。对外的 NodeDefinition 封装归 `lib/nodes/training.ts`，并通过 `nnanything/training` 公开导出。本目录不维护第二套节点定义或注册入口。

当前增量已实现完整六节点离线训练支持模块（`samples.ts`、`basic-kind-samples.ts`、`basic-kind-numeric.ts`、`basic-kind-training.ts`、`handwired.ts` @ 0.1.0）。

## 1. 职责与边界

1. **源码与数据物理隔离**：本目录位于 `lib/` 源码树下，仅包含训练流程的算子逻辑与契约。本地生成的样本数据、评估报告与权重产物物理存放在根目录的 `training/` 下（Git 忽略）。
2. **显式数值后端**：必须通过调用者显式提供的 Handwired 源码根参数（`--handwired-root` 或 `HANDWIRED_ROOT` 环境变量）加载本地内核。源码根未配置或缺失 `numeric-ui-core.ts` 时明确报错，不自动搜索、复制/vendor 上游或伪造训练成功。
3. **加载器环境与技术栈**：Node.js >= 20，已在 Node 22 环境测试通过（Bun 未经验证）。`lib/training/handwired.ts` 通过已安装的 devDependency `typescript` 内存转译源码为 ESM 并通过 data URL 动态 import，校验其导出 `Circuit` 类。
4. **校准与采用诚实性**：
   - 初始手写分数与训练产出的候选参数均保持未校准（`uncalibrated`），不宣称独立标定的概率；
   - 每次参数重新拟合使旧校准状态自动失效；
   - 保存的候选 profile 标记为 `candidateAdoption: "not_applied"`，绝不自动替换基础 profile；
   - 新旧版本比较必须逐例输出 `fixed`、`regressed`、`retained`、`unresolved`、`unassessed`，严禁通过汇总 loss 掩盖关键用例退化。
5. **离线隔离**：训练算子仅在本地内存与文件上运行，不触发浏览器动作或网络请求。用户已授权跨页评估和之后的增量实验；训练样本、留出样本和旧黄金回归分别报告，详见 `docs/training-m1-results.md`。第二层业务语义、WebUI、Rust 保持在范围外。

## 2. 模块结构与已实现能力 (0.1.0)

1. **多分类样本 Schema 与学生投影 (`basic-kind-samples.ts`)**：
   - 规范 `ReviewedBasicKindRow` 与 `BasicKindTrainingRequest`（包含 `provenanceRef`、`sourceAssociations`、`candidateQualification`、`captureCoverage`、`properties`、`proposal`、`review`）；
   - 严格的学生属性白名单提取与缺测保全，彻底剥离 teacher/raw class、id、账号、正文、URL 与绝对路径；
   - 区分 `candidate_qualified` 与 `properties_offline` 输入范围。
2. **Handwired 数值图与 Adam 优化器 (`basic-kind-numeric.ts`)**：
   - 动态调用 Handwired Circuit 构建稀疏数值计算图；
   - 运行 `Circuit.evaluateReference`、计算已知类与 other 损失及分数端导数；
   - 运行 `Circuit.backpropagateReference` 获得权重端梯度；
   - 结合锚定正则 L2 惩罚（λ/2 · ||w - wBase||²）与 Adam 优化器更新，并将权重截断投影至 `[-1, 1]`。
3. **来源分区、新旧比对与持久化 (`basic-kind-training.ts`)**：
   - 来源闭包分组算法（`partitionBasicKindSamples`），支持 `source_group_holdout`（要求至少 2 个独立来源组且两侧非空）与 `development_only`；
   - 双轨调用正式前向分类器比对（`compareBasicKindCandidates`），逐例统计迁移与类别指标；
   - 采用与退化评估（`assessBasicKindComparison`），黄金样本退化时收束为证据不足；
   - 权重与报告排他写入器（`writeBasicKindTrainingArtifacts`），在 `allowedRoot` 下安全创建 `*.weight.json` 与 `*.result.json`。
4. **单任务二分类样本与监督映射 (`samples.ts`)**：
   - 保持 0.1.0 已交付的 `TaskSampleRow` 与 `TaskDataset` 映射契约。
5. **已完成小批真实试验证据**：
   - 证据记录于 `/Volumes/Intel/playground/nnanything-runs/training-m1/existing-trial-summary.json`；
   - 158 条 LLM 复核样本（XHS 120 训练 108->120，Zhihu 38 留出 32->38，fixed 18 / regressed 0，仅 2 来源组，无 audio/select，未见页面评估进行中）。
6. **CLI 共享命令训练 (`cli-command-numeric.ts`, `cli-command-samples.ts`)**：
   - 当前 typed `file.property` 切片生成38条train与20条development样本，覆盖PWD、CD/NOOP/DEFER、LS及受信证据边界；
   - 6×14线性 logit共84参数；旧4×4按名称显式迁移，新行新列补零，再以全批SGD、softmax交叉熵真实增量拟合；
   - 真实 Handwired `evaluateReference`/`backpropagateReference`；候选保持 uncalibrated/not_applied；
   - 合同与当前训练入口为 [docs/cli-filesystem-training.md](../../docs/cli-filesystem-training.md)，历史实测见 [docs/cli-filesystem-training-results.md](../../docs/cli-filesystem-training-results.md)。
