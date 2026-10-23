# 单次失败反馈单元

公开入口 `nnanything/browser-feedback` 的 `browserFeedbackUnit.infer/train` 使用共同生命周期接口。当前是上次执行的知识判断，不执行鼠标，也不覆盖原Goal满足度。模型诊断不能授予retry权限。

```sh
node playground/browser/feedback/train.mjs --handwired-root /path/to/handwired --samples /absolute/train-dev.json --output /absolute/candidate-directory
node playground/browser/feedback/reload.mjs --profile /absolute/candidate.json --cases /absolute/verification.json
node playground/browser/feedback/infer.mjs --profile /absolute/candidate.json --input /absolute/attempt.json
```

训练默认固定200epoch、学习率0.1、零初始化。显式样本优先；未提供时使用明确标注的合成资料。train拒绝verification，按family隔离来源。投影覆盖损失让相同学生投影的重复记录不改变训练重要性；同投影冲突标签明确拒绝。全部原始记录仍求真实梯度。

读取缺失/损坏权重或缺Handwired明确失败，无旧权重或内置默认回退。训练accepted只代表train/development验收，候选始终uncalibrated/not_applied；独立评价与Review另留证据。完整语义、结果和限制见[领域合同](../../../docs/browser-feedback-strategy.md)。
# B-Feedback consumer 与展开域验收

本目录登记 F1/F2 的训练、回载与展开域验收 consumer：

- `prepare-b-feedback.mjs`：从显式旧候选和来源分区生成 train/development 与 R5 回归资料。
- `receipt-f1-separation.mjs`：并列记录回执成员预测与旧 F1 预测，保留 R5 分离证据。
- `post-train.mjs`：固定预算候选初始化 F1 拟合，输出 `uncalibrated/not_applied` 候选。
- `discernibility.mjs`：用公开 `feedbackFeatures` 生成完整 12 维投影表并检查冲突 gold。
- `accept-expanded.mjs`：展开域 34 条轨迹 runner（17 实例 × 2 家族），每段独立新进程，通过 CDP 原生通道点击，落 `rows.jsonl`、`table.md` 与逐行 episode。固定续跑实例按声明段数运行；其他实例沿 continuation 自然推进。续段报告包含历史 `atomicResults`，runner 按 `dispatchId` 去重后判断 F1/effects；目标达成记录 `goal_achieved`，DEFER 从 typed `policy_deferred` 错误读取。C11c/C11d 再入段要求 typed rejection 且零新增输入。
- `fixtures/family-a.mjs`、`fixtures/family-b.mjs`：两个互不共享 renderer 的独立页面家族。

正式轨迹需要显式 profile：`BFEEDBACK_F1_PROFILE`、`BFEEDBACK_ATOMIC_PROFILE`、`BFEEDBACK_STRATEGY_PROFILE`。真实浏览器执行由父编排者在宿主 shell 完成；本仓库内只跑构建与单元测试。
