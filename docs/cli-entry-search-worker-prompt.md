# CLI精确名称查找：worker交接提示词

以下内容可直接交给负责该目标的worker。设计版本为docs/cli-entry-search-design.md的0.1.0-design；执行时以最新main及其中有效合同为准。

---

你是NNAnything“指定目录内精确名称查找”实施目标的负责人。父编排者负责最终独立Review与main集成。你负责独立Plan、实现编排、自检、真实consumer、独立执行家族及证据收口。你不是唯一工作者；其他人正在维护浏览器方向，不能回退、覆盖或清理他人代码与资源。

总目标：在显式绑定目录的直接子项中，按精确名称查找一个regular或directory对象。保留根file.property目标，通过现有recursive-goal派生“本次列举→精确候选→真实inspect”条件，按真实State反向满足。只输出本轮当前动作，不能训练循环层序、把模型分数当满足度，或从日志重建控制与受信证据。

必读：项目AGENTS.md、note.md、docs/cli-entry-search-design.md、docs/cli-call-contract.md、docs/cli-filesystem-semantics.md、docs/recursive-goal-module.md及适用需求文件。先读workflows/cli-entry-search.graph.json（5N4E内部责任图，design无运行绑定）、recursive-goal 3N2E和cli-file-property 6N5E。按nnanything-design和实际宿主编排Skill执行。

范围与硬约束：

- 严格按设计第3–5节请求/结果及当前性合同实施。新组合公开入口为nnanything/cli-search；原子cli-goal仍仅处理已有子Goal，直接根matches仍unsupported。
- 仅显式单目录、直接子项、严格名称和regular/directory；不递归、不glob、不跟随候选symlink、不读取正文、不改cwd、不写文件。fixture操作仅限自有临时沙盒。
- 复用单一cli.command-policy.v1的现有head/wire/profile，不重训、不采用、不另造selector。固定名称比较是D，不包装成新训练能力。
- 真实列表不是ObjectRef。匹配后必须通过当前生产entry.inspect取得真实类型和受信引用；错误、部分覆盖、根事实、control、effects分别保留。
- 浏览器代码/工作树/权重/页面资料均禁改。通用核心原则上不改；必须改变核心、head/wire或设计语义时，先交具体证据与Plan修订，不自行扩大。
- 保留S06部分完成、五项UNVERIFIED及Linux限制，不能用本任务通过清零。

执行路径：

1. 从最新origin/main按全局Close-Before-Open规则建立唯一独占工作树，建议/Volumes/Intel/playground/nnanything/cli-entry-search。先盘点，若同域已有树则复用或安全收口后再开；不在canonical写代码。
2. 按Q0–Q6推进。先独立Plan，再用自有目录做命中/完整无命中最小探索，特别检查policy authority、sandbox引用与recursive State的兼容性。Plan/Review按专用角色路由；执行/观察尽量派codex exec --profile gcm，不用会话内spawn_agent替代。
3. 先让E01/E02/E09/E13的公开行为红，再实施最小入口。其后补E03–E14适用分支。测试必须能抓原失败，不只断言“调用成功”。
4. 让独立执行者按设计重新构造家族B并运行；不要复用A生成器仅换名称。保留逐例OS前提、gold来源、运行轨迹、执行/错误、根与子结果和清理。注入结果与真实OS结果分报。
5. 运行受影响回归、build及新进程公开consumer。复用未变证据，不为凑数量重复全仓运行。若拟合需求出现，保留当前失败并报独立后续计划，本批不偷偷改权重。

Owner按设计第8节：新合同/CLI递归桥接归lib/adapters/cli；纯判断归lib/filters；薄导出归lib/cli-search.ts；测试/consumer归tests与playground/cli/entry-search。不要机械照文件数实现，已有owner可复用则复用。

证据放仓库外独占run目录；训练资产沿项目既有目录；项目进度只更新note.md。不新建根级目录、平行注册表、哈希清单或冻结包装。

停止条件：明确授权拒绝、外置盘不可用、受信引用/当前性/错误链无法沿既有合同表达、必须改核心/策略表示才可继续，或发现设计矛盾。只停受影响链，报告原始证据、唯一owner、最小修复建议；不要通过fallback、改gold或削弱验收绕过。

交付：完成作者验收后提交可审查候选。报告Q0–Q6与E01–E14分支的实际通过/失败/未验证；列公开API用法、worker角色、两家族来源、具名分母、受影响回归、真实consumer、限制、分支/worktree/run及最短可复制复跑命令。命令逐行放代码块，环境变量使用正常ASCII，不把多条命令挤一行。

按用户本次分工，停在候选交父编排者Review：不合main、不push、不部署、不采用权重、不删除待审树。不要自称最终Review PASS。父Review只在完整milestone作者验收后进行一次，finding修复只补受影响验证。
