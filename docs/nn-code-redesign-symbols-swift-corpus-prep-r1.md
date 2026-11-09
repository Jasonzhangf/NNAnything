# NN Code redesign: Swift symbol corpus preparation r1

状态：2026-11-09 设计准备。owner Carol，reviewer Alice，master Jenny。任务
`nn-code-symbols-swift-corpus-prep-r1-20261109` 只准备 Swift 符号语料、分区、
typed fixture、独立监督和验证入口。本页不生成物理语料，不启动拟合，不实现产品，
不改权重、gold、threshold 或采用状态，不接线、不安装，也不动 daemon 或 tmux。

本页的输入是已接受的 Swift 符号设计，不是训练结果。设计接受不等于 Swift 语料
READY，也不等于 converter、evaluate 或训练入口已兼容 Swift。物理语料、converter
兼容性、独立评价和训练均保持 `INCOMPLETE/UNVERIFIED`。

## 1. 目标与已接受边界

本切片把一个缺口闭合到可执行准备合同：把已接受的 Swift 符号设计变成 Swift 独立
语料、独立监督、typed fixture 和验证入口的设计。它是研究设计，不是样本生成器，
也不是产品接线。

已接受的上游依据：

- `/Volumes/Intel/playground/nnanything-runs/nn-code-redesign-symbols-swift-20261108/nn-code-redesign-symbols-swift-design.md`
  §1-§11：Swift 观测边界、声明身份、三态 unknown、来源家族、独立监督和
  S_g/A_g 合同。该设计由 Alice 在 subject_revision 3（`de3a56f`）正式 ACCEPT。
- `/Volumes/Intel/playground/nnanything-runs/nncode-swift-first-train-planner-20261109/plan.md`
  §A：Swift corpus-preparation R1 的来源、监督、fixture、分母与分阶段准备计划。
- `/Volumes/Intel/playground/nnanything-runs/nncode-swift-first-train-planner-20261109/alice-plan-audit.md`：
  Alice 对上述计划 PASS，限 preparation-only；不授权 fit、采样、转换、产品接线、
  安装或采用。
- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md`
  §3-§4、§11：共享四元素、线性 SESE、三态事实分离。
- `docs/nn-code-redesign-symbols-tsjs-design.md` §1-§9：共享 judge/action、
  64 槽 StepContext、候选组、固定引擎和语义硬门。只复用结构，不把 TS/JS
  语料或 TS schema 当成 Swift 已兼容。
- `docs/nn-code-tsjs-training-entry-reload-contract.md` §1-§5：固定 recipe、
  TRAIN-only 准入、模型包和 checkpoint 边界。

固定共用引擎不变：输入 64 维；hidden 为 64 -> 64 -> 64 -> 1 ReLU；group loss；
full-batch SGD，momentum 0；learning rate 0.01；maxEpochs 200；Xavier fixed
seed；DEV 早停禁用。Swift 和 TS/JS 共享抽象与引擎，但语言来源、gold、候选、
报告和分母必须独立。

## 2. 当前真实事实与职责

### 2.1 Swift 确定性观测现状

亲读当前源码后确认：

- `lib/adapters/cli/swift-symbol-table-adapter.ts` 只输出声明符号：
  `symbols[]` 含 `symbolId/name/fullName/kind/file/declSpan/nameSpan/
  nameSpanSource/lexicalScope/ownerType/ownerKind/modifiers/visibility/
  declaredIn/parseStatus`；`coverage` 含 discovered/parsed/failed/skipped/
  syntaxErrorFiles/partial/partialReasons/truncated/parserInvocations/notes；
  `boundaries` 含 project module path、macros、protocol witness、ObjC interop、
  SwiftUI view graph。
- `lib/filters/swift-symbol-table-policy.ts` 固定 `semanticBinding=false`、
  `projectModulePath="unknown"`、`swiftMacros="not_expanded"`、
  `protocolWitnessDispatch="not_resolved"`、`objcInteropBindings="not_resolved"`、
  `swiftUiViewGraph="not_resolved"`。`nameSpan` 可为 `null`，并记录
  `nameSpanSource=unknown` 与 partial reason。
- `lib/adapters/` 没有 `swift-unified-adapter.ts`。当前只有
  `rust-unified-adapter.ts`、`tsjs-unified-adapter.ts`、
  `tsjs-unified-recursive.ts` 与 `unified-relation-facts.ts`。
- Swift adapter 没有真实 call-site 投影，不解析 import/`use` 绑定，不产出
  `BindingEdge` 或 `advance` 链。宏只有定义、没有真实调用边界时不能构造有效宏
  unknown，也不能把声明投影冒充调用事实。

因此 Swift 本阶段可准备的确定性来源是声明身份、词法作用域、owner/kind、
可见性、protocol/extension 局部语法证据、`nameSpan` 缺测和 partial parse。
project module path、宏展开、protocol witness dispatch、ObjC interop、SwiftUI
view graph 与真实调用表达式属于后继工程依赖，不能从声明表补造。

### 2.2 现有 converter 与 runner 事实

亲读 `lib/training/unified-student-converter.ts`、
`lib/training/unified-supervision-converter.ts`、
`lib/training/unified-step-context-builder.ts` 和
`lib/training/l2-standard-runner.ts` 后确认：

- `convert-samples`、`validate-data`、`train`、`resume` 是现有公开入口；
  `evaluate` 对当前基础树返回 `NOT_READY`。Swift evaluate 尚未接入。
  该结论仅描述基础树与 Swift 现状，不外推为其他语言候选的评价状态。
- `loadStepwiseFamilyManifest` 读取 `manifest.json` 的 `sourceGroup`、
  `language`、`semanticStratum`、`partition` 和可选
  `derivationFamily.familyId`。`loadUnifiedFamilyManifestSource` 额外只要求
  `sourceGroup` 和 `partition`。来源准入由 `corpus.admissionsPath` 的
  `familyAdmissions[]` 按精确 `sourceGroup` 和 `partition` 检查。
- 学生入口读取 `student-observations.jsonl`，接受
  `emma-tsjs-student-observation-v2` 或
  `carol-tsjs-fixed-stepwise-student-v1`；监督入口读取
  `independent-supervision.jsonl`，接受
  `emma-tsjs-independent-action-supervision-v1` 或
  `carol-tsjs-fixed-stepwise-supervision-v1`。
- 现有名称是 TS/JS 生成器历史名称，loader 按形状和字段校验，不按语言自动
  改写 schema。Swift 行若复用这些形状，必须显式记录 `language=swift`，
  不得把 Swift 行改名成 TS/JS 样本，也不得声称已经存在 Swift schema 兼容。
- `loadStepwiseEpisodeFamily` 把 `adapterRef` 硬编码为
  `tsjs-unified-adapter:${manifest.language}`；`unified-step-context-builder`
  把 `route.domain` 硬编码为 `tsjs`。Swift 物理转换前必须有明确 typed route
  和 adapterRef 修正，不能靠 manifest 里写 `language=swift` 自动获得正确路由。
- `declarationProjection` 当前无条件写 `bindingMode="bound"`、
  `resolution.status="resolved"`、`scopeRef=null`。Swift 未解析的 module、
  protocol witness、ObjC、SwiftUI 或宏依赖不得复用这一成功路径；须先引入
  已接受设计中的 `SwiftDeclarationEligibility` typed 承载，并使未解析项进入
  `resolution.status="unresolved"`。
- `unified-student-converter` 对 `currentRelation.binding.resolution.status=
  resolved` 的声明要求唯一匹配；Swift 预落在未就绪时应使用
  `unresolved/missing`，不得伪造 resolved 身份。
- `UnifiedRunnerConfig` 提供 `route.domain`、`route.decisionKind`、`phase`、
  `encoderVersion`、`dataGate.admissionsPath`、`outputDir` 和可选
  `corpus`。runner 的 route 由配置传入，但当前 StepContext builder 仍自行写
  死 `domain:"tsjs"`；这条差异必须由工程 owner 在 Swift 接入时闭合。

### 2.3 唯一缺口与 owner

| 层 | 本任务要闭合的缺口 | 唯一 owner |
| --- | --- | --- |
| 语料与监督 | Swift 来源家族、TRAIN/DEV/VERIFICATION 分区、独立 gold 与 supervision group | 研究设计 owner（本任务 Carol） |
| typed 事实 | 从 Swift 声明表产生 declaration identity、lexicalScope、owner/extension、资格与显式缺测 | 后继工程 owner（Jenny 指定） |
| converter 映射 | 把 Swift 行映射到既有 manifest/student/supervision/config 形状 | 同一工程 owner |
| 数据隔离 | 学生行只含请求、当前观测、候选和回执；gold/A_g 只进监督路径 | 工程 owner；独立数据审查 |
| 验证 | 检查事实保真、时序、无未来/teacher 泄漏、候选完整性和三态隔离 | Frank 或独立 verifier |
| 真值裁决 | 冲突或未决样本独立 adjudication，不把设计接受扩大为逐样本接受 | Alice |
| 集成与交付 | 后续实现、集成、远端核对和资源收口 | Jenny |

现有 Swift adapter 文件存在只证明声明/词法/owner 提取入口；`semanticBinding=false`
必须保留。文件存在不闭合 typed Swift 投影、call-site、import binding、训练准入
或产品能力。

## 3. Swift 来源家族与分区

### 3.1 共用准备规则

Swift 每个来源家族独立 `sourceGroup` 和 `partition`。同一真实来源家族不得跨
TRAIN、DEV、VERIFICATION；验证来源不参与拟合、样本构造、选参或候选选择。
语言隔离要求所有 Swift family 的 `manifest.language="swift"`，且与任何 TS/JS、
Rust、Kotlin 或 Java family 不共享 gold、监督、报告和分母。

每行准备记录至少带：

```text
language=swift
partition=TRAIN|DEV|VERIFICATION
sourceFamily
sourceRef
requestRef
expectedRelationRef
trainingEligible
readiness=ready|not_ready|coverage_gap|execution_failure
reason
observationReceipts
supervisionGroupRef
```

`sourceRef` 指向可复现的固定 fixture 或来源位置，不以短 hash 或临时目录作
唯一身份。`expectedRelationRef` 只作独立监督和分母身份，不进入学生输入。

### 3.2 可准备来源家族

| family | 最小构造 | 期望关系/用途 | 分区规则 |
| --- | --- | --- | --- |
| `local_declaration_relation` | 当前文件内已观测声明及其 owner/kind/extension 局部证据 | 已知 true/false；按 `declarationRef`、owner 和本地范围判同 | 独立 fixture 家族分 TRAIN/DEV/VERIFICATION |
| `lexical_scope` | 顶层声明与嵌套类型/函数/作用域内同名声明 | 词法作用域和 opaque declaration identity 决定关系 | 独立 fixture；作用域必须真实观测 |
| `shadow` | 局部同名声明遮蔽外层或父作用域声明 | 已知 false 或 true，按请求身份和 `role=shadow` 区分 | 独立构造；不与普通同名模板改名复用 |
| `protocol_witness` | 真实 `struct X: P` 与协议要求，且请求/待判关系对象关联 | 协议 witness dispatch 未解析且无法判定时为有效 unknown | 独立协议 fixture；缺目标对象进 coverage |
| `macro_boundary` | 真实宏节点 + 真实调用边界，且请求与调用关联 | 宏展开未执行、展开声明身份不可判定时为有效 unknown | 只有宏定义、无调用或无请求关联时进 coverage |
| `module_unresolved` | 已观测声明的 project module path 未知，且请求关系真实依赖模块身份 | 有声明对象但无法判定模块归属时为有效 unknown | 独立模块 fixture；无观测依据进 coverage |
| `execution_failure` | parser 非零、信号、超时、不可解释 dump、不可读文件 | execution/coverage failure | 保留原错，不生成 A_g，不进入语义分母 |

### 3.3 明确不准备的家族

| family | 原因 | 状态 |
| --- | --- | --- |
| `local_call_site` | Swift adapter 没有真实调用表达式投影；本设计不修代码 | `NOT_READY`，不得生成物理样本 |
| `import_binding` | adapter 不产出真实 import/`use` 边 | `NOT_READY`，不得用空 imports 补造 |
| `binding_edge`/`advance` 链 | 当前 Swift 无 typed BindingEdge | `NOT_READY`，学生候选不得列 `c:advance:*` |
| protocol witness 解析 | `protocolWitnessDispatch=not_resolved` | `COVERAGE_GAP`；仅真实对象和边界关联时可作有效 unknown |
| ObjC interop 解析 | `objcInteropBindings=not_resolved` | `COVERAGE_GAP`；不解析 selector/桥接关系 |
| SwiftUI view graph 解析 | `swiftUiViewGraph=not_resolved` | `COVERAGE_GAP`；不解析 `View`/`body` 组合 |
| 宏展开 | `swiftMacros=not_expanded` | `NOT_READY`；无真实调用边界时不得伪造 unknown |
| 跨模块/包解析 | `projectModulePath=unknown` | `COVERAGE_GAP`，保留未解析 |

本阶段不准备真实 call-site、import binding、witness 解析和 SwiftUI 组合。
后续工程 owner 补齐真实观测后，才可新增这些家庭，并重新经 Alice 审计。

### 3.4 分区与准入

建议 family 与 partition 分离命名，例如：

```text
swift-declaration-train-a        -> sourceGroup=..., partition=train
swift-declaration-dev-a          -> sourceGroup=..., partition=dev
swift-declaration-verification-a -> sourceGroup=..., partition=verification
swift-lexical-scope-train-a      -> ...
swift-shadow-train-a             -> ...
swift-protocol-witness-train-a   -> ...
swift-macro-boundary-train-a     -> ...
swift-module-unresolved-train-a  -> ...
```

具体 family ID 在建物理语料时确定；每个 `sourceGroup` 必须在
`corpus-admissions.json` 的 `familyAdmissions[]` 中出现，且 partition 与
manifest 完全一致。`validate-data` 当前会拒绝未声明来源、分区不匹配和
VERIFICATION 进入训练 data gate。不得通过跳过 admission 或把验证样本改成
train 来提高容量。

## 4. 学生与监督组

每个 Swift family、分区和 step 都有独立 supervision group。一个 group 对应
当前 obligation 的一步决策：

```text
studentRow:
  request + current State + legal candidates + observation receipts
