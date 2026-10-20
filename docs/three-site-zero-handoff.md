# 三站 DOM 识别任务交接

交接日期：2026-10-19（America/Los_Angeles）。状态：主目标未完成；本文件是本次交接快照，不替代进度唯一入口 note.md。运行中的 worker 可能继续产出；接管时只刷新相关进程和结果，不重跑已有有效证据。

## 1. 从这三个位置恢复

| 位置 | 用途 |
| --- | --- |
| /Volumes/Intel/playground/nnanything/three-site-zero | 当前唯一 DOM 开发工作树，分支 feat/three-site-zero；保留全部未提交改动 |
| /Volumes/Intel/playground/nnanything-runs/three-site-zero | 独占任务记录；先读 goal.md、note.md，再读其引用的当前 Plan 与结果 |
| /Volumes/extension/code/NNAnything | canonical 主树、原扩展产物与本地样本／结果／权重所在地；不在这里接管代码开发 |

本机 main 与 origin/main 当前指向 3336c72。工作树 HEAD 为 6cdcbc6；相对本机 main 落后 3、领先 5。这里没有重新查询远端，不能把本地引用当作本次远端推送回执。DOM milestone 尚未整体 Review、合入 main 或推送。

其他 CLI 工作树 /Volumes/Intel/playground/nnanything/cli-property-migration 不属于本任务。R 设计已由 peer 落入 main 的 3336c72，不重复修订或覆盖其共享合同。node_modules 是现有符号链接，不删除、不另建工作树。不要 reset、restore、stash 或批量清理当前 dirty 状态。

## 2. 已沉淀的架构与固定流程

| 唯一 owner | 已有内容 |
| --- | --- |
| [AGENTS.md](../AGENTS.md) | 目录写入边界、adapter/filter/node/training 分工、第一层／第二层边界、显式 I/O、焦点和缺测保护、推进与治理 |
| [设计 Skill](../.agents/skills/nnanything-design/SKILL.md) | 四元素、harness 与学生责任、内部数值 wire／外层 DAG、可辨反例、独立评价、实施准入 |
| [训练 Skill](../.agents/skills/nnanything-training/SKILL.md) | 真实 DOM 采证、未知分层、owner 路由、真实拟合、回载、计时、回归和文件权重验收 |
| [增量方法](../.agents/skills/nnanything-training/references/incremental.md) | 按层／目标／wire 名迁移、显式零地址、冻结、缺测和黄金／留出隔离 |
| [总体设计](design.md) | 通用事件与节点核心、语义目标、外层 workflow 与 Handwired 内部数值图的区别 |
| [浏览器合同](browser-overlay-m1.md) | 前景／裁剪／命中证明、采集、overlay、文件权重与资源生命周期 |
| [分类连线](basic-kinds-wiring.md)、[优先级分类](priority-classifier.md) | 第一层通用种类、显式评分、缺测区间、阶段与支持路径 |
| [训练合同](training-workflow.md) | 六节点训练 I/O、真实数值后端、损失、拟合和报告 |
| [进化合同](model-evolution.md) | 使用采样、候选隔离、独立评价、旧能力回归与采用条件；设计不等于全部已实现 |

固定职责：adapter 观察真实事实；filter 做纯资格／语义判断；node 封装公开 I/O；workflow 连接步骤；training 拟合并评价。扩展供用户验收，Agent 直接通过内置浏览器取得 DOM。通用核心不加入站点类别。跨节点 DAG 连线不自动反传；Handwired 数值图另行维护。

现有图继续复用：workflows/dom-candidates.graph.json、dom-basic-kinds.graph.json、browser-visual-overlay.graph.json、node-training.graph.json，以及设计／模型进化图。本次交接未改变拓扑；没有新建执行引擎、注册表或治理图。

本次补齐了 AGENTS 的文件权重约束和易过时状态的归属；训练 Skill 补齐直接采证、未知分层、旧新配对、文件源验收及失败实验处理。设计 Skill 的固定流程已经完整，本次没有复制或重写它。当前补充仅在本地工作树，不能说已合入 main。

## 3. 原目标和不可降低的交付条件

