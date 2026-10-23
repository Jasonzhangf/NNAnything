# 浏览器下一阶段：能力milestone与验证路线

日期：2026-10-22。状态：阶段规划；本轮不实现、不采集、不训练、不采用。范围是现有浏览器方向的增量推进，不启动computer use或CLI扩展。

## 0. 本轮可直接派发的工单（优先于后文路线概述）

用户指出上一版“没有可落地的操作，需要更具体”。以下固定第一批的资料、修改位置、实验预算、用例和交付；后文B0–B6是路线索引，不是可直接执行的派单。当前只准备这些工单，不由本次文档编辑启动实施。

### 工单A：焦点反例修复，一次完整milestone

输入位置（实施者开工时核对存在，不猜资产路径）：

- 420行原始语料：`/Volumes/extension/code/NNAnything/training/samples/three-site-zero/wrapper-increment-request.json`。
- 当前待修候选：`/Volumes/Intel/playground/nnanything/browser-foundation/training/weights/dom-basic-kinds/ignore-capability-20261021.weight.json`。
- 已知反例sampleId：`actual-focus-native:actual-focus-candidate-112`，原gold=container；不得重标。
- 原训练起点脚本：`/Volumes/Intel/playground/nnanything-runs/browser-ignore-capability-20261021/fit-sweep.mjs`。它默认从DEFAULT profile起步，不能直接拿来冒称从当前候选增量拟合，需显式改为加载指定文件的任务consumer。
- 已有验收入口：候选树的`playground/browser/f04-live-gold.mjs`和`reobserve-compare.mjs`；前者支持输出路径和`--weight`，后者先读取实际CLI参数再使用，不凭注释猜参数。
- 原r7资料：`/tmp/ignore-fit-r7/training/`可能被系统清理；只是历史证据，先归档可用部分，不让新任务依赖/tmp长期存在。

| 工单 | 谁做/改哪里 | 执行操作 | 必交结果与结束条件 |
| --- | --- | --- | --- |
| A0 当前反例复现 | 执行者；新增`playground/browser/focus-ignore/evaluate.mjs`，算法不改 | 从显式文件读当前候选；用公开classifyBasicKind/extractBasicKindWires跑420行；按sampleId找反例；输出类型/status、两个焦点wire、三wrapper、container/ignore区间和margin；保存每条ignore是否召回 | 外置run的baseline.json及baseline-rows.jsonl；必须实际复现反例ignore；否则先报告输入/版本偏差，不继续训练 |
| A1 实际DOM对照A | 执行者；`playground/browser/focus-ignore/fixture-a.html`与`capture.mjs` | 构造6种无自身独立内容的包装（子对象为button、svg、image、link、文本span、含一层额外包装的button），每种3状态；用真实adapter采集、键鼠切焦点，保存每步实际测量 | 计划18状态，缺陷三wrapper签名至少有一个实测复现；不满足构造前提的场景不能算通过，要修fixture或报告缺口 |
| A2 独立实现B | 另一独立GCM执行者，仅负责`fixture-b.html`、对应oracle与capture | 按同一6类×3状态要求重新实现DOM/CSS，不能读A实现或复制改名；先交期望/前提，再测候选。B不得进入fit或超参选择 | 计划18状态，含独立复杂包装与焦点组合；保存独立来源。只收到共同语义合同和生产adapter，不给A代码/构造器；不得依据候选预测改gold |
| A3 真实拟合最多两次 | 训练执行者；`playground/browser/focus-ignore/train.mjs`，复用公开training workflow | 执行下述T1/T2；从指定候选读profile，引用实际train/dev分区；只开放既有ignore支撑wire及两焦点wire，不改算法/标签/区间 | 两个独立输出目录、实际配置/计时/停止原因、保存候选；失败也交。不得边看B边调参 |
| A4 回载与真实验收 | 独立执行者；新增`reload.mjs`/`accept.mjs`，复用已有F04/live compare | 用train/dev选定一个候选后，启动新进程回载；首次评价B；重跑受影响F04；四份已知live离线同输入对照；逐例检查旧有效能力变化 | acceptance.json和逐例差异。B失败则本milestone未通过，不把B加入本轮再训练；新的实验须另记分区与停止条件 |
| A5 作者收口 | 原目标owner | 更新实际领域合同/代码入口说明/note；做受影响build与测试，整理完整候选 | delivery.md：反例保留约束、正确分类、独立评价、回归分别PASS/FAIL；父独立Review后才集成，不自称最终PASS |

