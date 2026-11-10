// Shared family/label aggregation for fixed acceptance and evaluation entries.
// This module owns the output shape only; callers retain their own scoring and
// decision semantics.

export type FamilyLabelGoldLabel = "true" | "false" | "unknown";

export interface FamilyLabelDecisionEffect {
  readonly selected: string | null;
  readonly correct: boolean | null;
  readonly margin: number | null;
  readonly marginOk: boolean | null;
  readonly outcome: string;
}

export interface FamilyLabelAggregationRow {
  readonly rowRef: string;
  readonly sourceFamily: string;
  readonly goldLabel: FamilyLabelGoldLabel;
  readonly loss?: number | null;
  readonly decision: FamilyLabelDecisionEffect;
}

export interface FamilyLabelAggregationBucket {
  readonly sourceFamily: string;
  readonly goldLabel: FamilyLabelGoldLabel;
  readonly rowCount: number;
  readonly rowRefs: readonly string[];
  readonly rows: readonly FamilyLabelAggregationRow[];
  readonly loss: {
    readonly rowCount: number;
    readonly total: number;
    readonly mean: number;
  } | null;
  readonly decision: {
    readonly total: number;
    readonly assessed: number;
    readonly correct: number;
    readonly incorrect: number;
    readonly unassessed: number;
    readonly outcomeCounts: Readonly<Record<string, number>>;
    readonly rowRefs: readonly string[];
  };
}

export interface FamilyLabelAggregation {
  readonly rowCount: number;
  readonly buckets: readonly FamilyLabelAggregationBucket[];
}

export class FamilyLabelAggregationError extends Error {
  readonly code = "AGGREGATION_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "FamilyLabelAggregationError";
  }
}

const LABEL_ORDER: readonly FamilyLabelGoldLabel[] = ["true", "false", "unknown"];

export function familyLabelOfGold(gold: unknown): FamilyLabelGoldLabel {
  if (gold === "true" || gold === "false" || gold === "unknown") return gold;
  if (typeof gold === "string" && gold.startsWith("c:judge:")) {
    const label = gold.slice("c:judge:".length);
    if (label === "true" || label === "false" || label === "unknown") return label;
  }
  throw new FamilyLabelAggregationError(`unsupported gold label for aggregation: ${String(gold)}`);
}

export function requireSourceFamily(value: unknown, rowRef: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FamilyLabelAggregationError(`row ${rowRef} has no source family`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aggregateBucket(
  sourceFamily: string,
  goldLabel: FamilyLabelGoldLabel,
  rows: readonly FamilyLabelAggregationRow[],
): FamilyLabelAggregationBucket {
  const lossRows = rows.filter(row => typeof row.loss === "number" && Number.isFinite(row.loss));
  const outcomeCounts: Record<string, number> = {};
  for (const row of rows) {
    outcomeCounts[row.decision.outcome] = (outcomeCounts[row.decision.outcome] ?? 0) + 1;
  }
  const assessed = rows.filter(row => row.decision.correct !== null).length;
  const correct = rows.filter(row => row.decision.correct === true).length;
  const incorrect = rows.filter(row => row.decision.correct === false).length;
  const totalLoss = lossRows.reduce((sum, row) => sum + (row.loss ?? 0), 0);
  return {
    sourceFamily,
    goldLabel,
    rowCount: rows.length,
    rowRefs: rows.map(row => row.rowRef),
    rows: [...rows],
    loss: lossRows.length === 0
      ? null
      : {
          rowCount: lossRows.length,
          total: totalLoss,
          mean: totalLoss / lossRows.length,
        },
    decision: {
      total: rows.length,
      assessed,
      correct,
      incorrect,
      unassessed: rows.length - assessed,
      outcomeCounts,
      rowRefs: rows.map(row => row.rowRef),
    },
  };
}

export function aggregateFamilyLabel(
  inputRows: readonly FamilyLabelAggregationRow[],
): FamilyLabelAggregation {
  const groups = new Map<string, FamilyLabelAggregationRow[]>();
  for (const row of inputRows) {
    if (typeof row.rowRef !== "string" || row.rowRef.length === 0) {
      throw new FamilyLabelAggregationError("aggregation row must have a non-empty rowRef");
    }
    const sourceFamily = requireSourceFamily(row.sourceFamily, row.rowRef);
    if (!LABEL_ORDER.includes(row.goldLabel)) {
      throw new FamilyLabelAggregationError(`row ${row.rowRef} has an invalid gold label`);
    }
    const key = `${sourceFamily}\u0000${row.goldLabel}`;
    const rows = groups.get(key) ?? [];
    rows.push({ ...row, sourceFamily });
    groups.set(key, rows);
  }

  const buckets = [...groups.values()]
    .map(rows => aggregateBucket(rows[0]!.sourceFamily, rows[0]!.goldLabel, rows))
    .sort((left, right) =>
      compareText(left.sourceFamily, right.sourceFamily)
      || LABEL_ORDER.indexOf(left.goldLabel) - LABEL_ORDER.indexOf(right.goldLabel)
    );
  return { rowCount: inputRows.length, buckets };
}
