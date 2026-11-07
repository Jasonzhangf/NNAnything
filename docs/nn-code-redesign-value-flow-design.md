# NN Code redesign: value flow

状态：2026-11-07 设计 r2（REWORK rev14），owner Carol，reviewer Alice。旧 `nn-code value-flow` 只作 teacher、oracle、样本来源与对照材料，不恢复为产品。本文是设计子交付，不启动实际拟合、不修改现有权重/gold/threshold/采用状态、不接线产品、不安装 runtime。实际训练、保存、新进程回载、独立留出评价与旧调用图能力回归仍按 board 生命周期执行；共享固定训练环境未验收前不启动 fit。

本次定点修订依据 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-valueflow-design-audit-20261107.md`，只补三层语义、具体 64-slot 映射和 `one`/`all` 终止差异，不扩展实现、训练或采用授权。

## 1. 与现行统一路线对齐

本设计复用 `docs/neural-cli-unified-plan.md` 的统一决策 package，不新建 value-flow 专用模型或第二套训练器：

- 学生输入沿用 `nnanything.unified-step.v1` 的 `StepContext`，经 `unified-encoder` 编码为 `x[64]`。
- 固定模型结构保持 `64 -> 64 -> 64 -> 1 (ReLU)`，共享候选评分器；候选数变化不改变输出维。
- 复用 `docs/l2-four-head-experiment.md` 的 R/D/E/A 职责与 `workflows/l2-four-head-step.graph.json`（8N7E design）；外层仍复用 `recursive-goal` 3N2E。
- 复用已接受合同中的 group loss、固定 recipe、数据门和候选隔离规则；本文只补 value-flow 的领域语义、局部观测、语料与评价。
- 现有 `lib/training/value-flow-l2-runner.ts` 的 15 维、`[15,16,16,3]`、579 参数路线只作旧离线对照，不是本设计目标，不进入新候选训练。

本设计不改变 `x[64]`、两层隐藏层、统一格式、固定推理引擎、既有权重、gold、threshold、采用状态、产品接线或安装状态，也不恢复旧 `nn-code` 产品。

## 2. Goal 与 satisfactionThreshold

### 2.1 Goal

给定显式仓库根、anchor 程序点、方向、scope、最大深度和结果模式，返回该请求范围内可证明的静态 may-provenance 值流关系，保留每条关系的局部路径证据、精度和未知边界。

请求字段沿用旧领域合同的语义，但作为统一 Goal 的 typed 字段注入，不另造自然语言请求：

| 字段 | 含义 |
| --- | --- |
| `repoRoot` | 当前只读沙箱的规范化仓库根 |
| `anchorFile` / `anchorSymbol` | 规范化相对路径和符号 |
| `anchorLexicalPath` / `anchorLine` / `anchorColumn` | 可选程序点消歧信息 |
| `direction` | `origin` 或 `sink` |
| `scopePaths` | 非空相对路径范围 |
| `maxDepth` | `0..3`，表示允许观察的跨站点值流跳数 |
| `resultMode` | `all` 或 `one`；默认 `all` |
| `satisfactionThreshold` | 本文只接受 `100` |

根 Goal 不是“输出若干可能命中”，而是“在声明范围内完整、可追溯地确定候选关系”。`one` 模式只证明找到一条合法路径，不证明 `all` 覆盖；`all` 模式只证明完整查询，不允许用低分候选剪枝。

### 2.2 satisfactionThreshold 与实际 satisfaction

只有当前 State 的局部证据、已确认边、覆盖回执和未知收口同时满足以下条件时，实际 satisfaction 才为 `100`：

1. `resultMode=all` 时，所有已登记的关系义务都得到最终 `true`、`false` 或 `unknown` 判定。
2. 已确认的 `true` 关系均有可复核边和路径证据。
3. `unknown` 有具名原因、未决证据和完整 coverage 记录。
4. `resultMode=all` 时 `truncatedCount=0`、`failedCount=0`，候选枚举覆盖完整。
5. `resultMode=one` 时，已存在至少一条由固定引擎验证的合法路径见证；允许其他义务保持未判定，但必须报告 `coverage=partial`、`unsearchedCount` 和早停原因。
6. scope 外和不支持语言在准入处显式拒绝，不混入语义 unknown。

任一已知关系错误、漏报、截断、失败遗漏或伪成功均为 `0` 或 `incomplete`；只有证据不足且未完成收口时为 `null`。模型分数不是 satisfaction，任何实现也不允许用预测填充事实。

### 2.3 resultMode 的根终止差异

`one` 和 `all` 不是同一条覆盖义务的强弱表示，根终止条件必须分开：

| resultMode | 何时可根终止 | 允许的剩余范围 | 禁止的结论 |
| --- | --- | --- | --- |
| `all` | 所有关系义务均为终态，候选枚举完整、必要范围全部有 coverage 回执，且无未收口观察或执行失败 | 不允许未搜索候选；终态 `unknown` 必须有具名原因和证据 | 不得因模型低分跳过候选；不得把 open unknown、截断或失败写成 achieved |
| `one` | 固定引擎已独立验证至少一条满足 scope/depth 的路径 | 允许仍有未搜索候选；必须报告 `coverage=partial`、`unsearchedCount` 和早停原因 | 不得把找到一条路径外推为完整关系；不得把模型自报 true 当见证；不得因早停掩盖已知错误 |

`one` 的完整结果是“找到合法见证并明确未覆盖范围”，不是“所有关系均已判定”。`all` 的 `achieved` 需要每个关系义务都有终态；候选完整后为已知真、已知假或带具名原因的语义 unknown 都可成为该义务的终态。由缺测、截断、预算或执行失败产生的 open unknown 不是终态，必须使根保持 `unknown` 或 `incomplete`。

## 3. State

State 只包含当前请求与当前步真实可见的事实。每次动作后由固定 harness 产生 New State；上一轮预测不能替代实际观测。

状态按用途分为三层，禁止把后层结果回灌为前层输入：

1. 原始解析事实：adapter 从当前文件/scope 真实读取的 token、声明、读写点、调用点、参数、返回、顺序、分支、循环、跨度和 coverage。它只报告“观测到了什么”，不报告关系真假。
2. 当前待判关系：候选枚举器从请求和原始事实构造的 `(sourceSite, sinkSite, edgeKind, accessPath?, direction)`。它只表示“需要判定什么”，不是 gold，也不是模型答案。
3. 已接受判定：模型候选经固定引擎验证后进入 State 的 `judge=true/false/unknown`、路径证据、未决原因和覆盖结果。只有这一层可以作为根评价输入。

adapter 可以验证对象身份、scope、参数类型、span 和证据引用是否可用，也可以验证模型提交的一条局部路径是否连续；adapter 不能预先计算并返回最终关系真值，不能把“候选关系”直接标成已验证边，也不能把完整调用图、最终路径或按 gold 过滤后的候选作为学生输入。只有模型提出待验证路径后，固定验证器才能为该路径写出已接受判定；候选枚举本身只产出待判关系，不产出答案。

| State 区域 | 字段与边界 |
| --- | --- |
| 请求与准入 | `repoRoot`、scope、语言、支持状态、anchor 绑定状态、接受/拒绝原因 |
| 当前 anchor | anchor 的声明身份、词法作用域链、程序点角色、位置、观测回执引用 |
| 当前候选 | 尚未判定的一对源/汇点、边类型候选、access path、候选来源和局部证据 |
| 已观测符号事实 | 声明、读取、赋值、解构、import/re-export、同名遮蔽、动态成员边界 |
| 已接受判定 | 模型选择后由固定验证器接受的 `reaching_def`、`local_init`、`local_assign`、`destructure_extract`、`arg_to_param`、`return_from_fn`、`return_to_call_lhs` 局部边及路径状态 |
| 路径证据 | 当前已观察路径前缀、边的顺序、分支备选、循环精度和证据跨度 |
| 覆盖 | 已读文件/范围、已搜索范围、未读候选、截断、失败、timeout、budget |
| 未知 | typed `unknownReason`、缺失证据、是否可继续观察、是否已到收口边界 |
| 动作历史 | 已完成动作、实际回执、effects、失败、未记录项 |
| 义务 | 根 Goal 剩余关系义务、已满足条件、当前结果模式和终止条件 |

未读文件不得预先提供 AST、最终声明、完整调用图或 oracle 路径。`sourceCurrent`、read receipt、覆盖状态和最终 Goal 结果分别保存；未尝试、读取失败、缺测、观测冲突与已确认不存在不得合并。

上表中的“已接受判定”只指模型选择后由固定验证器验证通过的局部边。它不是 adapter 预先给出的关系真值；如果没有模型或独立 oracle，仅凭原始解析事实和候选枚举不能完成关系义务。

## 4. Action

学生只做当前一步决策，固定引擎和执行器负责真实操作和观测。动作集合分为关系判定与推进控制两类，均为已有 R/D/E/A 候选的一部分，不新增第五个基础元素。

### 4.1 当前关系判定

当前候选关系 `(sourceSite, sinkSite, edgeKind, accessPath?, direction)` 的输出候选为：

- `judge=true`
- `judge=false`
- `judge=unknown`

`true` 只在模型选择一条路径、该路径由固定验证器在原始事实和已接受局部分段上验证通过，并满足 scope/depth 时成立。`false` 只在当前 scope 内必要候选均已检查且能证明不存在该关系时成立。证据缺失、cross-file 绑定未验证、解析失败或达到未覆盖边界时只能 `unknown`。固定验证器不能代替模型枚举并完成全部关系终态；它只验证模型明确选择的局部路径。

模型只能引用当前 StepContext 中已枚举的候选和对象引用，不能生成源码、调用栈、文件路径、最终符号答案或完整 oracle 链。

三类参与者的职责边界如下：

| 参与者 | 可以做什么 | 不可以做什么 |
| --- | --- | --- |
| adapter / 固定观测 | 返回原始语法事实、对象/scope 身份、span、顺序、coverage、错误和模型提交路径的局部验证回执 | 不预先给出当前关系 true/false，不返回完整调用图答案，不用 gold 过滤候选 |
| 学生模型 | 读取当前 StepContext，在 `J` 上选择 `true/false/unknown`，并选择下一步合法动作 | 不读 gold、oracle、未来回执、teacher 最终链或完整调用图；不把模型分数当关系事实 |
| 训练监督来源 | 在 `TRAIN` 分区生成独立监督；通过来源隔离和准入后可作为 loss 标签进入拟合 | 不进入学生 StepContext、运行时执行链或候选选择；不能由学生回填 |
| 独立 oracle | 在评价旁路生成 `DEV`/`VERIFICATION` gold、路径证据和 unknown 依据，供选参与最终分母使用 | `VERIFICATION` oracle 不进入拟合、样本构造、选参或候选选择；`DEV` 只按预声明选参用途使用 |

删除模型后，固定引擎仍能读取原始事实并枚举候选，但没有组件能完成以下判断：选择当前关系终态、为 `true` 选择需要验证的路径、为 `false` 证明必要候选完整且无支持路径、或为 `unknown` 选择仍有信息增益的合法观察。若直接运行确定性 analyzer 补上这些判断，就会重现“analyzer 先完成答案、模型只复述结果”的违规路线，因此运行时结果只能保持未决。

### 4.2 当前推进动作

学生对当前未决义务从合法动作中选择一个：

- `observe`：读取有正增益的局部观察，必须绑定明确对象/范围/观察方法。
- `advance`：仅当已存在可验证的局部边且该边覆盖一个未决义务时提交一步；提交由固定 adapter 验证，不由模型自报。
- `defer`：存在合法但本轮不能完成的观察或尚需保留的未决义务时暂停该步；结束后仍须返回显式最终 `judge=unknown` 的原因。
- `return`：提交当前根结果；根评价必须独立执行，根未满足时返回准确的未满足或 unknown。

`all` 模式下不得因模型低分跳过未读候选。模型分数只用于排序和判定，最终覆盖由固定枚举和真实读取决定。

### 4.3 固定执行与后验

固定 harness 负责：

1. 将动作映射到已注册的只读观察或读取技能。
2. 执行受控读取、AST/符号解析和值流检查。
3. 返回原始回执、错误、截断、范围、对象身份和实际 New State。
4. 拒绝越界、非法参数、scope 外文件和不支持语言。

动作成功不等于关系成立；读取成功不等于路径已验证；路径已验证不等于根 Goal 完成。三条事实分别进入 State 和评价。

## 5. 值流关系语义

### 5.1 站点与声明身份

沿用旧合同的分离：

- `declId`：词法声明身份，包含文件、词法作用域链、符号和声明跨度。
- `siteId`：具体程序点身份，包含文件、作用域链、符号、程序点角色、点跨度和声明跨度。

同一个 `declId` 的顺序重赋值、读取和分支汇合不得坍缩。`siteId` 只用于对象绑定，不能作为模型输出或独立语义捷径。

### 5.2 边类型

新学生只学习已有边类型候选的当前关系，不新增 value-flow 专用关系词表：

| 边类型 | 含义 |
| --- | --- |
| `reaching_def` | 使用点读取某个到达定值 |
| `local_init` | 声明初始化写入来源 |
| `local_assign` | 赋值左值写入来源 |
| `destructure_extract` | 解构叶子从来源对象提取 |
| `arg_to_param` | 调用实参到被调用形参 |
| `return_from_fn` | 返回表达式到函数返回站点 |
| `return_to_call_lhs` | 函数返回值到调用结果接收点 |

`accessPath` 只在当前证据能明确表达对象/数组/属性路径时存在；无法证明时为 `null` 或未知，不由模型猜测。

### 5.3 静态 may-provenance

边和路径的语义固定为静态 may-provenance，而非运行时精确可达路径：

- `exact_unconditional`：路径不依赖未决分支条件，且所有边已验证。
- `may_branch_disjunction`：到达来自多个分支备选；每条路径链内为合取，链间为析取。
- `may_loop_fixpoint`：含循环回边或不动点传播，保留保守可能来源。

分支不得把两条路径的条件拍平成矛盾合取；循环不得因相反分支标记做静态互斥剪枝。当前设计接受保守 may-provenance，但必须明确精度与路径证据，不能冒称运行时唯一路径。

### 5.4 路径证据

每条最终 `true` 关系至少保存：

- 源站点和汇点；
- 边类型、`accessPath` 和 `provenancePrecision`；
- 已观察路径前缀中的有序边；
- 分支备选链和公共必经条件；
- 是否含循环回边；
- 每段边的文件、跨度、观测回执和覆盖引用；
- 相关 unknown 引用；
- 结果是否由 `all` 完整覆盖或仅由 `one` 找到。

路径证据不足时不能输出 `true`，只能输出 `unknown` 并保留未决证据。

### 5.5 两个定点正反例

以下例子只定义训练与评价语义，不新增实现。adapter 侧只给出原始事实，独立 oracle 侧才给出 gold。

#### 5.5.1 赋值 Kill 正反例

原始局部程序：

```ts
let x = 1; // d0
let y = x; // u0
y = 2;     // d_other
let y2 = x; // u_other
x = 3;     // d1
let z = x; // u1
if (c) x = 4; // d2
let w = x; // u2
```

待判关系：

| 候选 | 关系 | 期望判断 |
| --- | --- | --- |
| `r_kill_pos = (d0, u0, reaching_def)` | `d0` 到达 `u0` | `true` |
| `r_kill_neg = (d0, u1, reaching_def)` | `d0` 被同声明无条件 `d1` 后 kill，不能到达 `u1` | `false` |
| `r_other_write = (d0, u_other, reaching_def)` | `d_other` 写的是另一声明 `y`，不 kill `x` 的 `d0` | `true` |
| `r_cond_may = (d1, u2, reaching_def)` | 分支前最新无条件写 `d1`，`c=false` 时 `d1` 到达 `u2`；`c=true` 时 `d2` 到达 `u2` | `true`，`may_branch_disjunction` |
| `r_cond_neg = (d0, u2, reaching_def)` | `d1` 已在分支前无条件覆盖 `d0`，因此 `d0` 不能到达 `u2` | `false` |
| `r_cond_missing_body = (d1, u2, reaching_def)` | 条件写 `d2` 和顺序已观察，但分支体内容/逃逸未观察 | `unknown`，原因是分支内容缺测 |
| `r_cond_missing_order = (d1, u2, reaching_def)` | 条件写本身或 `d1 -> d2 -> u2` 顺序未观察 | `unknown`，原因是顺序缺测，orderFlowIndex 必须为 undetermined |

adapter 原始事实只包含：

- 所有站点的声明身份、词法 scope、span、源代码顺序和程序点角色；
- `d0`、`d1`、`d_other` 是写入点，`u0`、`u_other`、`u1`、`u2` 是读取点；
- `d_other` 的声明与 `d0` 不同；`d1`、`d2` 与 `d0` 同声明；
- `d1` 无条件，`d2` 位于可观测 `if` 分支内；分支结构、branch-join 和 coverage 回执可见；
- `d1` 在 `d2` 之前，`d0` 在 `d1` 之前；因此 `r_cond_may` 的源点是 `d1`，不是 `d0`；
- `r_cond_missing_body` 保留已观测的条件写和顺序，只把分支体内容标为 missing；`r_cond_missing_order` 把条件写/顺序本身标为 missing，`orderFlowIndex` 不得填成已知的 `3`；
- 不包含“`d0` reaches `u0`”“`d1` kills `d0`”“`d0` may-reach `u2`”的最终关系判断。

学生语义职责：

- 对 `r_kill_pos`，选择 `judge=true`，并让固定引擎验证 `d0 -> u0` 的顺序和局部写读事实。
- 对 `r_kill_neg`，选择 `judge=false`，前提是当前 scope 的必要写入点已完整枚举，且固定引擎验证 `d1` 是 `u1` 前顺序覆盖的同声明无条件重赋值。
- 对 `r_other_write`，选择 `judge=true`；`d_other` 的声明身份与 `d0` 不同，不能把它当作同变量 kill。
- 对 `r_cond_may`，选择 `judge=true` 并保留 `may_branch_disjunction`；条件 `c` 的运行值未观测不等于缺测。`d1` 在 `c=false` 分支到达 `u2`，`d2` 在 `c=true` 分支到达 `u2`。
- 对 `r_cond_neg`，选择 `judge=false`；`d1` 在分支前已无条件覆盖 `d0`，后续条件写不能复活 `d0`。
- 对 `r_cond_missing_body`，选择 `judge=unknown`，因为条件写和顺序可见但分支内容不完整；对 `r_cond_missing_order`，同样 `unknown`，但 `orderFlowIndex` 必须是 `0=undetermined`，不能把未观测顺序写成已知条件写。两者原因字段分别保留分支内容缺测或顺序缺测。

独立 oracle 使用独立静态证明或离线 analyzer 记录 `r_kill_pos=true`、`r_kill_neg=false`、`r_cond_may=true`、`r_cond_neg=false`、`r_cond_missing_body=unknown`、`r_cond_missing_order=unknown`、顺序 span、kill 证明和 coverage。oracle 证据不进入学生 StepContext。

#### 5.5.2 `arg_to_param` 正反例

原始局部程序：

```ts
function f(a: number, b: number) { return a + b; }
function g(a: number, b: number) { return a + b; }
f(7, 8); // a0_0 -> p_f0, a0_1 -> p_f1
g(7, 8); // a1_0 -> p_g0, a1_1 -> p_g1
```

待判关系：

| 候选 | 关系 | 期望判断 |
| --- | --- | --- |
| `r_arg0_pos = (a0_0, p_f0, arg_to_param)` | `f` 的第 0 实参到第 0 形参 | `true` |
| `r_arg1_pos = (a0_1, p_f1, arg_to_param)` | 同一 callee 的第 1 实参到第 1 形参 | `true` |
| `r_arg_swap = (a0_1, p_f0, arg_to_param)` | 同一 callee，但实参序号与形参序号不匹配 | `false` |
| `r_arg_other_callee = (a1_0, p_f0, arg_to_param)` | 不同 callee `g` 的实参到 `f` 的形参 | `false` |
| `r_arg_missing_arg = (a0_1, p_f1, arg_to_param)` | 实参列表覆盖不完整 | `unknown` |
| `r_arg_missing_param = (a0_1, p_f1, arg_to_param)` | 形参表覆盖不完整 | `unknown` |

adapter 原始事实只包含函数声明、形参顺序与 span、调用表达式、callee 的局部标识符、实参顺序与 span、callee/形参声明身份一致性证据以及两侧 coverage；不包含最终参数绑定结果。学生必须读取 callee 身份、实参序号、形参序号和覆盖状态，选择 `true`、`false` 或 `unknown`。序号相同且 callee 身份一致时可为 `true`；同 callee 但序号不同、或 callee 不同时可为 `false`；实参或形参任一侧 coverage 不完整时只能 `unknown`。`r_arg_missing_arg` 与 `r_arg_missing_param` 的 `bindingResolutionCode` 都标记为 `unresolved`，但这不是“coverage 缺失必然推出未解析”的通用规则；这两个对照各自明确缺少绑定所需的实参或形参侧事实，其他 coverage 缺失若绑定事实仍可见，`bindingResolutionCode` 保持不变。两者的区别只在 `coverageIndex` 的缺测侧。独立 oracle 在评价旁路给出绑定证明和 negative/unknown reason。

删除模型后，adapter 只能报告 `a0_0`、`a0_1`、`a1_0`、`a1_1`、`p_f0`、`p_f1`、`p_g0`、`p_g1` 和调用位置，不能自行决定上述候选的终态。候选因此保持待判，不会在没有模型或独立 oracle 的情况下生成 achieved。

## 6. 局部观测与统一 StepContext

本设计不新增 value-flow 专用 64 维输入。值流事实必须映射到统一 StepContext 的现有对象引用、关系、缺失和覆盖字段；若某个必要字段当前无法表达，必须把它列为共享 StepContext 的设计缺口，不能由本任务私建第二编码器或在适配器中偷偷补答案。

当前关系候选可观测的局部事实包括：

| 事实族 | 示例 |
| --- | --- |
| 请求方向与模式 | `origin`/`sink`、`all`/`one`、剩余深度 |
| 对象角色 | 源/汇点、声明/读取/赋值/参数/返回/调用结果程序点 |
| 作用域 | 同一文件、同一函数、嵌套作用域、同名遮蔽、scope 内/外 |
| 绑定 | 已观测声明、import/re-export、解构、局部函数、动态属性边界 |
| 位置与顺序 | 前后位置、读取前/后赋值、跨函数跳点、跨文件 |
| 当前路径 | 已观察路径前缀、边数、剩余深度、是否已有已验证边 |
| 分支/循环 | 条件已观察/未知、备选链、循环精度、回边 |
| 覆盖与缺测 | 已读范围、未读候选、截断、解析失败、unresolved import |
| 语言与准入 | 支持语言、scope 资格、unsupported/out-of-scope 拒绝 |

禁止进入学生输入的事实：

- 最终 gold 关系、完整路径答案、完整调用图、`A_g`、`goal_met`；
- 未来读取结果、未来 receipt、teacher 结论、oracle 未发生的解析结果；
- 按 gold 过滤后的候选集合；
- 只由最终答案推导的 `declId`/`siteId` 或对象配对捷径；
- 运行后才知道的变更、删除或动态绑定结果。

### 6.1 当前 64-slot 映射与可辨性

当前 `unified-encoder` 已使用的相关槽位如下：

| 槽位 | 当前含义 | 与 value-flow 的关系 |
| --- | --- | --- |
| `x[0..7]` G0 | goal 类型、target、threshold、constraints 数量 | 只表示请求和阈值可用性，不表示关系真值 |
| `x[8..15]` G1 | facts 数量、missing facts、conflict、evidence、objectRefs | 只计数量；`x[15]` 当前保留为 0 |
| `x[16..23]` G2 | previous action、receipt、outcome、condition state | `x[23]` 当前保留为 0 |
| `x[24..31]` G3 | 技能类别和 executor 可用性 | `x[31]` 当前保留为 0 |
| `x[32..39]` G4 | 参数覆盖、类型、judge one-hot、缺失参数 | `x[36..38]` 只表示 `judge=true/false/unknown` |
| `x[40..47]` G5 | target kind 可用性、证据存在、声明名称/类型一致 | 不表示边类型、源汇角色、顺序或 kill |
| `x[48..55]` G6 | control、candidate kind、参数投影 | `x[51]` 提出 `orderFlowAndCoverageCode`，`x[55]` 提出 `bindingResolutionCode`；均为 §6.2 的共享扩展提案，未经 Alice 审计前不实现 |
| `x[56..63]` G7 | route 和 declaration identity | 只表示声明身份的一致性，不表示关系本身 |

当前结构不能从标准字段中独立表达 `edgeKind`、源/汇程序点角色、顺序关系、条件性/无条件性、callee 绑定、参数序号或覆盖状态；kill 结论也不是编码器输入。两个候选即使对应不同关系，只要 fact 数量和第一条 declaration 相同，就可能产生相同的主要向量。因此当前 `nnanything.unified-step.v1` 不能直接承担上述正反例的可辨性交付。

### 6.2 定点例的 64-slot 映射

为了让例子可训练且不泄露 gold，建议先审计一个共享的 64-slot 语义扩展。扩展只填充当前保留的 0 槽位，不改变 64 维长度，也不新建 value-flow 私有编码器。下表是最小映射提案，需由 Alice 先审计后才进入实现：

| 槽位 | 共享语义 | 编码 |
| --- | --- | --- |
| `x[15]` | `relationKindCode` | `0=not_applicable`；`1/7=reaching_def`、`2/7=local_init`、`3/7=local_assign`、`4/7=destructure_extract`、`5/7=arg_to_param`、`6/7=return_from_fn`、`7/7=return_to_call_lhs` |
| `x[23]` | `sourceRoleAndOrdinalCode` | `(roleIndex*4 + min(ordinal,3))/19`；roleIndex `0=unknown`、`1=definition/write`、`2=argument`、`3=return`、`4=other`；ordinal 对 argument 源保留 `0/1` |
| `x[31]` | `sinkRoleAndOrdinalCode` | `(roleIndex*4 + min(ordinal,3))/19`；roleIndex `0=unknown`、`1=read`、`2=parameter`、`3=assignment_target`、`4=other`；ordinal 对 parameter 汇保留 `0/1` |
| `x[51]` | `orderFlowAndCoverageCode` | `(orderFlowIndex*4 + coverageIndex)/31`；orderFlowIndex `0=undetermined`、`1=ordered before no intervening write`、`2=same-decl unconditional intervening write`、`3=same-decl conditional intervening write`、`4=other-decl unconditional intervening write`、`5=other-decl conditional intervening write`、`6=same-decl unconditional then same-decl conditional intervening write`、`7=non-ordering`；coverageIndex `0=missing`、`1=partial`、`2=complete`、`3=not_applicable` |
| `x[55]` | `bindingResolutionCode`（仅 callee 解析，不含覆盖） | `0=not_applicable`，`0.25=unresolved`，`0.5=same callee`，`0.75=different callee`，`1=ambiguous/dynamic` |

`x[51]` 明确打包两个独立字段，但数值可以机械拆回：`orderFlowIndex` 表源点到汇点的“已观测写前缀”摘要，即源点之后到汇点之前出现的中间写序列（声明身份是否同目标、无条件/条件分支）；`coverageIndex` 表该候选观测覆盖。它不写“该写构成 kill”或关系真值。`x[55]` 只表 callee 解析状态，不携带覆盖或序号。序号相等比较只由 `x[23]` 和 `x[31]` 的 role/ordinal 码承载，`x[55]` 不因参数序号不匹配而改变。`same-decl`/`other-decl` 由 adapter 比较已观测声明 ref 的相等性得出，是语法/身份事实，不是 reaching-def 真值。

`orderFlowIndex` 的过滤与压缩合同如下：只把源点之后、汇点之前且目标声明等于候选源声明的写作为 kill-relevant 序列；若没有同声明写，则把已观测的其他声明写归为 `other-decl` 对照。若同时存在同声明和其他声明写，其他声明写不进入该候选的 kill-relevant 前缀，因为它们不能覆盖候选源声明。多写只允许以下压缩：全无条件 → `2`；全条件 → `3`；先有无条件、后有条件 → `6`。其他混合顺序必须为 `0=undetermined` 并带 unsupported/missing reason，不得按猜测压成已知序列。

该扩展下的关键槽位差异为：

| 例子 | `x[15]` | `x[23]` | `x[31]` | `x[51]` | `x[55]` |
| --- | --- | --- | --- | --- | --- |
| `r_kill_pos` | `1/7` | `4/19` | `4/19` | `6/31` | `0` |
| `r_kill_neg` | `1/7` | `4/19` | `4/19` | `10/31` | `0` |
| `r_other_write` | `1/7` | `4/19` | `4/19` | `18/31` | `0` |
| `r_cond_may` | `1/7` | `4/19` | `4/19` | `14/31` | `0` |
| `r_cond_neg` | `1/7` | `4/19` | `4/19` | `26/31` | `0` |
| `r_cond_missing_body` | `1/7` | `4/19` | `4/19` | `12/31` | `0` |
| `r_cond_missing_order` | `1/7` | `4/19` | `4/19` | `0` | `0` |
| `r_arg0_pos` | `5/7` | `8/19` | `8/19` | `30/31` | `0.5` |
| `r_arg1_pos` | `5/7` | `9/19` | `9/19` | `30/31` | `0.5` |
| `r_arg_swap` | `5/7` | `9/19` | `8/19` | `30/31` | `0.5` |
| `r_arg_other_callee` | `5/7` | `8/19` | `8/19` | `30/31` | `0.75` |
| `r_arg_missing_arg` | `5/7` | `0` | `9/19` | `28/31` | `0.25` |
| `r_arg_missing_param` | `5/7` | `9/19` | `0` | `28/31` | `0.25` |

每个对照的原始字段值、独立推导、完整槽位差异及缺测状态如下表。`orderFlowIndex`/`coverageIndex` 只从 adapter 已观测的语法与身份事实导出，不调用 reaching-def/analyzer 真值；kill 是待判定关系结论，不是输入：

| 候选 | 原始顺序/中间写事实（adapter 可见） | `orderFlowIndex` | `coverageIndex` | 角色/序号/绑定事实 | `x[23]` | `x[31]` | `x[55]` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `r_kill_pos` | `u0` 在 `d0` 后、`d1` 前；`d0..u0` 中间无对 `x` 的写 | `1`（无中间写） | `2`（complete） | `d0`=write，`u0`=read；无 callee | `4/19` | `4/19` | `0` |
| `r_kill_neg` | `u1` 在 `d1` 后；`d1` 是同声明无条件写 | `2`（same-decl unconditional intervening write） | `2`（complete） | 同上 | `4/19` | `4/19` | `0` |
| `r_other_write` | `u_other` 在 `d_other` 后；`d_other` 是 `y` 声明，非 `x` | `4`（other-decl unconditional intervening write） | `2`（complete） | 同上 | `4/19` | `4/19` | `0` |
| `r_cond_may` | `u2` 在 `d2` 后；`d2` 是 `x` 的同声明条件写（`d1` 是源点，不在 `d1..u2` 中间） | `3`（same-decl conditional intervening write） | `2`（complete） | 同上 | `4/19` | `4/19` | `0` |
| `r_cond_neg` | `d0..u2` 中间：先 `d1` 同声明无条件写，再 `d2` 同声明条件写 | `6`（same-decl unconditional then same-decl conditional intervening write） | `2`（complete） | 同上 | `4/19` | `4/19` | `0` |
| `r_cond_missing_body` | 同 `r_cond_may`，条件写和顺序可见，但分支体内容未观察 | `3`（same-decl conditional intervening write） | `0`（missing） | 同上 | `4/19` | `4/19` | `0` |
| `r_cond_missing_order` | 条件写本身或 `d1 -> d2 -> u2` 顺序未观察 | `0`（undetermined） | `0`（missing） | 同上 | `4/19` | `4/19` | `0` |
| `r_arg0_pos` | callee 形参表在调用点之前可见；跨函数绑定非顺序域 | `7`（non-ordering） | `2`（complete） | `a0_0`=argument ordinal0，`p_f0`=parameter ordinal0，callee `f` | `8/19` | `8/19` | `0.5` |
| `r_arg1_pos` | 同上 | `7` | `2` | `a0_1`=argument ordinal1，`p_f1`=parameter ordinal1，callee `f` | `9/19` | `9/19` | `0.5` |
| `r_arg_swap` | 同上 | `7` | `2` | `a0_1`=argument ordinal1，`p_f0`=parameter ordinal0，callee `f` | `9/19` | `8/19` | `0.5` |
| `r_arg_other_callee` | 同上 | `7` | `2` | `a1_0`=argument ordinal0，`p_f0`=parameter ordinal0，callee `g`（不同） | `8/19` | `8/19` | `0.75` |
| `r_arg_missing_arg` | 调用实参列表覆盖缺测 | `7`（non-ordering） | `0`（missing） | 源侧 argument 未解析，形参侧 `p_f1` 可见 | `0` | `9/19` | `0.25` |
| `r_arg_missing_param` | 形参表覆盖缺测 | `7`（non-ordering） | `0`（missing） | 源侧 `a0_1` 可见，目标侧 parameter 未解析 | `9/19` | `0` | `0.25` |

表内 `x[23]` 与 `x[31]` 保留源/汇角色和参数序号，`x[51]` 保留有序中间写序列摘要（声明身份、条件性/无条件性）、coverage，`x[55]` 保留 callee 解析状态。`judge=true/false/unknown` 仍由 G4 `x[36..38]` 表示，声明身份仍由 G5/G7 原槽位表示。`r_arg_swap` 与 `r_arg0_pos` 只在 `x[23]`/`x[31]` 上区分序号；`r_arg_other_callee` 与 `r_arg0_pos` 只在 `x[55]` 上区分 callee；`r_arg_missing_arg`/`r_arg_missing_param` 分别由 `x[23]` 或 `x[31]` 的 unknown 角色与 `x[51]` 的 missing coverage 表示，二者都保持 `x[55]=0.25` 但不会被混同。`r_cond_missing_body` 与 `r_cond_missing_order` 分别用 `x[51]=12/31`（顺序/条件写已观测，内容缺测）和 `0`（顺序/条件写本身 undetermined）表示。`r_kill_neg` 与 `r_cond_neg` 分别是“同声明无条件写”和“同声明无条件写后同一声明条件写”，`x[51]` 上以 `10/31` 与 `26/31` 区分；它们都表示 `d0` 已被 `d1` kill，但程序结构不同，编码必须可辨。`x[51]` 不写 kill，也不写关系真值。

### 6.3 共享投影最小差异

如果上述扩展被审计接受，最小共享差异是：

1. 在统一 StepContext 增加通用的 `relationshipProjection`，包含 `relationKind`、`sourceSiteRef`、`sinkSiteRef`、`sourceRoleAndOrdinal`、`sinkRoleAndOrdinal`、`orderFlowAndCoverage`、`bindingResolution` 和证据引用；字段由 adapter 的原始事实填充，不由 gold 或 analyzer 真值填充。中间写身份、条件性/无条件性、callee 绑定、参数序号和 coverage completeness 各自独立导出，各自携带缺测码；不把中间写与 kill、或绑定解析与覆盖完整折叠成一个码。
2. 在 `unified-encoder` 中按 §6.2 填充当前保留的 `x[15]`、`x[23]`、`x[31]`、`x[51]`、`x[55]`，并提升统一 encoder 版本；不改变 64 维长度。
3. 旧 profile 按版本加载，不能在未迁移的情况下接收新槽位；新增关系字段必须保持缺失可表达，不能补 0 冒充观测。
4. 在实现前先由 Alice 审计字段是否真的共享、是否有旧能力回归、是否出现 relation-specific 私有分支；未通过前不启动 fit、不生成新训练语料。

在该共享扩展被接受前，价值流设计保持“当前 v1 映射不可辨”的显式缺口。不得通过手写规则、完整调用图或 oracle 侧字段绕过模型，也不得把 §6.2 的候选映射直接写成已实现状态。

## 7. 未知、缺测与拒绝边界

以下状态必须分开：

| 状态 | 判定 | 根结果 |
| --- | --- | --- |
| 已知关系成立 | 局部证据和已验证路径支持 | `true` |
| 已知关系不成立 | 当前 scope 内必要候选完整检查并证伪 | `false` |
| 语义 unknown | 证据不足或存在未决合法观察 | `judge=unknown`，保留原因 |
| 缺测 | 字段、范围、对象或解析结果缺失 | `unknown` 或 `incomplete`，不补 `false`/`0` |
| 执行/覆盖失败 | 读取、解析、timeout、截断或 worker 错误 | 原错保留，`failed`/`incomplete` |
| unsupported language | 语言不在已注册支持域 | 显式 `rejected` |
| out of scope | 文件或候选在 `scopePaths` 外 | 显式 `rejected` |
| 动态属性/绑定 | 只有当前局部证据时才判定；不能一律 unknown | 有证据则 true/false，否则 unknown |

`resultMode=all` 下任意未收口 unknown、截断、覆盖失败或执行失败都阻止根 `achieved`；已具名且 coverage complete 的语义 unknown 可以作为对应义务的终态，但不能被写成 true/false。`resultMode=one` 只允许在固定引擎验证一条路径后早停；剩余候选只报告为未覆盖，不得判定为 false、不得声称完整调用图、不得把模型自报 true 当见证。已知错误在所有模式下都不能被 unknown 或早停替代。

## 8. SESE 与唯一 owner

复用现有 responsibility graph，不新建 value-flow 专用 workflow：

```text
typed request and scope
  -> validate language/scope/anchor
  -> local observation and legal candidate enumeration
  -> StepContext -> x[64]
  -> R relation judge + A current action
  -> fixed read/verify action
  -> actual New State and coverage
  -> final root evaluation and report
