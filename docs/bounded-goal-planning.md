# 有界目标规划：预测推理与执行推理

状态：`0.1.0-design`。本文定义有界前瞻、每请求候选图、执行路径与checkpoint的领域合同；它不是已导出的TypeScript API，不表示`runRecursiveGoal`已支持通用预测、多层路径选择或自动重推演。设计态图唯一源为[bounded-goal-planning.graph.json](../workflows/bounded-goal-planning.graph.json)。现有[recursive-goal.graph.json](../workflows/recursive-goal.graph.json) 3N2E和[browser-strategy-step.graph.json](../workflows/browser-strategy-step.graph.json) 5N4E运行图不改；预测性能、样本、权重和采用状态也未改变。

需求原文与审计保存在run `/Volumes/Intel/playground/nnanything-runs/human-semantic-evaluation-20261020` 的`lookahead-steering.md`、`lookahead-audit.md`、`plan.md`和`plan-update.md`。本文只实现前述输入的领域合同，不把用户描述、审计发现或静态图通过写成运行能力。

## 1. 目标、边界与术语

目标是在显式根Goal、真实起点、已启用技能、明确结果模型和有限预算内，生成可反驳的候选路径图，再每次只推进一个实际动作。执行后以真实New State决定继续、切换、局部重推演、阶段滚动或结束。

根`AcceptedRoot.rootGoal/rootThreshold/rootBindings`在全部预测段和执行段中保持不变。预测与执行不能修改根、降低阈值、扩大权限、重置总预算或改写学生当前错误head。根实际满足时立即回收必要链并结束，不为性格、路径分数或剩余视野追加动作。

三个不同对象不得混写：

| 对象 | 含义与owner |
| --- | --- |
| 静态治理workflow | 本文配图的6N5E SESE，表达设计资料的责任顺序；无运行绑定，不是每次请求的数据实例 |
| 每请求目标图实例 | `GoalGraphPlan`及其预测节点、结果分支、候选路径、检查点和覆盖声明；由预测入口生成 |
| 实际执行与ledger | 当前动作派发、真实回执、`StateRecord/EvidenceRecord`、effects、错误、重试与预算；由执行入口维护 |

预测推理负责“可能怎样推进及哪些候选有依据”，执行推理负责“现在能否推进一个真实动作”。计划是控制输入，不是事实、权限或完成证明。

## 2. 四元素与训练反推

| 元素 | 本文对应合同 |
| --- | --- |
| Goal | 调用者的结构化Goal及其必要条件不变；本模块只交付有界计划/控制结果，不另造可替换根 |
| satisfactionThreshold | 根阈值原样保存；预测满足度或路径utility不能替代它。只有在真实State上由领域评价器得到的实际满足度可判定根达标 |
| State | 根绑定、最新真实State与证据、未满足义务、计划cursor、checkpoint、预算、ledger、错误和权限；预测State只存在于计划实例 |
| Action | 预测展开、候选比较、当前单步派发、真实后验、checkpoint判定和分段控制；不要求模型一次输出整段动作 |

训练期可由达标State反向推导动作、前置State与结果关系，但运行期以真实New State评价。计划级训练反推关系不同于梯度反传，也不把路径规划器的固定控制训练层序。

动作成功、预测正确、路径满足、checkpoint满足和根Goal达成是五个结果。动作成功但后验unknown仍是unknown；预测正确只增加结果模型证据；checkpoint必须由真实评价器满足；根只由根评价器满足。

## 3. 预测推理I/O

以下类型是概念记法，不是现有导出API。`PredictionRequest`最少包含：

```text
PredictionRequest {
  acceptedRootRef; startStateRef; startEvidenceRefs;
  horizonN; frontierRef; unmetObligations;
  enabledSkillSchemas; resultModelRefs;
  preferencePolicyRef; remainingPredictionBudget;
  trigger: initial | checkpoint | no_applicable_path | invalidated | uncovered_result
}
```

`acceptedRootRef`必须解析到当前请求的`AcceptedRoot`；`startStateRef`必须指向最新真实State。`enabledSkillSchemas`只列出本次显式启用的技能合同。`resultModelRefs`须与技能、State/action条件及适用域匹配。缺少模型、评价尺或必要证据时保留`unknown/not_ready`，不生成看似可行的成功边。

`PredictionResult`是单一typed结果，统一收束为以下一种：

| 结果 | 最小内容 |
| --- | --- |
| `ready` | `GoalGraphPlan`实例、主路线、有序备选、覆盖声明、checkpoint与比较引用 |
| `deferred` | 只读补证要求、缺口键、已消费预算、保留的frontier |
| `not_ready` | 缺技能、缺结果模型、缺评价尺或不可比原因 |
| `stopped` | 根已满足、明确不可恢复错误、未知effect、权限或预算停止原因；根当前未满足本身不构成停止原因 |

