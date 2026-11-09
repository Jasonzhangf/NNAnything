# TS/JS symbols first-train config and reload preparation r1

状态：2026-11-09 设计/准备，owner Leo，reviewer Alice。任务
`tsjs-first-train-config-reload-prep-r1-20261109`。本页只准备
TS/JS symbols 首训的实际配置、package/checkpoint 路径、新进程回载证据计划和
准入检查。不运行 train/resume/evaluate，不采集或转换样本，不实现产品代码，
不改权重、gold、threshold 或采用状态，不安装，不绕过 evaluate gate，
不动 daemon/tmux。

## 1. 依据与唯一缺口

来源：

- Alice 计划审计：
  `/Volumes/Intel/playground/nnanything-runs/nncode-swift-first-train-planner-20261109/alice-plan-audit.md`
  （B 段 PASS）。
- 独立计划：
  `/Volumes/Intel/playground/nnanything-runs/nncode-swift-first-train-planner-20261109/plan.md`
  §B。
- 已接受设计：
  `docs/nn-code-redesign-symbols-tsjs-design.md`。
- 训练入口与回载合同：
  `docs/nn-code-tsjs-training-entry-reload-contract.md`。
- 已接受 TS/JS 符号设计审计与固定训练启动合同：
  `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-tsjs-symbols-design-audit-20261106.md`、
  `emma-tsjs-fixed-training-launch-r1.md` §2.1-§2.4。
- 本轮实现真源：
  `lib/training/l2-standard-runner.ts`、`unified-train-config.ts`、
  `unified-training-checkpoint.ts`、`unified-model-package.ts`、
  `unified-timing.ts`、`unified-data-gate.ts`、`scripts/convert-neural-cli-tsjs.mjs`。

现有决定保持固定：64 输入、两层隐藏层、统一 typed 格式、固定推理引擎。
唯一缺口是实际首训配置、输出路径、新进程回载证据和 evaluate 启动门尚未落盘。
本页只补该准备合同，不新建第二训练器、不新增并行图、不改变已接受算法。

## 2. 唯一对象流与 SESE

```text
B0 接收接受设计请求
  -> B1 配置、资源、输入与负控制准备
  -> B2 启动门：evaluate 验收 + 数据/recipe 准入 + 正式生命周期
  -> B3 固定 train
  -> B4 checkpoint 原子保存
  -> B5 checkpoint 新进程回载
  -> B6 candidate package 原子保存
  -> B7 package 新进程回载
  -> B8 独立评价、旧能力回归与真实 consumer
  -> BS 成功结果
  -> B9 单一最终报告

任一节点失败 -> BF 保留原错与已有结果 -> B9
任一活动节点取消 -> BC 取消结果 -> B9
B8 不通过 -> BR 保留当前采用版本、候选不采用 -> B9
```

B0 单入口，B9 单出口。BS/BF/BC/BR 都汇入 B9。没有训练重试回边。bounded
invocation 如另行批准，可进入 paused 结果并汇入 B9；下一次 resume 是新 invocation，
读取已提交 checkpoint，不回退初始化、不增加总预算。首轮计划不主动切 bounded run。
来源（复用现有图）：`docs/nn-code-tsjs-training-entry-reload-contract.md` §2-§5；
`docs/nn-code-redesign-symbols-tsjs-design.md` §3、§5。

## 3. 数据准入边界

复用已接受 v2 输入根：

```text
/Volumes/Intel/playground/nnanything-runs/tsjs-v2-corpus-admission-henry-20261108/
```

有效证据为 `converter-out/run-report.json`、`validation-out/run-report.json`、
Alice revision 1 ACCEPT 和物理分离的行文件。当前基线为 15 data groups、
67 student rows、15 supervision rows；这些是输入对应基线，不是模型效果。

保留两次排除：

- `b-closure-unknown-dynamic-property`：真值争议未裁定，不进 fit。
- `a-module-unknown-missing-module`：真实模块解析/覆盖失败，保留原 gold，
  不生成新的语义允许集合。

