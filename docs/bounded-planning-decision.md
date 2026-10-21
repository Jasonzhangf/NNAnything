# 有界推理的可替换决策单元

状态：候选实现已通过规则、真实Handwired数值推理及公开consumer替换验证；尚未完成本轮整体Review和main交付。真实预训练、后训练、持久奖励评分及自动升级未实施。阶段证据由[note.md](../note.md)统一维护。

对外仍调用`nnanything/recursive-goal`的`runRecursiveGoal`。内部`dependencies.planning.decision`提供`ref`与异步`infer`，输出既有`PathRanking`。省略decision时使用唯一通用默认规则。显式选择权重provider后，缺资源、坏profile或推理失败均返回准确错误，不切回默认规则。续接保存decision语义引用；同一continuation中更换引用会被拒绝。

## 决策与控制

| 层 | 当前可替换边界 | 固定保障 |
| --- | --- | --- |
| 当前技能选择 | 既有`adapter.select(SelectionInput)`，每次一个head | 运行时核对启用词表、mode、权限、计划入口和真实回执 |
| 递归目标分解 | 既有`adapter.derive(DerivationInput)`，每次一个有限条件批次 | 根Goal/阈值不变，子条件逐项真实验收、依赖及预算有界 |
| 有界结果预测 | `ResultModelBinding.predict`，当前是注册的确定性有限结果模型 | 预测与实际State分开、N/节点/调用预算、逐分支frontier |
| 路径与适用备选排序 | 新`PlanningDecisionBinding`，默认规则或Handwired权重 | 只比较合法候选，输出必须完整排列；不能决定root/checkpoint真值或授权 |

递归分解和技能选择也可将内部实现换成权重模型。它们不是永久手写层；当前尚未训练。未来拟合复用这些显式I/O及`TrainableSemanticUnit`的infer/train生命周期，不能另造隐式层序、重试控制或让学生调用执行器。GTPyhop可作为Goal/task分解与回溯骨架的参考；本项目未引入其运行依赖或据此宣称学会分解。

## 输入、wire与profile

决策输入含显式preference、合法候选的预测投影与typed顺序、已适用的降序先验关联及unknown。候选ID仅用于返回映射，不是数值特征。排除先验由来源和适用范围守卫执行，不能被权重重新加入。

当前Handwired线性效用电路是单输出、18个显式wire：bias；satisfaction/risk/cost/rankOrder各自的known与value；covered/truncated/unknown三个覆盖位；deprioritized prior；unknown.present；四种preference编码。wire顺序、有限权重、尺度、单位、归一化边界、unit/provider版本和Handwired源码根均由调用者显式传入。值越界或profile损坏报错，不裁剪或补零；非零权重需要的测量缺失时DEFER。同分DEFER，不按数组、路径ID或日志顺序破同分。效用未校准，不是成功概率或实际满足度。

代码owner：`decision-contracts.ts`维护统一I/O与binding；`lib/filters/bounded-planning-decision.ts`包装唯一默认排序；`lib/training/bounded-planning-decision.ts`复用既有Handwired加载器和线性电路。公开门面导出binding构造器；不新增执行引擎。

## 候选权重热重载与失败对照

公开入口另导出`createPlanningDecisionReloadResource(handwiredRoot)`与`comparePlanningDecisionCandidates(input,candidates,handwiredRoot)`。Goal是切换后续请求的候选资源，或解释同一已记录决策在不同候选下的差异；达标条件是版本不混用、错误不伪装加载成功、对照零动作副作用。State是加载状态与已捕获binding，Action是reload/capture/数值对照。

资源`reload({ref,profile})`在调用时复制并校验完整profile，准备Handwired电路后一次发布。`ref`是参数版本，区别于profile的unit/provider合同版本。同一资源不重复发布成功使用过的参数ref，不并发reload；加载期间capture明确报错。加载失败后capture也报错，不将上次权重冒充本次候选。已经capture的不可变binding继续可用；后续成功reload恢复新请求capture。不同资源相互独立，无全局当前权重。

请求开始前capture一次，注入既有`dependencies.planning.decision`。在途请求和全部continuation沿该binding；发布B后新请求可使用B，A的续接仍提供A。现有decisionRef守卫拒绝中途偷换。跨进程恢复由调用者重建对应旧资源，本轮不实现历史权重仓库。调用者必须为不同参数提供不同ref；不增加参数hash。

对照入口只消费已记录的`PlanningDecisionInput`和显式`{ref,profile}`数组。输入先校验并复制，各候选独立输出参数ref、profile尺度、逐路径features/known/missing、utility或null及ranking；坏profile/后端错误按候选保留，其余继续。同分与缺测仍是DEFER，重复参数ref拒绝。不同profile的原始utility不能跨尺度当成优劣评分；应结合排序、逐例实际评价和独立回归定位原因。

该入口没有执行器，不观测环境，不恢复continuation，也不重放实际动作。真实重执行实验仍需受控沙盒和原有effects/ledger保障。候选排序改变不产生实际成功或奖励。报告可交大模型分析，但当前没有自动大模型调度、后台采集/评分、后训练或自动采用。热重载仅发布实验资源，候选保持uncalibrated/not_applied，采用仍受模型演进合同约束。

`bounded-planning-reload.test.mjs`从公开入口验证A/B排序反转、原profile修改隔离、加载期间/失败后capture拒绝、旧binding继续使用、同一输入多候选数值与手算一致、坏项隔离，以及续接拒绝新版本而接受原版本。

## 训练信号与采用状态

当前单元暴露共同infer/train接口，train明确返回`PLANNING_DECISION_TRAINING_NOT_IMPLEMENTED`，不产生假候选。手工权重仅证明数值推理与替换，不计训练交付。未来样本至少包含当时完整决策输入、期望/等价候选集合或DEFER监督、来源与场景家族分区、实际执行及后验评价引用、先验依据。一次实际失败不证明未执行备选成功。

正常路线是初始样本和手写teacher→泛化验证→显式初始权重→真实后验数据后训练→无回归且独立泛化改善后采用。默认不重写逻辑或重做预训练；仅重大表示/参数缺失使一大类场景不可覆盖时，按[模型演进合同2.1](model-evolution.md#21-预训练后训练与结构修订边界)修订。采样、奖励归因、隔离训练、回载与采用只沿该唯一合同，不复制第二流程。

## 验收边界

`bounded-planning-decision.test.mjs`用预先手算的小矩阵验证真实`evaluateReference`效用、两组手工权重反转、先验wire、缺测、坏profile和训练未实施错误。`recursive-goal-bounded-integration.test.mjs`通过同一个公开请求，分别由规则和权重选择两个合法动作，并验证异步拒绝、非法排列、取消、checkpoint回退与历史错误保留。

这证明决策可替换及两域控制可复用。它不证明任意高层语义已泛化、全部递归决策已训练、浏览器/桌面已接入，或后台评分和自动后训练已经运行。
