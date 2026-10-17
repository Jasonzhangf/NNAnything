# Workflow 基础配置合同

状态：L1 已交付并完成验收，当前授权基础工作流设计与目录分类，2026-10-17。配置表示节点接续，不依赖画布。执行方案采用 Flowed 1.15.0，保留项目图唯一真源（集中于 `workflows/` 目录）；L1 已实现加载、编译和单次执行合同。流程清单见 [workflows/README.md](../workflows/README.md)，三类基础采样节点合同卡见 [lib/nodes/README.md](../lib/nodes/README.md)。

## 1. 持久配置与运行绑定

持久WorkflowConfig只存JSON可表达的声明。解析后得到内存WorkflowDefinition，供编译适配层使用。两者的区别是解析引用，不是两套执行图。

| 字段 | 合同 |
| --- | --- |
| configVersion | 配置合同版本，首期为1；未知版本明确拒绝 |
| graphRef | 对项目.graph.json的显式本地相对路径；节点/ARC/edges/出口拓扑只在该图定义 |
| configs | 本配置内的具名参数对象；供多个节点共享同一份规则，键是局部引用，不是全局注册服务 |
| bindings | 以图中nodeId为键；每项指定configRef或内联config（互斥），以及可选profileId |

调用者另行提供节点定义列表、具名profile对象、必要适配器/训练后端、输入事件与授予的effect能力。配置不能自行授予能力，不从URL加载脚本，不从日志或隐式全局找profile。configs/profile引用必须存在；无绑定且节点声明无需配置时使用空配置，其他缺失明确拒绝。

本地加载器只解析调用者明确允许的项目配置/图目录；读取和解析错误直接报告。首期不支持远程图、动态插件路径、任意模板/表达式、全局当前配置或自动目录搜索。profile等运行对象由调用者显式加载后绑定，不把未训练的占位参数当可用模型。

示例仅展示声明格式，引用的profile须由后续调用者提供，当前不是可运行文件：

```json
{
  "configVersion": 1,
  "graphRef": "./dom-recognition.graph.json",
  "configs": {
    "focus": {
      "viewportOnly": true,
      "scopeMode": "subtree",
      "within": null,
      "region": null,
      "deny": []
    },
    "task": {"taskId": "weibo.post.card.structure", "target": "post.card"}
  },
  "bindings": {
    "筛选视口内候选": {"configRef": "focus"},
    "限制当前关注范围": {"configRef": "focus"},
    "应用黑名单": {"configRef": "focus"},
    "应用白名单": {"configRef": "focus"},
    "检查展开项的候选规则": {"configRef": "focus"},
    "执行单标签语义识别": {"configRef": "task", "profileId": "card-structure-candidate"}
  }
}
```

示例未配置allow表示不额外限制；显式allow:[]表示拒绝全部候选。profiles为运行时具名参数资源，不把它们再放进任意业务metadata。特征/分类节点的同一任务合同由应用绑定工厂明确提供，不靠搜索其他节点配置来推断。

## 2. 内存定义与端口绑定

加载后，WorkflowDefinition.graph是graphRef实际解析的项目图，bindings中的configRef解析为明确参数对象，profileId指向本次profiles。程序直接构造WorkflowDefinition时使用同一结构与编译规则；无需先写配置文件。局部configs是声明去重机制，不是执行状态存储。

NodeDefinition的inputPorts按顺序与图节点inputs数组一一绑定，outputPort与图节点单个output ARC绑定。端口名属于算子合同，ARC ID属于图，两者不要求同名。每个端口声明领域schemaId及实际payload验证；上游/下游兼容性按同一schema合同检查，不能只看.graph.json的粗Object类型。

公开接口职责：loadWorkflow将持久声明解析为WorkflowDefinition，configRef解析为明确inline配置；compileWorkflow接收该定义、节点列表及显式profile/effect资源，返回可执行绑定或具体编译错误；runWorkflow接收编译结果与单个入口事件，异步返回本次结束结果及轨迹。配置文件入口与程序构造入口在compile阶段汇合，不各自调度。

单次结束结果区分completed和failed。completed表示DAG已结束，其outputEvent仍可为filtered_out/skipped/unknown，不等于目标命中或业务操作成功。failed带失败节点、错误类别和原因；局部数据缺测按节点合同输出unknown，不能以异常误杀整个宿主服务。首期无持续投递/恢复接口，一次run只接收一个入口事件，各ARC只产生一次结果；不宣称跨进程exactly-once。

首期每个处理节点一个输出事件，可在payload中承载有序数组或结构化结果；首期不做同一DOM项多标签。input ARC/出口也必须有实际验证合同。需要更多输出端口时以后演进图合同，不能在处理器中偷偷向未声明边发送事件。

## 3. 编译与执行的确定语义

编译前检查：图单输入单输出、无环/死节点；边与ARC依赖一致；operator版本和节点存在；参数、端口、profile兼容；所需effects已由调用者授权。M1只使用Whole和空selector，不支持的Items/selector配置明确拒绝，不静默忽略以改变保序语义。

通过后将图一比一转换为Flowed tasks。ARC成为requires/provides依赖键，输入事件沿边推进，Flowed负责async等待与汇合。每次run创建独立执行实例，不跨run缓存分类或参数，不提供未声明的重试/恢复/事件总线。

事件包含eventId、runId、生产节点/端口、事件类型、输入项关联键、明确状态与payload。节点执行上下文提供明确配置/profile与能力。运行器验证关联，不混用不同run/输入项。批量处理时数组项携带自己的index/nodeRef；这些关联字段不成为数值特征。

过滤/跳过/未知均通过明确结果传到汇总出口，不等不会出现的事件。需要输入成功的节点收到不满足条件的事件时跳过；汇总节点可以消费这些状态。节点异常保留原因及失败位置，由运行边界返回明确失败；不得用空成功或语义负类掩盖异常。

## 4. 校验与证据边界

静态DAGpipe校验只证明图语法与拓扑，后续compile与consumer才证明节点注册、领域端口、effects和结果行为。已有图未变时复用静态结果，不在每次改文档/记笔记时重验。

L1验收包括：配置文件与代码入口进入同一编译；async扇入等输入齐备才执行；过滤/跳过能结束；非法图/错类型/缺引用明确拒绝；未授权effect实际执行次数0。公开用法见[l1-usage.md](l1-usage.md)，原始结果与独立审查状态见[note.md](../note.md)。
