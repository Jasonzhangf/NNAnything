# 路径函数表达训练 M1

目标：`path.resolve(cwd,input) -> absolute_path`。仅 macOS/POSIX 词法路径；无自然语言、目录选择、文件系统查找、符号链接解析或 pwd 能力学习。本轮先交首个精确函数训练，目录绑定设计后置。

`cwd` 必须是规范绝对路径，根为 `/`；其他路径段非空、不是 `.`/`..`，无尾部斜杠。input 非空、无NUL，按 `/` 分段，重复/首尾斜杠中的空段忽略。`.`、`..` 和普通名称段保留；普通名称包括空格、Unicode、反斜杠及字面 shell 符号。绝对 input 以 `/` 开始。cwd 与 input 的非空路径段总数最多256。超界明确拒绝，不作路径展开或近似处理。

## 学生结构与公开共享合同

`PathRequest={cwd:string,input:string}`。`PathAction` 顺序固定为 START_FROM_ROOT、START_FROM_CWD、PUSH_NAME、POP_PARENT、STAY。`PathProfile` 包含 contract=`cli.path-controller.v1`、actions、wires、5×9 weights、calibration=`uncalibrated`、adoption=`not_applied`。动作与wire顺序及参数维度必须校验，不能按数组下标误载旧权重。

wire顺序：bias、phaseStart、phaseSegment、absoluteInput、kindCurrent、kindParent、kindName、stackEmpty、parentEmpty。最后一项为 kindParent×stackEmpty，只提供已观测状态关系。名称和完整路径不进入向量。每个动作使用线性logit；同分按声明顺序选第一个，不用teacher或动作mask修正。

手写部分只负责语法分段、状态输入、通用栈原语、名称复制与格式化。栈从未初始化开始；起点与每个非空input段都必须经过模型选动作。非法动作（起点阶段push、根上pop、对非名称push等）返回失败并保留尝试trace；机械上合法但语义错误的动作按实际结果计错，不能替换为teacher动作。

共享函数 owner `lib/filters/cli-path-controller.ts`：`validatePathProfile`、`zeroPathProfile`、`scorePathActions(features,profile)`、`rolloutPath(request,profile)`；导出 PATH_ACTIONS/PATH_WIRES、PathAction/PathRequest/PathFeatures/PathProfile/PathStep/PathRollout/PathFitRow。PathStep={index,phase,features,scores,action,before,after}。成功rollout={ok:true,absolute,trace}；失败={ok:false,code,message,trace}。请求校验失败可抛明确TypeError；学得动作失败用失败结果。

数值结构 owner `lib/nodes/trainable/cli-path-controller.ts`：`buildPathCircuit(module)` 返回 `{circuit,parameterWires,featureWires,logitWires}`；参数按action-major展平45项，特征9项，动态source通过multiply/affine形成5个logit，不硬编码学习后的策略。

拟合 owner `lib/training/cli-path-numeric.ts`：`fitPathController({rows,initial,handwiredRoot,epochs,learningRate}) -> {profile,timing,trajectory}`。rows={features,expected:PathAction}，仅训练行；真实Handwired前向反传，稳定softmax交叉熵、全批SGD，零参数初始化。默认200epochs、lr0.1，只允许用开发集调整。epochs0为明确冻结对照，参数不变，不假称发生拟合。EpochMetric={epoch,loss}。

FitTiming记录backendLoadMs、circuitBuildMs、baselineEvalMs、trainEpochGradMs、finalEvalMs、fitTotalMs、completedEpochs、processedRowCount、gradientRowEpochs、totalRowPasses、trainableParamCount。失败保留已完成轮数及部分计时。保存候选不自动采用，不改变M0默认实现。

## teacher、样本与验收

teacher只用于准备样本和评估，以独立路径规则给出动作trace；用 `path.posix.resolve` 独立核对最终期望值。学生不能导入teacher、normalize/resolve路径求解器或已解析的答案。初始/冻结/训练后的完整路径与teacher-state单步动作成绩分别报告。完整路径按模型自己执行的状态逐步推进，记录首个偏离和invalid action；不得只报告teacher状态上的单步正确率。

可读合成fixture目标64train/16development/32holdout，包含原始cwd/input、期望路径、结构场景族和分区。所有同场景重命名、slash/dot变形在同一分区。保留样本数、场景族数和展开step数。留出包含未见组合和更长深度，不参与参数/预算选择。公开生成器可复现fixture。真实pwd原件如采集只留本地，不把路径名称当身份特征。

验收需有零参数基线、冻结参数对照、实际拟合参数变化、全部声明fixture的自主完整路径结果、实际计时、保存后新进程从公开入口回载。非法profile、缺后端、跨分区族泄漏、非法请求、错误动作不被修正、未授权/覆盖保存等必须明确失败。达到有界验收不宣称无限长度或任意CLI泛化。

## 外部执行图

