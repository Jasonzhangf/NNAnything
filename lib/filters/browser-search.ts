import type {BrowserSearchDecisionBinding} from '../adapters/browser/search-contract.js';
/** Explicit baseline, not a fitted profile. It never executes or controls a loop. */
export const handwiredBrowserSearchDecision: BrowserSearchDecisionBinding = Object.freeze<BrowserSearchDecisionBinding>({
  id:'browser.search.handwired.v1', source:'handwired',
  select:({goal})=>({kind:'selected',action:goal.phase==='input'?'input':goal.phase==='submitted'?'submit':'read'}),
});
