import { FAMILY_C_DEV_CORPORA, FAMILY_C_DEV_FAMILY_ID } from "./data.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderCardArticle(card, index) {
  return `<article class="grid-card" data-card-id="${escapeHtml(card.id)}" data-card-index="${index}">
    <header class="grid-card-header">${escapeHtml(card.title)}</header>
    <div class="grid-card-meta">${escapeHtml(card.category)}</div>
    <p class="grid-card-body">${escapeHtml(card.summary)}</p>
  </article>`;
}

export function renderFamilyCDevSearchPage(options = {}) {
  const {
    query = "quartz",
    inputValue = query,
    submittedQuery = query,
    submissionId = "sub-fc-1",
    responseSubmissionId = submissionId,
    requestStatus = "settled",
    accessOutcome = "available",
    corpusKey = "sparse",
    batchStage = 1,
    hasMore = "false",
    terminalBannerVisible = true,
    inputType = "search",
    inputDisabled = false,
    inputReadOnly = false,
    inputContentEditable = false,
    includeSecondaryFilter = true
  } = options;

  const corpus = FAMILY_C_DEV_CORPORA[corpusKey] ?? FAMILY_C_DEV_CORPORA.sparse;
  const activeCards =
    batchStage >= 2 ? [...corpus.batch1, ...corpus.batch2] : [...corpus.batch1];
  const batchRef =
    requestStatus === "loading"
      ? ""
      : `${FAMILY_C_DEV_FAMILY_ID}:${corpusKey}:b${batchStage}:${submittedQuery || "none"}`;

  const disabledAttr = inputDisabled ? " disabled" : "";
  const readOnlyAttr = inputReadOnly ? " readonly" : "";

  const primaryControlHtml = inputContentEditable
    ? `<div id="search-input" role="textbox" contenteditable="true" data-value="${escapeHtml(inputValue)}">${escapeHtml(inputValue)}</div>`
    : `<input id="search-input" type="${escapeHtml(inputType)}" value="${escapeHtml(inputValue)}"${disabledAttr}${readOnlyAttr} />`;

  const secondaryFilterHtml = includeSecondaryFilter
    ? `<aside id="grid-Auxiliary-filter">
        <label for="secondary-tag-filter">Tag Filter</label>
        <input id="secondary-tag-filter" type="text" value="" placeholder="Optional card tag" />
      </aside>`
    : "";

  const accessBannerHtml =
    accessOutcome === "login_required"
      ? `<div id="access-wall-banner" data-access-outcome="login_required">Authentication required to view grid cards.</div>`
      : accessOutcome === "rate_limited"
        ? `<div id="access-wall-banner" data-access-outcome="rate_limited">Rate limit exceeded for card grid query.</div>`
        : "";

  const cardsHtml =
    accessOutcome === "available" && requestStatus !== "loading"
      ? activeCards.map((card, index) => renderCardArticle(card, index)).join("\n")
      : "";

  const loadMoreHtml =
    hasMore === "true"
      ? `<button id="load-more" type="button" data-has-more="true">Load Next Card Row</button>`
      : `<button id="load-more" type="button" data-has-more="${escapeHtml(hasMore)}" disabled style="display:none">No More Cards</button>`;

  const terminalBannerHtml =
    terminalBannerVisible && hasMore === "false"
      ? `<footer id="collection-terminal-banner" data-terminal="true">End of card grid results</footer>`
      : `<footer id="collection-terminal-banner" data-terminal="false" style="display:none"></footer>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Family C Dev Card Grid Search</title>
</head>
<body data-family-id="${FAMILY_C_DEV_FAMILY_ID}">
  <main id="family-c-grid-app">
    <form id="search-form" data-submitted-query="${escapeHtml(submittedQuery)}" data-submission-id="${escapeHtml(submissionId)}">
      ${primaryControlHtml}
      <button id="search-submit" type="submit">Search Grid</button>
    </form>
    ${secondaryFilterHtml}
    <div id="request-state"
      data-request-status="${escapeHtml(requestStatus)}"
      data-submitted-query="${escapeHtml(submittedQuery)}"
      data-submission-id="${escapeHtml(submissionId)}"
      data-response-submission-id="${escapeHtml(responseSubmissionId)}"
      data-access-outcome="${escapeHtml(accessOutcome)}"
      data-batch-ref="${escapeHtml(batchRef)}"
      data-has-more="${escapeHtml(hasMore)}">
      ${escapeHtml(requestStatus)}
    </div>
    ${accessBannerHtml}
    <div id="result-scroll-box" data-scroll-container="true">
      <section id="grid-main-collection" role="region" aria-label="Primary Card Grid">
        ${cardsHtml}
      </section>
      ${loadMoreHtml}
      ${terminalBannerHtml}
      <div id="long-footer-spacer" style="height: 240px;"></div>
    </div>
  </main>
  <script type="module" src="./client.js"></script>
</body>
</html>`;
}
