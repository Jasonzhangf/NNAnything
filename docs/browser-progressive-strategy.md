# F2：当前策略优选与有界重试

F1反馈36参数已独立Review并main交付2da1559；原子50参数保持f7b97a7合同。F2只拟合20参数候选评分，不重训前两成员。详细独立机制计划为外置feedback-strategy/strategy-detail-plan.md。当前已实现并完成下述作者训练/行为验收；main集成与独立Review状态由note.md记录。

根Goal为SetExpanded(regionRef,true)，threshold100，bindings不变。State包含实际浏览器观测与历史反馈知识；typed retryControl单独持有每策略同错累计、锁定、耗尽及总预算。学生每次只选当前一个策略/DEFER，Action调用原子单次，真实New State决定达成。n默认2且含首次，重试层序、是否继续与计数不训练。

两个明确确认同效果的策略各有唯一skillId和targetRef：native button与显式非原生role button，均控制同一Goal。注册表为显式领域资源，不凭多provider推断等价。当前事实的controls/enabled/hit/point仍由真实观测与原子模型验证。未确认多对象继续拒绝；standalone原子双provider仍DEFER。组合selected.v1入口保留全部DOM及关系，仅投影选定目标到能力provider数量，decide同时按该显式范围验证；不制造CLICK，不绕过原子DEFER或错误。

共享2head choose/defer、10wire，20参数；合同唯一源lib/adapters/browser/strategy-contract.ts。每候选margin=choose−defer，DEFER分数固定为0。最高且唯一、严格正margin才SELECT；并列/非正DEFER，不按数组首项。原子margin有限映射为0.5+0.5*d/(1+abs(d))，不是概率。候选只消费自身、同绑定及适用条件历史的F1实际预测；teacher不进特征，A失败不广播B。verifiedSuccess同样由该候选实际历史证据提供。当前Goal已真实达成直接结束。

训练使用完整决策集的最大竞争项平方hinge损失：teacher分数s与其他选项最大分数r构成u=max(0,1+r−s)，每集合L=u²/2，仍按原始训练集合平均。teacher可为候选或固定0的DEFER；固定训练间隔1只约束分数尺度，不改变运行门槛或Goal阈值。u>0时teacher导数−u，所有并列最大竞争项等分+u，固定0获得的份额不反传；正确且超过间隔的集合梯度为0。保留原子/F1固定成员、20参数、样本、分区与预算。首次跨候选CE实际fit未达标（train30/36、dev8/12），候选与轨迹保留；独立分析证明现有线性特征可表达全部train/dev，并否定简单投影等权修订。本次只做这一项损失修订，不自动续训或调整预算。

历史还须绑定其内部invocation.targetRef，不能只信外层candidate标签；同文档历史不得晚于当前revision。verifiedSuccess的known/value由实际执行及有效Goal证据计算，不从F1预测类别推成事实；未执行的NOOP达标不能当作该策略成功。Goal已达成必须expanded/rendered均真实为true，缺呈现观测保持不足。作者在拟合前发现合成历史错误设为未来版本，已取红证据并修正资料时序与边界，保留原监督，不让未来结果进入当步输入。

固定36train/12dev/24verification当前决策集合，按来源家族和整轨迹隔离；训练一个集合不是把两个候选当两个独立正例。零初始化200epoch/.1，真实Handwired每候选求logit导数，所有梯度只更新同一20参数；记录集合数、候选行数、候选row-epochs、时间。固定预算失败保留错例与梯度，先查语义/可辨性/接线，不自动延长、改标签或加入fallback。拟合前拒绝跨集合输入冲突，不能用id/顺序区分同输入。

控制owner仍为既有recursive-goal，optional retryPolicy与continuation.retryControl显式保存。策略注册为两个稳定atomic skill；无policy的旧consumer行为不改。计数更新只消费已提交、未计账的dispatch；新observationId不重置。到n耗尽首选，从未耗尽合法候选由学生选择；锁定只剩一项也必须学生正margin。core全树transitions与独立maxAtomicAttempts均有界，异常回调也消耗尝试，续跑不能变policy或重置额度。SELECT越界直接policy_error，无补偿选择。

