/**
 * Minimal judge for the B-Feedback §8 search-contract migration.
 * It encodes only the stop behavior, never the F1/F2 learning contract,
 * and never weakens the search contract assertions.
 */

const STOP_REASONS = new Set([
  "root_unknown_subcondition_only",
  "rejection_no_body",
  "input_throw_error_preserved",
  "submit_throw_no_resubmit",
  "posterior_missing_stop",
  "posterior_stale_stop",
  "results_attribution_mismatch",
  "root_satisfied_no_extra_mutation",
]);

function countOf(counts, key) {
  const value = counts?.[key];
  return Number.isSafeInteger(value) ? value : 0;
}

function errorsOf(errors, code) {
  return Array.isArray(errors) && errors.some((error) => error?.code === code);
}

function errorBodies(errors) {
  return Array.isArray(errors)
    ? errors.map((error) => (typeof error?.message === "string" ? error.message : "")).join("; ")
    : "";
}

export function judgeSearchMigration(item, evidence) {
  if (!item || !item.id) throw new TypeError("search migration case definition required");
  if (typeof evidence !== "object" || evidence === null) throw new TypeError("search migration evidence required");
  const expectedStopReason = item.expectedStopReason;
  const failures = [];
  const checks = {};

  if (!STOP_REASONS.has(expectedStopReason)) {
    failures.push(`unknown expected stop reason ${expectedStopReason}`);
  }

  const expectedRoot = item.expectedRoot;
  if (!["satisfied", "unknown", "unsatisfied"].includes(expectedRoot)) {
    failures.push(`invalid expected root ${expectedRoot}`);
  }
  if (expectedRoot === "satisfied") {
    if (evidence.root !== "satisfied") failures.push(`root ${String(evidence.root)} != satisfied`);
    if (evidence.control !== "completed") failures.push(`control ${String(evidence.control)} != completed`);
    if (evidence.controlStopReason !== "root_evaluation") {
      failures.push(`controlStopReason ${String(evidence.controlStopReason)} != root_evaluation`);
    }
    const inputs = countOf(evidence.actionCounts, "input");
    const submits = countOf(evidence.actionCounts, "submit");
    if (inputs !== 1) failures.push(`input count ${inputs} != 1`);
    if (submits !== 1) failures.push(`submit count ${submits} != 1`);
    if (inputs + submits > 2) failures.push(`extra mutation: ${inputs}i/${submits}s`);
    if (evidence.executionErrors.length > 0) failures.push("satisfied root must not carry execution errors");
    if (evidence.observationErrors.length > 0) failures.push("satisfied root must not carry observation errors");
  } else {
    if (evidence.root === "satisfied") failures.push("root must not be satisfied for a stop obligation");
    if (evidence.control !== "error") failures.push(`control ${String(evidence.control)} != error`);
    if (evidence.controlStopReason !== "fatal_error") {
      failures.push(`controlStopReason ${String(evidence.controlStopReason)} != fatal_error`);
    }
  }

  if (expectedStopReason === "root_unknown_subcondition_only") {
    if (evidence.phases?.input !== "satisfied") failures.push("draft subcondition must be satisfied");
    if (evidence.inputValue?.status !== "observed" || evidence.inputValue?.value !== evidence.goalQuery) {
      failures.push("draft value must match the goal query");
    }
    if (countOf(evidence.actionCounts, "input") !== 1) failures.push("draft obligation needs exactly one input episode");
    if (countOf(evidence.actionCounts, "submit") !== 1) failures.push("draft obligation needs exactly one submit episode");
    if (evidence.phases?.submitted === "satisfied") failures.push("submitted condition must not be satisfied");
    if (evidence.phases?.results === "satisfied") failures.push("results condition must not be satisfied");
    if (evidence.root !== "unknown") failures.push("subcondition alone must not satisfy the root");
  }
  if (expectedStopReason === "rejection_no_body") {
    const receipts = Array.isArray(evidence.receipts) ? evidence.receipts : [];
    if (receipts.length !== 1) failures.push(`rejection needs exactly one receipt, got ${receipts.length}`);
    else {
      const receipt = receipts[0];
      if (receipt.action !== "input") failures.push("rejection must be an input receipt");
      if (receipt.dispatched !== false) failures.push("typed rejection must not dispatch");
      if (receipt.ok !== false) failures.push("typed rejection must carry ok=false");
      if (receipt.error !== null && receipt.error !== undefined) failures.push("rejection with no body must carry error=null");
      if (receipt.effectKnowledge !== "none") failures.push("not-dispatched receipt must carry effectKnowledge=none");
    }
    if (countOf(evidence.actionCounts, "submit") !== 0) failures.push("rejection must not submit");
    // "Keep the original value" is proven by the not-dispatched receipt plus the
    // absence of a submit: nothing was written. The empty starting value stays
    // not_observable under the existing projection, so an observed value must
    // equal the original and must never turn into the requested query.
    if (evidence.inputValue?.status === "observed") {
      if (evidence.inputValue.value !== (item.originalInputValue ?? "")) {
        failures.push("input rejection must preserve the observed original value");
      }
      if (evidence.inputValue.value === evidence.goalQuery) {
        failures.push("input rejection must not carry the requested query as if written");
      }
    } else if (evidence.inputValue?.status !== "unknown") {
      failures.push(`unexpected input value fact ${String(evidence.inputValue?.status)}`);
    }
    if (!errorsOf(evidence.executionErrors, "execution_rejected")) {
      failures.push("typed rejection must keep the execution rejection error");
    }
  }
  if (expectedStopReason === "input_throw_error_preserved") {
    if (!errorsOf(evidence.executionErrors, "native_action_failed")) {
      failures.push("input throw must keep the execution error");
    }
    if (countOf(evidence.actionCounts, "input") !== 1) failures.push("input throw needs exactly one input episode");
    if (countOf(evidence.actionCounts, "submit") !== 0) failures.push("input throw must not continue to submit");
    if (evidence.inputValue?.status !== "observed" || evidence.inputValue?.value !== evidence.goalQuery) {
      failures.push("input throw must keep the reached value");
    }
    if (!evidence.receipts.some((receipt) => receipt?.action === "input" && receipt?.dispatched === true)) {
      failures.push("input throw must keep the dispatched native receipt");
    }
    if (!evidence.effects.some((effect) => effect?.effectKnowledge === "unknown")) {
      failures.push("input throw must keep unknown effects");
    }
  }
  if (expectedStopReason === "submit_throw_no_resubmit") {
    if (!errorsOf(evidence.executionErrors, "native_action_failed")) {
      failures.push("submit throw must keep the execution error");
    }
    if (countOf(evidence.actionCounts, "input") !== 1) failures.push("submit throw needs exactly one input episode");
    if (countOf(evidence.actionCounts, "submit") !== 1) failures.push("submit throw must not repeat the submit");
    const submitReceipts = evidence.receipts.filter((receipt) => receipt?.action === "submit");
    if (submitReceipts.length !== 1 || submitReceipts[0].dispatched !== true) {
      failures.push("submit throw must keep exactly one dispatched native submit receipt");
    }
    if (!evidence.effects.some((effect) => effect?.effectKnowledge === "unknown")) {
      failures.push("submit throw must keep unknown effects");
    }
  }
  if (expectedStopReason === "posterior_missing_stop") {
    if (evidence.root !== "unknown") failures.push("missing posterior must leave root unknown");
    if (countOf(evidence.actionCounts, "input") !== 1) failures.push("missing posterior needs the completed input");
    if (countOf(evidence.actionCounts, "submit") !== 1) failures.push("missing posterior needs exactly one submitted action");
    if (!errorsOf(evidence.observationErrors, "post_observation_failed")) {
      failures.push("missing posterior must keep the observation failure");
    }
  }
  if (expectedStopReason === "posterior_stale_stop") {
    if (evidence.root !== "unknown") failures.push("stale posterior must leave root unknown");
    const association = evidence.association ?? {};
    const submittedRef = association.submittedRequestRef ?? null;
    const resultsRef = association.resultsRequestRef ?? null;
    const baseline = association.baseline ?? {};
    const sameQuery = evidence.resultsFor?.status === "observed"
      && evidence.resultsFor?.value === evidence.goalQuery;
    const staleAttribution = (submittedRef && resultsRef && submittedRef !== resultsRef)
      || (baseline.batchRef !== null && baseline.batchRef !== undefined
        && association.batch === baseline.batchRef);
    if (!sameQuery) failures.push("stale-posterior case must keep the same query text");
    if (!staleAttribution) failures.push("stale posterior must point at an old request ref or batch");
  }
  if (expectedStopReason === "results_attribution_mismatch") {
    const association = evidence.association ?? {};
    const submittedRef = association.submittedRequestRef ?? null;
    const resultsRef = association.resultsRequestRef ?? null;
    const submittedQuery = association.submittedQuery ?? null;
    const resultsQuery = association.resultsQuery ?? null;
    if (submittedQuery !== evidence.goalQuery) failures.push("current query must be submitted");
    if (resultsQuery !== null && resultsQuery === evidence.goalQuery) {
      failures.push("resultsFor must not match the current query");
    }
    if (!submittedRef || !resultsRef || submittedRef === resultsRef) {
      failures.push("results must not be attributed to the current submission");
    }
    if (evidence.root !== "unknown") failures.push("attribution mismatch must leave root unknown");
  }
  if (expectedStopReason === "root_satisfied_no_extra_mutation") {
    const inputs = countOf(evidence.actionCounts, "input");
    const submits = countOf(evidence.actionCounts, "submit");
    if (inputs + submits !== 2) failures.push(`exactly one input and one submit required, got ${inputs}i/${submits}s`);
    if (evidence.root !== "satisfied") failures.push("satisfied obligation requires root satisfied");
    if (evidence.inputValue?.status !== "observed" || evidence.inputValue?.value !== evidence.goalQuery) {
      failures.push("satisfied input must carry the current query");
    }
    if (evidence.submittedQuery?.status !== "observed" || evidence.submittedQuery?.value !== evidence.goalQuery) {
      failures.push("satisfied submission must carry the current query");
    }
    if (evidence.resultsFor?.status !== "observed" || evidence.resultsFor?.value !== evidence.goalQuery) {
      failures.push("satisfied results must belong to the current query");
    }
    const association = evidence.association ?? {};
    if (!association.submittedRequestRef || !association.resultsRequestRef
      || !association.collectionRequestRef
      || association.submittedRequestRef !== association.resultsRequestRef
      || association.submittedRequestRef !== association.collectionRequestRef) {
      failures.push("satisfied results must carry one current submission request");
    }
    if (!association.batch || association.batch === association.baseline?.batchRef) {
      failures.push("satisfied results must carry a new current batch");
    }
    if (!Number.isSafeInteger(evidence.mainMatches) || evidence.mainMatches < 1) {
      failures.push("satisfied results must contain a matching main item");
    }
  }

  return {
    id: item.id,
    status: failures.length === 0 ? "pass" : "fail",
    passed: failures.length === 0,
    reason: failures.join("; "),
    stopReason: expectedStopReason,
    controlStopReason: evidence.controlStopReason ?? null,
    errorBodies: errorBodies(evidence.executionErrors),
    checks: {
      root: expectedRoot === "satisfied"
        ? evidence.root === "satisfied"
        : evidence.root !== "satisfied",
      control: expectedRoot === "satisfied"
        ? evidence.control === "completed"
        : evidence.control !== "completed",
      stop: failures.length === 0,
    },
  };
}