TRAIN 只来自已接受的 staged corpus。DEV 不进入梯度、early stop 或首轮候选选择。
VERIFICATION 不进入 fit 配置，也不经 data gate 伪装成 TRAIN。
`train`/`resume` 不接收 `evalSources`。独立评价来源由 evaluator 保管，
不为写训练配置读取其内容。

## 4. 实际配置字段与值

首训 run 根：

```text
/Volumes/Intel/playground/nnanything-runs/tsjs-symbols-first-fit-20261109/
```

该目录及以下文件尚未创建。Jenny 确认唯一 owner 后由执行者创建；若已有同名活动
run，保留它并在原合同中指定新的可读路径，不覆盖。配置文件
`train-config.json` 建议内容：

```json
{
  "schema": "nnanything.unified.runner-config.v1",
  "command": "train",
  "route": {
    "domain": "tsjs",
    "decisionKind": "R"
  },
  "phase": "pretraining",
  "encoderVersion": "nnanything.unified-step.encoder.v2",
  "dataGate": {
    "schema": "nnanything.unified.data-gate.v1",
    "partition": "TRAIN",
    "encoderVersion": "nnanything.unified-step.encoder.v2",
    "thresholdsPath": "/Volumes/extension/code/NNAnything/tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
    "rowsPath": "/Volumes/Intel/playground/nnanything-runs/tsjs-v2-corpus-admission-henry-20261108/converter-out/data-rows.jsonl"
  },
  "outputDir": "/Volumes/Intel/playground/nnanything-runs/tsjs-symbols-first-fit-20261109/out",
  "corpus": {
    "root": "/Volumes/Intel/playground/nnanything-runs/tsjs-v2-corpus-admission-henry-20261108/staged",
    "admissionsPath": "/Volumes/Intel/playground/nnanything-runs/tsjs-v2-corpus-admission-henry-20261108/staged/corpus-admissions-v1.json",
    "studentRowsPath": "/Volumes/Intel/playground/nnanything-runs/tsjs-v2-corpus-admission-henry-20261108/converter-out/student-rows/student-rows.jsonl",
    "supervisionRowsPath": "/Volumes/Intel/playground/nnanything-runs/tsjs-v2-corpus-admission-henry-20261108/converter-out/labels/supervision.jsonl",
    "packagePath": "/Volumes/Intel/playground/nnanything-runs/tsjs-symbols-first-fit-20261109/package/model-package.json",
    "missingModeTablePath": "/Volumes/extension/code/NNAnything/tests/fixtures/unified-64-slot/missing-mode-table.json"
  },
  "training": {
    "modelId": "nn-code.tsjs.symbols.r",
    "version": "0.1.0-first-fit-r1",
    "optimizer": "full_batch_sgd",
    "learningRate": 0.01,
    "maxEpochs": 200,
    "seed": 20261104,
    "init": "xavier_uniform",
    "checkpointPath": "/Volumes/Intel/playground/nnanything-runs/tsjs-symbols-first-fit-20261109/checkpoint/training-checkpoint.json"
  }
}
```

这些路径已在准备时核对为存在：阈值、missing-mode、data-rows、student-rows、
supervision-rows、corpus-admissions。`modelId`/`version` 是本计划提出的候选身份值，
须由 Alice 配置审计接受；它们不是既有产物。资源路径来自已接受准入配置；执行时必须
证明实际读取这些资源且不修改内容。

其他固定值由当前入口生成或实现，不向 JSON 添加不存在的字段：

| 项目 | 固定值或来源 |
| --- | --- |
| 内部 train schema | `nnanything.unified.train-config.v1` |
| input schema | `nnanything.unified-step.v1`，由 `buildUnifiedTrainConfig` 设置 |
| architecture | `64 -> 64 -> 64 -> 1`，ReLU |
| loss | `L(g)=logZ_all(g)-logZ_allowed(g)`；epoch 为合格组均值 |
| batch / momentum | full batch；momentum=0 |
| early stop | 禁用 DEV early stop；不以自拟 loss 阈值提前停止 |
| 最大预算 | 200 epochs，仅为上限，不代表语义通过 |
| `epochsThisRun` | 首轮省略 |
| resume | 首轮不使用，不从旧 CLI/browser 权重初始化 |
| candidate 状态 | `uncalibrated/not_applied`，沿既有候选记录表达，不添加未知 package 字段 |

