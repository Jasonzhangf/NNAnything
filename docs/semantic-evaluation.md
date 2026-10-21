# 人的语义评价与元素审计

## 目的与边界

本文件是 NNAnything 元素、观测、关系、行为、反馈、递归组合和 CLI 能力的“人的语义评价”唯一 owner。它回答的是：用户能否从可观察、可感知或可独立核对的事实确认语义问题，以及什么证据足以支持或否定这个答案。

这里定义评价原则、状态、证据和具名分母，不复制基础种类算法、训练 wire、样本 schema、动作执行器或模型演进规则。算法仍沿 [basic-kinds-wiring.md](basic-kinds-wiring.md)，训练仍沿 [training-workflow.md](training-workflow.md) 与 [cli-filesystem-training.md](cli-filesystem-training.md)，行为边界仍沿 [browser-behavior-framework.md](browser-behavior-framework.md)，采用规则仍沿 [model-evolution.md](model-evolution.md)。

人的角度不等于每一例必须由真人签字。标签来源必须如实记录为 `human`、`LLM`、`teacher` 或 `rule`，合成、人工复核和真实来源组分别报告。人的判据可以使用截图、AX、声音输出、焦点轨迹、原生输入回执、OS 文件回执或人工判据；只在当前 Goal 需要时使用对应证据，不要求每例同时具备截图、AX 和人工 trace。

证据按当前问题选择，不能跨问题替代。

| 评价问题 | 适用证据 | 不能单独证明 |
| --- | --- | --- |
| 对象或文字是否可见 | 同 revision 截图、可见区域、裁剪和遮挡证据 | 元素身份、可编辑性或动作效果 |
| 内容是否可读 | 实际读取结果、可见文字范围和内容归属 | 仅有 DOM `textContent` 不能证明用户实际读得到该内容 |
| 控件是否可聚焦 | 原生 Tab/键盘后实际焦点和焦点反馈 | `tabindex` 属性存在 |
| 媒体是否有画面或声音 | 当前播放区域、实际音画结果和播放状态 | poster、媒体标签或控件外观 |
| 动作是否派发 | 原生执行器 invocation、receipt 和 dispatch 记录 | Goal 已满足或没有副作用 |
| 效果是否成立 | 同一对象新 revision 的 New State 和必要条件 | 旧 State、预测值或执行成功 |
| 文件结果是否成立 | 独立 OS 属性、内容或产物回执 | CLI 文本输出自称成功 |

## 不可合并的事实

每个评价项至少分开以下问题。只有当前 Goal 明确要求时，才把多个事实组合成一个结果。

| 事实 | 人的问题 | 不能替代 |
| --- | --- | --- |
| 身份 | 这个对象是不是该类元素或该语义角色 | 可见、可操作、可交互 |
| 资格 | 它是否进入当前候选范围，缺测是否明确 | 基础类别真值 |
| 能力与资格条件 | disabled、readonly、隐藏、离屏等状态是否允许当前动作 | 元素身份或动作结果 |
| 选择 | 当前 Goal 下选中的对象、动作和参数是否正确 | 已派发或已达成 |
| 派发 | 原生执行器是否实际调用，收到什么回执或拒绝 | Goal 已满足 |
| 效果与 New State | 同一逻辑对象的新观测是否满足 Goal 阈值和必要条件 | 未来仍可复用旧引用 |
| 人的可感知结果 | 用户能否看见、听见、读到、聚焦或核对产物 | DOM/AX 属性存在 |
| 组合根结果 | 根 Goal 的真实评价是否满足 | 成员成功之和 |

分类分数、候选 `expectedSatisfaction`、真实 `actualNewStateSatisfaction`、排序偏好和 `margin` 必须使用不同名字。分数是 `uncalibrated` 时不得称为概率。`satisfactionThreshold=90` 只是某个 Goal 的要求；二元目标的实际值仍可为 `0/100`，不能改写成全模型 90% 准确率，也不设统一统计下界或零误判门槛。

## 状态口径

