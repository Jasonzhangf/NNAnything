# CLI 只读组合主线 P1：能力盘点、受信范围读与最小组合合同

状态：2026-10-22 实施合同，2026-10-23 增加多来源设计。本文是 P1/P2 增量（盘点、受信范围读与只读组合公开入口）的唯一 owner；领域合同仍由 `cli-filesystem-semantics.md`、`cli-call-contract.md`、`cli-semantic-operations.md` 与 `cli-entry-search-design.md` 维护，本文不复制其表格。P2 公开入口 `nnanything/cli-read` 已实现并跑通 21 用例、公开 consumer 与独立家族；共享 `cli.command-policy.v1` 不增加 head/wire/权重。第 8 节多来源组合仍为设计，未实现、未验收，不改变单来源 7N6E 图与既有 consumer/家族。

## 1. 实测能力盘点

盘点以实际源码与公开入口为准，不按文件存在判断可调用。共享 `cli.command-policy.v1` 保持 10 head × 30 wire = 300 参数，候选 `35bd5ad9-15dc-409e-9001-bcab24f75398` 保持 `uncalibrated/not_applied`；本增量不增加 head、wire、权重，不重训。

### 1.1 policy 已注册 head

| head / 语义调用 | I/O | 真实观测来源 | 授权 | 公开 consumer |
| :--- | :--- | :--- | :--- | :--- |
| `unsupported` / `DEFER` / `NOOP` | 控制结果，零调用 | 无 OS | 无需 effect | `nnanything/cli-goal` `createCliCommandPolicy().step` |
| `pwd` / `cwd.get` | session → cwd 观测 | `/bin/pwd -P` | `filesystem.read` + `process.exec` | `createCliCommandPolicy().step`；`sandbox.execute` |
| `cd` / `cwd.set` | session + directory → cwd.set | 固定 `/bin/zsh` cd 脚本 + `/bin/pwd -P` | `filesystem.read` + `process.exec` + `session.write` | 同上 |
| `ls` / `directory.list` | session + directory → 直接子项列表 | 固定编译 helper（readdir+lstat） | `filesystem.read` + `process.exec` | 同上；`nnanything/cli-search` 复用 |
| `path.resolve` / `path.relative` / `path.parts` | 明确路径 → 词法路径结果 | 无 OS，纯词法 | 无 effect | `createCliCommandPolicy().step`；`sandbox.execute` |
| `entry.inspect` | E/D/F/P → 完整属性快照 | 固定 helper（lstat/stat/readlink） | `filesystem.read` + `process.exec` | 同上；`nnanything/cli-search` 复用 |

### 1.2 独立函数与受信原语（有实现与单测，接不接 authority harness 分别列出）

| 函数 | I/O | 真实观测来源 | 授权 | 公开 consumer |
| :--- | :--- | :--- | :--- | :--- |
| `readFileRange`（`lib/adapters/cli/file-content.ts`） | absolutePath, offset, length → bytes(base64)/size/bytesRead/eof/identity | `lstat` + `open(O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK)` + handle `fstat` | 函数本身无授权，调用方负责 | `nnanything/cli` `createCliSession().observe({kind:"read",...})`（按路径读，无受信引用/无 revision）；P1 起也是 `file.read` 的安全打开策略 |
| `file.read`（`lib/adapters/cli/filesystem-sandbox.ts`） | observed `cli.file` ref + offset + length → bytes(base64)/size/bytesRead/eof/identity | 受信 ref 复验 + 同一安全打开策略 | `filesystem.read`；不需要 `process.exec` | `nnanything/cli-goal` 与 `nnanything/cli-search` 导出的 `sandbox.execute`；无 policy head；作为根组合的 read 原子由 `nnanything/cli-read` 公开入口消费 |
| `observeContentFormat` / `detectSignature` / `decodeUtf8`（`lib/filters/cli-content.ts`） | bytes+complete → 签名/UTF-8/JSON 判断 | 无 OS，纯确定性 | 无 | 无包导出、无公开 consumer、未接 sandbox；仅 `tests/cli-content-format.test.mjs` 6/6 |
| `readDeclaredReferences`（`lib/filters/cli-declaration.ts`） | manifest path+bytes+complete+field+scope → 声明引用 | 无 OS，纯确定性 | 无 | 无包导出、无公开 consumer；仅 `tests/cli-declaration.test.mjs` 9/9 |
| `readEntrySnapshot` / `collectDirectoryListing` | 见 `entry-inspection.ts` / `directory-listing.ts` | 真实 `lstat`/`readdir` | 由 sandbox 授权 | 被 sandbox `entry.inspect` / `directory.list` 使用，属已接能力，不是仅单测 |

