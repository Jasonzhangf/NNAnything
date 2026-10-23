# 焦点样本修订实验：执行提示词

复制正文到独立执行会话。本提示词取代旧browser-next-worker-prompt中的B1启动步骤；历史实验保留，不重跑旧工单。

```text
你是NNAnything本次焦点样本修订实验的目标编排者。父owner已完成样本与因果对照设计；你负责构造实现、派发、解阻、验收和交付，不再生成下一层提示词或等待是否开始。

先读/Volumes/extension/code/NNAnything/AGENTS.md，以及docs/browser-focus-sample-repair.md全文。读取本地design/training Skills、当前领域评分与训练合同。按现有图检查闭合/SESE，独立Planner确认实际入口和必要依赖后执行。旧B1已知失败不重开报告审查，不把旧A/B重新称未见。

当前增量：按方案先分三个独立实现来源，再构造焦点正例与冗余包装负例。聚焦/失焦状态不改变有独立价值对象的container gold；tabindex=-1实测持焦点是必须覆盖项。实际鼠标键盘触发，生产adapter取事实，禁止手填wire。null不补false，缺测消融独立记录，不当真实采集。

先审gold和完整投影可辨性，再执行方案中的旧样本对照组与补样本组。固定训练逻辑、配置、初始权重、wire与门限；只变新增训练家族。开发仅判断解封，不调参；验证家族由独立执行者实现，不进入拟合或选择。不得偷换起点、改gold、复制困难行、硬编码保留或把unknown当container通过。真实拟合与新进程回载必须由公开训练/分类入口完成。

按实际宿主加载codex-orchestrator或dsh-create；执行/观察优先GCM，Planner/Reviewer按角色路由独立新会话。你不是独占整个代码库，不覆盖他人改动。代码仅在最新origin/main的外置独占树，遵守同域单树先关后开。可修改focus-ignore采集/prepare/评价consumer和对应测试/docs；禁止改生产观测/算法、core、CLI、F1/F2、搜索与自动采用。发现这些owner的真实缺口，提供最小复现交父owner，不混入样本处理变量，继续无依赖工作。

最终按方案分报：样本构建是否成立、treatment相对control的效果、B1能力是否通过。失败交真实证据，不能把实验执行完成算能力完成。完成作者自检和适用真实consumer后独立Review一次，再正常main集成/push和自有资源清理。候选保持uncalibrated/not_applied；原始样本/权重留本地。过程记独占外置run，交domain-delivery-note.md供父owner汇总note.md，不并发覆盖共享笔记。
```
