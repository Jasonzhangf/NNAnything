import assert from "node:assert/strict";
import { test } from "node:test";

const {
  createBrowserJpegImageResourceProducer,
} = await import("../dist/adapters/browser/image-resource-browser.js");

const JPEG_BYTES = new Uint8Array(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
  "base64",
));
const TRANSPARENT_PNG = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.records = [];
    this.disconnected = false;
    this.options = null;
    FakeMutationObserver.instances.push(this);
  }

  observe(_target, options) {
    this.options = options;
  }

  takeRecords() {
    return this.records.splice(0);
  }

  disconnect() {
    this.disconnected = true;
  }

  queue(record) {
    this.records.push(record);
  }
}

class FakeAbortController {
  static instances = [];

  constructor() {
    this.signal = { aborted: false };
    this.abortCount = 0;
    FakeAbortController.instances.push(this);
  }

  abort() {
    this.abortCount += 1;
    this.signal.aborted = true;
  }
}

function createDocument() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, listener, options) {
      const rows = listeners.get(type) ?? [];
      rows.push({ listener, options });
      listeners.set(type, rows);
    },
    removeEventListener(type, listener, options) {
      const rows = listeners.get(type) ?? [];
      listeners.set(type, rows.filter(row => row.listener !== listener || row.options !== options));
    },
    dispatch(type, target) {
      for (const row of listeners.get(type) ?? []) row.listener({ type, target });
    },
  };
}

function createImage(document, source) {
  return {
    tagName: "IMG",
    ownerDocument: document,
    isConnected: true,
    complete: true,
    naturalWidth: 1,
    naturalHeight: 1,
    currentSrc: source,
  };
}

function nodeRefFactory() {
  const refs = new WeakMap();
  let sequence = 0;
  return {
    refs,
    nodeRefFor(element) {
      let ref = refs.get(element);
      if (!ref) {
        ref = `node-${++sequence}`;
        refs.set(element, ref);
      }
      return ref;
    },
  };
}

function response(bytes, overrides = {}) {
  return {
    ok: true,
    type: "cors",
    body: {},
    async arrayBuffer() {
      return Uint8Array.from(bytes).buffer;
    },
    ...overrides,
  };
}

function decoderFactory(result = { displayWidth: 1, displayHeight: 1, complete: true }) {
  const instances = [];
  class FakeImageDecoder {
    constructor(init) {
      this.init = init;
      this.decodeCalls = [];
      this.closed = false;
      this.frameClosed = false;
      const owner = this;
      this.frame = {
        displayWidth: result.displayWidth,
        displayHeight: result.displayHeight,
        close() {
          owner.frameClosed = true;
        },
      };
      instances.push(this);
    }

    async decode(options) {
      this.decodeCalls.push(options);
      return { image: this.frame, complete: result.complete };
    }

    close() {
      this.closed = true;
    }
  }
  return { ImageDecoder: FakeImageDecoder, instances };
}

function producerInput({
  document,
  fetch,
  ImageDecoder,
  nodeRefFor = nodeRefFactory().nodeRefFor,
}) {
  return {
    document,
    documentRef: "document-test",
    nodeRefFor,
    platform: {
      fetch,
      MutationObserver: FakeMutationObserver,
      AbortController: FakeAbortController,
      ImageDecoder,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

test("coalesces one current-load read and caches its successful proof", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/poster.jpg");
  const fetchGate = deferred();
  const fetchCalls = [];
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return fetchGate.promise;
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const first = producer.read(image);
  const second = producer.read(image);
  await Promise.resolve();
  fetchGate.resolve(response(JPEG_BYTES));
  const [left, right] = await Promise.all([first, second]);
  const cached = await producer.read(image);

  assert.equal(fetchCalls.length, 1);
  assert.equal(decoder.instances.length, 1);
  assert.deepEqual(left, right);
  assert.deepEqual(cached, left);
  assert.equal(left.status, "proven");
  assert.equal("bytes" in left.proof, false);
  producer.dispose();
});

test("uses the exact safe fetch request and forced native JPEG decode", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/poster.jpg?size=large");
  const fetchCalls = [];
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return response(JPEG_BYTES);
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const result = await producer.read(image);

  assert.equal(result.status, "proven");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, image.currentSrc);
  assert.deepEqual(Object.keys(fetchCalls[0].options).sort(), ["credentials", "signal"]);
  assert.equal(fetchCalls[0].options.credentials, "omit");
  assert.equal(fetchCalls[0].options.signal.aborted, false);
  assert.equal(decoder.instances.length, 1);
  assert.equal(decoder.instances[0].init.type, "image/jpeg");
  assert.deepEqual(decoder.instances[0].init.data, JPEG_BYTES);
  assert.deepEqual(decoder.instances[0].decodeCalls, [
    { frameIndex: 0, completeFramesOnly: true },
  ]);
  assert.equal(decoder.instances[0].frameClosed, true);
  assert.equal(decoder.instances[0].closed, true);
  producer.dispose();
});

