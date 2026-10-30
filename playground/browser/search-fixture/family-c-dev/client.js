export function attachFamilyCDevGridClient(rootDocument) {
  if (!rootDocument || typeof rootDocument.getElementById !== "function") {
    return { attached: false };
  }
  const form = rootDocument.getElementById("search-form");
  const requestState = rootDocument.getElementById("request-state");
  const loadMore = rootDocument.getElementById("load-more");
  const terminalBanner = rootDocument.getElementById("collection-terminal-banner");

  return {
    attached: true,
    hasForm: Boolean(form),
    hasRequestState: Boolean(requestState),
    hasLoadMore: Boolean(loadMore),
    hasTerminalBanner: Boolean(terminalBanner)
  };
}
