# CLI 只读组合主线 P1：能力盘点、受信范围读与最小组合合同

状态：2026-10-22 实施合同。本文是 P1 增量的唯一 owner；领域合同仍由 `cli-filesystem-semantics.md`、`cli-call-contract.md`、`cli-semantic-operations.md` 与 `cli-entry-search-design.md` 维护，本文不复制其表格。P1 只交付盘点文档、责任图与 `file.read` 受信范围读原语；根组合 `file.property.content.bytes` 的运行入口属于 P2，本文只给合同与责任图，不宣称根目标已实现。

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
| `file.read`（`lib/adapters/cli/filesystem-sandbox.ts`） | observed `cli.file` ref + offset + length → bytes(base64)/size/bytesRead/eof/identity | 受信 ref 复验 + 同一安全打开策略 | `filesystem.read`；不需要 `process.exec` | `nnanything/cli-goal` 与 `nnanything/cli-search` 导出的 `sandbox.execute`；无 policy head，也无根组合公开入口 |
| `observeContentFormat` / `detectSignature` / `decodeUtf8`（`lib/filters/cli-content.ts`） | bytes+complete → 签名/UTF-8/JSON 判断 | 无 OS，纯确定性 | 无 | 无包导出、无公开 consumer、未接 sandbox；仅 `tests/cli-content-format.test.mjs` 6/6 |
| `readDeclaredReferences`（`lib/filters/cli-declaration.ts`） | manifest path+bytes+complete+field+scope → 声明引用 | 无 OS，纯确定性 | 无 | 无包导出、无公开 consumer；仅 `tests/cli-declaration.test.mjs` 9/9 |
| `readEntrySnapshot` / `collectDirectoryListing` | 见 `entry-inspection.ts` / `directory-listing.ts` | 真实 `lstat`/`readdir` | 由 sandbox 授权 | 被 sandbox `entry.inspect` / `directory.list` 使用，属已接能力，不是仅单测 |

`readFileRange` 的旧公开路径是 `nnanything/cli` 的按路径 `observe({kind:"read"})`，它不查 `boundRefs`、不查 session revision，不能当受信组合能力。P1 只复用它的安全打开策略，不改旧路径语义；新增 `identity` 字段为向后兼容扩展。

### 1.3 仅合同/设计，无运行入口

| 合同项 | I/O | 真实观测来源 | 授权 | 公开 consumer |
| :--- | :--- | :--- | :--- | :--- |
| `file.property.content.bytes` 根组合 | 合同定义显式 directory ref + name + regular + range + `equals(base64)`；P1 只有底层 `file.read` 原语 | P2 仍需 list → inspect → read；当前没有根组合运行路径 | 计划需要 `filesystem.read`；list/inspect 还需要 `process.exec` | 无；仅 P1 `sandbox.execute({operation:"file.read"})`，根组合不在 P2 前 |
| `file.property.content.format` | 无可调用 I/O；合同只定义 format 属性与显式 parser 边界 | 无运行观测路径 | 无 | 无 |
| `file.property.role` | 无可调用 I/O；合同只定义 role/scope 关系与独立模型边界 | 无运行观测路径 | 无 | 无 |
| `file.property.links` | 无可调用 I/O；合同只定义硬链接关系缺口 | 无运行观测路径 | 无 | 无 |
| `file.property.path.physical` | 无可调用 I/O；合同只保留 realpath 缺口 | 无运行观测路径 | 无 | 无 |
| `file.property.operation.applicability` | 无可调用 I/O；合同只定义适用性知识 | 无运行观测路径 | 无 | 无 |
| 写操作（`file.replace/write/append/truncate/copy`、`mkdir/remove/move`、`mode/owner/times` set） | 无可调用 I/O；操作目录仍为设计 | 无运行观测路径 | 无 | 无；本增量不扩写操作或提权 |

### 1.4 与 lead 盘点的差异

- lead 记录的“sandbox 无 `file.read` 操作”在 P1 实现前准确；P1 后新增受信 `file.read` 语义调用，但共享 policy 仍无 content head，根组合仍无公开入口。这是增量状态变化，不是对原先测量的纠正。
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
    kind: "cli.file-query";
    directory: ObservedDirectoryRef; // 显式已绑定目录引用
    name: string;                    // 严格单个名称段
    type: "regular";                 // 要求类型，不是已观测真值
  };
  requirement: {
    kind: "matches";
    predicate: {
      kind: "equals";
      offset: number;
      length: number;
      expectedBase64: string;        // 规范 base64
    };
  };
  satisfactionThreshold: 100;
};
```

`name` 是单个非空名称段，拒绝 NUL、`/`、`.`、`..`，不 trim、不展开 glob/变量、不做大小写或 Unicode 折叠。`directory` 是显式绑定目录，不接受 `DirectoryQuery`、不扫描磁盘。

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

0 与 100 是二元目标的全部合法 satisfaction；null 表示证据不足。短读不冒充 `byte_mismatch`，也绝不产生部分满足分数。

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
- `file.read` 不增加 policy head，不训练，不改共享 `cli.command-policy.v1` 或权重；根组合入口属 P2。

## 6. P1 证据

- 实现：`lib/adapters/cli/filesystem-sandbox.ts`（`file.read` 语义调用与 `executeFileRead`）、`lib/adapters/cli/file-content.ts`（`FileReadRange.identity` 扩展）。
- 红测日志：外置 run `logs/p1-red.log`。
- 新测试：`tests/cli-file-read-sandbox.test.mjs`，11 个具名测试。
- 责任图：`workflows/cli-read-composition.graph.json`，`dagpipe graph validate` 通过（7 节点 6 边 7 波）。