训练持久图为4N3E：准备路径样本 → 拟合动作参数 → 评估完整路径 → 保存候选报告。资源在节点工厂显式注入，save声明filesystem.write，必须在拟合前通过compile授权；每个阶段传递明确数据，不在核心加入CLI分支。

推理持久图为1N0E的 `cli.path.resolve`，profile显式绑定，内部有限rollout是函数内部结构而非第二个workflow执行引擎。公开入口 `nnanything/cli-training` 提供 `createPathResolver({profile})` 与 `runPathTraining(request,resources)`，均加载持久配置并复用compiler/runner/Flowed。

## 运行与样本

公开入口为 `nnanything/cli-training`。可读样本位于 `playground/cli/path-resolve/samples.fixture.json`；生成器为 `makePathFixture`，`preparePathDataset` 检查独立POSIX oracle标签、来源族与去名称/重复分隔符/当前段后的结构跨区泄漏。样本生成不创建对应文件。

```sh
npm run prepare:path-samples -- --output /absolute/new-samples.json
npm run demo:path-training -- --handwired-root /Volumes/extension/code/handwired
```

prepare 的目标父目录必须已经存在，文件以create-new写入；不传output时输出样本JSON。训练可传 `--samples FILE`、`--output-root EXISTING_TRAINING_ROOT`、`--epochs 200`、`--learning-rate 0.1`。输出根必须存在且为调用者明确授权的训练资产目录；默认本项目training。样本、权重和报告分别落在 samples/weights/results 的 path-resolve 子目录。模型不会自动接入M0。

```ts
import {createPathResolver, validatePathProfile} from 'nnanything/cli-training';
const profile = validatePathProfile(savedCandidate);
const resolver = createPathResolver({profile});
const result = await resolver.resolve({cwd:'/a/b',input:'../c'});
// result.ok 时 absolute 为 /a/c，并保留模型每步分数、动作和栈。
```

`runPathTraining({dataset,epochs,learningRate},{handwiredRoot,outputRoot,grantedEffects})` 需要filesystem.read与filesystem.write。未授权effect在compile时拒绝，早于拟合；候选和报告create-new写入，子目录不允许链接逸出。保存失败通过错误链返回已写资产路径和已有拟合计时。没有磁盘沙箱或对恶意并发替换的隔离承诺。

训练consumer在保存之后启动新的Node进程，读取实际样本/权重文件，通过同一推理图重新执行，并逐项比较分数、动作、栈和路径。`report.json` 包含逐例原始结果；`consumer-summary.json` 记录完整trainingWorkflowMs、fresh-process回载时间和总consumer时间。report中的workflowMs为节点工厂开始到报告写入前的阶段时间，receipt中的同名字段计到报告写入后；完整调用wall time以consumer-summary的trainingWorkflowMs为准，不混用边界。

## 首轮实际结果（2026-10-19）

按预先声明的200轮、学习率0.1，用64条train请求展开的200条teacher-state动作行拟合45个参数。先运行train/development验证预算，不读取holdout；开发通过后，正式consumer使用同一预算执行全部声明分区。没有用留出成绩调整参数。

| 分区 | 请求数／结构族 | teacher动作行 | 零参数完整路径正确 | 训练后完整路径正确 | 训练后teacher-state动作正确 | 无效rollout |
| --- | --- | --- | --- | --- | --- | --- |
| train | 64／8 | 200 | 8 | 64 | 200 | 0 |
| development | 16／2 | 96 | 0 | 16 | 96 | 0 |
| holdout | 32／4 | 288 | 0 | 32 | 288 | 0 |

合计104 fixed、8 retained、0 regressed、0 unresolved。冻结对照epochs0参数不变，沿用已验证相同参数的baseline成绩；不重复跑相同推理来充当独立实验。新进程回载112条完整trace一致。

首次正式run为 `5be5fe28-1dbe-4558-9d23-23d2b441870a`，本地资产在 `training/samples/path-resolve/<run>/samples.json`、`training/weights/path-resolve/<run>/candidate.json`、`training/results/path-resolve/<run>/{report,consumer-summary}.json`。这些资产按既有规则留本地；公开合成fixture和生成方法随代码提交。原始开发、baseline、正式运行及测试证据在 `/Volumes/Intel/playground/nnanything-runs/path-resolve-m1/`。

首次正式拟合552.254ms，其中后端加载326.297ms、梯度训练219.700ms；200行×200轮共40000梯度行轮，总forward行访问40400。完整训练workflow600.077ms，新进程回载115.405ms，consumer718.002ms。梯度阶段约182067行轮/秒；按200个拟合行除完整workflow计约333.29行/秒。两种吞吐分母不同，不将64请求或112总样本混作拟合行数。

留出cwd深度5–8，训练cwd深度0–3；留出有更长的parent/root-clamp与名称复制组合。名称、ref和路径身份不作为特征，但输入符号种类和有限状态原语已经手写；这是有界符号控制器在未见组合上的结果，不是任意函数学习、真实文件系统路径解析、help理解或通用编程能力。评分保持uncalibrated，候选not_applied。
