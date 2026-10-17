# 当前任务

2026-10-17未知项采集与共性审计：用户确认重载后小红书卡片标注已恢复。实站当前观察到24个container框，以及43image/66link/66text等第一层标注；一键收集与实际下载成功。前序“等待重载”已结束，下面保留修复历史。用户随后要求收集未知、检查原因和分类，补充各页都有分割／包装容器的共性。

本轮只做数据采集／只读诊断和标签提议，不改产品代码或运行图。复用已闭合的4N3E browser-visual-overlay与1N0E browser-capture图。小红书首页251未知、知乎回答页302未知+1冲突，共554条已导出并保存在本地training/samples/browser-unknown-20261017（Git忽略）。公开提取器与prepare读取全部请求成功，保留553 unreviewed+1 ambiguous，进入训练0条。当前微博首页未打开审查器，本批不声称覆盖微博或其他标签页。iframe/shadow内部也不声称覆盖。

两页共333条带子元素的包装／分组候选、4条根包装、78条SVG根、84条SVG绘图primitive、28条直接文字DIV、18条空／装饰叶节点、8条当前DOM匹配不唯一、1条combobox冲突。546条只读DOM证据唯一匹配，8条保留待定。分类提议单独保存，不自动黄金化；333条包装候选中109条pointer样式，需复核交互／列表／富文本边界。用户所指包装／分组原则上复用container，真正分隔线与之分开，不新增类别。

公开分类器回放确认：145条中性多子DIV缺少repeatedChildGeometry与inVerifiedListParent，未知区间阻止确定分类；仅在诊断中假设二者false，145条均转为judged/container。假设未写回原始样本，不能作为实际测量或准确率。单子DIV、SVG、直接文字DIV还分别暴露局部结构、图形和文字wire不足。全部逐条提议、引用与原因、原始包、诊断干预记录和统计在本地同目录README/summary中。尚未训练或应用profile；后续先补输入／wire设计，再用确认标签回归，不能用所有DIV硬判container。

2026-10-17后续实测修复已交付：用户已在内置浏览器加载扩展，小红书首页宿主与面板实际运行，但帖子列表无框。只读页面检查与点选确认card子树candidateStatus=unknown、无wire且采集禁用，首次偏离是live-dom.clippedBox对任意transform的否决。实际卡片均用2Dmatrix平移排列；未改权重、站点class或workflow拓扑。

真实几何快照1165元素、30卡片（24视口内、6视口外），公开四节点回放修前0卡片框、修后24个container框；feed后代合格9→377、judged0→191（container24/link64/image44/text59）。这不是第二层post.card语义识别。只接纳单位线性分量的computed2D平移，其他变换仍未测定。新增红测先复现identity被拒，再通过8项基础测试与全96项；真实浏览器fixture验证平移IMG判断/可采集及260×90→220×75的精确父级裁剪，scale区域仍unknown禁采集。外置证据browser-translations。

实现提交8e27ec2已合入main并推送，正式目录build:extension成功，工作树/分支和临时HTTP服务已回收。用户随后已在原扩展管理界面正式重新加载、刷新并重开标注，实站结果与采集已在上文记录。没有绕过内部管理URL限制。原样本矩形、旧模块反向复现、更新后回放和真实fixture构成这次根因证据。无需新增全局规则或受管记忆；通用规则已要求真实入口验收，必要回归落在测量owner测试和复现页面中。

针对该用户实测缺陷的独立局部复核，conversation5ec7c619-4683-4db1-bea0-c01cacce4308、实际gemini-4-argon-medium，SUCCESS/exit0、findings=[]，统一controller判pass。结果见docs/reviews/gemini4-browser-translations-review.json。原代码整体review不冒称覆盖新缺陷，局部复核不重复未改的整体架构审查。

## 初始扩展交付记录（历史）

2026-10-17：当前增量为 Chrome/Chromium 本地页面标注与采集扩展。基础训练已交付，下面保留其证据。扩展实现已完成作者验证，独立 Gemini4 整体 Review 无 findings，宿主按统一 schema/controller 判 pass。实现提交3e2374f已合入 main 并推送，主目录 npm ci 与 build:extension 成功；本轮工作树/分支、临时HTTP进程和child home已清理，证据保留。尚未安装进 Chrome，因此不能称已完成真实站点的扩展入口验收。构建产物 `artifacts/chrome-extension`，本地 consumer `artifacts/overlay-harness`，安装与使用说明 `extension/README.md`。4N3E 标注图与1N0E采集图实际绑定0.1.0，复用 Flowed 与现有 compiler/runner；浏览器入口不导入 Node fs/训练后端。第一层分类器和旧黄金数据不改。

用户已明确授权“加载到 Chrome 并验证”。实际打开 chrome://extensions/ 被浏览器工具URL安全策略拒绝（只允许http/https，且明确禁止换通道绕过）。未使用原生界面/CDP/其他浏览器绕过。已交具体加载目录，请用户手工加载并回复“已加载”，随后继续微博真实入口验收。此处是工具访问限制，不是缺少用户授权；不重复询问安装许可。

结案独立经验审计 `d4d519c6-0101-4000-b9d6-5e3af6168367`、实际gemini-4-argon-medium，SUCCESS/exit0。报告覆盖需求、红绿测试、真实下载、截图、代码review及适用规则链；无需新增规则、Skill或受管记忆，仅更新过程笔记中的交付/清理状态。报告在外置 `browser-overlay/audit/response.txt`。源码交付已收口，Chrome安装与外站验收仍待上述用户手工步骤。

