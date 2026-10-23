# 单次行为最低语义训练：SetExpanded

本轮最小目标是`SetExpanded(regionRef,true)`，阈值固定100。基础行为是一次原生点击；已展开为NOOP，必要观测不足为DEFER，多控制保持歧义。一次点击回执和实际目标达成分别返回。框架背景沿[browser-behavior-framework.md](browser-behavior-framework.md)，目标必要性沿[operation-goal-necessity.md](operation-goal-necessity.md)，本页唯一维护本切片的数值、训练与使用合同。2026-10-20 已实现、真实拟合及回载，候选未采用；独立 Review 与 main 交付状态沿 note.md。

本页同时唯一维护 `InputTextValue` 的独立 input-policy 数值设计。该成员当前仅为设计且 BLOCKED，没有 profile、typed 运行入口、样本或权重，也不改变 SetExpanded 的 50 参数或既有证据。

本切片按[统一基本单元](design.md#111-可训练基本单元与组合)组织：逐元素控制关系与当前能力选择是两个成员，单次行为是组合单元。成员使用明确数值 I/O、样本监督和各自参数矩阵；组统一持有 profile、推理 episode、训练 workflow 及使用采集。成员可独立预测与拟合，组合验收还须验证关系预测确实成为能力输入。当前没有跨成员反传，不声称是端到端网络；统一接口约束不表示全仓旧入口已完成迁移。

## 四元素与逐元素职责

Goal为显式绑定区域展开；State为本次有效观测及当前权限；Action为当前技能与对象引用；实际New State决定100/0/null。固定Goal kind/desired/阈值不强造恒定学生wire。未支持Goal显式拒绝，不训练自然语言或递归顺序。

控制按钮、相邻其他控制、区域自身、文字及包装均保序进入关系判断。区域是状态承载者；按钮是候选行为承载者；caption只提供内容，包含/相邻不证明控制关系。disabled控制仍可能有controls关系，但不是当前可执行provider。两个真实provider不能强造唯一标签。缺测不当负例，非provider不改L1 ignore。

输入类型唯一owner为`lib/adapters/browser/single-action-contract.ts`。raw id/class/文案/URL/序号只作绑定或teacher证据，不进入数值特征。绑定引用通过同次DOM明确解析成controls关系；仅将“是否指向Goal”投影给学生。框架拒绝不能替模型换正确对象。

## 学习函数

profile为`browser.single-action-policy.v1`，独立于L1和CLI。关系矩阵2×13与当前能力矩阵3×8，共50参数；一份profile共同管理，不另造必要性网络和对象selector。

关系heads：actionable_provider、not_provider。13wire顺序由合同常量唯一维护：bias，controls known/target，enabled known/value，hit known/value，candidate是否Goal区域，buttonSemantics known/value，以及controls.target与enabled/hit的两项及三项乘积。所有本次元素逐项前向；关键事实缺测或分数平局保留unknown，不把unknown强行标负。

能力heads：CLICK、NOOP、DEFER。8wire为bias、regionExpanded known/value、学生明确provider数量零/一/多、关系覆盖完整、可操作事实覆盖完整。先拟合关系矩阵，冻结其实际预测再生成能力训练输入；禁止teacher provider数直接进入能力头。

Student直接输出当前能力和对象。只有明确单一provider才能构造click调用；多provider报歧义，不按最高分/首项/距离强选。模型raw预测及guard拒绝分别保留。native调用只通过注入的人类输入执行器，不用DOM.click/value/脚本设状态或fetch操作站点。

## InputTextValue 独立成员设计

状态为 BLOCKED，仅为设计，未拟合。Goal为显式绑定的普通单行 text input 当前值精确等于目标字符串，阈值固定100；State为当前值相等事实、有效输入类型、enabled、editable、readOnly、可执行露出与命中事实及各自缺测；Action为学生选择 INPUT、NOOP 或 DEFER，INPUT 的对象与值引用由 harness 机械绑定；New State为执行后重新观测同一逻辑宿主，精确相等为100，不等为0，缺测或无法重绑为null。训练反推从目标相等状态反推当前是否需要输入及前提是否可用，不把对象查找、字符串生成或键盘层序混入当前 head。

建议 profile 身份为 `browser.input-text-policy.v1`，但当前尚未创建或注册。该成员独立于 `browser.single-action-policy.v1`、F1和F2：3个 heads 为 INPUT、NOOP、DEFER，13条有序 wire，单矩阵3×13共39参数。SetExpanded 原子50参数、F1 36参数和F2 20参数均不改变；不增加对象查找、字符串生成、焦点／全选／按键层序或递归调度网络。

| 序号 | wire | 语义 |
| --- | --- | --- |
| 0 | bias | 常量 |
| 1 | valueEqual known | 当前值与目标值的确定性精确比较是否有有效观测 |
| 2 | valueEqual value | known=1 时，比较结果是否为相等 |
| 3 | textType known | effective input type 是否已观测 |
| 4 | textType value | known=1 时，是否为首轮支持的普通 text input |
| 5 | enabled known | enabled 是否有有效观测 |
| 6 | enabled value | known=1 时，宿主是否 enabled |
| 7 | editable known | editable 是否有有效观测 |
| 8 | editable value | known=1 时，宿主是否 editable |
| 9 | readOnly known | readOnly 是否有有效观测 |
| 10 | readOnly value | known=1 时，宿主是否 readOnly |
| 11 | executableHit known | 可执行露出区域与命中事实是否完整 |
| 12 | executableHit value | known=1 时，露出与命中是否允许执行 |

每个 known/value 是配对位。负责状态未知时 known=0；配对 value 位只作为该未知状态的占位，不能解释为观测到 false，也不能把缺测写成未禁用、非只读、可编辑或已命中。相等事实由确定性字符串比较产生，目标字符串、Goal kind、阈值和对象引用不作为学生数值输入。

head 语义如下：已观测相等对应 NOOP；已观测不等且类型、enabled、editable、readOnly、露出和命中均支持执行对应 INPUT；已观测不等但任一必要事实缺测或不可用时对应 DEFER。边界 guard 仍须复核 current-control、类型、授权和可执行前提。guard 可以拒绝非法 INPUT，但不得替模型改选 NOOP/DEFER；raw head、scores、features 与 guard 错误分别记录，不用规则 fallback 掩盖错选。

能抓错的最小反例为：同一状态只把 `valueEqual` 从 false 改为 true，正确 head 从 INPUT 变为 NOOP；只把 `valueEqual known` 改为未知，正确 head 从 INPUT 变为 DEFER；只把 enabled、readOnly、可执行命中或 effective text type 之一改为不可用，正确 head 从 INPUT 变为 DEFER；同一页面状态只把目标值从当前值改为另一字符串，正确 head 在 NOOP 与 INPUT 间变化。若不同正确 head 仍得到相同许可输入，先修观测或 wire，不增加 epoch。

来源分区复用单次行为合同规模：3个 train family、1个 development family，各10 episode；另2个 verification family，各10 episode。先按页面家族、fixture 实现及关联 episode 分区，再生成投影；同源变体不得跨区，独立集不进入 fitter。覆盖空值、非空替换、目标空串、已相等、各单项缺测或不可用，以及目标变化引起 head 变化的配对例。真实 DOM／原生效果与 synthetic projection 分开记录；teacher 标签来源必须明确，使用记录不自动成为黄金。

解除训练阻塞后，固定全零初始化、200 epoch、学习率0.1，使用真实 Handwired 前向／反传；不搜索超参、不静默延长。记录梯度、参数更新、错例和实际耗时；未达 dev 要求即保留失败并先查可辨性。候选保持 `uncalibrated/not_applied`。当前没有样本、profile 或权重，以上只为固定设计预算。

保存候选后必须由新进程显式加载 profile，并经公开 consumer 重跑；坏 profile 或缺 Handwired 源码根须显式失败。同一入口比较零权重、规则对照与拟合候选；规则只作对照，不作为 head fallback。训练图可复用既有 6N6E 形状及执行基座，但领域绑定尚待设计并校验；既有 SetExpanded 训练绑定不支持 InputTextValue，不能据其历史回载宣称 input 已可训练。

独立原生验收沿用 operation 合同的 I1-I10，并要求两个独立 family 产生真实原生键盘效果。必须核对同宿主值精确相等、邻字段不变、NOOP 零输入、缺测/失效零输入、raw 错选不被 guard 修正成假成功、已派发后验错误不报成功、部分 effects 不丢失。合成 receipt 只能验证映射，不能替代真实原生输入；独立材料若用于修订，转为回归资料。字段、原生文字执行器和训练域绑定未闭合前不启动训练。

## 观测与真实验收

最小adapter在顶层显式scope中读取所有元素、目标区域、原生button或role语义、aria-controls解析、enabled、真实命中与L1回执。Goal区域即使折叠不可见也保留。声明关系不等于真实效果；展开前后分别读region呈现与控制端状态，冲突或无证据为unknown。观测只读，应用自身响应真实点击的正常事件处理不算执行器旁路。

公开episode复用现有operation-episode的7N6E图及Flowed runner，scoped registry只支持本目标，图的通用design状态不改。引用绑定document/observation/revision；派发前核对显式currentControl和授权，过期零输入。几何point为内容视口CSS像素，本会话原生tab.click坐标由后端完成视口映射，已在同页能力探针实测；不外推其他后端。

NOOP须有有效真实展开证据且零输入。输入成功但后验仍折叠为0；展开且同一目标/必要条件成立为100；缺后验或冲突为null。回执、effects、原错误、collection错误分开保留，后验失败不清除已派发动作。使用时collect是显式资源并本地记录，自动进化仍沿[model-evolution.md](model-evolution.md)，本轮不自动采用。

## 流程和训练预算

训练图为`browser-single-action-training.graph.json`，6N6E：准备→按family分区→拟合→比较→评价→保存报告，分区另有到比较的边。领域schema与fitter不同于L1，因此独立operator身份；复用现有compiler/runner/Handwired loader，不新增引擎。

3个train family、1个development family，各10episode。另2个verification family由独立owner保留，不传给fitter。实际DOM观测/原生episode和synthetic_projection分别记录，合成属性反例不得冒充真实effect监督。由teacher源码得到的标签要显式标来源；没有实际复核不能写成human/LLM已审核。

固定全零初始化，关系200epoch、能力200epoch，学习率0.1。真实Handwired前向/反传产生梯度；显式源码根，缺失报错。无超参搜索或静默延长。预算未达dev要求保留失败、梯度与错例，先查可辨性再作有证据的修订。时间记录backend/circuit/各拟合/保存/回载/评价，行数与row-epochs按实际计数。

对照为同一正式入口的零权重冻结、手写规则（仅比较，不fallback）、真实拟合候选。检查参数更新、真实非零梯度与差分接线、新进程回载一致，以及目标互换/disabled/已展开/邻控制等离散选择。独立资料若用于修订模型就转为回归，不继续冒称未见。候选保持uncalibrated/not_applied，不触碰当前L1或CLI权重。

## 公开入口及交付准入

公共subpath为`nnanything/browser-single-action`；入口createBrowserSingleActionPolicy、runBrowserSingleActionEpisode、runBrowserSingleActionTraining。train/reload/step consumer位于`playground/browser/single-action/`，显式给profile、数据及源码根，不静默fallback。

至少验证目标互换、顺序不变性、模型错选不被修正、过期零输入、后验折叠不报成功，以及坏profile/缺Handwired显式失败。独立真实原生验收覆盖两个family、邻控制、已展开、disabled、多控制、缺测、stale和点击无效果；已发动作次数与邻区域副作用分别核对。纯合成consumer不能替代CUA原生effect验证。

图/gate/红测先于对应实现。作者完成公开consumer、真实拟合、保存回载、独立评价及原生验证后进行一次整体Review，再正常集成main、push并清理自有资源。当前任务进度和证据由note.md单一汇总。

## 本轮结果与适用边界

证据目录为 `/Volumes/Intel/playground/nnanything-runs/browser-semantic-single-action-20261020`。训练输入 `train-dev-cases.json` 共40个episode：30训练、10开发，其中1个来自实际DOM观测与原生点击，39个明确为合成投影。teacher标签由作者按事实复核，不声称独立人工标注。另由独立worker提供20个verification，未送入fitter。首次verification因scope引用缺失被schema拒绝；修正输入结构后，新进程回载20/20，模型与权重未改。

固定200+200 epoch、50参数的真实拟合用时415.69ms，含后端加载308.73ms；关系拟合82.84ms、能力拟合19.98ms。112个有效关系行与30个能力行，共28400 row-epochs；213个未知关系行跳过监督。候选训练30/30、开发10/10；零权重0/30、0/10，规则对照27/30、9/10。对照结果只覆盖本次样本，不外推任意网站或完整手写策略。候选位于 `fitted/candidate.json`，原始报告 `fullyVerified:false` 表示拟合时未注入独立集；后续独立回载报告单独保留，不改写历史报告。

真实Chrome夹具验收覆盖原生button、带SVG/文字的role按钮、目标互换、相邻包装、已展开、disabled、多provider、关系缺测、过期、输入无效果。共11个场景，5次真实输入：4次目标达到100、1次点击无效果返回0；已展开NOOP返回100，其他不满足前提者零输入并保留错误。role按钮未声明可用状态的原始案例返回unknown/DEFER，作为观测缺口保留；另一个显式`aria-disabled=false`的role夹具成功，未修改原例或训练权重。仅验证显式scope与controls的受控页面，不声称学会凭caption推断任意按钮用途。

观测引用当前性对NOOP同样生效，后验不得改绑document/scope。原生回调抛错时派发与effects保留unknown；成功输入不代表Goal成功。DEFER保留raw head并返回观测不足、歧义、前提不满足、缺能力或policy_deferred。DEFER的满足度目前为null，不凭未执行操作推断实际达成。使用采集本地保存，自动升级仍未接入。

作者测试41/41，完整回归860/860且零skip。首次全量因隔离树缺少扩展构建产物失败，补正式构建后通过；未改断言或旧L1/CLI权重。完整独立Review及集成回执随后由note.md记录。

整体独立Review发现后验当前性、透明输入拦截、fieldset继承禁用三项问题。已新增红测并修复：后验必须更新且匹配currentControl；可执行点须由最上层目标或后代接收；原生禁用沿`:disabled`测量并保留legend例外。修复后48/48浏览器测试、867/867全量零skip；透明拦截与fieldset实页零输入，legend实页原生点击后达100。原模型、wire与权重未改。此增量仅修基础事实，不宣称已经训练“失败后重试/次选”。

### 2026-10-22 展开域失败反馈与安全有界恢复验收

失败反馈 F1 与策略 F2 的展开域验收复用本切片的原子公开入口和真实原生点击，不改变 50 参数或既有证据。`playground/browser/feedback/accept-expanded.mjs` 对 17 个固定实例在两个独立页面家族各跑一次，共 34 条轨迹；每段独立新进程，只走 CDP 原生鼠标事件，不脚本写值或 `.click()`，故障注入标注 `injected:`。续段报告回放历史原子结果，runner 按 `dispatchId` 去重；目标达成记录 `goal_achieved`。安全恢复仍沿既有最窄合同：succeeded、无执行/验证错误、明确 unsatisfied、effects 证明 none、权限与绑定有效、F1 预测 `completed_without_goal`、`assessRetry` 同类失败且预算有余量；拒绝、异常、派发不确定、effects unknown 或观察无效一律停止。真实浏览器轨迹由父编排者在宿主 shell 执行，本仓库内只跑构建与单元测试。
