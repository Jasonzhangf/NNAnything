# file.property：Shell 文件属性目标与状态转换

状态：实施与设计合同。当前权威共享命令合同已演进至 **Stage 2（`stage2-13x38`）**：**13 个 head、38 条 wire、13×38 = 494 参数**（在 Stage 1 `stage1-11x34` 基础上新增 `directory.select`、`file.select` 两个执行 head 与 `predicate.select.entry`、`selectorTargetType.unspecified/regular/directory` 四条 selector wire，经 `migrateCliCommandProfileStage1ToStage2` 按名复制 374 项、补零 120 项；Stage 1 `stage1-11x34` 仍作为显式旧边界按自身 11×34 矩阵推理）。Stage 2 正式候选 `4e7e39ca-bd72-4785-a719-c621112159b8` 已完成 8N8E 训练图 370 条样本真实执行、新进程回载 370/370、P3 偏好回归 24/24（`weightDelta=0`）与外部独立套件 95/95（保留 5 项固定 `UNVERIFIED`），候选保持 `uncalibrated/not_applied`、训练报告保持 `fullyVerified=false`。**历史阶段记录**：0.2.0 的 PWD/CD/LS `6×14` 切片、0.3.0 批次1 的 `10×30` 矩阵（候选 `35bd5ad9-15dc-409e-9001-bcab24f75398`，262 条样本，独立套件 56/56）、P3 的 `10×31` 矩阵（候选 `fb73d4a0-cb66-4008-afa0-5569b2cdfcdc`）与 Stage 1 的 `11×34` 矩阵（候选 `7e34901c-68ca-401f-ab40-72189f4e904d`，310 条样本，独立套件 71/71）均作为历史基线保留。用户收敛：不零散编辑目标，全部采用 `file.property.xxx`。路径、目录、普通文件及 Linux 特殊文件共享属性目标与状态转换模型；CLI 是取得观测或产生状态变化的 Action。操作目录仍由 [cli-semantic-operations.md](cli-semantic-operations.md)维护，调用合同由 [cli-call-contract.md](cli-call-contract.md)维护。

## 1. 唯一目标形式

单目录直接子项精确名称查找的多步组合见[精确查找设计](cli-entry-search-design.md)（`nnanything/cli-search`）；单目录已观测 listing 上的原子 `directory.entries matches entrySelector`（`predicate.select.entry`）已在当前 Stage 2（`stage2-13x38`）通过 `directory.select` / `file.select` 与只读注入的 Track B 关系 profile（`cli.entry-select.v1`）接入共享 6N5E `cli-file-property` 图（未观测或过期 listing 仍进入 `DEFER`，不隐式扫描磁盘）。

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

目录、普通文件、symlink、字符/块设备、FIFO、socket 是文件类型，不另设平行推理体系；类型会约束可用属性与动作。批次1的 `entry.inspect` 合同使用完整 8 类联合：`regular`、`directory`、`symlink`、`character_device`、`block_device`、`fifo`、`socket`、`other`。旧 M0 的 `type="file"` 接口只做兼容映射：`regular→file`，特殊类→`other`，与新的完整接口共用同一底层 OS 读取，不维护两套 stat 算法。特殊类型细分未因本合同落盘而取得运行证据。并非所有类型都能按普通文件读取、复制或定位偏移。Linux 一切皆文件是统一抽象，不是操作语义相同的证明。

