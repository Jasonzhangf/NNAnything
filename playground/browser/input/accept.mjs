import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CASE_IDS, materializeCase } from "./cases.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const runEntry = resolve(here, "run.mjs");
const ioEntry = resolve(here, "cdp-io.mjs");

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

const familyArg = argAfter("--family", "all");
const cdp = argAfter("--cdp", "http://127.0.0.1:9333");
const out = resolve(argAfter("--out", resolve(process.cwd(), "b-input-acceptance")));
const families = familyArg === "all" ? ["A", "B"] : familyArg === "A" ? ["A"] : familyArg === "B" ? ["B"] : (() => {
  throw new Error("--family must be A, B, or all");
})();

const goalText = "目标文本";

function requestFor(config) {
  return {
    requestId: `b-input-${config.family}-${config.caseId}`,
    goal: { kind: "BrowserInput", targetText: goalText },
    satisfactionThreshold: 100,
    bindings: {
      documentRef: config.documentRef,
      scopeRef: config.scopeRef,
      targetRef: config.targetRef,
      ...(config.sensitive ? { sensitive: true } : {}),
    },
  };
}

function check(episode, expected, sideEffects, config) {
  const refusal = episode.refusal?.code ?? null;
  const executionError = episode.executionErrors.length > 0;
  const observationError = episode.observationFeedback.errors.length > 0;
  const neighbor = episode.state?.observation?.neighbors?.[0];
  const neighborValue = sideEffects?.neighborValue ?? neighbor?.value?.value ?? null;
  const neighborUnchanged = neighborValue === config.neighborValue;
  const events = Array.isArray(episode.nativeEvents) ? episode.nativeEvents : [];
  const pressedEnter = events.some(event =>
    (event.type === "rawKeyDown" || event.type === "keyDown" || event.type === "keyUp")
    && event.detail === "Enter");
  const submitted = events.some(event => typeof event.type === "string" && /submit/i.test(event.type));
  return {
    goalFact: episode.goalFact === expected.goalFact,
    satisfaction: episode.satisfaction === expected.satisfaction,
    textWriteCount: episode.textWriteCount === expected.textWriteCount,
    dispatchState: episode.dispatchState === expected.dispatchState,
    canContinue: episode.canContinue === expected.canContinue,
    refusal: refusal === expected.refusal,
    executionErrors: executionError === expected.executionErrors,
    observationErrors: observationError === expected.observationErrors,
    neighborUnchanged,
    noEnter: pressedEnter === false,
    noSubmit: submitted === false
      && (episode.invocation === null || episode.invocation.kind === "input"),
  };
}

function conciseReason(error, stderr) {
  const lines = (stderr || "").split("\n").filter(Boolean);
  const marker = lines.find(line => /EPERM|ECONNREFUSED|ENOTFOUND/.test(line))
    ?? lines.find(line => /Error:|Build failed|connect/.test(line));
  if (marker) return marker.trim();
  const fromMessage = String(error?.message || "").split("\n").find(line => /Error/.test(line));
  return (fromMessage || `exit ${error?.code ?? "unknown"}`).trim();
}

function summarize(rows) {
  const counts = { total: rows.length, pass: 0, fail: 0, unverified: 0 };
  const distribution = { S: 0, N: 0, U: 0, refusals: 0, executionErrors: 0, observationErrors: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.status === "pass" && row.actual) {
      if (row.actual.episode.goalFact === "satisfied") distribution.S += 1;
      else if (row.actual.episode.goalFact === "unsatisfied") distribution.N += 1;
      else distribution.U += 1;
      if (row.actual.episode.refusal) distribution.refusals += 1;
      if (row.actual.episode.executionErrors.length > 0) distribution.executionErrors += 1;
      if (row.actual.episode.observationFeedback.errors.length > 0) distribution.observationErrors += 1;
    }
  }
  return { counts, distribution };
}

