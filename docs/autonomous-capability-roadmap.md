# CLI与浏览器：自主目标执行及未知场景泛化总路线

2026-10-23用户明确的总目标：CLI自主使用已训练CLI集合，并扩展未知CLI；浏览器自主完成已训练目标集合，并泛化到不同网页的同类目标。本文维护跨域目标、增量依赖及完成尺度；具体算法/训练/错误与采用条件仍由既有领域owner维护，不建第二套运行框架。

本文更新此前切片的默认范围：广义CLI适配与网页对象自动绑定现在是明确后续目标，不能再用旧文档“本轮不做”把它们永久排除；但也不能把这次授权解释成任意shell执行、账号写操作、权限变更或自动采用已实现。旧切片的准确运行边界继续有效。

## 2026-11-13 TS/JS 实际后训练结果

已用原 first-fit 权重完成独立 post-projection 后训练，候选为 `0.1.2-post-projection-r1`，仍 `uncalibrated/not_applied`。本轮训练 R 共享 scorer，D/E/A 未训练。旧 TRAIN 的引用、非引用及继续查找行为保留；动态不确定组由原先误判 false 改为 unknown。新词法对照能区分同声明与同名异模块。其词法判断在修正输入后的旧权重上也成立，因此不把 bridge 的身份修复计为新增训练能力。

固定 loss 从初始 `0.5799938288431852` 降至保存权重重新前向计算的 `0.10065258155392573`。原包继承与独立进程回载通过。优化实际耗时约三秒；预算上限只解释停止原因，不代表目标达成。

首次真实 consumer 的词法判断正确，但读取/绑定证据未准入，查询为 incomplete；该失败保留。补齐词法来源证据接线后，同一保存候选在真实源码入口分别返回 complete_true 和 complete_false。此结论仅覆盖直接具名 import 到顶层函数的 TRAIN 对照，不是新语言泛化。旧 DEV 的同名异模块与常量属性用例仍失败；动态 helper 回归通过。历史独立来源的单步选择正确，但一项 unknown 完成证据缺失。不得据此宣布完整 CLI 交付或采用候选。

证据入口：`/Volumes/Intel/playground/nnanything-runs/nncode-training-full-audit-20261109/training-delivery-20261113/progress.md`；训练事实见其 `tsjs-post-projection-training-r1-20261113/fitter-report.md`，首次真实评价见 `evaluation-result.md`，词法完成复验见 `runtime-consumer-preparation/completion-candidate/report.md`。浏览器本轮只完成真实页面采证，没有获得合格的新 TRAIN 对照，未启动新的浏览器拟合。

## 共同的完成定义

调用者给结构化根Goal、satisfactionThreshold、允许范围、权限、可用技能/版本与运行限制；不逐步提供head、子Goal顺序、目标对象ref、页面selector或正确答案。框架自行观察、生成当前必要子条件、从启用技能选择一步、绑定对象与参数、执行、重观测并收回根目标。固定预算/重试控制、权限、受信引用与真实根评价保持确定性。未完成/缺能力/缺证据/拒绝/错误分开，不能机械执行完就称达成。

“自主”是声明范围内的目标执行，不要求自然语言解析。显式根目录/页面scope是合法授权输入；直接传正确文件/输入框/按钮ref则属于辅助绑定，要在指标中单列。现有辅助绑定consumer是基线，不宣称自主识别。

“泛化”至少分三轴：新对象/数据、新实现/布局、新工具能力。每轮明确测试哪一轴；换名字/样式不算独立实现，手填权重反转不算训练，真实浏览器fixture不等于真实站点。

四元素不变：Goal是本次用户任务，阈值是预先定义的要求，State是当前可信观测和已声明资源，Action是当前合法技能及必要观察。二元目标0/100、unknown为null；模型效用不是满足度。

## 2026-10-24 当前优先级与纠错完成尺度

用户将CLI短期目标收敛为编程任务的搜索部分：训练沙盒与测试CLI沙盒独立，在已知技能集合内完成找文件、找字符串及文件条件与内容条件的组合匹配。具体切片、训练责任、测试与验收见[编程搜索M1](cli-programming-search-m1.md)，执行交接见[peer提示词](cli-programming-search-m1-prompt.md)。先证明这条路径可纠错且可达，再推进计划、修改、测试及未知工具适配；C-G1既有设计保留，不抢占本短期主线。

两域追求“执行出错后能依据真实反馈找到正确路径，并在多次类似任务中提高效率”，不要求首选动作次次正确。分报首次命中、预算内根达成、失败后恢复与重复任务成本；单步可恢复误选不能直接等同整条能力失败。基础事实/监督真值、权限、实际副作用与根Goal真实验收仍保持原合同，不能为了容许试错把错误写成成功。

恢复必须存在已启用合法路径：每步执行后有相应观察，失败只按已证范围更新当前State或失败先验，选择合法次选/必要时回到真实checkpoint重推。没有合法技能、权限或足够证据时准确停止；预算/重试不因换路径重置，不学习层序或复制控制器。

类似任务提效以固定资源与预算下的配对真实轨迹验证：最终成功率与恢复率不退化，至少一项声明成本（重复失败次数、命令/观察次数、读取字节或时间）改善。报告冷启动、同任务缓存及隔离候选训练/新进程回载后的新任务迁移，不能用缓存或后验答案回填冒称学习。正式采用仍沿model-evolution的无回归/独立证据规则；当前不自动扩大为已运行的采样训练采用链。

## 分工与现有基础

Alice（designer/详细设计owner）：目标拆解、逐条件语义、对象与证据关联、详细I/O、算法与步骤、具体反例和验收、失败裁决；发现未定义分支时保留证据交Alice裁决，worker只停该分支。Jenny（项目master）：派发、进度与集成协调；跨peer范围、共享owner依赖与冲突协调，不代Alice做技术裁决。Carol：CLI域目标编排。Bob：浏览器域目标编排。worker只按Alice已落盘的明确文档执行，不自行补语义、不改gold/门限/预算/目标函数、不归因根因。独立Reviewer负责交付审查。同一文件/任务域仍只有一个活动owner；每个peer自行编排已定方案的执行、派GCM执行与观察、独立Review、main交付和资源收口。