test("CORS or network rejection is explicit unavailable and does not throw", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/cors-denied.jpg");
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async () => {
      throw new TypeError("Failed to fetch");
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const result = await producer.read(image);

  assert.deepEqual(result, { status: "unavailable", reason: "read-failed" });
  assert.equal(decoder.instances.length, 0);
  producer.dispose();
});

test("an opaque response cannot prove browser-readable bytes", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/opaque.jpg");
  let readBody = false;
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async () => response(JPEG_BYTES, {
      type: "opaque",
      async arrayBuffer() {
        readBody = true;
        return Uint8Array.from(JPEG_BYTES).buffer;
      },
    }),
    ImageDecoder: decoder.ImageDecoder,
  }));

  const result = await producer.read(image);

  assert.deepEqual(result, { status: "unavailable", reason: "read-failed" });
  assert.equal(readBody, false);
  assert.equal(decoder.instances.length, 0);
  producer.dispose();
});

test("actual transparent PNG bytes do not reach the forced JPEG decoder", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/disguised-as-jpeg.jpg");
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async () => response(TRANSPARENT_PNG, {
      headers: { get: () => "image/jpeg" },
    }),
    ImageDecoder: decoder.ImageDecoder,
  }));

  const result = await producer.read(image);

  assert.deepEqual(result, { status: "unavailable", reason: "unsupported-format" });
  assert.equal(decoder.instances.length, 0);
  producer.dispose();
});

test("source and load changes while awaiting reject the old generation", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/first.jpg");
  const firstGate = deferred();
  const decoder = decoderFactory();
  const fetchCalls = [];
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options });
      return fetchCalls.length === 1 ? firstGate.promise : response(JPEG_BYTES);
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const oldRead = producer.read(image);
  await Promise.resolve();
  const observer = FakeMutationObserver.instances.at(-1);
  image.currentSrc = "https://example.test/second.jpg";
  observer.queue({ type: "attributes", target: image, attributeName: "src" });
  document.dispatch("load", image);
  firstGate.resolve(response(JPEG_BYTES));

  assert.deepEqual(await oldRead, { status: "unavailable", reason: "stale-binding" });

  const next = await producer.read(image);
  assert.equal(next.status, "proven");
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].url, "https://example.test/second.jpg");
  producer.dispose();
});

test("A to B to A attribute changes invalidate the same URL cache", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/a.jpg");
  const fetchCalls = [];
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async url => {
      fetchCalls.push(url);
      return response(JPEG_BYTES);
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const first = await producer.read(image);
  assert.equal(first.status, "proven");

  const observer = FakeMutationObserver.instances.at(-1);
  image.currentSrc = "https://example.test/b.jpg";
  observer.queue({ type: "attributes", target: image, attributeName: "src" });
  document.dispatch("load", image);
  image.currentSrc = "https://example.test/a.jpg";
  observer.queue({ type: "attributes", target: image, attributeName: "src" });
  document.dispatch("load", image);

  const second = await producer.read(image);
  assert.equal(second.status, "proven");
  assert.deepEqual(fetchCalls, [
    "https://example.test/a.jpg",
    "https://example.test/a.jpg",
  ]);
  producer.dispose();
});

test("failure is cached for the current load and a new load can retry", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/retry.jpg");
  let fetchCount = 0;
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new TypeError("Failed to fetch");
      return response(JPEG_BYTES);
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const [first, second] = await Promise.all([
    producer.read(image),
    producer.read(image),
  ]);
  const cached = await producer.read(image);
  assert.deepEqual(first, { status: "unavailable", reason: "read-failed" });
  assert.deepEqual(second, first);
  assert.deepEqual(cached, first);
  assert.equal(fetchCount, 1);

  document.dispatch("load", image);
  assert.equal((await producer.read(image)).status, "proven");
  assert.equal(fetchCount, 2);
  producer.dispose();
});

test("missing native decoder remains an explicit unavailable observation", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/no-decoder.jpg");
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async () => response(JPEG_BYTES),
    ImageDecoder: null,
  }));

  assert.deepEqual(await producer.read(image), {
    status: "unavailable",
    reason: "decode-failed",
  });
  producer.dispose();
});

test("replaced and disconnected elements cannot reuse another element proof", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/reused.jpg");
  const refs = nodeRefFactory();
  const fetchCalls = [];
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async url => {
      fetchCalls.push(url);
      return response(JPEG_BYTES);
    },
    ImageDecoder: decoder.ImageDecoder,
    nodeRefFor: element => {
      if (element.tagName === "IMG") return "same-node-ref";
      return refs.nodeRefFor(element);
    },
  }));

  assert.equal((await producer.read(image)).status, "proven");
  const replacement = createImage(document, image.currentSrc);
  assert.equal((await producer.read(replacement)).status, "proven");
  assert.equal(fetchCalls.length, 2);

  image.isConnected = false;
  assert.deepEqual(await producer.read(image), {
    status: "unavailable",
    reason: "invalid-load",
  });
  image.isConnected = true;
  assert.equal((await producer.read(image)).status, "proven");
  assert.equal(fetchCalls.length, 3);
  producer.dispose();
});

