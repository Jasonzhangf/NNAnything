# CLI 旧实现到 file.property 架构迁移审计与收口计划

状态：2026-10-19 审计与计划，不含产品代码改动。本文回答两件事：主干旧实现与新可扩展架构差在哪；迁移怎样收口才算完成。迁移候选已存在，本文不重新开工迁移，不另起第二候选。

审计基线：`main` 提交 `3336c72`（工作树干净）；迁移候选分支 `codex/cli-property-migration` 提交 `2dbd7bd`，其工作树另有未提交修复。只读审计，未运行 build、全仓测试、训练或真实命令。

## 1. 现状结论

1. 主干 `main` 仍是旧实现：六参数二分类 Goal、共享命令 4×4、`cli-command-step` 3N2E 推理图、legacy 三个 Goal kind。
2. 迁移候选已把整条命令层迁到 typed `file.property`：6 head、14 wire、84 参数、属性图 `0.2.0` 6N5E、训练图 `0.2.0` 8N8E；旧六参数 Goal、旧 4×4 运行对象、旧 `cli-command-step` 与旧 `cli-goal` 图在候选内物理退役。
3. 候选已有真实证据：一次真实拟合（train 38/38、development 20/20）、保存后新进程回载、作者定向回归 105/105、独立验证 34/34 场景与 16/16 失败探针。
4. 候选整体 Review 判 FAIL，3 条 P1，正在修复；未合入 `main`，未推送。这是当前唯一阻塞，不是架构缺口。
5. 迁移范围只到 PWD/CD/LS 三类语义。M0 观测入口、路径控制器、其余 22 个操作、B 对象绑定、R 用途关系、自动采集与自动采用都还在迁移范围之外。

因此迁移的下一步是把已有候选收口，而不是重做设计或重新实现。

## 2. 旧实现真源清单

| 面 | 主干真源 | 公开面 | 候选内状态 |
| --- | --- | --- | --- |
| M0 观测 | `lib/cli.ts`、`lib/adapters/cli/observation.ts`、`lib/filters/cli-path.ts` | `createCliSession`、`interpretCliPath`（`nnanything/cli`） | 未改动，保留 |
| 六参数 Goal 策略 | `lib/filters/cli-goal-policy.ts`（266 行）、`lib/nodes/cli-goal.ts`（660 行） | `createCliGoalPolicy`、`runCliGoalTraining`、`cli.goal-policy.v1` | 物理删除 |
| 共享命令策略 | `lib/filters/cli-command-policy.ts`（4×4） | `createCliCommandPolicy`、`runCliCommandTraining` | 升级为 6×14 |
| 推理图 | `workflows/cli-command-step.graph.json` 3N2E `0.1.0` | 三算子 `cli.command.select/execute/verify` | 图与绑定删除 |
| 训练图 | `workflows/cli-filesystem-training.graph.json` 8N8E `0.1.0` | 8 算子 `cli.command.training.*` | 升级 `0.2.0` |
| legacy Goal 图 | `cli-goal-step` 3N2E、`cli-goal-training` 4N3E | 兼容基线 | 物理删除 |
| 路径控制器 | `lib/filters/cli-path-controller.ts`、`lib/cli-training.ts` | `cli.path-controller.v1`、`createPathResolver`、`runPathTraining` | 未改动，保留 |
| CWD 关系模型 | `lib/filters/cwd-relation.ts` | `cli.cwd-relation.v1` | 保留为独立概念测量，不选命令 head |
| 旧候选 | `training/weights/filesystem/command/d7c4a3e5-…/candidate.json` 4×4 | 本地资产 | 只作按名迁移起点 |

## 3. 新架构目标形状

依据为迁移桥接合同（外置 run `cli-property-migration-20261019/migration-contract.md`）与公共设计 `c7c20ef`。要点：