整体 Review 使用独立 conversation `1f296c38-8c06-4b4b-85e2-90917eebdfe2`，实际 `gemini-4-argon-medium`、SUCCESS/exit0。结果见 `docs/reviews/gemini4-browser-overlay-m1-review.json`，原始事件与宿主裁决见外置 `browser-overlay/review`。当前源码/本地consumer审查不扩展为已安装Chrome或外站验收声明。

Chrome 本地测试页实际遍历2714个顶层元素，验证分类色框/标签、仅未知筛选、点选与单项确认/仅标错/纠正类别/待复核/other理由、未知批量去重且不覆盖人工复核、Focus子树7候选与失效清框/禁采集/同元素恢复、Escape取消、局部滚动刷新、动态增加50元素以及关闭后宿主不重挂。生成实际下载包32行：verified1/rejected1/unreviewed30；公开提取器输出训练请求后，training.prepare只接纳1行，未复核进入训练0行。截图和原始下载引用见外置 browser-overlay/note.md。导出只请求浏览器下载，不谎称磁盘落盘；实际落盘另行验证。采集不自动训练，class/id/文字只进证据。

作者检查：95测试、两种typecheck与真实浏览器bundle通过。公开图consumer含overflow裁剪框、状态属性推理/训练一致与稳定引用恢复；2501行导出通过。消融UI重复API声明、构建resolver与缺依赖假成功、提取器fallback/force、图版本静默升级。修正默认纠错标签污染、页面文字innerHTML插值、显示筛选逻辑、旧帧采集、错误反馈和关闭后迟到回调。自动化文件上传因ChatGPT扩展未获file URL权限被拒，未改权限或绕过；权重解析正反例已由API测试验证，真实文件选择加载仍待人工验收。当前仅顶层文档，不深入iframe/shadow，不证明遮挡像素可见性。外置过程唯一目录 `/Volumes/Intel/playground/nnanything-runs/browser-overlay`。

2026-10-17：六节点离线训练已实现，作者自检、独立 Gemini4 整体 Review、main 集成构建和远端推送均完成（实现提交33b1726）。公开入口为 `nnanything/training`、`npm run demo:training -- --handwired-root <源码根>`。使用真实 Handwired Circuit 求值、反传与 Adam；保留分层 wire、缺测区间、来源闭包与单标签边界。通用核心未加入站点分支。当前图六节点六边、绑定 0.1.0，DAGpipe validate/inspect 成功。88 个测试、typecheck、四个旧公开 consumer 及训练 consumer 通过。主树公开接口回载增量权重，357确认标签中356匹配，2未定标项不计分；其中309已知细类有308项judged，48个other标签匹配但仍unknown。

独立 Reviewer conversation90507fad-92d6-4814-9de2-71ce301cf8b9，实际gemini-4-argon-medium，SUCCESS/exit0，findings=[]。宿主复用统一 classifyReviewOutput 与 schema/scope 合同裁决pass；CLI response附有工具元数据，采用原始result.structured_output，不删改审查字段或放宽schema。完整审查结果见docs/reviews/gemini4-training-m1-review.json，外置原始事件与controller回执保留。

结案独立经验审计conversatione03e4b13-4f54-4327-9560-fe5bf3b71fa9已完成SUCCESS/exit0，覆盖实际技能链、项目规则、原始实验、审查与资源回执；无需新增全局规则或记忆。浏览器调度延迟、CUA返回截断和worker提前退出已纠正并在外置note记录事实，不将单次问题扩成长期门禁。两个worker临时home已移除，事件/结果/笔记保留。审计正文与最终工作树清理回执位于外置training-m1运行目录。

已有样本试验：158 个 LLM 复核样本，properties_offline；小红书共享背景的 120 个训练样本从108匹配到120；独立来源的知乎38个从32到38。25 epochs、lr0.01、anchor0.01；18 fixed、0 regressed。实际手写 profile 起步，没有削弱基线。保存、回载及再次分类成功。只有两个来源组、无 audio/select，不能作为全站准确率。

用户后续授权跨站多页面采集验证。内置浏览器已实际访问微博搜索/正文、小红书搜索/作者主页、知乎搜索/回答，完整 DOM 分段保存，另保存微博滚动视口。原始和标注只在本地 `training/samples/training-m1/unseen`。201 个节点先复核后预测，199 verified、2 ambiguous。未参与初次拟合的新页面：原规则182/199、已训练候选184/199，fixed2/regressed0；剩12个普通div unknown、3个li role=tab conflict。18个other仅类别匹配、状态unknown，不是高置信识别。矩形与viewport相交不等于完成裁剪/遮挡资格，均为properties_offline。repeatedChildGeometry缺测仍为null；iframe内部未采到。

原始试验与回归报告：本地 `training/results/dom-basic-kinds/existing-properties-320c80ef-447e-41b3-be03-33197cd4b8d6.result.json` 和 `unseen-six-scenes.result.json`。固定首轮候选在 `training/weights/dom-basic-kinds/existing-properties-320c80ef-447e-41b3-be03-33197cd4b8d6.weight.json`。外置过程和测试证据：`/Volumes/Intel/playground/nnanything-runs/training-m1`。权重保持候选、未自动采用、未校准。

