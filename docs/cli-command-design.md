# 文件属性操作的固定调用设计

状态：设计合同，2026-10-20。0.3.0 批次1 的 `path.resolve`、`path.relative`、`path.parts` 与 `entry.inspect` 已实现并接入统一运行入口（10 head × 30 wire），并有全仓 761/761、新独立套件 56/56、旧独立套件 34/34 的证据；本页其余操作仍为设计，未实现。范围为 [精确目录](cli-semantic-operations.md)2.1/2.2中的全部操作、列出的有限组合，以及特殊文件类型观测。程序执行、挂载/卷管理、ACL/xattr、任意设备协议不属于普通文件操作；不能从统一文件抽象推导其已支持。目标统一沿 [file.property](cli-filesystem-semantics.md)，本页仅维护各操作固定harness、参数、回执及验收，参数简化原则沿 [cli-call-contract.md](cli-call-contract.md)。

## 1. 共同输入、权限与结果

Action 为 `{operation, parameters}`。资源引用从 typed control resource 解析：P为新增 `cli.path` 明确路径，E/F为新增 `cli.entry`/`cli.file` 对象引用，D继续复用 `cli.directory`，S为session。P只携带 `{scenarioId,sessionId,path}`，不保证存在、类型或对象身份。E/D/F必须携带或显式关联已观测 `{type,identity:{dev,ino},sourceRun,sessionRevision,absolutePath}`，由sandbox绑定API生成和验证，不从业务metadata、日志或路径字符串重建。创建目标引用为 `{parent:D,name:Name}`，Name是单个非空名称段，拒绝 `/`、NUL、`.`、`..`；需要完整路径时先按path合同解析并绑定父目录。不删改合法空格、换行、Unicode。路径文本只是定位，不证明对象身份；既有引用记录观测的类型及OS身份，用于发现失效，缺失则保留未验证，不许猜。

`entry.inspect`的语义入参可为E/D/F/P，`path.realpath`的物理路径入参仍属后续设计。绑定器保留原引用种类、已观测类型、OS身份及有效性证据；引用失效、绑定目标与观测身份不一致或身份无法核实时返回stale/unknown/rejected，不得仅凭遗留路径继续。显式P按明确路径处理，不声称已有对象身份。旧四字段D `{kind:"cli.directory",scenarioId,sessionId,path}` 继续服务`cd`/`ls`；旧D用于`inspect`且缺身份时返回unknown/`binding_identity_missing`，不降级为P。

声明effects：本批三个词法head无业务effect；`entry.inspect`需`filesystem.read`，不得打开FIFO/socket/设备字节流。其余创建、删除、写、改属性需`filesystem.write`，CLI子进程需`process.exec`，改变S另需`session.write`。固定helper路径与子进程执行由adapter工厂显式配置，不是模型参数或`followSymlinks` wire。目录范围来自调用者授权和训练场景根，不从文件业务metadata推断。模型判断适用不授予权限。

固定CLI helper设计位于 `lib/adapters/cli/`：以 `{executable:process.execPath,argv:[configuredHelperPath,operation],stdin:typedJson,shell:false}` 调用，控制通道与原始Bytes分别编码（Bytes使用base64且注明原始长度），stdout为单个固定协议JSON，stderr只作证据。helper路径来自配置，不接收可执行脚本或任意argv。所有表中标为helper者均使用此模板，模型不学习原生命令flags。目录列举helper（`lib/adapters/cli/directory-list-helper.ts`，argv为`[helperPath, physicalDirectory]`）与批次1的entry inspect helper（`lib/adapters/cli/entry-inspect-helper.ts`）已实现；其余操作helper尚未实现，调用方不因缺失而改用任意shell。PWD及CD保持已定原生命令例外。

共同回执：`{operation,status:complete|partial|rejected|failed,value,errors,effectsObserved}`。value按下表固定，不能含自由options；write类另有实际写入/创建/删除清单。harness执行成功不等于Goal满足；[属性图](../workflows/cli-file-property.graph.json)独立读回实际属性。读取可改变atime，部分动作可能改变ctime/mode；明确记录相关效果，不承诺所有元数据不变。必要观测失败返回unknown，不能补造旧State。失败不自动回滚、删部分产物、降级或复活旧执行路径。

