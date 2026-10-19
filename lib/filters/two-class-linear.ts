export function scoreTwoClassLinear(
  features: readonly number[],
  weights: readonly [readonly number[], readonly number[]],
): readonly [number, number] {
  if (!Array.isArray(features) || features.length === 0 || features.some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("features must contain finite values");
  }
  if (!Array.isArray(weights) || weights.length !== 2) throw new TypeError("weights must contain two class rows");
  const rows = weights.map((row, classIndex) => {
    if (!Array.isArray(row) || row.length !== features.length) throw new TypeError(`weight row ${classIndex} has the wrong width`);
    if (row.some(value => typeof value !== "number" || !Number.isFinite(value))) throw new TypeError(`weight row ${classIndex} must contain finite values`);
    return row.reduce((sum, weight, index) => sum + weight * features[index]!, 0);
  });
  return Object.freeze([rows[0]!, rows[1]!] as const);
}

export function selectSecondOnlyWhenGreater<T>(scores: readonly [number, number], first: T, second: T): T {
  if (!Array.isArray(scores) || scores.length !== 2 || scores.some(value => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("scores must contain two finite values");
  }
  return scores[1]! > scores[0]! ? second : first;
}