supervisionRow:
  group_id + partition + language + source_family + stepId
  + A_g + allowed A_g + truth authority + readiness
```

候选生成只依赖当前 State 与合法 effects：

- `judge(true)`、`judge(false)`、`judge(unknown)` 同组保留，不按 gold 过滤；
- 有可减少不确定性的剩余义务时才列 `observe`；
- 只有存在可见、可读局部 BindingEdge 时才列 `advance`；当前 Swift 未就绪，
  所以物理 Swift 候选组不得包含 `c:advance:*`；
- 无合法补观察时用 `c:return`，有合法补观察时用 `c:defer`；
- 不列 `NOOP`、`NO_CAPABILITY`，它们不属于本切片已接受的候选集合；
- `enumeration=complete` 只表示当前步合法候选已完整枚举，不表示根范围
  cursor 已闭合。

一次模型决策只处理一个当前 obligation。固定引擎负责选择、更新 ledger 和
coverage cursor，并独立判断根是否 satisfied、partial、unsatisfied 或 unknown。

`steps[].S_g` 必须逐字等于学生候选集合（即当前步可见的完整候选组）；
`steps[].A_g` 的每个成员必须精确引用对应候选，且 `A_g` 是该候选组的非空子集；
二者不应被读作 `A_g=S_g`。空 A_g、A_g 越界、语言或分区不符、学生行含
gold/teacher 字段、未来观测或缺失监督均拒绝拟合并保留原错。零绑定关系仍保留
当前 reference/callSite/requested declaration 的 pending obligation；其
binding candidate 为 null，不伪造 edge。

## 5. 三态、训练准入与分母

| 结果 | 条件 | 是否可训练 | 分母归属 |
| --- | --- | --- | --- |
| semantic `judge(unknown)` | 已真实观测 protocol/macro/module 边界，固定谓词仍不可判 | 仅在有独立 unknown 真值裁决时 | semantic unknown 分母 |
| capability gap | adapter/parser 缺少必要观测能力 | 否 | coverage gap |
| execution failure | parse/process/permission/read 失败 | 否 | execution/coverage failure |
| known true/false | 已观测事实足以满足或否定固定谓词 | 是 | 对应 Swift 已知关系分母 |
| disputed truth | 真值冲突、待裁决 | 否 | pending，保留证据 |

capability gap 和 execution failure 不得生成对应 `A_g`，不得转成 false、
unknown 或 `other`，也不得从原 expected 列表删除。`trainingEligible=false`
的行只进入准备/覆盖报告。semantic unknown 不得因 adapter 不会观测而虚造。

`label_missing` 只表示独立监督本身缺失；学生输入缺测另记
`input-admission=input_observation_missing`，保留原 gold，不改写
`label_missing`。

准备阶段具名分母：

| 分母 | 定义与通过要求 |
| --- | --- |
| `D_source_obligations` | 已声明来源任务全集；每项必须对应结果、缺口或取消 |
| `D_files_discovered` | 范围内实际发现文件全集；逐文件列成功、partial、failed、未处理 |
| `D_target_obligations` | 请求声明及关系义务全集；逐目标记录局部资格和覆盖 |
| `D_eligible_groups` | 输入具备资格、完整 `S_g` 且监督有效的组；全部成功对应 |
| `D_known_relations` | 独立 gold=true/false 的合格输入；未来语义门为逐例正确、零错误 |
| `D_valid_unknown` | 有真实边界与对象关联的 unknown；未来终态 unknown 召回必须完整 |
| `D_action_groups` | 有逐步允许集合的合法选择组；按 `A_g` 单独评价 |
| `D_input_missing` | 学生观测缺失；保留 gold 和任务身份，进入 unassessed |
| `D_label_missing` | 独立监督缺失；与学生缺测分开 |
| `D_execution_failure` | parser、观测、转换及执行错误；保留原错和受影响对象 |

## 6. Swift typed fixture 最小形状

物理 fixture 的逻辑形状如下（文件名是准备合同的产物名，不是现有 runner
已经提供的 Swift 物理 schema）：

```text
corpus/
  swift-family-.../
    manifest.json
    student-observations.jsonl
    independent-supervision.jsonl
    evidence/
    expected-report.json
  corpus-admissions-swift-r1.json
