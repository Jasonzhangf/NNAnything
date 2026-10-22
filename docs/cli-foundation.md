# CLI 基础语义 M0

本轮从 pwd、路径和文件属性开始。独立入口为 `nnanything/cli`。路径解释是纯函数；实际工作目录和属性由 CLI／文件系统适配器观测。三项能力使用显式 I/O，不读取隐藏 session 状态，不修改父进程工作目录。

## 使用

```ts
import { createCliSession, interpretCliPath } from 'nnanything/cli';

const session = createCliSession({
  cwd: '/absolute/project',
  grantedEffects: ['filesystem.read', 'process.exec'],
});

await session.observe({ kind: 'pwd' });
await session.observe({ kind: 'path', path: '../project/docs', join: ['notes.txt'] });
await session.observe({ kind: 'attributes', path: 'README.md', followSymlinks: false });

// 不检查目标是否存在，不启动进程，不读取文件系统。
interpretCliPath('/absolute/project', { kind: 'path', path: 'future/file.ts' });
```

`createCliSession` 同步检查配置。`cwd` 必须是无 NUL 的非空绝对路径；创建 session 不要求该目录已存在。`grantedEffects` 必须显式提供，构造时复制。session 固定该解析基准，不隐式执行 `cd`。所有请求返回 `{ok:true, observation}` 或 `{ok:false, error:{operation,stage,code,message}}`。非法 session 配置直接抛错。

| 请求 | 语义及输出 | 所需授权 |
| --- | --- | --- |
| `pwd` | 固定 `/bin/pwd -P` 的原始 stdout、stderr、退出码、配置目录与物理目录 | `filesystem.read`、`process.exec` |
| `path` | 原始输入、绝对/相对形式、join 后规范路径、相对 cwd 解析的绝对路径与父目录 | 无业务 IO 授权 |
| `attributes` | 实际对象类型、大小、mode/uid/gid、时间，按显式跟随策略选择 stat/lstat | `filesystem.read` |
| `read` | 普通文件的显式 offset/length 范围字节（base64）、bytesRead、eof、读时 size 与 observedRange | `filesystem.read` |

模块调用实际持久 `cli-foundation.workflow.json` 与 `cli-foundation.graph.json`，复用现有 compiler、runner 与 Flowed。控制文件加载与业务 IO 分开；节点合同卡见 [节点清单](../lib/nodes/README.md)。固定工作目录在节点工厂中注入，授权从现有 workflow context 明确传入。路径请求不因 IO 未授权而失败。

## 路径引用与实际对象

路径只是引用。纯解释结果不证明目标存在。路径计算按宿主 `node:path` 规则，先 join、再 normalize，并相对显式 cwd 解析。空路径、NUL 和未知字段被拒绝。`~`、`$HOME`、`*` 都保留字面含义，不展开 shell 内容。

M0 的 `attributes` 观察纯路径解释所得的绝对路径。这是显式的词法解析合同。它先消除 `.` 和 `..`，不等价于经过符号链接逐段解析的 OS 路径查找。例如 `link/../x` 的词法路径与直接把同一原始字符串交给 shell 工具的目标可能不同。纯路径请求不声称解析符号链接；`pwd -P` 的物理路径单独返回。

`cwd` 是解析基准，不是安全根。绝对路径和 `..` 可以引用其他目录。操作只观察调用者指定的单个路径，不扫描目录。M0 面向 macOS/POSIX：`pwd` 固定 `/bin/pwd`，未声明 Windows 进程入口兼容。

## 属性与错误

`followSymlinks:false` 使用 `lstat`，链接返回自身属性与 `readlink` 原始目标文本；`true` 使用 `stat`，返回目标属性。断链在前一种请求中仍可被观察，后一种请求返回 `ENOENT`。不把链接文本解释成已经存在的目标。

大小保留 OS 字节值；目录大小不表示目录下文件总大小。`ctimeMs` 是元数据变化时间，不是创建时间。`birthtimeMs` 不可用时为 null。`mode/uid/gid` 不等于有效访问权限，不能替代 ACL 或实际访问结果。多次系统调用不是原子快照。

请求字段错误返回 validate/EINVAL；缺授权返回 authorize/EFFECT_DENIED；OS 错误保留 ENOENT、ENOTDIR、EACCES 等原始错误码。错误不变为空成功。失败请求不会关闭 session，后续独立请求仍可执行。工作流控制文件读取或编译失败属于模块配置错误，公开调用会拒绝 Promise，不伪装为目标路径错误。