最终symlink策略：inspect显式选择跟随；realpath显式跟随；readlink读取链接自身；move/remove作用条目自身；其他修改/读取目标要求最终对象为声明类型，拒绝最终symlink。祖先路径可经过链接解析，场景根按实际解析核对；不声称“先检查再操作”提供并发隔离。可用fd绑定读取/写入时以fd核对对象，路径变化或效果无法确定时报告stale/unknown。目录与文件测试使用本轮独占真实fixture。

## 2. 路径、目录与条目映射

人类命令栏用于说明语义，不是第二执行通道。helper内使用固定OS API；列明的native binding为待实现适配器责任，缺少时显式不可用。

| operation及必要parameters | 人类命令语义 / 唯一执行方案 | value与独立验收 / 关键失败 |
| --- | --- | --- |
| `cwd.get {session:S}` | `/bin/pwd`，argv固定`["-P"]`，cwd来自S | physicalCwd及native证据；独立realpath核对，S与父进程cwd不改 |
| `cwd.set {session:S,directory:D}` | 固定`/bin/zsh -f -c 'builtin cd -- "$1" && /bin/pwd -P' nnanything-cd D`；成功核对后提交S.cwd/revision | 复用[CD详细合同](cli-cd-training-design.md)；后续同S另发pwd；已提交但验证失败必须保留changed |
| `path.resolve {base:P,input:PathText}` | 已有词法解释器，非CLI | absolute/parent；与独立POSIX词法例核对，不读FS、不展开`~`/glob |
| `path.relative {from:P,to:P}` | 固定path.posix.relative纯函数 | relative；resolve(from,relative)与规范to一致；from/to非绝对拒绝 |
| `path.parts {path:P}` | 固定path.posix dirname/basename | parent/name；根为parent=`/`、name为空、isRoot=true；不将空名用于创建 |
| `path.realpath {path:E/D/F/P}` | 后续设计，不在0.3.0注册；统一typed绑定为P后，helper fs.realpath等价真实路径查询 | physicalPath及来源引用证据；断链/环/拒权/stale显式错误，独立实际链接fixture核对 |
| `entry.inspect {ref:E/D/F/P,followSymlinks:boolean}` | 统一typed绑定后，固定stat/lstat/readlink；follow=true先lstat核对来源身份，再stat目标 | 完整8类type、exists双事实、size、mode、owner、times、link.target、entry.identity及来源证据；无字段就null，不按0补缺测 |
| `directory.list {session:S,directory:D}` | helper readdir+lstat；语义类似ls，禁止解析人类多列输出 | entries/coverage/errors，沿[LIST合同](cli-list-training-design.md)；隐藏/换行名称、partial、空目录 |
| `directory.select/file.select {selector,candidates,coverage}` | 纯关系节点，不执行find或扫描；selector固定name/type/parent | selected/not_found/insufficient_evidence/invalid_input；单父同名唯一性沿旧合同，file只改变目标type，不复用未证明兼容的权重 |
| `directory.create {target:{parent:D,name}}` | helper fs.mkdir，recursive=false | createdRef；父已存在、目标不存在；EEXIST/ENOTDIR/拒权不伪成功 |
| `entry.move {source:E,destination:{parent:D,name}}` | mv/rename语义；native no-replace rename：macOS renamex_np(RENAME_EXCL)，Linux renameat2(RENAME_NOREPLACE) | source/destination实际条目证据；目标冲突/跨设备失败，不用fs.rename覆盖，不copy+delete；不支持native binding时报UNSUPPORTED |
| `entry.remove {entry:E}` | unlink文件/链接自身，rmdir空目录；helper固定类型分支 | removedPath及实际删除证据；非空目录失败；已不存在与本次已删分开，类型/身份失效不删新对象 |
| `entry.mode.set {entry:E,mode:uint}` | chmod；helper适用文件/目录的fd绑定fchmod | mode读回（仅声明POSIX位）；范围0..07777，不处理ACL；fd无法取得/拒权失败，不改用隐式提权 |
| `entry.owner.set {entry:E,uid:uint,gid:uint}` | chown；helper fchown | uid/gid与实际mode/ctime；无自动sudo，OS清除setid位如实记录 |
| `entry.times.set {entry:E,atime:Time,mtime:Time}` | touch时间语义；helper futimes | 实际atime/mtime、OS精度；不声明设置ctime/birthtime；无法精确表示时按已声明精度验收 |
| `link.create {target:{parent:D,name},targetText:PathText}` | ln -s；helper fs.symlink，create-new | lstat类型与readlink原文；targetText可相对或断链，不能误报指向对象存在 |

