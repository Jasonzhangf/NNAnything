# 基础种类公开消费端

在仓库根执行 `npm run demo:basic-kinds`。消费端通过公开 `nnanything` 与 `nnanything/browser` API 加载、编译并执行真实保存图。默认先跑候选七节点，再跑基础种类节点。默认 fixture 是合成观测，包含重复项、缺测、冲突和排除项；没有站点名称规则。

已有候选批次可用 `npm run demo:basic-kinds -- --input /absolute/candidate-batch.json`。输入是现有 CandidateBatch，可在根增加 itemObservations 数组。脚本只读输入并输出 JSON，不写样本，不触发浏览器操作。

算法与输入语义见 [分层连线](../../docs/basic-kinds-wiring.md)。完整判断可通过 `classifyBasicKindBatch(input)` 取得；消费端为便于阅读只打印主类别和路径。`classifyBasicKind({tag:"input",role:null})` 可独立查看先判 control、再在缺 type 时弃判的结果。单节点诊断没有候选资格含义。

数字为未校准的手写支持分数。此处不报告准确率、不实施训练，也不把未知或排除当成训练负例。旧微博快照缺少可见性测量，必须保留原候选未知状态。
