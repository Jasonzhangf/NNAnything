# E到动作的最小因果对照

状态：设计已就绪，待Jenny指派peer。Alice负责设计与Review，peer执行，Jenny提交文档。此轮仅诊断，不拟合、不修改codec、不采用权重。

## 目标和证据边界

上一轮E诊断已通过报告复核，但方法仍INCOMPLETE。受控A直接读取真实fact，因此学习E与替换E轨迹相同无法定位E的动作贡献。本轮只移除该混杂。尺度x64探针已损害48/72同gold配对，不作为修复。

根Goal沿实验合同10.7：固定ref、anchor、length；satisfactionThreshold=100。State来自真实沙盒read后验，Action仍为已注册inspect/read与控制输出。预测不得替代真实满足度，保留model_with_fact_veto单向否决；不能救回模型假阴性。预算沿现有入口，每请求最多4次原子派发、40次转换，不能重启请求或改Goal恢复。

已检查8N7E责任图和recursive-goal 3N2E执行图：单入口单出口完整，本次只换诊断provider，不改拓扑、不加执行循环。评价与选择两处E回调分别记录，错误和预算终态仍归report。缺少可替换入口时报告具体缺口，不修改core绕行。

## 唯一变化：受控A不读原始事实

受控A只接收当前A投影中声明的谓词类型和E标签，不接context、真实receipt、字节、offset、size、oracle或样本ID；也不利用闭包取得这些信息。

固定映射：E=satisfied→RETURN；E=unknown→DEFER；E=unsatisfied且谓词size→inspect；E=unsatisfied且谓词root/range→read。其他形状明确报诊断输入错误。不为拟合结果增加规则。该映射是接线对照，不是已训练A。

参数绑定沿原harness；R/D使用保存的真实预测，所有变体保持相同。若实际R/D选择使选定轨迹不可执行，保留其首次阻断，本轮不替换R/D使之通过。

## 有限矩阵

选上一轮已见TRAIN的两个head病例：一个空文件，一个至少2字节的非空文件；length=2，size作为显式已观测条件。从已存pre-fit选择并记录原ID，不读独立验证。若没有满足条件的已见病例，只交已有病例及缺口，不扩场景搜索。

每例四个变体：原学习E；仅evaluation替换E；仅selection替换E；两处替换E。替换E按真实观测产生confirmed标签，只在诊断provider内使用，来源单列；不进入学生样本或权重。保持同一根，每变体仅首个read强制offset=1，后续由原harness绑定offset=0；length始终2。各变体用自有等价沙盒，不共享污染状态。上限8个请求；不因不符合期待增加变体或重试。

期待是假设：selection的错误satisfied可能使A选RETURN，selection被纠正后可能选read并恢复；evaluation替换可能影响控制器是否进入selection。实际未发生分支必须报告，不构造缺失调用。

## 必需验收

1. 小型隔离检查：相同A允许输入，即使隐藏raw内容改变也输出相同动作；固定其余输入只改E标签，应按上述映射改变动作。检查同时给出provider实际参数入口，不能只靠宣称无旁路。
2. 每个真实请求保存根绑定、首读实际调用与回执、逐次E的phase/原预测/替换标签、A允许输入及输出、后续调用、事实否决与控制终态。保存完整run结果，不仅摘要。
3. 比较的因果单位是同场景同phase的干预。若轨迹不同，定位首个动作/控制分叉；若相同，说明E是否被调用、是否被否决以及是否到达A，不强判有贡献。
4. 原学习E仍假阳性时不得报告根成功；unknown不得改为false；真实读事实和停止原因分开。成功恢复只能称受控接线可达，不能称学生能力通过。

若A没有消费E、事实直接泄漏到A、根或预算变更、权限/引用失效，则停止对应路径并报告。允许完成其他独立变体。无需全量测试、训练、标度实验或新独立样本。

## 产物与范围

源码树只读：/Volumes/Intel/playground/nnanything/l2-four-head-mvp。执行脚本和结果写自有run：/Volumes/Intel/playground/nnanything-runs/l2-e-action-causal-20261025。无需新worktree。一次性worker沿GCM，不启动Astra。

交delivery.md、可复跑脚本、8个以内原始请求结果、具名比较表和一个结论：E能否影响动作，以及此结论的控制前提。缺项显式UNVERIFIED。由Alice审查，Jenny提交设计文档；外置证据保留，不提交未验收公共实现。

本轮结束后才选择下一训练假设。新fit必须另写初始权重、数据用途、先验保持、预算和停止条件；此文不授权新fit。
