# 单次行为最低语义训练：SetExpanded

本轮最小目标是`SetExpanded(regionRef,true)`，阈值固定100。基础行为是一次原生点击；已展开为NOOP，必要观测不足为DEFER，多控制保持歧义。一次点击回执和实际目标达成分别返回。框架背景沿[browser-behavior-framework.md](browser-behavior-framework.md)，目标必要性沿[operation-goal-necessity.md](operation-goal-necessity.md)，本页唯一维护本切片的数值、训练与使用合同。2026-10-20 已实现、真实拟合及回载，候选未采用；独立 Review 与 main 交付状态沿 note.md。

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
