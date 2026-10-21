export const BROWSER_RECEIPT_HEADS = [
  "explicit_failure",
  "explicit_success",
  "unknown",
] as const;
export type BrowserReceiptHead = typeof BROWSER_RECEIPT_HEADS[number];

export const BROWSER_RECEIPT_WIRES = [
  "bias",
  "receipt.present",
  "receipt.ok",
] as const;
export type BrowserReceiptWire = typeof BROWSER_RECEIPT_WIRES[number];

export const BROWSER_RECEIPT_SCHEMA = "receipt-knowledge.experimental.v1" as const;

export function isBrowserReceiptHead(value: unknown): value is BrowserReceiptHead {
  return BROWSER_RECEIPT_HEADS.includes(value as BrowserReceiptHead);
}

export function isBrowserReceiptWire(value: unknown): value is BrowserReceiptWire {
  return BROWSER_RECEIPT_WIRES.includes(value as BrowserReceiptWire);
}

export interface BrowserReceiptInput {
  readonly receipt:
    | (Readonly<Record<string, unknown>> & { readonly ok: boolean })
    | null;
}

export interface BrowserReceiptProfile {
  readonly schema: typeof BROWSER_RECEIPT_SCHEMA;
  readonly heads: readonly BrowserReceiptHead[];
  readonly wires: readonly BrowserReceiptWire[];
  readonly weights: readonly (readonly [number, number, number])[];
  readonly state: {
    readonly calibration: "uncalibrated";
    readonly application: "not_applied";
  };
}

export interface BrowserReceiptPrediction {
  readonly features: readonly [number, number, number];
  readonly logits: readonly [number, number, number];
  readonly status: "predicted" | "undecided";
  readonly head: BrowserReceiptHead | null;
  readonly satisfaction: null;
}

export interface BrowserReceiptInferenceResult {
  readonly input: BrowserReceiptInput;
  readonly prediction: BrowserReceiptPrediction;
  readonly satisfaction: null;
}