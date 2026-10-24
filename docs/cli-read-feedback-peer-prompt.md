# 新peer执行任务：CLI读取反馈与下一Goal实验

发送方Alice（NNAnything designer），Jenny为项目master。你是本实验受托peer编排者，负责规划、GCM执行/观察、独立Review、真实交付与自有资源收口。用户已明确基础训练/推理训练分层、读取通用特征、错误后操作与语义收敛；本任务不做正文理解。

先按collab恢复本人身份/角色，读取master正式任务条件并接受，再自行登记本目标；不提升master，不代别人持有目标。协调与Carol的C-A1/搜索主线边界；本实验专属新模块，不改她的文件或复用她的dirty树。

唯一实验合同：docs/cli-read-feedback-experiment.md。必读docs/design.md 1.1.5、model-evolution.md 2.2/2.3、cli-programming-search-m1.md、AGENTS及本地设计/训练Skill。执行前先读受影响DAG/现有file.read合同，独立Plan固定数值与训练合同；不再向用户逐项确认已授权范围。

当前最小增量：bytes的head/tail/range；基础ReadFeedbackUnit学习读取结果及错误；ReadReasoningUnit学习反馈与Goal条件的联系，输出下一合法需求/Goal。随后按合同扩行数/字符数和本单元在线学习实验。复用ls、entry.inspect、file.read、唯一共享命令policy及recursive-goal，操作/计数/预算不另写循环。首要真实轨迹是分段不足→剩余读取Goal→根收敛，以及一次受控瞬时错误→合法重试Goal→根收敛。

允许：独立外置worktree内的本实验adapter/filter/trainable/training模块、公开consumer、测试、独立fixture和领域文档，名称前缀与allowed paths由正式任务/Plan明确。禁止：修改lib/core、lib/workflow/recursive-goal、既有共享命令矩阵、他人目录、真实用户源码、未知程序/网络、权限提升、正文含义/符号解析，以及手填见证权重冒充训练。

训练前做可辨/有效梯度与真实读取前提检查，训练资源与测试沙盒隔离。模型消费通用读取事实与Goal条件，不消费正文、fixture ID、gold或故障注入开关。期待在执行前保存；原始数据与计数不由模型编造。基础反馈、推理结果语义和真实根结果分开，不用自评分自产监督。

执行实验合同的有限训练与停止条件，不为失败自动续训。在线使用后数据先复核，候选训练/保存/新进程回载后在新任务上比较；不在途换版本，不自动采用有回归候选。成功/EOF/未完成/错误/未知必须准确，单步试错允许，重复已证失败、错误升级/越权与假成功不允许。

交付须给：独立Plan及图/数值设计、样本与来源、训练/回载原始证据、独立OS/fixture oracle、逐步期待/观察/反馈/衍生Goal/根结果、正常错误停止和恢复轨迹、在线前后配对指标、可复跑入口、剩余缺口。效率未提升如实报告，不能靠删失败/放宽根Goal取得通过。完整milestone自验后按现有合同独立Review、finding定点修复，再由owner完成正式集成和资源收口。
