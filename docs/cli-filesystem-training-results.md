# CLI基础语义训练实测

## 状态

本页保留历史实测，不重写历史。当前运行结果以[文件系统训练合同](cli-filesystem-training.md)为准；本轮typed `file.property`迁移结果见下方「当前file.property单候选结果」。

## 历史当前共享模型结果（4→9→16三阶段）

历史入口为`createCliCommandPolicy`和`runCliCommandTraining`，共用一个`cli.command-policy.v1`权重profile。模型接收旧Goal/State，输出`["pwd"]`、`["cd",D]`、`["ls",D]`，harness机械绑定S/D并固定执行。unsupported无调用。单独命令selector及其未交付训练包装已退役，旧六参数PWD API当时只保留为兼容，现已退役。

历史实测使用真实Handwired，200epochs/lr0.1。每阶段从前一阶段保存的共享候选回载，按名称扩展行列，加入新命令样本并回放历史命令。样本来源为4个train家族和2个development家族；每家族有每个已接入命令的正例及真正unsupported语义，未把未来命令永久标为拒绝。

| 阶段 | 参数 | train正确/题数 | development正确/题数 | 零/扩展冻结控制的train正确数 | 历史回归 |
| --- | ---: | ---: | ---: | ---: | --- |
| pwd | 4 | 8/8 | 4/4 | 4、4 | unsupported 6条保留 |
| 增量cd | 9 | 12/12 | 6/6 | 4、8 | pwd及unsupported各6条保留，0退化 |
| 增量ls | 16 | 16/16 | 8/8 | 4、12 | pwd、cd、unsupported各6条保留，0退化 |

各已接入命令每阶段均有4次train、2次development真实正常调用及实际效果核验。CD的固定后条件另发同一session的新PWD。每个阶段都有独立新进程回载，分别重放12、18、24条题；其中显式正常调用为6、12、18次，内部CD后验PWD另计。这些是历史三阶段run，已被本轮单候选迁移替代。正式阶段run依次为：

- pwd：`333bb151-003e-4188-a027-e145eb591760`
- cd：`a22e71aa-dbd5-44ce-ab1e-56a7a89f6d57`
- ls及最终共享候选：`d7c4a3e5-4111-4e09-857f-5f20f4fa18c0`

真实拟合分别357.618ms、8.892ms、12.690ms，处理梯度行分别1600、2400、3200。第一阶段包含344.189ms后端加载，后续同进程复用已加载后端，仍执行真实Handwired求值和反传。新进程回载及真实重放分别285.103ms、597.911ms、1041.338ms；三阶段consumer总计4020.477ms。计时是本机单次记录，不是性能承诺。

独立验证只读取当时这同一份共享权重，未调用fitter或训练生成器。16/16命令选择正确：pwd、cd、ls和unsupported各4条。真实正常调用的名称、参数、状态、目录直接条目名称及类型均符合独立配方；另检查5次补充PWD、1次连续CD提交和1次不同session目录列举。CWD概念仍用历史独立关系profile单独测量16/16，它不选择任何命令。该报告形成时运行对象是旧4×4模型。

失败探针全部通过：pwd 2项、cd 8项、ls 6项。其中14项为真实文件系统校验或显式grant拒绝，2项为受控故障注入：CD提交后PWD观测失败，以及LS collector的单条lstat失败。后者仍用原生readdir及其余条目的原生lstat，保留unknown/error并标为partial；不声称注入调用启动了native helper。所有正常与失败场景检查其他session、父cwd和文件树/正文无未声明变化。CD已提交但验证失败时保留changed状态，Goal未验证。

首次独立测试在构造不存在目录引用时，被`bindDirectory`提前拒绝，未进入命令执行。原日志保留。探针改为显式构造恶意typed引用，以测试调用边界本身拒绝；场景、期望、权重和预算未改变。有效独立运行通过1项综合测试、0skip，报告`shared-independent-report.json`、日志`shared-independent-valid.log`。首次共享consumer也保留失败记录：同目标路径的`relative`返回空串，后改为显式`.`引用，再完成正式三阶段运行。这些测试构造/引用修复不作为调参成绩。

历史本地资产：`training/{samples,weights,results}/filesystem/command/<run>/`。样本包含配方和teacher OS证据；权重为`candidate.json`；结果含`report.json`、`executions.jsonl`，最终阶段另有`consumer-summary.json`。执行证据先写入，再记录各场景清理结果。候选保持uncalibrated/not_applied；训练workflow未提供可选verification资源时，`accepted`只表示train/dev和历史回放通过，`fullyVerified=false`。独立结果由外部报告明确提供。

上述历史正式资产已复制到项目主目录的同名本地training路径，历史临时路径字段保留原始证据，不事后改写。独立验证样本单独位于`training/samples/filesystem/verification/shared-cli-20261019/samples.json`，含4份独立家族、16条正常题及16项失败探针清单。它未进入历史拟合入口。最终候选的results目录另存独立报告、独立日志和正式训练日志。

