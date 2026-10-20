# 页面分类标注与采集扩展 M1

状态：候选内容，实施中复核（candidate under verification）。本文记录已落地的捕获、标注与输入合同，以及尚待场景回归的 ignore 与训练采用边界；不表示本增量已整体交付或候选权重已采用。

2026-10-17，Chrome/Chromium本地扩展的设计与实现合同。用户选择扩展，并新增点选采集、人工纠错和一键收集未知项。独立Gemini4计划与同角色增补位于外置browser-overlay运行目录。先完成最小可用闭环，不扩展训练台或第二层业务语义。

## 工作流与边界

现有候选图和基础类别图不改。新增4N3E标注图与1N0E采集图。每次刷新、Focus或权重改变是新事件；调度复用现有compileWorkflow/runWorkflow和Flowed的浏览器构建，不另写调度器。磁盘loadWorkflow不进入浏览器包，图作为构建时JSON资源明确传入。

```mermaid
flowchart TD
  S([页面标注请求]):::boundary --> O[采集实时DOM几何与局部测量]:::action
  O --> C[筛选当前视口与关注候选]:::action
  C --> K[判断DOM基础种类]:::action
  K --> P[显示分类边框与Focus焦点]:::action
  P --> E([输出当前标注帧]):::success
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A
  linkStyle default stroke:#475569
```

```mermaid
flowchart TD
  S([当前帧、采集选择与人工标注]):::boundary --> C[保存元素样本与复核决定]:::action
  C --> E([本地采集包或导出回执]):::success
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A
  linkStyle default stroke:#475569
```

内部采集、复核投影、去重和下载是该单节点的实现，不为普通函数拆出更多节点。图只保存拓扑，实际NodeDefinition与公开consumer必须证明可运行。滚动与DOM变更合并刷新，扩展宿主子树不进入观测或变更触发；关闭断开监听并移除宿主。

## 输入、输出和唯一owner

Agent复检使用内置浏览器的只读DOM入口，将同一测量器的观测交给现有候选与基础类别workflow，在本地回放和保存采集包。扩展仅用于用户验收。观测不足、分类未知、冲突和已确认排除项分别保留；现场计数下降不代替正确性检查。

`contentEditable` 表示有效HTML可编辑状态。原生Boolean优先并直接采用；原生getter抛错保留null，不回退。仅在完整可读HTML父链内测量；非input/textarea的合格目标可用一次原生`matches(':read-write')`的Boolean结果代替推断，方法缺失、抛错或非Boolean都不得记为false。无可信selector时，按最近的精确contenteditable声明与文档designMode判断：空值、true、plaintext-only为编辑声明，false阻断更外层true，无效词按继承处理，不裁剪两端空白；designMode为on时覆盖false声明，off时编辑声明为true、false或无声明为false，未知时编辑声明为true、false或无声明保留null。不从根selector推断文档designMode，不用CSS userModify。无法证明的有效状态保留null，批处理不再用原始属性替换null。历史已存Boolean保持原件；只有来源足以证明时另存修正输入，不批量翻转旧样本。

根滚动口与普通祖先框分开：已证明CSS1Compat、HTML实际scrollingElement、两个已知computed overflow轴分别属于auto/hidden/scroll、无变换且zoom1、leading边框/padding及client偏移为零、原生尺寸和滚动偏移有效时，根裁剪框固定为视口原点的clientWidth/clientHeight。hidden仍可发生程序性滚动，不额外要求scrollTop为0；强制滚动条的尺寸由原生client框承载，不使用innerWidth替代。clip、visible和缺测不进入此准入，不新增BODY视口overflow传播。不支持的事实保留null，不读取随滚动移动的根DOMRect，也不给普通嵌套滚动容器补偿滚动量。scroll及混合轴增量当前为候选合同，实施及原生验收状态见note.md。viewport-fixed元素仅在完整祖先事实证明视口为包含块时逃逸外层普通overflow；实际legacy clip、clip-path及元素自身对子节点的overflow仍保留。不把普通fixed标签或缺测当作证明。

嵌套fixed证明增量（候选）：目标向上最近的fixed节点作为viewport anchor候选；更外层另有fixed定位本身不构成拒绝。仍检查该anchor以上全部祖先的变换、独立变换、perspective、filter／backdrop、contain、will-change、content-visibility、namespace及overflow事实；缺测与真实包含块条件继续拒绝viewport escape。不能改取最外fixed并跳过两层之间实际裁剪。显式clip-path／legacy clip及anchor以下overflow继续消费原合同。每个后代独立观测，关闭容器可见不自动证明SVG实例或图标可见。状态及原生验收见note.md。

受限backdrop包含块连接（候选）：内层fixed仅在一个已知relative `blur(20px)` backdrop包含块和包住它的外层viewport-fixed之间建立几何连接，其余包含块效果须明确为基线。外层fixed以上全部祖先仍须通过viewport-anchor守卫。连接成立不等于逃逸所有中间overflow：backdrop自身、其内部wrapper对子节点的overflow，以及适用legacy clip／clip-path继续约束目标；仅外层fixed以上已证明不约束的普通overflow可跳过。实际正轴平移、比例和物理矩形继续使用原合同，缺测、普通filter、负轴和其他backdrop不获放行。此处的负轴限制与后面的HTML单位轴反射例外分开判断：wrapper自身若满足该反射证书可独立准入，但该反射不豁免祖先containing-block守卫，也不支持反射轴以下未经独立物理域证明的client裁剪。该证明不改变paint守卫，不把父容器状态传给后代；焦点能力、实际焦点与露出区域分别保留。四对原生控制及公开旧观测证据见过程笔记，实施和现场验收状态见note.md。