每个结果都携带`rootRef`、`startStateRef`、错误/控制引用和实际预算。节点不能以空路径表示成功、以候选分数表示证据、以`predicted`字段写入实际State或ledger。

预测推理不得派发动作。它可多次调用已声明的技能关系或结果模型，但每次调用只回答已声明转移；调用次数不是N。组合技能展开到规范化语义动作后才计入视野。

## 4. 执行推理I/O

`ExecutionRequest`最少包含：

```text
ExecutionRequest {
  acceptedRootRef; planControlRef; currentStateRef;
  currentStudentHead; currentPermissions; remainingExecutionBudget;
  continuationRef?; retryControlRef?; ledgerRef; pendingVerificationRefs
}
```

`currentStudentHead`是当前学生实际输出，不因计划存在而补造。执行入口先核对计划适用性、根绑定、前提、权限、预算、retryControl与同错计数；合法时最多派发一个当前动作。当前head与技能及参数合同不兼容时保留`policy_error`，计划不能替换成另一个head。

`ExecutionResult`是单一typed结果：

| 结果 | 下一步责任 |
| --- | --- |
| `continue` | 前进当前cursor，保留同一有效计划，不调用预测 |
| `switch` | 用真实State重验次优入口后切到首个适用路径，旧回执保留 |
| `replan` | 仅撤换受影响frontier，生成新计划段 |
| `checkpoint_reached` | 归还该阶段义务，以最新真实State展开下一段 |
| `root_satisfied` | 回收全部必需链与必要收口，停止后续动作 |
| `defer` | 只允许已声明的只读补证；否则停止受影响链 |
| `stop` | 透传原错误、unknown effect、权限、取消或超预算控制 |

结果同时携带实际receipt、`observedStateRef`、effects、错误、预算增量、更新后的计划适用性和continuation。预测字段不得复制进实际证据；actual satisfaction只能来自真实评价。

## 5. 每请求图实例与状态分离

`GoalGraphPlan`至少含`planId`、`rootRef`、`startStateRef`、`horizonN`、节点集、结果边集、候选路径、覆盖frontier、checkpoint和生成范围。`planId`仅标识本次计划实例，不作冻结或身份包装。

| 实例字段 | 语义 |
| --- | --- |
| `PlanNode` | skill/version、typed前置条件、`PredictedState`、预测结果分支、预测effects、成本、unknown与依据引用 |
| `PlanEdge` | 从某结果分支到后继的条件、目标节点/checkpoint及覆盖状态 |
| `PathCandidate` | 有序节点、路径投影、rank引用、假设、失效条件及起始适用State |
| `CoverageFrontier` | 逐结果分支的`covered/truncated/unknown`、剩余视野与原因 |
| `CheckpointSpec` | 对象、实际条件、评价器、证据要求、解除义务和下一段滚动规则 |
| `PlanControl` | planRef、当前路径、备选顺序、cursor、checkpoint cursor、失效原因、专用限额和累计计数 |

`PredictedState`只保存假设、结果范围、来源模型与unknown。真实`StateRecord`、`EvidenceRecord`、`EffectRecord`和错误表不接受预测字段。预测effect不是授权；真实ledger只在执行前记`in_flight`并在回执后更新。

候选路径是OR选项。只把当前选中路径需要的条件加入必需AND集合；未选备选不得生成“已经失败”的虚假义务。共享预测引用只计一次覆盖，父子证据重叠不能重复贡献根满足度。

## 6. 静态6N5E设计图与唯一出口

新图固定六个中文节点：

```text
接收根与真实起点 -> 展开有界预测分支 -> 比较合法候选路线
-> 复核并推进当前一步 -> 核对真实结果与检查点 -> 汇总本段控制结果
```

六节点分别防止根漂移、无依据预测、排序混责、盲派发、预测冒充事实和结果无接收者。每个operator版本均为`0.1.0-design`，无workflow配置、运行绑定或算子实现。

拒绝、缺口、deferred、unknown、预算停止和正常结果都通过节点输出的typed控制字段沿五条边传到唯一出口。下游节点不得把上游`not_ready`改成空成功，也不得在静态图中增加回边。跨段继续由外层控制再次调用本设计流。

