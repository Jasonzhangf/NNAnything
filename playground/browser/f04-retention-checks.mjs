// Pure aggregation for the retention harness. Kept separate from the CDP script
// so the pass/fail rules can be tested without a browser.
export const EXPECTED_IGNORE_IDS = ["ignore-wrap-button", "ignore-wrap-link"];

export function summarizeRetentionChecks(rows) {
  const missing = rows.filter(row => row.present === false);
  const refStable = rows.every(row => row.refStableAcrossReobservation === true);
  const descendantPropertiesAgain = rows.every(row => row.descendantPropertiesAgain === true);
  const standalone = rows.find(row => row.id === "standalone-container");
  const positiveDefaultAvailable = standalone?.parentCandidateStatus === "ok" && standalone?.parentKind === "container";
  const ignoreRows = rows.filter(row => EXPECTED_IGNORE_IDS.includes(row.id));
  // Every expected ignore-parent case must be present, be judged ignore, and keep
  // its descendant available. A single miss must fail the aggregate check.
  const parentIgnoreDescendantIndependent = ignoreRows.length === EXPECTED_IGNORE_IDS.length
    && ignoreRows.every(row => row.parentKind === "ignore" && row.descendantCandidateStatus === "ok");
  return {
    noMissingElements: missing.length === 0,
    refStableAcrossReobservation: refStable,
    descendantPropertiesAgain: descendantPropertiesAgain,
    positiveTargetDefaultAvailable: positiveDefaultAvailable,
    parentIgnoreDescendantIndependent,
  };
}
