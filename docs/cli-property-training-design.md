# file.property 最小单元训练设计

状态：2026-10-19 设计合同；P3 的 sessionCwd observed/equals 与 directory.entries observed 已接入运行入口并真实拟合。本页其余 P1/P2/P4/P5/P6、B 与 R 仍为设计，单元不能因本页存在就标为已训练。所有命令/操作选择只使用[文件系统训练合同](cli-filesystem-training.md)§2的同一`cli.command-policy.v1`共享矩阵；P1-P6只是样本/统计/效果分组。B对象关系与R用途关系是独立概念模型；C组合下一步若选命令，复用同一共享矩阵。特殊文件只训练观测/拒绝关系，不学习未定义设备协议。语义和命令方案分别沿 [属性合同](cli-filesystem-semantics.md) 与 [固定调用设计](cli-command-design.md)。

## 1. 四元素与分工

每个单元采用 `{goal:{kind:"file.property",target,property,requirement},satisfactionThreshold,state}`。反向推理只在训练设计/样本阶段：从达标属性条件反推可接受的操作效果、参数角色和前置State。实际New State与Goal评价由固定执行/独立观测给出。policy分数不表示满足度。单属性精确观测/修改的满意度为0/100；阈值取1..100时达标条件相同，不制造90%的精确写入成功；阈值0仍须有必要证据及Goal必要条件，不能跳过本次观测。

学生学习以下函数；B与R各自独立权重/损失，P与C共用同一共享命令策略矩阵与同一softmax/CE损失：

| 单元 | 学习内容 | 手写基础/执行者 |
| --- | --- | --- |
| B 对象关系绑定 | 候选是否符合明确的类型/名称/父目录或session关系 | 引用合法性、符号相等计算、实际候选观测与集合消歧 |
| P 属性效果策略 | 给定Goal/State选必要操作、NOOP或DEFER | typed Goal编码、相等/范围等基础比较、操作授权及OS执行 |
| R 用途关系 | 在明确证据范围内判断指定用途关系 | 实际读取、格式解析、声明引用和局部关系取参 |
| C 组合下一步 | 从明确前沿和依赖状态选择必要的下一原语/结束/缺口 | 实际树枚举、范围/预算、已有runner、结果保存 |

格式UTF8/JSON解析、stat类型、路径分解/relative、权限检查、Bytes复制及stdout协议解码均为固定基础，不为复述已知标签另训模型。已有path.resolve符号控制器、PWD策略及CWD/CD/LIST设计复用，新增兼容接口需做回归；本页不替换已交付结果或直接改profile名称。操作适用性以类型与操作合同确定，没有需学习的新关系则保持确定性。

## 2. B：候选对象及参数角色

目录/file.select沿旧3关系结构：`x=[1,nameEqual,typeEqual,parentEqual]`，4参数 `z=w·x`，宿主BCE、Handwired求梯度；输入任一必要关系缺测，输出unknown不进完整监督行。8种0/1组合全覆盖，teacher为三条件合取，不在推理时覆写学生输出。file与directory目标类型在构造typeEqual时显式传入，分别保存/评估兼容profile；不能直接声称旧directory权重跨类型有效。B是概念关系模型，不输出命令head，不参与`cli.command-policy.v1`的head选择。

sessionCwd关系复用CWD设计 `[1,sameSession,hasObservation]` 的2×3参数。多角色Action的source/destination/parent/session分别调用相应关系判别：每个参数角色都是独立查询，禁止用候选顺序/最高分猜。目录创建没有已存在目标，绑定已知parent与精确Name，不能强迫B生成不存在对象。操作给定明确参数引用时只做typed绑定，不重复训练复制字符串。

学生输出逐候选关系，集合resolver只有唯一确定匹配且必要覆盖完整才选中；无匹配且覆盖完整为not_found，矛盾观测invalid_input，缺覆盖/unknown为insufficient_evidence。扩到跨父目录宽选择器时多匹配返回ambiguous，不沿用单父名称唯一假设。teacher关系、可执行器拒绝与模型正确率分别统计。

