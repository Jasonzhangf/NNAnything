# Shell 训练全路线与当前读取实验

研究员负责详细设计，Alice定义统一模板并审计设计和结果；执行为明确派单的GCM worker；正式集成与note.md由Jenny负责。路线初稿日期：2026-10-25。

目标是自主使用已训练的 CLI 技能，并通过真实反馈和后训练扩展工具集合。不是背诵命令文本，也不承诺有限数据覆盖任意程序。本文规划完整训练范围；除当前读取实验外，列项不等于实现、训练或执行授权。

## 阶段与设计深度（用户明确要求）

2026-10-28用户最新排序：先完成Shell基础语义，基础语义完成后再讨论高级应用训练。研究员按[统一语义训练设计模板](../.agents/skills/nnanything-training/references/semantic-design-template.md)梳理下列S0–S12及既有文件操作定义，优先逐项完成基础语义的详细设计、数据审核、必要训练与独立验收；多条件复杂组合及S12等高级应用训练后置。已通过的基础能力复用证据与权重，完全确定的工具内部行为不虚设拟合，缺失执行原语单列实现依赖。训练设计完成不等于数据已验收或实际训练完成。下文读取阶段顺序保留为历史切片，不能据此限制新设计，也不能把旧状态当成当前能力事实。

第一阶段是当前读取探索：真实shell样本经审核入库，先验证实际需要的E/A，再验证组合与继承权重的增量学习。单步读取的R绑定与D直接路径不虚设训练；后续出现实际关系/分解需求再单独训练。当前有限实验及边界统一见[原生读取实验汇总](cli-native-read-experiment.md)，下一批详细设计见[搜索后读取学习](cli-search-read-learning.md)。这些离线成绩不等于四头整体或正式后端交付，硬argmax组合不冒称端到端联合反传。

第一阶段验收通过后，研究员按已验证方法与统一模板完成下一批基础语义的详细设计，给出样本矩阵、各头I/O、依赖、训练预算与停止条件；Alice独立审计设计与数据，通过后由Jenny派单GCM按独立语义/来源家族并发执行。并发充分利用已确认算力与内存容量，不按固定串行队列等待；无依赖的单头训练可并行，联合阶段须等待其实际依赖通过。各任务独占样本和输出目录，不并发覆盖同一profile，不用重复拟合或验证泄漏换取吞吐。Jenny负责调度巡检及集成，Alice负责设计与结果审计验收。

## 1. 不变的框架

文件系统目标沿 `file.property.xxx`，不重建并行词表。原语合同沿 [cli-semantic-operations.md](cli-semantic-operations.md)、[cli-call-contract.md](cli-call-contract.md)；R/D/E/A 唯一合同为 [l2-four-head-experiment.md](l2-four-head-experiment.md)。复用 l2-four-head-step 8N7E责任图和recursive-goal 3N2E执行图，不新增推理循环。本轮为训练规划，不改变运行DAG；每个未来实现切片仍先检查其受影响图。

L1：真实对象、属性、缺测、基础识别、固定操作与回执。OS可精确测量的事实不再让网络猜；已有基础分类能力保持其独立训练。

L2：R学目标/对象/条件关系；D学有界条件与依赖；E学当前条件和反馈评价；A学合法候选优选。各头先单独训练、单独验收，再训练实际预测组合。权限、对象身份、精确参数计算、预算和根事实否决保持确定性，不用MLP替代安全边界。

## 2. 真实样本生成与入库

流程：声明场景及来源分区 → 真实shell构造自有沙盒 → 实际CLI操作 → 保存原始记录及独立后验 → 加工语义样本 → Alice验收 → 入库 → 单头训练/验收 → 联合训练/整链验收。

每条原始记录保留固定命令及argv、cwd/session、输入引用、退出码、stdout/stderr原始字节、超时/信号、真实前后事实与采集来源。Shell构造、shell操作、生产typed执行、独立OS观测分别标明；不得把API调用改名为shell执行。使用固定argv及安全fixture脚本，不将不受信名称插入shell字符串。不要保存凭据或真实用户文件。

现有sandbox若只支持recipe创建，可由shell先生成源fixture，再将实际字节导入recipe；同时记录源文件和sandbox导入事实。当前生产read与固定shell读取做同fixture对照，保留范围、字节、错误及平台差异。缺命令或无法表达的失败保持UNVERIFIED，不伪造errno。

加工只转换格式并提出监督，不伪造观测。未知保持未知。teacher标签、oracle、内容、绝对路径、caseId不得进入不允许读取这些字段的学生输入。标签按既有语义合同确认，不根据模型结果修改。

四头独立生成器可以共用生产API，但不互抄生成器或把同一模板称为独立验证家族。先分来源关联组再生成；TRAIN/DEV/最终verification分开，验证由独立owner保管。参数外推、模板来源差异和语义组合未见分别报告。

入库条件：所有声明语义格子有真实证据或显式缺口；关键边界全部核验；原始回执可追溯；完整投影无相反合法gold碰撞；不存在标签泄漏；分区清楚。重复展开不增加独立任务数。只入库已批准范围，不能把整批proposal默认标verified。

## 3. 完整训练能力目录

| 顺序/能力族 | 基础对象与固定操作示例 | R/D需要学习的关系 | E/A需要学习的反馈及验收 |
| --- | --- | --- | --- |
| S0 会话与路径 | session、pwd/cd、路径词法、绝对/相对路径 | 当前会话/目标目录/前置条件；词法与存在性分开 | 实际cwd读回、子进程不改父session、路径歧义补观察、不可达停止 |
| S1 类型、身份与元数据 | stat/lstat、readlink、ls、mode/时间/dev/ino | 名称与对象、链接自身与目标、目录范围和覆盖 | 缺失/拒权/替换/stale/缺测；inode、时间、size不能互相冒充内容事实 |
| S2 读取（当前） | 已绑定普通文件、原生head/tail行读取；受信字节read是独立API合同 | 目标方向、实际操作、输出行数与证据充分性；不强加size→offset依赖 | 空/短正常成功、反向读取等价或证据不足、真实反馈后补读；执行异常只按实际支持域评价 |
| S3 文本读取特征 | 字节/编码、head/tail行、限定字符/行数 | 字节、字符、行边界；末行换行与多字节字符 | 解码失败/二进制/截断；读到了什么特征，不要求理解正文含义 |
| S4 编程搜索 | find/rg/grep的受控子集；目录、文件、行、匹配范围 | 名称匹配与内容匹配、literal/regex、范围、one/all、递归依赖 | 无匹配不等于执行错误；partial不能说全部未找到；拒权、忽略规则、符号链接边界 |
| S5 聚合与有界管道 | 流、sort/uniq/wc/cut等已注册操作；显式有限AST | producer/consumer输入输出类型、顺序、分隔符、数据依赖 | exit0不等于内容满足；阶段错误、SIGPIPE、stderr、空流、截断、超时；不靠最终exit掩盖中间失败 |
| S6 创建与修改 | mkdir、create/write/append/truncate/copy/move/remove的受控原语 | 父子依赖、目标存在、覆盖策略、修改区域/不变量 | 字节与目录真实读回、范围外不变、部分写入、跨设备；仅自有沙盒，不用自动重试掩盖副作用 |
| S7 链接、权限与特殊文件 | hardlink/symlink、mode/owner/time、FIFO/socket/device | 同对象多名称、是否跟随、可访问与mode区别、类型能力 | 链接环、断链、阻塞、有界读取、权限限制；macOS/Linux分别验，不清零既有UNVERIFIED |
| S8 程序运行与编程验证 | executable、argv/env/stdin、退出与测试报告 | cwd/依赖/输入、运行器与测试目标、构建→测试前置关系 | 超时/信号/进程失败/测试失败分别归因；未跑测试≠测试通过；只管理自有进程 |
| S9 工作区与版本操作 | Git只读状态/diff，后续受控修改/暂存/提交 | 工作区/索引/版本关系、修改目标、冲突与归属 | dirty保护、内容差异、冲突准确停止；破坏性操作和远端发布单列授权 |
| S10 打包与环境工具 | 压缩包、包管理、安装/构建配置 | 格式/目标路径/依赖、可用工具/版本能力 | 路径穿越、下载失败、部分安装、可复现性；只在独立环境，不操作宿主全局依赖 |
| S11 未知CLI扩展 | 真实help/version、声明schema与沙盒探针 | 新工具的能力、参数角色、对象及已有语义映射 | LLM提案经实际探针确认；不理解语义与缺技能分开；unknown不是可随意执行 |
| S12 开放编程目标组合 | 搜索→计划→修改→测试的已注册技能 | 多候选目标图、依赖、覆盖与冲突、有限前瞻 | 每步观察、失败归因、可行次选、累计预算、checkpoint与副作用；失败经验后训练 |

