import type {
  ImageLoadBinding,
  JpegDecodeResult,
  JpegImageBytes,
  JpegImageResourceObservation,
  ImageResourceUnavailableReason,
} from "./image-resource.js";
import { observeJpegImageResource } from "./image-resource.js";

export interface BrowserImageDecoderFrame {
  readonly displayWidth: number;
  readonly displayHeight: number;
  close(): void;
}

export interface BrowserImageDecoder {
  decode(options: {
    readonly frameIndex: number;
    readonly completeFramesOnly: boolean;
  }): Promise<{ readonly image: BrowserImageDecoderFrame; readonly complete: boolean }>;
  close(): void;
}

export interface BrowserImageDecoderConstructor {
  new (init: {
    readonly type: "image/jpeg";
    readonly data: Uint8Array;
  }): BrowserImageDecoder;
}

interface BrowserMutationObserver {
  observe(target: Node, options: MutationObserverInit): void;
  disconnect(): void;
  takeRecords(): MutationRecord[];
}

export interface BrowserJpegImageResourcePlatform {
  readonly fetch: (
    input: string,
    init: { readonly credentials: "omit"; readonly signal: AbortSignal },
  ) => Promise<Response>;
  readonly MutationObserver: new (
    callback: (records: MutationRecord[]) => void,
  ) => BrowserMutationObserver;
  readonly AbortController: new () => AbortController;
  readonly ImageDecoder: BrowserImageDecoderConstructor | null;
}

export interface BrowserJpegImageResourceProducerInput {
  readonly document: Document;
  readonly documentRef: string;
  readonly nodeRefFor: (element: HTMLImageElement) => string;
  readonly platform: BrowserJpegImageResourcePlatform;
}

export interface BrowserJpegImageResourceProducer {
  read(imageElement: HTMLImageElement): Promise<JpegImageResourceObservation>;
  peek(imageElement: HTMLImageElement): JpegImageResourceObservation | undefined;
  dispose(): void;
}

interface CachedRead {
  readonly binding: ImageLoadBinding;
  readonly observation: Promise<JpegImageResourceObservation>;
  settled: JpegImageResourceObservation | null;
}

interface ImageElementState {
  readonly element: HTMLImageElement;
  generation: number;
  cached: CachedRead | null;
}

