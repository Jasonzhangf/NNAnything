# NN Code TS/JS training entry and reload contract

状态：2026-11-06 准备合同与现状核对。基线 `eba211e`，分支
`nn-code-redesign-symbols-tsjs-training-20261107`。本页只定义公开入口、TRAIN 准入、
模型包与回载边界，并记录当前实现差距。没有启动 fit、train、resume，没有修改权重、
gold、threshold、采用状态、产品接线或安装。

2026-11-10 更新：按 Alice 已接受的 TS/JS post-training warm-start 合同，增加
`warmstart` 入口、独立 post-training lineage、`corpus.slotMapPath` 和
warmstart→resume 切换边界。此更新仍只使用合成 fixture，不训练真实样本，不改权重、
gold、threshold、采用状态或安装。

## 1. 适用合同与固定边界

本页继承以下既有来源，不新建第二套训练配方：

- `docs/nn-code-redesign-symbols-tsjs-design.md`
- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md`
- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-tsjs-symbols-design-audit-20261106.md`
- `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-tsjs-fixed-training-launch-r1.md` §2.1–§2.4

固定架构仍为 `64 -> 64 -> 64 -> 1 (ReLU)`。固定优化目标仍为 group loss，固定
optimizer 为 `full_batch_sgd (momentum=0)`，learning rate 为 `0.01`，max epochs
为 `200`，init 为固定 seed 的 Xavier-uniform。DEV 不进入拟合，VERIFICATION
不得经数据门冒充 TRAIN，不启用 DEV 早停。

## 2. 公开入口

统一 runner 的公开命令为：

```sh
node dist/training/l2-standard-runner.js convert-samples --config <runner-config.json>
node dist/training/l2-standard-runner.js validate-data --config <runner-config.json>
node dist/training/l2-standard-runner.js train --config <runner-config.json>
node dist/training/l2-standard-runner.js warmstart --config <runner-config.json>
node dist/training/l2-standard-runner.js resume --config <runner-config.json>
node dist/training/l2-standard-runner.js evaluate --config <runner-config.json>
```

当前命令状态：

| command | 当前行为 | 训练边界 |
| --- | --- | --- |
| `convert-samples` | 可用 | 写学生行和监督行两个物理路径 |
| `validate-data` | 可用 | 64 槽 typed 行、TRAIN 分区、threshold 和泄漏检查 |
| `train` | 可用 | 只接收 TRAIN；当前会把 tensor package 保存到配置的 package path |
| `warmstart` | 可用 | 仅接收统一 runner config；从已验收推理包初始化新 post-training stage |
| `resume` | 可用 | 从独立 training checkpoint 恢复同一 recipe 的 epoch/tensor 状态 |
| `evaluate` | `NOT_READY`，exit 2 | 独立 holdout 评价尚未接入该命令 |

`warmstart` 只接受 `nnanything.unified.runner-config.v1`。非统一
`StandardRunnerConfig` 以该命令传入时显式拒绝，不进入旧 runner 训练路径。普通
`train` 和 `resume` 不接受 `warmStart` 配置块。

语料直转换入口为：

```sh
node scripts/convert-neural-cli-tsjs.mjs --dry-run
```

该脚本的学生输出为 `<family>/student-rows/student-rows.jsonl`，监督输出为
`<family>/labels/supervision.jsonl`。必须保持两条路径的字段隔离。真实执行前使用
隔离 corpus 副本或已批准的转换输出版本，不能覆盖冻结的 Carol 语料。

模型包公开 API 位于 `lib/training/unified-model-package.ts`：

- `saveUnifiedModelPackageAtomic`
- `loadUnifiedModelPackageFromFile`
- `validateUnifiedModelPackage`

训练保存与回载复核 API 位于 `lib/training/unified-train-config.ts`：

- `saveUnifiedTrainPackage`
- `verifyUnifiedTrainPackageReload`

runner 的新进程 reload 路径会启动独立 Node 子进程，重新执行
`loadUnifiedModelPackageFromFile`，再比较保存前与回载后的 tensors。

本任务另外用无 fit 的 Xavier tensor package 做了一次独立子进程回载。父进程 atomic
save 后，子进程重新加载 package，回执为 `tensorsMatch=true`、exit 0。该回执只证明
inference tensor 回载，不证明 resume。