同一静态图用于单步推进，不代表每次经过展开节点都重新预测。接收节点显式给出`reuse`或`expand`控制：已有计划有效、正常续行且未到指定checkpoint时，展开节点只透传已接受计划，比较节点复用当前适用路线；不得调用预测器或重新展开。初次请求、checkpoint达成、无适用备选或明确失效时才消费展开预算。该控制不是新学生动作，也不计入N。

## 7. 有界展开、N与分支覆盖

N是规范化路径上一次有语义动作转移的最大视野。技能包装、控制转移、模型调用和workflow节点不增加N。只读取证在取得当前缺少且合同使用的事实时可计一步；必要后验归原动作合同，不另计；NOOP、虚层、重复同值观测和无下降循环不补N。

展开从真实起点开始，只走显式启用技能和明确结果模型，逐结果分支记录：

| 字段 | 要求 |
| --- | --- |
| 适用条件 | 启动该分支所需typed State/证据/权限 |
| 声明结果 | 模型合同允许的结果范围，不把unknown改成成功 |
| 剩余视野 | 从该结果出发仍可展开的语义动作数 |
| 后继/终止 | 可预测后继、预计根/checkpoint或停止原因 |
| 覆盖状态 | `covered/truncated/unknown`及具体缺口 |

短路径已真实到达根时提前结束。最长路径达到N不证明每个失败分支仍有N步；失败发生在第一步后，原段通常只剩N-1步，必须按实际分支重推演或明确截断。未知结果、缺模型和搜索预算不足都排除在成功保证之外。

预测只能声称“当前已生成且可比较候选中的有限视野较优”，不能声称全局最优或任何未知世界结果必然成功。checkpoint是typed runtime control/continuation，不是SHA、冻结快照或日志恢复控制。

## 8. 路径投影与排序边界

本文只定义传给排序owner的`PathProjection`，不复制候选排序字典序。排序、同分、DEFER和偏好策略的唯一owner是[goal-selection-policy.md](goal-selection-policy.md)，拟议边界为：

```text
rank(candidates, projection, preferencePolicyRef) -> ranking | defer
```

`PathProjection`含同尺终点评价、领域风险等级、动作累计成本和`unknown`。终点评价来自根预期满足度或同一checkpoint评价；不同checkpoint分数不能直接比较，除非领域声明共同根进展尺。

不使用未校准概率相乘。对声明覆盖的叶取最低终点评价，风险取域内可比较的最高等级，成本取各结果路径累计成本的最大值；动作成本单位显式一致，最小可用每动作1单位。比较键缺失时按排序owner返回DEFER或补证。原始NN margin、预测满足度、实际满足度和utility分开保存。

硬条件先于偏好。已观测结果使用实际满足度；待执行路径使用合法预期值。风格只改变合法候选排序，不改变根、阈值、权限、证据、基本类别gold或实际事实。排序接口当前未实现，不能调用现有F2 margin冒充路径级偏好。

## 9. 执行、分叉与局部重推演

执行顺序固定为：核对根实际事实；检查计划绑定、前提、权限、预算、retry与ledger；取得并守卫当前学生head；至多派发一个动作；取得真实回执并更新effects；评价实际New State；核对根、checkpoint和结果分支。

正常结果匹配当前路径且未到checkpoint时推进cursor，不调用预测器重建图。实际分叉先按既定顺序检查已有备选，候选入口必须用当前真实State、权限、effects和预算重验；旧预测不能授权，未选路径也不会自动执行。

次优入口都不适用或意外结果未被覆盖时，才局部重推演受影响frontier与排序。重推演不重跑历史derive、不覆盖已接受依赖、不修改根/阈值/固定绑定。原错误、unknown/mixed effects、`in_flight`、同错次数、累计预算和已完成回执跨计划段全部保留。

后续动作抵消先前成果或使引用失效时，撤销相关预测和持续条件适用性，保留历史回执。计划不能降低现有停止条件，unknown/inflight不得因换planId、次优路径或继续而重放。

## 10. Checkpoint、根结束与跨段continuation

checkpoint只在绑定对象和实际条件满足后触发。触发时归还该阶段义务，丢弃旧路径剩余预测承诺，并以最新真实State生成下一段。若根未满足，跨调用滚动通过continuation；若根已满足，立即回收必要链并结束。

现有`RecursiveGoalContinuation`已保存`acceptedRoot`、真实State/Evidence、frames、ledger、atomicResults、errors、remainingRequirements、budgetUsed、retryControl及contractRefs。未来接入需要增加概念性的`planControl`扩展，但必须沿模块owner先设计、红测和验证，不能在本设计态直接改公共类型。

