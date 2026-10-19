# file.property 最小单元训练设计

状态：2026-10-19 设计完成候选；没有生成样本、运行拟合或修改代码。本页完成普通路径/目录/文件合同中的训练责任、特征/数值连线、分区和验证设计；单元不能因本页存在就标为已训练。特殊文件只训练观测/拒绝关系，不学习未定义设备协议。语义和命令方案分别沿 [属性合同](cli-filesystem-semantics.md) 与 [固定调用设计](cli-command-design.md)。

## 1. 四元素与分工

每个单元采用 `{goal:{kind:"file.property",target,property,requirement},satisfactionThreshold,state}`。反向推理只在训练设计/样本阶段：从达标属性条件反推可接受的操作效果、参数角色和前置State。实际New State与Goal评价由固定执行/独立观测给出。policy分数不表示满足度。单属性精确观测/修改的满意度为0/100；阈值取1..100时达标条件相同，不制造90%的精确写入成功；阈值0仍须有必要证据及Goal必要条件，不能跳过本次观测。

学生学习以下独立函数，权重和损失分开：

| 单元 | 学习内容 | 手写基础/执行者 |
| --- | --- | --- |
| B 对象关系绑定 | 候选是否符合明确的类型/名称/父目录或session关系 | 引用合法性、符号相等计算、实际候选观测与集合消歧 |
| P 属性效果策略 | 给定Goal/State选必要操作、NOOP或DEFER | typed Goal编码、相等/范围等基础比较、操作授权及OS执行 |
| R 用途关系 | 在明确证据范围内判断指定用途关系 | 实际读取、格式解析、声明引用和局部关系取参 |
| C 组合下一步 | 从明确前沿和依赖状态选择必要的下一原语/结束/缺口 | 实际树枚举、范围/预算、已有runner、结果保存 |

格式UTF8/JSON解析、stat类型、路径分解/relative、权限检查、Bytes复制及stdout协议解码均为固定基础，不为复述已知标签另训模型。已有path.resolve符号控制器、PWD策略及CWD/CD/LIST设计复用，新增兼容接口需做回归；本页不替换已交付结果或直接改profile名称。操作适用性以类型与操作合同确定，没有需学习的新关系则保持确定性。

## 2. B：候选对象及参数角色

目录/file.select沿旧3关系结构：`x=[1,nameEqual,typeEqual,parentEqual]`，4参数 `z=w·x`，宿主BCE、Handwired求梯度；输入任一必要关系缺测，输出unknown不进完整监督行。8种0/1组合全覆盖，teacher为三条件合取，不在推理时覆写学生输出。file与directory目标类型在构造typeEqual时显式传入，分别保存/评估兼容profile；不能直接声称旧directory权重跨类型有效。

sessionCwd关系复用CWD设计 `[1,sameSession,hasObservation]` 的2×3参数。多角色Action的source/destination/parent/session分别调用相应关系判别：每个参数角色都是独立查询，禁止用候选顺序/最高分猜。目录创建没有已存在目标，绑定已知parent与精确Name，不能强迫B生成不存在对象。操作给定明确参数引用时只做typed绑定，不重复训练复制字符串。

学生输出逐候选关系，集合resolver只有唯一确定匹配且必要覆盖完整才选中；无匹配且覆盖完整为not_found，矛盾观测invalid_input，缺覆盖/unknown为insufficient_evidence。扩到跨父目录宽选择器时多匹配返回ambiguous，不沿用单父名称唯一假设。teacher关系、可执行器拒绝与模型正确率分别统计。

独立反例：同名异目录、同目录异类型、文件伪目录扩展名、symlink与目标、过期session观测、角色互换、创建目标误绑定成已有文件。原始名称/路径只供绑定和证据，学生只见明确关系值，不含teacher匹配结果。

## 3. P：每属性操作策略及数值电路

不训练一个任意命令生成器。按以下操作族保存独立profile；每族仅有本族动作及NOOP/DEFER。NOOP表示已满足且证据适用，DEFER表示缺必要对象/观测/参数并返回typed缺口；确定性授权拒绝独立记录，不能用guard掩盖策略误选。

### 封闭词表与参数矩阵

