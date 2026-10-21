# Shell／文件系统基础语义完成计划与 worker 交接

状态：2026-10-21，待执行。本轮仅规划，不执行文件操作、实现或训练。用户要求Shell也按浏览器相同方式规划：基础节点隔离，组合分层，最小实验先验收，worker完成后由原编排者继续review。

本文是Shell基础这一专项的任务与验收owner；[总实施计划](implementation-plan.md)只链接入口。[file.property领域合同](cli-filesystem-semantics.md)、[调用合同](cli-call-contract.md)、[完整操作目录](cli-semantic-operations.md)、[属性训练设计](cli-property-training-design.md)及[用途证据](cli-role-evidence-design.md)仍分别维护原规则，不复制另一套命令、模型或执行引擎。浏览器计划见[browser-foundation-plan.md](browser-foundation-plan.md)，两方向不能共享隐含状态或照搬领域wire。

## 1. 目标与边界

交付可独立验证的路径、文件对象、属性/内容、局部关系和执行事实，使上层按统一`file.property.xxx`目标组合，而不把操作选择、编程用途或用户意图塞入基础事实。

当前Shell方向沿项目既有文件系统范围。起点仍为pwd、路径、目录和文件属性；目录、普通文件、链接及特殊文件共享属性框架，但各有适用操作。本计划不等于任意Shell能力全覆盖；自由shell文本生成、通用进程/管道/job control、网络、包管理、help学习、任意代码理解和自然语言意图均不在本轮。

本轮以显式绑定对象和自有临时沙盒为主，真实OS读取与副作用检查是必要证据。测试fixture的创建/变化只限自有沙盒。对真实用户文件的写入/删除、递归扫描、设备读写、提权、daemon操作和生产变更不在本任务授权内。Linux特有能力缺运行环境时明确未验证，不从macOS或合成结果推断通过。

所有Goal继续使用`file.property.xxx`，不新建cwdGoal、sourceGoal等同义入口；语义操作与实际程序名分开，harness固定命令/argv及机器协议。学生不生成shell文本，也不解析自由stdout。

## 2. 已有事实与受影响DAG

| 当前事实 | 本轮可复用 | 不能推出的结论 |
| --- | --- | --- |
| CLI M0已有cwd、路径及基础属性观测 | cli adapter、公开consumer与OS回归 | 没有证明所有文件属性/特殊类型/用途已覆盖 |
| 0.3.0注册pwd、cd、ls、path.resolve/relative/parts、entry.inspect | 固定调用、会话沙盒、引用与状态合同 | 不能认为创建、删除、内容读写或physical路径已实现 |
| 共享cli.command-policy.v1为10head×30wire、300参数 | 已有训练、回载、实际执行与回归证据 | 它是Goal/State到操作选择的组合策略，不是所有基础事实已训练完成 |
| 项目记录174train/88dev、训练图262条真实执行，独立套件有限56/56 | 亲查现存资产与运行入口后复用 | 报告fullyVerified=false及5项UNVERIFIED不能改写为全通过；先查原项目内容，不猜是哪5项 |
| 路径函数已有独立训练实验 | 保留其精确函数范围与候选 | path.resolve词法正确不代表对象存在/真实物理路径正确 |
| role、对象绑定与常见操作有设计 | 复用原scope、证据与操作合同 | 不能把文件名或扩展名当用途真值，不能把设计当运行API |

本次已读`cli-file-property.graph.json`0.3.0（6N5E）、`cli-filesystem-training.graph.json`0.3.0（8N8E）、`cli-filesystem-curriculum.graph.json`0.2.0-design（7N6E）。各有单入口单出口，训练的独立资料支路在实际执行处合流。未改拓扑，本轮不新增业务图、不重复未变校验。后续新增运行载荷/算子先检查合同兼容；不兼容时先修唯一图纸/绑定、DAGpipe validate/inspect，再按红测→实现→公开consumer验收推进。

项目存在历史合同和进度表述，启动时按当前AGENTS、有效需求和真实入口核对，只修受影响冲突。没有有效.appsdk/requirements.json时跳过，不补需求占位。

## 3. 基础层与组合层的明确分界

