import { renderPage } from "../../search-fixture/page.mjs";

function escapeScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function behaviorScript(config) {
  return `
<script>
(function () {
  var cfg = ${escapeScript(config)};
  if (cfg.targetSelector === "#query-duplicate") {
    var base = document.querySelector("#query");
    if (!base) throw new Error("family A duplicate base missing");
    var copy = base.cloneNode(true);
    copy.id = "query-duplicate";
    base.insertAdjacentElement("afterend", copy);
  }
  var target = document.querySelector(cfg.targetSelector);
  var neighbor = document.querySelector(cfg.neighborRefs[0].selector);
  if (!target || !neighbor) throw new Error("family A fixture selectors missing");
  target.value = cfg.initialValue;
  neighbor.value = cfg.neighborValue;
  target.setAttribute("placeholder", cfg.placeholder || "");
  if (cfg.host !== "input") {
    var tag = cfg.host === "textarea" ? "textarea" : "div";
    var replacement = document.createElement(tag);
    replacement.id = target.id;
    replacement.className = target.className;
    replacement.value = cfg.initialValue;
    if (cfg.host === "contenteditable") replacement.setAttribute("contenteditable", "true");
    target.replaceWith(replacement);
    target = replacement;
  }
  target.type = cfg.type;
  if (cfg.readonly) target.setAttribute("readonly", "readonly");
  if (cfg.ariaReadonly !== null) target.setAttribute("aria-readonly", cfg.ariaReadonly ? "true" : "false");
  if (cfg.disabled) target.disabled = true;
  if (cfg.ariaDisabled !== null) target.setAttribute("aria-disabled", cfg.ariaDisabled ? "true" : "false");
  if (cfg.editableUnprobed) target.setAttribute("data-binput-editable-unprobed", "1");
  if (cfg.behavior === "reset") {
    target.addEventListener("input", function () { target.value = cfg.initialValue; });
  }
  if (cfg.behavior === "cancelBeforeInput") {
    target.addEventListener("beforeinput", function (event) { event.preventDefault(); });
  }
  if (cfg.behavior === "rebuildAfterInput") {
    target.addEventListener("input", function () {
      var clone = target.cloneNode(true);
      clone.value = target.value;
      target.replaceWith(clone);
    });
  }
  if (cfg.behavior === "stealFocus") {
    target.addEventListener("focus", function () { neighbor.focus(); });
  }
  if (cfg.behavior === "replaceOnCommand") {
    window.__bInputReplaceTarget = function () {
      var clone = target.cloneNode(true);
      clone.value = target.value;
      target.replaceWith(clone);
    };
  }
})();
</script>`;
}

export function renderFamilyA(config) {
  const profile = {
    id: "b-input-a",
    label: "普通文本输入",
    layout: { columns: 1, maxWidth: 920, cardBorder: false, fieldOrder: [], wrapperDepth: 0 },
    input: { tag: "input", type: "text" },
    groups: [],
  };
  const html = renderPage(profile, "normal", [profile]);
  return html.replace("</html>", `${behaviorScript(config)}</html>`);
}