独立反例：同名异目录、同目录异类型、文件伪目录扩展名、symlink与目标、过期session观测、角色互换、创建目标误绑定成已有文件。原始名称/路径只供绑定和证据，学生只见明确关系值，不含teacher匹配结果。

## 3. P：同一共享命令策略矩阵（P1-P6为样本分组）

### 3.1 唯一owner与禁用平行selector

不训练任意命令生成器，也不为每个操作族建立独立profile。所有命令/操作选择由[文件系统训练合同](cli-filesystem-training.md)§2.1-2.4的同一`cli.command-policy.v1`共享矩阵承担：同一head词表、同一wire顺序、同一softmax与CE。P1-P6不是部署单元，只是样本、统计与效果分组；prepare不按P族路由到独立selector，不按族过滤logits或硬mask，不保存P族候选。B对象关系与R用途是两个独立概念模型，它们不输出命令head；C组合下一步若选命令，同样使用这一共享矩阵。

当前运行schema登记 P3 的 2 个 property、3 个 predicate、4 个 state 位与 1 个交互项，并同时登记 `unsupported/DEFER/NOOP/pwd/cd/ls` 六个 head，见[文件系统训练合同](cli-filesystem-training.md)§0.1；本页其余 P 组头/块仍是设计，不是已接入模型。

下表只列各P组的样本覆盖与反例重点，不含K、F或参数数，不构成独立矩阵。

| 分组 | property样本覆盖 | predicate样本覆盖 | 共享head覆盖 | 反例重点 |
| --- | --- | --- | --- | --- |
| P1 路径词法/物理 | `file.property.path.absolute/relative/parent/name/physical` | `observe.absolute/relative/parts/physical` | `path.resolve/relative/parts/realpath` | 词法与物理不可互换；复用已有`path.resolve`训练 |
| P2 存在/类型/元数据/链接 | `file.property.exists/type/size/mode/owner/times/link.target/links` | `observe.inspect`、`observe.resolvedTarget` | `entry.inspect`、`path.realpath` | 拒权不等于不存在；`nlink`缺测不补0 |
| P3 cwd与目录选择 | `file.property.relation.sessionCwd`、`file.property.directory.entries` | `observe.sessionCwd`、`equals.sessionCwd`、`observe.entries`、`select.entry` | 复用`pwd/cd/ls`，新增`directory.select/file.select` | S/D不可交换；候选类型可辨 |
| P4 创建/移动/删除/链接 | `file.property.exists/path.name/path.parent/link.target/links` | `exists.true/false`、`name.equals`、`parent.equals`、`linkText.equals`、`hardLink.sameObject` | `directory.create/file.create/link.create/file.link/entry.move/entry.remove` | rename与move同head；create不覆盖；目标类型可辨 |
| P5 字节与长度 | `file.property.content.bytes`、`file.property.size` | `observe.range`、`equals.bytes`、`patch.bytes`、`append.suffix`、`equals.length`、`copy.bytes` | `file.read/replace/write/append/truncate/copy` | 不接受任意options；整文件与局部字节分别监督 |
| P6 元数据设置 | `file.property.mode/owner/times` | `equals.mode`、`equals.owner`、`equals.times` | `entry.mode.set/owner.set/times.set` | 缺必要参数或要求设置ctime/birthtime时返回缺口 |

该表是[固定调用设计](cli-command-design.md)25个精确operation的样本分组视图；25个head到operation的唯一映射、调用输出和typed参数由[文件系统训练合同](cli-filesystem-training.md)§2.2维护，本页不复制第二份部署表。

### 3.2 全局词表与固定顺序

共享矩阵的wire顺序和维度公式唯一维护在[文件系统训练合同](cli-filesystem-training.md)§2.1。本页只声明各块来源：

