# 焦点误忽略：样本构建修订与配对实验

状态：设计已落盘，未构造新样本、未执行拟合。配套[执行提示词](browser-focus-sample-repair-prompt.md)。本页是本次样本实验的唯一方案；旧B1工单和T1/T2/C实验仅作历史证据，不再作为启动指令。

## 目标、事实与未知

Goal：用补齐的真实样本检验焦点container分类能否在现有模型中学会，并保持必需旧能力。satisfactionThreshold：明确gold为container的焦点构造必须judged:container，必需旧正确行无回归；不把模型分数当满足度。State：生产观测、固定分区、初始权重、对照/补样本候选及逐例评价。Action：原生构造与采集、监督复核、配对拟合、回载与独立评价。失败也收束为准确结论，能力仍INCOMPLETE。

已知：旧A/B各18行缺少af=1/fc=0；后来的native构造能真实产生该状态，81wire与历史反例相等，但未加入旧438行拟合请求。C实验仍使用原420+A18，唯一改rivalCeiling为0.6，反例仍ignore。旧报告中162条verified ignore有159条own_focus_target=null，不能事后补false。

未知：补样本是否足以修复；历史监督是否含语义不一致；固定训练配方是否能找到兼顾旧能力的参数。此次不预断根因为样本或训练算法。

## 固定边界与既有图

复用project-design治理图与node-training训练图；DOM观测→生产properties→现有wire→训练/公开分类→真实保留验收的对象流不改拓扑，不新增执行器或业务图。设计图已读，7N6E单入口单出口闭合。本轮先交设计；实现者按当前代码检查受影响采集/训练路径。

生产adapter、wire、null区间、family_leaf_v1、minScore=0.6、minMargin=0.15及gold语义均不变。不增加焦点硬编码旁路。不修改F1/F2、搜索、CLI、通用core或自动采用。可改playground/browser/focus-ignore下采集/prepare/评价consumer及必要测试；生产缺口先给最小复现，另行处理，不混入样本变量。

既有入口：prepare-request.mjs、train.mjs、evaluate.mjs、diagnose.mjs。prepare目前只认fixture-a与旧分区形状，不能不检查就套新家族。复用公开prepare/partition合同，增加本次显式用途，禁止手写学生wire或复制另一个分类器。

## 一、先分家族，再构造

新建三个独立实现来源，命名sample-repair-train、sample-repair-dev、sample-repair-verification，避免与已暴露旧A/B混淆。

| 家族 | 用途 | 实现要求 |
| --- | --- | --- |
| 新训练家族 | 只进入补样本组train | 简单面板/行式容器，构造下述配对 |
| 新开发家族 | 只评价，不拟合/选参 | 独立DOM模板与布局，例如工具面板或嵌套检查项，不复制训练renderer |
| 新验证家族 | 开发门槛满足后评价一次 | 独立执行者只接共同语义/测量合同、生产adapter与公开分类入口；不接训练fixture实现或候选预测 |

每个元素的所有状态、同页关联对象、同模板派生物必须同分区。随机换id、文字、颜色或尺寸不是独立来源。标签来源、配对关系、用途、资格和原始证据沿现有样本schema记录；确无字段的诊断信息放外置逐例表，不造第二机器注册系统。

### 每家族的最小构造矩阵

六个独立交互container：三种包装关系×两种显式tabindex（-1、0）。三种包装关系为：W1旧反例三wrapper wire全1；W2单子元素但有真实几何边界差异；W3多子元素容器。关系是构造目标，是否命中必须由生产wire实测确认，不能改输入凑形状。

每个container观察四个状态：初始、原生点击持焦点、原生点击外部失焦、再次原生点击持焦点。共24条正例状态。六个对象每个必须有至少一条实际持焦点；-1组须实测af=1/fc=0，0组须实测af=1/fc=1。不能把tabindex值当作实际焦点证据。

另构造三个匹配W1/W2/W3形状的冗余包装：无独立文本/图形、无独立操作/状态用途，真实操作目标位于后代，包装自身无焦点能力。分别观察后代聚焦前后，共6条ignore对照。必须实际证明没有外层独立价值；单子节点、无自身文字或无listener不能单独决定ignore。任一构造不符合前提就标invalid-construction并修构造，不能硬赋gold。

计划每家族30条状态、9个目标对象，三家族共90条；90不是独立样本数。同时报告家族数、对象数、episode数和状态行数。构造不成立的行不计通过，不能靠缩小分母达标。

### gold与观测必须分开

六个正例对象预先由监督复核者确认为独立可操作/状态观察的container，保留依据不只是一瞬间activeElement。四态gold保持container：失焦不取消对象持续存在的独立价值。不得建立“聚焦container、失焦ignore”的伪配对。

ignore负例使用不同对象，不通过移除同一对象tabindex后直接沿用标签。若要研究移除能力，那是改变语义状态的新实验，本轮不混入。

真实焦点仅通过原生鼠标/键盘触发；禁element.focus/click、JS写value及脚本事件冒充人类动作。页面脚本不负责把焦点移到目标。允许只读JS运行生产adapter与核对document.activeElement。目标点击区必须确实命中容器，不能实际点到子元素却声称父持焦点。动作前后保留同一对象ref、连接状态、activeElement、tabindex原值、geometry和生产properties/wire。

fc的准确语义是“neutral容器且有显式非负tabindex”，不是完整Tab可达性或可聚焦性。默认activeElement等于body不算目标持焦点。

### 缺测测试单列

新增真实采集必须保留实测false；旧null原样保留。若正常浏览器无法自然产生焦点缺测，不伪造真实null样本。