## 3. typed config 与 TRAIN-only 准入

`UnifiedTrainConfig` 只接收一个固定 recipe 和一个显式 TRAIN 数据集。拟合前依次满足：

1. `validateUnifiedTrainConfig` 核对 schema、optimizer、learning rate、epoch 上限、
   seed、initializer 和固定架构。
2. `loadStudentRowsFile` 和 `loadSupervisionRowsFile` 只接受显式 partition。
3. `buildEncodedGroups` 按 `group_id` join 学生候选组与监督行。
4. 学生或监督任一 partition 不是 `TRAIN` 时抛出 `UnifiedTrainDataError`。
5. `labelMissing=true` 的行不进入拟合组，但保留监督证据和排除计数。
6. 空 `A_g`、`A_g` 不属于 `S_g`、学生行带 gold/teacher 字段时显式拒绝；不能生成
   candidate。

统一 runner config 保持 `nnanything.unified.runner-config.v1`，并增加一个可选根块：

```json
{
  "command": "warmstart",
  "phase": "posttraining",
  "corpus": {
    "slotMapPath": "/absolute/path/to/slot-map.json"
  },
  "warmStart": {
    "sourcePackagePath": "/absolute/path/to/accepted-package.json"
  }
}
```

`warmStart` 只在 `command=warmstart` 且 `phase=posttraining` 时合法。
`warmstart` 不接受 `ceilingAmendment`。`corpus.slotMapPath` 可选；存在时写入目标
package 的 `resources.slotMapRef`，缺失时源和目标都必须没有 slot map。源包、目标
package 和目标 checkpoint 的解析路径必须两两不同。

当前 `train` 和 `resume` 还显式拒绝配置中的 `evalSources`。DEV 和 VERIFICATION
不能借评估路径进入拟合。这个边界是后续独立 holdout 的前提。

## 4. 模型包 schema 与 tensor 边界

当前 inference package schema 为：

```text
nnanything.unified.model-package.v1
```

当前序列化字段：

```text
schema
modelId
version
route { domain, decisionKind }
inputSchema
encoderVersion
architecture { input: 64, hidden: [64, 64], output: 1, activation: "relu" }
tensors { W1, b1, W2, b2, W3, b3 }
outputContract { kind: "scalar-score", groupNormalization: "outside-model" }
resources { thresholdsRef, thresholdsSchema, missingModeTableRef, missingModeSchema }
fixedStages
```

Tensor shape 固定为：

```text
W1 = 4096
b1 = 64
W2 = 4096
b2 = 64
W3 = 64
b3 = 1
```

`validateUnifiedModelPackage` 拒绝错误 schema、错误 input/encoder schema、非 ReLU
architecture、错误 hidden shape 和错误 tensor length。`loadUnifiedModelPackageFromFile`
默认核对 threshold 与 missing-mode resource 是否存在。`verifyUnifiedTrainPackageReload`
只有在 tensor 全部一致时才返回 `tensorsMatch=true`。

## 5. RNG、optimizer 与 resume 状态边界

当前边界必须分开表述：

### 5.1 inference model package

`nnanything.unified.model-package.v1` 的职责是保存可推理 tensor、固定 architecture
和资源引用。它当前不保存 optimizer state、RNG state、completed epochs、累计 timing 或
early-stop state。这个选择不影响纯 tensor 保存和新进程回载。

### 5.2 training checkpoint

恢复训练所需的 optimizer recipe、学习率、seed、累计 completed epochs、epoch 历史和
early-stop state 属于独立的 `nnanything.unified.training-checkpoint.v1`。它们不能从
模型包 tensor 中推导，也不能用同一份 `tensorsMatch=true` 回执代替。

当前实现边界：

- checkpoint 只保存 committed epoch boundary 的 tensors、固定 recipe、typed 编码版本
  （`inputSchema`/`encoderVersion`）、已训练资源引用（thresholds/missing-mode）、
  epoch records、prior violations、`devEarlyStopEnabled=false` 和显式
  `cumulativeTimingSeconds=null`；
- `resume` 必须使用与 checkpoint 相同的 model/version/route/recipe/`inputSchema`/
  `encoderVersion`/资源引用，任一 mismatch 显式 `CHECKPOINT_INVALID`，不重新初始化
  或 fallback；换训练数据、new encoder 或新资源引用不能隐式当作同一次 resume；