完整目标以外部 run 的 goal.md 为准：完成微博、小红书、知乎第一层 DOM 识别闭环。需要解决当前范围的分类未知、冲突和观测未知，保留键盘焦点、阅读、状态和交互目标；完成跨页留出、原黄金回归、真实训练计时、旧新比较、文件权重验收、整体 Review、main 集成推送与资源清理。

不得删节点、强制 ignore/other、伪造缺测、降低门限、改黄金标签或隐藏错误忽略来清零。父项被排除不删除后代；兄弟不归并。学生输入不用原始 class/id、正文名称或完整 URL。未读 iframe/shadow 内部仍是未覆盖。

样本、原始页面、teacher 证据与权重留在 canonical 的 training 既有本地忽略目录。候选保持 uncalibrated/not_applied，直到实际验收满足。历史 Review 只覆盖当时范围，不是当前 milestone 的 PASS。

## 4. 最近有效页面结果

实际入口：run/readonly-capture-entry.mjs，真实 document 加同次 computed-style 缓存，调用 observeLiveDom，再走公开候选／分类 workflow。不要用 run/readonly-capture-cached-entry.mjs 或 cached-dom-reader.mjs 做验收；旧 facade 遗漏 compatMode、scrollingElement、namespace 和必要 CSS 字段，曾产生大批假观测缺失。保留失败证据，不把该包装入口问题说成产品权重退化。

证据：run/perimeter-standard-xhs-detail-wb-video-xhs-search-zh-article-wb-home-parent-preflight.json。7214 个原始槽位，1390 个合格候选，合格项分类 unknown=0、conflict=0，另外 10 项资格观测未知。

| 场景 | 合格候选 | 观测未知 | 未解项 |
| --- | ---: | ---: | --- |
| 小红书详情 | 156 | 0 | 本次快照未见未解项，不代表全站覆盖 |
| 微博视频 | 245 | 6 | 629/630、656/657、683/684 的 PNG 覆盖证明 |
| 小红书搜索 | 241 | 3 | USE362/403 的 outline 内部域；USE779 的零 opacity 祖先 |
| 知乎文章 | 299 | 0 | 本次快照未见未解项，不代表全站覆盖 |
| 微博首页 | 449 | 1 | DIV410 与 IMG413 的图片资源／覆盖证明 |

这些索引只用于该次快照定位，不能作为后续页面永久身份。原始样本在 canonical training/samples/three-site-zero/direct-{scene}-perimeter-standard.json。

run/perimeter-transition-audit-result.md 完成 5383 个可配对项比较：9 个 USE 从 unassessed 变为 visible，再成为合格 ignore；没有观察到匹配项旧已知非 ignore 变 ignore，也没有 occluded 变 visible。微博首页有 821 个旧项、824 个新项未配对，另含 3 个动态新增项；它们保持 unassessed，不能据此宣称完整旧已知保留或准确率提高。

以上结果早于本轮 outline／SVG 预处理修复的原生验收，不能提前改成新结果。

## 5. 权重与训练：已知失败、禁止自动续跑

五场景显式开发基线文件：

/Volumes/extension/code/NNAnything/training/weights/three-site-zero/toolbar-real-fit-24cell/three-site-20261019194017792-93975-abe88de9.weight.json

这不等于已证明用户安装态采用了该文件。公开 consumer 每次显式读取文件，未采用新的实验权重。浏览器文件句柄／扩展真实入口仍需按浏览器合同完成验收；已有单测和 Node 文件读取结果不能替代安装态证据。

当前数值结构为 81 wires／308 cells。固定形状实验选中 20 个地址、冻结 288 个；新增焦点／图形的 4 个地址为零且冻结。actual-schema parity 已通过，旧 423 行公开结果及旧 424 行诊断端点一致。焦点图形的两个开发样本已准备，但新焦点参数尚未训练，不能称焦点误忽略已修复。历史黄金基线为 357 行中 274 项严格正确、83 项原有未解；本轮候选尚未完成黄金评价。

G4 已失败。证据为 run/objective-ray-g4-result.json、objective-ray-g4-details.md、objective-ray-g4-result.md：

