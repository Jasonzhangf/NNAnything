/goal

身份：你是NNAnything第一阶段L1“能动”目标的编排者，对结果、进度、解阻、验收和交付负责。按实际Codex宿主使用codex-orchestrator。优先可通信且角色/模型有依据的peer；没有则启动独立worker，不等待Collab注册。观察/通用执行按全局路由使用GCM，Planner与Reviewer分别保持独立；不用内置spawn_agent/fork代替。自己组织与验收，不亲自接手debug；将复现、修复与测试交给对应owner。

目标：在NNAnything实现并交付第一个浏览器场景的最小可运行切片。复用Flowed1.15.0作为执行内核，提供通用类型化事件节点与配置/编译/运行入口；实现读取保存观测、viewport、focus、deny、allow、DOM拆分及展开项资格检查七个手写节点；输出保序候选引用、过滤/未知状态与原因。候选结果不冒充语义识别。

依据：项目AGENTS.md、docs/project-governance.md、docs/implementation-plan.md的L1、docs/workflow-config.md、docs/node-contract.md，以及docs/dagpipe/graphs/dom-candidates.graph.json。D0总体和增量设计已由独立Gemini4审查通过，结果在docs/reviews/；已有独立四层计划有效，未变结论直接复用。新证据改变目标、关键方案或依赖时才补独立规划。

范围：只建立能动层实际需要的核心、Flowed编译适配、通用节点、浏览器观测适配、七个候选节点、公开consumer和必要测试。配置文件与程序定义进入同一个执行合同；项目图是唯一拓扑源，画布可选。每个节点I/O与owner明确，可在其他workflow复用；将确定规则和必要回归案例作为可追溯经验保留。

硬约束：核心不内置DOM或站点语义，不手写第二套调度器；输入输出通过事件接续，单次DAG有限、单源单汇并明确结束；配置、状态、引用和effect能力显式传入。deny优先allow，显式空allow拒绝全部；父节点跳过自身不自动剪后代；显式输入数组保长保序，页面模式按确定项顺序保留排除映射；缺测/失效不伪造成功或负标签。离线不执行真实浏览器动作。原始登录态页面/私人数据保持本地，只提交适合分享的脱敏或合成fixture。

当前增量：先明确最小共享API与配置合同，用非DOM公开consumer验证执行基座；共享合同可用后按不重叠owner并行实现执行层与浏览器节点，再组合候选workflow。基础能力独立验证后才进行组合验收。只交L1，不提前接Handwired、特征分类、训练/校准、广告识别、operation、LLM监督、预测上下文、跨站兼容或画布。

验收：
1. 真实公开入口能加载配置、编译并执行非DOM流程与浏览器候选流程；采用实际Flowed，不用mock或占位成功。
2. 异步扇入等输入齐备才执行，过滤/跳过/未知可结束；事件不跨run或输入项混接。
3. 非法环、未绑定/不兼容端口、缺失配置/引用与未授权effect明确拒绝；未授权副作用节点实际调用次数为0。
4. 候选规则、部分可见、deny/allow、父子遍历及数组顺序有具体反例；原始观测不足时保留证据不足，不声称精确可见或可点击。
5. 节点与组合流程有必要单测和真实consumer黑盒证据；作者排障、自检、构建和适用验收通过后，再进行一次覆盖完整L1及架构的独立milestone Review。
6. 通过后合入main，推送origin/main并接收正常Git回执，清理本目标独占worktree与临时资源。只报告实际可用行为和未支持边界，不以测试绿或Review通过代替交付。

执行规则：项目内观察、Plan/Review、实现、测试与正常Git交付已授权，按全局原则派发，无需逐节点确认。源码仅在/Volumes/Intel/playground/nnanything下的本目标独占worktree修改，遵循先关旧树再开新树；不得覆盖他人改动。先检查受影响DAG，图变更校验一次，依次做必要红测、唯一owner修改和公开入口回归。有效未变证据复用，不主动计算/核对SHA、checksum、冻结快照或候选身份包装，不新增无保障的gate。

记录：项目note.md是唯一进度汇总；过程合同、节点结果和原始证据保存在/Volumes/Intel/playground/nnanything-runs/browser-l1。恢复和接收先读已有记录。派单、回报和等待时按依赖补位，不为并发造任务；局部失败只停真实下游，有可执行解阻动作就继续。完成L1后停止扩展，按全局合同做一次目标结案经验审计，不递归审查Reviewer。

直接执行本任务，不再为它生成一层提示词。
