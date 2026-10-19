# 训练设计3：获取目录内文件与子目录

状态：可实施设计，2026-10-19；列举harness、样本与模型尚未实现。前两项见[CWD/pwd](cli-cwd-training-design.md)、[cd](cli-cd-training-design.md)。本项先训练精确单操作，不将“进入目录再列举”组合规划作为前置。

## 语义目标与NN责任

Goal为`{kind:"list_directory",session:S,directory:D}`，D为明确绝对目录引用，语义对应既有`directory.list(D)`。Action固定为`{kind:"LIST",session:S,directory:D}`。NN独立学习`LIST / REJECT`，harness按固定字段绑定参数；不生成shell参数、文件名或条目列表。文件/目录是OS观测事实，本轮不训练通过扩展名猜对象类型的分类器。

学生输入为`[1,goalListDirectory,goalObserveCwd,goalSetCwd]`，REJECT/LIST两个logit，共8参数；同分REJECT。内部乘权→求和→logit→argmax/softmax交叉熵图沿[CWD设计的数值图](cli-cwd-training-design.md#nn内部图与手写边界)，此处输入4维且profile独立。目录名、条目数量和目标是否存在不进入动作特征；合法list Goal上选择LIST，不把OS错误算成动作错误。

初始真实Handwired训练预算200epochs/lr0.1、全批SGD、零初始化，冻结控制epochs0。不是将前两项profile改动作名字复用；保存独立候选，原PWD/CD能力只读回归。三个单项模型训练完成不等于跨模型调度已实现。

## 固定CLI映射与观测格式

该语义等价于人用`ls`获取目录条目，但首版不解析macOS面向人的ls多列/换行输出。明确选择固定的本地CLI helper：harness通过`process.execPath + 固定helper路径 + D`执行，helper用`fs.readdir`和`lstat`产生结构化JSON。helper路径由声明配置给定，D单独传argv，不接收任意脚本或命令。其唯一职责是列举，并不包含模型或teacher。

这是真实文件系统操作和固定CLI调用，不宣称训练了`/bin/ls`选项。若之后要求实际`/bin/ls`，需另改harness合同及无损名称协议，不能偷偷换成会拆坏换行文件名的文本解析。目录/文件概念与固定动作不依赖人类显示格式。

输出为`{directory,entries:[{name,path,type}],coverage,errors}`。name保留完整名称，包括空格、中文、点开头和换行；JSON转义仅是传输格式，不修改名称。type取`file/directory/symlink/other/unknown`，由lstat观测；链接自身不误标为目标目录，不跟随列举。只包含直接子项，排除`.`和`..`，不递归，不读正文。条目按明确的JS字符串顺序排序以便重放；独立验收按原始名称集合及类型比对，不依赖同一排序代码。

目录D最终条目为链接时按既有合同拒绝。每个返回条目都有观测来源；若readdir成功后某条lstat失败，保留名称、type=unknown、对应错误，coverage=partial，不把遗漏项当空目录。coverage=complete且名称/类型全部有证据时才可达成完整列举Goal。输出不是原子快照；初版独占fixture，变化场景单独测试并显式报告。

## 状态与独立真值

LIST不改变S.cwd/revision、其他session、目录结构或文件内容。成功增加本次目录条目观测；失败/partial不能覆盖旧知识后伪装成完整新知识，Goal未达成或证据不足。参数绑定错误与读错目录分别计数。

验证作者先写场景配方及期望直接条目集合，实际创建后独立核对对象类型。harness/helper的返回值不能直接当teacher真值。验证比较原始名称集合与类型；隐藏项、同名不同目录、文件伪目录扩展名、目录伪文件扩展名均有反例。创建配方失败先报fixture失败，不算模型失败或成功。

## 样本计划

每个正常场景生成4条动作题：list_directory、observe_cwd拒绝、set_cwd拒绝、其他Goal拒绝各1；仅list题实际列举一次。

| 分区 | 独立场景家族 | 动作题 | 计划真实列举 |
| --- | ---: | ---: | ---: |
| train | 4 | 16 | 4 |
| development | 2 | 8 | 2 |
| verification | 4 | 16 | 4 |

train家族为空目录、混合文件/子目录、点开头条目、带后代的直接子目录；development为不同布局的空格名称和伪装扩展名；verification由独立作者构造换行/尾随空格名称、中文及同名跨目录、链接条目、两个session读取不同目录。前述环境差异不改变4种语义向量，报告环境覆盖，不冒称未见Goal泛化。

具体配方不得只是换名：train分别为0项、1文件+1空子目录、3文件含点开头项、1子目录带2个后代；development为3文件+2子目录和5文件+1子目录；verification独立构造2文件+3目录、3文件+4目录且后代重名、4文件+2目录+2链接，以及双session指向两个不同分支的场景。特殊名称叠加在独立结构上。数量只确定配方覆盖，不作为学生特征或“未见语义”证据。

额外6个失败探针：D不存在、D为普通文件、D最终链接、目标越界、缺filesystem.read、列举中条目消失导致partial。最后一项允许受控harness注入以稳定抓错，另列为合同测试，不混报native覆盖。普通非特权macOS目录的EACCES不保证稳定，不以chmod形式宣称实际拒权；只有真实复现才增加该类成绩。

## DAG、验收与owner

训练图：[cli-list-learning.graph.json](../workflows/cli-list-learning.graph.json)。训练/开发配方与独立验证配方分支，在候选保存后合流。真实列表结果与fixture预期比较，学生不能读取teacher列表作为输入。未确认的使用时列举样本先入证据池，不能自动晋升黄金。

各成功、拒绝、partial和异常终态都先保存已有证据再回收自有场景；report和异常清理使用相同场景owner，清理失败单独报告，不伪造完成。

验收：独立16/16动作正确；4个正常场景名称集合/类型完全符合；空目录complete且entries=[]；特殊名称无损；后代不混入；6个失败探针正确拒绝或partial；所有session、文件树及内容无变化；PWD/CD旧能力零退化；profile保存回载一致。loss下降不能替代条目集合正确，平均正确率不能掩盖漏文件。

owner：`lib/adapters/cli/`负责固定helper与实际列举；`lib/filters/`和`lib/nodes/trainable/`负责LIST评分及8参数电路；`lib/training/`负责样本、后端拟合、独立比较；公开consumer沿既有workflow运行。不把实现放scripts/当作业务真源；CLI入口仅薄封装真实adapter。实现前红测抓“用空白拆文件名”“漏点开头条目”“列举后代”“partial冒充complete”和列举误改cwd。