表内命令只是候选载体，不等于已经开放任意flags。每个能力族先固定typed语义及命令子集，再生成样本。S4已完成的单命令递归搜索有限实验直接复用；基础语义（S0–S3、S1/S5/S6/S7基础原语）优先完成，多条件复杂组合与S12高级应用训练后置。S5不支持无限shell语法、任意eval或无限递归管道。网络、远程服务、交互终端程序归S11扩展，不因本目录存在自动授权调用。

### 3.1 既有基础语义与 S0–S12 全量盘点表（按 `P1–P6` + `B / R / C` 原文合同与统一模板）

下表按 [semantic-design-template.md](../.agents/skills/nnanything-training/references/semantic-design-template.md)、[cli-property-training-design.md](cli-property-training-design.md)、[cli-filesystem-training.md](cli-filesystem-training.md)、[cli-semantic-operations.md](cli-semantic-operations.md) 与 [cli-command-design.md](cli-command-design.md) 盘点 `S0–S12` 与既有基础语义（`P1–P6` + `B / R / C`），逐项区分 `设计 / 实现 / 训练 / 独立验收 / 正式交付` 状态，并统一收敛到单一共享命令策略 `cli.command-policy.v1`（按名累积演进 `Stage 0: 10×31 -> Stage 1: 11×34 -> Stage 2: 13×38 -> Stage 3: 19×61 -> Stage 4: 25×69 -> Stage 5: 28×72`）与确定性 6N5E 后验评估（`cli-file-property 0.3.0.0000`）：