```

### 6.1 manifest.json

物理文件至少含：

```json
{
  "sourceGroup": "swift-declaration-train-a",
  "language": "swift",
  "semanticStratum": "declaration_identity",
  "partition": "train",
  "derivationFamily": { "familyId": "swift-declaration-train-a" }
}
```

`partition` 只能是 `train|dev|verification`；`language` 固定 `swift`。不得用
同一 manifest 混多种语言或跨分区来源。

### 6.2 student-observations.jsonl

复用现有 stepwise 逻辑字段：`request`、`steps[].localSyntax`、
`remainingObligations`、`S_g`、`receipts`、`coverage`、`notReady`。

当前 loader 接受的历史 schema 名称是 `emma-tsjs-student-observation-v2` 或
`carol-tsjs-fixed-stepwise-student-v1`。Swift 物理落地前由工程 owner 明确：

1. 使用语言中立的 schema 名称；或
2. 显式批准 Swift 复用现有形状，并增加 `language=swift` 与 schema 兼容测试。

在明确决定前，Swift fixture 只能作为设计映射，不能宣称已被 converter 接受。

### 6.3 independent-supervision.jsonl

复用现有 stepwise 监督逻辑字段：`sampleId`、`family`、`requestRef`、
`steps[]`、`trainingEligible`、`notReadyReason`。`steps[].S_g` 必须逐字
等于学生候选集合（即当前步可见的完整候选组）；`steps[].A_g` 的每个成员
必须精确引用对应候选，且 `A_g` 是该候选组的非空子集；二者不应被读作
`A_g=S_g`。

监督字段至少包含：

```text
labelAuthority = researcher_structural_proof+swiftc_dump_parse
oracleKind = swiftc_dump_parse|swift_structural_audit
unknownReason = null|protocol_witness_unresolved|macro_expansion_not_evaluated|
                objc_interop_unresolved|swiftui_view_graph_unresolved|
                module_path_unknown|evidence_insufficient
