---
name: nn-code
description: 旧确定性 nn-code 产品已停用；不得用于项目查询或推荐调用。当前研究训练授权见 autonomous-capability-roadmap。
---

# nn-code 旧产品已停用

旧 `nn-code` 产品保持停用，不作为神经网络能力交付，不用于日常项目查询，也不恢复产品推广。用户已恢复的是整体重设计与研究训练授权，不是恢复旧产品。

- 当前研究训练路线定位在 `docs/autonomous-capability-roadmap.md` 的“2026-11-05 用户已恢复整体重设计、训练与并行推进”一节：Alice route r1 已接受，保留 64 维输入、两层隐藏层、统一格式和固定推理引擎；首个实验方向是 TS/JS import/reexport/alias 与终端声明判断。
- 训练启动条件在该文件的 launch 条件中：等待 Alice 通过设计后的具体 launch 合同，不重复等待用户逐项批准。旧确定性 `nn-code` 实现仍仅作为 teacher、oracle、样本与对照。
- 旧实现和结果不自动成为 gold，不因训练授权恢复而自动启用、推广或接入产品。
- 日常源码查询使用 `rg` 和源码读取，不调用当前 `nn-code`。
- 训练候选只能进入独立候选路径，并要求保存、新进程回载、独立留出评价与旧能力回归齐全后，才可进入 model-evolution 采用流程。
- 本文件不改写 `AGENTS.md` 的“授权冲突待用户直接裁定”段落；该段落属项目 owner/用户边界，仍需项目 owner 核对。

本文件仅阻止继续使用，不提供执行入口。源码、权重、原始日志及失败证据保留供只读审计。
