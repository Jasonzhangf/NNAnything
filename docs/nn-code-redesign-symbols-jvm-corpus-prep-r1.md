# NN Code redesign: JVM symbol corpus preparation r1

状态：2026-11-09 设计准备。owner Leo，reviewer Alice。任务
`nn-code-symbols-jvm-corpus-prep-r1-20261109` 只准备 Kotlin/Java 语料、
分区、typed fixture、独立监督与验证入口。本页不启动 JVM 拟合，不实现产品，
不改权重、gold、threshold 或采用状态，不接线、不安装，也不动 daemon 或 tmux。

## 1. 目标与已接受边界

本切片闭合一个缺口：把已接受的 JVM 符号关系设计，变成可按语言独立验收的
语料准备合同。它不把现有单文件符号提取器说成已具备语义绑定，也不把设计接受
说成训练或产品能力。

已接受的上游依据：

- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-jvm-symbol-table-redesign-r1.md`
  §1-§4、§7-§10：Goal/State/Action、声明身份、三态 unknown、分区和 TS-first
  顺序。
- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-overall-redesign-route-r1.md`：
  正式 ACCEPT 独立 Kotlin/Java 语料、typed fixture 与验证准备。
- `docs/nn-code-redesign-symbols-tsjs-design.md` §1-§9：共享 judge/action、
  64 槽 StepContext、候选组、固定引擎与语义硬门。
- `docs/nn-code-tsjs-training-entry-reload-contract.md` §1-§5：固定 recipe、
  TRAIN-only 准入、模型包与 checkpoint 边界。

固定共用引擎不变：输入 64 维；hidden 为 64 -> 64 -> 64 -> 1 ReLU；group loss；
full-batch SGD，momentum 0；learning rate 0.01；maxEpochs 200；Xavier fixed
seed；DEV 早停禁用。Kotlin 和 Java 可共用字段形状与代码，但不共用语言真值。

## 2. 唯一缺口与职责

| 层 | 本任务要闭合的缺口 | 唯一 owner |
| --- | --- | --- |
| 语料与监督 | 为 Kotlin、Java 分别定义来源家族、TRAIN/DEV/VERIFICATION 分区、独立 gold 与 supervision group | 研究设计 owner（本任务 Leo） |
| 确定性事实 | 从声明表增量产生 typed reference、call site、import/lexical binding、BindingEdge 与 opaque declaration identity | Jenny 后续指定的工程 owner |
| 固定引擎映射 | 把局部 State、义务、合法候选和 coverage cursor 映射到既有 `runRecursiveGoal` | 同一工程 owner |
| 数据隔离 | 学生行只含请求、当前观测、候选和回执；gold/A_g 只进独立监督路径 | 工程 owner；数据独立审查 |
| 验证 | 检查事实保真、时序、无未来/teacher 泄漏、候选完整性和三态隔离 | Frank 或独立 verifier |
| 真值裁决 | 对冲突或未决样本作独立 adjudication，不把设计接受扩大为逐样本接受 | Alice |
| 集成与交付 | 后续实现、集成、远端核对和资源收口 | Jenny |

现有 `java-symbol-table-adapter.ts`、`kotlin-symbol-table-adapter.ts` 和对应
policy 只输出声明记录。其 `parser.semanticBinding=false` 是必须保留的事实。
adapter 文件存在不闭合 typed reference、import binding、BindingEdge 或训练准入。

## 3. 语料来源与分区

### 3.1 共用准备规则

Kotlin 和 Java 各有独立 source family、gold、候选集合、报告和分母。每个语言
各有 TRAIN、DEV、VERIFICATION；同一真实来源家族不得跨分区。独立验证来源不参与
拟合、样本构造、参数选择或候选选择。

旧 `nn-code symbols`、编译器诊断、PSI dump 和确定性最终绑定只作 teacher、
oracle、来源与对照。学生输入只含当前请求、局部 typed observation、合法候选和
执行回执，不含 gold、A_g、最终声明链、未来回执或 `goal_met`。