- legacy块：`bias`、`goalObserveCwd`、`goalSetCwd`、`goalListDirectory`原样保留在最前。
- property块：按[属性合同](cli-filesystem-semantics.md)第2节目录次序，只注册当前阶段实际使用的属性；旧P族局部property one-hot合并为这一全局块，同name只保留一次。
- predicate块：按下面predicate表的P1→P6次序，只注册当前阶段实际使用的predicate；旧P族局部`oneHot(requirement variant)`并入predicate块，不再单独复制一列。
- selectorTargetType块：3维，只在阶段含`select.entry`类predicate时整块注册。
- requiredTargetType块：4维，只在阶段含P4目标类型条件时整块注册。
- observedType块：9维，只在阶段需要实际观测类型时整块注册。
- state块与interaction：逐条按阶段需要注册。
- combination块：22维（7 predicate + 15 state），只在C阶段注册。

同一阶段所有P1-P6行共享同一wire顺序和同一F；不再存在"每族F不同"的局部矩阵。某个property/predicate对不在注册表时返回`unsupported`，不路由到另一个族。

所有predicate标签都从`goal.kind="file.property"`的typed Goal及其`property`、`requirement`取值；下表给出唯一来源，不从head、teacher可接受集合、扩展名或候选反推。`observed`查询也必须保留Goal的property，不以head名代替。P组只用于样本/统计归属，不是部署路由。

| predicate标签 | typed Goal来源（P组为样本分组） |
| --- | --- |
| `observe.absolute` | P1：`property=file.property.path.absolute`，`requirement.kind=observed` |
| `observe.relative` | P1：`property=file.property.path.relative`，`requirement.kind=observed` |
| `observe.parts` | P1：`property=file.property.path.parent`或`file.property.path.name`，`requirement.kind=observed` |
| `observe.physical` | P1：`property=file.property.path.physical`，`requirement.kind=observed` |
| `observe.inspect` | P2：`property`为P2组8项之一，`requirement.kind=observed`；实际类型、存在性、长度、元数据、链接文本和链接关系分别由property选定 |
| `observe.resolvedTarget` | P2：`property=file.property.link.target`，`requirement.kind=matches`且声明typed predicate`resolvedTarget` |
| `observe.sessionCwd` | P3：`property=file.property.relation.sessionCwd`，`requirement.kind=observed` |
| `equals.sessionCwd` | P3：`property=file.property.relation.sessionCwd`，`requirement.kind=equals`，expected为typed DirectoryRef |
| `observe.entries` | P3：`property=file.property.directory.entries`，`requirement.kind=observed` |
| `select.entry` | P3：`property=file.property.directory.entries`，`requirement.kind=matches`且声明typed predicate`entrySelector`；结果绑定唯一入口或明确not_found/ambiguous/insufficient_evidence |
| `exists.true` | P4：`property=file.property.exists`，`requirement.kind=equals`，expected为true |
| `exists.false` | P4：`property=file.property.exists`，`requirement.kind=equals`，expected为false |
| `name.equals` | P4：`property=file.property.path.name`，`requirement.kind=equals`，expected为typed Name |
| `parent.equals` | P4：`property=file.property.path.parent`，`requirement.kind=equals`，expected为typed AbsolutePath |
| `linkText.equals` | P4：`property=file.property.link.target`，`requirement.kind=equals`，expected为typed PathText；不要求链接目标存在 |
| `hardLink.sameObject` | P4：`property=file.property.links`，`requirement.kind=matches`且声明typed predicate`sameObject`及明确source；要求dev/ino及链接关系 |
| `observe.range` | P5：`property=file.property.content.bytes`，`requirement.kind=observed`，target绑定明确offset/length范围 |
| `equals.bytes` | P5：`property=file.property.content.bytes`，`requirement.kind=equals`，expected为整文件的typed Bytes |
| `patch.bytes` | P5：`property=file.property.content.bytes`，`requirement.kind=matches`且声明typed predicate`patch`，含offset与Bytes，只监督该区间并保留区间外字节 |
| `append.suffix` | P5：`property=file.property.content.bytes`，`requirement.kind=matches`且声明typed predicate`appendSuffix`，含Bytes |
| `equals.length` | P5：`property=file.property.size`，`requirement.kind=equals`，expected为typed Length |
| `copy.bytes` | P5：`property=file.property.content.bytes`，`requirement.kind=matches`且声明typed predicate`sameBytes`，含明确source |
| `equals.mode` | P6：`property=file.property.mode`，`requirement.kind=equals`，expected为typed Mode |
| `equals.owner` | P6：`property=file.property.owner`，`requirement.kind=equals`，expected为typed Owner |
| `equals.times` | P6：`property=file.property.times`，`requirement.kind=equals`，expected为typed Times |