这是 TS/JS 首训，不是后训练。后续后训练必须继承合格权重并按既有重放合同执行，
不能把从零重拟合称为后训练。

## 5. 公开命令与保存/回载顺序

以下命令仅为后续执行步骤，本次未运行。在 Jenny 指定的已核实 worktree 中，
使用其实际构建产物：

```sh
node dist/training/l2-standard-runner.js validate-data --config /Volumes/Intel/playground/nnanything-runs/tsjs-symbols-first-fit-20261109/train-config.json
```

先确认该入口对配置中 `command` 的处理方式。若要求命令字段一致，则准备同一配置的
`validation-config.json`，仅将 `command` 改为 `validate-data`、`outputDir` 改为独立
validation 输出，不改数据、recipe 或来源。`validate-data` 只证明数据门；不发明独立
`validate-config` 子命令。完整配置校验由已有 `validateUnifiedTrainConfig`、runner
配置构造与对应工程测试证明；如缺某项覆盖，交工程 owner 在既有测试中补齐，不运行
真实 fit 探测配置。

启动门全部满足后，唯一真实拟合命令：

```sh
node dist/training/l2-standard-runner.js train --config /Volumes/Intel/playground/nnanything-runs/tsjs-symbols-first-fit-20261109/train-config.json
```

该命令内部依次执行：配置及数据校验；固定 recipe 拟合；checkpoint 原子保存；新 Node
子进程读取 checkpoint 并比较 tensors/completed epochs/epoch record count；完整预算
结束后保存 candidate package；新 Node 子进程调用 `loadUnifiedModelPackageFromFile`
并比较保存前后 tensors 与资源解析路径；写每次运行回执及 latest 报告。

没有独立 `save-package`、`save-checkpoint`、`reload` CLI。不得增加第二个 runner，
也不得用同进程内存对象代替上述回载。

只有已批准的暂停恢复才使用：

```sh
node dist/training/l2-standard-runner.js resume --config /Volumes/Intel/playground/nnanything-runs/tsjs-symbols-first-fit-20261109/train-config.json
```

resume 必须匹配 checkpoint 的 model、version、route、recipe、input/encoder 与资源
引用，不重新初始化。

## 6. evaluate REWORK 与首训启动门

Henry 可继续现有窄修，不等 ticket 恢复。必须关闭：

- 真实 read/observe -> 新状态 -> judge 多动作公开工程轨迹。
- 同一样本中已完成步与失败步保留，含原始 code/nativeCode/message、实际 stepId
  和安全后验。
- root evidence 为空不能报 completed；不得由 runner 补造 root ref。
- 学生输入缺失时保留已确认独立监督义务及原 sample 身份。
- root satisfied/unsatisfied/unknown 与 missing 分开，机器和人读报告保留或链接
  完整语义与证据。

闭合证据为对应公开成功/失败 fixture、红绿回执、受影响构建及 Alice finding 复核。
终端快照重复执行、全 true 控制 fixture 或测试汇总不能代替真实多动作证据。

真实 fit 启动条件：

1. evaluate 工程通过适用验收，Alice 关闭受影响 findings。
2. 修复已进入首训实际使用的候选/集成环境。
3. 实际配置及负控制通过审计。
4. 接受的 TRAIN 数据与资源可解析，隔离不变。
5. 保存、checkpoint、新进程回载与当前计时工程证据有效。
6. 适用正式交付生命周期恢复并完成，不绕过 ticket gate。

Rust 独立 verification 或 Rust package 不是 TS/JS 首训前置；真实训练 package 也
不是首训前置。

## 7. 必须收取的证据