每行准备记录至少带：`language`、`partition`、`sourceFamily`、`sourceRef`、
`requestRef`、`expectedRelationRef`、`trainingEligible`、`readiness`、
`reason`、`observationReceipts`、`supervisionGroupRef`。`sourceRef` 指向
可复现的固定 fixture 或来源位置，不以短 hash 或临时目录作唯一身份。

### 3.2 Kotlin 来源家族

| family | 最小构造 | 期望关系/用途 | 分区规则 |
| --- | --- | --- | --- |
| `import_alias` | `import lib.helper as h` 后调用 `h` | 已观察 alias 指向请求声明则 true；指向另一声明则 false | 按独立 fixture 家族分 TRAIN/DEV/VERIFICATION |
| `local_shadow` | 局部函数或变量遮蔽同名顶层声明 | 请求顶层声明时为 false；局部声明身份不得合并 | 独立构造，不与 alias 模板改名复用 |
| `same_name_packages` | 两个包有同名声明 | 包与 declarationRef 区分，不按显示名去重 | 独立包身份 fixture |
| `type_member_unsupported` | 外部类型参数调用成员 | 无 classpath 时为 unsupported coverage gap | 只进 coverage/准备分母，不生成 A_g |
| `syntax_or_read_failure` | 语法错误、不可读或解析失败 | execution/coverage failure | 保留原错，不进入 semantic unknown |

`type_member_unsupported` 不以“没找到声明”推成 false。只有 adapter 能合法观测
所有必要事实，且固定谓词仍无法区分请求声明时，才可准备 semantic unknown。

### 3.3 Java 来源家族

| family | 最小构造 | 期望关系/用途 | 分区规则 |
| --- | --- | --- | --- |
| `single_import` | `import lib.a.Helper` 后使用 `Helper` | 请求声明相同为 true，不同包声明为 false | 独立 fixture 家族 |
| `static_import` | `import static lib.Factory.make` 后调用 `make` | 已观察静态成员身份决定 true/false | 独立构造 |
| `same_simple_name` | `lib.a.Helper` 与 `lib.b.Helper` | 以完整 declarationRef 区分，不合并短名 | 独立包身份 fixture |
| `overload_identity` | 同名方法不同参数签名 | 以 opaque declaration identity 区分 | 独立构造，避免仅靠名称判真 |
| `wildcard_not_ready` | `import lib.a.*; import lib.b.*;` | 未固定谓词且无独立 javac receipt 时为 not_ready | 不生成 A_g；保留 coverage/truth preparation |
| `syntax_or_read_failure` | 语法错误、不可读、JVM 执行失败 | execution/coverage failure | 保留原错，不进入 semantic unknown |

Java wildcard 只有在固定根谓词和独立 `javac` receipt 同时存在后，才可转为
semantic unknown 或确定关系。编译器已诊断的歧义属于 compiler failure/coverage，
不是模型关系标签；不得用大写或假设的 A_g 补齐。

## 4. 学生与监督组

每个语言、每个分区、每个 source family 都建立独立 supervision group。一个
group 对应一个当前 obligation 的一步决策：

```text
studentRow:
  request + current State + legal candidates + observation receipts
supervisionRow:
  group_id + partition + language + source_family
  + A_g + allowed A_g + truth authority + readiness
```

候选生成只依赖当前 State 与合法 effects：

- `judge(true)`、`judge(false)`、`judge(unknown)` 同组保留，不按 gold 过滤；
- 有可减少不确定性的剩余义务时才列 `observe`；
- 有可见、可达的 BindingEdge 时才列 `advance`；
- `DEFER`、`NOOP`、`RETURN` 按当前 State/effects policy 生成；
- `enumeration=complete` 只表示当前步合法候选已完整枚举且本地页闭合，不表示
  根范围 cursor 已闭合；
- 一次模型决策只处理一个当前 obligation。固定引擎记录选择、更新 ledger 和
  coverage cursor，并独立判断根是否 satisfied、partial、unsatisfied 或 unknown。

`A_g` 必须属于当前 `S_g`。空 A_g、A_g 越界、语言或分区不符、学生行含 gold/
teacher 字段、未来观测或缺失监督均拒绝拟合并保留原错。零绑定关系仍保留当前
reference/call site 与 requested declaration 的 pending obligation；其 binding
candidate 为 null，不伪造 edge。