用户最新要求检验贝叶斯式增量更新。固定首轮候选作高斯锚点，仅新增知乎59项拟合，25轮/lr0.01/anchor0.01不调参；微博与小红书140项留出，原黄金158项仅回归。知乎52/59→59/59，留出132/140→139/140，旧黄金158/158保持；新页合计184/199→198/199，14fixed、0regressed、1unresolved。保留原权重与初次报告，另存incremental-map-d5f655f7-1d16-486c-87ee-c0760b8f55e0候选。代理损失+参数锚定只是MAP式近似，不是完整后验分布。实际consumer复用六节点工作流，旧黄金回归在consumer保存候选后执行，不冒充已有独立节点。详见docs/training-m1-results.md。

以下设计记录为实现前历史，当前实现状态以上文为准。

外置过程记录 /Volumes/Intel/playground/nnanything-runs/training-workflow-design。独立 Gemini4 medium Planner conversation a7ec8e02-d449-48c6-8ad8-4ce7cb8575e6 初稿存在 ReGLU 门顺序、原始分数截断一致性、来源哈希与核心 DOM 进度耦合等缺口；同会话 refined/plan.md 已返回 READY、SUCCESS/exit0。接受修订数值方案与六节点职责，结合用户 LLM 标定要求允许有证据的复核者；规范字段名以项目设计文档为准。该结果是规划，不宣称代码 Review PASS。两个 CLI 子进程已正常退出，无任务代码 worktree。

训练图已由 7N8E 更新为 6N6E，版本 0.2.0-design，去掉首版无实际校准的节点；六算子仍 0.1.0-design。DAGpipe validate/inspect 均成功；配置绑定、图引用与受影响文档本地链接已检查。没有运行模型/效果测试或声称可编译训练；源码、依赖、原始样本和权重均未改。图形源为 Markdown Mermaid，本轮未进行独立浏览器渲染验收。Git 提交与远端回执在正常交付后补记。

以下为先前已交付阶段及证据。

2026-10-17 后续需求已记录：用户要求基础闭环跑通后提供 WebUI，可视化配置和训练状况，UX 单独设计。阶段安排及 UX 交付要求唯一维护于 docs/implementation-plan.md 第 8 节。本次仅补计划，未实现训练或界面；执行拓扑未改，复用现有训练设计图，不为此文档增量新增业务 DAG。

## DOM 基础种类分层算法（2026-10-17，作者验收与 Gemini4 Review 完成）

实现提交3b6bcdd已 ff-only 合入 main 并正常推送 origin/main。主目录 npm run demo:basic-kinds 已构建并运行通过。本轮独立结案审计完成，仅发现外置验证记录有一处 pending 状态未更新，已修正；结论见 docs/reviews/basic-kinds-retrospective.md。自有任务工作树已移除并 prune，自有分支已删除，当前只保留项目主树；外置 run 记录作为证据保留。本轮代码、文档、本地种类提议样本均已交付，没有运行训练。

用户要求先按 DOM 属性性质建立清晰的分层、多条件 wire 路径，第一层基础种类先做，第二层应用组合后做；算法完成后交 Gemini4 review。独立 Gemini4 Planner 初稿平铺细类且试图放宽旧快照资格，未接受；同会话修订后采用大类→类内细类，继续保留旧候选未知。实现中将 DTO 绑定到现有 CandidateBatch 的实际 observation.nodes，并使用兼容的根级 itemObservations 数组；不改变既有观测/候选/训练样本合同。

当前新增 dom.basic_kinds@0.1.0、纯函数 classifyBasicKind/classifyBasicKindBatch、稀疏参数 profile、1节点0边工作流及公开 Consumer。连线设计在 docs/basic-kinds-wiring.md，先落图并经 DAGpipe validate/inspect，再实现。五大类 control/media/navigation/text/structure；仅在大类成功后计算对应细类。缺测 wire 使用分数上下界；无 class/id/正文/URL 输入，无训练极性，无伪造校准概率。未实现训练、Handwired 后端或第二层业务语义。

作者验收：65测试通过（原56+新增9组）、typecheck通过、原3个 Consumer 与新增公开 Consumer 均成功。缺测上界的实际故障注入使2组测试失败，恢复后通过；中性 span 的明确 role 被缺测文字支路干扰的反例已红测修复。新增 Consumer 先跑真实7候选节点，再跑分类节点；11槽位中6 judged、3 unknown、1 conflict、1 excluded，保序并保留重复。归档微博2000节点保持605 filtered_out、528 skipped、867 unknown；分类节点输出1133 excluded/867 unknown/0 judged。纯属性诊断另计，不作为准确率或合格预测。

本轮使用独占树 /Volumes/Intel/playground/nnanything/dom-basic-kinds。原始证据、独立计划与测试日志见 /Volumes/Intel/playground/nnanything-runs/dom-basic-kinds；最终 Review、交付与资源回执由该处 note.md 记录。用户新增授权采集小红书、知乎种类对照样本，原始与 teacher 记录仅本地保存，不将此视为自动黄金标注或扩大算法训练范围。

独立 Gemini4 medium Review（conversation394247f8-395b-4f57-878c-71bf0efb7972）完成 SUCCESS/exit0，findings=[]；宿主按统一 schema/scope 裁决通过。原始结果见 docs/reviews/gemini4-basic-kinds-review.json。审查独立于 Planner 和实现者，不以规划通过代替代码审查。

