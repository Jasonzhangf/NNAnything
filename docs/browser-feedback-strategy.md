# 单次失败反馈与后续策略：分段训练合同

本轮按用户顺序实施：先单次动作，再单次失败/点击无效的反馈，最后有其他已确认候选时学习重试后的次选。基础50参数profile已经main交付且保持不变。反馈成员已真实拟合并回载，候选未采用。本文记录F1阶段；当时策略成员尚未实现/训练，当前F2状态由[browser-progressive-strategy.md](browser-progressive-strategy.md)维护。整体Review与main回执沿note.md。

## F1：先训练单次失败反馈

固定知识Goal为解释上一次单次动作的反馈，阈值100只用于独立监督验收。State为完整原请求、原始执行结果/错误、实际后验及当时控制资源；Action为当前反馈分类，New State是带有模型判断的知识输出。模型判断不覆盖原Goal满足度，不证明重试安全。推理结果同时保留原始事实与错误，满足度为null，不自报分类正确。

反馈heads为completed_without_goal、execution_rejected、indeterminate。真实Goal已经达成时沿实际证据直接返回goal_achieved，不另训练成功判断。completed_without_goal只证明实际目标未达成，不证明没有其他副作用。原子执行失败、后验缺失和effects未知必须分别保留；点击无效不能自动标成按钮关系负例。

有效且当前的后验确认Goal达成时，即使执行回调报错或effects未知，知识结果仍可为goal_achieved；原执行错误和effects不清除，这不表示执行干净成功或允许重试。新增逐步观察反馈独立承载执行错误与观测错误，F1优先检查该typed后验适用性；旧样本缺新增字段沿原合同读取，不补造新观测。现有36参数是否覆盖新的合法失败投影须实际回放判断，不从旧样本通过推成全部新反馈正确。

本切片completed_without_goal的监督要求：已派发、成功回执、无执行错误、后验当前且足以证明目标未达成，并且effects知识明确。effects未知时即使实际satisfaction=0仍标indeterminate，原始满足度0不丢失。effects明确不代表无副作用，任何诊断均不授予retry权限。有明确拒绝证据可归execution_rejected；派发不确定不能只因出现错误就当成已明确拒绝。

唯一输入/样本/profile合同为lib/adapters/browser/feedback-contract.ts。12条wire：bias、dispatch known/value、receipt.ok known/value、executionError.present、post.currentValid、expanded known/value、rendered known/value、effects resolved。post有效性沿原子Goal document/scope绑定、当前控制、更新观测身份和revision检查，不能因字段存在就补为true。缺测保留known=false，不能将缺测与数值false混淆。raw错误消息、元素名称、引用字符串和后续动作teacher不进学生特征。

独立3×12=36参数，profile browser.action-feedback.v1，零初始化，真实Handwired200epoch、学习率0.1。此预算独立于原子模型，不改原子权重。候选未校准、未采用。3train family共36、1development共12；另2verification family共24由独立owner保留，不传fitter。实际无效果、成功和原生错误记录与合成反例分开，至少一个真实no-effect反馈进入训练并保留真实来源。

首次逐行平均拟合固定预算后为33/36与11/12，保留failed candidate。独立修订计划证实当前6种投影可线性区分，不增加wire。修订损失为train内部不同完整学生投影等权：每行系数`1/(K × 该投影行数)`，K为投影种数；teacher不参与键，同投影冲突标签显式失败。全部36行仍逐行真实求梯度，dev不进入权重分组。一次修订仍200epoch/.1/零初始化，另目录保存。回执记录目标口径、投影数和组频数；无效点击错例不删除、不重标。验证集未供该修订使用。

统一接口由lib/core/trainable-unit.ts定义infer/train，原子与组可使用相同泛型生命周期而保留明确领域类型。反馈成员公开入口nnanything/browser-feedback，推理是1N0E知识分类图，训练是6N6E准备/来源分区/拟合/比较/评价/报告，分区另连比较。SESE内无回边；不新增执行引擎。数值后端复用既有Handwired与中性linear-policy构建器。

F1验收先于策略代码派发：真实拟合/非零梯度、新进程回载、独立未见家族、坏profile/缺后端显式错误、实际无效果与执行拒绝和不确定分别可辨、原错误及effects不丢。发生未知不能强选类别来清零。固定预算未达标先查可辨性及梯度，不静默延长。

## F2：反馈通过后再训练当前策略

