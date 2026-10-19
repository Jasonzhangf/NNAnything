# 训练设计2：cd改变指定会话CWD

状态：历史独立基线已验证，当前正式模型并入统一共享命令模型。历史独立CD动作题记录为train/dev 12/12、6/6，独立验证12/12、4次正常提交、8个失败探针通过（作为历史基线保留，不直接作为共享模型成绩）。旧独立二分类`CD / REJECT`模型合同已退役。CD现作为共享命令模型（`cli.command-policy.v1`）的第2增量阶段（9参数），唯一权威训练合同见[文件系统训练合同](cli-filesystem-training.md)。

调用边界统一沿[参数简化合同](cli-call-contract.md)：模型输出调用序列 `["cd", D]`，S置于显式资源信封中。模型只携带typed引用，不生成Shell脚本或解析stdout。固定脚本和真实路径argv绑定由harness维护。

## 精确语义与学习目标

`Goal {kind:"set_cwd",session:S,target:D}`要求改变S的执行基准。D为明确绝对目录引用；相对路径由调用前的独立path.resolve能力根据S解析，保留原始输入证据，本项不训练找目录或字符串生成。

在共享命令模型中，模型根据Goal与State选择命令头`cd`并输出参数序列 `["cd", D]`。旧独立二分类CD选择器与profile退役，相关权重并入共享profile的9参数矩阵（`unsupported, pwd, cd` × `bias, goalObserveCwd, goalSetCwd`），按名称扩展并回放历史PWD样本。

目标目录名、是否存在、OS权限均不进动作特征；在合法set_cwd输入上选cd，即使执行将失败。授权与存在性由harness检查，失败不等于模型动作选错。

## harness与会话持久性的确定方案

最小方案是harness维护显式session资源`{id,cwd,revision,grantedEffects}`，每次命令使用该资源cwd。无需新建PTY、daemon或修改Agent父进程cwd。S中同一时刻只提交一个目录变更；不同session独立。

真实CLI映射固定为`/bin/zsh -f -c 'builtin cd -- "$1" && /bin/pwd -P' nnanything-cd D`，D作为独立argv传入，不拼入脚本文本；启动cwd来自S。harness先验证目标类型、沙盒归属及授权，执行成功并复核返回物理路径后，才将S.cwd更新为该物理目录并增加revision。后续所有S命令从更新后的资源取cwd。最终目标条目是symlink时拒绝，祖先链接与物理归属按原精确操作合同处理。

实际持久效果由成功执行之后显式提交S的执行基准提供，必须用后续S命令证明。`session.write`由新的CliSandboxEffect承载；原只读固定session不变。

DirectoryRef.path在调用时相对于S当前cwd解析。CD后要重新绑定相对引用；policy同时校验Goal.target与本次引用解析目标相同。跨session/scenario引用在启动进程前拒绝。目标目录的存在、类型、真实归属由harness检查，返回typed错误，不解析错误文案。

提交后另发一轮同一S的`observe_cwd→pwd`，读取更新后的会话资源，作为独立后条件验证。模型选择`cd`、harness提交和后续pwd验证分别记录，不能以script内pwd代替后续S验证。

## 成功、失败与部分效果

| 边界 | New State与GoalResult |
| --- | --- |
| 目标校验、授权或CLI执行失败，尚未提交 | S.cwd/revision保持原值，旧知识保留但不证明Goal；明确失败 |
| 执行与提交成功，后续S的pwd也符合目标 | 记录新S.cwd/revision和本次新观测，Goal achieved |
| 已提交，但后续验证失败或证据不足 | 如实记录已改变的S状态，Goal为未验证/未达成并标明changed；不能伪报旧cwd，也不自动回滚 |
| 其他session或父进程cwd改变 | 未声明副作用，验收失败，不采用候选 |

普通稳定场景下，预期D的物理路径由独立OS检查取得。目标移除/并发变化等会导致验证失败，保留实际效果，不承诺TOCTOU原子文件系统隔离。初版场景由harness独占，不引入并发攻击训练。

## 样本计划与独立验证

保留4 / 2 / 4个来源家族：
- 4个train家族、2个development家族、4个独立verification家族。
- 在共享模型中，每家族包含真实set_cwd（正例标cd）与真实unsupported负例，历史observe_cwd（标pwd）作为回放资料共同训练，严禁将支持命令打为REJECT。

验证探针（8个失败探针保持完整，严格区分native/grant/受控注入）：
1. 不存在目录（native ENOENT）
2. 普通文件（native ENOTDIR）
3. 最终链接（native symlink rejected）
4. 词法越界（harness sandbox bounds）
5. 链接解析后越界（harness sandbox bounds）
6. 缺process.exec（grant拒权）
7. 缺session.write（grant拒权）
8. 提交后观测失败（受控注入验证changed状态报告）

清理失败显式记录并暴露。

## 外层DAG与owner

未发布的独立CD学习图已退役。正式推理统一走`cli-command-step.graph.json`，每阶段训练走`cli-filesystem-training.graph.json`。`cli-filesystem-curriculum.graph.json`是公开consumer按PWD→CD→LS传递共享候选的设计图，没有独立运行配置或新课程执行引擎。

owner：`lib/adapters/cli/`管理session资源、固定执行映射与提交；`lib/filters/`负责纯特征和共享评分；`lib/nodes/`封装参数绑定、workflow与目标后条件；数值电路与拟合由共享训练owner承担。历史独立结果保留，新交付统一经共享候选与公开入口验收。
