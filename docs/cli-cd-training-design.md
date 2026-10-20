# 训练设计2：cd改变指定会话CWD

状态：历史独立基线已验证，当前正式模型并入统一共享命令模型。历史独立CD动作题记录为train/dev 12/12、6/6，独立验证12/12、4次正常提交、8个失败探针通过；这些只作历史基线。旧独立二分类`CD / REJECT`与旧9参数阶段模型均已退役。CD现是`cli.command-policy.v1` typed `file.property` 6×14单矩阵中的`cd`/`NOOP`/`DEFER`切片，唯一权威训练合同见[文件系统训练合同](cli-filesystem-training.md)。

调用边界统一沿[参数简化合同](cli-call-contract.md)：模型输出调用序列 `["cd", D]`，S置于显式资源信封中。模型只携带typed引用，不生成Shell脚本或解析stdout。固定脚本和真实路径argv绑定由harness维护。

## 精确语义与学习目标

当前Goal为`file.property.relation.sessionCwd`的`equals`要求，target为显式session query，expected为typed `DirectoryRef`或合法未绑定`DirectoryQuery`。DirectoryRef.path按S当前cwd解析；DirectoryQuery本轮进入DEFER且不扫描磁盘。本项不训练找目录或字符串生成。旧`set_cwd` kind已退役。

在共享命令模型中，模型根据typed Goal与State在6个全head上选择。适用真观测已证明cwd等于D时选`NOOP`；不等于D、cwd未知或旧知识过期但S/D完整时选`["cd", D]`；合法未绑定DirectoryQuery选`DEFER`。旧4×4交叉块按名称迁移，新行新列补零后再真实拟合。

目标目录名、是否存在、OS权限均不进动作特征；在目录引用已绑定且fresh真观测未证明已等于目标的typed equals Goal上选cd，即使执行将失败。授权与存在性由harness检查，失败不等于模型动作选错。

## harness与会话持久性的确定方案

最小方案是harness维护显式session资源`{id,cwd,revision,grantedEffects}`，每次命令使用该资源cwd。无需新建PTY、daemon或修改Agent父进程cwd。S中同一时刻只提交一个目录变更；不同session独立。

真实CLI映射固定为`/bin/zsh -f -c 'builtin cd -- "$1" && /bin/pwd -P' nnanything-cd D`，D作为独立argv传入，不拼入脚本文本；启动cwd来自S。harness先验证目标类型、沙盒归属及授权，执行成功并复核返回物理路径后，才将S.cwd更新为该物理目录并增加revision。后续所有S命令从更新后的资源取cwd。最终目标条目是symlink时拒绝，祖先链接与物理归属按原精确操作合同处理。

实际持久效果由成功执行之后显式提交S的执行基准提供，必须用后续S命令证明。`session.write`由新的CliSandboxEffect承载；原只读固定session不变。

DirectoryRef.path在调用时相对于S当前cwd解析。CD后要重新绑定相对引用；policy核对Goal中的typed目标与本次执行引用一致。跨session/scenario引用在启动进程前拒绝。目标目录的存在、类型、真实归属由harness检查，返回typed错误，不解析错误文案。

提交后在同一请求内执行一次固定后验PWD，读取更新后的会话资源，作为独立后条件验证。模型选择`cd`、harness提交和后续PWD验证分别记录，不能以script内pwd代替S状态验证，也不能重复观测。

## 成功、失败与部分效果

| 边界 | New State与GoalResult |
| --- | --- |
| 目标校验或CLI执行native失败，尚未提交 | S.cwd/revision保持原值，旧知识保留但不证明Goal；`failed/0` |
| 授权或typed绑定拒绝，尚未提交 | S.cwd/revision保持原值；`rejected/0`并保留具体原因 |
| 执行与提交成功，后续S的pwd也符合目标 | 记录新S.cwd/revision和本次新观测；`achieved/100` |
| 已提交，但后续观测失败或证据不足 | 如实记录已改变的S状态；`unknown/null`或`failed/0`并标明changed，不能伪报旧cwd或自动回滚 |
| 已提交，后续观测有效且明确不匹配 | 保留实际改变；`unmet/0`，不能把已证不匹配降为未知 |
| 其他session或父进程cwd改变 | 未声明副作用，验收失败，不采用候选 |

`satisfactionThreshold`由调用者显式给0..100，公开结果类型及完整评价表唯一维护于[文件系统训练合同](cli-filesystem-training.md)。只有同session、当前revision、物理目录基准一致且来源受信的本次/仍适用真观测证明已等于D时，NOOP才提前完成Goal；普通旧知识、陈旧revision或伪造fresh字段不能提前完成。共享命令模型与CWD关系模型均引用公共[设计流程](../workflows/project-design.graph.json)、[模型演进](../workflows/model-evolution.graph.json)和[冲突设计](../workflows/model-conflict-design.graph.json)；自动采集、当前版本、自动比较采用及LLM冲突处理仍未实现，旧`set_cwd`入口已退役。

普通稳定场景下，预期D的物理路径由独立OS检查取得。目标移除/并发变化等会导致验证失败，保留实际效果，不承诺TOCTOU原子文件系统隔离。初版场景由harness独占，不引入并发攻击训练。

## 样本计划与独立验证

保留4 / 2 / 4个来源家族：
- 4个train家族、2个development家族、4个独立verification家族。
- 历史独立样本计划保留；当前typed训练样本由PWD/CD/LS、NOOP/DEFER和受信证据配对组成，旧命令能力进入零回归回放，旧Goal不再作为运行标签。

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

未发布的独立CD学习图已退役。正式推理统一走`cli-file-property.graph.json`（6N5E，0.2.0），训练走`cli-filesystem-training.graph.json`（8N8E，0.2.0）。`cli-filesystem-curriculum.graph.json`只保留未来属性单元顺序设计，没有独立运行配置或新课程执行引擎。

owner：`lib/adapters/cli/`管理session资源、固定执行映射与提交；`lib/filters/`负责纯特征和共享评分；`lib/nodes/`封装参数绑定、workflow与目标后条件；数值电路与拟合由共享训练owner承担。历史独立结果保留，新交付统一经共享候选与公开入口验收。