受限absolute包含块裁剪（候选）：对已证明的HTML absolute目标，沿完整HTML父链定位最近的已知positioned containing block。附加证明只在需要跳过中间普通overflow时生效；最近positioned盒为直接父元素，或中间双轴overflow均明确visible时，无需逃逸，由同一既有裁剪循环继续处理。目标自身变换不决定其自身包含块，不为该附加证明重审目标与最近盒以外祖先的几何；已有正轴／单位轴反射和外层裁剪守卫继续负责这些输入。确需逃逸时，中间节点的HTML／static与包含块建立条件必须已知，static identity transform也不能被当作none而跳过。仅豁免目标与该盒之间适用逃逸规则的普通overflow；该盒自身和以上祖先的裁剪仍消费原规则。overflow:clip、适用legacy clip、clip-path和目标对子节点的overflow不获额外豁免，既有显式零clip终点保留。缺测、SVG／foreignObject、transform／filter／backdrop／contain等本轮未证明的包含块关系不授予豁免，也不能据未经证明的中间零高盒制造确定nonrendered。普通非absolute路径保持原合同；首轮不递归求解多层absolute或自动宣称initial containing block。原生对照已证明静态零高包装可被absolute图片逃逸、定位包装仍裁剪、实际包含块仍裁剪；不读取不可用的offsetParent作为事实。实施和真实文章复验以note.md为准。

HTML单位轴反射是下列一般正轴限制的局部例外（候选）：仅允许有限六项 `matrix(a,0,0,d,tx,ty)`，a和d分别为-1或1且至少一轴为负，覆盖水平镜像、垂直镜像和精确180度反转；要求单分片实测物理矩形、双轴visible overflow且无局部clip／contain／filter／backdrop／perspective，独立translate／rotate／scale明确none。实测矩形已包含transform-origin和平移，不重建布局坐标。保留原始负轴，不修改正轴helper；外层正轴hidden仍取真实交集。反射轴以下的普通client裁剪不能套用正轴偏移算法，未有独立物理域证明时保持未知；SVG仍须自己的viewport与绘制证明，不继承容器可见性。一般旋转／非单位负scale／3D／多分片和必要事实缺测不在该例外内。状态及真实页面证据见note.md。

外层SVG物理viewport例外（候选）：目标祖先为SVG namespace的外层`SVG`且上方无另一SVG时，若根八项border／padding均为明确零、CSS width／height为有限正px、根只有一个实测分片且测得有限正面积BCR，则该BCR可作为屏幕坐标系中的精确物理viewport。根CSS transform须为`none`或既有正轴对齐变换，独立translate／rotate／scale／perspective须明确`none`；HTML祖先链只接受单位正平移、`none`或现有`exactHtmlAxisReflection`唯一证书接受的单位轴反射。该证明只处理矩形坐标，不依赖viewBox、path语法或资源内容，也不证明绘制范围、透明度、原子顺序或前景可见性。新增消费只在根overflow轴明确为hidden或visible时生效：hidden轴与目标实测矩形取交，visible轴不裁剪；`clip`、`auto`、`scroll`、缺测和未支持反射仍沿既有证明或保持null。固定、定位逃逸、显式clip-path、legacy clip、root-scrollport、外层HTML裁剪及其执行顺序不变；目标到根的定位边界仍须闭合，命中空交集返回既有零宽结果，证明缺失保持null。根BCR只定义物理viewport，不读取子USE的shape、viewBox或资源payload。

祖先拓扑复用（候选，待原生完整验收）：同一次`observeLiveDom`调用内由现有父先子DFS记录`parentElement`拓扑，仅供`clippedBox`、`roundedClippingAncestor`、`ancestorRoundedClearCorners`复用。保持自身到根顺序、include-self规则、`window.getComputedStyle`读取位置、几何与遮挡判断及缺测语义不变；不跨调用、滚动或快照缓存，不缓存样式或裁剪结论。确定性公共输入上旧／新完整输出逐字段一致，聚焦资源反例在旧实现失败；WB完整入口证据以note.md为准。

局部CSS标量复用（独立候选）：仅在一次`observeLiveDom`中，对`clippedBox`函数体直接消费的translate、rotate、scale、perspective、transform、contain、clipPath、overflowX、overflowY按Element与字段复用第一次成功返回值。仍在原分支的首次实际读取位置取值，不预读；null、undefined和空串分别保留，抛错不写成功值并原样传播。下一次调用重新读取，不挂到registry、snapshot或模块上，不缓存几何、文本、裁剪、可见性和分类。fixedAnchorProof、legacy clip、rootScrollport、SVG helper及surface继续读取真实样式；它们不加入该标量表。此合同不是全页原子快照，也不是所有CSS consumer统一快照。稳定输入上须验证完整输出一致；动态字段在同次调用变化时可能与旧逐次读取不同，须明确记录首次值语义，不把一次未见变化当作未来稳定保证。实现与完整原生验收状态见note.md；未验收前不宣称解决微博执行期限。

