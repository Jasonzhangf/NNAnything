import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  BA1_REAL_SITE_MDN_SHADOW_ROOT_COVERAGE,
} from "../dist/adapters/browser/b-a1-real-site-browser-projection.js";
import { createCurrentControlAuthority } from "../dist/adapters/browser/current-control-authority.js";
import {
  createBA1RealSiteControlSlot,
} from "../dist/adapters/browser/b-a1-real-site-cdp-runtime.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("the page projection module has no Node filesystem or model import", async () => {
  const source = await readFile(
    join(root, "lib/adapters/browser/b-a1-real-site-browser-projection.ts"),
    "utf8",
  );
  assert.equal(/from\s+["']node:/.test(source), false);
  assert.equal(/unified-model-package|unified-forward|node:fs/.test(source), false);
  assert.equal(BA1_REAL_SITE_MDN_SHADOW_ROOT_COVERAGE, "partial");
});

test("the provider slot changes token currentness on a second observation", () => {
  const slot = createBA1RealSiteControlSlot();
  const provider = createCurrentControlAuthority({ documentRef: "doc-1" });
  slot.replace(provider);
  const first = provider.beginObservation();
  provider.beginObservation();
  assert.notDeepEqual(provider.currentControl(), first);
  assert.equal(slot.read().identity.observationId, "observation-2");
});

test("the provider slot never falls back to a previous document", () => {
  const slot = createBA1RealSiteControlSlot();
  const first = createCurrentControlAuthority({ documentRef: "doc-1" });
  slot.replace(first);
  first.beginObservation();
  const second = createCurrentControlAuthority({ documentRef: "doc-2" });
  slot.replace(second);
  second.beginObservation();
  assert.equal(slot.read().identity.documentRef, "doc-2");
  assert.equal(slot.generation(), 2);
  assert.deepEqual(first.currentControl(), {
    documentRef: "doc-1",
    observationId: "observation-1",
    revision: 1,
  });
});
