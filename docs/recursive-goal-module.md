# 通用递归目标独立模块与准确错误合同

2026-10-24领域决策新实验：[L2四语义头](l2-four-head-experiment.md)通过既有adapter接点设计关系、分解、评价及当前选择；本模块的帧、证据、权限、预算、恢复和错误合同不变。H_R不替换supports的纯类型兼容检查；H_D/H_E/H_A分别接derive/evaluate/select。内部单步责任图是design，无新增运行算子或已训练模型，不据此声称当前controller已接四头。未知与有范围的失败证伪按显式State/证据返回，不能从日志恢复控制。

状态：2026-10-20。v1递归行为保留，`0.2.0` 3N2E已接有界规划、真实结果对照、checkpoint与失败先验恢复，有限合成域和真实cwd consumer已有验收。第13节保留旧`0.1.0`历史证据；新实现证据另列，不混用分母。整体Review、main集成及资源收口由[note.md](../note.md)维护。

本合同唯一维护独立模块边界、公开数据类型、adapter 调用形状、错误传播、response 和 continuation。通用语义及 3N2E 仍由 [recursive-goal-design.md](recursive-goal-design.md)维护。实现源码 owner 为 `lib/workflow/recursive-goal/`，公开门面 owner 为 `lib/recursive-goal.ts`。

逐步观察接入补充：执行失败但原子回执提供可信且当前的New State/证据、无验证错误时，错误停止前允许纯重验已有必要条件及根事实。重验仅消费本次post证据，沿既有条件自下而上暂存再提交；不创建或执行子Goal，不调用规划、retry或普通成功终结。每次评价消耗现有transition预算并遵守取消，材料/预算不足、取消或评价失败时根保持unknown并保留原因。原执行错误、失败execution及effects不因根事实达标而清除。错误停止仍是error，不能把“根事实satisfied”写成干净执行成功；无有效post不得用初态评价冒充本次结果。

2026-10-22反馈归因修订：图/三个算子候选升为`0.2.0.0001`，拓扑不变。`planning.attributeFailure`为可选同步纯领域边界；未配置或返回unknown时停止本次自动失败恢复，不创建排除先验。合法restricted输出须引用本次生成转移的非空子集与当前有效post证据；原错误保留。异常或非法输出增加准确诊断，不改原primary error。verified_failure先验新增可复制归因凭据（capability/plan/node/已生成集合/State/证据/reason），旧缺凭据先验不静默准入。真实拟合和自动采集没有因此实现。本次行为与交付回执另记note.md。

## 1. 边界与依赖

通用模块只管理 Goal 帧生命周期、条件衍生、预算、取消、dispatch ledger、错误关联和统一返回。领域应用提供 typed Goal、State、对象绑定、证据 payload、effect fact、原始回执、评价器、selector、组合规则和原子执行。

允许依赖：

- `lib/core/` 的事件、端口、错误和通用 types。
- `lib/workflow/` 已有的 `loadWorkflow`、`compileWorkflow`、`runWorkflow`。

禁止依赖具体 CLI、browser、training、filter 或 node 模块，也禁止默认 adapter、环境推断、全局可变 singleton、隐式 profile 和第二执行引擎。原子技能必须调用领域既有 workflow；外层继续使用 `recursive-goal.graph.json` 的 3N2E。

最小文件职责：

| 文件 | 唯一职责 |
| --- | --- |
| `contracts.ts` | public types、结构守卫、纯比较 helper |
| `module.ts` | admission、显式栈、预算、ledger、算子 factory、facade、finalize |
| `errors.ts` | 稳定 diagnostic 构造、source 映射和父链传播 |

## 2. 公开入口与 total response

```ts
runRecursiveGoal<G, S, B, E, F, R, C>(
  request: unknown,
  deps: RecursiveGoalDependencies<G, S, B, E, F, R, C>,
): Promise<RecursiveGoalResponse<G, S, B, E, F, R, C>>;
```

### 2.1 使用入口

```ts
import { runRecursiveGoal } from "nnanything/recursive-goal";

const response = await runRecursiveGoal(request, deps);
```

`deps` 必须显式提供 adapter、`enabledSkills`、`enabledEvaluators`、`selectors`、`comparators`、`grantedEffects` 和可选 `AbortSignal`。模块没有默认 adapter、profile、评价器或 effects 授权。

新请求可带 `initialObservation`，用于把真实 State 与已观测 `EvidenceRecord` 一起准入；恢复请求使用 `continuation`。两者互斥。`continuation` 只承载已保存的 typed State、证据、帧控制、依赖定义、预算和 ledger，不携带新的初始观测或动作函数。规划请求另带可选 `planning`，并要求 dependencies 同时提供匹配 capability；只有一侧存在时显式拒绝。

根 `rootGoal`、阈值和绑定在 admission 后不可变。子帧只能向直接父条件返回真实 New State、有效证据和已确认 effects；领域执行失败不能直接改写成根成功或根 false。错误、根事实、control、effects 和 atomic results 分开记录，调用者须读取 response discriminator 与 `rootEvaluation`，不能把 workflow `completed` 当作 Goal achieved。

预算为全树共享的 transition/depth/derived-goal 限额；取消只在控制边界生效，进行中的 callback 必须按有界合同返回或留下 unknown effect。continuation 保留累计消耗；恢复不重演历史 derive、不重放已完成或 ledger 中的动作，unknown/mixed effect 只能先走已声明的只读补证。跨进程 exactly-once、并发恢复保护和宿主终止同步返回不在当前边界内。

generic 含义固定：

| 参数 | 含义 |
| --- | --- |
| `G` | 领域 typed Goal |
| `S` | 由实际观测得到的领域 State |
| `B` | 已验证对象绑定 |
| `E` | 领域证据 payload |
| `F` | 已确认领域 effect fact |
| `R` | 领域原始 receipt payload |
| `C` | 组合规则 cursor |

请求、证据、回执和 continuation 必须是可复制数据。函数、policy、adapter、comparator、资源句柄和 evaluator 实现只放 `deps`，不写 continuation。

公开结果封闭为三分，不允许裸 `ok`、`null` 或普通抛错表示业务结束：

