/** Shared record for F1 material usage. One owner for training data provenance. */

export function buildPartitionRecord({
  total,
  train,
  development,
  projections,
  r5Rows,
  historicalSource,
  r5Source,
}) {
  return {
    purpose: 'F1 minimal post-training material',
    historicalSource,
    r5Source,
    total,
    train,
    development,
    projections,
    r5Purpose: 'known regression folded into train; never counted as a fresh holdout',
    r5Rows,
    r5CountedAsFreshHoldout: false,
    excludedFromFit: ['holdout/holdout.json', 'holdout/transformations.json', 'finite-cases.json', 'independent 24-case verification'],
    candidateAdoption: 'not_applied',
  };
}
