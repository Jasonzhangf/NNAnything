# 原生读取学习实验：设计、训练与验收汇总

设计与验收owner：Alice；执行按明确任务书交GCM；Jenny负责集成。本页汇总2026-10-25已执行的有限原生读取实验。具体原始证据在本机 `/Volumes/Intel/playground/nnanything-runs/l2-layer-corpus-20261025/`（下称RUN）。这是离线概念证据，不是正式CLI权重采用或四头完整交付。

## 1. 目标、边界和责任

Goal为在一个已绑定静态普通文件上取得前/后N个逻辑行的原始字节。学生不理解正文。真实命令为系统head/tail的`-n N FILE`，harness负责固定argv、文件绑定和观测；不得强加size→offset前置。短文件与空文件均是正常成功。根满足由真实证据确认，模型分数不作满足度。

E学习当前输入投影下的证据是否足以确认读取完成。A学习根据目标方向和E评价选择head、tail或RETURN。R的受信绑定、D的直接路径在本切片不训练，不能把它写成四头已全学会。复用l2-four-head-step 8N7E责任设计；正式编排仍归recursive-goal 3N2E。离线Python实验没有完成正式controller接入。

## 2. 输入、标签和可知性

E的12列顺序固定为：goal.head、goal.tail、goal.N/16、receipt.present、actual.head、actual.tail、execution.succeeded、execution.failed、execution.unknown、output.linesKnown、output.logicalLines/16、actual.N/16。缺测数值以presence/known位区分，不把占位0当实测空内容。

E标签顺序unsatisfied/satisfied/unknown。完整初态为unsatisfied；同目标方向的成功读取为satisfied；相反命令成功且输出行数<N为satisfied；相反命令输出=N为unknown。输入没有源文件总行数或末尾LF位，因此unknown是相对此投影而言，不能声称完整原始回执永远无法进一步判断。意外执行失败原样保留，不强行套以上正常标签。

物理内容相等与学生证据充分性分开。相反命令读恰好N行文件和更长文件，可以产生同一12维输入却有不同物理根事实，均应监督unknown。原字节oracle只评价，不输入模型。

A的5列为goal.head、goal.tail、E三态one-hot，输出head/tail/RETURN。单头训练使用已确认E监督；组合必须使用E真实预测，不让A旁路读完整回执。每头两层16/16 ReLU；E531参数，A419参数，无共享trunk、无跨argmax反传。

## 3. 数据与分区

首批TRAIN N={1,3,8}，DEV N={2,5,11}；L取去重后的{0,N−1,N,N+2}，非空分别有/无末尾LF。40文件、80Goal、128实际命令、208状态。补充56次L≤N的相反命令，得到264状态：TRAIN126、DEV138。逐行字节oracle与输入复算均有回执。

正常episode为initial→target；受控episode为initial→opposite→target。不得把正常成功历史串入受控episode。原采集48个post存在这一引用错误，原件保留，RUN/parent-native-experiment/data-curated.json已修正投影，数值输入和监督不变。恢复成绩取新执行episode，不取错误历史。

来源按文件身份和N分区，同一关联源不跨区。原内容有跨区相同字节，不能称内容独立。Astra另构造24文件、96episode作为独立构造开发证据；它不是Carol封存验证，公开后不再是未来未见集。

## 4. 已执行训练配方与结果

| 实验 | 起点与配方 | 候选选择 | 结果 |
| --- | --- | --- | --- |
| A/E初次诊断 | torch CPU单线程float32，原生Linear初始化，seed20261025；各自SGD .05，逐行等权cross entropy，最多1000步/60秒 | 每50步看TRAIN，连续3次全对停止 | A250步全对；E1000步TRAIN114/126、DEV122/138，失败保留 |
| E优化配方对照 | 同结构、数据、seed和预算，重置为同一初始权重；Adam .003，其余默认β/ε，无衰减 | 同一TRAIN停止规则，不看DEV挑候选 | E450步约0.148秒；TRAIN126/126、DEV138/138 |
| 范围增量学习 | 显式继承上行E，A冻结；旧TRAIN126行和新TRAIN330行各占loss1/2；Adam .001，重新初始化优化器；上限1000步/60秒 | 两组TRAIN同时全对连续3次，每50步记录并保存 | 150步约0.172秒；新TRAIN264→330/330，新DEV238→330/330 |

优化配方对照不是后训练；范围增量才是继承权重的后训练实验。第二配方同时改变优化器及学习率，不把提升单归因于动量，也不声称SGD必然不可用。旧权重均保留，候选not_applied。

增量TRAIN N={17,24,32,48,64}，DEV N={20,28,40,56,72}；L={0,1,floor(N/2),N−1,N,N+1}，尺度仍/16。110文件、440真实命令、660状态。旧DEV、独立评价及扩大回归均未进入拟合或停止条件。

## 5. 分层与真实行为验收