| 能力族/既有语义名 | 合同及代码入口 | 设计/实现/训练/独立验收/正式交付状态 | 已有证据与适用范围 | 依赖及当前缺口 | 下一动作与owner |
| --- | --- | --- | --- | --- | --- |
| `S0` `P1` `cwd.get` (`pwd`) / `cwd.set` (`cd`/`NOOP`) 与 6 参数 `cwd-relation` | [cli-filesystem-semantics.md](cli-filesystem-semantics.md) §6、[cli-filesystem-training.md](cli-filesystem-training.md) §0–1、[cli-property-training-design.md](cli-property-training-design.md) §3.1；`lib/adapters/cli/filesystem-sandbox.ts`、`lib/filters/cli-command-policy.ts`、`lib/filters/cwd-relation.ts` | 设计：完成（`Stage 0: current-10x31`）；实现：完成；训练：完成（`35bd5ad9` 10×30 / `fb73d4a0` 10×31，保持 `uncalibrated/not_applied`）；独立验收：完成（56/56 + 34/34）；正式交付：已合入 `main` | `/bin/pwd -P`、固定 zsh `cd` 脚本提交 `S` 并后验；`cwd-relation` 6 参数 `MATCH/NO_MATCH` | **【已验证可复用（Stage 0 基线 `262` 条样本）】** 共享策略 `pwd/cd/NOOP` 与 6 参数 `cwd-relation` 已闭合 | 作为 `Stage 1..5` 按名迁移与重放回归基线（CLI owner） |
| `S0` `P1` `path.resolve` / `path.relative` / `path.parts` 词法路径原语 | [cli-path-training.md](cli-path-training.md)、[cli-filesystem-semantics.md](cli-filesystem-semantics.md) §7、[cli-property-training-design.md](cli-property-training-design.md) §3.1；`lib/filters/cli-path.ts`、`lib/filters/cli-path-controller.ts`、`lib/filters/cli-command-policy.ts` | 设计：完成（`Stage 0: current-10x31`）；实现：完成；训练：完成（符号栈控制器 + 共享选头 `35bd5ad9`）；独立验收：完成（56/56）；正式交付：已合入 `main` | 词法 `resolve/relative/parts` 零 FS 访问；共享 policy 选头 `262/262` | **【已验证可复用 + 确定性无需拟合】** 词法计算本身为纯函数，选头已验证 | 保持 `Stage 0` 262 条样本重放回归（CLI owner） |
| `S0/S1` `P1` `path.realpath` (`file.property.path.physical`) 与 `P2` `entry.inspect(followSymlinks)` 软链接目标消歧 | [cli-property-training-design.md](cli-property-training-design.md) §3.1、[cli-filesystem-semantics.md](cli-filesystem-semantics.md) §2 & §7、[cli-command-design.md](cli-command-design.md) §2 | 设计：完成（§8 `Stage 1: stage1-11x34`，`11 × 34 = 374`p，`310` 条累积样本）；实现：`entry.inspect(followSymlinks)` 已实现，`path.realpath` 与 `observe.resolvedTarget` 待 `Phase A` 工程准备（已获 Alice 放行）；训练：`NOT_READY`（待 Phase A 验收与数据准入审计）；独立验收：inspect 56/56 已验，`realpath` 未开始；正式交付：未交付 | `entry.inspect` 已支持 `followSymlinks` 双事实（`entryExists` / `resolvedTargetExists`）；`Stage 1` 仅按名新增 `path.realpath` head 与 3 条 wire | **【Stage 1（`P1–P2` 最小缺口补齐）】** 在 `lib/adapters/cli/entry-inspection.ts` + `lib/adapters/cli/entry-inspect-helper.ts` 中扩展 `operation: "path.realpath"` + 共享矩阵 `10×31 -> 11×34` 按名迁移与 6N5E 确定性后验（不造 MLP） | Jenny 推进 Stage 1 产品工程切片；Emma 负责训练 consumer / 数据 / 评价入口准备并单 writer 交接 |
| `S1` `P2` `directory.list` (`ls`) 与 `entry.inspect` 八项基础属性观测（`exists/type/size/mode/owner/times/link.target/entry.identity`） | [cli-list-training-design.md](cli-list-training-design.md)、[cli-filesystem-semantics.md](cli-filesystem-semantics.md) §6–7；`lib/adapters/cli/directory-listing.ts`、`lib/adapters/cli/entry-inspection.ts` | 设计：完成；实现：完成；训练：完成（`Stage 0: 10×31` `ls`/`entry.inspect` head）；独立验收：完成（56/56，macOS `block_device` native 保留 `UNVERIFIED`）；正式交付：已合入 `main` | 固定 helper `readdir+lstat` 与 8 类 `EntryType`、`bigint` 身份保真 | **【已验证可复用】** 单目录列举与 8 项属性观测选头及 6N5E 后验已闭合 | 保持 `Stage 0` 重放回归，供 `Stage 1..5` 复用（CLI owner） |
| `S1` `P3` `directory.select` / `file.select`（`select.entry`）与 4 参数线性关系模型 `B` | [cli-property-training-design.md](cli-property-training-design.md) §2 & §3.2、[cli-semantic-operations.md](cli-semantic-operations.md) §4–8；`lib/filters/cli-entry-search.ts` | 设计：完成（§9 `Stage 2: stage2-13x38`，`13 × 38 = 494`p，`358` 条累积样本 + 独立 4 参数线性 `B`）；实现：确定性 `nnanything/cli-search` 已实现，`directory.select`/`file.select` 共享 head 与 4 参数 `B` 待 Phase A 接入；训练：`NOT_READY`；独立验收：未开始；正式交付：规则版在 `main` | 原文 `B` 固定为 `p = sigmoid(b + w_n*name_equal + w_t*type_equal + w_p*parent_equal)` 4 参数线性 BCE 模型，不扩 `R30` MLP | **【Stage 2（`P3 + B`）】** 共享矩阵 `11×34 -> 13×38` 按名迁移 + 独立 4 参数线性模型 `cli.directory-select-relation.v1` / `cli.file-select-relation.v1` | Alice 审计 §9 `p3/plan.md`；通过后执行 Phase A（Emma / CLI owner） |
| `S2/S4` 原生行读取 `file.read.lines`（`head`/`tail -n N`）与编程搜索基础（按 §3.3 表 2.3-A/2.3-B 三分：原生命令递归搜索 vs P3 指定知识保留 vs 旧自展开搜索路线退役） | [cli-native-read-experiment.md](cli-native-read-experiment.md)、[cli-programming-search-m1.md](cli-programming-search-m1.md)；`lib/adapters/cli/filesystem-sandbox.ts`、`lib/adapters/cli/command-search.ts`、`lib/filters/cli-command-search.ts` | 1. 原生行读取 `head/tail`：设计/实现/训练/独立验收完成（110/110），原语在 `main`；<br>2. 原生单命令递归搜索（`rg`/`grep`/`find -P`）：运行合同在 `main`（沙箱 `8/8`、过滤 `18/18`、单命令有限实验 DEV `43/43` + VERIFY `70/70` + `2/2`），正式神经策略训练 `NOT_READY`（须按 §3.3 提交样本/分区/I-O/配方预算/分母/固定入口另审）；<br>3. P3 指定知识（`entry.inspect × search.nameNeedleSegment`）：从持久基线 `ba10a538`（`fb73d4a0` 仅标为历史记录）按名迁移并保持 `delta === 0`（`train.mjs` 第 211 行）与 `24/24` 偏好回归，不包装为原生递归搜索；<br>4. 旧自展开搜索轨迹与步数/深度预算监督（`P2-T12`、`P2-T14a/b/c`）：**已退役**，不进入新搜索拟合，`cli-p1-p2-stage1/receipt-unblock/new-consumer-p2.json` 与 `new-family-p2.json` 中 `T12` 原始失败回执原样保留 | 已验证正反向行读取与原生单命令子树搜索；单目录 `30/30`、单文件 `17/17` 确定性过滤与受控读组合 `27/27` 保留 | **【二分治理（见 §3.3）】** 保留 `head/tail`、P3 指定系数 `delta === 0` + `24/24` 偏好、单目录/单文件及原生命令搜索回归；旧自展开搜索训练路线退役 | 保持表 2.3-B 有效回归；新原生搜索训练待提交样本/分区/固定入口经 Alice 审核与 Jenny 派单 |
| `S3` `P2` `file.property.content.format` 与 `P3` `file.property.role`（`R` 18 参数线性用途关系模型） | [cli-property-training-design.md](cli-property-training-design.md) §3.1 & §4、[cli-role-evidence-design.md](cli-role-evidence-design.md)；`lib/filters/cli-content.ts`、`lib/filters/cli-declaration.ts` | 设计：完成（见 §12.2）；实现：`observeContentFormat`（单测 6/6）与 `readDeclaredReferences`（单测 9/9）纯函数已实现；18 位沙盒证据采集器未实现；训练：格式解码确定性无需拟合，`R` 18 参数模型待证据采集器就绪后训练 | 确定性解码/签名/JSON 校验无需 NN 重学；`R` 18 参数模型固定为 `p = sigmoid(b + sum_{k=1..17} w_k * x_k)` | **【确定性无需拟合（`content.format` 解码/签名）+ 待补证据采集器（`R` 18 参数线性模型）】** 不造 `E20` MLP | 保持 `cli-content.ts` 确定性单测；`R` 排在 `P1–P6` 共享矩阵闭合后（CLI owner） |
| `S6/S7` `P4` 目录与文件创建、软硬链接、移动与删除（`directory.create`/`file.create`/`link.create`/`file.link`/`entry.move`/`entry.remove`）与 `file.property.links` | [cli-property-training-design.md](cli-property-training-design.md) §3.3、[cli-semantic-operations.md](cli-semantic-operations.md) §2、[cli-command-design.md](cli-command-design.md) §2 | 设计：完成（§10 `Stage 3: stage3-19x61`，`19 × 61 = 1159`p，`574` 条累积样本）；实现：未实现（`Phase A` 工程准备）；训练：`NOT_READY`；独立验收：未开始；正式交付：未交付 | `O_CREAT\|O_EXCL`、`RENAME_EXCL`/`RENAME_NOREPLACE`、同 FS `link`、非递归 `unlink/rmdir` 与 6N5E 确定性后验（不造 `E23` MLP） | **【Stage 3（`P4` 6 个单目标受控原语）】** 共享矩阵 `13×38 -> 19×61` 按名迁移（保留 `property.entry.identity`，新增 `property.links` 等 23 列） | Alice 审计 §10 `p4/plan.md`；通过后执行 Phase A（Emma / CLI owner） |
| `S2/S6` `P5` 普通文件字节读取与单文件确定性写/改/复制（`file.read`/`file.replace`/`file.write`/`file.append`/`file.truncate`/`file.copy`） | [cli-property-training-design.md](cli-property-training-design.md) §3.4、[cli-semantic-operations.md](cli-semantic-operations.md) §2.4、[cli-command-design.md](cli-command-design.md) §3 | 设计：完成（§11 `Stage 4: stage4-25x69`，`25 × 69 = 1725`p，`718` 条累积样本）；实现：`file.read` 已实现，5 个单文件写/复制原语待 Phase A 实现；训练：`NOT_READY`；独立验收：`file.read` 规则已验，共享策略待验；正式交付：`file.read` 在 `main` | 单目标显式参数确定性写入（不做 multi-edit/代码生成）；fd + `dev/ino` 核验与独立后验回读 | **【Stage 4（`P5` 6 个文件字节与长度原语）】** 共享矩阵 `19×61 -> 25×69` 按名迁移（新增 `property.content.bytes`、6 个 P5 predicate 与 `state.hasPayload` 共 8 列） | Alice 审计 §11 `p5/plan.md`；通过后执行 Phase A（Emma / CLI owner） |
| `S7` `P6` 权限、属主与时间戳设置（`entry.mode.set`/`entry.owner.set`/`entry.times.set`） | [cli-property-training-design.md](cli-property-training-design.md) §3.5、[cli-semantic-operations.md](cli-semantic-operations.md) §2.2、[cli-command-design.md](cli-command-design.md) §5 | 设计：完成（§12 `Stage 5: stage5-28x72`，`28 × 72 = 2016`p，`796` 条累积样本）；实现：未实现（`Phase A` 工程准备）；训练：`NOT_READY`；独立验收：未开始；正式交付：未交付 | fd 绑定 `fchmod`/`fchown`/`futimes`；请求修改 `ctime/birthtime` 路由 `unsupported`；跨用户 `chown` 成功分支保留 `UNVERIFIED` | **【Stage 5（`P6` 3 个元数据设置原语，收口 `28×72`）】** 共享矩阵 `25×69 -> 28×72` 按名迁移（新增 3 个 head 与 3 列 `equals.{mode,owner,times}`） | Alice 审计 §12 `p6/plan.md`；通过后执行 Phase A（Emma / CLI owner） |
| `S5/S8–S12` 统计管道（`S5`）、程序运行（`S8`）、Git（`S9`）、环境工具（`S10`）、未知 CLI（`S11`）、目录树组合 `C` 与开放编程组合（`S12`） | [cli-training-roadmap.md](cli-training-roadmap.md) §3、[cli-property-training-design.md](cli-property-training-design.md) §5、[cli-programming-compositions.md](cli-programming-compositions.md) | 设计：`C` 见 §12.3，编程组合由 Alice 维护于 [cli-programming-compositions.md](cli-programming-compositions.md)；实现/训练/验收：按用户 2026-10-28 最新指令**排在 `P1–P6` 基础原语之后** | 单步基础语义 `P1–P6` 闭合前不启动 multi-edit 或高级组合训练 | **【后续批次 / 高级应用后置】** 先完成 `P1–P6`（`Stage 1..5`）与 `B` 基础语义，再推进高级组合 | 挂起后置，不混入当前 `P1–P6` 基础批次 |

### 3.2 基础语义分类汇总与 `P1–P6` 累积演进队列

按用户与 Alice 最新正式分工（`m1793201013812-389`、`m1793202108326-414`、`m1793202864863-436`、`m1793203349808-451`），Shell 基础语义严格回到既有落盘文档的 `P1–P6` + `B / R / C` 编号与线性模型合同，不新建 `F1–F7` 编号，也不为确定性 OS 后验虚设 `E23`/`R24`/`R30`/`E20` MLP：

1. **分类 I：已验证可复用基线（`Stage 0: current-10x31`，`10 × 31 = 310` 参数，`262` 条真实样本：`174 train + 88 dev`）**
   - 包含 7 个已交付执行 head（`pwd`, `cd`, `ls`, `path.resolve`, `path.relative`, `path.parts`, `entry.inspect`）与 3 个控制 head（`unsupported`, `DEFER`, `NOOP`），持久可读基线 `ba10a538`（`fb73d4a0` 仅标为历史记录）中的 P3 指定系数 `entry.inspect × search.nameNeedleSegment`（保持 `delta === 0` 与 `24/24` 偏好回归，不包装为原生递归搜索），以及独立 6 参数 `cwd-relation`、原生 `file.read.lines`（`head/tail`）和原生单命令搜索有限实验成果（旧自展开搜索轨迹与 `P2-T12`/`T14a-c` 步数/深度预算监督按 §3.3 退役，原始 `T12` 失败回执保留）。
