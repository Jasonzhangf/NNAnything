# 文件语义语言：精确单操作与首个模糊训练设计

状态：设计态，2026-10-19。起点为 macOS/POSIX。本文定义语义语言，不增加实现、模型、训练数据或运行入口。当前已实现的 cwd/path/attributes 观测仍以 [CLI M0 合同](cli-foundation.md) 为准。

用户顺序：先总结精确单操作，再设计一个最低层次的模糊任务。自然语言识别、help 文档学习、组合规划与“进入目录”的完整执行均不属于本轮。

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

语义请求写为 `operation(arguments) -> result`。它是有类型的操作及参数，不是自然语言，也不是 shell 命令字符串。实现可以对应一个或多个必要 OS 调用；一个请求只承担一种对外语义，不自动搜索、补参或继续执行另一项操作。

## 2. 精确单操作目录

精确指执行入口时，目标、必要参数与策略已经明确。操作仍可能因状态、权限或 OS 原因失败；精确不等于保证成功。除 `path.resolve` 外，路径参数均为已解析的 `AbsolutePath`，避免隐藏 cwd 依赖。权限、可执行程序配置与 session 状态由显式 typed resource 承载，不塞进业务 metadata。

下表是设计目录。只有映射栏明确列出的 M0 能力已经实现；其余名称均不是现有可调用 API。

| 语义操作 | 精确输入 | 成功输出及行为 | 关键失败与边界 | 当前映射 |
| --- | --- | --- | --- | --- |
| `cwd.get` | `session: SessionRef` | 该 session 的 cwd 观测与证据 | 目录失效、观察失败；不改变状态 | M0 `observe({kind:'pwd'})`，固定 `pwd -P` |
| `path.resolve` | `base: AbsolutePath, input: PathText` | 词法绝对路径及父路径 | 非法路径；不检查存在性；绝对 input 不依赖 base | M0 `kind:'path'`／`interpretCliPath` |
| `entry.inspect` | `path, follow_symlinks: boolean` | 类型、大小、mode/uid/gid、OS 时间；不跟随时可返回链接文本 | ENOENT、EACCES；stat/lstat 明确区分 | M0 `kind:'attributes'` |
| `directory.list` | `directory: AbsolutePath` | 直接子条目及覆盖状态；包括点开头名称，不含 `.`/`..` | 不是目录、拒权、读取未完成；不递归 | 设计态 |
| `file.read` | `file: AbsolutePath, offset: uint, length: uint` | 从指定字节位置读取，返回 Bytes、实际长度和 EOF | 不是普通文件、拒权、IO 失败；不隐式文本解码 | 设计态 |
| `cwd.set` | `session: SessionRef, directory: AbsolutePath` | 设置该 session 后续操作的 cwd，并返回成功后的 cwd | 不是目录、目录不可进入；失败不得报告已进入 | 设计态，M0 session 的 cwd 仍固定 |
| `directory.create` | `path: AbsolutePath` | 新建一个目录 | 父目录不存在、目标已存在、拒权；不递归补父目录 | 设计态 |
| `file.create` | `path: AbsolutePath` | 以 create-new 方式建立空普通文件 | 目标已存在、父目录不存在、拒权；不覆盖 | 设计态 |
| `file.replace` | `file: AbsolutePath, content: Bytes` | 用给定字节替换已有普通文件的全部内容 | 目标不存在或不是普通文件、拒权、IO 失败；不是追加；不预先承诺原子替换 | 设计态 |
| `entry.move` | `source, destination: AbsolutePath` | 将指定条目移到准确目标路径 | 目标已存在、跨文件系统、非法目录关系、拒权；不自动覆盖或 copy+delete | 设计态 |
| `entry.remove` | `path: AbsolutePath` | 删除指定文件、链接自身或空目录 | 目录非空、拒权、IO 失败；不递归，不跟随链接删除目标 | 设计态 |

所有有副作用的设计操作需在实现前补齐成功、失败及部分副作用合同。错误必须保留可检测的原因，不能变为空成功。本文目录不授权执行删除、覆盖或任何尚未实现的动作。

首版对象操作的最终条目策略固定：`directory.list`、`file.read`、`file.replace`、`cwd.set` 要求最终条目本身为所需普通文件或目录，遇到最终 symlink 明确拒绝；需要跟随时先用显式观测取得目标引用。`entry.move/remove` 操作链接自身，create-new 遇到已有链接也算目标已存在。祖先路径仍可能经过 OS 链接解析；这不提供文件系统隔离，也不承诺抵御并发替换。未来实现必须对相应边界给出实际行为验收，不能把先检查类型再操作称为原子保证。

`cwd.set` 成功后的 cwd 按物理目录观测返回，与当前 `pwd -P` 基础合同一致。它更新的是指定 session 的执行基准，不修改父进程或其他 session。此约定尚未实现。

只读结果使用 `ok(value)` 或 `error(code,evidence)`。`directory.list` 的未完成覆盖必须显式返回，不能将部分结果当成完整目录。文件写入的副作用不能仅靠返回值宣称成功。

## 3. 单操作与组合的边界

精确单操作示例：

```text
path.resolve(base="/workspace", input="humanagent")
entry.inspect(path="/workspace/humanagent", follow_symlinks=false)
cwd.set(session=S, directory="/workspace/humanagent")
```

这是三个分别可以调用的操作，不是本轮要训练的一条组合序列。`cwd.set` 不负责寻找名称为 humanagent 的对象；搜索范围和目标消歧也不隐藏在它内部。独立子进程中的 `cd` 不会自动改变父进程或别的 session。

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