| 验收 | 实际结果与证据相对RUN路径 |
| --- | --- |
| 小样本真实闭环 | parent-native-experiment/rollout-adam.json：正常42/42、反向42/42，零伪成功、零多余读，E→A热推理P95约0.54毫秒 |
| 独立构造开发评价 | astra-independent-native/summary.json：96/96任务，E/A各180/180；132真实命令 |
| 扩大数据与固定模型 | native-corpus-v1/：N1..16，320文件、1280回执、1920状态、640唯一输入；未重训E/A各1920/1920 |
| 后训练旧知识保留 | native-incremental-v1/evaluation.json：旧264和1920两组各自全保留，零退化；分母有重叠，不相加宣称独立样本量 |
| 后训练真实闭环 | native-incremental-v1/rollout.json：新DEV正常110/110、反向110/110，零伪成功、零多余读 |
| 旧模型范围外失败 | 同一rollout：正常22/110、88次未读取即原始RETURN；反向106/110。它是原始学生错误，不是正式controller已经错误采用 |
| 断点 | parent-native-experiment/resume-check.json：SGD200→250与连续结果差0；native-incremental-v1/resume-diagnostic/result.json：Adam150→155→新进程160与连续结果参数差0、优化器状态相等；后者是scratch测试，不把160步作为候选 |

宏指标必须带逐类支持数；模型原始错误与根事实保护后结果分开。验证没有错误样本时，不宣称学习了权限、缺文件或超时恢复。有限旧回归零退化不等于所有未知场景无遗忘。

## 6. 工程及后续准入

正式Handwired后端与独立torch诊断的初始化、损失缩放、优化器及停止合同有差异。本页不把独立拟合冒充正式后端通过。2026-10-26加速/保存工程三项修复经独立定点复核通过，Jenny报告已集成并推送main 1bcd33b；回执为RUN/compute-backend-work/independent-recheck/report.md，组合树两套件37/37、对抗复核7/7。这只关闭工程finding，E数值等价与正式模型能力仍未由此通过。被终止的Astra增量分析没有最终审查结论。

当前可以继续有限数据与下一真实组合设计，不能启动任意Shell规模化或自动采用。下一切片见[搜索后读取的学习设计](cli-search-read-learning.md)。正式迁移必须显式保持输入顺序、标签和权重，单独验证前向/回载/行为；不偷偷从零重训。后训练继续旧TRAIN重放、新监督和独立评价隔离，按model-evolution既有标准决定保留或拒绝候选。

## 7. 正式接入：受信原生行读取

2026-10-26 新增公开 sandbox 操作 `file.read.lines`。目标是正式多循环模型入口的第一增量，不训练、不替换权重、不修改递归核心。

调用形状：

```ts
{
  operation: "file.read.lines",
  parameters: { ref: ObservedObjectRef, anchor: "head" | "tail", count: 正整数 }
}
```

只接受当前 sandbox、当前 session revision 已签发的 `cli.file` regular 引用。缺失 `filesystem.read` 或 `process.exec` 任一效果在打开前拒绝。固定使用 `/usr/bin/head` 或 `/usr/bin/tail -n N`，通过已验证 fd 传入 stdin，不传文件路径 argv，不用用户 shell。

`createCliFilesystemSandbox` 新增显式宿主选项 `fileReadLinesOptions`，不是语义参数。本轮回执使用 `timeoutMs=10000`、`killGraceMs=250`、`maxStdoutBytes=16777216`、`maxStderrBytes=1048576`，可选 `signal`。缺配置返回 `CONFIG_MISSING`，零打开、零启动。旧调用者不提供时不影响既有 `file.read`。

成功观测：

```text
kind: "file.read.lines"
ref, anchor, requestedCount, bytes(base64), bytesRead, logicalLines, identity, process
```

`logicalLines` 只按完整 stdout 的 LF 字节统计；非空且无末尾 LF 加 1。空文件和短文件都是正常成功。`requestedCount` 不等于输出行数。非零退出、启动失败、超时、取消、stdout/stderr 越界、流错误或 close 不完整都走失败臂，不返回部分成功。stderr 非空本身不失败。

实现边界：

- 共用 `file-content.ts` 的已验证打开函数，保留 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`、pre-open lstat、opened fstat 与 dev/ino 比对。
- 行读取在 spawn 前把 opened dev/ino 与受信 ref identity 比对；预打开阶段身份不符零 spawn。
- 子进程只由本 helper 的 lifecycle 管理，先 TERM，`killGraceMs` 后 KILL；句柄在 close 后释放。
- 不取全文行数，不按 `fstat.size` 推断行数，不做通用 shell 执行器。

验收证据：

- 红测：`tests/cli-file-read-lines-sandbox.test.mjs` 新增前，公开入口报“仅支持 cwd.get … file.read”，保存于 `red.log`。
- 新套件 17/17 通过，覆盖空/短/恰 N/长/无末尾 LF、二进制字节保真、缺效果、伪造/过期/非 regular/路径替代拒绝、abort、绑定后替换、preflight-to-open 换文件、打开后路径改名仍读原对象、spawn 失败/非零退出/signal/timeout/abort/stdout/stderr 越界及非空 stderr 成功。
- 受影响 range 回归 34/34 通过，command/binding 套件 7/7 通过，1 项因缺少最终共享候选跳过，不是新增失败。
- 构建：`NN_HANDWIRED_ROOT=/Volumes/extension/code/handwired npm run build` 通过。

本轮未完成：正式模型组合、selector 选择新操作、训练与采用均未接入；旧 range API 与模型候选保持不变。完整四头或整体模型交付不能由本切片推断。