“已实现”“已训练”“已验证”“已采用”分别记录。当前默认采用 `dom-basic-kinds-handwritten-v2`；M1、MAP、priority、SetExpanded、F1、F2 等拟合候选保持 `not_applied`，不能因文件可加载或测试通过而视为采用。

判断项使用 `judged`、`unknown`、`conflict`，候选链另用 `excluded`、`skipped`、`stale`、`unassessed`。`unknown/conflict/excluded` 不是 `other`，也不是负例；`other` 是合格分类输入中当前 12 个具体类别之外的残余标签。预测的 `other` 不自动成为黄金 `other`。

评价事实的唯一 owner 不因合并报告而改变。

| 事实 owner | 持有的输出 | 不承担 |
| --- | --- | --- |
| 基础分类 filter | 单输入的基础类别、判断状态和评分证据 | 候选资格、动作和人的可感知结果 |
| training／dataset | 样本来源、黄金、分区、拟合与回载证据 | 把预测改写成黄金 |
| browser／CLI adapter | 可见性、焦点、命中、原生执行和 OS 观测 | 自行裁定业务 Goal |
| 领域 evaluator／operation | 当前 Goal 的选择、效果和 New State 判定 | 修改基础类别或隐藏原始失败 |
| 独立 Reviewer | 评价依据、逐例合理性和组合根事实 | 修改 gold、权重或作者汇总 |

## 基础叶类：12 类加 other

共同证据入口：[基础种类连线](basic-kinds-wiring.md)、[基础训练合同](training-workflow.md)、当前公开实现 [basic-kinds.ts](../lib/filters/basic-kinds.ts) 和 [basic-kind-training.ts](../lib/training/basic-kind-training.ts)。逐类已有计数、拟合候选、来源留出和回载状态只引用 [实施计划](implementation-plan.md) 与既有训练证据，不在此复制大表。

读表时还要区分四种常见但不等价的状态：代码存在只算已实现；真实拟合与保存回载只算已训练；独立来源、逐例结果和真实入口通过才算已验证；显式资源切换并经采用规则确认才算已采用。旧黄金与训练材料的重叠、已查看的 `eval` 集和三站 wrapper 证据都不能写成新鲜独立验证。

