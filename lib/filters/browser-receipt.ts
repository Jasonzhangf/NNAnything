import {
  BROWSER_RECEIPT_HEADS,
  BROWSER_RECEIPT_SCHEMA,
  BROWSER_RECEIPT_WIRES,
  isBrowserReceiptHead,
  type BrowserReceiptHead,
  type BrowserReceiptInput,
  type BrowserReceiptPrediction,
  type BrowserReceiptProfile,
} from "../adapters/browser/receipt-contract.js";
import { expectRecord } from "../core/schema.js";

export function readBrowserReceiptInput(value: unknown): BrowserReceiptInput {
  const input = expectRecord(value, "receipt input");
  if (!Object.hasOwn(input, "receipt") || input.receipt === undefined) {
    throw new TypeError("receipt input requires an explicit receipt field");
  }
  if (input.receipt === null) return { receipt: null };
  const record = expectRecord(input.receipt, "receipt");
  if (typeof record.ok !== "boolean") throw new TypeError("receipt.ok must be an explicit boolean");
  return { receipt: { ...record, ok: record.ok } };
}

export function browserReceiptFeatures(input: BrowserReceiptInput): readonly [number, number, number] {
  const present = input.receipt === null ? 0 : 1;
  const ok = input.receipt === null ? 0 : Number(input.receipt.ok);
  return [1, present, ok];
}

export function validateBrowserReceiptProfile(value: unknown): BrowserReceiptProfile {
  const input = expectRecord(value, "receipt profile");
  if (input.schema !== BROWSER_RECEIPT_SCHEMA) throw new TypeError("Invalid receipt schema");
  const heads = input.heads;
  if (!Array.isArray(heads) || heads.length !== BROWSER_RECEIPT_HEADS.length
    || heads.some((head, index) => head !== BROWSER_RECEIPT_HEADS[index])) throw new TypeError("Invalid receipt heads");
  const wires = input.wires;
  if (!Array.isArray(wires) || wires.length !== BROWSER_RECEIPT_WIRES.length
    || wires.some((wire, index) => wire !== BROWSER_RECEIPT_WIRES[index])) throw new TypeError("Invalid receipt wires");
  const weights = input.weights;
  if (!Array.isArray(weights) || weights.length !== BROWSER_RECEIPT_HEADS.length
    || weights.some(row => !Array.isArray(row) || row.length !== BROWSER_RECEIPT_WIRES.length
      || row.some(x => typeof x !== "number" || !Number.isFinite(x)))) throw new TypeError("Invalid receipt 3x3 weights");
  const state = expectRecord(input.state, "receipt profile state");
  if (state.calibration !== "uncalibrated" || state.application !== "not_applied") throw new TypeError("Invalid receipt profile state (must be uncalibrated/not_applied)");
  return {
    schema: BROWSER_RECEIPT_SCHEMA,
    heads: heads as unknown as BrowserReceiptProfile["heads"],
    wires: wires as unknown as BrowserReceiptProfile["wires"],
    weights: weights as unknown as BrowserReceiptProfile["weights"],
    state: { calibration: "uncalibrated", application: "not_applied" },
  };
}

export function createZeroBrowserReceiptProfile(): BrowserReceiptProfile {
  return {
    schema: BROWSER_RECEIPT_SCHEMA,
    heads: [...BROWSER_RECEIPT_HEADS],
    wires: [...BROWSER_RECEIPT_WIRES],
    weights: BROWSER_RECEIPT_HEADS.map(() => [0, 0, 0]),
    state: { calibration: "uncalibrated", application: "not_applied" },
  };
}

export function predictBrowserReceipt(input: BrowserReceiptInput, profile: BrowserReceiptProfile): BrowserReceiptPrediction {
  const features = browserReceiptFeatures(input);
  const logits = profile.weights.map(row => [
    row[0] * features[0],
    row[1] * features[1],
    row[2] * features[2],
  ].reduce((sum, value) => sum + value, 0) as number);
  if (!logits.every(Number.isFinite)) throw new Error("non-finite receipt logits");
  const max = Math.max(...logits);
  const first = logits.indexOf(max);
  const last = logits.lastIndexOf(max);
  const undecided = first !== last;
  const head: BrowserReceiptHead | null = undecided ? null : (BROWSER_RECEIPT_HEADS[first] ?? null);
  return {
    features,
    logits: [logits[0], logits[1], logits[2]] as readonly [number, number, number],
    status: undecided ? "undecided" : "predicted",
    head,
    satisfaction: null,
  };
}

export function isBrowserReceiptHeadValue(value: unknown): value is BrowserReceiptHead {
  return isBrowserReceiptHead(value);
}