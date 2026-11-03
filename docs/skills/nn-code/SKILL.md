---
name: nn-code
description: 已知 TS/JS 函数入口，需要理解执行流程、审计影响或追踪被调用方时，优先用 nn-code calls 一次获取指定 scope/depth 内的静态调用关系、源码位置及未解析项，省去 agent 逐层搜索的多次往返；跨函数值传播、变量来源/去向追踪用 nn-code value-flow（TS/JS，静态 may-provenance）；Rust/Kotlin/Java/TS/JS/Swift 声明与词法归属用 nn-code symbols。单次文本定位可用 rg；错误和阻断任务的能力缺口通过 Collab 报告。
---

# `nn-code` 使用、参数选择与问题反馈

## 一次调用能得到什么，为什么优先使用

给定 TS/JS 入口后，`nn-code calls --verbose` 在一次调用中完成指定 `--scope` 和 `--max-depth` 内的静态被调用关系展开，返回关系节点、边、声明与调用点位置，以及未解析目标和覆盖证据。agent 可直接据此整理执行流程、选择需要精读的函数，不必逐层搜索、读结果、再组织下一条查询。

例如需要追到入口的三层被调用方：手动逐层查询通常至少需要三轮有前后依赖的工具往返；使用 `--max-depth 3 --verbose`，一次调用即可取得该深度内的关系图。同层并行搜索仍需等待上一层返回，不能消除这个依赖。主要收益是减少模型组织查询、读取中间结果和再次调用的轮次；不承诺固定倍数的速度或 token 节省。

“一次获取关系”指本次范围与深度内可静态解析的被调用关系，不是全仓所有关系、反向引用、值流或跨语言调用图。深度边界、动态调用和未解析项仍须读取；`achieved` 不代表这些未知关系已被解决。`symbols` 一次返回所选范围内支持的声明清单，不冒称调用关系。`value-flow` 返回静态 may-provenance 的候选站点与边，不代表已解析全部真实值流。任务只需一次文本命中时，直接用 rg 即可。

## 按任务选择命令

### 什么时候用 nn-code，什么时候用 rg

- 已知 TS/JS 函数入口，需要查被调用方或逐层展开调用链：优先一次 `nn-code calls`，按任务需要设置深度；不要用多轮 rg 逐层模拟关系查询。
- 需要追踪某个变量/参数/返回值在跨函数、跨文件中的来源或去向（值传播、是否被引入到某点），且源码是 TS/JS：用 `nn-code value-flow`。它返回静态 may-provenance 站点与边，不是调用图，也不是确定性的全边 oracle。
- 需要 Rust/Kotlin/Java/TS/JS/Swift 的符号声明、精确位置、同名声明区分或词法归属：优先 `nn-code symbols --language <lang>`。
- 只找一个字符串、配置项、日志文本、文档内容或正则命中，一次文本查询即可回答：用 `rg`。只需文件名清单时用 `rg --files`。入口尚未给定时可用精确文本搜索定位候选，再按所需能力选择 nn-code。
- nn-code 已返回关系和源码跨度时，直接按跨度读取必要上下文；不要再用 rg 重复验证已闭合的每条边。遇到 unresolved、覆盖缺口或未支持的语言关系时，按明确线索用 rg 和源码读取补查；人工确认结果与工具输出分开，阻断任务的缺口按 reportbug 流程反馈。
- 当前 nn-code 的文本候选扫描不等于独立通用正则搜索接口。不要臆造 `nn-code search`、`--regex` 等参数，也不要把文本同名命中当作调用边。需要当前未支持的正则或 ignore 行为时使用 rg。
- 选择依据是能否一次得到任务所需结果、减少依赖上一轮结果的模型往返。一次 rg 能完成的定位直接用 rg；关系任务可由 nn-code 一次完成时优先 nn-code，不以命令执行毫秒数代替整体流程判断。