| 证据 | 内容 |
| --- | --- |
| 执行身份 | worktree 路径、实际公开 runner 路径、Node 版本、命令、配置路径 |
| 原始结果 | stdout、stderr、原始退出码、报告路径；非零不能被 wrapper 改成成功 |
| 输入 | admission、物理学生/监督/data 路径、partition、encoder、排除理由 |
| 配置 | 实际解析后的 route、model/version、input/encoder、recipe、资源及输出绝对路径 |
| loss | 初始/最终及逐 epoch loss、finite、maxAbsGrad、末段变化、单调违规 |
| 停止 | `epoch_limit_exhausted`、数值失败、数据失败、暂停或其他原始停止原因 |
| package | `nnanything.unified.model-package.v1`；固定架构、fixedStages、资源、完整 tensors |
| checkpoint | `nnanything.unified.training-checkpoint.v1`；committed tensors、recipe、epochs、记录、资源及 timing |
| package 回载 | 实际新进程成功退出、`tensorsMatch=true`、解析 package 与资源路径 |
| checkpoint 回载 | 实际新进程成功退出、tensors、completed epochs、epoch record count 对应 |
| 计时 | load、validation、optimization、checkpoint I/O、reload、evaluation、total wall 及 committed cumulative cut point |
| 失败 | 已完成结果、失败步、原错与未执行阶段；未知计数和未进入阶段保持 null |
| 回归 | 独立逐例结果、known/unknown、coverage、missing、execution、逐步和 root 证据 |

package tensors 长度应为 `4096/64/4096/64/64/1`，对应 W1/b1/W2/b2/W3/b3。

当前 package 子进程回执返回 model/version、tensors 和解析资源路径；checkpoint
子进程比较 tensors、epoch 数和记录数。不能把比较扩大成“已比较全部资源内容及全部
恢复状态”。配置一致性与资源语义还须由 loader 校验、typed resume 检查及对应负控制
证明。

计时使用现有 monotonic 字段。失败 epoch 的 `attemptProcessedRows` 无法准确得知时
保持 null。累计值只覆盖 checkpoint committed cut point；本次完整 wall 与
committed cumulative 分开。TS/JS 当前是一个共享 scorer，不虚构四个独立头的耗时。

## 8. 负控制

只用隔离工程 fixture 或合成 tensor，不能改真实语料、gold、threshold 或候选。

| 负控制 | 预期 |
| --- | --- |
| 错 runner/train/package/checkpoint schema | 显式拒绝，非零；不输出成功候选 |
| 缺 config 或缺 training/corpus | 解析或配置失败；不启动优化 |
| threshold/missing-mode 不存在或错误 | 显式失败；不能回退默认资源 |
| 错 route、encoder 或版本绑定 | 在适用 consumer/resume 边界拒绝 |
| 空 package、缺 tensors、错误 tensor shape | loader 拒绝，非零 |
| 子进程回载 tensors 不同 | `PACKAGE_RELOAD_ERROR` 或对应显式错误；不接受候选 |
| checkpoint epoch/record/tensor 不同 | checkpoint reload 失败 |
| 非 TRAIN、泄漏字段、空/越界 A_g | 数据拒绝，不拟合 |
| 非有限 loss 或 gradient | 停止，不生成成功候选；保留 trace 和原错 |
| 子进程非零退出 | 外层报告失败，保留原错误 |
| root 缺证据或失败样本中途退出 | 保留监督分母、已完成步、失败步和未完成状态 |

复用 `tests/unified-runner-convert-train.test.mjs`、`tests/unified-train-config.test.mjs`、
模型包与 evaluate 的既有测试 owner，不新增包装检查框架。已有有效正反证据直接引用。

## 9. 独立评价与旧能力回归

fit 结束和 reload 通过后，才由独立 evaluator 运行：

```sh
node dist/training/l2-standard-runner.js evaluate --config <接受的独立评价配置绝对路径>
```

该配置是现有独立评价合同的产物；当前缺少真实首训候选，不能提前伪造其可运行状态。

分别报告：

- 已知 true/false 关系逐例正确，错误为零。
- 有效 unknown 的最终 judge=unknown，无漏报和误判。
- 中间 observe/advance/DEFER 按逐步 A_g 评价，不误计为最终错误。
- 候选覆盖、truncated、failed、missing-run、labelMissing 和 root 证据。
- 完整用户请求的真实 consumer 行为。

旧能力回归包括已接受的 TS/JS import/reexport/alias、声明身份、unknown 与多步边界，
以及受本次共享实现变更影响的既有公开接口。旧 CLI/browser 权重和 threshold 不变；
若只产生新 package，复用其有效证据。若共享 runner、loader、encoder 被修改，则执行
受影响旧 consumer 回归。不得将旧能力成绩合并成 TS/JS 首训准确率，也不解封无关
browser verification。所有候选继续 `uncalibrated/not_applied`。

