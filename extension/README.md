# NNAnything DOM Inspector (Chrome/Chromium MV3 Extension & Harness)

Local Chrome/Chromium browser extension and evaluation test harness for NNAnything DOM basic-kind visual inspection, Focus scoping, and human capture/correction.

## Architecture & Features

1. **Manifest V3 Extension Shell (`extension/`)**:
   - Permissions: Strictly `activeTab` and `scripting` only. No host permissions, no downloads, no storage, no network permissions.
   - Background service worker: Handles action click to toggle the inspector on the active tab; validates page protocols and flags restricted URLs (`chrome://`, `edge://`, `about:`, etc.) via extension badge (`ERR`) without throwing unhandled exceptions.
   - Content script: Executes in the extension's isolated world as a singleton controller.

2. **ShadowDOM Isolated Inspector UI (`extension/controller.ts`)**:
   - Single excluded host element (`#nnanything-dom-inspector-host`) attached to `document.documentElement` with an open `ShadowRoot`.
   - Host element is explicitly excluded from live DOM traversal via `excludeHost` in `createBrowserOverlayNodeDefinitions`.
   - Overlay canvas with `pointer-events: none` rendering YOLO-like category bounding box outlines (button, link, input, select, text, container, list, listitem, image, video, audio, other).
   - Distinct status outlines: unknown (dashed slate), conflict (dashed orange), Focus target (double violet with distinct badge).
   - Labels shown on hover/selected, or globally via the "显示全部标签" checkbox.
   - Fixed control panel (top-right, ~320px width, max-height responsive down to 390px, slate design system, no marketing gradients).
   - Scores are clearly marked as `未校准` (uncalibrated). They are not calibrated probabilities or percentages.
   - Coverage metrics: Reports top-document element count, traversed elements, and counts of unassessed iframe and open shadow root internals.

3. **Focus Subtree Scoping & Stale Scope Protection**:
   - Selecting a Focus element confines candidate filtering to that element's DOM subtree.
   - If the Focus target element is removed from the DOM, the inspector detects the detachment, displays `⚠️ Focus 失效：目标元素已脱离 DOM`, clears all bounding boxes, and retains the selection until the user explicitly clicks `清除Focus` (does not silently widen to the entire viewport).

4. **Single-Click Picking Mode**:
   - "检查元素" and "选择Focus" enter a dedicated single-click picking mode.
   - Event interception: Uses capture-phase window listeners (`preventDefault()` + `stopImmediatePropagation()`) so underlying website links, forms, or buttons never fire during picking.
   - ESC key cancels picking mode immediately. Normal pointer interactions restore upon selection or cancellation.

5. **Human Review, Annotation & Capture Session**:
   - Predictions are labeled as proposals (`[提议 proposal]`). No verified badge is assigned without explicit human confirmation.
   - Review options:
     - `正确` (Confirmed correct): Confirms predicted category. If category is `other`, a concrete reason is required.
     - `标错` (Mark wrong): Prompts for corrected class from dropdown. If `other` is chosen, a reason is required. If marked wrong without a corrected class, status remains `rejected`.
     - `待复核` (Unsure): Marked as ambiguous.
   - `一键收集当前未知 (N)`: Captures all qualified unknown slots (`candidateStatus === 'ok' && judgmentStatus === 'unknown'`) without overwriting previously reviewed items.
   - `收集当前候选 (N)`: Captures every qualified candidate (`candidateStatus === 'ok'`), including known, unknown, conflict, and judged `ignore` slots. Rows stay unreviewed with their original proposal; filtered and candidate-unknown slots are excluded.
   - `导出 JSON 样本包`: Calls capture workflow export and triggers a client-side Blob JSON download anchor (`nnanything-capture-<sessionId>.json`).

6. **Native File Weight Source**:
   - Starts unconfigured. The extension has no embedded, default, or build-selected weight asset.
   - The visible "选择权重文件" button calls `showOpenFilePicker` directly from the user click.
   - The controller keeps only the `FileSystemFileHandle`. Each classification calls `getFile()` and reads the file text again.
   - A read, JSON, or weight-contract failure clears the old frame and collection eligibility through the normal error path.
   - Cancelling the picker preserves the current source. The handle remains available when the controller is closed and reopened in the same document. It is not restored after navigation or browser restart.

7. **Lifecycle & Coalescing**:
   - Coalesced `requestAnimationFrame` refresh pending flag prevents concurrent workflow executions and self-observer loops.
   - MutationObserver observes document changes while ignoring mutations within the inspector's own host element.
   - Scroll (capturing on window and scrollable containers) and resize listeners trigger refreshes.
   - `destroy()` disconnects observers, cancels rAF, removes all window/document listeners, and removes the host element, fully restoring the host page.