2. **分类 II：确定性无需拟合（由固定纯函数、fd 安全打开协议或 6N5E 确定性后验比较器直接保证，不虚设神经网络）**
   - 词法路径计算、`boundRefs` 签发、`dev/ino`（`OsInteger` `bigint`）身份核对、`O_CREAT|O_EXCL` / `O_NOFOLLOW` / `RENAME_EXCL` / `RENAME_NOREPLACE` 安全边界。
   - `cli-file-property` 6N5E（`0.3.0.0000`）中 `cli.file.evaluate` 对 `actualPostState` 与目标 `Goal.requirement` 的确定性满足度计算（`achieved/100`、`unmet/0`、`unknown/null`）。
   - `observeContentFormat` / `detectSignature` / `decodeUtf8` 与 `file.property.operation.applicability` 确定性门控。
3. **分类 III：`P1–P6` 单一共享策略矩阵（`cli.command-policy.v1`）五阶段按名累积演进队列（单 writer 串行推进 Stage，设计/脚手架可并行准备）**
   - **`Stage 1`（`P1–P2` 最小缺口，`stage1-11x34`）**：`10 × 31 -> 11 × 34 = 374` 参数（`+1` head `path.realpath`；`+3` wires `property.path.physical`, `predicate.observe.physical`, `predicate.observe.resolvedTarget`），累积样本 `206 train + 104 dev = 310`（`+32 train, +16 dev`）。详见**第 7 节与第 8 节**。
   - **`Stage 2`（`P1–P3` 目录/文件精确关系选定，`stage2-13x38` + 独立 4 参数 `B`）**：`11 × 34 -> 13 × 38 = 494` 参数（`+2` heads `directory.select`, `file.select`；`+4` wires `predicate.select.entry`, `selectorTargetType.{unspecified,regular,directory}`），累积样本 `238 train + 120 dev = 358`（`+32 train, +16 dev`）；配套训练原文 4 参数线性 BCE 模型 `B`（`cli.directory-select-relation.v1` 与 `cli.file-select-relation.v1`）。详见**第 9 节**。
   - **`Stage 3`（`P1–P4` 受控创建/软硬链接/移动/删除，`stage3-19x61`）**：`13 × 38 -> 19 × 61 = 1159` 参数（`+6` heads `directory.create`, `file.create`, `link.create`, `file.link`, `entry.move`, `entry.remove`；`+23` wires：保留 `property.entry.identity` 并新增 `property.links`、6 个 P4 predicate、4 个 `requiredTargetType.*`、9 个 `observedType.*` 与 3 个 `state.*`），累积样本 `382 train + 192 dev = 574`（`+144 train, +72 dev`）。详见**第 10 节**。
   - **`Stage 4`（`P1–P5` 普通文件字节读取与单文件确定性写/改/复制，`stage4-25x69`）**：`19 × 61 -> 25 × 69 = 1725` 参数（`+6` heads `file.read`, `file.replace`, `file.write`, `file.append`, `file.truncate`, `file.copy`；`+8` wires：`property.content.bytes`、6 个 P5 predicate 与 `state.hasPayload`），累积样本 `478 train + 240 dev = 718`（`+96 train, +48 dev`）。详见**第 11 节**。
   - **`Stage 5`（`P1–P6` 权限/属主/时间设置收口，`stage5-28x72`）**：`25 × 69 -> 28 × 72 = 2016` 参数（`+3` heads `entry.mode.set`, `entry.owner.set`, `entry.times.set`；`+3` wires：`predicate.equals.{mode,owner,times}`），累积样本 `530 train + 266 dev = 796`（`+52 train, +26 dev`）。详见**第 12 节**。
4. **分类 IV：高级组合与后续批次（后置）**
   - `R`（18 参数文件用途关系线性模型，待 18 位沙盒证据采集器就绪）、`C`（多步目录树递归组合，复用 `runRecursiveGoal` 3N2E）及编程组合（由 Alice 维护于 [cli-programming-compositions.md](cli-programming-compositions.md)）排在 `P1–P6` 基础原语之后，不在 `P1–P6` 中引入 multi-edit 或代码生成。

### 3.3 2026-10-29 搜索训练纠偏：原生命令递归、三层覆盖分离与旧知识/回归精确二分（`C1 / C2` 闭合）

按用户纠正与已通过 Alice 复核的方法合同（`/Volumes/Intel/playground/nnanything-runs/cli-search-training-correction-20261029/cli-search-design-r2.md` 及 `alice-review-r2.md`）：

1. **S1/S2/S4 搜索动作空间与停止条件纠偏**：
   - 跨目录文件名称搜索与跨文件内容搜索统一由原生 CLI 命令（`find -P`、`grep -R -I -n -F --`、`rg --json --no-config -F --`）一次性递归完成；学生模型只学习选择搜索命令、绑定 `s0`/`s1` 与匹配谓词槽位、判读命令回执，以及在命中后按 `followUpRead` 发起针对命中文件的受控 `file.read`。
   - **退役自展开轨迹与步数预算监督**：严禁采集或训练“模型逐步 `ls -> entry.inspect -> cd -> 分块 file.read` 维护 `pendingDirectories` 队列遍历未知子树”的自展开轨迹；移除 `maxDirectoryDepth`（`P2-T14a/b/c`）与 `transitionBudget`（`P2-T12`）作为搜索语义停止条件。`/Volumes/Intel/playground/nnanything-runs/cli-p1-p2-stage1/receipt-unblock/new-consumer-p2.json` 与 `new-family-p2.json` 中的 `T12` 原始失败回执（`actual: budget_exhausted` vs `expected: interrupted`）原样保留为历史事实，不宣称通过、不改 gold 或预算掩盖。
2. **三层覆盖与根满足度分离（`C2`）**：
   - 严格区分单槽位进程覆盖 `slotReceipt.coverage`、全请求候选域覆盖 `domain.coverage` 与根 Goal 满足度：`cardinality: "one"` 在 `s0` 完整命中（含必要 `followUpRead` 成功）并早停跳过 `s1` 时，`domain.coverage = "partial"`（`reasons = ["unsearched_fallback_scope_early_stop"]`）但根目标 `status = "achieved", resolution = "matched", satisfaction = 100`；`cardinality: "all"` 受阻或 `one` 零命中受阻时保持 `status = "unknown", satisfaction = null`。
3. **保留的有效原子能力、按名迁移拷贝、合法训练更新与指定零梯度不变性（`C1`）**：
   - **迁移起点与参数更新边界**：从当前持久可读基线 `ba10a538`（`fb73d4a0` 仅标为历史记录，不作为当前可读原件）按名拷贝 310 个同名 `head × wire` 位置、新位置补零；训练按原配方允许非零梯度位置合法更新（如 `ba10a538 -> 7e34901c` 中 300 个继承位置合法更新），不设“310 参数全冻结”门槛；指定 P3 系数 `entry.inspect × search.nameNeedleSegment`（`train.mjs` 第 211 行）及精确零梯度位置保持 `delta === 0` 不因精度转换漂移（不将该系数重新包装为原生递归搜索能力）。
   - **必须继续保持全绿的回归入口**：Stage 0 `262` 样本与独立套件 `tests/cli-filesystem-independent.test.mjs`（`56/56`）、P3 `24/24` 偏好回归（`tests/cli-programming-search-p3-*.test.mjs`）、单目录过滤 `tests/cli-entry-search.test.mjs`（`30/30`）、单文件过滤 `tests/cli-content-search.test.mjs`（`17/17`）、受控读取组合 `playground/cli/read-composition/independent-family.mjs`（`27/27`）及原生命令搜索 `tests/cli-command-search-sandbox.test.mjs`（`8/8`）与 `tests/cli-command-search.test.mjs`（`18/18`）。
   - **正式训练准入边界**：本方法合同同步不代表正式搜索训练已获准开跑；后续正式训练仍须提交实际样本集与三分区、各头 I/O、固定配方预算、具名评估分母与固定入口，经 Alice 审计与 Jenny 验收派单后执行。

## 4. 每族统一覆盖尺

