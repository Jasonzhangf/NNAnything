# NN Code redesign: TypeScript/JavaScript symbol table

状态：2026-11-06 设计交付，owner Carol，reviewer Alice。旧 `nn-code` 仅作 teacher、oracle、样本来源和对照材料，不恢复为产品。本页维护本能力的重新设计合同；训练、回载与独立评价合同见 §8-§10，实际 fit 在共享 fixed training launch 经 Alice 审计后才进入。本页不改变既有权重、gold、threshold、采用状态、产品接线或旧 nn-code 产品。

## 1. 目标与边界

### 1.1 本能力学什么

学生学的是**局部符号关系**：给定入口文件、显式请求的声明与当前一步已取得的局部语法观测，判断请求声明与当前模块内可观察声明之间是否存在可证关系（`in_scope`、`content_of`、`associated_with`、`current_for`、`covers`）。学生不学跨模块最终绑定、不学调用边真值、不学任意代码理解。

### 1.2 确定性基础与学生能力的分工

| 层 | 职责 | owner | 不能冒称 |
| --- | --- | --- | --- |
| 确定性观测 | 单文件 TypeScript compiler AST 符号表、coverage、parse errors、动态成员边界 | `lib/adapters/cli/tsjs-symbol-table-adapter.ts` + `lib/filters/tsjs-symbol-table-policy.ts` | 不是学生能力；只是局部语法证据 |
| 确定性投影 | 把符号表投影为 language-agnostic relation facts；缺测/unsupported 显式保留 | `lib/adapters/tsjs-unified-adapter.ts` + `lib/adapters/unified-relation-facts.ts` | 不产出 teacher 链、最终声明或 callEdge 真值 |
| 学生能力 | 在当前一步的局部观测上判断关系与当前选择 | 本设计定义的 H_R/H_A（见 §3） | 不得把确定性解析结果当学生学会 |

旧 `nn-code symbols` 入口（`lib/cli-symbols.ts`，schema `nnanything.cli-symbols.request.v1` / `result.v1`）只作 teacher、oracle、样本来源与对照材料。它的 `parser.semanticBinding=false` 语义必须保持：解析不等于语义绑定成功。

### 1.3 非目标

不做跨模块全量绑定求解；不把 `tsc`/language-service 的最终答案作为学生输入；不改 `docs/design.md` 1.1 四元素合同；不改 64 维输入、两层隐藏层、统一格式与固定推理引擎；不恢复旧 nn-code 产品；不启动本能力训练。

## 2. Goal / satisfactionThreshold / State / Action 四元素

| 元素 | 本能力定义 |
| --- | --- |
| Goal | `code.symbol.relation.requestedDeclaration in scope(entryFile)`（typed；`kind: acquire` 或 `verify`）。显式给入口文件、请求声明（typed `DeclarationIdentity`，允许 opaque target）与 one/all 语义 |
| satisfactionThreshold | 显式 0..100；本能力二元判定，实际 satisfaction 只输出 100/0/null，不得给中间分 |
| State | 当前入口文件、请求声明、当前一步已取得的局部语法观测（relation facts）、缺测/unsupported/conflict、`remainingObligations`、`previousExecution` 回执；未知不伪装为已知 |
| Action | `observe`（读当前模块 AST 取局部符号）、`advance`（沿显式合法边推进局部 cursor）、`judge=true/false/unknown`、`NOOP`、`RETURN`。judge 是独立判定族，不是技能 |

四元素闭合要求：Goal 的满足度只能由当前 State 的局部证据评价；缺测不补 false；`judge=unknown` 与“未观测”分开；`RETURN` 仍须独立根评价，根未满足时返回准确未满足/unknown。

## 3. 四头职责投影

沿用 `docs/l2-four-head-experiment.md` 的头定义与 `lib/training/unified-encoder.ts` 的 64 槽编码（G0-G7），不新增第五头、不替换 Encoder。

