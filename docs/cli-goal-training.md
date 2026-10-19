# 首个结构化 Goal 动作训练：observe_cwd -> pwd

状态：历史实现与实测合同（2026-10-19），作为兼容基线保留。本文记录首个单项 `observe_cwd -> pwd` 的真实实测数据与6参数模型结构。该六参数API（`createCliGoalPolicy`、`runCliGoalTraining`）仅作为历史兼容基线保留，新共享入口不调用该旧API与旧profile。全命令统一共享模型（`cli.command-policy.v1`）唯一权威合同见[文件系统训练合同](cli-filesystem-training.md)。历史记录与实测数据保留原貌，不重写历史。

## 1. 范围

支持的结构化 Goal 为：

```ts
{ kind: "observe_cwd", session: S }
```

`set_cwd` 与其他结构化 Goal 是拒绝对照，不执行命令。首轮动作集合固定为 `REJECT`、`PWD`。`PWD` 只调用已有 CLI session 的 `{kind:"pwd"}` 观测，即真实 `/bin/pwd -P`。`cd` 未实现。

State 使用显式 session 引用：

```ts
type State = {
  session: string;
  cwdObservation: null | {
    physicalCwd: string;
    evidence: PwdObservation;
    sourceRun: string;
  };
};
```

旧知识只作上下文，不能证明本次 Goal 成功。只有本次运行的真实 pwd 观测成功，且新状态绑定该观测与运行 ID，`goal_result.status` 才可为 `achieved`。拒绝或执行失败保留原知识对象。

## 2. 学习结构

wire 固定顺序：`bias`、`goalObserveCwd`、`goalSetCwd`。输入向量只有三种：

| Goal 种类 | features | teacher action |
| --- | --- | --- |
| `observe_cwd` | `[1,1,0]` | `PWD` |
| `set_cwd` | `[1,0,1]` | `REJECT` |
| 其他 | `[1,0,0]` | `REJECT` |

profile 是 2×3 线性 logit，共六个参数：

```ts
type CliGoalProfile = {
  contract: "cli.goal-policy.v1";
  actions: ["REJECT", "PWD"];
  wires: ["bias", "goalObserveCwd", "goalSetCwd"];
  weights: [[number, number, number], [number, number, number]];
  calibration: "uncalibrated";
  adoption: "not_applied";
};
```

同分按动作顺序选 `REJECT`。零 profile 因此拒绝所有 Goal。session ID、路径、先前观测、授权和目录名称不进入特征。真实 Handwired `Circuit` 提供六个动态参数 wire 和三个特征 wire；宿主计算稳定 softmax 交叉熵、反传梯度并用全批 SGD 更新。默认 200 epochs、learning rate 0.1，`epochs:0` 是冻结对照。

执行器另设确定性 unsupported guard。坏 profile 对 `set_cwd` 或其他 Goal 选择 `PWD` 时，guard 不执行命令，并保留 `policy_error.code="UNEXPECTED_ACTION"`。策略正确率只比较学习选择与 teacher action；guard 拒绝不计为学习成功。授权仍由现有 CLI executor 检查：`pwd` 需要 `filesystem.read` 与 `process.exec`。

## 3. 样本

公开生成器产生 12 条 train、6 条 development，各分区对三类 Goal 均衡。每条样本有独立 scenario/session ID；train 与 development 的 source group 不交叉。覆盖无先前知识、正确知识、陈旧知识，以及每类 Goal 的有/无知识组合。训练请求没有 holdout 分区，父级独立测试不进入拟合、预算选择或调参。

数据只有三个不同语义 feature vector。18 条记录不等于 18 个独立语义概念；目录改名、session 改名或旧观测变化不会创造新语义向量。fit 只消费 train 的 12 行，development 只用于回放比较。

## 4. 图与公开入口

推理图 `cli-goal-step.graph.json` 为 3N2E SESE：

1. `cli.goal.select` 读取显式 Goal/State 并计算 features、scores、`selectedAction`。
2. `cli.goal.execute` 执行 `PWD`，或在不支持/拒绝时返回 typed rejection/failure。
3. `cli.goal.evaluate` 绑定本次实际观测并验证 Goal，输出完整 transition。

训练图 `cli-goal-training.graph.json` 为 4N3E SESE：准备样本 -> 拟合 -> 零/冻结/候选评估 -> 保存。推理和训练都从持久 workflow 配置经现有 loader、compiler、Flowed 执行。训练图的 fit 声明 `filesystem.read`，save 声明 `filesystem.write`；业务执行授权留在每条 session 内。

公开入口 `nnanything/cli-goal`：

```ts
import {
  createCliGoalPolicy,
  makeCliGoalFixture,
  runCliGoalTraining,
  zeroCliGoalProfile,
} from "nnanything/cli-goal";

const session = {
  id: "session-a",
  cwd: "/absolute/existing/directory",
  grantedEffects: ["filesystem.read", "process.exec"],
};
const policy = createCliGoalPolicy({ profile: zeroCliGoalProfile(), session });
const transition = await policy.step({
  goal: { kind: "observe_cwd", session: session.id },
  state: { session: session.id, cwdObservation: null },
});
```

零 profile 会返回 `selectedAction: "REJECT"` 与未达成 Goal。训练后的显式 profile 才能选择 `PWD`。候选始终 `uncalibrated`、`not_applied`，不会被 M0 自动采用。

## 5. 运行与产物

