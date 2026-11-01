---
name: nn-code
description: 排查问题、审计流程或追踪 TypeScript/JavaScript 函数调用关系时，优先使用 nn-code 一次获取给定入口的被调用关系，减少模型逐层搜索的往返。处理未解析目标，并通过 Collab 报告错误或阻断实际任务的能力缺口。
---

# `nn-code`（`nn-code calls`）使用与问题反馈 Skill

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
  [--request-id <id>] \
  [--log-dir <dir>] \
  [--diagnostics-file <pathOutsideRepo>] \
  [--compact]
```

- **必填项**：
  - `--repo <path>`：目标仓库根目录（只读打开，零写入）。
  - `--entry-file <repoRelativePath>`：相对于 `--repo` 的 POSIX 路径（如 `lib/cli-call-depth.ts`）。
  - `--entry-symbol <symbol>`：目标函数名；匿名默认导出填 `default`，具名默认导出用函数名（如 `export default function main()` 填 `main`）。
  - `--max-depth <0|1|2|3>`：向下追踪被调用方（`callee`）的最大跳数（`0` 仅定位入口声明跨度；`1..3` 展开静态可解析被调函数）。
  - `--scope <prefix>`：允许解析与跨文件追踪的相对路径前缀（如 `lib` 或 `src/core,src/utils`）。
- **退出码与输出读取**：
  - `0` (`achieved`)、`2` (`unmet`)、`3` (`unknown`)、`4` (`rejected`)、`5` (`failed`) **均在 `stdout` 输出合法结构化 JSON**（非零 `2/3/4/5` 是结构化语义结论，不是 CLI 崩溃！仅退出码 `1` 表示参数或运行异常并在 `stderr` 输出 `{"error":{...}}`）。
  - 每次运行自动在 `~/.local/state/nn-code/runs/` 下保存单次运行日志，并在返回 JSON 顶层通过 `runLogPath` 字段回显完整路径。
  - 若输出较大，可将 `stdout` 重定向至临时文件并用 `jq '{status, resolution, runLogPath, nodes: (.nodes|length), edges: (.edges|length), unresolved: (.unresolvedCallsites|length)}'` 查看摘要。

## 3. 预期静态边界（非 Bug）vs 触发 `reportbug` 的真实问题

| 类别 | 具体现象 | 判定结论与动作 |
| --- | --- | --- |
| **预期边界（非 Bug）** | 对象方法/属性调用（`obj.fn()`）、形参或普通局部变量调用报 `unresolved_dynamic` (`LEXICAL_PARAM_OR_VARIABLE_CALL`) | **正常静态边界，不报 Bug**；按需用 `sed` 读 `callsiteSpan` 附近源码即可 |
| **预期边界（非 Bug）** | `import * as ns` 成员调用（如 `ts.isIdentifier(...)`）报 `unresolved_dynamic` (`NAMESPACE_MEMBER_ACCESS`) | **正常静态边界，不报 Bug** |
| **预期边界（非 Bug）** | `node:*`、第三方包、超出 `--scope` 的模块或内置全局（`Object.freeze` 等）报 `out_of_scope_external` | **正常静态边界，不报 Bug** |
| **预期边界（非 Bug）** | `minDepth === requestedMaxDepth` 的前沿节点 `bodyExtracted: false` | **正常深度截断合同，不报 Bug** |
| **预期边界（非 Bug）** | 传入不存在的入口文件/符号返回 `exit 2` (`status: "unmet"`)，或入口在 `--scope` 外返回 `exit 4` (`status: "rejected"`) | **正常语义拒绝，不报 Bug** |
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
  "runLogPath": "/Users/fanzhang/.local/state/nn-code/runs/<runId>.json",
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