独立计划位于外置run/progressive-plan.md。最多两个已确认等效控制策略，策略选择另持有权重且消费F1的实际输出；不得用teacher反馈标签替代正式预测。根Goal保留。当前一步仅选一个策略，重试n、耗尽、总预算与停止确定性持有，不训练层序/是否继续。n默认2，含第一次尝试；可安全重试的同错到n后放弃首选，再由学生选允许的次选。无可用能力、对象歧义、证据不足或effects未知准确返回，不做隐式fallback。

F2的候选评分和原子显式策略接入、递归控制扩展须在F1通过后落对应图/gate/红测；不把未完成行为验收的组合或retry写成已运行。F1资料不能兼作F2独立留出；每次当步输入只能包含此前发生的真实反馈。实际F2合同与状态只沿[browser-progressive-strategy.md](browser-progressive-strategy.md)。

## 基础层隔离最小实验：回执结果知识（2026-10-21）

用户要求先做一次最小实验，确认可行后再推进下一语义。本实验只验证一项基础知识：可信且关联本次尝试的typed执行回执明确报告失败、成功，还是缺少回执。它不解释任意失败原因，不判断Goal达成，也不授权重试。`ok=false`只证明明确失败，不能一概当作操作被拒绝的因果诊断；即使error为null也有明确失败证据。可信性与请求关联由调用者提供，不是学生学到的能力。

四元素：Goal为获得回执结果知识；satisfactionThreshold固定100用于独立监督；State为回执/null及只供组合保留的原始事实；Action为一次知识分类。New State增加成员预测但不覆盖原事实，推理satisfaction为null。效果知识、实际Goal、执行错误和后验分开保留。训练反推只确定三种证据状态的必要区分，不训练动作或层序。

这是仓库外可调用原型，入口为外置run的`train-once.mjs`导出`receiptUnit.infer/train`，组合由`prototype.mjs`的compose完成，不是新增生产导出API。推理对象流P校验投影→N成员推理→C组合返回，P另向C传原始信封，为3N3E；训练对象流资料准入分区→固定拟合→保存→新进程回载→评价→报告，分区另向评价供资料，为6N6E。两者单入口单出口且无回边；均为实验对象流，不假称已有F1算子接受新schema。项目workflows和生产lib不变，不新增执行引擎。

学生仅有`bias, receipt.present, receipt.ok`三条输入，三个head为`explicit_failure, explicit_success, unknown`，9参数。合法投影仅`[1,1,0]`、`[1,1,1]`、`[1,0,0]`；无回执的末位0只是占位，不表示观察到失败。effects、Goal、DOM、历史、错误正文不进入学生输入。组合只附加成员知识并保留原信封，不将它映射为旧F1成功或安全重试。

独立计划固定零初始化、真实Handwired CE全批量、200epoch/.1，3条train等权，只拟合一次。实际9参数、200次更新、600次逐行梯度求值；拟合6.606916ms，后端加载324.5765ms；loss由1.098612下降至0.269852，9参数均发生变化。GCM交付原型和单次训练，父补齐可导入的统一infer/train接口、profile语义校验及配对分数复核，未再次拟合。两项评价脚本错误原记录保留，修正后使用同一候选复测。

所有资料在拟合前准备，gold按上述可信回执规则派生，非真人逐例标注。train3、development3、verification54（回执3×effects3×Goal事实3×外层错误2）、已知R5回归4、历史原生记录8分别保存。合成信封仅承载独立观察事实，不冒充完整浏览器执行结果；历史原生记录从实际result.receipt原样取值并保留原来源。配方实例化检查effects、Goal及回执字段，R5的result/receipt均为unknown effects。

新进程回载：train3/3、development3/3、组合54/54、R5成员回归4/4、历史受控原生轨迹回放8/8；全部72项与保存前预测一致，原信封及回执72/72保留，反馈satisfaction均null。无关变化99/99对的特征、logits和预测完全相同；自身语义变化36/36对正确改变输出。零权重在全部72项均并列undecided；缺profile、坏schema/heads/wires/weights、缺回执字段、错误类型及缺后端共9项显式拒绝，无fallback。

可复核位置：`/Volumes/Intel/playground/nnanything-runs/atomic-refusal-20261021`。`node <run>/reload-evaluate.mjs`回载原候选并评价；`author-check.mjs`另作新进程完整分数/事实及负控制复核，已有author-check.json时其独占输出保护会拒绝覆盖。`train-once.mjs`作为命令运行会因candidate.json已存在而拒绝重训。候选、完整trajectory、逐例、配对和失败日志均保留。