- red：13 行，256 轮，10/13 正确且 judged，仍有 3 项严格残差，288 个冻结地址不变。
- green：第 1 轮选标量 69.84372974691512、6 次 trial；第 2 轮报 no positive scalar proposal，仅完成 1 轮。
- restored red：按停止规则未运行。
- 实验计算合计约 1.170445417 秒，257 个完成轮次，3354 梯度行轮，6812 数值行处理，13 次终态分类；包含失败工作，不含 Agent 分析／等待时间。

首次 red 报告将筛选后索引与完整数组错配。后来按参数地址从同一个已保存 profile 修正统计，只继续 green，没有再拟合一次 red。保留原错误回执与修正记录，不改写实验历史。

独立 run/objective-ray-failure-plan.md 已确定一个另行缺陷：普通 scalar=1 虽已评估，未达标时却未进入 selection.best。它不单独解释第 2 轮失败。不得直接加 fallback、改动量或继续训练。先按该 Plan 做一次公开 inspector 状态重建，取得实际第二状态的梯度、动量、方向、曲率和 box limit；不得调用 fitBasicKinds，包括零轮拟合。

GCM 已准备 run/objective-ray-failure-diagnostic.mjs，prep result 明确 SCRIPT_READY_NOT_EXECUTED；仅语法检查，没有执行或加载后端。构建 owner 释放后，接管者先读脚本与 Plan，确认尚无该次诊断结果，再按既有边界执行一次。已有结果就读取，不重复运行。G5、黄金评价和采用仍关闭。

## 6. 当前 worker 与写入责任

本表是本次实际句柄／进程检查的快照。新会话的工具 session ID 不保证可移植；若句柄不可用，检查记录的 PID、实际命令和终态事件，不能把工具超时或文件存在当作终止。

| GCM 任务 | 当前状态与权限 | 恢复入口 |
| --- | --- | --- |
| outline-green-fix | session8307 已终态 exit0；构建通过、99/99 通过，normal build／dist 已释放；不再有写入责任 | run/outline-green-fix-result.md、outline-green-fix-green.log、outline-green-fix-build.log |
| svg-nonrendered-implementation | session94470，PID57003，实测仍运行；source-first，禁止 normal build／dist 写入 | run/svg-nonrendered-implementation-task.md、events.jsonl、待产出的 result.md |
| objective-ray-diagnostic-prep | session39595 已终态 exit0；脚本已准备但未执行；没有剩余写入责任 | run/objective-ray-diagnostic-prep-result.md |

SVG worker 的 owner：observation.ts 的 optional schema／saved reader，candidate-chain.ts 的 currentViewNonrendered，live-dom.ts 仅 currentView／strict-zero-opacity／editing-context helper 与 callsite，以及 browser-candidates／browser-overlay-foundation 测试。不得覆盖 outline 的 surfaceFor／guard hunk。

outline 原 source writer 已终态。父 Agent 最初复用 numeric cleanup 编译产物跑 99 项测试，95 通过 4 失败，原证据为 run/outline-combined-green.log。green-fix 后续已完成：修正 18px 内缩的测试期望，补齐与 native 一致的 fixture contentVisibility=visible，并修复 missing backgroundColor 被当成透明的真实守卫缺口。缺测仍拒绝证明，没有削弱 SVG 命中。最新构建 PASS、99/99 PASS，证据为上表三个文件；原生页面验收仍待完成。

outline-green-fix 曾有一次 stream disconnected／自动重连，随后继续执行并正常终止。该记录不是产品失败，不需要重启或重派。

已有两个独立方案均已结束并接受：outline-interior-plan.md；svg-nonrendered-plan.md 加 svg-editing-proof-addendum.md。SVG 的 item／自身 contentEditable 保留 null；最近 HTML 宿主可信 measureContentEditable=false 可以证明 editingContextActive=false，无需重复要求不可读的 designMode=off。只有属性 fallback、事实缺测或不支持链时仍保持 null。实际焦点、负 tabindex 焦点、focus-within、编辑态、role／标签／文本、top-layer 与可见 pointer-none 阅读目标必须保留。

## 7. 接管后的顺序

