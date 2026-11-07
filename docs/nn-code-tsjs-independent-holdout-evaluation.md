# NN Code TS/JS independent holdout evaluation

状态：2026-11-06 准备合同与样本清单。基线 `eba211e`。本页只定义独立或留出语义评价集、
oracle 断言、四分母和 unknown 召回边界。没有运行 fit，没有修改 gold、阈值、权重、
采用状态或产品接线。

## 1. 评价边界

独立评价必须调用不含学生 forward 的 evaluator，并以独立来源产生的 student run 为输入。
学生输入只能来自当前 episode 的局部 StepContext，经固定 encoder 形成 `x[64]`。

学生输入禁止包含：

- gold；
- `A_g`；
- teacher final binding；
- future receipt；
- `goal_met`；
- teacher chain 或 teacher 监督字段。

当前 `unified-data-gate.ts` 会拒绝学生行中的 teacher chain。Carol converter regression
也要求删除 gold 后学生 `S_g` 与每个 `x[64]` 保持 byte-identical。独立监督只能沿监督
旁路进入评价。

## 2. 样本来源分区

| 来源 | 分区 | 当前用途 |
| --- | --- | --- |
| Carol R2 stepwise corpus | TRAIN | 固定训练与学生观测来源，不是独立 holdout |
| `tsjs-dev-closure-shadow-b` | DEV | 已暴露的开发回归，不进入拟合，不冒充独立评价 |
| `tsjs-verification-reexport-closure-c` | VERIFICATION | derived diagnostic regression，不是独立 holdout |
| `tsjs-verification-independent-callgraph-d` | VERIFICATION | 当前独立 holdout 语义评价集 |

`training/samples/neural-cli/tsjs/corpus-admissions-v1.json` 当前只把
`tsjs-verification-independent-callgraph-d` 标为
`usableForIndependentVerification=true`。其他三个家族都不是独立 holdout。

## 3. 独立 holdout 样本清单

目录：

```text
training/samples/neural-cli/tsjs/verification-independent-callgraph-d
```

| sampleId | oracle gold | unknownReason | 断言重点 |
| --- | --- | --- | --- |
| `d2-verification-positive-alias` | `true` | null | import alias 与 requested declaration 一致 |
| `d2-verification-positive-pipeline` | `true` | null | 闭包内调用链与目标声明一致 |
| `d2-verification-negative-shadow` | `false` | null | 同名 local shadow 不得合并到 import |
| `d2-verification-unknown-dynamic` | `unknown` | `runtime_dynamic_selector` | runtime selector 必须保留最终 unknown |

监督文件的 `labelAuthority` 为
`researcher_structural_proof+typescript_compiler_api`，`oracleKind` 为
`independent_tsc+typescript_compiler_api`，`labelMissing=false`。每条 gold 同时保留
manual structural proof、tsc receipt 和 oracle receipt 的 evidence refs。

## 4. oracle 断言

`lib/training/relation-oracle-evaluator.ts` 是当前独立 evaluator。它不调用学生 forward，
不把模型分数反推为 gold。逐例断言如下：

1. 已知 `true/false` gold 必须得到相同终态 `judge`。`judge=unknown` 是弃权或漏检，
   终态 true/false 误判是 incorrect。
2. 有效 `unknown` gold 必须得到最终 `judge=unknown`，并列出未决证据。把 unknown
   猜成 true/false 是 incorrect；missing student run 是 unknown，不是 false。
3. `labelMissing=true` 不计入正确率分母，但保留 evidence 和 excluded count。
4. 合法中间 `DEFER` 或 `observe` 按逐步允许动作评价。只有终态或停止时才按最终语义
   判定。不能把正确中间动作统一判错。
5. root evaluation 独立于 per-step evaluation。`rootSatisfied=true` 不得与 unsatisfied
   或 unknown condition、non-empty root gaps 同时出现。`rootSatisfied=false` 必须暴露
   root gap。
6. student run 缺失时保留 missing run，不补 false、不补 zero、不静默跳过。

## 5. 四分母

评价报告必须至少保留以下四个彼此分离的分母。

### 5.1 gold denominator

```text
total
true
false
unknown
labelMissingExcluded
```

`labelMissingExcluded` 只记录排除数量，不加入 correctness denominator。有效 unknown
必须单列并进入 unknown recall 分母。

### 5.2 student prediction denominator

```text
total
true
false
unknown
missing
```

