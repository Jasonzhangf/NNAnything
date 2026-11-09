# NN Code call-graph cursor and gap schema r1

状态：2026-11-09 设计准备。owner Leo，reviewer Alice。任务
`nn-code-call-graph-cursor-schema-r1-20261109` 只闭合已接受调用图设计
§5.1 的 typed cursor/gap schema。本页不实现 adapter、converter、产品接线、
训练、评价或安装，不改权重、gold、threshold 或采用状态，不动 daemon/tmux。

## 1. 目标、依据与唯一缺口

已接受调用图合同要求按 `(declarationRef, reachedDepth)` 传播 `maxDepth` 内
有界 walk 的全部到达深度，每深度保留 witness；一次模型决策只处理一个
`pendingRelationRef`；深度边界正常关闭；循环不剪简单路径；零 binding 仍保留
完整 judge 三态。来源：

- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-call-graph-redesign-r1.md`
  :131-167、:169-242、:244-283、:287-390、:489-521。
- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-overall-redesign-route-r1.md`
  :252-293。

现有递归模块已提供 `C` cursor、`states`、`evidence`、`ledger`、
`remainingRequirements` 和 `control.stopReason`。来源：

- `docs/recursive-goal-module.md`:57-69、:427-493、:531-564、:629-738。
- `lib/workflow/recursive-goal/contracts.ts`:169-192、:557-563、:778-800。

统一决策合同已提供 StepContext、CandidateGroup、CandidatePage、S_g/A_g、
数据门和 continuation 规则。来源：

- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-unified-decision-contract.md`
  :155-179、:181-203、:205-286、:298-330、:381-433、:1280-1302、
  :1361-1376、:1597-1615。

唯一缺口是统一合同 §8.6 已明确列出的四项：pending queue 与 visited set
没有公开 typed schema；`Evaluation.gaps` 只有引用，没有种类、来源和深度；
`stopReason` 没有进入 StepContext/DecisionReceipt。来源：
`emma-unified-decision-contract.md`:1597-1615。

本页把这四项定义为一个可复制、可守卫的 `CallGraphCursor` payload，并映射到
既有字段。它不新增循环、调度器、账本真源或第二套 StepContext。

## 2. 唯一对象流与 SESE

```text
typed call-graph request
  -> existing runRecursiveGoal admission
  -> domain cursor initialization
  -> one shallowest declaration obligation
  -> one pendingRelationRef CandidateGroup
  -> one model decision
  -> one read-only observation or one typed judgment
  -> real New State + receipt
  -> update cursor and ledger
  -> existing root evaluation and report