覆盖输入对象类型、目标参数、前置条件已满足/缺测/不满足、合法多解、实际成功/目标未满足/失败/中断。边界包括空、零（仅合同允许）、最小、恰好、边界前后、超范围。加入名称/顺序/无关内容扰动、同目标正误配对、多个工具实现、平台版本差异。

失败场景区分 transient、permanent、unknown attribution；只有真实证据支持且权限/副作用允许才重试。没有恢复技能的错误必须停止，不通过新增手写补救假装学生学会恢复。

验收逐头与逐类报告precision/recall/F1、unknown/abstention、假成功、错误排除、旧回归。D报告必要条件召回和可行性/效率两种评价；A使用允许集合及累计动作成本。整链报告真实根达成、恢复、准确终了、额外动作、耗时。平均分不能抵消关键安全或假成功反例。

## 5. 当前读取实验交付顺序

1. 独立R/D/E/A样本生成：有界密集TRAIN、独立标明DEV参数外推和错误族；生成后的产物先待审。具体网格与worker合同在外置run l2-layer-corpus-20261025/design.md。
2. Alice审查各头输入、监督与原始证据；缺口返工，合格范围入既有training/samples目录。每头单独有数据验收，不要求等四头全齐才审。
3. 单头拟合：从兼容已有参数继承，记录confirmed上游语义用于隔离单头能力；每头独立预算与单头验证。当前没有fit授权，预算须在数据通过后按数据量和数值耗时给定；不能沿旧脚本重跑600/1200更新。
4. 联合适配：用真实学习上游预测重建下游输入，TRAIN内按来源交叉预测或明确隔离；不是teacher代答。实际更新指定头，其他冻结；下一轮重投影，不能沿用旧上游结果。当前接口不支持跨离散标签端到端梯度，不冒称端到端训练。
5. 整链独立验收：正常两图、未见参数、unknown/停止、旧能力保留与新进程回载。精确事实只能否决假成功，不能救模型假阴性。训练与验收按实际 shell 命令的参数、范围、行为设计（v0.2 原则）；不为不会正常发生的命令内部错误制造恢复门槛，tail 自行定位末尾，不把手动 size→offset 推广为训练前置。旧 12 正常/6 恢复门槛若沿用，先确认范围与来源仍适用。
6. 合格基础版本后的两批后训练：真实学生访问轨迹→确认监督→新增TRAIN+旧TRAIN重放→继承更新→新独立评价和旧能力回归。无回归且有收益才采用；冲突保留旧版本交设计owner，不丢旧知识。

## 6. 明确停止与调整条件

输入相同但合法标签冲突：停该头，Alice裁定语义或表示；不改gold追分。真实观测与投影不一致：修加工入口，不训练补偿。单头成功而组合失败：定位实际上游误差及信息丢失。训练内失败：查标签、表示、梯度/损失与优化，不先讨论泛化。训练内通过但未见组合失败：查捷径与覆盖。预算结束：保存失败权重和逐例结果，停止；不以“输出未保存”为由再训练。

多次运行绝不能覆盖首次报告。单次fit应实际遍历预算一次并记录检查点，不从初始模型重复跑每个检查点。失败候选也必须保存，否则不能完成失败归因。实现此训练入口的修正需独立计划、真实入口测试和完整milestone审查；worker只执行，不自行改学习方法。

当前结论：完整Shell训练路线已完成S0–S12与既有基础语义（`P1–P6` + `B / R / C`）的统一收口。所有单步文件/路径/目录基础命令统一归入单一共享线性策略 `cli.command-policy.v1`（按名称逐步累积扩展：`Stage 0: 10×31 -> Stage 1: 11×34 -> Stage 2: 13×38 -> Stage 3: 19×61 -> Stage 4: 25×69 -> Stage 5: 28×72`）与 `cli-file-property` 6N5E 确定性后验评价器（`0.3.0.0000`），不新建 `F1–F7` 编号，也不为确定性 OS 后验虚设 `E23`/`R24`/`R30`/`E20` MLP。各阶段严格区分 Phase A（工程准备、`--mode validate-only` 零步数据/迁移门禁、以及单列的 `NN_HANDWIRED_ROOT` 工程拟合器数值冒烟测试）与 Phase B（待 Phase A 与数据获 Alice 审计 PASS 后才启动的标准训练与独立验证，当前正式训练状态均为 `NOT_READY`）。早期 `F1–F7` 探索草案仅归档于外置 run 目录 `/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/line-*`，不作为当前设计或执行合同。

---

## 7. `cli.command-policy.v1` 单一共享矩阵累积演进总表与 Phase A / Phase B 分段门禁

权威全量 schema 与分阶段执行合同：`/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/p1-p6-cumulative-schema-and-phased-contracts.md`。

### 7.1 单一共享 Writer 与六阶段累积矩阵演进总表（`Stage 0` $\to$ `Stage 5`）

`lib/filters/cli-command-policy.ts`、`lib/filters/cli-file-property.ts`、`lib/nodes/cli-command.ts`、`lib/training/cli-command-samples.ts`、`lib/nodes/cli-command-training.ts` 与 `playground/cli/command-learning/{train,reload}.mjs` 为共享命令策略的单一 writer 链。任何阶段升级均保留前序全部已注册 head 与 wire（含 `property.entry.identity` 与 `property.links` 独立并存），严禁删除前序阶段已注册列或让不同阶段各自从 `10×31` 分叉覆盖：

| 累积阶段 ID | 对应基础语义分组 | 矩阵维度 `K × F`（参数量） | 本阶段新增 Heads | 本阶段新增 Wires | 累积样本数（`train + dev = total`） | 起始权重来源与按名迁移函数 |
| --- | --- | --- | --- | --- | --- | --- |
| `Stage 0` (`current-10x31`) | 已交付基线（`P1/P2` 已实现子集 + P3 `nameNeedleSegment`） | `10 × 31 = 310` | 既有 10 heads（`unsupported, DEFER, NOOP, pwd, cd, ls, path.resolve, path.relative, path.parts, entry.inspect`） | 既有 31 wires | `174 + 88 = 262`（legacy 58 + batch1 204） | 持久可读基线 `ba10a538`（`35bd5ad9` / `fb73d4a0` 标为历史记录；均保持 `uncalibrated / not_applied`） |
| `Stage 1` (`stage1-11x34`) | `P1–P2` 最小缺口补齐（`path.realpath` + `observe.resolvedTarget`） | `11 × 34 = 374` | `+1`：`path.realpath` | `+3`：`property.path.physical`, `predicate.observe.physical`, `predicate.observe.resolvedTarget` | `206 + 104 = 310`（本阶段新增 `32 + 16 = 48`） | 从 `Stage 0` 持久基线 `ba10a538` 经 `migrateCliCommandProfileStage0ToStage1` 按 `(headName, wireName)` 拷贝 310 项、新位置补 0 |
| `Stage 2` (`stage2-13x38`) | `P1–P3` 目录/文件精确关系选定（`select.entry`）+ 独立 4 参数线性 `B` | `13 × 38 = 494`（另配独立 4 参数 `B`） | `+2`：`directory.select`, `file.select` | `+4`：`predicate.select.entry`, `selectorTargetType.{unspecified,regular,directory}` | `238 + 120 = 358`（本阶段新增 `32 + 16 = 48`） | 从已验收 `Stage 1` 候选经 `migrateCliCommandProfileStage1ToStage2` 按名迁移 |
| `Stage 3` (`stage3-19x61`) | `P1–P4` 单目标受控创建、软硬链接、移动与删除 | `19 × 61 = 1159` | `+6`：`directory.create, file.create, link.create, file.link, entry.move, entry.remove` | `+23`：`property.links`（保留 `property.entry.identity`，共 16 properties）、6 个 P4 predicate、`requiredTargetType` 4 列、`observedType` 9 列、`state.{parentConfirmed,targetConfirmedAbsent,sourceBound}` 3 列 | `382 + 192 = 574`（本阶段新增 `144 + 72 = 216`） | 从已验收 `Stage 2` 候选经 `migrateCliCommandProfileStage2ToStage3` 按名迁移 |
| `Stage 4` (`stage4-25x69`) | `P1–P5` 普通文件字节范围读取与单文件确定性写/改/复制 | `25 × 69 = 1725` | `+6`：`file.read, file.replace, file.write, file.append, file.truncate, file.copy` | `+8`：`property.content.bytes`（共 17 properties）、6 个 P5 predicate、`state.hasPayload`（共 8 state wires） | `478 + 240 = 718`（本阶段新增 `96 + 48 = 144`） | 从已验收 `Stage 3` 候选经 `migrateCliCommandProfileStage3ToStage4` 按名迁移 |
| `Stage 5` (`stage5-28x72`) | `P1–P6` 权限、属主与时间戳设置（全量收口） | `28 × 72 = 2016` | `+3`：`entry.mode.set, entry.owner.set, entry.times.set` | `+3`：`predicate.equals.{mode,owner,times}`（共 25 predicates） | `530 + 266 = 796`（本阶段新增 `52 + 26 = 78`） | 从已验收 `Stage 4` 候选经 `migrateCliCommandProfileStage4ToStage5` 按名迁移 |

