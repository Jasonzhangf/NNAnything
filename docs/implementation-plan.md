# D0交付与后续浏览器项目实施计划

状态：2026-10-17，D0设计增量复核通过并已交付。用户随后授权直接执行[第一阶段能动Goal](goals/l1-browser-candidates.md)，本轮只实现L1。远端为Jasonzhangf/NNAnything；L2-L4仍为计划。独立Gemini4设计报告见[原始结果](reviews/gemini4-d0-incremental-review.json)，设计审查不代表运行验收。

本计划依据独立Gemini4计划及其D0/四层补充收敛。当前阶段/优先级以本文为准；总体设计保留长期能力，不能将完整责任地图当首轮任务清单。

## 1. 本轮D0的完成条件

| 项目 | D0交付 | 针对性验收 |
| --- | --- | --- |
| 通用框架 | Node/事件/状态/Workflow/Profile边界；Flowed选型及与DAGpipe分工 | 无DOM业务进入核心；正式和训练同一执行合同；未引入第二调度器 |
| 基础配置 | graphRef、局部configs、bindings及显式运行资源 | 图单一真源、端口按合同绑定、profile/effects不隐式获取；见workflow-config.md |
| 复用与经验 | 节点卡、参数/规则/特征修复owner、规范案例与回归积累 | 不将LLM提议直接变黄金；不将缺证据当负例或自动覆盖参数；见node-contract.md |
| 浏览器计划 | 四层优先级、首个能动切片、必要节点卡、每层验收及非目标 | 能动候选输出与语义识别分开，真实训练留在核心层；不能有假运行占位 |
| 流程与连线 | 能动候选图、完整识别图、训练图、操作图及结构电路候选 | 项目图为design，SESE静态检查；未变图复用有效结果；不宣称运行可用 |
| 规则与交付 | AGENTS、项目治理、独立设计增量Review、main合流和远端推送 | 本轮无src/package/依赖/训练；普通Git回执，无额外SHA核对；清理自有worktree |

当前没有AppSDK需求文件或控制面初始化。本轮采用其治理原则，不建占位文件、守护进程或受管状态。相关边界见[项目治理](project-governance.md)。

## 2. 目录与唯一Owner

下列源码目录是后续实现责任规划，当前不创建空模块或文件。按当前层级需要逐个建立。

```text
NNAnything/
  AGENTS.md                         项目边界与规则入口
  README.md                         阶段与文档导航
  note.md                           单一项目进度/证据汇总
  docs/
    design.md                       总体责任地图
    implementation-plan.md          本计划：目录、分层交付、首批节点卡
    workflow-config.md              通用配置合同
    node-contract.md                可复用经验节点合同
    project-governance.md           推进、授权、治理与交付
    dagpipe/graphs/                  项目图拓扑真源
    reviews/                        已交付设计评估证据
  research/                         调研依据；原始页面资料本地忽略
  src/                              以下均为后续计划
    core/                           通用Node/事件/Workflow；核心层才增加训练Profile合同
    workflow/                       配置加载/编译适配、Flowed运行与显式结果
    nodes/common.ts                 通用规则、数组转换及汇总节点
    nodes/dom.ts                    DOM过滤/拆分，核心层增加特征/分类/组装
    adapters/browser/               页面观测输入与引用；不持有分类策略
    adapters/weibo/                 后续站点teacher，原始名称只用于标注
    backends/handwired/             核心层的显式数值后端
    data/                           核心层规范样本、来源分组与用途分区
    training/                       核心层拟合、校准及评估节点
    workflows/                      引用项目图并绑定节点/配置，不手抄拓扑
    index.ts                        公开consumer入口
  playground/browser/              首个场景consumer，无独立执行引擎
  tests/                            当前层失败模式所需的公开合同/黑盒用例
  data/、artifacts/                  本地原始数据/标签/profile/运行报告，默认不入Git
```

每个模块一个写owner。不同worker可按不重叠文件并行；共享基础合同由其owner先明确并验证，再派依赖任务。合同变化回到该owner，不跨节点回改其他模块真源。具体宿主派发和独占worktree规则沿全局合同。

