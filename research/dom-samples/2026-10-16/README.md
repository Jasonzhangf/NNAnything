# DOM sampling and requirements alignment

Status: initial observations and candidate design. No product code or training was performed.

## Confirmed user requirements

- A trainable node has an explicitly designed internal process. Inspect samples, extract shared properties, and design the structure before training.
- LLM and Skill work includes requirements alignment, real-page sampling, commonality analysis, annotation, experiment design, and failure analysis.
- The first task identifies complete non-advertising content cards in social-media feeds.
- Advertisements are negative targets. Filter evidence-backed advertisements as early as their owning content block can be determined.
- Use DOM structure and rendered dimensions/layout, preferably normalized ratios. Raw class/id names may support annotation but do not enter the proposed learned predictor.
- Profiles adapt declared parameters within the designed structure. Cross-site transfer of the same weights is a separate experiment.
- Target sites include Weibo, Xiaohongshu, Zhihu, Bilibili, X, YouTube, Facebook, and Reddit. This collection does not cover all sites.

The user clarified: "这个节点内部构造是我们需要进行的流程设计，设计好了才是训练的事情，不是做一个黑盒子进行训练".

## Collected artifacts

| Page state | Structured sample | Screenshot | Observation |
| --- | --- | --- | --- |
| Weibo home feed | `weibo-home.json` | `weibo-home.png` | 1,160 retained elements; 7 `article` elements are inspection candidates, not verified positive labels. |
| Xiaohongshu explore, login modal open | `xiaohongshu-explore.json` | `xiaohongshu-explore.png` | 761 retained elements; modal occludes underlying feed. Keep separate from unobstructed samples. |
| Xiaohongshu explore, login modal dismissed | `xiaohongshu-feed.json` | `xiaohongshu-feed.png` | 722 retained elements; 30 `section.note-item` elements are inspection candidates, not verified positive labels. |
| Zhihu home | Not collected as feed data | Not collected | Redirected to `/signin`. No feed commonality or classifier claim is supported. |

Each JSON contains capture time, URL without query, viewport, scroll offset, parent indices, tag, class/id, role, aria label, direct text, bounding rectangle, selected computed layout properties, and viewport intersection.

These are structured captures of rendered light-DOM elements with positive bounds and visible CSS. They are not complete HTML archives or offline page reproductions. They omit scripts, form values, link URLs, data attributes, shadow DOM, and iframe subdocuments. CSS visibility and viewport intersection do not establish absence of occlusion. Screenshots and DOM measurements were captured sequentially on live pages; content can change between them.

Class/id and direct text belong to the inspection/annotation view. This collection does not yet implement or prove a separate restricted training feature view. Do not train directly on every stored field.

## Initial findings and evidence limits

1. In the Weibo capture, several `article` candidates are 642 CSS pixels wide, with different heights. The DOM includes recycling wrappers and positive-size elements far above the viewport, including an article near y = -9698. Positive size alone does not establish an active feed card. Distinguish active offscreen content from recycled nodes before selecting a viewport/sampling policy.
2. In the unobstructed Xiaohongshu capture, note candidates are approximately 250.66 CSS pixels wide. The first row has five distinct x positions, and heights vary. The screenshot supports a multicolumn masonry layout. Do not require one globally vertical list.
3. A Xiaohongshu note's wrapper and inner elements can have equal bounds. Geometry alone does not uniquely identify the canonical card DOM boundary. Annotation must define equivalent wrappers or a consistent boundary rule.
4. The candidate counts above come from markup inspection. They do not certify card completeness, organic content, candidate coverage, or advertisement status.
5. No advertisement example has been independently confirmed in this collection. An exact direct-text scan for several advertisement marker words found no matches; this does not establish absence of advertisements or absence of other advertisement signals.
6. Only one home-page state per site was sampled, plus the Xiaohongshu modal state. This is discovery evidence, not a training corpus or generalization benchmark.

## Candidate node design

This design is a discussion draft, not a verified implementation.

| Stage | Explicitly designed responsibility | Potential adaptation |
| --- | --- | --- |
| Observe | Read DOM, layout, and page state; identify unavailable or obstructed content. | Sampling policy is declared, not inferred from labels. |
| Establish minimal block ownership | Associate local markers with the block they describe; do not propagate a marker to the whole page. | Boundary cues require sample evidence. |
| Early advertisement filter | Reject blocks with sufficient contextual advertisement evidence; record rejection reason. | Evidence combination/thresholds may be calibrated; ambiguous blocks continue to later assessment. |
| Layout grouping | Represent vertical feeds, grids, and masonry using local alignment and normalized geometry. | Alignment and similarity tolerances may vary by profile. |
| Card completeness | Inspect the content subtree and distinguish the full card from media-only, body-only, or multi-card containers. | Named evidence scores can have trainable weights. |
| Boundary resolution | Choose a consistent representative and avoid duplicate parent/child outputs. | Canonical boundary semantics remain fixed by the task definition. |
| Return | Emit accepted card nodes and preserve diagnostic decisions for evaluation. | Validate full-chain behavior, including ad leakage and organic false rejection. |