| 层 | 本层问题 | 不应混入的判断 |
| --- | --- | --- |
| 基础：路径知识 | 显式base/input的词法路径、组成及明确OS解析结果 | 路径好看/可解析不等于存在、可进入或有权限 |
| 基础：对象与属性 | 存在性、类型、身份、长度、mode/owner/times、内容范围等真实证据 | 扩展名不等于类型/格式；mode不等于访问资格；目录size不等于子树大小 |
| 基础：局部关系 | 父子条目、链接文本/目标、同一对象、session与cwd的当前关系 | 路径相同不等于对象相同；词法父级不等于物理祖先；关系不授予修改权限 |
| 基础：执行事实 | 是否调用、返回状态/错误、观察是否完整、副作用是否明确 | 退出码0不等于Goal成功；失败不证明没有部分写入；未知不等于未变化 |
| 二层：局部能力 | 选择必要操作、绑定未指定对象、判断指定操作适用性、读取/改变指定属性后验证 | 不得重复基础owner的事实判断，不复制每命令selector |
| 三层：抽象任务 | 整理目录、修改项目配置、定位源码/符号、备份等 | 不从任务名字直接猜对象或把计划当真实状态 |

先标每项为直接观测O、确定性计算D、学习判断L。O/D不为满足“有权重”而虚设训练；L具有推理环、训练环、样本和显式权重，使用既有infer/train接口。多个属性可共享OS采集，但分开返回语义及覆盖，不必每字段一个模型。

控制/授权使用现有typed资源，错误沿error chain保留。对象引用、路径引用、观察来源和有效性显式传递；不从日志或当前进程cwd猜业务状态。raw路径/名称可作请求参数和读取结果，不能作为学生的绝对身份泄漏特征。CLI词语输入仍按CLI合同，不机械套用DOM学生禁令。

## 4. 详细工作包S00–S20

以下21项均待worker核对与验收；已有能力允许复用有效证据，不要求重新实现/重训。每项包含多个属性时按独立问题验收，不能合并成互斥状态头。

### S00–S03：边界、证据和最小实验

| ID | 工作及产物 | 依赖/owner | 验收与反例 |
| --- | --- | --- | --- |
| S00 | 盘点实际注册操作、基础函数、共享policy、样本/候选、首次评价及5项UNVERIFIED | 本计划、note.md；读CLI领域owner | 设计/实现/训练/回载/独立验证/采用分别列；不得凭56/56抹掉未验证，不复活旧Goal/API |
| S01 | 对下列基础问题逐项定义四元素、O/D/L、合法输入、输出、错误、独立性和上层禁推结论 | S00；领域合同 | file.property目标唯一；同一事实一个owner；操作选择属于共享policy，角色与当前任务不进入基础类型 |
| S02 | 固定配方字段断言、关联组分区、同投影冲突和自身/无关变化评价 | S01；既有训练/consumer | 明确expectedType与observedType、follow模式、scope和session；能抓住配方要求断链却生成正常链接等构造错；gold不由预测反推 |
| S03 | 先做一个基础隔离最小实验：显式base/input的词法结果不随OS存在性改变，真实对象存在性不由词法结果替代 | S01/S02；path与entry.inspect公开consumer | 同一路径在不存在→创建→移除自有对象时词法输出不变、实际exists变化；拒权不变成不存在；明确D/O不强造模型。优先复用已支持函数，先验收再扩展下一个新语义 |

S03的创建/移除仅为自有沙盒fixture刺激，不等于已实现通用create/remove学生能力。若需要验证新的学习函数，先由实施独立Plan固定其输入、样本、拟合及留出；不把浏览器9参数回执实验直接迁移成CLI模型。

### S04–S09：路径、对象、目录与元数据

