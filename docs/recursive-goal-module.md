# 通用递归目标独立模块与准确错误合同

状态：2026-10-20，设计合同，未实现。未来源码 owner 为 `lib/workflow/recursive-goal/`，公开门面为 `lib/recursive-goal.ts`，计划 subpath 为 `nnanything/recursive-goal`。当前这些路径不存在，不是可导入 API；模块复用现有执行器。旧合同 [recursive-goal-design.md](recursive-goal-design.md) 继续负责通用语义与 3N2E；本文唯一维护独立模块边界、公开I/O、错误与执行结果传播。不新增运行图或当前package导出。

## 1. 边界与依赖

模块管理 Goal 帧生命周期、条件衍生、预算、取消、dispatch ledger 和统一返回。领域应用负责 typed Goal、对象绑定、证据有效性、原子 workflow、评价器和副作用执行。

模块只 import `lib/core/` 的事件、端口、错误与通用 types，以及 `lib/workflow/` 已有 `compileWorkflow`、`runWorkflow`。禁止 import `lib/cli-goal`、具体 CLI/browser/training/filter/node/adapter。应用必须显式注入 Adapter、已启用 skills、已启用 evaluators、已授权 effects 和初始 State。模块没有默认 Adapter、默认 profile、全局可变 singleton 或从环境推断的资源。

独立模块不得绕过现有 workflow。原子技能继续编译和执行其领域图；外层仍由 `recursive-goal@0.1.0-design` 的 3N2E 表达。`report` 节点只可渲染快照，不是错误真源，也不保证在 runner 上游 failure 后执行。

拟定目录最小划分为 `contracts.ts`（类型与运行时守卫）、`module.ts`（调度与 facade）、`errors.ts`（领域错误映射）。实现前可合并小文件，但不得把领域语义写进本模块。

## 2. 公开调用与 total response

拟定入口：

```ts
runRecursiveGoal(
  request: unknown,
  deps: {
    adapter: RecursiveGoalAdapter;
    enabledSkills: readonly EnabledSkill[];
    enabledEvaluators: readonly EnabledEvaluator[];
    grantedEffects: ReadonlySet<string>;
  },
): Promise<RecursiveGoalResponse>;
```

公开结果是封闭联合，不允许以裸 `ok`、`null` 或抛出的普通 `Error` 表示业务结束：

```text
RecursiveGoalResponse =
  RequestRejected | RunResult | ModuleFault

RequestRejected {
  kind: "request_rejected"; requestId: string | null;
  acceptedRoot: null; error: ErrorDiagnostic
}

RunResult {
  kind: "run_result"; requestId: string; acceptedRoot: AcceptedRoot;
  report: RunReport
}

ModuleFault {
  kind: "module_fault"; requestId: string | null;
  acceptedRoot: AcceptedRoot | null;
  report: PartialRunReport | null; fault: ErrorDiagnostic;
  knownBoundary: { evidence: "none" | "partial" | "retained";
                   effects: "none" | "known" | "unknown" | "mixed" }
}
```

入参格式、限制、重复 id、未注入评价器或未绑定根等错误在 admission 阶段返回 `RequestRejected`。此时没有已接受根，不得伪造空 Goal、root frame 或 achieved 结果。`invalid_request` 与 `invalid_binding` 都可导致拒绝，但原因保持不同。

admission 成功后，正常结束、预算、取消、stalled、领域执行失败和可分类的框架失败都返回同一 `RunReport` 骨架。`ModuleFault` 只用于模块自身状态或回调结果已不可信的内部故障；若已接受请求，仍返回最后可信 root、ledger 和 knowledge 边界，不补造缺失证据。

模块只承诺处理可捕获的异常与按合同返回的有界adapter回调。OOM、进程终止、宿主崩溃、同步死循环或永不返回的callback不能保证同步返回；不能把未设执行期限的回调伪称已超时。应用必须提供满足有界执行合同的adapter，宿主故障与可返回模块错误分开。

## 3. 根事实、控制停止与帧结果

`rootGoal`、`satisfactionThreshold`、`rootBindings` 在 admission 时快照，全程只读。帧不得改写根或降低阈值。