这些效果字段描述Goal要求的属性变换，不是原生flags。只有同一typed predicate及其typed参数确实定义等价效果时，teacher才可将相应操作列入可接受集合A。先按无副作用优先、影响范围最小的合同排除多余动作；仍等价时均可正确，不能将学生选择另一合法操作记错。已知OS执行可能失败的合法操作仍可被选择：ENOENT/拒权等执行失败不自动变成“策略选错”；类型不适用、缺必要参数或未经授权执行则分别报告。

### P5 equals.bytes与patch.bytes的范围

`equals.bytes`固定表示整文件的期望内容。已有普通文件的整文件字节提交使用`file.replace`，不由`file.write`承担该equals条件的监督。局部更新必须使用独立的typed predicate`patch.bytes(offset,bytes)`并绑定`file.write`，执行后保留offset/bytes区间外的原有字节。`observe.range`只观测明确区间，不产生修改，也不能替代上述两个效果predicate。范围属于Goal语义，prepare和harness不得在运行时临时选择范围或操作，也不得让同一个`equals.bytes`编码同时监督`file.replace`与`file.write`。

### P3候选目标类型与P4目标类型

`selectorTargetType`固定为3项：`unspecified`、`regular`、`directory`。它只在共享矩阵的selectorTargetType块中出现，并在predicate块之后、requiredTargetType/observedType之前形成一个3维one-hot块；该块在阶段含`select.entry`类predicate时整块注册。对于`select.entry`，它从typed `entrySelector.type`读取：明确要求普通文件时对`regular`置1，明确要求目录时对`directory`置1，没有类型要求时对`unspecified`置1；`sessionCwd`和`observe.entries`固定对`unspecified`置1。`entrySelector.type`为symlink及其他类型时返回unsupported，不伪造`unknown`，也不映射为`other`或`unspecified`。它只表示Goal要选择的候选类型，与`observedType`表示父目录或实际候选的已观测类型严格分开，不得从head标签、操作名称、扩展名、候选顺序或harness选择推导。

`requiredTargetType`固定为4项：`unspecified`、`regular`、`directory`、`symlink`。它只在共享矩阵的requiredTargetType块中取值，该块在阶段含P4目标类型条件时整块注册。存在唯一精确目标类型要求时对相应token置1；Goal没有类型要求时对`unspecified`置1；多个类型要求冲突时返回invalid_input。未注册该块的阶段不包含这4维，也不从State补恒定块。它不得从teacher/head标签、操作名称、扩展名、候选顺序或harness选择推导，也不得由`observedType`复制。selectorTargetType与requiredTargetType是两个不同块，一个阶段可按需注册其中之一或两者，不能互相复制。`observedType`固定为9种实际观测状态：`regular/directory/symlink/char/block/fifo/socket/other/unobserved`。类型要求块表示Goal要求，`observedType`表示State中的实际观测。

`unspecified`只表示Goal没有目标类型要求，不能写成“未知类型”；未知实际类型仍只由`observedType=unobserved`表达。P4当前head不能创建设备、FIFO或socket，要求这些目标类型的请求在进入策略监督前返回unsupported，不能借用`other`或`unspecified`。P3的`entrySelector.type`超出普通文件/目录时同样返回unsupported。动作顺序按共享head表（[文件系统训练合同](cli-filesystem-training.md)§2.2）；`NOOP`、`DEFER`是共享控制head，不执行shell。NOOP只在当前State已满足Goal且证据适用时进入可接受集合；DEFER表示缺必要对象、观测或参数。harness只绑定学生选定head的typed参数并执行，不依据`selectorTargetType`或`requiredTargetType`替换、补选或纠正head。

