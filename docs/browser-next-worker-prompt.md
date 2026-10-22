# 浏览器下一阶段首批worker提示词

本提示词只派B1焦点保留与ignore学习修复。B0/B2准备可另给互不冲突的owner，不将整条路线一次开工。阶段总表和完成标准见[browser-next-milestones.md](browser-next-milestones.md)。

---

你负责NNAnything浏览器B1能力修复的实施编排。父编排者保留最终独立Review与集成。你不是唯一工作者，不回退、覆盖他人改动，不碰CLI或他方工作树。

目标：真实拟合得到候选，使actual-focus-candidate-112不再判ignore，并在独立场景及受影响旧能力上验证。须同时分报“不被忽略”的保留约束与confirmed gold的正确分类；unknown/conflict不等于container恢复。不得以全部unknown逃避能力验收。

必读：AGENTS.md、note.md、docs/browser-next-milestones.md §1–4/10–11、docs/basic-kinds-wiring.md、docs/training-workflow.md、docs/model-evolution.md、项目design/training Skills，以及受影响L1/训练图。第7轮四项报告更正已PASS，直接复用，不重审：外置browser-ignore-capability-20261021/parent-r7-four-recheck.md及原始review。能力目标未通过，权重未采用。

职责与授权：先独立Plan，再由执行/观察GCM worker做资料与实验；按当前宿主Skill选择Planner/Reviewer及medium。不使用会话内spawn_agent替代规定路由。Plan、执行、最终Review分离。

工作顺序：

1. 查实际main、browser-foundation候选和资产位置，确认任务树owner；同域沿Close-Before-Open，优先授权复用原树。不在canonical改代码，不覆盖待审候选，不手拷跨树合流。外置run保存过程。
2. 固定已知反例、ignore正例、各受影响类、独立焦点/包装家族，来源先分train/dev/verification。teacher/LLM/human来源如实标注。已经参与诊断或拟合的资料不当未见留出。
3. 校验正式前向、缺测区间、同投影冲突、参数可训练地址、实际梯度与优化更新。null保持[min(w,0),max(w,0)]；历史缺测不能补false；只有确认对象对应才能补测，否则采新样本或保留null。
4. 独立Plan预定每项实验的单因素、预算、成功与失败停止条件，按必要顺序探索语料覆盖、拟合预算、目标函数。失败保留原始轨迹，先归因，不自动加轮直到绿。0.13手调仅诊断，不当真实拟合候选。只有证据表明缺表示才补图/特征，不用硬编码焦点否决旁路。
5. 用公开训练入口和真实Handwired拟合、保存、新进程回载。给逐例fixed/regressed/retained/unresolved/unassessed，分别列保留安全、类别正确性、ignore召回、unknown/conflict及独立来源。
6. 复用旧F04等有效证据；权重变化后补受影响评价。新鲜live报告覆盖和预测变化；无语义gold不得宣称完整假ignore率0。pointerCursor也不能单独决定gold。
7. 作者自检、受影响回归和真实公开consumer通过后，交完整候选供父独立Review一次。未修复时交准确失败、原因和下一步，不自行宣布能力完成。

Owner：观测缺口归browser adapter；输入已有而wire缺口归filters；可辨而参数不合适归训练/profile；scope/当前性与执行错误归现有对应模块。纯观测和固定控制不造NN。不得从本任务扩展任意浏览器行为、整个F1/F2重构或自动采用链。

交付：分支/worktree/run、独立Plan、样本来源/分区、实验配方与停止结果、原始失败、拟合/保存/回载证据、逐例分母、真实consumer、旧能力回归和剩余限制。复跑命令逐行代码块，无秘密。更新项目唯一note和实际领域owner。

按本次父子分工：停在可审查候选，不合main、不push、不部署、不采用权重、不删除待审树。父Review通过后负责集成。预算耗尽、真实权限拒绝或合同冲突只停受影响链并报告，不能降标准、改gold或换来源伪造通过。
