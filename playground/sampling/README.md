# 基础规则采样公开 Consumer (playground/sampling/)

本目录提供基础规则采样流程的公开离线 Consumer 实现说明与运行规范。

## 1. 核心流程与职责

采样 Consumer (`playground/sampling/demo.mjs`) 演示标准公开工作流调用契约：
1. **加载配置与图**：使用 `nnanything` 公开 API `loadWorkflow` 读取持久化配置 `workflows/dom-rule-sampling.workflow.json`（解析本地图 `dom-rule-sampling.graph.json`）；
2. **编译绑定**：调用 `compileWorkflow`，提供三类采样节点定义与显式副作用授权：
   ```js
   import {
     sampleMatchNode,
     sampleAssembleNode,
     createSampleSaveNode,
   } from "nnanything/browser";

   const compiled = compileWorkflow(workflowDef, {
     nodeDefinitions: [
       sampleMatchNode,
       sampleAssembleNode,
       createSampleSaveNode({ allowedRoot }),
     ],
     grantedEffects: ["filesystem.write"],
   });
   ```
3. **有限执行**：调用 `runWorkflow` 处理输入事件 `raw_records`，完成确定性语义规则分类、单任务监督映射与安全持久化；
4. **双向核对**：检查 `result.status === "completed"` 与 `save_receipt` 事件，回读生成的 JSONL 文件并逐行解析，校验行数与回执 `counts`（positive、negative、unlabeled、conflict、excluded）完全一致。

## 2. Consumer 命令行运行规范

运行命令：
```bash
# 默认运行合成脱敏样例数据并写入 training/samples 独立子目录
npm run demo:sampling

# 显式指定输入、配置、工作流根目录与输出根目录
npm run demo:sampling -- --input <normalized.json> --config <workflow.json> --workflow-root <repo-or-enclosing-dir> --output-root <existing-dir>
```

参数契约：
- `--input <path>`：标准化 DOM 原始记录 JSON 文件路径（格式符合 `sample/raw-dom-records/v1`，缺省为 `playground/sampling/raw-records.fixture.json`）；
- `--config <path>`：采样工作流配置文件路径（缺省为 `workflows/dom-rule-sampling.workflow.json`）；
- `--workflow-root <dir>`：`loadWorkflow` 的 `allowedRoot` 检查根目录（缺省为当前仓库根目录 `<repo>`；显式传入外部包含目录时，可包容外部私有配置与仓库内标准图文件，无需拷贝图）；
- `--output-root <dir>`：调用者显式指定的已存在输出根目录（缺省为 `training/samples/` 下新建的独立目录）。

> [!NOTE]
> 合成 consumer 与归档微博 consumer 均已实际执行并回读 JSONL。具体结果与 Review、交付状态见仓库 `note.md`。

## 3. 安全隔离与数据底线

1. **排他创建与路径安全**：
   - `createSampleSaveNode({ allowedRoot })` 强制要求 `allowedRoot` 必须为已存在的绝对规范路径；
   - 写入路径必须为相对路径且通过组件级防逃逸检查，严禁绝对路径、NUL 字符、URI 协议头或 `..` 越界；
   - 检查已有路径组件，严禁父路径符号链接与终点符号链接；
   - 采用 `wx` 独占排他写入标志，目标文件已存在立即拒绝，不追加、不覆盖、不静默重试。
2. **并发与故障边界**：
   - 调用者必须在外部控制 `allowedRoot` 目录，防止并发进程置换目录；
   - 不确定 I/O 故障时显式暴露为失败，不伪造成功回执；故障时允许磁盘残留部分文件，不提供隐式回滚事务。
3. **学生特征严格剥离**：
   - 学生观测仅允许白名单字段（fresh `tag`、`role`、`parentRef`、`rect`、`clippedRect`、`fragments`）；
   - 原始 classList、id、账号、正文、URL、绝对路径与全局深度严禁流入学生特征。
4. **脱敏与真实数据约束**：
   - 文档与提交样例仅使用通用占位符（如 `card.structure.sample`、`synthetic.card.*`）；
   - 真实网页采集数据、站点私有标注规则与生成的样本文件仅存留本地，严禁提交或公开。
5. **状态诚实性**：
   - 标签来源标记为 `labelProvenance: "rule_proposed"`，提议不自动升为黄金真值；
   - 最终交付与测试通过证据由 parent 统一维护于项目 `note.md`。
