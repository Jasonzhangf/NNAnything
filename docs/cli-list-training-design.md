# 训练设计3：获取目录内文件与子目录（ls）

状态：目录列举已接入typed `file.property`运行入口。旧独立`LIST / REJECT` 8参数模型及旧16参数阶段模型已退役。0.2.0 时 LS 是`cli.command-policy.v1` 6×14 单矩阵中的`ls`/`DEFER`切片（历史形状）；0.3.0 起为 10×30 单矩阵中的同一切片，唯一权威训练合同见[文件系统训练合同](cli-filesystem-training.md)。本轮真实训练与作者回载见[共享模型实测](cli-filesystem-training-results.md)；父级独立验证另做。

调用边界统一沿[参数简化合同](cli-call-contract.md)：模型输出调用序列 `["ls", D]`。profile、sandbox与session在策略工厂绑定：`createCliCommandPolicy({ profile, sandbox, session: S })`；每次调用传`step({ goal, satisfactionThreshold, state })`，请求没有`resources`、`directories`或独立`directory`字段。NN不解析`/bin/ls`面向人类的文本输出或文件正文；固定编译helper返回结构化JSON条目，由harness处理机器协议。

## 语义目标与NN责任

Goal为`{kind:"file.property",property:"file.property.directory.entries",target:DirectoryRef|DirectoryQuery,requirement:{kind:"observed",freshness:"this_run"}}`。`DirectoryRef.path`在调用时相对S当前cwd解析；本轮不实现DirectoryQuery查找，所以合法query返回typed DEFER。模型通过共享profile选择`ls`，输出调用序列`["ls", D]`；首项是实际Shell命令名，后续是机械绑定的typed引用，不生成自由参数文本。harness按固定字段绑定参数；模型不生成Shell选项、文件名或条目列表。文件/目录类型是OS观测事实，本轮不训练通过扩展名猜对象类型的分类器。

[调用设计](cli-command-design.md)中的`directory.list(session:S,directory:D)`是固定harness语义操作。共享命令模型在 0.2.0 保存 14 条有序 wire 与 6 个 head、共 84 参数（历史形状），0.3.0 起为 30 条 wire 与 10 个 head、共 300 参数；旧4×4交叉块按名称迁移，新行新列补零后对PWD/CD/LS、NOOP/DEFER和证据配对做一次真实拟合。

初始真实Handwired训练预算为200epochs/lr0.1、全批SGD。冻结对照使用迁移后的初始矩阵且不做参数更新（等价初始状态`epochs:0`），只做预测；零权重对照同样只做预测，不执行命令。目录名、条目数量和目标是否存在不进入动作特征；在合法entries observed Goal上选择`ls`，不把OS错误算成模型动作错误。

## 固定CLI映射与观测格式

该语义对应用户在终端使用`ls`获取目录条目，但实现明确不解析macOS面向人的ls多列/换行文本输出。明确使用固定的本地编译CLI helper：harness通过`process.execPath + 固定helper路径 + D`执行，helper用`fs.readdir`和`lstat`产生结构化JSON。helper路径由声明配置给定，D单独传argv，不接收任意脚本或未编译命令。其唯一职责是列举，并不包含模型或teacher。

这是真实文件系统操作和固定CLI helper调用，绝不宣称训练了`/bin/ls`选项或文本解析。若之后要求实际`/bin/ls`，需另改harness合同及无损名称协议。

输出格式保持精确：`{directory,entries:[{name,path,type}],coverage,errors}`。name保留完整名称，包括空格、中文、点开头和换行；JSON转义仅是传输格式，不修改名称。type取`file/directory/symlink/other/unknown`，由lstat观测；链接自身不误标为目标目录，不跟随列举。只包含直接子项，排除`.`和`..`，不递归，不读正文。条目按明确的JS字符串顺序排序以便重放；独立验收按原始名称集合及类型比对。

目录D最终条目为链接时按既有合同拒绝。若readdir成功后某条lstat失败，保留名称、type=unknown、对应错误，coverage=partial，不把遗漏项当空目录。coverage=complete且名称/类型全部有证据时才可达成完整列举Goal。

## 状态与独立真值

`["ls", D]`调用绝不改变S.cwd/revision、其他session、目录结构或文件内容。成功增加本次目录条目观测；失败/partial不能覆盖旧知识后伪装成完整新知识，Goal未达成或证据不足。

共享命令入口要求调用者显式给0..100的`satisfactionThreshold`。完整列举且直接条目的名称与类型都有本次证据、S未变时为`achieved/100`；native OS或grant失败按结果为`failed/0`或`rejected/0`；coverage为partial、任一必要类型为unknown或条目证据不足时为`unknown/null`；已证发生cwd/revision等禁止副作用时为`unmet/0`。partial没有比例满足度，也不能覆盖旧完整知识。公开结果类型和status边界唯一维护于[文件系统训练合同](cli-filesystem-training.md)。

共享命令模型与CWD关系模型均接入公共[设计流程](../workflows/project-design.graph.json)、[模型演进](../workflows/model-evolution.graph.json)和[冲突设计](../workflows/model-conflict-design.graph.json)。使用采集、显式当前版本、自动比较采用及LLM冲突裁决执行尚未实现；旧`list_directory`入口已退役，不新增零散Goal。候选保持`uncalibrated/not_applied`。

验证作者先写场景配方及期望直接条目集合，实际创建后独立核对对象类型。harness/helper的返回值不能直接当teacher真值。验证比较原始名称集合与类型；隐藏项、同名不同目录、伪装扩展名均有反例。

## 样本计划与独立验证

当前typed训练数据使用4个train来源家族与2个development来源家族，同一家族不跨分区。每家族包含entries observed的LS行，同时回放PWD、CD/NOOP/DEFER及历史命令能力。合法DirectoryQuery另有DEFER行，不执行磁盘扫描。正式共享run未提供可选verification资源；父级独立验证由独立作者另建，只有显式提供资源时receipt才记录`evaluation`分支。

额外6个失败探针保持完整，严格区分native/grant/受控注入：
1. D不存在（native ENOENT）
2. D为普通文件（native ENOTDIR）
3. D最终链接（native symlink rejected）
4. 目标越界（harness sandbox bounds）
5. 缺filesystem.read（grant拒权）
6. 列举中条目消失导致partial（受控注入验证partial与错误保留）

清理失败显式记录并暴露。

## 外层DAG与owner

未发布的独立`cli-list-learning.graph.json`已删除。当前推理统一走`cli-file-property.graph.json`（6节点/5边，0.2.0）。训练走`cli-filesystem-training.graph.json`（8节点/8边，0.2.0）及同名workflow配置；它接收调用者准备并分区的typed dataset，不生成fixture或自行启动新进程回载。`cli-filesystem-curriculum.graph.json`（7节点/6边，0.2.0-design）只是未来属性单元设计描述，不是运行配置或新引擎。

owner：`lib/adapters/cli/`负责固定helper与实际列举；`lib/filters/`负责条目校验与后条件；数值电路与拟合由共享训练owner承担。实现前红测抓“用空白拆文件名”、“漏点开头条目”、“列举后代”、“partial冒充complete”和“列举误改cwd”。