每族的property、predicate和Action均按下表顺序封闭。Action顺序是模型输出词表顺序，不是property/predicate推导来源；向量另在Action族表末尾追加`NOOP`、`DEFER`。

| 族 | property词表（N_property） | predicate词表（N_predicate） | Action词表（N_action） | K | F | 参数 |
| --- | --- | --- | --- | ---: | ---: | ---: |
| P1 | `file.property.path.absolute`、`file.property.path.relative`、`file.property.path.parent`、`file.property.path.name`、`file.property.path.physical`（5） | `observe.absolute`、`observe.relative`、`observe.parts`、`observe.physical`（4） | `path.resolve`、`path.relative`、`path.parts`、`path.realpath`（4） | 6 | 28 | 168 |
| P2 | `file.property.exists`、`file.property.type`、`file.property.size`、`file.property.mode`、`file.property.owner`、`file.property.times`、`file.property.link.target`、`file.property.links`（8） | `observe.inspect`、`observe.resolvedTarget`（2） | `entry.inspect`、`path.realpath`（2） | 4 | 29 | 116 |
| P3 | `file.property.relation.sessionCwd`、`file.property.directory.entries`（2） | `observe.sessionCwd`、`equals.sessionCwd`、`observe.entries`、`select.entry`（4） | `cwd.get`、`cwd.set`、`directory.list`、`directory.select`、`file.select`（5） | 7 | 28 | 196 |
| P4 | `file.property.exists`、`file.property.path.name`、`file.property.path.parent`、`file.property.link.target`、`file.property.links`（5） | `exists.true`、`exists.false`、`name.equals`、`parent.equals`、`linkText.equals`、`hardLink.sameObject`（6） | `directory.create`、`file.create`、`link.create`、`file.link`、`entry.move`、`entry.remove`（6） | 8 | 34 | 272 |
| P5 | `file.property.content.bytes`、`file.property.size`（2） | `observe.range`、`equals.bytes`、`patch.bytes`、`append.suffix`、`equals.length`、`copy.bytes`（6） | `file.read`、`file.replace`、`file.write`、`file.append`、`file.truncate`、`file.copy`（6） | 8 | 27 | 216 |
| P6 | `file.property.mode`、`file.property.owner`、`file.property.times`（3） | `equals.mode`、`equals.owner`、`equals.times`（3） | `entry.mode.set`、`entry.owner.set`、`entry.times.set`（3） | 5 | 25 | 125 |

原族约束保持不变：P1词法与物理不可互换并复用已有resolve训练；P2拒权未知不等于不存在且nlink缺测不补0；P3的S/D不能交换；P4的rename与move同Action且create不覆盖；P5不接受任意options；P6缺少必要参数或要求设置不可设置的ctime/birthtime时返回缺口。

所有predicate标签都从`goal.kind="file.property"`的typed Goal及其`property`、`requirement`取值；下表给出唯一来源，不从Action、teacher可接受集合、扩展名或候选反推。`observed`查询也必须保留Goal的property，不以Action名代替。

| predicate标签 | typed Goal来源（family取自prepare唯一路由） |
| --- | --- |
| `observe.absolute` | P1：`property=file.property.path.absolute`，`requirement.kind=observed` |
| `observe.relative` | P1：`property=file.property.path.relative`，`requirement.kind=observed` |
| `observe.parts` | P1：`property=file.property.path.parent`或`file.property.path.name`，`requirement.kind=observed` |
| `observe.physical` | P1：`property=file.property.path.physical`，`requirement.kind=observed` |
| `observe.inspect` | P2：`property`为本族8项之一，`requirement.kind=observed`；实际类型、存在性、长度、元数据、链接文本和链接关系分别由property选定 |
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

`selectorTargetType`固定为3项：`unspecified`、`regular`、`directory`。它只在P3输入中出现，并在`requirement variant`之后、`observedType`之前形成一个3维one-hot块。对于`select.entry`，它从typed `entrySelector.type`读取：明确要求普通文件时对`regular`置1，明确要求目录时对`directory`置1，没有类型要求时对`unspecified`置1；`sessionCwd`和`observe.entries`固定对`unspecified`置1。`entrySelector.type`为symlink及其他类型时返回unsupported，不伪造`unknown`，也不映射为`other`或`unspecified`。它只表示Goal要选择的候选类型，与`observedType`表示父目录或实际候选的已观测类型严格分开，不得从Action标签、操作名称、扩展名、候选顺序或harness选择推导。