在target不存在且其他State相同的P4配对中，训练行`P4-dir`的`requiredTargetType=directory`，可接受集合只含`directory.create`；训练行`P4-file`的`requiredTargetType=regular`，可接受集合只含`file.create`。两行的property、`exists.true` predicate、`observedType=unobserved`、exists证据、条件位及全部引用存在位相同，requiredTargetType块不同。该反例要求共享矩阵输入至少有一处不同，禁止两行共享同一学生向量后接受互斥head。

对于P3目录选择配对，两行使用同一个混合目录候选State，完整覆盖候选，并分别以合法名称约束目录候选`E_dir`与普通文件候选`E_file`。训练行`P3-dir`的`selectorTargetType=directory`，可接受集合只含`directory.select`；训练行`P3-file`的`selectorTargetType=regular`，可接受集合只含`file.select`。两行的property、`select.entry` predicate、父目录观测、证据及基础状态位相同，共享矩阵的P行输入只在selectorTargetType块不同。候选名称分别由B绑定，名称不同不进入共享矩阵特征，也不能把同一父目录下同名普通文件和目录共存作为fixture。

注册表按完整的`(property,predicate)`对校验，不按P组路由selector。P1-P6只决定样本/统计归属，不决定模型或profile。同名property可按Goal条件配不同predicate（例如P2观测`size`与P5的`equals.length`），它们进入同一property/predicate全局块，不进入两套权重。目录entries的整体集合修改交C拆成P4原语，不给P3加入写操作。无法匹配的property/predicate对返回`unsupported`，不尝试另一个族；注册校验是typed合同分工，不计为NN学习。

### 输入、参数及梯度

所有P行共享同一输入向量，块顺序唯一维护在[文件系统训练合同](cli-filesystem-training.md)§2.1：

```text
x = [1, goalObserveCwd, goalSetCwd, goalListDirectory, // 四条legacy wire
     oneHot(property),            // 全局property块，P1-P6合并去重
     oneHot(predicate),           // 全局predicate块，替代原"requirement variant in family"
     selectorTargetType block,    // 3维或空
     requiredTargetType block,    // 4维或空
     oneHot(observedType: regular/directory/symlink/char/block/fifo/socket/other/unobserved),
     hasFreshEvidence, knownValue, requiredConditionHolds,
     hasSourceRef, hasDestinationRef, hasParentRef, hasSessionRef, hasPayload,
     requiredConditionHolds*hasFreshEvidence,
     combination block]           // 仅C阶段，否则空
z[a] = Σ_j W[a,j] * x[j]
p = stableSoftmax(z)
L = -Σ_a q[a] log(p[a]), q[a]=1/|A| if a∈A else 0
∂L/∂z[a] = p[a] - q[a]
```

softmax在全部已注册head上进行，包含`unsupported`、`DEFER`、`NOOP`、`pwd`、`cd`、`ls`及新增动作head。禁止prepare按P1-P6分组先过滤logits或硬mask；teacher允许集合只进入损失与评价。被guard拒绝的错误head仍计一次策略错误并记录`policy_error`，不得改标为`unsupported`、`DEFER`或OS失败。

`F`与`K`由注册表唯一计算，公式见[文件系统训练合同](cli-filesystem-training.md)§2.1：`F=4+N_property+N_predicate+3*selectorBlock+4*requiredTypeBlock+9*observedTypeBlock+N_state+N_interaction+N_combination`，`K=1+2+3+新可执行head数`，参数为`K×F`。同一阶段所有P1-P6行使用同一F，不再存在"每族F不同"的局部矩阵。profile必须保存精确property/predicate/head顺序，不按词表长度猜兼容。observed/equals/matches在prepare阶段解成全局predicate标签；不以head名作为输入。unobserved明确表示未观测类型，不能冒充other，也不能与`selectorTargetType=unspecified`或`requiredTargetType=unspecified`互换。缺少必要比较事实时knownValue=0且condition槽为availability屏蔽的中性0，该槽不解释为已知false；prepare按该单元必需条件将行转为DEFER监督或unknown。读取本身就是为了补事实时，不因尚无待获取属性而误标DEFER。

