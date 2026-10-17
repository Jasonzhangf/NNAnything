# 项目工作流清单与拓扑真源 (workflows/)

本目录为 NNAnything 项目所有 DAG 图定义（`*.graph.json`）与持久化配置（`*.workflow.json`）的唯一物理真源目录。
遵循单源单汇（SESE）DAG 原则，每个工作流保持单一入口与单一出口。

## 1. 流程清单与状态

| 工作流图文件 | 对应配置文件 | 拓扑规格 | 状态 | 职责与交付范围 |
| :--- | :--- | :--- | :--- | :--- |
| `dom-candidates.graph.json` | `dom-candidates.workflow.json` | 7 节点 6 边 (7N6E SESE) | `0.1.0` 已实现 | L1 能动候选切片：读取页面观测并经视口、focus、黑白名单与拆分复检输出有序候选槽位与排除映射 |
| `dom-rule-sampling.graph.json` | `dom-rule-sampling.workflow.json` | 3 节点 2 边 (3N2E SESE) | `0.1.0` 已实现 | 基础规则采样流：显式 semantic rules 确定性分类 DOM 记录、下游按任务映射正负监督并持久化至本地 JSONL |
| `dom-recognition.graph.json` | 待按需配置 | 10 节点 10 边 (10N10E SESE) | `0.1.0-design` 设计态 | L2 完整卡片语义识别流：候选展开后经白名单特征提取、单标签语义分类并组装回原槽位 |
| `node-training.graph.json` | 待按需配置 | 7 节点 8 边 (7N8E SESE) | `0.1.0-design` 设计态 | L2 目标节点离线训练流：样本准备、来源分组分区、Handwired 拟合、校准与新旧逐例比较报告 |
| `operation-episode.graph.json` | 待按需配置 | 7 节点 6 边 (7N6E SESE) | `0.1.0-design` 设计态 | L3 操作闭环设计示例：观测、目标识别、策略决策、条件执行、新观测验证与统一收束 |

> [!NOTE]
> `dom-rule-sampling.graph.json` 及其三算子（`sample.match`、`sample.assemble`、`sample.save`）已升级为 `0.1.0`，经 `dagpipe graph validate` 与 `inspect` 验证通过。
> 运行时可通过 `compileWorkflow` 配合 `nnanything/browser` 导出的采样节点与显式 `filesystem.write` 授权执行（详见 [playground/sampling/README.md](../playground/sampling/README.md)）。

## 2. 基础规则采样流设计 (dom-rule-sampling)

### 2.1 业务流程图（遵循 flow-presentation 规范）

```mermaid
flowchart TD
  S([输入原始DOM记录数组 raw_records]):::boundary --> M[按显式规则匹配DOM记录]:::action
  M -->|matched_records| A[组装单任务训练样本]:::action
  A -->|task_samples| W[保存样本到本地目录]:::action
  W -->|save_receipt| Z([返回保存回执与样本统计]):::success

  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef data fill:#F1EAFE,stroke:#7C3AED,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

### 2.2 图与配置一一对应关系

持久配置 `dom-rule-sampling.workflow.json`（v1 格式）与 `dom-rule-sampling.graph.json` 严格一一对应：
1. `graphRef`: 对本地图文件显式相对路径 `"./dom-rule-sampling.graph.json"`；
2. `configs`: 提供局部配置对象（`cardMatchRule`、`cardSampleSpec`、`localSaveSpec`），配置采用合成语义规则与任务监督映射（如 `post.card`、`post.body` 等合成类别，非私有生产规则）；
3. `bindings`: 键名必须与图文件中的中文节点 ID 完全一致：
   - `"按显式规则匹配DOM记录"` 绑定 `cardMatchRule`
   - `"组装单任务训练样本"` 绑定 `cardSampleSpec`
   - `"保存样本到本地目录"` 绑定 `localSaveSpec`

三节点完整 I/O、三值逻辑真值表、白名单清洗、副作用、防越界写入及验收要求唯一维护于 [lib/nodes/README.md](../lib/nodes/README.md)。
公开消费端用法与运行方式见 [playground/sampling/README.md](../playground/sampling/README.md)。
