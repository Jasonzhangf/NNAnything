# CLI对象绑定：B关系概念设计

状态：2026-10-19设计说明；未实现类型、算子、样本、训练或迁移。本文只补齐B对象关系绑定的typed I/O、集合消歧、覆盖与新鲜度、参数角色、使用采样和验收合同。现有边界继续由[file.property合同](cli-filesystem-semantics.md)、[固定调用设计](cli-command-design.md)、[训练设计](cli-property-training-design.md)和[模型演进合同](model-evolution.md)维护；本文不建立第二套算法、采用条件或执行引擎。

## 1. 位置、范围与权重边界

B是一个在对象参数进入属性动作策略前运行的独立关系概念函数。它只输出候选对象、路径或session是否满足声明的名称、类型、父目录及session关系。它不选择命令头，不选择P属性动作，不执行扫描或OS操作，也不把最高分候选直接当成答案。

现有[cli-file-property.graph.json](../workflows/cli-file-property.graph.json)已是6节点5边SESE。B只服务第一个节点“绑定属性目标阈值与当前状态”：把request及显式State中的typed引用整理为可消费的`file_property_context`，或返回绑定缺口。后续选择、执行、观测、评价和采样节点不变。本文不新增图、节点、边、算子或运行配置。

CLI最终只有一个统一动作策略权重`cli.command-policy.v1`，负责命令头及既有已声明动作选择。B的关系概念profile不属于这个CLI动作权重，不输出`pwd/cd/ls`等命令头，不替代统一动作策略；B也不是逐命令selector。其他P1/P2及共享权重策略由公共设计正文维护，本文不修改。

迁移必须先满足本文设计闭合，再进入实现和旧入口迁移。当前`observe_cwd/set_cwd/list_directory`仍是既有运行事实；本文存在不表示它们已接入B或`file.property`。

## 2. 四元素与执行责任

| 元素 | B的最小合同 |
| --- | --- |
| Goal | 在显式范围和声明角色内，为一个对象/路径/session参数取得唯一合法绑定，或返回typed未找到、歧义、未知、冲突或输入缺口。 |
| satisfactionThreshold | 绑定知识Goal固定100：要求必要关系当前可判、范围覆盖足够、集合结果唯一且消费时引用有效。该100不是B模型分数或概率；整体`file.property`满足度仍由图第五节点按实际New State评价。 |
| State | 显式Goal约束、参数角色、已观测候选、ObjectRef/PathRef、session引用、观测来源、覆盖和新鲜度证据；不读取隐藏cwd、未声明目录或历史teacher答案。 |
| Action | 手写校验、候选收集结果接入、符号关系特征计算、B关系分类、集合解析和消费前复核。B不执行`find/list/cd`等环境动作。 |

训练期可从Goal和独立真值反推“名称/类型/父目录或session关系成立”的监督；推理期只用可观测State及候选计算关系，不接收teacher正确ref。推理预测不能替代实际对象观测，绑定成功也不能替代属性Goal达成。

## 3. Typed对象合同

以下为设计形状，不是当前可导入TypeScript类型。实现必须在现有`lib/filters/`、`lib/nodes/trainable/`、`lib/training/`和公开consumer边界内落地，不把原始路径字符串或teacher结果塞入学生向量。

