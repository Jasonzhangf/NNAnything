---
name: nnanything-training
description: NNAnything项目内的DOM基础种类训练、特征与wire升级、旧权重迁移、增量拟合及跨页回归方法。用于本仓库相关任务，不处理浏览器operation或第二层业务语义。
---

# NNAnything训练方法

先读项目[AGENTS.md](../../../AGENTS.md)的目录边界。学生输入、wire、标签和训练I/O分别以[基础种类算法](../../../docs/basic-kinds-wiring.md)、[训练合同](../../../docs/training-workflow.md)为准。不要在Skill中另建schema、调度器或权重注册表。

## 开始前确定变化的owner

| 观察到的问题 | 先处理的owner |
| --- | --- |
| DOM可测，但输入一直缺测 | `lib/adapters/browser/`的观测与测量 |
| 输入已有信息，但没有对应评分路径 | `lib/filters/`的特征提取与wire |
| 输入和wire足以区分，但贡献不合适 | 参数profile与训练 |
| 当前基础词表无法表达目标 | 标签合同；重新复核历史other，再训练 |
| 输入正确，网页动作仍失败 | operation或观测时序；不把它自动变成分类负例 |

最小必要性：先复用已有属性。tag已有SVG值时增加评分wire，不再增加重复isSvg输入。增加新输入必须说明它能区分哪组反例，以及现有输入为什么不足。所有适用属性进入评分；不靠单一tag、role、hidden或class直接决定类别。

## 样本与标签

1. 原始页面／几何证据留在`training/samples/<run>/`，先声明页面、viewport/Focus、iframe/shadow、完整性和缺测范围。只采到顶层时不宣称覆盖内嵌内容。
2. class、id、正文、账号名、URL仅用于teacher证据。学生白名单不接收这些信息，也不接收绝对DOM路径或全局深度。
3. Filter输出语义与判断状态；正负例由训练任务决定。unknown/conflict不是负例，也不是黄金other。
4. 浏览器采集包遵循人工确认合同。自动分类与LLM建议另存proposal，未确认不改verified。离线teacher复核依训练合同记录实际reviewer和证据，不假冒human。
5. 单任务单标签，数组保序。包装节点不自动继承后代语义。other确认须有具体原因；combobox等边界不明时保留ambiguous。
6. 通过现有公开提取器／prepare读取请求。未复核、被排除或观测不足不能靠改状态进入训练。

## 标准训练与验收

1. 先读受影响现有DAG及有效证据。拓扑不变则复用，不为本轮再造图。内部wire变化更新算法owner；外部workflow变化更新对应图与绑定。
2. 固定本轮训练集、开发回放、旧黄金回归及新页面留出用途。同页面／同资产关联组不得跨训练与独立验证。重复快照不是独立来源。
3. 用真实Handwired后端拟合。显式提供源码根；缺失报错。公开起点是`npm run demo:training -- --handwired-root <源码根>`，实际数据试验使用`nnanything/training`公开接口。
4. 训练输出候选profile和逐例比较。分别报告训练、开发回放、旧黄金与未见页面，保留fixed/regressed/retained/unresolved/unassessed。不要用loss下降代替类别与状态回归。
5. 达到本轮验收即停。先用已有样本检查效果；只有明确存在覆盖缺口才扩大采集，不以增加样本代替修测量／wire。
6. 新拟合使旧校准失效。分数保持uncalibrated，候选not_applied。页面未知减少不等于准确率提高；未标注页面只报告覆盖和变化，再检查代表性新判断与剩余未知。

特征升级、迁移和增量规则见[incremental.md](references/incremental.md)。代码实现、Review、集成和资源回收沿项目与全局既有流程，不新增审批链。