## 5. 三态与训练准入

| 结果 | 条件 | 是否可训练 | 分母归属 |
| --- | --- | --- | --- |
| semantic `judge(unknown)` | 合法观测已耗尽，固定谓词仍不可判 | 仅在有独立 unknown 真值裁决时 | semantic unknown 分母 |
| capability gap | adapter/parser 缺少必要观测能力 | 否 | coverage gap |
| execution failure | parse/process/permission/read 失败 | 否 | execution/coverage failure |
| known true/false | 已观察事实足以满足或否定固定谓词 | 是 | 对应语言已知关系分母 |
| disputed truth | 真值冲突、待裁决 | 否 | pending，保留证据 |

capability gap 和 execution failure 不得生成对应 `A_g`，不得转成 false、
unknown 或 `other`，也不得从原 expected 列表删除。`trainingEligible=false`
的行只进入准备/覆盖报告。semantic unknown 不得因 adapter 不会观测而虚造。

## 6. Typed fixture 与公开验证入口

### 6.1 Fixture 最小形状

每种语言至少准备独立的 typed fixture 目录，包含以下逻辑产物：

```text
sources/                 Kotlin 或 Java 固定来源
observations.jsonl       当前步 typed facts 与 receipts
supervision.jsonl        独立 gold/A_g 与真值来源
readiness.json           分区、family、eligible、gap/failure 原因
expected-report.json     独立验证的逐语言分母和硬门
```

这些文件名是本准备合同的逻辑产物名，不是现有 runner 已接受的物理
schema 或文件名。当前 `unified-student-converter.ts` 读取 `manifest.json` 与
`student-observations.jsonl`，并限制 TS/JS schema；JVM 物理 fixture 落地前，
工程 owner 必须明确映射到现有 loader/config，或实现受范围的 JVM adapter 增量。
不得把 JVM 行改名为 TS schema 后宣称兼容。

fixture 必须覆盖：已知 true、已知 false、合法 semantic unknown、capability gap、
execution failure、零绑定、同名不同 declarationRef、未来观测拒绝、gold 泄漏拒绝。
Java 另含 single/static import 与 not-ready wildcard；Kotlin 另含 alias、local
shadow 与 unsupported type member。每个 fixture 的期望由独立真值来源给出，不从
学生输出反推。

本准备合同没有交付有具体谓词、合法观测耗尽和独立真值证据的实体 semantic
unknown 样本。该缺口保持未就绪，不得为填满 fixture 清单虚构 unknown。

### 6.2 准备阶段公开入口

复用现有公开命令，不新增第二套训练入口：

```sh
node dist/training/l2-standard-runner.js convert-samples --config <runner-config.json>
node dist/training/l2-standard-runner.js validate-data --config <runner-config.json>
```

`convert-samples` 必须写隔离的学生路径与监督路径。`validate-data` 必须核对
64 槽 typed 行、显式分区、语言隔离、阈值、候选完整性与泄漏。准备阶段不执行
`train`、`resume` 或 `evaluate`。JVM `evaluate` 尚未接入，不能把 TS/JS 后续
评价状态外推为 JVM 已就绪；JVM 独立 holdout 评价和旧能力回归接入后，才能作为
JVM 真实训练门禁。上述物理 fixture 映射与 JVM 评价接入仍是工程缺口。

后续工程实现须在现有 adapter/policy 上增量产生 typed facts，并映射到既有
`runRecursiveGoal`。不得把 adapter 的最终声明、编译器答案或 PSI dump 直接塞入
学生输入。验证者须独立核对事实来源时间、opaque declaration identity、同名
overload 区分、alias/import 边、零绑定与 coverage closure。

## 7. TS-first 与跨语言验证顺序

1. TS/JS 先取得合格候选和被接受的 symbol-slice 行为。设计接受不等于候选已验收。
2. Kotlin/Java 可并行准备语料、typed fixture 与验证设计，但 JVM 拟合不得早于
   TS 合格候选及其 symbol-slice 行为验收。