首个runtime只自动retry已成功完成且明确无副作用的未达标尝试：core独立要求outcome succeeded、无执行/验证错误、当前unsatisfied、effect knowledge none、无未决验证，再调用领域assessRetry纯判定；F1预测不能覆盖这些条件。证明none须有显式受控fixture proof绑定attempt/前后观测/target，区域仍折叠或raw effectKnowledge known不等于none。一般执行拒绝、已知其他副作用、effects unknown、失效/禁用/权限变化准确停止；不冒称已支持所有错误重试。

原子每次`currentControl()`均委托实时资源源，支持同步或Promise；不能用observe时缓存代替apply前的查询。raw atomic结果或receipt的effectKnowledge为unknown时，领域effects优先保留unknown；合法proof、Goal已观测达成或F1类别都不能把它改成none/known并绕过停止守卫。根Goal事实与执行/effects错误分别保留。

F2当前步图5N4E：准备真实State/策略→解释历史反馈→选择并核对当前策略→原子一次执行→汇总采集。每run最多一次原生输入。多run由现有recursive runner调度，不在executeAtomic内部循环，不加第二执行引擎。训练图6N6E含分区直连比较边。单元与组合沿共同infer/train接口，原始成员结果、错误、effects和采集回执不丢。

最低黑盒：A→A→B达标、A→A→B→B四次未达标后停止、n1、次选DEFER零补偿、同分/顺序与引用变化、unknown effects停止、续跑计数与policy校验、原子standalone/组合配对及故意错误学生。真实键鼠和真实后验才证明轨迹；合成/模拟只补边界。独立Review、main/push及自有资源收口后才交付。

## 本轮训练与行为证据

唯一证据目录为 `/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020/progressive-strategy`。首次CE候选失败保存在`fitted`；一次独立损失修订后的候选在`fitted-r1/candidate.json`。固定零初始化、200轮、学习率0.1，20参数真实Handwired拟合：36/36训练、12/12开发，新进程回载48/48。训练包含33个合成决策及同一真实教师轨迹的3个当步决策，开发为12个合成决策；真实教师演示不计学生行为。58候选行、11,010实际梯度候选轮，拟合38.86ms，总365.73ms。未达到间隔的集合才反传，因此不把未计算的梯度计入处理量。候选仍未校准、未采用。

原独立24例oracle原始结果保留为FAIL 22/24，未改原JSON或预期，也未据此重训。两项single-candidate-defer要求拒绝，但固定候选margin均为正1.8258569413；独立只读裁决确认其“非正margin”前提未成立，实际SELECT符合合同。其余22项符合原预期，其中2项为同分拒绝边界，不全算学习成果。两项输入另用明确的零权重负控制2/2及固定负bias对照2/2验证DEFER，诊断profile不计入训练候选成绩。原失败、裁决、补充控制分别见`verification-r1-metadata-repaired.log`、`verification-oracle-plan.md`、`verification-controls.json`，不宣称24/24训练候选通过。

真实学生经公开递归入口、实时CUA原生AX输入完成9场景、16次输入：AAB达标、AABB未达标后停且无第五次、n1的AB、AA第二次成功后停、未知效果A后停、禁用A后停、初态已满足0输入、零策略0输入、页面重排且三个新进程续跑AAB达标。`native-acceptance.json`逐项断言根Goal、真实满足度、动作次数和错误，保留每轮receipt/continuation。失效、权限、次选DEFER、错误成员及采集失败等另由公开接口合同测试覆盖，不冒充原生场景。全仓936/936、零跳过。范围限当前受控展开语义及已测投影；不宣称任意网站、所有错误自动重试或全模型自动演进已经完成。

完整独立Review另检出control缓存和proof覆盖rawunknown两项P1，现已修复并补公开接口红绿回归。修复后全仓943/943零跳过；原生AAB复测3次输入成功，另加一项“rawunknown＋合法proof＋故意错误F1”诊断场景，真实输入1次后effect_outcome_unknown停止，原始receipt/proof/错误均保留且未记安全重试。原生记录累计11轮、20输入，其中10类场景及一次AAB复测；错误诊断F1不计训练候选。定点独立复核与集成终态见note.md。