- `lib/adapters/browser/live-dom.ts`：顶层Document/Window与稳定节点引用表→PageObservation、局部属性与元素映射。全页遍历无2000条截断，候选仍按viewportOnly/subtree/focus/黑白名单筛选。完整children与getClientRects、实际祖先overflow裁剪；computed `none` 与 `matrix(a,b,c,d,e,f)` 中 `b=c=0` 且 `a>0,d>0` 的正对角矩阵按正比例缩放与平移处理。视口矩形已含变换，不再二次缩放；裁剪祖先按自身到根的累计正比例换算client偏移与尺寸。负比例/零比例、旋转、倾斜、matrix3d、非none的独立translate/rotate/scale/perspective属性、clip-path、SVG用户坐标裁剪及其他未测定裁剪仍保留null。legacy `clip` 仅在computed position为absolute/fixed时适用；适用且为`rect(0px,0px,0px,0px)`返回已知空交集，static/relative/sticky声明不生效，其他legacy rect仍保留null。未知重复几何与未验证列表父级不得补假值。iframe和shadow内部只报告未覆盖，不推断closed shadow数量。`document.activeElement` 每次观测只读一次并映射到本次稳定引用；命中节点记 `activeElementFocus=true`，其他已观测节点记 false，不可读、null 或不可映射保持 null。`tabIndexFocus` 仍只表示显式非负 tabindex 属性，负 tabindex 单独不构成焦点证明。
- `lib/adapters/browser/weight-asset.ts`：显式训练权重资产→已校验profile、compatibility门限、未校准标志；文件源合同与 `loadBrowserWeightAsset` 每次调用只读取并解析一次，不缓存。`lib/adapters/browser/file-weight-classify.ts` 通过公开 `classifyBrowserBasicKinds` 复用同一加载和纯分类入口。读取、解析与合同错误原样拒绝；结果报告不能当权重加载。私人权重不提交。
- `lib/adapters/browser/capture-bundle.ts`：当前分类帧、选中引用和用户复核决定→本地采集会话与单文件bundle。批量收集只纳入合格候选且保持未复核；`collect_unresolved` 同时纳入 qualified `unknown` 与 `conflict`，并分别给出 `eligibleUnknown`、`eligibleConflict`；既有 `collect_unknown` 仍只纳入 qualified `unknown`。按 snapshot/frame/node 去重，保序重排 `inputRef.index`。采集会话不产生训练梯度。
- `lib/browser-classify.ts`：纯浏览器入口，复用已有观察/Focus/候选/类别及复核schema。浏览器workflow适配单独导出已有compiler/runner，不能导入Node磁盘loader或重复分类算法。
- `lib/nodes/browser-overlay.ts`：可复用NodeDefinition与显式Document、引用表、present/download资源，使用上述两张图。数据、Focus/profile和采集会话不从日志或隐式站点全局重建。
- `extension/`：MV3壳和Shadow DOM视图，只有activeTab+scripting权限，无host_permissions。图标显式开关；浏览器包复用Flowed官方browser入口。单个esbuild开发依赖，不引入UI框架或自造打包器。
- `playground/overlay/`：同一视图与测量器的真实网页consumer、可重复fixture和本地HTTP入口，用于浏览器黑盒验收。

构建时可显式选择一个已校验的本地权重资产：

```sh
npm run build:extension -- --weight-file training/weights/layout-ignore-svg-pair-v1.weight.json
```

无参数构建继续使用手写基线。带参数时，构建先读取并通过`parseBrowserWeightAsset`校验文件，再把typed profile/config仅嵌入content bundle；面板来源显示“构建加载”、文件basename和profile ID。缺文件、非法JSON或合同不符必须非零退出，不能回退基线或覆盖已有构建产物。绝对输入路径只进入本地构建回执，不进入页面UI。

面板文件上传仍只覆盖当前会话，不写入Chrome storage，也不发网络请求。页面重载后恢复构建时选择的资产；该本地构建选择不自动采用候选profile为项目默认。

文件化验收入口（T4 controller边界，候选）：`classifyBrowserBasicKinds(input, { weightFile })` 接收显式 `BrowserWeightFileSource`。每次调用执行 `weightFile.readText()`，经唯一资产解析器校验后使用本次 profile/config 分类；读取、JSON或合同失败直接拒绝，本次不产生旧权重结果。`DOMInspectorController`提供opt-in `options.weightFile`及公开`setWeightFile(source | null)`切换边界；每个实际运行通过`loadBrowserWeightAsset`重读，并把本次解析资产只用于该次既有workflow。文件模式不读取`initialWeight`、默认profile或上传配置作为回退；未配置源时停止分类并显示选择提示。源切换使用现有`refreshRevision`清空旧展示与采集资格，关闭及迟到读取继续使用`mountGeneration`和revision拒绝发布。旧`initialWeight`、默认权重和面板上传仅供旧调用者兼容，不是新文件源路径。`loadBrowserWeightAsset`不引入跨调用缓存、文件监听或额外服务，外层四节点图不变。

Node调用者以 `readText: () => readFile(weightPath, "utf8")` 每次重新按路径打开文件；公开consumer为 `playground/browser/file-weight.mjs`，覆盖同路径原地覆盖、rename替换、损坏／不兼容／删除后拒绝及恢复。浏览器后续接入须每次从原生句柄调用`getFile()`再读文本，不得保存旧`File`快照冒称磁盘重读。当前自动化选择器实际拦截原生文件picker，句柄重读与扩展集成尚未验收；现有扩展仍沿上文旧加载方式，不能宣称已支持该入口。兼容的权重替换可独立于插件代码更新；新增观测特征、算子或不兼容资产合同仍需更新相应代码。