`readFileRange` 的旧公开路径是 `nnanything/cli` 的按路径 `observe({kind:"read"})`，它不查 `boundRefs`、不查 session revision，不能当受信组合能力。P1 只复用它的安全打开策略，不改旧路径语义；新增 `identity` 字段为向后兼容扩展。

### 1.3 仅合同/设计，无运行入口

| 合同项 | I/O | 真实观测来源 | 授权 | 公开 consumer |
| :--- | :--- | :--- | :--- | :--- |
| `file.property.content.format` | 无可调用 I/O；合同只定义 format 属性与显式 parser 边界 | 无运行观测路径 | 无 | 无 |
| `file.property.role` | 无可调用 I/O；合同只定义 role/scope 关系与独立模型边界 | 无运行观测路径 | 无 | 无 |
| `file.property.links` | 无可调用 I/O；合同只定义硬链接关系缺口 | 无运行观测路径 | 无 | 无 |
| `file.property.path.physical` | 无可调用 I/O；合同只保留 realpath 缺口 | 无运行观测路径 | 无 | 无 |
| `file.property.operation.applicability` | 无可调用 I/O；合同只定义适用性知识 | 无运行观测路径 | 无 | 无 |
| 写操作（`file.replace/write/append/truncate/copy`、`mkdir/remove/move`、`mode/owner/times` set） | 无可调用 I/O；操作目录仍为设计 | 无运行观测路径 | 无 | 无；本增量不扩写操作或提权 |

### 1.4 与 lead 盘点的差异

- lead 记录的“sandbox 无 `file.read` 操作”在 P1 实现前准确；P1 后新增受信 `file.read` 语义调用，共享 policy 仍无 content head。P2 完成 `nnanything/cli-read` 根组合公开入口；这是增量状态变化，不是对原先测量的纠正。
- lead 已确认 `readFileRange` 只有 `nnanything/cli` 按路径入口；P1 后它同时成为 `file.read` 的安全打开原语，并增加向后兼容的 identity 字段。
- 其余 head 顺序、30 wire、300 参数、`observeContentFormat`/`readDeclaredReferences` 无包导出、`readEntrySnapshot`/`collectDirectoryListing` 已接 sandbox，均与源码一致，无纠正。

## 2. 受信范围读合同 `file.read`

语义调用（严格 exactKeys）：

```ts
type FileReadCall = {
  operation: "file.read";
  parameters: { ref: ObservedObjectRef; offset: number; length: number };
};
```

- `ref` 必须是本 sandbox 签发且登记于 `boundRefs` 的观测引用：`kind === "cli.file"` 且 `type === "regular"`。
- `offset`、`length` 是非负安全整数；`length === 0` 合法。
- 只需要 `filesystem.read` effect，不需要 `process.exec`。
- 非法 schema、额外字段、坏 ref、非法 offset/length 直接抛 `TypeError`，零 OS 副作用。

执行顺序与失败边界：

1. `sameSession` 校验 scenario/session 一致；不一致返回 `EINVAL`，`executorInvoked:false`。
2. `filesystem.read` effect 校验；缺失返回 `EFFECT_DENIED`，`executorInvoked:false`。
3. `ref.kind === "cli.file"` 且 `ref.type === "regular"`；否则返回 `NOT_REGULAR_FILE`，`executorInvoked:false`。
4. `physicalEntryCandidate` 做场景内路径边界检查；随后 `readEntrySnapshot(..., false)` 取得当前快照。
5. 复用 `validateObservedRef`：boundRefs 登记与精确相等（sourceRun/scenario/session/type/identity/revision/absolutePath）、当前 session revision、entryExists、kind/type、dev/ino。任一步失败返回对应错误（`binding_identity_missing`、`STALE_REFERENCE`、`ENOENT` 等），`executorInvoked:false`，不打开文件。
6. 调用 `readFileRange`：pre-open lstat、`open(O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`、handle `fstat` regular、post-open dev/ino 与 pre-open 比较。
7. 把 post-open dev/ino 与受信 ref 的 dev/ino 再比较；不一致返回 `STALE_REFERENCE`，不返回字节。这一步覆盖「inspect 之后、read 打开之前」同路径换 inode 的竞态。