```text
RecursiveGoalResponse =
  RequestRejected | RecursiveGoalRunResult | RecursiveGoalModuleFault

RequestRejected {
  kind: "request_rejected";
  requestId: string | null;
  acceptedRoot: null;
  error: RecursiveGoalErrorDiagnostic
}

RecursiveGoalRunResult {
  kind: "run_result";
  requestId: string;
  acceptedRoot: AcceptedRoot;
  report: RecursiveGoalRunReport
}

RecursiveGoalModuleFault {
  kind: "module_fault";
  requestId: string | null;
  acceptedRoot: AcceptedRoot | null;
  report: RecursiveGoalPartialRunReport | null;
  fault: RecursiveGoalErrorDiagnostic;
  knownBoundary: {
    evidence: "none" | "partial" | "retained";
    effects: "none" | "known" | "unknown" | "mixed"
  }
}
```

admission 前结构、限制、重复 id 或根引用错误返回 `RequestRejected`。此时不得生成空 Goal、root frame、accepted root 或 achieved。admission 后可分类失败优先本地 `finalize` 为完整 `RunResult`。只有模块 invariant 或自身状态损坏才返回 `ModuleFault`，并投影仍可信的 report。

## 3. 请求、dependencies 与 admission

未信任请求先由通用 envelope guard 检查，再由 adapter 验证领域值：

```text
RecursiveGoalRequestEnvelope {
  schema: "nnanything.recursive-goal.request.v1";
  requestId: string;
  rootGoal: unknown;
  satisfactionThreshold: 0..100;
  rootBindings: unknown;
  state: unknown;
  rootEvaluatorId: string;
  rootSelectorId: string;
  limits: {
    maxTransitions: nonnegative integer;
    maxDepth: nonnegative integer;
    maxDerivedGoals: nonnegative integer
  };
  initialObservation?: {
    stateId: string;
    evidence: readonly EvidenceRecord<unknown>[]
  };
  continuation?: unknown
  planning?: BoundedPlanningOptions
}
```

`readRecursiveGoalRequestEnvelope(...)` 只接受上述字段。adapter 返回：

```text
ValidatedRequest {
  requestId, rootGoal: G, satisfactionThreshold,
  rootBindings: B, state: S,
  rootEvaluatorId, rootSelectorId, limits,
  initialObservation?: RecursiveGoalInitialObservation<E>,
  continuation: RecursiveGoalContinuation | RecursiveGoalPlanningContinuation | null,
  planning?: BoundedPlanningRequest<G, B>
}
```

adapter 不得换写根 Goal、阈值或绑定。continuation 必须保留 accepted root；改变用户目标要开启新 request。通用模块在 admission 时保存只读根快照。

### 3.1 初始观测证据

`initialObservation` 只用于新请求，且不改变 `state` 的唯一 State 值。request envelope 的 evidence payload 是 `unknown`；`validateRequest` 必须用领域 `evidencePayload` guard 校验它，并在 `ValidatedRequest.initialObservation` 返回 typed `E`。`readRecursiveGoalInitialObservation(...)` 检查精确 shape、非空 `stateId`、evidence id 唯一，以及每条 `EvidenceRecord.stateRef === stateId`。`assertRecursiveGoalInitialObservationContinuationBoundary(...)` 要求 `initialObservation` 与 continuation 互斥；模块在 adapter 返回后必须对 typed request 再调用该 helper，不能信任 adapter 自行维持该边界。

模块收到 typed initial observation 后，把 `state` 写成 `{ id: initialObservation.stateId, value: state }`，并原样保存其中的 evidence；它不扫描领域 State 字段、不调用隐藏观测，也不写入第二份 State 值。没有 `initialObservation` 时保持初始 evidences 为空的兼容路径；cwd 的初始 State 仍可为 unknown，再由正常技能衍生 `pwd` 补证。continuation 只恢复其已保存的 `states/evidence`，不得用新的初始观测替换历史。

零动作已满足根时，调用者仍须用 `state` 提供真实已观测状态，并用 `initialObservation.evidence` 提供对应 `EvidenceRecord`；根 evaluator 引用这些显式 id，不得把 State 内的 seed 字符串当证据。最小示意如下，领域字段由 adapter 守卫：

```json
{
  "schema": "nnanything.recursive-goal.request.v1",
  "requestId": "request-initial-observation",
  "rootGoal": "<domain goal>",
  "satisfactionThreshold": 100,
  "rootBindings": {},
  "state": "<existing domain state value>",
  "rootEvaluatorId": "root.evaluator",
  "rootSelectorId": "root.selector",
  "limits": {
    "maxTransitions": 8,
    "maxDepth": 2,
    "maxDerivedGoals": 4
  },
  "initialObservation": {
    "stateId": "state-initial",
    "evidence": [
      {
        "id": "evidence-initial",
        "stateRef": "state-initial",
        "payload": "<domain evidence payload>",
        "validity": "valid"
      }
    ]
  }
}
```

dependencies 固定为：

```text
RecursiveGoalDependencies {
  adapter;
  enabledSkills: readonly EnabledSkill[];
  enabledEvaluators: readonly EnabledEvaluator[];
  selectors: readonly SelectorBinding[];
  comparators: RecursiveGoalComparators<G, B, S, E>;
  grantedEffects: ReadonlySet<string>;
  planning?: BoundedPlanningCapability<G, B, S, E, F, C>;
  signal?: AbortSignal
}
```

模块没有默认依赖。`planning` 只提供纯结果模型、领域投影守卫、actual/prior 适用性和路径排序；它不拥有 runtime、ledger 或第二份预算。`signal` 供有界 callback 感知取消，不能证明未设期限的 callback 已超时。

## 4. Adapter 单步合同

adapter 每个 callback 只处理当前一步。它不得自行遍历递归树、推进父帧、重置预算、重试不明动作或把多次原子调用藏在一次 callback 内。

### 4.0 逐步反馈与模式反应

每步按“当前条件→合法选择/必要预测→至多一次原子执行→真实后验→事实评价→控制反应”闭合。真实观察由领域原子合同提供，不能用模型自报成功代替。普通模式未启用结果模型时不声称完成预测核对；可替换的选择/衍生/预测/排序/归因不拥有重试计数或停止权。

