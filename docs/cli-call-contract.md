# CLI调用参数简化合同

状态：实施合同。当前权威共享命令合同已演进至 **Stage 2（`stage2-13x38`）**：**13 个 head、38 条 wire、13×38 = 494 参数**，在 Stage 1（`stage1-11x34`，11 head × 34 wire = 374 参数，已接入 `path.realpath` 及 `property.path.physical`/`predicate.observe.physical`/`predicate.observe.resolvedTarget`）基础上新增 `directory.select`、`file.select` 两个执行 head 与 `predicate.select.entry`、`selectorTargetType.unspecified`、`selectorTargetType.regular`、`selectorTargetType.directory` 四条 selector wire，经 `migrateCliCommandProfileStage1ToStage2` 按精确名称迁移（**374 个按名复制 + 120 个零填充 = 494 参数**）；Stage 1 `stage1-11x34` 仍作为显式旧边界（`stage: "stage1-11x34"`）按自身 11×34 矩阵推理。推理复用 `workflows/cli-file-property.graph.json`（6N5E），训练复用 `workflows/cli-filesystem-training.graph.json`（8N8E）。当前 Stage 2 候选为 `4e7e39ca-bd72-4785-a719-c621112159b8`，8N8E 训练图真实执行 370 条（原 358 条 + append-only 追加 12 条未观测/过期目录阻断样本，`train` 246/246、`development` 124/124）、新进程回载 `reload.json` 370/370、P3 偏好回归 24/24（`weightDelta=0`）、P3 内容搜索回载 natural 与 forced-first 各 24/24、外部独立套件 95/95（历史 71 + Stage 2 24，保留 5 项固定 `UNVERIFIED`；首跑失败候选 `4e249c32-0809-4016-beb6-5b3d336a9f16` 历史证据保留）。**历史阶段记录**：0.2.0 的 PWD/CD/LS `6×14` 矩阵、0.3.0 批次1 的 `10×30` 矩阵（300 参数，候选 `35bd5ad9-15dc-409e-9001-bcab24f75398`，训练图 262 条、独立套件 56/56）、P3 的 `10×31` 矩阵（310 参数，候选 `fb73d4a0-cb66-4008-afa0-5569b2cdfcdc`）与 Stage 1 的 `11×34` 矩阵（374 参数，候选 `7e34901c-68ca-401f-ab40-72189f4e904d`，训练图 310 条、独立套件 71/71）仅作为历史基线与离线迁移输入保留，不再作为当前矩阵。旧 `observe_cwd/set_cwd/list_directory` Goal 与旧 `cli.command-policy.v1` 4×4 运行对象已退役。本文是当前调用边界的唯一入口；Goal/证据/结果语义见[file.property合同](cli-filesystem-semantics.md)第7节，训练与迁移见[文件系统训练合同](cli-filesystem-training.md)§0.1。所有共享候选保持`uncalibrated/not_applied`，训练报告保持`fullyVerified: false`；后续 P4–P6 目录/文件变更操作、自动采集/自动采用仍未接入共享命令矩阵。

## 1. 模型输出调用序列与显式资源信封

