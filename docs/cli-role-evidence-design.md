# file.property.role 用途关系证据合同

状态：2026-10-19 支持性证据合同 READY，设计候选。本文只定义 R（用途关系）单元的证据来源、scope、缺失语义、固定18维逐位抽取、teacher 与独立真值、consumer I/O 与采样接口，以及同名不同用途和多角色反例。READY 仅表示本文的支持类型、有限输入与抽取边界已闭合，不表示用途判断已可训练或可用。本文没有生成样本、运行拟合、接线或实现；候选采用仍为 `not_applied`。R 的数值连线、损失、预算与分区沿[最小单元训练设计](cli-property-training-design.md)第4、6、7节，本文只引用，不复制公式、预算、阈值或采用规则。本文由 file.property owner 授权的支持性证据合同，不修改共享合同、图或代码。

## 1. 范围与复用

- 目标：让 R 的固定18维输入每一位都有唯一、可复核、可缺失的抽取来源，并给出可实施的证据与采样合同。
- 非目标：不新增角色词表、不改变特征数、不定义新 Goal、不新增图、不新增执行引擎、不授权任何 CLI 命令或文件操作。
- 角色词表沿用 R 合同初始词表 `source / test / config / dependency_manifest / documentation / generated / log / media / attachment / backup`；本文不复制、不替换、不扩充。
- 图复用：外层推理图 [cli-file-property.graph.json](../workflows/cli-file-property.graph.json) 的 6N5E 结构不变；训练复用 [cli-filesystem-training.graph.json](../workflows/cli-filesystem-training.graph.json)；升级与冲突沿 [model-evolution.graph.json](../workflows/model-evolution.graph.json) 与 [model-evolution.md](model-evolution.md)。
- 模型输出边界：输出只是属性关系 `matches / nonmatch` 及识别状态 `judged / unknown / conflict`；只有 `judged` 携带 `matches` 或 `nonmatch`，`unknown/conflict` 的 relation 为 `null`。它不是 CLI 命令头、参数选择、操作适用性判断或执行授权。命令选择与操作授权归 B/P/C 单元与 adapter，不因本文改变。

## 2. 四元素与责任分工