结论：在可信typed回执的三状态域内，隔离的基础语义可真实训练、回载，并与独立effects/Goal事实组合而不相互污染。三种学生特征全部在train出现；54项只证明未训练信封组合及输入隔离，不是未见特征泛化。历史8项不是本轮新操作或外站验收。新成员处理R5正确不修复旧F1，也不改变旧F1的23/24失败记录。候选继续uncalibrated/not_applied，自动采集/采用未接入。完整Review及main交付沿note.md；下一语义本轮不启动。

## F1结果与限制

### 2026-10-21 有限域后训练与有界鲁棒性验证

本轮保持12 wire、三个head、36参数和推理合同，未增加特征或改写推理逻辑。训练请求新增可选`objective`：省略或`distinct_projection_coverage`保持原来的投影等权行为；显式`class_balanced_projection_coverage`使每个已出现的gold类等权，类内每个完整学生投影等权。每行损失/梯度系数为`1/(C × Kc × n)`，C是train内出现的类数，Kc是该gold类的不同投影数，n是该投影的重复行数。gold不参与投影键，冲突标签仍拒绝；development不进入分组。训练回执记录目标与类投影数，推理profile形状不变。未知objective显式报错。

有限语法为8种attempt×14种posterior×3种观察承载，共336组合；228合法、108无效、0未决。合法失败有56种学生投影、0标签冲突；旧候选215/228。独立解析梯度与Handwired最大差约1.05e-8；同结构解析分隔矩阵能处理228/228，但它仅作诊断，未作训练初值或候选。现有表示足以表达本轮有限域，不能据此证明覆盖任意浏览器状态。

训练固定77行、47种投影，development13行；类投影数按head顺序为3/17/27。旧36行train保留，新增训练排除了独立设计预留的9种投影。三次拟合均从原`fitted-feedback-coverage-r1/candidate.json`开始，学习率0.1，旧gold不变，失败候选全部保留：

| 尝试 | 目标与预算 | train | development | 有限域 |
| --- | --- | --- | --- | --- |
| 首次扩展 | 投影等权，200epoch | 63/77 | 9/13 | 216/228 |
| 类平衡修订 | 类/投影等权，200epoch | 73/77 | 13/13 | 220/228 |
| 覆盖预算修订 | 类/投影等权，2700epoch | 77/77 | 13/13 | 228/228 |

第三次是失败诊断后的独立计划修订，不是首次实验前预注册。预算由旧每投影累计目标系数`200/6`与新最小系数`1/(3×27)`推得2700；只比较累计目标系数，不宣称优化进程等价或保证收敛。无中间checkpoint择优、无验证集早停。实际207900次逐行梯度求值，2700次更新，拟合852.996ms。此前4种观察不完整投影的margin由负转正约0.98–1.13，此数只作事后诊断。新进程回载预测一致，旧72/72；已知原生开发反例改判indeterminate，原错误/effects和实际Goal事实保留，反馈自身satisfaction仍null。

真实Chrome验证在两种自有HTML布局上运行8个episode：6次原生点击、2次受控执行前拒绝。覆盖已知其他副作用但Goal未达成、点击后注入transport错误且Goal未达成、明确拒绝、Goal达成但回调报错，全部8/8。拒绝不是实际点击失败，注入错误不是站点自身报错。toolbar的拒绝回执没有error正文，其学生投影未在有限域或训练出现，正确归execution_rejected；这只提供一个新的受控拒绝投影证据。对象关系和命中点由调用者依可见证据预绑定，不能称已学会DOM发现。小红书只读观察未证实本切片的展开关系及状态，不计外站操作验收。

独立作者设计24个组合，父编排者机械实例化，原评价24/24及72对变换全部通过，但独立Review发现R5实例化遗漏：配方要求已派发、明确拒绝且effects未知，实际复制模板时将result及receipt的effectKnowledge均保留为known。原报告保留，不能作为24个原配方全部通过的证据。作者仅将这两个字段补为unknown，保持gold和保存候选不变，另存r5-corrected-cases.json与r5-correction-evaluation.json，补测R5及三个原语义变换，4/4均错误预测indeterminate，预期execution_rejected。该投影`[1,1,1,1,0,1,1,1,1,1,0,0]`未在train及有限域出现，暴露真实的未见投影泛化失败。

