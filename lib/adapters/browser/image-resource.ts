export interface ImageLoadBinding {
  readonly documentRef: string;
  readonly nodeRef: string;
  readonly loadGeneration: number;
  readonly currentSrc: string;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

export interface BrowserReadableResponseProvenance {
  readonly kind: "browser-readable-response";
}

export interface OfficialIabDownloadProvenance {
  readonly kind: "official-iab-download";
  readonly receiptRef: string;
}

export type ImageResourceProvenance =
  | BrowserReadableResponseProvenance
  | OfficialIabDownloadProvenance;

export interface JpegImageBytes {
  readonly bytes: Uint8Array;
  readonly provenance: ImageResourceProvenance;
}

export interface JpegDecodeResult {
  readonly complete: boolean;
  readonly width: number;
  readonly height: number;
}

export interface JpegImageResourceProof {
  readonly width: number;
  readonly height: number;
  readonly binding: ImageLoadBinding;
  readonly provenance: ImageResourceProvenance;
}

export type ImageResourceUnavailableReason =
  | "invalid-load"
  | "binding-read-failed"
  | "stale-binding"
  | "read-failed"
  | "unsupported-format"
  | "decode-failed"
  | "incomplete"
  | "dimension-mismatch"
  | "cancelled";

export type JpegImageResourceObservation =
  | { readonly status: "proven"; readonly proof: JpegImageResourceProof }
  | { readonly status: "unavailable"; readonly reason: ImageResourceUnavailableReason };

type Awaitable<T> = T | Promise<T>;

export interface ObserveJpegImageResourceInput {
  readonly binding: ImageLoadBinding;
  readonly readCurrentBinding: () => Awaitable<ImageLoadBinding | null>;
  readonly readBytes: (binding: ImageLoadBinding) => Awaitable<JpegImageBytes>;
  readonly decodeJpeg: (bytes: Uint8Array) => Awaitable<JpegDecodeResult>;
}

const unavailable = (
  reason: ImageResourceUnavailableReason,
): JpegImageResourceObservation => ({ status: "unavailable", reason });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isLoadBinding(value: unknown): value is ImageLoadBinding {
  if (!isRecord(value)) return false;
  return (
    typeof value.documentRef === "string"
    && value.documentRef.length > 0
    && typeof value.nodeRef === "string"
    && value.nodeRef.length > 0
    && typeof value.loadGeneration === "number"
    && Number.isInteger(value.loadGeneration)
    && value.loadGeneration >= 0
    && typeof value.currentSrc === "string"
    && value.currentSrc.length > 0
    && value.complete === true
    && isPositiveDimension(value.naturalWidth)
    && isPositiveDimension(value.naturalHeight)
  );
}

function isProvenance(value: unknown): value is ImageResourceProvenance {
  if (!isRecord(value)) return false;
  if (value.kind === "browser-readable-response") return true;
  return (
    value.kind === "official-iab-download"
    && typeof value.receiptRef === "string"
    && value.receiptRef.length > 0
  );
}

function sameBinding(left: ImageLoadBinding, right: ImageLoadBinding): boolean {
  return (
    left.documentRef === right.documentRef
    && left.nodeRef === right.nodeRef
    && left.loadGeneration === right.loadGeneration
    && left.currentSrc === right.currentSrc
    && left.complete === right.complete
    && left.naturalWidth === right.naturalWidth
    && left.naturalHeight === right.naturalHeight
  );
}

function hasJpegPrefix(bytes: Uint8Array): boolean {
  // SOI must be followed by a marker; the forced full decode completes the proof.
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

async function readBinding(
  readCurrentBinding: ObserveJpegImageResourceInput["readCurrentBinding"],
): Promise<ImageLoadBinding | null | "failed"> {
  try {
    const value = await readCurrentBinding();
    return isLoadBinding(value) ? value : null;
  } catch {
    return "failed";
  }
}

export async function observeJpegImageResource(
  input: ObserveJpegImageResourceInput,
): Promise<JpegImageResourceObservation> {
  if (
    !input
    || typeof input.readCurrentBinding !== "function"
    || typeof input.readBytes !== "function"
    || typeof input.decodeJpeg !== "function"
  ) {
    throw new TypeError(
      "observeJpegImageResource requires readCurrentBinding, readBytes, and decodeJpeg",
    );
  }

  if (!isLoadBinding(input.binding)) return unavailable("invalid-load");

  const beforeRead = await readBinding(input.readCurrentBinding);
  if (beforeRead === "failed") return unavailable("binding-read-failed");
  if (beforeRead === null || !sameBinding(input.binding, beforeRead)) {
    return unavailable("stale-binding");
  }

  let readResult: JpegImageBytes;
  try {
    readResult = await input.readBytes(input.binding);
  } catch {
    return unavailable("read-failed");
  }
  if (
    !isRecord(readResult)
    || !(readResult.bytes instanceof Uint8Array)
    || !isProvenance(readResult.provenance)
  ) {
    return unavailable("read-failed");
  }

  const afterRead = await readBinding(input.readCurrentBinding);
  if (afterRead === "failed") return unavailable("binding-read-failed");
  if (afterRead === null || !sameBinding(input.binding, afterRead)) {
    return unavailable("stale-binding");
  }

  if (!hasJpegPrefix(readResult.bytes)) return unavailable("unsupported-format");

  let decoded: JpegDecodeResult;
  try {
    decoded = await input.decodeJpeg(readResult.bytes);
  } catch {
    return unavailable("decode-failed");
  }

  const afterDecode = await readBinding(input.readCurrentBinding);
  if (afterDecode === "failed") return unavailable("binding-read-failed");
  if (afterDecode === null || !sameBinding(input.binding, afterDecode)) {
    return unavailable("stale-binding");
  }

  if (
    !isRecord(decoded)
    || typeof decoded.complete !== "boolean"
    || !isPositiveDimension(decoded.width)
    || !isPositiveDimension(decoded.height)
  ) {
    return unavailable("decode-failed");
  }
  if (!decoded.complete) return unavailable("incomplete");
  if (
    decoded.width !== input.binding.naturalWidth
    || decoded.height !== input.binding.naturalHeight
  ) {
    return unavailable("dimension-mismatch");
  }

  return {
    status: "proven",
    proof: {
      width: decoded.width,
      height: decoded.height,
      binding: input.binding,
      provenance: readResult.provenance,
    },
  };
}