`requiredTargetType`固定为4项：`unspecified`、`regular`、`directory`、`symlink`。它只在P4 typed Goal的requirement schema中取值。存在唯一精确目标类型要求时对相应token置1；Goal没有类型要求时对`unspecified`置1；多个类型要求冲突时返回invalid_input。其他P族不包含这4维，也不从State补恒定块。它不得从teacher/Action标签、操作名称、扩展名、候选顺序或harness选择推导，也不得由`observedType`复制。P3的3维`selectorTargetType`不是`requiredTargetType`，P4也不使用`selectorTargetType`。`observedType`固定为9种实际观测状态：`regular/directory/symlink/char/block/fifo/socket/other/unobserved`。类型要求块表示Goal要求，`observedType`表示State中的实际观测。

`unspecified`只表示Goal没有目标类型要求，不能写成“未知类型”；未知实际类型仍只由`observedType=unobserved`表达。P4当前Action不能创建设备、FIFO或socket，要求这些目标类型的请求在进入策略监督前返回unsupported，不能借用`other`或`unspecified`。P3的`entrySelector.type`超出普通文件/目录时同样返回unsupported。P3/P4动作顺序按上表，向量的完整Action顺序再加`NOOP`、`DEFER`。NOOP只在当前State已满足Goal且证据适用时进入可接受集合；DEFER表示缺必要对象、观测或参数。harness只绑定学生选定Action的typed参数并执行，不依据`selectorTargetType`或`requiredTargetType`替换、补选或纠正Action。

在target不存在且其他State相同的P4配对中，训练行`P4-dir`的`requiredTargetType=directory`，可接受集合只含`directory.create`；训练行`P4-file`的`requiredTargetType=regular`，可接受集合只含`file.create`。两行的property、`exists.true` predicate、`observedType=unobserved`、exists证据、条件位及全部引用存在位相同，requiredTargetType块不同。该反例要求策略输入至少有一处不同，禁止两行共享同一学生向量后接受互斥Action。

对于P3目录选择配对，两行使用同一个混合目录候选State，完整覆盖候选，并分别以合法名称约束目录候选`E_dir`与普通文件候选`E_file`。训练行`P3-dir`的`selectorTargetType=directory`，可接受集合只含`directory.select`；训练行`P3-file`的`selectorTargetType=regular`，可接受集合只含`file.select`。两行的property、`select.entry` predicate、父目录观测、证据及基础状态位相同，学生P输入只在selectorTargetType块不同。候选名称分别由B绑定，名称不同不进入P特征，也不能把同一父目录下同名普通文件和目录共存作为fixture。

prepare按完整的`(property,predicate)`对确定唯一策略族，不能只按property或其中一词分流：P1只接4个P1 predicate；P2只接`observe.inspect/observe.resolvedTarget`；P3只接sessionCwd与entries的4个predicate；P4只接6个拓扑predicate；P5只接bytes/range/patch/append/length/copy的6个predicate；P6只接mode/owner/times的3个predicate。由此同名property也按Goal条件进入不同族，例如P2观测`size`属于P2，P5的`equals.length`属于P5；P2观测`mode`属于P2，P6的`equals.mode`属于P6。目录entries的整体集合修改交C拆成P4原语，不给P3加入写操作。无法匹配的property/predicate对返回unsupported，不尝试另一个族；路由是typed合同分工，不计为NN学习。

### 输入、参数及梯度

每族使用自己表内的属性、predicate与操作词表。输入公共块固定为：