该次审查后用户补充两项契约：合格输入用具体类别或 other 全覆盖；各属性参与评分，不能按单一条件判死。已接受同一独立 Planner 的 scoring-plan/plan.md 合并修订：移除 SVG/hidden/presentation/hidden-input 的提前返回，增加可配状态 wire；无判别证据的状态系数显式默认0；合格未消歧项给 other，非合格槽位仍为 null。新增反例先红后绿，当前66测试通过，新 Consumer 保留2个 other 和原有非合格项。原 Reviewer 已完成增量定向复核，SUCCESS/exit0、findings=[]，宿主裁决通过，见 docs/reviews/gemini4-basic-kinds-delta-review.json。原完整审查有效范围复用，不重审未变图或核心。

本地采集已保存小红书首页1200、详情2000、知乎首页1899，共5099条返回 DOM 观测；两份小红书快照有重复背景，不是独立样本。原始证据位于 research/dom-kind-corpus，派生基础种类和组件提议位于 training/samples/dom-basic-kinds。全部 gold=false，other 不自动成为真值；返回范围与 CSS 裁剪未证明完整。明确广告标记、SVG/图片alt与知乎 input/combobox 边界已记录本地 README。新增 .gitignore 仅排除此本地原始语料目录，避免 JSONL/说明被误提交，已用 git check-ignore 验证。

## 基础规则采样能动 Goal（2026-10-17，已交付；资源回执见外置记录）

实现提交2638d17已 ff-only 合入 main 并正常推送 origin/main。主目录 npm run demo:sampling 已构建并实际生成8行合成 JSONL，回执与文件一致；原有入口与采样验收证据沿本段下文复用。私有微博规则配置保存在 training/samples/sampling-l1-weibo/weibo.workflow.json，引用主目录唯一图，已用主目录公开 API 加载编译，不依赖待删除工作树。再次运行 consumer 时可使用该配置并省略 output-root，生成新的独立目录，已有 JSONL 不被覆盖。目标内没有模型训练或活网页动作。

本轮代码、使用入口、真实样本、Review 和结案审计均已交付。最终提交/远端回执、工作树及 child home 清理核销由 /Volumes/Intel/playground/nnanything-runs/sampling-l1/note.md 记录；本项目 note 不复制第二套资源台账。

用户纠正：“我认为 filter 应该是输入以后输出各种语义分类，至于是正例还是负例，这不是 filter 的工作，而是根据语义和训练要求”。用户提出时尚无采样实现，已先暂停受影响工作并修订合同；Filter 只产语义与识别状态，训练任务组装层独立映射监督标签。原正负规则私有配置已替换，不作为现行配置执行。单项单语义、数组保序、不自动负例、隐私与保存授权边界不变。

上述修订已完成：独立 Gemini4 medium 返回 READY（01b9cbeb-e19e-4689-8048-be4b048ddb63），接受 semantic-plan/plan.md；文档与配置已改为 rules/semanticLabel → supervisionMap/expectedLabels。原图不变，复用静态检查。编排者收回原 GCM 实现 owner 后已实现纯语义内核、三节点、公开导出与四参数 consumer。补查原始 events 确认原执行者除读取与笔记外还创建了未接入 fixture 和 .keep，未实现节点或红测；这两文件已在整体 Review 后删除，纠正早期“仅读取”摘要。主动取消不等于模型后端不可用。私有观察所得结构证据由编排者核对后使用，原观察任务也已主动取消，未伪称 worker 已交报告。

作者验收：全56测试通过（原48+新8组），错误三值合取优先级的实际故障注入使语义测试失败，恢复后通过。最终规则引用格式修订后补8项采样测试与 typecheck 均通过；通用 total18、浏览器13/6槽位和新合成8槽位 consumer 成功。真实保存入口与隔离文件系统覆盖未授权、拒绝覆盖、越界、父/终点符号链接和非 ok 跳过等边界。原始日志及细节见 /Volumes/Intel/playground/nnanything-runs/sampling-l1/verification.md，不以设计通过代替运行证据。

归档微博通过同一 consumer 生成2000行。语义分类为 post.card10、post.body10、post.content10、editor.composer1；完整卡片任务映射为正10/负21/未标注1969。每行保留语义及独立监督结果、输入/证据/来源引用。全部2000行已核对引用、顺序、映射、白名单和回执，无 teacher 原始字段。产物在本地 training/samples/sampling-l1-weibo/weibo-card-structure.samples.jsonl，Git 忽略。单来源、rule_proposed，不证明准确率、可见候选资格或训练效果。

独立 Gemini4 medium 整体 Review 已结束（baa2d79f-d02e-4c9b-9544-47b0433b1f9d，SUCCESS/exit0），canonical schema/scope/classifyReviewOutput 裁决 PASS，无 P0/P1，3项P2已修正：删除未使用文件、允许空 supervisionMap 的文档对齐、实现状态措辞归位。仅文档与未接入文件变化，复用代码验收并做针对性检查。

独立 fresh OAuth gpt-6.1-sol medium 结案过程审计已完成，原文 docs/reviews/sampling-l1-retrospective.md。已按原始 events 纠正初始 fixture 贡献、移除外置 run 笔记的过时等待状态、对齐节点卡 attributes/null 声明。全局 goal-prompt Skill 的绝对禁止接管措辞与上游规则冲突，建议已保留给该 Skill owner；本项目未扩展为全局 Skill 修改，按上游权威规则执行本轮接管。不改受管记忆，不新增永久护栏或重复验收。代码 Review 原文 docs/reviews/gemini4-sampling-l1-review.json，P2处置以上文及外置 verification.md 为准。该审计完成时尚未集成，后续实际交付见本节开头与外置核销回执。