function tableMarkdown(rows) {
  const summary = summarize(rows);
  const lines = [];
  lines.push("# B-Input 逐例验收表");
  lines.push("");
  lines.push("| 家族 | 用例 | 期望 Goal | 实际 Goal | 判定 | 说明 |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- |");
  for (const row of rows) {
    const actualGoal = row.actual?.episode?.goalFact ?? "未运行";
    lines.push(`| ${row.family} | ${row.caseId} | ${row.expected.goalFact} | ${actualGoal} | ${row.status} | ${row.reason ?? ""} |`);
  }
  lines.push("");
  lines.push("## 汇总");
  lines.push("");
  lines.push(`- 总实例：${summary.counts.total}`);
  lines.push(`- 通过：${summary.counts.pass}`);
  lines.push(`- 失败：${summary.counts.fail}`);
  lines.push(`- 未验证：${summary.counts.unverified}`);
  lines.push("");
  lines.push("### 已执行实例的分布（仅 status=pass 的实例计入）");
  lines.push(`- S：${summary.distribution.S}`);
  lines.push(`- N：${summary.distribution.N}`);
  lines.push(`- U：${summary.distribution.U}`);
  lines.push(`- 拒绝：${summary.distribution.refusals}`);
  lines.push(`- 执行错误：${summary.distribution.executionErrors}`);
  lines.push(`- 观察错误：${summary.distribution.observationErrors}`);
  lines.push("");
  return lines.join("\n");
}

await mkdir(out, { recursive: true });

const rows = [];
for (const family of families) {
  for (const caseId of CASE_IDS) {
    const config = materializeCase(family, caseId);
    const caseDir = resolve(out, family, caseId);
    await mkdir(caseDir, { recursive: true });
    const requestPath = resolve(caseDir, "request.json");
    const casePath = resolve(caseDir, "case.json");
    const request = requestFor(config);
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    await writeFile(casePath, `${JSON.stringify(config, null, 2)}\n`);

    let row;
    // run.mjs exits non-zero for non-continuable outcomes by design, so capture
    // stdout/stderr/exit code instead of rejecting on a non-zero exit.
    const result = await new Promise(resolveRun => {
      execFile(process.execPath, [runEntry, "--request", requestPath, "--io", ioEntry], {
        cwd: repo,
        env: {
          ...process.env,
          B_INPUT_CDP: cdp,
          B_INPUT_CASE_FILE: casePath,
        },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      }, (error, stdout, stderr) => {
        resolveRun({
          error,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          code: error?.code,
          killed: error?.killed === true,
        });
      });
    });
    try {
      if (result.killed) throw new Error("runner timed out");
      await writeFile(resolve(caseDir, "stdout.json"), result.stdout);
      await writeFile(resolve(caseDir, "stderr.log"), result.stderr);
      let actual;
      try {
        actual = JSON.parse(result.stdout);
      } catch {
        throw new Error("runner stdout was not JSON");
      }
      await writeFile(resolve(caseDir, "episode.json"), `${JSON.stringify(actual, null, 2)}\n`);
      const checks = check(actual.episode, config.expected, actual.sideEffects, config);
      const passed = Object.values(checks).every(Boolean);
      row = {
        family,
        caseId,
        expected: config.expected,
        actual,
        checks,
        status: passed ? "pass" : "fail",
        reason: passed ? "" : "one or more behavior checks failed",
        artifacts: { request: requestPath, case: casePath, episode: resolve(caseDir, "episode.json") },
      };
    } catch (error) {
      await writeFile(resolve(caseDir, "exec-error.json"), `${JSON.stringify({ message: error?.message, code: error?.code }, null, 2)}\n`);
      const reason = error?.code === "ETIMEDOUT"
        ? "runner timed out"
        : conciseReason(error, result.stderr);
      row = {
        family,
        caseId,
        expected: config.expected,
        actual: null,
        checks: null,
        status: "unverified",
        reason: `execution did not produce an episode: ${reason}`,
        artifacts: { request: requestPath, case: casePath },
      };
    }
    rows.push(row);
  }
}

await writeFile(
  resolve(out, "rows.jsonl"),
  rows.map(row => JSON.stringify(row)).join("\n") + "\n",
);
await writeFile(resolve(out, "table.md"), `${tableMarkdown(rows)}\n`);

const summary = summarize(rows);
console.log(JSON.stringify(summary, null, 2));
if (summary.counts.unverified > 0 || summary.counts.fail > 0) process.exitCode = 2;