| 实际任务 | 使用方式 | 结果如何继续使用 |
| --- | --- | --- |
| 已知 TS/JS 函数，追踪它调用谁 | `calls`，传入口文件、符号、深度和 scope | 读取关系与调用点；只对未解析目标补查源码 |
| 追踪 TS/JS 变量/参数/返回值的跨函数来源或去向 | `value-flow`，传 repo、anchor 文件/符号、direction、max-depth 和 scope | 读站点与边；未解析或跨文件覆盖开放时按 unknown 处理，只对有证据的边下结论 |
| 找 Rust/Kotlin/Java/TS/JS/Swift 声明及位置 | `symbols --language <rust\|kotlin\|java\|typescript\|javascript\|swift>` | 保留同名声明的不同位置与词法归属；不是调用关系图 |
| 审计逐层调用关系 | 在 `calls` 上加 `--verbose`；可同时加 `--compact` | 获取完整结构化关系和覆盖证据；compact 只改变排版 |
| 混合语言仓库 | 对需要的语言分别调用已支持的命令，显式给 scope | 可整理各语言结果，但不能把文本同名命中连成已证跨语言引用 |

- `--scope` 可以重复或用逗号分隔。传任务所需的目录或具体文件；不能缩小用户要求的范围后宣称原任务已完整完成。
- `symbols --symbol` 按短名称精确匹配、区分大小写；`--file` 与名称及 scope 取交集。需要核对同名声明时保留全部命中。
- `--edition` 只用于 Rust。Kotlin 不传该参数；JDK/jars 缺失时保留实际错误，不能当作零符号。
- `symbols` 不接受 `--entry-file`、`--entry-symbol`、`--entry-lexical-path`、`--max-depth`、`--request-id`、`--diagnostics-file`、`--verbose`；不能照搬 calls 参数。
- 正常使用保留默认日志。用户要求关闭时传 `--no-log`；此时 `logging.state=disabled` 是预期结果，不报日志故障。`--diagnostics-file` 是独立显式导出，关闭持久记录时不要另传它。
- 同时读语义结果与 coverage/未解析项。退出成功不表示未知关系已解析；日志状态也不能替代查询状态。
- 已知参数直接使用。仅在参数被拒收或安装版与本 Skill 冲突时，查看对应子命令 help 一次，保留原错并按下方流程报告；不凭猜测重复调用。

## CLI 能力升级与 Skill 同步交付（维护者）

每次 CLI 升级，新增或改变命令、支持语言、可用语义、参数、输出或错误行为时，必须在同一交付中更新本 Skill。所有新增且可用的能力都要让 Agent 能发现并正确调用，不限于参数变更。

- 在 `description` 和任务选择中写清何时使用、能一次取得什么结果，以及与 `rg` 的分工。
- 同步真实命令、必要参数、默认值、组合限制、输出读取、未知/失败处理、日志与问题反馈，并提供受影响能力的实际用例。尚未安装验收的能力不得标成已可用。
- Jenny 负责源码 `docs/skills/nn-code/SKILL.md`、全局正文 `~/.agents/skills/nn-code/SKILL.md` 与安装版 help 同批同步。发布前先合并已有 Skill 修订，禁止用旧源码副本覆盖全局的新规则；宿主链接继续指向全局正文。
- Alice 或交付审计者核对安装版 help、源与全局 Skill 的一致性及受影响真实用例；复用有效回执，不要求重跑无关测试。代码合入或 CLI 安装成功，但 Skill 未同步、缺少使用触发条件或调用说明不符时，该能力的使用交付仍为未完成，交 Jenny 补齐后再验收。

项目 AGENTS 只保留使用触发条件，不复制上述参数与反馈规则。

## 1. 核心原则（压缩编排开销，禁止冗余探测）

