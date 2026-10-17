const RESTRICTED_PROTOCOLS = [
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "view-source:",
  "devtools:",
];

function isRestrictedUrl(url?: string | null): boolean {
  if (!url) return true;
  return RESTRICTED_PROTOCOLS.some((proto) => url.startsWith(proto));
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  if (isRestrictedUrl(tab.url)) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#ef4444" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: `Cannot inspect restricted page: ${tab.url || "unsupported protocol"}`,
    });
    return;
  }

  try {
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: "NNAnything DOM Inspector",
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#ef4444" });
    await chrome.action.setTitle({
      tabId: tab.id,
      title: `Injection failed: ${message}`,
    });
  }
});