| 类 | 状态与语义问题 | 人的判据与证据 | 正例／反例 | unknown 与组合风险 | owner 与具体 gap |
| --- | --- | --- | --- | --- | --- |
| `button` | 已有手写分类、M1/MAP 拟合；默认未改用新候选。问“它是命令控件吗”，不问当前是否可点击 | 控件形态、角色和实际可见控制区域；禁用状态单列 | `button` 或等价命令控件；纯段落文字伪造按钮外观 | `disabled` 仍是 `button`；命中、透明层和动作效果是后续事实。gap：类别级独立留出 | filter/training owner；补类别留出与真实页面反例 |
| `input` | 已有分类和 M1 拟合。问“它是输入宿主吗”，不把可编辑能力与写入结果合并 | 输入宿主、类型和控制形态；`readonly` 作为状态证据 | 原生 `input`；只有输入框外形的静态装饰 | 缺类型可为 `unknown`，但不自动否定 input 身份。gap：类别级留出、39 参数行为设计仍 BLOCKED | filter/training 与 browser operation owner |
| `select` | 有分类路径，canonical 黄金很少，M1 未形成充分拟合。问“它是选择控件吗” | 控件、选项归属、当前选中/勾选状态分别观察 | 原生 `select` 或明确选择控件；普通静态列表 | 只看到 `selected` 属性或外观时保留缺测；选择执行另评。gap：真实正反例、独立留出 | filter/training 与 behavior owner |
| `link` | 已有分类与拟合。问“它是导航入口吗” | 可见入口、链接语义和上下文；当前位置另记 | 实际链接入口；URL 样式普通文字 | 链接身份不证明导航成功；旧引用可能在导航后失效。gap：类别独立留出 | filter/training 与 navigation owner |
| `text` | 已有分类与拟合。问“它承载文字语义吗” | 文本身份、可见直接文本、可访问名称和内容读取分开 | 有文字内容的对象；无文字且无文字语义的纯几何装饰 | 零透明、零面积、离屏或隐藏只影响当前可读性，不自动改 `other/ignore`；父容器文字不等于每个后代都读。gap：独立可见性评价 | filter/read owner |
| `image` | 已有分类与拟合。问“它是图像目标吗” | 图像载体、图形内容、加载与可见内容分别观察 | 图像载体；仅有矩形边框且不承载图像语义的装饰 | 未加载、损坏、零面积不自动否定图像载体身份；`role=img`不证明可见像素。gap：独立类别留出、媒体取值 | filter/browser adapter owner |
| `video` | 已有手写与少量样本，独立拟合和留出不足。问“它是视频目标吗” | 视频载体或播放区域；poster、播放画面和播放状态分开 | 视频目标；普通矩形或图片伪装成播放区域 | poster 不证明正在播放，也不自动否定视频身份。gap：黄金和独立留出极少 | filter/training/browser adapter owner |
| `audio` | 只有手写路径，canonical 黄金为零。问“它是音频目标或控件吗” | 音频载体或控件语义；可听输出与播放状态另证 | 音频载体；仅有音符外观但无音频载体/控制关系的装饰 | 静音或未播放不否定载体身份；DOM存在不等于听见声音，截图不能证明可听性。gap：无黄金、无类别验证 | filter/training/audio observation owner |
| `container` | 已有分类与拟合。问“它是否承载独立区域或分组语义” | 共同范围、内容归属、交互或阅读目的；几何只作辅助 | 有共同阅读/交互范围的区域；单子同矩形纯包装 | 父子同时保留可以合理，覆盖不能重复计分。gap：类别级留出和业务边界证据 | filter/relation owner |
| `list` | 已有分类但样本少。问“用户是否感知为有序或重复集合” | 集合结构、成员关系、顺序和共同范围 | 列表或明确集合；仅重复几何的网格 | 重复几何单独不定类；相邻列表不自动合并。gap：独立留出和真实页面集合 | filter/relation/training owner |
| `listitem` | 已有分类和拟合。问“该对象是否属于当前列表” | 成员身份、父列表和显式归属证据 | 同一列表成员；相似卡片或最近祖先猜测 | 最近祖先、DOM 嵌套和相同文案不足以证明 owned。gap：owned 仍为 `unsupported_scope` | filter/relation owner |
| `ignore` | 只有分类路径和实验，canonical 未训练。问“它是否缺少独立读取、交互、焦点或状态目标价值” | 后代保留、焦点、加载/重试入口、可见文字和纯包装对照 | 无独立价值的同矩形包装；可见文字、按钮、焦点、独立媒体或加载入口 | `ignore` 不删除后代；完全遮挡是候选排除，不是 `ignore`。gap：正式 retain/ignore 训练与独立复核 | overlay/filter/training owner |
| `other` | 已有分类路径、训练标签和残余语义。问“合格对象是否明确超出当前词表” | 合格观测、稳定类别边界和来源标签 | 明确不符合具体叶类的对象；缺测、冲突、采集失败 | `unknown/conflict/excluded` 不能并入 `other`；预测 `other` 不改黄金。gap：新增类别时复核旧 `other` | filter/dataset owner |

## 基础类内仍需核验的控件与组合

以下是未来属性/关系/行为覆盖目录，不是新增L1标签，也不表示当前已训练。先用已有类加显式属性、关系和scope表达；确实不可表达时，再修改词表并复核旧other与全部旧类。已有设计元素结构包含部分checked/selected/expanded等属性，字段存在不等于这些子能力已验收。