test("dispose aborts own work, removes watchers, and returns cancelled", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/slow.jpg");
  const fetchGate = deferred();
  const fetchStarted = deferred();
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async () => {
      fetchStarted.resolve();
      return fetchGate.promise;
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const pending = producer.read(image);
  await fetchStarted.promise;
  const observer = FakeMutationObserver.instances.at(-1);
  const controller = FakeAbortController.instances.at(-1);
  producer.dispose();
  fetchGate.resolve(response(JPEG_BYTES));

  assert.deepEqual(await pending, { status: "unavailable", reason: "cancelled" });
  assert.equal(controller.signal.aborted, true);
  assert.equal(observer.disconnected, true);
  assert.equal(document.listeners.get("load").length, 0);
  assert.equal(document.listeners.get("error").length, 0);
  assert.deepEqual(await producer.read(image), {
    status: "unavailable",
    reason: "cancelled",
  });
});

function peekFixture() {
  const document = createDocument();
  const image = createImage(document, "https://example.test/peek.jpg");
  const fetchCalls = [];
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async url => {
      fetchCalls.push(url);
      return response(JPEG_BYTES);
    },
    ImageDecoder: decoder.ImageDecoder,
  }));
  return { document, image, fetchCalls, decoder, producer };
}

test("peek returns the settled proof for the same current load without fetching again", async () => {
  const { image, fetchCalls, decoder, producer } = peekFixture();

  const settled = await producer.read(image);
  const peeked = producer.peek(image);

  assert.equal(settled.status, "proven");
  assert.deepEqual(peeked, settled);
  assert.equal(fetchCalls.length, 1);
  assert.equal(decoder.instances.length, 1);
  producer.dispose();
});

test("queued same-source mutation invalidates peek before the observer callback runs", async () => {
  const { document, image, fetchCalls, producer } = peekFixture();

  const first = await producer.read(image);
  assert.equal(first.status, "proven");
  const observer = FakeMutationObserver.instances.at(-1);
  image.currentSrc = "https://example.test/peek.jpg";
  observer.queue({ type: "attributes", target: image, attributeName: "src" });

  assert.equal(producer.peek(image), undefined);
  assert.equal(observer.records.length, 0);

  const second = await producer.read(image);
  assert.equal(second.status, "proven");
  assert.equal(fetchCalls.length, 2);

  document.dispatch("load", image);
  assert.equal(producer.peek(image), undefined);
  producer.dispose();
});

test("peek does not expose a pending read or trigger its own fetch", async () => {
  const document = createDocument();
  const image = createImage(document, "https://example.test/pending-peek.jpg");
  const fetchGate = deferred();
  const fetchStarted = deferred();
  const fetchCalls = [];
  const decoder = decoderFactory();
  const producer = createBrowserJpegImageResourceProducer(producerInput({
    document,
    fetch: async url => {
      fetchCalls.push(url);
      fetchStarted.resolve();
      return fetchGate.promise;
    },
    ImageDecoder: decoder.ImageDecoder,
  }));

  const pending = producer.read(image);
  await fetchStarted.promise;
  assert.equal(producer.peek(image), undefined);
  assert.equal(fetchCalls.length, 1);

  fetchGate.resolve(response(JPEG_BYTES));
  const settled = await pending;
  assert.equal(settled.status, "proven");
  assert.deepEqual(producer.peek(image), settled);
  assert.equal(fetchCalls.length, 1);
  assert.equal(decoder.instances.length, 1);
  producer.dispose();
});

test("peek cannot reuse a proof after binding change, load, error, disconnect, or dispose", async () => {
  const { document, image, fetchCalls, producer } = peekFixture();

  const first = await producer.read(image);
  assert.deepEqual(producer.peek(image), first);

  const observer = FakeMutationObserver.instances.at(-1);
  image.currentSrc = "https://example.test/changed.jpg";
  observer.queue({ type: "attributes", target: image, attributeName: "src" });
  assert.equal(producer.peek(image), undefined);

  image.currentSrc = "https://example.test/peek.jpg";
  const second = await producer.read(image);
  assert.equal(second.status, "proven");
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual(producer.peek(image), second);

  document.dispatch("load", image);
  assert.equal(producer.peek(image), undefined);

  const third = await producer.read(image);
  assert.equal(third.status, "proven");
  assert.deepEqual(producer.peek(image), third);

  image.complete = false;
  assert.equal(producer.peek(image), undefined);
  image.complete = true;

  image.isConnected = false;
  assert.equal(producer.peek(image), undefined);
  image.isConnected = true;

  document.dispatch("error", image);
  assert.equal(producer.peek(image), undefined);

  producer.dispose();
  assert.equal(producer.peek(image), undefined);
  assert.equal(fetchCalls.length, 3);
});
