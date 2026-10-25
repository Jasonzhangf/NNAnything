# 最小多选E诊断：peer执行任务书

状态：IN_PROGRESS。Jenny已确认任务板revision 2由David接手，Alice负责复核。此任务交付诊断证据，不交付合格模型。父任务为`l2-four-head-mvp-m1`，目标仍是验证通用MLP驱动有限候选推理的方法，而后再扩充CLI和浏览器。

## 责任与边界

Alice负责设计、分析、Review和下一实验裁定；领域peer负责执行、验证和报告，可按需派GCM一次性worker；Jenny负责最终提交、集成和note.md。禁止启动Astra或绕过Alice自行改变训练方案。peer先通过当前任务板接受本任务，不根据角色或通知自行认领他人代码树。

本阶段只读源码树`/Volumes/Intel/playground/nnanything/l2-four-head-mvp`。该树仍由Alice保留，包含未提交的公共实现。peer不改树、不新建同域代码worktree。诊断脚本和结果写入自有外置run：`/Volumes/Intel/playground/nnanything-runs/l2-multichoice-e-diagnosis-20261024/`。后续若需产品代码变更，Jenny先明确唯一代码owner和标准Git合流方式，不能从多个树手拷源码。

依赖图继续复用`workflows/l2-four-head-step.graph.json`的8N7E责任流与`workflows/recursive-goal.graph.json`的3N2E执行图。拓扑不变，不新建执行循环。根Goal、对象ref、阈值、权限和累计预算不变。

## 已有证据：直接复用

原run为`/Volumes/Intel/playground/nnanything-runs/l2-four-head-mvp-20261024/`。

- `multichoice-plan.md`：本轮已接受的最小规格。
- `multichoice-fit/pre-fit.json`：24个新增TRAIN任务、12个DEV任务及旧样本重放。无verification。
- `multichoice-fit/fit/`：R/D/E阶段权重与回执。R为174/174，D为102/102；E为660/756，240轮用尽；A未拟合。
- `gcm-multichoice-metrics-eval.mjs`、`gcm-multichoice-metrics.json`：公开入口量化、相位混淆、旧R/E逐例比较和A碰撞。
- `multichoice-preflight-tests.log`：21个受控接线测试通过，包括两图、E否决边界及同请求错读恢复。这不是学习成绩。
- `multichoice-dev-diagnostic.json`：包含未拟合A的部分模型轨迹。不得据此评价完整四头模型，更不得用受控替换结果当学生成功。

已确认：E把新增TRAIN和DEV的所有wrongread根/范围行误判为satisfied；两组A碰撞各有48条TRAIN展开行。展示的一对raw偏移不同，A向量却相同。仍未知：当前E拟合失败主要来自数值尺度、样本结构、优化还是其他因素；不能声称预算充分、已数学收敛或MLP不能表达。

## 执行顺序

### E0：核准证据口径

不重跑已有效的训练或采集。核对GCM脚本与报告的直接依据，并在本任务报告作三项更正：

1. A参数比较已由GCM最终报告直接对照`migrated.json`，确认等于迁移后起点；此项已关闭，复用证据，不重复比较。该结论不表示等于迁移前原始旧profile。
2. E每条原始监督行展开为evaluation/selection两行；一个源任务还包含多个状态和谓词，不是每任务只有两行。
3. 只对有监督支持的类别报告F1；无支持类别不记作1。原summary空回归数组保持未评估解释。

保留原报告及修正出处，不覆盖首次结果。发现既有临时副本时只报告明确owner，由原owner处理，不清理他人文件。

### E1：无训练的E→A因果对照

从已知TRAIN选一对wrongread/correctread。使用`E.weight.json`的真实R/D/E预测和现有chain，保存两行完整A输入、raw差异及E logits。先验证真实A向量碰撞。再只在诊断内将wrongread的E标签替换为已确认的unsatisfied，保持其余输入不变，验证A向量是否分离。

该对照只定位信息传递，不训练A，不代表A已经能选择正确动作。数值logits变化本身也不算实际恢复。

随后做真实同入口行为对照：A明确使用受控选择，R/D保留实际权重；分别使用学习E和受控E。受控E只在诊断模式按真实观测范围计算，不进入学生baseline、样本或权重。分别替换evaluation、selection和两者，保留精确事实的单向否决。

验收必须保存原根、首个实际调用、错误回执、后续调用、两个E回调结果与控制终态。使用原`runMultiChoice`和recursive-goal，最多4次原子派发；禁用外置retry、重置预算和改Goal。对照成功只能说明该场景的接线/错误层，不算训练成功率。

### E2：补足诊断范围，不扩训练集

最多12个新诊断任务，使用自有沙盒普通文件。覆盖head/tail、空/短/等长/长文件，重点配对：正确读取、非空错偏移、错误请求长度、EOF外空读。每个正确/错误配对保持原Goal与对象不变；实际调用参数的干预必须另记，不能改根来制造恢复。

这些任务只作已见诊断，不计为新独立验证，不进入本轮TRAIN/DEV分母，不自动成为gold。若当前字段无法区分某对合法相反结果，保存原始回执和相同投影，停止受影响训练设计并交Alice；不能靠标签修补缺字段。

### E3：数值与优化检查

只使用已保存的迁移起点与E阶段参数，不更新权重。检查公开前向与训练前向在失败样本上的一致性；复用已有有效梯度检查。若还缺失败路径的梯度证据，再做最多两对样本的有限差分，报告实际参数、步长、数值与解析方向，不从单个梯度推断必然能收敛。

检查当前字节数除以64后的尺度、布尔mask和新增列初始化是否使失败对的logit差异过小。可以做明确标记的纯数值敏感性对照；不得把非真实投影当OS证据，不修改当前codec，也不通过尝试多种变换挑高分方案。区分“输入可辨”“权重敏感”“梯度有效”“本配方学会”四件事。

### E4：交回单一修正建议

报告只选择一个有证据的下一假设。列明唯一owner、拟改字段或样本族、移除该变化为何仍会失败、能证伪该假设的反例，以及旧知识如何保持。

若证据不足，明确写未定位，不把“加样本”“加轮次”当根因。若拟议修正涉及新字段、连线或目标函数，先由Alice修改唯一设计合同。下一次训练的起点、数据用途、固定预算与停止条件必须在训练前另行写定。本任务不授权新fit，不授权参数搜索。

## 完成与停止

本工单完成标准：E0口径更正、E1实际成对证据、E2具名诊断病例、E3数值结论和E4单一建议均交齐；缺项明确UNVERIFIED并给出具体恢复条件。所有数字区分源任务、监督行和回调展开行。无需重跑无关全量测试。

遇同输入相反合法gold、真实引用/授权缺口、无法确认的oracle前提，停止对应路径，继续独立项。GCM传输故障保留原错，向Alice/Jenny报告，不改模型或换Astra绕过。

交付包括`delivery.md`、可复跑入口、逐例JSON和原始错误证据。Alice审查后将结论与精确文件范围交Jenny。peer不合main、不push、不采用任何权重；Jenny不得将诊断通过扩大成最小多选方法PASS或完整M1/M2通过。当前未完成代码和候选保持保留状态。

本阶段按无代码候选交付，使用现有`collab task deliver --no-candidate --evidence <报告路径> l2-multichoice-e-diagnosis`。外置分析脚本不因此成为产品代码候选；不得为满足默认code交付状态创建无关提交或工作树。