| 属性键 | 值/关系与范围 | 观测 Action | 改变或构建目标属性的 Action |
| --- | --- | --- | --- |
| `file.property.path.absolute` | 明确 base/input 的词法绝对路径 | path.resolve | 纯计算增加路径知识，不改变 OS 对象 |
| `file.property.path.relative` | 相对于明确 from 的词法路径 | path.relative | 纯计算；不改变 cwd |
| `file.property.path.parent` | 路径的父路径；只合并重复斜杠并去掉尾斜线（根`/`除外），不解析`.`或`..`；实际归属另有观测依据 | path.parts、entry.inspect/list | entry.move 改变实际目录条目位置 |
| `file.property.path.name` | 目录条目名；只合并重复斜杠并去掉尾斜线（根`/`除外），不解析`.`或`..` | path.parts、directory.list | 同父目录 entry.move 即重命名 |
| `file.property.path.physical` | OS解析后的物理路径 | path.realpath | 改链接或移动后需重新观测，不能仅改字符串 |
| `file.property.exists` | 明确路径是否有条目 | entry.inspect；ENOENT与拒权分开 | directory/file.create、entry.remove；树操作为有限组合 |
| `file.property.type` | regular/directory/symlink/character_device/block_device/fifo/socket/other 完整类型 | entry.inspect；旧M0兼容映射为file/other | 按目标类型创建；不假设可将任意原对象原地变类型 |
| `file.property.directory.entries` | 直接子条目、类型及覆盖 | directory.list | create/move/remove 改条目集合；不默认递归 |
| `file.property.content.bytes` | 明确范围的字节及EOF/覆盖 | file.read；类型适用时才可读取 | file.replace/write/append/truncate/copy |
| `file.property.content.format` | 明确编码/格式的证据或判断 | 显式读取后固定解码/parser，必要时独立模型 | 改字节后重新评价；扩展名不是格式真值 |
| `file.property.role` | 指定范围内的用途关系，如源码/配置/测试/文档/媒体 | 声明引用、内容/结构证据及独立角色模型 | 移动或修改不必然改变角色，必须按关系证据重验 |
| `file.property.size` | OS长度；目录值不等于子树大小 | entry.inspect | file.truncate、写入或追加；目录子树统计是派生评价 |
| `file.property.mode` | POSIX权限位 | entry.inspect | entry.mode.set；不代表ACL或实际可访问性 |
| `file.property.owner` | uid/gid | entry.inspect | entry.owner.set；不默认提权 |
| `file.property.times` | atime/mtime/ctime/birthtime及缺测 | entry.inspect | entry.times.set只设置atime/mtime，其他时间只观察实际效果 |
| `file.property.link.target` | follow=false时为readlink原文；follow=true不伪造目标文本，目标关系与组合不在本批 | entry.inspect(lstat/readlink) | link.create；不跟随删除，不假设链接文本目标存在 |
| `file.property.entry.identity` | `{dev,ino,nlink,rdev}`；逐项可null，不用路径相等推断对象相同 | entry.inspect | 不提供设置操作；跨路径硬链接关系仍属未注册的file.property.links |
| `file.property.links` | 硬链接关系与实际对象身份 | 适用OS对象证据，当前M0缺失 | file.link、entry.remove；删一名称不等于销毁内容 |
| `file.property.relation.sessionCwd` | 此目录与指定session当前目录的关系 | cwd.get；参数显式绑定S | cwd.set；改变的是S的关系，不是目录的全局属性 |
| `file.property.operation.applicability` | 指定操作对当前类型/状态的适用条件及未知 | 类型/实际状态与操作合同 | 仅增加条件知识；不授予权限，不保证OS随后成功 |

属性只定义必要的 typed 值和证据，不建立任意键值业务数据库。内容格式、用途、操作条件和目标关联是同一属性体系的观测/选择函数；不各建另一套核心 Goal 或通用执行引擎。新属性先给合同、可辨输入、反例和评价，再接入本图；表中条目是设计词表，不能冒称模型已训练。

路径指向目录条目，不是永恒对象身份。同一文件可有多个硬链接路径，同一路径可被替换；在State保留引用来源和有效性，不能按路径相同就认定对象未变。内容角色可重叠，单次判断一个明确角色关系，不强塞成互斥文件类型。

## 3. 共享属性状态转换 DAG

持久图：[cli-file-property.graph.json](../workflows/cli-file-property.graph.json)，0.3.0、6N5E SESE。每个属性单元以上表属性键及具体 schema 实例化同一闭合图；不为同一 I/O 结构复制图，也不以共享拓扑省略单项合同。

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