```

单入口是公开 typed call-graph request。单出口是现有 `RecursiveGoalResponse`
的 `RequestRejected`、`RunResult` 或 `ModuleFault`。跨步继续由现有
continuation 恢复，不在单次静态 DAG 增加回边。来源：
`docs/recursive-goal-module.md`:71-104、:669-738。

本设计没有运行实现，故不新建项目 DAG 文件。现有责任图已由已接受调用图合同
给出；本页只补该图的 typed cursor payload。

## 3. 身份与不变量

### 3.1 身份

复用已接受三层身份，不另造字符串关系键：

```text
CallSiteRelationRef
PendingRelationRef
ConfirmedCallEdgeRef
DeclarationRef
CallSiteRef
BindingCandidateRef
WitnessPathRef
```

`CallSiteRelationRef` 由已观测调用点和真实 callee 名产生。每个
`PendingRelationRef` 带父 `CallSiteRelationRef` 与可空
`BindingCandidateRef`。`ConfirmedCallEdgeRef` 只在 caller、call-site 和
callee declaration 均已观测后产生。模型与评价器不拆 opaque ref。
来源：`emma-call-graph-redesign-r1.md`:131-167。

### 3.2 不变量

1. 一个 `CallSiteRelationRef` 是父义务；每个 binding 候选或零 binding 子关系
   各有独立 `PendingRelationRef`。
2. 一个 CandidateGroup 只对应一个 `PendingRelationRef`；一次模型选择只关闭
   该组。
3. `(DeclarationRef, reachedDepth)` 是 expansion identity。不同深度不能因声明
   相同而合并。
4. `(ConfirmedCallEdgeRef, reachedDepth)` 是输出深度 identity。每条已确认出边
   在每个到达深度各有独立 witness；不同 call-site 即使到达同一 callee 同一深度
   也是不同 `ConfirmedCallEdgeRef`，不能合并成一个 visited witness。
5. `remainingDepth=0` 是正常深度终点。它不产生未知，也不产生 scope 缺口。
6. 读取失败、权限失败、预算停止、候选截断与语义 unknown 分开。
7. 父义务、frontier、visited、gap、witness 和 stop 只来自 typed cursor 与
   现有 runtime 表；不从日志、文本或闭包重建。

依据：`emma-call-graph-redesign-r1.md`:164-196、:306-365；
`emma-unified-decision-contract.md`:422-433、:1280-1294。

## 4. Typed cursor schema

### 4.1 根形状

`CallGraphCursor` 是现有
`RecursiveGoalContinuation<G,S,B,E,F,R,C>` 中 `C` 的 payload。它不替代
`states`、`evidence`、`ledger`、`remainingRequirements` 或
`control.stopReason`。来源：`docs/recursive-goal-module.md`:669-700；
`lib/workflow/recursive-goal/contracts.ts`:778-800。

```ts
type CallGraphCursor = {
  schema: "nnanything.call-graph-cursor.v1";
  requestRef: Ref;
  request: {
    entryDeclarationRef: Ref;
    scopeRefs: readonly Ref[];
    maxDepth: number;
    outcome: "one" | "all";
  };
  frontier: readonly FrontierEntry[];
  active: ActiveObligation | null;
  visited: readonly VisitedExpansion[];
  ledgers: CallGraphLedgers;
  gaps: readonly CallGraphGap[];
  coverage: CallGraphCoverage;
  stop: CallGraphStop | null;
};
```

`requestRef` 对应 `StepContext.requestRef`；
`entryDeclarationRef` 对应根 `Goal.targetRef` 的显式入口绑定，不能从路径字符串
重造。`scopeRefs` 对应 `Goal.constraints` 与 `State.facts`；`maxDepth` 是请求
不变量。来源：`emma-unified-decision-contract.md`:155-187、:1599-1608。

### 4.2 Frontier 与 visited

```ts
type FrontierEntry = {
  entryRef: Ref;
  declarationRef: Ref;
  reachedDepth: number;
  remainingDepth: number;
  witnessPathRef: Ref;
  stateRef: Ref;
  status: "pending" | "active" | "closed";
};

type VisitedExpansion = {
  expansionRef: Ref;
  declarationRef: Ref;
  reachedDepth: number;
  stateRef: Ref;
  witnessPathRef: Ref;
  disposition:
    "expanded" | "depth_boundary" | "execution_failed" | "unsupported";
  receiptRef: Ref | null;
};

type ActiveObligation = {
  expansionRef: Ref;
  declarationRef: Ref;
  reachedDepth: number;
  callSiteRelationRef: Ref;
  pendingRelationRef: Ref;
  candidateGroupRef: Ref;
  decisionReceiptRef: Ref | null;
};
```

`FrontierEntry` 是 pending queue 的公开 typed 投影。稳定弹出顺序是
`reachedDepth` 升序，再按引擎签发的 `entryRef` 稳定排序。`VisitedExpansion`
是 visited set 的公开 typed 投影，键为
`(declarationRef, reachedDepth)`。`ActiveObligation` 是当前唯一未完成组；
它对应 `StepContext.candidateGroup`，不能同时有两个活动组。

`stateRef` 解析到现有 `states` 表；`receiptRef` 解析到现有
`atomicResults`/`evidence`。`witnessPathRef` 只引用当前已观测路径证据，不能
引用尚未发生的读取。来源：`docs/recursive-goal-module.md`:427-493、
:531-564、:669-738；`emma-unified-decision-contract.md`:155-179、
:381-433。

### 4.3 领域 ledger

```ts
type CallGraphLedgers = {
  scope: readonly ScopeCursorRecord[];
  modules: readonly ModuleLedgerRecord[];
  callSites: readonly CallSiteLedgerRecord[];
  relations: readonly RelationLedgerRecord[];
  expansions: readonly ExpansionLedgerRecord[];
  edgeOccurrences: readonly EdgeOccurrenceRecord[];
  depthBoundaries: readonly DepthBoundaryRecord[];
};

