# 单次失败反馈单元

公开入口 `nnanything/browser-feedback` 的 `browserFeedbackUnit.infer/train` 使用共同生命周期接口。当前是上次执行的知识判断，不执行鼠标，也不覆盖原Goal满足度。模型诊断不能授予retry权限。

```sh
node playground/browser/feedback/train.mjs --handwired-root /path/to/handwired --samples /absolute/train-dev.json --output /absolute/candidate-directory
node playground/browser/feedback/reload.mjs --profile /absolute/candidate.json --cases /absolute/verification.json
node playground/browser/feedback/infer.mjs --profile /absolute/candidate.json --input /absolute/attempt.json
```

训练默认固定200epoch、学习率0.1、零初始化。显式样本优先；未提供时使用明确标注的合成资料。train拒绝verification，按family隔离来源。投影覆盖损失让相同学生投影的重复记录不改变训练重要性；同投影冲突标签明确拒绝。全部原始记录仍求真实梯度。

读取缺失/损坏权重或缺Handwired明确失败，无旧权重或内置默认回退。训练accepted只代表train/development验收，候选始终uncalibrated/not_applied；独立评价与Review另留证据。完整语义、结果和限制见[领域合同](../../../docs/browser-feedback-strategy.md)。