## 当前file.property单候选结果（2026-10-19本轮）

本轮输入起点是历史最终共享候选`d7c4a3e5-4111-4e09-857f-5f20f4fa18c0/candidate.json`，经显式按名迁移扩展到`unsupported,DEFER,NOOP,pwd,cd,ls`六个head和14条有序wire，共84参数，然后一次真实拟合。运行时只接typed `file.property`请求，旧Goal kind和旧4×4对象被运行入口拒绝。

本轮正式run为`ba002b23-b650-4869-87ec-2d36f4fe7485`。样本38条train、20条development，10种case覆盖真实受信证据、旧知识、未绑定query与未注册property边界。策略正确train 38/38、development 20/20，逐例副作用与状态均核对；未注册property由`unsupported`零执行收束，合法未绑定query由`DEFER`零执行收束。

| 项 | 结果 |
| --- | ---: |
| 参数矩阵 | 6×14 = 84 |
| 训练代数与学习率 | 200 epochs / lr 0.1，全批SGD |
| 梯度行轮 | 7600（38行 × 200） |
| 拟合计时 | 415.565 ms（含后端加载327.182 ms） |
| 零权重对照正确数 | 4/38，只认零logits命中的unsupported行 |
| 迁移后冻结对照正确数 | 26/38，旧PWD/LS能力保留，新head未学会 |
| 新进程回载 | 58题检查、0失败、34次真实执行、`fitted=false` |
| 回载与consumer计时 | 回载2454.938 ms；consumer总计5338.783 ms |

迁移后旧四行logits在对应legacy样本上保持可复现；这不证明softmax概率或argmax不变。回归按命令逐项统计，`pwd` 6条、`cd` 16条、`ls` 12条、`unsupported` 6条均retained且regressed为0；详见report.json的`regression`字段。同目标CD在新`equals`证据适用时由`cd`变为`NOOP`是公开语义变化，单独列在`semanticChanges`，不计作旧准确率提升。

候选绝对路径：

```text
/Volumes/extension/code/NNAnything/training/weights/filesystem/command/ba002b23-b650-4869-87ec-2d36f4fe7485/candidate.json
```

样本、报告、执行记录和consumer摘要位于同一run的samples/weights/results目录。候选保持`uncalibrated`/`not_applied`；父级独立验证不通过本consumer宣称。

复现当前公开训练和新进程回载：

```sh
npm run demo:command-training -- --handwired-root /Volumes/extension/code/handwired
```

完整独立测试需显式提供`NN_CLI_COMMAND_PROFILE`；可额外提供`NN_CWD_RELATION_PROFILE`检验历史概念单元。独立场景在`tests/cli-filesystem-independent-fixtures.mjs`，执行入口为`tests/cli-filesystem-independent.test.mjs`。当前特征包含typed属性、谓词和State事实，测试覆盖独立环境及执行合同，不证明自然语言、help、搜索、多步规划或未见Goal语义。当前只实现pwd/cd/ls；未来命令沿同一权重合同增量接入，不代表任意系统命令已可执行。

## 2026-10-19 固定满足度独立复核（历史）

作者完成固定满足度增量后，由独立验证worker在保存候选上复核。复核没有拟合、重训，也没有修改fixture、标签、权重、预算或源码。构建通过。当时公开固定配置为`CLI_COMMAND_GOAL_CONFIG.satisfactionThreshold=100`，结果使用`achieved/100`、`unmet/0`与`unverified/null`三值评价。该固定配置已退役，当前阈值显式传入，`unverified`由统一`unknown`取代。

同一保存候选取`d7c4a3e5-4111-4e09-857f-5f20f4fa18c0/candidate.json`，关系模型取`c30b2917-4980-4b0f-8c7f-e0954ce22270/relation-candidate.json`。独立测试通过，命令选择16/16，CWD关系16/16；常规题中pwd、cd、ls、unsupported各4题，失败项中pwd 2题、cd 8题、ls 6题。14项为native/grant失败，2项为受控故障注入。测试断言支持命令的正常项为`achieved/100`，未知语义的unsupported为`unverified/null`且不执行；已知失败项为`unmet/0`，CD提交后观测失败与LS partial项为`unverified/null`。报告为`standards-independent-report.json`，日志为`standards-independent.log`。

全仓命令`npm test`在显式Handwired根、共享命令候选、CWD关系候选和动作候选下通过：253/253，0失败，0跳过，0取消。日志为`standards-regression.log`。新进程公开回载通过：`checked=24`、`executions=18`、`fitted=false`，日志为`standards-reload.log`。

P1来源独立gate由三组真实测试覆盖：

- `shared prepare rejects scenario source groups that cross partitions`拒绝同一source group跨train/development分区。
- `optional verification rejects primary train or development source groups before fitting`证明来源重叠在拟合前拒绝，且不留下部分路径。
- `optional verification with disjoint source groups evaluates and fully verifies`证明独立来源可评价，4条验证行均保留独立source group并达到`fullyVerified=true`。