type ScopeCursorRecord = {
  scopeRef: Ref;
  cursorRef: Ref;
  status: "open" | "closed" | "failed";
  enumeratedRefs: readonly Ref[];
  nextRef: Ref | null;
};

type ModuleLedgerRecord = {
  moduleRef: Ref;
  contentRevision: number;
  stateRef: Ref | null;
  status: "unread" | "observed" | "conflicting" | "failed" | "unsupported";
  receiptRef: Ref | null;
};

type CallSiteLedgerRecord = {
  callSiteRelationRef: Ref;
  pendingRelationRefs: readonly Ref[];
  terminalRelationRefs: readonly Ref[];
  gapRefs: readonly Ref[];
  status: "open" | "closed" | "incomplete";
};

type RelationLedgerRecord = {
  pendingRelationRef: Ref;
  callSiteRelationRef: Ref;
  bindingCandidateRef: Ref | null;
  status: "pending" | "true" | "false" | "unknown" | "coverage" | "execution";
  confirmedEdgeRef: Ref | null;
  unknownReason: CallGraphUnknownReason | null;
  evidenceRefs: readonly Ref[];
  receiptRef: Ref | null;
};

type ExpansionLedgerRecord = {
  expansionRef: Ref;
  declarationRef: Ref;
  reachedDepth: number;
  status: "not_started" | "in_progress" | "closed" | "failed";
  callSiteRelationRefs: readonly Ref[];
  receiptRefs: readonly Ref[];
};

type EdgeOccurrenceRecord = {
  edgeOccurrenceRef: Ref;
  confirmedEdgeRef: Ref;
  parentDeclarationRef: Ref;
  calleeDeclarationRef: Ref;
  reachedDepth: number;
  witnessPathRef: Ref;
  stateRef: Ref;
  evidenceRefs: readonly Ref[];
  receiptRef: Ref | null;
};

type DepthBoundaryRecord = {
  boundaryRef: Ref;
  declarationRef: Ref;
  reachedDepth: number;
  maxDepth: number;
  witnessPathRef: Ref;
  evidenceRefs: readonly Ref[];
};
```

这些记录是 `C` 的领域内容。它们不复制现有 effect ledger。读取动作仍先写
`EffectRecord.in_flight`，返回后写 `returned`；模型判断属于 control，不伪造
副作用。来源：`docs/recursive-goal-module.md`:531-564、:669-700。

`CallSiteLedgerRecord.status=closed` 只在全部 pending 子关系均有语义终态或
显式 coverage/execution gap 时成立。`RelationLedgerRecord.status` 与
`ConfirmedCallEdgeRef` 不能互相替代：unknown/false 没有 confirmed edge；
true 必须有已观测终端声明与有效 witness。

`EdgeOccurrenceRecord` 是 `(ConfirmedCallEdgeRef, reachedDepth, witness)` 的唯一
typed owner，键为 `(confirmedEdgeRef, reachedDepth)`。它的 `witnessPathRef`、
`stateRef`、`evidenceRefs` 解析到现有 `evidence`、`states` 表，不复制这些真源。
每次新到达深度都追加一条 occurrence；复用局部 relation 判断时也必须为该深度写
自己的 witness。同一 callee 同深度的不同入边是不同 `confirmedEdgeRef`，各有独立
occurrence，不能用 visited witness 代替。

### 4.4 Gap schema

```ts
type CallGraphGapKind =
  | "not_observed"
  | "evidence_insufficient"
  | "conflicting"
  | "unsupported"
  | "dynamic_undecidable"
  | "out_of_scope"
  | "coverage_incomplete"
  | "execution_failed"
  | "budget_exhausted"
  | "cancelled";

type CallGraphGap = {
  gapRef: Ref;
  kind: CallGraphGapKind;
  ownerRef: Ref;
  pendingRelationRef: Ref | null;
  declarationRef: Ref | null;
  reachedDepth: number | null;
  stateRef: Ref | null;
  evidenceRefs: readonly Ref[];
  receiptRef: Ref | null;
  errorRef: Ref | null;
  terminal: boolean;
};

type CallGraphUnknownReason =
  | "not_observed"
  | "evidence_insufficient"
  | "conflicting"
  | "unsupported"
  | "dynamic_undecidable";