CLI已有路径/属性命令、受信精确查找、只读单/多来源根组合，排序接口可替换但未训练；浏览器已有基础分类、普通text输入、显式绑定搜索与展开域反馈。已知B1、F1独立评价与搜索学习恢复缺口不清零。候选仍uncalibrated/not_applied。

## CLI主线

| 增量 | 可交付行为 | 训练责任与验收 |
| --- | --- | --- |
| C-A1 已知集合自主入口 | 一个领域Goal入口接收允许范围内的cwd目标、目录观测目标、文件范围字节目标；从启用的已知技能选择/组合，无需调用者提供selector/evaluator ID或逐步head。文件目标只给范围和语义条件，由观测得到受信对象 | 复用共享cli.command-policy.v1；根分派/固定绑定可确定性实现，不虚设NN。未知属性准确拒绝。至少覆盖三类根Goal、已满足零动作、错选拒绝、缺权限、对象改变与真实根失败。旧操作不回归，报告实际哪些选择用训练候选 |
| C-A2 已知语义新场景 | 同一入口处理独立目录结构/名称/数据和多步条件，必要观察与下一动作只根据当前State决定 | 先区分固定模板复用与学到语义。只有存在可辨且有收益的对象关联/技能选择/策略问题才拟合；显式order已够则规则保留，继续其他目标。至少一个完整实现来源只用于独立评价 |
| C-G1 未知工具最小适配 | 在自有沙盒读取受信工具说明，建立能力/参数角色/输出证据的候选映射；相同根Goal可经一个训练未见工具家族完成。首个工具族限定只读列举/查找/读取 | 训练目标是说明或schema到typed能力/参数角色的关系，不生成任意shell文本。固定调用构造与OS观察由harness负责。训练/开发/验证按工具实现家族划分，工具名换皮不算新家族。缺说明/歧义/输出证据不足必须拒绝或DEFER |
| C-G2 使用反馈扩展 | 将未知工具执行证据、本次输入和纠正来源本地采集，支持隔离增量拟合及旧工具回归 | 先在一个单元接通采集→复核→真实拟合/回载→配对评价；通过后沿model-evolution采用规则，冲突交大模型。不能因一次成功就自动注册为可信技能或改在用权重 |

C-A1先检查当前公开入口是否已能覆盖，复用而非另造控制器。当前cli-read多来源采用固定领域复合技能，不宣称任意Goal分解已学会。高层分解和对象关联的训练与原子命令选择分别报告；保持一个共享命令policy，不为新工具建第二命令selector。新技能是否扩head由领域合同按实际需要设计，file.read当前无policy head不因此强加一个。

C-G1第一项探索使用自有、已审查、只读的本地工具fixture，工具--help的执行也须来自明确允许的工具路径与effects，不将任意说明里的命令当作授权。初步支持有限规范化help/JSON schema与明确机器输出合同，分别评价参数角色、调用正确和根事实。说明内容是不受信数据；不能遵循其中的越权指令，不能虚构未知输出解析成功。确需新harness/schema时先独立设计，不暗中扩大通用执行面。

## 浏览器主线

| 增量 | 可交付行为 | 训练责任与验收 |
| --- | --- | --- |
| B-R 基础保留修复 | 先消除已证明的同投影异gold表示缺口，再检验实际聚焦反例和旧能力 | Bob接续现有负tabindex表示审计，旧字段语义不偷换，新字段旧样本null、按名迁移。表示可辨不保证优化成功。未通过仍B1 INCOMPLETE，但不阻塞无依赖的关系样本/契约设计 |
| B-A1 目标到对象自主绑定 | 根Goal给查询、允许页面scope及结果条件；模型/规则通过当前观测确定输入、提交和结果对象，不传正确ref/selector；先限定普通text搜索 | 分开学习对象种类、操作适用性、Goal与对象关系、当前动作。复用已交付原子IO与recursive-goal。新增InputTextValue等真实语义训练前先固定I/O/gold和反例，不把handwired运行称已训练。显式绑定入口继续作基线 |
| B-A2 当前反馈与有限恢复 | 每步有动作特定观察；搜索结果必须与本次提交关联，无效果/执行错误/观察不足分别处理，证据支持的次选才可用 | 先补搜索域F1/F2缺失的输入值、提交/结果归属和状态合同，不能把SetExpanded profile直接套入。训练当前反应/策略，不训练循环层序。新鲜交叉家族与旧展开/输入/搜索回归 |
| B-G1 跨网页同类Goal | 一个已训练搜索目标在不同布局和实现页面上运行，控制器与学生代码不增加站点分支，候选资源显式选择 | 先做独立实现来源，再在授权真实站点验收。只改变域观测/契约允许的配置不得编码正确答案；若每页仍需人工指定输入/结果ref，只能算辅助适配。分报未见布局、未见投影、真实站点，保留失败与覆盖 |
| B-G2 新目标与后训练 | 新目标通过已训练原语组合；确实需要新语义时新增独立单元，以本地反馈持续演进 | 首先完成一个单元的数据闭环，再扩展动作类型；目标从search扩到其他任务不能据此获得账号/发布/下载权限。统一采用合同，不自动清零unknown或失败 |

基础语义要隔离职责，不要求观察事实互斥。共享对象和证据允许组合，但不能重复计覆盖或由成员分数相加推出根满足。文字内容、对象身份、能力、关系和实际效果分别验收。缺失观测不能补false；需要历史时用显式且可失效的State，不从日志猜。

## 当前可立即执行的增量

Carol：接收C-A1，先产出公开入口能力差距表与最小独立Plan，随后完成现有已知集合的自主Goal入口/consumer和独立场景。并行完成C-G1的最小说明到能力样本设计、受信fixture工具与参数/证据合同；不能因为当前order排序不值得训练而关闭CLI主线。设计就绪后推进相应训练原型，缺共享core实现向Jenny/Alice提交最小依赖，不在CLI复制引擎。

Bob：原定 B-R 唯一 owner 与 B-A1 关系样本准备；实际 B-R 拟合评价由 Henry 完成并交付（失败实验如实报告、Alice accept、B-R INCOMPLETE），B-A1 自主绑定关系合同与动作样本下一增量已邀请 Carol 承接（reviewer Alice）。B-R 未通过只阻塞依赖该分类保证的运行验收，不阻塞独立关系设计；后续普通 text 自主搜索最小端到端再推进 B-A2/B-G1。

