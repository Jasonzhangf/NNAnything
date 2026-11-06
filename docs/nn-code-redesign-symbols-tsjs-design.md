# NN Code redesign: TypeScript/JavaScript symbol table

状态：2026-11-06 设计修订 r2（REWORK 后），owner Carol，reviewer Alice。旧 `nn-code` 仅作 teacher、oracle、样本来源与对照材料，不恢复为产品。本页是设计子交付，不表示训练任务完成；训练、回载、独立留出评价与旧能力回归仍按 board 生命周期由 Jenny 调度。本页不改变既有权重、gold、threshold、采用状态、产品接线或旧 nn-code 产品。

## 1. 目标与边界

### 1.1 与现行已接受路线对齐

现行已接受的 TS/JS 切片见 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md` §3，不是重学一套关系词表：

- Goal：根请求身份与 requested declaration 保持不变；当前 pending relation 是其中一个明确关系义务。
- State：当前时点真实可见的局部绑定、声明、读取状态、当前关系关联、已完成动作回执和引擎义务。
- Action：学生从本步合法技能、参数与控制选项中选择一个；固定引擎与 adapter 执行并取得真实后验。
- MLP：对合法候选打分，学习当前关系判断和动作偏好；三个 judge 选项均保留。

本设计不新增 five-class 关系词表，不替换现行 judge 关系与动作选择。TS/JS 符号表子能力的作用是提供局部真实观测（符号、声明、import/re-export、作用域、动态边界），供该已接受 pipeline 使用。任何后续新关系词表必须单独立项并后置，不进入本轮训练准入。

### 1.2 确定性基础与学生能力的分工

| 层 | 职责 | owner | 不能冒称 |
| --- | --- | --- | --- |
| 确定性观测 | 单文件 TypeScript compiler AST 符号表、coverage、parse errors、动态成员边界 | `lib/adapters/cli/tsjs-symbol-table-adapter.ts` + `lib/filters/tsjs-symbol-table-policy.ts` | 不是学生能力；只是局部语法证据 |
| 确定性投影 | 把符号表投影为 language-agnostic relation facts；缺测/unsupported 显式保留 | `lib/adapters/tsjs-unified-adapter.ts` + `lib/adapters/unified-relation-facts.ts` | 不产出 teacher 链、最终声明或 callEdge 真值 |
| 学生能力 | 在已接受 StepContext/64 槽合同内判断当前关系并选择当前合法动作 | 本设计定义的 H_R/H_A 职责（见 §3） | 不得把确定性解析结果当学生学会 |

旧 `nn-code symbols` 入口（`lib/cli-symbols.ts`，schema `nnanything.cli-symbols.request.v1` / `result.v1`）只作 teacher、oracle、样本来源与对照材料。它的 `parser.semanticBinding=false` 语义必须保持：解析不等于语义绑定成功。

### 1.3 非目标

不做跨模块全量绑定求解；不把 `tsc`/language-service 的最终答案作为学生输入；不改 `docs/design.md` 1.1 四元素合同；不改 64 维输入、两层隐藏层、统一格式与固定推理引擎；不恢复旧 nn-code 产品；不启动本能力训练。

## 2. Goal / satisfactionThreshold / State / Action 四元素

沿用 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md` §3，不另造四元素：

| 元素 | 本能力定义 |
| --- | --- |
| Goal | 根请求身份及 requested declaration 保持不变；当前 pending relation 是其中一个明确关系义务 |
| satisfactionThreshold | 沿用已接受合同及缺测语义；不新增或修改阈值；本能力中实际 satisfaction 只输出 100/0/null |
| State | 当前时点真实可见的局部绑定、声明、读取状态、当前关系关联、已完成动作回执和引擎义务 |
| Action | 学生从本步合法技能、参数与控制选项中选择一个；固定引擎与 adapter 执行并取得真实后验 |

四元素闭合要求：Goal 的满足度只能由当前 State 的局部证据评价；缺测不补 false；`judge=unknown` 与“未观测”分开；`RETURN` 仍须独立根评价，根未满足时返回准确未满足/unknown。

## 3. 学生 I/O 与输出形状（对齐 64 槽合同）

学生输入沿用 `unified-step-context-builder` 构造的 `nnanything.unified-step.v1` StepContext，经 `unified-encoder` 编码为 x[64]；不新增头、不改结构。

