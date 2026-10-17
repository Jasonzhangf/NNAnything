# 本地训练数据与权重资产 (training/)

本目录为 NNAnything 本地训练样本数据、评估报告与权重资产的根目录。
遵循数据、报告与权重三分类原则，本目录与 `lib/training/`（源码/契约实现）及 `lib/nodes/trainable/`（节点定义）物理分离。

## 1. 三分类架构与唯一 Owner

| 子目录 | 唯一职责 | 资产类型与生命周期 |
| :--- | :--- | :--- |
| [`samples/`](samples/README.md) | 规范训练与评测样本数据 | 本地 JSONL 记录（单任务单标签），由采样流或 teacher 标注流生成 |
| [`results/`](results/README.md) | 拟合、校准、新旧逐例比较报告 | 本地评估与比较 JSON 报告，**仅引用权重 profile**，不重复存储权重 |
| [`weights/`](weights/README.md) | 真实参数与权重 profile **唯一存放处** | 训练产出的结构化参数文件，供运行时通过 `profileId` 显式加载 |

## 2. 隔离与安全底线

1. **全量 Git 忽略**：本目录下的所有样本文件、评估结果与权重参数默认受 `.gitignore` 保护，严禁提交到远端 Git 仓库。仅各子目录的 `README.md` 入版本库维护规范。
2. **私有研究数据隔离**：`research/` 下的历史私有页面数据、未脱敏登录态快照与标注细节保留在原位，绝不迁移或复制至本目录，更不得提交入库。
3. **单源原则**：
   - 真实权重 profile 仅存在于 `training/weights/`；
   - `results/` 仅记录评估指标并链接至对应 weight，不留重复副本；
   - `lib/nodes/trainable/` 仅为代码定义，不内嵌权重。