训练复用[cli-filesystem-training.graph.json](../workflows/cli-filesystem-training.graph.json)：按场景家族划train/dev/verification，真实拟合、候选保存/回载、独立执行与旧能力回归。两张图与源码绑定均为`0.3.0.0000`，当前权威矩阵为 Stage 2 `stage2-13x38`（13 head × 38 wire = 494 参数，含只读 Track B `cli.entry-select.v1` 关系评分注入）并保留 Stage 1 `stage1-11x34`（11×34 = 374 参数）旧边界；历史 `10×30` 与 `10×31` 证据保留为历史基线。[完整训练设计](cli-property-training-design.md)中的后续 P4–P6 属性效果策略、R用途关系、C组合下一步属于未来扩展。P与C只扩展同一`cli.command-policy.v1`共享命令矩阵，B与R为独立概念关系模型，不选择命令；未来设计不覆盖当前运行图。固定确定函数不强训。具体固定harness及操作回执见[命令调用设计](cli-command-design.md)，并不表示这些后续写/字节/元数据单元已全部接入共享策略训练。

每单元按 [project-design](../workflows/project-design.graph.json) 完成四元素、SESE和最小必要性准入，按 [model-evolution](../workflows/model-evolution.graph.json) 自动采样、复核、训练及采用，回归/冲突交大模型裁决。采用条件只引用 [model-evolution.md](model-evolution.md)，不建平行门槛。真实OS效果、动作选择、参数绑定和知识判断分别计分。

## 5. 操作补全与当前边界

目录/路径操作目录已在 cli-semantic-operations.md 2.1补齐，文件操作在2.2补齐；均映射上述属性变化，不扩大 Goal kind。先完成既有CWD/pwd、cd、直接列举，再逐能力接入目录创建/移动/删除/属性/链接及组合，随后接入文件字节读写、复制等。属性判断在真实输入已具备时可独立推进，不必等待无关操作全部完成。

现有 `observe_cwd/set_cwd/list_directory` 旧 Goal 已由本轮迁移显式退役；运行入口拒绝旧 Goal 对象。PWD/CD/LS 只接受本节第6条的 `file.property` typed 请求，不新增同义 Goal。

设计已覆盖普通路径/目录/文件操作映射、B/P/R/C内部数值设计和独立验收计划。当前已实现：0.2.0 的六个属性算子与 `cli-file-property` 运行绑定、PWD/CD/LS 的 typed 请求/统一结果、批次1的四个新 head（`path.resolve`、`path.relative`、`path.parts`、`entry.inspect`）、typed E/D/F/P 引用与完整 inspect 属性、Stage 1 的 `path.realpath`（`stage1-11x34`）以及当前 Stage 2 的单目录 `directory.select`/`file.select` 与 Track B 纯关系评分（`stage2-13x38`，494 参数）。当前未接入共享命令矩阵：P4–P6 目录/文件变更与字节/元数据操作训练、R用途模型、自动使用采样/采用/裁决执行链。Linux设备/FIFO/socket已定义观测与普通操作的类型拒绝终点；专用创建/设备协议、挂载/ACL等沿命令设计第5节显式范围，不把当前macOS普通文件实测扩展为Linux设备覆盖。设计不授权对用户文件或设备执行破坏操作。

## 6. 0.2.0 已实施切片：PWD/CD/LS typed 请求与统一结果（2026-10-19）

本节是0.2.0运行实现的准入正文，与 `docs/cli-filesystem-training.md` §0.1、`docs/cli-call-contract.md` §1.1 共同生效。本节只覆盖 0.2.0 切片的 sessionCwd observed/equals 与 directory.entries observed；0.3.0 批次1、Stage 1 与当前 Stage 2（`stage2-13x38`）的路径原语、`entry.inspect`、`path.realpath` 与 `directory.select`/`file.select` 已实施并接入运行入口，其合同、实现状态与证据见第7节。

### 6.1 可导入请求形状