```text
RootEvaluation =
  { state: "not_evaluated"; reason:
      "not_reached" | "no_evaluator" | "binding_error" | "runner_fault";
    blockedByErrorId: string | null }
  |
  { state: "evaluated";
    result: "satisfied" | "unsatisfied" | "unknown";
    satisfaction: number | null;
    evaluatorId: string; evidenceRefs: readonly string[];
    evaluatedAtTransition: number }

Control = {
  outcome: "completed" | "error" | "stalled" | "exceeded" | "cancelled";
  stopReason: "root_evaluation" | "fatal_error" | "no_progress" |
              "budget" | "cancel" | "no_remaining_work";
  frameId: string | null
}

RunReport = {
  root: AcceptedRoot; rootEvaluation: RootEvaluation; control: Control;
  frames: readonly FrameResult[]; effects: readonly EffectRecord[];
  atomicResults: readonly AtomicExecutionResult[];
  errors: readonly ErrorDiagnostic[];
  primaryErrorId: string | null;
  relatedIssues: readonly RelatedIssue[];
  budgetUsed: BudgetUsed; continuation: Continuation | null;
  cleanup: ReceiptRef | null; collection: ReceiptRef | null
}

PartialRunReport {
  lastTrustedTransition: number;
  rootEvaluation: RootEvaluation | null;
  frames, atomicResults, errors, effects; // 仅从仍可信的typed RunState投影
  unavailableSections: readonly string[]
}
```

PartialRunReport不是任意字段缺失的Partial类型。它明确列出仍可信的部分及不可用段；响应中的error/atomic引用只指向已返回项，丢失的细节记不可用，不发不可解析的悬空引用。ModuleFault也必须尽力返回已保留的执行错误及回执，不能因为report节点跳过而丢掉它们。

`result: "satisfied"` 才表示根目标事实已满足，且必须有有效 evaluator、证据引用、数值 satisfaction 达到阈值并满足 adapter 声明的必要条件。`unsatisfied` 表示已证未满足，`unknown` 表示已评价但证据不足。`not_evaluated` 与 `evaluated/unknown` 不同，根没有有效 evaluator 时不得标记 `satisfied`。

现行 CLI `goal.status` 可由 CLI adapter 映射为领域 evaluation receipt，但不得直接成为通用 `Control`、root result union 或跨域枚举。其他领域可以声明不同 Goal 类型和评价器，只要映射到本合同的 `not_evaluated`、`evaluated/satisfied|unsatisfied|unknown`。

`Control.completed`只在必要链均收束、根评价satisfied且没有未决必需验证时使用，消费者仍必须读取rootEvaluation，不将workflow或事件的completed/ok当作它。根已满足也可能因后续必需收口失败以error返回，不能反向把根事实改成unsatisfied。根为unsatisfied/unknown时以error、stalled、exceeded或cancelled停止。纯评价unsatisfied本身不是错误；有已声明义务则继续，无可用技能返回capability_missing，已选规则前提已证不满足则precondition_unsatisfied，缺证据则evidence_unavailable，不能以no_remaining_work伪装完成。

帧结果分开记录义务真假、执行动作和停止原因：

```text
FrameResult {
  frameId, rootRef, parentFrameId, fulfillsConditionId,
  fact: "not_evaluated" | "satisfied" | "unsatisfied" | "unknown" |
        "not_applicable";
  execution: "not_started" | "dispatched" | "completed" |
             "failed" | "cancelled";
  unexecutedReason: "dependency_not_met" | "budget" | "cancel" | null;
  errorId: string | null; evidenceRefs; dispatchRefs; atomicResultRefs
}
```

`not_applicable` 只用于未选活动分支；依赖失败而从未派发的帧标 `not_started + dependency_not_met`；只有明确取消请求到达并影响该帧时才标 `cancelled`。三者不得互相替代。已发生动作即使失败或清理出错，也必须保留 `EffectRecord`。

### 3.1 执行错误必须返回给根调用者

用户明确要求执行错误也要返回。`RunReport.atomicResults`返回每个已尝试原子步骤的typed结果，包括模块前置拒绝与已派发调用，不只给文件路径或日志；`errors`保存本响应内唯一errorId对应的完整diagnostic，所有frame/error/related引用必须能在响应内解析。外部refs仅补充大体积原始证据，不是读取执行错误的唯一途径。

```text
AtomicExecutionResult {
  dispatchId, frameId, skillId, runId: string | null;
  executorInvoked: true | false | "unknown";
  outcome: "succeeded" | "failed" | "rejected" | "unknown";
  sourceResult: DomainReceipt | CapturedWorkflowFailure | null;
  executionErrorIds: readonly string[];
  verificationErrorIds: readonly string[];
  effect: EffectRecord; observedStateRef: string | null
}
CapturedWorkflowFailure { category, message, nodeId?: string }
EffectRecord {
  dispatchId, frameId, skillId;
  dispatchState: "not_dispatched" | "in_flight" | "returned";
  knowledge: "none" | "known" | "unknown" | "mixed";
  confirmedEffects: readonly TypedEffectFact[];
  receiptRef: string | null
}
```

