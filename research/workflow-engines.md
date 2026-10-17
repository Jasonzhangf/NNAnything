# Workflow 执行框架选型依据

2026-10-17，GitHub CLI读取上游README、package与实际执行源码，并查询npm当前发布版本。本文记录候选证据；不将源码阅读当作本地运行验收。最终采用方案须经独立计划与用户要求的Gemini 4设计评估。

目标是嵌入式、无画布依赖的节点执行：有类型事件端口、异步依赖、汇合、有限DAG、明确结束，网页与训练共用一条执行路径。应用自己的节点合同、参数/profile与数据隔离仍需实现。

| 方案 | 已查到的可复用能力 | 当前适配代价与限制 |
| --- | --- | --- |
| [Flowed](https://github.com/danielduarte/flowed) | MIT；npm 1.15.0；JSON任务、requires/provides、Promise resolver、依赖调度与完成；FlowManager.run可传本次resolver映射 | 上次发布2025-02-26；上游允许环、内联模板和全局plugin，不能直接将这些配置全部暴露。我们的配置边界需拒绝环、未绑定输入与非允许effect，并使用本次局部resolver；运行时行为待consumer验证 |
| [Rete.js Engine](https://github.com/retejs/engine) | MIT；rete-engine 2.1.1 + rete 2.0.6；无需渲染插件也可构造图；DataflowEngine有异步拉取与缓存 | ControlFlow.execute递归forward且不await；无现成的异步汇合/统一结束。Dataflow是按需拉取。若为事件操作补齐调度，可能重复造轮子；同一缓存也不能跨页面run复用 |
| [LangGraph.js](https://github.com/langchain-ai/langgraphjs) | MIT；状态图、节点执行与持久化生态，近期仍有更新 | 已查package依赖LangChain core/zod；当前无需LLM agent、检查点或循环状态图。不能仅因同为graph就认定比小型依赖调度库更适合 |
| [n8n](https://github.com/n8n-io/n8n) / [Dify](https://github.com/langgenius/dify) | 完整的工作流应用，可参考节点配置与交互 | 当前是本地基础库，嵌入完整平台会扩大服务、存储、部署与许可核查范围；本轮不需要平台UI和集成目录 |
| 已安装DAGpipe 0.1.1 | CLI能静态validate/inspect；Rust SDK提供compile及Runtime::run | 本地观察确认Operator::execute为同步Rust trait，无TS/FFI/WASM桥，CLI没有run命令；直接承载浏览器异步节点与Handwired需要新增跨语言适配。保留静态图治理，不将未接入的Rust runtime说成当前执行引擎 |

已读取的关键源码：

- [Flowed FlowManager.run](https://github.com/danielduarte/flowed/blob/main/src/engine/flow-manager.ts)：本次spec、params、expectedResults、resolvers、context、options。
- [Flowed TaskProcess.run](https://github.com/danielduarte/flowed/blob/main/src/engine/task-process.ts)：同步/Promise resolver与结果映射。节点包装必须保持显式结果，不让未知/过滤变成负标签。
- [Flowed Task](https://github.com/danielduarte/flowed/blob/main/src/engine/task.ts)：requires队列和参数/结果映射；包含flowed-st模板能力。本项目若采用，只由编译适配器生成普通端口映射，不透传任意模板或URL加载能力。
- [Rete ControlFlow.execute](https://github.com/retejs/engine/blob/main/src/control-flow.ts)：直接调用setup.execute和后继，没有完成Promise或汇合等待。
- [Rete DataflowEngine](https://github.com/retejs/engine/blob/main/src/dataflow-engine.ts)：基于fetch和cache；这与一次输入事件驱动的有限run存在适配边界。

没有运行上述库，也没有做性能/稳定性对比。维护时间是事实，不单独作为排除条件。选型还需明确：哪一层拥有唯一图配置、哪些校验由项目完成、哪些依赖执行直接复用上游，以及真实consumer如何证明成功、跳过、错误与无副作用。

本地独立观察还确认Handwired的numeric-ui-core.ts是无import、无DOM依赖的纯TS单文件，能直接提供参考前向与反传。现有reusable-layout示例是MSE回归模型，不应直接冒充语义分类器；本项目需要显式分类电路、宿主损失与参数/profile合同。观察只读，未运行训练，不代表数值节点已经接入。