单目录直接子项精确查找的多步组合调用与资源边界由[精确查找设计](cli-entry-search-design.md#3-请求资源与公开入口)维护（公开入口 `nnanything/cli-search`）；单目录已观测完整 listing 上的原子 `select.entry` 选择已在当前 Stage 2（`stage2-13x38`）通过 `directory.select`/`file.select` 与只读注入的 Track B 关系评分 profile（目录选择为 `cli.directory-select-relation.v1`，普通文件选择为 `cli.file-select-relation.v1`）接入共享 `cli-file-property` 6N5E 图。

统一共享模型（`cli.command-policy.v1`）接收 typed `file.property` Goal 与 State，输出标准调用序列。序列首项取自命令头，是小写实际Shell命令名或稳定语义动作id；后续项是机械绑定的typed位置参数引用，模型不生成自由参数文本。

profile、sandbox、会话与可选采样回调在策略工厂绑定：`createCliCommandPolicy({ profile, sandbox, session: S, onSample?, stage?, entrySelectProfiles? })`；每次调用只传`step({ goal, satisfactionThreshold, state })`。请求没有`resources`、`directories` 或独立 `directory` 字段；目标目录引用在 `goal.target`/`goal.requirement.expected` 中显式给出。模型不生成完整命令文本，不生成Shell标志位，不解释Shell语法，也不解析命令stdout/stderr正文。

```ts
const policy = createCliCommandPolicy({ profile, sandbox, session: S });
await policy.step({
  goal: {
    kind: "file.property",
    property: "file.property.relation.sessionCwd",
    target: { kind: "cli.file-query", relation: "sessionCwd", session: S },
    requirement: { kind: "equals", expected: D },
  },
  satisfactionThreshold: 100,
  state: { session: S.sessionId, cwdObservation: null, directoryListing: null },
});
```
Shell 的统一 Goal 为 [file.property.xxx](cli-filesystem-semantics.md)，指定对象、属性及要求；本页 `operation` 仍是 Action，不将属性键当可执行程序名，也不为每个属性增加一个原生命令。旧 Goal kind 不再被运行入口接受；旧对象只能经显式离线迁移工具转换，不能静默 fallback。

| 语义调用 | NN需要选择/携带的参数 | harness固定的内容 |
| --- | --- | --- |
| `{operation:"cwd.get",parameters:{session:S}}` | session引用 | PWD映射、`/bin/pwd -P`、显式cwd、授权、回执来源 |
| `{operation:"cwd.set",parameters:{session:S,directory:D}}` | session和目录引用 | CD映射、固定执行模板、目标路径绑定、成功后提交S、后续观测验证 |
| `{operation:"directory.list",parameters:{session:S,directory:D}}` | session和目录引用 | LIST映射、固定结构化CLI helper、只列直接条目、隐藏项保留、不跟随链接、不递归 |
| `{operation:"path.resolve",parameters:{base:P,input:PathText}}` | 明确绝对base与原始input | 固定词法解释器；不访问FS，不展开`~`、环境变量或glob |
| `{operation:"path.relative",parameters:{from:P,to:P}}` | 两个明确绝对路径 | 固定`path.posix.relative`；非绝对参数拒绝 |
| `{operation:"path.parts",parameters:{path:P}}` | 明确绝对路径 | 固定`dirname/basename`；只合并重复斜杠并去掉尾斜线（根`/`除外），不解析`.`或`..`；根目录返回显式parent/name/isRoot |
| `{operation:"path.realpath",parameters:{ref:E/D/F/P}}` | typed来源引用 | 固定helper执行OS realpath；解析物理路径与目标身份，只读不写FS |
| `{operation:"entry.inspect",parameters:{ref:E/D/F/P,followSymlinks:boolean}}` | typed来源引用与明确跟随模式 | 固定helper执行stat/lstat/readlink；只读，不打开FIFO/socket/设备字节流 |
| `{operation:"directory.select" \| "file.select",parameters:{selector,candidates,coverage}}` | 目标类型匹配的选择器与当前目录已观测直接子项 | 纯关系选择节点（读取显式注入的只读 Track B 关系评分 profile：`directory.select` 对应 `cli.directory-select-relation.v1`，`file.select` 对应 `cli.file-select-relation.v1`）；不执行shell，不隐式扫描磁盘 |

`DirectoryRef.path`在调用时相对S当前cwd解析；CD提交后调用者重新绑定。`DirectoryQuery` 是合法但未完成的目录绑定：`scopes` 显式、`selector.type="directory"`、`cardinality="one"`；它与缺少当前有效完整目录 listing 的 `select.entry` 请求均进入 `DEFER`，不扫描磁盘。harness不做隐藏重定向。

| 结构化语义 | 模型输出调用序列 | harness固定映射与语义操作 | harness固定执行与验证内容 |
| --- | --- | --- | --- |
| `sessionCwd observed` | `["pwd"]` | `cwd.get(session:S)` | 读取S当前cwd，执行`/bin/pwd -P`，回执解码与证据记录 |
| `sessionCwd equals D` | `["cd", D]` 或 `NOOP` | `cwd.set(session:S, directory:D)` | 绑定D，执行固定CD脚本，提交S并以同一回执验证后条件；已满足且证据适用时不执行 |
| `directory.entries observed` | `["ls", D]` | `directory.list(session:S, directory:D)` | 绑定D，通过固定结构化helper列举直接子条目；不调用未编译自由命令，不解析`/bin/ls`文本 |
| `path.physical observed` / `entry.identity observed (resolvedTarget)` | `["path.realpath", ref]` | `path.realpath(ref)` | 绑定ref，通过固定helper解析物理路径与解析目标身份 |
| `directory.entries matches entrySelector`（已具备当前目录有效完整 listing） | `["directory.select", selector, candidates, coverage]` 或 `["file.select", selector, candidates, coverage]` | `directory.select` / `file.select` | 基于已观测完整 listing 与只读 Track B profile 对合格候选评分并绑定 `selectedRef`，零外部进程 |
| 合法未绑定 `DirectoryQuery` 或缺当前有效完整目录 listing 的 `select.entry` | `DEFER`，无调用 | 不执行 | `invocation:null`，`executorInvoked:false`，返回typed `binding_unresolved` / 缺口 |
| 结构合法但未注册 property/predicate | `unsupported`，无调用 | 不分流，不执行 | `selectedHead:"unsupported"`，`invocation:null`，`executorInvoked:false`，`satisfaction:null` |

合同要求：
- `["cd", D]`是单次调用的参数序列，不是多步规划。
- 未支持语义输出内部`unsupported`分类，不输出可执行Shell命令，也不输出`["REJECT"]`。
- 共享路径只有一份 `cli.command-policy.v1` profile；旧六参数 PWD API（`cli.goal-policy.v1`）与旧 4×4 共享 profile 已物理退役，不在运行入口保留兼容分支。
- `ls`的native实现继续使用固定编译结构化helper，harness与模型均不解析`/bin/ls`面向人类的文本输出。
- 命令头预测错误时，guard拒绝执行但仍记录`policy_error`，不能把错误伪装成`unsupported`或OS失败。
- 模型预测的新状态或机械调用完成不能等同于目标达成，实际状态由harness观测提供。
- `NOOP`与`DEFER`是控制 head，`invocation:null`且零 executor；不输出伪造 shell 命令。
- 非法 schema、额外答案字段、坏 ref、跨 session 矛盾或旧 Goal/旧 profile 直接抛 `TypeError`，零 OS 副作用。结构合法但未注册的 property/predicate 返回 `unsupported` 控制结果。
- 顶层 `status` 统一为 `achieved | unmet | unknown | rejected | failed`；旧 `unverified` 分支退役。

### 1.1 实现切片、当前 `stage2-13x38` 合同与迁移入口

**当前 `stage2-13x38` 合同**：默认运行 schema 保存精确的 `properties`、`predicates`、`heads`、`wires`、`weights` 顺序：
- `heads`（`K=13`）顺序固定为：`unsupported,DEFER,NOOP,pwd,cd,ls,path.resolve,path.relative,path.parts,path.realpath,entry.inspect,directory.select,file.select`。
- `wires`（`F=38`）顺序固定为：`bias,goalObserveCwd,goalSetCwd,goalListDirectory`（4列）；`property.path.absolute,property.path.relative,property.path.parent,property.path.name,property.path.physical,property.exists,property.type,property.directory.entries,property.size,property.mode,property.owner,property.times,property.link.target,property.entry.identity,property.relation.sessionCwd`（15列）；`predicate.observe.absolute,predicate.observe.relative,predicate.observe.parts,predicate.observe.physical,predicate.observe.inspect,predicate.observe.resolvedTarget,predicate.observe.sessionCwd,predicate.equals.sessionCwd,predicate.observe.entries,predicate.select.entry`（10列）；`selectorTargetType.unspecified,selectorTargetType.regular,selectorTargetType.directory`（3列）；`state.hasFreshEvidence,state.knownValue,state.requiredConditionHolds,state.hasDestinationRef`（4列）；`search.nameNeedleSegment`（1列）与交互 `state.requiredConditionHolds*state.hasFreshEvidence`（1列）。`hasSessionRef` 恒为 1，只记录常量，不注册。`F = 4 + 15 + 10 + 3 + 4 + 1 + 1 = 38`、`K = 13`，当前合同矩阵为 `13×38 = 494` 参数。

**命名迁移与 Stage 1 旧边界**：
- 从 Stage 1（`stage1-11x34`，11 head × 34 wire = 374 参数）到当前 Stage 2（`stage2-13x38`）由 `migrateCliCommandProfileStage1ToStage2` 显式离线执行：**374 个已有 `(head, wire)` 位置按精确名称复制，新增 `directory.select`、`file.select` 两行与 `predicate.select.entry`、`selectorTargetType.unspecified/regular/directory` 四列共 120 个位置补零**，合计 494 参数。
- Stage 1（`stage1-11x34`）仍作为显式旧边界（`validateCliCommandProfile(profile, "stage1-11x34")`）按自身 11×34 矩阵推理。
- **历史离线迁移链（不再作为当前默认矩阵）**：旧 `4×4` 对象经 `migrateLegacyCliCommandProfile` 按 name 迁移到 `6×14`（84 参数）；`6×14` 的 84 个交叉位置经 `migrateCliCommandProfileV6` 按 name 复制到 `10×30`（300 参数）；`10×30` 经 `migrateCliCommandProfileV10x30` 追加 `search.nameNeedleSegment` 到 `10×31`（310 参数）；`10×31` 再经 `migrateCliCommandProfileStage0ToStage1` 按 name 复制 310 项并补零 64 项到 Stage 1 `11×34`（374 参数）。默认运行入口不静默接受未迁移的旧形状，也不按行索引复用权重。legacy 四 wire 从 typed property/predicate 相等关系计算，不调用期望 head 或 teacher。

当前 Stage 2 已注册 `selectorTargetType`（3列）、`predicate.select.entry`、`path.physical`、`observe.physical`、`observe.resolvedTarget`、`path.realpath`、`directory.select` 与 `file.select`；当前仍不注册 `observedType`、`requiredTargetType`、`combination` 块，不注册 `followSymlinks` wire 或 `file.property.links`。

补全的目录/文件操作按语义目录2.1/2.2的必要参数接入：引用 source/destination/parent/file/session 与 typed Bytes、offset、length、mode、uid/gid、时间或link文本，字段按具体operation固定。创建目标用已知父目录与明确目标路径，不要求伪造已有引用。固定harness在 `lib/adapters/cli/`，仅接已声明操作，不开放通用shell；OS/固定helper映射及部分副作用验收须在各操作实现前补齐。递归创建、树复制/删除等由有限单操作组合，不给命令加隐含递归/覆盖fallback。

上述操作的具体typed参数、固定命令/OS API、无覆盖rename、字节协议、类型限制和部分副作用方案已由 [cli-command-design.md](cli-command-design.md) 补齐；本页只维护调用原则，不复制第二份映射。训练特征、参数矩阵、监督、分区与独立验收由 [cli-property-training-design.md](cli-property-training-design.md) 维护。后续 P4–P6 的写/字节/元数据操作在接入共享命令矩阵前不冒称已完成 Stage 3–5 联合策略训练。

## 2. 准确调用由边界保障

固定流水为：已验证语义调用序列→检查命令头及参数类型→从策略绑定与调用字段取session/目录资源→检查授权及场景归属→构造固定CLI/argv→执行→保存回执与独立状态观测。复用现有CLI动作workflow，不另建调度器。模型选择错误、参数绑定错误、调用构造错误及OS失败分别报告。

实际argv必须与模板逐参数一致；路径含空格、中文、换行、引号或shell元字符仍是一个原始参数。不得把整条命令拼成字符串执行。为cd调用固定zsh脚本时，仅允许已声明的恒定脚本，目录通过独立argv传入；模型不能改脚本或可执行路径。

正确选择操作不保证OS成功。无权限、目标不存在、目标类型错误及partial结果仍保留真实错误；参数简化不是吞错、补默认或静默fallback。harness guard拒绝模型错误调用时，策略仍记错。

## 3. 回执与内容理解分开

命令stdout/stderr可作为不透明原始证据保存，不能成为学生的自由文本输入或自动监督。harness读取退出码、固定协议字段或独立OS状态来验收效果，这是机器协议与观测，不训练内容理解。原pwd适配器已有的路径回执解码保持既有实现，不将它称为NN学会解析pwd输出。

目录列举返回名称/类型是结构化条目观测，不读文件正文，也不通过人类ls文本分词提取名称。JSON等固定协议可由harness解码；不能因此宣称模型理解文件内容。列举完整性与特殊名称无损仍需要独立验收。若回执缺少可验证事实，目标保持未验证，不让NN读stdout猜成功。

## 4. 训练与设计流程接入

每项训练只监督命令头选择和明确的参数角色；参数引用是否指向正确session/目录单独验收。原始路径复制、argv编码、输出解码和OS类型不是NN训练目标。CWD归属概念题仍只用结构关系，不引入内容解析。共享训练图接收调用者准备并分区的dataset；fixture创建与新进程回载由公开consumer负责，不是图内行为。

设计时先写“简化调用序列→固定harness映射→实际观测后条件”，再定学生特征、样本与训练图。所有接入能力都给出精确调用、缺参数、错引用、特殊路径参数和执行失败反例。统一共享命令模型唯一训练合同为[文件系统训练合同](cli-filesystem-training.md)，完整训练分区及自动采用条件仍沿[模型演进合同](model-evolution.md)。