用户通过 Goal 明确授权实现已评审的 sample.match → sample.assemble → sample.save，交付公开离线 consumer、JSONL、合成与归档微博验收、整体 Review 和 main 推送。此段覆盖下方已结束设计任务的“不实现采样”限制；不扩大到模型拟合、数值特征、活页面、operation 或跨站。

本任务 owner 为当前 Goal 编排者。开工主树干净、fetch 成功，仅 main 注册；无历史活动工作树需要核销。唯一独占树 /Volumes/Intel/playground/nnanything/sampling-l1，feat/sampling-l1；过程证据 /Volumes/Intel/playground/nnanything-runs/sampling-l1。未发现 .appsdk/requirements.json，按规则跳过，不初始化控制面。

已读采样图，原图为 3N2E SESE，入口 raw_records、出口 save_receipt，复用前次有效拓扑证据。独立 OAuth gpt-6.1-sol medium 小计划已完成并接受，plan/report.md 给出唯一 schema/规则/节点 owner、公开 consumer、路径边界与验收；实现时保留原拓扑，仅升级采样版本后由文档 owner 校验一次。规则未命中/缺测/过滤不生成负例；teacher 字段只作提议与证据，学生观测显式投影。

早期派发为独立 GCM 实现与私有数据观察、AGY Flash 文档更新；后续已按上文记录回收代码和数据 owner，由编排者完成实现与作者验收。AGY 文档任务已结束。运行链路已验证，语义标签准确率仍未建立；整体 Review 与 Git 交付单独记录，不把局部完成当作总目标完成。

## 基础 Workflow 资产与目录分类（已交付历史）

2026-10-17，用户要求设计基础规则采样workflow，Review后保存为基础workflow与基础节点，并分类workflow、lib节点/filter、训练实现、样本、结果和权重。当前只交新三节点设计与既有L1路径归位，不实现新采样/保存/训练、不采集活页面。新目录和职责见docs/implementation-plan.md第2节；流程清单workflows/README.md，三张采样节点卡唯一维护于lib/nodes/README.md。

独立Gemini4计划及收敛意见记录在/Volumes/Intel/playground/nnanything-runs/workflow-library/plan/plan.md、accepted-plan.md。唯一worktree为/Volumes/Intel/playground/nnanything/workflow-library，chore/workflow-library；已有L1树在上轮清理，本轮从origin/main建立。当前无.appsdk/requirements.json，按规则跳过。

现L1的15个TS文件已归位lib，过滤纯逻辑在lib/filters，NodeDefinition封装在lib/nodes，执行核心在lib/core与lib/workflow。4张既有图及L1配置集中workflows，不保留旧src或旧图副本。新dom-rule-sampling为sample.match→sample.assemble→sample.save，3N2E，全部0.1.0-design，未实现；新图validate/inspect各一次通过。training/samples/results/weights存本地数据，lib/training与lib/nodes/trainable只存实现合同/定义，不放假TS或假参数。

作者验收：原48测试与两个公开consumer通过，编译出口及算法行为不变；code/migration-red.log保存路径移动后的import失败，修正后test/demo日志均exit0。最初GCM回报了未执行的工具文本，父任务核对src未移动后停止该PID并接管机械迁移，不把它算产品完成或模型不可用。新图/config经真实公开loadWorkflow加载且绑定一致，compile明确报COMPILE_UNKNOWN_OPERATOR；数据/结果/权重忽略而README可追踪，23份active Markdown链接检查通过。必要原始证据在本轮run。

新采样合同区分teacher名称资料与可选学生观测；匹配槽位保长保序且允许重复，正负极性明确；过滤/缺测/冲突不自动负例。JSONL每行携带任务、规则、输入及证据引用，标签为rule_proposed；来源关联交后续partition计算闭包。保存根由caller显式适配绑定，config只给相对文件名，create_new、不覆盖/追加/自动重试。训练、数值取参和真实样本生成尚未发生。

独立Gemini4整体Review已完成：新会话9f1a6ef7-a0f7-46e9-838d-cc53eeafe2c0，实际gemini-4-argon-medium、SUCCESS/exit0，canonical classifyReviewOutput核对schema/scope后裁决PASS，findings=[]。原文docs/reviews/workflow-library-review.json。基础资产提交e8ac830已ff-only合入main并正常推送origin/main；主目录从lib全新构建及两个公开consumer均成功。

独立fresh oauth gpt-6.1-sol medium结案审计完成，原文docs/reviews/workflow-library-retrospective.md。已收敛AGENTS/治理/实施计划三处旧“当前L1”授权措辞；按原始events纠正验收汇总：旧4图内容不变且复用validate证据，文字worker另对4图执行过inspect，新图validate/inspect各一次。记录实际执行，不新增重复检查规则。其他经验已有合同覆盖，不改全局Skills、规则或受管记忆。

本轮设计、目录归位、回归、整体Review和远端交付已完成，保持新采样节点未实现的边界。唯一工作树及临时执行环境的owner为本任务；最终核销回执统一保存在/Volumes/Intel/playground/nnanything-runs/workflow-library/note.md，必要原始证据保留。此新段覆盖下方L1和D0历史记录中的目录与实施时点，历史Goal/Review原文保留原路径，当前唯一真源以AGENTS及workflows清单为准。