`DomainReceipt`由领域校验并在当前响应中按领域tag保留，是实际返回的错误/回执，不是通用模块重新猜出的错误。已有code、stage、原始message、nativeCode及executor状态保留；未收到的字段显式不可用，不补造。sourceResult缺失时仍返回unknown原子结果与已捕获异常，保留能力边界。隐私凭据及无关原始payload不进入返回，裁剪不得丢失错误类别、执行事实或必要诊断字段。

执行结果与后验分开：cd执行已成功但验证失败时，原子源回执必须保留成功提交，verificationErrorIds保留观测执行器的失败。若同一source只有组合unknown结果，就保留该组合回执和已证提交效果，不伪造单独成功回执。根的primary可以是evidence_unavailable，但不能因此丢弃导致它的实际执行/观测错误；这些错误在errors内以cause id关联。

## 4. 请求状态与 dispatch ledger

每次调用拥有独立 `RunState`：只读请求快照、帧表、条件到帧映射、共享预算、primary error id、related issues、effect ledger、cleanup/collection receipt。状态由模块写入；adapter、事件 payload 和日志不能成为第二控制真源。

dispatch 生命周期固定：

1. 选技能后先做 enabled skill、typed condition、binding、effect allowlist 和预算前置检查。拒绝时不得调用 executor。
2. 任何可能产生副作用的调用前，先写入`EffectRecord { dispatchState:"in_flight",knowledge:"unknown",confirmedEffects:[],dispatchId,frameId,skillId,receiptRef:null }`。这是控制侧已派发风险标记，不声称动作已经发生。
3. adapter返回typed receipt后将dispatchState记returned，更新AtomicExecutionResult的outcome及可证明的effect知识。receipt明确executorInvoked=false且无任何先前效果时可为none；已提交但后验失败时为known并把真实提交写入confirmedEffects；存在已确认部分与未决部分时为mixed。
4. adapter抛出异常时保存已捕获信息，返回对应AtomicExecutionResult和错误，不自动推断效果已发生或未发生。已跨dispatch边界保持unknown或有证据支持的mixed；纯评价/校验抛出且未跨边界才可为none。执行outcome=failed不等于effect知识=none。

`source.nativeCode`、errno、nodeId 或 receipt 只能来自已保留的 typed source。不得从 `message`、日志文本或 `events` 猜测丢失的 errno 与完整 cause。现有 `WorkflowRunFailure` 只稳定提供 `category/message/nodeId`，因此可保留 category 与 nodeId，不可补造 OS code。

dispatchId可在前置检查时分配用于关联，但不是已派发事实；模块前置拒绝返回not_dispatched、executorInvoked=false、knowledge=none，sourceResult可为空且errors保留模块真实拒绝。领域workflow被调用后内部再拒绝时，模块dispatch为returned，但OS executor仍false；两个层次不能混淆。

## 5. Adapter 与运行时校验

```text
RecursiveGoalAdapter {
  validateRequest(raw): Promise<ValidatedRequest>;
  evaluate(input): Promise<EvaluationReceipt>;
  select(input: {frame, candidates}): Promise<
    {kind:"selected"; skillId} | {kind:"no_capability"; searchedSkillIds}>;
  derive(input: {frame, skill, cursor}): Promise<DerivationReceipt>;
  executeAtomic(input): Promise<AtomicReceipt>;
  validateAtomicReceipt(raw): AtomicReceipt; // 应用提供领域tag与原始sourceResult守卫
  cleanup?(input): Promise<Receipt>;
  collect?(input): Promise<Receipt>
}
```

`enabledSkills` 至少声明稳定 id、`atomic|composite`、可满足的 typed condition、evaluator 引用和 required effects；`enabledEvaluators` 至少声明 id、适用 Goal 类型和阈值合同。所有列表都由应用显式传入。selector 只能返回候选集合中的一个 id；越界选择是 `policy_error`，不能替换成“更正确”的技能。

每个 adapter 返回都要运行时校验：根未被改写、id 唯一、child 引用存在、技能/evaluator 已启用、selected skill 属于候选、effect 属于显式授权集合、帧结果与 receipt 判别字段一致。Object 端口静态通过不保证运输 payload 的类型或运行语义，公开 helper 抛出的 `TypeError` 也不能默认归为能力缺失。