允许在实测行副本上仅将activeElementFocus设null，经过生产extract重新投影，作为明确标注的observation-ablation对照；不得手改af/fc/own_focus_target，不进入train，不计真实采集或独立来源。它只检验缺测传播/公开前向一致性，不一律要求container或ignore。其他事实仍足以判类时可以判类；否则保留unknown/conflict。

## 二、拟合前审核与红测

1. 亲查旧438行用途及反例是否已在train；旧177 eval已反复使用，只称历史回归。核查旧oracle是否把“失焦”直接当ignore。无原始证据不改旧gold。
2. 若发现确证gold与当前语义冲突，列原证据和冲突，停止拟合部分，交父owner裁决；采集和无依赖检查继续。不能把改标签混入本次补样本因果对照。
3. 对旧train和新增train按完整学生投影检查同输入异gold；同时列跨分区重复投影。不同DOM相同投影不等于数据泄漏，但必须如实标明只是新实现验证，不是新投影泛化。
4. 相反gold同投影时先确认gold和测量，不能继续宣称补样本可解。无冲突也不证明线性/区间模型必可解。
5. 公开分类器对原始反例及新W1/-1持焦点行生成修复前红例；保留实际status、类别、区间、margin。新构造全正确时也保留历史红例，不能制造红测。
6. prepare consumer用小型反例验证：漏掉-1聚焦行、跨家族用途错误、null补false或训练包含验证家族时必须能被本次验收查出。测试只绑定这些实际风险，不锁死源码或整份文件。

## 三、两个实验组，只改变新增训练样本

初始文件沿历史真实起点：training/weights/dom-basic-kinds/ignore-capability-20261021.weight.json。若资产不存在，明确缺资源，禁止换用C/T1/T2结果或默认权重。

旧请求/用途沿外置browser-focus-repair-20261022/train/prepared-request.json与该run对应explicit-usage.json，执行前从历史配方解析实际路径，不能猜路径。固定配置取原T1而非C候选：family_leaf_v1、targetScore=0.8、rivalCeiling=0.4、otherGap=0.05、epochs=200、learningRate=0.02、anchorLambda=0.001，现有18条trainableWires/78地址，现有门限不变。

| 组 | train | 起点与其他配置 |
| --- | --- | --- |
| control | 旧261行 | 同一初始文件重新加载，原始行顺序不改 |
| treatment | 旧261行＋新训练家族30行 | 同上，新增行按确定的对象/状态顺序追加 |

两组保留旧历史eval用途，新dev/verification不进入fit请求。记录实际trainable地址、使用行、更新次数、训练停止原因与实际配置，禁止额外复制困难行、重采样或改loss权重。新增数据会改变平均梯度和每epoch工作量，这是本次“加入这套样本”的处理效果；不能把差异完全归为某一个af组合，也不能宣称排除了优化量影响。

这是一个配对实验，不是扫参：两个组完成后不自动追加配置、换objective、延长epoch或用dev挑参数。不使用验证家族选组。无随机性的既有后端照实记录；如有随机性，固定公开支持的同一seed并说明单次比较的局限，不能私自引入随机机制。

分别用新进程回载control/treatment，比较旧420/旧A/B、原始反例、新训练、新dev及已暴露human构造。旧baseline也在同一入口评价，防止只看训练报告。development仅为解封门槛，不参与调参。

## 四、解封与完成标准

只有treatment同时满足下列条件，才评价新验证家族：历史反例与已确认human焦点正例judged:container；新train/dev全部符合预先复核gold；旧初始正确行逐行无回归，原149条正确ignore均保留。若未满足，新验证家族不读取候选预测，报告NOT_EVALUATED，不称验证通过。

解封后报告30条逐例结果、9对象/家族分母以及新/旧投影分层；全部符合gold才通过该有限家族验收。明确这不代表任意页面覆盖。权重变化后重跑受影响F04与公开保留consumer：同一snapshot经候选分类后目标在默认可用结果中可寻址、可再次观察，后代不因父分类丢失。不能展示层强制保留来通过。

历史null对照需保留区间语义；其他未解决旧行继续报告。分别列不误ignore、container正确、ignore召回、各旧类回归及unknown/conflict。不能以总体准确率抵消硬约束失败。

成功：真实训练候选、回载、独立有限家族、必需旧回归和保留consumer均通过，再完整milestone独立Review，检查原始gold与评价前提。保持uncalibrated/not_applied，不自动采用。

失败：交control/treatment逐例差异、反例及训练梯度诊断，B1保持INCOMPLETE。treatment改善但未达标只证明本实验有限收益；两组均失败不证明样本无关，也不证明算法无解。已验证失败转后续先验，不重复未变实验。

## 五、执行资源与交付

用户将另行派发worker，本设计落盘不启动采集或拟合。目标执行者负责独立Plan、GCM采集/实现、监督复核及最终独立Review。新验证家族执行者不继承训练实现；最终Reviewer独立于作者。按当前宿主Skill路由，不用会话内spawn/fork替代。

从最新origin/main创建本域唯一外置树`/Volumes/Intel/playground/nnanything/browser-focus-samples`，先盘点有无其他活动浏览器域任务；有则协调唯一集成入口，不抢占或删除。过程在独占外置run，样本和权重本地保存，不提交站点/账号内容；只用自有fixture、标签及浏览器实例，不动用户登录态或生命周期。

交付包括：来源与监督逐例表、真实采集、显式分区、投影冲突/重合报告、两组真实配方/训练/回载、开发与验证解封记录、旧回归、公开保留consumer、准确结论。实现范围完成后按既有流程独立Review、main集成/push与资源清理。样本实验能力未通过时仍保持B1未完成，不以代码合流或报告Review PASS关闭能力。