## L1 Goal（已交付历史）

D0设计基线已合入main并正常推送origin/main；原framework-m1工作树已remove/prune且路径不存在。用户要求review/提交后生成第一阶段能动Goal并直接执行。目标提示词保存docs/goals/l1-browser-candidates.md：只实现通用执行与七个手写候选节点，输出候选引用，不接模型、训练或动作。当前在唯一browser-l1独占树实施，复用有效独立计划及设计评估，不恢复旧M1全节点任务。

本轮独占记录 /Volumes/Intel/playground/nnanything-runs/browser-l1；D0必要证据仍在framework-m1记录目录，未将取消worker算模型不可用。下方D0不实现条款为历史阶段，当前L1实施由上述最新指令明确授权；后续L2-L4仍未启动。

2026-10-17 L1作者验收完成：Node22.22.2、TS5.9.3、实际Flowed1.15.0；公开load/compile/run、三种common算子和七个dom算子已实现。项目候选图升级0.1.0，仍7N6ESESE；validate/inspect各一次通过，其他design图不变。配置与程序定义进入同一compile，不新增调度器、AppSDK占位或不必要SHA校验。

原始验收：core-expert/test-final.log 48/48（28核心、20浏览器），build-final.log、demo-common.log（total18）、demo-browser.log均成功；browser-expert/final-tests.log 20/20、final-demo.log验证13槽位页面及6槽位显式数组，重复保留、deny优先、未知不复活。必要反例和红测分别在两组run；参考verification.md汇总。依赖缓存、GCM未完整实现及Flowedautomap问题都保留原错，由对应owner修复，不削弱断言。

父任务另通过公开包入口和真实Flowed消费本地微博保存观测：2000输入→2000槽位，605过滤、528自身跳过、867未知、0确定候选。缺fragments/clipping是观测证据不足，不能据此报告识别率或精确可见；原始登录态内容未进入Git。此项补充browser-expert的纯适配证据。

独立整体Review完成：Gemini4 medium新会话a225d760-ee1c-4383-9928-d1d9a1ec1cd5，实际gemini-4-argon-medium，SUCCESS/exit0；按canonical reviewOutputSchema/classifyReviewOutput核对scope与字段后宿主裁决PASS，findings=[]。原始结果docs/reviews/gemini4-l1-review.json，过程review/。实现提交ac95c28已ff-only合入main，并正常推送origin/main。主目录npm ci、构建及两个公开consumer成功，证据main-build/main-demo-common/main-demo-browser.log；未重复运行未变的测试。

独立结案经验审计完成：fresh oauth gpt-6.1-sol medium，只读审计相关规则链、原始失败、验收与交付记录；原文docs/reviews/l1-retrospective.md。已修project-governance.md四处失效D0状态，不新增门禁。npm条件交接、规则链未完成和文档虚构示例均归当轮执行与纠正，已有规则覆盖，不晋升模型永久能力。AGY文字编辑曾未按合同使用apply_patch；记为执行偏差，不为重建编辑过程重做正确文档，不复制已有编辑规则。未修改全局Skills、全局规则或受管记忆。

L1范围已完成验收、独立Review、main远端交付和结案审计；不启动L2。资源owner是本Goal，路径为/Volumes/Intel/playground/nnanything/browser-l1及本轮临时child homes；同域仅此一树。关闭工作树、分支和临时执行环境的最终核销回执统一记录于/Volumes/Intel/playground/nnanything-runs/browser-l1/note.md；必要原始验收与审计证据保留于该run目录，原始私有页面仍仅本地保存。

## 2026-10-17 D0最终范围（最新，覆盖下方M1实施授权）

用户将本轮终点明确为架构完整/计划完整，不实现；之后才从浏览器项目开始。进一步要求可复用经验节点、DAGpipe/AppSDK治理、范围内派发按全局原则无需单独许可、能动→核心→完善→兼容四层推进，以及消融不必要SHA/校验。

产品代码任务PID76674已SIGTERM停止，控制器回执exit-15；只产生thread/turn启动，无工具改产品、无src/tests/package/node_modules。没有依赖安装、训练或浏览器动作。本轮只交文档/设计图。

origin已按用户指定配置为https://github.com/Jasonzhangf/NNAnything.git；GitHub API显示空仓库/main且当前有push权限，分支列表为空。此事实覆盖历史“无remote”。本轮按正常main合流/push回执交付，不额外SHA比较。

独立Planner的plan-refined技术方案与design-only-plan、priority-plan补充合用，后两者覆盖实施时机/阶段范围；记录在 /Volumes/Intel/playground/nnanything-runs/framework-m1。项目内交付计划已落docs/implementation-plan.md；配置、经验节点、治理分别由workflow-config.md、node-contract.md、project-governance.md唯一维护。

6项交付已有5项完成：架构/选型、配置/目录、可复用经验节点、四层计划/治理、同一Gemini4设计Reviewer增量复核；剩余main/远端提交与清理。增量报告docs/reviews/gemini4-d0-incremental-review.json返回findings=[]，实际gemini-4-argon-medium、SUCCESS/exit0，宿主核对schema/scope后仅裁决DESIGN_PASS。针对性检查：文档本地链接和diff检查通过，无产品实现；新增能动候选图7节点6边已静态validate/inspect通过。原识别10/10、训练7/8、操作7/6图未变，复用已有结果。全部图仍为design，不冒称runtime绑定或效果验证。

