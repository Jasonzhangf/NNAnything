# 基础种类离线训练公开 Consumer

在仓库根执行：

```sh
npm run demo:training -- --handwired-root <source-root>
# 或显式指定样本集与输出目录：
npm run demo:training -- --input <reviewed.json> --output-root <dir> --handwired-root <source-root>
```

默认使用 `playground/training/reviewed.fixture.json` 合成样例。为清晰演示参数拟合过程，默认合成样例运行时刻意弱化了基础 profile（`training-demo-deliberately-weak-base`，将基础权重置零）；当通过 `--input` 传入外部真实复核样本时，则使用真实的手写基线 profile（`DEFAULT_BASIC_KIND_PROFILE`）。

Handwired 源码根目录必须显式配置：通过 `--handwired-root <dir>` 命令行参数或 `HANDWIRED_ROOT` 环境变量指定。缺失时抛错拒绝，不进行假训练。

输出根目录 `--output-root` 默认指向仓库根目录（权重保存至 `training/weights/dom-basic-kinds/`，报告保存至 `training/results/dom-basic-kinds/`，使用唯一的 run ID）；亦可指定已存在的自定义目录。写入使用 `wx` 排他创建，已有同名文件拒绝覆盖。

`--input-scope properties_offline` 可复核原候选状态为 `not_evaluated` 的本地样本；该模式只验证离线单节点属性训练，不证明浏览器视口与候选资格链通过。

Consumer 通过 `nnanything` 加载并编译 `workflows/node-training.workflow.json`（绑定 0.1.0），通过 `nnanything/training` 创建六个真实节点，并显式授予 `filesystem.read` 与 `filesystem.write`。拟合与新旧双轨比较绑定相同的基础 profile，运行结束后从写入的权重资产回读 profile，并用 `nnanything/browser` 的正式分类器复核。

权重产物保持未校准状态（`calibrated: false`），且绝不自动替换现有基础 profile（`candidateAdoption: "not_applied"`）。公开入口导出样本/schema 转换、来源分区、比较、评估、持久化、节点工厂和数值适配 API。训练仅离线运行，不采集页面，不执行浏览器动作。