| 头 | 本能力输入 | 输出 | 独立监督/分母 |
| --- | --- | --- | --- |
| H_R | 当前入口 + 请求声明 + 当前一步局部 relation facts + missing mask | 每候选 `(request, relation, localDeclaration)` 的 true/false/unknown logits `[pairs,K,3]` | 已确认三元组逐关系 precision/recall/F1；unknown 单列；对象改序/改名配对一致率 |
| H_D | 根 Goal、State、H_R 实际输出、有限技能描述 | 分解候选：observe 当前模块 / advance 合法边 / judge / return，附 supported/semantic_gap/capability_gap/unknown | 允许分解集合命中率；必需观察召回；额外不必要动作率 |
| H_E | 当前条件（in_scope / declared_here / shadowed / dynamic）与证据 | satisfied/unsatisfied/unknown/not_applicable `[C,4]` | 独立 oracle；假达成=0；越界证伪单列 |
| H_A | 未决条件、H_D 候选、H_E 评价、合法技能 | observe/advance/judge=true/false/unknown/NOOP/RETURN/NO_CAPABILITY | 允许集合命中率；越权执行=0；无合法动作准确返回 |

学生输入只来自 `unified-step-context-builder` 可构造的 typed StepContext（source-level episode：entryFile、requestedDeclaration、observedFacts、pendingRelationRef、callSiteRef、remainingObligations、cursorOpen）。禁止把 gold 关系、teacher 最终绑定、未来回执或 `goal_met` 编入学生特征。

## 4. SESE 数据路径与唯一 owner

外层复用 `recursive-goal` 的 `bind→run→report` 3N2E，本能力不新增控制循环。单次 run 的对象流：

```text
[请求+入口文件+显式阈值]  (调用者 typed)
  -> observe: 当前模块 tsjs symbol table (deterministic adapter)
  -> project: tsjs-unified-adapter -> relation facts (missing/unsupported 保留)
  -> step-context: unified-step-context-builder (学生可见，无 gold)
  -> H_R/H_D/H_E/H_A (64-slot encoder 输入)
  -> 固定调用 judge/observe/advance + 真实后验 (deterministic)
  -> 后验评价 (H_R/H_E 同合同) -> 统一回执 / 新 run
```

单入口单出口；跨步迭代以实际 New State 开启新 run，图内不加回边。owner 划分：

| 路径段 | 唯一 owner |
| --- | --- |
| 入口文件发现、scope、请求校验 | 既有 `lib/cli-symbols.ts` 的 request/scope 合同（只作 teacher/对照入口） |
| 当前模块符号观测 | `tsjs-symbol-table-adapter` |
| language-agnostic 投影 | `tsjs-unified-adapter` + `unified-relation-facts` |
| 学生 StepContext 构造 | `unified-step-context-builder` |
| 学生编码 | `unified-encoder`（不改结构） |
| 独立监督 gold/`A_g` | 独立监督路径（`researcher_structural_proof` + `independent_tsc` oracle），与学生路径物理分离 |
| 训练候选与回载 | 共享 fixed training launch（待 Alice 审计） |

## 5. 语料、转换输入与来源分区

复用既有 TS/JS adapter、语料与测试作为样本来源，但**必须重建为独立来源分区**，不把确定性解析结果当学生能力：

| 来源家族 | 内容 | 用途 |
| --- | --- | --- |
| `tsjs-symbols-local-decl` | 当前模块内声明/可见性/lexical scope | 关系真值 train/ver |
| `tsjs-symbols-import-alias` | import/re-export/alias 的局部语法证据（不含跨模块最终绑定） | 关系与 advance train/ver |
| `tsjs-symbols-shadow` | 同名遮蔽/局部遮蔽 | 证伪 train/ver |
| `tsjs-symbols-dynamic-undecidable` | computed member、动态 require/export | unknown 监督 |
| `tsjs-symbols-parse-error` | `broken.ts` 类部分语法错误文件 | partial/unsupported 保留 |

TRAIN/DEV/VERIFICATION 按关联来源与构造机制先分区：同模板改名称只验名称不变性；声称组合泛化必须留出机制组合。已暴露 DEV 转“已知回归”。独立构造者只收共同任务合同，不收 dev 错误提示。teacher（旧解析器）只出现在监督旁路，不进入学生输入或拟合。

复用 `carol-tsjs-r2-stepwise-corpus` 已验收的固定字段映射（`field-mapping.md`）：学生输出含 request identity、current local observation、current relation、obligations/gain、legal candidates、previous execution、local cursor；独立监督路径单独持 gold/`A_g`/`trainingEligible`；学生输出不含 `A_g`、gold、teacher、oracle、`S_g` 或终态答案。