- **调用关系探索优先 nn-code**：排障、理解执行流程或审计代码时，一旦需要从已知函数继续查找被调用方，先使用 nn-code，不默认以多轮 rg/sed 逐层展开。优化目标包含模型组织命令和等待结果的往返耗时，不能只比较命令本身的执行时间。同层并行不能消除依赖上一层结果的往返。仅定位一个定义或入口尚未知时可用精确搜索；获得入口后切回 nn-code。
- **未知可继续检查**：保留 unresolvedCallsites 与实际给出的调用点、表达式和原因；沿明确位置读取必要源码。没有证据的目标不得猜成已解析关系。人工补查结论与工具结果分开。当前未提供的未知字段不得由 agent 冒充工具输出。
- **能力缺口也反馈**：正常边界本身不是缺陷；但它阻断实际任务、迫使 agent 手工追踪明确目标时，应沿下方报告流程投递 `[capability-gap]`，说明实际任务、已知位置及缺失关系。不能以“Skill说不是bug”为由丢弃有价值的未知样本。相同缺口复用已有报告，不逐调用重复发送。日志和人工提案不自动成为训练真值，由研究员核验、分区后用于后训练。

1. **已给定入口时一次命令直达**：
   - 当已知目标仓库 `--repo`、入口相对路径 `--entry-file` 与入口函数名 `--entry-symbol` 时，直接运行一次 `/opt/homebrew/bin/nn-code calls` 获取结构化 JSON。
   - **不要**在每次调用前先跑 `nn-code --help`、`which nn-code` 或编写临时 Node/Python 包装脚本；**不要**去读取被查询仓库里的设计文档、`tests/` 或历史评测目录。
2. **只在需要函数体内部逻辑或核查动态调用时按跨度精读源码**：
   - `nn-code calls` 已返回每个节点的精确声明跨度 `declSpan`（`startLine..endLine`）和每条边的调用点跨度 `callsiteSpan`。
   - 若后续任务需要阅读某函数的具体业务实现，直接用 `sed -n '<startLine>,<endLine>p' <repo>/<filePath>` 读取该函数行区间，不要对已在 `edges[]` 中闭合的函数重复全仓 `rg` 搜索。

## 2. 标准调用方式与参数速查

```bash
/opt/homebrew/bin/nn-code calls \
  --repo <repoPath> \
  --entry-file <repoRelativePath> \
  --entry-symbol <symbolName> \
  --max-depth <0|1|2|3> \
  --scope <prefix1,prefix2> \
  [--entry-lexical-path <outer.inner>] \
  [--language <typescript|ts|javascript|js>] \
  [--request-id <id>] \
  [--log-dir <dir>] \
  [--diagnostics-file <pathOutsideRepo>] \
  [--no-log] \
  [--verbose] \
  [--compact]
```

- **必填项**：
  - `--repo <path>`：目标仓库根目录（只读打开，零写入）。
  - `--entry-file <repoRelativePath>`：相对于 `--repo` 的 POSIX 路径（如 `lib/cli-call-depth.ts`）。
  - `--entry-symbol <symbol>`：目标函数名；匿名默认导出填 `default`，具名默认导出用函数名（如 `export default function main()` 填 `main`）。
  - `--max-depth <0|1|2|3>`：向下追踪被调用方（`callee`）的最大跳数（`0` 仅定位入口声明跨度；`1..3` 展开静态可解析被调函数）。
  - `--scope <prefix>`：允许解析与跨文件追踪的相对路径前缀（如 `lib` 或 `src/core,src/utils`）。
  - `--language <typescript|ts|javascript|js>`（可选）：显式指定源语言；省略时按入口文件扩展名选 TS/JS 解析器，不做自动全仓语言检测。`rust|rs|cpp|kotlin|kt|java|swift` 合法但 `calls` 当前返回 `UNSUPPORTED_LANGUAGE` 并附真实文本扫描，需符号表时改用 `nn-code symbols`。
  - `--verbose`（可选）：输出完整结构化关系 JSON 与覆盖证据；`--compact`（可选）：单行 JSON。