采集包含 kind=`nnanything.browser-capture-bundle.v1`、会话/Focus/profile 引用、trainingRequest 和按证据引用索引的 evidenceSidecar。trainingRequest 仅由 readBasicKindTrainingRequest 校验，不能错误套用接收 CandidateBatch 的 validateBasicKindRequest；显式 extractTrainingRequestFromBundle 拒绝错类型。学生 `properties` 只用 `BasicKindMeasurements` 与 tag/role 等许可字段；raw class/id 只在证据区，作为来源线索，不进入学生输入。证据不读取 input.value、密码、Cookie、浏览器存储或网络请求；不伪造原始整页 HTML 覆盖。采集保留原始槽位、兄弟/直接父子关系、子元素观测和 Focus 范围，不能为去重或 ignore 展示删除这些关系证据。

## 主任务路径与UX

普通页面变更触发重算时，保留上一帧的视觉标注与统计，面板更新状态占固定空间。可采集帧立即失效；旧显示只能用于查看，不获得新的采集资格。成功结果整体替换显示，真正的空结果、错误、Focus切换或失效、关闭仍清除旧显示。刷新以单个运行和一个合并的后续请求推进；更新期间到来的变更使旧运行结果不能重新启用采集，关闭重开也不能接收旧代结果。文件源切换立即清除旧展示和采集资格；慢A在B已选或controller关闭后完成时，不得发布A结果、覆盖B错误或恢复采集。文件读取或资产合同失败清空当前帧与展示并显示原错误，下一次有效运行可恢复。公开回归入口为`artifacts/overlay-harness/refresh.html`和`artifacts/overlay-harness/weight-source.html`，通过实际controller验证稳定呈现、旧采集回调拒绝、突发合并、错误／Focus／关闭恢复及显式文件源切换；不读取私有controller状态。A/B和延迟读取在`weight-source.html`中仅为并发测试fixture，不代表原生文件句柄或持久磁盘身份。

页面是操作工具，目标是查分类、限定 Focus 并采集纠错，采用紧凑常规控件。类别颜色配文字图例，平时显示边框；`ignore` 默认不画标注框，图例仍显示该类别，用户可开启查看。选中或开启“显示全部标签”后显示类别文字，减少父子标签堆叠。Focus 用独立边框与名称。面板显示扫描总数、视口候选、已判断、未知、冲突、ignore 与未覆盖说明；`ignored` 是 `judged` 的子集，`unresolved=unknown+conflict`，排除项不计入两者。分数显示为未校准分数，不显示概率百分比。

“检查元素”和“选择Focus”均为显式点选模式，拦截一次点击，不触发原网页按钮；Esc取消，选中后退出模式。正常浏览不拦点击。Focus根被移除时显示失效，用户可清除，不静默扩大范围。

选中后可选择“确认分类正确”“分类错误并指定正确类别”“尚不确定”。只标错未选正确类写 rejected、黄金字段全 null；确认 other 需理由。只有用户明确确认的标签可 verified。未解决项一键收集使用 `collect_unresolved`，只纳入 candidateStatus=ok 且 judgmentStatus 为 unknown 或 conflict 的当前 Focus/viewport 项；legacy `collect_unknown` 的 unknown-only 含义保持不变。filtered_out、skipped、观测不足和候选未知不混为类别未知，不自动黄金 other/负例。收集到当前会话后显示计数；“导出 JSON 样本包”通过用户手势 Blob 下载持久保存，导航前需导出，首版不建数据库或自动后台保存。

## 当前用户可观测范围

语义判断前，实时DOM观测生成可选`foreground`（visible／occluded／unassessed）和`exposedRects`。候选预处理排除已确认完全遮挡的节点，原因`occluded`；未测定绘制保持候选unknown。原始rect、DOM顺序和排除槽位保留。旧观测没有新字段时保持原行为，不伪称已检查遮挡。分类器、权重和训练标签不变。

覆盖差集使用已测定的轴对齐纯色矩形；受限单层轴向线性渐变增量按下述合同实施与验收。接收指针且有背景色的表面包含半透明遮罩；鼠标穿透表面仅在背景完全不透明时提供视觉遮挡证据。原生命中栈按目标与遮挡面自身提供前后关系，不用其小块后代代替整个表面。鼠标穿透目标或表面使用显式层叠路径比较，不把后代z-index直接与另一个根比较。祖先圆角裁剪、图片透明度和复杂变换不能冒充矩形全覆盖；不确定区域不画框。有限采样点全被挡住不构成完全遮挡证明。本轮不承诺逐像素可见性、完整CSS绘制引擎或iframe/shadow内部覆盖。

中心点未取得合法目标原生顺序证据时，仅对两类受限目标增加固定有限的实际目标顺序补探：精确两个正分片的直接文本HTML SPAN，以及复用既有contained-fill证书的直接叶SVG PATH。SPAN只查询两个裁剪后片段的中心；PATH在既有相关重叠上查询归一化坐标{0.1,0.3,0.5,0.7,0.9}的固定5×5点集，中心结果复用后最多增加24次查询。补探须遮挡面已证明、非鼠标穿透、目标非pointer-events none且几何覆盖全部可见相关分片；须至少取得一个目标位于遮挡面之后的实际命中。任一点目标位于遮挡面前方或命中时缺少遮挡面均拒绝，查询缺目标时须由既有`simplePaintBefore`显式为true保持一致。补探只补顺序起点，不扩大原生证书、绘制域或遮挡差集；完全遮挡仍只由既有相关域完整差集与四角顺序守卫决定，且只描述本次观测，不证明形状实心或未来动画阶段。