| ID | 工作及产物 | 依赖/owner | 验收与反例 |
| --- | --- | --- | --- |
| S04 | path.resolve、relative、parts的精确词法边界、根路径及特殊名称补证 | S03；既有path合同、adapter/纯函数 | 空格/换行/Unicode/前导横线、根/重复斜杠/`.`/`..`按各函数合同；不展开~、变量或glob；parts不得偷换成resolve；纯计算零FS变更 |
| S05 | physical路径、lstat/readlink与follow解析的差别；必要新注册先补图/调用合同 | S01–S04；CLI adapter、属性合同 | 正常/断裂/相对/循环链接及越界证据；词法相同而physical不同可辨；解析失败保留errno，不补目标不存在；缺实现标未就绪 |
| S06 | exists与type：完整8类及适用平台证据 | S03；entry.inspect底层唯一OS读取 | regular/directory/symlink/character_device/block_device/fifo/socket/other分别有真值或未验证；ENOENT、EACCES/EPERM等不混；断链的条目存在与目标存在分开；不打开特殊文件读取字节 |
| S07 | 对象身份与引用有效性：dev/ino/nlink/rdev及缺测、路径替换/移动后的关联 | S06；adapter与typed引用owner | 同路径替换不是同一对象；重命名/硬链接不按名称生成新身份；不保证跨重启inode永恒；旧引用失效显式拒绝，不能无证据重绑 |
| S08 | directory.entries：直接子项、类型、完整/部分/未知覆盖 | S06/S07；固定list helper | 隐藏/空格/换行名称保留，后代不混入；单项inspect失败时partial不伪造完整；不同session解析正确；不解析人类ls文本，不隐式递归 |
| S09 | size、mode、uid/gid及各时间项的OS观测、缺测和适用边界 | S06/S07；inspect合同 | 目录size不当递归容量；mode可读位不当实际可访问；ctime不是创建时间；birthtime/rdev不可得保留未知；不为验证变更用户权限或提权 |

### S10–S15：内容与局部关系

| ID | 工作及产物 | 依赖/owner | 验收与反例 |
| --- | --- | --- | --- |
| S10 | content.bytes只读范围合同与最小固定读取能力；普通文件先行 | S06/S07；内容adapter、调用合同 | 明确offset/length/EOF/覆盖；零字节、二进制、短读、截断及读中变化；有范围数据不声称整文件完整；拒绝把FIFO/socket/设备当regular读取 |
| S11 | 显式编码解码与格式证据（签名/parser），无依据保留未知 | S10；格式/解码owner | 相同扩展名不同字节、不同扩展名同格式、非法编码、部分内容；文件名不是gold；记录parser范围与失败，不执行文件或项目脚本 |
| S12 | 链接关系：链接文本、解析目标、硬链接同对象与目标状态 | S05/S07；局部关系filter | readlink原文与解析结果分开；断链、相对目标、多个名称同对象、链接环；link删除不等于目标删除；当前未注册links不能冒充运行API |
| S13 | 目录局部归属：直接parent/child、词法包含和真实物理范围 | S05/S07/S08；关系/边界owner | `/root/a`与`/root/ab`不同范围；symlink逃逸、`..`和前缀歧义；词法contains不得授予沙盒权限；不扫描scope外 |
| S14 | sessionCwd事实：显式session绑定、pwd观测来源、当前关系及新鲜度 | S04/S07；既有session/cwd adapter | 同一父进程下两个session独立；子进程cd不当作session已变；旧pwd不能满足this_run；父进程cwd不被修改；不从shell prompt或日志猜路径 |
| S15 | 基础证据引用与声明引用边：仅从声明parser/清单取得明确源和目标关系 | S07/S10/S11/S13；用途证据中的确定性基础 | 实际引用与同名字符串出现分开；只读配置/manifest不执行；缺枚举覆盖不判没有引用；符号定义/引用解析不在此项偷偷实现；scope/target失配拒绝 |

S15提供后续role所需的基础证据，不训练“这个文件是源码/配置”。必要scope声明若未实现则该能力未就绪，不能依靠项目文件名惯例补答案。

### S16–S20：执行事实、隔离与review交接