三状态的gold前提必须如下，不能把“失去当前焦点”误标成ignore：

| 状态 | 实际刺激与观测 | 包装期望 |
| --- | --- | --- |
| S1 实际聚焦且可键盘聚焦 | 通过正常键鼠进入包装焦点，读回activeElementFocus=true与tabIndexFocus=true | container、不得ignore |
| S2 可键盘聚焦但当前未聚焦 | 焦点移至自有其他控件，保留包装tabIndex，读回active=false、tabIndexFocus=true | container、不得ignore |
| S3 无焦点能力的冗余包装 | 独立fixture配置移除包装可聚焦属性且无独立读取/交互/状态价值；读回两焦点事实false | ignore；子对象继续保留且分类不被父级覆盖 |

S3不是把旧观测字段改成false；它是新页面状态，必须实测。fixture可声明正常HTML初态/控件，操作时用原生键鼠，不用JS focus/click作为行为验收。额外的null输入对照另作明确的“缺测投影测试”，不得算真实测量。6×3×2=36只是计划状态数，不是已取得样本数，也不足以证明任意页面泛化。

T1/T2的固定配方：

1. 基线A0不拟合。从当前候选显式起步，原420行及新A资料按来源组准备train/dev；保持原资料既有分区与group完整，A的同构/连续状态不跨train/dev。B独立存文件，不送fitter。prepare产物逐行登记用途，若现有partition入口不能表达，先交最小适配设计，不通过改seed反复找好分区。
2. T1：200 epoch，lr=0.02，anchorLambda=0.001，保持现有family_leaf_v1及其兼容目标；开放原ignore支撑wire集合加neutral_actual_focus、neutral_focusable_control，阈值minScore=0.6、minMargin=0.15不变。trainableWires是跨地址配置，必须输出实际可训练地址清单，不能声称只改container一个参数。
3. T2仅在T1于train/dev未满足声明目标时执行：仍从同一初始候选起步，数据、分区、lr、anchor、wire和objective都与T1相同，只把epoch改为2000。预算×10是一次明确的预算假设检验，不保证成功，不在本轮继续第三次fit。
4. 候选选择只看train/dev：先满足保留约束/正确分类及必要回归，再取预算更小者；不得通过aggregate分数掩盖具体回归。选定后才交A4查看B。如果T1/T2都失败，停止并交梯度/端点/逐例诊断，目标函数改动另行设计，不能自动切objective或手填0.13。

必须由独立Plan先核对上述数值及现有配置兼容性；这是本批建议固定预算，不是旧r7配方的已验证复现。发现配方/接口不兼容时写明具体字段与最小修订，不能静默换起点。

A4必须逐项返回以下结果，不用一个“准确率”覆盖：

- 原反例是否judged:container；若仅不再ignore但仍unknown/conflict，记部分修复。
- 独立B中满足oracle前提的S1/S2全部不得ignore，并检查是否为正确container；S3必须仍能识别ignore。任何未测/不成立场景单列，不能剔除后宣称18/18。
- 原420行按相同样本与用途列fixed/regressed/retained/unresolved。保留基线每条已正确ignore及已正确保留类，禁止用总数补偿丢掉某条；无法沿旧输入评价的项保留具体限制，不能补测量。
- F04的ignore/audio/video各4例在新候选仍满足gold；已知live只报预测变化及所列代理检查，不能声称全语义误判率0。
- 同一输入保存前后及新进程加载结果一致；坏文件显式失败；候选维持uncalibrated/not_applied。

所有新入口目前待实现。建议命令接口在实现中固定如下，实际复跑回执必须提供无占位符版本：