## 3. 四层推进与停止点

| 层级 | 唯一行为交付 | 最小实现范围 | 验收与停止点 |
| --- | --- | --- | --- |
| L1 能动 | 给保存的页面测量，输出有序DOM候选引用、排除与未知原因 | 通用配置/执行基座、一个非DOMconsumer、网页观测和7个手写候选节点；不依赖模型或训练环境 | 公开入口跑完能动候选图，保序且规则正确；非法图/错端口/未授权effect明确拒绝。作者验收、整体milestone Review、main交付后停止本层 |
| L2 能有核心功能 | 识别完整卡片结构，训练同一节点并回载候选profile | L1后增加3个特征/分类/组装节点，完整10节点识别图；真实Handwired后端、规范样本及7节点训练图 | 前向/纠错梯度、来源分区、校准不足、旧新比较、同节点profile回载均有真实consumer证据；来源分类仍unsupported，单快照不报泛化成绩 |
| L3 完善功能 | 按实际任务补来源类别、语义查询与真实操作/监督修复 | 可辨广告/推广/推荐特征与数值支路、teacher准备、目标归属/查询、operation后观测验证、选择性入集 | 使用所选功能的真实目标与后条件验收；离线不动作，unknown不自动重放；不要求一次完成全部长期目录 |
| L4 提高兼容性 | 在已有效任务上扩展站点/DOM布局与环境适配 | 新场景观测/动作适配、兼容profile及对照样本；有收益证据后再选预测上下文、贝叶斯或可选画布 | 按同类目标做新站点/变体比较，不承诺零样本迁移，不改变通用核心来硬编码站点 |

当前实施只交L1；L2-L4是递进范围，不自动成为本轮工作。阶段切换遵循当时已授权目标；目标已覆盖下一层时继续执行，不重复索取逐节点许可。安全、数据正确性及真实结果要求不按层级后移。

## 4. L1首个能动切片与节点卡

单入口是保存的页面观测引用、当前FocusSpec和可选显式nodeRefs。单出口是CandidateSlots：每项包含index/nodeRef、资格状态和原因，并保留遍历范围/排除子树记录。候选结果不含伪造语义标签、isTarget或confidence。

| operator候选 | 输入→输出 | 独立职责和必要反例 |
| --- | --- | --- |
| dom.observe | 请求/保存观测→PageObservation | 适配已有测量及明确覆盖范围，原始资料只做证据引用；引用失效、缺必需测量不假装成功 |
| dom.viewport | 观测范围→视口槽位/遍历上下文 | 正面积相交、部分可见保留；离屏父容器不误剪可见后代；遮挡/可点击性不由相交证明 |
| dom.focus | 视口范围+FocusSpec→关注范围 | within/region只缩小目标；失效范围stale_scope；owned所需归属缺失时明确不支持/证据不足，不能按subtree假扮owned |
| dom.deny | 范围+明确规则→排除记录 | 命中规则保留原因；跳过自身与排除子树分开；不能生成训练负标签 |
| dom.allow | 前序范围+明确规则→允许范围 | deny优先；未配置allow不额外限制，显式空集合拒绝全部；不能复活离屏/被拒项 |
| dom.split | 可遍历范围→确定顺序层级项 | 包括中间容器与后代，父子可重叠；显式单节点/数组入口不强制扩展；引用/路径不成为学习特征 |
| dom.candidates | 展开项+相同FocusSpec→CandidateSlots | 复检展开项防止复活排除目标；保留项序号及排除/未知记录；不调用神经网络 |

上述节点可复用同一规则处理实现的不同实例，不要求七套类层次。configs只保存一份FocusSpec，节点通过明确局部引用绑定；无站点隐藏全局。

[能动候选图](dagpipe/graphs/dom-candidates.graph.json)为7节点6边单入口单出口设计图，与完整识别图承担不同结果合同。后续实现引用它，不用10节点图里的假分类节点拼出“能动”。