轴向渐变候选合同：仅接受单层linear-gradient、显式to left/right/top/bottom、rgb/rgba与显式px/%停靠点；停靠位置有限且严格递增，alpha单调。背景origin为padding-box、size为auto、position为0% 0%、repeat且attachment为scroll、clip为border-box，四边border/padding为零时，渐变定位区与实测单分片HTML框重合；调用方还须证明正轴映射、透明度及无未建模的自身绘制／裁剪效果。背景底色与有效opacity合成后，接收指针使用严格alpha大于0的域，鼠标穿透使用严格alpha等于1的域；矩形差集和点判断共享同一域与精确端点，不使用alpha容差。半透明ramp可按鼠标穿透合同保留，但不冒称物理上无绘制。多层、缺测、其他语法／几何、mask、filter、阴影、伪元素等继续不确定；文字不变为实心bbox。原顺序、裁剪与合法命中要求继续生效，是否实现和原生验收以note.md为准。

剩余观测增量的验收合同：圆角、定位或非单位透明度本身不产生像素；无自身绘制的包装不能仅因此成为遮挡面。边框存在性使用宽度、样式和颜色联合观测，缺测保持未知。仅有边框时，可保守计算已证明透明的内部矩形；圆角须按CSS规则归一并换算到viewport，不能把整个padding矩形视为透明。遮挡差集只扣除该内部矩形以外的可能绘制区域；命中栈也只能在已证明透明的点跳过该表面。阴影、outline、伪元素、图片、mask和filter仍属于绘制证据，无法界定时保留不确定。原有纯色半透明遮罩合同不变。

祖先圆角增量合同：仅在实际包含和定位关系证明该裁剪约束后代、单分片HTML盒、零边框／padding、正轴对齐映射及相关绘制效果均已知时，使用既有归一化圆角算法约束后代表面的可能绘制范围。hidden裁剪与可能扩展clip margin的clip分开处理。已证明透明的角区同时供差集与点命中判断消费，不能只修一端。目标自身或祖先裁剪会排除的角区不能被计为露出；祖先自己的背景、边框与其他绘制仍独立判断。该增量不推断图片alpha，不继承父节点可见性，不把未知改为ignore；源码与真实入口验收以note.md为准。

背景图片的声明存在性与实际绘制范围分开。新增横向无绘制证明仅支持：单URL图层、`100% auto`、严格px横向位置、`no-repeat`、`scroll` attachment、padding-box origin、border-box clip，以及已知零边框/padding、单分片block盒的正computed px宽W。图片横向区间为[X,X+W]；只有X+W≤0或X≥W时可排除该图片的绘制贡献。相交、重复、缺测或不支持语法保持原不确定行为；排除图片后仍检查其他自身绘制。学生`backgroundImagePresent`继续记录CSS声明，不改为几何证明，也不据此重标ignore或推断资源alpha。实现及现场验收进度见note.md。

SVG增量只接受可证明的正轴对齐viewport/viewBox映射与局部矩形clipPath。物理viewport负责overflow裁剪，不能以viewBox映射后的内容矩形替代，否则会误删留白区域。嵌套偏移与尺寸须由实际属性和已知父映射推导；资源ID只用于解析裁剪证据。缺测、冲突的同名资源、旋转、倾斜和不支持的路径仍保留未知，不伪造CTM或切换浏览器通道。该段是新增实现与黑盒验收的目标；是否已交付以note.md证据为准。

后续受限二维根SVG合同：仅对外层变换明确none、物理computed CSS尺寸及零边距已知、有效viewBox与meet、单直接fill path的根建立局部包含证书。读取实际computed d；只支持完整消费的显式绝对M/C/Z闭合路径。所有端点与控制点须严格位于viewBox内，且无stroke、markers、mask/filter、额外clip或中间变换。Bezier控制凸包与meet证明路径填充在根viewport内；根的同一有限可逆二维变换不破坏包含。只跳过受证根对自身box／该fill的overflow裁剪，继续全部外层裁剪；不反解AABB、不扩边界、不伪造单位scale。其他旋转和HTML变换继续未知，证书不证明实心像素或不透明性。该增量按独立计划实现及验收，当前状态仍以note.md为准。

原子SVG补充证书接受目标子树内已显式测定的正衰减opacity（0＜值≤1）、经既有局部矩形clipPath解析器同时校验属性与computed值的限制裁剪，以及正轴对齐祖先变换；反射根只复用既有directPath物理viewport证明，不制造单位映射或二次变换。双轴明确为hidden且其余映射与绘制条件成立时，根物理viewport直接约束目标填充范围；原始bounds越界不再要求额外子级clip，也不使用误差容限。overflow为clip时可能存在扩展clip margin，仍沿既有较窄证明：原始bounds须包含于viewport，或存在已解析的链上clip并有正交集。所有声明的局部clip仍须可解析；缺测、未解析或冲突资源、其他根样式和可能扩大绘制的filter/mask/marker/shadow/outline/pseudo继续拒绝。单独的直接leaf PATH stroke路线可进入同一hidden-root证书：目标须为根的直接PATH子元素且`children.length===0`，根须有已知正轴映射、双轴hidden及严格的根自身效果；markers、未解析clip、fixed/sticky、top-layer、foreignObject、缺测或不支持的根及外层事实继续拒绝。该路线返回完整根viewport为`paintDomain`，只覆盖PATH几何BCR不能证明全遮挡。该证书只用于原子顺序的范围证明，不推断填充像素、透明度或可见性；不改变旧fill、clip、reflected或resource合同、原始rect或统一目标状态。

