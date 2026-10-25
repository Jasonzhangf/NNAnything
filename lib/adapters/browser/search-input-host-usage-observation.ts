// B-A1 m2 R1: usage-relation observation projection.
//
// This module is the read-only bridge between a real observed page and the
// relation sub-unit proposed in m2-representation-plan.md section 4. It is
// deliberately separate from search-input-host-projection.ts: the binder
// candidate shape (34 wires) must not change until the m2 relation
// representation is accepted, so the new observation fields live here.
//
// What this module may read: the human-visible label text of the labels that
// really associate with the control, the placeholder attribute, the accessible
// name already measured by observeLiveDom, the submit controls that share the
// control's real form owner, and one caller-supplied access fact.
//
// What this module must never read: form action URL, method, input name,
// fixture/page id, file path, endpoint, handler, submitted result or gold,
// page title, class/id, or the written value. Those are teacher evidence only
// and stay physically separate from the student input.

import type {
  UsageAssociationCoverage,
  UsageChannelCoverage,
  UsageLabelChannel,
  UsageObserveInput,
  UsageObservation,
  UsageOwnedSubmit,
  UsageTextChannelCoverage,
} from "./search-input-host-usage-contract.js";

/**
 * Read the human-visible text of one submit control.
 *
 * A <button> carries its caption as text content. An <input type="submit"> or
 * <input type="button"> carries it as its value attribute, which is display
 * text, not a written value. Anything else is not a submit control.
 */
function captionOf(element: Element): string | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "button") {
    const text = (element.textContent ?? "").trim();
    return text.length > 0 ? text : null;
  }
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    if (type !== "submit" && type !== "button" && type !== "image") return null;
    const value = (element.getAttribute("value") ?? "").trim();
    if (value.length > 0) return value;
    // An image submit button exposes its alt text as the caption instead.
    const alt = (element.getAttribute("alt") ?? "").trim();
    return alt.length > 0 ? alt : null;
  }
  return null;
}

function isSubmitControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  if (tag === "button") {
    const type = (element.getAttribute("type") ?? "submit").toLowerCase();
    return type === "submit";
  }
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "").toLowerCase();
    return type === "submit" || type === "image";
  }
  return false;
}

/**
 * Resolve the real form owner of a control.
 *
 * The HTML form owner algorithm allows a control to point at a form that is not
 * its ancestor through the `form` attribute. `closest("form")` cannot see that
 * relation, so it is tried first (the common case) and the id reference is
 * resolved inside the allowed scope second. A dangling reference is reported as
 * an unresolved association rather than as "no form".
 */
