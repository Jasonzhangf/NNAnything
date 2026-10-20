# 浏览器行为框架与元素保留合同 v0.1

版本：`0.1.0-design`。本版固定行为边界、单步流程和分类后元素的逻辑结构；后续修订同一正文，不建立冻结快照。它不是已导出的 TypeScript API，不表示二次语义模型、浏览器行为 adapter 或自动采样已经实现。最小 `ObserveExpanded` read 合同已 READY，可进入实现；它是确定性读取，不训练也不引入网络。最小 `InputTextValue` 合同因宿主值/输入类型字段、训练域绑定及原生文字执行器缺失而 BLOCKED；InputTextValue 仍有 INPUT／NOOP／DEFER 单步学习责任。当前没有 input profile、typed 运行入口、样本或权重。

四元素沿 [design.md 1.1](design.md#11-结构化语义的目标与状态推理)。元素对操作条件的必要性沿 [operation-goal-necessity.md](operation-goal-necessity.md)，InputTextValue 数值训练合同沿 [browser-single-action-training.md](browser-single-action-training.md)，递归、错误、预算及恢复沿 [recursive-goal-module.md](recursive-goal-module.md)。本页是浏览器行为目录和分类后元素交接结构的唯一 owner；不改 L1 词表、数值输入、训练权重或已有采集包。

## 1. 四元素与学习边界

| 元素 | 浏览器单步含义 |
|---|---|
| Goal | 当前对象需要满足的内容、状态或结果条件；保留根 Goal 与直接父条件引用 |
| satisfactionThreshold | 精确读取、输入、激活后条件等通常为100；搜索仅在明确覆盖评价时有中间值，必要匹配条件仍需成立 |
| State | 同次适用页面观测、对象绑定、基础分类、语义关系、权限、已执行回执及缺测 |
| Action | 选择一个已启用技能，绑定对象及参数；可以读取知识，也可以执行人类输入 |

L1 学基础种类，L2 学给定当前 typed Goal/State 的用途、对象关系，以及当前行为/对象/参数引用选择。浏览器测量、输入执行、递归顺序、是否继续、引用失效和真实完成判定不训练。模型分数不能作为满足度。每步只选当前技能；缺技能、对象歧义、缺观测与执行失败分别返回准确错误，不按最高分任取对象。

LLM 用于定义、监督复核和训练纠错；当前设计不训练任意自然语言请求识别。使用样本不自动成为黄金，单元采集/真实训练/回载/独立回归及自动采用规则仍沿 [model-evolution.md](model-evolution.md)。

## 2. 行为目录

行为按目标效果分类；技能实现只准使用声明的人类可执行交互。组合行为可递归调用当前启用的原子或组合技能，不要求所有行为属于同一层。

| 行为 | 局部意图 | 必需识别/关系 | 验收 |
|---|---|---|---|
| read | 获取对象的内容/状态 | 对象、属性、内容归属、观测时效；首轮只取 `ObserveExpanded` 状态读取 | 实际取得目标要求的内容；观测到false也能完成“读取状态” |
| input | 使编辑对象内容符合要求 | 真正编辑宿主、所属范围、当前值、可编辑/只读状态；首轮只取显式绑定的普通 text input | 同一逻辑对象重观测值精确符合目标 |
| select | 使选项/开关处于要求状态 | 选项、所属控件、当前值/选中状态 | 实际选中/勾选状态符合要求 |
| click | 激活指定对象承载的作用 | 可操作区域、用途、作用对象、当前条件 | 点击回执与意图后条件分别记录；无后验证据不报目标成功 |
| scroll | 暴露目标或推进明确检查范围 | 实际滚动宿主、方向、边界、目标范围 | 真实可见区域/滚动位置变化或边界证据 |
| search | 在绑定范围中取得符合要求的结果 | 搜索范围、输入、提交方式、结果区、结果与查询关联 | 当前查询确实生效，匹配和明确覆盖条件成立 |
| download | 获得指定资源产物 | 入口、资源归属、选项、下载状态 | 浏览器下载完成及产物证据；不直接请求资源URL替代人类操作 |
| navigate | 到达要求的页面/标签/区域 | 导航入口、目的与上下文 | 实际位置及目标页面条件成立 |

`click`是当前执行行为，`search`可以是父行为。模型不能仅凭input类别判定它是搜索框，不能仅凭button或“Search”字样认定它属于目标搜索范围。具体用途和控制关系需要规则或模型的显式证据。

## 3. 单步流程及递归组合

复用 `workflows/operation-episode.graph.json` 的 `0.1.0-design` 7N6E SESE，拓扑不改，不新建第二张同义图。

| 现有节点 | 输入/输出责任 |
|---|---|
| 读取状态与页面观测 | 当前节点Goal/父引用/阈值/授权及变化事件 → 新观测、覆盖、候选资格；控制数据显式携带 |
| 组合基础节点识别目标 | 观测 → 本页元素结构、L1结果，以及所需L2角色/关系；缺测保留 |
| 按状态与策略判断是否操作 | 当前Goal/实际State/启用技能 → 一个当前技能及对象/参数引用，或NOOP/明确失败 |
| 满足条件时执行操作 | 核对引用新鲜、权限和操作条件后执行人类输入；保留原始回执，拒绝和未派发分开 |
| 操作已尝试时读取新观测 | 对已尝试动作获取所需真实后验；未执行保留原State，不制造变化 |
| 验证声明的后条件或保留未知 | 依Goal检查真实证据、必要条件与满足度；执行成功不代替目标达成 |
| 汇总结果与监督记录 | 返回真实事实、原子回执、错误、effect与父条件反馈；未实现采样明确报告 |

本轮先固定上述I/O责任，算子仍是design。运行接入时复用已交付的 `runRecursiveGoal`：领域adapter注入显式技能与条件，框架保留根Goal，按真实New State选择下一当前节点，并沿fulfills收回必要链。单次DAG不加回边，不训练递归层序。

Observe由首次请求、网页相关变化、目标scope变化与必要后验触发。变化包括DOM、滚动、尺寸、焦点、输入值及遮挡；DOM mutation不是唯一触发源。事件使受影响观测失效，合并事件后重新观测，不逐mutation派动作。重新观测仍是同一节点的显式控制状态，不是新业务Goal。

可见与完全遮挡过滤只影响本次候选资格。部分露出保留已观测区域。缺测为unknown，不按不可见删除。保留原槽位、节点、排除原因和关系证据；不可见不自动作为L1负例，离屏对象不自动失去通过滚动被发现的可能性。

操作仅为原生鼠标、键盘、文字输入、滚轮和必要拖拽。DOM只读可用于观测及绑定；禁止用`.click()`、写`.value`、脚本设滚动位置、调用站点函数/API、直接下载请求代替人类输入。原生或浏览器输入接口是否符合该合同须以实际后端验收，不因API名字是click/fill就自动符合。

### 3.1 最小 read/input typed 交接

两个 `0.1.0-design` 目标及完整 typed 请求/结果由 [operation-goal-necessity.md](operation-goal-necessity.md) 第5.6节维护。本页只固定浏览器侧交接：

| Goal | 显式目标 | 执行 | 真实后验 | 状态 |
|---|---|---|---|---|
| `ObserveExpanded` | `region: ElementRef`，`freshness: this_run` | 读取当前 `aria-controls`/`aria-expanded`，不修改网页 | 本次新观测为 `true` 或 `false` 都达到；unknown/conflict/stale 不报成功 | READY，未实现 |
| `InputTextValue` | `host: ElementRef`，`desiredValue: string` | 值相等时 NOOP；否则固定 `native_input_text` 原生键盘替换 | 新观测重绑同一宿主且值精确相等；邻输入不变 | BLOCKED，未实现 |

请求状态是 `ElementSnapshotV01` 的最小逐行投影，并显式给 `scopeRef`、`observationId` 与 `revision`。read 只要求 control/expanded/证据行，input 才要求值、effective input type 与可编辑事实。引用只在对应 document/scope 当前观测内有效。派发前必须检查 current-control；输入后必须取得新的 observation/revision，并显式证明同一逻辑宿主。跨快照不能按 AX 序号、DOM 顺序、文案或值相同继承对象。

`InputTextValue` 首轮只接受 effective type 为 `text` 的 `input`。`textarea`、`contenteditable`、rich text、`password`、`search`、文件输入和 `select` 均不在本轮。动作不得写 `.value`、调用站点 API 或经网络提交；select-all 仅作为原生文字替换的键盘基础，不是 select 行为。

`ObserveExpanded` 是 read 的可选最小切片，不读取正文、名称或媒体内容，不新增网络或事件采集。它是确定性读取，不设训练头、参数或 epoch。`InputTextValue` 的宿主已经显式绑定，因此不训练对象 selector、字符串生成或键盘层序；但学生仍须按 Goal/State 选择 INPUT、NOOP 或 DEFER。该独立 input-policy 成员的数值、分区、固定预算与回载合同唯一维护在 [browser-single-action-training.md](browser-single-action-training.md)，本页不复制数值。

当前 InputTextValue 仅为设计且 BLOCKED。没有 input profile、typed 运行入口、样本或权重；既有 SetExpanded 训练绑定不支持 input。模型 raw head 与 guard 结果分别保留，guard 可以阻止非法调用，不能替模型选择正确 head。独立验收必须在新进程提交 typed 请求，检查 invocation、原始 receipt、New State、effects、错误和 satisfaction；未满足字段、执行器与训练域绑定条件前不得启动拟合。

## 4. 分类后保留结构

以下是设计结构体，不在本轮加入lib或改变现有JSON解析器。复用现有`Rect`、`BasicKindSlot`、`ObservationNode`与`CandidateSlot`概念，运行实现按其owner对接。本结构是下一层的有证据对象视图，不是L1学生特征集合。

```ts
type EvidenceRef = string;
type ObservationId = string;
type DocumentRef = string; // 导航/文档替换后重新分配
type FrameRef = string;

type Observed<T> =
  | { status: "observed"; value: T; evidenceRefs: readonly [EvidenceRef, ...EvidenceRef[]] }
  | { status: "unknown"; reason: string }
  | { status: "not_applicable"; reason: string };

interface ElementRef {
  documentRef: DocumentRef;
  frameRef: FrameRef;
  nodeRef: string; // DOM/AX后端的明确引用；不是模型特征
}

interface ElementSnapshotV01 {
  schema: "nnanything.browser-elements.v0.1";
  observationId: ObservationId;
  pageRef: string;
  documentRef: DocumentRef;
  changeRevision: number;
  trigger: "initial" | "page_change" | "scope_change" | "post_action";
  viewport: Rect; // 浏览器内容视口CSS像素，不含浏览器工具栏
  coverage: readonly {
    frameRef: FrameRef;
    source: "dom" | "ax";
    status: "assessed" | "partial" | "unassessed";
    missingFacts: readonly string[];
  }[];
  elements: readonly RetainedElementV01[]; // 原顺序与槽位保留
}

interface RetainedElementV01 {
  index: number;
  ref: ElementRef;
  parentRef: Observed<ElementRef | null>; // 结构父级，不暗示语义owner
  tag: Observed<string>;
  role: Observed<string | null>;
  candidate: {
    status: "ok" | "filtered_out" | "skipped" | "unknown";
    reasons: readonly string[];
  };
  classification: Observed<{
    basicKind: BasicKindSlot["basicKind"];
    judgmentStatus: BasicKindSlot["judgmentStatus"];
    profileRef: string;
    resultRef: EvidenceRef; // 引用完整L1结果，不复制全部wire
  }>;
  view: {
    visibility: Observed<"visible" | "partial" | "offscreen" |
      "hidden" | "occluded">;
    rect: Observed<Rect>;
    exposedRects: Observed<readonly Rect[]>;
    pointerTarget: Observed<{ x: number; y: number }>;
  };
  interaction: {
    effectiveInputType: Observed<string | null>; // 仅表单宿主；普通 input 缺省 type 由 adapter 解析
    enabled: Observed<boolean>;
    editable: Observed<boolean>;
    readOnly: Observed<boolean>;
    focused: Observed<boolean>;
    checked: Observed<boolean>;
    selected: Observed<boolean>;
    expanded: Observed<boolean>;
  };
  content: {
    visibleText: Observed<string>;
    accessibleName: Observed<string>; // 不冒充用户看见的caption
    value: Observed<string | null>; // 仅当前Goal必要且允许时读取
    mediaRefs: Observed<readonly EvidenceRef[]>;
  };
  scroll: Observed<{
    hostRef: ElementRef;
    x: number; y: number;
    maxX: number; maxY: number;
  }>;
  evidenceRefs: readonly EvidenceRef[];
}
```

每个字段明确已测、未知或不适用。已测空文字为`observed("")`；无法读取不能伪装为空。`observed(null)`只用于实际确认该属性无值。已测值必须有证据引用，引用在本次证据集合中可解析。几何及pointerTarget统一内容视口CSS像素；frame坐标转换与原生屏幕坐标转换由adapter负责，转换未证实不能派坐标点击。

`pointerTarget`只证明该点在已观测露出区域且命中目标或允许的交互承载，不证明点击有业务效果；阅读目标不要求有pointerTarget。未评估命中为unknown，不由rect中心自行补点。AX只读能取得值，但没有DOM tag/几何时相应字段仍unknown，不能用fixture源码伪装成实时测量。

`changeRevision`属于观测/harness控制资源，业务payload不另建副本驱动决策。页面变化使受影响快照失效；框架在派发前核对当前版本。导航更换documentRef。AX数字索引只在当前AX观测内有效，不能当跨快照稳定nodeRef；重新绑定需显式证据，不能靠文案相同直接继承身份。

`content.value`默认unknown/not_collected；密码和敏感内容不进入普通元素快照或训练集。所需输入读回走目标专用、已授权观测。raw class/id、账号正文、完整URL、媒体文件名和绝对路径不因保留于诊断或目标内容就自动进入L1数值输入。训练取参器仅消费任务声明字段。

`classification=unknown/not_classified`表示没有本次L1回执；与实际分类回执内的`judgmentStatus=unknown`不同。被过滤元素不能伪造L1类别、profile或结果引用。`visibleText`是读取器在当前可见范围直接取得的文字证据，读取范围写入其证据，不默认等于caption、标题或归属正文；AX提供的名称如不能证明可见文字，只填accessibleName，visibleText保持unknown。跨子容器的button.text/card.text需要显式owned关系及内容组合，不能用全后代textContent静默替代。

### 4.1 语义角色与当前行为分开承载

```ts
interface SemanticRelationV01 {
  observationId: ObservationId;
  subject: ElementRef;
  relation: "owned_by" | "caption_of" | "title_of" | "body_of" |
    "controls" | "edits" | "submits" | "results_for";
  object: ElementRef;
  judgmentStatus: "judged" | "unknown" | "conflict";
  basis: "explicit_fact" | "declared_rule" | "model";
  profileRef: string | null;
  evidenceRefs: readonly EvidenceRef[];
}

interface BrowserChoiceV01 {
  goalRef: string;
  conditionRef: string | null;
  observationId: ObservationId;
  skillRef: string; // 一个当前已启用的原子/组合技能
  behavior: "read" | "input" | "select" | "click" | "scroll" |
    "search" | "download" | "navigate";
  targetRef: ElementRef;
  argumentRefs: readonly string[];
  relationRefs: readonly EvidenceRef[];
  profileRef: string;
}
```

caption/title/body是角色，不新增同义L1类别。`controls`等模型关系是待实际操作验证的判断，不自动提升成实际效果事实。关系需要显式引用；`relationRefs`引用收录的完整关系结果证据。相邻、包含、同文案都不单独证明语义归属。当前Goal相关的provider判断沿现有必要性合同，不写回L1 `ignore`。

BrowserChoice只描述成功选出的当前步骤。NOOP、缺技能、歧义、缺观测和权限/执行失败分别由既有递归response/error合同承载，不伪装成Choice或新建第二套status词表。report保留实际atomic receipt、effect knowledge、新观测引用及父条件评价；日志不承担业务决策真源。

### 4.2 字段保留的最小必要性

| 字段组 | 删除会破坏什么 |
|---|---|
| 版本、document/frame/node引用、槽位 | 导航后误用旧对象、跨frame混用、排除项丢失 |
| candidate与L1 judgment/结果引用 | 无法区分被过滤、unknown、other和具体类别，误当可操作候选 |
| parent及独立语义关系 | 无法区分相邻输入、嵌套scope及其提交/结果对象 |
| 可见区域、命中点及坐标约定 | 完全遮挡或点击位置错误；缺几何却发动作 |
| 交互状态与有效输入类型 | 对disabled、只读、错误输入类型或错误选中状态执行 |
| 文字/名称/目标必要值/媒体引用 | 无法区分用途、读取caption或核实写入；内容不得自动进入L1 |
| scroll及覆盖缺口 | 无法区分范围已检查、仅离屏和观测不到 |
| 证据/来源及profile引用 | 无法区分真实测量、模型判断、缺测和过期结果 |

各组是通用槽位，不要求每个元素产生所有测量。非滚动对象或非输入对象可明确not_applicable。仅本案例使用的字段也不据此宣称所有网页语义已经覆盖。

## 5. 单案例实测及版本结论

2026-10-20，原生Chrome、本地HTTP搜索fixture，查询`Recursive Goal`，目标结果`Recursive Goal Framework`。页面包含相邻Notes输入、disabled保存按钮及隐藏的重复搜索按钮。fixture通过普通GET表单返回结果，无站点JS操作。

| 步骤 | 实际操作与观测 | Goal评价 |
|---|---|---|
| S0 | 原生键盘新建标签并输入本地地址；AX显示Notes原值、Search catalog及No search submitted | 搜索父Goal未达成；对象选择由本轮agent完成 |
| S1 | 点击Search catalog，原生typeText输入Recursive Goal，重读实际值 | 输入子Goal达成；父Goal仍未达成 |
| S2 | 原生点击Search；页面导航到`/search?q=Recursive+Goal` | 点击已发生，尚需后验 |
| S3 | AX与截图显示Query: Recursive Goal; 1 result(s)以及目标条目；Notes仍Keep this unchanged | 本案例搜索Goal达成，阈值100 |

六项现场检查为true：查询值、当前查询结果状态、目标结果、邻输入未改、隐藏重复按钮未出现在AX、导航后原输入索引未再使用。原始工具状态显示输入从S0/S1索引202变为导航后225；后续完整AX重读又重新编号，进一步说明AX索引不是持久DOM引用。

这是一个手工选择/评价的真实键鼠合同实验：没有调用NNAnything浏览器L1分类器、L2选择器、operation图或递归runner驱动这段操作。它验证最小用户行为与反馈，以及结构必须保留的信息；不证明项目模型已正确分类/选择，也不证明跨站泛化、遮挡过滤或自动变化监听已实现。

尝试将此原生Chrome页面绑定到本会话Chrome扩展DOM后端时返回`Tab not found in browser 1`；未换通道伪造实时DOM。因此本次实时内容证据为AX/截图，DOM布局仅来自fixture源且不当作测量；L1输入测量仍是具体gap。完全遮挡、滚动、下载、复杂多层scope及模型误选反例未实测。

现场证据摘录、六项检查、fixture及工具会话回执归档于`/Volumes/Intel/playground/nnanything-runs/browser-behavior-v01-20261020/`；摘录为工具输出转录，不宣称自动采集管线。案例不产生训练样本或权重。

## 6. 对照本版得到的gap

| 缺口 | 当前基础与owner | 关闭依据 |
|---|---|---|
| 页面/文档/观测版本与失效绑定 | browser adapter；现有ObservationNode只有nodeRef与局部观测 | 页面变化、导航、重绑定真实入口用例，不复用过期对象 |
| 新结构投影与完整关系结果引用 | browser adapter/节点交接；已有ObservationNode、CandidateSlot、BasicKindSlot | 从真实观测和L1结果组装，unknown/排除槽位保留，JSON/typed合同一致 |
| `ObserveExpanded` typed runtime | browser adapter/operation节点；窄观测已解析 `aria-controls`/`aria-expanded` | READY；增加 typed Goal 与 read-only结果消费，R1-R6 新进程验收，不新增网络或NN |
| caption、owner、用途与输入/提交/结果关系 | L2 relation/model；owned当前仍unsupported_scope | 同scope正确、相邻/嵌套反例、观测不足及独立真实页面评价 |
| 当前意图的行为/对象/参数选择 | L2 policy与training；本案由agent选择 | 相同对象不同Goal、相同Goal不同State等区分样本，真实拟合回载及独立回归 |
| `InputTextValue` 当前值与输入宿主事实 | browser adapter及专用元素快照 | BLOCKED；补 current value、effective input type、editable/readOnly、露出与缺测，不能由普通L1类别推断 |
| `InputTextValue` 原生文字执行与后验 | browser adapter/operation节点 | BLOCKED；补 `native_input_text` receipt、current-control、同宿主重绑和邻输入不变验收，DOM写值不算实现 |
| `InputTextValue` INPUT／NOOP／DEFER 训练成员 | browser-single-action training及lib/training；既有模型演进owner | 学习责任保留且数值设计另立；当前无 profile、样本、权重或领域绑定。字段和执行器闭合后先设计/校验 input 训练绑定，不能复用 SetExpanded 绑定冒充已支持 |
| 真实键鼠成功/失败/副作用 | 浏览器领域adapter/operation节点 | 输入实现后用独立新进程验证 dispatch、effects、New State及错误；本次外部CUA案例不冒称产品实现 |
| 自动采集与单元升级 | 沿model-evolution既有owner | 真实使用采样、监督、训练回载、独立评价及无回归采用；本次未实现 |

本版不新增L1类别。现有input/button/text/container等足以表达该案例候选；真实L1分类未运行，不能由此证明分类准确率。后续发现不可表达的基础种类或缺测后，按最小必要性补其owner，不以L2补丁掩盖基础能力缺失。
