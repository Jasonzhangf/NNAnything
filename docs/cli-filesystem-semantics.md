# file.property：Shell 文件属性目标与状态转换

状态：2026-10-19 设计合同，尚无新增运行实现。用户收敛：不零散编辑目标，全部采用 `file.property.xxx`。路径、目录、普通文件及 Linux 特殊文件共享属性目标与状态转换模型；CLI 是取得观测或产生状态变化的 Action。操作目录仍由 [cli-semantic-operations.md](cli-semantic-operations.md)维护，调用合同由 [cli-call-contract.md](cli-call-contract.md)维护。

## 1. 唯一目标形式

```ts
type FilePropertyGoal = {
  kind: "file.property";
  target: ObjectRef | PathRef | ScopedFileQuery;
  property: FilePropertyKey; // 完整标识统一为 file.property.xxx
  requirement:
    | { kind: "observed"; freshness: "this_run"; query?: DeclaredTypedQuery }
    | { kind: "equals"; expected: TypedValue; requiredTargetType?: "regular" | "directory" | "symlink" }
    | { kind: "matches"; predicate: DeclaredTypedPredicate };
};
type Request = {
  goal: FilePropertyGoal;
  satisfactionThreshold: number; // 0–100
  state: ExplicitFileState;
};
```

以上为设计形状，不是现有可导入类型。`property` 使用下面表中的完整属性键；不再为新能力新增 observe_config、find_source 等同义 Goal kind。ObjectRef/PathRef 是明确 typed 绑定，不是任意路径字符串或自由文本执行。ScopedFileQuery 在显式范围内按已声明关系定位未知对象，例如 `{relation:"sessionCwd", session:S}` 获取S的当前目录；它不是隐式磁盘搜索，也不能预填待观测的正确路径。目标不存在时使用 PathRef 及父目录/名称证据，不能伪造已存在的文件对象。predicate 按该属性的固定 schema 声明，不接收脚本或任意表达式。