关系判定不是新的输出形状：关系值 `true/false/unknown` 是有限候选集合 `J = {c:judge:true, c:judge:false, c:judge:unknown}` 中的三个候选，沿用已接受的 `pairs/K` 候选打分接口（每个 group 对 `S_g` 候选打分），不引入 `[pairs,K,3]` 第三轴或另一套关系词表。`judge` 是独立终端判定族，编码在 G4 槽 36-38 与 G7 槽 60-63；动作选择与关系判定共用同一候选组。

| 职责 | 本切片输入 | 输出 | 独立监督/分母 |
| --- | --- | --- | --- |
| H_R 关系判断 | 当前局部观测（声明、import/re-export、作用域、动态边界、missing mask） | `J` 上候选分数，保留 true/false/unknown 三选项 | 已确认关系逐例正确率与 unknown 召回 |
| H_A 当前选择 | 未决关系、合法技能与显式义务 | `judge=true`、`judge=false`、`judge=unknown`、`observe`（存在合法的正增益观察义务时）、`advance`（存在可读局部边时），以及控制 `DEFER`/`RETURN`（由当前是否存在合法补观察决定，二选一）候选分数；不列 NOOP/NO_CAPABILITY——它们不属于本轮已注册的 TS/JS 候选集合 | 允许选择命中率；越权/伪引用执行=0；无合法动作准确返回 |

H_D/H_E 沿用 `docs/l2-four-head-experiment.md` 已接受合同，仅按既有实现启用；本切片不新训练 D/E，也不以四头一并训练替代现行 judge 关系 + 动作选择路线。固定训练 recipe 是单一共享候选打分器（见 §8），不是分别训练四个头。

学生输入只来自 source-level episode：entryFile、requestedDeclaration、observedBindings、observedDeclarations、currentRelation、remainingObligations、previousExecution、localCandidateCursor。禁止把 gold 关系、`A_g`、teacher 最终绑定、未来回执或 `goal_met` 编入学生特征。

## 4. SESE 数据路径与唯一 owner

沿用 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md` §4 的线性 SESE 资料流，本能力只替换局部观测来源，不新增拓扑：

```text
隔离输入包
  → 来源、分区与显式准入核对
  → 双路径映射
      学生：当前局部观测 → 当前关系/动作/义务 → 独立合法候选 → StepContext → x[64]
      监督：独立逐步监督 → A_g 与准入依据
  → 复合键 join 与候选/监督核对
  → 公开 convert-samples
  → 公开 validate-data
  → 单一验收报告
