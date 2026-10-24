// B-A1 M1 phase 2: production projection for the search-input-host binder.
//
// This is the wiring between the real browser adapter and the numeric unit. It
// reads only fields that `observeLiveDom` already measures, plus structural
// facts read from the resolved element (form membership, label, adjacency) and
// one caller-supplied access fact. It never reads raw page text into the unit:
// the text-cue wires receive booleans about a declared cue list only.
//
// Depth is measured relative to the allowed scope root, not as a global DOM
// depth, because global depth is a forbidden student feature in this project.

import type {
  SearchInputHostCandidate,
  SearchInputHostCoverage,
  SearchInputHostDepthBand,
  SearchInputHostHost,
  SearchInputHostInferInput,
  SearchInputHostType,
} from "./search-input-host-contract.js";
import { SEARCH_INPUT_HOST_ROLE } from "./search-input-host-contract.js";

/** Declared cue lists. These are the only text facts the unit may receive. */
export const SEARCH_INPUT_HOST_SEARCH_CUES: readonly string[] = Object.freeze([
  "搜索", "查询", "检索", "搜", "search", "query",
]);

export const SEARCH_INPUT_HOST_NON_SEARCH_CUES: readonly string[] = Object.freeze([
  "备注", "昵称", "补充说明", "显示名", "说明", "密码", "邮箱订阅",
  "memo", "nickname", "note", "password",
]);

const TYPE_VALUES: readonly SearchInputHostType[] = Object.freeze([
  "text", "search", "tel", "email", "url", "number", "other",
]);

function normalizeType(raw: string | null, tag: string): SearchInputHostType {
  if (tag === "textarea") return "other";
  const value = (raw ?? "text").toLowerCase();
  return (TYPE_VALUES as readonly string[]).includes(value) && value !== "other"
    ? (value as SearchInputHostType)
    : "other";
}

function hostOf(element: Element): SearchInputHostHost | null {
  const tag = element.tagName.toLowerCase();
  if (tag === "input") return "input";
  if (tag === "textarea") return "textarea";
  if ((element as HTMLElement).isContentEditable) return "contenteditable";
  return null;
}

function depthBandOf(element: Element, scopeRoot: Element): SearchInputHostDepthBand {
  let depth = 0;
  let cursor: Element | null = element;
  while (cursor !== null && cursor !== scopeRoot) {
    cursor = cursor.parentElement;
    if (cursor === null) break;
    depth += 1;
  }
  if (depth <= 4) return "shallow";
  if (depth <= 10) return "middle";
  return "deep";
}

function textLenBandOf(text: string): 0 | 1 | 2 {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.length <= 12 ? 1 : 2;
}

export interface SearchInputHostProjectionInput {
  readonly scopeRef: string;
  readonly documentRef: string;
  readonly observationId: string;
  readonly revision: number;
  readonly scopeRoot: Element;
  readonly nodes: readonly { readonly nodeRef: string; readonly element: Element }[];
  readonly propertiesOf: (nodeRef: string) => Record<string, unknown> | null;
  readonly coverage: SearchInputHostCoverage;
  /**
   * Access is a caller-level fact, not an observeLiveDom measurement: the caller
   * knows whether the page it opened is reachable, login-gated or challenged.
   * Passing null keeps the candidate unmeasured, and the unit then abstains.
   */
  readonly access: SearchInputHostCandidate["access"];
}

/**
 * Project observed hosts into binder candidates. Only elements that can carry an
 * input host are projected; everything else is out of scope for this unit.
 */
export function projectSearchInputHostCandidates(
  input: SearchInputHostProjectionInput,
): readonly SearchInputHostCandidate[] {
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  const candidates: SearchInputHostCandidate[] = [];
  for (const node of input.nodes) {
    const element = node.element;
    const host = hostOf(element);
    if (host === null) continue;
    const properties = input.propertiesOf(node.nodeRef);
    const form = element.closest("form");
    const labels = (element as HTMLInputElement).labels;
    const labelElement = labels !== null && labels !== undefined && labels.length > 0
      ? labels[0] ?? null
      : null;
    const labelText = labelElement === null ? "" : (labelElement.textContent ?? "");
    const placeholder = element.getAttribute("placeholder") ?? "";
    const aria = element.getAttribute("aria-label") ?? "";
    const cueText = `${labelText} ${placeholder} ${aria}`.toLowerCase();
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const cssHidden = style.display === "none"
      || style.visibility === "hidden"
      || Number(style.opacity) === 0;
    const intersectsViewport = rect.width > 0 && rect.height > 0
      && rect.right > 0 && rect.bottom > 0
      && rect.left < viewportWidth && rect.top < viewportHeight;
    const measuredTabIndexKind = properties?.explicitTabIndexKind;
    const measuredTabIndexFocus = properties?.tabIndexFocus;
    candidates.push({
      ref: node.nodeRef,
      scopeRef: input.scopeRef,
      documentRef: input.documentRef,
      observationId: input.observationId,
      revision: input.revision,
      host,
      type: normalizeType(element.getAttribute("type"), element.tagName.toLowerCase()),
      contentEditable: (element as HTMLElement).isContentEditable,
      editable: !(properties?.disabled === true) && (element as HTMLInputElement).readOnly !== true,
      disabled: properties?.disabled === true,
      readOnly: (element as HTMLInputElement).readOnly === true,
      cssHidden,
      intersectsViewport,
      // Missing measurement stays null. It is never coerced to a default.
      explicitTabIndexKind: (measuredTabIndexKind ?? null) as SearchInputHostCandidate["explicitTabIndexKind"],
      tabIndexFocus: typeof measuredTabIndexFocus === "boolean" ? measuredTabIndexFocus : null,
      inForm: form !== null,
      formRoleSearch: form !== null && form.getAttribute("role") === "search",
      nearbySubmit: form !== null
        && form.querySelector("button[type='submit'], input[type='submit']") !== null,
      depthBand: depthBandOf(element, input.scopeRoot),
      hasLabel: labelElement !== null,
      hasPlaceholder: placeholder.length > 0,
      hasAria: aria.length > 0,
      markerHit: SEARCH_INPUT_HOST_SEARCH_CUES.some(cue => cueText.includes(cue.toLowerCase())),
      nonSearchMarker: SEARCH_INPUT_HOST_NON_SEARCH_CUES.some(cue => cueText.includes(cue.toLowerCase())),
      textLenBand: textLenBandOf(cueText),
      access: input.access,
    });
  }
  return candidates;
}

/** Assemble the full infer input for one observed scope. */
export function projectSearchInputHostInferInput(
  input: SearchInputHostProjectionInput,
): SearchInputHostInferInput {
  const candidates = projectSearchInputHostCandidates(input);
  return {
    goal: { requestedRole: SEARCH_INPUT_HOST_ROLE, allowedScopeRef: input.scopeRef },
    candidates,
    coverage: input.coverage,
    currentControl: {
      documentRef: input.documentRef,
      observationId: input.observationId,
      revision: input.revision,
    },
  };
}
