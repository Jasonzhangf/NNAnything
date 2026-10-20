# 确定性过滤规则与候选槽位求值实现 (lib/filters/)

本目录存放浏览器场景下确定性过滤规则与候选槽位计算的纯逻辑实现（如焦点收缩、黑白名单匹配、候选过滤链等），与工作流节点（`lib/nodes/`）的事件封装解耦。

## 1. 职责与边界

1. 纯内存确定性计算：本目录下的规则函数为纯内存求值，无副作用（`effects: []`）。
2. 与节点封装解耦：
   - 规则与槽位求值内核位于 `lib/filters/`；
   - `lib/nodes/dom.ts`、`lib/nodes/sampling.ts` 与 `lib/nodes/basic-kinds.ts` 将这些纯逻辑包装为符合 `NodeDefinition` 的事件端口处理单元。
3. 经验积累路径：手写过滤经验通过确定性规则与回归用例积累，不将手写规则包装为神经网络权重；过滤排除的候选记录明确排除原因，严禁自动转为模型负标签。
4. 采样规则支持：`sample.match` 算子的规则匹配纯内核（`evaluateSemanticRules`，AND 条件与类别内 OR 求值、三值逻辑、跨类槽位仲裁与语义冲突检测）归属于本目录（`lib/filters/sample-match.ts`）。Filter 仅输出语义分类与匹配状态，彻底无训练正负极性概念，无 `lib/training` 依赖。
5. 基础种类判断支持：第一层 DOM 基础种类两阶段求值纯内核（`classifyBasicKind`、`classifyBasicKindBatch`，大类通过后再计算细类、缺测特征区间与冲突处理、稀疏 profile 门限求值）归属于本目录（`lib/filters/basic-kinds.ts`）。详细算法设计由 [docs/basic-kinds-wiring.md](../../docs/basic-kinds-wiring.md) 单一维护。不包含模型训练、Handwired 后端或置信度标定，纯属性诊断调用不替代合格工作流分类。
6. CLI 共享命令策略支持：`cli-command-policy.ts` 维护7个语义head（`pwd/cd/ls/path.resolve/path.relative/path.parts/entry.inspect`）和3个控制head（`unsupported/DEFER/NOOP`）、30条有序wire、10×30共300参数profile、typed `file.property` 特征计算、纯softmax及显式按名离线迁移。它不执行命令、不加载Handwired、不读取隐藏session。`cli-file-property.ts`负责typed目标/谓词映射，`cli-state.ts`负责CwdKnowledge与受信证据校验。合同唯一入口为 [docs/cli-filesystem-training.md](../../docs/cli-filesystem-training.md)。

## 2. 迁移与实现状态

- `focus.ts`：视口、within 容器及 region 矩形候选过滤纯逻辑（自原 `src/adapters/browser/focus.ts` 迁入）；
- `candidate-chain.ts`：7 节点手写候选过滤链求值纯逻辑（自原 `src/adapters/browser/candidate-chain.ts` 迁入）；
- `sample-match.ts`：纯语义规则求值内核 `evaluateSemanticRules`，`0.1.0` 已实现并通过公开接口验收；
- `basic-kinds.ts`：DOM 基础种类两阶段求值纯内核 `classifyBasicKind` 与批次求值 `classifyBasicKindBatch`，`0.1.0` 已实现并通过公开接口验收。
- `cli-command-policy.ts`：typed `file.property`到统一命令/控制head的纯选择合同，当前运行与训练节点为`0.3.0.0000`；配套`cli-file-property.ts`与`cli-state.ts`已通过作者回归和真实公开consumer，候选仍未采用。