## 6. 最小必要性

仅保留当前合同所需项：单文件 AST 观测（已存在，复用）、language-agnostic 投影（已存在，复用）、typed StepContext（已存在，复用）、64 槽编码（已存在，不改）、关系监督与逐关系分母（本设计新增定义）。不为假设的跨模块求解新增输入，不为填满类别制造实际命令不会发生的内部错误。删除任何一项会破坏：局部证据可辨性、缺测显式性或验收分母。

## 7. 未知、证伪与失败证伪设计

| 事实 | 处理 |
| --- | --- |
| 计算成员名、动态 require/export | `judge=unknown`，`dynamic_undecidable`，不补 false |
| 部分语法错误文件 | `parseStatus=partial_syntax_error`，coverage.partial，观测强度降级为 partial |
| 遮蔽/同名声明 | 不合并；显式 shadow 事实；同名不合并 |
| 无命中 | 正常搜索/观测结果，`judge=false` 只在有结构证据后成立 |
| 观测覆盖不足 | unassessed 逐例列出原因与数量，不得排除缩小分母 |
| 假达成 | 学生输出 satisfied 但 oracle 判定无关系 -> 假达成，必计 0 容忍 |

## 8. 训练与回载准备（待 Alice 通过后执行）

训练阶段在共享 fixed training launch 环境验收后执行；保存独立候选并完成新进程回载、独立留出语义评价和旧能力回归。既有权重、gold、threshold、采用状态不改。候选只写独立候选路径；保存后新进程回载 `tensorsMatch=true` 才算可回载证据。首轮数值候选固定两层 64-hidden MLP，四头共享 MLP 实现，各域独立 profile；L1 参数不更新。

## 9. 评价与分母

沿用 `docs/l2-four-head-experiment.md` §量化表与 `docs/semantic-evaluation.md` 的具名分母。本能力必需分母：

| 项 | 分母/通过条件 |
| --- | --- |
| H_R | 已确认三元组每关系 F1>=0.95；unknown 与 unassessed 公开；改序/改名配对一致率 100% |
| H_D | 允许分解命中率>=0.95；必需观察召回 100%；额外动作率单列 |
| H_E | 已判定条件宏 F1>=0.95；假达成=0；越界证不可能=0；unknown 补 false=0 |
| H_A | 允许选择命中率>=0.95；越权/伪引用执行=0；无合法动作准确返回 |
| 根目标 | 可达 episode 准确达成；已证不可达准确停止；证据不足保持 unknown；假根成功=0 |

测试条件（继承 board）：已知符号关系 100% 正确且零错误；未知必须 `judge=unknown`；无截断或失败遗漏；候选完整；训练输入不使用未来信息；独立来源不进入拟合；运行失败和缺测不得吞掉。任一项未达即 INCOMPLETE。所有已确认 gold 的合格输入都进入相应头评价；`judge=unknown` 计弃权与漏检，不从分母删除。

## 10. 交付与证据路径

| 交付 | 路径 |
| --- | --- |
| 设计合同（本页） | `docs/nn-code-redesign-symbols-tsjs-design.md` |
| 独立语料与转换输入 | 复用 `carol-tsjs-r2-stepwise-corpus` 固定生成合同与 `tsjs-symbols-local/import/shadow/dynamic/parse-error` 家族；独立来源分区在训练任务中落盘 |
| 训练/评价合同 | 本页 §8-§9；实际 fit 在共享 fixed training launch 审计后单独派发 |
| 缺口 | §11 |
| 真实入口与可复现证据 | 训练任务交付时提供命令与原始回执 |

## 11. 未实现项（INCOMPLETE，明列）

1. 独立语料实际生成与来源分区落盘：本任务只交设计；实际语料生成与分区在独立训练任务执行。
2. 学生能力训练、回载、独立留出评价、旧能力回归：未执行，待 Alice 通过设计并审计共享 fixed training launch。
3. 候选权重：不存在，保持 `uncalibrated/not_applied` 前置。
4. 独立监督 oracle（`independent_tsc`）对本能力新关系词表的具体断言集：待训练任务按本页 §9 分母固化。

本页落盘即设计交付，不计作功能已完成。