```ts
type SessionCwdQuery = {
  kind: "cli.file-query";
  relation: "sessionCwd";
  session: SessionRef;
};

type DirectoryQuery = {
  kind: "cli.file-query";
  relation: "entrySelector";
  scopes: readonly DirectoryScope[];
  selector: { type: "directory"; name?: string };
  cardinality: "one";
};

type CwdGoal = {
  kind: "file.property";
  property: "file.property.relation.sessionCwd";
  target: SessionCwdQuery;
  requirement:
    | { kind: "observed"; freshness: "this_run" }
    | { kind: "equals"; expected: DirectoryRef | DirectoryQuery };
};

type EntriesGoal = {
  kind: "file.property";
  property: "file.property.directory.entries";
  target: DirectoryRef | DirectoryQuery;
  requirement: { kind: "observed"; freshness: "this_run" };
};

type Request = {
  goal: CwdGoal | EntriesGoal;
  satisfactionThreshold: number;
  state: ExplicitFileState;
};
```

`SessionRef` 与 `DirectoryRef` 复用 `lib/adapters/cli/filesystem-sandbox.ts` 的 typed 形状。`SessionCwdQuery` 不允许 `path`、`cwd` 或答案字段；`DirectoryRef` 的 `path` 相对当前 session 解析。`DirectoryQuery` 的 `scopes` 是显式数组，`selector.type` 固定为 `directory`，`cardinality` 固定为 `one`。任何未绑定的 `DirectoryQuery` 形成 typed 未绑定缺口并进入 `DEFER`，不扫描磁盘。

`ExplicitFileState` 保留显式 `session` 与 `cwdObservation`/`directoryListing` 槽位。`CwdKnowledge` 与 `DirectoryKnowledge` 增加 `revision` 与 `sourceRun`，由唯一中性合同 owner 校验；它们不包含 caller 自封的 `trusted` 位。

### 6.2 阈值、证据与受信来源

`satisfactionThreshold` 必填、有限、范围 0..100。实际 `satisfaction` 只取 `0 | 100 | null`，阈值只是最低要求，不替代实际事实。阈值 0 仍要求必要证据；阈值 90 的正常实际值仍是 100；缺必要事实仍是 null。

每次 `.step()` 生成新的 property run 身份。`observed(this_run)` 在动作选择时没有本次证据，必须执行 PWD/LS。`equals` 可复用同一 policy/session 上下文中先前真实观测，但必须同时满足：同一 session、来源真实、当前 revision、物理目录关系成立。策略工厂持有局部观测 authority，只保存该 policy 实际产生的 receipt 标识、revision 与观测对应关系。修改 JSON 中的路径、`sourceRun`、`revision` 或 session 不能取得受信地位。

证据特征分开表达：`knownValue` 表示有合法来源的值可知；`requiredConditionHolds` 表示已知值与要求比较的结果；`hasFreshEvidence` 表示证据当前对本 Goal 适用。过期但来源真实的相等值仍是 `knownValue=1`、`requiredConditionHolds=1`、`hasFreshEvidence=0`，不能 NOOP。未知值使用 `knownValue=0` 与中性 `requiredConditionHolds=0`，不解释成已知 false。

### 6.3 动作表与状态词表

| 输入事实 | 动作与必要结果 |
| --- | --- |
| sessionCwd observed，本次尚无证据（无论旧知识是否存在） | `pwd` |
| directory.entries observed，D 完整（无论旧 listing 是否存在） | `ls` |
| sessionCwd equals，适用真观测证明已等于 D | `NOOP`；`invocation:null`，零 executor |
| sessionCwd equals，适用真观测证明不等 | `cd`；提交后以同一 session 的 CD 回执验证 |
| sessionCwd equals，cwd 未知/过期但 S/D 完整可执行 | `cd`；不因未观测 cwd 一律 DEFER |
| 已注册 Goal，目录仅为合法未绑定 `DirectoryQuery` | `DEFER`；typed `binding_unresolved`，零 executor |
| 结构合法但本轮未注册的 property/predicate | `unsupported`；零 executor，`satisfaction:null` |