当前AppSDK只落治理规则，未执行控制面prepare/init；需求文件不存在按规则跳过，不建占位。后续实际入驻沿正式prepare确认合同，不将此确认扩大为日常agent派发许可。当前主线不因辅助控制状态缺失阻断。

以下为前序范围与过程，不能用来恢复代码任务或推翻当前D0边界。

## 2026-10-17 Framework M1（最新授权）

用户要求“review后开始框架和第一批必要节点搭建”，并要求GitHub选型以避免重复造轮子。此前D0实现hold由此更新为：完整设计review通过后直接实施，无需再次请求实现许可。当前设计评估已通过，开始T1共享核心合同、脚手架与红测。

本轮独占树 /Volumes/Intel/playground/nnanything/framework-m1，分支feat/framework-m1；开工前只有主树注册，nnanything工作树目录为空。无remote，使用唯一集成main，不创建远端。独占记录 /Volumes/Intel/playground/nnanything-runs/framework-m1。Opus计划调用因RESOURCE_EXHAUSTED失败；按同源后备由独立Gemini4 medium规划（conversation 29d9463b-7c16-4ff3-9585-3dc8d2519468），接受plan-refined/plan.md。独立Gemini4medium设计Reviewer conversation64c8e121-d79f-47d0-b7bb-99fe0c2f24cd返回findings=[]，SUCCESS/exit0，宿主schema/scope校验后裁决DESIGN_PASS。原始结果docs/reviews/gemini4-framework-m1-design.json，不代表运行已验收。

候选：DAGpipe CLI静态图治理 + Flowed1.15.0异步依赖执行；不接Rust桥，不另写scheduler。源码证据见research/workflow-engines.md；当前产品范围和配置草案见docs/framework-m1.md。真实网页动作不在M1，首个实验target须由可测输入支持，不冒称organic/广告识别已可分。旧数值草案仍待适用性审计。

本地GCM观察已完成（实际子进程18139，exit0，报告位于本轮observe/report.md）；确认DAGpipe0.1.1无TS绑定及CLI执行，Handwired是零依赖单TS文件，支持真实前向/反传。只读观察不证明运行、效果或桥接性能；不采纳其范围外Rust consumer建议为M1前置。

以下记录为前序设计基线及历史证据；与上述最新授权冲突的D0停止条款不再作为实施hold。

目标：先定义通用框架，再确定最小基础节点，搭建网页与训练workflow，后续扩展其他场景。以有类型事件I/O的filter为节点，通过节点接续组合统一workflow；画布是可选呈现。正式应用、数据准备与训练共用合同。核心只提供端口、连线和有限DAG执行，不固定DOM/微博业务；黑白名单、DOM拆分、判断、operation均由使用者搭建。业务状态显式传递，操作后新观测验证，结束事件收束单次执行；下一次触发是新run。训练只处理目标节点I/O、参数及损失/后端合同。DOM是首应用，神经节点首期单标签且数组保序。class/id、账号名、完整URL/图片名、绝对根路径与全局深度不输入学生模型，标注/原始证据与其隔离。

当前阶段：2026-10-17用户最新指令要求先完成整体规划设计，再由AGY Gemini 4整体评估/review，之后再决定推进。已停止实现。Git已初始化、本地main有设计基线，无remote。未提交的package/tsconfig、架构与测试草稿已归档到 /Volumes/Intel/playground/nnanything-runs/project-scaffold/unimplemented-scaffold-draft.tar.gz，未合入main；唯一外置worktree和自有分支已清理。没有src实现、依赖安装、采集、标注或训练。此前为脚手架启动实现早于用户期望，已纠正为设计优先；本轮不再实现。

## 已有材料