```sh
# 在经授权复用的候选工作树内；这是工单约定，以下focus-ignore脚本尚未实现。
node playground/browser/focus-ignore/evaluate.mjs --request /absolute/dataset.json --weight /absolute/current.weight.json --out /absolute/run/baseline.json
node playground/browser/focus-ignore/train.mjs --request /absolute/prepared-request.json --weight /absolute/current.weight.json --recipe /absolute/t1.json --out /absolute/run/t1
node playground/browser/focus-ignore/accept.mjs --weight /absolute/selected.weight.json --verification /absolute/family-b.json --out /absolute/run/acceptance.json
```

外置run建议`/Volumes/Intel/playground/nnanything-runs/browser-focus-repair-20261022/`。资料沿现有training目录或明确外置证据，不新建根目录。A0可先做；A1/A2在合同给定后并行；A3必须等资料/分区准备；A4等候选选定。执行者不读B的未公开gold来选择配方。

### 工单B：现有浏览器候选集成准备，与A分开

交给集成owner：读`browser-foundation`相对最新main的diff、最终finding复核和F18剩余项；产出一张具体文件/API/证据/未完成项表`integration-scope.md`，注明哪些已审变化可交付、哪些是未合格权重/实验，不把历史阶段笔记当最新结论。真实组合main产生的新差异才补测试。当前ignore候选不能默认采用。无新功能实现，不重新审已关闭finding；实际完整候选达到集成准入后由父完成Git合流与资源清理。没有独立可拆边界就保留原树，不能手拷文件拼装。

### 工单C：单次输入验收，只做六个明确行为

A的资料/训练不占用输入模块owner。另一个worker复用现有`playground/browser/search/run.mjs`及`runBrowserSearchGoal`，先只准备输入阶段公开consumer。改动限`playground/browser/search/`、相应tests及确有缺口的现有输入/后验owner，不新写搜索runner，不训练新模型。

实现一个自有HTML：左侧“搜索”普通text input，右侧“备注”普通text input，独立提交按钮与结果区。请求显式绑定左侧对象；用真实键鼠输入，正常模式以原生input.value只读观察。六个case：

1. 正常写入：左侧读回精确query，右侧原值不变；只有读回通过才允许提交。
2. placeholder等于query、value为空：必须实际输入，不能NOOP。
3. input事件后页面重置左侧值：报告未达标，不提交。
4. 左侧readonly：零输入派发，准确拒绝；不能改填右侧。
5. 已派发后执行器抛错：仍安全读回；分别保留执行错误与真实值，不因值已变清除错误。
6. 读回失败：unknown并保留观察错误，零后续提交。

每例记录真实输入/提交次数、前后值、目标身份、原错误、根/子结果；fixture无用户内容，测试后清理自有标签/服务。产出`input-six-cases.json`与逐例原始回执。六例通过才把页面实现B和对象自动选择学习排进下一批；本工单只证明显式绑定下执行/观察，不能报模型学会挑选输入框。

当前先派A与B/C的互斥准备，不启动B3–B6。完整交付仍沿本页末尾及项目既有Review/Git规则。

## 1. 起点与总目标

总目标：在固定语义合同下，让不同页面样本经过基础识别、当前对象/动作选择、真实人类操作和后验观察，递归满足根Goal；失败可准确返回，并在具备安全前提时学习恢复。固定合同不等于固定页面、布局或元素编号。

当前可复用的基础与限制：

| 层 | 已有依据 | 本阶段不得越过的结论 |
| --- | --- | --- |
| 第一层分类与观测 | 分类/训练入口已交付；browser-foundation有基础事实、scope、比较及修复候选 | 分支候选不等于main交付；F00–F18不能一概写完成 |
| ignore增量 | F04受控ignore/audio/video各4/4；live预测与代理检查有证据；第7轮四项报告更正已独立复核通过 | 焦点反例仍判ignore；全语义假ignore率未评估；候选未采用 |
| 原子行为 | SetExpanded及普通text输入搜索切片有真实后验，逐步观察义务已接入 | 不是任意点击/输入，也未证明textarea/contenteditable、分页、下载等已接入 |
| 反馈F1与策略F2 | 有真实拟合、回载和限定展开域行为；回执三态9参数实验已交付 | 旧F1有R5未见投影失败；9参数成员正确不修复整个F1；F2不自动泛化为搜索策略 |
| 搜索与递归 | 现有普通text搜索runner、参数化HTML、recursive-goal及有界规划可复用 | 显式绑定/handwired起点不等于已训练对象绑定、查询归属或任意网页搜索 |

