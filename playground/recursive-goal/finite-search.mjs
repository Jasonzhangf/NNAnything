import { fileURLToPath } from "node:url";

import { runRecursiveGoal } from "nnanything/recursive-goal";

import { createFiniteSearchHarness } from "./finite-search-adapter.mjs";

export async function runFiniteSearchScenario(name, options = {}) {
  const harness = createFiniteSearchHarness(name, options);
  const response = await runRecursiveGoal(harness.request, harness.dependencies);
  return {
    scenario: name,
    request: harness.request,
    response,
  };
}

export async function runFiniteSearchSuite() {
  const runs = [
    ["search-60-pass", "search", { threshold: 60, matchAt: 4 }],
    ["search-100-pass", "search", { threshold: 100, matchAt: 4 }],
    ["search-60-no-match", "search", { threshold: 60, matchAt: null }],
    ["document-persistent-invalidation", "document", {}],
    ["branch-pass", "branch", { observedBranch: "approve", failSelected: false }],
    ["branch-selected-failure", "branch", { observedBranch: "approve", failSelected: true }],
  ];
  const results = [];
  for (const [label, scenario, options] of runs) {
    results.push({
      label,
      ...(await runFiniteSearchScenario(scenario, options)),
    });
  }
  return results;
}

async function main() {
  const results = await runFiniteSearchSuite();
  console.log(JSON.stringify(results, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