- bounded `epochsThisRun` 会返回 `status=paused`，只写 checkpoint，不写 candidate
  package；完成 maxEpochs 后 `resume` 写 package 并做新进程 reload；
- checkpoint 保存采用 atomic rename，保存后在新 Node 进程 reload 并核对 tensors、
  completed epochs 和 epoch record count；
- 本 fitter 的 RNG 只影响初始 Xavier 参数。checkpoint 已保存实际参数 tensors，
  因此不保存 RNG state，也不从 seed 重推参数。

`warmstart` 创建的 post-training checkpoint 在同一 v1 schema 上增加可选
`warmStart` lineage：

```json
{
  "schema": "nnanything.unified.training-checkpoint.v1",
  "warmStart": {
    "kind": "package-warm-start",
    "sourceModelId": "accepted-model-id",
    "sourceVersion": "accepted-version",
    "sourcePackagePath": "/absolute/path/to/accepted-package.json",
    "sourceRoute": { "domain": "tsjs", "decisionKind": "R" },
    "sourceEncoderVersion": "nnanything.unified-step.encoder.v2",
    "epochZero": {
      "exact": true,
      "tensorEquality": true,
      "checkedInputs": 4,
      "maxAbsDelta": 0
    }
  }
}
```

该 lineage 是普通 post-training checkpoint 的附加字段。`completedEpochs`、
`epochRecords`、`violations` 和 timing 只覆盖 post-training stage。后续
`command=resume` 不读取源包，也不重新验证源路径；它从 checkpoint 继承 lineage。
resume 配置必须移除 `warmStart`，并保持目标 route、encoder、recipe、身份、资源和
checkpoint path 不变。

该实现不宣称 `evaluate` 或独立 holdout 已经接入；它们仍由独立评价合同维护。

### 5.3 当前判定

| 检查项 | 当前结果 |
| --- | --- |
| model package schema 与固定 tensor shape | PASS |
| atomic save 与 new-process tensor reload | PASS（无 fit 的合成 tensor 回执） |
| threshold 与 missing-mode 资源引用解析 | PASS |
| checkpoint 保存 typed 编码版本与资源语义引用 | PASS，`inputSchema`/`encoderVersion`/`resources` 均入 checkpoint，resume 逐项比对 |
| TRAIN-only 拟合与 DEV/VERIFICATION 拒绝 | PASS |
| committed epoch 参数状态持久化 | PASS，独立 checkpoint schema |
| completed epoch 与 epoch 历史持久化 | PASS，checkpoint 新进程核对 |
| early-stop state 持久化 | PASS，固定 `devEarlyStopEnabled=false` |
| resume 从 checkpoint 恢复并继续固定预算 | PASS，bounded + resume 测试已验收 |
| cumulative timing 持久化 | EXPLICIT_NULL，当前 fitter 不测量 timing |

这里不追加以 tensor hash 或 frozen snapshot 代替 checkpoint 状态。必要的恢复状态必须是
typed、可核对的训练状态。

### 5.4 计时与 evaluate 的剩余责任

本 milestone 只完成 checkpoint 与 typed 恢复边界，不宣称“完整首训入口已就绪”。

- `cumulativeTimingSeconds` 被类型与校验硬限定为 `null`：统一 fitter 当前不测量每轮或
  每头耗时，也不累计续训时长。研究 owner 需在既有合同中确定每次/每头实际耗时、续训
  累计方式与墙钟字段，工程接入后才允许以时间作为 fit 准入条件。不得伪造 0，也不以
  轮次数代替 loss 目标。
- `evaluate` 仍为 `NOT_READY`：独立 holdout 语义评价与旧能力回归未接入运行入口。
- 上述两部分的 owner 是研究设计 owner（Carol），准入依赖是 Alice 接受独立评价与计时
  合同；完成并接入后再启动真实 fit。

### 5.5 warm-start 计时与 epoch-zero

`warmstart` 只初始化一个新 post-training stage。第一次调用开始时：

- `completedEpochs=0`，`epochRecords=[]`，`violations=[]`；
- 新 stage 的 cumulative optimizer steps、processed rows 和 timing 从 0 开始；
- 源包不属于新 stage 的 optimizer 状态，`sourceTiming=null`，
  `sourceTimingReason="package_carries_no_training_timing"`；