```

单入口单出口；跨步迭代以实际 New State 开启新 run，图内不加回边。owner 划分沿用该合同 §4；本能力补充：局部读取与符号事实由既有 TS/JS 生成器学生侧采集逻辑及 adapter 持有，符号表子能力不得反向读取 gold 或监督。

| 路径段 | 唯一 owner |
| --- | --- |
| 当前模块符号观测 | `tsjs-symbol-table-adapter` + 既有学生侧采集逻辑 |
| 学生字段加载 | `unified-student-converter.ts` |
| 合法候选与 StepContext | `unified-step-context-builder.ts` |
| 固定编码 | `unified-encoder.ts` |
| 独立监督与准入 | 既有独立监督输入和 supervision converter |
| 转换与数据门 | 公开 `convert-samples` / `validate-data` |
| 字段与回执审计 | Alice |
| 独立验收 | Frank 或 Jenny 指定的替代验证者 |
| 派发、集成和收口 | Jenny |

## 5. 最小字段增量

复用现有 `Observed<T>`、`BindingProjection`、`DeclarationIdentity`、`BindingEdge` 和 Action；本设计不新增 wire、不改 x[64] 编码。符号表子能力向已接受 StepContext 提供：

- `observedBindings`：import、re-export、local、shadow 的局部语法边；
- `observedDeclarations`：当前模块可观察声明及缺测；
- `currentRelation.binding`：请求声明与当前局部候选的 typed 关联；
- `callSiteRef`/`calleeName`：当前 call site 的局部字符串观测，不声称最终绑定；
- 动态边界、missing、unsupported、partial coverage 作为显式状态。

现有 `tsjs-unified-adapter` 投影主要用于语言无关一致性检查，不作为本切片学生输入的唯一来源；本切片学生输入以已接受逐步 episode 合同为准。若后续要让该 adapter 直接承担 ESM import/export 事实，需另立投影增量，不在本轮改 wire。

## 6. 语料、转换输入与来源分区

复用既有 Carol 固定语料与 Iris converter 审计，不重新生成、不覆盖、不改其状态：

- 固定字段映射：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/.worker-runs/carol-tsjs-r2-stepwise-corpus-20261106/output/field-mapping.md`
- 学生观测：同目录 `student-observations.jsonl`
- 独立监督：同目录 `independent-supervision.jsonl`
- converter 审计：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md`、`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-iris-four-mappings-audit-20261106.md`

| 来源家族 | 内容 | 用途 |
| --- | --- | --- |
| `closure_call_site` | 当前局部真实观测上的 call-site judge 关系 | 关系判定与动作选择主分母 |
| `import_alias` | import/re-export/alias 的局部语法证据 | 关系与 advance 分母 |
| `shadow` | 同名遮蔽/局部遮蔽 | 证伪分母 |
| `dynamic-property` | computed member、动态 require/export | 保持原 expected unknown、corrected true、`pending_sample_adjudication`；`trainingEligible=false` |
| `missing-module` | 模块不可用、TS2307 | execution/coverage 缺口；保留 expected unknown，不改成 false |

TRAIN/DEV/VERIFICATION 按关联来源与构造机制沿用既有分区；同模板改名称只验名称不变性；已暴露 DEV 转已知回归。独立构造者只收共同任务合同，不收 dev 错误提示。teacher 只出现在监督旁路，不进入学生输入或拟合。

## 7. 未知、缺测、执行失败与动态语法

按 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md` §11 与 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-tsjs-fixed-training-launch-r1.md` §2.4 分开三类事实：

| 事实 | 处理 |
| --- | --- |
| 语义 unknown | 有效 unknown gold 照常进入组 loss 与独立 unknown 召回分母 |
| 缺测 | 缺少必要字段或观测资格；保留 gap，不补 false/零增益，不当作语义 unknown |
| 执行/覆盖失败 | 保留原错、TS2307、receipt；不伪造读取成功，不把不可用模块当已完成覆盖 |

动态语法不能一律判 `judge=unknown`：已知可局部折叠的 computed member 仍有真值冲突，保留原始 expected unknown、corrected true 与 `pending_sample_adjudication`，`trainingEligible=false`，不进入本轮 loss；局部证据足以判定时按候选判定，证据不足时语义 unknown，读取失败时执行/覆盖失败。不得把三类状态合并。

## 8. 训练 loss、固定 recipe 与停止条件（唯一来源引用）

本节复用已接受合同，不另设第二套训练配方：

- 唯一优化目标：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-tsjs-fixed-training-launch-r1.md` §2.1；代码 `lib/training/group-loss.ts`。`L_group(g) = logZ_all(g) - logZ_allowed(g)`；epoch loss = 各 group loss 的平均；有效 unknown gold 照常进入组 loss，`label_missing=true` 的监督行在准入排除并保留证据。
- 固定 recipe：同文件 §2.2。`architecture = 64 -> 64 -> 64 -> 1 (ReLU)`；`optimizer = full_batch_sgd (momentum=0)`；`learningRate = 0.01`；`maxEpochs = 200`（仅上限）；`batch = full`；`init = Xavier-uniform, fixed seed`；`stop = 仅 maxEpochs 耗尽即停，不做 DEV 早停`。
- 数值失败出口：同文件 §2.3。`non_finite` 立即失败且不生成候选；`epoch_limit_exhausted` 只表示固定长度诊断完成；`data_invalid` 时优化步数写 0；逐 epoch loss、finite、maxAbsGrad、末段变化与单调性违规分别记录。
- 停止与语义验收分离：同文件 §2.4。loss 只说明优化对象在变，完成必须独立通过语义硬门；不得因 loss 上升静默加轮、换 seed、换学习率或换优化器。

真实 trainer/evaluator/config 已存在并已有真实拟合、保存、回载原始回执：`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/.worker-runs/jenny-tsjs-first-fit-engineering-r1/real-train-train-only/output/run-report.json`（200 epoch 预训练 `status=completed`，`Package Reload tensorsMatch=true`，typecheck 0）。原候选因输入不可辨未达语义目标，不能据此称 trainer 不存在。在 Alice 通过本设计并由 Jenny 调度、共享 fixed training launch 验收前，不得启动新的 fit；当前唯一前置是语料经修订 converter 的独立准入验收。真实引擎/独立评价的剩余缺口分别列明，不把历史文案当作新增全面训练阻塞。

## 9. 评价：诊断指标、最终验收与独立 oracle

### 9.1 诊断指标（不替代最终验收）