本单元沿 [cli-filesystem-semantics.md](cli-filesystem-semantics.md) 第4节「内容/用途判断」行与 [design.md 1.1](design.md#11-结构化语义的目标与状态推理) 实例化同一闭合图，不新建第二套语义。

| 元素 | 本单元内容 | 声明 owner |
| --- | --- | --- |
| Goal | `{kind:"file.property", property:"file.property.role", target:ObjectRef, requirement:{kind:"observed"}}`；target 是明确 scope 内由 owner 绑定的条目引用，一次请求判定一个指定角色关系 | cli-filesystem-semantics.md |
| satisfactionThreshold | 关系判断要求本次观测证据；单次精确关系 0/100，默认 100；不因证据少而放宽或降低 | cli-filesystem-semantics.md |
| State | 版本化 `RoleEvidenceDeclaration`、明确 `RoleEvidenceScope`、target membership、`RoleEvidenceRecord`/`RoleEvidenceGap` 集合及各 `EnumeratorCoverage` | adapter 收集，filters 消费 |
| Action | 固定读取、解码、签名识别、parser、声明引用枚举；不产生 OS 对象修改；得到的关系知识即 New State | adapter / consumer |

学生学习：仅17维证据位到 role logit 的关系；线性位不可分时按设计流程补必要交互 wire。手写且不计入学生：scope 声明、解码器、签名检测、parser、记录枚举、引用绑定、完整性判定、阈值与采样。删除 NN 后确定性 scope、解码、parser 与引用枚举保留，只有角色 logit 消失。预测不替代实际证据，teacher 复核不替代本次实际观测。本节只声明既有 owner 下的设计映射，不新增执行能力。

## 3. 类型化证据来源、scope 与有限抽取

用途关系只在声明的 scope 内判断。`ObjectRef` 的绑定、有效性和相等语义由 [cli-filesystem-semantics.md](cli-filesystem-semantics.md) owner 维护；本文只要求所有 target 与记录端点使用该 typed 引用，不从名称、字符串路径或扩展名重建对象身份，不定义第二套引用类型。

### 3.1 Scope、成员与完整性

```ts
type RoleScopeRef = {
  kind: "role.scope";
  id: string;
  version: string;
};

type EnumeratorRef = {
  kind: "enumerator";
  id: string;
  version: string;
};

type EvidenceSourceRef =
  | { kind: "object"; object: ObjectRef }
  | { kind: "contentRange"; object: ObjectRef; start: number; endExclusive: number }
  | { kind: "recordRange"; enumerator: EnumeratorRef; rangeId: string }
  | { kind: "receipt"; receiptId: string };

type RoleEvidenceScope = {
  ref: RoleScopeRef;
  root: ObjectRef;
  targetMembership: ScopeMembershipEvidence;
  enumerators: EnumeratorRef[];
  completeness: EnumeratorCoverage[];
};

type ScopeMembershipEvidence =
  | {
      target: ObjectRef;
      state: "member" | "nonmember";
      via: "rootEntry" | "enumerator";
      enumerator?: EnumeratorRef;
      source: EvidenceSourceRef;
    }
  | {
      target: ObjectRef;
      state: "not_observed";
      reason: "unsupported" | "staleRef" | "incompleteEnumeration" | "notObserved";
      enumerator?: EnumeratorRef;
      source?: EvidenceSourceRef;
    };

type EnumeratorCoverage = {
  enumerator: EnumeratorRef;
  extent:
    | { kind: "rootDirectEntries"; root: ObjectRef }
    | { kind: "recordRange"; rangeId: string };
  availability: "complete" | "partial" | "unavailable";
  source?: EvidenceSourceRef;
};
```

scope 成员证据必须直接给出 target 为 `member`、`nonmember` 或 `not_observed`，并绑定依据来源。只有 scope 中声明的枚举器完整覆盖对应 `rootDirectEntries` 或 `recordRange` 时，`nonmember` 或记录的 `value=false` 才可使用；`partial`、`unavailable`、scope 外记录和失效引用都不能变成反例。`enumerators` 是声明引用，`completeness` 是本次观测证据，两者不能用一个布尔值互代。

### 3.2 有限输入的关系证据

每条证据记录只描述一个关系位，不含 role 真值、正负训练标签或命令授权。`value=true` 对应位 1，`value=false` 对应位 0；无法执行、未观测、范围不完整或 family 不支持时，不得生成 `value=false`，必须生成对应 `RoleEvidenceGap`。

```ts
type ContentInterval = {
  target: ObjectRef;
  start: number;
  endExclusive: number;
  reachedEof: boolean;
};

type DeclaredFamilyRef = {
  family: string;
  version: string;
};

type RecordSignatureRef = {
  id: string;
  version: string;
};

type RecordEvidenceRelation =
  | "producerRecorded"
  | "consumerRecorded"
  | "buildInputEdge"
  | "testInputEdge"
  | "runtimeLoadEdge"
  | "userAttachmentEdge"
  | "historyCopyEdge"
  | "buildOutputEdge"
  | "dependencySectionEdge"
  | "appendTraceEdge"
  | "declaredMediaUseEdge"
  | "declaredBackupUseEdge";

type RecordEvidenceObservation<
  R extends RecordEvidenceRelation,
  S extends string
> = {
  relation: R;
  input: { enumerator: EnumeratorRef; signature: { id: S; version: string } };
  extraction: "completeEnumerationMatch";
  value: boolean;
};

type RoleEvidenceObservation =
  | {
      relation: "textDecodable";
      input: { interval: ContentInterval; decoder: DeclaredFamilyRef };
      extraction: "strictDecodeToEof";
      value: boolean;
    }
  | {
      relation: "structuredParseValid";
      input: { interval: ContentInterval; parser: DeclaredFamilyRef };
      extraction: "strictWholeTextParseToEof";
      value: boolean;
    }
  | {
      relation: "codeSyntaxRecognized";
      input: { interval: ContentInterval; recognizers: DeclaredFamilyRef[] };
      extraction: "finiteRecognizerSetAcceptance";
      value: boolean;
    }
  | {
      relation: "mediaSignature";
      input: { interval: ContentInterval; signatureFamilies: DeclaredFamilyRef[] };
      extraction: "finiteSignatureSetMatch";
      value: boolean;
    }
  | RecordEvidenceObservation<"producerRecorded", "producer.record">
  | RecordEvidenceObservation<"consumerRecorded", "consumer.record">
  | RecordEvidenceObservation<"buildInputEdge", "build.input.edge">
  | RecordEvidenceObservation<"testInputEdge", "test.input.edge">
  | RecordEvidenceObservation<"runtimeLoadEdge", "runtime.load.edge">
  | RecordEvidenceObservation<"userAttachmentEdge", "user.attachment.edge">
  | RecordEvidenceObservation<"historyCopyEdge", "history.copy.edge">
  | RecordEvidenceObservation<"buildOutputEdge", "build.output.edge">
  | RecordEvidenceObservation<"dependencySectionEdge", "dependency.section.edge">
  | RecordEvidenceObservation<"appendTraceEdge", "append.trace.edge">
  | RecordEvidenceObservation<"declaredMediaUseEdge", "media.use.edge">
  | RecordEvidenceObservation<"declaredBackupUseEdge", "backup.use.edge">
  | {
      relation: "documentationStructure";
      input: { interval: ContentInterval; parsers: DeclaredFamilyRef[] };
      extraction: "finiteDocumentParserSetAcceptance";
      value: boolean;
    };

type RoleEvidenceRecord = {
  scopeRef: RoleScopeRef;
  target: ObjectRef;
  observation: RoleEvidenceObservation;
  source: EvidenceSourceRef;
  collector: string;
  collectedAt: string;
};

type RoleEvidenceGap = {
  scopeRef: RoleScopeRef;
  target: ObjectRef;
  relation: RoleEvidenceRelation;
  availability: "unavailable";
  reason:
    | "unsupported"
    | "notObserved"
    | "partialInterval"
    | "incompleteEnumeration"
    | "invalidInput";
  enumerator?: EnumeratorRef;
  source?: EvidenceSourceRef;
};

type RoleEvidenceRelation =
  | "textDecodable" | "structuredParseValid" | "codeSyntaxRecognized" | "mediaSignature"
  | "documentationStructure"
  | RecordEvidenceRelation;
```

每种输入只接受表中列出的 typed 字段，不接受脚本、正则、任意 glob、自由文本或隐式全盘扫描。filters 只把 `RoleEvidenceRecord`、对应 `EnumeratorCoverage` 与 `RoleEvidenceGap` 转成固定位的 availability 和值；记录端点与来源真实性由 adapter/consumer 的证据回执保证。

### 3.3 Record signature 与 broad/specific 边界

以下签名是证据记录的最小判定形状，不是新运行时能力。现有 adapter/consumer 只能从已声明来源产生这些记录；未提供对应来源时写 `RoleEvidenceGap`，不新增服务、目录或注册表。

```ts
type RecordEnvelope = {
  recordId: string;
  scopeRef: RoleScopeRef;
  enumerator: EnumeratorRef;
  evidenceSource: EvidenceSourceRef;
};

type ProducerRecord = RecordEnvelope & {
  signature: "producer.record@1";
  producer: ObjectRef;
  output: ObjectRef;
  operation: "write" | "create" | "generate";
};

type ConsumerRecord = RecordEnvelope & {
  signature: "consumer.record@1";
  consumer: ObjectRef;
  input: ObjectRef;
  operation: "read" | "load" | "execute";
};

type BuildInputEdgeRecord = RecordEnvelope & {
  signature: "build.input.edge@1";
  buildTask: ObjectRef;
  input: ObjectRef;
};

type TestInputEdgeRecord = RecordEnvelope & {
  signature: "test.input.edge@1";
  testTask: ObjectRef;
  input: ObjectRef;
};

type RuntimeLoadEdgeRecord = RecordEnvelope & {
  signature: "runtime.load.edge@1";
  loader: ObjectRef;
  loaded: ObjectRef;
};

type UserAttachmentEdgeRecord = RecordEnvelope & {
  signature: "user.attachment.edge@1";
  attachmentSet: ObjectRef;
  attachment: ObjectRef;
};

type HistoryCopyEdgeRecord = RecordEnvelope & {
  signature: "history.copy.edge@1";
  copyEvent: ObjectRef;
  source: ObjectRef;
  destination: ObjectRef;
};

type BuildOutputEdgeRecord = RecordEnvelope & {
  signature: "build.output.edge@1";
  buildTask: ObjectRef;
  output: ObjectRef;
};

type DependencySectionEdgeRecord = RecordEnvelope & {
  signature: "dependency.section.edge@1";
  manifest: ObjectRef;
  dependency: ObjectRef;
};

type AppendTraceEdgeRecord = RecordEnvelope & {
  signature: "append.trace.edge@1";
  writer: ObjectRef;
  output: ObjectRef;
  writeMode: "append";
};

type MediaUseEdgeRecord = RecordEnvelope & {
  signature: "media.use.edge@1";
  container: ObjectRef;
  media: ObjectRef;
  use: "image" | "audio" | "video" | "font" | "otherDeclared";
};

type BackupUseEdgeRecord = RecordEnvelope & {
  signature: "backup.use.edge@1";
  backupRecord: ObjectRef;
  entry: ObjectRef;
  endpoint: "source" | "destination";
};
```

边界固定如下：

- `producerRecorded` 只消费 `producer.record@1` 中 `output=target` 的直接写入/创建/生成记录；`consumerRecorded` 只消费 `consumer.record@1` 中 `input=target` 的直接读取/加载/执行记录。它们是弱来源关系，不能从 role 分数、内容格式或某个具体构建边反推。
- `buildInputEdge`、`testInputEdge`、`runtimeLoadEdge` 分别消费 `build.input.edge@1`、`test.input.edge@1`、`runtime.load.edge@1`。构建输入声明不自动等于 broad consumer 记录；只有记录同时给出 consumer、input 与 read/load/execute 字段并满足 `consumer.record@1` 时，才可另生成 broad consumer 证据。反向亦然。
- `historyCopyEdge` 在 target 是该复制事件的 source 或 destination 时为真；`appendTraceEdge` 只在 target 是 `writeMode=append` 的输出时为真，普通日志存在或一次覆盖写不算。
- `declaredMediaUseEdge` 只来自显式 media-use 声明，media signature 是内容位，不能替代声明；`declaredBackupUseEdge` 只来自显式 backup 记录，history copy 也不能替代 backup 用途。
- `buildOutputEdge`、`dependencySectionEdge` 与 broad producer/consumer 各自保留独立字段。一个原始记录可以因字段完整同时支撑多个位，但每个位必须由对应签名单独验证，不能因“同一来源”自动复制。

同一个 `history.copy.edge@1`、`append.trace.edge@1`、`media.use.edge@1` 或 `backup.use.edge@1` 在 target 不匹配时仍可保留为 scope 证据，但不能把该位写成 `value=false`；只有对应枚举器完整时才可给出无匹配的 0。

### 3.4 已声明 family 与 concrete declaration

decoder、结构化 parser、代码语法识别器、媒体签名和文档结构 parser 都只能从声明中的有限 family 集合选择。任何未列出、版本不匹配或无法执行的 family 返回 `unsupported` gap，绝不以 0 表示“没有匹配”。`codeSyntaxRecognized`、`mediaSignature` 与 `documentationStructure` 要产生 0，至少需要一个已声明 family 对完整范围实际执行且全部拒绝；空集合不是全格式否定。

```ts
type EnumeratorDeclaration = {
  ref: EnumeratorRef;
  inputKind:
    | "rootDirectEntries"
    | "manifestRecords"
    | "historyRecords"
    | "userAttachmentRecords"
    | "useDeclarations";
  sourceFamily: DeclaredFamilyRef;
  recordSignatures: RecordSignatureRef[];
};

type RoleEvidenceDeclaration = {
  schemaVersion: "role-evidence/1";
  declaration: { kind: "role.evidence.declaration"; id: string; version: string };
  scopeRef: RoleScopeRef;
  root: ObjectRef;
  enumerators: EnumeratorDeclaration[];
  decoders: DeclaredFamilyRef[];
  structuredParsers: DeclaredFamilyRef[];
  syntaxRecognizers: DeclaredFamilyRef[];
  mediaSignatures: DeclaredFamilyRef[];
  documentParsers: DeclaredFamilyRef[];
};
```

具体最小声明示例如下。`projectRootObjectRef` 必须替换为 owner 绑定的真实 `ObjectRef`；示例只声明 UTF-8、JSON、PNG 与 Markdown 标题，不声称覆盖其他编码、格式或媒体族。该值是随现有 request/profile/state 绑定传递的版本化配置，不建立新存储目录、注册表或采集服务。

```ts
const minimalRoleEvidenceDeclaration: RoleEvidenceDeclaration = {
  schemaVersion: "role-evidence/1",
  declaration: {
    kind: "role.evidence.declaration",
    id: "sample-cli-project-role-evidence",
    version: "1"
  },
  scopeRef: { kind: "role.scope", id: "sample-cli-project", version: "1" },
  root: projectRootObjectRef,
  enumerators: [
    {
      ref: { kind: "enumerator", id: "project-direct-entries", version: "1" },
      inputKind: "rootDirectEntries",
      sourceFamily: { family: "directory.list.structured", version: "1" },
      recordSignatures: []
    },
    {
      ref: { kind: "enumerator", id: "project-record-range", version: "1" },
      inputKind: "manifestRecords",
      sourceFamily: { family: "declaredRecordRange", version: "1" },
      recordSignatures: [
        { id: "producer.record", version: "1" },
        { id: "consumer.record", version: "1" },
        { id: "build.input.edge", version: "1" },
        { id: "test.input.edge", version: "1" },
        { id: "runtime.load.edge", version: "1" },
        { id: "history.copy.edge", version: "1" },
        { id: "build.output.edge", version: "1" },
        { id: "dependency.section.edge", version: "1" },
        { id: "append.trace.edge", version: "1" },
        { id: "media.use.edge", version: "1" },
        { id: "backup.use.edge", version: "1" }
      ]
    }
  ],
  decoders: [{ family: "utf8.strict", version: "1" }],
  structuredParsers: [{ family: "json.strict", version: "1" }],
  syntaxRecognizers: [],
  mediaSignatures: [{ family: "png.signature", version: "1" }],
  documentParsers: [{ family: "markdown.heading", version: "1" }]
};
```

`declaration.version`、`scopeRef.version`、family version 与 record signature version 共同组成可读配置身份；它们不是哈希、冻结快照或候选身份绑定。不同 scope 可使用不同最小 family 集，但 profile 不得把一个声明中的 family 或 signature 自动用于另一个声明。

scope、coverage、record 与 gap 中出现的每个 `RoleScopeRef`、`EnumeratorRef`、decoder/parser/signature family 和 record signature 都必须在本次 `RoleEvidenceDeclaration` 中按 id 与 version 唯一解析。重复定义、缺失定义或版本不一致返回 `unsupported` gap 或明确输入缺口，不选择最近的声明，也不建立跨声明搜索。

## 4. 缺失语义与完整性

每个位的值来自 `RoleEvidenceRecord.observation`，可用性来自本次 scope/证据观测。缺失规则沿 [design.md](design.md) 第5节 `FeatureSchema` 的 availability 语义：值和 availability 分开；不可用位置保留为 missing，不写 0、不补中性值、不传 NaN/Infinity。本文不把 17 个输入统一声明为 required。

- `value=true` 只在记录满足该关系的有限输入、完整性要求和已声明 family 时映射为 1。
- `value=false` 只在该关系的完整范围或完整枚举已实际执行并确认无匹配时映射为 0。
- `RoleEvidenceGap.availability="unavailable"`、`partial` coverage、未执行、unsupported family、非完整内容区间或 scope 外记录对应 missing；不得把缺失解释为“无关系”。
- 同类关系出现 `value=true` 与 `value=false` 的相反记录时，保留全部原始记录，不取多数、不按记录数量投票。filters 可暴露 `conflictPresent=true`，但 R 输出状态与最终 `matches/nonmatch` 由 R owner 合同决定。

完整性证据属于收集 owner：内容类关系要求目标 `ContentInterval` 已到 EOF，并覆盖该记录声明的完整区间；记录类关系要求对应 `EnumeratorCoverage.availability="complete"`。`partial`、`unavailable` 或缺失枚举器都不是 0。

输入 missing 不等于输出 `unknown`。本文不增加“任意位缺失即 unknown”的前置守卫，也不要求全部 17 位可用；R owner 尚未列出每 role 的必要关系集合，因此该集合是第10节列明的未决 owner 决定，不能从本文位值自行发明。`unknown` 与 `conflict` 的 Response 关系都为 `null`。

## 5. 固定18维逐位抽取定义

向量与参数总数固定：含常量项共18维，逐 role 共18个参数（17位加常量项权重），与 [R 合同](cli-property-training-design.md)第4节完全一致，不新增、不删除特征。顺序严格如下，且不得重排。

| 序 | 特征位 | 有限输入（typed） | =1 | =0（要求完整范围/完整枚举） | unavailable（availability=false） |
| ---: | --- | --- | --- | --- | --- |
| 0 | `1` | 无 | 恒为 1 | 不适用 | 无缺失语义 |
| 1 | `textDecodable` | `{interval, decoder}` | 完整区间到 EOF 且 strict decoder 接受 | 完整区间到 EOF 且 strict decoder 拒绝 | 未到 EOF、区间不完整或 decoder 未声明/不支持 |
| 2 | `structuredParseValid` | `{interval, parser}` | 已解码全文被声明的 strict parser 接受 | 已解码全文被声明的 parser 拒绝 | 文本不可解码、parser 未声明/不支持或未执行 |
| 3 | `codeSyntaxRecognized` | `{interval, recognizers[]}` | 已解码全文被任一已声明 recognizer 接受 | 非空已声明集合已执行且全部拒绝 | 文本不可解码、集合为空、family 不支持或未执行 |
| 4 | `mediaSignature` | `{interval, signatureFamilies[]}` | 完整区间匹配任一已声明媒体签名 | 完整区间已执行且非空已声明集合均不匹配 | 区间未到 EOF、集合为空或 family 不支持 |
| 5 | `producerRecorded` | `{enumerator, producer.record@1}` | 存在 `output=target` 的直接 producer 记录 | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 6 | `consumerRecorded` | `{enumerator, consumer.record@1}` | 存在 `input=target` 的直接 consumer 记录 | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 7 | `buildInputEdge` | `{enumerator, build.input.edge@1}` | 存在显式 build input 边且 `input=target` | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 8 | `testInputEdge` | `{enumerator, test.input.edge@1}` | 存在显式 test input 边且 `input=target` | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 9 | `runtimeLoadEdge` | `{enumerator, runtime.load.edge@1}` | 存在运行时加载记录且 `loaded=target` | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 10 | `userAttachmentEdge` | `{enumerator, user.attachment.edge@1}` | 存在用户附件声明且 `attachment=target` | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 11 | `historyCopyEdge` | `{enumerator, history.copy.edge@1}` | 存在复制事件且 target 是 source 或 destination | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 12 | `buildOutputEdge` | `{enumerator, build.output.edge@1}` | 存在构建输出记录且 `output=target` | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 13 | `dependencySectionEdge` | `{enumerator, dependency.section.edge@1}` | 依赖声明段落显式命名 target | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 14 | `documentationStructure` | `{interval, parsers[]}` | 已解码全文被任一已声明文档 parser 接受 | 非空已声明集合已执行且全部拒绝 | 文本不可解码、集合为空、family 不支持或未执行 |
| 15 | `appendTraceEdge` | `{enumerator, append.trace.edge@1}` | 存在 `writeMode=append` 且 `output=target` 的写者记录 | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 16 | `declaredMediaUseEdge` | `{enumerator, media.use.edge@1}` | 存在显式媒体用途声明且 `media=target` | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |
| 17 | `declaredBackupUseEdge` | `{enumerator, backup.use.edge@1}` | 存在显式备份用途记录且 target 为 source 或 destination | 完整记录枚举无此边 | enumerator 未声明、未收集或 coverage 非 complete |

已核对：本表特征行共18行（序 0–17），17个非恒定特征加 1 个常量项；与 R 合同列出的 `[1,textDecodable,structuredParseValid,codeSyntaxRecognized,mediaSignature,producerRecorded,consumerRecorded,buildInputEdge,testInputEdge,runtimeLoadEdge,userAttachmentEdge,historyCopyEdge,buildOutputEdge,dependencySectionEdge,documentationStructure,appendTraceEdge,declaredMediaUseEdge,declaredBackupUseEdge]` 同名同序同数。`producerRecorded/consumerRecorded` 是「存在生产者/消费者记录」的弱关系，不与 `buildInputEdge/buildOutputEdge/runtimeLoadEdge` 等具体边互相替换；`buildOutputEdge`、`appendTraceEdge`、`dependencySectionEdge` 分别保留生成物、日志与依赖声明的可辨依据。所有位都不接受 teacher 的 `isSource/isConfig` 顶点结论。

## 6. teacher 与独立真值

两类信息必须分开：

- 证据抽取：内容类位的唯一来源是声明中的固定 decoder、signature detector 与 parser；记录类位的唯一来源是已声明 enumerator 中符合签名的记录。抽取只产生 `RoleEvidenceRecord` 的 `value` 或 `RoleEvidenceGap`，不产生 role 真值，也不产生 `isSource/isConfig`。
- 关系真值：某个 role 的 `matches/nonmatch` 由独立复核的实际用途给出。复核者只依据收集到的证据与真实使用，不把抽取结果、学生输出、路径名或扩展名当作真值。无足够证据区分某 role 时返回 `unknown`，不降低阈值或假装全部条目可分类。

训练与验证分开：训练真值由作者按本合同复核，独立验证真值由不同作者、不同 scope 家族、不同记录配方产生；用于调参或改连线的验证转为开发/回归证据，另留未见的独立批次。negative 只能是已复核的相反角色，不从「未命中」或 `unknown` 自动补负。真值记录保留 `truth = true/false/unknown` 与复核状态，`unknown` 不进强监督行。

必要证据与结果状态的 owner 分工如下。本文只闭合“一个关系位如何从有限输入得到 value 或 gap”，不替 R owner 定义每 role 的完整判定。

| 决定 | owner | 当前状态 |
| --- | --- | --- |
| target、scope、成员与 `ObjectRef` 有效性 | [cli-filesystem-semantics.md](cli-filesystem-semantics.md) | 已引用，本文不重定义 |
| 每个关系位的有限输入、完整性、value/gap 与冲突暴露 | 本文 | READY |
| 每个 role 的必要关系集合、availability 组合及 unknown/conflict 判定 | [cli-property-training-design.md](cli-property-training-design.md) R 合同 | 未列明，见第10节唯一 owner 缺口 |
| 使用采样、复核、训练、评价与采用 | [model-evolution.md](model-evolution.md) | 已引用，本文不复制算法或门槛 |

因此，任何 role 都不能从本文 17 位自行推导“独立真值”。在 R owner 补齐必要关系集合前，adapter/consumer 可以按本支持合同采集证据，但不能宣称该 role 的完整决策合同已可实施或已训练。

## 7. consumer I/O 与采样接口

请求与响应沿既有节点合同，不新增执行引擎；采样 `owner` 是 adapter/consumer，写入既有 `training/samples/` 目录，不新增根目录或第二套台账。

```text
Request  { goal: {kind:"file.property", property:"file.property.role",
                  target: ObjectRef, requirement:{kind:"observed"}},
           role: RoleKey, scope: RoleEvidenceScope,
           declaration: RoleEvidenceDeclaration,
           satisfactionThreshold: 100, state: ExplicitFileState }
Response { role, relation: "matches" | "nonmatch" | null,
           state: "judged" | "unknown" | "conflict",
           satisfaction: 100 | 0 | null,
           features: {order: 18, values, availability},   // availability 与值分离
           evidence: RoleEvidenceRecord[], gaps: RoleEvidenceGap[],
           calibration: "uncalibrated" }
```

一次请求判定一个 `role`；多角色使用多次独立请求，不做互斥单标签。`judged` 才携带确定关系；`unknown/conflict` 的 `relation=null`，`satisfaction=null`，并保留候选证据。`availability` 与值分离，缺失位不得补 0。响应只携带属性关系与证据，不带命令、argv、操作或授权字段。采样记录复用 [design.md](design.md) 第5节的 `OperationSample`，追加角色请求、声明身份、当时的 `RoleEvidenceScope` 与枚举器完整性、`RoleEvidenceRecord`/`RoleEvidenceGap` 集合、双作者复核状态与实际使用证据；不允许 filter 自己写文件或 core 解释领域数据。采样失败显式记录，不因采样失败改写未受影响的业务结果。

## 8. 同名不同用途与多角色反例

以下反例用于验证可辨性、缺失语义与不泄漏教师标签；它们是设计反例，不表示已有样本或准确率。

| 反例 | 输入差异 | 期望关系与向量 | 判定 |
| --- | --- | --- | --- |
| 运行配置 vs 测试夹具 | 同名字 `config.json`，同字节，不同 scope 子目录 | `runtimeLoadEdge` 与 `testInputEdge` 位不同；truth 分别为 config 与 test | 两行必须在边位可分；若向量相同则记特征缺口，不用路径名补位 |
| 文档 README vs 测试 README | 同名 `README.md`，同为文档结构 | `documentationStructure` 相同，`testInputEdge` 不同 | 名称相同，role 由边证据区分 |
| 页面媒体 vs 用户附件 | 同字节 `logo.png` | `declaredMediaUseEdge` 与 `userAttachmentEdge` 位不同 | media 与 attachment 分别判定 |
| 生成配置（多角色） | `buildOutputEdge` 与 `runtimeLoadEdge` 同时成立 | 两位同时为 1；generated 与 config 同时可为真 | 逐 role BCE，不互斥、不逐位相乘 |
| 依赖清单兼文档（多角色） | `dependencySectionEdge` 与 `documentationStructure` 同时成立 | 两位同时为 1 | dependency_manifest 与 documentation 分别判定 |
| 记录枚举器缺失 | 构建记录枚举器未声明或未收集 | 该位 availability=false、值为 missing | 与已穷尽无边的 `=0` 对照；role 是否 unknown 只由 R owner 必要证据规则决定，不设全输入门 |
| 仅名称不同 | 两条目除名称外无证据差异，truth 却不同 | 各位相同 | 报告可辨性缺口，禁止引入名称/扩展名启发式 |

多角色不得合并成单标签；同一事实可在多个 role 为真，冲突按关系冲突处理。反例显示线性位不可分时，先按 [design.md 1.1](design.md#11-结构化语义的目标与状态推理) 与本地设计流程补必要交互 wire，再实现、训练与独立验证；不能以 teacher 运行时接管或名称规则绕过。

## 9. 数值、分区与采用（引用）

- 数值连线：逐 role 线性乘加与 BCE、Handwired 内图、SGD 与梯度路径沿 [cli-property-training-design.md](cli-property-training-design.md) 第4节，本文不重复。
- 分区：`train / dev / verification` 的来源家族先划用途再生成、同模板换名不跨分区、独立作者配方，沿同文件第6节与第7节。
- 采用：候选与当前隔离、独立配对比较、旧能力无回归才升级、冲突保留并交大模型裁决，沿 [model-evolution.md](model-evolution.md) 与 [model-evolution.graph.json](../workflows/model-evolution.graph.json)。角色阈值只用开发集预定并保持 `uncalibrated`，它不是 `satisfactionThreshold`。

## 10. 可实施最小步骤与剩余缺口

本支持性证据合同 READY。下列步骤仍只描述实现顺序，不表示已有样本、拟合、接线、运行入口或训练结果。

可实施最小步骤，按序且不扩范围：

1. adapter/consumer 按现有 request/profile/state 绑定提供 `RoleEvidenceDeclaration`、`RoleEvidenceScope`、membership、coverage、records 与 gaps；未声明 family 或未收集枚举器显式输出 unavailable。
2. filters 实现 `RoleEvidenceRecord`/`RoleEvidenceGap`/`EnumeratorCoverage` → 18维向量 + availability 的纯函数抽取，顺序锁定为第5节表序，常量项固定 1。
3. 用第8节反例构造开发集配方，验证边位可分、missing 保持 availability=false、相反证据保留 conflict，无名称泄漏；开发集不选阈值，阈值只按 R 合同预定。
4. 在 R owner 补齐必要关系集合后，才按 R 与训练合同实现拟合、保存候选、回载与独立验证；候选保持 `not_applied`，采用与冲突沿 model-evolution。

剩余 owner 缺口只有一项：

- [cli-property-training-design.md](cli-property-training-design.md) 第4节尚未列出每个 role 对应的必要关系集合、availability 组合规则以及 unknown/conflict 的最终判定规则。它目前只声明“缺必需关系保留 unknown”，未说明哪些关系必需，也未定义不可用位置如何影响该 role。该决定属于 R owner；本文不能从 17 位自行发明，也不能用全输入 required 或相反证据多数替代。

ObjectRef 的具体形状、有效性、寿命与相等判断继续由 [cli-filesystem-semantics.md](cli-filesystem-semantics.md) owner 维护。声明存储不另定目录：它作为现有 request/profile/state 绑定中的版本化值传递。复核者身份、样本存储与双作者分区沿 [model-evolution.md](model-evolution.md) 与既有 `OperationSample`，本文不建立第二套流程。

以上唯一 owner 缺口不阻断本文作为支持性证据合同使用；它阻断任何 role 的训练、独立验证和采用声明，未补齐前不得宣称某 role 已可判断或已训练。