```

单入口：通过公开 typed value-flow request 进入。单出口：`achieved`、`unknown`、`rejected`、`failed` 或 `incomplete` 的完整报告。跨步迭代由 controller 新建 run 继续，不在单次 DAG 加回边。

| 职责 | owner |
| --- | --- |
| 请求 schema、anchor、scope、结果合同 | value-flow 领域合同 |
| 只读观测与沙箱执行 | CLI adapter / filesystem sandbox |
| AST、符号、CFG 和路径候选生成 | value-flow policy / adapter |
| StepContext 投影 | `unified-step-context-builder` + `unified-encoder` |
| 关系与动作评分 | 统一 64-slot R/A 评分 |
| 独立监督与最终 oracle | 独立语料 converter / relation oracle evaluator |
| 训练、候选保存与回载 | 统一 `l2-standard-runner` 训练入口 |
| 独立评价与旧能力回归 | Alice 指定的独立评价者 |

## 9. 独立语料与来源分区

### 9.1 语料来源

语料使用旧实现仅作为 teacher/oracle/对照，不把旧产品结果直接写入学生输入。来源族至少覆盖：

| 来源族 | 必须覆盖的关系 |
| --- | --- |
| `reassignment_kill` | 顺序重赋值、读取后未来赋值、Kill 后不可回流 |
| `branch_join` | 单分支保留旧定值、双分支杀灭旧定值、析取链 |
| `loop_fixpoint` | 循环回边、跨迭代相反分支、may-loop precision |
| `destructure_alias` | 对象/数组解构、别名、同名遮蔽 |
| `module_binding` | ESM import/re-export、CJS 局部绑定、未解析模块 |
| `call_return_flow` | 实参到形参、返回站点、调用结果接收 |
| `negative_path` | 未覆盖实参、返回被丢弃、局部函数遮蔽 |
| `unknown_coverage` | 截断、未读候选、解析失败、执行失败 |
| `rejection_boundary` | unsupported language、scope out、非法 anchor |

### 9.2 来源分区

在构造实例之前按来源家族和仓库模块划入 `TRAIN`、`DEV`、`VERIFICATION`：

- 同一文件、同一模块、同一真实项目来源族不得跨分区；同模板尺寸变化、改名、重复快照仍属同一族。
- `DEV` 只用于预声明选参和停止判断。
- `VERIFICATION` 的原始内容、gold、派生特征和错误清单不交给 fitter、样本构造者或候选选择者。
- 若 verification 暴露反例后用于设计或调参，保留原记录并降级为已知回归；不能继续称为未见。
- 不使用完整 oracle 链回填学生行；学生行只来自当前局部观测和合法动作候选。

### 9.3 固定交付文件

每个 value-flow 语料 run 至少提供：

- `student-observations.jsonl`：当前 step 可见事实、合法候选和覆盖状态；
- `independent-supervision.jsonl`：独立 gold、路径证据、unknown 原因、来源与准入；
- `field-mapping.md`：学生侧/监督侧字段映射和禁止输入清单；
- `admissions.json`：分区、来源族、可用性、验证隔离和拒绝原因；
- `readiness.json`：完整候选枚举、数据门状态和缺口。

## 10. 独立评价与验收

### 10.1 独立 oracle

独立评价不调用学生 forward。逐例 gold 由离线静态证明和旧确定性 value-flow analyzer 形成，并保留：

- gold 关系 `true/false/unknown`；
- unknown 原因与未决证据；
- 边的类型、跨度、access path 和 may-provenance 精度；
- 路径证据或“为什么不能形成路径”；
- 来源族、分区和 oracle 版本；
- 是否 `label_missing`。

旧 analyzer 只作为对照和离线 gold 生成器，不作为运行时学生输入，也不作为自动采用依据。

### 10.2 具名分母

分别报告：

1. 已知关系正确数 / 已知关系评价数；
2. `true`、`false`、`unknown` 三类混淆矩阵与 unknown 召回；
3. 最终路径证据正确数 / 期望路径数；
4. 候选枚举覆盖数 / 合法候选数；
5. `truncated`、`failed`、`budget_exhausted`、`unsupported`、`out_of_scope` 计数；
6. 根 `achieved` / `unknown` / `rejected` / `incomplete` 比例；
7. 泄漏检查：学生输入包含 gold、完整链、未来回执或 oracle 的样例数必须为 0。

`label_missing` 不计入正确率分母但保留证据；unknown 不得从覆盖分母静默删除；`one` 模式不得冒充 `all` 完整覆盖。

### 10.3 最终硬门

1. 已知 value-flow 关系逐例 `100%` 正确且错误数 `0`。
2. 有效 unknown gold `100%` 返回最终 `judge=unknown`，无漏报、无误判；`defer/observe` 只可作中间动作，结束时必须有具名 unknown。
3. `all` 模式候选完整，`truncatedCount=0`、`failedCount=0`。
4. scope 外和不支持语言显式拒绝，不混入语义 unknown。
5. verification 来源不进入拟合、样本构造、选参或候选选择。
6. 学生输入不含 gold、teacher 最终链、A_g、未来回执或完整调用图答案。
7. 新候选保持 `uncalibrated/not_applied`，直到独立评价和旧能力回归全部通过并进入模型演进采用流程。

任一项不满足即 `INCOMPLETE` 或 `FAIL`，不能降级为 PASS。

## 11. 训练与回载边界

- 在共享固定训练环境、converter、数据门和真实 runner 经 Alice 验收前，不启动 value-flow 实际拟合。
- 实际训练只使用统一 64-slot package、固定 group loss 与已接受 recipe；不训练 15 维/579 参数旧 runner，不手填权重。
- 训练行只来自 `TRAIN`，`DEV` 按预声明用途使用，`VERIFICATION` 不进入拟合。
- 候选保存后必须新进程回载，并在独立评价者持有 gold 的情况下运行；保存文件存在不等于回载或语义评价通过。
- 旧调用图能力回归与 value-flow 新能力评价分开报告；新能力收益不能抵消旧能力退化。
- 本文不启动训练、不生成权重、不修改采用状态。

## 12. 现有缺口

本设计交付后，以下事项仍由后续 board 生命周期处理：

1. 先审计 §6.2 的共享 `relationshipProjection` 与保留槽位扩展；当前 `nnanything.unified-step.v1` 没有足够的 value-flow 局部字段，审计通过前不私建第二编码器、不改 wire、不启动 fit。
2. 完整学生候选枚举、合法动作集合和 converter 的真实入口。
3. 独立 verification 语料、oracle 证据和分区准入。
4. 共享训练环境、真实 runner、保存/回载入口和数据门验收。
5. 旧调用图能力回归清单与独立评价执行。
6. Alice 对本设计的设计审计；通过前不启动 fit。

## 13. 参考

- `docs/design.md` §1.1、§1.1.1
- `docs/neural-cli-unified-plan.md`
- `docs/l2-four-head-experiment.md`
- `docs/model-evolution.md`
- `docs/semantic-evaluation.md`
- `docs/nn-code-redesign-symbols-tsjs-design.md`
- 旧实现与对照：`lib/cli-value-flow.ts`、`lib/adapters/cli/value-flow-contract.ts`、`lib/adapters/cli/value-flow-recursive.ts`、`lib/filters/cli-value-flow-policy.ts`、`lib/training/value-flow-l2-runner.ts`、`tests/cli-value-flow.test.mjs`
- 旧设计、训练和审计材料：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/value-flow-plan.md`、`value-flow-training-design.md`、`alice-valueflow-readiness-audit.md`、`carol-valueflow-r5-audit.md`
- 本次 REWORK 审计：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-valueflow-design-audit-20261107.md`