## 10. Owner、阻断与恢复动作

| 责任 | owner 与边界 |
| --- | --- |
| 本次配置准备与文档 | Leo（当前任务 owner），新语义决定仍交设计 owner |
| evaluate 窄修 | Henry；adapter 依赖交真实 owner，经 Jenny 路由 |
| 实际配置文件与路径准备 | Leo 当前接单；若 Jenny 改变执行 owner 按 board 调整 |
| 固定 fit 执行 | Jenny 指定执行 peer；GCM 只调用已验收入口，不修 trainer/converter/evaluator |
| 独立评价 | 隔离 evaluator（Frank 或 Jenny 指定替代） |
| 独立审计 | Alice |
| 集成与资源收口 | Jenny |
| ticket 恢复 | AppSDK 实际 owner；本任务不执行安装或 daemon 操作 |

当前阻断与立即动作：

| 缺口 | 立即动作 | 恢复信号 |
| --- | --- | --- |
| evaluate REWORK | Henry 继续五项窄修及工程 fixture | Alice 对新公开证据关闭 findings |
| 正式 ticket 生命周期 | Jenny 协调 AppSDK owner，保留原拒绝 | 正式合法路径成功；不 force-close |
| 实际配置未落盘 | 执行者按 §4 创建并核对，独立于 ticket 推进 | 实际配置、解析路径及审计回执 |
| package/reload 证据不完整 | 工程 owner 用已有 loader/save/测试补反例 | schema、资源、子进程回载正反证据完整 |
| 独立评价或旧回归清单缺失 | evaluator 在不向 fitter 暴露来源前提下落实 | 接受的独立配置、分母和回归边界 |

任一阻断仍存在时不运行 `train/resume`。数值失败、数据失败、回载失败、语义验收失败或
旧能力退化时停止受影响链。保留失败候选和原始证据，不换 seed、不加 epochs、不换
优化器、不改 gold 或阈值。下一步由设计 owner 根据具体失败修订方案，再交 Alice 审计。

## 11. 验收矩阵

| 验收项 | 通过条件 | 当前状态 |
| --- | --- | --- |
| 唯一缺口 | 只闭合首训配置/路径/回载/启动门 | 设计完成 |
| 固定架构 | 64 -> 64 -> 64 -> 1，ReLU | 设计完成 |
| 数据隔离 | TRAIN/DEV/VERIFICATION 边界明确，train 只收 TRAIN | 设计完成 |
| 配置与路径 | 所有输入/资源路径真实存在；输出为尚未创建的首训产物路径 | 设计完成 |
| 公开入口 | 不发明第二个 runner/CLI；沿用 l2-standard-runner | 设计完成 |
| 新进程回载 | 明确 checkpoint/package 子进程比较与资源解析证据 | 设计完成 |
| 负控制 | 十类正反预期已定义，测试职责复用 | 设计完成 |
| evaluate gate | 五项 finding 关闭且生命周期恢复前不 fit | 设计完成（gate 未关闭） |
| 实际配置 | `train-config.json` 落盘并审计 | UNVERIFIED |
| fit | 真实 train 执行与原始回执 | UNVERIFIED |
| package/checkpoint | 真实保存、新进程回载、资源解析 | UNVERIFIED |
| 独立评价 | 语义、coverage、missing、execution、root 证据 | UNVERIFIED |
| 采用 | 候选继续 `uncalibrated/not_applied` | 未变化 |

本页只证明设计准备。配置存在不证明可训练；训练存在不证明语义通过；独立评价通过
才可进入采用决策。

## 12. 非目标与后续 owner

不运行 train/resume/evaluate，不采集或转换样本，不写产品/config/weight/gold，
不改 threshold/采用，不安装，不恢复旧 nn-code，不动 daemon/tmux。Alice 审计本设计
后由 Jenny 指定执行 owner 落盘实际配置并推进 evaluate 窄修；实际 fit 仍需
§6 启动门全部闭合。