student prediction 的 unknown 不能和 gold 的 unknown 混成一个计数。missing 也不能补到
false 或 true。

### 5.3 per-step evaluation

```text
correct
unknown
incorrect
entries[]
```

每个 entry 保留 `sampleId`、`stepId`、predicted、gold 和 outcome。已知 gold 上的
unexpected unknown 和 incorrect 都要形成 violation。

### 5.4 independent root evaluation

```text
evaluated
satisfied
unsatisfied
unknown
entries[]
```

root 只接受独立 root evidence 或既有 fixed engine 的真实回执。per-step 全对不能自动
推出 root satisfied。

## 6. unknown recall

有效 unknown gold 的单列召回为：

```text
unknownRecall = predictionUnknown / goldUnknown
```

语义硬门要求有效 unknown gold 的最终 `judge=unknown` 召回为 100%，漏报、误报和未返回
终态都不是成功。`labelMissing` 不扩大这个分母。缺测、覆盖失败和执行失败也不改写成
语义 unknown。

### 6.1 当前实现差距

当前 `relation-oracle-evaluator.ts` 的数值字段仍使用
`studentPrediction.unknown / gold.unknown`。`studentPrediction.unknown` 包含所有样本的
unknown prediction，没有先限定 `gold=unknown` 的子集。因此已知 true/false gold 返回
unknown 时，虽然会产生 violation 并使 `overall=incomplete`，数值 `unknownRecall` 仍可能
被抬高，甚至超过 1。

独立评价报告不得把该字段单独当作有效 unknown 召回回执。至少同时保留 gold-unknown
子集内的 correct unknown 数、miss 数、wrong true/false 数和 final unknown 数。当前
evaluator 没有这个单独 numerator；这是评价实现缺口，不是通过修改 gold 或跳过样本解决。
已补最小红测
`tests/relation-oracle-evaluator.test.mjs` 的
`RED: known-gold unknown must not count toward valid unknown recall`。该测试把
known-true 误报为 unknown，同时保留一个正确的 valid unknown。期望有效 unknown 召回
为 1，当前实际为 2，exit 1。这个失败证据固定了缺口。

当前边界：

- `missing-module` 保留 expected unknown、TS2307 和 execution/coverage gap，不改成
  false。
- `dynamic-property` 保留原始 expected unknown、corrected true 和
  `pending_sample_adjudication`，`trainingEligible=false`。
- Carol R2 语料当前没有 admitted training-ready semantic-unknown row。该缺口必须保留，
  不通过改 gold 或把 gap 补成 unknown 来制造分母。

## 7. 评价准备步骤

未来真实评价按以下顺序执行，不在本准备任务中执行：

1. 从 admitted independent family 读取每个 sample 的独立 gold 与 evidence。
2. 固定推理引擎读取尚未采用的 candidate package。
3. 学生只消费 local StepContext，不读取 gold、A_g、teacher final binding、future
   receipt 或 goal_met。
4. 保存每个 sample 的逐步 trajectory、terminal judge 和 root evidence。
5. 调用 `evaluateRelationOracle`，分别保存四分母、unknown recall、violations 和
   unassessed rows。
6. 评价结果与 loss report 分列，不互相替代。

## 8. 当前准备回执

已执行的只读或合成评价检查：

```sh
node --test tests/relation-oracle-evaluator.test.mjs
node --test --test-name-pattern='convert-samples writes|deleting gold' \
  tests/unified-runner-convert-train.test.mjs
node --test tests/carol-tsjs-r2-stepwise-corpus.test.mjs
```

回执为 exit 0。oracle 测试覆盖 pass、known miss、unknown misreport、label missing、
model evidence rejection、root conflict 和 missing run。converter 测试覆盖删除 gold
后学生路径不变。Carol corpus 测试覆盖 future alias leakage、监督变化不影响学生输出，
以及 dynamic/missing-module 的未就绪状态。另有一个 intentional red test exit 1，
failure 为 `2 !== 1`。其余七个 oracle tests exit 0。上述结果不等于 unknown 子集
numerator 已修正，也不等于真实 holdout 已执行。

未执行：

- 没有运行 `evaluate` command。
- 没有调用学生 forward。
- 没有运行 fit、train 或 resume。
- 没有生成独立 holdout 的 candidate package。

因此本页状态为准备完成、真实独立评价未执行。`fullyVerified=false`，candidate 保持
`uncalibrated/not_applied`。