| 真实反馈 | 普通递归模式 | 有界planning模式 |
| --- | --- | --- |
| 节点/根已满足 | 用当前证据回收必要链，根满足即结束 | 同样结束，不因偏好继续追更高分 |
| 动作成功但目标未达成/无效果 | 仅按声明的安全retry与依赖规则继续，否则明确未达成/停滞/错误 | 正常核对结果及当前入口；适用备选可切换，无适用路才按限额重推；retry仍走同一gate |
| 执行失败/拒绝，当前后验充分且effects=none | 重验已有必要条件和根事实，保留原错误停止；不声称自动换路 | 仅既有可恢复错误类进入领域归因，再重验checkpoint并重推；该失败路径不是正常分叉的自动备选循环 |
| 预测不符或计划前提过期 | 无规划模型时不产生同类结论，按领域前提/证据合同处理 | 正常分叉重验已有备选的当前前提、授权、effects及预算；不适用才重推，unknown不能授权 |
| 有/无备选 | 只有显式retry/selector合同可选次选，没有通用fallback | 正常分叉可检查备选；failed/rejected恢复明确走checkpoint/重推，新图仍需合法入口；缺模型/预算准确停止 |
| 后验缺失或观察失败 | 保留unknown与错误；已提交动作仅可走已声明只读补证，不能重放mutation | 同样受pendingVerification/ledger约束，换图不绕过补证义务 |
| 副作用unknown/mixed/in_flight | 不自动重试或执行次选，只允许授权内只读恢复或准确停止 | checkpoint不是物理回滚，保留实际State及ledger，不能复制旧State清除副作用 |
| retry耗尽/取消/超限 | 返回对应控制结果和累计计数，不假称目标不可能 | 同时保留原retry及planning累计量，重推不清零 |
| 环境自行使根满足/子条件后来失效 | 只按新鲜证据评价；失效持续条件撤销有效性，阶段历史义务不乱撤销 | 同样评价真实根/持续条件；失效路径不再适用，是否可继续仍受恢复准入约束 |

