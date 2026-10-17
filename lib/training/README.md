# 训练算子与适配合同实现目录 (lib/training/)

本目录规划存放离线训练的算法、数值后端适配和样本 schema，供 training.prepare/partition/fit/calibrate/compare/assess/report 使用。对外的 NodeDefinition 封装归 lib/nodes，本目录不再维护第二套节点定义或注册入口。

## 1. 职责与边界

1. **源码与数据物理隔离**：本目录位于 `lib/` 源码树下，仅包含训练流程的算子逻辑与契约。本地生成的样本数据、评估报告与权重产物物理存放在根目录的 `training/` 下（Git 忽略）。
2. 显式数值后端：涉及拟合与反向传播时，通过调用者明确提供的 Handwired 源码根配置（HANDWIRED_ROOT）加载本地内核。源码根未配置时明确报错，不自动搜索、复制/vendor 上游或伪造训练成功；本轮不实现加载器。
3. **校准与泛化诚实性**：
   - 每次参数重新拟合使旧校准状态自动失效；
   - 独立数据覆盖不足时明确标记为 `uncalibrated` 或 `development-only`，严禁伪造校准；
   - 新旧版本比较必须逐例输出 `fixed`、`regressed`、`retained`、`unresolved`、`unassessed`，严禁通过汇总 loss 掩盖关键用例退化。
4. **离线隔离**：训练算子仅在本地纯内存与离线文件上运行，严禁在训练或回放过程中触发任何浏览器动作或外部网络请求。

## 2. 当前状态

本目录当前处于**设计态（0.1.0-design）**。
遵循消融原则，当前不创建空 `.ts` 壳代码或假执行接口。