```

`Evaluation.gaps` 的公开投影使用 `gapRef[]`；每个 ref 必须在 cursor 的
`gaps` 表解析。`ownerRef` 指向父义务、expansion 或 scope cursor。深度只在
该 gap 有真实到达深度时填写，不能用 `0` 或 `null` 混淆未观测与根深度。
来源：`emma-unified-decision-contract.md`:320-330、:1597-1615。

以下分流固定：

| 情况                        | kind                    | 是否语义 unknown           | 对根的影响                |
| --------------------------- | ----------------------- | -------------------------- | ------------------------- |
| 观察义务未耗尽              | `not_observed`          | 否，先继续 observe/advance | 未完成                    |
| 观察耗尽仍不足              | `evidence_insufficient` | 是                         | 可成为该关系终态 unknown  |
| 已观测证据冲突              | `conflicting`           | 是，带冲突证据             | 可成为该关系终态 unknown  |
| 已接纳形态不受 adapter 支持 | `unsupported`           | 是，若请求已接纳           | 可成为该关系终态 unknown  |
| 动态 callee 不可静态确定    | `dynamic_undecidable`   | 是，观察耗尽后             | 可成为该关系终态 unknown  |
| 请求范围外                  | `out_of_scope`          | 否                         | coverage 缺口，不伪造关系 |
| 候选页截断或 cursor 未闭    | `coverage_incomplete`   | 否                         | coverage 缺口             |
| 读取、解析、权限或执行错误  | `execution_failed`      | 否                         | execution 缺口            |
| 预算耗尽                    | `budget_exhausted`      | 否                         | 停止，不等于根满足        |
| 显式取消                    | `cancelled`             | 否                         | 停止，保留已完成事实      |

依据：`emma-call-graph-redesign-r1.md`:244-283、:359-379；
`docs/recursive-goal-module.md`:566-627、:764-778。

### 4.5 Coverage、stop 与 StepContext 投影

```ts
type CallGraphCoverage = {
  status: "open" | "complete" | "partial" | "failed" | "cancelled";
  frontierClosed: boolean;
  scopeClosed: boolean;
  activeGroup: boolean;
  truncatedCount: number;
  failedCount: number;
  openGapRefs: readonly Ref[];
};