1. 唯一 Goal 形式为 `{kind:"file.property",property,target,requirement}`；当前注册 `file.property.relation.sessionCwd`（observed/equals）与 `file.property.directory.entries`（observed）。
2. 请求为 `{goal,satisfactionThreshold,state}`；阈值必填且为有限 0..100，实际满足度仍为 100/0/null。
3. head 表固定 `unsupported,DEFER,NOOP,pwd,cd,ls`；wire 为 legacy 四条原名原序加 property、predicate、State 与交互项，共 14 条。
4. 结果为单一顶层形状，status 为 `achieved/unmet/unknown/rejected/failed`，取消旧公开 `unverified`。
5. 受信来源由 factory 绑定的局部 authority 承载；调用者自填的路径、run、revision 不能取得受信地位。
6. 已注册能力的合法未绑定 `DirectoryQuery` 进入 `DEFER` 且零执行；未注册 property/predicate 返回 `unsupported`；schema 错误、旧 Goal、额外答案字段以 `TypeError` 拒绝且无 OS 副作用。
7. 运行图为 `cli-file-property` 6N5E（bind→select→execute→observe→evaluate→report），训练复用 8N8E；NOOP/DEFER 也走同一出口。

## 4. 旧到新逐项对照

| 旧语义 | 新语义 | 迁移方式 | 当前状态 |
| --- | --- | --- | --- |
| `observe_cwd` | `sessionCwd` observed，head `pwd` | typed 转换 + 新证据要求 | 已迁移 |
| `set_cwd` | `sessionCwd` equals，head `cd` | typed 转换；已适用真观测证明相等时改判 `NOOP` | 已迁移，公开语义变化单列 |
| `list_directory` | `directory.entries` observed，head `ls` | typed 转换 | 已迁移 |
| 二分类 `REJECT` | 控制 head `unsupported` | 由未注册语义收束 | 已迁移 |
| 旧 `unverified` | 拆为 `unknown`、`rejected`、`failed` | 统一结果状态机 | 已迁移 |
| 4×4 权重 | 6×14，legacy 四行四列按名保留 | 离线按名迁移后一次真实拟合 | 已迁移，旧对象不可直接运行 |
| 旧 profile 直接加载 | 必须带完整 heads/properties/predicates/wires | 显式拒绝 + 离线迁移器 | 已迁移 |
| `cli-command-step` 推理图 | `cli-file-property` 属性图 | 物理替换 | 已迁移 |
| legacy 三个 Goal kind | 不再接受 | 物理删除 | 已迁移 |
| 六参数 PWD API | 无迁移目标 | 彻底退役 | 已迁移 |
| M0 `observe({kind})` | 无替换，继续作为固定观测 API | 不迁移 | 未迁移，属保留范围 |
| 路径控制器 | 设计中 `path.resolve` 是 head，执行仍是既有词法解释器 | 未决策 | 未迁移 |
| 其余 22 个精确操作 | 新建 head + property/predicate + helper | 未实现 | 未迁移 |
| B 对象绑定 | `DirectoryQuery` 只产生 `DEFER` | 未实现查找 | 未迁移 |
| R 用途关系 | 证据合同已就位（`docs/cli-role-evidence-design.md`） | 未实现 | 未迁移 |
| 使用采集 | `onSample` 显式回调 | 已接入入口 | 已接入，自动采用未实现 |

## 5. 迁移完整度判定

已闭合：typed 请求与结果、单共享权重与 head/wire 注册、旧链物理退役、旧权重按名迁移、真实拟合与回载、独立行为验证、两张图静态校验。

未闭合，按阻塞程度排列：

1. 整体 Review 3 条 P1 未关闭：
   - `lib/filters/cli-state.ts:71`：State 外层 `physicalCwd` 与内嵌 `evidence` 未交叉核对，保留真实来源摘要、只篡改内嵌证据仍可取得 `NOOP`。
   - `lib/cli-goal.ts:77`：请求校验在 bind 节点内执行，runner 包装后公开边界抛 `Error` 而非合同要求的 `TypeError`。
   - `lib/nodes/cli-command.ts:232`：未注册语义配合法 `DirectoryQuery` 被报成 `DEFER/binding_unresolved`，应先按 `unsupported` 收束。