证据入口：`/Volumes/Intel/playground/nnanything-runs/browser-foundation-20261021/f18-delivery.md`及原Review/定点修复；`browser-ignore-capability-20261021/parent-r7-four-recheck.md`；[反馈合同](browser-feedback-strategy.md)；[搜索抽象](search-page-abstraction.md)。候选历史报告有多个时点，实施前只核对影响本批的最终结论，不能恢复已撤回口径。

## 2. 优先级与依赖

| milestone | 要证明的能力 | 当前状态 | 依赖 |
| --- | --- | --- | --- |
| B0 基础候选交付边界收束 | 已修观测/关系能力有明确可用入口、限制及main交付状态 | 待执行集成准备；不重新开启已关闭finding | 已有候选与有效Review |
| B1 焦点保留与ignore学习 | 真实拟合能消除已知焦点误忽略，并在独立组合和旧能力上成立 | 首轮已执行：T1/T2两次有效拟合均未翻转反例，`B1 INCOMPLETE`；无合格候选、B未解封、未采用。证据见外置run `browser-focus-repair-20261022/delivery.md`；剩余缺口与owner见§4末 | 可复用当前独占候选与分类/训练入口；不必等B0全部合main |
| B2 单次写入与读取反馈 | 选对当前编辑对象，输入后能观察并判定真实结果 | 现有text切片可复用，扩展/学习待验证 | 本批所用观测和目标保留合格；不要求整个L1全部完成 |
| B3 最小搜索根目标闭环 | 写入、提交、当前查询结果关联能反向满足根Goal | 已有handwired runner起点，学习与变化样本验收未完成 | B2及必需scope/当前性能力 |
| B4 失败解释与合法恢复 | 学会无效果/拒绝/未知的区别，并选择允许的重试或次选 | F1已有已知缺口，搜索恢复未验收 | 先修复/验证反馈基础；恢复行为依赖B2/B3 |
| B5 新结果表示与范围扩展 | 同一语义在未见结构、分页/加载和重建后仍有正确归属与覆盖 | 后续，按一个新能力逐批推进 | B3；需要恢复时接B4 |
| B6 使用样本与单元升级 | 失败与成功可追踪入池，候选隔离训练/回载/评价、热重载及按规则采用 | 全链未实现，不属于当前首批 | 至少一个稳定的实际使用闭环；沿既有model-evolution合同 |

近期只把B0/B1/B2展开为可排期实施。B3–B6是有验收边界的路线，不是本轮全部开工清单。B1、旧F1的独立样本准备、B2观测/fixture准备可在owner不冲突时并行；共享basic-kinds训练owner、live-dom或同一profile不能并行写入。每次只给依赖满足的任务分配资源。

## 3. B0：先分清代码交付、能力验收与权重采用

工作：依据最终修复记录，汇总browser-foundation中已实现、已独立复核、仍partial/UNVERIFIED及仅设计的项目；核对与最新main的实际差异和受影响公开入口。复用已关闭finding及有效黑盒证据，只有组合main产生新差异才补受影响验证。原10项finding的修复复核和ignore报告更正，均不能扩大为整个基础层完成。

交付：可用基础API与声明边界、相关build/真实consumer、main集成/远端回执和资源状态。可交付已合格基础代码与如实的失败报告；不把有已知焦点失败的ignore权重作为已合格权重采用。具体可拆分边界由实际diff决定，不机械拆文件/复制跨worktree成果。

必须保留：currentView焦点投影、离视口foreground标签、iframe/shadow及真实站点gold等限制，按实际当前实现核对；某能力影响本批消费时修复或准确阻塞，不能仅因历史存在就无限扩展。不得再索取已获范围内集成授权；冲突/CI失败按交付合同停止受影响集成。

## 4. B1：真实拟合修复焦点误忽略

四元素：Goal为取得满足“独立交互/读取/状态目标保留”的基础分类；阈值用于已确认样本的二元达标；State为真实测量与显式profile；Action为分类及隔离训练候选。真实New State是保存后公开分类器的逐例结果，不是loss或手填参数。