1. 先接收仍运行的 SVG worker 结果。没有终态就不重复派同一项；它无权 normal build、提交、合并或推送。outline 的构建 owner 已释放。
2. 复用 outline 最新构建及 99/99 PASS，不再重新修四个历史失败。保持缺测拒绝和严格 SVG 自身命中；原生验收仍要做。
3. SVG 源码 owner 结束后，协调一次当前源码构建及新增 SVG 的受影响测试。不能用 source-ready、语法检查或旧 dist 代替新行为通过。若先运行数值诊断，当前 numeric/dist 已释放且 SVG worker 不写 dist；执行前只核对没有新构建竞争，不必重跑旧数值测试。
4. 在稳定 numeric/dist 上执行已经准备的状态重建。先读原 Plan 和脚本；它不是新拟合。根据实际第二状态证据，修 scalar=1 选择缺陷并安排必要独立后续设计；失败 G4 不自动变为通过。
5. 父 Agent 直接 IAB 重新采集小红书搜索及其余四场景。验证 outline 内部点仍用实际 USE 自身／后代命中；SVG779 只有完整零 opacity、焦点和编辑证据成立时才前置排除。保留所有原 DOM、后代、槽位与原因。
6. 用本地同构 fixture 验证负 tabindex 实际焦点、opacity0→1→0、可见 pointer-none、编辑宿主与缺测反例。不得修改真实站点 DOM 来帮助验收。两个焦点训练样本仍需后续实际拟合与旧能力回归。
7. 完成微博 PNG 六项、首页图片一项的真实证明或必要观测接入。已有 JPEG 下载和完整解码仅是诊断事实，尚未绑定运行时资源 producer；不能伪造 loadGeneration。PNG 原 SOURCE crop 与预缩放域／实际 consumer 证明缺口仍在，沿现有具体 Plan，不重新泛查 Chromium、不猜 guard pixels 或 alpha 容差。
8. 完成跨页独立留出、旧黄金与新旧逐例回归、真实拟合及文件回载。候选达到原验收再采用，不能交仍带旧权重的产物并声称新效果已生效。
9. 作者完整验收后仅对完整 milestone 做一次独立整体 Review。再组合最新 origin/main，处理 findings，合入 main、推送并核对，交付正式文件权重／扩展产物，清理本任务资源。不要把本机分支、历史 Review 或编译 PASS 当作完成。

公开复放工具：run/geometry-parent-preflight.mjs。只处理指定 stage 的已保存真实观测；新的捕获使用新 stage，保留基线文件。原生采集返回大 JSON 时在 evaluate 内 JSON.stringify，按块传出并在主机检查完整长度后解析；避免接口截断或跨对象序列化污染。节点引用只在当前 registry 内有效。

## 8. 浏览器、服务器与最后清理

当前会话 CUA 绑定为 IAB browser4。旧 REPL 变量名和句柄不具跨会话保证；新会话按工具文档初始化并从实际页面清单恢复，不猜节点索引。Agent 专用页最近由当前会话保留：知乎详情14、微博首页18、知乎留出24、小红书详情26、profile32/33/34、微博视频36、小红书搜索37、知乎文章38、焦点 fixture47、稀疏 SVG fixture48。不要关闭用户页；页面若已变化，按新事实处理。

本任务服务器 PID76107，127.0.0.1:8766，实际命令为 Python http.server，根目录为工作树 artifacts/overlay-harness，并非项目根目录。验收期间保留；全部证据归档后再通过明确 PID 清理。不要重启其他 daemon 或清理权限。

正式产物原目录为 /Volumes/extension/code/NNAnything/artifacts/chrome-extension。它不证明当前页面已加载最新源码。后台 worker、服务器和专用标签在主目标收口时回收；唯一 DOM 工作树在集成与证据归档后移除，不碰 CLI peer 工作树。

## 9. 本次交接材料的边界

本次只检查并补充本地 AGENTS／Skill，创建交接材料，接收已有 worker 的结束回执。没有为本次文档请求新运行训练、全量测试、安装、Review 或 Git 集成。文档针对性检查通过：设计／训练两个 Skill 格式有效、21 个本地链接无缺失、根目录边界检查和改动格式检查未报错。代码主目标保持未完成，当前 active goal 没有被标记为 complete 或 paused。

交接提示词位于外部 run/handoff-prompt.md。它不会自动创建会话或转移 goal。真正接管时先确立唯一编排者；先接收存量 worker，不与旧会话并行推进同一工作树。