| 子族 | 最少保留的相关事实 | 人的验收与反例 | 当前gap/owner |
| --- | --- | --- | --- |
| caption按钮、yes/no/cancel、图标按钮 | 可见caption与accessibleName分开；作用对象、作用范围和上下文 | 字词/图标帮助判断意图，实际后条件证明作用；相同“确定”作用于邻弹窗为反例 | 用途/作用关系未普遍训练；browser relation/operation |
| 多行、contenteditable、富文本、不同input type | 实际编辑宿主、类型、value/内容、readonly、焦点及输入结果 | 同一宿主写入与读回；有边框但无编辑宿主、错误类型为反例 | 现InputTextValue仅普通text input设计；adapter/operation |
| checkbox/radio/switch | checked/混合状态、控件组、互斥范围及enabled | 选择后目标状态与同组其他项符合；不能把原来checked的项盲切一次 | 当前select行为未实现，混合态不能补false；adapter/selection |
| option、多选、combobox建议框 | 选项owner、selected集合、编辑/弹出关系、active选项 | 输入值与选中结果分别验证；相邻列表或隐藏旧选项不作当前选项 | 现单标签input/select交界曾有ambiguous；关系与行为未闭合 |
| slider/range/spinbutton | 当前值、范围/步长及其适用性、可操作区域、值后验 | 原生操作达到目标范围；数字显示变化不证明对应控件改变 | 细粒度字段与行为未验收；adapter/operation |
| tab/menu/tree及可展开项 | 所属容器、selected/expanded、焦点和被控制面板 | 对的面板/子项实际呈现；成员独立正确但作用于另一容器为反例 | 复用基础类，组合归属与交互另设计；relation/group |
| dialog/modal/popover/tooltip | owner、模态范围、遮挡、焦点、打开/关闭及返回上下文 | 前景对象与焦点正确；透明层拦截、关闭错误层为反例 | 部分遮挡观测已有；模态语义/关闭恢复未普遍验收 |
| 表单label、required、错误提示 | label/宿主/错误owner、值、校验状态 | 错误关联当前字段；仅有红色或附近文案不足以定错 | 关系与提交后验未实现；relation/operation |
| status/progress/alert/loading | 状态owner、真实变化、时间范围及错误/完成条件 | 进度变化与任务完成分开；spinner消失不自动表示成功 | 状态语义和有界等待按Goal设计；adapter/evaluator |
| table/grid、卡片、列表成员 | 容器/成员、行列/表头或业务owner、内容边界 | 单元格/成员归属正确；重复几何不自动构成列表或同一记录 | 结构关系可有显式证据，通用owned仍未实现；L1与L2分别验收 |
| 文件输入与上传 | 已绑定文件引用、选择器结果、表单owner、上传状态/产物 | 选中文件与服务器接受分别验证；路径文本出现不算上传完成 | 不在当前普通input切片；未来只用人类操作，参数引用不进L1特征 |
| 拖拽/放置、自绘canvas区域 | source/target、可见区域、坐标/命中、拖动前后状态 | 原生拖动改变正确对象；draggable属性或DOM事件不证明效果 | 浏览器领域需单独观测/行为合同，不借computer-use占位声称实现 |
| iframe/shadow/嵌套文档 | frame/document/scope引用、采集范围及覆盖缺口 | 只有实际读到且引用有效才使用；跨文档同序号不能重绑 | 未读内部保持unassessed，不把不可采变成other；adapter |

上述事实按Goal必要性保留，缺测用unknown、不适用用N/A，不增加全元素强制字段。checkbox等布尔或混合态需独立合同；身份不等于当前可操作，关系明确也不等于执行成功。

## 观测、资格与关系