未注册 property/predicate 由 harness 结构化判定，不进入打分；`features` 保留，`scores`/`probabilities` 为按 head 长度的全 0 数组。已注册请求才进入共享 softmax，guard 继续按第 6.4 节保留模型错选。

统一顶层 `status` 词表为 `achieved | unmet | unknown | rejected | failed`。旧公开 `unverified` 分支退役。`achieved` 只在必要事实完整且实际 satisfaction=100；`unmet` 表示必要事实已证伪、actual=0；`unknown` 表示必要证据不足、actual=null；`rejected` 表示 typed/guard/绑定拒绝并保留具体原因；`failed` 表示真实必需操作失败。`policy_error`、绑定错误、native/grant 失败、partial 与 CD 后验失败分别保留，不用一个 `unsupported` 覆盖。

### 6.4 统一结果与调用边界

公开 `createCliCommandPolicy({ profile, sandbox, session, onSample?, stage?, entrySelectProfiles? })` 返回的 `.step(request)` 只接受 `{ goal, satisfactionThreshold, state }`。结果至少包含：

```text
goal, satisfactionThreshold, state_before, action, invocation,
policy, policy_error, execution_result, observed_state_after,
satisfaction, status, reason, evidence, collection_result
```

并保留实际 `session_before`/`session_after`、`changed`、CD 后条件等诊断。`NOOP` 与 `DEFER` 的 `invocation` 为 null、`executorInvoked` 为 false。`onSample` 未配置时 `collection_result.status="not_configured"`；回调失败只记录 `collection_result.status="failed"`，不改变已发生业务结果。

边界唯一选择：非法 schema、额外答案字段、坏 ref、跨 session 矛盾、旧 Goal kind 或旧 4×4 profile 直接抛 `TypeError`，零 OS 副作用；结构合法但未注册的 property/predicate 返回 `unsupported` 控制结果。guard 在策略选择后拒绝不可执行/不符合目标约束的 head，保留原 `policy_error`，不改选正确 head、不 mask logits、不把错误计成功。

## 7. 0.3.0 路径原语、条目检查与当前 Stage 2（`stage2-13x38`）合同

本节合同正文已由批次1（I2–I7）、Stage 1（`stage1-11x34`）与当前 Stage 2（`stage2-13x38`）依次实现：gate/红测、typed 语义、adapter、工作流封装、训练与独立验收均已完成。图文件与 `lib/nodes/*` 的实现版本均为 `0.3.0.0000`。

### 7.1 注册切片与共享矩阵（当前 `stage2-13x38` 与历史阶段）

**当前权威合同（`stage2-13x38`）**：注册 **13 个 head、38 条 wire，矩阵为 `13×38 = 494` 参数**。
- 13 个 head 顺序固定为：`unsupported,DEFER,NOOP,pwd,cd,ls,path.resolve,path.relative,path.parts,path.realpath,entry.inspect,directory.select,file.select`（其中 `path.realpath` 在 Stage 1 加入，`directory.select` 与 `file.select` 在 Stage 2 加入）。
- property 块按属性目录次序注册 **15 列**：`path.absolute`、`path.relative`、`path.parent`、`path.name`、`path.physical`、`exists`、`type`、`directory.entries`、`size`、`mode`、`owner`、`times`、`link.target`、`entry.identity`、`relation.sessionCwd`。
- predicate 块按顺序注册 **10 列**：`observe.absolute`、`observe.relative`、`observe.parts`、`observe.physical`、`observe.inspect`、`observe.resolvedTarget`、`observe.sessionCwd`、`equals.sessionCwd`、`observe.entries`、`select.entry`。
- `selectorTargetType` 块注册 **3 列**：`selectorTargetType.unspecified`、`selectorTargetType.regular`、`selectorTargetType.directory`。
- state 块为 **4 列**（`state.hasFreshEvidence`、`state.knownValue`、`state.requiredConditionHolds`、`state.hasDestinationRef`），search 为 **1 列**（`search.nameNeedleSegment`），交互项为 **1 列**（`state.requiredConditionHolds*state.hasFreshEvidence`）；`hasSessionRef` 保持常量，不注册。
- property 与 predicate 的 wire 名沿用现有前缀，分别为 `property.<后缀>` 与 `predicate.<标签>`。因此 `F = 4 + 15 + 10 + 3 + 4 + 1 + 1 = 38`、`K = 13`，当前矩阵为 `13×38 = 494` 参数。