const unavailable = (
  reason: ImageResourceUnavailableReason,
): JpegImageResourceObservation => ({ status: "unavailable", reason });

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function sameLoadBinding(left: ImageLoadBinding, right: ImageLoadBinding): boolean {
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

function validateInput(input: BrowserJpegImageResourceProducerInput): void {
  if (
    !input
    || !input.document
    || typeof input.document.addEventListener !== "function"
    || typeof input.document.removeEventListener !== "function"
    || !nonEmptyString(input.documentRef)
    || typeof input.nodeRefFor !== "function"
    || !input.platform
    || typeof input.platform.fetch !== "function"
    || typeof input.platform.MutationObserver !== "function"
    || typeof input.platform.AbortController !== "function"
    || (
      input.platform.ImageDecoder !== null
      && typeof input.platform.ImageDecoder !== "function"
    )
  ) {
    throw new TypeError(
      "createBrowserJpegImageResourceProducer requires document, documentRef, nodeRefFor, and explicit browser platform constructors",
    );
  }
}

class BrowserJpegImageResourceProducerImplementation
implements BrowserJpegImageResourceProducer {
  readonly #document: Document;
  readonly #documentRef: string;
  readonly #nodeRefFor: (element: HTMLImageElement) => string;
  readonly #platform: BrowserJpegImageResourcePlatform;
  readonly #observer: BrowserMutationObserver;
  readonly #states = new Map<HTMLImageElement, ImageElementState>();
  readonly #inflight = new Set<AbortController>();
  readonly #decoders = new Set<BrowserImageDecoder>();
  #disposed = false;

  constructor(input: BrowserJpegImageResourceProducerInput) {
    validateInput(input);
    this.#document = input.document;
    this.#documentRef = input.documentRef;
    this.#nodeRefFor = input.nodeRefFor;
    this.#platform = input.platform;
    this.#observer = new input.platform.MutationObserver(records => {
      this.#processRecords(records);
    });
    this.#observer.observe(this.#document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "sizes"],
    });
    this.#document.addEventListener("load", this.#onLoadOrError, true);
    this.#document.addEventListener("error", this.#onLoadOrError, true);
  }

  readonly #onLoadOrError = (event: Event): void => {
    if (this.#disposed) return;
    this.#processQueuedRecords();
    for (const state of this.#states.values()) {
      if (event.target === state.element) this.#invalidate(state);
    }
  };

  #processQueuedRecords(): void {
    this.#processRecords(this.#observer.takeRecords());
  }

  #processRecords(records: readonly MutationRecord[]): void {
    if (records.length === 0 || this.#disposed) return;
    for (const state of this.#states.values()) {
      if (records.some(record => record.target === state.element)) this.#invalidate(state);
    }
  }

  #invalidate(state: ImageElementState): void {
    state.generation += 1;
    state.cached = null;
  }

  #stateFor(element: HTMLImageElement): ImageElementState {
    let state = this.#states.get(element);
    if (!state) {
      state = { element, generation: 0, cached: null };
      this.#states.set(element, state);
    }
    return state;
  }

  #readCurrentBinding(state: ImageElementState): ImageLoadBinding | null {
    if (this.#disposed) return null;
    this.#processQueuedRecords();
    const element = state.element;
    if (
      element.isConnected !== true
      || element.ownerDocument !== this.#document
      || typeof element.tagName !== "string"
      || element.tagName.toLowerCase() !== "img"
    ) {
      this.#invalidate(state);
      return null;
    }

    const currentSrc = element.currentSrc;
    const complete = element.complete;
    const naturalWidth = element.naturalWidth;
    const naturalHeight = element.naturalHeight;
    if (
      !nonEmptyString(currentSrc)
      || complete !== true
      || !positiveDimension(naturalWidth)
      || !positiveDimension(naturalHeight)
    ) {
      return null;
    }

    const nodeRef = this.#nodeRefFor(element);
    if (!nonEmptyString(nodeRef)) return null;
    return {
      documentRef: this.#documentRef,
      nodeRef,
      loadGeneration: state.generation,
      currentSrc,
      complete,
      naturalWidth,
      naturalHeight,
    };
  }

  async #readBytes(
    binding: ImageLoadBinding,
  ): Promise<JpegImageBytes> {
    if (this.#disposed) throw new Error("image resource producer disposed");
    const controller = new this.#platform.AbortController();
    this.#inflight.add(controller);
    try {
      const response = await this.#platform.fetch(binding.currentSrc, {
        credentials: "omit",
        signal: controller.signal,
      });
      if (
        response.ok !== true
        || response.type === "opaque"
        || response.type === "opaqueredirect"
        || response.type === "error"
        || typeof response.arrayBuffer !== "function"
      ) {
        throw new Error("browser response is not readable");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        provenance: { kind: "browser-readable-response" },
      };
    } finally {
      this.#inflight.delete(controller);
    }
  }

  async #decodeJpeg(bytes: Uint8Array): Promise<JpegDecodeResult> {
    if (this.#disposed) throw new Error("image resource producer disposed");
    const ImageDecoder = this.#platform.ImageDecoder;
    if (ImageDecoder === null) throw new Error("native ImageDecoder unavailable");

    let decoder: BrowserImageDecoder | null = null;
    let frame: BrowserImageDecoderFrame | null = null;
    try {
      decoder = new ImageDecoder({ type: "image/jpeg", data: bytes });
      this.#decoders.add(decoder);
      const decoded = await decoder.decode({
        frameIndex: 0,
        completeFramesOnly: true,
      });
      frame = decoded.image;
      return {
        complete: decoded.complete,
        width: frame.displayWidth,
        height: frame.displayHeight,
      };
    } finally {
      try {
        frame?.close();
      } finally {
        if (decoder !== null) {
          this.#decoders.delete(decoder);
          decoder.close();
        }
      }
    }
  }

  async read(imageElement: HTMLImageElement): Promise<JpegImageResourceObservation> {
    if (this.#disposed) return unavailable("cancelled");
    const state = this.#stateFor(imageElement);
    let binding: ImageLoadBinding | null;
    try {
      binding = this.#readCurrentBinding(state);
    } catch {
      return unavailable("binding-read-failed");
    }
    if (binding === null) return unavailable("invalid-load");

    if (state.cached !== null && sameLoadBinding(state.cached.binding, binding)) {
      return state.cached.observation;
    }

    const observation = this.#platform.ImageDecoder === null
      ? Promise.resolve(unavailable("decode-failed"))
      : observeJpegImageResource({
        binding,
        readCurrentBinding: () => this.#readCurrentBinding(state),
        readBytes: observed => this.#readBytes(observed),
        decodeJpeg: bytes => this.#decodeJpeg(bytes),
      });
    const cached: CachedRead = { binding, observation, settled: null };
    state.cached = cached;
    const result = await observation;
    cached.settled = result;
    return this.#disposed ? unavailable("cancelled") : result;
  }

  peek(imageElement: HTMLImageElement): JpegImageResourceObservation | undefined {
    if (this.#disposed) return undefined;
    const state = this.#states.get(imageElement);
    if (!state) return undefined;
    let binding: ImageLoadBinding | null;
    try {
      binding = this.#readCurrentBinding(state);
    } catch {
      return undefined;
    }
    if (binding === null) return undefined;
    const cached = state.cached;
    if (cached === null || cached.settled === null) return undefined;
    if (!sameLoadBinding(cached.binding, binding)) return undefined;
    return cached.settled;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#document.removeEventListener("load", this.#onLoadOrError, true);
    this.#document.removeEventListener("error", this.#onLoadOrError, true);
    this.#observer.disconnect();
    const inflight = [...this.#inflight];
    const decoders = [...this.#decoders];
    this.#inflight.clear();
    this.#decoders.clear();
    this.#states.clear();
    for (const controller of inflight) controller.abort();
    for (const decoder of decoders) decoder.close();
  }
}

export function createBrowserJpegImageResourceProducer(
  input: BrowserJpegImageResourceProducerInput,
): BrowserJpegImageResourceProducer {
  return new BrowserJpegImageResourceProducerImplementation(input);
}
