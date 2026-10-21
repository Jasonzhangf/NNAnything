# Typed search consumer

Build the repository, then run `node playground/browser/search/run.mjs --request /absolute/request.json --io /absolute/io.mjs`.

The request uses `BrowserSearchRequest` exported by `nnanything/browser-search`. It binds a document, input, submit control, collection and result scope explicitly. The query comparison is exact. Content matching uses the declared `containsText`, minimum independent result count and `matched_items` or `visible_batch` coverage. This consumer does not discover arbitrary page objects or fit weights.

The IO module exports `resources` or `createResources(request)`. Resources provide a declared handwired or model decision binding, actual observations, current control, native input/submit operations and collection sinks. No implicit mock, browser process or hidden default model is created. Native IO must use actual human input primitives. Observation reads may use visible DOM, AX or screenshots. Page script mutation is outside this contract.

`runBrowserSearchGoal` retains the root and derives input, submission and result-check conditions through the existing recursive controller. Each current step runs the existing 7N6E operation workflow. Input is read back before a later submission. Submission rechecks the current actual input. Results must belong to the current query and declared collection and satisfy the content condition. Bounded result reads can wait for loading; exhaustion cannot imply completion. Collection errors remain separate from observed facts.

Only ordinary `input type=text` is enabled. Textarea, search input and contenteditable are explicitly unsupported in this slice. Pagination, scrolling, filters, arbitrary semantic relevance and multi-site learned binding remain future capabilities. The injected decision provider is replaceable; an invalid selection is rejected and never corrected into an unrequested action. This release uses a handwired initial decision, with no search training or adopted search weights.
