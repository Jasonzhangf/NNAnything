# Shell长程目标：刚性属性语义与可组合只读任务

状态：S-Inventory 至 S-Independent 已交付并通过独立 Review；S-React 的后续权重替换与 S-Pipeline 的更大组合边界仍是后续增量。配套[启动提示词](cli-next-longhorizon-prompt.md)。通用推理core由父编排者维护；shell编排者负责领域语义与接入，不重复实现控制器。

已交付（2026-10-22，合流后提交见 main）：
- `nnanything/cli-read` 的 `runCliReadCompositionGoal`：显式受信目录内严格名称 regular 文件的指定范围字节 equals 根目标，根 0/100、unknown null。list/inspect 走共享 `cli.command-policy.v1`，read 是确定性 `file.read` harness 观察，无新 head、未训练。
- 受信 `file.read` 沙盒原语：observed `cli.file` 引用 + 范围，只需 `filesystem.read`，打开前后身份比对，替换返回 stale 且不返回字节。
- 组合 state 显式携带 listing/candidate/inspected/fileRef/read 与 sourceRun/revision；根评价只在控制器根评价完成且一致时给出 0/100；预算/取消停止为 unknown/interrupted。
- 根目录必须是 sandbox 签发且当前 revision 有效的目录引用，未签发/旧 revision 的普通 path 引用零执行拒绝。
- 证据：组合 21 例（命中/异型/未找到/字节不符/完整与部分列举/读前替换/过期 revision/伪造 source/短读/零长度/拒权/真实 EACCES/取消/预算边界/未绑定目录/组合层竞态）、公开 consumer、独立来源家族 27 例、受影响回归 82/82、独立 Review PASS 与修复复核 PASS。外置材料在 `/Volumes/Intel/playground/nnanything-runs/cli-read-composition-20261022/`。

未做：第二层混合决策训练、S-Pipeline 更大组合、写操作/realpath/links/role/format 判断、Linux 设备/FIFO 实测；五项 UNVERIFIED 与 S06 部分完成保持原状。

## 目标与已有起点

将已交付的路径/文件属性和精确名称查找组合成可用、可验证的只读shell任务：在显式目录与范围中绑定对象，检查所需属性，按需要读取普通文件的指定内容范围，用真实状态验收并解释失败。第一层刚性且训练，第二/三层组合可用手写或权重。固定系统命令继续typed化，不因样本变化就开放自由shell生成。

CLI精确名称查找已完成authority修复与主线集成，集成提交a854bcc。公开入口`nnanything/cli-search`。受信目录引用先经sandbox校验，成功match由sandbox签发且可供entry.inspect复用；替换或revision变化拒绝旧引用且零executor。外置证据在`/Volumes/Intel/playground/nnanything-runs/cli-entry-search-20261021/integration/`，旧失败probe文件保留，不能误当当前结果。旧cli-entry-search工作树已关闭，不在不存在的树续作。

必读：docs/cli-foundation.md、cli-filesystem-semantics.md、cli-call-contract.md、cli-filesystem-training.md、cli-semantic-operations.md、cli-entry-search-design.md；通用设计及逐步反应/归因/经验边界沿docs/design.md 1.1.1、recursive-goal-module.md 4.0、bounded-goal-planning.md 9.1、model-evolution.md 2.2。

首层不是全部完成：S06及五项UNVERIFIED、Linux限制、写操作/realpath/links/role缺口沿原记录保留。未取得真实设备/平台证据不清零，不为只读主线争取无关提权。共享cli.command-policy.v1保持一份；新只读helper并非自动成为policy已注册head。

## 增量与可执行工作