移动中source与destination是同一条目时显式判为已满足且不调用rename；同对象不同硬链接名不能按路径相等处理。普通文件/目录/链接的身份与更新效果分别核对。跨设备失败不会自动启动另一种组合。OS错误与满足度终点统一沿[file.property §7.4](cli-filesystem-semantics.md#74-os-错误与满足度终点)：明确P且follow=false的ENOENT可形成`exists=false`有效观测，ENOTDIR/EACCES/EPERM/ELOOP不写false，follow=true的ENOENT分开`entryExists`与`resolvedTargetExists`，E/D/F的ENOENT按失效引用处理。

## 3. 文件读写映射

| operation及必要parameters | 固定helper方案 | value与独立验收 / 关键失败 |
| --- | --- | --- |
| `file.create {target:{parent:D,name}}` | open(O_CREAT\|O_EXCL\|O_WRONLY)，关闭 | 空普通文件；已存在不截断；新文件mode=0666受显式fixture umask影响，不假称最终恒为0666 |
| `file.read {file:F,offset:uint,length:uint}` | O_RDONLY且拒绝最终symlink，fstat核类型及身份，按明确offset read | Bytes/bytesRead/eof/observedRange；0长度合法，不据0长度宣称已读完整文件；独立fixture原始字节核对 |
| `file.replace {file:F,content:Bytes}` | 打开已有普通文件，验证后truncate(0)，循环写给定Bytes，关闭 | 最终字节与length；空Bytes得到空文件；写失败保留bytesWritten和实际内容，不承诺原子替换 |
| `file.write {file:F,offset:uint,content:Bytes}` | 打开已有普通文件，定位写；不O_TRUNC、不O_APPEND | writtenRange/bytesWritten；区间外原字节不改，越EOF空隙为零；短写继续剩余部分，错误停止并返回部分效果 |
| `file.append {file:F,content:Bytes}` | 打开已有普通文件O_APPEND，写入Bytes；不O_CREAT | bytesWritten/实际追加范围；单写/多写的并发排序不保证；fixture无并发时核对完整前缀与后缀 |
| `file.truncate {file:F,length:uint}` | 打开已有普通文件，ftruncate | 实际size；缩短保留前缀，扩长区读回为零；不声称内容与旧文件相同 |
| `file.copy {source:F,destination:{parent:D,name}}` | 源fd读取，目标O_CREAT\|O_EXCL，分段复制并核对实际写入 | 源不变、目标字节；目标不覆盖，短写/错误保留已创建目标；不自动保留mode/owner/ACL/xattr，不复制设备/socket |
| `file.link {source:F,destination:{parent:D,name}}` | ln硬链接；固定OS link，前后lstat核对 | source/destination同dev+ino且nlink变化；拒绝最终symlink及跨设备，不能只比较字节宣称同对象 |

Bytes必须有原始长度，base64解码长度不符拒绝。offset/length为非负安全整数，不能越过实现可表示范围；这是typed参数边界，不训练数值溢出猜测。OS整数使用bigint读取；公开值schema明确`number-safe|string-decimal|null`，超出安全整数时以固定十进制字符串保真返回，不截断为Number，缺测为null。size、dev/ino/nlink/rdev/uid/gid及时间数值采用同一保真边界。

## 4. 内容、关系与有限组合

这些仍是 file.property 的计算/操作方案，不增加场景Goal kind。完整属性知识含范围和证据；任何一段未知都不能把全部范围标complete。

| 属性条件或组合 | 固定调用/状态推进 | 后条件与训练反例 |
| --- | --- | --- |
| `content.format` | file.read→显式编码解码→固定JSON/UTF8等已声明parser | 只对已读范围判断；JSON全文valid须EOF且完整；UTF8错误保留invalid，未知格式不猜 |
| `role` | 在明确项目/日常范围观测声明引用、内容格式、结构关系→角色判断器 | 单次角色关系matches/nonmatch/unknown/conflict；名称和扩展名不单独成为真值；沿训练设计 |
| `operation.applicability` | 对声明operation逐项检查实际类型/状态与已知条件 | appropriate/inappropriate/unknown；不是授权通过或OS成功预测 |
| 多级建目录 | path.parts/inspect→父先directory.create→每步重观测 | 已有目录可显式复用，已有文件冲突；记录本轮创建清单，不回滚别人的目录 |
| 树列举/搜索 | directory.list→显式前沿与深度/预算→有限下一批 | 不跟随链接；coverage分母仅限可证明范围，拒权/未知不算搜完；匹配与覆盖分别评价 |
| 树复制 | 完整源枚举→父先mkdir→file.copy/link.create→目标核对 | 不复制设备/FIFO/socket；遇此类在计划阶段返回类型不支持，不偷偷跳过；部分目标如实保留 |
| 树删除 | 完整目标枚举→子先entry.remove→根核对 | 不跟随链接，逐条实际核对；部分删除不可逆，不回报原状态未变 |
| 文件/树比较与统计 | 实际完整枚举/分段read→typed比较或汇总 | 比较大小不足以证明内容相同；不需要哈希清单；未读范围/目录枚举错误返回partial |
| 文本匹配 | file.read→显式UTF8→固定literal或已声明正则子集 | 返回字节范围、匹配及coverage；不解释shell、代码符号定义或任意自然语言 |

组合状态含 `{rootScope,frontier,completed,pending,errors,budget,goal}`，调用现有runner执行有限单步，下一run继续；依赖错误只停止真实下游。每次采样及最终采用沿原model-evolution，不新增调度器。此处没有未定义的通用递归flags。

保存文件、日志追加、整理/归档的有限原语分支与终点唯一维护于 [操作目录2.2](cli-semantic-operations.md#22-文件操作补全)的目标组合表，本页复用该合同，不复制第二份分支。其精确已给定步骤使用确定性编排和上述单原语策略，不为“保存”等场景名另训Goal或额外组合头。

## 5. 特殊文件与平台设计终点

inspect的设计类型完整列为regular/directory/symlink/character_device/block_device/fifo/socket/other；当前旧M0接口仍file/directory/symlink/other，兼容映射为regular→file、特殊类→other，共用同一底层OS读取。Linux设备类型来自stat mode与rdev，不能按`/dev`路径推断。设备/FIFO/socket允许inspect、exists、路径关系；普通字节读写/复制/截断对这些类型明确TYPE_UNSUPPORTED，不假设seek、EOF或幂等。特殊设备状态控制需设备协议，不在本轮普通FS合同中猜测。

平台证据边界：`block_device`保留在完整联合中，但本机macOS无真实fixture时其native证据标`UNVERIFIED`，禁止用`mknod`、sudo或伪设备伪造。FIFO、socket与symlink必须在沙盒内真实构造并保留证据；mock/注入不计为native覆盖。file.property.entry.identity放在link.target之后登记，file.property.links不在本批注册。

FIFO创建的后续固定映射为mkfifo(path,mode)，设备节点为mknod(path,type,mode,major,minor)，均需要专用typed effect及独立Linux fixture；socket条目由socket/bind生命周期产生，不通过touch伪造。此三类创建/流式I/O属于专用扩展设计，当前Action词表不给出可调用标签，只提供明确不支持终点。统一属性模型已覆盖其观测与拒绝；不声称本轮设计了任意Linux设备协议。

## 6. 迁移、owner与设计验收

旧PWD/CD/LIST及路径训练合同保持既有接口事实；训练时适配为file.property语义，不能同时再维护一套同义Goal。M0不默认加载新权重。实现owner为adapter固定调用、filter语义/比较、trainable数值结构、training拟合与分区、nodes和consumer封装。目录/文件原语共用，不建通用shell执行入口。

本页设计验收是：精确目录每一operation均有本页唯一映射或纯计算说明；每项有typed参数、实际回执、失败/部分副作用、类型策略和独立反例。训练设计见 [cli-property-training-design.md](cli-property-training-design.md)。真实OS执行、拟合、回载、自动采集/升级全部留给后续实现验收；本次不得以未来用例标记已通过。