- **退出码与输出读取**：
  - `0` (`achieved`)、`2` (`unmet`)、`3` (`unknown`)、`4` (`rejected`)、`5` (`failed`) **均在 `stdout` 输出合法结构化 JSON**（非零 `2/3/4/5` 是结构化语义结论，不是 CLI 崩溃！仅退出码 `1` 表示参数或运行异常并在 `stderr` 输出 `{"error":{...}}`）。
  - 日志默认开启：每次运行在 `~/.local/state/nn-code/runs/`（env `NN_CODE_LOG_DIR` 可覆盖，`--log-dir` 改变目录）写单次 JSONL 运行日志，按每 root 10 GB 容量上限按最旧已完成记录轮转并保护活动记录；返回 JSON 顶层 `logging` 字段为 `{enabled, state, runLogPath, reason}`，`runLogPath` 回显完整路径。`--no-log` 关闭本次持久日志（不建目录/文件、不轮转）；`--diagnostics-file` 另存 opt-in 深度诊断。
  - 若输出较大，可将 `stdout` 重定向至临时文件并用 `jq '{status, resolution, runLogPath, logging: {state: .logging.state, reason: .logging.reason}, nodes: (.nodes|length), edges: (.edges|length), unresolved: (.unresolvedCallsites|length)}'` 查看摘要；`logging.state != "complete"` 时读 `logging.reason`（如 `LOG_CAPACITY_EXCEEDED`、`LOG_STORE_BUSY`）区分日志是否完整落盘。
  - 运行日志实际为 `.jsonl`；`runLogPath` 指向该 `.jsonl` 文件。

### `nn-code symbols`（Rust/Kotlin/Java/TS-JS/Swift 独立符号表）

需要 Rust/Kotlin 源码的声明、位置、词法归属与覆盖状态而非调用关系图时，用：

```bash
/opt/homebrew/bin/nn-code symbols \
  --repo <repoPath> \
  --language <rust|rs|kotlin|kt|java|typescript|ts|javascript|js|swift> \
  --scope <prefix1,prefix2> \
  [--symbol <name>] \
  [--file <repoRelativePath>] \
  [--edition <2015|2018|2021|2024>] \
  [--ignore-policy <no_ignore>] \
  [--log-dir <dir>] \
  [--no-log] \
  [--compact]
```

- 输出为单个 `nnanything.cli-symbols.result.v1` JSON 对象。`symbols[]` 每条含 `name`、`kind`、`declSpan`、`lexicalScope`、`visibility`、`parseStatus`、`nameSpan` 与覆盖状态；`coverage` 记录发现/解析文件、`partial`、`truncated`、`skipped` 与 `partialReasons`。
- 结果只代表 AST 词法作用域：不读 `Cargo.toml`（`edition` 默认 2021）、不展开宏/`include!`、不做跨 crate 或类型推断，模块路径未解析为 `unknown`。`nameSpan` 在当前 `rustc -Z unpretty=ast-tree` 后端为 `null`，原因写 `nameSpanSource`。
- `--ignore-policy` 首版仅支持 `no_ignore`；`respect_vcs_ignore` 显式拒绝，不静默降级。Kotlin 需要 JDK 17 与四个 Kotlin compiler jars（环境变量 `NN_CODE_KOTLIN_JAVA_BIN` / `NN_CODE_KOTLIN_JARS`）；Java 需要 JDK 17 与 `node scripts/build-java-symbol-jvm.mjs` 预构建的 ExtractJavaSymbols driver；Swift 需要 `/usr/bin/swiftc`。
- 每次运行默认在 `~/.local/state/nn-code/runs/` 保存 JSONL 日志，顶层 `logging` 与 `runLogPath` 回显；`--no-log` 关闭本次日志，`--log-dir` 改变日志目录。

### `nn-code value-flow`（TS/JS 静态值流，may-provenance）

追踪变量/参数/返回值的跨函数来源或去向。返回静态 may-provenance 候选站点与边，不是确定性全边 oracle，未解析站点保留 unknown。