| 族 | 当前状态与人的问题 | 必要证据及正反例 | 缺测与组合风险 | owner / gap |
| --- | --- | --- | --- | --- |
| focus | 已有部分 activeElement/tabIndex 观测。问“Tab 或程序聚焦后谁实际持焦” | 同帧实际焦点、可见焦点反馈；属性存在只是反例 | 未观测不补 `false`；焦点移除、shadow/编辑器边界未知 | browser adapter；补真实 Tab、移除和嵌套范围 |
| viewport／部分露出 | 有几何、裁剪和现场覆盖路径。问“用户能看到哪一块” | 视口、裁剪、滚动和部分面积；只看原始矩形是反例 | 未知形状不冒充完整覆盖；部分可见仍需独立价值 | overlay；补真实滚动、嵌套裁剪和 DPR 用例 |
| 完全遮挡 | 有保守证明与排除。问“用户是否真的不能看见或命中” | 完整 blocker 和命中证据；单点 hit 或 z-index 不足 | 排除项不改 L1 负例、`ignore` 或 `other`；未知保持 unassessed | overlay/browser adapter |
| retain | 目标与设计存在，正式训练未完成。问“是否值得作为独立交互、读取或状态观察目标” | 阅读、焦点、加载/重试、媒体和动作目标；纯包装对照 | 可点击不是唯一保留标准；缺测不判不保留 | overlay/training；需正式样本、拟合和采用证据 |
| owned／caption／用途 | `owned` 返回 `unsupported_scope`，内容关系尚未闭合。问“该元素属于哪个对象” | 显式 scope、同一 owner 的结构或内容证据；相邻文案和最近祖先为反例 | 关系错误会放大到 click/input/read；unknown 不绑定 | browser relation；补显式归属和真实嵌套反例 |
| 内容读取 | `ObserveExpanded` 只是最小设计方向；正文、caption、media 值未形成完整 API。问“用户实际读到了什么” | 当前 revision 的可见直接文本或媒体结果；AX 名称不自动等于可见正文 | stale、隐藏值和读取失败不能报成功；父内容不等于 owned 内容 | browser adapter/operation；补取值入口和失效反例 |

## 行为与效果

| 行为 | 当前状态 | 人的语义问题与证据 | 正例／反例 | 组合风险与 owner |
| --- | --- | --- | --- | --- |
| `click`／SetExpanded | 仅有限 SetExpanded 切片有设计、拟合、回载和受控原生验收，候选未采用 | 人是否识别同一控制入口，派发后发现真实展开状态 | 原生点击同一控制并看到状态变化；合成 DOM click 或只看 receipt | 透明层、错误控制、rerender 旧引用；single-action/strategy owner |
| `read` | 行为目录已定义，完整运行 API 未实现 | 实际取得指定内容，读取 `false` 也可完成状态读取 | 当前对象可读值；stale 或未知报成功 | 读取成功不等于根 Goal 达成；adapter/operation owner |
| `input` | 仅 39 参数设计且 BLOCKED，无样本、权重或 typed 运行入口 | 原生输入后同宿主值符合，邻输入不变 | 精确宿主和原生键盘；写 `.value` 或只报 receipt 为反例 | 文本生成、对象绑定、执行和回读分开；operation/training owner |
| `select` | 只有行为目录和 L1 类 | 真实选中/勾选状态符合目标 | 正确 option 和可见状态；只改属性为反例 | 控件/选项/状态分属不同事实；behavior owner |
| `scroll` | 只有行为目录 | 原生滚动后目标露出或到达明确边界 | 同一宿主可见范围改变；只改 `scrollTop` 为反例 | 滚动可能改变候选资格和旧引用；adapter owner |
| `search` | 只有父行为设计 | 查询实际提交，结果区与查询真实关联并满足覆盖 | 查询、提交、结果归属分别成立；输入已填但未提交为反例 | 搜索成绩不能替代父 Goal；recursive integration owner |
| `download` | 只有目录设计 | 浏览器原生触发并形成指定本地产物 | 入口、完成和文件产物分别验证；直接 URL 请求不可替代 | 采集包导出不是业务下载；browser adapter owner |
| `navigate` | 只有目录设计 | `documentRef` 改变且新页面条件成立 | 新文档和新引用；仅 receipt ok 或继续用旧引用为反例 | 导航后所有旧引用、焦点和 hit 事实重新评价；navigation owner |

## 反馈、策略与递归组合