```text
x = [1,
     oneHot(property in family),
     oneHot(requirement variant in family),
     familyTypeRequirementBlock,
     oneHot(observedType: regular/directory/symlink/char/block/fifo/socket/other/unobserved),
     hasFreshEvidence, knownValue, requiredConditionHolds,
     hasSourceRef, hasDestinationRef, hasParentRef, hasSessionRef, hasPayload,
     requiredConditionHolds*hasFreshEvidence]
z[a] = Σ_j W[a,j] * x[j]
p = stableSoftmax(z)
L = -Σ_a q[a] log(p[a]), q[a]=1/|A| if a∈A else 0
∂L/∂z[a] = p[a]-q[a]

familyTypeRequirementBlock =
  P3: oneHot(selectorTargetType: unspecified/regular/directory), 3维
  P4: oneHot(requiredTargetType: unspecified/regular/directory/symlink), 4维
  P1/P2/P5/P6: 空
```

P1、P2、P5、P6的输入按上式结束，维数为`F=1+属性数+predicate数+9+9`；末段的9是observedType词表，随后9是8个基础状态位加1个交互项。P3在`requirement variant`之后、`observedType`之前增加`oneHot(selectorTargetType)`，维数为`F=1+属性数+predicate数+3+9+9`。P4在同一位置增加`oneHot(requiredTargetType)`，维数为`F=1+属性数+predicate数+4+9+9`。属性、predicate、selectorTargetType、requiredTargetType和observedType的one-hot均为整块且按本节表序；基础位和交互项顺序固定。动作数`K=本族Action词表长度+2`，参数为K×F。实际profile必须保存精确property/predicate/action顺序，不按词表长度猜兼容。observed/equals/matches在prepare阶段解成本族typed predicate标签；不以Action名作为输入。unobserved明确表示未观测类型，不能冒充other，也不能与P3的`selectorTargetType=unspecified`或P4的`requiredTargetType=unspecified`互换。缺少必要比较事实时knownValue=0且condition槽为availability屏蔽的中性0，该槽不解释为已知false；prepare按该单元必需条件将行转为DEFER监督或unknown。读取本身就是为了补事实时，不因尚无待获取属性而误标DEFER。

按上表静态计数：P1 `F=1+5+4+9+9=28`、`K=4+2=6`、`6×28=168`；P2 `F=1+8+2+9+9=29`、`K=2+2=4`、`4×29=116`；P3 `F=1+2+4+3+9+9=28`、`K=5+2=7`、`7×28=196`；P4 `F=1+5+6+4+9+9=34`、`K=6+2=8`、`8×34=272`；P5 `F=1+2+6+9+9=27`、`K=6+2=8`、`8×27=216`；P6 `F=1+3+3+9+9=25`、`K=3+2=5`、`5×25=125`。P3 profile必须保存selectorTargetType的3维固定顺序，P4 profile必须保存requiredTargetType的4维固定顺序；P1、P2、P5、P6没有类型要求块。

交互项只表达“条件成立且新证据有效”的NOOP可辨性，不传teacher的eligibleAction/expected/ref正确性。hasPayload等仅表示字段存在，不表示内容正确。raw名称、绝对路径、Bytes正文、session标识不进入P特征，符号复制由harness完成。数字目标仅以精确比较结果进入P，P不学习整数算术。

Handwired内图为 `显式特征与独立参数source → multiply(W,x) → 每动作affine求和z → 输出logits`；宿主计算稳定softmax/CE及输出梯度，Handwired反传到参数源，全批SGD更新。argmax不在梯度路径；同分先DEFER后NOOP再按表顺序。零权重和epochs=0冻结为必要对照，不能将零模型结果当随机基线。初始预算200epochs、lr0.1，开发集可决定后续预算；独立验证不选预算。所有参数真实动态wire，不用teacher或OS oracle替换学生rollout。

## 4. R：用途属性的最小关系设计

每次请求一个role，输出matches/nonmatch及judged/unknown/conflict；词表初始为source、test、config、dependency_manifest、documentation、generated、log、media、attachment、backup。角色重叠使用分别BCE任务，不做单标签互斥type。关系来源是当前明确scope内的实际文件及引用，不能把目标角色是否正确作为输入。