adapter输出违例或可捕获的未声明回调异常映射为adapter_contract_invalid；typed框架错误按第7节workflow_failure映射。未知frame或非法派生结果同样属于契约故障，不伪装为capability_missing。selector不返回的情形不谎称已捕获，按第2节宿主边界处理。

模块的能力覆盖查找只检查已启用技能的目标/条件合同；权限不足是effect_denied，不能通过筛掉技能改称capability_missing。selector的candidates必须是该selector声明的技能词表及其显式启用合同，不能按Goal临时mask logits来隐藏错选。`no_capability`必须由确定性覆盖检查确认；覆盖存在但模型返回无能力或选错是policy_error。父子effect授权仅可收窄为根、父及技能允许范围的交集，衍生不能扩大权限。

## 6. 稳定错误合同

`ErrorCode` 至少包含：`invalid_request`、`invalid_binding`、`capability_missing`、`precondition_unsatisfied`、`evidence_unavailable`、`evidence_conflict`、`policy_error`、`effect_denied`、`execution_failed`、`effect_outcome_unknown`、`derivation_cycle`、`no_progress`、`budget_exceeded`、`cancelled`、`adapter_contract_invalid`、`workflow_failure`。

```text
ErrorDiagnostic {
  errorId: string; code: ErrorCode;
  stage: "admission" | "binding" | "evaluation" | "selection" |
         "derivation" | "dispatch" | "execution" | "observation" |
         "effect" | "aggregation" | "cleanup" | "collection" | "finalization";
  origin: {frameId?, skillId?, conditionId?, evaluatorId?, nodeId?};
  source: {owner: "module" | "adapter" | "workflow";
           category: string | null; nativeCode?: string; refs: readonly string[]};
  effectKnowledge: "none" | "known" | "unknown" | "mixed";
  atomicResultRefs: readonly string[];
  cause?: {kind: "captured_error"; name: string; message: string;
           nativeCode?: string} | {kind: "error_ref"; errorId: string};
  propagation: readonly {
    frameId: string; parentFrameId: string | null;
    satisfies: { frameId: string; conditionId: string } | null
  }[];
  diagnosticMessage: string
}
```

`code` 决定可证明条件，`message` 只供人读取，不能用于分支。`stage`、source category 和 refs 不互相代替。`propagation` 由每个父帧只追加 frame、`satisfies` 与 condition path，但不生成“子失败”，不改写 origin、code、nativeCode 或 cause。

一个errorId只对应errors表内一份原因，不每层复制。顺序调度中第一个阻断当前必要条件的错误为primary，primaryErrorId指向同一diagnostic；执行错误即使不是primary也必须经atomicResults和errors返回。清理/采样等其他错误进relatedIssues并引用errors中的diagnostic，不覆盖主错。本轮不引入并行调度；相关关系为cleanup/collection/secondary。没有primary时，未完成显式必需收口或影响安全/数据正确性的清理/采集失败才提升primary；可选失败为可见issue，不改根事实。cause引用必须无环，传播路径只追加父条件，不把父包装当新根因。

错误条件最小矩阵：

| code | 可证明条件 | 不可推断 |
| --- | --- | --- |
| `invalid_request` | admission 前结构、限制或根引用不合法 | 不存在已接受根 |
| `invalid_binding` | 已保留的 Goal/对象/skill 绑定不可用或已失效 | executor 是否执行，须看 ledger |
| `capability_missing` | 显式已启用技能的目标/条件合同均不兼容 | 目标永久不可能，或用缺授权冒充缺能力 |
| `precondition_unsatisfied` | 已观测的必要前置条件为 false，且当前规则不继续 | 未派发动作已发生 |
| `evidence_unavailable` | 所需受信证据缺失、未保留或后验观测失败 | Goal 为 false |
| `evidence_conflict` | 保留证据互相冲突或有效性不可裁决 | 任一方自动为真 |
| `policy_error` | 模型选错技能/head或在覆盖存在时误报无能力 | 领域目标失败；模块非法cursor另属契约故障 |
| `effect_denied` | 授权检查在 dispatch 前拒绝 | 动作已执行 |
| `execution_failed` | typed receipt 明示执行失败 | 未在 receipt 中的副作用 |
| `effect_outcome_unknown` | 已过副作用边界且没有结论性 receipt | 成功、失败或可安全重试 |
| `derivation_cycle` | 同 Goal、binding、模式与事实没有下降却再次衍生 | 合法同 Goal 下降也为循环 |
| `no_progress` | 按声明可重复步骤测得连续两次无进展 | 任意重复只是预算问题 |
| `budget_exceeded` | 下一控制转换或派生需要超出共享额度 | 超额动作已经派发 |
| `cancelled` | 显式取消到达并终止未完成工作 | 已提交副作用已被回滚 |
| `adapter_contract_invalid` | 返回值或异常违反已声明 adapter 合同 | 领域能力缺失 |
| `workflow_failure` | compile/run 异常、无法映射的上游 failure | 原始 errno，除非 typed cause 保留 |