### 7.2 终态 `Stage 5`（`28 × 72 = 2016` 参数）有序词表与消融依据

- **28 个有序 Head（`0..27`）**：
  - 控制 head（3）：`0: unsupported`, `1: DEFER`, `2: NOOP`
  - Stage 0 执行 head（7）：`3: pwd`, `4: cd`, `5: ls`, `6: path.resolve`, `7: path.relative`, `8: path.parts`, `10: entry.inspect`
  - Stage 1 新增（1）：`9: path.realpath`
  - Stage 2 新增（2）：`11: directory.select`, `12: file.select`
  - Stage 3 新增（6）：`13: directory.create`, `14: file.create`, `15: link.create`, `16: file.link`, `17: entry.move`, `18: entry.remove`
  - Stage 4 新增（6）：`19: file.read`, `20: file.replace`, `21: file.write`, `22: file.append`, `23: file.truncate`, `24: file.copy`
  - Stage 5 新增（3）：`25: entry.mode.set`, `26: entry.owner.set`, `27: entry.times.set`
- **72 条有序 Wire（`0..71`，9 个固定连续块）**：
  1. `legacy`（4 列，`0..3`）：`bias`, `goalObserveCwd`, `goalSetCwd`, `goalListDirectory`
  2. `property`（17 列，`4..20`）：`path.absolute`, `path.relative`, `path.parent`, `path.name`, `path.physical`, `exists`, `type`, `directory.entries`, `content.bytes`, `size`, `mode`, `owner`, `times`, `link.target`, `entry.identity`, `links`, `relation.sessionCwd`
  3. `predicate`（25 列，`21..45`）：P1（4）+ P2（2）+ P3（4）+ P4（6：`exists.true`, `exists.false`, `name.equals`, `parent.equals`, `linkText.equals`, `hardLink.sameObject`）+ P5（6：`observe.range`, `equals.bytes`, `patch.bytes`, `append.suffix`, `equals.length`, `copy.bytes`）+ P6（3：`equals.mode`, `equals.owner`, `equals.times`）
  4. `selectorTargetType`（3 列，`46..48`）：`unspecified`, `regular`, `directory`
  5. `requiredTargetType`（4 列，`49..52`）：`unspecified`, `regular`, `directory`, `symlink`
  6. `observedType`（9 列，`53..61`）：`unobserved`, `regular`, `directory`, `symlink`, `character_device`, `block_device`, `fifo`, `socket`, `other`
  7. `state`（8 列，`62..69`）：`hasFreshEvidence`, `knownValue`, `requiredConditionHolds`, `hasDestinationRef`, `parentConfirmed`, `targetConfirmedAbsent`, `sourceBound`, `hasPayload`（常量 `hasSessionRef`、已被 `parentConfirmed` 蕴含的 `hasParentRef` 及确定性 guard `operationApplicable` 依法消融）
  8. `search`（1 列，`70`）：`search.nameNeedleSegment`
  9. `interaction`（1 列，`71`）：`state.requiredConditionHolds*state.hasFreshEvidence`

### 7.3 Consumer CLI 显式参数改造与 Phase A / Phase B 硬门禁（Alice 审计 `m1793203349808-451` 闭合）

1. **`playground/cli/command-learning/train.mjs` 与 `reload.mjs` 显式参数要求（禁止隐式默认 `600` 步或旧起点 `ba002b23`）**：
   - Phase A 改造 `train.mjs`，强制要求显式传入 `--stage <stage1-11x34|stage2-13x38|stage3-19x61|stage4-25x69|stage5-28x72>`、`--mode <validate-only|train>`、`--initial-source <PATH>`、`--output-root <PATH>`：
     - 当 `--mode validate-only` 时：不要求 `--handwired-root`，不调用 `fitCliCommandProfile`，仅运行 `migrateCliCommandProfile*` 按名迁移核验、数据集构造、`prepareCliCommandDataset` 特征维度/零冲突/成对消歧校验与 `sourceGroup` 分区零重叠检查，写出 `validation-receipt.json`（`completedEpochs: 0`）。
     - 当 `--mode train` 时：强制要求显式传入 `--handwired-root /Volumes/extension/code/handwired`、`--epochs 200`、`--learning-rate 0.1`（移除原脚本默认的 `epochs = 600` 与旧起点 `ba002b23`，缺任一必填参数立即非零退出）。
   - `reload.mjs` 强制要求显式传入 `--stage <STAGE_ID>`、`--candidate <PATH>`、`--output <PATH>`。
2. **Phase A（工程准备与数据门禁）与 Phase B（正式能力训练）严格分离**：
   - **（A-1）零步确定性测试与 `--mode validate-only` 数据门禁**：运行 `npm run build && npm run typecheck && node --test <确定性单测> && node playground/cli/command-learning/train.mjs --stage <STAGE_ID> --mode validate-only --initial-source <PREV_CANDIDATE> --output-root <RUN_DIR>/phase-a-validation`，确认 `completedEpochs === 0`。
   - **（A-2）工程拟合器数值链路冒烟测试（单列工程证据，禁止 skip，不计作能力训练）**：因 `tests/cli-command-training.test.mjs` 内含微型临时 fixture 的 20/200 步数值拟合测试，Phase A 必须显式运行 `NN_HANDWIRED_ROOT=/Volumes/extension/code/handwired node --test tests/cli-command-training.test.mjs` 并确认 `0 skipped, 0 failed`，其输出单列为“工程拟合器数值链路自检通过”，**绝不把该单测临时权重当作正式阶段候选，也不宣称已完成能力训练**。
   - **Phase B（标准训练与独立验证，当前状态 `NOT_READY`）**：仅在 Phase A 与数据获 Alice 审计 PASS 后，由 Jenny 派 GCM 调用 `node playground/cli/command-learning/train.mjs --stage <STAGE_ID> --mode train --handwired-root /Volumes/extension/code/handwired --initial-source <PREV_STAGE_CANDIDATE> --epochs 200 --learning-rate 0.1 --output-root <RUN_DIR>/training-output` 及 `reload.mjs`。`controls.zero` 与 `controls.frozen` 的 `fixed / regressed / retained / unresolved` 四计数均按实际运行回执如实报告，严禁预填固定收益数。

---

## 8. `P1–P2`（`Stage 1: stage1-11x34`）详细设计：物理路径 `path.realpath` 与软链接目标消歧

完整 8 节详细设计文件：`/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/p1-p2/plan.md`。

1. **范围、已验证复用与最小新增缺口**：
   - `P1` 的 `pwd`、`cd`、6 参数 `cwd-relation`、`path.resolve`（符号栈控制器 + 共享选头）、`path.relative`、`path.parts` 以及 `P2` 的 `directory.list` (`ls`)、`entry.inspect` 八项基础属性已在 `Stage 0` (`10×31`) 验证合入，直接保留 `262` 条样本回归，不重复立项。
   - `Stage 1` 仅补齐 `P1–P2` 剩余最小缺口：
     1. 在 `lib/adapters/cli/entry-inspection.ts` 与 `lib/adapters/cli/entry-inspect-helper.ts` 同一固定 helper 中扩展只读 `operation: "path.realpath"`（先 `lstat` 核对来源，再 `realpath` + `stat` 目标，支持 `PathRef | ObservedObjectRef`；断链返回 `entryExists=true, resolvedTargetExists=false, errno="ENOENT"`，环路返回 `ELOOP`）；
     2. 在 `lib/filters/cli-file-property.ts` 与 `lib/filters/cli-command-policy.ts` 中将共享矩阵按名扩展至 **`11 × 34 = 374` 参数**（新增 1 个 head `path.realpath`；新增 3 条 wire：`property.path.physical`、`predicate.observe.physical`、`predicate.observe.resolvedTarget`）；
     3. 复用 `cli-file-property` 6N5E 确定性 `evaluate` 节点核对物理路径与 `followSymlinks` 双事实，不造 `R24/E24` MLP；对 `predicate.observe.resolvedTarget` 严格区分**非法 `followSymlinks: false`**（前置 guard 拒绝 `status: "rejected", satisfaction: 0, executorInvoked: false`，0 次 helper 调用）与**合法 `followSymlinks: true` 但来源非 `symlink`**（helper 正常执行 1 次 `executorInvoked: true, execution_result.status: "succeeded"`，后验 `status: "unknown", satisfaction: null, reason: "attribute_not_applicable"`）。