8. **Training Request Extraction CLI (`playground/overlay/extract-training.mjs`)**:
   - Extracts a valid `BasicKindTrainingRequest` from an exported capture bundle JSON:
     ```bash
     node playground/overlay/extract-training.mjs --input <bundle.json> --out <training-request.json>
     ```
   - Enforces strict bundle validation via `extractTrainingRequestFromBundle`.
   - Creates a new output file atomically (`wx`). Existing files are not overwritten.

---

## Build Instructions

Build requires Node.js >= 20.

```bash
# 1. Typecheck the UI against the real library API and DOM types
npm run typecheck:ui

# 2. Build the extension and harness bundles (via esbuild)
npm run build:extension
```

The command builds the library first, then bundles the extension and harness into `artifacts/chrome-extension` and `artifacts/overlay-harness`. A missing dependency fails the build. The build does not accept `--weight-file`; obsolete use is reported as a normal argument error.

Here, reloading means refreshing the website document. Reloading the extension in the extension manager does not refresh an existing website or remove its old inspector context. Export the current samples, reload the extension, refresh each target website, then open the inspector once. Opening the inspector before that website refresh can leave old and new panels together, with different weights and counts.

---

## Loading Unpacked Extension in Chrome / Chromium

1. Open Chrome or any Chromium-based browser (Edge, Brave, Arc, etc.).
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked** (加载已解压的扩展程序).
5. Select the directory:
   `<project-root>/artifacts/chrome-extension`
6. The extension "NNAnything DOM Inspector" will appear in the toolbar.
7. Click the extension icon on any standard web page (`https://...` or `http://localhost:...`) to toggle the inspector overlay.

Warning: do not select `<project-root>/extension`. That folder holds the TypeScript sources and has no built `.js` file, so Chrome reports "Could not load manifest." and "Could not load background script". If `artifacts/chrome-extension` is missing or older than the sources, run `npm run build:extension` first; the directory only exists after that build.

---

## Running the Evaluation Test Harness

The test harness provides an interactive test page containing >2500 DOM elements, including form controls, scrollable containers with overflow clipping, hidden/zero-size elements, role conflicts, dynamic element addition/removal, and Focus target detachment tests.

```bash
# Serve the built harness directory using standard Python HTTP server:
python3 -m http.server 8080 --bind 127.0.0.1 -d artifacts/overlay-harness
```

Open `http://localhost:8080` in your browser.

### Test Harness Verification Steps

1. **Inspector Toggle**: Click "打开 DOM 审查器" to mount the overlay; click "关闭审查器" to verify clean unmount and restoration of page state.
2. **Normal vs Picking Clicks**:
   - Click "测试普通网站按钮点击": verify the click counter increments.
   - Click "检查元素" in the panel to enter picking mode. Click the same button: verify the button click is intercepted (counter does NOT increment) and the element is selected in the inspector panel.
3. **Focus Subtree & Stale Protection**:
   - Click "选择Focus", select the purple dashed "Focus 目标子树容器": verify only elements inside this container are candidates.
   - Click "移除 Focus 目标元素": verify the inspector displays the `⚠️ Focus 失效` warning, clears all bounding boxes, and does not silently widen to the viewport.
   - Click "恢复 Focus 目标元素" and "刷新": verify Focus detection recovers when the element is restored.
   - Click "清除Focus": verify overlay resets to full viewport candidates.
4. **Human Review & Correction**:
   - Inspect any candidate element.
   - Select "正确" (or "标错" and choose a corrected class from the dropdown).
   - Click "保存此元素样本": verify session stats counter updates.
5. **Bulk Unknown Collection**:
   - Click "一键收集当前未知": verify eligible unknown candidates (`candidateStatus === 'ok' && judgmentStatus === 'unknown'`) are added to the session.
   - Click "收集当前候选": verify all qualified slots are added as unreviewed rows and the button count matches the view's candidate count.
6. **Export & Extraction**:
   - Click "导出 JSON 样本包": verify the browser downloads `nnanything-capture-<sessionId>.json`.
   - Run the extraction CLI:
     ```bash
     node playground/overlay/extract-training.mjs --input nnanything-capture-xxx.json --out extracted-request.json
     ```
   - Verify the extracted file is a valid `BasicKindTrainingRequest`.
7. **Native File Weight Source**:
   - In the inspector panel, click "选择权重文件" and select a compatible weight JSON through the native file picker.
   - Verify the profile tag changes to the selected file name and the classification frame updates.
   - Replace the selected file contents and click "刷新". Verify the next classification reads the new contents without another file selection or extension reload.
   - Make the file malformed or unavailable, then click "刷新". Verify the boxes and collection eligibility clear with an inline error. Restore the file and refresh to recover without selecting it again.