type CallGraphStop = {
  reason:
    | "frontier_exhausted"
    | "one_satisfied"
    | "execution_failed"
    | "budget_exhausted"
    | "cancelled";
  sourceRef: Ref;
  receiptRef: Ref | null;
  errorRef: Ref | null;
};
```

StepContext 投影固定如下：

| cursor 内容                   | StepContext / 现有 runtime 字段                     |
| ----------------------------- | --------------------------------------------------- |
| `requestRef`                  | `StepContext.requestRef`                            |
| 当前 `pendingRelationRef`     | `StepContext.goal.targetRef`；局部 Goal 为 verify   |
| `active.candidateGroupRef`    | `StepContext.candidateGroup.candidateGroupRef`      |
| 当前 relation/expansion facts | `StepContext.state.facts`                           |
| pending binding 候选          | `StepContext.bindingEdges`、`bindingProjections`    |
| scope 与深度事实              | `StepContext.scopeFacts`、`State.facts`             |
| gap refs                      | `StepContext.evaluation.gaps`                       |
| stop 投影                     | `StepContext.action.outcome` + 新增 typed stop 引用 |
| frontier/visited/ledger       | 现有 `C` cursor                                     |
| 真实 State/evidence/effect    | 现有 `states`、`evidence`、`ledger`                 |
| 未完成义务                    | 现有 `remainingRequirements`                        |

`StepContext.action` 只记录上一动作，不预填本次 gold。`allowedEffects` 对
judge/control 为 `control`，对 inspect/advance 为 `read_only`。来源：
`emma-call-graph-redesign-r1.md`:198-218；
`emma-unified-decision-contract.md`:155-179、:298-342。

`stopReason` 的完整投影不填入 `Action.outcome` 字符串。`Action.outcome` 只
保留真实动作结果；cursor 的 `stop` 提供领域原因，现有
`control.stopReason` 提供模块控制原因。两者必须一致：

| cursor stop          | 现有 control.stopReason | 根评价                     |
| -------------------- | ----------------------- | -------------------------- |
| `frontier_exhausted` | `no_remaining_work`     | 独立评价；不自动 satisfied |
| `one_satisfied`      | `root_evaluation`       | 根 verify 独立评价         |
| `execution_failed`   | `fatal_error`           | failed 或未满足，保留原错  |
| `budget_exhausted`   | `budget`                | exceeded，不满足           |
| `cancelled`          | `cancel`                | cancelled，保留已提交事实  |

依据：`docs/recursive-goal-module.md`:629-667、:756-778；
`lib/workflow/recursive-goal/contracts.ts`:557-563。

## 5. 状态转移

### 5.1 初始化

1. 校验显式入口声明、scope、`maxDepth >= 0` 和 `outcome`。
2. 创建 `(entryDeclarationRef, 0)` frontier entry，`remainingDepth=maxDepth`。
3. 创建 open scope cursor；未枚举不等于枚举完成。
4. 若入口身份无法得到真实证据，写 `execution_failed` 或语义 unknown 的合法
   gap，不能从空图开始 satisfied。

### 5.2 单步

1. 按 `(reachedDepth, entryRef)` 弹出最浅 frontier entry，并写入
   `VisitedExpansion.status=expanded` 或 `depth_boundary`。
2. `remainingDepth=0` 时写 `DepthBoundaryRecord`，不再读取出边，关闭该
   expansion。
3. 否则按稳定 call-site 顺序取一个未关闭父义务，再取一个未终态
   `PendingRelationRef`，建立唯一 `ActiveObligation`。
4. guard 从当前 State、合法技能和 effects 生成完整 `S_g`；gold 路径生成
   独立 `A_g`。`A_g` 非空且为 `S_g` 子集才允许训练。
5. 模型只选一个候选。observe/advance 派发一次 read-only 动作并等待真实
   receipt；judge 写当前 relation 的唯一语义终态。
6. 新观测只进入动作之后的 New State。旧 StepContext 不回填未来证据。
7. 按所选动作的真实结果更新当前 `pendingRelationRef` 的局部状态。observe/advance
   只追加已观测事实并保持该关系 `pending`；只有 `judge` 写唯一语义终态
   `true|false|unknown`，只有带 typed gap 的 coverage/execution 结果才关闭处理。
   单个 observation receipt 不构成父义务关闭。
8. 全部子关系有语义终态或有显式 gap 后关闭父义务；同一 call-site 仍有 pending
   子关系时保持父义务 open，下一次只处理下一组。父义务关闭后继续同一 expansion
   的下一 call-site，或关闭 expansion。

### 5.3 确认边与深度传播

`judge(true)` 只有在终端 `DeclarationRef` 已观测时才能产生
`ConfirmedCallEdgeRef`。引擎把 `parentDepth+1` 加入该边 depths，并为
`(confirmedEdgeRef, parentDepth+1)` 追加一条 `EdgeOccurrenceRecord`，保存该深度
自己的 `witnessPathRef`。若 `parentDepth+1 <= maxDepth`，创建或复用
`(calleeDeclarationRef, parentDepth+1)` frontier entry。等于边界时仍创建
到达记录，但下一次弹出只写深度终点，不解析出边。

同一 `(DeclarationRef, reachedDepth)` 只处理一次。局部 relation 判断可复用，
但每个新到达深度仍传播同一已确认出边并记录该深度的 witness。不同 call-site
到达同一 `(calleeDeclarationRef, reachedDepth)` 时，`visited` 只有一条，但每条
入边有自己的 `ConfirmedCallEdgeRef` 和 `EdgeOccurrenceRecord`，不能用同一
visited witness 代替。循环不剪简单路径，也不枚举全部路径。
来源：`emma-call-graph-redesign-r1.md`:337-365。

### 5.4 收敛

- `all`：frontier 空、scope closed、无 active group、无 open coverage/
  execution gap，才可提交完整覆盖。语义 unknown 可作为关系终态，但终态
  unknown 不能满足要求已知关系成立的 all 根；open unknown 不是终态。
- `one`：一条真实确认边带请求要求的 witness，且相关 CandidateGroup 已终结，
  就可满足根 verify。此时其他未处理 frontier、scope 与 gap 保持
  `coverage.status=partial`，不阻止该 one 结果 satisfied。
- 对 `one`：只有同一目标链上的执行失败、截断或相关组未闭阻止 satisfied；与 one
  请求无关的未闭 frontier/scope 记为 partial coverage，不全局否决。`all` 仍只按
  上面的 complete-coverage 规则判定。
- 遍历停止、模型 RETURN、根 satisfied 分别记录。

依据：`emma-call-graph-redesign-r1.md`:367-379、:473-474、:478-523；
`docs/nn-code-redesign-value-flow-design.md`:53-62、:417。

## 6. S_g / A_g 与 New State

### 6.1 候选

每个 `PendingRelationRef` 单独生成 CandidateGroup。完整组至少包含合法
`judge(true)`、`judge(false)`、`judge(unknown)`；observe/advance/control
只按当前 State 和 effects 增减。候选页必须消费到 `nextPageRef=null`；
截断组不能计算训练 loss。来源：
`emma-unified-decision-contract.md`:381-433、:1280-1294。

### 6.2 独立监督

| 证据状态                               | `A_g`                     |
| -------------------------------------- | ------------------------- |
| 已确认关系成立                         | `{judge(true)}`           |
| 已确认该候选关系不成立                 | `{judge(false)}`          |
| 仍有合法、有信息增益的 observe/advance | 对应观察动作              |
| 合法观察耗尽且仍不可判                 | `{judge(unknown)}`        |
| 执行失败或 coverage 未闭               | 不生成语义 gold；保留 gap |

`A_g` 为空或 `A_g` 不是 `S_g` 子集返回 `DATA_INVALID`。零 binding 组不按
gold 删除 judge 三态；guard 只枚举，独立监督只给 allowed set。

### 6.3 New State

每个动作产生不可变新 State，至少包含：

```text
stateId
previousStateRef
actionReceiptRef
newlyObservedRefs
newlyConfirmedEdges
relationTerminalUpdates
frontierUpdates
visitedUpdates
gapUpdates
coverageUpdate
```

前态不得包含动作之后才读取的声明、binding、终端 callee 或 receipt。
`Action.previousActionRef` 和 `receiptRef` 指向前一真实动作；本次候选不预填。
来源：`emma-unified-decision-contract.md`:298-332；
`docs/nn-code-redesign-value-flow-design.md`:64-91、:131-140。

## 7. 逐步例子

以下均为纸面轨迹，不是实现或运行回执。

### 7.1 直接链 A -> B -> C，maxDepth=2，all

| step | 当前义务             | 观测                          | 决策          | 更新                         |
| ---- | -------------------- | ----------------------------- | ------------- | ---------------------------- |
| 1    | `(A,0)`，A 的 `A->B` | A 声明、call-site、B 声明可见 | `judge(true)` | 写 `A->B@1`；enqueue `(B,1)` |
| 2    | `(B,1)`，B 的 `B->C` | B 声明、call-site、C 声明可见 | `judge(true)` | 写 `B->C@2`；enqueue `(C,2)` |
| 3    | `(C,2)`              | C 到达路径有效                | 无模型判断    | 写深度终点；关闭             |

输出为 `A->B.depths=[1]`、`B->C.depths=[2]`。frontier 空、scope closed、
无 gap 后，根评价独立执行。`remainingDepth=0` 不是 unknown。

### 7.2 菱形 A->X、A->B->X、X->Y，maxDepth=3，all

frontier 按深度弹出 `(A,0)`、`(B,1)`、`(X,1)`、`(X,2)`、`(Y,2)`、
`(Y,3)`。`X` 的出边组只在首次到达时决策一次；`(X,2)` 复用已确认局部判断，
但必须把 `X->Y` 传播到深度 3 并使用 `(X,2)` 的真实 witness。

结果：

```text
A->X depths [1]
A->B depths [1]
B->X depths [2]
X->Y depths [2,3]
```

`(X,1)` 与 `(X,2)` 是两个 visited identity。先走较深路径不能删除较浅路径，
反之亦然。两个 `X->Y` 深度各有 witness，不能拿深度 2 路径证明深度 3。

同深度多入边反例：A 有 `A->B`、`A->C`，B 与 C 各有一条 `->D`。此时 `(D,2)`
只有一条 visited entry，但 `B->D@2` 与 `C->D@2` 是两条不同
`ConfirmedCallEdgeRef`，各有自己的 `EdgeOccurrenceRecord` 与 witness。不能用
`(D,2)` 的单个 visited witness 代替其中一条入边。

### 7.3 循环 A->B->A，另有 A->C，maxDepth=3，all

visited 包含 `(A,0)`、`(B,1)`、`(A,2)`、`(B,3)`，以及 `A->C` 的
`(C,1)`、`(C,3)`。`A->B` 的 depths 是 `[1,3]`，`B->A` 是 `[2]`，
`A->C` 是 `[1,3]`。循环 occurrence 不因声明重复而丢弃。

`(B,3)` 与 `(C,3)` 只记录深度终点，不读取深度 4。frontier 空后完整覆盖
才可满足 all。来源：`emma-call-graph-redesign-r1.md`:356-359。

### 7.4 maxDepth=0，all

入口 A 的身份 preflight 成功。`(A,0)` 只写
`DepthBoundaryRecord(maxDepth=0)`，不生成关系 CandidateGroup。输出零条调用
边，scope cursor closed，frontier 空；根 all 可独立评价为 satisfied。

入口身份失败时写 execution 或合法 unknown gap，不能空图 satisfied。

### 7.5 maxDepth=0，one

请求内没有可确认调用边。结果写深度终点与 `no_candidate`/unmet，不伪造
unknown，也不向深度 1 展开。来源：
`emma-call-graph-redesign-r1.md`:374-379。

### 7.6 零 binding 动态调用

调用点是 `eval(input)` 或不可静态确定 receiver。父义务
`CallSiteRelationRef` 已观测；唯一子关系是
`PendingRelationRef(bindingCandidateRef=null)`。

仍有合法 inspect 时：

```text
S_g = {judge(true), judge(false), judge(unknown), inspect, legal controls}
A_g = {inspect}
```

执行 inspect 后，若合法观察耗尽且证据仍不足：

```text
S_g = {judge(true), judge(false), judge(unknown), legal controls}
A_g = {judge(unknown)}
return relationRef = PendingRelationRef(bindingCandidateRef=null)
reason = dynamic_undecidable
```

同一 S_g 形状在不同独立证据下只改变 A_g，guard 不代答。不得因零 binding
直接删 true/false 候选或直接补 false。

### 7.7 多 binding

同一 call-site 有 binding `b1`、`b2`：

```text
parent = CallSiteRelationRef(call-site, name)
child1 = PendingRelationRef(parent, b1)
child2 = PendingRelationRef(parent, b2)
```

两个 CandidateGroup 独立生成。选择 child1 的 judge 只关闭 child1；child2
仍 pending。父义务只有在两个子关系均终态或有显式 gap 后关闭。一次模型选择
不能把整个 call-site 标为已处理。

### 7.8 观察到判断

alias 调用先只观测到 import 边。StepContext 的 `state.facts` 含已知
call-site 与未读 source module，`BindingEdge.sourceContent.state` 为
`not_requested`。`A_g={advance(edge)}`，`S_g` 不按终端 gold 过滤。

同一 `pendingRelationRef=R` 跨以下步骤保持 `pending`。advance 的真实 receipt
读取 source 后，下一 State 才加入 re-export 边，R 的局部状态只追加观察；
继续 advance 读取终端声明后，R 仍 `pending`，只有下一个 `judge(true)` 才把 R
写成语义终态并关闭该子关系。读取 util 后不能提前宣布最终 callee。来源：
`emma-unified-decision-contract.md`:1617-1635。

## 8. 评价分母

评价先冻结完整 expected relation case。每个 case 至少带：

```text
expectedCaseRef
pendingRelationRef
expectedRelation: true | false | unknown
expectedDepths
sampleRef
episodeRef
sourceFamily
partition
```

主分类互斥、按固定优先级只归一类，所有 expected case 保留：

```text
execution -> coverage -> invalid -> missing -> returned
```

| 分类      | 条件                                       |
| --------- | ------------------------------------------ |
| execution | 读取、解析、权限、预算或执行失败           |
| coverage  | scope/cursor/page/组未完成或候选截断       |
| invalid   | 响应引用、身份、深度、witness 或合同不合法 |
| missing   | 覆盖完整但没有该关系响应                   |
| returned  | true、false 或 unknown 的真实语义返回      |

固定等式：

```text
expectedCount =
  returnedKnownTrueCount + returnedKnownFalseCount + returnedUnknownCount +
  missingCount + invalidCount + coverageCount + executionCount
