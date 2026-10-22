# 浏览器长程目标：刚性基础与逐步反馈搜索闭环

状态：任务设计；未启动本目标的实现或训练。配套[启动提示词](browser-next-longhorizon-prompt.md)。本任务由浏览器目标编排者独立推进，通用核心由父编排者维护，不能各自复制推理循环。

## 目标与完成边界

完成一个可交付的浏览器能力切片：在显式允许的scope内，识别所需基础对象，向当前输入对象写入查询，通过人类键鼠动作提交，观察并判断当前查询的结果；遇到无效果、执行错误、观察不足或前提变化时，准确返回，或按已声明且有真实依据的策略继续。根Goal始终保留，每步反馈可解释，独立布局家族及旧能力无回归。

第一层基础语义按docs/design.md 1.1.1刚性训练：固定定义、手工构造/复核正反例、null规则及独立验收。第二/三层的关联、组合、预测与策略可混合实现。未接入的能力必须登记缺口，不把DOM识别当作能操作，不把手写harness算成模型学会。

不以“任意网站一定正确”为目标。首个使用切片保留typed输入和显式scope/对象绑定，不加入自然语言请求识别、账号操作、任意网页自动绑定、分页下载及computer use。不自动采用权重，不新增第二执行引擎。

## 已有交付与必读入口

- docs/browser-foundation-plan.md与旧F00–F18资料；候选树`/Volumes/Intel/playground/nnanything/browser-foundation`，含尚未获集成批准的分区代码与focus-ignore脚本。它是待审成果，不是整体PASS。
- docs/browser-next-milestones.md、semantic-evaluation.md、basic-kinds-wiring.md；B1首轮T1/T2有效完成但反例未修，报告更正已关闭，能力仍INCOMPLETE。两候选未采用。
- 外置`/Volumes/Intel/playground/nnanything-runs/browser-focus-repair-20261022/`的delivery、三份diagnostic和父收口记录；不重开已关闭报告finding。
- 新构造`/Volumes/Intel/playground/nnanything-runs/browser-focus-human-20261022/`的delivery、parent-acceptance、measurement-contract、fixture、driver、out/capture-human.json及signature-comparison。native点击在新页面重复得到af=1/fc=0，与原反例81wire相等，仍ignore。新数据是探索而非gold或留出。fc测显式非负tabindex，不等于完整Tab可达性；不能把fc=0写成不可聚焦。
- docs/browser-behavior-framework.md、search-page-abstraction.md、browser-feedback-strategy.md、browser-progressive-strategy.md；已有text搜索、原子/F1/F2候选及各自已知限制保持原样，不冒称全域训练。
- 通用反馈修订沿docs/recursive-goal-module.md 4.0、bounded-goal-planning.md 9.1、model-evolution.md 2.2。推理层实际实现状态以最新main为准。

## 依赖与实施增量

| 增量 | 实际动作与唯一owner | 验收及停止条件 |
| --- | --- | --- |
| B-L1 接收基础候选 | 先盘点旧树dirty来源和有效证据；归类已实现、独立函数、未验证及未实现。复用原review，仅审仍影响交付的缺口 | 给可用能力表、准确限制与可合流范围；不批量重训，不以F18作者完成代整体批准 |
| B-Focus 修复焦点误忽略 | 先独立复核新native构造gold，按家族分区；新探索例只进开发。基于现有wire/门限/objective设计单因素实验，从真实保存初始权重拟合 | 精确反例不再ignore；若要求恢复container就必须实际judged container，unknown/conflict不充通过；独立构造与必需旧能力无回归；不手填权重，不改gold掩盖失败 |
| B-Input 一次写入与观察 | 复用领域operation与action-observation。先text最小公开consumer，再按现有B2合同补所需编辑形状与状态 | 写入前确认目标/能力，后验读取同一对象实际值；已满足零输入；readonly/disabled、重建、截断和观察失败返回准确；每个扩展先有对应反例 |
| B-Search 组合根闭环 | 复用runBrowserSearchGoal及recursive-goal，训练仅放在输入→对象关联、当前动作和结果关系所需单元 | 输入正确≠搜索完成；提交后必须证明当前查询与结果scope对应，旧结果/空结果/加载中/部分覆盖明确；结果布局变化不改controller |
| B-Feedback 失败与恢复 | 单步通过领域输入观察执行错误/无效果/观察不足，再接新attributeFailure或现有retry/策略接口；不修改core | 执行失败不默认排除全部路线；未知/部分effects不重放；只有当前可信证据支持的限制可接受；有/无/过期/未授权备选的差异可解释 |
| B-Generalize 独立组合与交付 | 基础手工家族、开发探索、未见验证分开；旧A/B及已暴露配方不得重称未见。三站与搜索引擎只读形状用于抽象诊断，不收集隐私 | 保留逐例分母、false-ignore与unknown，人的语义gold及oracle前提可核查；完成范围内适用真实浏览器键鼠consumer、完整milestone独立Review及main交付 |

基础部分不合格只阻塞真实下游；可独立的scope/输入fixture、旧反馈投影审计可并行。不要为了并行另建同职责的模型或数据真源。补特征须证明现有输入无法区分必要配对；拟合不成功不自动说明结构无解。新候选仍not_applied，采用另沿现有演进合同。

## 公开验收与交付

逐步记录当时可得输入、预测/选择、实际dispatch、post观察、根事实、错误及限制来源。未来证据不回填历史输入；未执行次选没有成功标签。观察必须包含执行结果检查，动作不同可以使用不同观察方式。

至少覆盖：原焦点签名与焦点null对照；同对象写入/读回；输入成功但提交无效；提交后旧结果仍在；当前查询空结果；对象重建；执行失败后根已满足；观察失败或effects未知；次选存在/不存在/过期/缺权限。每例绑定真实失败模式与人可观察依据，不重复铺同类测试。合成与真实证据分开，代理信号0命中不称0误判。

输出使用现有docs owner和仓库外run：实现/未实现表、真实拟合与新进程回载、逐例结果、旧回归、独立家族、原始浏览器回执、未解决限制。一个重大完整交付批次作者验收后独立Review整体能力及评价合理性；finding只复核受影响部分。按正常Git合流最新main、push并核远端，清理自有资源，不能停在候选PASS。

## 资源与共享边界

优先接续现有browser-foundation任务域；旧dirty代码先逐项归属并保存有效成果，未经归属不删除。若换树，按Close-Before-Open先收口旧树，不并存同域新旧树。只操作自有fixture标签/服务，已登录Chrome真实入口遵守用户授权和浏览器Skill；不得动账号页、权限或浏览器生命周期。

可修改浏览器adapter、对应filter/node、领域训练、fixture/tests和领域文档；不能修改lib/core、lib/workflow/recursive-goal或CLI。若发现通用缺口，以最小公开复现交父编排者，继续不依赖该缺口的工作。note.md由父owner汇总；域内状态先记自己的外置run，避免两个目标同时写共享笔记。训练权重和原始页面保持本地，不推送。
