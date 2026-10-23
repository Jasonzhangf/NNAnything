function escapeScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderFamilyB(config) {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>资料编辑样本</title>
<style>
  :root { font: 16px/1.5 system-ui, sans-serif; color: #1f2937; background: #f4f4f0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; }
  .sheet { max-width: 640px; margin: auto; background: #ffffff; border: 1px solid #d7d9d3; padding: 24px; }
  fieldset { border: 1px solid #c8ccc4; margin: 0 0 18px; padding: 14px 16px; }
  legend { font-weight: 600; padding: 0 6px; }
  label { display: block; margin: 10px 0; }
  input, textarea { width: 100%; font: inherit; border: 1px solid #9aa39b; padding: 8px 10px; }
  .hint { color: #55615a; font-size: 13px; }
</style>
<main class="sheet">
  <h1>资料编辑</h1>
  <fieldset>
    <legend>基本资料</legend>
    <label for="display-name">显示名
      <input id="display-name" name="displayName" type="text" autocomplete="off">
    </label>
  </fieldset>
  <fieldset>
    <legend>补充说明</legend>
    <label for="memo">备注
      <input id="memo" name="memo" type="text" autocomplete="off">
    </label>
    <p class="hint">相邻字段保持独立，不作为本次编辑目标。</p>
  </fieldset>
</main>
<script>
(() => {
  const cfg = ${escapeScript(config)};
  const base = document.getElementById("display-name");
  const memo = document.getElementById("memo");
  if (!base || !memo) throw new Error("family B fixture fields missing");
  if (cfg.targetSelector === "#display-name-duplicate") {
    const copy = base.cloneNode(true);
    copy.id = "display-name-duplicate";
    copy.name = "displayNameDuplicate";
    base.insertAdjacentElement("afterend", copy);
  }
  let target = document.querySelector(cfg.targetSelector);
  const neighbor = document.querySelector(cfg.neighborRefs[0].selector);
  if (!target || !neighbor) throw new Error("family B fixture selectors missing");
  target.value = cfg.initialValue;
  neighbor.value = cfg.neighborValue;
  target.setAttribute("placeholder", cfg.placeholder || "");
  if (cfg.host === "textarea") {
    const area = document.createElement("textarea");
    area.id = target.id;
    area.name = target.name;
    area.value = cfg.initialValue;
    target.replaceWith(area);
    target = area;
  } else if (cfg.host === "contenteditable") {
    const editable = document.createElement("div");
    editable.id = target.id;
    editable.setAttribute("contenteditable", "true");
    editable.textContent = cfg.initialValue;
    target.replaceWith(editable);
    target = editable;
  } else {
    target.type = cfg.type;
  }
  if (cfg.readonly) target.setAttribute("readonly", "readonly");
  if (cfg.ariaReadonly !== null) target.setAttribute("aria-readonly", cfg.ariaReadonly ? "true" : "false");
  if (cfg.disabled) target.disabled = true;
  if (cfg.ariaDisabled !== null) target.setAttribute("aria-disabled", cfg.ariaDisabled ? "true" : "false");
  if (cfg.editableUnprobed) target.setAttribute("data-binput-editable-unprobed", "1");
  if (cfg.behavior === "reset") target.addEventListener("input", () => { target.value = cfg.initialValue; });
  if (cfg.behavior === "cancelBeforeInput") target.addEventListener("beforeinput", event => event.preventDefault());
  if (cfg.behavior === "rebuildAfterInput") {
    target.addEventListener("input", () => {
      const clone = target.cloneNode(true);
      clone.value = target.value;
      target.replaceWith(clone);
    });
  }
  if (cfg.behavior === "stealFocus") target.addEventListener("focus", () => neighbor.focus());
  if (cfg.behavior === "replaceOnCommand") {
    window.__bInputReplaceTarget = () => {
      const clone = target.cloneNode(true);
      clone.value = target.value;
      target.replaceWith(clone);
    };
  }
})();
</script>
</html>`;
}