- docs/canvas-events.md：修订6的最小事件合同与可选呈现、基础节点能力、状态与执行进度分离、判断与操作闭环示例。只规划基础节点，不做UI、消息中间件或独立复杂状态机。新增事件/层级拆分/操作设计尚未纳入Gemini整体复核。
- docs/node-workflows.md：修订6的统一架构；第6节明确框架→最小节点→网页与训练workflow的三项交付和验收。区分通用/场景/训练节点，两条workflow通过目标节点I/O与兼容profile对齐；后续场景按需增加节点及适配器。项目图规模未变：识别10节点10边、训练7节点8边、操作闭环7节点6边；operator仅设计引用，尚无实现/注册或运行时接入。执行后端适配仍须审查，未恢复实现。
- 修订5检查：修改后的识别图和新增操作图均通过dagpipe graph validate/inspect，单入口单出口且无环；训练图未变，复用上一轮静态结果。事件运行、操作行为和画布渲染均未验证；当前没有可执行实现。
- docs/focus-and-labeling.md：用户最新决定的设计增量。首期单任务单标签，数组保序；页面共享上下文→viewport/focus/deny/allow候选过滤→取参→分类。viewportOnly固定true，部分可见保留；排除当前节点不默认剪掉其后代；上下文不是额外分类目标；过滤记录不作为负例。总体设计修订3待审，修订2的Gemini4通过不自动覆盖新接口。
- 用户进一步确认：页面必须先经过一系列手写ManualFilter（viewport/focus/白黑名单），才进入NeuralNode。前者输出pass/reason，后者语义标签/分数；只读基础过滤所需观测，放行后才做完整取参与网络计算。
- docs/reviews/gemini4-design-review.md：用户指定AGY Gemini 4整体设计Review。新独立conversation 528f539f-1599-4673-83e1-9926c4d84689；首轮5P1+1P2，修订2后同Reviewer复核findings=[]。两轮SUCCESS/exit0、实际gemini-4-argon-medium，宿主校验schema/scope后裁决仅设计通过。原始结果已存docs/reviews/gemini4-design-v1.json和v2.json；不代表实现/训练验收。
- docs/design.md：最新总体设计入口，覆盖目标/目录/核心合同、两层建模与两阶段训练、teacher标注、监督回放与开发/测试/训练框架。D0设计评估后仍等待用户决定，不自动进入D1实现。
- research/github-semantic-anchors.md：2026-10-17 GitHub 只读调研；WebUI 主参考基础成分和采样，Web2Text 参考块/边证据与结构对照，Mind2Web 参考操作证据。实际解析 WebUI 一个公开 AX 样本，328 节点；没有运行第三方模型或下载完整数据集，业务标签仍需本地标定。
- research/compositional-recognition.md：整体与成分共生，关系直接入参；第一阶段使用可测关系，第二阶段再加入父子/兄弟预测摘要。第二阶段训练与有限推理轮次分开。
- research/semantic-query-contract.md：固定 target 分类、within 作用范围、one/all 查询、结构化返回与纠错；运行时搜索不依赖 LLM。中文描述仅解释用途，不作为匹配输入。读取值和动作与语义查询分开。
- 新增显式分类 post.card.advertisement、post.card.promotion、post.card.recommendation；识别保留具体节点及当前任务单标签供操作，不能只作为 organic 负例丢弃。旧研究中的多标签不属于首期合同。推荐不自动等于付费广告或商业推广，未知标签不强行变负例。
- research/browser-semantic-modes.md：最新上层设计；两种模式、共享观测目录、多目标标签与边界、错误归因、旧新样本重拟合和独立黄金回归。两张流程图是设计图，不是 Handwired 内部数值连线。
- research/filter-wiring-audit.md：当前待审的稀疏数值连线与通用单轮反馈更新设计。拟议 10 个输入、10 个系数与 bias；Handwired 求连续分数，宿主做 sigmoid、损失和校准。
- research/weibo-filter/snapshot-001/：原始渲染 DOM、同次节点测量、随后捕获的视口截图。
- research/weibo-filter/seed-labels.json：15 个初始标注，3 正例、12 负例。包含平台广告和用户确认的商业推广；多数初始标注仍待复核。
- research/weibo-filter/user-visual-labels.json：用户截图确认的购物促销、科普荐读、社交推荐负例；后两张尚未关联到归档原始 DOM 节点。
- research/weibo-filter/visible-differences.md 和 visible-marker-comparison.json：当前可见差异。社交推荐在作者 header 前有约 33px 来源栏；作者资料区粉丝数不能混淆为来源栏。

## 当前设计与未知

用户确认推广范围包括科普/新闻荐读和“某某关注了”的推荐，不仅是付费广告或商业文案。要比较容器中实际呈现的标记后再选特征。少样本高效果是待测假设，不预设准确率。

推理与训练节点职责分开，workflow合同与执行基础共用。首轮采用旧训练回放集与新训练样本重拟合，独立黄金集与新留出批次验收。顺序贝叶斯更新保留为另一路径，拟议对角高斯/拉普拉斯近似，不与全量回放叠加旧证据。新增标签与更正已吸收标签分开处理，后者不累计矛盾证据；校准不替代分类纠错。未训练点权重不冒称贝叶斯后验。

每次操作进入样本池；LLM 按操作链回溯失败、引用证据、区分失败 owner，选择性入集。保留成功样本供核实后回归。候选版本逐例比较 fixed/regressed/unresolved/retained/unassessed，并分别报告开发回放和独立回归。离线预测回放不重复真实网站动作，也不证明动作成功。只有输入足以判别时做参数修复，否则返回特征/连线审计。上述机制均为设计，尚无实际运行记录或版本比较结果。

来源槽位是否使用纯几何，还是允许固定 UI 标记词/局部图像识别，是用户审计项。图片广告没有 DOM 文字，不能声称 textContent 能识别它。纯几何和有限样本尚未证明足够区分所有来源状态。

两张当前数值/更新图已做文本单入口单出口与无环检查；未单独渲染验收。无算子性能、学习曲线或分类效果数据。

## 独立规划与资源

记录目录：/Volumes/Intel/playground/nnanything-runs/filter-wire-audit。
Opus 5.5 medium 实际因配额耗尽失败；按既定路由改为 Gemini 4 Argon medium，独立 conversation a30e71c9-05d0-4af1-a470-20804f27e544 完成初稿和修订。初稿有未经测量的性能宣称及硬门零梯度问题，未采纳；当前用户审计稿已删去这些问题并压缩候选输入。外部进程均已退出。

下一动作：将修订6的框架→基础节点→两条workflow顺序、事件/可选画布、单标签/focus及可选层级拆分统一纳入下一轮整体设计评估；当前不为每次讨论增量单独派review。执行后端和具体端口合同在实现前收敛。本轮不进入D1或恢复实现。旧10输入图只为卡片待审草案，各目标实际数值连线仍需后续审计。项目无remote，不猜测或创建远端。