要分两个验收：保留安全性（必须不是ignore）；分类可用性（已确认gold应正确且状态可用）。将反例改为unknown/conflict只通过前者，不能宣称已恢复container，也不能靠所有样本unknown通过本milestone。

探索顺序：

1. 固定原焦点反例、已有ignore正例与其他类回归、焦点/无焦点包装对照。独立来源家族先划分，再生成/采集；已看过的live和诊断行只作开发/回归，不重新冒称盲测。
2. 检查现有特征能否区分目标，重算正式前向、缺测区间、实际梯度/更新方向。语义null保留区间；0.13手调对照仅证明表示可能可用，不是拟合成功。
3. 按独立Plan一次只验证一个假设：现配方预算是否不足；焦点覆盖补足是否有效；目标函数是否对实际分类约束给足梯度。训练前固定该实验预算和停止条件，失败后先分析，不自动加轮直到绿。
4. 补测只针对能确认身份的对象，或新采有来源样本；旧行无法配对则保持null。不得从“verified ignore”标签反推无焦点。样本gold与实际缺测事实分别保留。
5. 真实Handwired拟合、保存、新进程回载，公开分类器评价；操作/纯规则不能替代学生预测。失败候选与轨迹保留。

测试族：实际焦点开/关；可聚焦但未聚焦；三wrapper组合及不同DOM实现；有独立文字/图形/输入/按钮/滚动价值的保留对象；相同尺寸但有/无独立价值的包装；测量null/false/true；无关内容、兄弟顺序及布局改变。自身语义变化应按gold改变结果，无关变化不应改变语义判断。

完成标准：

- 已知反例不再判ignore，且该行confirmed gold的分类要求单独说明是否满足；未满足分类可用性则只报告部分改善。
- 独立焦点与包装家族的已确认gold在声明域通过，既有F04三类4/4受控证据与受影响基础类无必需回归；有效ignore不能靠全改unknown“保护”。
- 按相同逐例集对照候选与基线，列false-ignore、ignore召回、保留类准确性、unknown/conflict和unassessed；149/162仅历史有限口径，不能取代新分区评价。
- 新鲜live先报告覆盖与预测变化；若声称语义误判率，必须给相应gold及分母。代理信号0命中不等于0误判，pointerCursor也不直接决定gold。
- 保存/回载一致、坏源显式失败。独立Reviewer核oracle与根语义；通过后按既有采用规则评估，不因本计划默认采用。

### 4.1 首轮执行结论（2026-10-22，B1 INCOMPLETE）

A0–A3 已实际执行，A4 未解封：T1（200 epoch）与 T2（2000 epoch，重读同一初始权重）两次真实拟合均有效完成，反例 `actual-focus-native:actual-focus-candidate-112` 仍判 `judged:ignore`（score 0.864008 → 0.895949 / 0.871745），无合格候选。原 420 行 `regressed=0`、ignore 召回 149/162→157/162；A 家族 18/18 正确；初始权重下 18 行 A 的 loss 均非零、对 `container.neutral_actual_focus` 聚合梯度 −1.70715（分类正确不等于零梯度；T1/T2 下该组为 12 行非零 loss）。两候选 `uncalibrated/not_applied`，未合 main。证据唯一入口：外置 run `browser-focus-repair-20261022/delivery.md`；独立 Review 结论在 `review/conclusion.md`；父定点复核在 `parent-failure-delivery-review.md`；三组只读诊断在 `train/diagnostic-full.json`（初始）、`diagnostic-t1.json`、`diagnostic-t2.json`。

已验证事实与待验证推断（不能把推断写成根因）：

