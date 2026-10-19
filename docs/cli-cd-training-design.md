# 训练设计2：cd改变指定会话CWD

状态：可实施设计，2026-10-19；session变更、样本和模型尚未实现。前置为[设计1](cli-cwd-training-design.md)真实session观测通过；沙盒、样本分区及采用沿既有公共合同。本页是本项动作、持久状态及训练owner。

## 精确语义与学习目标

`Goal {kind:"set_cwd",session:S,target:D}`要求改变S的执行基准。D为明确绝对目录引用；相对路径由调用前的独立path.resolve能力根据S解析，保留原始输入证据，本项不训练找目录或字符串生成。

NN独立选择`CD / REJECT`。动作固定为`{kind:"CD",session:S,directory:D}`；harness按字段合同绑定S和D。其他Goal在该单项模型中监督REJECT。它不替代原PWD模型，不宣称已完成跨三个模型的总调度器；旧模型作为只读回归保留。后续组合调度是另一个明确目标。

学生输入`[1, goalSetCwd, goalObserveCwd]`；2×3线性logit、6参数、softmax交叉熵、同分REJECT。内部图沿设计1的乘权→求和→logit→argmax/训练loss结构，标签词表换成REJECT/CD，profile独立命名，禁止把PWD权重按数组位置当CD权重。目标目录名、是否存在、OS权限均不进动作特征；在合法set_cwd输入上选CD，即使执行将失败。授权/存在性由harness检查，失败不等于模型动作选错。

教师输出动作标签；真实执行转换记录提供效果监督与验收。本轮不另训练状态预测头，也不把固定goalSetCwd特征解释为自动理解自然语言。初始训练预算为200epochs/lr0.1的真实Handwired全批SGD，开发集决定是否需要调整，独立验证不挑预算。

## harness与会话持久性的确定方案

最小方案是harness维护显式session资源`{id,cwd,revision,grantedEffects}`，每次命令使用该资源cwd。无需新建PTY、daemon或修改Agent父进程cwd。S中同一时刻只提交一个目录变更；不同session独立。

真实CLI映射固定为`/bin/zsh -f -c 'builtin cd -- "$1" && /bin/pwd -P' nnanything-cd D`，D作为独立argv传入，不拼入脚本文本；启动cwd来自S。harness先验证目标类型、沙盒归属及授权，执行成功并复核返回物理路径后，才将S.cwd更新为该物理目录并增加revision。后续所有S命令从更新后的资源取cwd。最终目标条目是symlink时拒绝，祖先链接与物理归属按原精确操作合同处理。

这里不是声称子进程修改了父进程：实际持久效果由成功执行之后显式提交S的执行基准提供，必须用后续S命令证明。`session.write`是待实现的typed effect；当前M0不支持该授权或变更，不能把它塞进metadata绕过现有合同。

提交后另发一轮同一S的`observe_cwd→PWD`，读取更新后的会话资源，作为独立后条件验证。NN选择CD的成功率、harness提交成功率和后续pwd验证率分别记录，不能以script内pwd代替后续S验证。

## 成功、失败与部分效果

| 边界 | New State与GoalResult |
| --- | --- |
| 目标校验、授权或CLI执行失败，尚未提交 | S.cwd/revision保持原值，旧知识保留但不证明Goal；明确失败 |
| 执行与提交成功，后续S的pwd也符合目标 | 记录新S.cwd/revision和本次新观测，Goal achieved |
| 已提交，但后续验证失败或证据不足 | 如实记录已改变的S状态，Goal为未验证/未达成并标明changed；不能伪报旧cwd，也不自动回滚 |
| 其他session或父进程cwd改变 | 未声明副作用，验收失败，不采用候选 |

普通稳定场景下，预期D的物理路径由独立OS检查取得。目标移除/并发变化等会导致验证失败，保留实际效果，不承诺TOCTOU原子文件系统隔离。初版场景由harness独占，不引入并发攻击训练。

## 样本计划与独立验证

| 分区 | 独立场景家族 | 每家族动作题 | 计划动作题总数 |
| --- | ---: | ---: | ---: |
| train | 4 | set_cwd、observe_cwd拒绝、其他Goal拒绝各1 | 12 |
| development | 2 | 同上 | 6 |
| verification | 4 | 同上 | 12 |

train使用兄弟目录、子目录、父目录、同目标目录四种关系；development使用不同多层树和空格目录；verification由独立配方提供中文/尾随空格、多session、连续两次cd、祖先链接目标。关系只影响真实环境，不进入本项三向量策略，不能声称学会了新的路径算法。

验证另加8个失败探针：不存在目录、普通文件、最终链接、词法越界、链接解析后越界、缺process.exec、缺session.write、提交后观测失败。最后一项通过受控删除或观测故障注入验证“已改变但未验证”报告；它是副作用合同测试，不冒称纯真实OS成功场景。每个探针注明native还是受控注入。安全拒绝不能算学对动作。

每条有副作用样本重新创建独立树与session。连续两次cd只在同一条明确轨迹内共享session，整条轨迹不得跨分区。零/冻结/候选比较，旧PWD及路径黄金只读回归；开发调优后再运行独立验证。

train只用2至3个目录的单步场景；development使用不同三层分支树；verification配方采用至少两条不同深度分支、三session和多步轨迹，另叠加特殊名称或链接。验证作者独立声明目标/预期，不复用train构造器后仅换名称。关系类型可以相同，实际配方来源与轨迹必须分开，并报告只有三种学生动作向量。

## 外层DAG、验收与owner

训练图：[cli-cd-learning.graph.json](../workflows/cli-cd-learning.graph.json)。独立验证节点必须包含“执行CD→提交S→下一run同一S执行PWD→比较后条件”；这些是harness事务与验证步骤，不在DAG加重试回边。

只有已提交的CD场景触发后续PWD；策略拒绝与提交前失败保留typed结果直接检查状态，不额外调用PWD后冒称对照零执行。每个正常/失败终态先保存证据，再在report收口自有场景；异常退出也由场景owner回收，不用成功图出口假定一定清理。

验收：验证12/12动作正确；4个正常场景均在后续S的pwd中达到目标；连续轨迹每步基准正确；8个失败探针都符合实际效果合同；其他session与父进程不变；旧能力零退化；保存/回载一致。证据缺项保持候选，不自动采用。

唯一owner：`lib/adapters/cli/`管理session资源、固定执行映射与提交；`lib/filters/`/`lib/nodes/trainable/`实现独立CD评分及6参数电路；`lib/training/`负责样本、真实拟合及比较。现有`createCliSession`固定cwd合同不得偷偷改变：新增明确可变session入口或显式扩展版本，原只读入口保持兼容。实现前红测必须抓住“一次性子进程cd看似成功但后续S未改变”、失败后误提交和跨session污染。