```sh
npm run prepare:goal-samples -- --cwd /absolute/existing/directory --output /absolute/new-samples.json
npm run demo:goal-training -- --handwired-root /Volumes/extension/code/handwired
```

训练 consumer 可传 `--output-root EXISTING_TRAINING_ROOT`、`--samples FILE`、`--epochs N`、`--learning-rate N`。默认输出到本项目 `training/`。产物：

```text
training/samples/observe-cwd/<run>/samples.json
training/weights/observe-cwd/<run>/candidate.json
training/results/observe-cwd/<run>/report.json
training/results/observe-cwd/<run>/consumer-summary.json
```

保存使用 create-new，不覆盖旧资产。训练完成后启动新 Node 进程，读取实际样本与候选，经同一推理图重放 train/development，并额外执行一个真实失败 session。`report.json` 保留零、冻结、候选的逐例 action、scores、执行次数、Goal 结果与 policy error；`consumer-summary.json` 记录 workflow、回载和完整 consumer 时间。

## 6. 实测结果

2026-10-19 公开 consumer 使用真实 Handwired 源码根 `/Volumes/extension/code/handwired` 运行，正式 run 为 `7b78d1f2-de24-42fb-a4ca-c9e04ecef38c`。数据集为 12 train / 6 development，18 个独立 session，训练拟合只读取 12 条 train 行；两类分区都只有三种语义 feature vector。

| 分区 | 样本 | 零 profile 动作正确 | 冻结 profile 动作正确 | 候选动作正确 | 候选执行次数 | 候选 Goal achieved |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| train | 12 | 8/12 | 8/12 | 12/12 | 4 | 4/4 |
| development | 6 | 4/6 | 4/6 | 6/6 | 2 | 2/2 |

train fixed/regressed/retained/unresolved 为 `4/0/8/0`，development 为 `2/0/4/0`。零与冻结 profile 都选择 `REJECT`，因此 observe 行不执行命令；候选只对 4 条 train observe 和 2 条 development observe 调用真实 `/bin/pwd -P`。`set_cwd` 与其他 Goal 的候选执行次数为 0。策略准确率按学习选择的动作计算，unsupported guard 没有把错误预测算成正确。

200 epochs、learning rate 0.1 拟合 12 行，六个参数均发生变化，完成 200 epochs，梯度行轮为 `2400`，总 forward 行访问为 `2424`。本次实际计时：

| 阶段 | 时间 |
| --- | ---: |
| backend load | 333.961042 ms |
| circuit build | 0.947458 ms |
| baseline eval | 0.361500 ms |
| gradient epochs | 12.616458 ms |
| final eval | 0.009125 ms |
| fit total | 348.246458 ms |
| zero/frozen/trained evaluation | 178.198083 ms |
| save | 1.293792 ms |
| training workflow | 564.266209 ms |
| fresh-process reload | 176.273459 ms |
| total consumer | 747.716584 ms |

梯度阶段吞吐约 `190227.72` 行轮/秒。新进程读取保存的样本与候选后，train/development 的 normalized scores、actions、执行状态与 GoalResult 行逐项一致；另有一个缺失 cwd 的 fresh failure batch，返回显式 `failed` 且 Goal 为 unmet。候选文件为：

```text
training/weights/observe-cwd/7b78d1f2-de24-42fb-a4ca-c9e04ecef38c/candidate.json
```

候选保持 `calibration: "uncalibrated"`、`adoption: "not_applied"`。该结果只覆盖三种语义向量和声明的有限样本，不是未见 Goal 泛化、自然语言或 `cd` 能力。

算子命名修正后，以相同数据、200 epochs / lr 0.1 重新运行，最终候选为 `4929f70a-379c-4e76-9a01-838f4d29e79b`。train/development 指标相同；fit 351.670 ms、training workflow 554.806 ms、fresh reload 205.590 ms、total consumer 768.875 ms。没有根据独立测试调整参数或训练预算。

独立作者的 `tests/cli-goal-independent.test.mjs` 只加载已保存候选，不调用样本生成器或训练函数。最终候选的独立动作选择为 18/18，8 个有效目录观测全部 achieved，10 个预期拒绝/失败场景全部 unmet。覆盖普通、含空格、尾随空格、中文、符号链接目录、陈旧/重复观测、多 session、缺失目录、文件作为 cwd、缺少每种授权以及不支持的 Goal。另验证零权重不能用旧证据完成 Goal、错误策略的 guard 不掩盖选错、session 引用不匹配会拒绝。独立 fixture 没有未见语义向量，不冒称新概念泛化。完整 transition 保存在本地 `independent-report.json`。

重跑独立测试：

```sh
CLI_GOAL_PROFILE="$PWD/training/weights/observe-cwd/4929f70a-379c-4e76-9a01-838f4d29e79b/candidate.json" \
  node --test tests/cli-goal-independent.test.mjs
```

无 `CLI_GOAL_PROFILE` 时该独立套件显式跳过。最终全仓 `npm test` 为 216 passed、0 failed、1 skipped；独立套件用候选另行执行为 1 passed、0 skipped。

## 7. 边界

本能力不实现 `cd`、目录搜索、文件读写、自然语言识别、help 学习、多步规划或通用工具选择。它证明一个有界结构化动作选择与真实观测绑定闭环；有限 3-vector 数据不能证明未见语义泛化。后续全命令选择与多阶段增量训练统一由[文件系统训练合同](cli-filesystem-training.md)管理，本页仅作为历史单项验证基线。