本地USE增量合同（候选，源码接入待构建及consumer验收）：仅准入唯一同文档symbol引用，且有限内容已读为g/path、无未知内容或逃逸路径。最外层SVG须有已证明的单物理viewport、双轴hidden，以及不扩展裁剪后绘制的根自身效果。外层祖先自己的box-shadow或outline只属于祖先自身绘制，不扩展USE子树的可能绘制域，因此不据此拒绝该上界；根自身shadow/outline仍严格拒绝。外层filter、backdrop、mask、clip、contain与独立变换事实继续拒绝；fixed/sticky与top-layer仍在目标到根的内容路径及根上按原守卫拒绝。该物理viewport只给出实例可能绘制的上界；无需把源定义样式冒充实例继承样式，也不从上界推断资源成功、实心像素或可见性。物理根范围不依赖viewBox用户坐标映射。观测端只消费该上界域与本次观测viewport的正面积交集；证书自身仍保留完整物理根域。全遮挡须由可靠blocker消除该正面积相关域，不能只覆盖USE的原始BCR，也不能将空交集自动当作全遮挡或退回BCR证明。相关域剩余不得发布为目标露出区域，正向露出仍需实际目标与合法命中证据。对携带完整SVG绘制域证书的目标，祖先或根命中只提供顺序证据，不提供目标自身绘制证据；正向露出须由目标或后代的合法原生命中，或既有合同独立建立的witness支持，HTML祖先阅读与补充命中合同保持不变。未取得完整绘制范围证明的USE，也不能退回用BCR单独证明全遮挡；原生visible-overflow反例的框外笔画仍可见。保留旧PATH/G分支，foreignObject/top-layer、缺测、多分片和不支持的反射映射继续未知。叶节点973的原生CSS为`rgba(0, 0, 0, 0.5)`且opacity为1；它只按当前blocker合同作为有效遮挡证据，不是物理不透明证明。公开fixture使用完全不透明cover。是否完成构建及原生验收以note.md为准。

外部USE引用准入（候选，源码接入待构建及consumer验收）：USE引用的不是同文档`#`片段时，实例内容在本轮不可读取，因此不执行唯一symbol与有限g/path内容校验，只把该实例的可能绘制域约束到外层SVG的物理viewport上界。准入沿用本地USE的外层条件：目标到根为SVG namespace的USE/g链、无light-DOM子内容、单外层根与单实测分片、根八项border/padding为明确零、根computed width/height为有限正px、根与祖先独立translate/rotate/scale/perspective为none且正轴对齐无3D、双轴hidden，以及根与祖先的filter/backdrop-filter/mask/clipPath/contain/mix-blend/isolation等不扩张或逃脱绘制的外层守卫。祖先自身box-shadow/outline只属祖先绘制，不用它收紧或放宽该上界；根自身shadow/outline仍严格拒绝。浏览器合同依据为：W3C SVG2的`use`元素与渲染模型规定shadow内容在`use`坐标系统中绘制、`use`为shadow内容建立独立组合组，组内容、效果与变换先组合再并入父组，组内新的SVG viewport是嵌套坐标边界而非新的外层布局根；SVG2的overflow规则规定hidden裁剪尺寸恰为SVG viewport，stacking规则把子stacking context作为不可分割项参与绘制顺序；Chromium `svg-use-element.cc`按允许名单排除并整体移除non-SVG/foreignObject/script/style子树，`svg-element.cc`与`svg-svg-element.cc`把`use` shadow内克隆SVG/symbol替换视为inner SVG并选择viewport容器。基于这些合同，外部实例的可能绘制域不超出外层根物理viewport；根相对外部blocker的原子顺序继续由现有witness消费。该准入只返回既有`SvgAtomicViewportCertificate`的物理域上界，不读取资源payload、不解析URL、不做版本或能力探测、不证明资源加载、内容存在、opacity、实心像素或正向可见；缺测、多分片、visible/混合overflow、filter/backdrop/mask/clip、3D、fixed/sticky、top-layer和不支持的外层事实继续返回null。下载或站点资源不绑定当前实例身份，不能把asset内容当作准入依据。

本地USE有限正向补探合同：中心点未取得合法目标或后代命中且`boundDomain !== null`时，才按目标原始`node.rect`生成四个固定内缩点：上、右、下、左分别为(0.5,0.1)、(0.9,0.5)、(0.5,0.9)、(0.1,0.5)坐标比例。每个点只在当前remaining矩形的包含范围内查询，不移动或钳制；跳过已查询点（含中心），同一目标最多四次额外几何查询，每个remaining矩形首个成功即停止。补探复用既有`queryNativeHitPoint`、原生坐标补充、点级诊断和目标/后代在首个合法不透明owner之前的判定；目标出现在owner之后不成立。成功只发布命中的remaining矩形到既有`exposedRects`，不发布根域剩余，不恢复祖先正向兜底；完整根域遮挡仍先终止。一次目标命中不证明矩形内每个像素均可绘制或可交互；有限查询失败保持`unassessed`与null，不扩点集。