执行失败后根事实可能已满足，但控制仍须保留error及原effects，不输出干净成功。缺能力、缺证据、无适用路线及预算耗尽按各自已有错误/控制返回，不都归为“动作选错”。失败事实、解释及可用限制的领域边界沿[有界规划9.1](bounded-goal-planning.md#91-失败事实归因与路线限制)，不以错误码直接推断全部转移不可用。

最小验收配对：同一A失败、无effects且后验充分，分别在普通/规划模式中运行；有合法B、B已过期、B缺权限、无B应能从报告与当前模式合同解释是否检查/重推/停止。普通模式不得假报switch；失败恢复不得冒称执行了未选B。实际coverage与测试证据另列，不因本表新增而声称所有分支已经自动恢复。

```ts
interface RecursiveGoalAdapter<G, S, B, E, F, R, C> {
  validateRequest(
    request: RecursiveGoalRequestEnvelope,
  ): Promise<ValidatedRequest<G, S, B, E, F, R, C>>;

  supports(input: SupportsInput<G, B>): boolean;

  evaluate(
    input: EvaluationInput<G, S, B, E>,
  ): Promise<EvaluationReceipt>;

  select(
    input: SelectionInput<G, S, B, E>,
  ): Promise<Selection>;

  derive(
    input: DerivationInput<G, S, B, E, C>,
  ): Promise<DerivationReceipt<G, B, C>>;

  executeAtomic(
    input: AtomicInput<G, S, B, E>,
  ): Promise<unknown>;

  validateAtomicReceipt(
    raw: unknown,
  ): AtomicReceipt<S, E, F, R>;

  measureProgress(input: {
    goal: G;
    before: S;
    after: S;
    previousEvaluation: EvaluationReceipt;
    currentEvaluation: EvaluationReceipt;
  }): ProgressReceipt;

  cleanup?(input: CleanupInput<G, S, B, E, F, R>): Promise<ReceiptRef>;
  collect?(input: CollectionInput<G, S, B, E, F, R>): Promise<ReceiptRef>;
}
```

所有 callback input 都带显式 `context: { requestId, frameId, signal }`。

### 4.1 覆盖与选择

```text
EnabledSkill {
  id, version,
  mode: "atomic" | "composite",
  capability,
  evaluatorId,
  requiredEffects, allowedEffects,
  retry: "never" | "completed_no_effect",
  effectClass: "none" | "read_only" | "mutating"
}

SelectorBinding { id, skillIds }
SupportsInput { goal, bindings, skill }
```

`supports` 是纯合同兼容检查。它不得选技能、评价、观测或执行。模块先做确定性覆盖检查。没有兼容技能返回 `capability_missing`；有覆盖时 selector 仍接收其声明的完整启用词表，不按当前 Goal 裁剪候选或 logits。

`SelectionInput` 包含 selector id、当前 Goal/阈值/绑定、State、Evidence、ConditionFact、上一次 EvaluationReceipt 和完整 candidates。规划模式另带 `planning?: PlanningSelectionView`，只提供当前 plan/path/cursor、预期技能和合法入口引用；它不能裁剪候选词表或替换错误 head。输出是判别联合：

```text
{ kind: "selected"; skillId }
{ kind: "no_capability"; searchedSkillIds }
```

`skillId` 必须在候选词表内。`searchedSkillIds` 必须等于候选词表。覆盖存在却返回 `no_capability` 或选择越界时返回 `policy_error`，不得静默替换成“正确”技能。权限不足返回 `effect_denied`。

### 4.2 评价与进展

```text
EvaluationReceipt {
  evaluatorId;
  result: "satisfied" | "unsatisfied" | "unknown";
  satisfaction: 0..100 | null;
  necessaryConditionsMet: boolean;
  evidenceRefs: readonly string[]
}

ProgressReceipt {
  improved: boolean;
  reason: "obligation_reduced" | "facts_improved" | "none";
  comparable: boolean
}
```

`evaluate` 和 `measureProgress` 是纯评价。它们只能读取传入的 State、证据和条件；需要新观测时必须先通过正常技能衍生与 dispatch。evaluator 不得直接读文件、页面、进程、环境或被隐藏资源。

`measureProgress.before` 从本帧 `ProgressBaseline.stateRef` 指向的 `StateRecord` 恢复；`previousEvaluation` 使用 baseline 中保存的 receipt，`currentEvaluation` 使用当前实际评价。不要在恢复时重新执行历史动作来取得 before State。

`satisfied` 必须有有效 evaluator、非空 evidence refs、数值 satisfaction 达到本帧阈值且 `necessaryConditionsMet=true`。根/帧 evaluator 的每个 evidence ref 必须能从响应内的 `states/evidence` 解析。模块调用导出的 `assertRecursiveGoalEvaluationEvidenceRefs(...)`：`satisfied` 引用的证据必须全部为 `valid`；当前 State 的 `stale/conflict` 证据仍可由纯领域 evaluator 形成 `unsatisfied` 或 `unknown`，但不得形成 `satisfied`。`unsatisfied` 表示已证未满足。`unknown` 表示已评价但证据不足。没有有效评价时是 `not_evaluated`，不能等同于 `evaluated/unknown`。

### 4.3 衍生

```text
DerivedCondition<G, B> {
  id;
  goal: G;
  bindings: B;
  satisfactionThreshold;
  evaluatorId;
  selectorId;
  mode: "atomic" | "composite";
  dependsOn: readonly string[];
  lifetime: "stage" | "persistent";
  activation: "required" | "not_applicable";
  allowedEffects: readonly string[]
}

DerivationReceipt<G, B, C> {
  conditions: readonly DerivedCondition<G, B>[];
  nextCursor: C;
  expansion: "more" | "closed"
}
```

`derive` input 含当前 frame、skill、cursor、Goal/阈值/绑定、State、Evidence、ConditionFact。一次只返回一个有限批次，不执行子技能。模块检查 id 唯一、batch 内依赖无环、effect 收窄和预算。`more` 只表示 adapter 可响应后续有限 derive，不允许 adapter 内部循环。

continuation 保存每个已接收 `DerivedCondition` 的原定义，以及该帧最近一次 `expansion`。恢复不得重新调用 derive 重建这些定义；`more` 与 `closed` 必须原样保留。

`stage` 条件完成后保留历史证据。`persistent` 条件在父完成时仍须成立；后续 State 变化必须重评有效性。未选分支只有 `activation:"not_applicable"` 才能记为跳过。已选失败分支不能改成跳过。

### 4.4 原子执行

`AtomicInput` 含当前 skill、Goal/阈值/绑定、State、Evidence 和 callback context。`executeAtomic` 只执行当前一个原子技能，返回未信任的 domain raw。领域必须通过 `validateAtomicReceipt` 加 tag、验证 payload 并返回：

```text
AtomicReceipt {
  runId: string | null;
  executorInvoked: boolean | "unknown";
  outcome: "succeeded" | "failed" | "rejected" | "unknown";
  sourceResult: DomainReceipt<R> | CapturedWorkflowFailure | null;
  newState: { id, value: S } | null;
  evidence: readonly { id, stateRef, payload: E, validity }[];
  executionErrors: readonly AdapterDiagnostic[];
  verificationErrors: readonly AdapterDiagnostic[];
  effect: {
    knowledge: "none" | "known" | "unknown" | "mixed";
    confirmedEffects: readonly F[];
    receiptRef: string | null
  }
}
```

原子 receipt 的 `executorInvoked=false` 不得声明 known/mixed effect。`none` 不得带 confirmed effects；`known` 和 `mixed` 至少有一条 confirmed effect。原始 code、stage、message、nativeCode、nodeId 和 executor 状态只可从 typed source 保留，不从文本猜 errno。

## 5. 根、帧、条件与依赖

根 acceptance 快照：

```text
AcceptedRoot {
  requestId;
  rootFrameId;
  rootGoal: G;
  rootThreshold: 0..100;
  rootBindings: B
}
```

`rootGoal`、`rootThreshold`、`rootBindings` 全程只读。`sameAcceptedRoot(left, right, comparators)` 只比较 requestId、rootFrameId、阈值、Goal 和 bindings。不同 frame id、timestamp 或 cursor 不能证明根已改变或仍未改变。

帧报告：

```text
FrameResult {
  frameId; rootRef; parentFrameId; fulfillsConditionId;
  goal; bindings; mode; depth;
  selectedSkillId; cursor: C | null;
  conditionResults: ConditionFact[];
  activeRequirements; unresolvedRequirements;
  fact: "not_evaluated" | "satisfied" | "unsatisfied" |
        "unknown" | "not_applicable";
  execution: "not_started" | "dispatched" | "completed" |
             "failed" | "cancelled";
  unexecutedReason: "dependency_not_met" | "budget" | "cancel" | null;
  errorId; evidenceRefs; dispatchRefs; atomicResultRefs;
  noProgressCount
}

ConditionFact {
  conditionId;
  fact;
  satisfaction: number | null;
  evaluatorId: string | null;
  evidenceRefs;
  childFrameId: string | null
}
```

`rootRef` 必须等于 accepted root 的 root frame。child 的 `fulfillsConditionId` 属于直接父帧。条件结果、帧结果和执行状态分开记录：

- 依赖失败且从未派发：`not_started + dependency_not_met`。
- 明确取消影响该帧：才可记录取消；未派发取消使用 `unexecutedReason:"cancel"`。
- 未选活动分支：`not_applicable`。
- 已发生动作即使失败也保留 ledger 和 atomic result。

`FrameResult` 是报告投影。continuation 另保存与每帧一一对应的 typed control、显式 stack 和 dependency state：

```text
FrameStackEntry {
  frameId; parentFrameId; fulfillsConditionId;
  phase: "evaluate" | "select" | "derive" |
         "await_children" | "aggregate";
  cursor: C | null
}

FrameEvaluation {
  receipt: EvaluationReceipt;
  evaluatedAtTransition
}

ProgressBaseline {
  stateRef: string;
  evaluation: EvaluationReceipt;
  capturedAtTransition
}

ObligationSnapshot {
  mode;
  selectedSkillId;
  unresolvedConditionIds;
  stateRef: string;
  evidenceRefs;
  conditions: ConditionFact[]
}

FrameControl<G, B> {
  frameId;
  satisfactionThreshold;
  evaluatorId;
  selectorId;
  effectScope;
  expansion: "not_derived" | "more" | "closed";
  evaluation: FrameEvaluation | null;
  progressBaseline: ProgressBaseline | null;
  pendingVerification: {
    dispatchId; skillId; verificationErrorIds: string[]
  } | null;
  obligationSnapshot: ObligationSnapshot | null
}

DependencyState<G, B> {
  ownerFrameId: string;
  condition: DerivedCondition<G, B>;
  fact;
  execution;
  childFrameId: string | null
}
```

`FrameControl` 保存当前帧继续所需的有限控制配置，不能只存 `frameId` 后由 adapter 猜阈值、评价器、selector 或 effect scope。`effectScope` 是当前帧允许动作的真实范围；根 scope 等于 continuation 明确保存的 `grantedEffects`，子 scope 不得宽于其原始 `DerivedCondition.allowedEffects`、父 scope、当前组合技能的 `allowedEffects` 或授权词表。所有 `allowedEffects` 都是显式集合；`[]` 表示无权限，不代表继承，模块不得改写原条件来扩大范围。`expansion` 与 `FrameResult.cursor` 共同保存已完成的 derive 批次位置；历史条件不重算。

`DependencyState` 的 `ownerFrameId` 是派生该条件的父帧，`condition` 是规则原先给出的完整有限定义，而不是可由 condition id 重新推导的摘要。`fact`、`execution` 和 `childFrameId` 只记录当前依赖状态。condition 的 `dependsOn` 必须在本 owner 的定义表内闭合且无环，child frame 的 parent、condition、Goal、bindings、mode、阈值、evaluation/selection 与 effect scope 必须匹配同一 owner 引用。

`FrameEvaluation` 保存最近一次可继续使用的评价。`ProgressBaseline` 的 `stateRef` 指回 `states` 表，`evaluation` 是动作前评价；不复制完整 State 或 Evidence。`ObligationSnapshot` 保存祖先义务比较所需的 mode、skill、未消解条件、State ref、Evidence refs 和当时的 ConditionFact 快照。恢复时可由这些显式 refs 重构纯比较输入，但不得从 cursor、业务 payload 或 frame id 重建控制。

首次评价尚未选技能时，可以保存baseline；该合法阶段停止后仍可续接，累计消耗不清零。`pendingVerification` 单独保存已提交但后验失败的待验证义务，引用已有dispatch、技能及原验证错误。effect仍保持真实`known`；它不表示Goal已经验证。恢复只能选择显式启用的只读或无副作用原子补证技能；缺能力或仍选择mutation时返回evidence_unavailable，不重放已提交动作。未选分支保持fact:not_applicable、execution:not_started，取消和恢复不会把它改成已执行。

待验证义务只允许进入受限选择阶段；只有已经返回实际成功补证回执，且其State与当前State一致时，才可恢复到评价阶段。准入同时核对该技能的只读/无效果原子合同。局部fact为satisfied不能删除待验证字段；评价必须引用该实际补证State上的有效证据，随后才显式清除义务。补证已返回但评价前预算耗尽时，续接直接消费这份回执，不重复派发。

persistent子条件自底向上重评。每个帧只用自己的Goal和条件集取得自己的评价回执；不能把后代评价结果直接写成父帧事实。停止时诊断保留真实源帧，control指向实际活动栈位置；依赖的execution保留子帧真实执行状态，使失败和重评中途预算停止都能原样恢复。

调度稳定顺序不来自模型学习。图内不回边；stack 的 `phase` 是唯一阶段位置，frame control、dependency state、状态表和祖先快照共同构成中间 node 的可序列化显式 State。公开 `RunState` 不含函数、资源句柄或隐藏 controller。

## 6. 等价比较与循环下降

应用注入纯比较器：

```ts
interface RecursiveGoalComparators<G, B, S, E> {
  sameGoal(left: G, right: G): boolean;
  sameBindings(left: B, right: B): boolean;
  sameFacts(
    left: {
      state: S;
      evidence: readonly EvidenceRecord<E>[];
      conditions: readonly ConditionFact[];
    },
    right: {
      state: S;
      evidence: readonly EvidenceRecord<E>[];
      conditions: readonly ConditionFact[];
    },
  ): boolean;
}
```

比较器必须纯、确定性且不得观测或执行。模块用 `sameRecursiveGoalObligation(...)` 比较：

- Goal；
- bindings；
- 当前执行模式；
- selected skill id；
- 未消解条件 id 集；
- 当前 State、Evidence 和 ConditionFact。

continuation 中的祖先义务取 `FrameControl.obligationSnapshot`，并通过其 `stateRef` 与 `evidenceRefs` 从已有 `states/evidence` 表恢复比较输入；condition fact 使用快照内有限控制记录。不得用当前业务 cursor、后续 frame result 或重新 derive 的历史条件替换快照。

不使用 SHA、checksum、序列化文本或新 frame id。相同 Goal 的 composite→atomic 合法下降可通过。相同 Goal、bindings、模式、技能和事实再次展开同一未消解义务返回 `derivation_cycle`。事实变化不保证无限允许，仍受全树预算。

## 7. dispatch ledger、atomic result 与 effect

任何可能产生副作用的调用前先写：

```text
EffectRecord {
  dispatchId; frameId; skillId;
  dispatchState: "not_dispatched" | "in_flight" | "returned";
  knowledge: "none" | "known" | "unknown" | "mixed";
  confirmedEffects: readonly F[];
  receiptRef: string | null
}
```

`in_flight/unknown` 表示已记 dispatch 风险，不表示动作已发生。adapter 正常返回后更新 `returned`。异常返回时保留 unknown/mixed；不得自动推断安全重试。

每个已尝试原子步骤报告：

```text
AtomicExecutionResult {
  dispatchId; frameId; skillId; runId;
  executorInvoked;
  outcome;
  sourceResult;
  executionErrorIds;
  verificationErrorIds;
  effect: EffectRecord<F>;
  observedStateRef
}
```

`dispatchId` 是本响应内唯一 atomic result 引用。frame 的 `atomicResultRefs`、error 的 `atomicResultRefs` 和 `executionErrorIds` 必须解析到同一响应内的项。effect record 与 atomic result 的 dispatch/frame/skill/knowledge/confirmedEffects/receiptRef 必须一致。

模块前置拒绝返回 `not_dispatched/executorInvoked=false/knowledge=none`。领域 workflow 内拒绝时 dispatch 返回 returned，但 OS executor 仍可为 false。cd 已提交但后验失败时，必须同时保留 source success/receipt、known effect 和 verification error，不能把后验失败当作执行未发生。

## 8. 稳定错误合同

错误码固定为：

```text
invalid_request, invalid_binding, capability_missing,
precondition_unsatisfied, evidence_unavailable, evidence_conflict,
policy_error, effect_denied, execution_failed, effect_outcome_unknown,
derivation_cycle, no_progress, budget_exceeded, cancelled,
adapter_contract_invalid, workflow_failure
```

```text
RecursiveGoalErrorDiagnostic {
  errorId;
  code;
  stage: "admission" | "binding" | "evaluation" | "selection" |
         "derivation" | "dispatch" | "execution" | "observation" |
         "effect" | "aggregation" | "cleanup" | "collection" |
         "finalization";
  origin: { frameId, skillId, conditionId, evaluatorId, nodeId };
  source: {
    owner: "module" | "adapter" | "workflow";
    category; nativeCode; refs
  };
  effectKnowledge;
  atomicResultRefs;
  cause:
    { kind: "captured_error"; name; message; nativeCode } |
    { kind: "error_ref"; errorId } |
    null;
  propagation: readonly {
    frameId;
    parentFrameId;
    satisfies: { frameId; conditionId } | null
  }[];
  diagnosticMessage
}
```

一个 errorId 只对应 errors 表内一份原因。父链只追加 `propagation`，不改 origin/code/nativeCode/cause，也不复制“子失败”。cause 的 error_ref 必须解析且无环。`source.refs` 只补充大体积外部证据；执行错误本体和必要诊断必须在 response 内。

| code | 可证明条件 | 不可推断 |
| --- | --- | --- |
| `invalid_request` | admission 前 envelope、限制或根引用非法 | 不存在 accepted root |
| `invalid_binding` | 已保留 Goal/对象/skill 绑定不可用 | executor 已执行 |
| `capability_missing` | 已启用技能没有兼容目标/条件合同 | 世界永久不可能 |
| `precondition_unsatisfied` | 必要前置事实已证为 false | 未派发动作已发生 |
| `evidence_unavailable` | 必要证据缺失、未保留或后验失败 | Goal 为 false |
| `evidence_conflict` | 保留证据冲突且不可裁决 | 任一方自动为真 |
| `policy_error` | 越界选择、错误 head，或有覆盖时误报无能力 | 领域目标失败 |
| `effect_denied` | dispatch 前授权检查拒绝 | 动作已执行 |
| `execution_failed` | typed receipt 明示执行失败 | receipt 外副作用 |
| `effect_outcome_unknown` | 已过副作用边界且无结论 receipt | 成功、失败或可安全重试 |
| `derivation_cycle` | 同义务、事实、技能和模式无下降再衍生 | 合法 composite→atomic 下降 |
| `no_progress` | 同一安全可重复义务连续两次无进展 | 任意重复都是 stalled |
| `budget_exceeded` | 下一控制转换或派生超出共享额度 | 动作已派发 |
| `cancelled` | 显式取消终止未完成工作 | 已提交副作用已回滚 |
| `adapter_contract_invalid` | callback 输出或可捕获异常违反合同 | 领域缺能力 |
| `workflow_failure` | compile/run failure 或无法映射的上游 failure | 丢失的 errno |

issue 不覆盖 primary。cleanup/collection 失败先进入 `RelatedIssue`。没有 primary 时，仅影响资源安全或数据正确性的必需清理失败可提升为 primary。

## 9. Report、budget 与 continuation

```text
RunReport {
  root: AcceptedRoot;
  rootEvaluation: RootEvaluation;
  control: {
    outcome: "completed" | "error" | "stalled" | "exceeded" | "cancelled";
    stopReason: "root_evaluation" | "fatal_error" | "no_progress" |
                "budget" | "cancel" | "no_remaining_work";
    frameId: string | null
  };
  states;
  evidence;
  frames;
  effects;
  atomicResults;
  errors;
  primaryErrorId: string | null;
  relatedIssues;
  budgetUsed: { transitionsUsed; derivedGoalsUsed };
  continuation: RecursiveGoalContinuation | RecursiveGoalPlanningContinuation | null;
  planning?: PlanningReport;
  cleanup: ReceiptRef | null;
  collection: ReceiptRef | null
}
```

`RootEvaluation` 严格区分：

```text
{ state: "not_evaluated"; reason; blockedByErrorId }
{ state: "evaluated"; result; satisfaction; evaluatorId;
  evidenceRefs; evaluatedAtTransition }
```

`control.completed` 只在必要链、根评价和全部必需收口完成时使用。消费者仍须读取 `rootEvaluation`；event 或 workflow 的 completed/ok 不表示 Goal achieved。根已事实满足后若必需清理失败，可返回 error，但不得把根事实改成 unsatisfied。

五类 transition 共用累计预算：`evaluate`、`select`、`derive`、`dispatch`、`aggregate`。计费发生在调用前；State/ledger 落账、停止收束和 finalize 不收费。`maxDerivedGoals` 不含根；`maxDepth` 以根 depth 0。超限后不得启动新 Goal 技能；已派发原子调用仍可完成其原合同后验并落账。

continuation 是显式控制数据，不是持久服务：

```text
RecursiveGoalContinuation {
  schema: "nnanything.recursive-goal.continuation.v1";
  acceptedRoot;
  lastTrustedTransition;
  rootEvaluation;
  control;
  frames;
  frameControls: FrameControl<G, B>[];
  stack;
  dependencies: DependencyState<G, B>[];
  states;
  evidence;
  ledger;
  atomicResults;
  errors;
  primaryErrorId;
  relatedIssues;
  budgetUsed;
  remainingRequirements: {
    frameId: string;
    conditionId: string
  }[];
  contractRefs: {
    enabledSkillIds;
    evaluatorIds;
    selectorIds;
    grantedEffects
  }
}

RecursiveGoalPlanningContinuation {
  schema: "nnanything.recursive-goal.continuation.v2";
  ...all-v1-copyable-runtime-fields;
  planControl: PlanControl<G, B, S, E, F>;
  planningContract: PlanningContractRefs;
  actionBoundary: PlanningActionBoundary | null
}
```

`readRecursiveGoalContinuation(...)` 继续只接受 v1。`readRecursiveGoalPlanningContinuation(...)` 接受严格 v2；`readRecursiveGoalResumableContinuation(...)` 只按 schema 分派，不做字段猜测。两者都由应用注入 `goal/state/bindings/evidencePayload/effectFact/sameEffectFact/receiptPayload/cursor` guards，以及 `sameGoal/sameBindings/sameCursor` 纯比较器，并检查：

- accepted root 不变；root frame 的 Goal、bindings、阈值和 effect scope 匹配 accepted root；
- `frameControls` 与 frames 一一对应；每帧阈值、evaluator、selector、skill、effect scope 引用显式合同且可继续；
- 已评价 frame 的 `fact` 与 `FrameControl.evaluation.receipt.result` 一致，选择技能后必须同时保留评价和祖先义务快照；
- stack 是从 root 到 leaf 的唯一祖先路径，parent/condition/cursor 与 frame 一致；stack 的 `phase` 是恢复阶段位置；
- `DependencyState.ownerFrameId`、完整 `DerivedCondition`、`dependsOn`、child frame 和条件 fact 双向闭合，定义图无环；
- State、Evidence、frame/condition/root/control 的 evidence refs、ProgressBaseline.stateRef 与 ObligationSnapshot refs 闭合；当前 frame/root 的 `satisfied` 评价只能引用 `valid` evidence；
- `RootEvaluation` 与 root `FrameControl.evaluation` 的评价结果、阈值位置、evaluator、evidence refs 和 transition 一致；
- evaluation 和 ProgressBaseline 的 transition 不超过 `lastTrustedTransition`，累计 budget 不小于该位置；
- effect ledger 与 atomic result 一致；
- frame dispatch/atomic/error refs、error cause 和 related issue 闭合；
- primary error 可解析；`remainingRequirements` 必须等于各 frame 的 `unresolvedRequirements`，且每个 owner frame/condition 定义可解析；
- error cause 无环；
- contractRefs 保存当前显式技能、评价器、selector 和 effect 授权词表。

v2 额外检查 `planControl`、`planningContract` 与 `actionBoundary`：

- plan root 等于 accepted root frame；start State、verified checkpoint、prior source 和 observed State 全部解析到 v1 runtime 表；
- plan model/checkpoint/horizon 与 `planningContract` 一致，plan 内节点、结果边、路径与 frontier 引用闭合；
- action boundary 的 frame、dispatch、atomic result 和 observed State 一致；它不能由 predicted node 构造；
- planning counts 非负、累计不下降并受 planning-only limits 约束；总 transitions/retry/ledger 仍只读 v1 budget owner。

恢复只接受已经保存的 typed frame control 和 dependency definition。adapter 可以重新解析 Goal/State/bindings/证据数据，并将等价领域值归一化到既有定义，但不得只凭 `frameId`、cursor、业务 payload 或当前 adapter 配置猜阈值、评价器、selector、effect scope 或条件语义。continuation 请求不得携带新 `initialObservation`；恢复的 State/evidence 只能来自 continuation 表。缺少任一控制字段即 `adapter_contract_invalid`，不得静默补默认值。

恢复从 stack 保存的 `phase` 继续。已经完成的 derive 批次直接使用 `FrameResult.cursor`、`FrameControl.expansion` 和持久化条件定义，不再次调用 `derive` 以重算历史。已经完成或已进入 ledger 的 atomic effect 不重放；恢复只从已保存的 receipt、State refs 和证据继续评价或聚合。unknown/mixed effect 先走已声明的只读补证，不重复原 mutation。

恢复时保留累计预算。新增额度只能来自新的显式请求总限额，不能隐式归零。恢复可重评当前事实以确认旧证据是否仍有效，但该评价不是历史 derive 的重演，也不改变已保存条件定义。需要外部补证时只可选 `effectClass:"none"` 或 `"read_only"` 的已启用技能。`mutating` 技能不能作为 unknown/mixed effect 的自动补证。没有只读补证能力则返回 `evidence_unavailable`。未知 effect 未澄清前不得继续依赖它的后继，也不得重发原 mutating 动作。

`measureProgress`、新 timestamp、run id、重复同值观测、日志条数和模型分数升高都不是自动进展。安全重试必须同时满足：技能声明 `completed_no_effect`、执行明确结束、effect knowledge 为 none、规则允许、预算/绑定/证据仍有效。连续两次安全完成但无进展才可 stalled。

## 10. Workflow failure 与 facade

`runWorkflow` 的上游 failure 会跳过下游 report。facade 在每次 await 外保留本请求独占 `RunState`；返回 failed、抛错或非预期事件后，由本地 `finalize(state)` 生成报告。

映射边界：

- `WorkflowContractError`、`status:"failed"`、`flow_execution_failed` 和无法映射的 `invalid_node_event` 收束为 `workflow_failure`，保留可用 category、nodeId 和 events refs。
- 模块 dispatch 前发现未授权 effect 映射 `effect_denied`；进入执行后才返回的 unauthorized effect 保留 workflow failure 和真实 ledger。
- adapter 普通 TypeError、缺字段、非法 frame/skill/effect 映射 `adapter_contract_invalid`。
- admission 后内部 `invalid_input_event` 属于模块或 adapter 合同故障，不回退成 RequestRejected。
- events 只作证据引用，不从数量、文本或 `status` 推断副作用。workflow `completed` 不代表 Goal satisfied。

report node 只生成 typed projection。若基础 runner 异常，模块不得以伪造成功 event 维持表面 SESE，也不得依赖 report 节点是唯一错误出口。

## 11. 取消与清理

每次新控制转换先检查取消和预算。正在执行的 callback 必须等待其有界回执，或在返回时明确 effect unknown。取消不回滚已发生动作。停止生效前已正式结束且必要链已收束的根保持原结果；迟到取消不重写已完成结果。

cleanup/collect 输入含 accepted root、可信 State/Evidence/effects/atomic results 和 callback context。它们使用独立、有界、显式授权动作，不承担新 Goal 技能。

已派发原子调用的 effect ledger 在所有返回和异常路径保留。cleanup/collection 失败不得覆盖 primary error、根事实或已提交 effect。

## 12. 场景边界

| 场景 | 根事实 | control/error | effect |
| --- | --- | --- | --- |
| 无适用技能 | 已评价值保留，否则 not_evaluated | error/capability_missing | none |
| 绑定拒绝 | 未评价或保留前序事实 | error/invalid_binding | none |
| selector 选错 | 前序事实不变 | error/policy_error | none |
| OS typed failure | 未评价或 unknown | error/execution_failed | receipt 明示 |
| 已提交但后验失败 | 通常 unknown | error/evidence_unavailable + 原验证错误 | known |
| 超预算 | 前序评价保留 | exceeded/budget_exceeded | 未派发为 none |
| 取消 | 前序评价保留 | cancelled/cancelled | none/known/unknown |
| runner failure | 前序评价保留 | error/workflow_failure | 依 ledger |
| 清理失败 | 原根事实不变 | 原 primary 或安全相关新 primary | 清理单列 |

若实现把叶 failed 直接复制为根 unsatisfied/achieved、把 capability_missing 解释为世界永久不可能、从 text/log 猜 errno、重放已提交/unknown effect、以未执行 `not_applicable` 代替失败、或在 root evaluator 缺失时产生 satisfied，均视为合同违约。

## 13. 当前实现状态与验收

当前实现包含：

- `contracts.ts` 的 generic public types、判别 response、request/continuation/evaluation/selection/atomic guards，以及显式 `initialObservation` 与 evidence refs 闭包 helper；
- `planning-contracts.ts` 的 planning plan/node/edge/path/frontier/checkpoint/prior/control/decision types、v1/v2 分派守卫和 planning-only 引用闭包；
- `module.ts` 提供有界显式栈、admission、预算、取消、dispatch ledger、三个 `goal.recursive.*@0.2.0` 算子、本地 finalize 和公开 `runRecursiveGoal`；可选planning接入v2续接、单步边界、checkpoint及范围化失败恢复；
- `errors.ts` 的稳定 diagnostic、source 映射和父链传播；
- `lib/recursive-goal.ts` 与 package subpath `nnanything/recursive-goal`；
- 合同图与三个NodeDefinition均为`0.2.0` 3N2E，复用现有workflow编译/运行；6N5E bounded图只描述内部责任，不另建引擎。

有界增量证据位于`/Volumes/Intel/playground/nnanything-runs/bounded-reasoning-prototype-20261020`。有限域控制、新进程及真实cwd四场景由新增公开consumer测试覆盖；真实Handwired决策替换和热重载按[决策合同](bounded-planning-decision.md)验收。恢复不复制历史State，不删除错误/effects或重置预算，不重放unknown/inflight。当前有限规则不代表任意高层Goal已训练；具体分母与整体交付沿note.md。

原v1实施证据归档于 `/Volumes/Intel/playground/nnanything-runs/recursive-goal-implementation-20261020/`：

- 最新`r5-build.log`、`r5-recursive.log`与`r5-full.log`分别为构建通过、58/58递归测试及735/735正式全仓测试，均无跳过。新增首次子评价前取消往返：保留`not_evaluated`与空评价字段，同步真实取消execution；原样恢复成功，首次零动作、恢复后原子动作一次且预算累计。`r5-cancel-red.log`保留修前无evaluator的unknown被拒绝的真实红测。`r5-cwd.log`4/4、`r5-finite.log`及`r5-integrity.log`7/7通过；下列较早结果保留其当时覆盖范围。
- `r4-recursive.log`：57/57公开递归测试通过，无跳过。在原42项和首次整改51项上补充深层失败/预算/取消续接、错误补证phase、已返回补证回执续评以及未闭合后代保护。父局部条件达标不能绕过未闭合必要链；persistent子帧使用自己的条件集并自底向上重评。取消保留真实诊断源，停止control定位活动栈，并同步父条件的实际执行状态。`r3-cancel-red.log`保留取消原样续接失败的红测；`effect-scope-red.log`中两个权限反例在修复前各真实执行一次未授权write，修复后均零执行。
- `r4-full.log`：正常 `npm run test:full` 为734/734通过，无跳过。原`author-full.log`的719/719、`review-fix-full.log`的728/728及`r2-closure-full-final.log`的733/733为此前已覆盖范围的原始结果。独立verifier的只读全仓运行曾因扩展测试需要生成artifacts而受限；该限制由具有原始写入授权的owner执行完整命令闭合，未改测试或降低断言。
- `verification-cwd.log`：独立公开cwd consumer为4/4通过，最新`r2-closure-cwd.log`同样4/4。真实same、different、绑定拒绝与真实cd后受控观察故障分别保留原始回执；profile未训练、修改或采用。
- `verification-finite.log`及最新`r2-closure-finite.log`：同一runtime完成至少三级非CLI嵌套、同层三依赖、分支、persistent失效及60/100覆盖阈值。固定10项范围分别检查6项/10项；找到匹配另作必要条件。
- `verification-integrity.log`及最新`r2-closure-integrity.log`：独立设计的7项完整性probe均通过，覆盖根与历史隔离、无效证据拒绝、report-node故障后保留ledger。V05是定点fault injection，只证明该故障边界，不冒称真实OS故障。
- `verification-public-api.log`：原子根一步完成、显式初始证据零动作完成、两个并发请求的根/ledger/预算隔离，3/3通过；这不是单次运行内部的动作并发调度。

独立验证的逐项结论、整体Review与main交付回执由note.md单一入口维护。历史外置cwd probe的87/87只证明旧外部组合逻辑，不计算为上述新结果。组合选择器仍为显式有限规则；未训练递归层序、是否继续或任意高级Goal模型。调用者必须提供有界adapter；本模块不承诺进程崩溃后返回、永不返回callback的终止、跨进程exactly-once或并发重复恢复保护。