按注册表静态计数示例（假设某阶段注册16个property、25个predicate、3维selectorTargetType、4维requiredTargetType、9维observedType、8个state位、1个交互项、无combination，22个新head）：`F=4+16+25+3+4+9+8+1=70`、`K=1+2+3+22=28`、`28×70=1960`。该数字只说明计数方法，随注册表变化，不是固定部署规模；不得以此声称当前模型已接受这些值。

交互项只表达“条件成立且新证据有效”的NOOP可辨性，不传teacher的eligibleAction/expected/ref正确性。hasPayload等仅表示字段存在，不表示内容正确。raw名称、绝对路径、Bytes正文、session标识不进入共享矩阵特征，符号复制由harness完成。数字目标仅以精确比较结果进入P，P不学习整数算术。

Handwired内图为 `显式特征与独立参数source → multiply(W,x) → 每head affine求和z → 输出logits`；宿主计算稳定softmax/CE及输出梯度，Handwired反传到参数源，全批SGD更新。argmax不在梯度路径；同分顺序为`unsupported` > `DEFER` > `NOOP` > 其余head按共享head表顺序。零权重和epochs=0冻结为必要对照，不能将零模型结果当随机基线。初始预算200epochs、lr0.1，开发集可决定后续预算；独立验证不选预算。所有参数真实动态wire，不用teacher或OS oracle替换学生rollout。

## 4. R：用途属性的最小关系设计

每次请求一个role，输出matches/nonmatch及judged/unknown/conflict；词表初始为source、test、config、dependency_manifest、documentation、generated、log、media、attachment、backup。角色重叠使用分别BCE任务，不做单标签互斥type。关系来源是当前明确scope内的实际文件及引用，不能把目标角色是否正确作为输入。

每role独立18参数logit，固定特征为 `[1,textDecodable,structuredParseValid,codeSyntaxRecognized,mediaSignature,producerRecorded,consumerRecorded,buildInputEdge,testInputEdge,runtimeLoadEdge,userAttachmentEdge,historyCopyEdge,buildOutputEdge,dependencySectionEdge,documentationStructure,appendTraceEdge,declaredMediaUseEdge,declaredBackupUseEdge]`。所有edge是采集到的具体声明/调用/记录关系及证据，不是teacher给出的isSource/isConfig。producer/consumer不等于用途角色真值；buildOutput、appendTrace和dependencySection分别保留生成物、日志与依赖声明的可辨依据。先读取必要证据再形成完整向量；缺必需关系保留unknown，不填0为“无关系”。已确认不存在关系才是0。R是用途概念模型，不输出命令head，不参与`cli.command-policy.v1`的head选择。

训练仍用BCE、Handwired线性乘加与SGD，数值梯度同B模块。label来自独立复核的实际用途：例如构建实际输入与generated可同时成立，运行时加载的JSON与测试JSON要有独立作用证据。负例必须是已复核的相反角色，不从未命中或unknown自动补负。无足够证据区分某role时返回unknown，不降低阈值或假装全部文件均可分类。

角色判定分数阈值仅用开发集预定，保持uncalibrated；它不是satisfactionThreshold。独立回归按完整已复核样本的matches/nonmatch及unknown状态评价。格式JSON/UTF8由parser直接产生，无单独格式分类NN；更广自然语言用途理解不是这18参数模型的能力。

## 5. C：共享策略上的有限下一步

C不是第二个selector。组合下一步仍由同一`cli.command-policy.v1`共享矩阵选择head；C只向该矩阵增加22维combination块（7个predicate one-hot + 15个state位），不建独立9-head softmax、不复制bias（共享bias已在legacy块）。C行与P行在同一head词表和同一softmax中训练，teacher允许集合只进入损失与评价。

C步骤标签与规范head的唯一映射如下，不得另造同义head：

| C步骤标签 | 规范head |
| --- | --- |
| INSPECT | `entry.inspect` |
| LIST | `ls`（operation `directory.list`） |
| CREATE_DIRECTORY | `directory.create` |
| COPY_FILE | `file.copy` |
| CREATE_LINK | `link.create` |
| REMOVE_ENTRY | `entry.remove` |
| READ_CHUNK | `file.read` |