图片资源观测由显式可选producer承载。原`browser.observe_live`节点先用同步DOM观测收集几何上确需资源证明的图片，再等待这些图片的读取，最后重新观测当前DOM；外层四节点DAG不变，展示只提交最终一次结果。启用producer时必须授予`browser.resource.read` effect；不启用时不读取资源。第二遍只接受producer同步peek返回的当前文档、节点、加载代次、来源和尺寸均匹配的已完成证明；异步等待期间的源变更、load/error、脱离文档或dispose使旧证明失效。失败保留观测未知，不转为ignore。producer只读取请求到的图片，不遍历下载全页，不上传资料；controller关闭时dispose并中止在途读取，原刷新代次保护继续阻止过期结果展示。圆角域的矩形字段逐项读取并保存为普通记录，接受原生DOMRect的继承／非枚举getter；不能用对象展开丢掉已验证的坐标，也不能为缺失字段补默认值。

图片覆盖下界在完整raw坐标中证明，再与目标当前可见区域比较；不能把先与viewport相交的图片区域要求为完整raw盒。当前受限支持零border/padding、零自身圆角的已完成IMG：centered contain须完整比例精确一致，centered cover须证明内容填满自身盒；仍需当前JPEG资源证明、opacity与效果／合成／裁剪条件成立。目标上界限于原有VIDEO圆角clip、由共同同盒hidden圆角祖先约束的空HTML占位盒，以及无文字／媒体／生成内容／外逃效果的空DIV或单同盒空DIV子树。圆角域为已验证凸域时，可用四顶点证明当前可见矩形被其包含；露出的角区继续保留。目标padding不等同图片的内容边界，不据此删除占位节点。顺序同时要求现有paint owner的明确顺序和当前IMG／共同祖先的native witness；pointer-none目标缺少自身命中可以有明确支持路径，但显式反向顺序、证明缺失与不支持形状仍拒绝。几何与顺序资格通过后才请求资源。原节点、后代、槽位与排除理由保留。

顶层观测未读取的OBJECT内部须与iframe／shadow内部一样明确登记为未评估；登记不是实际读取，也不把未知变成空白内容。当前只读入口无法取得OBJECT内部时保留该边界，不把`about:blank`、负tabindex、aria-hidden或透明样式单独当作无交互证明。

当前视图非渲染资格增量只支持实测HTML DIV与OBJECT外部表面。观测记录保存当前绘制路径的严格零opacity见证、pointer-events、实际焦点及focus-within、原生tabIndex、有效编辑状态、自身标签和直接文本。只有已证明零透明度、pointer-events none、实际焦点与焦点路径均false、原生tabIndex小于0、不可编辑且无role／自身标签／直接文本全部成立时，候选预处理才以`current_view_nonrendered`排除该节点。缺测不补false。零透明度取实际合法computed值的零见证，不用乘积下溢或旧累计默认值；借用祖先见证时，目标到见证之间须已证无top-layer脱离。实际焦点、键盘或编辑目标、原生控件、可见阅读／状态元素均保留。每个后代独立判断，原始节点、槽位及未读OBJECT内部覆盖记录不删除。不据此声明未来脚本或协议永远不可操作。该增量按独立计划实施，交付状态以note.md为准。

视口亚像素边界见证（候选，待验收）：保持原CSS几何点与实际原生查询点分开。只有同次原生DPR=1、visualViewport scale=1且偏移为0均已测定，原查询返回空数组，且已测正面积overlap／remainingRect位于右／下最后1 CSS px带并到达边界时，才允许一次查询至对应轴的viewport尺寸减1；不修改另一轴，不改变`hitAt`、原矩形、裁剪或差集，不将null或非空无关栈当作可补偿空栈。blocker顺序与最终露出共同消费该有界见证；原生顺序仍要求对应自身，反证不被其他探针覆盖。CSS绘制、paintRect、透明内部／角区与目标有效域仍以原几何点判定，不能把补充查询点当作CSS露出点。最终新增露出须有当前remainingRect对应的已测单分片目标或合法后代自身命中；祖先、HTML、无关元素及焦点状态不作替代。未解决的可能前景面、未知形状和缺测环境继续保留unassessed；pointer-none覆盖仍按既有显式绘制顺序与几何扣除，完全遮挡不能被补充探针救回。圆角及裁剪只消费已有合法域证书，不为此扩展CSS绘制器。具体运行证据与未完成项以note.md为准，外层DAG不变。

部分命中顺序不等于明确在后：IMG中心在目标前方但角落命中不完整时，仅在图片自身绘制范围有界、无逃逸效果且几何已测定时，从可能露出区域扣除其可能绘制范围，再通过既有owner命中检查剩余区域。该分支不减少已证明未遮挡集合，不把图片提升为不透明，不改变鼠标穿透表面的既有层叠判断。缺少绘制边界仍保留未知；祖先自身阴影不自动当作图片自身像素。

普通绘制顺序补证只处理受限的“目标自身绘制位于后出现的正层叠分支之后”情形：目标和遮挡面同属顶层HTML文档，目标独占祖先路径与遮挡面在已知正定位层叠上下文之上的路径均为static/relative且z-index:auto，共享分歧为普通block，目标子树在DOM绘制顺序中早于遮挡子树；目标自身还须无可见outline、生成伪元素、阴影或未界定的绘制效果。证明沿两条祖先路径线性检查，允许任何额外零层级动画上下文，不要求动画缺席；top-layer须由实际fullscreen、modal和popover状态证明为假，getter不可用时才使用原生`:fullscreen`选择器结果。任一必需CSS或原生事实缺测、3D、共享flex/grid顺序反转、目标为正层叠或原生栈显示目标在遮挡面前方时均返回unsupported。该证明只补充顺序，完整遮挡仍依赖既有几何与表面差集；部分覆盖保留露出区域，结果不传给后代，也不修改paintParticipation或legacy比较器。