| 增量 | 操作与owner | 验收 |
| --- | --- | --- |
| S-Inventory 实际基础图谱 | 列公开操作、独立函数、已训练head、仅设计及未验证。核对content/format/declaration等函数与harness入口，不按文件存在就算可调用 | 每项给I/O、真实观测、授权和consumer；目录/文件角色均归file.property，不造零散Goal |
| S-L1 必需刚性原语 | 仅补下一组合实际缺少的只读绑定/属性/范围读合同；参数、字节、名称与引用机械传递，复杂语义不塞入基础gold | 手工正反例、特殊名称、空/缺测、symlink/非普通类型及打开边界、引用过期/伪造、范围/effects分离；旧共享policy无回归 |
| S-Compose 最小组合 | 一个typed根目标：显式目录内严格名称regular项存在且其指定范围字节满足明确谓词。复用精确查找、inspect与read公开能力，通过recursive-goal串联 | 匹配名≠匹配类型，路径≠对象身份，读取成功≠根满足；每步post当前有效，根0/100/null，未找到/不匹配/未知/拒绝/失败分别返回 |
| S-React 逐步反馈 | 领域接入适用性、实际反馈和必要归因；先固定规则成立，再按明确可辨输入考虑上层权重替换，不训练层序 | 临时OS失败不自动排除全部转移；未知effects不重放；读取前对象替换、目录覆盖partial、绑定过期、后验不足、根自行满足均有公开轨迹 |
| S-Pipeline 有限组合边界 | 将需要的组合表达为有类型依赖，输出/输入角色明确；可先给有限管道语法设计与准确unsupported，不以常见shell文本直接执行 | 当前切片只声明能支持的原语/组合；未声明重定向、替换、通配、任意管道、未知CLI均拒绝或未就绪。不能暗中扩成通用shell |
| S-Independent 泛化与交付 | 先分不同目录结构/名称/对象变更机制家族，再生成样本；至少一个独立来源家族仅拿共同合同与公开入口 | 真实OS逐例结果和副作用、引用可复用、旧回归；只读组合consumer贯穿公开入口，完整milestoneReview及main交付 |

先交S-Compose的最小可用主线，再依缺口完善。广义CLI/help/非标准命令的语义识别、容错建议和NN学习是后续边界设计，不是本目标默认实现。错误容忍只能建议纠正候选，不能把拼错命令当已成功执行。不新增写文件/删除/下载/安装/网络执行来扩大完成范围。

## 测试与验收标准

每次训练或设计变更分别验收：语义选择、typed参数构造、真实OS结果、实际根条件。路径空格/换行/Unicode/前导横线不拆参；词法解析不证明存在；errno保留真实值。完整覆盖不足不能返回not_found，mtime相等不证明字节未变，同路径不证明同对象，内容声明不自动成为用途gold。

组合必须包含：命中且字节符合、同名异型、未找到、字节不符、完整/部分列举、读取前替换、过期revision、伪造source、symlink/FIFO打开边界、拒权、真实读取失败/观察不足及取消。复用已有原子反例，组合新测只覆盖依赖交界和根判定，不复制整套原子测试。存在/相等等binary目标0/100，unknown保持null；没有定义部分满足尺度不造进度分。

第二/三层混合单元各有显式infer/train、样本及权重归属；确定性基础不虚设训练。手写组合可先证明行为，再有监督替换；不能把控制回路、重试计数、任意shell输出拟合作为当前学习目标。经验按时间保留真实输入、预测/选择、实际回执与后验解释，teacher建议与已执行效果分开。候选仍未采用，采用规则不另复制。

交付现有docs owner下的能力表/组合合同、公开consumer、真实OS证据、训练/回载（仅实际有训练的单元）、独立家族、准确限制和完整Review回执。正常合流最新main、push核远端并回收自有树和沙盒；Review PASS或分支提交不算完成。

## 资源与边界

从最新origin/main创建`/Volumes/Intel/playground/nnanything/cli-read-composition`独占树，分支前缀codex/；开树前正常盘点同域旧资源，旧entry-search已关闭，不重新创建其历史路径。可修改CLI adapter、对应filter/node、领域训练与测试/docs；不能修改browser、lib/core或lib/workflow/recursive-goal。发现通用缺口给父owner最小公开复现，继续无依赖工作。

只在自有文件系统沙盒操作，不读用户私有文件，不提权建设备。训练沿显式Handwired根和现有CLI公开consumer，共享policy一份不分裂。note.md由父owner汇总，过程用独占外置run，避免与浏览器并发改共享笔记。不能覆盖他人dirty状态或强删资源。