| 现有边界 | 前瞻设计映射 |
| --- | --- |
| `maxTransitions/maxDepth/maxDerivedGoals` | 继续消费原预算；另加显式计划展开/重推演有限计数，并受总请求上限约束 |
| `capability_missing` | 缺启用技能或无法生成合法后继 |
| `evidence_unavailable` | 缺实际前提/后验证据，或只读补证不可用 |
| `policy_deferred` | 排序键不足、比较未声明或需补证 |
| `effect_outcome_unknown` | 停止自动fallback，只允许声明内只读补证 |
| `budget_exceeded` | 计划展开、动作或重推演预算耗尽 |
| `completed/stalled/cancelled/error` | 由真实根评价及现有控制原样收束，不另造顶层成功 |

这些是映射，不是新增API承诺。错误与控制的最终类型、字段和序列化仍由[recursive-goal-module.md](recursive-goal-module.md)及实现变更确认。

## 11. 训练与演进边界

未来技能转移预测和路径偏好学习各有独立I/O、样本、权重和评价。转移模型学习“State+Action条件→结果范围/后继”；偏好模型只学习候选/路线排序。排序成绩不能证明转移正确，转移损失也不能证明根达成。

预测样本须有可复核结果、来源模型和适用边界；偏好样本须有候选投影及独立排序依据。来源家族先分train/dev/verification，unknown、actual失败和预测落空保留，不把预测自回放当gold。旧技能回归与新场景评价分别报告。

N、层序、是否继续、checkpoint、预算、重推演与fallback控制不训练。本轮不拟合任何新模型，不创建样本、权重、profile或采用条件；未来采用沿[model-evolution.md](model-evolution.md)。

## 12. 十四个设计案例

| 案例 | 预期映射 |
| --- | --- |
| C1 正常主路径未到checkpoint | `continue`并推进cursor；计划有效时不调用预测器 |
| C2 意外结果匹配已有次优入口 | 用真实State重验后`switch`；旧预测不授权，原回执保留 |
| C3 次优入口不匹配且结果未覆盖 | 先完成备选检查，再局部`replan`；不得盲派或自由成功 |
| C4 checkpoint实际满足、根未满足 | `checkpoint_reached`，归还阶段义务并展开下一段 |
| C5 根实际满足且仍有高分备选 | `root_satisfied`；零额外优化动作，回收必要链后结束 |
| C6 N=3但第二步真实达到根 | 第二步结束，不机械补第三步 |
| C7 NOOP/包装/重复同值观测凑三层 | 不计有效N；暴露`truncated/unknown`覆盖缺口 |
| C8 一条分支三步、另一失败分支断路 | 逐分支声明覆盖；不得从最长路推导全分支可行 |
| C9 unknown effect且原派发in_flight | `stop/defer`并允许声明内只读补证；换图或续接不得重放mutation |
| C10 切换/重推演后预算或同错计数耗尽 | `budget_exceeded`或原停止控制；累计值不因planId清零 |
| C11 保守/激进面对同尺收益和风险 | 排序owner可选不同合法路线；根、权限和实际事实不变 |
| C12 候选完全同分且无顺序／有typed顺序 | 无顺序为`defer`；有顺序由排序owner按显式顺序选择 |
| C13 路线抵消旧成果或共享结果重叠 | 撤销失效适用性，覆盖去重；历史回执与错误不删除 |
| C14 关键结果模型或评价尺缺失 | `not_ready`并指出具体路线；不得编造可行边或未来成功 |

## 13. 现有支持、实现缺口与验收

| 已支持 | 当前缺口 |
| --- | --- |
| 3N2E `runRecursiveGoal`的根绑定、真实State评价、单current-head派发、有界derive、反向满足、错误、effects和continuation | 无`GoalGraphPlan`、预测State、路径cursor、checkpoint和跨段滚动控制 |
| 现有`capability_missing/evidence_unavailable/policy_deferred/effect_outcome_unknown/budget_exceeded`边界 | 无通用预测adapter、路径投影调用和重推演预算 |
| 浏览器F2当前候选、同错重试及CLI/cwd/finite-search消费入口 | F2不是预生成多步路径；不能冒充路径级偏好或前瞻 |

本设计验收只要求：双推理I/O闭合；请求实例与静态图区分；predicted/actual分离；N和逐分支覆盖可反驳；checkpoint及现有控制映射明确；排序投影引用唯一owner；14案例逐项得到预期结论。新图执行一次DAGpipe validate和inspect，静态通过不等于运行、训练或真实效果验收。

未来接入仍由现有recursive-goal控制owner完成，先补领域结果模型、真实consumer、控制接口设计、红测和同入口黑盒，再实现。不得另建执行引擎、并发mutation框架、冻结快照或平行台账。
