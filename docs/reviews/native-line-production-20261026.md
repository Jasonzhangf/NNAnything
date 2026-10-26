# Independent Review: trusted native line-read production primitive

Reviewer `native-line-production-review-1` ran through the Codex OAuth review controller with `gpt-6.1-sol` at medium reasoning effort. Scope was the uncommitted candidate in the `native-line-production` worktree. The final JSON below is the reviewer's read-only output; the controller found no P0/P1 finding.

```json
{
  "contract_version": "1",
  "scope": {
    "mode": "uncommitted",
    "commit": null,
    "base": null
  },
  "module_boundary_evidence": [
    {
      "module": "受信 file.read.lines 调用与 sandbox 回执",
      "owner": "lib/adapters/cli/filesystem-sandbox.ts",
      "paths": "lib/adapters/cli/filesystem-sandbox.ts；lib/cli-goal.ts；tests/cli-file-read-lines-sandbox.test.mjs",
      "edges": "公开 cli-goal 入口导出 sandbox；execute → readSemanticCliCall → session snapshot → executeFileReadLines → effects、regular 类型、显式配置及受信引用校验 → readFileLines → 成功或失败 SemanticCallReceipt。新增参数要求 ref、anchor、count 精确匹配，不接受路径替代。正常成功和合法调用的执行失败均返回原 receipt；非法 schema 保持既有 TypeError 边界。lib/cli-goal.ts 只补充两项观测 effects 的穷举映射，没有接入模型选择。",
      "resources": "权威需求采用 /Volumes/Intel/playground/nnanything-runs/l2-layer-corpus-20261025/native-line-production/design.md，Alice 日期为 2026-10-26；同目录 plan.md 与 worker-task.md 明确接受最小文件范围和资源配置。受审 worktree 及 /Volumes/extension/code/NNAnything 均无 .appsdk/requirements.json，跳过该输入。AGENTS.md 将固定 CLI 观测归 adapter，禁止通用 shell、训练和递归核心扩展；本次 diff 符合该边界。候选 docs/cli-native-read-experiment.md 第 7 节记录实现状态，没有作为独立用户授权来源。",
      "gates": "已亲读公开 sandbox 用例和原始 red.log：实现前新操作及配置入口被拒绝。实际成功用例通过真实 head/tail 读取已知 fixture，断言原始字节、logicalLines、requestedCount、进程结果及 session 不变。拒绝用例覆盖分别缺少 filesystem.read/process.exec、伪造或过期引用、非 regular、路径替代、缺配置及预先取消，并检查零 open、零 spawn。身份变化覆盖绑定后替换和 preflight-to-open 替换，后者在 spawn 前拒绝。修复后五文件结果见 fix-tests.log 与 jenny-verify1/tests.log，均为 54/54、无失败、无跳过；本次审查复用这些记录，没有补测。"
    },
    {
      "module": "共享 verified-open 与原 range 行为",
      "owner": "lib/adapters/cli/file-content.ts 的 openVerifiedHandle；成功后的句柄由调用者持有",
      "paths": "lib/adapters/cli/file-content.ts；tests/cli-file-read.test.mjs；tests/cli-file-read-sandbox.test.mjs；tests/cli-file-read-independent.test.mjs；tests/cli-file-read-end-observed.test.mjs",
      "edges": "readFileRange/readFileLines → 共用 openVerifiedHandle → pre-open lstat → final-symlink/regular 检查 → O_RDONLY|O_NOFOLLOW|O_NONBLOCK open → opened fstat 与 dev/ino 核对。打开后的拒绝和异常路径由 helper 关闭句柄；成功路径转移所有权，由各调用者 finally 关闭。行读取另在 spawn 前核对受信 ref 身份。原 range 的零长度、短读、字节范围及错误返回逻辑保持原样。",
      "resources": "parent-findings.md 记录 Alice 通过真实 a/b 文件替换探针发现的 post-open 拒绝泄漏；fix-task.md 限定只修两条失败路径及相关测试。fix-progress.md、fix-delivery.md 和 parent-findings.md 的定点复核记录了修复、构建、测试及真实 fd 关闭结果。没有引入第二套文件打开 owner。",
      "gates": "fix-red.log 保留修复前四个 close-count 断言失败，实际结果为 0 而非 1。当前代码在非 regular 和身份不符的返回前关闭句柄。range 回归用例包装真实 FileHandle.close，检查调用恰好一次及真实 fd=-1；成功用例也检查只关闭一次。Alice 的独立真实 readFileRange 探针记录 READ_TARGET_CHANGED、close=1、fd=-1。修复后 54/54 记录覆盖 range、lines、真实 errno、symlink/FIFO 拒绝及独立范围读取回归。"
    },
    {
      "module": "固定原生行读取进程与资源收尾",
      "owner": "lib/adapters/cli/file-content.ts 的 runNativeLineRead/readFileLines",
      "paths": "lib/adapters/cli/file-content.ts；tests/cli-file-read-lines-sandbox.test.mjs",
      "edges": "已验证 fd → 固定 /usr/bin/head 或 /usr/bin/tail，argv 仅为 -n 和 count，shell=false、fd 作为 stdin → Buffer 采集 stdout/stderr → child close → 完整成功或 typed 失败 → finally 释放父句柄。超时、取消或输出越界只终止当前 child，先 TERM，再按 killGraceMs 发 KILL；close 后清理 timer 和 abort listener，再结算结果。成功要求正常零退出、无信号、无采集错误且未超过输出上限。",
      "resources": "宿主显式提供 timeoutMs、killGraceMs、maxStdoutBytes、maxStderrBytes 和可选 signal；语义调用不能选择 executable、argv 或 shell 文本。测试配置与 worker-task.md 一致，为 10000ms、250ms、16777216 字节 stdout 和 1048576 字节 stderr。没有运行时全文读取、全文行数或 size 推断，也没有声明文件内容快照语义。",
      "gates": "真实 head/tail 用例覆盖双方向的空、短、恰 N、长及无末尾 LF 文件，并验证 NUL 和非 UTF-8 字节。打开后 rename 并替换原路径的用例仍读取原对象。生命周期用例启动真实子进程，覆盖真实 ENOENT、非零退出、信号、timeout、abort、stdout/stderr 越界和非空 stderr 的成功结果。失败不返回部分读取观测，spawn 错误保留 errno，失败 receipt 可承载实际进程结果。源码仅从 stdout LF 字节计算 logicalLines，不将 requestedCount 当作实际行数。"
    },
    {
      "module": "feature DAG、构建与范围闭合",
      "owner": "Alice 负责设计和领域验收；adapter 负责实现；Jenny 负责集成",
      "paths": "workflows/cli-file-property.graph.json；workflows/recursive-goal.graph.json；workflows/l2-four-head-step.graph.json；docs/cli-native-read-experiment.md；任务 run 目录中的 design.md、plan.md、progress.md、delivery.md 与修复记录",
      "edges": "本轮 feature 链为设计需求 → 已接受 scope/owner → sandbox 与文件观测实现 → 新入口红测及真实行为回归 → cli-goal 公开产物 → 原始结果记录。内部流程为 typed call → 校验 → verified open → native process → observation/failed receipt，清理由文件观测 owner 收口。已检查外层 6N5E、3N2E 和 8N7E 图，均保持单输入单结果；本次未修改 workflow 节点或拓扑，8N7E 仍是设计图。",
      "resources": "任务过程记录位于 /Volumes/Intel/playground/nnanything-runs/l2-layer-corpus-20261025/native-line-production/。初次实现、泄漏发现、定点修复和验收均有对应记录。实际 diff 限于三个源码文件、两个测试文件和一份领域文档，未触及 core、recursive-goal、训练、权重或样本。模型组合、selector 选择新操作及 continuation 后续工作明确未实现，不纳入本轮 primitive 的完成声明。",
      "gates": "jenny-verify1/build.log 记录 check-layout 与 TypeScript 构建完成；jenny-verify1/tests.log 记录五文件 54/54。初次较宽回归 tests.log 为 93 通过、0 失败、1 项既有共享候选资产缺失跳过，该跳过不影响本轮原语用例。图未变，本次复用已有图检查依据，没有新增治理图或重复运行构建。审查范围为指定未提交候选；提交、main 集成及资源清理由 controller 后续负责。"
    }
  ],
  "findings": []
}
```
