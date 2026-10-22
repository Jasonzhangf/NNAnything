import { isUtf8 } from "node:buffer";

// S11: explicit decode/format evidence. Deterministic computation (D). This
// module never consults file names or extensions as ground truth, never
// executes file content, and keeps unknown when there is no evidence.

export type ContentFormat = "png" | "jpeg" | "gif" | "pdf" | "elf" | "json" | "text" | "unknown";

export type ContentFormatObservation = Readonly<{
  encoding: "utf8" | "unknown";
  format: ContentFormat;
  valid: boolean | null; // validity only when coverage is complete and a parser applies
  complete: boolean;
  signature: ContentFormat;
  notes: readonly string[];
}>;

export function decodeUtf8(bytes: Uint8Array): Readonly<{ valid: boolean; text: string | null }> {
  if (!isUtf8(bytes)) return { valid: false, text: null };
  return { valid: true, text: Buffer.from(bytes).toString("utf8") };
}

export function detectSignature(bytes: Uint8Array): ContentFormat {
  const head = Buffer.from(bytes.subarray(0, 8));
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return "png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "GIF8") return "gif";
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (head.length >= 4 && head[0] === 0x7f && head.subarray(1, 4).toString("latin1") === "ELF") return "elf";
  return "unknown";
}

export function observeContentFormat(input: Readonly<{ bytes: Uint8Array; complete: boolean }>): ContentFormatObservation {
  const bytes = input.bytes;
  const notes: string[] = [];
  const signature = detectSignature(bytes);
  const decoded = decodeUtf8(bytes);
  const encoding: "utf8" | "unknown" = decoded.valid ? "utf8" : "unknown";
  if (!decoded.valid) notes.push("utf8_invalid");
  if (!input.complete) notes.push("coverage_partial");
  if (signature !== "unknown") {
    // A binary signature is evidence even without full coverage.
    return Object.freeze({ encoding, format: signature, valid: null, complete: input.complete, signature, notes: Object.freeze(notes) });
  }
  if (decoded.valid) {
    if (!input.complete) {
      // Partial utf8: keep text encoding known, but do not claim a format.
      return Object.freeze({ encoding, format: "text", valid: null, complete: false, signature, notes: Object.freeze(notes) });
    }
    try {
      JSON.parse(decoded.text as string);
      return Object.freeze({ encoding, format: "json", valid: true, complete: true, signature, notes: Object.freeze(notes) });
    } catch {
      return Object.freeze({ encoding, format: "text", valid: false, complete: true, signature, notes: Object.freeze([...notes, "json_parse_failed"]) });
    }
  }
  return Object.freeze({ encoding, format: "unknown", valid: null, complete: input.complete, signature, notes: Object.freeze(notes) });
}