function resolveFormOwner(
  element: Element,
  scopeRoot: Element,
): { form: Element | null; resolved: boolean; dangling: boolean } {
  // The HTML form owner algorithm is explicit about precedence: when the form
  // attribute is present it decides ownership, and an explicit reference that
  // does not resolve leaves the control without a form owner. The nearest
  // ancestor form is only the fallback when the attribute is absent. Checking
  // the ancestor first would hand a control to the wrong form whenever both
  // exist.
  const reference = typeof element.getAttribute === "function" ? element.getAttribute("form") : null;
  if (reference !== null && reference.trim() === "") {
    // An explicitly empty reference is a measured "no form owner", not a miss.
    return { form: null, resolved: true, dangling: false };
  }
  if (reference === null) {
    if (typeof element.closest !== "function") {
      // Neither the ancestor relation nor a form reference could be read, so the
      // ownership is unknown. Reporting "no form" here would turn an unread
      // relation into a confident absence.
      return { form: null, resolved: false, dangling: true };
    }
    const closest = element.closest("form");
    return closest === null
      ? { form: null, resolved: true, dangling: false }
      : { form: closest, resolved: true, dangling: false };
  }
  const id = reference.trim();
  // Resolve inside the allowed scope first so an out-of-scope form is never
  // adopted, then fall back to the document (the real form owner algorithm is
  // document-wide). Both lookups are optional: a unit host may not provide
  // either, and that is an unresolved association rather than "no form".
  const scoped = typeof scopeRoot.querySelector === "function"
    ? scopeRoot.querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`)
    : null;
  const doc = scoped === null && typeof globalThis.document?.getElementById === "function"
    ? globalThis.document.getElementById(id)
    : null;
  const lookup = scoped ?? doc;
  if (lookup === null || lookup.tagName.toLowerCase() !== "form") {
    return { form: null, resolved: false, dangling: true };
  }
  return { form: lookup, resolved: true, dangling: false };
}

/**
 * The accessible name already measured by observeLiveDom, or null when unread.
 *
 * `label` carries the already-projected label channel (texts plus coverage) so
 * an empty name read can be told apart from an unread one without inventing a
 * second accessible-name algorithm (ruling 2: reuse the live-dom name read, do
 * not build a new AAM).
 *
 * An empty read is a *proven* empty only when every declared name source was
 * considered: the live-dom read returned a complete empty value AND the
 * associated-label channel was itself measured complete with no label text. A
 * label is a name source for a form control, so "no aria-labelledby, no
 * aria-label, no title" alone does not prove an empty name (Alice ruling
 * 2026-10-24, milestone review P2-2). When the label channel is unread, or when
 * it does carry text, the empty read stays unread instead of being promoted to
 * eight false facts.
 */
function accessibleNameOf(
  evidence: Record<string, unknown> | null,
  properties: Record<string, unknown> | null,
  label: { readonly labels: readonly string[] | null; readonly coverage: UsageChannelCoverage },
): {
  name: string | null;
  coverage: UsageChannelCoverage;
} {
  const labelSettlesEmptiness = label.coverage === "complete"
    && label.labels !== null
    && label.labels.length === 0;
  // observeLiveDom reports the accessible name on the evidence map, not on the
  // basic-kind properties map. Prefer evidence, fall back to properties so a
  // caller that already has the name in hand can pass it either way.
  const source = evidence ?? properties;
  if (source === null) return { name: null, coverage: "unmeasured" };
  const raw = source.accessibleName;
  const declared = source.accessibleNameCoverage;
  const unresolved = source.labelledByUnresolved === true;
  if (typeof raw === "string") {
    // A truncated name is a partial read. It is kept but never reported as a
    // complete name, so the extractor refuses to score it.
    return { name: raw, coverage: declared === "complete" ? "complete" : "truncated" };
  }
  if (declared === "complete") {
    // The live-dom read resolved its declared source and carried no text. That
    // covers the aria/title sources only, so it is a measured absence only when
    // the label source also measured empty. Otherwise the name is unread and
    // must stay null rather than become eight false facts.
    return labelSettlesEmptiness
      ? { name: "", coverage: "complete" }
      : { name: null, coverage: "unmeasured" };
  }
  if (declared === "unavailable") {
    // aria-labelledby existed but resolved to nothing. An unresolved reference
    // is an unfinished read. A resolved-but-empty set is a measured absence only
    // under the same label condition as above.
    if (unresolved) return { name: null, coverage: "unmeasured" };
    return labelSettlesEmptiness
      ? { name: "", coverage: "complete" }
      : { name: null, coverage: "unmeasured" };
  }
  if (declared === null || declared === undefined) return { name: null, coverage: "unmeasured" };
  return { name: null, coverage: "unavailable" };
}

/**
 * The label texts that really associate with the control, in document order.
 *
 * `labels` returns null when the element cannot carry labels at all (so "no
 * label" is an empty array, while "not readable" stays null). Reading only the
 * first label loses the collision evidence the plan needs, so every associated
 * label is kept.
 */
function labelChannelOf(element: Element): UsageLabelChannel {
  const labels = (element as HTMLInputElement).labels;
  if (labels === null || labels === undefined) {
    // Either the element type cannot have labels, or the property is not
    // available in this environment. Both are "not readable" for this unit.
    return { labels: null, coverage: "unmeasured" };
  }
  const texts: string[] = [];
  for (const label of Array.from(labels)) {
    texts.push((label.textContent ?? "").trim());
  }
  return { labels: texts, coverage: "complete" };
}

function placeholderChannelOf(element: Element): UsageTextChannelCoverage<string> {
  const raw = element.getAttribute("placeholder");
  // A missing attribute is an observed "no placeholder", not an unread value.
  return { value: raw === null ? "" : raw, coverage: "complete" };
}

function ownedSubmitsOf(form: Element | null, resolved: boolean): {
  submits: readonly UsageOwnedSubmit[];
  coverage: UsageAssociationCoverage;
} {
  if (!resolved) return { submits: [], coverage: "unmeasured" };
  if (form === null) return { submits: [], coverage: "complete" };
  const created: UsageOwnedSubmit[] = [];
  // The form's own control collection is the truth about what it owns. A control
  // listed through `form="id"` is owned by the form without being a DOM
  // descendant, so a descendant query alone would report "no submit" for a form
  // that really has one. `elements` is the same collection the browser uses for
  // submission, so it is the authority here, not a heuristic — and when it is
  // unavailable the association is unread rather than guessed.
  const collection = (form as HTMLFormElement).elements;
  if (collection === null || collection === undefined || typeof (collection as ArrayLike<Element>).length !== "number") {
    return { submits: [], coverage: "unmeasured" };
  }
  const candidates = Array.from(collection as ArrayLike<Element>);
  for (const element of candidates) {
    if (!isSubmitControl(element)) continue;
    const caption = captionOf(element);
    created.push({
      caption,
      association: "same_form_owner",
      captionCoverage: caption === null ? "unmeasured" : "complete",
    });
  }
  return { submits: created, coverage: "complete" };
}

/**
 * Project one observed control into the relation-observation shape.
 *
 * Every "unread" stays null or unmeasured. Nothing is coerced to a default, so
 * the relation sub-unit can abstain instead of guessing.
 */
export function observeUsageRelation(input: UsageObserveInput): UsageObservation {
  const element = input.element;
  const properties = input.properties;
  const label = labelChannelOf(element);
  const placeholder = placeholderChannelOf(element);
  const accessible = accessibleNameOf(input.evidence ?? null, properties, label);
  const owner = resolveFormOwner(element, input.scopeRoot);
  const submits = ownedSubmitsOf(owner.form, owner.resolved);
  return {
    ref: input.nodeRef,
    scopeRef: input.scopeRef,
    documentRef: input.documentRef,
    observationId: input.observationId,
    revision: input.revision,
    labels: label.labels,
    labelCoverage: label.coverage,
    placeholder: placeholder.value,
    placeholderCoverage: placeholder.coverage,
    accessibleName: accessible.name,
    accessibleNameCoverage: accessible.coverage,
    // An unmeasured association keeps its control list null. An empty array
    // beside an "unmeasured" coverage would read as "measured: no submit".
    ownedSubmits: owner.dangling || submits.coverage === "unmeasured" ? null : submits.submits,
    associationCoverage: owner.dangling ? "unmeasured" : submits.coverage,
    formResolved: owner.resolved,
    access: input.access,
  };
}
