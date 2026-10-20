import assert from "node:assert/strict";
import { test } from "node:test";

const { observeJpegImageResource } = await import("../dist/adapters/browser/image-resource.js");

const JPEG_BYTES = new Uint8Array(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q==",
  "base64",
));
const TRANSPARENT_PNG_PREFIX = new Uint8Array(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
));

function binding(overrides = {}) {
  return {
    documentRef: "document-1",
    nodeRef: "node-1",
    loadGeneration: 4,
    currentSrc: "https://example.test/poster.jpg",
    complete: true,
    naturalWidth: 1,
    naturalHeight: 1,
    ...overrides,
  };
}

function snapshots(values) {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)];
}

function decoder(result = { complete: true, width: 1, height: 1 }) {
  // Unit-test double only; this is not a native decoder or runtime producer.
  const calls = [];
  return {
    calls,
    decodeJpeg: async bytes => {
      calls.push(bytes);
      return result;
    },
  };
}

test("unchanged browser-readable JPEG binding returns proven dimensions without bytes", async () => {
  const current = binding();
  const injected = decoder();
  const provenance = { kind: "browser-readable-response" };
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([{ ...current }, { ...current }]),
    readBytes: async observed => {
      assert.deepEqual(observed, current);
      return { bytes: JPEG_BYTES, provenance };
    },
    decodeJpeg: injected.decodeJpeg,
  });

  assert.equal(injected.calls.length, 1);
  assert.strictEqual(injected.calls[0], JPEG_BYTES);
  assert.deepEqual(result, {
    status: "proven",
    proof: {
      width: 1,
      height: 1,
      binding: current,
      provenance,
    },
  });
  assert.equal("bytes" in result.proof, false);
});

test("official IAB download provenance is preserved in the proof", async () => {
  const current = binding();
  const provenance = {
    kind: "official-iab-download",
    receiptRef: "download-receipt-17",
  };
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([current, current]),
    readBytes: async () => ({ bytes: JPEG_BYTES, provenance }),
    // This decoder is an injected unit-test double, not native runtime evidence.
    decodeJpeg: async () => ({ complete: true, width: 1, height: 1 }),
  });

  assert.deepEqual(result, {
    status: "proven",
    proof: { width: 1, height: 1, binding: current, provenance },
  });
});

test("a real PNG byte prefix is rejected without invoking the forced JPEG decoder", async () => {
  const current = binding();
  const injected = decoder();
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([current, current]),
    readBytes: async () => ({
      bytes: TRANSPARENT_PNG_PREFIX,
      provenance: { kind: "browser-readable-response" },
    }),
    decodeJpeg: injected.decodeJpeg,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "unsupported-format" });
  assert.equal(injected.calls.length, 0);
});

test("spoofed JPEG prefix with decode rejection is unavailable and does not throw", async () => {
  const current = binding();
  const spoofed = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0xff, 0xd9]);
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([current, current]),
    readBytes: async () => ({
      bytes: spoofed,
      provenance: { kind: "browser-readable-response" },
    }),
    decodeJpeg: async () => {
      throw new Error("native JPEG decoder rejected bytes");
    },
  });

  assert.deepEqual(result, { status: "unavailable", reason: "decode-failed" });
});

test("readBytes rejection is an explicit read failure and does not escape", async () => {
  const current = binding();
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([current]),
    readBytes: async () => {
      throw new Error("CORS denied");
    },
    decodeJpeg: async () => ({ complete: true, width: 1, height: 1 }),
  });

  assert.deepEqual(result, { status: "unavailable", reason: "read-failed" });
});

test("incomplete native decode is unavailable", async () => {
  const current = binding();
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([current, current]),
    readBytes: async () => ({
      bytes: JPEG_BYTES,
      provenance: { kind: "browser-readable-response" },
    }),
    decodeJpeg: async () => ({ complete: false, width: 1, height: 1 }),
  });

  assert.deepEqual(result, { status: "unavailable", reason: "incomplete" });
});

test("decoded dimensions must match the explicit load binding", async () => {
  const current = binding({ naturalWidth: 640, naturalHeight: 360 });
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([current, current]),
    readBytes: async () => ({
      bytes: JPEG_BYTES,
      provenance: { kind: "browser-readable-response" },
    }),
    decodeJpeg: async () => ({ complete: true, width: 640, height: 359 }),
  });

  assert.deepEqual(result, { status: "unavailable", reason: "dimension-mismatch" });
});

test("generation, source, and element changes across byte reading are stale", async () => {
  const changes = [
    ["generation", { loadGeneration: 5 }],
    ["source", { currentSrc: "https://example.test/other.jpg" }],
    ["element", { nodeRef: "node-2" }],
  ];

  for (const [name, change] of changes) {
    const current = binding();
    const result = await observeJpegImageResource({
      binding: current,
      readCurrentBinding: snapshots([current, { ...current, ...change }]),
      readBytes: async () => ({
        bytes: JPEG_BYTES,
        provenance: { kind: "browser-readable-response" },
      }),
      decodeJpeg: async () => ({ complete: true, width: 1, height: 1 }),
    });
    assert.deepEqual(result, { status: "unavailable", reason: "stale-binding" }, name);
  }
});

test("binding change after awaited decode is stale", async () => {
  const current = binding();
  const result = await observeJpegImageResource({
    binding: current,
    readCurrentBinding: snapshots([current, current, { ...current, loadGeneration: 9 }]),
    readBytes: async () => ({
      bytes: JPEG_BYTES,
      provenance: { kind: "browser-readable-response" },
    }),
    decodeJpeg: async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return { complete: true, width: 1, height: 1 };
    },
  });

  assert.deepEqual(result, { status: "unavailable", reason: "stale-binding" });
});

test("invalid or incomplete load bindings are unavailable without reading bytes", async () => {
  for (const current of [
    binding({ complete: false }),
    binding({ loadGeneration: undefined }),
    binding({ naturalWidth: 0 }),
    binding({ nodeRef: "" }),
  ]) {
    let read = false;
    const result = await observeJpegImageResource({
      binding: current,
      readCurrentBinding: async () => current,
      readBytes: async () => {
        read = true;
        return {
          bytes: JPEG_BYTES,
          provenance: { kind: "browser-readable-response" },
        };
      },
      decodeJpeg: async () => ({ complete: true, width: 1, height: 1 }),
    });
    assert.deepEqual(result, { status: "unavailable", reason: "invalid-load" });
    assert.equal(read, false);
  }
});

test("missing caller dependencies are a typed contract violation", async () => {
  await assert.rejects(
    () => observeJpegImageResource({
      binding: binding(),
      readCurrentBinding: async () => binding(),
      readBytes: async () => ({
        bytes: JPEG_BYTES,
        provenance: { kind: "browser-readable-response" },
      }),
    }),
    TypeError,
  );
});