**命名迁移 `11×34 -> 13×38` 与 Stage 1 旧边界**：
- 从 Stage 1（`stage1-11x34`，11 head × 34 wire = 374 参数）迁移到当前 Stage 2（`stage2-13x38`）由 `migrateCliCommandProfileStage1ToStage2` 显式执行：**全部 374 个已有 `(head, wire)` 交叉位置按精确名称原值复制**，新增 `directory.select`、`file.select` 两个 head 与 `predicate.select.entry`、`selectorTargetType.unspecified/regular/directory` 四条 selector wire 共 **120 个位置补零**，合计 **494 参数**（`374 + 120 = 494`）。零填充只保证结构兼容，不证明 softmax 无回归。
- Stage 1（`stage1-11x34`，不含 `directory.select`/`file.select` 及上述四条 selector wire，共 `11×34 = 374` 参数）仍作为显式旧边界（传入 `stage: "stage1-11x34"`）按自身 11×34 矩阵推理，不静默降级或自动混用。

**历史矩阵记录（不再作为当前默认矩阵）**：0.3.0 批次1 基础矩阵注册 10 个 head（不含 `path.realpath`、`directory.select`、`file.select`）与 30 条 wire（14 列 property、7 列 predicate，不含 `path.physical`、`observe.physical`、`observe.resolvedTarget`、`select.entry`、`selectorTargetType` 与 `search.nameNeedleSegment`），共 `10×30 = 300` 参数（从旧 `6×14 = 84` 按名复制 84 项、其余 216 项补零）；P3 增量 A 在 `10×30` 上追加 `search.nameNeedleSegment` 形成 `10×31 = 310` 参数；Stage 1 从 `10×31` 按名复制 310 项并补零 64 项形成 `11×34 = 374` 参数。

当前 Stage 2 已注册 `selectorTargetType`、`predicate.select.entry`、`path.physical`、`observe.physical`、`observe.resolvedTarget`、`path.realpath`、`directory.select` 与 `file.select`。当前仍不注册 `observedType`、`requiredTargetType`、`combination` 块，不注册 `followSymlinks` wire、`hasSessionRef` 或 `file.property.links`；`followSymlinks` 只作为 `entry.inspect` 的 typed 执行参数。

### 7.2 typed 引用与身份

```ts
type EntryType = "regular" | "directory" | "symlink" | "character_device"
  | "block_device" | "fifo" | "socket" | "other";
type OsInteger = number | string | null; // number-safe | string-decimal | null

type PathRef = Readonly<{
  kind: "cli.path";
  scenarioId: string;
  sessionId: string;
  path: AbsolutePath;             // 明确路径，不保证存在、类型或对象身份
}>;

type ObservedObjectRef = Readonly<{
  kind: "cli.entry" | "cli.file" | "cli.directory";
  scenarioId: string;
  sessionId: string;
  type: EntryType;
  identity: Readonly<{ dev: OsInteger; ino: OsInteger }>;
  sourceRun: string;
  sessionRevision: number;
  absolutePath: AbsolutePath;
}>;
```

`cli.path` 是批次1新增的 P 引用，只做 schema 与场景归属校验；词法操作不 stat，也不要求路径存在。`cli.entry` 与 `cli.file` 是新增的 E/F 对象引用；D 继续复用 `cli.directory`。E/D/F 对象引用必须携带或显式关联已观测的 `{type,identity:{dev,ino},sourceRun,sessionRevision,absolutePath}`，由 sandbox 的绑定 API 生成并由其 authority 验证。引用不得从业务 metadata、日志或旧路径字符串重建。