| 能力 | 状态与人的问题 | 必要证据与反例 | 组合风险与 gap |
| --- | --- | --- | --- |
| F1 失败反馈 | 36 参数候选已拟合、回载，未采用。问“目标没变是因为无效果、被拒绝还是证据不足” | 派发、错误、前后目标状态和 effects；把任一单独事实当结论是反例 | feedback 不授予 retry；未知 effects 不能补成 none |
| F2 同效果策略 | 20 参数候选及受控验收存在，原独立报告仍为 22/24 FAIL，未采用 | 同一 Goal、对象和 scope 的真实候选；跨 Goal 分数不可比 | 两项 oracle 前提裁决和负控制单列，不重跑旧 24，不改写成 24/24 |
| 递归 Goal | 运行框架已验收，selector 仍是有限规则。问“根 Goal 是否由最新真实证据满足” | root、control、error、effects、continuation 和 satisfied evidence 分开 | 子步成功不能抵消根失败；预测或旧 state 不能反向满足父条件 |
| 多候选偏好 | 通用选择由后续 owner 定义，本轮不在此复制 | 硬条件、实际满足度、尝试顺序和显式偏好的依据必须可追溯 | 风格不得改 Goal、阈值、权限或证据；原始分数不能冒充满足度 |
| 有界双推理 | 预测推理与执行推理均未实现，设计由 [bounded-goal-planning.md](bounded-goal-planning.md) 维护 | 预测、checkpoint、真实分叉和重推演逐例轨道 | 预测 State 不得计为实际达成；图生成、执行和控制责任分别评价 |

## CLI／文件语义

当前注册切片为 `pwd`、`cd`、`ls`、`path.resolve`、`path.relative`、`path.parts`、`entry.inspect`，以及 `unsupported/DEFER/NOOP` 控制结果。共享 `cli.command-policy.v1` 为 10×30、300 参数；174 train/88 dev、262 条真实执行及新进程回载已有证据。训练报告仍为 `fullyVerified=false`，外部独立套件有限通过 56/56，并保留 5 项 `UNVERIFIED`；候选保持 `uncalibrated/not_applied`。

| 对象 | 人的问题与证据 | 正例／反例 | unknown 与组合风险 | owner / gap |
| --- | --- | --- | --- | --- |
| sessionCwd／pwd | 同一 session 的真实 cwd 是什么，`pwd` 是否只读 | harness 固定映射和受信 OS 回执；子进程猜测是反例 | 子进程成功不证明 session 改变 | CLI adapter/training；继续保留同 session 黑盒 |
| 路径词法属性 | 输入解析出的规范路径与用户目标是否一致 | `path.resolve/relative/parts` 的精确函数结果 | 词法路径不等于 physical/realpath | CLI policy；后两者尚未注册 |
| directory.entries／ls | 目录项、对象绑定和保序是否真实 | 完整目录列举和特殊名称；截断结果冒充完整为反例 | 未绑定 DirectoryQuery 必须 `DEFER`，不扫描 | CLI policy/adapter；对象查找后置 |
| entry.inspect | 普通文件、目录、特殊文件属性是否由独立观测得到 | 类型、存在性和受信属性读回 | 权限失败、断链和平台缺测不能补默认值 | CLI adapter；physical/links 等未注册 |
| 后续文件操作 | 创建、移动、删除、读写和元数据当前多为设计 | 前后独立状态、内容、部分副作用和拒绝均可核对 | 退出码不能掩盖部分写入；后续 combination 不训练层序 | CLI owner；按实施计划逐项闭合 |

## 未来占位

| 范围 | 当前状态 | 允许写的评价结论 | 未实现边界与 owner |
| --- | --- | --- | --- |
| 自进化／候选采用 | 设计合同存在，全域默认采集、统一自动采用和冲突裁决未接通 | 可评价候选提升、旧能力回归、独立证据和配对样本 | 不能从总分、历史日志或候选顺序推定采用；model-evolution owner |
| 第二层业务语义 | 不在当前运行范围 | 只可评价显式基础成分和关系是否足以支持未来设计 | 不能把旧 `post.card` 方案当通用基础类；business semantic owner |
| computer use | 仅有文档占位 | 未来按桌面可见、焦点、命中、动作和 New State 分别评价 | 当前无实现、无训练、无运行支持；computer-use owner |
| 有界预测／执行双推理 | 设计输入已记录，尚无运行时 | 只评价预测与实际分离、checkpoint、分叉、次优和重算 | 不由本文件定义规划 I/O 或算法；bounded-planning owner |