`code`不是retry许可。只有技能合同显式允许、effect知识为none、原证据有效且预算允许时才可重试；effect_outcome_unknown、已提交副作用、取消和超预算不得自动重放。未知副作用只能在仍有授权及预算的显式恢复请求中走已声明只读补证，不在异常返回期间无限派发。

## 7. workflow failure、facade 与返回边界

`runWorkflow` 的 upstream failure 会阻止 report 节点执行。facade 必须在每次 await 外保留 `RunState`，在调用返回或抛出后由模块本地 `finalize(state)` 生成报告，不能依赖 report 节点失败后仍运行。

映射规则：

- `compileWorkflow` 的 `WorkflowContractError`、`runWorkflow` 返回的 `status:"failed"`、`flow_execution_failed` 或非预期 `invalid_node_event` 收束为 `workflow_failure`，把可用 category、nodeId、events 引用保留在 source/refs。
- `unauthorized_effect` 若在 dispatch 前由模块预检发现，映射 `effect_denied`；若在已进入执行后返回，保留 `workflow_failure` 和真实 ledger，不猜执行未发生。
- adapter 的普通 `TypeError`、缺字段、非法 frame/skill/effect 映射 `adapter_contract_invalid`；不映射为 `capability_missing`。
- `invalid_input_event` 若发生在已接受请求后的内部事件构造阶段，是模块或 adapter 合同故障；不会回到 `RequestRejected`。
- `WorkflowRunResult.events` 只作证据引用，不从事件数量、文本或非 ok 状态推断副作用。`status:"completed"` 也不代表 Goal 成功。

admission 后所有可捕获失败必须先尝试生成 `RunResult`。只有模块自己的 invariant 或状态结构破坏时才返回 `ModuleFault`，其中 `acceptedRoot` 可为空，`report` 可为部分快照，但 evidence/effect 边界必须明确。

不得为了“总有 report”把失败改写成发送成功业务事件。若用 event `status:"ok"` 运输报告，`ok` 只表示事件端口合同有效；payload 必须有 `kind`、`control.outcome` 和 `rootEvaluation.state` 判别字段，消费者不得把它直接读成 Goal achieved。也不得绕过 runner 原错误机制制造伪成功。

## 8. 预算、取消、effect 与清理优先级

每次控制转换先检查取消和预算，再派发新副作用。根在停止信号生效前已经正式结束、必要链及effects均收束时保持completed，迟到取消不重写结果。停止在未完成dispatch期间生效时等待已有调用回执或保留未知；即使随后证据证明根satisfied，control仍保留cancelled/exceeded，不改写先前停止原因。

取消不回滚已发生动作。in-flight调用必须有结论性receipt才可把knowledge改为known；无receipt保持unknown或有证据的mixed。预算耗尽后不派发新的补证技能；已经派发的原子合同内后验观察可随该调用返回，不能擅自截断。统一finalize/report及必要资源清理可执行，但清理必须是单独有界、已授权的关闭动作，不能承担新的Goal技能或扩大权限。

清理失败、采样失败和日志写入失败先形成 related issue，不得覆盖 primary error、根事实或已提交 effect。没有 primary 时，若清理失败会破坏资源安全或数据正确性，可提升为 `execution_failed(stage:"cleanup")`；否则仍为 related issue。

## 9. 场景矩阵