2. **样本分母（按实际 predicate、策略选头、后验结果分别统计）、迁移与 Phase A / Phase B 合同**：
   - 累积样本：`Stage 0` `262` 条（`174 train + 88 dev`）+ `Stage 1` 新增 `48` 条（4 TRAIN 家族 `32` 条 + 2 DEV 家族 `16` 条）= **`310` 条**（`206 train + 104 dev`），另配独立 `VERIFY` 家族（`48` 场景 + `23` 探针 = `71` 条）：
     - **新增 48 条按实际 Predicate 计数**：`predicate.observe.physical` `24` 条（`16 train + 8 dev`）、`predicate.observe.resolvedTarget` `18` 条（`12 train + 6 dev`）、`predicate.observe.inspect` 同链接配对对照 `6` 条（`4 train + 2 dev`）；
     - **新增 48 条按策略选头 Gold 计数**：`expectedHead = "path.realpath"` `24` 条（`16 train + 8 dev`）、`expectedHead = "entry.inspect"` `24` 条（`16 train + 8 dev`）；
     - **新增 48 条与全量 310 条按后验结果计数**：新增 48 条含 `achieved / 100` `42` 条（`28 train + 14 dev`）与断链 `unmet / 0` `6` 条（`4 train + 2 dev`，选头正确不等于目标达成）；全量 `310` 条含 `achieved / 100` `286` 条（`190 train + 96 dev`）、`unmet / 0` `6` 条（`4 train + 2 dev`）、`unknown / null` `18` 条（`12 train + 6 dev`）。
   - 按名迁移：`migrateCliCommandProfileStage0ToStage1` 从持久基线 `ba10a538` (`10×31`，`fb73d4a0` 仅标为历史记录) 按名复制 `310` 个同名参数，新增 `64` 个位置补 `0`；训练允许非零梯度位置按原配方合法更新，指定 P3 系数 `entry.inspect × search.nameNeedleSegment`（`train.mjs` 第 211 行）及精确零梯度位置保持 `delta === 0`。
   - Phase A（已获 Alice 放行产品工程切片）：Jenny 推进产品 adapter/policy/node 工程切片，Emma 负责训练 consumer、样本生成/数据校验与评价入口准备并单 writer 交接；Phase B 保持 `NOT_READY`，待 Phase A 与数据准入获 Alice 审计通过后执行。

---

## 9. `P3` 与 `B`（`Stage 2: stage2-13x38` + 独立 4 参数线性关系模型 `B`）详细设计

完整 8 节详细设计文件：`/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/p3/plan.md`。

1. **原文双层设计与职责边界（不造 `R30` MLP）**：
   - **独立 4 参数线性关系模型 `B`（`cli.directory-select-relation.v1` 与 `cli.file-select-relation.v1`）**：严格按 [cli-property-training-design.md](cli-property-training-design.md) §2 & §3.2 原文定义：
     $$z = b + w_n \cdot \text{name\_equal} + w_t \cdot \text{type\_equal} + w_p \cdot \text{parent\_equal}, \quad p = \sigma(z)$$
     每个模型仅 **4 个标量参数** `(b, w_n, w_t, w_p)`，使用二元交叉熵（BCE）在 8 种布尔组合完备网格上独立训练（`directory.select` 目标类型为 `"directory"`，`file.select` 目标类型为 `"regular"`，两模型独立训练、独立保存，不混用未验证权重）；集合汇总规则（`coverage: "complete" | "partial"`、唯一匹配 `selected`、全不匹配 `not_found`、`partial` 未确认 `insufficient_evidence`）100% 确定性执行。
   - **共享策略 `Stage 2`（`stage2-13x38`，`13 × 38 = 494` 参数）**：在 `Stage 1` (`11×34`) 基础上新增 2 个 head（`directory.select`, `file.select`）与 4 条 wire（`predicate.select.entry`、`selectorTargetType.{unspecified,regular,directory}`），学习在 `select.entry` 下按 `selectorTargetType` 与前置列表证据选择 `directory.select`、`file.select`、`NOOP` 或 `DEFER`。
2. **样本分母、迁移与 Phase A / Phase B 合同**：
   - 共享策略累积样本：`Stage 0` (`262`) + `Stage 1` (`48`) + `Stage 2` 新增 `48`（`32 train + 16 dev`）= **`358` 条**（`238 train + 120 dev`）；`B` 关系模型样本独立分区（每模型 4 TRAIN 家族 + 2 DEV 家族 + 独立 VERIFY 家族）。
   - 按名迁移：`migrateCliCommandProfileStage1ToStage2` 从已验收 `Stage 1` (`11×34`) 候选复制 `374` 个同名参数，新增 `120` 个位置补 `0`。

---

## 10. `P4`（`Stage 3: stage3-19x61`）详细设计：目录/文件创建、软硬链接、无覆盖移动与单条目删除

完整 8 节详细设计文件（含 Alice 首审 `m1793204090940-472` 全部修订）：`/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/p4/plan.md`。

1. **6 个单目标受控原语、按操作区分 `NOOP` 与 Native No-Replace Rename 具体绑定**：
   - **6 个原语**：`directory.create`（单层 `mkdir`）、`file.create`（`O_CREAT | O_EXCL | O_WRONLY` 空普通文件）、`link.create`（create-new `symlink`）、`file.link`（已存在 `regular` 源同 FS `link` create-new）、`entry.move`（同父重命名 `name.equals` 与跨父移动 `parent.equals` 共用同一 `entry.move` head）、`entry.remove`（普通文件/symlink/FIFO/socket `unlink`，空目录 `rmdir`，非空目录报 `ENOTEMPTY` 绝不递归删除）。
   - **按具体操作和根条件严格区分 `NOOP` vs 冲突拒绝（Alice 审计 `m1793204090940-472` 第 2 条闭合）**：
     - **严禁将“`source/dest` 同条目”泛化为所有 P4 操作的统一 `NOOP`**：
       1. `file.link`（`hardLink.sameObject`，create-new）：若 `destination` 与 `source` 是**同一目录项路径**（`P_dst === P_src`），`requiredConditionHolds = 0`，Guard 直接拒绝 `SAME_ENTRY_CONFLICT`（`status: "rejected", satisfaction: 0`），绝不冒称已创建新链接或判 `NOOP`；仅当 `P_dst !== P_src`（两个**不同目录项**）且本轮已观测两者同 `(dev, ino)`（`nlink >= 2`）时才判 `NOOP`（`achieved/100`）。
       2. `entry.move`（`name.equals` / `parent.equals`）：若源与目标为**同一目录项路径**（`P_dst === P_src`），目标位置条件已满足且无需调用 rename，判 `NOOP`（`achieved/100`）；但若 `P_new !== P_old` 是**两个不同目录项名称的既有硬链接**（同 `(dev, ino)` 但旧名称 `P_old` 仍存在且目标槽位 `P_new` 已被占用），`requiredConditionHolds = 0`，**严禁判 `NOOP/achieved`**（因为移动要求旧名消失且目标原本为空，no-replace 规则拒绝覆盖返回 `rejected/failed`）。
   - **`entry.move` 原子无覆盖重命名具体构建与调用入口（Alice 审计 `m1793204090940-472` 第 3 条闭合）**：
     - 新增最小 C11 源 `lib/adapters/cli/native-rename-noreplace.c`（macOS 调 `renamex_np(src, dst, RENAME_EXCL)`，Linux 调 `syscall(SYS_renameat2, AT_FDCWD, src, AT_FDCWD, dst, RENAME_NOREPLACE)`），由 `scripts/build-native-rename.mjs` 编译至 `dist/native/rename-noreplace`，并由 `lib/adapters/cli/entry-mutation-helper.ts` 通过 `execFileSync`（`shell: false`）固定调用。
     - 若宿主缺 C 编译器或内核不支持，显式返回 `UNSUPPORTED_NATIVE_RENAME`，**严禁退化为覆盖式 `fs.rename` 或 `lstat + fs.rename`**；该依赖仅作为 `entry.move` 的工程准备前置，不阻塞其余 5 个 P4 原语。
