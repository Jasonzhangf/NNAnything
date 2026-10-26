# G2 独立有限组合泛化验收（Alice 2026-10-26）

2026-10-26。PASS，范围为固定四头模型在有限双源读取组合、来源优先级和方向恢复上的独立 validation，不是任意 CLI、任意词表、产品集成或权重采用。

Alice 直接读取独立 fixture，以 lstat 判断双源真实类型，再按首个 regular 来源、原始目标 head/tail 与 N 计算字节。48 个有匹配任务的实际输出和来源全部正确；18 个负例无 regular 目标，轨迹完整列举双源、零读取、根 unsatisfied；12 个方向干预各有错误方向和正确方向两次真实 read，错误方向字节评价全部拒绝，恢复成功。分母为 66 = 标准 48 + 预置 6 + 干预 12。独立 consumer、heads 与 torch reference 和 DEV 原件逐字节一致。

结合 DEV 72/72 与 G1 已知 388 例回归，支持当前固定读取语义下：R/D/E/A 参与真实多轮推理；双源优先关系在未用于拟合的物理组合及 N=9/21/45 上有效；模型能使用反馈恢复方向错误；新增 D 后训练未在已查旧能力上退化。R 仅 5 个独特输入投影、D 38 个新投影，物理样本新颖不等于抽象关系未见。有限通过不能证明任意新命令、任意词表或无限范围泛化。

本次纯模型 R×2+D+E+A p95 约 0.020ms，不含命令和文件 I/O，不代表端到端延迟。权重仍为实验候选，未自动采用。

过程限制保留：consumer 仅调用一次；外层脚本误用 zsh 只读 `status` 变量，未保存 consumer exit code。完整 66 例结果、stdout PASS、空 stderr 及逐例真实证据支持行为结论，但不声称已捕获 exit 0。独立 oracle 首次跟随 symlink 的评价错误保留；只修事后 oracle 并重算，没有改 consumer、权重或重跑验证取优。consumer 原始 result 的 schema/evidence_scope 仍为 DEV 模板，原始字段保留，不静默改写；实际用途由本验收、descriptor 及 delivery 共同说明。

独立 Review `g2-evidence-milestone-review-4` 使用 Codex OAuth `gpt-6.1-sol` medium，只读审查完整 G2 milestone，controller 返回 `pass`，findings 为空。此前 review-2 与 review-3 因派发时 commit 被存成字符串 `"null"` 而非 JSON null，controller 严格 scope 比较失败；Reviewer 输出本身有效，原错与原始输出保留，未作为代码 finding。review-4 使用新任务并省略 commit 后通过。

下一阶段沿 domain-expert-pretraining-design 与 Emma 既有 casebook 完成常用 CLI 语义家族详细合同。优先文件发现、字面内容搜索、上下文读取，定义真实 shell 采样、各头特征与监督、来源分区和预算，再并行采样。保留本批能力与旧 TRAIN 重放；各头独立验收后组合。本 milestone 不把实验验收写成产品集成。