| 项 | 性质 | 事实 | owner |
| --- | --- | --- | --- |
| 构造覆盖 | 已证实 | A/B 三状态为 (`af=1,fc=1`)/(`af=0,fc=1`)/(`af=0,fc=0`)，不含反例的 `af=1,fc=0`（实际聚焦但不可键盘聚焦） | fixture 构造 + `lib/adapters/browser/` 观测前提 |
| 端点约束 | 已证实 | 反例 ignore=0.864008、container 上限 1.0，最大可得 margin=0.13599<0.15，仅抬 container 不可能翻成 container | 算法门限（minMargin 0.15） |
| 参数权衡 | 已观测，不构成收敛或预算结论 | T1 终态 `container.af=0.00568` 下 243 条原 train 聚合梯度 +1.64471（T2 终态 0.00069 处 +1.52624），分桶 `list|af=null`（T1 +2.3250 / T2 +2.2152）与 `container|af=1`（−0.6802 / −0.6889）方向相反；两次均 `epoch_limit` 停止，收敛性/预算是否足够/是否必须改目标或阈值均未确认。两参数诊断 `container.af=0.28, ignore.af=-0.15` 翻反例但 21 条旧 ignore 退回 unknown（train 19、eval 2） | 训练/profile，须另开有分区与预算的新实验计划 |
| "现有 wire 必然无解" | 未证实 | 只穷举固定配方与一组两参数诊断 | — |

下一轮不得第三次重跑本配方、不改 gold、不手填 0.13；B 已在本轮使用过，后续不得称未见。

失败报告已完成两次独立定点复核并收口（`parent-failure-delivery-closure.md`）：原 6 项 finding 全部关闭。该收口只关闭失败报告的证据与表述问题，不关闭焦点能力缺口，不构成 browser-foundation 整体 Review PASS，也不批准分区基础代码集成。下一步先补 `af=1,fc=0` 的真实人类鼠标/键盘构造，证明该状态能真实产生且生产 adapter 如实观测（缺测保持 null，不补 false），再纳入有明确分区与预算的拟合实验；现有证据不足以决定是否加 wire、改 objective 或降 minMargin。该实验尚未启动。

## 5. B2：一次写入，确认写到了正确对象

2026-10-22 后续起点：真实焦点构造已由父级接收，native `tabindex=-1`容器经CDP原生点击及新页面重复，15条状态检查通过，5条focused为af=1/fc=0；81wire与精确反例相等，仍ignore0.864008。fc只表示中性容器显式非负tabindex，不能解释成完整键盘可达性或可聚焦能力。探索数据未标gold、未拟合，B1能力仍未完成。证据沿外置browser-focus-human-20261022/parent-acceptance.md；下一完整域任务沿[browser-next-longhorizon.md](browser-next-longhorizon.md)，不是再重跑原T1/T2。上文“尚未启动”是该次失败报告收口时点的历史状态。

四元素：Goal为指定scope内的已确认编辑对象显示目标文本；threshold100；State为当前对象身份、可编辑事实、当前值与观测版本；Action为一次当前输入行为及其必要读回。已经达标可以零输入，但this_run观察义务不能省。

先保留普通text输入的显式绑定最小consumer，验证低层操作与观察，再独立训练“当前Goal条件→合适对象/能力provider”的关系选择。只在出现需学习的关系时训练，不训练精确字符串相等、权限或层序。原有展开原子50参数不可直接当输入模型。对象关系保持Goal相关，不能污染L1类别或ignore标签。

必测：相邻两个输入框用途不同；placeholder等于目标但value不同；输入被页面重置；disabled/readonly/native与ARIA不同；同文案不同对象；DOM重建；输入报错但值已改变；读回失败；实际值未变；缺权限；密码/不支持的敏感宿主拒绝。非目标输入值不变，执行与观察错误分开返回。仅通过人类输入操作写入，JS只读观测不得替代输入。

完成标准：新进程公开入口在两种独立页面实现上，对已确认目标执行正确并从真实读回判定；不触碰相邻对象；缺观察不能继续提交。失败、未知与实际达标准确返回。普通text通过后，textarea/search/contenteditable每次新增一种，先补合同和单次实验，不一次宣称全部编辑宿主支持。

2026-10-22 B-Input 实施切片：`nnanything/browser-input` 公开入口、7N6E 独立绑定（`workflows/browser-input.workflow.json`）、CDP 原生 IO 和家族 A/B 各 26 例材料已就位；确定性合同测试 18 项与搜索回归一起绿。真实浏览器 52 例已在独立 headless Chrome（端口 9444、独立 user-data-dir，不占用使用者日常浏览器）按逐例契约跑通 52/52，分布 S=10、N=22、U=20、拒绝=32、执行错误=34、观察错误=6。真实路径此前不可用，本轮复验定位并修正三处缺陷（绑定 ref 映射、macOS 原生全选、派发前后验门禁），逐例材料见 run 目录 `b-input/acceptance`。B3 搜索组合继续按本路线执行。

