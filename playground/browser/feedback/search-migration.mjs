/**
 * B-Feedback plan §8 search-contract migration runner. Eight obligations run
 * once per independent family (A and B), for 16 trajectories. Each row starts
 * its own consumer process through `playground/browser/search/run.mjs`, using
 * the existing CDP-native search IO plus three explicit injected obligations.
 *
 * Usage (run from the repository root by the orchestrator on the host):
 *
 *   node playground/browser/feedback/search-migration.mjs \
 *     --family all \
 *     --cdp http://127.0.0.1:9444 \
 *     --origin http://127.0.0.1:4173 \
 *     --out /absolute/search-migration-acceptance
 *
 * The runner writes rows.jsonl, table.md and summary.json under --out, plus
 * per-case request/case/stdout/stderr/episode/exec-error evidence. It never
 * touches training, weights, profiles or the search contract.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  MIGRATION_FAMILIES,
  SEARCH_MIGRATION_CASES,
  materializeMigrationCase,
  materializeMigrationExpected,
} from "./search-migration-cases.mjs";
import { judgeSearchMigration } from "./search-migration-judge.mjs";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const runEntry = resolve(repo, "playground/browser/search/run.mjs");
const ioEntry = resolve(repo, "playground/browser/search/native-io.mjs");

function argAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined
    ? fallback
    : process.argv[index + 1];
}

const familyArg = argAfter("--family", "all");
const cdp = argAfter("--cdp", "");
const origin = argAfter("--origin", argAfter("--fixture-origin", ""));
const out = resolve(argAfter("--out", resolve(process.cwd(), "b-search-migration-acceptance")));
const resultReads = Number(process.env.BSEARCH_RESULT_READS ?? "8");
if (!Number.isSafeInteger(resultReads) || resultReads < 1) {
  throw new Error("BSEARCH_RESULT_READS must be a positive integer");
}
const families =
  familyArg === "all"
    ? [...MIGRATION_FAMILIES]
    : familyArg === "A"
      ? ["A"]
      : familyArg === "B"
        ? ["B"]
        : (() => {
            throw new Error("--family must be A, B, or all");
          })();

if (!cdp || !origin) throw new Error("--cdp and --origin are required");

function sourceEpisode(sourceResult) {
  if (!sourceResult || typeof sourceResult !== "object" || !("value" in sourceResult)) return null;
  const value = sourceResult.value;
  return value && typeof value === "object" ? value : null;
}

function deriveEvidence(output, config) {
  const report = output?.response?.report ?? null;
  const episodes = (report?.atomicResults ?? [])
    .map((entry) => sourceEpisode(entry.sourceResult))
    .filter(Boolean);
  const phases = {};
  const phaseFacts = [];
  for (const frame of report?.frames ?? []) {
    if (frame.depth === 1 && ["input", "submitted", "results"].includes(frame.goal.phase)) {
      const fact = frame.execution === "not_started" ? "not_evaluated" : frame.fact;
      phases[frame.goal.phase] = fact;
      phaseFacts.push({ phase: frame.goal.phase, fact, execution: frame.execution ?? null });
    }
  }
  const actionCounts = { input: 0, submit: 0, read: 0 };
  for (const episode of episodes) {
    if (episode.action in actionCounts) actionCounts[episode.action] += 1;
  }
  const episodeReceipts = episodes
    .filter((episode) => episode.action === "input" || episode.action === "submit")
    .map((episode) => ({
      action: episode.action,
      source: episode.receipt?.source ?? null,
      dispatched: episode.receipt?.dispatched ?? null,
      ok: episode.receipt?.ok ?? null,
      effectKnowledge: episode.receipt?.effectKnowledge ?? null,
      error: episode.receipt?.error ?? null,
      dispatchState: episode.dispatchState,
    }));
  const mutationReceipts = output.sideEffects?.mutationReceipts ?? [];
  const receipts = mutationReceipts.length > 0
    ? mutationReceipts.map((receipt) => ({
        action: receipt.action,
        source: receipt.source ?? null,
        dispatched: receipt.dispatched ?? null,
        ok: receipt.ok ?? null,
        effectKnowledge: receipt.effectKnowledge ?? null,
        error: receipt.error ?? null,
        dispatchState: receipt.dispatchState ?? "unknown",
      }))
    : episodeReceipts;
  const executionErrors = episodes.flatMap((episode) =>
    (episode.executionErrors ?? []).map((error) => ({
      action: episode.action,
      code: error.code,
      message: error.message,
    })),
  );
  const observationErrors = episodes.flatMap((episode) =>
    (episode.observationFeedback?.errors ?? []).map((error) => ({
      action: episode.action,
      code: error.code,
      message: error.message,
    })),
  );
  const lastEpisodeState = episodes.findLast((episode) => episode.state?.observation)?.state ?? null;
  const finalObservation =
    output.sideEffects?.finalObservation ?? lastEpisodeState?.observation ?? null;
  const observedValue = (fact) => (fact?.status === "observed" ? fact.value : null);
  const baseline =
    episodes.find((episode) => episode.submissionBaseline)?.submissionBaseline ?? null;
  const association = {
    baseline,
    submittedQuery: observedValue(finalObservation?.submittedQuery),
    submittedRequestRef: observedValue(finalObservation?.submittedRequestRef),
    resultsQuery: observedValue(finalObservation?.resultsFor),
    resultsRequestRef: observedValue(finalObservation?.resultsRequestRef),
    collectionRequestRef: observedValue(finalObservation?.collection?.requestRef),
    batch: observedValue(finalObservation?.collection?.batch),
  };
  const collectionItems = finalObservation?.collection?.items ?? [];
  const mainMatches = collectionItems.filter(
    (item) =>
      item.collectionRef === config.goal.collectionRef &&
      item.role === "main" &&
      item.text?.status === "observed" &&
      item.text.value.includes(config.goal.containsText),
  ).length;
  return {
    goalQuery: config.goal.query,
    root: report?.rootEvaluation?.result ?? "not_evaluated",
    control: report?.control?.outcome ?? "not_run",
    controlStopReason: report?.control?.stopReason ?? null,
    phases,
    phaseFacts,
    actionCounts,
    receipts,
    executionErrors,
    observationErrors,
    inputValue: finalObservation?.input?.value ?? { status: "unknown", value: null },
    submittedQuery: finalObservation?.submittedQuery ?? { status: "unknown", value: null },
    resultsFor: finalObservation?.resultsFor ?? { status: "unknown", value: null },
    batch: finalObservation?.collection?.batch ?? { status: "unknown", value: null },
    association,
    effects: episodes.map((episode) => ({
      action: episode.action,
      dispatchState: episode.dispatchState,
      effectKnowledge: episode.effectKnowledge,
    })),
    mainMatches,
    closeErrors: output.closeErrors ?? [],
    migrationId: config.migrationId,
  };
}

function conciseReason(error, stderr) {
  const lines = (stderr || "").split("\n").filter(Boolean);
  const marker =
    lines.find((line) => /EPERM|ECONNREFUSED|ENOTFOUND/.test(line)) ??
    lines.find((line) => /Error:|Build failed|connect/.test(line));
  if (marker) return marker.trim();
  const fromMessage = String(error?.message || "")
    .split("\n")
    .find((line) => /Error/.test(line));
  return (fromMessage || `exit ${error.code ?? "unknown"}`).trim();
}

function summarize(rows) {
  const counts = { total: rows.length, pass: 0, fail: 0, unverified: 0 };
  const distribution = { S: 0, N: 0, U: 0, controlError: 0, nativeActions: 0 };
  for (const row of rows) {
    if (row.status === "PASS") counts.pass += 1;
    else if (row.status === "FAIL") counts.fail += 1;
    else counts.unverified += 1;
    if (row.status !== "PASS") continue;
    if (row.actual?.root === "satisfied") distribution.S += 1;
    else if (row.actual?.root === "unsatisfied") distribution.N += 1;
    else if (row.actual?.root === "unknown") distribution.U += 1;
    if (row.actual?.control === "error") distribution.controlError += 1;
    distribution.nativeActions += row.actual?.receipts?.length ?? 0;
  }
  return { counts, distribution };
}

function compactExpected(expect) {
  return [
    `root=${expect.root}`,
    `stop=${expect.stopReason}`,
  ].join("; ");
}

function compactActual(actual) {
  const phases = actual.phaseFacts?.map((item) => `${item.phase}=${item.fact}`).join("; ") || "none";
  return [
    `exit=${actual.exitCode ?? "null"}`,
    `root=${actual.root}`,
    `control=${actual.control}/${actual.controlStopReason ?? "null"}`,
    `actions=${actual.actionCounts.input}i/${actual.actionCounts.submit}s/${actual.actionCounts.read}r`,
    phases,
  ].join("; ");
}

function nativeText(actual) {
  if (!actual.receipts?.length) return "none";
  return actual.receipts
    .map((receipt) => `${receipt.action}:${receipt.source}/${receipt.dispatchState}`)
    .join("; ");
}

function errorsText(actual) {
  const execution = actual.executionErrors.map((error) => error.code).join("/") || "none";
  const observation = actual.observationErrors.map((error) => error.code).join("/") || "none";
  const effects = actual.effects
    .map((effect) => `${effect.action}:${effect.effectKnowledge}/${effect.dispatchState}`)
    .join("; ") || "none";
  return `exec=${execution}; observe=${observation}; effects=${effects}`;
}

function tableCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function tableMarkdown(rows) {
  const summary = summarize(rows);
  const lines = [
    "# B-Feedback §8 搜索迁移逐例表",
    "",
    "| 家族 | 用例 | 义务 | 来源/注入 | 期望 | 实际 | 判定 | 原因 | native 回执 | 错误与 effects |",
    "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |",
  ];
  for (const row of rows) {
    const actual = row.actual ?? {};
    lines.push(
      `| ${[
        row.family,
        row.caseId,
        row.label,
        row.injection ?? row.source,
        compactExpected(row.expected),
        actual.exitCode === undefined ? "未运行" : compactActual(actual),
        row.status,
        row.reason,
        actual.receipts ? nativeText(actual) : "未运行",
        actual.effects ? errorsText(actual) : "未运行",
      ]
        .map(tableCell)
        .join(" | ")} |`,
    );
  }
  lines.push("", "## 汇总", "");
  lines.push(`- 总轨迹：${summary.counts.total}`);
  lines.push(`- PASS：${summary.counts.pass}`);
  lines.push(`- FAIL：${summary.counts.fail}`);
  lines.push(`- UNVERIFIED：${summary.counts.unverified}`);
  lines.push(`- 已通过轨迹根分布：S=${summary.distribution.S} N=${summary.distribution.N} U=${summary.distribution.U}`);
  lines.push(`- 已通过轨迹 control error：${summary.distribution.controlError}`);
  lines.push(`- 已通过轨迹 native 回执：${summary.distribution.nativeActions}`);
  lines.push("");
  return lines.join("\n");
}

await mkdir(out, { recursive: true });
const rows = [];
for (const family of families) {
  for (const item of SEARCH_MIGRATION_CASES) {
    const config = materializeMigrationCase(family, item);
    const expect = materializeMigrationExpected(family, item);
    const caseDir = resolve(out, family, item.id, "main");
    await mkdir(caseDir, { recursive: true });
    const requestPath = resolve(caseDir, "request.json");
    const casePath = resolve(caseDir, "case.json");
    const request = {
      requestId: `b-search-migration-${family}-${item.id}`,
      goal: config.goal,
      satisfactionThreshold: 100,
      bindings: config.bindings,
      maxResultReads: resultReads,
    };
    await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
    await writeFile(casePath, `${JSON.stringify(config, null, 2)}\n`);

    let runResult;
    try {
      const started = Date.now();
      const result = await execFileAsync(
        process.execPath,
        [runEntry, "--request", requestPath, "--io", ioEntry],
        {
          cwd: repo,
          env: {
            ...process.env,
            BSEARCH_CDP_URL: cdp,
            BSEARCH_FIXTURE_ORIGIN: origin,
            BSEARCH_CASE_DIR: caseDir,
            BSEARCH_RESULT_READS: String(resultReads),
            BSEARCH_READ_TIMEOUT_MS: process.env.BSEARCH_READ_TIMEOUT_MS ?? "1000",
          },
          maxBuffer: 24 * 1024 * 1024,
          timeout: 45000,
        },
      );
      runResult = {
        code: 0,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      runResult = {
        code: error.code === "ETIMEDOUT" ? null : error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        killed: error.killed === true,
        signal: error.signal ?? null,
        message: error.message,
        elapsedMs: error.elapsedMs ?? null,
      };
    }
    await writeFile(resolve(caseDir, "stdout.json"), runResult.stdout);
    await writeFile(resolve(caseDir, "stderr.log"), runResult.stderr);
    await writeFile(
      resolve(caseDir, "exec-error.json"),
      `${JSON.stringify(
        {
          code: runResult.code,
          killed: runResult.killed === true,
          signal: runResult.signal ?? null,
          message: runResult.message ?? null,
        },
        null,
        2,
      )}\n`,
    );

    let parsed = null;
    try {
      parsed = JSON.parse(runResult.stdout);
    } catch {
      parsed = null;
    }
    if (parsed) {
      await writeFile(resolve(caseDir, "episode.json"), `${JSON.stringify(parsed, null, 2)}\n`);
    }

    let actual = null;
    let status;
    let reason;
    if (parsed?.response?.kind === "run_result") {
      actual = { ...deriveEvidence(parsed, config), exitCode: runResult.code };
      const verdict = judgeSearchMigration(item, actual);
      status = verdict.passed ? "PASS" : "FAIL";
      reason = verdict.passed ? "" : `judge: ${verdict.reason}`;
    } else {
      status = "UNVERIFIED";
      reason = `execution did not produce a run report: ${conciseReason(runResult, runResult.stderr)}`;
    }
    rows.push({
      family,
      caseId: item.id,
      migrationId: item.id,
      variant: "main",
      label: item.obligation,
      source: item.source,
      injection: item.injection ?? null,
      expected: expect,
      actual,
      status,
      reason,
      exitCode: runResult.code,
      elapsedMs: runResult.elapsedMs ?? null,
      artifacts: {
        request: requestPath,
        case: casePath,
        stdout: resolve(caseDir, "stdout.json"),
        stderr: resolve(caseDir, "stderr.log"),
        episode: resolve(caseDir, "episode.json"),
        execError: resolve(caseDir, "exec-error.json"),
      },
    });
  }
}

await writeFile(resolve(out, "rows.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
await writeFile(resolve(out, "table.md"), `${tableMarkdown(rows)}\n`);
const summary = summarize(rows);
await writeFile(resolve(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
if (summary.counts.unverified > 0 || summary.counts.fail > 0) process.exitCode = 2;