2. **共享策略 `Stage 3`（`stage3-19x61`，`19 × 61 = 1159` 参数）与样本分母**：
   - 在 `Stage 2` (`13×38`) 基础上新增 6 个 P4 head 与 23 条 wire（保留 `property.entry.identity` 并新增 `property.links`、6 个 P4 predicate、4 列 `requiredTargetType`、9 列 `observedType`、3 列 `state.{parentConfirmed,targetConfirmedAbsent,sourceBound}`）；`P4-dir` vs `P4-file` 在同一不存在目标上仅凭 `requiredTargetType.directory` vs `requiredTargetType.regular` 线性可分。
   - 累积样本：`Stage 0–2` (`358`) + `Stage 3` 新增 `216`（4 TRAIN 家族 `144` + 2 DEV 家族 `72`）= **`574` 条**（`382 train + 192 dev`）。
   - 按名迁移：`migrateCliCommandProfileStage2ToStage3` 从已验收 `Stage 2` 候选精确复制 `494` 个同名参数，新增 `665` 个位置补 `0`。

---

## 11. `P5`（`Stage 4: stage4-25x69`）详细设计：普通文件字节读取与单文件确定性写/改/复制

完整 8 节详细设计文件（含 Alice 首审 `m1793203433391-455` 全部修订）：`/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/p5/plan.md`。

1. **6 个单文件原语、零长度 `file.write` 真实边界与 `file.copy` `(dev, ino)` 身份对**：
   - **6 个原语**：`file.read`（`observe.range`，复用 `readFileRange`）、`file.replace`（`equals.bytes`，已有普通文件 `ftruncate(0)+write`）、`file.write`（`patch.bytes`，已有普通文件定点 `pwrite`，不 `O_TRUNC`/不 `O_CREAT`）、`file.append`（`append.suffix`，`O_APPEND`，后验缺失返回 `unknown/null` 并保留 `effectsObserved`，严禁自动重放造成重复追加）、`file.truncate`（`equals.length`，`ftruncate`）、`file.copy`（`copy.bytes`，源只读 fd 到目标 `O_CREAT | O_EXCL` 新建普通文件）。
   - **`file.write` 零长度写入且 `offset > EOF` 的真实 POSIX 边界（Alice 审计 `m1793203433391-455` 第 1 条闭合）**：
     - 经 Node.js / POSIX 实测：对 `oldSize = 4` 的文件执行零长度定点写 `fs.writeSync(fd, Buffer.alloc(0), 0, 0, 10)`（`offset = 10 > 4, patchLen = 0`）返回 `bytesWritten = 0, sizeAfter = 4`，**零字节 `pwrite` 绝不会扩展文件长度**（仅当 `patchLen > 0` 时才扩展至 `max(oldSize, offset + patchLen)`）。
     - 因此：`patchLen === 0` 时期望长度严格为 **`expectedSize = oldSize`**（若已持有本轮新鲜存在证据则直接选 `NOOP` `achieved/100`；若调用了 `file.write` 则核对 `afterSize === oldSize` 且原字节不变判 `achieved/100`），**严禁把 `max(oldSize, offset)` 扩文件当作零字节写 gold，也严禁偷偷调 `ftruncate` 补偿**。
   - **`file.copy` 跨设备兼容的对象身份对 `(dev, ino)` 判据（Alice 审计 `m1793203433391-455` 第 2 条闭合）**：
     - 后验核对源与目标非同一硬链接对象时，严格使用完整对象身份对 **`(dest.identity.dev !== source.identity.dev || dest.identity.ino !== source.identity.ino)`**（`OsInteger` `bigint`），绝不只比较单字段 `dest.ino !== source.ino`，防止跨设备复制碰巧同 inode 号被误判失败；同时核对源文件 `(dev, ino)` 与字节未变、目标 `type === "regular"` 且全部字节与源 100% 相等。
2. **共享策略 `Stage 4`（`stage4-25x69`，`25 × 69 = 1725` 参数）与样本分母**：
   - 在 `Stage 3` (`19×61`) 基础上新增 6 个 P5 head 与 8 条 wire（`property.content.bytes`、6 个 P5 predicate、`state.hasPayload`）；`content.format` 100% 复用确定性 `observeContentFormat`（`lib/filters/cli-content.ts`），不造格式分类 NN 或 `E14/E20/E23` MLP。
   - 累积样本：`Stage 0–3` (`574`) + `Stage 4` 新增 `144`（4 TRAIN 家族 `96` + 2 DEV 家族 `48`）= **`718` 条**（`478 train + 240 dev`）。
   - 按名迁移：`migrateCliCommandProfileStage3ToStage4` 从已验收 `Stage 3` 候选精确复制 `1159` 个同名参数，新增 `566` 个位置补 `0`。

---

## 12. `P6`（`Stage 5: stage5-28x72`）与 `R / C` 详细设计：权限/属主/时间戳设置收口与后续组合边界

完整 8 节详细设计文件：`/Volumes/Intel/playground/nnanything-runs/cli-foundation-concurrent-design-20261028/p6/plan.md`。

1. **`P6` 3 个元数据设置原语与平台诚实边界**：
   - `entry.mode.set`（`property.mode + predicate.equals.mode`）：对自有 `regular/directory`（拒绝最终 symlink）以 fd 核对 `(dev, ino)` 后调用 `fchmod(fd, mode & 0o7777)`，独立后验 `entry.inspect` 核对 `(after.mode & 0o7777) === expectedMode`。
   - `entry.owner.set`（`property.owner + predicate.equals.owner`）：fd 核对后调用 `fchown(fd, uid, gid)`；非特权进程下当前 `(euid, egid)` 自保持写入与跨用户 `uid=0` 真实 `EPERM` 均在沙盒实测；需 root 权限的跨用户成功变更显式保持 `UNVERIFIED`（严禁 `sudo` 或 mock 伪造成功）。
   - `entry.times.set`（`property.times + predicate.equals.times`）：fd 核对后调用 `futimes(fd, atime, mtime)`，独立后验仅调用 `entry.inspect`（`lstat/stat`）按预声明平台纳秒/毫秒精度核对 `atimeNs/mtimeNs`（严禁在后验中调用 `file.read` 污染刚设置的 `atime`）；请求直接设置 `ctime` 或 `birthtime` 由确定性绑定层直接路由 `unsupported`。
2. **共享策略 `Stage 5`（`stage5-28x72`，`28 × 72 = 2016` 参数）全量收口**：
   - 在 `Stage 4` (`25×69`) 基础上新增 3 个 P6 head 与 3 条 predicate wire（`predicate.equals.{mode,owner,times}`），完成 `P1–P6` 全部 28 个 head 与 72 条 wire 的统一收口。
   - 累积样本：`Stage 0–4` (`718`) + `Stage 5` 新增 `78`（4 TRAIN 家族 `52` + 2 DEV 家族 `26`）= **`796` 条**（`530 train + 266 dev`）。
   - 按名迁移：`migrateCliCommandProfileStage4ToStage5` 从已验收 `Stage 4` 候选精确复制 `1725` 个同名参数，新增 `291` 个位置补 `0`。
3. **`R`（18 参数文件用途关系线性模型）与 `C`（目录树多步组合）后续边界**：
   - **`R`（`cli.file-role-relation.v1`，18 参数线性 BCE 模型）**：按 [cli-property-training-design.md](cli-property-training-design.md) §4 与 [cli-role-evidence-design.md](cli-role-evidence-design.md) 保持 `p = sigmoid(b + sum_{k=1..17} w_k * x_k)`（6 维显式引用边 + 5 维内容特征 + 6 维路径位置提示 + 1 偏置 = 18 参数），待 18 位沙盒证据采集器在 `P1–P6` 闭合后接入再启动训练。
   - **`C`（多步目录树递归组合）与开放编程组合**：`C` 复用 `nnanything/recursive-goal`（3N2E SESE）在每步内部调用 `Stage 5` (`28×72`) 单步基础算子，不新增共享矩阵 head；编程类组合由 Alice 唯一维护于 [cli-programming-compositions.md](cli-programming-compositions.md)，排在 `P1–P6` 基础原语完成之后。
