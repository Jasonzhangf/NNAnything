# 浏览器策略优选训练与回载

公开入口为 `nnanything/browser-strategy`。当前训练只拟合共享 choose/defer 头的20参数策略 profile；原子50参数和 F1 反馈36参数是显式固定资源，不在此入口重训。候选始终为 `uncalibrated` / `not_applied`。

```sh
node playground/browser/strategy/train.mjs \
  --atomic-profile /absolute/atomic-profile.json \
  --feedback-profile /absolute/feedback-profile.json \
  --handwired-root /absolute/handwired \
  --samples /absolute/train-dev.json \
  --output /absolute/candidate-directory

node playground/browser/strategy/reload.mjs \
  --profile /absolute/candidate-directory/candidate.json \
  --atomic-profile /absolute/atomic-profile.json \
  --feedback-profile /absolute/feedback-profile.json \
  --cases /absolute/verification.json

node playground/browser/strategy/step.mjs \
  --profile /absolute/candidate-directory/candidate.json \
  --atomic-profile /absolute/atomic-profile.json \
  --feedback-profile /absolute/feedback-profile.json \
  --request /absolute/step-request.json
```

`train.mjs` 固定使用零初始化、200 epoch、学习率0.1。未提供 `--samples` 时使用 `makeStrategySamples()` 的 `synthetic_projection` 资料。显式样本必须包含 train 与 development family；verification、同 family 跨分区和缺失 Handwired 都会明确失败。开发集失败时仍保存候选与报告，但 `accepted=false`。

`reload.mjs` 在新进程中读取 profile 与 cases，只评价，不执行 fit。`step.mjs` 只调用纯 `predictBrowserStrategy`，不执行浏览器或原生输入。step request 文件形状为 `{ "request": ..., "history": [...], "registry": [...], "selection": ... }`。

训练 accepted 只表示当前 train/development 满足“全对且优于零权重”，不等于整体策略交付，也不等于已校准、已采用或已有真实浏览器轨迹。零 epoch 或零权重结果只是零权重 baseline。合成资料只能补边界，不能称为实际 native 验证。合同见 [渐进式策略](../../../docs/browser-progressive-strategy.md)。
