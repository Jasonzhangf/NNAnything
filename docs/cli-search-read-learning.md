# 精确名称搜索→读取：最小组合学习详细设计

Alice负责设计、评价及失败分析；GCM只执行下述已定步骤，Jenny负责代码集成。状态：本页是下一切片的执行合同，不是已训练结果。第一批只授权离线真实采样与D单头诊断；正式controller接入为明确后续阶段，不能用离线循环冒称产品交付。

## 1. 本轮假设与非目标

假设：在已学会原生读取E/A的基础上，一个小型D单元可以学习“当前还缺哪个条件”，把精确查找与读取组合起来，而不改变已有读取权重。

根Goal：在指定已绑定目录的直接子项中，找到名称严格相等的普通文件，并取得前/后N个逻辑行。原Goal保持不变。首版无递归、无名称近似、无正文检索、无多结果排名、无写入；不处理一般shell文本或管道。不存在合格文件意味着找到了负向知识，根Goal仍未满足。

精确名称比较与受信身份是已有确定性基础能力，不伪装成R学会关系。本轮只增加D的当前子条件判断；R的语义候选关系学习要在存在真实多对象语义选择的后续切片单独验证。已交付cli-search/cli-read入口不是新发现的缺口，但cli-read按字节范围读取，不等同本轮原生行读取。

## 2. 真实操作、对象及观察

离线SEARCH_TARGET使用固定argv的系统find：`find ROOT -mindepth 1 -maxdepth 1 -type f -print0`。先确认本机支持，缺能力则明确停止，不换自写扫描伪装真实命令。NUL解析保留名称，按basename与Goal.name精确比较；不把名称插入shell代码，不用glob展开。此命令只覆盖直接普通文件，symlink不跟随。

搜索后分别记录exit/stdout/stderr、目录覆盖、实际普通文件项、精确匹配项。成功完整遍历且无匹配才支持no_qualifying_file。异常保留原错并终止该例，不把find错误造为语义负例。READ_TARGET执行head/tail -n N FILE；读取特征与E/A沿cli-native-read-experiment.md。

离线目录全部自有且静态。生产接入必须用既有sandbox验证目录与文件引用；find返回路径不是受信ObservedObjectRef，不自行签发authority。正式阶段复用已有bind/inspect/validateObservedObject，将原生行读取接在合法引用后。禁止把本切片实施为lib/core中的CLI分支或另造循环。

## 3. 推理与D输出

复用l2-four-head-step 8N7E责任设计和recursive-goal 3N2E；两图现有单入口单出口闭合，图拓扑不改。下一次推进由真实post决定，错误和停止沿统一report返回，不在DAG添加回边。

D输出顺序固定为SEARCH_TARGET、READ_TARGET、RETURN_RESULT、REPORT_NO_MATCH。它输出当前一个子Goal，不输出整段计划。harness仅将选中的typed子Goal映射到已启用技能；预算、权限、引用、根事实和终止控制不训练。本批只验证D的“当前缺失条件”子能力：依赖骨架预先声明，不宣称已经学习生成任意依赖DAG或多个替代分解。

D的7列按顺序为：listing.present、listing.complete、selectedFile.present、read.present、readE.unsatisfied、readE.satisfied、readE.unknown。selectedFile是本请求内由真实清单精确匹配取得的文件选择，不是伪造的受信ObservedObjectRef；正式执行仍须sandbox签发和验证。read不存在时readE三位均0，由read.present区分“未评价”；有read时必须是冻结E实际预测one-hot。不得把当前teacher阶段号、正确子Goal或rootFact作为输入。

| 当前证据 | D监督 | 期待与后验 |
| --- | --- | --- |
| 尚无搜索回执 | SEARCH_TARGET | 得到真实完整目录事实或显式执行错误 |
| 完整搜索无合格文件 | REPORT_NO_MATCH | 无新OS调用；根未满足，说明当前目录与类型范围 |
| 完整搜索、绑定文件、未读 | READ_TARGET | 调用已有A，取得实际读取回执，再调用已有E |
| 已读但现有证据不足 | READ_TARGET | 让已有A选择补足目标方向的读取；不重做已完成搜索 |
| 读取证据充分 | RETURN_RESULT | 返回已有字节和证据，不额外执行 |

表中E监督来自真实命令可知性，不从物理rootFact泄漏答案。D训练输入使用冻结E预测；如果上游误差使D输入出现相反监督碰撞，保留错误交Alice，不替成gold骗过拟合。D选无合法绑定的READ时零命令拒绝；原始错误选择单列，不由teacher自动纠正。模型RETURN不能绕过根事实核验。

## 4. 数据矩阵与来源

TRAIN N={1,3,8}；开放DEV N={2,5,11}。每N构造三个负向布局各一个目录：空目录；只有不同名普通文件；目标同名条目是目录且有不同名普通文件。再构造正向布局：目标普通文件加干扰项，L取去重{0,N−1,N+2}；本批每文件有末尾LF，空文件空字节。末行形态已由读取回归覆盖，不无意义翻倍。每目录两个Goal方向head/tail；整个目录及派生轨迹固定同区。