| ID | 工作及产物 | 依赖/owner | 验收与反例 |
| --- | --- | --- | --- |
| S16 | invocation/退出状态/stdout/stderr/原始错误与副作用知识分别保留，解码机器协议不混语义学习 | S01；CLI adapter/错误合同 | 明确未执行拒绝、启动失败、非零退出、0退出但后验失败分开；部分副作用未知不能写none；采集失败不覆盖业务错误；无需新建每命令回执分类模型 |
| S17 | 前后观测与变化事实：引用/作用域/覆盖可比较后计算属性变化 | S07–S10/S14/S16；纯比较与观察owner | unchanged/changed/unknown分开；路径相同但对象已换不能直接比较；mtime相同不证明字节未变；字段变动不证明唯一因果或根Goal达成 |
| S18 | 基础隔离及只读组合consumer；共享policy的必要旧回归 | 相关基础项作者通过；公开consumer/既有policy | 可解析但不存在、exists却拒权、类型相同用途不同、明确失败仍有部分effects、硬链接同对象不同路径；组合保留原事实，不另训新selector或用teacher纠正当前选择 |
| S19 | 独立沙盒实现家族、实际OS验收及平台边界；补清既有5项UNVERIFIED | S02及相关基础项；独立资料/OS观察owner | 至少两个独立编写的场景构造来源，路径改名不是独立家族；旧样本回归/新鲜留出分开；OS真值与学生执行分开；真实Linux缺失就保留具体未验证，不能合成清零 |
| S20 | 汇总作者验收、候选提交、复跑入口与资源状态，交原编排者review | S00–S19；worker、原编排者 | 逐项完成/失败/未验证；给分支、worktree、run、样本/权重/OS证据、命令；worker停在待父review，不合main、不采用权重、不删除待审树 |

## 5. 编程与日常文件语义如何接到后续层

以下是边界映射，不是本轮第一层训练任务。它们复用现有`file.property.role`和操作目录，不新建Goal或按命令另建模型。

| 后续语义 | 基础证据 | 局部二层能力及三层组合条件 |
| --- | --- | --- |
| source/test/config/dependency_manifest/documentation/generated/log | 字节/格式、显式声明和引用、scope成员关系 | 单次判一个指定role关系；同文件可多角色；项目结构和用途明确后才支持“修改配置/定位测试” |
| media/attachment/backup | 格式、引用/来源、范围和对象/内容关系 | 不因图片扩展名认定附件，不因`.bak`后缀认定有效备份；分别建立关系与产物条件 |
| 读取/列举/定位 | 路径、entries、内容范围、明确引用 | 对象绑定B、有限枚举与内容/名称/符号搜索分开；找到一项不代表扫描完整 |
| 创建/移动/重命名/复制/删除 | 存在、类型、身份、parent/child、范围与effects | 改变指定file.property后独立观测；复制不是只改路径；目录递归是组合，不把partial当完成 |
| 写入/追加/截断/patch/元数据设置 | 字节范围/EOF、identity、mode/owner/times、实际权限与授权 | 精确目标/局部patch/持久性分开；发生部分修改后失败不重放未知执行 |
| 指定操作的applicability | 当前基础状态＋显式操作条件 | 属于目标相关二层判断；不是基础type，也不授予权限；实际OS结果另验收 |

角色和能力在二层可以交叉覆盖，但同一基础事实只有一个owner。比如“读取配置”和“检查备份”可共享内容/格式读取，不能各自凭文件名重判类型或用途。三层继续持有根Goal和实际满足条件，不能相加子模型分数得到成功。

现有所有CLI操作选择仍使用单一`cli.command-policy.v1`共享profile，不能为pwd/cd/ls或新操作复制selector。角色R输出局部关系、不选择命令；固定parser/argv/授权不计学生能力。完整目录/文件写操作按原合同另作后续增量，不混入基础层完成率。

## 6. 推进顺序、样本与完成标准

推荐依赖：S00→S01→S02→S03；S04→S05，S06→S07→S08/S09；再S10→S11、S05/S07→S12/S13、S14及S15；S16/S17→S18/S19→S20。按实际owner只展开当前最小语义。已有证据先复用，不为同一事实重新训练。

每个学习语义：独立实施Plan固定I/O、wire、样本与拟合配置→最小反例/红测→一次已声明训练→显式保存/新进程回载→独立评价与旧回归。失败保存并诊断，不能静默延长、改标签或让harness代选正确命令。O/D项用实际函数/OS观测验收，不伪造拟合。单元依赖发生实质变化时修计划；普通执行进度不重plan。

样本充分性要求：

