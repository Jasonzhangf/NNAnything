import { readFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import type { BrowserReceiptProfile } from "../adapters/browser/receipt-contract.js";
import { validateBrowserReceiptProfile } from "../filters/browser-receipt.js";

export function requireNonEmptyProfilePath(profilePath: string): void {
  if (typeof profilePath !== "string" || profilePath.trim() === "") {
    throw new TypeError("browser-receipt requires a non-empty explicit profilePath");
  }
}

export async function loadBrowserReceiptProfile(profilePath: string): Promise<BrowserReceiptProfile> {
  requireNonEmptyProfilePath(profilePath);
  const info = await stat(profilePath);
  if (!info.isFile()) throw new TypeError(`browser-receipt profile path is not a regular file: ${profilePath}`);
  let raw: string;
  try {
    raw = await readFile(profilePath, "utf8");
  } catch (error) {
    throw new Error(`browser-receipt failed to read profile file ${profilePath}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`browser-receipt profile is not valid JSON: ${profilePath}`, { cause: error });
  }
  return validateBrowserReceiptProfile(parsed);
}