- 源包读取时间计入本 stage 的 `loadSeconds`，并在
  `warmStart.sourcePackageLoadSeconds` 单独报告。

数据门通过并完成编码后，优化器启动前必须对所有 TRAIN candidate input 执行
epoch-zero 检查：源 tensors 与克隆后的 post-training tensors 六个张量逐项相等，且
每个输入的 forward score `===` 源包结果。失败为
`WARMSTART_EPOCH0_MISMATCH`，报告 `optimizerSteps=0`，不写 checkpoint 或 package。

warm-start report 的继承状态必须区分“已加载但尚未验证”与“已完成 epoch-zero”：

- 直接从源包启动时，`inheritanceSource="source_package"`、
  `sourcePackageLoadedThisRun=true`，`sourcePackageLoadSeconds` 为本次实际读取时间；
  epoch-zero 验证完成前 `epochZero=null`，完成并返回 receipt 后才写入 exact receipt；
- 源包加载成功后，数据门、编码或 epoch-zero 失败仍保留已验证的 source model/version/
  path 和实际 load timing，报告 `epochZero=null`；不得把未执行检查写成 `exact=true`；
- 源包加载失败没有已验证的 source metadata，但 `error.cause` 保留原始 loader cause；
- 从 warm-start checkpoint resume 时，报告
  `inheritanceSource="checkpoint"`、`sourcePackageLoadedThisRun=false`、
  `sourcePackageLoadSeconds=null`，并继承 checkpoint 已记录的 epoch-zero receipt；
  该报告不声称本次重新读取或初始化源包。

合成 failpoint 还覆盖 package 输出失败：优化已提交一个 finite step 后，如果目标 package
路径不可写，报告为 `PACKAGE_SAVE_ERROR`，保留非零 `optimizerSteps`、checkpoint、partial
timing 和已保存 checkpoint 的回载回执，不产生有效 package。

warm-start 兼容检查比较 source/target 的 route、inputSchema、encoderVersion、
64→64→64→1 ReLU architecture、tensor shape 和实际解析后的 thresholds、missing-mode、
slotMap 资源路径。资源引用字符串不同但解析到同一文件是合法；解析到不同文件则
显式失败。源和目标 modelId/version 相同不作为兼容性门槛，也不作为阶段分离证明。

## 6. 最小验证命令

以下命令只做准备与现状核对，不运行 fit、train 或 resume：

```sh
npm run build

node --test tests/unified-model-package.test.mjs
node --test tests/unified-runner-route.test.mjs
node --test tests/unified-warmstart-contract.test.mjs
node --test tests/unified-data-gate.test.mjs
node --test tests/relation-oracle-evaluator.test.mjs
node --test tests/unified-runner-convert-train.test.mjs
node --test --test-name-pattern='convert-samples writes|same episode|deleting gold|A_g outside|convert-samples rejects' tests/unified-runner-convert-train.test.mjs
node --test --test-name-pattern='joins student|empty A_g|A_g outside|non-TRAIN|missing supervision|loadStudentRowsFile' tests/unified-train-config.test.mjs

node scripts/convert-neural-cli-tsjs.mjs --dry-run
node dist/training/l2-standard-runner.js validate-data --config tests/fixtures/unified-64-slot/runner-config.json
```

本准备合同的有效回执记录：

- `npm run build` exit 0。
- 模型包、runner route、数据门和 oracle evaluator 的既有测试 exit 0；新增
  `unknownRecall` 最小红测按预期 exit 1。
- `convert-samples`、TRAIN-only 准入和 tensor-only reload 的选定测试全部 exit 0。
- 无 fit 的 Xavier package 子进程回载 exit 0，`tensorsMatch=true`。
- `convert-neural-cli-tsjs.mjs --dry-run` exit 0，输出 2 个 admitted TRAIN family。
- `validate-data` fixture exit 0。
- 没有执行 `train`、`resume` 或任何真实 fit。

在本入口与回载合同范围内，独立 checkpoint contract 与 typed resume 兼容检查已实现。
仍未通过的是 `evaluate` 与累计计时：前者保持 `NOT_READY`，后者保持
`cumulativeTimingSeconds=null`。这两项不阻断准备工程与合成 tensor 回执，但阻断真实
fit 的完整首训入口验收。