| 场景 | 根事实边界 | control 与错误 | effect known | 父传播 |
| --- | --- | --- | --- | --- |
| 无适用技能 | 已评价则保留原值，否则 `not_evaluated` | `error/capability_missing`；仅证明显式能力集缺失 | `none` | 同一 error 沿 `fulfills` 上行，不推出世界不可能 |
| 前置绑定拒绝 | 未评价，通常 `binding_error` | `error/invalid_binding` | `none` | 标识未派发，不能写 executor failed |
| 错误 head | 前序有效事实不变 | `error/policy_error` | `none` | 父链追加 condition path，不换技能 |
| OS 已证执行失败 | 未评价或已评价 `unknown` | `error/execution_failed` | `none` 或 receipt 明示值 | 保留原 nativeCode，后续必需节点不执行 |
| cd 已提交但后验观测失败 | `evaluated/unknown`，除非另有有效证据 | `error/evidence_unavailable` | `known`，confirmedEffects含实际提交 | 返回cause中的执行/观测原错，不重放 |
| 超预算 | 已完成评价则保留，否则 `not_evaluated` | `exceeded/budget_exceeded` | 未派发为 `none` | 剩余帧 `not_started/budget`，不伪装 cancelled |
| 取消 | 已完成评价则保留，否则 `not_evaluated` | `cancelled/cancelled` | 依 ledger，可为 none/known/unknown | 未执行帧与真正 cancelled 帧分开 |
| 底层 workflow 异常 | 前序有效事实保留，否则未评价 | `error/workflow_failure` | 依 ledger，可 unknown | 保留 category/nodeId/refs，不伪造 errno |
| 清理出错 | 原根事实不变 | primary 仍为原错误；无 primary 时按安全影响处理 | 清理动作单列 | cleanup 为 related，不遮主错 |

## 10. 逐层 error 示例

示例A，cwd绑定失效：根`S.cwd == D`已接受，子帧在binding阶段发现目标目录引用失效。primary为invalid_binding，origin为子帧/condition，effectKnowledge为none；propagation记录“该节点负责根cwd条件”，不表示该条件已满足。已有[cwd首例](recursive-goal-cwd-validation.md)第4节为directory_binding_failed、executor未调用；sourceResult在atomicResults中保留该真实拒绝，不能改成cd executor failed。当前CLI动作head实际为cd，`cwd.equals`仅是子目标条件描述，不是新head。

示例B，cd已提交但PWD失败：dispatch先记in_flight；实际sourceResult证明已提交与revision增加，后验观测失败。根primary为evidence_unavailable(stage:observation)，effectKnowledge为known，confirmedEffects保留实际提交；根经有效评价器判unknown。根响应errors还包含execution_failed(stage:observation)及已采到的实际观测错误，primary.cause以error_ref指向它，atomicResults.verificationErrorIds也引用它；模型/父层不能覆盖这个错误或重试cd。已有[cwd首例](recursive-goal-cwd-validation.md)第4节postcommit-observation-injected为受控观察故障，不冒称真实系统errno；本文不重跑。

## 11. 无代码验收反例

以下为设计审阅检查，不是本轮执行结果：

- 若实现把叶 `failed` 直接复制为根 `unsatisfied` 或 achieved，拒绝。
- 若 `capability_missing` 被解释为世界永久不可能，拒绝。
- 若 `control.completed` 被消费者当作 Goal 成功，拒绝。
- 若 `RequestRejected` 创建 root frame，或 `ModuleFault` 伪造完整证据链，拒绝。
- 若 report 节点是异常时唯一报告来源，拒绝。
- 若从 `message`、日志或 events 猜测 errno/cause，拒绝。
- 若 cd 后验失败自动重放已提交副作用，拒绝。
- 若清理失败覆盖原 primary error，或未执行 dependent 被标 cancelled，拒绝。
- 若 selector 返回候选外 skill 后被规则静默替换，拒绝。
- 若根 evaluator 缺失仍可出现 `rootEvaluation: satisfied`，拒绝。
- 若 event `status:"ok"` 被解释为 Goal achieved 而不读 payload discriminator，拒绝。
- 若预算/取消覆盖已有效结束的根事实，或把未派发动作写成已执行，拒绝。

## 12. 剩余实施项

1. 定义并测试 `contracts.ts`、adapter 运行时守卫、稳定 error union 与 total response。
2. 实现有界 controller、帧表、共享预算、取消边界、dispatch ledger 和本地 finalize。
3. 接通3N2E的goal.recursive.bind/run/report实现绑定；沿既有图与模块typed端口合同编译，不另造图或引擎。
4. 增加显式 application adapter；CLI 只作为领域 consumer，不进入通用模块 import。
5. 实现 `lib/recursive-goal.ts` facade 和 `package.json` 的 `./recursive-goal` export，再补公开 consumer。
6. 建立错误映射、workflow failure、未知 effect、清理失败及本文矩阵的黑盒红测；当前只有设计，不宣称模块已实现或可用。
