// S17: reproducible change comparison. Deterministic (D), pure.
// - compares two observations over an explicit reference/scope;
// - never infers byte equality from identical mtime (mtime equality is
//   recorded but is not a byte-equality proof);
// - keeps unknown when the comparison cannot be completed (identity never
//   observed, or the object was replaced without full byte coverage);
// - object replacement (different dev/ino) is always at least "changed".

export type ChangeComparison = Readonly<{
  reference: string;
  changed: boolean;
  status: "changed" | "unchanged" | "unknown";
  reasons: readonly string[];
  mtimeSame: boolean | null;
  sizeSame: boolean | null;
  identitySame: boolean | null;
  bytesSame: boolean | null;
}>;

export type ObservedSnapshot = Readonly<{
  path: string;
  size: number | null;
  mtimeMs: number | null;
  dev: string | null;
  ino: string | null;
  bytes: string | null; // base64, only when a byte range was actually observed
  coverageComplete: boolean | null; // whether bytes covers the whole file
}>;

export function compareSnapshots(reference: string, before: ObservedSnapshot, after: ObservedSnapshot): ChangeComparison {
  const reasons: string[] = [];
  if (before.path !== after.path) {
    // Different explicit path is not the same reference; comparing across
    // different references is not supported. Keep unknown rather than guess.
    return Object.freeze({
      reference,
      changed: false,
      status: "unknown" as const,
      reasons: Object.freeze(["reference_mismatch"]),
      mtimeSame: null,
      sizeSame: null,
      identitySame: null,
      bytesSame: null,
    });
  }

  const identityObserved = before.dev !== null && after.dev !== null && before.ino !== null && after.ino !== null;
  const identitySame = identityObserved && before.dev === after.dev && before.ino === after.ino;
  if (identityObserved && !identitySame) {
    reasons.push("object_replaced");
  } else if (!identityObserved) {
    reasons.push("identity_unobserved");
  }

  const sizeSame = before.size === after.size;
  if (before.size !== null && after.size !== null && before.size !== after.size) reasons.push("size_changed");

  const mtimeSame = before.mtimeMs === after.mtimeMs;
  if (before.mtimeMs !== null && after.mtimeMs !== null && before.mtimeMs !== after.mtimeMs) reasons.push("mtime_changed");

  let bytesSame: boolean | null = null;
  const bytesObserved = before.bytes !== null && after.bytes !== null;
  if (bytesObserved && before.coverageComplete === true && after.coverageComplete === true) {
    // Only full byte coverage on both sides establishes byte equality.
    bytesSame = before.bytes === after.bytes;
    if (!bytesSame) reasons.push("bytes_changed");
  } else {
    // Partial or absent coverage never establishes byte equality.
    reasons.push("bytes_not_fully_observed");
  }

  let status: ChangeComparison["status"];
  const decisive = reasons.filter(
    reason => reason !== "identity_unobserved" && reason !== "bytes_not_fully_observed" && reason !== "reference_mismatch",
  );
  if (reasons.length === 0) {
    status = "unchanged";
  } else if (identityObserved && !identitySame) {
    // Object replaced. If full byte coverage exists, the comparison is
    // decisive; otherwise the new object's content is unknown.
    status = bytesSame !== null ? "changed" : "unknown";
  } else if (decisive.length > 0) {
    // Identity is unknown or same, but a decisive fact (size/mtime/bytes
    // changed) was observed on this reference.
    status = "changed";
  } else {
    // Only non-decisive reasons (identity or coverage unobserved): no change
    // can be proven.
    status = "unknown";
  }

  return Object.freeze({
    reference,
    changed: status === "changed",
    status,
    reasons: Object.freeze(reasons),
    mtimeSame,
    sizeSame,
    identitySame: identityObserved ? identitySame : null,
    bytesSame,
  });
}