返回 observation：

```ts
{
  kind: "file.read",
  ref, absolutePath, offset, length, size,
  bytes /* base64 */, bytesRead, eof,
  identity: { dev, ino } /* post-open */
}
```

回执形状与既有 `SemanticCallReceipt` 一致：`status`、`session_before`、`session_after`、`execution{status, runId, executorInvoked, observation|error}`。

边界语义：

- 零长度合法，仍通过 open + 身份核对；零长度不声称 EOF（`eof:false`）。
- 短读：`bytesRead < length`、`eof:true`，不冒充完整；二进制用 base64 保真，不解码、不 trim。
- symlink / FIFO / socket / 设备均拒绝：它们无法成为受信 `cli.file` 引用，`readFileRange` 的类型检查也拒绝非 regular；`bindFile` 对非 regular 返回 `NOT_REGULAR_FILE`。
- errno 保真：真实读取失败（如 `EACCES`）返回 failed，`executorInvoked:true`，保留真实 errno。
- `file.read` 不改变 session revision 或 cwd；旧 revision 引用在 session 推进后返回 `STALE_REFERENCE`。

## 3. 根目标最小组合合同 `file.property.content.bytes`

### 3.1 typed schema

```ts
type ContentBytesGoal = {
  kind: "file.property";
  property: "file.property.content.bytes";
  target: {
    kind: "cli.exact-child";
    directory: TrustedDirectoryRef;  // 受信目录引用，必须是本 sandbox 签发
    name: string;                    // 严格单个名称段
    requiredType: "regular";         // 要求类型，不是已观测真值
  };
  requirement: {
    kind: "equals";
    range: { offset: number; length: number };
    expectedBase64: string;          // 规范 base64
  };
  satisfactionThreshold: 100;
};
```

`name` 是单个非空名称段，拒绝 NUL、`/`、`.`、`..`，不 trim、不展开 glob/变量、不做大小写或 Unicode 折叠。`directory` 必须是受信目录引用：由 `sandbox.bindDirectoryObject` 签发的观测 `cli.directory`，或由 `sandbox.bindDirectory` 在当前 session revision 签发的目录引用。请求解析只校验引用形状；adapter 在列举前复核签发真源与当前 session revision，手工构造、未签发或旧 revision 的普通 path 引用直接拒绝，零 list/inspect/read、零 open。不接受 `DirectoryQuery`、不扫描磁盘。

### 3.2 子步角色

- `list`（`directory.list`）：只列举显式目录的直接子项，coverage 必须 complete；partial 一律 `insufficient_evidence`，不继续 inspect。不递归，不解析人类 ls 文本。
- `inspect`（`entry.inspect`）：对精确同名候选核验当前类型与 dev/ino，签发受信 `cli.file` 引用；名称匹配不等于类型匹配，路径不等于对象身份。symlink 不跟随。
- `read`（`file.read`）：受信引用 + 明确范围读取；读成功不等于根满足，短读/errno 保留真实事实。
- 根评价：对 list/inspect/read 真实结果执行 equals 谓词；名称、归属、类型、身份、范围、字节全满足才 100。纯评价零 IO，子 Goal 全绿不等于根 achieved。

### 3.3 根决策矩阵

| 条件 | 根 status | satisfaction | resolution |
| :--- | :--- | :--- | :--- |
| 完整列表精确命中 + regular + 当前受信引用 + 精确字节 equals 且 `bytesRead === length` | achieved | 100 | matched |
| 完整列表无精确名称 | unmet | 0 | not_found |
| 同名项当前类型非 regular（含 symlink，不跟随） | unmet | 0 | type_mismatch |
| 读完整长度但字节与 expected 不符 | unmet | 0 | byte_mismatch |
| 列表 partial / 短读或 EOF 未覆盖完整范围 / 缺类型或身份 / 观察不足 | unknown | null | insufficient_evidence |
| 引用/身份/revision/postcondition 过期，或读取前对象替换 | unknown | null | stale_or_unverified |
| 缺 effect、类型/范围/绑定拒绝、伪造引用 | rejected | null | rejected |
| helper/protocol/策略错误或必需操作真实失败 | failed | null | failed |
| budget/cancel/stalled 提前停止且根无真实判定 | unknown | null | interrupted |

