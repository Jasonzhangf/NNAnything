# 预处理与呈现输入复检

本轮目标是修复已确认的输入与数值表示缺口。分类词表仍为五个family、十一个具体类别及other。预处理负责输入整形和候选范围；分类器负责评分。原始DOM与teacher证据不作为学生特征，也不因预处理被改写。新增特征和连线以零系数接入，不能据此宣称准确率提高。

## 输入范围与比较口径

同批保存资料位于本地`training/samples/sample-recheck-20261017/`。知乎1009节点、209候选、57未知；小红书1214节点、474候选、80未知；微博2313节点、873候选、199未知。总计4536节点、336未知。只覆盖顶层文档。页面原始资料不进入Git。

三站现场只读复核仍存在工具注释根；知乎39个元素仅有格式字符，微博仍有伪元素内容。原图browser-visual-overlay为4N3E、browser-capture为1N0E、node-training为6N6E，均闭合。复用既有流程，不另建执行引擎。

## 剩余未知的表示审计

只读GCM审计按原始reasonGroup作互斥分组，全部336行保留未定标签：

| 原因组 | 数量 |
| --- | ---: |
| 已有评分项但未达到判断边界 | 167 |
| SVG内部成分 | 90 |
| CSS伪元素呈现 | 51 |
| 仅格式字符的直接文本 | 10 |
| 文档根上下文 | 6 |
| CSS背景图 | 6 |
| 工具注入根 | 3 |
| 分隔线词表边界 | 1 |
| b与path编码碰撞 | 1 |
| object内部未知 | 1 |

167行都有已有非零评分地址。这只证明可训练地址存在，不能证明表示足以区分目标。它们包括86个span子容器、32个空叶div、29个重复子元素div、7个嵌套svg根、5个混合直接文本div、4个非重复子元素div及4个直接文本span。需要复核具体语义和保留／忽略监督；不能自动标为other。

主Agent复核了两组确有相同wire的例子：小红书420号与244号span的子元素分别为`span/svg/span`与`span/picture/div`；知乎931号div的子元素是四个链接及两个按钮，微博304号div是六个div。它们的局部组成不同，现有数值编码相同。此事实不等于它们必然应有不同黄金类别，但说明当前拟合看不到这些已观测差异。

关系数据已由explorationInput保存，当前第一层fit仍不消费它。混合内容div已有直接文本观测，但旧div_direct_text仅对叶节点激活；新增通用非格式文本wire可以提供对应入口。关系数值投影、包装的保留／忽略目标、hr与object边界仍需后续明确，不能把本轮呈现输入修复当作全量语义完成。

## 本轮验收

已完成共享纯预处理、五个可缺测呈现参数、六条零初始化wire及四十二个训练地址。类型、reader和exploration摘要保持兼容；旧必需字段不因新增兼容而放宽。未提供直接文本与CSS为null；已测空串为false。Unicode检测只生成布尔值，原文及ZWJ emoji不改写。

首次红测12项失败；作者补测又确认未提供原始文本被误填false，修为null。完整117测试通过、0skip，新增Handwired测试补充验证四条CSS及通用文本系数从0学习，SVG内部wire有实际梯度地址。UI类型检查、扩展构建及公开`demo:training`真实拟合／保存／回载成功。演示候选未采用、未校准，不能作为三站准确率。

357个旧确认样本、两套profile，共714次比较，类别、状态、分数、余量与family/leaf分数区间全部不变。三站相同4536节点回放排除3个工具根；保留4533行的候选资格及上述判断结果均与旧实现一致。每站结果如下：

| 站点 | 候选前→后 | 未知前→后 | 冲突 |
| --- | ---: | ---: | ---: |
| 知乎 | 209→208 | 57→56 | 0 |
| 小红书 | 474→473 | 80→79 | 0 |
| 微博 | 873→872 | 199→198 | 0 |

减少的3项全部是工具根；未通过调权重降低未知。知乎39处格式文本（含原10个未知span）的两个文本信号正确分离；CSS观测与同批测量逐行一致；b/path编码不同。样本仍未定类，新增入训0。

真实浏览器fixture通过26节点、18项检查，调用实际四节点workflow、采集session、JSON读取与prepare。断言涵盖跨层关系、内容边界、工具子树排除、普通fixed/shadow保留、CSS before/after/背景/mask、格式文本／emoji、编码区别、待定标注回载及不入训。只读用户网站复核与本地fixture分开记证据；未冒称用户页已加载新扩展。

外置原始证据位于`/Volumes/Intel/playground/nnanything-runs/appearance-inputs/`：red-test.log、missing-text-red.log、full-test.log、numeric-final.log、training-demo.log、golden-result.json、site-replay-summary.json、browser-fixture-result.json与browser-fixture.png。原始AGY/GCM会话和独立计划也保留。独立整体Review结果及Git交付由note.md记录。
