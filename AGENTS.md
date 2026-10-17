# NNAnything 项目规则

## 当前交付边界

L1 能动切片与基础工作流资产设计已先后完成交付并通过验证。当前用户明确授权实现基础采样节点（nnanything-sampling-l1）：交付三类基础采样算子（sample.match、sample.assemble、sample.save）、离线持久化与公开采样 Consumer。旧范围 hold 仅对本次采样增量解除；历史范围保留为历史。本轮不实现神经网络模型或训练、不接入活体网页或在线操作、不做批量外部采标或跨站扩展，不建伪执行接口。L2-L4 仍属于后续规划。

项目远端为https://github.com/Jasonzhangf/NNAnything.git。本轮交付三类基础采样算子实现、公开离线采样消费端与文档合同更新；原始登录态页面、站点特定标注规则与样本产物保持本地。

## 唯一Owner与入口

- 总体架构入口：docs/design.md；D0交付与后续浏览器范围：docs/framework-m1.md。
- 通用节点/事件与workflow合同：docs/node-workflows.md、docs/canvas-events.md；持久基础配置：docs/workflow-config.md。
- 可复用经验节点合同：docs/node-contract.md；目录和实施顺序：docs/implementation-plan.md。
- 推进节奏、DAGpipe/AppSDK治理、交付与审批：docs/project-governance.md。
- 项目图拓扑与流程清单：workflows/*.graph.json 与 workflows/README.md；后续可执行绑定直接读取它，不在代码手抄另一套图。未实现算子保持design版本。
- 三类基础采样节点完整合同卡唯一owner：lib/nodes/README.md。
- DOM focus/单标签与数组规则：docs/focus-and-labeling.md；首个结构实验电路：docs/structure-circuit-m1.md。research中的旧organic或多标签草案不得覆盖当前合同。
- 项目进度和证据汇总由note.md单一owner维护；任务过程材料放仓库外，不建立第二套治理台账。

## 后续实现必须保持的边界

通用核心不内置DOM/站点类别。正式应用与训练使用同一workflow执行合同；候选采用Flowed调度，DAGpipe CLI负责静态图检查。画布可选。节点内部Handwired数值图和外部workflow分别管理，跨节点连线不自动反传。

节点须能独立消费明确I/O。配置、状态、profile和effects显式传递，不读取隐藏站点全局。复用需验证合同兼容，不宣称只换权重即可跨任意场景。经验修复按规则/参数/特征/连线的实际owner处理；未知和过滤不自动变负例。

Filter 与任务监督边界：Filter 只输出语义分类、识别状态及证据，不输出训练正负极性。正例、负例和期望输出由下游训练任务按语义及训练要求显式映射；保持单项单语义分类和数组保序要求。

学生特征禁止原始class/id、账号/正文名称、完整URL/图片名、绝对根路径和全局深度；这些资料仅可用于原始证据与teacher标注。单任务单标签，数组保序保留排除/未知；同来源关联组不得跨训练和独立回归。

使用Handwired必须显式配置源码根，缺失报错、不复制上游或假训练。新拟合使旧校准失效。离线训练/回放不触发浏览器operation。首个结构任务不冒称已解决普通帖/广告/推广来源分类。

代码开发、测试、独立Review、Git集成和独占worktree沿全局AGENTS与适用Skills。本项目不新增机器manifest、全局插件注册服务或另一套执行引擎。

## 推进与授权

需求优先级依次为能动、能有核心功能、完善功能、提高兼容性。先交最小能动切片，不提前扩展。各层验收沿docs/implementation-plan.md，安全和数据正确性不后移。

项目内agent派发只要符合全局派发原则、已有任务范围和文件owner，不需要单独授权。L1实现与基础工作流设计已先后交付；当前增量实现三类采样算子及公开离线采样 Consumer。Review或派发授权不扩大到L2-L4。完整重大实现milestone作者验收后整体Review一次，不逐节点加审批。

采用DAGpipe图治理与AppSDK需求/交付治理原则。有效.appsdk/requirements.json存在时通过正式入口读取适用项；当前未初始化AppSDK，不伪造受管状态、不建需求占位。首次入驻沿既有prepare确认合同，不把它变成日常派发许可。

本项目禁止不必要SHA/checksum、哈希清单、候选身份包装、冻结快照和重复校验。保留当前失败模式所需的真实入口、安全及数据正确性检查；有效未变证据直接复用。具体规则只维护于docs/project-governance.md，不新增另一套门禁。
