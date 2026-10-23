import { materializeFamily } from "./materialize.mjs";
import { familyInspectTable } from "./family-inspect-table.mjs";
import { familySheetAudit } from "./family-sheet-audit.mjs";

/**
 * Aggregate the two independent source families into one 24-case verification
 * set. The family modules do not import each other and do not import any old
 * f1-robustness material.
 */
const cases = [
  ...materializeFamily(familyInspectTable),
  ...materializeFamily(familySheetAudit),
];

if (cases.length !== 24) {
  throw new TypeError(`expected 24 cases, got ${cases.length}`);
}

const ids = new Set(cases.map(c => c.id));
if (ids.size !== cases.length) {
  throw new TypeError("independent cases contain duplicate ids");
}

export const INDEPENDENT_CASES = Object.freeze(cases);
export const FAMILY_IDS = Object.freeze(["inspect-table", "sheet-audit"]);
