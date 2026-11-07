# NN Code TS/JS legacy regression checklist

状态：2026-11-06 只读回归准备清单。基线 `eba211e`。旧 `nn-code` 仅作 teacher、oracle、
样本来源和对照材料，不恢复产品接线，不安装全局 runtime，不改权重、gold、threshold、
采用状态或正式交付。

## 1. 对照入口

旧能力文档中的命令形状为：

```sh
nn-code symbols --repo <repo> --language <rust|kotlin|java|typescript|ts|javascript|js|swift> --scope <prefix>
nn-code calls --repo <repo> --entry-file <relative-file> --entry-symbol <symbol> --max-depth <0|1|2|3> --scope <prefix>
nn-code value-flow --repo <path> --anchor-file <path> --anchor-symbol <name> [options]
```

当前环境没有 `/opt/homebrew/bin/nn-code`，`command -v nn-code` 无输出。禁止为此重装或
恢复全局产品入口。源码级只读对照使用仓库内编译入口：

```sh
node dist/cli-call-depth-bin.js calls ...
node dist/cli-value-flow.js ...
```

`symbols` 的公开实现位于 `lib/cli-symbols.ts`，可直接通过
`runCliSymbols(argv, options)` 调用；它不提供独立 `dist/cli-symbols-bin.js`。

## 2. symbols 回归项

真实命令：

```sh
node --input-type=module -e '
import { runCliSymbols } from "./dist/cli-symbols.js";
await runCliSymbols([
  "--repo", "<repo>",
  "--language", "typescript",
  "--scope", "<scope>",
  "--compact",
  "--no-log",
]);
'
```

期望事实：

- stdout 为单个 `nnanything.cli-symbols.result.v1` JSON object。
- 成功 exit 0；runtime/error exit 1；请求拒绝 exit 4。
- symbol 只来自当前 scope 的显式 source files。
- `parser.semanticBinding=false` 必须保留。
- `typeCheckerSemanticBinding`、dynamic member、CommonJS dynamic require、re-export target
  resolution 等未求解边界必须保持 `unknown/not_resolved`。
- parse error、partial coverage、scope skip 和 symlink skip 保留为事实，不能当成功符号。

本次只读 smoke：

```sh
node --input-type=module -e '... runCliSymbols([... "--symbol", "scaleBy", "--compact", "--no-log"])'
```

exit 0，返回 `scaleBy`、`semanticBinding=false`、`typeCheckerSemanticBinding=not_resolved`
和完整 scope coverage。

回归测试：

```sh
node --test tests/tsjs-symbol-table.test.mjs
```

exit 0，13/13 通过；覆盖 TypeScript/JavaScript kinds、CJS/ESM、syntax error recovery、
deep expression、CJS shadowing、dynamic computed boundary、Unicode column 和 symlink skip。

## 3. calls 回归项

真实命令：

```sh
node dist/cli-call-depth-bin.js calls \
  --repo <repo> \
  --entry-file <relative-file> \
  --entry-symbol <symbol> \
  --max-depth <0|1|2|3> \
  --scope <prefix> \
  --language <typescript|ts|javascript|js|rust> \
  --compact \
  --no-log
```

期望事实：

- 成功调用图返回 structured nodes、edges 和 coverage。
- unresolved callsite 保留为 unknown 和 callsite evidence，不能写成 other binding。
- 语言不匹配、entry file unsupported 和 missing anchor 返回结构化 unknown，不返回伪造
  call edge。
- `--language typescript` 和 `--language ts` 路由为 TypeScript；`javascript/js` 只能按
  alias 接受，不得声称存在独立 JavaScript parser backend。
- public Rust caller 不执行 repository build code。

本次只读 smoke：

```sh
node dist/cli-call-depth-bin.js calls \
  --repo tests/fixtures/rust-calls/RS_POS_1 \
  --entry-file src/lib.rs \
  --entry-symbol execute \
  --max-depth 1 \
  --scope src \
  --language rust \
  --compact \
  --no-log
```

exit 0，返回 `status=achieved`、`resolution=complete`、`actualParser=rust` 和一条
`execute -> compute_step` 的 resolved edge。