```ts
type ScenarioId = string;
type SessionId = string;
type ObservationId = string;
type RunId = string;
type EntryType =
  | "regular"
  | "directory"
  | "symlink"
  | "char"
  | "block"
  | "fifo"
  | "socket"
  | "other"
  | "unobserved";

type ObjectIdentity = Readonly<{
  dev: string | null;
  ino: string | null;
  evidenceId: ObservationId | null;
}>;

type ObjectRef = Readonly<{
  kind: "cli.object";
  scenarioId: ScenarioId;
  observedPath: AbsolutePath;
  observedType: EntryType;
  parent?: ObjectRef | null;       // 仅来自实际直接父目录观测
  identity?: ObjectIdentity;       // 可得时保留，不用路径相等代替对象身份
  observationId: ObservationId;
  observedBySession: SessionId | null;
  freshness: ReferenceFreshness;
}>;

type PathRef = Readonly<{
  kind: "cli.path";
  scenarioId: ScenarioId;
  absolutePath: AbsolutePath;
  source: "goal" | "path.resolve" | "observation";
  observationId: ObservationId | null;
  freshness: ReferenceFreshness;
  creation?: Readonly<{
    parent: ObjectRef;             // 必须先观测为directory
    name: Name;                    // 单名称段；不是完整路径复制
    existence: "unobserved";       // 不假设已存在，也不伪造ObjectRef
  }>;
}>;

type SessionRef = Readonly<{
  kind: "cli.session";
  scenarioId: ScenarioId;
  sessionId: SessionId;
}>;

type BindingRole = "source" | "destination" | "parent" | "session";

type SessionCwdBinding = Readonly<{
  kind: "cli.session-cwd";
  session: SessionRef;
  relation: "sessionCwd";
  observationId: ObservationId | null; // 仅本次cwd.get可填，不从Goal预填
}>;

type BindingResult =
  | Readonly<{
      status: "unique";
      role: BindingRole;
      binding: ObjectRef | PathRef | SessionCwdBinding;
      coverageIds: readonly string[];
      evidence: Object;
    }>
  | Readonly<{
      status: "not_found" | "unknown" | "conflict" | "invalid_input";
      role: BindingRole;
      reason: string;
      coverageIds: readonly string[];
      evidence: Object;
    }>
  | Readonly<{
      status: "ambiguous";
      role: BindingRole;
      matches: readonly (ObjectRef | PathRef | SessionCwdBinding)[];
      coverageIds: readonly string[];
      evidence: Object;
    }>;
```

`ObjectRef`只表示一次仍可追溯的实际条目观测。其路径相同不证明后续仍为同一对象；硬链接、替换和链接目标必须另看identity或实际观测。`PathRef`只表示需解释的路径引用，不证明条目存在、类型或物理身份。创建目标使用带`creation:{parent,name}`的`PathRef`；目标尚不存在时不得强迫生成`ObjectRef`，也不得以“看起来存在”的路径包装成对象。

`ScopedFileQuery`只在调用者声明的范围内定位未知对象或关系：

```ts
type DirectoryScope = Readonly<{
  parent: ObjectRef;               // 已观测directory
  depth: 1;
  coverage: Coverage;
}>;

type ScopedFileQuery =
  | Readonly<{
      kind: "cli.file-query";
      relation: "entrySelector";
      scopes: readonly DirectoryScope[];
      selector: Readonly<{
        name?: Name;
        type?: "regular" | "directory" | "symlink";
        parent?: ObjectRef;
      }>;
      cardinality: "one";
    }>
  | Readonly<{
      kind: "cli.file-query";
      relation: "sessionCwd";
      session: SessionRef;
    }>;
```

`entrySelector`首轮只查显式父目录的直接条目，不递归、不跟随最终symlink、不把后代算入直接范围。多个显式`DirectoryScope`可用于跨目录候选，但每个父目录分别给覆盖。`sessionCwd`查询只携带session引用；不得用Goal目标路径、State旧cwd或候选顺序预填答案，实际cwd只能来自本次`cwd.get`观测。

## 4. 候选来源与覆盖

B接受的候选来源只有以下typed来源：

| 来源 | 允许内容 | 不允许的推断 |
| --- | --- | --- |
| 显式引用 | Goal或State直接给出的`ObjectRef`、`PathRef`、`SessionRef` | 从路径文本猜类型、存在性或父对象 |
| 目录观测 | 对显式`DirectoryScope`执行`directory.list`得到的直接条目及逐项观测 | 隐式扫描、递归、跟随链接、从列表长度猜覆盖 |
| session观测 | 对应显式S的本次`cwd.get`结果 | 把另一S、旧观测或期望路径当作S的cwd |
| 链接观测 | `lstat`/`readlink`得到的链接自身，及另一次`realpath`/目标inspect得到的独立目标 | 把链接文本存在当成目标存在，或把目标关系复制给链接自身 |

覆盖是集合解析的一等证据，不从候选数量推断：

```ts
type Coverage = Readonly<{
  scopeId: string;
  parentObservationId: ObservationId;
  status: "complete" | "partial" | "unknown";
  includedCandidateRefs: readonly string[];
  excludedUnknownRefs: readonly string[];
  errorRefs: readonly string[];
  observedAtRun: RunId;
  freshness: ReferenceFreshness;
}>;
```