3. JVM 准备完成后，用同一个固定共享引擎和共享抽象做跨语言验证。语言报告、
   adapter、gold 和分母保持独立；合并分数不得掩盖任一语言失败。
4. 跨语言验证决定是否需要增量训练。必要增量训练从已接受的共享权重开始，并
   重放旧能力回归样本；不默认每语言从零训练独立候选。
5. 任何候选须通过新进程 reload、隔离 holdout、逐语言候选/coverage 门和旧能力
   回归，才可称为 live。TS 通过不推出 Kotlin 或 Java 通过。

## 8. 验收与失败出口

逐语言最终语义门：

1. 已知关系逐例 100% 正确，错误数为零；
2. 有效 semantic unknown 100% 报最终 `judge(unknown)`，无漏报或误判；
3. 当前步候选完整，`truncatedCount=0`、`failedCount=0`；coverage gap 和
   execution failure 分列且保留原错；
4. `label_missing` 不进入正确率分母但保留证据；
5. 根评价由固定引擎独立给出，不能把 `processingStatus=complete` 当作 satisfied；
6. Kotlin 与 Java 分别通过；任一语言失败即整体 incomplete。

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

## 9. 当前实现事实与剩余缺口

已核对的事实：

- `lib/filters/java-symbol-table-policy.ts` 的 symbol record 只有声明字段，
  parser 固定 `semanticBinding=false`；boundaries 明确 classpath 未解析。
- `lib/filters/kotlin-symbol-table-policy.ts` 同样只有声明字段，
  `semanticBinding=false`；boundaries 明确 module path 与生成源未解析。
- `tests/kotlin-symbol-table.test.mjs` 明确断言 complex receiver 仍为
  declaration-only，且输出不含 `callEdges`/`bindings`。
- 现有 Kotlin/Java 测试覆盖声明种类、作用域、语法错误、符号链接与 JVM 失败；
  不覆盖 typed reference、import binding、BindingEdge 或训练准入。

尚未实现或未验证：

- Kotlin/Java typed reference、call site、import/lexical binding、BindingEdge；
- opaque declaration identity 的完整 typed 投影与递归引擎映射；
- 独立学生/监督 fixture、逐语言 gold、三态 coverage 报告；
- Java wildcard 固定谓词与独立 `javac` receipt；
- JVM fit、train、resume、evaluate、新进程 reload、独立 holdout 和旧能力回归；
- 产品接线、安装、采用与 live 能力声明。

本任务不关闭这些工程缺口。本页只给出可执行的语料/分区/验证准备合同，供 Alice
审计、Jenny 后续指定工程 owner。

## 10. 交付索引

| 产物 | 路径 |
| --- | --- |
| JVM 语料准备合同（本页） | `docs/nn-code-redesign-symbols-jvm-corpus-prep-r1.md` |
| 上游 JVM 设计 | `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-jvm-symbol-table-redesign-r1.md` |
| 上游设计接受 | `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-overall-redesign-route-r1.md` |
| 共享 TS/JS 设计 | `docs/nn-code-redesign-symbols-tsjs-design.md` |
| 训练入口与回载合同 | `docs/nn-code-tsjs-training-entry-reload-contract.md` |
| 现有 Java 声明 adapter | `lib/adapters/cli/java-symbol-table-adapter.ts` |
| 现有 Kotlin 声明 adapter | `lib/adapters/cli/kotlin-symbol-table-adapter.ts` |
| 现有 Java 声明 policy | `lib/filters/java-symbol-table-policy.ts` |
| 现有 Kotlin 声明 policy | `lib/filters/kotlin-symbol-table-policy.ts` |
| 本轮任务日志 | `/Volumes/Intel/playground/nnanything-runs/nn-code-redesign-symbols-jvm-corpus-prep-r1-20261109/task-log.md` |

## 11. 生命周期状态

`DESIGN_PREP_ONLY`。设计准备完成后交 Alice review。JVM 拟合、训练、回载、
独立留出评价、旧能力回归和集成均为 `INCOMPLETE`/`UNVERIFIED`，由 Jenny 按
board 生命周期另派。本页不改变任何产品行为或运行状态。