结合未受影响结果，正确配方成绩为23/24，变换分类正确为69/72；72对特征及预测结构不变性仍保持，不能与分类准确率混淆。正确24例中8例投影与训练重合，23例投影已在有限域诊断出现；R5为补正后首次评价的新投影。72对不是72个独立来源。评价后没有再次拟合。有限域验收通过，但本轮泛化/鲁棒性验收失败，候选不具备采用资格；不得将报告失败收口解释为模型健壮性已经完成。下一轮须先独立规划补齐副作用知识与拒绝的交叉覆盖，再确定训练与新鲜留出，不用本轮失败反复调参。

F2不改权重：原train/development48/48且逐例不变；独立包仍22/24，两个既有single-candidate-defer前提问题保留rawFAIL。新增公开递归consumer的6类边界、7种变体7/7，覆盖不确定effects停止、已知其他effects不授权重试、明确拒绝、达成且报错、失效后验及空权限；其中一个故意错分的诊断profile验证F1标签不能越过控制边界，不计候选准确率。

证据根为`/Volumes/Intel/playground/nnanything-runs/f1-robustness-20261021`：三轮fit回执、finite逐例、reload-audit.json、native-summary.json、holdout/first-evaluation.json、holdout/r5-correction-evaluation.json、f2-combination.json及完整失败资料均保留。最终候选为`fitted-coverage-budget-r1/candidate.json`，继续uncalibrated/not_applied；当前默认权重及用户扩展不变。作者全仓1031/1031零skip。结论限于声明有限域、受控原生行为和组合不变性；已证实一个未见投影泛化失败，独立外站操作仍未验证。整体Review及main交付回执由note.md维护。

### 2026-10-20 历史验收

2026-10-20逐步观察修复后的旧样本推理及新增失败判定：原子50参数旧60/60、F1 36参数旧72/72、F2 20参数train/dev48/48，逐例输出与修前一致；F2独立包仍22/24，两项既有single-candidate-defer前提缺陷保留rawFAIL，不能改gold清零。旧候选均未重新拟合、未采用。真实Chrome点击未展开后，执行回调抛transport错误，随后读回有效未达成状态，dispatch/effects仍unknown；旧F1给出execution_rejected，合同要求indeterminate。这是新增失败投影的后训练缺口。该反例已用于开发，不能再当未见留出。下一轮先检验现有12wire可辨性，再准备按来源家族分开的派发不确定、明确拒绝及观察失败对照，真实拟合、新进程回载和旧能力回归；F2在F1更新后做组合回归，本轮无独立改权重依据。

目标已由当前有效后验达成且执行器有错，是另一种情况。真实Goal事实仍应返回goal_achieved，错误与unknown effects保留且不授权重试；本轮修复的是确定性事实门禁，不靠训练覆盖运行逻辑。原始回执、推理结果及边界说明在`/Volumes/Intel/playground/nnanything-runs/step-observation-20261020/training-assessment.md`。

证据根为 `/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020/feedback-strategy`。四个GCM资料/实现worker实际连接失败，Flash后备实际quota失败，均未改产品；父接管实现和资料准备。48份资料中1份来自真实原生无效点击，47份为明确合成；train36/dev12。24份保留资料在拟合前分开准备，未送入fitter；它们由父接管作者职责，不能称为独立worker作者。独立Reviewer另核对监督和首次评价证据。

首次逐行平均候选固定200epoch失败33/36、11/12；经独立Plan明确语义并修订为投影覆盖等权，保持原标签/模型/初始化/epoch/学习率，仅作一次完整修订fit。修订后36/36、12/12；总耗时391.99ms含后端加载339.57ms，实际拟合48.75ms。36参数、36行×200=7200次真实梯度求值；6组频数12/6/6/3/6/3。首次失败目录fitted-feedback保留，修订目录fitted-feedback-coverage-r1另存。coverage-red/green记录重复记录改变旧损失、修订后loss/gradient不变的因果反例。

新进程回载48/48、首次保留集24/24，fitted:false，候选uncalibrated/not_applied。保留集与训练各有6种学生投影，新增投影为0；结果限于这些结构化反馈模式的来源分区回放，不能宣称完整合法输入或任意页面泛化。真实无效点击公开infer返回completed_without_goal，原始满足度0及effects/receipt/新状态完整保留，反馈单元满足度仍null。

全仓回归876/876零skip；9项反馈测试含36参数差分、覆盖损失反例、冲突监督拒绝、缺后端/坏资料/原错误保留和真实Goal保护。比较节点实际使用来源分区及拟合两个输入，未在拟合输出重复携带分区替代图边；保存候选的0次更新回放验证当前训练workflow绑定，明确不是第二次拟合。本节为F1验收时点，当时F2重试/次选未开始；当前状态沿上述F2合同。F1诊断本身仍不授予retry资格。