## 报告与分母

每个逐例结果保留输入引用、对象和 revision、label source、gold 状态、预测状态、选择、派发、effects、New State、人的可观察证据和最终 disposition。原始逐例结果不得被汇总替代。

至少分别报告以下具名分母：

1. 标签匹配数／有 gold 的评价项数，并按类别给混淆矩阵。
2. `judged`、`unknown`、`conflict` 等判断状态数／进入评价的输入项数。
3. `excluded`、`skipped` 数／原始观测项数；排除原因单列。
4. 执行失败／实际尝试次数；零派发、拒绝、执行错误和未知 effects 分开。
5. 根 Goal 真实达标数／应评价的根轨迹数；不得用成员成功数替代。
6. 每个候选的来源分区、真实/合成来源、人工复核状态和未评价项数。

类级 precision 明确定义为 `TP/(TP+FP)`。若只统计 `judged` 预测，必须同时报告 unknown/coverage，不能用 `judged` 总数充当 precision 分母，也不能把 unknown 从覆盖分母静默删除。现有 `M1 342/357` 和 `MAP 356/357` 只是已查看样本的标签匹配；MAP 的 357 项中 308 judged、49 unknown、0 conflict，49 unknown 中有 48 项仍匹配 `other`。它们不是总体准确率、现场候选链准确率或“达到 90”的证明。

## 验证与反例

| 场景 | 必须分开的结论 |
| --- | --- |
| disabled button、readonly input、poster video | 身份、当前资格、可操作性和播放/编辑效果分别记录；不统一改 `other/ignore` |
| 隐藏文字、离屏图片、部分遮挡控件 | 基础身份、可见内容和候选资格分别记录；缺测保持 unknown |
| 父容器与子按钮、图片链接、列表卡片 | 多个角色可以同时保留；成员归属、覆盖和完成不得重复计数 |
| 动作 receipt 成功但没有目标变化 | 派发成功、effects 明确程度、New State 和 satisfaction 分别报告 |
| 子条件满足而根条件失败 | 根轨迹保留，成员结果不能相加或相互抵消 |
| 阈值 90、实际二元值 0 或 100 | 保留请求阈值和实际值，不另造统一 90% 模型准确率 |
| 旧 F2 22/24 与两项前提不成立 | 原报告、oracle 裁决、负控制和诊断报告分列，不重算成新候选成绩 |
| 主路径正常、真实分叉、次优不适用 | 正常继续不重复推演；分叉用实际State核对备选；无适用备选才生成下一段，不能静默改写旧轨迹 |
| 指定checkpoint真实满足、根Goal提前满足 | 前者触发下一段预测并保留根Goal；后者结束且零额外动作，不为性格或N层补动作 |
| 预测成功但实际未知、重推演后预算或派发状态 | 预测不能写成真实证据；重推演不重置预算、不重放未知派发，原错误与effects保留 |

## 独立 Review 职责

完整编码 milestone 到既有独立 Review 边界时，Reviewer 必须检查评价定义及逐例结果是否合理，而不只看总分、汇总表或测试全绿。至少核对：人的问题与代理证据边界；gold/teacher/LLM/rule 来源；来源家族分区及泄漏；具名分母；unknown、conflict、excluded 和失败是否保留；oracle 前提是否真实成立；预测、派发、效果、人的感知和根事实是否被错误合并；组合收益是否重复计数；成功、失败和未知反例是否覆盖对应失败模式。

Reviewer 读取原始逐例依据，不改 gold、权重或候选输出。人的可观察证据被替代、invalid oracle 被计入通过、unknown 被静默删除、组合结果无轨迹证据，或 90 分由泄漏数据产生时，应将对应验收标为 BLOCKED，而不是只给一个低总分。