两域先自上而下给模块和依赖，再自下而上公开验证基础与组合。每个增量都有独立Planner；完整可交付milestone作者验收后独立Review一次。复用现有project-design、recursive-goal、cli-file-property/训练、operation-episode及演进图；改变端口/分支时由owner补正确图/gate/红测，不为每个站点/命令复制图或controller。当前文档是路线，不声明这些后续实现已存在。

## 每次报告必须回答

1. 用户只给什么Goal，系统还需要哪些人工绑定？自主程度不能靠描述推断。
2. 哪些由规则完成，哪些经过真实训练？使用的权重是否显式候选、已回载、已采用？
3. 未见的是数据、页面实现、工具说明还是任务组合？分区和具名分母是什么？
4. 根目标达成、动作正确、观察完成、错误与副作用分别是什么？
5. 离本域总目标还差什么，下一项已就绪动作与owner是谁？局部DONE不能关闭整条总目标。

后验可以作为训练奖励或监督依据；禁止未来信息回填t0输入、假定未执行备选成功、将一次事后赢家硬定为唯一正确先选。独立评价不能反复调参；回归或冲突保留当前版本，交大模型分析。代码main交付与能力PASS分开。

## 2026-11-04 master（Jenny）自有调度任务登记

用户要求把 master 自己的任务加入本长程目标并及时更新 board。master 不亲自实现主线，只承担编排、验收与收口；以下责任长期有效，逐项在 note.md 留证据。

1. 调度与验收：逐项核对 board 开放任务的交付证据、Alice 复核结论与集成条件；accepted 后推动集成提交、push 与资源收口。当前已完成语料集成：`emma-tsjs-corpus-prep-r1` revision 4 经 Alice ACCEPT，由 master 以 `jenny-tsjs-corpus-integration-r1` 集成提交 `620d6a3` 并推送 `origin/main`，任务已关闭。TS 固定环境实施候选 revision 2 已设计 ACCEPT；Emma 于 `m1793814807500-2925` 转达用户在其会话输入「继续」，按该批准派发实施 milestone `jenny-tsjs-fixed-env-implementation-milestone-r1`，owner Emma、reviewer Alice，正式后继 LayerFS 分支为 `emma-tsjs-fixed-env-implementation-milestone-r2`（r1 保持 PROTECTED_HOLD，不作为交付基线）。
   Emma 当前任务板 revision 12 `blocked`（owner Emma，reviewer Alice），r2 head 为 `1201b508bb3165a9f03bdc9005f9992e21ef53ea305aca5d8c90320bfe25aeeebd`。Alice 审计 `m1793840251355-4007` 正式判定整体 `INCOMPLETE`，纠正两点：typed acceptance 11/11 只证明合同组件，不等于第10项真实多步验收；工程缺口与训练后验收依赖必须分开。Emma 已按 `m1793840755285-4016` 完成仅收口（`m1793841465999-4038`）：A) 工程缺实现，unified transfer evaluator 文件/测试/报告缺失，§2.5 `runRecursiveGoal` 真实引擎接线缺失；B) 训练后验收依赖，已验收 TS/JS package 与 threshold resource 缺失。typed acceptance 11/11 仅记为合同组件测试；恢复需用户明确批准原文与范围，不重跑已有效组件测试。用户硬要求已记录：引用关系调用最终结果必须 100% 正确、无遗漏；已知关系 100% 可靠、错误为 0；未知结果必须 judge=unknown，不得给错误结论或遗漏；board test_condition 已承载该判定。禁 fitter/训练/权重/gold/threshold/采用/产品接线/安装/nn-code。
   master 下游 integration 任务 `jenny-tsjs-fixed-env-implementation-integration-r1` 已更新到 revision 39 `blocked`（owner Jenny），parent 指向上述实施 milestone；整体保持 blocked/INCOMPLETE，等待独立监理复核与用户明确批准，不继续实现。master longhorizon goal 当前 active/subscribed，最新订阅为 `sub-m1793841580891-4048`（armed，trigger_ms 1793842180884），project patrol 为 `sub-m1793420812006-236`。`/workspaces/7` 的过期 dirty 已由 owner Emma 声明并 discard，r2 交付线 `/workspaces/6/2/4/8` dirty 为 0；`/workspaces/1` dirty=31 为旧 r1 PROTECTED_HOLD，head `1201b508` 是当前最近可审计交付点。授权仍不含训练、拟合、安装、采用、产品接线或恢复旧 nn-code。
2. 统一解析器抽象：只读设计链已 accept 统一合同、验收合同与接线设计；实施必须等 Alice 审计通过的 TS 最小固定环境工程合同后按用户审批派发。当前禁止实现、训练、安装，禁止改权重/gold/阈值，禁止恢复旧确定性 nn-code。
3. TS/JS import alias 主线：保持训练目标不变；语料 revision 4 已集成，固定环境实施已按接受设计派单。Alice 复核交付后，master 只在批准范围内集成，不扩大到训练或采用。
4. 资源与治理：已合并 worktree 关闭，迁移 LayerFS 后新任务用独占 task branch，不新开 Git worktree。用户于 2026-11-04 再次要求移除 David 的未完成任务并交给别人；2026-11-05 实时 board 再次核实 David 名下 `task_ids=[]`，无开放任务、邀请或待复核项，历史 David 任务均已 closed，因此没有在途任务可改派。后续出现 David-bound 新工作时由可用 peer 承接，不等待离线 owner。LayerFS r2 分支 head `1201b508bb3165a9f03bdc9005f9992e21ef53ea305aca5d8c90320bfe25aeeebd` 已由 Emma 报告并作为当前最近可审计交付点；sandbox 1 的 r2 交付线 `/workspaces/6/2/4/8` dirty 均为 0，`/workspaces/7` 已由 owner Emma 声明为过期产物并 discard；旧 r1 workspace `/workspaces/1` 仍有 31 个未提交 entries，保持 PROTECTED_HOLD，不提交、不清理、不并入。全局 runtime 安装逐次用户批准。master 的消费与治理回执统一进入 `note.md`；最近一次 `collab recv` 前端挂起无正文，中断后 `collab inbox` 为空，不重复消费或补造通知结果。
5. 调度原语维护：master 常驻项目巡检（master-idle/project-patrol）保持 armed；goal/deadline 一次性唤醒消费后仍需继续调度时，显式 `appsdk goal subscribe` 续订。读取、ACK、摘要不续期。