每role独立18参数logit，固定特征为 `[1,textDecodable,structuredParseValid,codeSyntaxRecognized,mediaSignature,producerRecorded,consumerRecorded,buildInputEdge,testInputEdge,runtimeLoadEdge,userAttachmentEdge,historyCopyEdge,buildOutputEdge,dependencySectionEdge,documentationStructure,appendTraceEdge,declaredMediaUseEdge,declaredBackupUseEdge]`。所有edge是采集到的具体声明/调用/记录关系及证据，不是teacher给出的isSource/isConfig。producer/consumer不等于用途角色真值；buildOutput、appendTrace和dependencySection分别保留生成物、日志与依赖声明的可辨依据。先读取必要证据再形成完整向量；缺必需关系保留unknown，不填0为“无关系”。已确认不存在关系才是0。

训练仍用BCE、Handwired线性乘加与SGD，数值梯度同B模块。label来自独立复核的实际用途：例如构建实际输入与generated可同时成立，运行时加载的JSON与测试JSON要有独立作用证据。负例必须是已复核的相反角色，不从未命中或unknown自动补负。无足够证据区分某role时返回unknown，不降低阈值或假装全部文件均可分类。

角色判定分数阈值仅用开发集预定，保持uncalibrated；它不是satisfactionThreshold。独立回归按完整已复核样本的matches/nonmatch及unknown状态评价。格式JSON/UTF8由parser直接产生，无单独格式分类NN；更广自然语言用途理解不是这18参数模型的能力。

## 5. C：树操作和搜索的有限下一步

组合只在固定Goal predicate内学习下一类效果，不学习任意规划语言。x固定为 `[1,oneHot(createParents/walk/copyTree/removeTree/compareBytes/compareTree/searchLiteral),frontierNonEmpty,parentReady,childrenComplete,entryIsDirectory,entryIsRegular,entryIsSymlink,batchBudgetRemaining,requiredCoverageReached,hasError,existenceKnown,entryExists,currentObserved,sourceReady,destinationExists,readRemaining]`，7个predicate加15个基础位，F=23。K=9，动作词表为DEFER、FINISH、INSPECT、LIST、CREATE_DIRECTORY、COPY_FILE、CREATE_LINK、REMOVE_ENTRY、READ_CHUNK。参数9×23，线性softmax/CE及训练预算沿P，返回选定类后由显式前沿绑定具体对象/字节区间。缺测与不存在通过existenceKnown分开；sourceReady/destinationExists来自真实已观测对象，不来自teacher。

teacher按有限依赖和真实前树给允许下一步集合：父目录未存在先创建父目录；复制链接保留文本；删除目录必须子先；分段读取不可跳过未读块；预算耗尽返回DEFER及continuation。FINISH只有整体属性条件证据成立才允许。frontier中的多个同层对象可有多个合法顺序，不训练固定索引捷径。

所列特征必须能区分合法下一步；若反例显示线性特征不能区分，先按设计流程补必要交互wire，不通过teacher运行时接管。当前这是拟合前的结构假设，开发不收敛时按失败原样报告而非宣称已成功。search仅在可证明分母的覆盖Goal允许连续satisfaction；内容匹配真值与覆盖独立。覆盖目标90/100用同一明确范围配对样本，policy可看到requiredCoverageReached这个由typed比较提供的事实，不把未知范围比率当0。

## 6. 场景、分区与独立验证计划

以下为待生成配方，不是已完成样本/准确率。每个B/P/R/C独立profile都记录来源家族、唯一学生向量数、train/dev/verification用途；同一树或内容模板及其换名不得跨分区。输入不含验证标签。train拟合，dev选预算/阈值；verification由独立作者的不同树结构/内容配方创建，候选保存后只读回载执行。被用于调参的验证转回归，另留新验证。

| 模块 | train / dev / verification设计覆盖 | teacher与独立真值 |
| --- | --- | --- |
| B | 8种名称/类型/父关系组合全覆盖；分别至少4/2/4个独立树家族；另加缺测/重复/partial | train显式关系规则；verification独立实际目录和已知关系，不共用生成器 |
| P每族 | 每个Action至少2种Goal/State结构及NOOP/DEFER；每个predicate有满足/不满足/缺事实、每个允许类型和被拒类型；按结构家族划4/2/4以上，不以固定行数冒充覆盖 | 独立效果表给可接受集合；真实OS状态另核对，不以执行器guard回写策略标签 |
| R每role | 每分区至少正/负/未知各2个独立证据家族，另保留冲突；4/2/4套结构不同项目/日常目录配方，验证含同名不同用途、同格式不同角色 | 有来源的人工/teacher复核，独立验证作者不沿用训练标注模板；不编造真实站点/用户数据 |
| C | 每个组合predicate独立父子拓扑、正常和断点前沿；4/2/4组不同树形/块边界；search含阈值90与100配对 | train有限依赖/效果合同，verification先写真实树/字节配方，再独立核对整体效果 |