该gate按显式`sourceGroup`判断不重叠。它不证明不同标签掩盖同一原始资产，也不证明任意新来源的代表性。独立命令fixture仍只有4种有限语义向量，关系评价仍是有限真值组合；这些结果不证明未见Goal语义、自然语言、help、搜索、多步规划或完整自动进化链。

本轮新增评价证据不追溯改写旧独立报告。旧报告形成时没有`satisfaction`字段，不能据此宣称旧结果已经验证本次三值满足度合同。历史计数、先红测和原错保留。历史共享权重不变，候选继续为`uncalibrated/not_applied`。当前`file.property.xxx`运行入口已迁移；自动使用采集、显式当前引用、自动配对评价采用及LLM冲突裁决执行链仍未实现。

## 历史独立profile基线

2026-10-19。下列结果是逐命令独立profile的历史实验基线。用户随后要求所有命令采用一份共享权重并增量训练，不能将这些基线冒称共享模型已完成。实际使用本地Handwired源码`/Volumes/extension/code/handwired`求值与反传。每个单元零初始化、200 epochs、learning rate 0.1、全批SGD。候选均为uncalibrated/not_applied，不覆盖当前profile。使用真实文件系统专用目录，不声称硬件或OS隔离。

## CWD关系与PWD

正式run：`c30b2917-4980-4b0f-8c7f-e0954ce22270`。

| 分区 | CWD关系 | PWD动作 | 正常真实PWD |
| --- | ---: | ---: | ---: |
| train，4家族 | 16/16 | 12/12 | 4/4 |
| development，2家族 | 8/8 | 6/6 | 2/2 |
| 独立验证，4家族 | 16/16 | 12/12 | 4/4 |

独立验证另执行4次PWD取得关系题的观测证据，并检查缺失cwd和缺授权两个失败。重复PWD具有不同run，旧知识不代替本次执行。跨session关系、初始路径越界和cwd替换为越界链接均有反例。关系只覆盖4种特征向量，PWD只覆盖3种特征向量。

真实拟合：关系343.515ms、3200梯度行；PWD347.788ms、2400梯度行。workflow473.176ms、新进程回载140.833ms、consumer总计706.140ms。两个拟合分支可并行，不能将拟合时间相加当workflow耗时。

本地资产：`training/samples/filesystem/cwd/<run>/samples.json`、`training/weights/filesystem/cwd/<run>/{relation-candidate,action-candidate}.json`、`training/results/filesystem/cwd/<run>/{report,consumer-summary}.json`。

## CD

正式成功run：`b7f48942-4b3d-4b87-b0c1-fbac2de702ed`。

| 分区 | 动作正确 | 提交后下一run同session PWD |
| --- | ---: | ---: |
| train，4家族 | 12/12 | 4/4 |
| development，2家族 | 6/6 | 2/2 |
| 新独立验证，4家族 | 12/12 | 4/4 |

零/冻结控制只选REJECT，train为8/12、development为4/6，均不执行CD。拟合后正确执行CD。额外连续CD轨迹在每次提交后以新PWD复核；相对DirectoryRef在cwd改变后重新绑定。

8个独立失败探针包括不存在、普通文件、最终链接、词法越界、链接后越界、缺exec、缺session.write，以及受控提交后观测失败。前7项为真实文件系统校验或显式grant拒绝；最后一项是故障注入，不冒称原生OS失败。提交后观测失败保留已改变状态，Goal未验证，不自动回滚。

原验证发现policy在harness前做文件类型解析，导致错误未进入typed回执。原失败日志保留。修复后原集只作回归，再由新独立结构家族验证。权重与预算没有按验证集调节。

真实拟合357.176ms、2400梯度行；workflow531.130ms、新进程回载230.647ms、consumer总计847.363ms。首次run的拟合/回载通过但consumer清理调用错误，整次退出失败；不作为成功run。

本地资产：`training/samples/filesystem/cd/<run>/samples.json`、`training/weights/filesystem/cd/<run>/candidate.json`、`training/results/filesystem/cd/<run>/{report,consumer-summary}.json`。

## 复现与证据边界

旧CWD/CD独立命令consumer及其运行图已退役。历史样本、权重、报告和原始日志仍保留；当前复现入口使用上方共享consumer。CWD关系函数保留为独立概念测量，不产生第二个命令选择器。

过程原始记录位于`/Volumes/Intel/playground/nnanything-runs/cli-basics-training/`。其中`cwd-parent-acceptance.md`、`cd-parent-acceptance.md`索引原错、修复、真实训练及独立报告。独立fixture不导入训练生成器。相同有限特征向量在各分区都出现，实测证明环境与执行合同覆盖，不证明未见Goal、自然语言、help、搜索、组合规划或全自动进化。
