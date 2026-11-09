import { convertAllExistingUnitsToCoverageReport } from "../dist/training/generalization-coverage.js";

function parseArgs(argv) {
  let mode = "audit_diagnostic";
  let cliCommandSamplesPath;
  let repositoryRoot;
  let includeUpstreamCandidateInference = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      mode = argv[i + 1];
      i += 1;
    } else if (arg === "--cli-command-samples") {
      cliCommandSamplesPath = argv[i + 1];
      i += 1;
    } else if (arg === "--repo-root") {
      repositoryRoot = argv[i + 1];
      i += 1;
    } else if (arg === "--without-upstream-candidates") {
      includeUpstreamCandidateInference = false;
    } else {
      throw new TypeError(`Unknown CLI flag: ${arg}`);
    }
  }
  if (repositoryRoot === undefined) {
    throw new TypeError("--repo-root is required");
  }
  return {
    mode,
    cliCommandSamplesPath,
    repositoryRoot,
    includeUpstreamCandidateInference,
  };
}

const parsed = parseArgs(process.argv.slice(2));
const report = convertAllExistingUnitsToCoverageReport(parsed);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
