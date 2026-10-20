# CLI调用参数简化合同

状态：2026-10-19设计合同，共享命令模型源码已实现；正式三阶段train/dev与独立验证已通过，作者全量回归、整体Review与集成待完成。实测计数见[共享模型实测](cli-filesystem-training-results.md)。适用于所有接入的CLI能力，不表示已支持系统中的所有命令。当前模型唯一权威合同见[文件系统训练合同](cli-filesystem-training.md)；Goal推理及训练沿[总体架构](design.md)1.1节。

## 1. 模型输出调用序列与显式资源信封

统一共享模型（`cli.command-policy.v1`）接收结构化Goal与State，输出标准调用序列。序列首项取自命令头，是小写实际Shell命令名；后续项是机械绑定的typed位置参数引用，模型不生成自由参数文本。

profile、sandbox与会话在策略工厂绑定：`createCliCommandPolicy({ profile, sandbox, session: S })`；每次调用传`step({ goal, state, directory? })`。请求没有`resources`或`directories`字段。模型不生成完整命令文本，不生成Shell标志位，不解释Shell语法，也不解析命令stdout/stderr正文。

```ts
const policy = createCliCommandPolicy({ profile, sandbox, session: S });
await policy.step({
  goal: { kind: "set_cwd", session: S.sessionId, target: absoluteTarget },
  state: { session: S.sessionId, cwdObservation: null, directoryListing: null },
  directory: D,
});
```
Shell 的统一 Goal 为 [file.property.xxx](cli-filesystem-semantics.md)，指定对象、属性及要求；本页 `operation` 仍是 Action，不将属性键当可执行程序名，也不为每个属性增加一个原生命令。已有 observe_cwd 等接口尚未迁移；后续须显式接入并保留旧入口回归，不以设计正文替代运行变更。

| 语义调用 | NN需要选择/携带的参数 | harness固定的内容 |
| --- | --- | --- |
| `{operation:"cwd.get",parameters:{session:S}}` | session引用 | PWD映射、`/bin/pwd -P`、显式cwd、授权、回执来源 |
| `{operation:"cwd.set",parameters:{session:S,directory:D}}` | session和目录引用 | CD映射、固定执行模板、目标路径绑定、成功后提交S、后续观测验证 |
| `{operation:"directory.list",parameters:{session:S,directory:D}}` | session和目录引用 | LIST映射、固定结构化CLI helper、只列直接条目、隐藏项保留、不跟随链接、不递归 |

`DirectoryRef.path`在调用时相对S当前cwd解析；CD提交后调用者重新绑定。`Goal.target`是配置后的绝对路径，必须与本次绑定引用解析出的目标一致；harness不做隐藏重定向。

| 结构化语义 | 模型输出调用序列 | harness固定映射与语义操作 | harness固定执行与验证内容 |
| --- | --- | --- | --- |
| `observe_cwd(S)` | `["pwd"]` | `cwd.get(session:S)` | 读取S当前cwd，执行`/bin/pwd -P`，回执解码与证据记录 |
| `set_cwd(S,D)` | `["cd", D]` | `cwd.set(session:S, directory:D)` | 绑定D，执行固定CD脚本，提交S，并在同一S执行真实PWD验证后条件 |
| `list_directory(S,D)` | `["ls", D]` | `directory.list(session:S, directory:D)` | 绑定D，通过固定结构化helper列举直接子条目；不调用未编译自由命令，不解析`/bin/ls`文本 |
| 未支持的语义Goal | 无调用（`unsupported`） | 不分流，不执行 | 策略`selectedHead:"unsupported"`，`invocation: null`，`executorInvoked:false`；不执行任何Shell命令 |

合同要求：
- `["cd", D]`是单次调用的参数序列，不是多步规划。
- 未支持语义输出内部`unsupported`分类，不输出可执行Shell命令，也不输出`["REJECT"]`。
- 共享路径不建立逐命令binary profile；旧六参数PWD API（`cli.goal-policy.v1`）只保留兼容，不被共享入口调用。
- `ls`的native实现继续使用固定编译结构化helper，harness与模型均不解析`/bin/ls`面向人类的文本输出。
- 命令头预测错误时，guard拒绝执行但仍记录`policy_error`，不能把错误伪装成`unsupported`或OS失败。
- 模型预测的新状态或机械调用完成不能等同于目标达成，实际状态由harness观测提供。

补全的目录/文件操作按语义目录2.1/2.2的必要参数接入：引用 source/destination/parent/file/session 与 typed Bytes、offset、length、mode、uid/gid、时间或link文本，字段按具体operation固定。创建目标用已知父目录与明确目标路径，不要求伪造已有引用。固定harness在 `lib/adapters/cli/`，仅接已声明操作，不开放通用shell；OS/固定helper映射及部分副作用验收须在各操作实现前补齐。递归创建、树复制/删除等由有限单操作组合，不给命令加隐含递归/覆盖fallback。

上述操作的具体typed参数、固定命令/OS API、无覆盖rename、字节协议、类型限制和部分副作用方案已由 [cli-command-design.md](cli-command-design.md) 补齐；本页只维护调用原则，不复制第二份映射。训练特征、参数矩阵、监督、分区与独立验收由 [cli-property-training-design.md](cli-property-training-design.md) 维护。两者均为设计，当前没有新增helper或运行接口。

## 2. 准确调用由边界保障

固定流水为：已验证语义调用序列→检查命令头及参数类型→从策略绑定与调用字段取session/目录资源→检查授权及场景归属→构造固定CLI/argv→执行→保存回执与独立状态观测。复用现有CLI动作workflow，不另建调度器。模型选择错误、参数绑定错误、调用构造错误及OS失败分别报告。

实际argv必须与模板逐参数一致；路径含空格、中文、换行、引号或shell元字符仍是一个原始参数。不得把整条命令拼成字符串执行。为cd调用固定zsh脚本时，仅允许已声明的恒定脚本，目录通过独立argv传入；模型不能改脚本或可执行路径。

正确选择操作不保证OS成功。无权限、目标不存在、目标类型错误及partial结果仍保留真实错误；参数简化不是吞错、补默认或静默fallback。harness guard拒绝模型错误调用时，策略仍记错。

## 3. 回执与内容理解分开

命令stdout/stderr可作为不透明原始证据保存，不能成为学生的自由文本输入或自动监督。harness读取退出码、固定协议字段或独立OS状态来验收效果，这是机器协议与观测，不训练内容理解。原pwd适配器已有的路径回执解码保持既有实现，不将它称为NN学会解析pwd输出。

目录列举返回名称/类型是结构化条目观测，不读文件正文，也不通过人类ls文本分词提取名称。JSON等固定协议可由harness解码；不能因此宣称模型理解文件内容。列举完整性与特殊名称无损仍需要独立验收。若回执缺少可验证事实，目标保持未验证，不让NN读stdout猜成功。

## 4. 训练与设计流程接入

每项训练只监督命令头选择和明确的参数角色；参数引用是否指向正确session/目录单独验收。原始路径复制、argv编码、输出解码和OS类型不是NN训练目标。CWD归属概念题仍只用结构关系，不引入内容解析。共享训练图接收调用者准备并分区的dataset；fixture创建与新进程回载由公开consumer负责，不是图内行为。

设计时先写“简化调用序列→固定harness映射→实际观测后条件”，再定学生特征、样本与训练图。所有接入能力都给出精确调用、缺参数、错引用、特殊路径参数和执行失败反例。统一共享命令模型唯一训练合同为[文件系统训练合同](cli-filesystem-training.md)，完整训练分区及自动采用条件仍沿[模型演进合同](model-evolution.md)。