```bash
/opt/homebrew/bin/nn-code value-flow \
  --repo <repoPath> \
  --anchor-file <repoRelativePath> \
  --anchor-symbol <symbol> \
  [--direction <origin|sink>] \
  [--max-depth <0|1|2|3>] \
  [--scope <path[,path]>] \
  [--result-mode <all|one>] \
  [--no-log] \
  [--run-log-path <path>]
```

`--repo` 是主参数，`--root` 作为别名；`--anchor-file` 为含锚点的相对路径，`--anchor-symbol` 为要追踪的符号或参数名；`--direction origin` 向下溯源，`sink` 向下流向；`--scope` 限定文件范围；`--result-mode one` 在遍历中取首条路径，`all` 遍历全部候选。运行日志默认落盘在系统临时目录 `$TMPDIR/nn-code-value-flow/`（已登记与 calls 默认 run 目录不一致的缺口 ccc3d81，修复前以实际回执路径为准），`--run-log-path` 显式改路径，`--no-log` 关闭本次日志；`one` 与 `all` 的多路径输出裁剪差异另登记 f9d9fbc 待修，当前不依赖 `one` 裁剪输出。

## 3. 预期静态边界（非 Bug）vs 触发 `reportbug` 的真实问题

| 类别 | 具体现象 | 判定结论与动作 |
| --- | --- | --- |
| **预期边界（非 Bug）** | 对象方法/属性调用（`obj.fn()`）、形参或普通局部变量调用报 `unresolved_dynamic` (`LEXICAL_PARAM_OR_VARIABLE_CALL`) | **正常静态边界，不报 Bug**；按需用 `sed` 读 `callsiteSpan` 附近源码即可 |
| **预期边界（非 Bug）** | `import * as ns` 成员调用（如 `ts.isIdentifier(...)`）报 `unresolved_dynamic` (`NAMESPACE_MEMBER_ACCESS`) | **正常静态边界，不报 Bug** |
| **预期边界（非 Bug）** | `node:*`、第三方包、超出 `--scope` 的模块或内置全局（`Object.freeze` 等）报 `out_of_scope_external` | **正常静态边界，不报 Bug** |
| **预期边界（非 Bug）** | `minDepth === requestedMaxDepth` 的前沿节点 `bodyExtracted: false` | **正常深度截断合同，不报 Bug** |
| **预期边界（非 Bug）** | 传入不存在的入口文件/符号返回 `exit 2` (`status: "unmet"`)，或入口在 `--scope` 外返回 `exit 4` (`status: "rejected"`) | **正常语义拒绝，不报 Bug** |

CommonJS 字面量 `const { fn } = require('./mod')`、别名、命名导出、`module.exports` 可调用导出，以及同一 `const ns = require(...)` 绑定的静态成员调用，已在当前安装版中按可证明关系解析，优先使用。`compound assignment`、`Object.assign`、跨过程副作用、别名传播和动态 `require` 的确定关系尚未验证：没有直接静态证据时不得生成确定边，agent 必须核查实际输出，不保证当前运行时一定把这类调用标为 unknown；真实缺口沿下方流程报告。该支持不等于完整 JavaScript 数据流。

| **真实 Bug（触发 `reportbug`）** | 合法参数且目标仓库可读时进程崩溃、`exit 1` 或无故返回 `status: "failed"` | **触发 `reportbug`** |
| **真实 Bug（触发 `reportbug`）** | `--scope` 内的同文件直接函数调用、ESModule 具名/默认导入函数调用或 `export *` 重导出函数调用被漏报、错连，或 `declSpan`/`callsiteSpan` 行列号与源码实际位置不符 | **触发 `reportbug`** |
| **真实 Bug（触发 `reportbug`）** | 词法绑定或 AST 提取缺陷：如局部解构变量调用 `const { handle } = opened; handle.read()` 被误判为 `UNBOUND_FREE_IDENTIFIER`（当前安装版 v0.0.0 已修，正确分类为 `unresolved_dynamic / LEXICAL_PARAM_OR_VARIABLE_CALL`；`UNBOUND_FREE_IDENTIFIER` 仅适用于尚未修复的旧版本）；或链式调用 `a().b()` 漏提内层 `CallExpression` `a()`；或标准内置全局函数（如 `BigInt`）被误判为 `UNBOUND_FREE_IDENTIFIER` | **触发 `reportbug`** |
| **真实 Bug（触发 `reportbug`）** | 静态未修改且 `< 1 MiB` 的源码文件误报 `truncated: true` 或 `sourceConsistencyFailed: true` | **触发 `reportbug`** |