2. 迁移后的基线数字未重定：旧 253/253 含已退役的 `cli-goal` 两个测试文件，不能继续作为门禁。
3. 文档状态未同步到新形状：`docs/cli-call-contract.md`、`docs/cli-call-contract.md` §1.1 引用、`docs/cli-semantic-operations.md`、`docs/cli-foundation.md`、`AGENTS.md` 交付边界段、`workflows/README.md` 图清单仍是旧描述。
4. 迁移资产与孤儿合同：`cli.cd-policy.v1` 无代码与文档 owner；`ba002b23` 之前的原型产物与 `d7c4a3e5` 的地位需在结果文档里明确为历史证据。
5. 无 CI：所有基线依赖显式环境变量与手工日志，交付后无法一条命令复现。

## 6. 迁移完成定义

同时满足下列八条才算迁移完成。任一条不满足即为未完成，不以分支提交、Review PASS 或测试通过替代。

1. 3 条 P1 关闭，受影响复核通过。
2. 新契约下 PWD/CD/LS 正常、失败、副作用零回归；`NOOP` 语义变化单列且不计为准确率提升。
3. 公开入口在新进程加载保存候选，`fitted=false`，真实执行次数与题目数可核对。
4. 全仓回归在显式环境（Handwired 根、命令候选、CWD 关系候选）下通过，并记录新的基线数字。
5. 两张图 dagpipe validate/inspect 通过，配置与算子版本一致。
6. 受影响文档与 AGENTS 边界同步；旧 4×4 只以迁移器与历史证据存在。
7. 合入最新 `origin/main`、`main` 推送、远端核对完成。
8. 自有 worktree 与分支核销，保留他人 `three-site-zero`；训练资产归档到既有 canonical 子目录。

## 7. 收口步骤

| 步 | 动作 | 出口与验收 | 停止条件 |
| --- | --- | --- | --- |
| R1 | 修复 3 条 P1：State 与内嵌证据交叉核对；公开边界恢复 `TypeError`；未注册语义先按 `unsupported` 收束 | 每条 finding 有对应红测后转绿；补公开入口反例 | 任一条需要改契约才能修，先补合同再动代码 |
| R2 | 候选内 build 与全仓测试，记录新基线数字 | 新基线日志 + 逐命令统计 | 测试需放宽断言才能过，停止并查归因 |
| R3 | 受影响复核 Review | 只审 finding 与受影响模块，输出 PASS/FAIL | 新 finding 触及未变模块时先判断是否本次引入 |
| R4 | 合入最新 `origin/main`（含 B/R 文档），canonical build | 冲突按两侧保留；公共设计不被运行绑定覆盖 | 公共合同与迁移合同冲突时先定 owner |
| R5 | 保存候选新进程回载 + 独立验证结果复核 | `fitted=false`、执行计数、独立报告一致 | 回载结果与独立报告不一致 |
| R6 | `main` merge、push、远端核对 | 推送回执 | 推送拒绝或 CI 失败，不停无关工作 |
| R7 | 资源核销与资产归档 | worktree/branch 物理删除，证据保留 | dirty 或仍有活动进程，不强删 |

R1 与 R2 由现有迁移 owner 在该独占树完成。本轮审计不派重叠 worker，不修改该树。

## 8. 迁移后的残留退役

按依赖顺序排列，每项单独验收，不合并成一次大改。