0 与 100 是二元目标的全部合法 satisfaction；null 表示证据不足。短读不冒充 `byte_mismatch`，也绝不产生部分满足分数。achieved/100 与 unmet/0 都必须同时具备已完成且结果一致的根评价；只有 read 回执成功、控制器在根评价完成前 budget/cancel/stalled 停止时，一律保持 unknown/null。

## 4. 有限组合边界

本切片只声明支持 `directory.list`、`entry.inspect`、`file.read` 及既有 path/cwd 原语，并按上述顺序组合。准确 unsupported：

- 任意 shell 管道、重定向（`>`、`<`、`>>`）、命令替换（`$(...)`、反引号）。
- 通配/glob（`*`、`?`、`[...]`）。
- 未知 CLI 命令、help/`--help` 学习。
- 自然语言请求、名称近似/大小写折叠、隐式目录扫描、递归搜索。
- 写操作、删除、创建、提权、realpath/links/role/content.format 判断。

不实现写操作或提权；有限组合不能解释的请求准确拒绝或标未就绪，不暗中扩成通用 shell。

## 5. 准确限制

- S06 部分完成：8 类类型联合保留，但 `character_device`、`block_device`、`other` 的真实 fixture 未验证。
- 五项 UNVERIFIED 保留：character_device fixture、block_device fixture、other 类型 fixture、synthetic dev/ino 注入、syscall 零 I/O 追踪。
- Linux 限制：本机 macOS/POSIX 验证 `O_NOFOLLOW`/`O_NONBLOCK`；无 Linux 运行环境，不推断 Linux 设备/FIFO/socket 行为，不提供 mount/ACL/xattr。
- 读出字节不等于根满足：还必须名称、归属、类型、身份、范围、当前证据全部成立。
- 不定义部分满足尺度，不造进度分；根 satisfaction 只取 0/100/null。
- `file.read` 不增加 policy head，不训练，不改共享 `cli.command-policy.v1` 或权重；根组合入口属 P2，现已实现。

## 6. P1 证据

- 实现：`lib/adapters/cli/filesystem-sandbox.ts`（`file.read` 语义调用与 `executeFileRead`）、`lib/adapters/cli/file-content.ts`（`FileReadRange.identity` 扩展）。
- 红测日志：外置 run `logs/p1-red.log`。
- 新测试：`tests/cli-file-read-sandbox.test.mjs`，11 个具名测试。
- 责任图：`workflows/cli-read-composition.graph.json`，`dagpipe graph validate` 通过（7 节点 6 边 7 波）。

## 7. P2 公开组合入口

### 7.1 入口与资源信封

公开入口是 `nnanything/cli-read` 的 `runCliReadCompositionGoal(request, resources)`。resources 显式包含：

- `sandbox`：`createCliFilesystemSandbox` 创建、已授予 `filesystem.write` 的沙箱；
- `session`：`bindSession` 绑定的会话；
- `profile`：`cli.command-policy.v1` 候选 JSON（未采用，仅选择 ls/entry.inspect）；
- `limits`：实测必需 `{ maxTransitions: 23, maxDepth: 4, maxDerivedGoals: 8 }`；`maxTransitions` 低于 23 会在根评价完成前 `budget_exceeded`，投影为 `unknown/interrupted/null` 并保留已形成的 read 事实，不再投影 achieved；
- 可选 `onSample` 与 `signal`。

rootBindings 只携带普通 JSON 值（session ref、directory ref、name、requiredType、range、expectedBase64），不携带 Buffer 或非 JSON 对象。共享 policy 不新增 head，`file.read` 原子结果没有 `selectedHead`。

### 7.2 实现与验收

- 实现：`lib/cli-read.ts`、`lib/adapters/cli/read-composition-recursive.ts`、`lib/filters/cli-read-composition.ts`、`lib/adapters/cli/read-composition-contract.ts`。
- 责任图：`workflows/cli-read-composition.graph.json`。
- 用例：`tests/cli-read-composition.test.mjs` 21/21 通过（R01–R05、S-React-1–5、R09–R19；编号沿用当前运行切片）。
- 公开 consumer：`playground/cli/read-composition/consumer.mjs`，逐例 JSON + `exitCode: 0`，覆盖 matched / not_found / type_mismatch / byte_mismatch / zero-length / short-read / stale_or_unverified；独立家族 `playground/cli/read-composition/independent-family.mjs` 27/27，`exitCode: 0`。
- 组合状态：`file.property.content.bytes` 现在有运行入口；`content.format`、`role`、`links`、`path.physical`、`operation.applicability` 与写操作仍为设计，不因 P2 冒称完成。