## 4. `reportbug` 固定证据落盘与 Collab 投递 `NNAnything.Bob` 流程

检测到上表中的真实 Bug、阻断实际任务的能力缺口，或收到明确的 `reportbug` 验收指令时执行以下步骤。能力缺口使用同一最小报告结构，在标题/actual中注明 `[capability-gap]`，不冒称运行崩溃或已有支持回归。正常查询不发送消息，不推送完整运行日志，也不在本地调用 `appsdk bug` 重复建账。

### 步骤 1：在本地生成脱敏后的最小 Bug 报告 JSON
在 `~/.local/state/nn-code/bug-reports/` 下写入 `bug-<YYYYMMDDTHHMMSSZ>-<shortId>.json`（调用参数先脱敏；缺失字段显式填 `"unknown"`，不编造；若为无实际 bug 时的链路验收测试，必须先与 `NNAnything.Bob` 协调并将 `reportMode` 设为 `"verification_test"`、标题加 `[TEST-VERIFY]`）：

```json
{
  "schema": "nnanything.nn-code.bug-report.v1",
  "reportId": "bug-20261101T023000Z-01",
  "reportMode": "live_bug",
  "createdAt": "2026-11-01T02:30:00.000Z",
  "cliVersion": "0.0.0",
  "runLogPath": "/Users/fanzhang/.local/state/nn-code/runs/<runId>.jsonl",
  "reproduction": {
    "command": "nn-code calls --repo /Volumes/extension/code/NNAnything --entry-file lib/adapters/cli/file-content.ts --entry-symbol readFileRange --max-depth 1 --scope lib",
    "repo": "/Volumes/extension/code/NNAnything",
    "entryFile": "lib/adapters/cli/file-content.ts",
    "entrySymbol": "readFileRange",
    "entryLexicalPath": "none",
    "maxDepth": 1,
    "scope": ["lib"]
  },
  "observed": {
    "exitCode": 0,
    "status": "achieved",
    "resolution": "complete",
    "minimalOutputExcerpt": {
      "callerId": "lib/adapters/cli/file-content.ts#readFileRange@166:1-198:2",
      "calleeExpr": "handle.read",
      "callsiteSpan": { "startLine": 188, "startColumn": 33, "endLine": 188, "endColumn": 44 },
      "kind": "unresolved_missing_or_ambiguous_target",
      "reasonCode": "LEXICAL_PARAM_OR_VARIABLE_CALL"
    }
  },
  "expected": "handle is bound via local object destructuring `const { handle, after } = opened;` at line 180; `handle.read` should be classified as kind: \"unresolved_dynamic\", reasonCode: \"LEXICAL_PARAM_OR_VARIABLE_CALL\" (and inner `handle.close()` at line 196 should be extracted).",
  "actual": "`handle.read` at line 188 is classified as `unresolved_dynamic / LEXICAL_PARAM_OR_VARIABLE_CALL` in current installed v0.0.0 (fixed); this sample is retained for historical reproduction only and must NOT be treated as an unfixed bug.",
  "sourceEvidence": {
    "filePath": "lib/adapters/cli/file-content.ts",
    "lineRange": "180-197",
    "note": "line 180 `const { handle, after } = opened;`, line 188 `await handle.read(...)`, line 196 `await handle.close().catch(...)`"
  },
  "collabDelivery": {
    "targetPeer": "NNAnything.Bob",
    "deliveryState": "pending",
    "msg_id": null,
    "durable": null,
    "notification": null,
    "consumed": null,
    "task_id": null,
    "rawReceipt": ""
  }
}
```