旧 D 的四字段形状 `{kind:"cli.directory",scenarioId,sessionId,path}` 继续服务旧 `cd`/`ls`。它缺少对象身份时用于 `inspect` 必须返回 unknown 与 `binding_identity_missing`，不得静默降级为 P，也不得用遗留路径继续执行。`followSymlinks=true` 时先 `lstat` 核对来源条目身份，再 `stat` 目标；链接自身身份与解析目标身份分别保存，不能直接把链接自身 ino 与目标 ino 比较。session revision 变化、身份/类型不再匹配或引用过期时返回 stale/rejected，不猜测新对象。

事件与校验契约：两张持久图的端口事件名保留 `cli.*.v1`，不因本次载荷扩展改名；`cli.file-property.*` 与 `cli.command.training.*` 的 `operator_version` 与对应 `NodeDefinition.version` 均已同步为 `0.3.0.0000`，并用显式联合类型重新编译；不能把旧 6×14 形状当运行兼容。运行 schema 校验按本节的显式联合类型升级，默认校验 `stage2-13x38`（并支持显式 `stage1-11x34` 旧边界），不接受未迁移的旧 6×14/10×30/10×31 形状、不按行索引猜兼容，也不复用未注册的 property/predicate 对。新增 `cli.path`、`cli.entry` 与 `cli.file` 引用由版本化验证器识别；旧四字段 D 之外的多余字段按非法 schema 拒绝。

### 7.3 entry.inspect 属性值

| property | typed 值与缺测合同 |
| --- | --- |
| `exists` | `{entryExists,resolvedTargetExists}` 按明确 follow 模式投影为 boolean；错误失败不写 false |
| `type` | 完整 8 类，来自 OS stat mode/API，不按后缀或路径猜测 |
| `size` | 精确 `sizeBytes`；目录值不表示子树大小 |
| `mode` | POSIX mode/permission bits；不表示 ACL 或有效可访问性 |
| `owner` | `{uid,gid}` |
| `times` | atime/mtime/ctime/birthtime 及观测精度；不可用项为 null |
| `link.target` | follow=false 时的 readlink 原文；非链接为不适用 unknown；follow=true 不伪造目标文本 |
| `entry.identity` | `{dev,ino,nlink,rdev}`；逐项缺测 null。rdev 仅在设备语义有效；普通条目可保留 OS 原值并标明非设备，不能把 0 当缺测 |

OS 整数使用 bigint 读取。超出安全整数时以固定十进制字符串保真，不用 JSON Number 截断；同一公开值 schema 明确为 `number-safe|string-decimal|null`。`nlink` 是观测计数，不证明另一个路径与其同对象。跨条目硬链接关系 `file.property.links` 不在本批。

### 7.4 OS 错误与满足度终点

明确 P 且 `followSymlinks=false` 的本次 ENOENT 是有效观测：`exists=false` 可达 100；其余依赖对象的属性没有值，按 failed/0 保留。ENOTDIR、EACCES、EPERM 与 ELOOP 均不得写成 `exists=false`。`followSymlinks=true` 的 ENOENT 必须区分 `entryExists` 与 `resolvedTargetExists`：链接自身可存在而解析目标不存在。E/D/F 的 ENOENT 按失效引用处理，不能标成“普通的 P 不存在”。

身份不足或属性不适用时为 unknown/null；已证不匹配为 unmet/0；guard 或 typed 绑定拒绝为 rejected/0；非法 schema、额外答案字段、坏 ref、跨 session 矛盾沿公开 `TypeError` 异常边界，零 OS 副作用。OS 调用失败与属性结果分开记录，不以错误填充假值。

### 7.5 平台边界

`block_device` 保留在完整类型联合中。本机 macOS 没有真实 fixture 时，其 native 证据必须标 `UNVERIFIED`；不得用 `mknod`、sudo 或其他伪设备方式伪造。FIFO、socket 与 symlink 必须在沙盒内真实构造并保留证据，不能只靠注入或 mock 宣称实测。未知平台能力保持缺测，不阻塞其他属性。

