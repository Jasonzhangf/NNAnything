# 单次失败反馈与后续策略：分段训练合同

本轮按用户顺序实施：先单次动作，再单次失败/点击无效的反馈，最后有其他已确认候选时学习重试后的次选。基础50参数profile已经main交付且保持不变。反馈成员已真实拟合并回载，候选未采用；策略成员仍未实现/训练。整体Review与main回执沿note.md。

## F1：先训练单次失败反馈

固定知识Goal为解释上一次单次动作的反馈，阈值100只用于独立监督验收。State为完整原请求、原始执行结果/错误、实际后验及当时控制资源；Action为当前反馈分类，New State是带有模型判断的知识输出。模型判断不覆盖原Goal满足度，不证明重试安全。推理结果同时保留原始事实与错误，满足度为null，不自报分类正确。

反馈heads为completed_without_goal、execution_rejected、indeterminate。真实Goal已经达成时沿实际证据直接返回goal_achieved，不另训练成功判断。completed_without_goal只证明实际目标未达成，不证明没有其他副作用。原子执行失败、后验缺失和effects未知必须分别保留；点击无效不能自动标成按钮关系负例。

本切片completed_without_goal的监督要求：已派发、成功回执、无执行错误、后验当前且足以证明目标未达成，并且effects知识明确。effects未知时即使实际satisfaction=0仍标indeterminate，原始满足度0不丢失。effects明确不代表无副作用，任何诊断均不授予retry权限。有明确拒绝证据可归execution_rejected；派发不确定不能只因出现错误就当成已明确拒绝。

唯一输入/样本/profile合同为lib/adapters/browser/feedback-contract.ts。12条wire：bias、dispatch known/value、receipt.ok known/value、executionError.present、post.currentValid、expanded known/value、rendered known/value、effects resolved。post有效性沿原子Goal document/scope绑定、当前控制、更新观测身份和revision检查，不能因字段存在就补为true。缺测保留known=false，不能将缺测与数值false混淆。raw错误消息、元素名称、引用字符串和后续动作teacher不进学生特征。

独立3×12=36参数，profile browser.action-feedback.v1，零初始化，真实Handwired200epoch、学习率0.1。此预算独立于原子模型，不改原子权重。候选未校准、未采用。3train family共36、1development共12；另2verification family共24由独立owner保留，不传fitter。实际无效果、成功和原生错误记录与合成反例分开，至少一个真实no-effect反馈进入训练并保留真实来源。

首次逐行平均拟合固定预算后为33/36与11/12，保留failed candidate。独立修订计划证实当前6种投影可线性区分，不增加wire。修订损失为train内部不同完整学生投影等权：每行系数`1/(K × 该投影行数)`，K为投影种数；teacher不参与键，同投影冲突标签显式失败。全部36行仍逐行真实求梯度，dev不进入权重分组。一次修订仍200epoch/.1/零初始化，另目录保存。回执记录目标口径、投影数和组频数；无效点击错例不删除、不重标。验证集未供该修订使用。

统一接口由lib/core/trainable-unit.ts定义infer/train，原子与组可使用相同泛型生命周期而保留明确领域类型。反馈成员公开入口nnanything/browser-feedback，推理是1N0E知识分类图，训练是6N6E准备/来源分区/拟合/比较/评价/报告，分区另连比较。SESE内无回边；不新增执行引擎。数值后端复用既有Handwired与中性linear-policy构建器。

F1验收先于策略代码派发：真实拟合/非零梯度、新进程回载、独立未见家族、坏profile/缺后端显式错误、实际无效果与执行拒绝和不确定分别可辨、原错误及effects不丢。发生未知不能强选类别来清零。固定预算未达标先查可辨性及梯度，不静默延长。

## F2：反馈通过后再训练当前策略

独立计划位于外置run/progressive-plan.md。最多两个已确认等效控制策略，策略选择另持有权重且消费F1的实际输出；不得用teacher反馈标签替代正式预测。根Goal保留。当前一步仅选一个策略，重试n、耗尽、总预算与停止确定性持有，不训练层序/是否继续。n默认2，含第一次尝试；可安全重试的同错到n后放弃首选，再由学生选允许的次选。无可用能力、对象歧义、证据不足或effects未知准确返回，不做隐式fallback。

F2的候选评分和原子显式策略接入、递归控制扩展须在F1通过后落对应图/gate/红测；不把尚未实现的56参数组合或retry行为写成已运行。F1资料不能兼作F2独立留出；每次当步输入只能包含此前发生的真实反馈。

## F1结果与限制

证据根为 `/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020/feedback-strategy`。四个GCM资料/实现worker实际连接失败，Flash后备实际quota失败，均未改产品；父接管实现和资料准备。48份资料中1份来自真实原生无效点击，47份为明确合成；train36/dev12。24份保留资料在拟合前分开准备，未送入fitter；它们由父接管作者职责，不能称为独立worker作者。独立Reviewer另核对监督和首次评价证据。

首次逐行平均候选固定200epoch失败33/36、11/12；经独立Plan明确语义并修订为投影覆盖等权，保持原标签/模型/初始化/epoch/学习率，仅作一次完整修订fit。修订后36/36、12/12；总耗时391.99ms含后端加载339.57ms，实际拟合48.75ms。36参数、36行×200=7200次真实梯度求值；6组频数12/6/6/3/6/3。首次失败目录fitted-feedback保留，修订目录fitted-feedback-coverage-r1另存。coverage-red/green记录重复记录改变旧损失、修订后loss/gradient不变的因果反例。

新进程回载48/48、首次保留集24/24，fitted:false，候选uncalibrated/not_applied。保留集与训练各有6种学生投影，新增投影为0；结果限于这些结构化反馈模式的来源分区回放，不能宣称完整合法输入或任意页面泛化。真实无效点击公开infer返回completed_without_goal，原始满足度0及effects/receipt/新状态完整保留，反馈单元满足度仍null。

全仓回归876/876零skip；9项反馈测试含36参数差分、覆盖损失反例、冲突监督拒绝、缺后端/坏资料/原错误保留和真实Goal保护。比较节点实际使用来源分区及拟合两个输入，未在拟合输出重复携带分区替代图边；保存候选的0次更新回放验证当前训练workflow绑定，明确不是第二次拟合。F2重试/次选未开始，F1诊断也不授予retry资格。