`complete`只表示声明父目录的当前直接条目已全部纳入，且没有拒权、读取中断或未知排除项。`partial`不得支持`not_found`或唯一性结论。显式候选没有完好的覆盖合同时，也只能逐项判断关系，不能声称集合唯一。

## 5. 新鲜度与失效

引用必须同时带有观测来源和有效性状态。新鲜度按对象、范围及session各自证据判断，不使用任意墙钟TTL代替实际状态。

```ts
type ReferenceFreshness =
  | { status: "fresh"; observationId: ObservationId; runId: RunId }
  | { status: "stale"; reasonCode: "session_changed" | "parent_changed" | "identity_changed" | "link_changed" | "scope_changed" }
  | { status: "unknown"; reasonCode: "not_observed" | "evidence_missing" };
```

失效规则：

- `ObjectRef`在消费前必须复核当前条目；路径、类型、父关系或可得identity与观测不符时为`stale`。路径复用但OS对象已被替换，不视为原对象。
- `PathRef`的词法值可保留，但其存在性、类型和父目录约束随来源观测失效；创建目标只要求新鲜父目录，目标本身保持`existence:"unobserved"`。
- session的cwd观测在session变化、`cwd.set`提交或session revision不一致时失效。旧cwd不得从其他session或父进程补回。
- `DirectoryScope`在父目录条目集合可能变化、覆盖为partial/unknown或source observation失效时失效。文件内部内容改变不自动改变父目录覆盖，但不能继续证明文件属性。
- symlink自身的名称、类型和父关系只描述链接条目；目标观测单独保存。链接被替换、删除或重绑后，旧目标关系失效，不能仅按旧`realpath`继续消费。
- 观测和引用在消费边界再次校验。校验失败返回`stale`/`unknown`，不得按遗留路径直接执行。

## 6. 参数角色

角色由操作的固定typed schema提供，B不学习或交换角色。每个角色单独调用关系判别；缺失任一必需角色即形成绑定缺口。

| 角色 | 合法输入 | 关键约束 |
| --- | --- | --- |
| `source` | 已观测`ObjectRef` | 必须存在且类型符合操作；symlink默认是链接自身。创建路径或仅词法`PathRef`不能成为source。 |
| `destination` | 带`creation:{parent,name}`的`PathRef`；需要既有目标的场景可用`ObjectRef` | 目标存在性由State显式表示；需create-new的操作不得把已有条目猜成可覆盖。跨设备、目标冲突由执行阶段另行报告。 |
| `parent` | 已观测目录`ObjectRef` | 父关系来自实际直接父观测或本次sessionCwd结果；未观测目录或文件类型不能成为parent。 |
| `session` | `SessionRef` | 不是文件对象；只表示参数归属和观测来源。session关系使用CWD概念，不从路径相同推断同一session。 |

`source`与`destination`不能互换。`entry.move(source,destination)`、`file.copy(source,destination)`等多角色操作分别绑定；B不根据候选顺序、最高分或操作名称补换角色。创建目录或文件必须先绑定parent和精确Name；Name复制由harness完成，B不训练路径字符串复制。

## 7. B输入、关系事实与集合结果

B的单候选输入只包含声明关系及availability，不包含teacher期望ref或Action标签：

```ts
type BindingCandidateInput = Readonly<{
  role: "source" | "destination" | "parent" | "session";
  nameEqual: boolean | null;
  typeEqual: boolean | null;
  parentEqual: boolean | null;
  sameSession: boolean | null;
  hasObservation: boolean | null;
  sourceObservationId: ObservationId | null;
  freshness: ReferenceFreshness;
}>;
```

`nameEqual`是精确Symbolic Name比较，不做大小写或Unicode折叠；`typeEqual`比较Goal声明类型与实际观测类型，扩展名和尾随`/`不参与；`parentEqual`比较明确直接父关系，不能只用完整路径相同证明物理父对象相同。`sameSession`与`hasObservation`只用于显式session关系，概念输入及六参数语义沿[CWD训练设计](cli-cwd-training-design.md)，不在这里重写公式或损失。