`docs/l2-four-head-experiment.md` §130-134 的逐头 F1>=0.95、根目标 11/12 等是诊断指标，用于观察模型行为，不替代最终语义硬门。诊断结果必须与最终验收分列，不得用 0.95 诊断替换或放宽 board 的 100% 要求。

### 9.2 最终语义硬门（通过条件，继承 board）

按 `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/emma-tsjs-fixed-training-launch-r1.md` §2.4 与 board test condition：

1. 已知关系逐例 100% 正确，错误数 = 0；
2. 未知结果 100% 报最终 `judge=unknown`，无漏报、无误判；defer/observe 只允许作为中间动作，结束时必须返回显式 `judge=unknown` 并列出未决证据；
3. 候选枚举与覆盖完整，`truncatedCount=0`、`failedCount=0`；
4. `label_missing` 不计入正确率分母但保留证据；有效 unknown gold 单列分母须 100% 召回；
5. 运行失败、缺测与执行错误不得吞掉；任一项不满足即 `incomplete`。

### 9.3 独立 oracle 断言集（现在定义，不留给执行者）

沿用 `lib/training/relation-oracle-evaluator.ts`：四分母分离、`label_missing` 排除、unknown 召回、根评价独立；不调用学生 forward。独立监督沿用既有 `independent-supervision.jsonl` 字段：`labelAuthority = researcher_structural_proof+typescript_language_service`，`oracleKind = independent_tsc+typescript_compiler_api`，gold label ∈ {true,false,unknown} 并带 `unknownReason`。逐语义分层断言：

| 分层 | oracle 断言 |
| --- | --- |
| `closure_call_site` | 逐例 true/false/unknown 与独立 tsc/structural proof 一致；unknown 不得被 true/false 代替 |
| `import_alias` | 当前局部 edge 与已观察 alias 一致；未读模块的最终绑定不得当已知 |
| `shadow` | 同名声明不合并；遮蔽事实与独立作用域检查一致 |
| `dynamic-property` | 保留原 expected unknown、corrected true、`pending_sample_adjudication`；不得进入本轮 loss |
| `missing-module` | 保留 expected unknown、TS2307、execution/coverage gap；不得改成 false 或伪造成成功 |

所有已确认 gold 的合格输入都进入相应头评价；已知 true/false gold 上的 `judge=unknown` 计弃权/漏检，有效 unknown gold 被 `judge=unknown` 命中应计正确并计入 unknown 召回；中间合法 DEFER 按逐步 `A_g` 评估，终态或停止才按最终语义判定，不能把正确中间动作统一计错；unassessed 逐例列出原因与数量，不得通过排除缩小任务全集。

## 10. 交付与证据路径

| 交付 | 路径 |
| --- | --- |
| 设计合同（本页） | `docs/nn-code-redesign-symbols-tsjs-design.md` |
| 既有学生/监督语料 | `.../carol-tsjs-r2-stepwise-corpus-20261106/output/student-observations.jsonl`、`independent-supervision.jsonl`、`field-mapping.md` |
| 既有 converter 审计 | `/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-converter-mapping-design-r2-20261106.md`、`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/alice-iris-four-mappings-audit-20261106.md` |
| 训练/回载/独立评价 | Alice 通过设计后由 Jenny 调度；本设计交付不包含这些执行 |

## 11. 缺口与生命周期（INCOMPLETE）

1. 本设计只补设计子交付；训练、回载、独立留出评价、旧能力回归与整项 close 仍按 board 生命周期由 Jenny 调度。设计交回不等于训练任务完成。
2. 真实 trainer/evaluator/config 已存在并有真实拟合/保存/回载原始回执（`/Volumes/Intel/playground/nnanything-runs/cd1-live-comparison-20261031/.worker-runs/jenny-tsjs-first-fit-engineering-r1/real-train-train-only/output/run-report.json`）；§4.3 的历史“尚未实现”文案已被该回执取代。当前前置是语料经修订 converter 的独立准入验收，不在未通过准入前启动 fit 或以占位命令冒充训练。
3. `dynamic-property` 与 `missing-module` 仍为未就绪样本，按既有合同保留原 expected unknown、冲突与 coverage gap；本设计不重新生成、不覆盖、不把它们改善成可训练组。
4. 既有 Carol 固定语料与 Iris converter 工程审计各自继续按原有效范围核销；本设计只复用，不重记为新待生成，也不宣布其已训练完成。
5. 若后续让 `tsjs-unified-adapter` 直接承担 ESM import/export 事实，需另立投影增量；本轮学生输入以既有逐步 episode 合同为准。
