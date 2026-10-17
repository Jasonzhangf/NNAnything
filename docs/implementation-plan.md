# D0交付与后续浏览器项目实施计划

状态：2026-10-17，L1 能动切片已交付并完成作者验收与整体 Review。当前授权为基础工作流资产设计与目录分类（nnanything-design-workflow-assets）：确立单源目录规范、交付基础规则采样工作流（dom-rule-sampling）拓扑与配置设计、三节点合同卡及文档路径归位；未实现算子保持 0.1.0-design，不进行实际代码实现或 L2 扩展。远端为 Jasonzhangf/NNAnything；L2-L4 仍为后续规划。

本计划依据独立规划及其收敛决议。目录全图在第 2 节单一 owner 维护，工作流清单与真源索引见 [workflows/README.md](../workflows/README.md)，节点合同卡唯一真源见 [lib/nodes/README.md](../lib/nodes/README.md)。

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

本节是 NNAnything 项目单一完整的目录分类与职责真源。已实现模块存放真实源码；未实现目录仅放置单个 `README.md` 说明职责与契约，不创建空 `.ts` 壳、假参数、重复注册表或插件服务。

```text
NNAnything/
  AGENTS.md                                  # 项目边界与规则入口
  README.md                                  # 阶段与文档导航
  note.md                                    # 单一项目进度/证据汇总
  package.json                               # 导出 main="./dist/index.js" 与 "./browser"="./dist/browser.js"
  tsconfig.json                              # rootDir="lib", include=["lib/**/*.ts"]
  .gitignore                                 # 忽略规则与 training/{samples,results,weights}/** 忽略
  workflows/                                 # 项目 DAG 图 (.graph.json) 与持久配置 (.workflow.json) 唯一真源
    README.md                                # 流程清单、图与配置对应关系与状态说明
    dom-candidates.graph.json                # [已实现 0.1.0] L1 能动候选图 (7N6E SESE)
    dom-candidates.workflow.json             # [已实现 0.1.0] L1 持久配置 (graphRef="./dom-candidates.graph.json")
    dom-rule-sampling.graph.json             # [待实现 0.1.0-design] 基础规则采样图 (3N2E SESE)
    dom-rule-sampling.workflow.json          # [待实现 0.1.0-design] 采样配置模板
    dom-recognition.graph.json               # [设计态 0.1.0-design] 完整卡片识别流 (10N10E SESE)
    node-training.graph.json                 # [设计态 0.1.0-design] 目标节点训练流 (7N8E SESE)
    operation-episode.graph.json             # [设计态 0.1.0-design] 操作闭环流 (7N6E SESE)
  lib/                                       # 库源码根目录
    index.ts                                 # 公开主入口：导出 core、workflow、nodes/common
    browser.ts                               # 公开 ./browser 入口：导出 adapters/browser、filters、nodes/dom
    core/                                    # 通用契约、事件信封、错误与基础 schema
    workflow/                                # 持久配置加载、DAG 校验、Flowed 编译与运行器
    nodes/                                   # 可复用 workflow 节点定义与合同清单
      README.md                              # 节点目录职责与三类基础采样节点完整合同卡唯一真源
      common.ts                              # common.scale / sum / count (1.0)
      dom.ts                                 # dom.observe / viewport / focus / deny / allow / split / candidates (0.1.0)
      trainable/                             # 可训练节点定义目录（存节点结构/特征，不存权重）
        README.md                            # 可训练节点与 Handwired 电路边界
    filters/                                 # 确定性过滤规则与候选槽位求值纯逻辑
      README.md                              # 规则内核与节点解耦说明
      focus.ts                               # 视口、focus、within、region 求值内核
      candidate-chain.ts                     # 7 节点过滤链求值内核
    adapters/                                # 外部环境与原始观测输入适配
      browser/
        observation.ts                       # 页面观测数据适配与白名单清洗
    training/                                # 节点训练算子实现目录
      README.md                              # 训练算子与 HANDWIRED_ROOT 边界
  training/                                  # 本地训练数据与权重资产根目录（数据本地生成，Git 忽略）
    README.md                                # 本地训练资产三分类与隔离底线
    samples/                                 # 规则采样或 teacher 生成的规范样本（JSONL，Git 忽略）
      README.md                              # 样本记录格式、单任务单标签与来源关联引用
    results/                                 # 训练拟合、校准与新旧比较评估报告（Git 忽略）
      README.md                              # 评估报告与引用权重 profile 规范
    weights/                                 # 训练产出的真实参数/权重 profile 唯一存放处（Git 忽略）
      README.md                              # 权重 profile 结构与禁止自动覆盖规则
  playground/
    common/
      demo.mjs                               # 非 DOM 公开 consumer
    browser/
      README.md                              # 配置文件与图引用说明
      demo.mjs                               # 浏览器公开 consumer（configPath 指向 ../../workflows/dom-candidates.workflow.json）
      observation.fixture.json               # 离线观测样例数据
  tests/                                     # 公开合同与黑盒用例
  docs/                                      # 架构、合同与治理文档（图真源移入 workflows/）
  research/                                  # 调研依据与原始数据（本地忽略，绝不提交）
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

[能动候选图](../workflows/dom-candidates.graph.json)为7节点6边单入口单出口设计图，与完整识别图承担不同结果合同。后续实现引用它，不用10节点图里的假分类节点拼出“能动”。

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

完整图见[识别](../workflows/dom-recognition.graph.json)与[训练](../workflows/node-training.graph.json)。基础规则采样流见[采样流](../workflows/dom-rule-sampling.graph.json)。三类采样节点完整合同卡见[lib/nodes/README.md](../lib/nodes/README.md)。同一目标节点定义、输入编码和兼容profile是流程的接点。训练只处理目标节点I/O；teacher标注是独立数据准备流程，模型不读原始class/content。

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
