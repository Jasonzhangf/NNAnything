# B-Input 独立输入 consumer

这个目录是 B2 单次输入合同的公开 consumer、两个独立页面家族和原生 CDP IO。公开入口是 `nnanything/browser-input` 的 `runBrowserInputGoal`，新进程 runner 是 `run.mjs`。

## 调用方法

```sh
npm run build
node playground/browser/input/run.mjs \
  --request /absolute/request.json \
  --io /absolute/playground/browser/input/cdp-io.mjs
```

`request.json` 使用 `BrowserInputRequest`：只含 `requestId`、`goal`、`satisfactionThreshold` 和显式 `bindings`。请求不含搜索的 phase、submit、results 字段。IO 模块需要 `createResources(request)` 与 `close()`；`createResources` 为本次运行创建自有 CDP target，`close()` 在 `finally` 关闭连接并返回副作用检查。

## 运行范围

`runBrowserInputGoal` 只处理显式绑定的普通 `input type=text`。它最多执行一次逻辑文本替换，然后重新观测实际 `.value` 并给出 `S/N/U`。placeholder、attribute、原生 receipt 不能替代真实读回。执行错误与观察错误分开返回；观察失败只能返回 U，不允许继续。

textarea、search input、contenteditable、password、敏感宿主和未确认资格都明确拒绝。页面 reset、取消 beforeinput、DOM 重建、焦点转移和旧后验均按合同停止，不自动补写、不换绑、不按 selector 或文案恢复。

## 两个独立实现家族

- 家族 A：复用 `playground/browser/search-fixture/page.mjs` 的普通文本页面，目标为 `#query`，相邻框为 `#notes`。只消费输入阶段，不点击提交、不发送 Enter、不读取结果区。
- 家族 B：`fixtures/family-b.mjs` 是独立的资料编辑 HTML 模板和独立页面脚本，使用嵌套 fieldset、`#display-name` 与 `#memo`，不 import、包装或复制家族 A 的 renderer，也不含搜索提交或结果集合逻辑。

两家族各执行相同 26 个固定实例（共 52）。页面脚本可以在初始化或自身事件处理内设置值、reset 或替换节点；Agent 的操作通道只使用 CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText`，不用 JS `.value=`、setter、`focus()`、`click()` 或 `dispatchEvent()` 冒充输入。

## 逐例验收

```sh
node playground/browser/input/accept.mjs \
  --family all \
  --cdp http://127.0.0.1:9333 \
  --out /absolute/run/acceptance
```

`accept.mjs` 为每例准备请求与 case 文件，再用 `process.execPath` 启动新的 `run.mjs` 进程，保存逐例回执、原生事件、观察证据和副作用检查。运行结束后落盘 `rows.jsonl`、`table.md` 和逐例目录。

验收程序对预期的拒绝、unknown 或非零退出码判定为该用例通过，不会把所有非零退出误算为失败。`run.mjs` 只在 episode 达到“可继续的正常成功”时退出 0，其余情况非零。

## 限制

本 consumer 不做对象自动选择、搜索提交、结果采集、重试或组合规划。真实浏览器验收只在受控自有 target 内执行；端点不可用时保留原始错误，不自行启动或接管浏览器。当前实现尚未在真实浏览器上完成 52 例验收，状态以 run 目录 `summary.md` 为准。