1. 在生成前按沙盒实现/关联家族分train、development、verification。不同路径前缀、名称或同一生成器参数不是独立来源。已看过的评价、旧真实执行和当前反例转回归，不称新鲜泛化。
2. 覆盖声明语义的结果、缺测/不适用/拒绝与具体错误；同投影不同gold先定位缺观测/缺特征。配方条件与OS实际状态逐项核对，不按配方名称猜真值。
3. 自身事实变化必须可辨，无关条件变化不能污染该输出。路径词法与存在性、文件类型与mode、角色与扩展名、回执与effects是优先交叉对照。后两项涉及二层时只核对其边界，不新增二层训练。
4. 对特殊名称、链接、权限、部分覆盖和对象替换有能抓错的反例。权限测试在高权限环境实际仍可访问时保留事实，不编造EACCES；受控故障注入单列，不冒充真实OS拒绝。
5. 新鲜独立组合/实现来源与训练分开；有限输入已穷举时如实报告没有未见特征。不能把100%小样本匹配写成任意Shell泛化。
6. 共享policy保留按操作具名回归，不看总分掩盖某个命令退化；训练report accepted/fullyVerified与外部验证不同口径分别保留。候选保持uncalibrated/not_applied。
7. 每个O/D项给公开consumer与独立OS依据；L项另给真实Handwired、非零更新、保存回载、零/冻结/缺profile适用对照。缺后端、坏权重显式失败，不fallback。
8. 精确属性验收按实际值，不拿模型logit当满足度。requiredTargetType、observedType、目录候选类型分开；property observed取得反例值也可完成“观测”，不偷换成要求值为真。
9. 所有已声明必需边界/隔离/旧能力无未解决错误；无法观测的必需项仍未完成。缺Linux证据、role范围、真实读回或权限场景必须逐项报告，不用unknown或其它通过数抵消。

最小实验通过后才扩展下一新语义；无依赖只读审计/独立样本准备可以并行，禁止多worker改同一schema/profile。若阶段合同变更影响下游，先停真实下游。完整语义交付milestone作者自检后review一次；不是每次编辑review。按用户分工，本轮worker提交按单元分章的完整候选，由原编排者继续独立review后集成。

## 7. owner、交付与停止条件

- `lib/adapters/cli/`：固定OS/CLI读取、沙盒与执行回执；不做语义打分或自由shell。
- `lib/filters/`：局部属性/关系计算、显式评分及共享policy；不调用OS补测、不改授权。
- `lib/nodes/`与`lib/training/`：复用workflow包装、profile与数值训练；不复制基础算法或命令selector。
- `workflows/`：实际拓扑和绑定。新增schema不得冒用旧绑定；图与NodeDefinition版本按项目bumper。
- `playground/`、`tests/`：公开consumer、沙盒场景、必要红绿/黑盒。过程和原始资料放外置run，模型资产沿既有training目录/忽略规则；不新增根目录或机器manifest。
- 领域合同只改其唯一owner；本文只记专项任务/依赖/验收，note.md只汇总实际状态。

每项交付：四元素、O/D/L、必要输入与输出、适用范围、合同/图/入口、实际样本/OS证据及gold来源、拟合或不训练依据、自身/无关配对、旧回归与失败、可重放命令、候选和资源路径。所有控制/配置显式传递，秘密不入证据报告。

第一层完成必须S00–S20在声明范围内全部验收，所有必需未验证项关闭，并经原编排者review。否则仅报告部分完成。存在特殊文件或Linux观测缺口不允许通过忽略这些行把完整Shell基础标完成；可按明确受限范围交付，但不能私自改变需求范围。

发生缺必要状态、冲突gold、可表达但拟合未达标、原始错误丢失、部分effects被清除、沙盒越界或评价前提不成立时，保留证据并停止受影响链。脚本构造错仅修脚本，复用同一候选补测；需要新训练/表示的修订先有独立计划，禁止追分调参。

## 8. 可直接交给 worker 的完成提示词