## 8. 多合法候选只读组合（设计）

状态：本节的请求形状、状态、排序接缝、回退依据与根判定均为设计，未实现、未训练、未验收。单来源 `cli.exact-child` 合同与实现保持不变。排序复用 `goal-selection-policy.md` 与 `bounded-planning-decision.md`，失败恢复语义复用 `bounded-goal-planning.md` 第 9 节；本节不复制其正文。

### 8.1 目标与四元素

Goal：同一根 `file.property.content.bytes` 目标下，存在两个已授权、受信的目录来源（同名、同类型、同范围、同期望字节），任一来源完整满足即根达成。

| 元素 | 内容 |
| :--- | :--- |
| Goal | 两个已授权受信目录来源中任一来源满足 `file.property.content.bytes`；同名、regular、同 range、同 `expectedBase64` |
| satisfactionThreshold | 固定 100；不定义部分满足尺度 |
| State | `sources[]` 每来源独立携带 `listing/candidate/inspected/fileRef/read/attempt/negative`，加 `decision` 排序决策记录与既有 session/cli/root 字段 |
| Action | 只选 `directory.list`、`entry.inspect`、`file.read` 及纯决策/评价；无写操作 |

每个来源的 `attempt` 取 `not_attempted|in_progress|matched|definitive_negative|unknown`，`negative` 取 `not_found|type_mismatch|byte_mismatch|null`。`decision` 记录 `bindingRef`、`ranked|defer`、`order`、`chosen`、`missingKeys` 与 `reason`。根评价只消费真实回执，不把子步成功、排序结果或预测写成根达成。

### 8.2 请求形状与责任图

```ts
type MultiSourceContentBytesGoal = {
  kind: "file.property";
  property: "file.property.content.bytes";
  target: {
    kind: "cli.exact-child-sources";
    sources: [
      { directory: TrustedDirectoryRef; order?: number },
      { directory: TrustedDirectoryRef; order?: number }
    ]; // 恰好 2 个
    name: string;
    requiredType: "regular";
  };
  requirement: { kind: "equals"; range: { offset: number; length: number }; expectedBase64: string };
  satisfactionThreshold: 100;
};
```

- `sources` 恰好 2 个；两个 `directory` 互不相同，且都是本 sandbox 当前 revision 签发/登记的受信目录引用。任一伪造、未签发或旧 revision 在执行前返回 `request_rejected`，零 list/inspect/read、零 open。
- `order` 可省略；两个都给出时必须互不相同，作为 `rankOrder`。名称、类型、范围与 `expectedBase64` 的校验沿第 3.1 节。
- 旧 `cli.exact-child` 形状与单来源行为不变。

责任图是 `workflows/cli-read-multi-source.graph.json`（`0.1.0-design`，10N10E，单入口单出口，9 波，无环无回边）。节点顺序为：校验来源引用→分别列举两个来源（两个独立真实 OS 节点）→合法候选集→排序决策→首选链→回退依据→次选链→根评价→汇总。两个列举节点并列分叉、在合法候选集汇合。次选链边写作普通弧，图本身不承载条件；本合同的语义是该链仅当 8.5 回退依据成立时执行。静态图通过只证明拓扑，不替代真实运行证据。

### 8.3 合法候选集

对每个来源，列举结果分三类：

| 列举事实 | 判定 |
| :--- | :--- |
| 完整列举且含精确名称 | 合法候选，进入候选集 |
| 完整列举且不含名称 | 确定否定 `not_found` |
| partial / 出错 | 未知，不进入候选集 |

合法候选集只含第一类且 `coverage` 为 covered。未知来源不补成否定，也不进入候选集；未被选中的否定或未知来源不产生失败义务。完整列举、精确名称与 coverage 的定义沿第 3.2 节与 `cli-entry-search-design.md`。

### 8.4 排序决策接缝

排序复用 `docs/goal-selection-policy.md` 的路径投影和 `docs/bounded-planning-decision.md` 的决策单元，不新增第二套选择器：