## 2026-11-05 授权冲突：只读审计已交付，待用户直接裁定

Alice 已按只读合同交付整体符合性审计并获 master 接受，报告位于 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-overall-compliance-audit-r1.md`。审计不批准设计、实现、训练或采用。

审计结论：

1. 授权：存在两条用户方向（全面停工、仅允许收口与只读审计）与（整体重设计、设计师审批后即派训练、不重复索批），跨会话时间未证实，不能仅按消息到达顺序判定最终授权；不把转述擅自当作已生效的新用户指令。
2. 范围：整体方案被推翻不等于每条用户约束废止。64 维输入、两层、统一格式、固定推理引擎属于用户直接约束，不能由“整体重来”任意改架构；full-batch SGD 属方案选择。
3. 可复用证据：语料 revision 4、main `620d6a3`、r2 head `1201b508` 与 typed 组件回执可作新路线审计输入；不支持“已训练、已采用、真实多步闭环通过”。
4. 缺口：真实引擎接线与迁移评价器缺失；无本轮合格训练包与多步选择/执行/后态/根评价证据；工程准备、真实拟合与回载、语义验收、迁移验收的阶段边界尚未分清。

待用户直接裁定（一次性，不再按组件重复索批）：

1. 是否恢复整体重新设计，并授权设计师批准具体路线后执行范围内训练，取代停工条款。
2. 原 64 维输入、两层、统一格式与固定引擎是否仍是约束，还是允许总设计师重新选择。

裁定前仅继续只读审计、证据盘点、board/goal 维护与停工收口；不认领新总设计，不派实现、训练、采样、接线、采用或安装。旧 `nn-code` 继续禁用。board 真源：`nnanything-overall-redesign-orchestration-r1` working 记录本节；`alice-overall-redesign-authority-r1` 已交付并关闭；`jenny-tsjs-fixed-env-implementation-integration-r1` 与 `jenny-tsjs-fixed-env-implementation-milestone-r1` 保持 blocked/INCOMPLETE，待裁定后决定恢复或替换。

## 2026-11-05 用户已恢复整体重设计、训练与并行推进

本节取代前节“待用户直接裁定”。用户在本线程明确恢复：继续执行尚未完成的任务，恢复训练授权；整体重设计重新来，独立工作并行推进，不串行等待单一任务。旧 `nn-code` 产品仍禁用，旧确定性实现仅作 teacher、oracle、样本与对照。

Alice route r1 已接受：保留 64 维输入、两层隐藏层、统一格式和固定推理引擎；首个实验方向为 TS/JS import/reexport/alias 与终端声明判断。训练启动只等待 Alice 通过设计后的具体 launch 合同，不再等待用户再次批准。

### Master 编排职责

1. 调度与验收：Jenny 维护 `nnanything-overall-redesign-orchestration-r1`，并负责 board 队列、Alice review、集成、push 与资源收口。
2. 固定训练环境：Emma 当前补齐 `jenny-tsjs-fixed-training-launch-r1` 的四项 finding。Alice launch r1 复核要求：合格训练包不可作首训前置；Rust 迁移评价器不挡 TS 首训；converter 标签与学生路径分开；补 loss 收敛/失败诊断；最终 unknown 必须收口。直接拟合缺口是完整学生组、converter 与真实 train 入口。
3. 固定环境工程：Emma 继续 `jenny-tsjs-fixed-env-implementation-milestone-r1`，补 unified transfer evaluator 与 `runRecursiveGoal` 真实接线。该线与 launch 合同并行，不等待训练包。
4. Master 集成：`jenny-tsjs-fixed-env-implementation-integration-r1` 仅等待父任务交付与 Alice review accept，不等待用户批准。
5. Longhorizon：Jenny 的 goal 保持在 `appsdk goal` 登记，当前 goal 文档为本文件，one-shot deadline 定期显式续订；常驻 project patrol 保持 armed。

### 旧 NN Code 全功能并行重设计队列

以下 board 任务均为 `nnanything-overall-redesign-orchestration-r1` 的子任务， reviewer 为 Alice。发布即入队，不占执行容量；master 按可用 peer 与无冲突写域逐条邀请。每条线先设计/语料/评价/工程准备，实际 fit 等共享 fixed training launch 环境通过 Alice 审计后执行。

1. `nn-code-redesign-symbols-tsjs-r1`：TS/JS 符号表。
2. `nn-code-redesign-symbols-rust-r1`：Rust 符号表。
3. `nn-code-redesign-symbols-jvm-r1`：Kotlin 与 Java 符号表。
4. `nn-code-redesign-symbols-swift-r1`：Swift 符号表。
5. `nn-code-redesign-call-graph-r1`：调用图与调用深度。
6. `nn-code-redesign-value-flow-r1`：值流。
7. `nn-code-redesign-search-read-r1`：搜索与读取 composition。
8. `nn-code-redesign-repo-generalization-r1`：repo 关联、泛化与独立评价。
9. `nn-code-redesign-learning-loop-r1`：本地使用采集、增量训练与采用前报告。

共同边界：不改既有权重、gold、threshold、采用状态；不产品接线；不安装全局 runtime；不恢复旧 nn-code。训练候选只能写入独立候选路径，保存、新进程回载、独立留出评价与旧能力回归齐全后才可进入 model-evolution 采用流程。

## 2026-11-07 当前 MVP：nn-code 与浏览器训练交付

本节是当前短期 MVP 的可验收定义，直接取代 2026-11-05 “待用户裁定”一节。用户于 Codex 线程 `01a1ae9f-debd-7852-947b-d0b68b913fb0` 的 userMessage `01a1b48e-28bb-7e91-90c6-d49ebb38c21d` 直接指示：长程目标是 NNAnything 的 nn-code 与浏览器训练和交付；按目标拉满 peer 工作，按分拆任务维护 longhorizon 订阅，并按完成度修正细节。本节只收敛当前 MVP，不改各领域既有算法/训练合同。

### NN-code MVP

交付目标：TS/JS 符号表做成一条可用的训练闭环。设计子交付已由 Alice 接受并集成 main `c576a3f`；剩余是训练、保存、新进程回载、独立留出语义评价与旧 nn-code 能力回归。

- 设计 owner：Carol（`nn-code-redesign-symbols-tsjs-r1` 已 merged）；训练后继由 `nn-code-redesign-symbols-tsjs-training-20261107` 承接，准备与回载切片 2cb4ee4 已接受并集成；后续 `tsjs-first-train-fit-execution-iris-20261109` 已完成 fit、保存和新进程回载，Alice 已接受固定拟合执行证据；独立留出语义评价尚未执行。
- converter/train/config 工程：Iris 的 `iris-real-converter-engineering-20261106` 已接受并集成；shared fixed-env evaluator 与 §2.5 runRecursiveGoal 接线由 `fixed-env-engineering-gap-iris-20261107` 承接，board rev16 working（前置 blocked 已批准），候选 `66a7710` 保留；Alice 窄复核确认五项局部修复（expected 不覆盖 argmax、sample+step 绑定、纯评分不造执行/后验回执、每候选一次 forward、保留原错）闭合，且 `fixed-env-research-adjudication-carol-20261107` subject_revision 4 已正式 ACCEPT（两项准入冲突闭合，TS/JS 独立评价资格与 Rust transfer 准入分离，integrationCommit 非运行时前置）。已续派 Iris 原树按当前合同完成真实准入绑定与单步知识判定提交/New State/结构 root 接线，复用已闭合修复不回退旧候选；工程须交回实际黑盒再审，Rust 资格仍 false/incomplete，仍不训练/采用/安装。原 David-pinned child 因 3.5h 未接受已 force-close；Emma 1201b508 未交付内容保持 PROTECTED_HOLD，不复用为已交付。
- 真实入口：公开 `convert-samples` / `validate-data`、`l2-standard-runner` 训练入口、保存包新进程回载入口。
- 验收证据：build exit 0；unified-full 与受影响测试原始回执；公开 CLI READY；红/绿与变异对照；独立留出语义评价；旧 nn-code 能力回归。
- 完成门：候选包保存并新进程回载；独立留出评价与旧能力回归通过；候选保持 `uncalibrated/not_applied`，直到 model-evolution 采用规则满足。已知符号关系 100% 正确、未知 judge=unknown、无截断/遗漏、训练输入不含未来信息、独立来源不进拟合。
- 当前状态：converter f752715 工程返修已由 Alice 接受并集成 main `9b4a462`；Henry 只读回放保持 5 PASS / 0 FAIL / 2 INCOMPLETE（request-missing、repeat-read），不写 22/22 PASS。TS/JS encoder v2 语料准入已由 `tsjs-v2-corpus-admission-henry-20261108` 完成并通过 Alice 正式 ACCEPT（subject_revision 1）：物理 v2 TRAIN 转换/校验 READY，15 data rows / 67 student rows / 15 supervision rows；该结果只证明语料准入，不证明 fit 或语义验收。evaluate 工程由 `tsjs-evaluate-engineering-henry-20261108`（executor Henry，reviewer Alice，P0 implementation，parent overall-orchestration）承接，contract 见 `/Volumes/Intel/playground/nnanything-runs/tsjs-evaluate-engineering-henry-20261108/contract.md`。真实 fit、保存和新进程回载已完成，Alice 已接受固定拟合执行证据；候选仍为 `uncalibrated/not_applied`。独立留出评价尚未执行，须待 `tsjs-first-train-holdout-evaluate-henry-20261109` 运行并由 Alice 复核；该证据不推断语义成功、收敛、采用或完整调用图行为。

### 浏览器 MVP

交付目标：先闭合 B-R 基础保留表示缺口，再做 B-A1 普通 text 搜索的目标到对象自主绑定。B-A1 首切片只要求普通 text 搜索；显式绑定入口继续作为基线，不得把辅助绑定冒称自主识别。

- 当前 owner：B-R 只读诊断已审计接受并关闭（`alice-browser-reddiagnosis-audit-20261107.md`）；阶段二准备由 Henry 完成（`b-r-browser-base-prep-henry-20261107`，734c94d），已由 Alice ACCEPT、master merge `a30c10b` 集成 main 并 push，Henry 清理 worktree/branch 并 task close 完成，状态 integrated+closed。拟合与评价已由 Henry 完成并交付（`b-r-browser-fit-evaluation-henry-20261107`）：control/treatment 真实拟合、保存回载、新进程回载与逐例评价已完成，两组均未满足解封门槛，B-R 能力保持 INCOMPLETE；Alice 正式 accept 真实失败报告，不需要重训重评，verification 不解封、候选不采用，board 已收口 close，Henry 已清理 worktree/branch。B-R 的 loss 分项、反例112 wire/分数间隔与旧能力退化已转 Carol 做后继原因诊断（随 B-A1 设计下一增量一并派发）。测量进入聚焦投影的证据有效，训练 consumer/recipe 现接受 `explicit_negative_tabindex`，仅准备、不训练。B-A1 普通 text 搜索显式绑定基线已由 Henry 完成两轮 live：Alice 定点 REWORK 后候选 `ee88d37` 正式 ACCEPT，master merge `498557a` 集成 main 并 push，Henry 清理候选 worktree/branch 并 task close 完成，状态 integrated；仅显式绑定 consumer 交付，不是自主对象绑定、训练或采用。原 EPERM、Chrome Abort trap 6、ref lock 失败保留。
- 真实入口：浏览器 adapter 公开观察/分类 consumer、`operation-episode` 与 `recursive-goal` 搜索入口；B-A1 先跑显式绑定基线，再跑目标到对象自主绑定。
- 验收证据：B-R 同投影异 gold 表示缺口的红测与修复绿测；焦点反例与旧能力回归；B-A1 目标到对象关系/动作样本；真实页面 fixture 的输入、提交、结果归属与观察回执。
- 完成门：B-R 达标前只阻塞依赖该分类保证的运行验收，不阻塞独立关系设计；B-A1 不得把未知/缺测补 false；候选保持 `uncalibrated/not_applied`；不新增站点分支；不改既有权重/gold/threshold/采用。

### 当前并行派发

| 工作线 | owner | reviewer | 状态 |
| --- | --- | --- | --- |
| converter 四项映射工程 | Iris | Alice | f752715 已接受并集成 main `9b4a462`；训练后继 `tsjs-first-train-fit-execution-iris-20261109` 已完成 fit、保存和新进程回载，Alice 已接受固定拟合执行证据；独立留出语义评价待 Henry 执行并由 Alice 复核 |
| fixed-env evaluator + §2.5 接线 | Iris | Alice | subject_revision 4（候选 3f2e48d）已 Alice ACCEPT；master 先选择性集成 5 个文件到 main `d6cf866`，随后按候选血缘要求补 no-ff lineage merge `df68ce68` 并 push `origin/main`（9a8c8c5..df68ce68），候选现为 main 祖先；post-merge `npm run build` exit 0、`unified-decision-recursive.test.mjs` 与 `unified-transfer-evaluator.test.mjs` 合计 25/25 通过；原任务因回执被拒已按生命周期补记 follow-up `fixed-env-engineering-gap-iris-20261107-reopen-20261107`，正常 close 后校验完成；未训练、未改权重/gold/threshold/采用、未安装；Emma 1201b508 保持 PROTECTED_HOLD |
| P1-1 typed/dynamic §2.5 runRecursiveGoal | Iris | Alice | subject6 `b5f6726` 已由 Alice 正式 ACCEPT，master 集成 main `d125abc` 并 push（2026-11-08T05:06Z）；任务 `closed/disposition=integrated`，worktree 与 branch 已清理（cleanup receipt `cleanup-manual-p1-1-typed-dynamic-recursive-engineering-iris-20261107-1794114698509`）。原 rev4 REWORK 的两项实际关系证据分支已关闭，不再是 open 事项。未训练、未改权重/gold/threshold/采用、未产品接线。 |
| TS/JS 符号表训练准备 | Carol | Alice | 设计子交付已 merged；训练准备切片 2cb4ee4 已接受并集成、任务 closed；fit、保存和新进程回载已完成，Alice 已接受固定拟合执行证据；候选保持 `uncalibrated/not_applied`；独立留出语义评价待 `tsjs-first-train-holdout-evaluate-henry-20261109` 运行并由 Alice 复核 |
| TS/JS v2 语料转换/准入 | Henry | Alice | `tsjs-v2-corpus-admission-henry-20261108` closed，Alice ACCEPT subject_revision 1；物理 v2 TRAIN 转换/校验 READY（15 data rows / 67 student rows / 15 supervision rows）；仅语料准入，非 fit 或语义验收 |
| TS/JS evaluate 工程 | Henry | Alice | `tsjs-evaluate-engineering-henry-20261108` closed/disposition=integrated；board rev16 候选 `789d083` 经 Alice 窄预审 PASS 后按集成回归 rework 产出候选 `f5ca5ec`，Alice subject_revision 4 正式 ACCEPT，已并入 `origin/main`（`f5ca5ec` 为 `5955dca` 祖先；`f32c084` 经 rebase 为 `e3f8e63`）。证据 `/Volumes/Intel/playground/nnanything-runs/tsjs-evaluate-engineering-henry-20261108/alice-review.md`；Leo read-only triage 复核 efa49dc/abe21ae/ec6f457，ec6f457 以 rebased 后继满足原意。本行只覆盖 evaluate 工程；fit/保存/回载/独立留出/旧能力回归不因本行关闭而完成，仍单独跟踪，未训练/未采用 |
| TS/JS value-flow 设计 | Carol | Alice | 0c16fd7 accepted；阶段A shared projection 审计修订接受；阶段B engineering `value-flow-shared-projection-engineering-20261107` rev12 候选 `a76017d` 已 Alice ACCEPT，master `--no-ff` merge `8e02540` 集成 main 并 push `origin/main`；post-merge build exit 0、受影响值流/统一测试 118/118、fixture symlink 测试 13/13；`collab task integrated` merged，Carol 已 `worktree remove`、`branch -d` 并 close（cleanup receipt `cleanup-value-flow-shared-projection-engineering-20261107-1794081509650`），任务 `closed/delivery_complete=true/completion_missing=[]`；候选保持 `uncalibrated/not_applied`，仍不 fit/不采用 |
| TS/JS timing/evaluate 设计 | Carol | Alice | subject_revision 4 已 Alice 正式 ACCEPT（read-only，no integration/close 已收口）；timing runner 工程 `tsjs-timing-runner-engineering-henry-20261107` 已由 Alice accept `9d423a0`，master no-ff merge `66733c0` 集成 main 并 push，Henry 已清理 worktree/branch 并 close（`completion_missing=[]`）；只交付 runner/checkpoint timing，evaluate 接线复用 Iris adapter/recursive，后续独立派发，验收依赖 Iris 公共入口 |
| browser B-R | Henry | Alice | 只读诊断已审计接受并关闭；阶段二 734c94d 已 Alice ACCEPT、merge `a30c10b` 集成 main 并关闭；起始权重已由 `b-r-start-weight-recovery-henry-20261107` 接受为 `browser-ignore-capability-20261021/frozen-e200/training/weights/dom-basic-kinds/ignore-capability-4a60c08d-4c3a-4997-b576-44f92385a5d6.weight.json`（不宣称字节级同一，仍 not_applied）；拟合评价已由 `b-r-browser-fit-evaluation-henry-20261107` 完成：subject_revision 1 失败实验如实交付，Alice REWORK 后 rev2 正式 ACCEPT（真实失败接受，能力仍 INCOMPLETE，verification 不解封、候选不采用），board closed，Henry 已清理 worktree/branch。失败归因 `b-r-per-degradation-attribution-carol-20261107` 已由 Carol rev2 交付，Kate 于 subject_revision 4 正式 ACCEPT（2026-11-08T06:33Z），任务 `closed/disposition=no_merge_required`、`completion_missing=[]`；证据 `/Volumes/Intel/playground/nnanything-runs/b-r-per-degradation-attribution-carol-20261107/review-findings-kate.md`。归因确认反例 112 为 margin 失败，B-R 能力仍 INCOMPLETE，候选保持 `uncalibrated/not_applied`；不重训、不重评价、不改源码-gold-threshold-配方-采用。 |
| browser B-A1 | Henry（显式绑定基线）/ Carol（关系合同与研究准备） | Alice | ee88d37 accepted，merge 498557a 已集成 main 并关闭；显式绑定基线交付，非自主对象绑定/训练/采用。自主关系设计 `b-a1-object-relation-binding-carol-20261107` 已由 Alice 在 subject_revision 5 正式 ACCEPT（read-only），后继研究准备 `b-a1-research-prep-20261107` 亦经 Alice rev1 REWORK、rev2 正式 ACCEPT 并 close（cleanup receipt `cleanup-b-a1-research-prep-20261107-1794088256372`，无 worktree/分支）。已接受结论：统一 64 维/两层为唯一后继训练路线，旧 27 维双线性成员与 36 wire 单线性降为历史/待迁移材料；typed missing、encoder sentinel+missingMode、旧线性区间诊断分层；样本侧直接比较固定独立 gold 与输出，原始来源证据保留而学生数值投影剔除禁用字段。下一增量 `b-a1-unified-research-prep-20261107`（design，executor Carol，reviewer Alice，parent overall-orchestration）已由 Carol 交付 rev1；Alice 正式 REWORK（证据 `/Volumes/Intel/playground/nnanything-runs/b-a1-unified-research-prep-20261107/alice-review.md`，6 项 P1）；Carol 已按 Alice 审查修订三份设计并重交；Alice 对 subject_revision 3 正式 ACCEPT，任务随后 close，衔接统一数值研究（无 worktree/分支）。研究员标签（资深研究员）当前仅 Emma 且处于 missing，本线沿既有 B-A1 设计 owner Carol 承接、Alice 独立审计；Emma 离线事实已在 note 记录为角色缺口，后续恢复时按主目标优先级交接。B-R 原始证据归因独立继续（见 browser B-R 行） |
| B-A1 固定环境与样本准备 | Carol | Alice | `b-a1-fixed-env-sample-prep-20261107`（implementation，parent overall-orchestration）经多轮 REWORK 后收口：Alice subject_revision 4 正式 ACCEPT，候选 `43d83c7`；master no-ff merge `c624b94`（parents 2c20cb6 + 43d83c7）集成 main 并 push，post-merge build exit 0、node tests 28/28；`collab task integrated` 后任务 `closed`、disposition=integrated、completion_missing=[]，cleanup receipt `cleanup-b-a1-fixed-env-sample-prep-20261107-1794104462983`，独占 worktree/分支已移除。不训练/拟合/采样/接线/安装，不改权重/gold/threshold/采用 |
| unified-encoder 夹具迁移 | Henry | Alice | 窄修 `tests/unified-decision-recursive.test.mjs` 与 `tests/unified-transfer-evaluator.test.mjs` 四处 encoder v1→v2。Jack 候选 20db0f6，build exit 0，两目标测试 18/18、7/7，unified-data-gate 12/12 且 v1 负例保留，Alice 窄审无 finding。任务原执行由 Jack 完成但 session 被 peer lifecycle fence（cleanup-open）；改派 Frank 未接受后 withdraw，改派 live peer Henry，Henry 复用 20db0f6 与既有 Alice 证据正式 deliver。2026-11-08T01:40Z `collab task integrated` merge `a030bbb` 集成 main 并 push，任务 closed、completion_missing=[]；`1c8ccdd` 通过本次 fixture migration 与 B-A1 fixed-env 集成闭环。完整 `npm run test:full` 24 项失败为独立旧资产/环境缺口，不由本任务修复或冒称全绿，仍分类跟踪 |
| 浏览器 search-input-host 阈值来源 | Carol | Alice | `browser-search-input-host-threshold-source-20261107` subject_revision 1 已 Alice 正式 ACCEPT；master no-ff merge `fe54231` 集成 main 并 push（fix `8d41265`），任务 `closed`、delivery_complete=true、无残留 worktree/分支；仅修正阈值来源注释与 provenance，不改阈值数值、权重、gold 或采用状态 |
| repo-generalization 真实评价准备 R2 | Carol | Alice | `nn-code-redesign-repo-generalization-real-eval-r2-20261109` closed；Alice subject_revision 2 ACCEPT，F1 来源隔离闭合，disposition=no_merge_required；master 从 `32b975a` 恢复文档并 push `e941aeb`。仅设计准备，真实 repo 语料/评价/训练 INCOMPLETE |
| JVM 语料与 typed fixture 准备 R1 | Leo | Alice | `nn-code-symbols-jvm-corpus-prep-r1-20261109` integrated `f7b818d` 后 closed、completion_missing=[]；Alice subject_revision 1 ACCEPT（DESIGN_PREP_ONLY）。物理 JVM 语料/converter/evaluate/training 仍 INCOMPLETE |
| 调用图 cursor/gap schema R1 | Leo | Alice | `nn-code-call-graph-cursor-schema-r1-20261109` closed/disposition=integrated；候选 `2c5e75c` 经 PR #32 merge `5955dca` 并入 `origin/main`，`docs/nn-code-call-graph-cursor-schema-r1.md`（F1-F3 窄修，102ab27→2c5e75c）已在 main；Alice 预审 PASS（`/Volumes/Intel/playground/nnanything-runs/nn-code-call-graph-cursor-schema-r1-20261109/alice-review.md`）。design-only，不训练/不采用 |
| Rust 语料与 typed fixture 准备 R1 | Carol | Alice | `nn-code-symbols-rust-corpus-prep-r1-20261109` closed/disposition=integrated；候选 `8afa736` 经 Alice 只读预审 PASS（`m1794189882346-6758`）后正式 accept，merge `c527fe1` 并入 `origin/main`。物理 Rust 语料/converter/evaluate/training 仍 INCOMPLETE/UNVERIFIED。design-only，不训练/不采用 |
| Swift 语料与 typed fixture 准备 R1 | Carol | Alice | `nn-code-symbols-swift-corpus-prep-r1-20261109` closed/disposition=integrated；owner 由 Carol 承接（Emma missing 不再是停车原因，按用户“研究员是职责不是固定名字”补位），候选 `2259c6e` 经 Alice 窄预审 PASS（`m1794201926293-7756`）后正式 accept，merge `c717af4` 并入 `origin/main`。物理 Swift 语料/converter/evaluate/training 仍 INCOMPLETE/UNVERIFIED。design-only，不训练/不采用 |
| 训练隔离巡检 | Kate / Grace | — | 常驻巡检，不接普通 board 任务 |

### B-A1 后继切片状态

2026-11-08 纠偏（Kate round-38 后续 `m1794112040238-685`，Jenny 接受）：本节原记的 `HOLD_AUTHORIZATION` /「待用户直接裁定」与当前授权状态冲突，已删除。当前授权为用户在 Codex 线程 `01a1ae9f-debd-7852-947b-d0b68b913fb0`（userMessage `01a1b48e-28bb-7e91-90c6-d49ebb38c21d`）的直接指示：长程目标是 NNAnything 的 nn-code 与浏览器训练和交付，按目标拉满 peer 工作；该指示取代 2026-11-05「待用户裁定停工」范围。既有边界不变：不改既有权重/gold/threshold/采用状态，不产品接线，不安装全局 runtime，候选保持 `uncalibrated/not_applied`。

B-A1 固定环境（route encoder、绝对阈值 group loss、固定训练入口、样本/evaluator skeleton）已由 `b-a1-fixed-env-sample-prep-20261107` 交付、Alice subject_revision 4 ACCEPT、master `c624b94` 集成 main：`lib/training/b-a1-route-encoder.ts`、`lib/training/b-a1-group-loss.ts`、`lib/training/b-a1-training-entry.ts`（公开入口 `trainBA1UnifiedRelationDecision`）、`lib/training/b-a1-sample-evaluator-skeleton.ts`。因此 route encoder/loss/fixed entry 均已实现，不再作为新 board 切片重复派发。

B-A1 后继切片已收口：1) 真实样本生成（按已接受的槽位/监督合同产出 student-rows 与 supervision-rows 物理分离输入）；2) 完整独立 evaluator（在 skeleton 的类型与分母上实现模型执行、逐组阈值决策与独立语义评价）。两者均由 Kate 正式 ACCEPT subject_revision 3、master 集成并 push，owner 已完成清理和关闭。runner/export 接线仍由 `8d11940` 解阻条件约束（见下），不在样本/evaluator 切片内擅接线。B-R 逐退化样本只读归因 `b-r-per-degradation-attribution-carol-20261107` 已关闭，不受本节影响。

| 切片 | board 任务 ID | owner | reviewer | status | revision | 依赖 |
 | --- | --- | --- | --- | --- | --- | --- |
| 真实样本生成 | b-a1-real-sample-generation-henry-20261107 | Henry | Kate | integrated(eb2802d) closed | 3 | 无（并发启动） |
| 完整独立 evaluator | b-a1-independent-evaluator-leo-20261107 | Leo | Kate | integrated(b416566) closed | 3 | 无（并发启动） |

说明：两条后继切片均已交付、正式审查 ACCEPT、合并到 main 并 push，owner 清理 worktree/branch 后关闭，`completion_missing=[]`。固定训练入口 runner/export 接线仍由 `8d11940` 解阻条件约束，不在上述两切片内擅接线。

Henry 真实样本生成候选 `d49dae2` 已由 Kate 正式 ACCEPT subject_revision 3，master no-ff merge `eb2802d` 集成 main 并 push；converter 测试 9/9、B-A1 测试 59/59，`samples-v4` 可被固定训练入口消费，TRAIN/DEV/VERIFICATION 与 student/supervision 分离成立。family C 仍是第三个 renderer，真实站点 held-out 分母未填，不宣称训练或语义准确率。Leo 完整独立 evaluator 候选 `abb1a95` 已由 Kate 正式 ACCEPT subject_revision 3，master no-ff merge `b416566` 集成 main 并 push；post-merge build、typecheck 与目标测试均通过。两条任务均 `closed`、disposition=integrated、`completion_missing=[]`，worktree/branch 已清理。

Emma 旧树与未交付内容保留；其中 converter/fixed-env 的未完成工程依赖由对应 Iris/David 承接任务核销，未因改派而消失。`nn-code-redesign-learning-loop-r1` 经 Kate 正式 ACCEPT subject_revision 3、owner Carol 收口，board `closed`/`delivery_complete=true`/`completion_missing=[]`/`disposition=no_merge_required`，记为 design accepted。`nn-code-redesign-search-read-r1` 已由 Carol 完成 subject_revision 2 修订并交付，Kate 于 2026-11-08T09:39Z 正式 ACCEPT，任务 `closed/disposition=no_merge_required`、`completion_missing=[]`，证据 `/Volumes/Intel/playground/nnanything-runs/nn-code-redesign-search-read-20261108/review-findings-kate-r2.md`。剩余两个 symbols 子任务已于 2026-11-08T14:00Z 由 master 按 Grace 容量巡检恢复调度：`nn-code-redesign-symbols-rust-r1` 与 `nn-code-redesign-symbols-swift-r1` 均 board rev8、owner=Carol（已接受）、reviewer=Alice，只做设计合同、数据分区与转换/评价/回载准备；不改现有权重/gold/threshold/采用、不产品接线、不安装、不恢复 nn-code，实际训练仅可在共享 fixed training launch 经 Alice 审计后执行。Emma 缺席不再是停车原因；若需要 Emma 原始资料且缺盘，Carol 须报告具体缺口并继续可独立推进部分。

残项 open bug 处置（2026-11-08 Jenny triage）：P2 `8d11940`（checkpoint reload subgraph）已由只读 GCM 观察 worker 记录调用图（回执 `/Volumes/Intel/playground/nnanything-runs/bug-8d11940-triage/report.md`）：`verifyUnifiedTrainingCheckpointReload` 现由 B-A1 固定训练入口 `trainBA1UnifiedRelationDecision`（`lib/training/b-a1-training-entry.ts:954`）调用并在测试中真实校验，原"无消费者"事实过期；但该入口仅测试可达、未接真实 runner/export。当前 disposition 保持 open，不在 B-A1 进行中阶段 ablate 在途固定入口代码；解阻条件为 B-A1 fixed 入口接到真实 runner/export 或 B-A1 路线裁定终止时由 training-owner 裁定 wire 或 ablate。P1 `7db2c6a`（CLI P1/P2 Phase A 工程，owner Jenny）保持 open、无 board 任务；CLI Phase A 不在当前 nn-code 与浏览器 MVP 范围内，不受旧停工条款阻塞，本轮不派实现；待用户明确 CLI 范围后再评估派单或关闭。