`DeclaredTypedQuery`按property限定，不接受任意表达式。`file.property.role`的observed请求必须提供`query:{kind:"role",role:RoleKey,scopeRef:RoleScopeRef}`，RoleKey词表与判定合同见[属性训练设计第4节](cli-property-training-design.md#4-r用途属性的最小关系设计)，scope类型见[用途证据合同](cli-role-evidence-design.md)。其他当前属性不因此接受role查询。role和scope属于Goal，不由隐藏上下文或输出猜测；State中的scope必须与Goal引用一致。观测出matches或nonmatch都表示已取得指定关系知识；仅要求observed时两者都可达标100，unknown/conflict保留null。若目标要求某角色为真，须另用该属性已声明的matches条件验收，不能把observed偷换为要求正例。

四元素为：Goal 指定目标属性及条件；satisfactionThreshold 指定最低满足度；State 保存实际属性、关系及观测来源；Action 选择固定 CLI/计算操作及必要参数。`observed` 增加属性知识；`equals/matches` 可要求属性的实际值改变，也可能当前已满足。观测到属性不符合时不得当作目标完成。运行前评价已有状态；已满足且证据符合要求时不执行多余修改，要求本次观测则必须获取本次证据。

创建的Goal示例为 `property:"file.property.exists", requirement:{kind:"equals",expected:true,requiredTargetType:"directory"}`，目标是明确父目录下的新条目引用。requiredTargetType来自Goal，observedType来自实际State；目标不存在时两者不能混为同一输入。候选选择的类型来自typed `entrySelector.type`，局部字节修改使用typed `patch(offset,bytes)`；整文件equals与局部patch分别编码，防止同一学生向量需要互斥操作。精确词表与维度见训练设计，不由harness替学生选择动作。

## 2. 文件属性目录与操作映射

目录、普通文件、symlink、字符/块设备、FIFO、socket 是文件类型，不另设平行推理体系；类型会约束可用属性与动作。当前 M0 只分 file/directory/symlink/other，特殊类型细分尚未实现。并非所有类型都能按普通文件读取、复制或定位偏移。Linux 一切皆文件是统一抽象，不是操作语义相同的证明。

| 属性键 | 值/关系与范围 | 观测 Action | 改变或构建目标属性的 Action |
| --- | --- | --- | --- |
| `file.property.path.absolute` | 明确 base/input 的词法绝对路径 | path.resolve | 纯计算增加路径知识，不改变 OS 对象 |
| `file.property.path.relative` | 相对于明确 from 的词法路径 | path.relative | 纯计算；不改变 cwd |
| `file.property.path.parent` | 路径的父路径；实际归属另有观测依据 | path.parts、entry.inspect/list | entry.move 改变实际目录条目位置 |
| `file.property.path.name` | 目录条目名 | path.parts、directory.list | 同父目录 entry.move 即重命名 |
| `file.property.path.physical` | OS解析后的物理路径 | path.realpath | 改链接或移动后需重新观测，不能仅改字符串 |
| `file.property.exists` | 明确路径是否有条目 | entry.inspect；ENOENT与拒权分开 | directory/file.create、entry.remove；树操作为有限组合 |
| `file.property.type` | 普通文件/目录/链接/设备/FIFO/socket等 | entry.inspect；当前特殊类为other | 按目标类型创建；不假设可将任意原对象原地变类型 |
| `file.property.directory.entries` | 直接子条目、类型及覆盖 | directory.list | create/move/remove 改条目集合；不默认递归 |
| `file.property.content.bytes` | 明确范围的字节及EOF/覆盖 | file.read；类型适用时才可读取 | file.replace/write/append/truncate/copy |
| `file.property.content.format` | 明确编码/格式的证据或判断 | 显式读取后固定解码/parser，必要时独立模型 | 改字节后重新评价；扩展名不是格式真值 |
| `file.property.role` | 指定范围内的用途关系，如源码/配置/测试/文档/媒体 | 声明引用、内容/结构证据及独立角色模型 | 移动或修改不必然改变角色，必须按关系证据重验 |
| `file.property.size` | OS长度；目录值不等于子树大小 | entry.inspect | file.truncate、写入或追加；目录子树统计是派生评价 |
| `file.property.mode` | POSIX权限位 | entry.inspect | entry.mode.set；不代表ACL或实际可访问性 |
| `file.property.owner` | uid/gid | entry.inspect | entry.owner.set；不默认提权 |
| `file.property.times` | atime/mtime/ctime/birthtime及缺测 | entry.inspect | entry.times.set只设置atime/mtime，其他时间只观察实际效果 |
| `file.property.link.target` | 链接文本或已证实目标关系 | lstat/readlink/realpath | link.create；不跟随删除，不假设链接文本目标存在 |
| `file.property.links` | 硬链接关系与实际对象身份 | 适用OS对象证据，当前M0缺失 | file.link、entry.remove；删一名称不等于销毁内容 |
| `file.property.relation.sessionCwd` | 此目录与指定session当前目录的关系 | cwd.get；参数显式绑定S | cwd.set；改变的是S的关系，不是目录的全局属性 |
| `file.property.operation.applicability` | 指定操作对当前类型/状态的适用条件及未知 | 类型/实际状态与操作合同 | 仅增加条件知识；不授予权限，不保证OS随后成功 |

属性只定义必要的 typed 值和证据，不建立任意键值业务数据库。内容格式、用途、操作条件和目标关联是同一属性体系的观测/选择函数；不各建另一套核心 Goal 或通用执行引擎。新属性先给合同、可辨输入、反例和评价，再接入本图；表中条目是设计词表，不能冒称模型已训练。

路径指向目录条目，不是永恒对象身份。同一文件可有多个硬链接路径，同一路径可被替换；在State保留引用来源和有效性，不能按路径相同就认定对象未变。内容角色可重叠，单次判断一个明确角色关系，不强塞成互斥文件类型。

## 3. 共享属性状态转换 DAG

持久图：[cli-file-property.graph.json](../workflows/cli-file-property.graph.json)，6N5E SESE。每个属性单元以上表属性键及具体 schema 实例化同一闭合图；不为同一 I/O 结构复制图，也不以共享拓扑省略单项合同。

| 节点 / owner | 输入 → 输出 | 必要性与错误收束 |
| --- | --- | --- |
| 绑定属性目标阈值与当前状态 / nodes+filters | request → property_context | 绑定对象、关系范围及评价条件；不明对象输出缺口，不猜路径 |
| 判断满足度并选择必要操作 / filters+trainable | context → action_proposal 或无需动作/缺口 | 选择能力和对象参数；State/threshold影响正确输出时必须可区分；选择正确不等于Goal达标 |
| 核对条件并执行固定操作 / adapter | proposal → execution_receipt | 类型、参数、授权与当前状态检查后才执行；不适用/拒绝/缺口不调用OS，不让模型绕过权限 |
| 观测实际属性及副作用 / adapter | receipt → observed_transition | 绑定实际New State；写入后失败仍记录已发生效果；无需动作时引用已有合格证据 |
| 评价属性条件与实际满足度 / evaluator | transition → goal_result | 按Goal检查实际属性、来源、必要条件；未知不填0，不用模型分数验收 |
| 保存使用样本与统一结果 / consumer | goal_result → property_result | 保留成功/失败/冲突与采集结果，接入必需单元升级链 |

所有节点传递同一请求及累计证据，前置拒绝/失败沿后续节点收束；不执行真实下游，不把失败转为成功。执行后才发现失败时仍做适用的实际观测。输出包含 `goal, satisfactionThreshold, state_before, action, execution_result, observed_state_after, satisfaction, status, evidence, collection_result`；status 区分 achieved/unmet/unknown/rejected/failed，未知 satisfaction 为空。采集失败独立可见，不改写未受影响的业务结果。

读取/精确修改通常0/100，threshold默认100。搜索只有在Goal明确以已知有限范围的覆盖为条件时才可用中间满足度；未知总量不编百分比。`matches` 找到目标与覆盖范围是不同属性条件。无回归、授权等必要条件不得因阈值降低而放宽。

多级创建、遍历、树复制/删除、分段读取/比较均由有限单操作组合。每次执行本图，显式保存前沿、已完成/未完成项、整体目标和预算；下一步新run，不在DAG造回边。复制/删除整体目标未完成时如实保留部分副作用，不能按完成百分比宣称精确目标已达成。

## 4. 训练闭合与实例

反向推理只属于训练：属性Goal及threshold → 达标属性State → 所需操作/对象参数 → 前置State，形成监督。运行时使用所学关系选择动作，不由teacher纠正模型选择再记成功。读属性、改属性、识别属性分别声明学生职责；OS观测、路径复制、argv构造、固定parser和授权不冒称NN学会。

| 最小单元 | Goal/threshold | State → Action → 实际评价 | 抓错反例 |
| --- | --- | --- | --- |
| 获取cwd | session S绑定的 `file.property.relation.sessionCwd`，本次observed；100 | 明确S → cwd.get → 本次pwd与S关系、实际路径绑定 | 旧知识、其他S、失败冒充成功 |
| 进入目录 | 同属性关系 equals目标D；100 | S当前cwd、D → cwd.set → 同S后续pwd验证，其他S不变 | 一次子进程cd、改错S、提交后验证失败 |
| 列举目录 | `file.property.directory.entries` 本次完整observed；100 | D → directory.list → 独立核对直接子项及类型/覆盖 | 隐藏/换行名称丢失、后代混入、partial当complete |
| 创建/移动/删除 | exists/path.parent/path.name对应明确条件；100 | 真实前树和source/destination → 精确操作 → 独立核对前后树及其他条目 | 覆盖已有目标、同名错目录、链接目标被误删 |
| 整文件替换 | content.bytes 的equals.bytes为完整期望内容；100 | 原F与完整Bytes → file.replace → 核对全部内容与长度 | 把定点写入当整体替换、遗留旧后缀、部分写入却成功 |
| 局部写入 | content.bytes 的patch.bytes(offset,bytes)；100 | 原F与offset/Bytes → file.write → 核对写入区间及区间外保留字节 | 偷偷截断、写错偏移、文本trim丢字节 |
| 后缀追加 | content.bytes 的append.suffix(bytes)；100 | 原F与后缀Bytes → file.append → 核对原有前缀及新增后缀 | 追加变覆盖、隐式创建、部分追加却成功 |
| 内容/用途判断 | content.format/role 的指定关系observed；100 | 真实文件证据 → parser或独立模型 → 对照复核真值，保留未知 | 同后缀不同内容、配置示例与生效配置、生成源码角色重叠 |
| 操作条件 | operation.applicability 对指定操作observed；100 | 类型/状态及声明能力 → 判断 → 独立合同/执行证据核对 | mode当实际权限、设备按普通文件处理、缺测当允许 |

训练复用 [cli-filesystem-training.graph.json](../workflows/cli-filesystem-training.graph.json)：按场景家族划train/dev/verification，真实拟合、候选保存/回载、独立执行与旧能力回归。当前图文件及绑定仍是`cli.command.*@0.1.0`共享命令运行版；[完整训练设计](cli-property-training-design.md)中的B对象绑定、P属性效果策略、R用途关系、C组合下一步属于未来扩展。P与C只扩展同一`cli.command-policy.v1`共享命令矩阵，B与R为独立概念关系模型，不选择命令；未来设计不覆盖当前运行图。固定确定函数不强训。具体固定harness及操作回执见 [命令调用设计](cli-command-design.md)，并不表示这些单元已有运行实现或训练结果。

每单元按 [project-design](../workflows/project-design.graph.json) 完成四元素、SESE和最小必要性准入，按 [model-evolution](../workflows/model-evolution.graph.json) 自动采样、复核、训练及采用，回归/冲突交大模型裁决。采用条件只引用 [model-evolution.md](model-evolution.md)，不建平行门槛。真实OS效果、动作选择、参数绑定和知识判断分别计分。

## 5. 操作补全与当前边界

目录/路径操作目录已在 cli-semantic-operations.md 2.1补齐，文件操作在2.2补齐；均映射上述属性变化，不扩大 Goal kind。先完成既有CWD/pwd、cd、直接列举，再逐能力接入目录创建/移动/删除/属性/链接及组合，随后接入文件字节读写、复制等。属性判断在真实输入已具备时可独立推进，不必等待无关操作全部完成。

现有 `observe_cwd/set_cwd/list_directory` 是历史实现/设计接口，不在本轮文本修改中直接删除或更改。后续由其owner显式迁移到 file.property 语义并保留原公开入口回归；不新增同义Goal，不声称新合同已在运行入口生效。

设计已覆盖普通路径/目录/文件操作映射、B/P/R/C内部数值设计和独立验收计划。当前未实现：本图六个属性算子与绑定、统一四元素请求/结果、扩展对象引用与特殊文件细分、新操作harness、实际训练、自动使用采样/采用/裁决执行链。Linux设备/FIFO/socket已定义观测与普通操作的类型拒绝终点；专用创建/设备协议、挂载/ACL等沿命令设计第5节显式范围，不把当前macOS普通文件实测扩展为Linux设备覆盖。设计不授权对用户文件或设备执行破坏操作。
