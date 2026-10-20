# 文件系统沙盒与共享命令模型增量训练

状态：实施合同。0.2.0 的 typed `file.property` PWD/CD/LS 切片、统一控制结果、旧六参数链退役和单一6×14候选真实拟合已经实现；作者定向回归与回载证据保留，但本页不把它们扩展为0.3.0成绩。I1 已落盘 0.3.0 的 10 head、30 wire、10×30 矩阵和两张图合同；I2–I7 尚未执行，未改产品代码或测试。实测计数、计时和run记录见[共享模型实测](cli-filesystem-training-results.md)，本文不重复历史表。本文是全命令统一共享模型与增量训练的唯一权威合同。总体Goal/State定义见[总体设计1.1](design.md#11-结构化语义的目标与状态推理)；调用与资源信封见[参数简化合同](cli-call-contract.md)；精确操作与固定映射见[语义目录](cli-semantic-operations.md)。
2026-10-19 设计扩展：PWD/CD/LS迁移已完成；批次1新增路径词法原语与`entry.inspect`合同，后续再补目录/文件变更。所有新语义统一为[file.property.xxx](cli-filesystem-semantics.md)，内容、用途、条件与能力关联均归为属性判断和属性状态变化，复用`cli-file-property.graph.json`，不零散增加Goal。B对象查找、其余目录/文件操作、特殊文件扩展及自动采用仍为设计，不靠文档冒称已运行。

用户已选择真实文件系统中的专用沙盒目录，不声称硬件、虚拟机或操作系统权限隔离。PWD/CD/LS 的 `file.property` 切片已接入运行入口；B对象查找、未来22个操作与特殊文件扩展仍为设计，不将静态图校验称为这些未来执行器已实现。

## 0. 固定四元素与满足度评价

当前属性入口要求调用显式提供 `satisfactionThreshold`（有限 0..100），运行时不能从 profile 或环境选择。公开 `CliCommandGoalResult` 保存实际 `satisfaction: 0 | 100 | null` 与请求阈值；阈值只是最低要求，不替代实际事实。旧固定 `CLI_COMMAND_GOAL_CONFIG` 已退役。

### 0.1 0.2.0运行切片与0.3.0合同注册（2026-10-19）

0.2.0 运行入口只接 sessionCwd 的 `observed(this_run)`/`equals` 与 directory.entries 的 `observed(this_run)`，其6×14证据继续有效。0.3.0 合同新增 `path.resolve`、`path.relative`、`path.parts`、`entry.inspect`，以下注册表现为 I2–I5 的唯一目标；当前源码校验器尚未切换，不得把合同标成已运行。

| 项 | 当前注册值 |
| --- | --- |
| heads | `unsupported`, `DEFER`, `NOOP`, `pwd`, `cd`, `ls`, `path.resolve`, `path.relative`, `path.parts`, `entry.inspect`（K=10） |
| wires | `bias`, `goalObserveCwd`, `goalSetCwd`, `goalListDirectory`（legacy，顺序固定） |
| property 块 | `property.path.absolute`, `property.path.relative`, `property.path.parent`, `property.path.name`, `property.exists`, `property.type`, `property.directory.entries`, `property.size`, `property.mode`, `property.owner`, `property.times`, `property.link.target`, `property.entry.identity`, `property.relation.sessionCwd`（14列） |
| predicate 块 | `predicate.observe.absolute`, `predicate.observe.relative`, `predicate.observe.parts`, `predicate.observe.inspect`, `predicate.observe.sessionCwd`, `predicate.equals.sessionCwd`, `predicate.observe.entries`（7列） |
| state 块 | `state.hasFreshEvidence`, `state.knownValue`, `state.requiredConditionHolds`, `state.hasDestinationRef` |
| interaction | `state.requiredConditionHolds*state.hasFreshEvidence` |
| 常量记录 | `hasSessionRef` 恒为 1，不注册；`followSymlinks` 是`entry.inspect` typed参数，不注册wire |
| 矩阵 | F=4+14+7+4+1=30；K=10；10×30 = 300 参数 |

`selectorTargetType`、`requiredTargetType`、`observedType`、`combination` 块在批次1不注册；`path.physical`、`observe.physical`、`observe.resolvedTarget`、`file.property.links`及`path.realpath`也不注册，不预留占位列。未注册 property/predicate 返回 `unsupported`。同分顺序为 `unsupported` > `DEFER` > `NOOP` > 其余按 head 表。

未注册 property/predicate 由 harness 结构化判 `unsupported`，不进入打分；`scores`/`probabilities` 为按 head 长度的全 0 数组。只有已注册请求进入共享 softmax。

控制 head 与执行 head 进入同一全 head softmax，不按 P1-P6 分族 mask。guard 只在策略选择后拒绝不可执行/不符合目标约束的 head。

legacy 四 wire 从 typed 语义直接计算，不调用 `expectedCliCommand` 或 teacher head：

```text
bias = 1
goalObserveCwd = 1  <=>  sessionCwd + observed(this_run)
goalSetCwd    = 1  <=>  sessionCwd + equals
goalListDirectory = 1  <=>  directory.entries + observed(this_run)
```

顶层结果 `status` 统一 `achieved/unmet/unknown/rejected/failed`；旧公开 `unverified` 分支退役。`NOOP` 的 `invocation` 为 null 且零 executor；`DEFER` 返回 typed `binding_unresolved`。

### 0.2 单权重迁移规则（显式离线工具）

迁移分两级且都必须显式执行。旧 `cli.command-policy.v1` 4×4 对象先按 name 复制 `[unsupported,pwd,cd,ls]×[bias,goalObserveCwd,goalSetCwd,goalListDirectory]` 交叉块到6×14；然后把6×14的84个已有交叉位置按name原值复制到10×30，新增 `path.resolve`、`path.relative`、`path.parts`、`entry.inspect` 四行及16个新列补零。任何迁移都不得按索引复用权重。旧六参数 `cli.goal-policy.v1` 没有迁移目标，物理退役。

迁移后可复现旧四行 logits 在对应语义样本上的数值。这不证明 softmax 概率不变，也不证明新增行不改变 argmax；两种预测对照（零权重与迁移后不更新参数）只做预测，不执行命令。

| 单元 | Goal / satisfactionThreshold | State | Action与达标事实 |
| --- | --- | --- | --- |
| PWD | `file.property.relation.sessionCwd` observed(this_run)；显式 0..100 | 显式S、旧知识及来源、harness执行条件 | 共享模型选`pwd`；harness执行本次真实观测；S.cwd/revision不变且证据属于本次S |
| CD | 同属性 equals 目标D；显式 0..100 | S当前执行基准、D typed绑定、授权及旧知识 | 共享模型选`cd`或`NOOP`；NOOP只在适用真观测证明已等于D时正确；执行时提交S并以同一回执验证后条件 |
| LS | `file.property.directory.entries` observed(this_run)；显式 0..100 | S、D、旧目录知识及执行条件 | 共享模型选`ls`；harness返回本次完整、有类型证据的直接列举，S不变 |
| CWD关系 | 正确判定候选知识是否属于查询S；100 | 查询引用、候选观测槽位；学生输入仍为`sameSession/hasObservation` | 计算既有六参数模型，输出`MATCH/NO_MATCH`；有监督时正确为100、错误为0，无评价真值时未知 |

PWD、LS 要求本请求的新证据；CD 在适用真观测证明已等于 D 时以 NOOP 完成，否则执行。旧知识、同目标 CD 或关系 `MATCH` 均不提前完成 `observed(this_run)`。State、授权与阈值进入当前切片；学生从 typed Goal/State 特征学习 head 选择。训练期反推关系为 `Goal + 阈值 → 必需实际New State/证据 → 所需命令 → harness前置条件`。这是监督和样本设计关系，不是数值梯度反传；既有Handwired梯度路径不变。

| 实际路径 | Goal结果 | 边界 |
| --- | --- | --- |
| PWD成功，本次观测有效且S未变 | `achieved / 100` | 写入本次cwd知识及来源 |
| PWD native OS失败 | `failed / 0` | 本请求新观测未完成；旧知识保留，不评价未知真实cwd |
| PWD grant拒绝、错命令头被guard拒绝或目标引用不匹配 | `rejected / 0` | 保留grant、`policy_error`或目标绑定错误，不执行错误动作 |
| 未支持或没有定义评价规则的 property/predicate | `unknown / null` | `execution_result.status=unsupported`，不调用executor |
| CD提交前native失败 | `failed / 0` | S不变；旧cwd已等于目标也不能算本请求完成 |
| CD提交前grant/绑定/guard拒绝 | `rejected / 0` | S不变，保留具体拒绝原因 |
| CD提交后同S新PWD与目标一致 | `achieved / 100` | 保留真实提交、新观测及副作用 |
| CD已提交，后续观测失败或证据不足 | `unknown / null` | 保留新S、实际`changed`及失败回执，不回滚 |
| CD后续观测有效且明确不匹配 | `unmet / 0` | 保留实际改变，不以未知覆盖已证失败 |
| LS完整且全部必要类型有证据，S未变 | `achieved / 100` | 写入本次完整目录知识 |
| LS native失败 | `failed / 0` | 本请求新列举未完成，旧知识保留 |
| LS grant/绑定/guard拒绝 | `rejected / 0` | 保留具体拒绝原因，旧知识保留 |
| LS partial、类型unknown或必要条目证据不足 | `unknown / null` | 不定义比例满足度，不覆盖旧完整知识 |
| 已证发生禁止的cwd/revision副作用 | `unmet / 0` | 必要条件为假，即使产生观测也不能达成 |

`equals`的正确动作表、证据适用性与受信来源机制见[属性合同](cli-filesystem-semantics.md)第6节；非法schema/旧Goal/旧profile的`TypeError`边界见[参数简化合同](cli-call-contract.md)§1.1。

`changed`只表示实际session的cwd/revision变化，不表示知识变化或目标成败。PWD/LS新增知识可以为`changed:false`；CD验证失败仍可能为`changed:true`。`satisfactionThreshold`只是调用者要求，不提高模型分数、执行成功或harness权限的效力，满足度也不代替真实Goal验收。

两个CLI可训练单元按公共设计资料流和升级对象流挂接，不复制公共规则：

| 单元 | 设计流程 | 单元升级与冲突 | 当前状态 | 具体缺口 |
| --- | --- | --- | --- | --- |
| 共享命令模型 | `workflows/project-design.graph.json` | `workflows/model-evolution.graph.json`、`workflows/model-conflict-design.graph.json` | 离线增量训练、保存后新进程回载、独立评价及旧命令回归已有证据；候选`uncalibrated/not_applied` | 使用样本自动采集、显式当前版本引用、自动配对比较采用、自动冲突移交及LLM裁决执行链未实现 |
| CWD关系模型 | `workflows/project-design.graph.json` | `workflows/model-evolution.graph.json`、`workflows/model-conflict-design.graph.json` | 六参数关系分类、历史离线评价及回载证据保留；不作为命令selector | 使用样本自动采集、显式当前版本引用、自动比较采用、自动冲突移交及LLM裁决执行链未实现 |

下一步顺序沿公共合同：先补自动使用采集及使用/候选隔离，再补当前版本与配对比较/自动采用，最后补冲突裁决执行链。当前不得把自动升级、自动采集或LLM裁决写成已完成。

## 1. 统一共享命令模型

本项目使用单一共享模型与权重profile承载所有已注册的CLI命令与当前控制结果：

- 合同标识：`cli.command-policy.v1`
- 命令头（heads）：`unsupported`, `DEFER`, `NOOP`, `pwd`, `cd`, `ls`, `path.resolve`, `path.relative`, `path.parts`, `entry.inspect`
- 输入连线（wires）：4 条 legacy + 14 条 property + 7 条 predicate + 4 条 state + 1 条 interaction，共30
- 0.3.0合同参数结构：10×30，共300个参数
- 状态属性：`calibration: "uncalibrated"`, `adoption: "not_applied"`
- 同分规则：稳定顺序，`unsupported`优先；结果严格按teacher计分

模型接收 typed `file.property` Goal与State；profile、sandbox与会话在策略工厂绑定：`createCliCommandPolicy({ profile, sandbox, session: S })`，每次调用只传`step({ goal, satisfactionThreshold, state })`。请求没有`resources`、`directories` 或独立 `directory` 字段。所有head的模型输出调用序列首项取自命令头，legacy三head是小写实际Shell命令名，新增head使用稳定点号动作id；后续项是机械绑定的typed位置参数引用，模型不生成自由参数文本。调用首项与typed参数顺序见§2.2：
- `sessionCwd observed` → `["pwd"]`（harness执行固定PWD观测）
- `sessionCwd equals D` → `["cd", D]` 或 `NOOP`（已满足且证据适用时不执行；否则提交S并以同一回执验证）
- `directory.entries observed` → `["ls", D]`（harness通过固定编译结构化helper列举）
- `path.absolute observed` → `["path.resolve", P, PathText]`（固定词法解释器，不访问FS）
- `path.relative observed` → `["path.relative", from, to]`（固定`path.posix.relative`）
- `path.parent`或`path.name` observed → `["path.parts", P]`（固定dirname/basename）
- `entry.inspect`属性 observed → `["entry.inspect", ref, followSymlinks]`（固定stat/lstat/readlink）
- 合法未绑定 `DirectoryQuery` → `DEFER`，`invocation: null`，零 executor
- 未注册 property/predicate → `unsupported`，`invocation: null`，`executorInvoked: false`

示例（set_cwd）：

```ts
const policy = createCliCommandPolicy({ profile, sandbox, session: S });
const transition = await policy.step({
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

`DirectoryRef.path`在调用时相对S当前cwd解析；CD提交后，调用者必须重新绑定相对引用。`DirectoryQuery` 是合法但未完成的目录绑定，本轮进入 `DEFER`。命令头预测错误时，guard拒绝执行但仍记录`policy_error`，不能把错误伪装成`unsupported`或OS失败。

历史独立的二分类CD/LIST模型合同已退役。旧六参数PWD API（`cli.goal-policy.v1`）本轮物理退役；旧 4×4 共享 profile 只能经显式离线迁移工具转换。CWD关系是独立概念测量：`MATCH/NO_MATCH`，`x=[1, sameSession, hasObservation]`，共6个参数；历史16/8只是样本计数，不产生命令selector。

## 2. 递进增量训练（Curriculum）

历史共享候选曾按三阶段递进训练。本轮实施改为单阶段：从旧 4×4 候选显式迁移到 6×14 后一次真实拟合并保存同一 profile。以下三阶段表只记录旧候选来源与旧能力回放，不再产生 4/9/16 参数的独立保存候选：

| 阶段 | 动作集合 | 输入wires | 参数规模 | 输入起点与扩展规则 | 训练资料构成 |
| --- | --- | --- | ---: | --- | --- |
| 1. PWD | `unsupported`, `pwd` | `bias`, `goalObserveCwd` | 2×2=4 | 零初始化 | PWD正例 + 真实unsupported负例 |
| 2. CD | 追加 `cd` | 追加 `goalSetCwd` | 3×3=9 | 加载上一阶段保存的PWD候选；按名称扩展，新增行与列补零 | CD新正例 + PWD历史行全量回放 + unsupported |
| 3. LS | 追加 `ls` | 追加 `goalListDirectory` | 4×4=16 | 加载上一阶段保存的CD候选；按名称扩展，新增行与列补零 | LS新正例 + PWD/CD历史行全量回放 + unsupported |

注意：按名称扩展补零仅保证初始结构兼容，绝不代表数学上必然无回归（补零仍可能改变softmax分母与argmax）。每阶段必须同时记录：
1. 扩展后冻结对照：使用扩展后的初始矩阵且不做参数更新（等价初始状态`epochs:0`），只做预测。
2. 零权重对照：只做预测，不执行命令。
3. 真实Handwired拟合后候选（200 epochs，lr 0.1，源码根 `/Volumes/extension/code/handwired`）。
4. 历史命令逐项回归与逐命令独立统计（fixed / regressed / retained / unresolved）。

数值拟合器自身的`epochs:0`路径由作者单独测试，不属于上述两个预测对照。

### 2.1 共享矩阵的唯一扩展规则

所有命令/操作选择只有同一`cli.command-policy.v1`共享profile。P1-P6是样本、统计和效果分组，不是部署单元；不得为P1-P6分别保存profile、路由selector或候选。B对象关系与R用途是独立概念模型，不输出命令head；C组合下一步若选命令，复用本节同一共享矩阵。

保留规则：保留旧 head/wire 的名称、语义和按名对应系数。`bias`、`goalObserveCwd`、`goalSetCwd`、`goalListDirectory`四条legacy wire按名保留并排在wire表最前。批次1采用§0.1的十 head、14 property与7 predicate固定顺序；旧行索引不作为迁移依据，迁移一律按name查找，不得按位置复用旧权重。旧四 head 与旧6×14对象仅作显式离线迁移输入。

批次1 head表固定顺序为：`unsupported`、`DEFER`、`NOOP`、`pwd`、`cd`、`ls`、`path.resolve`、`path.relative`、`path.parts`、`entry.inspect`。文件§2.2列出完整25操作设计目录；本批只注册这10个head，其余操作在后续批次按依赖逐个扩展，不为`path.realpath`或其他未来head预留空行。`DEFER`与`NOOP`是控制head，不执行shell。四 head（`unsupported,pwd,cd,ls`）是迁移前历史阶段，不是当前阶段。

wire表按固定块顺序拼接，块间不交错：

| 块 | wire | 注册条件 |
| --- | --- | --- |
| legacy | `bias`、`goalObserveCwd`、`goalSetCwd`、`goalListDirectory` | 恒存在 |
| property | `property.<属性键后缀>` | 当前阶段或必需旧回放实际使用该属性 |
| predicate | `predicate.<predicate标签>` | 当前阶段或必需旧回放实际使用该predicate |
| selectorTargetType | `selectorTargetType.unspecified/regular/directory` | 阶段含`select.entry`类predicate时整块注册 |
| requiredTargetType | `requiredTargetType.unspecified/regular/directory/symlink` | 阶段含P4目标类型条件时整块注册 |
| observedType | `observedType.regular/directory/symlink/character_device/block_device/fifo/socket/other/unobserved` | 阶段需要实际观测类型时整块注册 |
| state | `state.hasFreshEvidence`、`state.knownValue`、`state.requiredConditionHolds`、`state.hasSourceRef`、`state.hasDestinationRef`、`state.hasParentRef`、`state.hasSessionRef`、`state.hasPayload` | 逐条按阶段需要注册 |
| interaction | `state.requiredConditionHolds*state.hasFreshEvidence` | 两个乘数都注册且该交互非恒定时注册 |
| combination | `combo.predicate.<7项>`、`combo.state.<15项>` | 仅C阶段注册，逐条按需要 |

块内顺序固定：property按[属性合同](cli-filesystem-semantics.md)第2节目录次序，predicate按[属性训练设计](cli-property-training-design.md)的P1→P6表序，其余块按上表列出次序。合并算法为：按上述块顺序收集；同name且定义相同只保留首个，同name定义冲突报错。legacy四列及既有profile已注册列始终保留；新增可选wire若在当前阶段全部训练与必需旧回放行中恒定，则不注册，记录为常量。声明整块注册的类型块保留完整one-hot词表，不逐列消融。由此`F`可唯一计算：

```text
F = 4
  + N_property
  + N_predicate
  + 3*selectorBlock
  + 4*requiredTypeBlock
  + 9*observedTypeBlock
  + N_state + N_interaction
  + N_combination
K = 1(unsupported) + 2(DEFER,NOOP) + 3(pwd,cd,ls) + N_newExecutable
矩阵 = K × F
```

`N_*`是注册后的实际数量，`selectorBlock/requiredTypeBlock/observedTypeBlock`为0/1。只有实际阶段需要的wire才注册，不为未来块预留恒定空列。示例：若某阶段注册16个property、25个predicate、3维selectorTargetType、4维requiredTargetType、9维observedType、8个state位、1个交互项、无combination，则`F=4+16+25+3+4+9+8+1=70`；`K=1+2+3+22=28`；矩阵28×70=1960参数。该示例只说明计数方法，不是部署声明。

0.2.0运行schema实现于`lib/filters/cli-command-policy.ts`的`validateCliCommandProfile`，当前只接受6个head与14条wire；0.3.0由I3升级为§0.1登记的10个head与30条wire，并保存精确`properties`/`predicates`顺序。旧 4×4 与旧6×14 profile由显式离线迁移转换，运行入口拒绝旧形状。`selectorTargetType`/`requiredTargetType`/`observedType`/`combination`块、`path.realpath`及剩余操作head仍为设计，不因0.3.0合同已落盘就冒称已接入。

### 2.2 新动作进入同一heads词表（25精确操作映射）

新增动作不建第二套词表，直接进入§2.1的同一head表。`cwd.get`、`cwd.set`、`directory.list`复用既有`pwd`、`cd`、`ls`行，不再加同义别名；批次1注册`path.resolve`、`path.relative`、`path.parts`、`entry.inspect`，`path.realpath`及其余操作保留为后续设计，不进入本批profile。调用输出统一为`[head, ...typed位置参数]`；参数顺序按本表，对象值参数保持一个typed对象。模型不生成argv、flags、shell文本或可执行路径；harness只把选定head映射到固定adapter并按类型绑定参数，绝不根据Goal改选或补选动作。

| operation | head | 调用首项与typed参数（顺序） | adapter | 执行shell |
| --- | --- | --- | --- | --- |
| `cwd.get` | `pwd` | `["pwd"]` | 既有`/bin/pwd -P` | 是（legacy例外） |
| `cwd.set` | `cd` | `["cd", D]` | 既有固定CD脚本 | 是（legacy例外） |
| `directory.list` | `ls` | `["ls", D]` | 既有固定结构化helper | 否 |
| `path.resolve` | `path.resolve` | `["path.resolve", P, PathText]` | 既有词法解释器 | 否 |
| `path.relative` | `path.relative` | `["path.relative", from, to]` | 固定纯函数`path.posix.relative` | 否 |
| `path.parts` | `path.parts` | `["path.parts", P]` | 固定纯函数`dirname/basename` | 否 |
| `path.realpath` | `path.realpath` | `["path.realpath", ref]` | 固定helper/OS realpath | 否 |
| `entry.inspect` | `entry.inspect` | `["entry.inspect", ref, followSymlinks]` | 固定helper/OS stat/lstat/readlink | 否 |
| `directory.select` | `directory.select` | `["directory.select", selector, candidates, coverage]` | 纯关系节点 | 否 |
| `file.select` | `file.select` | `["file.select", selector, candidates, coverage]` | 纯关系节点 | 否 |
| `directory.create` | `directory.create` | `["directory.create", {parent:D,name}]` | 固定helper `fs.mkdir` | 否 |
| `file.create` | `file.create` | `["file.create", {parent:D,name}]` | 固定helper `O_CREAT\|O_EXCL` | 否 |
| `link.create` | `link.create` | `["link.create", {parent:D,name}, targetText]` | 固定helper `fs.symlink` | 否 |
| `file.link` | `file.link` | `["file.link", source, {parent:D,name}]` | 固定helper link | 否 |
| `entry.move` | `entry.move` | `["entry.move", source, {parent:D,name}]` | 固定helper/native no-replace rename | 否 |
| `entry.remove` | `entry.remove` | `["entry.remove", entry]` | 固定helper unlink/rmdir | 否 |
| `file.read` | `file.read` | `["file.read", file, offset, length]` | 固定helper read | 否 |
| `file.replace` | `file.replace` | `["file.replace", file, content]` | 固定helper truncate+write | 否 |
| `file.write` | `file.write` | `["file.write", file, offset, content]` | 固定helper positional write | 否 |
| `file.append` | `file.append` | `["file.append", file, content]` | 固定helper `O_APPEND` write | 否 |
| `file.truncate` | `file.truncate` | `["file.truncate", file, length]` | 固定helper `ftruncate` | 否 |
| `file.copy` | `file.copy` | `["file.copy", source, {parent:D,name}]` | 固定helper copy | 否 |
| `entry.mode.set` | `entry.mode.set` | `["entry.mode.set", entry, mode]` | 固定helper `fchmod` | 否 |
| `entry.owner.set` | `entry.owner.set` | `["entry.owner.set", entry, uid, gid]` | 固定helper `fchown` | 否 |
| `entry.times.set` | `entry.times.set` | `["entry.times.set", entry, atime, mtime]` | 固定helper `futimes` | 否 |

legacy三行的首项是实际小写命令名；新增行的首项是稳定语义动作id。两者都在同一head表，输出都沿用`[head, ...typed位置参数]`首项约定，因此不并存"原生命令名"与"语义动作id"两套写法，也不产生重复别名。head到adapter的映射固定在代码中；模型只能选head，不能选adapter、helper路径或OS API。

### 2.3 file.property迁移、对照与回归

扩展同一阶段时，输入是上一保存候选，按name迁移：对每个新head与wire，若旧profile已有同名行/列则复制旧交叉块，否则补零。批次1从旧6×14候选扩展到10×30：84个已有交叉位置按name原值复制，新增4行与16列补零；`path.resolve`、`path.relative`、`path.parts`、`entry.inspect`不复制任何旧行。旧交叉块按name保留，不按索引复用；不改写、不重置已有系数。零填充只保证结构兼容，不保证softmax无回归：新增行/列会改变softmax分母与argmax，必须实测。

同一阶段必须回放全部必需旧行：`pwd`、`cd`、`ls`、真实`unsupported`，并按新样本要求加入本批4个新head/property/predicate行。旧行保留原teacher head，不得改标为REJECT。每阶段分别设计并记录下列四项：

1. 扩展后冻结对照：迁移后的初始矩阵、`epochs:0`、只预测。
2. 零基线对照：全零矩阵、只预测；不得把零模型当随机基线。
3. 真实训练：从上一保存候选（首次为零）按name迁移后，用Handwired真实拟合，固定epochs/lr并记录计时与行处理量。
4. 逐head、逐属性回归与新进程回载：保存候选后在新进程加载，按head和属性分别报告`fixed/regressed/retained/unresolved`，并对旧PWD/CD/LS/unsupported做命令级回归。

冻结与零基线只预测，不执行命令；真实训练与回载是独立步骤。不得用一次冻结通过代替真实拟合，也不得用零填充自称无回归。

### 2.4 控制head与guard

`unsupported`、`DEFER`、`NOOP`都是不执行shell的控制head。`unsupported`表示Goal kind、operation或property/predicate对不在注册词表；`DEFER`表示已注册语义缺必要对象、观测、参数或证据并返回typed缺口；`NOOP`表示当前State已满足Goal且证据适用。三者必须分开记录，不得互相冒充。

`FINISH`不是独立head。组合C只有在实际整体Goal条件成立时才允许结束，并以共享`NOOP`表达；预算或前沿耗尽而Goal未成立时返回`DEFER`与continuation，不返回`FINISH`或伪造成功。

guard在softmax之后拒绝不可执行或类型不匹配的调用；它不改变"全注册词表共同softmax"这一事实。禁止prepare按P1-P6或其他分组先过滤logits或硬mask使错误head不出现；teacher允许集合只用于损失与评价。被guard拒绝的错误head仍计一次策略错误并记录`policy_error`，不得改标为`unsupported`、`DEFER`或OS失败。

## 3. 样本分区与监督标签迁移

保留来源家族隔离：0.2.0共享数据集含4个train家族与2个development家族，同一家族不跨分区。0.3.0新增样本按plan §8执行：4个train家族与2个development家族，每族34行，新增train136、dev68；旧38 train/20 dev行原样保留。正式共享run未提供可选verification资源；独立verification家族由独立作者另建，父级独立报告单独记录。
共享训练图适用于目录与文件属性单元，入口必须提供具体属性键、对象、Goal条件、satisfactionThreshold、可见State及可学习Action关系。训练期反推达标属性与前置条件；每项补齐自己的输入/wire/参数/损失后才可实施。当前图没有自动获得新属性模型或新harness，具体缺口沿属性合同第5节记录；完成训练与独立回载后再进入既有model-evolution单元升级流程。

普通属性单元现已由 [cli-property-training-design.md](cli-property-training-design.md) 补全B/P/R/C输入、监督和验证配方；批次1的路径与inspect输入、监督、分区和错误监督按§7补充。固定调用方案由 [cli-command-design.md](cli-command-design.md)维护。命令/操作选择只有一个owner：本文§2.1-2.4的同一`cli.command-policy.v1`共享矩阵；B对象关系与R用途是独立概念模型，C组合下一步若选命令复用同一共享矩阵。当前`workflows/cli-filesystem-training.graph.json`已升级为`cli.command.*@0.3.0`合同，8N8E拓扑和分区/拟合/保存/回载/评价/收口不变；运行绑定由I5同步，B、R 及剩余操作仍为设计，不写入当前真实图。

共享过程是单源单汇DAG。分区声明之后分成两条资料链：训练/开发准备与独立验证准备。拟合节点只收到训练资料；独立验证资料在候选形成后才与候选合流。验证不回流修改本轮参数。

每条样本按实际语义打标，严禁将支持的命令在其他命令训练中打上控制head：
- `sessionCwd observed` → `pwd`
- `sessionCwd equals`（适用证据不等或未知）→ `cd`
- `sessionCwd equals`（适用证据相等）→ `NOOP`
- `directory.entries observed` → `ls`
- 合法未绑定 `DirectoryQuery` → `DEFER`
- 未注册 property/predicate → `unsupported`

数据集构成：
- 当前单阶段：每个来源家族覆盖 pwd、cd、ls、NOOP、DEFER、unsupported 及 State 配对；train/dev/verification 家族不重叠。
- 具体行数由公开consumer的`makeCliCommandFixture`按场景生成；行数不是固定部署声明，只在报告中按实际计数。
- 旧 PWD/CD/LS/unsupported 历史行以 typed 语义转换版本回放，保证旧能力零回归。
- 验证集由独立作者配方另行提供，加上各命令专属失败探针；父级独立报告单独记录，不进入默认train/development分区。若调用者显式提供可选verification资源，receipt才记录`evaluation`分支。测试覆盖有限特征向量与真实环境变化（空格、中文、嵌套、链接等），不冒称未见语义泛化。

## 4. 真实文件系统沙盒与harness边界

沙盒执行器（`lib/adapters/cli/`）提供隔离的场景目录与显式session资源。每个分区与每条带副作用的样本独立创建目录与session：

- **PWD**：执行`/bin/pwd -P`，读取物理cwd观测。S.cwd保持不变。
- **path.resolve**：固定词法解释器`interpretCliPath`，入参为明确绝对base与原始PathText；不访问FS、不展开`~`/环境变量/glob；S与FS内容不变。
- **path.relative**：固定`path.posix.relative`，入参是两个明确绝对路径；结果可为空串，不得强制非空；同路径与交换参数必须产生可区分结果。
- **path.parts**：固定`dirname/basename`，入参是明确绝对路径；根显式为parent=`/`、name=`""`、isRoot=true；不得把`basename('/')`当作合同值。
- **entry.inspect**：固定helper执行`stat`/`lstat`/`readlink`。先核对session/scenario、绝对绑定与对象身份；follow=true时先`lstat`来源条目，再`stat`目标，两种身份分别保存。只读，不打开FIFO/socket/设备字节流。旧四字段D缺身份时返回`binding_identity_missing`/unknown，不降级为P。
- **CD**：执行固定zsh脚本，先验证目录类型与归属，成功后提交S.cwd与revision；紧接着在同一S上执行真实PWD验证后条件。提交前失败不修改S；提交后验证失败如实报告实际修改状态，不伪报回滚。
- **LS**：通过固定编译本地helper执行（`process.execPath + helperPath + D`），返回直接条目的结构化JSON（包含精确名称、由OS lstat观测的类型、coverage及errors）。不修改S.cwd，不修改文件系统。partial结果不能覆盖旧知识或冒充完整列举。严禁将`/bin/ls`面向人类的文本输出分词或flags称为NN训练。
- **失败与清理分类**：报告中严格区分native OS错误、grant授权拒绝、受控故障注入；native与注入不合并计数，fixture创建失败、清理失败与模型策略错误分别计数。清理失败显式暴露。

资产保存在既有目录，不新建根级资产目录：
- 样本：`training/samples/filesystem/<capability>/<run>/`
- 候选：`training/weights/filesystem/<capability>/<run>/candidate.json`
- 报告：`training/results/filesystem/<capability>/<run>/report.json`

## 5. 推理与训练DAG

- 推理DAG：`workflows/cli-file-property.graph.json`（6节点/5边，0.3.0）及`cli-file-property.workflow.json`，负责接收 typed `file.property` 请求，经绑定→选择→执行→观测→评价→报告收敛于统一SESE出口。I1只升级operator_version与合同载荷；节点ID、ARC ID、边与端口不变。旧`cli-command-step`与`cli-goal-step`图及绑定已物理退役。
- 训练DAG：`workflows/cli-filesystem-training.graph.json`（8节点/8边，0.3.0）及同名workflow配置，接收调用者准备并分区的 typed dataset。它不生成fixture，也不自行启动新进程回载；fixture由公开consumer的`makeCliCommandFixture`创建，保存候选后由consumer重新读取，并以新进程运行reload脚本。
- 阶段调度：`workflows/cli-filesystem-curriculum.graph.json`现为7节点/6边、0.2.0-design设计图（非真实训练图），只描述历史 PWD→CD→LS 顺序与后续属性单元；公开consumer只执行本轮单阶段迁移训练，不执行未来设计单元。
- 拟合迭代：epoch循环在数值拟合器内完成，不给外层workflow加回边。

## 6. 当前实施状态与验收底线

当前状态：0.2.0源码已迁移为 typed `file.property` 单 profile（`createCliCommandPolicy`与`runCliCommandTraining`），从旧共享候选 `d7c4a3e5-4111-4e09-857f-5f20f4fa18c0` 显式迁移后真实拟合；profile保持`uncalibrated`/`not_applied`。旧六参数 PWD API 与旧 4×4 运行 profile 已物理退役。历史 PWD/CD/LS 实测数据保留为历史基线，不直接抄写为本轮成绩。0.3.0批次1只有合同与图版本，未改产品代码、未训练、未回载、未独立验证。

历史独立PWD与CD实测数据保留为历史基线，不直接抄写为共享模型结果。`accepted`只表示train/dev与历史回归通过；未提供可选verification资源时`fullyVerified=false`。训练图的冻结/零权重对照只做预测，不执行命令；独立测试由父级独立报告另行记录，不声称在训练图内执行。

验收门槛：
1. 共享模型经统一公开入口在新进程加载并逐项验证：作者侧已执行；父级独立验证另行记录。
2. 历史必需能力零回归：旧 PWD/CD/LS/unsupported 回放零回归。
3. 真实argv、权限拒绝、受控注入和清理回执完整无遗漏：作者与sandbox用例覆盖。
4. 全仓基线用 `npm run test:full`。缺 `NN_HANDWIRED_ROOT`、`NN_CLI_COMMAND_PROFILE`、`NN_CWD_RELATION_PROFILE` 任一项时非零退出，不以 skip 冒充通过；迁移后记录数字为 255/255、0 跳过。默认 `npm test` 仍可在无资产环境运行，但其中的跳过项不计作通过。
5. 当前运行入口只支持 `pwd`/`cd`/`ls` 与 `NOOP`/`DEFER`/`unsupported` 控制结果。0.3.0新增的`path.resolve`/`path.relative`/`path.parts`/`entry.inspect`尚未运行。B对象查找、剩余目录/文件操作、自动采样/采用及LLM冲突裁决仍未实现。自然语言识别、help泛化、文件搜索、多步组合规划、browser与自动升级保持在范围外。

## 7. 批次1输入、监督与独立验收合同

### 7.1 四元素与可执行配对

| head | Goal property / target | 学生输入与允许Action | 实际New State与反例 |
| --- | --- | --- | --- |
| `path.resolve` | `path.absolute`；base为P，input为PathText；observed this_run | 明确base/input；只允许`["path.resolve",P,PathText]` | 记录本次absolute/parent；不读FS、不写exists；绝对input覆盖base，`/missing/../x`可成功，`~/$HOME/glob`保持字面 |
| `path.relative` | `path.relative`；from/to为P；observed this_run | 两个明确绝对路径；只允许`["path.relative",from,to]` | 保留本次relative；同路径为空串合法，交换方向必须改变预期，非绝对参数TypeError |
| `path.parts` | `path.parent`或`path.name`；P；observed this_run | 明确绝对P；只允许`["path.parts",P]` | 同回执保留parent/name/isRoot；根`/`为parent=`/`、name=`""`、isRoot=true；词法结果不证明目录归属 |
| `entry.inspect` | 8项inspect property之一；E/D/F/P ref与followSymlinks | 已观测对象引用、明确跟随模式、授权与旧属性；只允许`["entry.inspect",ref,followSymlinks]` | 本次stat/lstat/readlink机器证据按property投影；保留原ref、来源身份、结果身份、errno与观测方法；不写FS，不读FIFO/socket/设备字节流 |

`PathRef`、E/D/F引用、旧D兼容和身份校验沿[file.property合同](cli-filesystem-semantics.md)§7.2。`State`增加可选`pathKnowledge`与`entryKnowledge`槽；旧三字段请求解释为空新槽，返回统一规范State。身份、类型、sourceRun、sessionRevision与absolutePath只能来自sandbox绑定与真实观测，不由业务metadata、JSON回执或日志重建。旧D缺身份时进入`binding_identity_missing`，不得构造P替代。

### 7.2 监督与错误

每个新observed请求即使有旧知识也必须执行所选原语。路径head的监督来自typed Goal/State与独立例表，不把执行结果或teacher head送入学生输入。`entry.inspect`监督来自独立OS fixture和按property选定的typed Goal；expectedHead、目标路径答案、native errno与readlink输出不进入特征。OS失败仍可监督正确`entry.inspect`，不能把EACCES改标为`unsupported`。新普通观测缺旧知识时仍选inspect，不误标DEFER。

`exists`的follow投影、ENOENT/ENOTDIR/EACCES/EPERM/ELOOP、E/D/F失效、身份缺失、非适用字段、已证不匹配与guard拒绝沿[§7.4错误终点](cli-filesystem-semantics.md#74-os-错误与满足度终点)。阈值为0也必须取得必要本次事实；OS错误、属性值、实际满足度和policy score分别记录。

### 7.3 样本分区与独立验收

新增4个train家族与2个development家族，每族34行：resolve6、relative6、parts6、inspect16（8属性×2个适用状态）。新增train136、dev68；旧38 train/20 development语义行及标签/预算保持不变。resolve/relative/parts各为train正例6×4=24、dev正例6×2=12；inspect为train正64、dev32。其余行作为同一10-head softmax的负例，实际计数在报告中按行统计，不造每head独立权重。新家族使用不同树/路径结构，换名不算独立家族。

独立作者另建至少4个verification来源家族，覆盖4个新head各两种结构及8个inspect属性；新增至少32场景与16失败/边界探针。旧34场景/16探针必须在新候选重跑并分开报告。候选保存后才接收独立配方；若配方用于调参则转回归并另留新验证。`block_device` native证据在macOS标`UNVERIFIED`；FIFO、socket、symlink使用沙盒真实fixture。候选保持`uncalibrated/not_applied`，真实拟合、回载与独立结果由I6/I7产生。