## 8. 0.3.0 Slice 3：SC 正式命令搜索产品接入（2026-10-28）

公开入口 `nnanything/cli-command-search`（`runCliCommandSearchGoal`）。本切片只接入产品级命令搜索的递归执行与领域投影，不训练、不改权重/阈值/采用状态。Slice 2 的 `command-search-contract.ts` 与 `cli-command-search.ts` 过滤/模型层为唯一 owner，本切片复用。

### 8.1 有限切片边界

- 公开域只接受两个根目标：
  - `file.property.content.bytes` + `requirement.kind = "contains_literal"`：字面量搜索，执行 `directory.search.content`；
  - `file.property.directory.entries` + `requirement.kind = "matches_target"`：文件名/类型匹配，执行 `directory.search.entries`。
- 范围（`cli.command-search-scope.scopeRefs`）支持单槽 `one|all` 与双槽主备；双槽位 `cardinality = "one"` 启用 `s1` 主备回退（`s0` 命中即早停，`s1` 未搜索）；**双槽位 `cardinality = "all"` 在公开边界显式抛出 `TypeError` 拒收**，因为多范围无法定义全局 `all` 命集合。
- 受控读取（`requirement.followUpRead`）仅经 `sandbox.bindFile` 签发的 `ObservedObjectRef` 执行 `file.read` / `file.read.lines`，不绕开沙箱身份校验。

### 8.2 执行与身份边界

- 所有 `directory.search.entries` / `directory.search.content` 只经 `sandbox.execute` 生成真实 `SemanticCallReceipt`；禁止 adapter 私自 spawn 或硬编码路径。
- `scopeRefs` 中每个 `DirectoryRef` 必须已由 `sandbox.bindDirectory` 签发；伪造/未签发引用返回 `status = "rejected"`、`resolution = "rejected"`、`totalProcessSpawns = 0`（底层 `binding_identity_missing`）。
- 缺少 `process.exec` / `filesystem.read` 授权时同样 `rejected/0`，`executorInvoked = false`。
- 最终目录为 symlink、或子目录内指向沙盒外的 symlink 在被禁止跟随时，不发生越界读取。

### 8.3 公开 domain 投影与冻结元数据

投影只暴露设计真源 §4.3 的正式词汇：`status`、`resolution`、`satisfaction`、`coverage`、`reasons`、`matchedEntries`、`matchedLines`、`readReceipt`、`issuedRefs`、`searchCommandSpawns`、`probeCommandSpawns`、`spawnLedger`、`stepTrace`、`modelMetadata`。

- `modelMetadata` 冻结为 `{ ref, schema: "cli.hybrid-package.v1", calibration: "uncalibrated", adoption: "not_applied" }`；**不含任何 hash/digest/sha256/checksum 字段**，也不对 `ref` 注入身份摘要。
- `stepTrace` 携带真实 `R`（14 维）/ `E`（19 维）/ `D`（26 维）/ `A`（6 维）logits 与每步 `command` 操作，作为运行证据；不进入满足度判定。
- 结局映射（唯一断言标准）：
  - 单/双槽命中完成或 `one` 早停：`achieved / matched / 100 / complete|partial`；
  - 全部槽位完整搜索且 0 命中：`unmet / not_found / 0 / complete`，`reasons = ["no_matching_entries"]`；
  - 覆盖不完整（`EACCES` / `maxStdoutBytes` / `maxDepth` 截断）：已有命中为 `unknown / partial / null / partial`，0 命中为 `unknown / insufficient_evidence / null / partial`；
  - 预算耗尽（如 `maxTransitions`）：`unknown / budget_exhausted / null`，`preserve.continuation != null`；
  - `effect_denied` / `invalid_binding` / `adapter_contract_invalid`：`rejected / rejected / null`；
  - `continuation` 与 `modelRef` 不一致（异版本或异 requestId）拒绝为 `rejected`。