## 6. B3：最小搜索组合，不把输入成功当搜索成功

沿用`runBrowserSearchGoal`及已有fixture；先在已绑定scope内做查询写入→读回→提交→结果观察。根Goal保留，原子子Goal成功不自动使父成功。对象绑定的学习验收与显式绑定的执行验收分别报告。

要证明的关系：draft、submitted、resultsFor分别可辨；请求/显示/访问状态分别观测；结果属于本次查询和正确集合。提交控制不能只凭yes/no或caption决定效果，必须结合关系与真实后验。固定流程复用，变化样本不通过站点分支处理。

必测：旧placeholder、新value；同词旧结果；A慢B快与迟到A；加载后空/错误/登录阻断；已输入未提交；建议词替换输入；当前结果尚未更新；旁栏/AI栏与主集合并存。仅导航标题或URL变化不能证明结果满足。登录阻断与空结果可同时存在，不伪报完整无结果。

完成标准：公开runner在两个独立实现家族上，由真实键鼠和只读后验确认根事实；普通成功、负向、未知、错误都有闭合证据。训练只针对当前对象选择/查询关系等必要语义，不训练“继续/第几步”。新结果语义尚未可辨时停在query关联验证，不提前宣称内容搜索完成。

## 7. B4：先解释失败，再学习合法恢复

先处理已有F1 R5：已知开发失败不能继续当新留出；9参数回执成员的正确输出不能替代F1完整组合验收。拆开回执知识、真实Goal事实、观察当前性与effects，先验证可辨性与组合关系，再最小后训练。具体标签/输入沿[反馈合同](browser-feedback-strategy.md)，不在此重定义。

训练目标是“当前失败State→当前合法恢复选择”。harness固定每步观察、计数、预算和重试资格；NN不能清除错误、猜effects、改变权限或直接宣布成功。n次是上限，不是错误后必须机械重试n次。只有同类失败仍满足安全条件才重试；次选必须已确认与根Goal同效果。

必测：回执成功但目标未变；明确拒绝但error正文缺失；可能派发后throw；后验缺失/过期；effects未知；发生其他效果；首选无效而次选有效；全部候选失败；同分DEFER；续跑计数不重置；原错误仍保留。F2必须消费F1实际预测，不能用teacher绕过错误。

完成标准：R5及新独立交叉组合正确；原子/反馈/策略分别评价，再跑完整公开轨迹。合法场景有界恢复到根达成；不安全/未知场景准确停止，无多余一次输入。旧F2的原始22/24及前提裁决保留，不按新报告改成历史全绿。展开域与搜索域迁移分别验收，不能混一个分母。

## 8. B5：不同结果表示与覆盖扩展

先固定“当前集合中的一个独立结果及其字段归属”语义，再一次增加一个变化：无标题正文、图文/视频、独立AI栏、嵌套引用、分页/手动加载、虚拟化。现有参数化fixture只是一个实现家族，增加参数不等于第二独立来源。

NN可学习结果角色、字段owner及当前合法对象选择；取值、版本、去重证据及覆盖评价保留确定性合同。owned不等于DOM包含，兄弟文字/引用作者不能错误归入当前结果。根阈值依据内容及已确认覆盖，不按节点数或模型分数相加。

验证：两个独立实现家族、未见结构组合、再到小红书/微博/知乎及Google/Bing的实际可访问页面。站点作为来源留出，不进入学生身份特征；无法登录/无适用对象精确记unassessed，不模拟已验证。真实页面操作使用授权的普通键鼠，不调用页面内部搜索接口或JS触发操作。

完成标准：对每个新增能力分别给字段归属准确性、查询关联、范围/批次覆盖、重复项处置、根达成与错误口径；动态未配对不强行继承旧标签。至少有一个未见表示在不改核心、不加站点规则下通过；若确有表示缺口，用同许可输入对应相反真值的反例修唯一owner，不能硬称永远只换参数。