TRAIN共17目录、34Goal；DEV18目录、36Goal。TRAIN干扰文件数为2，DEV为5（空目录布局除外）。各分区按N升序、负向三布局在先、正向L升序在后的目录序号轮换四个目标名：target.txt、target name.txt、目标.txt、-target.txt。干扰名为noise_0.txt等，确保不等于目标。名称只作harness参数与原始证据，不进网络。正文为该分区前缀加逐行序号与固定“样本”字样、以LF结尾。不能称共享构造器为独立来源验证。

每Goal记录initial、search-post；正向再记录target-read-post。每个正向Goal另从search-post分叉执行相反读取；其输出满N行则记录纠正读取，少于N行则直接终止。正常成功结果不得串进受控分支。

完整成功采样预期：TRAIN106状态、72实际命令；DEV114状态、78实际命令。D标签TRAIN为SEARCH34、NO_MATCH18、READ22、RETURN32；DEV为SEARCH36、NO_MATCH18、READ24、RETURN36。重复初态可引用，不重复算独立Goal。任一命令真实异常则保留部分产物，不能凑满分母。

每命令5秒，整批60秒。每回执保存实际argv、原字节、exit、时间、episode与父状态引用。目录清单由独立os.scandir原始事实核对；读取oracle沿LF字节边界扫描，不以再次运行同一命令作oracle。固定字节fixture通过shell printf生成；OS核对与学生能力分开。

## 5. 固定单头训练配方

沿已验证PyTorch离线诊断，不冒称正式backend。冻结并显式加载RUN/native-incremental-v1/E-candidate.pt与RUN/parent-native-experiment/A-model.pt；RUN为cli-native-read-experiment.md声明的外置证据根。D为7→16 ReLU→16 ReLU→4，468参数，原生Linear初始化，seed20261025。它是新增D单元的预训练，不称旧D后训练；E/A权重不重训。

逐行等权cross entropy；Adam lr=.003，β=(.9,.999)，ε1e-8，无weight decay；最多1000步或60秒。每50步报告TRAIN逐类正确数、loss、梯度、完整更新耗时并保存模型、optimizer、step、累计耗时与连续全对计数。TRAIN全对连续3次停止，不看DEV挑checkpoint。启动时验证无同输入相反合法标签；有冲突只停拟合并交Alice。

参数、优化器状态和步数必须支持新进程续接；恢复不能增加1000步总预算。候选另存，未过门不得继续新配方。D结束后新进程回载；DEV只评价一次并保留初次结果。没有定义的结果由Alice裁决，worker不能补标签或换模型。

## 6. 验收与反例

第一批采样：真实命令与独立oracle全部一致，分区/来源/episode有效，106/114输入和标签复算正确，列出唯一输入数。在冻结E全部正确时，本矩阵预期只有5种唯一D输入（初态、无匹配、待读、读满足、读未知）；220状态不冒充220种语义，也不证明D在未见状态组合上泛化。它验证真实不同目录下的观测投影与单元组合。假设未满足就报告数据FAIL，不进入拟合。

D单头：TRAIN全部正确；DEV四类precision/recall均≥95%，逐类支持与错误完整保留。对应明确失败：初态直接RETURN、空目录判取得文件、已绑定仍重复搜索、相反满N行直接RETURN、相反短输出还读一次。只能用实际合法状态构造，不制造工具内部错误。

组合前：E/A在既有264与1920状态回归不变；加载异常不换默认权重。D的gold不会进入组合推理；同输入强制替换D预测只作连线消融，确认原始预测影响执行和终了，不计训练成绩。

离线模型闭环预期DEV正常36episode：18实际找到并读到，18准确no_match；正向受控18episode：12短文件直接归还已有结果、6满N输出补一次读取。根错误成功为0；动作与重复读取分别计分。成功条件不是只看D的RETURN，最终还需真实目标对象与字节证据。每episode至多一次搜索、两次模型选择读取、六次controller推进；预算/取消显式终止且不重置。循环控制保持手写。

正式controller阶段必须复用runRecursiveGoal而非复制Python while循环交付。先用公开consumer验证真实技能调用、预算与根事实，再评价模型；若当前接口不能接原生行读取，记录唯一owner缺口并沿该接口做最小实现，不能把字节range算成head/tail。此阶段的代码清单与精确补丁需Alice依据第一批结果给出，不授权执行者自行扩架构。

独立验证由隔离owner只接共同合同，新构造目录家族，不读取本批错误。其数据不得进入拟合/选参。本批开放DEV通过不等于独立验收通过，更不等于任意文件搜索已训练。

## 7. 执行分段与停止

S1：真实采集、投影和标签核对，执行者返回原始证据，Alice验收。
S2：只有S1获Alice数据验收后执行上述唯一D配方、回载、DEV与冻结成员回归；不得自动启动第二配方。
S3：S2通过后做实际预测组合，先离线概念，再既有controller真实consumer。接口缺口交Alice，不能绕过。
S4：独立来源验证与一次继承D权重的增量实验；此阶段本页只有目标，不提前启动训练。取得结果后再决定扩大内容搜索、多候选关系与管道。

不合格先定位数据、表示、优化或运行绑定的首次偏离。既有已验收能力退化则保留基线，不能用新总分抵消。除明确S1/S2外，未定义工程动作及后续实验不由worker猜测。
