# 通用递归Goal独立泛化性审查

日期：2026-10-20。对象为当前[递归算法合同](../recursive-goal-design.md)与[独立模块合同](../recursive-goal-module.md)，是泛化性专项审查，不重复把上一轮错误闭包PASS当作泛化证明。本报告为owner对独立原始报告的摘要；原件保存在外置run，未改写。

## 1. 结论

独立Reviewer未发现阻断泛化的合同缺口，findings为空，controller裁决PASS。结论限定为：在明确typed语义、已启用技能、领域证据与评价器、有限预算的前提下，接口与有界递归控制机制能够跨域实例化。六类场景的具体推演未发现必须为某领域修改通用核心的合同障碍。

这不是任意自然语言目标求解器，也不是运行泛化或数值模型泛化的证明。通用runner、组合selector和跨域operation仍未实现；审查时 main 的 CLI 形状为6head、14wire、84参数（批次1交付后为10head、30wire、300参数）；现有CLI模型不能仅因套用本框架就跨域复用。

## 2. 独立性与证据

本轮首先重新查询并实际调用`gemini-4-argon-medium`、effort medium；init型号匹配，但返回RESOURCE_EXHAUSTED/code429，exit3，没有产生实质审查。保留该原错后，按编排后备新建独立OAuth `gpt-6.1-sol` medium只读Reviewer，未复用作者或先前Reviewer会话。最终退出0、schema合法、findings为空、controller PASS。

Reviewer亲读当前完整设计、项目约束与既有图，按用户要求以跨域实例与反例检查：根不丢失、逐层技能选择、无技能报错、真实New State反向满足、全部链回收、执行错误完整返回。原始JSON包含每个场景的Goal/State/技能/局部head/父条件映射及错误边界，不仅检查“有Adapter接口”。本轮未运行代码、测试、训练或图重校验；既有cwd原始结果只用来核对真实边界。

原件：`/Volumes/Intel/playground/nnanything-runs/recursive-goal-generalization-20261020/independent-review/review.final.md`，及同目录status、events、log、exit。首选失败的init/events/stderr/exit在该run根目录。

## 3. 六类具体实例

以下非CLI技能名及State字段是独立审查中的合同实例，不是当前可导入API或已运行能力。

| 场景 | Goal、State与技能链实例 | 如何反向满足/返回错误 | 泛化判断与必要条件 |
| --- | --- | --- | --- |
| CLI cwd | 根S.cwd等于入口绑定D；State含S、D、真实cwd和revision；pwd→比较→必要时cd及已有后验 | 同S有效证据满足父cwd条件；失效目标返回invalid_binding，已提交后观测失败保留提交和原始观测错误 | 不需核心内置session。仅现有外置consumer有4场景87/87，不能扩称通用runner实测 |
| Browser输入 | 根页面P的字段Q实际值等于X；State含页面身份/导航代次、对象绑定、可编辑性和实际值；bindField→ensureEditable→setValue→readValue | 子条件经fulfills返回，最终值必须属于当前P和有效对象；导航/DOM失效撤销旧证据，迟到旧结果不能满足新页面 | 页面/对象有效性由领域adapter显式定义；只有input分类、无operation技能时必须capability_missing |
| Computer use | 根窗口W的控件C值等于X；State含窗口身份、控件关系、截图有效范围和焦点；先满足绑定/焦点再typeText | 已派发无回执为effect_outcome_unknown，父不能按已发按键判成功；显式恢复只能用已声明只读技能补证 | 可用统一帧/ledger表达，不需核心识别窗口；当前桌面仅占位，未做运行验证 |
| 纯计算/只读 | 例如add(4,6)结果等于10；空effect集合；已有合格结果则零动作，否则调用固定add；查询使用领域数据版本 | evaluator验证实际知识结果；缺证据unknown，冲突evidence_conflict，typed计算失败execution_failed | 不需文件、cwd或OS副作用；固定函数无需虚构训练head，但仍须遵守公开workflow合同 |
| 有限搜索/分段 | 根为固定100项范围的有效检查覆盖；State含范围、有效结果与剩余项；每次衍生有限itemCheck批次 | 同一领域定义分母；90项在threshold90可达标，threshold100仍需10项；存在匹配的Goal不能用覆盖率代替 | 连续满足度由领域评价器表达；动态展开不造静态回边，全树预算和义务进展不因换id重置 |
| 深度3及同层3依赖 | 根表单满足显式提交规范；prepareForm含身份绑定、字段配置、最终校验；configureFields→setField→原子setValue/readValue | 每帧fulfills直接父条件，逐层重验；设置后项若重置前项，前项历史回执不能满足最终持续条件；未选分支not_applicable | 同一帧合同可表达，无需层数专用API或领域另造调度器；持续条件/一次性阶段必须由规则声明 |

## 4. 泛化成立所需的领域合同

新领域必须显式提供typed Goal及对象绑定、可用技能词表、领域State/证据适用范围、evaluate/derive/executeAtomic/进展规则、错误与effect映射；需要学习的局部选择器另有合法特征、profile及训练合同。不能把整个新领域调度器塞进一个大adapter后声称通用核心已覆盖。

以下共性由通用模块保持：根与阈值不变、单父条件映射、顺序依赖、有界栈/全树预算、真实父后验、错误及未知效果返回、终止/取消/恢复边界。领域只解释条件与事实，不接管栈、调度、预算或父链回收。

特别需要保持：

- 旧对象、旧页面、旧窗口或旧数据集的证据不自动适用于新状态；来源及适用性不明须未知。
- 无技能、拒权、错选、执行失败、未知效果、后验缺失和框架异常分别返回，不根据领域换成含糊成功/失败。
- 子链历史成功不替代父当前条件；一次性阶段与持续不变量分开。
- 连续满足度必须由语义范围与分母定义，节点完成率不能代替目标满足度。
- 同Goal的组合→原子下降合法；无下降自衍生、无进展换id或子层重置预算不合法。

## 5. 尚未证明与明确范围

尚未证明：通用runner实际执行的终止性、至少三层递归黑盒、跨领域错误传递、恢复及取消、browser/desktop operation和新领域selector训练效果。已有cwd证据仅证明专用consumer按规则组合当前CLI叶workflow。

明确不覆盖：无约束自然语言理解、未注册技能自动创造、无限持续监控、并发/多父共享可变帧、分布式事务或自动补偿。这些不作为当前设计缺陷，也不能在对外能力描述中暗示已支持。

本次3项审查工作完成：独立六场景推演、反例与错误边界核对、真实结论及证据落盘。没有改动目标算法、模块合同、图、业务代码或权重；实现阶段必须按这些具体领域合同及反例验收，不能用本次设计PASS代替运行验收。