## 9. B6：让实际使用进入可控升级链

沿[model-evolution](model-evolution.md)与现有DAG，先接一个已稳定浏览器能力的使用采样→监督复核→隔离训练→保存回载→独立评价/旧能力回归→条件采用或冲突移交。成功、无变化、拒绝、未知都采；样本记录不自动成为gold。

热重载按请求capture版本，旧continuation不偷换权重；失败对照是数值实验，不自动重放浏览器动作。单次奖励/惩罚作为训练资料，不能每次操作后直接改在用权重。

完成标准：公开consumer可证明完整升级行为；坏文件、回归、证据冲突保持当前版本并准确移交，符合既有提升/无回归/独立证据条件才采用。自动采用按已有用户授权规则，不新加逐次人工批准，也不能把静态图通过算自动链已运行。

## 10. 共同验收与停止规则

每个能力milestone都保留：四元素、现有图与唯一owner、必要红测、真实公开入口、逐例oracle、独立来源、受影响回归、新进程回载（如训练）、一次完整milestone独立Review，以及适用main交付。内部编辑不逐项审查；finding修复仅补受影响验证。纯状态整理不额外触发代码Review。

评价分开报：L1类别、关系识别、动作选择、实际执行、必要后验、根目标、恢复、安全边界、来源独立性。unknown/conflict/unassessed不删分母，不用成功率掩盖丢失的原始错误。无关变化检验不变性，自身条件变化检验正确翻转；测试数量按实际清单复算，不预编总通过数。

只改变一个必要假设，达到预定停止条件即停；预算失败不无限拟合。新训练使旧校准失效。表示足够时优先参数训练；只有重大缺失导致整类不可辨时才改特征/结构，并先改合同图纸。禁止用单条焦点if硬拦截代替已声明可训练分类语义。

复用现有拓扑：L1 1N0E与训练6N6E；operation-episode 7N6E；recursive-goal 3N2E；F1/F2各自推理/训练图；model-evolution及冲突图。本规划不改变运行拓扑，不新造阶段执行引擎或平行治理图。实施时有真实拓扑变化才修改相关图并validate/inspect。

## 11. 现在可派的最小批次

第一优先：B1焦点修复的独立Plan、评价资料与单因素实验。第二优先：B0集成边界整理，及B2已有text输入接口/观察能力的只读审计和独立场景准备。B4的R5资料设计可并行，实际共享模块修改需按owner排队。B3以后不提前做大规模样本/拟合。

实施者必须先记录运行入口、真实profile及材料位置，不能凭本规划重建资产路径或把旧worktree当新main。现有browser-foundation树归原作者且干净候选仍有独有工作，PROTECTED_HOLD；接续同任务域优先复用并明确owner，不额外开同域重试树，不删除他人资源。main集成只走标准Git合流。

首批worker提示词见[browser-next-worker-prompt.md](browser-next-worker-prompt.md)。本规划不是这些milestone已立项或执行完成的证明。

2026-10-22 B-Search 实施切片：搜索补「提交实例关联」与「响应归属」，新增 `submittedRequestRef`、`resultsRequestRef`、`submissionBaseline`、`collection.requestRef`/`batch`，使根 100 只能由本次提交的响应证据满足。家族 A 在既有 fixture 扩展场景；家族 B 为独立实现（自有 HTML、`<ol>/<li>` 主结果、独立旁栏、独立客户端与服务路由，不导入家族 A）。逐例验收程序 `playground/browser/search/{cases,native-io,accept}.mjs` 每行独立进程、仅 CDP 原生输入。真实浏览器 44/44 通过（两家族各 22 行；S=12、U=32、control error=32、原生动作 78），C04 迟到 A 不覆盖 B、C17/C18 错误分离、C19 两覆盖义务分列、C12–C14 旁栏不混计，材料见 run 目录 `b-search/acceptance`。验收在独立 headless Chrome 完成，搜索测试 30/30 与构建通过；本轮无训练与权重变更，决策仍 handwired。B-Feedback 仅展开域可开始，搜索域学习恢复仍未就绪。