```text
请直接执行NNAnything Shell／文件系统第一层基础语义完成任务，不再只返回建议或另一份提示词。

项目：/Volumes/extension/code/NNAnything
详细计划及全部任务：/Volumes/extension/code/NNAnything/docs/cli-foundation-plan.md

用户要求与浏览器同样的基础隔离、谨慎组合和逐个最小实验；本轮完成后由原编排者继续review。目标统一file.property.xxx，不生成自由shell文本，不为命令复制selector。

先读当前AGENTS.md、该计划全文、note.md、本地nnanything-design Skill；涉及CLI拟合时读nnanything-training Skill的CLI路由。读cli-filesystem-semantics.md、cli-call-contract.md、cli-property-training-design.md、cli-semantic-operations.md及用途证据合同的适用部分。存在.appsdk/requirements.json则核对当前有效项，不存在跳过。

按S00–S20依赖推进。先盘点当前7个语义操作/3个控制head、共享10×30模型与真实资产，亲查fullyVerified=false和5项UNVERIFIED，不能凭56/56替它们清零。先完成S03最小基础隔离实验，再按属性问题逐个扩展。区分O直接观测、D确定性计算、L学习判断；O/D不造训练头，已有兼容能力及有效证据不重做。

底层必须隔离：词法路径不等于physical/存在，路径不等于对象身份，mode不等于实际权限，扩展名不等于格式/角色，回执成功不等于Goal成功，失败不等于无部分effects。角色source/test/config等依赖scope和证据，属于后续层，不混入基础文件类型。目录、普通/特殊文件共享属性框架但不共享全部操作语义。禁止打开FIFO/socket/设备流做普通文件读取，不为取得Linux证据而提权或访问真实设备。

全部已注册CLI操作仍用同一cli.command-policy.v1；NN选择固定操作和参数引用，harness构造程序/argv/协议，OS真值独立验证。类型与目标类型、session与父cwd、读取范围与全量覆盖分别保留。未绑定query不隐式扫描；无效/过期引用明确拒绝，不从日志重建control或绑定。

代码开工前按项目流程独立Plan、受影响DAG/SESE、图/绑定/gate、红测、唯一owner实现、真实公开consumer回归。项目代码用最新origin/main的外置独占worktree，位置仅/Volumes/Intel/playground/nnanything/，分支codex/前缀；先盘点存量和保护他人dirty，先关旧树再开新树。过程放/Volumes/Intel/playground/nnanything-runs/独占目录。用apply_patch，不新增根目录/平行执行引擎/机器manifest，不绕hook，不算哈希或候选身份包装。

所有文件变更只限自有沙盒fixture和授权代码；不修改/删除真实用户文件、不扫真实磁盘、不提权、不改系统权限/daemon。平台不支持/权限前提不成立时如实保留未验证；合成或注入不冒充真实OS。每个学习单元拟合前准备分区和独立评价、逐项核对配方与实际FS状态，真实训练、保存、新进程回载，旧候选不变且不采用。失败保留，不改gold、不删错例、不静默延长或用teacher纠正学生选择。

如果你是受托长程peer，负责本目标拆解、调度和资源收口；按实际宿主的codex-orchestrator/dsh-create执行。执行/观察一次性任务优先GCM，独立Planner/Reviewer按各自路由，不用会话内spawn_agent替代。不初始化/等待Collab注册。并行只做ready且owner不冲突的资料与执行；共享合同/profile单owner，通过唯一集成分支合流，不跨树手工拼文件。一次性subworker只做派定scope，不自行再派发。

按单元保留合同、图、代码和样本/权重/真实OS证据，记录自身变化、无关变化、错误/部分副作用和独立来源，提供最短复跑命令。note.md汇总S00–S20完成/失败/未验证，不能把所有基类已有或共享policy已训练当作第一层完成。高层目录修改、备份、搜索、编程用途和任意命令理解不在本基础阶段扩展。

作者自检和适用验收完成后提交可审查候选，报告分支、worktree、run、修改范围、逐项结果、样本/权重/训练与回载、真实OS及副作用证据、复跑命令和资源状态。交回原编排者继续独立review，不自行合main、push main、部署或采用权重，不删除尚待审查的worktree。未完成项如实列出，不自称全部DONE或review PASS。候选分支提交不等于main交付。

缺证据/失败只停真实下游，保留原始结果和恢复条件，其余无依赖任务继续。直接执行本任务。
```