```

`expected` 不因截断、失败、漏响应或 unknown 删除。`missing`、`invalid`、
`coverage`、`execution` 都使覆盖硬门失败；它们不能通过缩小分母提高成绩。
`label_missing` 保留证据但不进入正确率分母。数据门 `DATA_INVALID` 是训练
监督无效，不混入运行 execution。

依据：`emma-call-graph-redesign-r1.md`:489-523；
`docs/nn-code-redesign-value-flow-design.md`:502-528。

## 9. 数据门与 continuation 门

### 9.1 数据门

至少拒绝以下输入：

1. `pendingRelationRef` 不属于当前 call-site 或绑定候选。
2. 一个 CandidateGroup 跨多个 pending 子关系。
3. `A_g` 空、非 `S_g` 子集，或包含 guard 未生成的候选。
4. 学生输入包含 gold、完整链、终端 callee、未来 receipt 或 `goal_met`。
5. 零 binding 组缺少 judge 三态。
6. 截断或枚举失败组仍计算 loss。
7. 同一 `(DeclarationRef,reachedDepth)` 被重复处理为不同状态。
8. 同一 `(ConfirmedCallEdgeRef,reachedDepth)` 缺少 witness。
9. 深度边界被记成 unknown 或 out-of-scope。
10. gap ref 无法解析到 typed gap 表。

依据：`emma-unified-decision-contract.md`:1361-1376。

### 9.2 continuation 门

恢复时检查：

- schema 精确匹配；
- request、入口、scope、maxDepth、outcome 与 accepted root 一致；
- frontier、visited、ledger、gap、coverage 引用闭合；
- active group 至多一个，且其 CandidateGroup 属于当前 pending relation；
- 所有 State/evidence/receipt/witness/error ref 解析到现有 runtime 表；
- 每条 `EdgeOccurrenceRecord` 的 `confirmedEdgeRef`、`reachedDepth`、
  `witnessPathRef` 经 `confirmedEdgeRef` 关联现有 `states`/`evidence` 并一致；
  `RelationLedgerRecord` 不重复保存 depth/witness 字段；
- 深度不超过 maxDepth，边界记录与 maxDepth 一致；
- stop 与现有 `control.stopReason` 一致；
- 未完成义务与现有 `remainingRequirements` 一致；
- 不从日志、旧 cursor 或隐式闭包补字段。

来源：`docs/recursive-goal-module.md`:669-738；
`docs/bounded-goal-planning.md`:223-256。

## 10. 验收矩阵

| 验收项       | 通过条件                               | 当前状态   |
| ------------ | -------------------------------------- | ---------- |
| 唯一缺口     | 只闭合 pending/visited/gap/stop schema | 设计完成   |
| 字段映射     | 每项附既有合同行号                     | 设计完成   |
| 深度传播     | 直接链、菱形、循环逐深度 witness       | 纸面完成   |
| 边界         | maxDepth=0 all/one 分开                | 纸面完成   |
| 父子义务     | 零 binding 三态与多 binding 单步关闭   | 纸面完成   |
| 分母         | expected 不删除，五类互斥              | 设计完成   |
| 实现         | adapter/converter/engine 真实运行      | INCOMPLETE |
| 训练         | TRAIN fit、保存、回载                  | UNVERIFIED |
| 真实 rollout | 真实入口逐步观察与评价                 | UNVERIFIED |

本页只证明设计准备。共享 schema 已写不等于 wire 已实现；设计接受不等于
调用图能力已交付。

## 11. 非目标与后续 owner

不实现 adapter、converter、cursor guard、StepContext builder、encoder、
runner、oracle、产品接线或安装。不训练、不评价、不改权重/gold/threshold/
采用，不恢复旧 nn-code，不动 daemon/tmux。

Alice 独立审计本设计。通过后由 Jenny 按 board 指定工程 owner，完成公开
typed schema、固定入口、adapter/converter、隔离语料和真实 rollout 评价。
工程准备不等待新训练 package。
