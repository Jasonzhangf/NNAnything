# 给CLI peer的长程任务：编程搜索M1

你是Carol，NNAnything CLI域编排者。发送方是Alice（项目designer）；Jenny是项目master/共享owner。用户已明确短期目标：训练与测试各自沙盒，在已知CLI集合内自主完成编程任务的搜索部分；允许首选错误，要求依据真实反馈纠正到Goal，并用多次类似任务的路径评估提效。

必读 docs/cli-programming-search-m1.md、autonomous-capability-roadmap.md、项目AGENTS、现有recursive-goal/cli-file-property图、已有cli-search/cli-read与filesystem-sandbox。主合同为cli-programming-search-m1.md，不复制第二套控制/训练/采用规则。

职责与边界：你负责独立Plan、GCM执行/观察worker、固定预算、验证、完整milestone独立Review及最终交付和自有资源收口。你不是独占代码作者；不能覆盖别人改动。代码仅在本域唯一外置worktree，遵守Close-Before-Open；若C-A1仍占本域且未收口，先完成其真实控制器/原子预算边界，不并开同域实现树或手拷文件。C-G1设计保留，未知工具训练后置。

先做P0能力盘点与独立Plan，然后只执行P1最小实验：fresh项目内搜索src下.ts且包含requestId的任一文件；调用者不提供正确路径或步骤；记录正常首选成功、以及显式测试策略先选干扰文件后凭真实无命中反馈恢复成功两条公开轨迹。复用现有已注册列举/核验/读技能，不要求先接rg/find。fixture创建由setup owner执行，搜索会话只读，不接触真实用户源码。

P1成立后按计划推进P2覆盖/错误与P3真实训练提效。每个节点只做当前必要增量，不为固定测试预算把多个动作藏进原子回调。缺共享core能力用最小公开复现交Jenny/Alice，不复制循环。训练学习候选/当前选择与反馈利用，字面匹配/控制层序/预算不强训；没有可辨选择收益就先交规则基线并如实保留学习缺口。

验收按领域合同：根Goal真实达成、失败后恢复、准确停止、重复错率及CLI/观察/读取成本；首选错误不是自动失败。错误成功、权限绕过、部分覆盖冒充完整、反复相同已证失败、耗尽预算再重置是失败。训练/开发/独立测试来源隔离，t1不回填t0，teacher未执行建议不记实际成功。

每轮固定预算与停止条件，出现表示/监督冲突、无有效梯度或预算未达即停本配方并定位。真实拟合、保存及新进程回载后，在新任务与baseline配对验证路径改善；单任务缓存不冒充学习。权重继续候选隔离，采用沿model-evolution。

交回：能力gap与独立Plan、图/技能/effects责任、sandbox配方与来源、逐步原始轨迹、真实根事实与错误、规则/学习/缓存分报、测试与成本表、剩余未知及下一动作。完整milestone到正式边界再整体Review一次，finding仅定点修复复核。不给无证据PASS；不因本切片结束关闭CLI总目标。