`DEFER`和`NOOP`是共享控制head，不执行shell。没有独立`FINISH` head；只有实际整体Goal条件成立时，C才允许结束并以`NOOP`表达。预算或前沿耗尽而Goal未成立时返回`DEFER`与continuation，不返回`FINISH`或伪造成功。

combination块固定顺序为7个predicate `createParents/walk/copyTree/removeTree/compareBytes/compareTree/searchLiteral`，随后15个state位 `frontierNonEmpty,parentReady,childrenComplete,entryIsDirectory,entryIsRegular,entryIsSymlink,batchBudgetRemaining,requiredCoverageReached,hasError,existenceKnown,entryExists,currentObserved,sourceReady,destinationExists,readRemaining`。这些wire只在C阶段注册，F与K由共享矩阵公式计算；原C的`F=23`不再作为独立矩阵复用，共享bias已计入legacy块，combination块贡献22维。

teacher按有限依赖和真实前树给允许下一步集合：父目录未存在先创建父目录；复制链接保留文本；删除目录必须子先；分段读取不可跳过未读块；预算耗尽返回DEFER及continuation。结束（NOOP）只有整体属性条件证据成立才允许；未成立时返回DEFER+continuation，不返回FINISH。frontier中的多个同层对象可有多个合法顺序，不训练固定索引捷径。teacher的允许集合使用上述规范head，不使用C局部大写标签作为第二词表。

所列特征必须能区分合法下一步；若反例显示线性特征不能区分，先按设计流程补必要交互wire，不通过teacher运行时接管。当前这是拟合前的结构假设，开发不收敛时按失败原样报告而非宣称已成功。search仅在可证明分母的覆盖Goal允许连续satisfaction；内容匹配真值与覆盖独立。覆盖目标90/100用同一明确范围配对样本，policy可看到requiredCoverageReached这个由typed比较提供的事实，不把未知范围比率当0。

## 6. 场景、分区与独立验证计划

以下为待生成配方，不是已完成样本/准确率。B与R保留独立概念profile；P与C共用同一`cli.command-policy.v1`共享profile，P1-P6只是样本/统计分组。每个profile都记录来源家族、唯一学生向量数、train/dev/verification用途；同一树或内容模板及其换名不得跨分区。输入不含验证标签。train拟合，dev选预算/阈值；verification由独立作者的不同树结构/内容配方创建，候选保存后只读回载执行。被用于调参的验证转回归，另留新验证。

| 模块 | train / dev / verification设计覆盖 | teacher与独立真值 |
| --- | --- | --- |
| B | 8种名称/类型/父关系组合全覆盖；分别至少4/2/4个独立树家族；另加缺测/重复/partial | train显式关系规则；verification独立实际目录和已知关系，不共用生成器 |
| P共享矩阵（P1-P6分组） | 每个head至少2种Goal/State结构及NOOP/DEFER；每个predicate有满足/不满足/缺事实、每个允许类型和被拒类型；按结构家族划4/2/4以上，不以固定行数冒充覆盖；同一阶段回放全部必需旧PWD/CD/LS/unsupported | 独立效果表给可接受集合；真实OS状态另核对，不以执行器guard回写策略标签 |
| R每role | 每分区至少正/负/未知各2个独立证据家族，另保留冲突；4/2/4套结构不同项目/日常目录配方，验证含同名不同用途、同格式不同角色 | 有来源的人工/teacher复核，独立验证作者不沿用训练标注模板；不编造真实站点/用户数据 |
| C（共享矩阵的combination块） | 每个组合predicate独立父子拓扑、正常和断点前沿；4/2/4组不同树形/块边界；search含阈值90与100配对；C行与P行同一head/softmax | train有限依赖/效果合同，verification先写真实树/字节配方，再独立核对整体效果 |