L1公开consumer须证明：非DOM流程可用；候选槽位顺序和排除映射正确；父级跳过不丢可见后代；deny/allow不冲突；async依赖齐备才执行；跳过/未知能结束；非法环、类型/引用错误和未授权副作用不被放行。原始现场缺裁剪/片段等证据时保留unassessed，不把单一外接框冒称精确可见或可操作。

L1就可以积累手写节点经验：例如父容器跳过导致漏候选的规范反例，归因给枚举owner，修规则后用同一输入回归。无需先有神经网络或自动监督服务。

## 5. L2核心层的组合计划

基础先独立验证再组合：显式Handwired加载与8输入9参数结构电路→特征/分类节点→规范样本与分区→拟合/校准/比较节点→两条workflow消费者。运行层与数值模块在共享合同明确后可按不同owner并行。

| 节点组 | 输入与输出 | 必需保障 |
| --- | --- | --- |
| dom.features / node.classify / dom.assemble | CandidateSlots+白名单观测→数值项→单标签结果→原槽位汇总 | 名称变化不改向量；缺测不调用模型；不压缩数组；profile不兼容拒绝 |
| training.prepare / partition | 规范节点输入+期望输出→准备样本→用途分区 | 未知标签保留但不参与拟合；按snapshot/post/adAsset传递闭包分组，不把未复核初始标注变黄金 |
| training.fit / calibrate | 训练分区+明确基础profile→候选参数→校准状态 | 真实Handwired反传；参数约束投影；新拟合清旧校准；独立覆盖不足用identity并明确uncalibrated |
| training.compare / assess / report | 同一留出样本的旧新输出→逐例结果→候选profile和报告 | fixed/regressed/unresolved/retained/unassessed均显式；证据不足不自动采用；所有必需产物沿事件传递不从隐藏状态获取 |

完整图见[识别](dagpipe/graphs/dom-recognition.graph.json)与[训练](dagpipe/graphs/node-training.graph.json)。同一目标节点定义、输入编码和兼容profile是两条流程的接点。训练只处理目标节点I/O；teacher标注是独立数据准备流程，模型不读原始class/content。

结构电路及w测量算法见[数值连线](structure-circuit-m1.md)。当前可分性、误判形态和样本量都需实施后验证；现有微博资料只有单来源组，不能报独立校准或泛化准确率。广告也可为完整卡片，结构结果不能代替普通帖/来源判断。

## 6. 未知、Owner与验证时机

| 未知 | Owner及动作 | 触发时机 |
| --- | --- | --- |
| Flowed在选定Node工具链上的实际运行与异常/扇入行为 | 执行层owner通过非DOM公开consumer验证，必要依赖只在实现时安装 | L1，阻断其受影响运行验收 |
| 原始测量的子树/祖先/裁剪覆盖不足 | 浏览器适配owner声明覆盖、补足必要观测或保留unknown，不能猜测缺失事实 | L1数据输入与L2取参 |
| 8维结构输入的实际可分性和所需样本 | 数值/数据owner复核结构标签，再按来源组开发与留出比较；不足则回特征/连线设计 | L2，不阻断D0架构交付 |
| 图片广告/推荐/商业推广的可辨特征 | 来源目标owner对照原始现场审特征、标注边界和数值支路，未支持前拒绝该target | L3所选来源任务启用前 |
| 独立校准的最低覆盖和指标界限 | 评估owner按目标/风险声明覆盖，使用多独立组检验；单快照始终开发态 | L2机制验证，L3真实数据启用前 |

## 7. D0收口与后续启动

本轮顺序：文档和新候选图定稿→针对性检查→原设计Reviewer对新增合同/范围/治理增量复核→提交合入main→推送origin/main→记录回执并清理自有worktree。未变图和选型证据复用，不因文档修改重跑业务或模型测试。

后续浏览器L1开工时以本计划、有效项目需求、图和适用治理规则形成具体执行派单。只实现能动切片，完成该层公开consumer验收和一次完整milestone Review再交付。不会因D0完成自动安装依赖、连接页面或启动L1代码任务。