B4数值输入、wire顺序、参数、梯度和训练预算的唯一正文是[训练设计第2节](cli-property-training-design.md#2-b候选对象及参数角色)。本文只固定这些输入的语义来源和运行时边界，不复制第二份算法。手写部分负责：

- 校验引用、父目录、session及覆盖合同；
- 计算精确名称/类型/父关系及availability；
- 把实际观测挂到候选事实；
- 消费B输出并执行集合解析；
- 在动作边界复核引用。

每个候选先输出关系事实，而非直接选择：

```ts
type CandidateRelation =
  | { status: "judged"; value: "match" | "nonmatch"; score: number; evidence: Object }
  | { status: "unknown"; reason: "missing_relation" | "stale" | "unobserved"; evidence: Object }
  | { status: "conflict"; reason: string; evidence: Object };
```

关系分类不带训练正负极性，不把“未匹配”自动变成负例。集合解析器再按以下优先级返回：

| 集合条件 | typed结果 |
| --- | --- |
| 输入将不可能状态伪装成候选，如同一父目录同一名称对应不同实体、重复ref指向互斥事实、角色引用非法 | `invalid_input` |
| 候选事实、覆盖或引用出现互斥证据，无法确定成员或归属 | `conflict` |
| 决策相关关系缺测、覆盖partial/unknown、引用stale，或任何未判候选仍可能改变集合 | `unknown` |
| 覆盖complete，正好一个确定匹配，其余候选均确定不匹配 | `unique`，返回对应`ObjectRef`、创建`PathRef`或session关系绑定 |
| 覆盖complete，所有候选确定不匹配 | `not_found` |
| 覆盖complete，两个及以上候选确定匹配 | `ambiguous`，保留全部匹配ref，不按分数/顺序猜一个 |

`unique`要求唯一性和证据同时成立；`not_found`要求完整范围内所有候选都已判断。没有完整覆盖时不得用`not_found`或`unique`掩盖缺测。`ambiguous`不自动取最高分。绑定结果只说明对象/关系事实，不评价属性Goal是否满足。

显式`sessionCwd`查询绑定的是`{session:S, relation:"sessionCwd"}`关系，实际cwd值仍由`cwd.get`产生。其无观测时返回`unknown`，不把Goal中的期望目录预填成知识。创建目标不存在时，B可返回带父目录和名称的`PathRef`；父目录未知或Name非法时返回typed缺口。

## 8. 消费链与单一动作策略

现有6N5E图的消费边界为：

```text
file.property request + explicit State
→ B按角色绑定ObjectRef/PathRef/ScopedFileQuery
→ file_property_context
→ P从声明操作族选择动作/NOOP/DEFER
→ harness复核typed引用并固定执行
→ 实际属性观测与Goal满足度评价
```

B不向P提交原始候选列表分数、teacher正确ref或候选顺序。P只接收已验证的目标、角色、类型、创建parent/name、覆盖和缺口事实；P仍不能凭角色内容生成自由参数或命令头。CLI统一动作策略的单一权重只处理动作选择；B概念profile独立，二者不能相互替代或共享未声明兼容的权重。

在执行前，harness按角色的typed合同复核：

- source存在且仍符合已观测类型/身份；
- destination按创建或既有目标合同校验；
- parent仍为已观测目录；
- session仍指向同一显式session，cwd证据有效；
- 绑定结果没有从partial覆盖升级成唯一。

复核失败保留原绑定事实及错误，不换ref、不重新扫描、不选择第二个候选。B不执行动作，也不把动作执行回执当关系标签。

## 9. 监督、样本与使用采样

只有关系事实由独立观测或明确合同核实的候选才可进入监督。当前B4的名称、类型、父关系三事实只在完整可用时形成8种关系组合；缺测、stale、unknown和conflict不补0，不转负例，也不强行生成第9种监督组合。

| `(nameEqual,typeEqual,parentEqual)` | 关系监督 |
| --- | --- |
| `000 / 001 / 010 / 011 / 100 / 101 / 110` | 非匹配 |
| `111` | 匹配 |

上表是训练监督事实，不是运行时旁路；模型推理仍由B输出，teacher不在请求中改写结果。student输入不含正确ref、路径全文、teacher候选布尔或可执行器预先选中的结果。文件与目录是否共享B权重仍按训练正文的兼容要求判断，本文不宣称跨类型可移植。

session关系样本只在显式session、候选观测槽位及必要关系可用时监督；四种二值特征组合及六参数概念合同沿用CWD正文。`sameSession=0`、无观测、过期观测和重复不一致归属不能合并成同一种负例。

每个使用episode至少采集：

```ts
type ObjectBindingUsageSample = Readonly<{
  requestId: string;
  scenarioId: ScenarioId;
  role: BindingRole;
  queryKind: "entrySelector" | "sessionCwd" | "creation";
  studentInput: BindingCandidateInput;
  candidateSourceKind: "explicit" | "directoryObservation" | "sessionObservation" | "linkObservation";
  coverage: Coverage | null;
  bindingResult: BindingResult;
  consumedByAction: boolean;
  preConsumptionValidity: ReferenceFreshness;
  postConsumptionObservation: Object | null;
  reviewStatus: "unreviewed" | "verified" | "conflict";
  sourceFamily: string;
}>;
```

采样由consumer/节点在真实使用边界生成，不能从filter写日志或从teacher事后补造。成功、失败、无匹配、歧义、缺测和冲突均保留；只有独立复核的实际关系、对象/链接观测或明确的受控创建结果可成为监督。消费成功或命令退出0不等于关系真值或属性Goal达成。

样本来源按完整场景家族先分train/development/verification，再生成候选、换名副本和顺序变换。同一实际树、目录列表来源或session轨迹不得跨分区。B的训练密度和4/2/4独立场景家族沿[训练设计第6节](cli-property-training-design.md#6-场景分区与独立验证计划)，本文只补下列独立反例，不重定义数量或拟合预算。

| 独立反例 | 必须抓住的失败 |
| --- | --- |
| 同名条目位于两个显式父目录 | 只用名称或候选位置，忽略parentEqual |
| 同一父目录中同名但类型不同的合法候选 / 明确同名文件与目录目标 | 从扩展名或名称猜类型，混淆requiredType与observedType |
| session修订已变化或cwd观测来自别的session | 把旧观测、其他session或预填期望路径当当前答案 |
| symlink自身与单独观测的目标同时出现 | 把链接文本/目标当链接自身，或未经跟随即把目标当direct entry |
| source与destination角色交换 | 按候选排序或操作习惯猜角色，误把创建目标当已存在source |
| coverage partial/unknown但有若干候选 | 无匹配或唯一绑定吞掉未覆盖范围 |
| 完整范围存在两个合格候选 | 最高分或首项捷径；应返回ambiguous |
| 创建目标不存在 | 强制ObjectRef、伪造exists或把父目录Name复制错 |
| 同名关系事实或ref互斥，或重复实体/路径不一致 | 将矛盾输入当普通unknown或训练为负例 |

## 10. 训练、独立来源与公开consumer验收

本轮不生成样本、不拟合、不保存profile、不迁移入口。后续实施至少形成以下消费者合同：

1. 关系consumer：输入显式候选关系事实，输出`CandidateRelation`；缺测保持unknown，不补0。
2. 集合consumer：输入`ScopedFileQuery`、显式候选来源及逐个scope的覆盖，输出`unique/not_found/ambiguous/unknown/conflict/invalid_input`。
3. file.property绑定consumer：输入`file.property` request、显式State和角色，输出可消费的`ObjectRef`/`PathRef`/session关系或typed缺口；不得隐式扫描。
4. 动作消费验收：source/destination/parent/session分别经harness复核，错误角色或stale引用不执行；实际属性效果由后续图节点独立观测。
5. 保存后新进程回载：公开consumer从显式B profile加载，得到与保存前一致的逐候选关系及集合结果；模型训练和OS执行分项报告。

训练consumer只读取已分区的B关系行和独立真值，不使用公开查询consumer作为反向标签来源。development消费独立结构家族以选择预算/阈值；verification由独立作者在真实临时目录中构造，使用实际`directory.list`、`lstat`、`readlink`或受控创建后观测，不复用train/dev生成器。真实临时目录仅供后续实现验收，不授权当前轮执行破坏操作。

公开consumer不能接受“正确ref”字段，也不能通过内部filter直接调用绕过typed校验。验收必须报告：

- 8种完整B关系组合及其缺测/冲突反例；
- unique、not_found、ambiguous、unknown、conflict和invalid_input各自至少一个可抓错场景；
- 同名异目录、同目录不同类型、过期session、symlink/目标、角色互换、缺coverage及不存在创建目标的独立结果；
- 参数引用、覆盖、新鲜度、实际OS证据与Goal满足度分别计分；
- 保存/回载、旧PWD/CD/LS兼容回归及候选`not_applied`状态；
- 没有真实样本、拟合或回载证据时只能报告设计完成或UNVERIFIED。

## 11. 进化与迁移接入

B的每次使用采样、复核、分区、真实拟合、候选保存/回载、独立评价、零回归比较、自动采用及冲突保留统一引用[model-evolution.md](model-evolution.md)和[model-evolution.graph.json](../workflows/model-evolution.graph.json)。不在本页增加采用门槛、哈希、冻结快照或第二套冲突处理。当前自动使用采样、版本切换和LLM冲突裁决链未实现，B候选不得写成已训练或已采用。

迁移前置条件：

1. 本文的对象、角色、覆盖、新鲜度、结果状态和消费合同通过设计核对。
2. 现有6N5E图的绑定节点获得typed实现与公开consumer红测；图本身无拓扑缺口时不另造B图。
3. adapter补齐实际观测来源、覆盖和引用身份证据；filter实现关系特征；trainable实现唯一数值正文对应电路；training实现分区/回载/评价；nodes与consumer负责workflow接续与采样。
4. 旧PWD/CD/LS兼容入口及路径黄金回归有适用证据，统一`cli.command-policy.v1`仍保持单一动作策略权重。
5. 随后才迁移`file.property` request/result及旧入口；设计、训练和迁移均不互相冒称完成。

## 12. 已给、依赖与具体缺口

已给且复用：

- `cli-file-property.graph.json`已验证为6节点5边SESE，B位于既有绑定节点。
- [cli-filesystem-semantics.md](cli-filesystem-semantics.md)已定义`file.property` Goal、`ObjectRef/PathRef/ScopedFileQuery`方向及目标不存在边界。
- [cli-property-training-design.md](cli-property-training-design.md)已定义B4关系模型、8组合监督、sessionCwd复用和三角色分别调用；本文不复制其算法正文。
- [cli-cwd-training-design.md](cli-cwd-training-design.md)已定义CWD六参数概念关系，B只引用其session归属语义。
- [cli-command-design.md](cli-command-design.md)已定义source/destination/parent/session的固定操作参数、创建parent+name、sessionCwd及执行后条件。
- [model-evolution.md](model-evolution.md)与图已定义采样、候选隔离、配对评价、采用和冲突移交目标流程。

具体缺口：

- 当前没有可导入的`ObjectRef/PathRef/ScopedFileQuery`合同类型，现有`DirectoryRef`也没有本文要求的完整对象身份、父观测和覆盖字段。
- 6N5E图的六个`cli.file-property.*@0.1.0-design`算子仍无运行实现；B没有运行profile、样本、拟合或回载。
- 公开`directory.select/file.select`仍是单父、精确parent+name的首轮设计，尚无本文的多匹配、stale引用、角色消费和覆盖矩阵实现。
- `file.property` request/result与旧PWD/CD/LS尚未迁移；统一动作策略单权重保持现状。
- B使用采样、独立训练数据、profiles、自动比较采用及冲突裁决执行链均未实现。
- 在实现前还需确认现有adapter可稳定提供的identity证据及覆盖诊断字段；不能提供时按`unknown`保留，不得用路径字符串补造。

依赖与owner：

- 实际文件/目录/session观测：`lib/adapters/cli/`。
- 关系特征、覆盖和集合纯判断：`lib/filters/`。
- B数值电路：`lib/nodes/trainable/`，数值定义只沿`cli-property-training-design.md`第2节。
- 样本分区、拟合、保存/回载与评价：`lib/training/`。
- 工作流接续、使用采样和公开consumer：`lib/nodes/`及`playground/`/`tests/`的公开入口。
- 外层对象流：现有6N5E属性图；单元升级：现有`model-evolution.graph.json`及其冲突图。

本文完成的是一次设计闭环，不是运行交付。公共入口由父级/公共owner后续挂接，当前不修改。
