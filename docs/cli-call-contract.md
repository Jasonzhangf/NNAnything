# CLI调用参数简化合同

状态：2026-10-19实施合同。0.2.0 的 PWD/CD/LS 已迁移到 `file.property` typed 请求与统一单 profile；0.3.0 已实现并接入 `path.resolve`、`path.relative`、`path.parts`、`entry.inspect` 与 10×30 共享矩阵；运行证据为合并最新 origin/main 后全仓 761/761 通过、独立套件 40 场景+16 探针 56/56、旧独立套件回归 34/34；当前候选 `35bd5ad9-15dc-409e-9001-bcab24f75398`，统一训练图真实执行 262 条。旧 `observe_cwd/set_cwd/list_directory` Goal 与旧 `cli.command-policy.v1` 4×4 运行对象已退役。本文是当前调用边界的唯一入口；Goal/证据/结果语义见[file.property合同](cli-filesystem-semantics.md)第7节，训练与迁移见[文件系统训练合同](cli-filesystem-training.md)§0.1。共享候选保持`uncalibrated/not_applied`；B对象查找、其余目录/文件操作、自动采集/自动采用仍未实现。

## 1. 模型输出调用序列与显式资源信封

统一共享模型（`cli.command-policy.v1`）接收 typed `file.property` Goal 与 State，输出标准调用序列。序列首项取自命令头，是小写实际Shell命令名；后续项是机械绑定的typed位置参数引用，模型不生成自由参数文本。

profile、sandbox、会话与可选采样回调在策略工厂绑定：`createCliCommandPolicy({ profile, sandbox, session: S, onSample? })`；每次调用只传`step({ goal, satisfactionThreshold, state })`。请求没有`resources`、`directories` 或独立 `directory` 字段；目标目录引用在 `goal.target`/`goal.requirement.expected` 中显式给出。模型不生成完整命令文本，不生成Shell标志位，不解释Shell语法，也不解析命令stdout/stderr正文。

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
| `{operation:"entry.inspect",parameters:{ref:E/D/F/P,followSymlinks:boolean}}` | typed来源引用与明确跟随模式 | 固定helper执行stat/lstat/readlink；只读，不打开FIFO/socket/设备字节流 |

`DirectoryRef.path`在调用时相对S当前cwd解析；CD提交后调用者重新绑定。`DirectoryQuery` 是合法但本轮未完成的目录绑定：`scopes` 显式、`selector.type="directory"`、`cardinality="one"`；它进入 `DEFER`，不扫描磁盘。harness不做隐藏重定向。

| 结构化语义 | 模型输出调用序列 | harness固定映射与语义操作 | harness固定执行与验证内容 |
| --- | --- | --- | --- |
| `sessionCwd observed` | `["pwd"]` | `cwd.get(session:S)` | 读取S当前cwd，执行`/bin/pwd -P`，回执解码与证据记录 |
| `sessionCwd equals D` | `["cd", D]` 或 `NOOP` | `cwd.set(session:S, directory:D)` | 绑定D，执行固定CD脚本，提交S并以同一回执验证后条件；已满足且证据适用时不执行 |
| `directory.entries observed` | `["ls", D]` | `directory.list(session:S, directory:D)` | 绑定D，通过固定结构化helper列举直接子条目；不调用未编译自由命令，不解析`/bin/ls`文本 |
| 合法未绑定 `DirectoryQuery` | `DEFER`，无调用 | 不执行 | `invocation:null`，`executorInvoked:false`，返回typed `binding_unresolved` |
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

### 1.1 实现切片、0.3.0合同与训练入口

0.2.0 已实现 profile 保存精确的 `properties`、`predicates`、`heads`、`wires`、`weights` 顺序，head 为 `unsupported,DEFER,NOOP,pwd,cd,ls`，矩阵为 6×14=84 参数（历史形状，仅作显式离线迁移输入）。0.3.0 运行接入已由 I3–I5 完成，当前矩阵为 10×30=300 参数。

0.3.0 合同 profile 的 head 顺序为 `unsupported,DEFER,NOOP,pwd,cd,ls,path.resolve,path.relative,path.parts,entry.inspect`。wire 顺序固定为：`bias,goalObserveCwd,goalSetCwd,goalListDirectory`；`property.path.absolute,property.path.relative,property.path.parent,property.path.name,property.exists,property.type,property.directory.entries,property.size,property.mode,property.owner,property.times,property.link.target,property.entry.identity,property.relation.sessionCwd`；`predicate.observe.absolute,predicate.observe.relative,predicate.observe.parts,predicate.observe.inspect,predicate.observe.sessionCwd,predicate.equals.sessionCwd,predicate.observe.entries`；`state.hasFreshEvidence,state.knownValue,state.requiredConditionHolds,state.hasDestinationRef` 与交互 `state.requiredConditionHolds*hasFreshEvidence`。`hasSessionRef` 恒为 1，只记录常量，不注册。`F=4+14+7+4+1=30`、`K=10`，合同矩阵为 10×30=300 参数。

离线迁移分两级且都显式执行：旧 `[unsupported,pwd,cd,ls]×[bias,goalObserveCwd,goalSetCwd,goalListDirectory]` 4×4 对象按 name 迁移到 6×14；旧 6×14 的 84 个交叉位置再按 name 原值复制到 10×30，新增四行、16 列及其他未对应位置补零。运行入口不静默接受旧形状，也不按行索引复用权重。legacy 四 wire 从 typed property/predicate 相等关系计算，不调用期望 head 或 teacher。

本批不注册 `observedType`、`requiredTargetType`、`selectorTargetType`、`combination` 块，不注册 `followSymlinks` wire、`path.physical`、`observe.physical`、`observe.resolvedTarget` 或 `file.property.links`。`path.realpath` 不注册且不预留空列；后续按独立批次闭合物理路径与链接全链解析。

补全的目录/文件操作按语义目录2.1/2.2的必要参数接入：引用 source/destination/parent/file/session 与 typed Bytes、offset、length、mode、uid/gid、时间或link文本，字段按具体operation固定。创建目标用已知父目录与明确目标路径，不要求伪造已有引用。固定harness在 `lib/adapters/cli/`，仅接已声明操作，不开放通用shell；OS/固定helper映射及部分副作用验收须在各操作实现前补齐。递归创建、树复制/删除等由有限单操作组合，不给命令加隐含递归/覆盖fallback。

上述操作的具体typed参数、固定命令/OS API、无覆盖rename、字节协议、类型限制和部分副作用方案已由 [cli-command-design.md](cli-command-design.md) 补齐；本页只维护调用原则，不复制第二份映射。训练特征、参数矩阵、监督、分区与独立验收由 [cli-property-training-design.md](cli-property-training-design.md) 维护。两者均为设计，当前没有新增helper或运行接口。

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
