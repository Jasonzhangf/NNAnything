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

## 独立验收与后续训练

运行 `npm run demo:cli` 可执行公开 consumer。它创建并回收自有目录，分别验证 pwd、路径、属性、链接、缺失路径与无权限结果，并确认目标内容和父进程 cwd 保持不变。测试入口为 `tests/cli-foundation.test.mjs`，覆盖绝对/相对路径、join、根目录、不存在路径、独立 session、真实 OS 属性、正常/断裂链接、错误隔离及 shell 元字符。

后续按基础观测 → 文件/目录操作语义 → 搜索组合推进。CLI 的长期目标仍是从 help 或说明学习能力及参数角色，再完成“在路径下找文件／找符号名称”。这些观测可提供训练行为证据；本轮没有拟合模型，不建立训练集/profile，也不宣称已实现 help 泛化、搜索或语义定义/引用解析。原生 [computer use](../lib/adapters/computer-use/README.md) 只有目录与说明占位。

最新的精确单操作词表及首个有界目录目标绑定训练设计见 [文件语义语言](cli-semantic-operations.md)。该文档为设计态，不改变本页已实现 API；输入使用语义语言，首轮不包含自然语言识别或组合规划。

逐能力训练的首项实现为[路径函数训练](cli-path-training.md)：独立`nnanything/cli-training`入口，真实Handwired拟合、显式profile和自主符号rollout。CLI命令训练当前由`nnanything/cli-goal`提供，只接typed`file.property`的PWD/CD/LS及控制结果；旧Goal动作入口已退役。两者都不替换本页确定性M0，也不自动采用候选。