参数边界反例：名称含空格/中文/换行/引号/元字符；空文件/空目录；源目标同一条目/硬链接别名；目标已存在；跨设备move不fallback；最终symlink与祖先链接；读到EOF/长度0；短写、部分复制/删除；ctime不可设置；失效引用与类型变化；设备/FIFO/socket不能被普通字节操作处理。

P4创建类型配对固定用于train、dev、verification三个分区。每分区各有一对独立生成的行：`requiredTargetType=directory`只允许`directory.create`，`requiredTargetType=regular`只允许`file.create`；两行使用同一已确认不存在的target、同一State、同一证据和同一引用存在性。除requiredTargetType的one-hot位置外，共享矩阵输入保持一致，因此两行之间至少存在这一处输入差异。teacher只给允许head集合，不把head标签写入requiredTargetType；harness不替学生选择或改写head。独立验证样本使用另一树结构家族和另写teacher效果表，不能复用train/dev配方直接换名。

P3选择类型配对固定用于train、dev、verification三个分区。每分区各有一对独立生成的行：同一混合目录候选State包含目录候选与普通文件候选，coverage完整；两行分别用合法目标名称绑定其中一个候选。`selectorTargetType=directory`的行只允许`directory.select`，`selectorTargetType=regular`的行只允许`file.select`。名称和实际候选类型由B输入及绑定负责，不进入共享矩阵特征；除selectorTargetType的one-hot位置外，两行共享矩阵P行输入相同。teacher只给允许head集合，不把head标签写入selectorTargetType；harness不替学生选择或改写head。fixture不得使用同一父目录下同名普通文件和目录共存这种不可能状态，也不能用harness临时改选候选来制造配对。

真实可稳定复现的OS错误才计native行为验证；短写/列举中消失可用受控harness故障注入，但单列为合同测试，不能混报真实权限或真实设备覆盖。不使用生产目录/设备；本轮仅设计，后续fixture副作用授权限于自有场景。

## 7. DAG、验收与升级闭合

外层推理图为 [cli-file-property](../workflows/cli-file-property.graph.json)，训练图复用 [cli-filesystem-training](../workflows/cli-filesystem-training.graph.json)；合同/反推/分区→训练开发准备与独立验证准备分支→真实拟合→保存候选→回载独立执行→汇总→保存/清理。当前真实训练图为`cli.command.*@0.2.0`、8N8E，推理图为`cli-file-property@0.2.0`、6N5E；P3 已接入，其余 P 组与 B/R 仍是设计，不写入真实图，也不新增第二套执行图。B与R是独立概念模型；P与C共用同一`cli.command-policy.v1`共享profile、同一head词表、同一softmax/CE。内部数值连线按共享矩阵注册表构建，外层跨节点不反传。

验收分别统计：按head、按属性、按P1-P6样本分组的允许集合正确、参数绑定、真实属性效果及满足度、错误/unknown保持、副作用、保存回载、旧路径/PWD黄金回归。P1-P6统计分开报告，但selector只有一个profile；不得用分组统计掩盖某组退化。精确属性验证与必要错误/副作用用例全部满足，旧黄金零回归；角色验证必须保留未知/冲突，不以覆盖增加替代准确率；候选作用于新场景有明确修复才可沿既有升级条件采用。不能用loss下降、命令退出0或平均指标掩盖一项必要失败。

每次使用自动采样由consumer完成，复核前不作监督。候选与当前隔离；在 [model-evolution](../workflows/model-evolution.graph.json) 的独立比较后，满足原合同条件自动采用，有回归或冲突保留当前版本交大模型裁决。采集失败、证据不足或尚未完成训练均不能宣称升级完成。P/C只有一个共享候选；B/R候选独立，但不能冒充命令selector。

owner：adapter负责固定CLI与OS证据；`lib/filters/cli-command-policy`负责共享head/wire注册表与矩阵，B/R filter分别负责独立概念模型；nodes/trainable负责共享电路；training负责配方分区/拟合/评价；nodes与公开consumer负责workflow接续和采样。设计交付不新增业务代码，不执行拟合。后续按最小单元逐项实现，失败先定位观测/监督/可辨输入/连线/参数/执行owner，再补受影响图和反例。