pwd 不接收任意 executable、argv 或命令字符串。子进程使用 `shell:false`，stdout 只移除末尾一个换行来取路径，不用 trim 删除合法空格。正常查询不读取文件正文，不写目标文件，不启动桌面操作。

## 内容范围读取

`read` 只对普通文件返回字节范围。`offset`/`length` 必须是非负安全整数。读取前先 `lstat`：最终符号链接被拒（`ELOOP`），非普通文件被拒（`READ_TYPE_DENIED`，含实际类型名）。打开阶段是安全边界：以 `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` 打开，最终符号链接即使检查后被换入也在 `open` 直接失败（`ELOOP`），FIFO 不会阻塞；打开后 `fstat` 核对类型，并把打开的 `dev/ino` 与 `lstat` 前记录的身份比对，被换成另一普通文件则拒（`READ_TARGET_CHANGED`）。返回 `bytes`（base64）、`bytesRead`、`eof`、读时 `size` 与 `observedRange`。

平台边界：`O_NOFOLLOW`/`O_NONBLOCK` 是本机 macOS/POSIX 语义；Windows 等无 `O_NOFOLLOW` 的平台不在当前运行范围。受控替换反例（symlink/FIFO/普通文件换入）见 `tests/cli-file-read.test.mjs`。零长度读取合法，但仍通过同一打开与身份核对；零长度读取不声称 EOF。有范围数据不声称已读完整文件；`eof` 只表示本次读取未填满请求长度。一次读取不是原子快照，不支持并发语义。不打开 FIFO/socket/设备流做普通文件读取，不写目标文件。

## 独立验收与后续训练

运行 `npm run demo:cli` 可执行公开 consumer。它创建并回收自有目录，分别验证 pwd、路径、属性、链接、缺失路径与无权限结果，并确认目标内容和父进程 cwd 保持不变。测试入口为 `tests/cli-foundation.test.mjs`，覆盖绝对/相对路径、join、根目录、不存在路径、独立 session、真实 OS 属性、正常/断裂链接、错误隔离及 shell 元字符。

后续按基础观测 → 文件/目录操作语义 → 搜索组合推进。CLI 的长期目标仍是从 help 或说明学习能力及参数角色，再完成“在路径下找文件／找符号名称”。这些观测可提供训练行为证据；本轮没有拟合模型，不建立训练集/profile，也不宣称已实现 help 泛化、搜索或语义定义/引用解析。原生 [computer use](../lib/adapters/computer-use/README.md) 只有目录与说明占位。

最新的精确单操作词表及首个有界目录目标绑定训练设计见 [文件语义语言](cli-semantic-operations.md)。该文档为设计态，不改变本页已实现 API；输入使用语义语言，首轮不包含自然语言识别或组合规划。

逐能力训练的首项实现为[路径函数训练](cli-path-training.md)：独立`nnanything/cli-training`入口，真实Handwired拟合、显式profile和自主符号rollout。CLI命令训练由`nnanything/cli-goal`提供，统一共享policy的7个语义head为`pwd`、`cd`、`ls`、`path.resolve`、`path.relative`、`path.parts`、`entry.inspect`，另有`unsupported`、`DEFER`、`NOOP`三个控制head；旧Goal动作入口已退役。两者都不替换本页确定性M0，也不自动采用候选。

## 2026-10-21 能力盘点与推进顺序

本次交付是受限文件系统基础能力，不等于完整Shell。S00–S20共21项，20项完成，S06部分完成；现存五项UNVERIFIED继续保留。完整计划与完成要求见[基础任务计划](cli-foundation-plan.md)。本次新增能力属于直接观测O或确定性计算D，没有增加学习头或重新训练共享policy。