Frozen rules and trainable scores must be declared separately. DOM acquisition and string/marker extraction can remain ordinary host operations. Handwired can express the intended numeric circuit. Do not assume the entire browser workflow is differentiable. Hard filters and final decisions need explicit gradient/training choices if they lie on a training path.

## Evidence required before training

- Verified complete-card annotations and negative examples, including real advertisements, nested reposts, recommendations, comments, and duplicate wrappers.
- An explicit definition of advertising: platform-marked ads, broader commercial promotion, or both.
- A commonality table linking each proposed feature to positive examples and counterexamples.
- An internal process design naming inputs, intermediate meanings, fixed operations, trainable parameters, profile scope, and observable outputs.
- Page/group-based data splits and an independently checked evaluation set.
- Separate evaluation of early ad filtering, card boundaries, and the complete page-to-result chain. Track ordinary posts incorrectly filtered before prediction.
- Same-weight cross-site transfer and profile adaptation reported separately. Compare profile adaptation with training from scratch on the same annotation budget.

Browser research used ego-browser TaskSpace 21. The task space was finished with no retained pages. The browser reported an available update; no update or login action was performed.

## Follow-up using the built-in browser

The user reported that a Chrome extension removes advertisements and requested the built-in browser. Follow-up observations used the Codex in-app browser (`iab`) through the computer-use browser interface. The original files above were not replaced. This switch does not by itself prove that the earlier ego-browser samples were modified by that Chrome extension, or that the new environment is free of all filtering.

- Weibo redirected to `/newlogin` and displayed a public feed with login/register controls. This differs from the earlier signed-in home feed, so it is not a controlled test of extension effects.
- The initial built-in Weibo measurement contained 1,429 DOM elements, 818 with positive bounds, and 8 positive-bounds `article` candidates. Several were 642 CSS pixels wide; one was positioned at y = -9607. Candidates remain unverified labels. The first eight had direct child tags `div` and `footer`, providing an observable candidate completeness cue rather than a universal requirement.
- Xiaohongshu displayed the explore feed. The initial measurement contained 1,221 DOM elements, 714 with positive bounds, and 26 positive-bounds `section` candidates. The inspected note cards were approximately 227.19 CSS pixels wide with several distinct x positions. A login modal subsequently appeared; its close control was used before scrolling.
- After scrolling Xiaohongshu, only 10 `section.note-item` elements remained in the DOM at document scrollTop 2230. This observation supports recording a sequence of captures; one DOM capture cannot be assumed to contain every card seen while scrolling.
- The initial exact marker scan found no matches on either page. A broader Xiaohongshu scan after scrolling found an ad-blocking warning string and the text `推广合作`. Both measured 0 by 0 pixels. The warning was hidden DOM text, not a visible warning or proof that an ad blocker was detected. Neither match is a verified advertising card.
- No verified advertisement card was obtained in this follow-up. Public/logged-out feeds, viewport differences, time, and recommendations are confounders. Further advertisement sampling is required before specifying or validating an advertisement filter.

The compact follow-up measurements are in `iab-observations.json`. They are selected inspection observations, not a full DOM export or training dataset. No product code, model training, extension change, or account login was performed.

## User login and expanded input requirements

After the public-page observations above, the user completed Weibo login in the built-in browser. The signed-in feed was then observed and saved as `iab-weibo-signed-in.json` and `.jpg`. Xiaohongshu was saved separately as `iab-xiaohongshu-public.json` and `.jpg`.

The signed-in Weibo capture has 1,441 retained nodes and 10 article inspection candidates. The public Xiaohongshu capture has 690 retained nodes and 30 section inspection candidates. These are raw inspection samples, not fully annotated training examples.

One Weibo advertisement is now visually confirmed: `iab-weibo-ad-card.jpg` shows an advertising label in the card header. The label is an image rather than DOM text, explaining why text-only scans did not detect this example. `iab-ad-annotation.json` links the evidence to node 492 in the saved signed-in DOM. This supersedes the earlier no-confirmed-ad result for the expanded collection; it does not change what was observed in the earlier public captures.

`iab-parent-chains.json` records the public-page ancestor topology without class/id names. `iab-scroll-observations.json` records current candidate and ancestor rectangles, client dimensions, scroll dimensions/offsets, overflow properties, and document scroller information. Both observed logical lists can be carried by document scrolling. An overflow declaration alone did not establish actual scroll range.

The user explicitly added position, dimensions, parent/list relationship, and scrolling as required basic input categories. The proposed interpretation, fixed-vs-trainable split, observed counterexamples, and remaining work are in `../../dom-input-design.md`.
