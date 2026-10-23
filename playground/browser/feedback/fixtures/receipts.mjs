/**
 * Typed native-click receipts shared by the expanded runner and its tests.
 * Kept free of CDP and profile dependencies so the contract can be asserted
 * without a browser.
 */

export function explicitRejectionReceipt() {
  return Object.freeze({
    dispatched: false,
    ok: false,
    effectKnowledge: 'none',
    source: 'cdp.Input',
    error: null,
  });
}