1. 基线重定（R2 已产出）：把"全仓通过"固化为显式命令，缺环境变量时非零退出而不是静默 skip；`dagpipe` 进入可复现入口。
2. M0 观测入口：保留为固定观测 API；决定是否把 effect 词表统一到 `filesystem.read/write`、`process.exec`、`session.write`。当前 `createCliSession` 只接受 read/exec，与沙盒 effect 词表不一致。验收：既有默认授权语义不变，新增写权限需显式声明。
3. `path.resolve` 双身份：head 保留（模型选动作，执行是既有词法解释器），独立 `cli.path-controller.v1` 需决定退役或继续作为训练基线。设计要求固定确定性函数不强训，建议退役控制器并保留其历史证据。停止条件：退役前必须证明 head 路径覆盖其全部既有回放用例。
4. `cwd-relation` 与 `cli.cd-policy.v1`：关系模型保留为独立概念；`cli.cd-policy.v1` 标记历史孤儿，不迁移。
5. 旧权重与旧报告：只作迁移与回归证据，不进入运行路径；`not_applied` 保持强制。

## 9. 下一阶段（迁移完成之后）

顺序沿用用户口径：先目录，再文件，最后组合。每一项都走同一流程：先补 head 注册与可辨配对，再红测，再 helper 与训练，再独立验证。

1. 目录与路径原语：`path.relative`、`path.parts`、`path.realpath`、`entry.inspect` 扩展（E/D/F/P、完整类型、`dev/ino/nlink/rdev`）。
2. 目录变更：`directory.create`、`entry.move`（native no-replace rename，缺 binding 报 UNSUPPORTED）、`entry.remove`。
3. 文件字节：`file.create/read/replace/write/append/truncate/copy/link`。
4. 元数据与链接：`entry.mode.set`、`entry.owner.set`、`entry.times.set`、`link.create`、`file.property.links`。
5. B 对象绑定：把当前只产 `DEFER` 的 `DirectoryQuery` 变成可执行 `DirectoryRef`；这是"模糊目标"唯一入口。
6. R 用途关系：按 `docs/cli-role-evidence-design.md` 的 18 维证据抽取实现，未知与冲突保留。
7. 组合与树操作：多级建目录、遍历、树复制、树删除、统计比较、文本匹配；结束只用 `NOOP`，未成立返回 `DEFER`。
8. 自进化：`onSample` 已就位，接自动采集落盘；再补当前版本引用、配对比较自动采用、冲突移交裁决。

## 10. 风险与已知冲突

1. head 顺序文档冲突：主干 `docs/cli-filesystem-training.md` §2.1 同时要求固定顺序 `unsupported,DEFER,NOOP,…` 与 legacy 行原样保留；候选以"始终完整 6 head"实现，文档需同步一次措辞。
2. 授权词表不一致：沙盒接受 `session.write`，`createCliSession` 与旧 Goal 校验只接受 read/exec；迁移未统一。
3. 旧基线数字不可续用：测试文件集合已变化，交付时必须给出新的基线，且不能把口径变化写成通过率提升。
4. 训练资产树未进 Git：迁移证据依赖本地 `training/**`，仓库内只能保存文档摘要；复现需要显式环境变量。
5. `note.md` 由迁移 owner 持有：本轮不修改 `note.md`，避免与其在跑的修复冲突；迁移事实以本文与外置 run 记录为出口。
6. 并发 owner：迁移 owner 正在候选树修复 P1，不得二次派单、不得在该树写文件。

## 11. 需确认事项

1. 迁移候选直接收口，还是先只把文档并入 `main`。建议直接收口：实现、训练、独立验证证据已在候选内，拆开只会产生双状态。
2. 路径控制器退役时机：建议并入迁移后的残留退役第 3 项，不与收口同批。
3. M0 effect 词表是否统一：建议在接入第一个写操作（`directory.create`）前统一，避免两套授权语义并存在运行路径。
4. 三个数字口径需要在文档里定一个：6 个属性算子（图节点）、22 个新动作 head（调用表）、25 个精确操作（操作目录）。三者是不同集合，不统一会继续产生像"25 操作 vs 28 head"这样的计数分歧。