另一次只读 smoke 对 unsupported file 返回 `status=unknown`、
`resolution=FILE_TYPE_UNSUPPORTED`、无 nodes/edges，exit 3。失败事实被保留，没有伪造
成功。

回归测试：

```sh
node --test tests/cli-language-a.test.mjs
```

exit 0，18/18 通过；覆盖 TypeScript/JavaScript/Rust 路由、language mismatch、text
candidate coverage、unresolved callsite evidence、same-name non-definition 和 read-only
boundary。

## 4. value-flow 回归项

真实命令：

```sh
node dist/cli-value-flow.js \
  --repo <repo> \
  --anchor-file <relative-file> \
  --anchor-symbol <name> \
  --direction origin \
  --max-depth <0|1|2|3> \
  --scope <prefix> \
  --result-mode <all|one> \
  --no-log
```

期望事实：

- exit 0 表示 achieved；
- exit 2 表示 unknown 或 insufficient evidence；
- exit 1 表示 unmet、invalid request 或 execution error。
- flow-sensitive kill、branch join、loop fixpoint、shadowing、import alias、re-export 和
  cross-file caller coverage 保留各自 typed evidence。
- stack overflow 或 parse limit 保留为 structured unknown，不能变 false。

本次只读 smoke：

```sh
node dist/cli-value-flow.js \
  --repo tests/fixtures/rust-calls/RS_POS_1 \
  --anchor-file src/lib.rs \
  --anchor-symbol limit \
  --direction origin \
  --max-depth 1 \
  --scope src \
  --result-mode one \
  --no-log
```

exit 2，`status=unknown`、`resolution=insufficient_evidence`，保留 anchor site、search
receipt、root unsatisfied 和 aggregation error。该回执说明未知与失败没有被吞掉。

value-flow 完整测试包含一个 legacy L2 训练步骤，本准备任务不运行该训练步骤。其它
value-flow 回归命令应在不启动 fit 的前提下按 Jenny 的后续派单执行。

## 5. 失败和 unknown 保留方式

旧入口回归只比较可观察事实。失败时按以下方式保留：

| 事实 | 保留方式 |
| --- | --- |
| parse/syntax boundary | parse error、partial coverage 或 typed boundary |
| unsupported language/file | structured unknown 与 reasonCode |
| missing anchor | unknown、null span、missing anchor evidence |
| unresolved callsite | unknown callsite 与 evidence refs |
| stack overflow/parse limit | structured unknown 与 `STACK_OVERFLOW_OR_PARSE_LIMIT` |
| value-flow insufficient evidence | exit 2，unsatisfied root 与 aggregation error |
| missing module | expected unknown、TS2307、execution/coverage gap |
| dynamic property conflict | expected unknown、corrected true、pending adjudication |

不得把 unknown 改成 other、false、zero gain 或 empty success。不得删除失败样本缩小分母。
不得用 teacher 修正覆盖学生原错。

## 6. candidate not_applied 检查

旧能力回归只读 candidate 状态，不触发采用：

```text
calibration = uncalibrated
adoption = not_applied
fullyVerified = false
```

当前记录的 CLI candidates：

```text
35bd5ad9-15dc-409e-9001-bcab24f75398
39f1570f-be11-48a4-94cb-3b071982922b
fb73d4a0-cb66-4008-afa0-5569b2cdfcdc
```

三个 candidate 全部保持未校准、未采用。历史外部有限套件通过 56/56 时仍有 5 项
`UNVERIFIED`，不能把该回执写成完整独立验收。旧 candidate、teacher 结果或 fixed
handwired result 不能作为 TS/JS 新学生能力成绩。

## 7. 当前回归准备状态

已完成：

- build exit 0；
- symbols API smoke exit 0；
- symbols regression exit 0，13/13；
- calls smoke exit 0；
- calls unsupported smoke exit 3，原因为 structured unknown；
- calls regression exit 0，18/18；
- value-flow smoke exit 2，原因为 structured insufficient evidence。

未完成：

- 全局 `nn-code` binary 不存在，不能执行全局 binary 对照；
- value-flow 完整测试中的 legacy L2 训练步骤未运行，避免超出本准备任务；
- 没有用未采用 candidate 运行正式 TS/JS rollout；
- 没有运行 fit、train 或 resume。

这些未完成项不改变候选的 `uncalibrated/not_applied` 状态。
