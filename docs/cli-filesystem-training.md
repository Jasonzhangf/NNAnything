# 文件系统沙盒与共享命令模型增量训练

状态：实施合同，源码已实现；正式共享训练（PWD→CD→LS）与独立验证已通过；作者全量回归、整体Review与集成待完成。实测计数、计时与run记录见[共享模型实测](cli-filesystem-training-results.md)，本文不重复历史表。本文是全命令统一共享模型与增量训练的唯一权威合同。总体Goal/State定义见[总体设计1.1](design.md#11-结构化语义的目标与状态推理)；调用与资源信封见[参数简化合同](cli-call-contract.md)；精确操作与固定映射见[语义目录](cli-semantic-operations.md)。
2026-10-19 设计扩展：前三项仍为首轮实施顺序，之后补全目录/路径操作，再补文件操作，目录见 [cli-semantic-operations.md](cli-semantic-operations.md)2.1/2.2。所有新语义统一为 [file.property.xxx](cli-filesystem-semantics.md)，内容、用途、条件与能力关联均归为属性判断和属性状态变化，复用 `cli-file-property.graph.json`，不零散增加Goal。下列原始题型和已实现入口保持历史真实合同；迁移由各owner在独占实现中完成，不靠文档冒称迁移生效。

用户已选择真实文件系统中的专用沙盒目录，不声称硬件、虚拟机或操作系统权限隔离。目录/文件属性扩展仍为设计，不将静态图校验称为新增执行器已实现。

## 0. 固定四元素与满足度评价

当前共享命令入口固定 `satisfactionThreshold=100`。公开固定配置为 `CLI_COMMAND_GOAL_CONFIG`，运行时不能从`.step()`请求、profile或环境选择任意阈值。`goal_result`使用公开`CliCommandGoalResult`类型，保存实际`satisfaction: 0 | 100 | null`；结果不重复保存阈值。

| 单元 | Goal / satisfactionThreshold | State | Action与达标事实 |
| --- | --- | --- | --- |
| PWD | 本请求新观测S的物理cwd；100 | 显式S、旧知识及来源、harness执行条件 | 共享模型选`pwd`；harness执行本次真实观测；S.cwd/revision不变且证据属于本次S |
| CD | 本请求执行并确认S到达D；100 | S当前执行基准、D typed绑定、授权及旧知识 | 共享模型选`cd`；harness提交S，再用同一S的新PWD确认目标 |
| LS | 本请求完整观测D的直接条目及类型；100 | S、D、旧目录知识及执行条件 | 共享模型选`ls`；harness返回本次完整、有类型证据的直接列举，S不变 |
| CWD关系 | 正确判定候选知识是否属于查询S；100 | 查询引用、候选观测槽位；学生输入仍为`sameSession/hasObservation` | 计算既有六参数模型，输出`MATCH/NO_MATCH`；有监督时正确为100、错误为0，无评价真值时未知 |

PWD、CD、LS都要求本请求的新动作及新证据。旧知识、同目标CD或关系`MATCH`均不提前完成Goal。State、授权及固定阈值当前不改变该切片的正确命令头，因此保留在harness或固定配置中；学生仍只学习Goal kind到命令头的选择。训练期反推关系为`Goal + 固定100 → 必需实际New State/证据 → 所需命令 → harness前置条件`。这是监督和样本设计关系，不是数值梯度反传；既有Handwired梯度路径不变。

| 实际路径 | Goal结果 | 边界 |
| --- | --- | --- |
| PWD成功，本次观测有效且S未变 | `achieved / 100` | 写入本次cwd知识及来源 |
| PWD native OS或grant失败 | `unmet / 0` | 本请求新观测未完成；旧知识保留，不评价未知真实cwd |
| 错命令头被guard拒绝或目标引用不匹配 | `unmet / 0` | 保留`policy_error`或目标绑定错误，不执行错误动作 |
| 未支持或没有定义评价规则的语义Goal | `unverified / null` | `execution_result.status=unsupported`，不调用executor |
| CD提交前失败或拒绝 | `unmet / 0` | S不变；旧cwd已等于目标也不能算本请求完成 |
| CD提交后同S新PWD与目标一致 | `achieved / 100` | 保留真实提交、新观测及副作用 |
| CD已提交，后续观测失败或证据不足 | `unverified / null` | 保留新S、实际`changed`及失败回执，不回滚 |
| CD后续观测有效且明确不匹配 | `unmet / 0` | 保留实际改变，不以未知覆盖已证失败 |
| LS完整且全部必要类型有证据，S未变 | `achieved / 100` | 写入本次完整目录知识 |
| LS native或grant失败 | `unmet / 0` | 本请求新列举未完成，旧知识保留 |
| LS partial、类型unknown或必要条目证据不足 | `unverified / null` | 不定义比例满足度，不覆盖旧完整知识 |
| 已证发生禁止的cwd/revision副作用 | `unmet / 0` | 必要条件为假，即使产生观测也不能达成 |

`changed`只表示实际session的cwd/revision变化，不表示知识变化或目标成败。PWD/LS新增知识可以为`changed:false`；CD验证失败仍可能为`changed:true`。固定100不提高模型分数、执行成功或harness权限的效力，满足度也不代替真实Goal验收。

两个CLI可训练单元按公共设计资料流和升级对象流挂接，不复制公共规则：

| 单元 | 设计流程 | 单元升级与冲突 | 当前状态 | 具体缺口 |
| --- | --- | --- | --- | --- |
| 共享命令模型 | `workflows/project-design.graph.json` | `workflows/model-evolution.graph.json`、`workflows/model-conflict-design.graph.json` | 离线增量训练、保存后新进程回载、独立评价及旧命令回归已有证据；候选`uncalibrated/not_applied` | 使用样本自动采集、显式当前版本引用、自动配对比较采用、自动冲突移交及LLM裁决执行链未实现 |
| CWD关系模型 | `workflows/project-design.graph.json` | `workflows/model-evolution.graph.json`、`workflows/model-conflict-design.graph.json` | 六参数关系分类、历史离线评价及回载证据保留；不作为命令selector | 使用样本自动采集、显式当前版本引用、自动比较采用、自动冲突移交及LLM裁决执行链未实现 |

下一步顺序沿公共合同：先补自动使用采集及使用/候选隔离，再补当前版本与配对比较/自动采用，最后补冲突裁决执行链。当前不得把自动升级、自动采集或LLM裁决写成已完成。

## 1. 统一共享命令模型

本项目使用单一共享模型与权重profile承载所有已注册的CLI命令（`pwd`、`cd`、`ls`）与不支持识别：

- 合同标识：`cli.command-policy.v1`
- 命令头（heads）：`unsupported`, `pwd`, `cd`, `ls`
- 输入连线（wires）：`bias`, `goalObserveCwd`, `goalSetCwd`, `goalListDirectory`
- 最终参数结构：4×4，共16个参数
- 状态属性：`calibration: "uncalibrated"`, `adoption: "not_applied"`
- 同分规则：稳定顺序，`unsupported`优先；结果严格按teacher计分

模型接收结构化Goal与State；profile、sandbox与会话在策略工厂绑定：`createCliCommandPolicy({ profile, sandbox, session: S })`，每次调用传`step({ goal, state, directory? })`。请求没有`resources`或`directories`字段。模型输出调用序列首项取自命令头，是小写实际Shell命令名；后续项是机械绑定的typed位置参数引用，模型不生成自由参数文本：
- `observe_cwd(S)` → `["pwd"]`（harness执行固定PWD观测）
- `set_cwd(S,D)` → `["cd", D]`（harness执行固定CD脚本，提交S，并在同一S执行PWD验证）
- `list_directory(S,D)` → `["ls", D]`（harness通过固定编译结构化helper列举）
- 未支持语义Goal → 内部输出`unsupported`，`invocation: null`，`executorInvoked: false`，不执行任何Shell命令

示例（set_cwd）：

```ts
const policy = createCliCommandPolicy({ profile, sandbox, session: S });
const transition = await policy.step({
  goal: { kind: "set_cwd", session: S.sessionId, target: absoluteTarget },
  state: { session: S.sessionId, cwdObservation: null, directoryListing: null },
  directory: D,
});
```

`DirectoryRef.path`在调用时相对S当前cwd解析；CD提交后，调用者必须重新绑定相对引用。`set_cwd`与`list_directory`的`Goal.target`是配置后的绝对路径，必须与本次绑定引用解析出的目标一致；harness不做隐藏重定向。命令头预测错误时，guard拒绝执行但仍记录`policy_error`，不能把错误伪装成`unsupported`或OS失败。

历史独立的二分类CD/LIST模型合同已退役。旧main的六参数PWD API（`cli.goal-policy.v1`）作为历史兼容基线保留，不被新共享入口调用；新共享路径不存在逐命令binary profile。CWD关系是独立概念测量：`MATCH/NO_MATCH`，`x=[1, sameSession, hasObservation]`，共6个参数；历史16/8只是样本计数，不产生命令selector。

## 2. 递进增量训练（Curriculum）

共享候选采用三阶段递进训练，阶段间按名称保留权重并扩展，上一阶段保存的候选作为下一阶段的输入起点：

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

## 3. 样本分区与监督标签迁移

保留来源家族隔离：共享数据集含4个train家族与2个development家族，同一家族不跨分区。正式共享run未提供可选verification资源；4个独立verification家族由独立作者另建，由父级独立报告单独记录。
共享训练图适用于目录与文件属性单元，入口必须提供具体属性键、对象、Goal条件、satisfactionThreshold、可见State及可学习Action关系。训练期反推达标属性与前置条件；每项补齐自己的输入/wire/参数/损失后才可实施。当前图没有自动获得新属性模型或新harness，具体缺口沿属性合同第5节记录；完成训练与独立回载后再进入既有model-evolution单元升级流程。

普通属性单元现已由 [cli-property-training-design.md](cli-property-training-design.md) 补全B/P/R/C输入、电路、监督和验证配方；固定调用方案由 [cli-command-design.md](cli-command-design.md)维护。该文件描述的`0.2.0-design`首节点属性效果反推仍是未来扩展设计；当前`workflows/cli-filesystem-training.graph.json`及绑定保持`cli.command.*@0.1.0`共享命令运行版，8N8E拓扑和后续分区/拟合/保存/回载/评价/收口不变。前三项旧方案仍保留其已实施状态，不能把新设计当作新训练证据。

共享过程是单源单汇DAG。分区声明之后分成两条资料链：训练/开发准备与独立验证准备。拟合节点只收到训练资料；独立验证资料在候选形成后才与候选合流。验证不回流修改本轮参数。

每条样本按实际语义打标，严禁将支持的命令在其他命令训练中打上REJECT：
- `observe_cwd` → `pwd`
- `set_cwd` → `cd`
- `list_directory` → `ls`
- 未支持语义Goal → `unsupported`

数据集构成：
- 4个train家族与2个development家族，每个家族包含pwd、cd、ls及真实unsupported各1题。
- 最终全量数据集：16条train行（4家族×4类别），8条development行（2家族×4类别）。
- 阶段数据集：PWD阶段为8 train / 4 dev（pwd + unsupported）；CD阶段为12 train / 6 dev（+cd）；LS阶段为16 train / 8 dev（+ls）。
- 验证集由独立作者配方另行提供，加上各命令专属失败探针；父级独立报告单独记录，不进入默认train/development分区。若调用者显式提供可选verification资源，receipt才记录`evaluation`分支。测试覆盖有限特征向量与真实环境变化（空格、中文、嵌套、链接等），不冒称未见语义泛化。

## 4. 真实文件系统沙盒与harness边界

沙盒执行器（`lib/adapters/cli/`）提供隔离的场景目录与显式session资源。每个分区与每条带副作用的样本独立创建目录与session：

- **PWD**：执行`/bin/pwd -P`，读取物理cwd观测。S.cwd保持不变。
- **CD**：执行固定zsh脚本，先验证目录类型与归属，成功后提交S.cwd与revision；紧接着在同一S上执行真实PWD验证后条件。提交前失败不修改S；提交后验证失败如实报告实际修改状态，不伪报回滚。
- **LS**：通过固定编译本地helper执行（`process.execPath + helperPath + D`），返回直接条目的结构化JSON（包含精确名称、由OS lstat观测的类型、coverage及errors）。不修改S.cwd，不修改文件系统。partial结果不能覆盖旧知识或冒充完整列举。严禁将`/bin/ls`面向人类的文本输出分词或flags称为NN训练。
- **失败与清理分类**：报告中严格区分native OS错误、grant授权拒绝、受控故障注入；native与注入不合并计数，fixture创建失败、清理失败与模型策略错误分别计数。清理失败显式暴露。

资产保存在既有目录，不新建根级资产目录：
- 样本：`training/samples/filesystem/<capability>/<run>/`
- 候选：`training/weights/filesystem/<capability>/<run>/candidate.json`
- 报告：`training/results/filesystem/<capability>/<run>/report.json`

## 5. 推理与训练DAG

- 推理DAG：`workflows/cli-command-step.graph.json`（3节点/2边，0.1.0）及同名workflow配置，负责接收Goal/State，通过共享profile计算分数，选出命令头与参数引用，经harness分流执行并验证后条件，收敛于统一SESE出口。
- 训练DAG：`workflows/cli-filesystem-training.graph.json`（8节点/8边，0.1.0）及同名workflow配置，接收调用者准备并分区的dataset。它不生成fixture，也不自行启动新进程回载；fixture由公开consumer的`makeCliCommandFixture`创建，各阶段保存候选后由consumer重新读取，并以新进程运行reload脚本。
- 阶段调度：`workflows/cli-filesystem-curriculum.graph.json`现为7节点/6边、0.2.0-design，前三项后接目录/文件属性设计；公开consumer只执行已实现的PWD→CD→LS共享增量训练，不执行新增设计单元。课程图不是运行配置、新引擎或workflow绑定。旧未发布的cli-cwd/cd/list-learning图已删除。
- 拟合迭代：epoch循环在数值拟合器内完成，不给外层workflow加回边。

## 6. 当前实施状态与验收底线

当前状态：源码已实现（`createCliCommandPolicy`与`runCliCommandTraining`），正式共享训练三阶段与独立测试已通过。当前共享run为pwd `333bb151-003e-4188-a027-e145eb591760`、cd `a22e71aa-dbd5-44ce-ab1e-56a7a89f6d57`、ls及最终候选 `d7c4a3e5-4111-4e09-857f-5f20f4fa18c0`；profile保持`uncalibrated`/`not_applied`。作者全量回归、整体Review与集成仍待完成，完整计数和计时见[共享模型实测](cli-filesystem-training-results.md)。

历史独立PWD与CD实测数据保留为历史基线，不直接抄写为共享模型结果。`accepted`只表示train/dev与历史回归通过；未提供可选verification资源时`fullyVerified=false`。训练图的冻结/零权重对照只做预测，不执行命令；独立测试由父级独立报告另行记录，不声称在训练图内执行。

验收门槛：
1. 共享模型经统一公开入口在新进程加载，逐命令独立验证通过：已通过（父级独立报告）。
2. 历史必需能力零回归：train/dev历史回放已通过。
3. 真实argv、权限拒绝、受控注入和清理回执完整无遗漏：独立测试已覆盖；作者全量回归仍待完成。
4. 当前只支持`pwd`/`cd`/`ls`。未来命令复用同一增量合同，不代表任意系统命令已可执行。自然语言识别、help泛化、文件搜索、多步组合规划、browser与自动升级保持在范围外。