- 输入用 `PlanningDecisionInput`：每个合法候选一条 `{pathId, rankOrder, projection, attemptOrder}`，`projection = {terminalSatisfaction:null, riskLevels:[], maximumCost:2, costUnit:"step", unknownRefs:[], coverage:"covered"}`；`attemptOrder` 用该来源 inspect/read 的引用占位；`unknown` 收集 partial 来源引用；`priorInfluences` 保留但本次为空。
- `preference` 固定 `order_first`；默认绑定是 `createDefaultPlanningDecisionBinding()`，输出既有 `PathRanking = ranked|defer`。
- 只有一个合法候选时直接选它，不调用决策单元。
- 两个合法候选都缺 `order` 时返回 `defer`；其余缺键（如仅一个候选缺 `order`、coverage 未覆盖）或同分同样按既有 `rankPlanningPaths` 返回 `defer`。`defer` 时根保持 unknown，零 inspect/read，`missingKeys` 与原因写入决策记录。
- 显式提供 `decision` 资源时使用该 `PlanningDecisionBinding`；资源或 profile 损坏准确报错，不静默回退默认规则。

排序只决定合法候选的检查顺序，不改根、权限、预算、回退依据或重试控制。`ranked` 与 `defer` 是两个合法输出，`ranked` 不表示根达成。

### 8.5 回退依据

首选链结束后，同时满足下列全部条件才尝试次选（依据 `docs/bounded-goal-planning.md` 第 9 节）：

1. 根尚未满足（聚合事实不是 matched）；
2. 还有另一个合法候选未尝试；
3. 次选来源目录引用在当前 revision 重新校验通过，权限仍覆盖 `filesystem.read`，effects 未变；
4. 本次预算还剩至少一次 inspect+read；
5. 首选结束类别不是 `rejected`/`failed`/`interrupted`。

在该前提下：

- 首选为确定否定（`not_found`/`type_mismatch`/`byte_mismatch`）→ 尝试次选。
- 首选为未知（partial、短读、stale/替换）→ 也尝试次选；首选的未知事实保留，不被次选成功掩盖。
- 同一候选最多尝试一次，不自动重试，unknown effects 不重放。

失败事实、归因和路线限制仍由第 9 节及其 9.1 维护；本增量不进入有界规划模式，也不把一次失败写成全部转移不可用。

### 8.6 根判定矩阵

根是"任一来源满足"的存在性目标，聚合矩阵如下（与计划文档 4.6 一致）：

| 聚合事实 | status | resolution | satisfaction |
| :--- | :--- | :--- | :--- |
| 任一来源完成完整链：完整列举+精确同名+regular+受信引用+全范围读取+字节相等 | achieved | matched | 100 |
| 无 match；所有合法候选已尝试且均为确定否定；其余来源均为"完整列举且不含名称"；无未知来源 | unmet | byte_mismatch > type_mismatch > not_found | 0 |
| 无 match；存在未知来源（partial 列举、短读、stale/替换、unverified）或排序 defer | unknown | stale_or_unverified > insufficient_evidence | null |
| 任何来源引用伪造/未签发/旧 revision（执行前） | rejected | rejected | null |
| 真实执行失败（errno，如 EACCES） | failed | failed | null |
| 预算/取消在根评价完成前停止 | unknown | interrupted | null |

0 需要全部合法候选确定否定且无未知来源：未知来源不能补成否定，部分列举不返回 `not_found`。短读不返回 `byte_mismatch`；读到字节不等于根满足；不产生部分满足分数。执行错误、观察事实与根满足度分别保留。

### 8.7 权限与预算

- `directory.list` 需 `filesystem.read`+`process.exec`；`entry.inspect` 沿用其现有授权；`file.read` 只需 `filesystem.read`。本切片无写操作。
- 预算上限以实测最小转换数为准：实现后用真实最小转换数测量再定测试 limits。预算不足时以 `interrupted` 停止并保留已完成事实，不出现 0 或 100。

### 8.8 限制与不做

- 排序可替换不等于已学会选择：默认规则、合法集过滤、根评价、权限、预算、回退依据与重试控制保持确定性；本增量不训练、不采用权重、不新增 policy head。
- 不写操作；不做 realpath/links/role/format；不做广义 CLI；不改共享 `cli.command-policy.v1`；不改单来源 7N6E 图与既有 consumer/家族。
- 现有 18 wire 只表达合法候选内部的排序偏好，不能表达"名称是否在场"这类合法集判定；合法集与根判定不进入可学习范围。
- 多来源图只覆盖本切片；不把 `cli.exact-child-sources` 扩大为任意目录数或候选名。