### 步骤 2：预先选择正式 Collab 投递路径投递给 `NNAnything.Bob`
- **路径预选原则（严禁鉴权失败后切换匿名通道绕过）**：
  - 发送前根据当前调用者身份**预先选择**对应路径；
  - **`--unknown-sender` 匿名入口是供未注册外部 agent 预先选择的公开路径，绝不是已注册身份遭 `PERMISSION_DENIED` 后的重试绕过通道**。若已注册 peer 调用标准 `collab send` 遇到 `PERMISSION_DENIED` 或任何权限拒绝，必须立即停止并原样记录错误，严禁改用 `--unknown-sender` 重试绕过！
- **路径 A（未注册外部 agent、一次性 `codex exec` worker、跨项目 agent 预选公开路径）**：
  切换到 `NNAnything` 仓库目录执行 `collab send --unknown-sender`（不伪造已注册身份、不提升角色）：
  ```bash
  cd /Volumes/extension/code/NNAnything && \
    ~/.cargo/bin/collab send --unknown-sender \
      --to 'NNAnything.Bob' \
      --subject '[nn-code][bug] <简短问题摘要>' \
      "Bug report file: ~/.local/state/nn-code/bug-reports/<file>.json
  $(cat ~/.local/state/nn-code/bug-reports/<file>.json)"
  ```
- **路径 B（当前会话已是 `NNAnything` 注册 peer 预选路径）**：
  必须先在 `NNAnything` 仓库目录（`/Volumes/extension/code/NNAnything`）执行，否则 `collab send` 报 `no registered Collab route contains cwd`。推荐新参数形式 `--content <正文>`（`--subject` 可省略、由正文首行派生）；legacy 位置参数仍可用：
  ```bash
  cd /Volumes/extension/code/NNAnything
  ~/.cargo/bin/collab send \
    --to 'NNAnything.Bob' \
    --subject '[nn-code][bug] <简短问题摘要>' \
    --content "Bug report file: ~/.local/state/nn-code/bug-reports/<file>.json
$(cat ~/.local/state/nn-code/bug-reports/<file>.json)"
  # legacy 位置参数（仍可用，注意无 --topic）：
  ~/.cargo/bin/collab send --to 'NNAnything.Bob' --subject '...' \
    "Bug report file: ... $(cat ~/.local/state/nn-code/bug-reports/<file>.json)"
  ```

### 步骤 3：按真实回执字段 `durable=true` 与 `msg_id` 回写状态并遵守边界
- **真实回执字段映射**：`collab send` 的真实返回字段为 `msg_id`、`durable`、`notification`、`consumed`、`task_id`（可为 null；不是 `message_id`）。
- **持久入队判定（`enqueued_durable`）**：仅当回执同时满足 **`durable === true` 且 `msg_id` 为非空字符串**时，才可判定为持久入队成功（不能只凭存在 ID 推断持久入队！）。此时将 `msg_id` 同步写入 `collabDelivery.msg_id`，同时原样记录 `durable`、`notification`、`consumed`、`task_id` 与 `rawReceipt`（`deliveryState: "enqueued_durable"`）。
- **严禁重复催发与严禁冒称已消费**：只要 `durable === true` 且返回非空 `msg_id`，即代表消息已持久入队（即使 `notification` 含唤醒提示或 `consumed === false`，也不代表投递失败，绝不重发）。同时，在收到 `NNAnything.Bob` 的消费处理回执前，绝不把 `enqueued_durable` 冒称为“`NNAnything.Bob` 已消费登记”。
- **错误处理**：若 `durable !== true`、`msg_id` 缺失，或因沙箱/权限错误导致 `collab send` 失败，将真实回执与原始错误写入 `collabDelivery`（`deliveryState: "failed_local_only"`），保留本地报告文件并向调用方如实报告该本地路径与原始错误，**严禁换通道绕过或重启全局 daemon**。