```

gold 只来自独立结构性证明和真实 swiftc AST 观测；不得从学生输出反推。已知
true/false 必须有可复现的声明身份和来源位置。unknown 必须有真实边界对象和
独立 unknown 裁决。

### 6.4 最小覆盖组

每个 ready family 至少覆盖：

- 已知 true；
- 已知 false；
- 零绑定或对象缺测；
- 同名不同 `declarationRef`；
- 未来观测拒绝（当前步不得含后续声明/证据）；
- gold 泄漏拒绝（学生侧不得出现 `A_g`、gold、teacher、oracle 字段）。

protocol/macro/module ready family 另需：

- 有真实边界对象、可判定 true/false 的对照；
- 有真实边界对象但独立 unknown 的合法样本；
- 边界对象缺失时进入 coverage gap 的反例。

宏家族只有在真实宏节点和真实调用边界同时存在且与请求关联时才能形成有效
unknown。只有宏定义、没有调用边界时保持 `NOT_READY`，不得用判断结果补造。

### 6.5 converter/config 必须陈述的映射

Swift 物理落地前，工程 owner 必须逐项核对并记录：

1. `manifest.sourceGroup`、`language=swift`、`semanticStratum`、`partition`、
   `derivationFamily.familyId`；
2. runner config 的 `schema`、`command`（仅 `convert-samples` / `validate-data`）、
   `route.domain`（Swift typed domain）、`route.decisionKind="R"`、`phase`、
   `encoderVersion`、`dataGate.admissionsPath`、`outputDir`；
3. student/supervision 行 schema 的名称决定与 Swift 兼容证据；
4. 复合键 `sourceGroup | sampleId | stepContextRef | candidateGroupRef` 的
   稳定对应；
5. `adapterRef` 从当前 `tsjs-unified-adapter:${manifest.language}` 迁移到
   Swift typed adapterRef 的条件；`swift-unified-adapter.ts` 不存在前，物理转换
   保持 `NOT_READY`；
6. `declarationProjection` 的 resolved/unresolved 资格由
   `SwiftDeclarationEligibility` 驱动；该类型本页只引用已接受设计中的提案，
   不代表已实现；
7. `StepContext` 的 route domain 不再无条件写 `tsjs`；runner config 传入的
   domain 必须与 builder 输出一致。

以上任一未闭合时，只能交出设计映射与缺口，不能宣称 `convert-samples` 或
`validate-data` 已接受 Swift。

## 7. 准备阶段公开入口与命令

准备阶段复用现有命令，不新增第二套训练入口：

```sh
node dist/training/l2-standard-runner.js convert-samples --config <runner-config.json>
node dist/training/l2-standard-runner.js validate-data --config <runner-config.json>
```

`convert-samples` 必须写隔离的学生路径与监督路径；`validate-data` 必须核对
64 槽 typed 行、显式分区、语言隔离、阈值、候选完整性与泄漏。准备阶段不执行
`train`、`resume` 或 `evaluate`。Swift `evaluate` 当前 NOT_READY，不能把 TS/JS
后续评价状态外推为 Swift 已就绪。

文档交付检查：

```sh
git diff --check
node scripts/check-layout.mjs
```

物理语料未生成，因此本任务不运行 `convert-samples` 或 `validate-data` 作为
Swift 成功证据。

## 8. TS-first 与跨语言验证顺序

1. TS/JS 先取得合格候选和被接受的 symbol-slice 行为。设计接受不等于候选已验收。
2. Swift 可并行准备语料、typed fixture 与验证设计，但 Swift 拟合不得早于 TS
   合格候选及其 symbol-slice 行为验收。
3. Swift 准备完成后，用同一个固定共享引擎和共享抽象做跨语言验证。语言报告、
   adapter、gold 和分母保持独立；合并分数不得掩盖任一语言失败。
4. 跨语言验证决定是否需要增量训练。必要增量训练从已接受的共享权重开始，并
   重放旧能力回归样本；不默认每语言从零训练独立候选。
5. 任何候选须通过新进程 reload、隔离 holdout、逐语言候选/coverage 门和旧能力
   回归，才可称为 live。TS 通过不推出 Swift 通过。

## 9. 验收与失败出口

Swift 最终语义门：

1. 已知关系逐例 100% 正确，错误数为零；
2. 有真实边界依据的 semantic unknown 100% 报最终 `judge(unknown)`，无漏报或
   误判；
3. 当前步候选完整，`truncatedCount=0`、`failedCount=0`；coverage gap 和
   execution failure 分列且保留原错；
4. `label_missing` 不进入正确率分母但保留证据；
5. 根评价由固定引擎独立给出，不能把 `processingStatus=complete` 当作 satisfied；
6. Swift 单独通过；任一语言失败即整体 incomplete。

以下任一情况即失败或保持未就绪，不能以测试通过替代：

```text
typed observation missing        -> DATA_INVALID / coverage gap
parse/process/read failure       -> execution/coverage failure
unsupported construct            -> capability gap with reason
candidate truncation             -> coverage/execution failure
missing declaration/type         -> unsupported/coverage when not observable
legal observations exhausted     -> judge(unknown) only under fixed predicate
expected relation unmatched      -> missing, retained in denominator
```

独立审查还必须核对：

- Swift family 的 language、partition 和 supervision 完全隔离；
- 学生文件不含 `A_g`、gold、teacher、oracle 或未来观测；
- 没有把声明投影冒充 call-site；
- 没有从缺失对象伪造 unknown；
- 没有把 TS/JS schema 名称冒充 Swift 已验证兼容；
- 物理语料、converter、evaluate 和训练均显式 INCOMPLETE/UNVERIFIED。

## 10. 当前缺口与生命周期

已核对并接受的事实：

- Swift adapter 提供单文件声明、词法作用域、owner/kind、可见性与 partial 状态；
- parser 固定 `semanticBinding=false`；
- `projectModulePath`、宏展开、protocol witness、ObjC interop 与 SwiftUI
  view graph 仍未解析；
- `lib/adapters/` 没有 `swift-unified-adapter.ts`；
- Swift adapter 没有真实 call-site 或 import 绑定投影；
- stepwise loader 接受既有 student/supervision 形状，但 adapterRef 和 route
  domain 仍硬编码为 tsjs；
- `unified-step-context-builder.declarationProjection` 无条件 resolved；
- public `evaluate` 对当前基础树 NOT_READY；Swift evaluate 未接入。其他语言
  候选的独立评价状态另行判定，不由本条覆盖。

尚未实现或未验证：

- Swift 物理语料、独立 gold/A_g fixture 和 corpus admission；
- Swift typed declaration eligibility 与 unresolved 投影；
- Swift adapterRef 和 StepContext typed route；
- 真实调用表达式观测和 import binding；
- Swift converter 兼容性、validate-data 真跑、evaluate、train、resume、
  新进程 reload、独立 holdout 和旧能力回归；
- 产品接线、安装、采用和 live 能力声明。

本任务只交付设计准备合同和任务日志，不关闭这些工程缺口。Swift 语料物理准备、
converter 兼容性、独立评价和训练保持 `INCOMPLETE/UNVERIFIED`。

## 11. 交付索引

| 产物 | 路径 |
| --- | --- |
| Swift 语料准备合同（本页） | `docs/nn-code-redesign-symbols-swift-corpus-prep-r1.md` |
| 上游 Swift 设计 | `/Volumes/Intel/playground/nnanything-runs/nn-code-redesign-symbols-swift-20261108/nn-code-redesign-symbols-swift-design.md` |
| 上游准备计划 | `/Volumes/Intel/playground/nnanything-runs/nncode-swift-first-train-planner-20261109/plan.md` |
| Alice 计划审计 | `/Volumes/Intel/playground/nnanything-runs/nncode-swift-first-train-planner-20261109/alice-plan-audit.md` |
| 共享 TS/JS 设计 | `docs/nn-code-redesign-symbols-tsjs-design.md` |
| 训练入口与回载合同 | `docs/nn-code-tsjs-training-entry-reload-contract.md` |
| 现有 Swift 声明 adapter | `lib/adapters/cli/swift-symbol-table-adapter.ts` |
| 现有 Swift 声明 policy | `lib/filters/swift-symbol-table-policy.ts` |
| 学生转换入口 | `lib/training/unified-student-converter.ts` |
| 监督转换入口 | `lib/training/unified-supervision-converter.ts` |
| 本轮任务日志 | `/Volumes/Intel/playground/nnanything-runs/nn-code-symbols-swift-corpus-prep-r1-20261109/task-log.md` |

## 12. 生命周期状态

本切片为 `read_only` 设计准备。交付形式是文档和任务日志；不产生代码候选，
不制造 integration。物理语料、converter 兼容、evaluate 和 training 仍由 Alice
接受后的后继任务分别验收。worktree `swift-corpus-prep-20261109` 在 review 和
收口后由 owner 清理；run 证据保留。