参数边界反例：名称含空格/中文/换行/引号/元字符；空文件/空目录；源目标同一条目/硬链接别名；目标已存在；跨设备move不fallback；最终symlink与祖先链接；读到EOF/长度0；短写、部分复制/删除；ctime不可设置；失效引用与类型变化；设备/FIFO/socket不能被普通字节操作处理。

P4创建类型配对固定用于train、dev、verification三个分区。每分区各有一对独立生成的行：`requiredTargetType=directory`只允许`directory.create`，`requiredTargetType=regular`只允许`file.create`；两行使用同一已确认不存在的target、同一State、同一证据和同一引用存在性。除requiredTargetType的one-hot位置外，学生输入保持一致，因此两行之间至少存在这一处输入差异。teacher只给允许Action集合，不把Action标签写入requiredTargetType；harness不替学生选择或改写Action。独立验证样本使用另一树结构家族和另写teacher效果表，不能复用train/dev配方直接换名。

P3选择类型配对固定用于train、dev、verification三个分区。每分区各有一对独立生成的行：同一混合目录候选State包含目录候选与普通文件候选，coverage完整；两行分别用合法目标名称绑定其中一个候选。`selectorTargetType=directory`的行只允许`directory.select`，`selectorTargetType=regular`的行只允许`file.select`。名称和实际候选类型由B输入及绑定负责，不进入P特征；除selectorTargetType的one-hot位置外，两行P输入相同。teacher只给允许Action集合，不把Action标签写入selectorTargetType；harness不替学生选择或改写Action。fixture不得使用同一父目录下同名普通文件和目录共存这种不可能状态，也不能用harness临时改选候选来制造配对。

真实可稳定复现的OS错误才计native行为验证；短写/列举中消失可用受控harness故障注入，但单列为合同测试，不能混报真实权限或真实设备覆盖。不使用生产目录/设备；本轮仅设计，后续fixture副作用授权限于自有场景。

## 7. DAG、验收与升级闭合

外层推理图为 [cli-file-property](../workflows/cli-file-property.graph.json)，训练图复用 [cli-filesystem-training](../workflows/cli-filesystem-training.graph.json)；合同/反推/分区→训练开发准备与独立验证准备分支→真实拟合→保存候选→回载独立执行→汇总→保存/清理。B/P/R/C在各自请求中执行该同一SESE图，不共享未声明兼容的profile或损失。内部数值连线按本页每模块公式构建，外层跨节点不反传。

验收分别统计：关系/操作允许集合正确、参数绑定、真实属性效果及满足度、错误/unknown保持、副作用、保存回载、旧路径/PWD黄金回归。精确属性验证与必要错误/副作用用例全部满足，旧黄金零回归；角色验证必须保留未知/冲突，不以覆盖增加替代准确率；候选作用于新场景有明确修复才可沿既有升级条件采用。不能用loss下降、命令退出0或平均指标掩盖一项必要失败。

每次使用自动采样由consumer完成，复核前不作监督。候选与当前隔离；在 [model-evolution](../workflows/model-evolution.graph.json) 的独立比较后，满足原合同条件自动采用，有回归或冲突保留当前版本交大模型裁决。采集失败、证据不足或尚未完成训练均不能宣称升级完成。

owner：adapter负责固定CLI与OS证据；filters负责B/P/R/C特征及输出；nodes/trainable负责独立电路；training负责配方分区/拟合/评价；nodes与公开consumer负责workflow接续和采样。设计交付不新增业务代码，不执行拟合。后续按最小单元逐项实现，失败先定位观测/监督/可辨输入/连线/参数/执行owner，再补受影响图和反例。
