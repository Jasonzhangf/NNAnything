# 文件语义语言：精确单操作与首个模糊训练设计

状态：设计态，2026-10-19。起点为 macOS/POSIX。本文定义语义语言，不增加实现、模型、训练数据或运行入口。当前已实现的 cwd/path/attributes 观测仍以 [CLI M0 合同](cli-foundation.md) 为准。

用户顺序：先总结精确单操作，再设计一个最低层次的模糊任务。自然语言识别、help 文档学习、组合规划与“进入目录”的完整执行均不属于本轮。

后续用户将实施起点进一步收敛为逐能力训练，先完成精确 `path.resolve(cwd,input)` 的函数表达。已实现的流程、样本与首轮实测见 [路径函数训练](cli-path-training.md)。下方目录目标绑定仍为后置设计，不与首项路径训练并行实施。

动作学习的最新方向为 [总体设计1.1](design.md#11-结构化语义的目标与状态推理)：全命令收敛为单一共享命令模型（`cli.command-policy.v1`），模型输出调用序列 `["pwd"]`、`["cd", D]`、`["ls", D]`，由harness分流执行对应固定操作。历史独立 `observe_cwd→pwd` 见[Goal动作训练](cli-goal-training.md)作为基线。当前各命令唯一权威训练合同见[文件系统训练合同](cli-filesystem-training.md)。

当前训练顺序为统一共享模型的递进增量训练：PWD阶段（4参数）→CD阶段（9参数）→LS阶段（16参数）。旧独立CD/LIST模型合同已退役，其实际执行harness、效果与失败模式保留并迁入共享模型。真实专用目录沙盒、训练/开发/独立验证分区及训练DAG见[文件系统训练合同](cli-filesystem-training.md)。

2026-10-19 用户要求补齐目录操作，再补文件操作，并明确不零散编辑Goal，统一为 `file.property.xxx`：路径、目录及各文件类型的属性观测或变化是目标，CLI是Action，实际属性是State。本页扩充精确操作与组合目录；四元素、属性键、持久图绑定、训练和缺口见 [file.property核心合同](cli-filesystem-semantics.md)。内容、用途和条件归入属性体系，不各立核心Goal。扩充是设计范围，不扩大当前运行 API，也不授权对真实用户文件执行修改或删除。

2026-10-19 后续用户要求完成旧合同缺少的命令及训练设计，独立Review后提交main，并明确“只完成设计，不完成训练和代码”。本目录每项的固定命令/helper/OS API、typed参数与后条件见 [调用设计](cli-command-design.md)；全部普通文件属性训练单元的输入、电路、监督及独立验证见 [训练设计](cli-property-training-design.md)。不将未来验收用例写成已执行结果。

## 1. 基础对象与表达

| 类型 | 含义 | 不包含的保证 |
| --- | --- | --- |
| `PathText` | 原始路径文本；名称段、分隔符、`.`、`..` 保留 | 不证明目标存在或对象类型 |
| `AbsolutePath` | 从 `/` 开始的路径引用 | 不证明是物理路径或唯一对象身份 |
| `RelativePath` | 需要显式基准目录解释的路径引用 | 不读取隐藏 cwd |
| `Cwd` | 某个 session 的当前工作目录观测 | 不等于任意子进程或其他 session 的 cwd |
| `EntryRef` | 一次观测中的具体目录条目引用，带实际路径和证据 | 不是文件内容，也不保证之后仍存在 |
| `DirectoryRef` | 已观测为目录的条目引用 | 不包含目录下所有后代 |
| `FileRef` | 已观测为普通文件的条目引用 | 不保证内容为文本或可读 |
| `SymlinkRef` | 链接自身的条目引用 | 不等于链接目标 |
| `Bytes` | 字节序列 | 不自带编码语义 |

纯路径解析先保留精确合同：`path.resolve(base, input) -> AbsolutePath`。完整 base 与 input 已给定时，它是确定任务。词法解析不访问文件系统、不展开 `~`/环境变量/glob，也不解析链接。实际对象类型通过观测取得，不能从扩展名或尾部 `/` 猜测。

语义请求由harness执行，对应模型的调用序列与typed参数。实现可以对应一个或多个必要 OS 调用；一个请求只承担一种对外语义，不自动搜索、补参或继续执行另一项操作。

## 2. 精确单操作目录

精确指执行入口时，目标、必要参数与策略已经明确。操作仍可能因状态、权限或 OS 原因失败；精确不等于保证成功。除 `path.resolve` 外，路径参数均为已解析的 `AbsolutePath`，避免隐藏 cwd 依赖。权限、可执行程序配置与 session 状态由显式 typed resource 承载，不塞进业务 metadata。

下表是设计目录。只有映射栏明确列出的能力已纳入固定harness执行；其余名称均不是现有可调用 API。

| 语义操作 | 精确输入 | 成功输出及行为 | 关键失败与边界 | 共享模型映射 |
| --- | --- | --- | --- | --- |
| `cwd.get` | `session: SessionRef` | 该 session 的 cwd 观测与证据 | 目录失效、观察失败；不改变状态 | 当前共享模型输出 `["pwd"]`，固定 `pwd -P` 观测；M0 `observe({kind:'pwd'})` 保持兼容 |
| `path.resolve` | `base: AbsolutePath, input: PathText` | 词法绝对路径及父路径 | 非法路径；不检查存在性；绝对 input 不依赖 base | 独立函数 `kind:'path'`／`interpretCliPath`；沿用 M0 合同 |
| `entry.inspect` | `path: E/D/F/P, follow_symlinks: boolean` | 类型、大小、mode/uid/gid、OS 时间；不跟随时可返回链接文本；保留来源引用证据 | ENOENT、EACCES、stale；stat/lstat 明确区分 | M0 `kind:'attributes'`仅P观测；引用绑定为设计 |
| `directory.list` | `session: SessionRef, directory: DirectoryRef` | 直接子条目及覆盖状态；包括点开头名称，不含 `.`/`..` | 不是目录、拒权、读取未完成；不递归 | typed `directory.list` 映射为未来设计；当前共享模型仍输出 `["ls", D]`，由固定编译结构化helper执行 |
| `file.read` | `file: AbsolutePath, offset: uint, length: uint` | 从指定字节位置读取，返回 Bytes、实际长度和 EOF | 不是普通文件、拒权、IO 失败；不隐式文本解码 | 设计态 |
| `cwd.set` | `session: SessionRef, directory: AbsolutePath` | 设置该 session 后续操作的 cwd，并返回成功后的 cwd | 不是目录、目录不可进入；失败不得报告已进入 | 模型输出 `["cd", D]`，固定CD脚本+提交S+PWD验证 |
| `directory.create` | `path: AbsolutePath` | 新建一个目录 | 父目录不存在、目标已存在、拒权；不递归补父目录 | 设计态 |
| `file.create` | `path: AbsolutePath` | 以 create-new 方式建立空普通文件 | 目标已存在、父目录不存在、拒权；不覆盖 | 设计态 |
| `file.replace` | `file: AbsolutePath, content: Bytes` | 用给定字节替换已有普通文件的全部内容 | 目标不存在或不是普通文件、拒权、IO 失败；不是追加；不预先承诺原子替换 | 设计态 |
| `entry.move` | `source, destination: AbsolutePath` | 将指定条目移到准确目标路径 | 目标已存在、跨文件系统、非法目录关系、拒权；不自动覆盖或 copy+delete | 设计态 |
| `entry.remove` | `path: AbsolutePath` | 删除指定文件、链接自身或空目录 | 目录非空、拒权、IO 失败；不递归，不跟随链接删除目标 | 设计态 |

所有有副作用的设计操作需在实现前补齐成功、失败及部分副作用合同。错误必须保留可检测的原因，不能变为空成功。本文目录不授权执行删除、覆盖或任何尚未实现的动作。

首版对象操作的最终条目策略固定：`directory.list`、`file.read`、`file.replace`、`cwd.set` 要求最终条目本身为所需普通文件或目录，遇到最终 symlink 明确拒绝；需要跟随时先用显式观测取得目标引用。`entry.move/remove` 操作链接自身，create-new 遇到已有链接也算目标已存在。祖先路径仍可能经过 OS 链接解析；这不提供文件系统隔离，也不承诺抵御并发替换。未来实现必须对相应边界给出实际行为验收，不能把先检查类型再操作称为原子保证。

`cwd.set` 成功后的 cwd 按物理目录观测返回，与当前 `pwd -P` 基础合同一致。它更新的是指定 session 的执行基准，不修改父进程或其他 session。

只读结果使用 `ok(value)` 或 `error(code,evidence)`。`directory.list` 的未完成覆盖必须显式返回，不能将部分结果当成完整目录。文件写入的副作用不能仅靠返回值宣称成功。

### 2.1 目录、路径和共享条目操作补全

以下与上表共同构成当前常见 POSIX 文件系统操作设计目录。S 是 session 引用，D/F/E 是目录/文件/条目引用；P 是明确的目标绝对路径。引用必须绑定观测、路径及对象类型，不能因名称或扩展名猜类型。除已有 M0 和路径/PWD 训练外，均未实现。`mode` 是 POSIX 权限位，`owner` 是明确 uid/gid；不提供任意 flags 或 shell 文本。

| 需求/操作 | 必要输入 | 实际结果与验收 | 边界/反例 |
| --- | --- | --- | --- |
| 获取/进入目录 `cwd.get/set` | S；set 另给 D | 同一 S 后续 pwd 核对；其他 S 不变 | 不以子进程 cd 成功冒充会话变化 |
| 解释/拼接路径 `path.resolve` | base、input | 得到词法绝对路径 | 不证明存在，不展开 glob/环境变量 |
| 相对路径 `path.relative` | from、to 两个绝对路径 | 词法相对路径，与明确 from 组合后等价于 to | 不证明两个别名指向同一物理对象 |
| 物理路径 `path.realpath` | E/D/F/P | 真实 OS 解析路径与来源；typed 绑定保留原引用类型、身份及有效性证据 | 断链、循环、失效、stale 显式失败；不退化为裸路径 |
| 路径分解 `path.parts` | 明确路径 | parent、basename；根目录显式处理 | 这是词法结构，不等于已观测的所属目录 |
| 检查/解析条目 `entry.inspect` | E/D/F/P、follow_symlinks | 属性、存在性或错误；保留来源引用证据 | EACCES 不能当 ENOENT，mode 不等于有效权限，stale 不降级为裸路径 |
| 列举 `directory.list` | S、D | 完整直接子项及类型；不改 cwd | 隐藏项/特殊名称无损；partial 不假称 complete |
| 绑定目录 `directory.select` | 已观测候选、name/type/parent、coverage | 唯一对象引用或明确未找到/证据不足 | 沿本文第4–6节；不是隐式扫描 |
| 建单目录 `directory.create` | P；父目录已存在 | 新目录存在，原有条目不变 | create-new；已存在/拒权不静默成功 |
| 移动/重命名 `entry.move` | source E、destination P | 新路径对象正确、旧路径消失 | 同父目录即重命名；目标不覆盖；跨设备不自动 copy+delete |
| 删除空目录 `entry.remove` | D | 目录条目消失，兄弟不变 | 非空目录失败，不偷偷递归 |
| 设置权限 `entry.mode.set` | E、mode | 读回声明的权限位 | 最终 symlink 拒绝；不宣称 ACL 或实际访问同步成立 |
| 设置归属 `entry.owner.set` | E、uid、gid | 读回 uid/gid 及实际变动属性 | 权限失败保留；不默认提权，不承诺保留被 OS 清除的 mode 位 |
| 设置时间 `entry.times.set` | E、atime、mtime | 按 OS 支持精度读回 | 不设置 ctime/birthtime，不伪造精确纳秒支持 |
| 创建符号链接 `link.create` | linkPath P、targetText | 链接自身存在且 readlink 文本一致 | 不覆盖；目标可不存在，不误称已跟随成功 |
| 读取链接 `entry.inspect(false)` | 链接 E/P | lstat 与 readlink 证据 | 已有 M0；读取文本不是目标存在证明 |

递归能力有必要语义，但复用上述原语，不另造同义底层操作。每个有限批次执行现有单操作图，外层新 run 继续，最后验证整体效果。

| 目录组合 Goal | 组合 Action | 完成与失败条件 |
| --- | --- | --- |
| 创建多级目录 | path.parts/inspect → 按父子顺序 directory.create | 所需链均为目录；已有目录可作为明确的既有状态，已有文件冲突；不越过范围 |
| 遍历/搜索树 | directory.list → 明确深度/范围的下一目录批次 → 语义匹配 | 不默认跟随链接；记录已覆盖与未访问范围，拒权不算已完整搜索 |
| 复制目录树 | list/inspect → create → file.copy/link.create → 核对目标树 | 源保留，目标 create-new；保留结构、字节和链接文本，不默认承诺 ACL/xattr 保真；失败返回已创建清单，不静默清除部分结果 |
| 删除目录树 | list/inspect → 后序 entry.remove | 显式树目标与授权；不跟随链接，保留已删/未删清单；部分删除不能回报原状态未变 |
| 目录统计/比较 | 完整遍历 → 汇总/配对实际条目 | 覆盖不完整时返回部分结果；目录 stat 大小不是子树大小 |

“全部”在此指上述日常目录/路径语义及可复用组合。挂载、卷管理、ACL/xattr、硬链接目录、监听器等具有独立 OS 合同，不混入此单元；作为明确的专用扩展缺口，不能宣称 POSIX 全功能覆盖。

### 2.2 文件操作补全

文件通过已观测父目录和明确路径绑定；文件内容、文件角色与路径文本分别管理。最终 symlink 不自动当普通文件。Bytes/offset/length 等为 typed 参数，原样传递，不训练 shell 引号和重定向。

| 需求/操作 | 必要输入 | 实际结果与验收 | 边界/反例 |
| --- | --- | --- | --- |
| 定位文件 `file.select` | 明确候选、name/type/parent、coverage | 与 directory.select 同一关系合同，目标类型为 file | 同名不同父目录、未知类型不误绑定；不把名称当用途真值 |
| 检查/解析/移动/删除 | 复用 entry.inspect、path.*、entry.move/remove | 核对指定文件及父目录前后状态 | 不为文件重写同义原语；删除链接只作用链接本身 |
| 建空文件 `file.create` | P | create-new 空文件，父目录其他条目不变 | 已存在不截断，不递归建父目录 |
| 读字节 `file.read` | F、offset、length | 原始 Bytes、实际长度、EOF，与独立 fixture 字节核对 | EOF 不是读错；不自动解码或裁剪空白 |
| 整体替换 `file.replace` | F、Bytes | 目标字节恰为给定内容 | 不自动创建，不声称原子；失败可能已有部分修改，实际观测并报告 |
| 定点写入 `file.write` | F、offset、Bytes | 写入区间正确；区间外保持，必要扩展明确 | 不隐式截断；越 EOF 的空隙沿 OS 字节合同核对；保留实际写入长度/错误 |
| 追加 `file.append` | F、Bytes | 原内容前缀保持，新增后缀正确 | 不隐式创建；并发顺序不预先保证，部分写入如实报告 |
| 调整长度 `file.truncate` | F、length | 长度符合；截断保留前缀，扩展区读回为零字节 | 不把 truncate 当写入任意内容；失败核对实际长度 |
| 复制 `file.copy` | source F、destination P | 源不变，新文件字节一致 | create-new，拒绝目录/最终链接；不承诺自动复制 ACL/xattr；部分目标保留并报告 |
| 硬链接 `file.link` | source F、destination P | 同一文件系统共享同一实际对象的证据 | 不复制字节；跨设备失败；不同于 link.create；删除一名称不证明内容被销毁 |
| 权限/归属/时间 | 复用 entry.mode/owner/times.set | 读回实际属性 | 不从属性设置推断用户已具备某操作权限 |
| 文件比较 | 分段 file.read → 比较字节 | 报告相等/不同/未完成 | 不引入 checksum 清单；未读完整不能报告全部相等 |
| 文本处理/内容搜索 | file.read → 显式解码/匹配 → 带来源的内容结果 | 编码、范围、匹配语义明确，字节来源可追踪 | 非文本不强行解码；不是命令 stdout 自由文本解析 |

文件保存、日志追加、整理/归档按以下有限组合终点映射；三项都保留源/目标证据、实际部分副作用，不隐式覆盖或回滚。

| 目标组合 | 有限 Action | 完成与失败条件 |
| --- | --- | --- |
| 保存文件 | 已有 F 使用 `file.replace(F,content)`；新目标按 Goal 先显式 `file.create(target)`，createdRef 绑定为 F 后 `file.write(F,offset=0,content)` | 最终字节等于明确内容；新目标创建或写入失败时保留已创建条目及实际写入量。不自动经 append 创建，不隐式覆盖既有目标 |
| 日志追加 | 已有 F 使用 `file.append(F,content)`；目标不存在时只能显式 `file.create(target)`，createdRef 绑定为 F 后 `file.append(F,content)` | 原有前缀保留且新增后缀正确；append 本身不 O_CREAT。部分写入、创建成功但追加失败分别报告，不截断或回滚已有内容 |
| 整理/归档 | 目标已定为移动时用 `entry.move`；目标已定为复制时，父先 `directory.create`，再按条目类型 `file.copy/link.create` | 源、目标父目录及目标条目可追踪；移动或复制的部分结果如实保留，不隐式覆盖或改走另一条路径。此处归档只指目录整理，不包含压缩格式 |

内容格式识别、用途关联及目标选择必须使用 [核心语义 DAG](cli-filesystem-semantics.md)，不能用后缀猜角色后直接执行。文件执行属于程序执行语义，压缩解压另属格式转换语义，均不混入普通字节读写合同。

## 3. 单操作与组合的边界

精确单操作示例：

```text
path.resolve(base="/workspace", input="humanagent")
entry.inspect(path="/workspace/humanagent", follow_symlinks=false)
cwd.set(session=S, directory="/workspace/humanagent")
```

这是三个分别可以调用的操作，不是本轮要训练的一条组合序列。模型调用 `["cd", D]` 是单次调用的参数序列，不是多步规划。CD 后的 PWD 验证是固定 harness 事务，不等于模型学会了调度组合。`cwd.set` 不负责寻找名称为 humanagent 的对象；搜索范围和目标消歧也不隐藏在它内部。独立子进程中的 `cd` 不会自动改变父进程或别的 session。

精确的 `path.resolve(cwd,input)` 可以先训练和评估，但不能把它的确定性输出称为模糊选择能力。

## 4. 第一个最低层次的模糊任务：目录目标绑定

模糊的含义：目标约束没有给出唯一绝对路径，需要与候选建立关系。首轮保持名称精确相等；不引入错别字、编辑距离、自然语言或“最相似名称”。

唯一任务：在调用者提供的一组已观测条目中，绑定目标目录。候选获取不属于此操作；它不执行 list/find/pwd/cd，不搜索磁盘，也不规划下一步。

```text
directory.select(
  selector = { name: "humanagent", parent: "/workspace" },
  candidates = [
    { ref: E1, path: "/workspace/humanagent", name: "humanagent", type: directory, parent: "/workspace" },
    { ref: E2, path: "/workspace/archive", name: "archive", type: directory, parent: "/workspace" },
    { ref: E3, path: "/workspace/readme", name: "readme", type: file, parent: "/workspace" }
  ],
  coverage = complete
)
-> selected(E1)
```

`parent` 是直接父目录约束，首轮不混入递归后代或语义归属。selector 不含目标完整路径。候选各有唯一引用，路径、名称和类型来自明确观测。coverage 表示当前候选是否覆盖 selector 指定父目录的全部直接条目；它由观测者提供，不能从“候选看起来够多”推断。

候选可以包含不同名称、不同类型和不同父目录，用来检验三种约束是否被共同使用。有效输入中一个 parent 下同名条目不会有两个不同实体；两个这样的候选属于矛盾观测，返回 invalid_input，不将不可能的文件系统状态标为真实黄金样本。若以后去掉 parent 或使用递归范围，才会自然出现多个同名目录候选，本轮不扩展 selector。

## 5. 学生输出与集合结果

每个候选输出一个关系分类 `matches_selector` 或 `does_not_match_selector`，并保留分数、证据及 judged/unknown/conflict 状态。关系分类不携带训练正负极性。训练任务显式将关系真值映射到监督目标。

集合处理不训练“第一个／最高分即正确”的捷径：

| 证据与关系结果 | 单操作结果 |
| --- | --- |
| coverage complete，唯一确定匹配，其余确定不匹配 | `selected(EntryRef)` |
| coverage complete，没有匹配，所有候选已确定 | `not_found` |
| 任意可能改变选择的缺测、unknown/conflict，或 coverage partial | `insufficient_evidence` |
| 候选重复实体或违反同一父目录名称唯一性等输入合同 | `invalid_input` |

此首轮 parent+name 精确约束至多一个合法目标，不需要训练多目标优先级。未来范围变大而允许多个合法匹配时，需要新增 `ambiguous` 结果合同，不能沿用本轮唯一性假设。

## 6. 最小可训练结构

非训练结构负责读语法、保留引用和计算基础比较。学生的三条输入为：

| wire | 已知时的值 | 缺测 |
| --- | --- | --- |
| `name_equal` | 候选名称与 selector.name 精确相等则 1，否则 0 | 保留 null |
| `type_equal` | 已观测类型为 directory 则 1，否则 0 | 保留 null |
| `parent_equal` | 候选的明确父路径与 selector.parent 相等则 1，否则 0 | 保留 null |

比较使用精确符号等价；大小写与 Unicode 形式不自动折叠。parent 使用已声明的词法绝对路径合同，不将别名路径视为已经证明的同一物理目录。符号链接类型不自动当成 directory；需要目标类型时由前置观测显式跟随。

真实名称、完整路径和 ref 保留在原始证据及返回值中，不作为可记忆的词表特征。不得将聚合后的 eligible、正确引用或期望关系作为学生输入。

四个参数构成最小评分结构：

```text
z = bias
  + w_name   * name_equal
  + w_type   * type_equal
  + w_parent * parent_equal

score = sigmoid(z)
```

缺测候选不补 0，也不进入完整监督行的损失；先返回证据不足。初始零参数作为未训练基线；用真实 Handwired 将特征与参数分别作为 source，multiply/affine 构成 z，宿主计算 BCE 及输出端导数，Handwired 反传到参数源。后续实现必须显式提供源码根，不复制后端或假拟合。

评分表示未校准支持度，不称为正确率或概率。接纳/拒识阈值只用开发集确定，然后在留出评估前固定。若模型与精确合同不一致，记录错误；不能在预测后用 teacher 规则改写成正确输出、再把修正算成模型成绩。

该结构只学习三个符号关系的合取，未学习字符串相等算法、目录扫描、路径解析、命令选择或任意模糊语义。这是最低层训练机制实验，不预设比确定性规则更好。

## 7. 样本、teacher 与分区

teacher 是公开的形式合同：三个关系均成立时匹配；任一已知关系不成立时不匹配。8 种完整 wire 组合全部覆盖。unknown/conflict/缺测不作为不匹配标签。

生成符号样本时必须满足条目唯一性和 path/name/parent 一致性。名称在同一样本内一致替换；目标和候选的相等关系保持。候选集合是训练实例，单候选行是展开后的拟合行；报告两者数量，不能把重命名副本计作独立语义来源。

分区单位是完整场景族，包含其候选、反例、顺序变换和所有重命名副本；同族不得跨训练与留出。合成训练/开发使用不同场景族。独立 macOS 临时目录测试在拟合和阈值确定后建立并评估，不反向调整本轮参数；修改模型后，原留出降为开发证据。

数据保存实际来源和 `teacher=deterministic_contract`，不伪称 human review。`pwd` 原文可作为父目录证据；它不是候选目录类型或匹配关系的标签。训练本身不要求创建实际文件；真实目录用于行为测试。

## 8. 单任务验收设计

| 用例 | 抓住的失败模式 | 预期 |
| --- | --- | --- |
| 目标目录与同范围其他名称目录共存 | 只看类型、记候选位置 | 唯一正确引用 |
| 同名文件、链接或未知类型 | 只看名称，把文件/链接当目录 | 已知错误类型不匹配；未知类型证据不足 |
| 同名目录位于别的父目录 | 忽略范围 | 不匹配 |
| 完整范围无目标／空目录 | 总选一个，吞掉未命中 | not_found |
| 候选不完整或类型缺测 | 用未知当负例，部分扫描冒充完整 | insufficient_evidence |
| 目标置于不同位置、加入无关条目 | 首项／末项／列表长度捷径 | 结果引用随目标移动，语义不变 |
| 名称、父目录和 ref 一致重命名 | 记 humanagent 或固定路径 | 同关系结果；返回新引用 |
| 矛盾路径、重复候选身份 | 用不可能样本伪造歧义训练 | invalid_input |

不包含“humanagent 与 human-agent 哪个更像”、候选优先级、递归搜索和组合调用。精确规则 baseline 必须保留：对于完整合法的三值事实，规则能直接给出关系真值。模型即使达到相同成绩，也只证明有界关系拟合，不宣称已超越规则或掌握全局文件语义。

后续真实训练须报告：训练前／后及冻结参数对照，候选关系成绩，整个 selector 的引用／not_found／拒识成绩，fixed/regressed/unresolved，场景族和 wire 覆盖，保存后新进程回载，训练 wall time 与处理行量。有限训练预算在首次实现计划中确定；只用 train/dev 选预算。候选保持 uncalibrated、not_applied。缺实际拟合与回载证据时，只能报告设计完成。

## 9. 当前图与实施边界

已读现有 `workflows/cli-foundation.graph.json`：1N0E 单入口单出口观测流。本轮不改变该图、算子、运行入口或训练拓扑。本文是纯合同和训练设计，没有新增可执行路径，不为文档生成虚构 runtime 图。

未来实现时，语义评分由 `lib/filters/` owner 负责；内部数值结构由 `lib/nodes/trainable/` 管理；训练与评估由 `lib/training/` 负责；适配器只提供实际观测，节点只做 workflow 封装。届时先完成独立实现计划、正确持久图与绑定、红测，再实现和执行训练。不得将 DOM 权重、DOM 标签或原有 DOM 训练入口改成 CLI 数据的隐藏通道。
