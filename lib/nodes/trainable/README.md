# 可训练节点定义目录 (lib/nodes/trainable/)

本目录规划用于存放未来可训练节点（如 `node.classify`）的结构定义、特征白名单、数值编码合同及内部 Handwired 数值电路定义。

## 1. 职责与边界

1. **代码与权重分离**：本目录仅包含可训练节点的 TypeScript 源码与结构契约，**严禁存放训练参数或权重 profile 真实产物**。所有真实权重产物唯一归属于本地 `training/weights/` 目录。
2. **禁止 Profile 源码膨胀**：每个可训练节点是一套固定的数值计算与特征结构，严禁为每个权重 profile 或每次训练拟合复制新的 `.ts` 节点源码。运行时通过 `profileId` 显式绑定不同的权重资源。
3. **单标签与特征白名单**：可训练节点严格限制在单任务单标签范围内；输入特征严格限制在已审定的白名单几何与局部上下文，绝对禁止引入原始 `class`、`id`、账号名称或绝对路径作为学习特征。

## 2. 当前状态

本目录已包含 `cli-path-controller.ts` 与 `cli-goal-policy.ts` 两个有限可训练电路结构；两者只定义固定 wire、动态参数 source 与计算形状，不保存真实权重。路径合同见 [docs/cli-path-training.md](../../../docs/cli-path-training.md)，结构化 Goal 合同见 [docs/cli-goal-training.md](../../../docs/cli-goal-training.md)。
