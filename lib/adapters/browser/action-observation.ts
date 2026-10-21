/** Domain observation obligations. These describe evidence, never model truth. */
export interface BrowserObservationObligation {
  readonly conditionRef: string;
  readonly method: string;
  readonly subjectRef: string;
  readonly scopeRef: string;
  readonly requiredFacts: readonly string[];
  readonly freshness: "current" | "after_action";
}

export interface BrowserObservationError {
  readonly code: string;
  readonly message: string;
}

/** State remains in the episode's newState; feedback refers to it, not a second copy. */
export interface BrowserObservationFeedback {
  readonly obligation: BrowserObservationObligation;
  readonly status: "satisfied" | "incomplete" | "failed" | "not_required";
  readonly observationId: string | null;
  readonly evidenceRefs: readonly string[];
  readonly unmetFacts: readonly string[];
  readonly errors: readonly BrowserObservationError[];
}

export function readBrowserObservationErrors(value: unknown): readonly BrowserObservationError[] {
  if (!Array.isArray(value) || value.some(item => item === null || typeof item !== "object"
    || typeof item.code !== "string" || !item.code || typeof item.message !== "string")) {
    throw new TypeError("Invalid browser observation errors");
  }
  return value;
}

export function readBrowserObservationFeedback(value: unknown): BrowserObservationFeedback {
  if (value === null || typeof value !== "object") throw new TypeError("Invalid browser observation feedback");
  const record = value as BrowserObservationFeedback;
  const obligation = record.obligation;
  if (!obligation || [obligation.conditionRef, obligation.method, obligation.subjectRef, obligation.scopeRef]
    .some(item => typeof item !== "string" || !item)
    || !["current", "after_action"].includes(obligation.freshness)
    || !["satisfied", "incomplete", "failed", "not_required"].includes(record.status)
    || (record.observationId !== null && (typeof record.observationId !== "string" || !record.observationId))
    || [obligation.requiredFacts, record.evidenceRefs, record.unmetFacts].some(items =>
      !Array.isArray(items) || items.some(item => typeof item !== "string" || !item))) {
    throw new TypeError("Invalid browser observation feedback");
  }
  readBrowserObservationErrors(record.errors);
  if (record.status === "satisfied" && (record.observationId === null || record.errors.length > 0
    || record.unmetFacts.length > 0 || record.evidenceRefs.length === 0)) {
    throw new TypeError("Satisfied browser observation requires complete evidence");
  }
  return record;
}