圆角外角证书当前只接入已知零边框／padding、双轴overflow clip、无额外绘制／逃逸效果、祖先zoom均为1的IMG。归一化椭圆半径后，各角选择距边[r/8,r/4]的小矩形；矩形严格位于椭圆外。差集和点绘制判断消费同一证书，目标具有未建模的圆角裁剪祖先时禁用此证书。PICTURE本身不产生解码图片像素，但其自身背景／边框等绘制及IMG后代继续分别计入。边框外角接入未实现，旧透明内部证书继续使用同一半径归一化函数。没有引入通用伪元素绘制器。

标注只画已保留的露出矩形。同一节点的多个露出框共享 nodeRef，计数仍按节点槽位。被排除节点不计入分类未知/冲突，不进入未解决批量采集或手动样本保存，不转 ignore/other/负例。`ignore` 只改变默认标注呈现，不剪除节点、子节点、关系或采集失败证据。工具自身宿主与已声明工具根不参与遮挡。重新观测后，关闭遮罩的背景可恢复候选。

公开consumer为`artifacts/overlay-harness/foreground.html`（`npm run build:extension`生成），通过原四节点workflow验收详情遮罩、两侧露出、透明层、不透明鼠标穿透层、圆角不确定性、采集拒绝和关闭恢复。十五轮二十七项浏览器断言已通过，含审查新增的前景穿透、后景负z-index、小块悬浮后代、祖先圆角、visibility子级恢复、静态grid层叠和现代颜色透明度反例。无法解析的颜色保持不确定，不默认不透明。旧357黄金×两profile共714次输出未变。

输入只按直接 Text 子节点判定 text 证据，不把 `textContent` 聚合成父节点文字。教师纠错中的 7 个同帧同矩形 span 包装是 `structure/ignore` 候选：自身无文本、唯一子元素同矩形，子元素的可见文字仍有自己的 `text/text` 标签；父 ignore 不删除子框和数据。行 17、29、43、50 这类多文本、链接或 img 子元素属于复合容器，按 `structure/container`，其子节点保留 text/image/link 等类别，不做自动后代标签继承。五项初步 91 行台账中的 ambiguous 项保持 ambiguous；ignore 不能由 class 名或跨观测关系强制返回。

用户后续明确：设计可训练的“人类可观测／可交互”过滤 filter。viewport 位置、最上层与露出区域、交互承载作为事实输入，保留/过滤由任务监督训练；阅读和显示内容也属于人类可用目标。本轮只交付最小契约与候选回归范围，不能把确定性遮挡预处理或已有 ignore 评分冒充完成该训练。

## 最小验收

图先 DAGpipe validate/inspect。基础模块红测覆盖教师字段泄漏、标错未定类被训练、缺 other 理由、legacy unknown-only 与 unresolved unknown+conflict 的范围差异、排除项误纳入、重复样本、>2500 项保序、错误权重导致现有配置丢失。真实浏览器 fixture 验证视口/overflow/隐藏、>2500 节点完整遍历、同一节点引用稳定、Focus 选择/取消/移除、滚动更新、动态变化不自触发、关闭后原网页点击恢复、单项纠错、未解决批量、ignore 默认不画但可查看及本地导出。Node 白盒不替代浏览器行为。

用户安装前先完成可审查构建物与同源harness实测。能操作Chrome安装时按实际权限完成；若需用户加载本地扩展，则明确该步未验证并提供具体文件夹，不能以harness冒称MV3已安装。完整milestone作者验收后一次独立审查，main合并/推送并清理任务资源。

## 作者验证结果与剩余边界

2026-10-17：扩展代码与可加载目录已构建，95项测试、库/UI类型检查通过。Chrome真实网页consumer遍历2714元素；色框与类别筛选、点选复核、未知批量去重、Focus子树/取消/移除/恢复、动态变更与关闭清理通过。32行真实下载包经公开提取器与training.prepare检查，仅1条verified入集，1条rejected与30条unreviewed均排除。2501行导出、裁剪矩形、稳定引用恢复、权重解析与标签数据边界由公开接口测试覆盖。过程证据、原始下载引用与截图在外置`browser-overlay`运行目录，项目汇总以note.md为准。

以上为初始交付时的安装边界；后续实际安装和现场证据以note.md为准。自动化文件选择被ChatGPT扩展的file URL权限拒绝，未改权限或换通道；权重文件选择后的界面应用仍需手工验收。首版只处理顶层DOM，iframe/shadow内部未覆盖，不宣称完成像素遮挡判断。采集会话驻留内存，刷新或导航前需导出；不自动上传或训练。

2026-10-17 候选呈现与关系输入升级：实时 adapter 读 DOM/CSS 后调用共享纯整形函数；候选节点继续负责 viewport/Focus/黑白名单。非格式直接文本、before/after 内容、背景图及 mask 存在性、关系几何与十项 nullable 测量随采集包保存，旧包缺项保留 null。工具注释根默认排除；额外排除根由资源显式提供，不排除普通 fixed 或 shadow 宿主。规则和连线唯一合同为 `docs/basic-kinds-wiring.md`。当前训练候选未采用，扩展重建也不表示用户页已加载新版；真实页面场景回归与现场重载核验仍待完成。