| 层与入口 | 现在能做什么 | 使用边界 |
| --- | --- | --- |
| `nnanything/cli`：`createCliSession`、`interpretCliPath` | 观测真实pwd、解释路径、按显式follow策略观测属性、按offset/length读取普通文件字节 | session的cwd固定；路径可解析不表示存在；cwd不是安全根；范围读取不表示完整内容 |
| `nnanything/cli-goal`：`createCliCommandPolicy().step` | 对已注册typed `file.property`目标选择七个语义head及三个控制head，观察目录直接子项，检查或改变显式session cwd | 显式加载profile和绑定；不解析自然语言，不生成任意shell；执行退码0不等于Goal达成；`cd`不改变调用者进程cwd |
| 独立纯函数：`observeContentFormat`、`readDeclaredReferences`、`compareSnapshots` | 按字节提供有限签名/UTF-8/JSON证据；从显式JSON声明字段提取引用；比较前后快照并列出proof | 实现在`lib/filters/cli-content.ts`、`cli-declaration.ts`、`cli-change.ts`；尚未由包子入口导出，也未接入共享policy。签名不证明整个格式有效；声明scope为词法边界，不是物理沙盒；缺测不补相等 |
| 公开组合consumer | 词法路径→存在性/类型→范围读取→目录项与链接证据；验证拒权和无写入后验 | `playground/cli/foundation-s18/read-only-combination.mjs`为调用者显式编排；不是模型已学会搜索或任意组合 |
| 通用递归Goal模块 | 可复用根Goal保留、子Goal反向满足、真实State评价和错误返回 | 本轮未把上述新内容函数接为递归技能；现有cwd验证不等于任意文件任务已接入 |

已有共享模型为10×30共300参数，候选仍为`uncalibrated/not_applied`、`fullyVerified=false`。本轮没有新增训练或采用。作者全量1075/1075及公开consumer证据、完整Review和各轮定点复核归档于`/Volumes/Intel/playground/nnanything-runs/cli-foundation-20261021/`；通过Review只关闭已报告缺陷，不消除平台与能力缺口。

### 下一步最小闭环：显式目录内精确名称查找

优先验证一个只读目标：在调用者显式授权、已绑定的目录中，取得名称与目标完全相同的直接子项。目标仍沿`file.property.xxx`体系定义，新增属性名及typed请求先在[领域合同](cli-filesystem-semantics.md)收敛，不把下述步骤当作已有API。

1. 固定四元素和评价口径：Goal给出目录与精确名称；State保留目录观测、覆盖和错误；Action只做已授权列举及必要inspect；二元目标阈值为100。完整枚举且无匹配、观测不完整、拒权、匹配但类型不符须分开返回。负向查找结论不能从部分枚举得出。
2. 将实际读取、名称比较与候选选择分开。可直接观测或确定性比较的事实不造训练头。组合若需学习，只训练当前条件下的操作/候选选择；继续、预算和递归层序由harness控制。新增学习操作仍使用共享`cli.command-policy.v1`，不另建每命令模型。
3. 先用现有目录列举和inspect做最小consumer，验证命中、完整无命中、同名不同类型、特殊名称、拒权、部分覆盖和无写入。错误必须回收到根Goal，不能把“流程跑完”当作“找到了”。
4. 首例成立后才扩展有界递归目录搜索，再扩展内容条件。递归时必须明确范围、深度/预算、链接跟随规则及覆盖；不隐式扫描整个文件系统。内容读取是独立技能，不能把它当作现有七个head已经支持的操作。

这条组合主线可以在当前已验证的普通文件/目录范围内推进。特殊文件的证据补齐可以独立进行，不以缺Linux环境阻断未受影响的只读首例，也不降低第一层完整验收。

### 仍须完成的基础与后续能力

- 基础证据：character_device、block_device、other三类fixture、synthetic dev/ino注入、syscall零I/O追踪五项仍UNVERIFIED；Linux行为尚未验收。下一轮先确认具体环境和可用观测入口，不能推断或提权清零。
- 能力接入：内容格式、声明引用和变化比较目前是独立函数。只有组合用例确实需要时，才补typed导出、节点/技能绑定及对应图；不能把存在源码写成统一推理已经可调用。
- 缺失原语：写操作、`path.realpath`、`file.property.links`与role尚未实现。路径/链接与物理范围能力在需要跟随链接或判断物理范围前补；创建、移动、删除、写入按单个属性变化分别闭环，不能并成任意shell能力。
- 更高层：文件编程/日常用途、符号定义/引用解析、help能力学习、自然语言目标理解仍在后续。先有独立基础事实和最小组合，再训练用途/角色；文件名、扩展名或一次成功都不能直接充当角色gold。
- 单元升级：运行样本自动收集、后台后训练、热重载实验和无回归自动采用仍是后续机制，沿[模型演进合同](model-evolution.md)。有回归或证据冲突保留当前版本并交大模型裁决。

建议下一批只立“显式目录内精确名称查找”一个行为目标，同时补可独立取得的基础证据。该批通过最小实验、真实consumer和独立留出评价后，再决定加训练还是补表示；不预先重写核心框架，也不同时铺开写操作、用途识别与任意命令理解。
