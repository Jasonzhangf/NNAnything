// Formal red tests for the batch/GPU compute backend, its checkpoint contract and
// its per-step observability (amendment V9–V15).
//
// The modules are loaded explicitly from NN_L2_BACKEND_DIST so this suite can run
// against an external `tsc --outDir` artifact while the experiment tree still
// resolves its own `dist/` for the old E process. Default is the tree `dist/`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST_ROOT = process.env.NN_L2_BACKEND_DIST ?? fileURLToPath(new URL("../dist", import.meta.url));
const BACKEND_MODULE = pathToFileURL(join(DIST_ROOT, "training/l2-mlp-backend.js")).href;
const MLP_MODULE = pathToFileURL(join(DIST_ROOT, "training/l2-mlp.js")).href;
// The TypeScript build emits JavaScript only, so a compiled artifact may not ship
// the Python bridge. Pass it explicitly when present; otherwise let the module
// resolve the source-tree asset itself.
const BRIDGE = join(DIST_ROOT, "training/l2-gpu-bridge.py");
const BRIDGE_OPTION = existsSync(BRIDGE) ? { bridgePath: BRIDGE } : {};
const PYTHON = process.env.NN_L2_PYTHON_BIN ?? "/opt/homebrew/bin/python3.13";
const HANDWIRED_ROOT = process.env.NN_HANDWIRED_ROOT;

const { runBackendFit, readL2Checkpoint } = await import(BACKEND_MODULE);
const { fitL2Mlp, createL2Unit, readL2Profile, saveL2Profile } = await import(MLP_MODULE);

const assetGated = { skip: !HANDWIRED_ROOT && "provide explicit NN_HANDWIRED_ROOT" };

const specs = {
  R: { features: ["r0", "r1"], labels: ["same", "diff", "later"], hidden: [5, 4] },
  D: { features: ["d0"], labels: ["planA", "planB"], hidden: [3, 3] },
  E: { features: ["e0"], labels: ["yes", "no"], hidden: [3, 2] },
  A: { features: ["a0", "a1"], labels: ["act", "skip", "defer"], hidden: [4, 3] },
};

// Repeated rows (5:1), a multi-label allowed set and a frozen-head case fixture.
function trainingRows() {
  return [
    ["R", [0.4, -0.2], ["same"]], ["R", [0.4, -0.2], ["same"]],
    ["R", [0.4, -0.2], ["same"]], ["R", [0.4, -0.2], ["same"]],
    ["R", [0.4, -0.2], ["same"]], ["R", [-0.6, 0.3], ["diff", "later"]],
    ["D", [0.7], ["planA"]], ["D", [-0.5], ["planB"]],
    ["E", [0.9], ["yes", "no"]], ["E", [-0.8], ["no"]],
    ["A", [0.3, -0.4], ["act"]], ["A", [0.3, -0.4], ["act"]],
    ["A", [0.3, -0.4], ["act"]], ["A", [-0.2, 0.8], ["skip"]],
  ].map(([head, features, allowed], index) => ({
    id: `row-${index}`,
    sourceGroup: "backend-test",
    partition: "train",
    head,
    features,
    allowed,
  }));
}

function rowsFor(heads) {
  return trainingRows().filter(row => heads.includes(row.head));
}

function baseInput(overrides = {}) {
  return {
    handwiredRoot: HANDWIRED_ROOT ?? "/unused",
    specs,
    rows: trainingRows(),
    seed: 20261025,
    learningRate: 0.1,
    epochs: 6,
    stopCheckpoints: [],
    computeBackend: process.env.NN_L2_BACKEND_DEVICE === "gpu" ? "gpu" : "batch-cpu",
    pythonBin: PYTHON,
    ...BRIDGE_OPTION,
    ...overrides,
  };
}

function maxAbsDiff(left, right) {
  assert.equal(left.length, right.length);
  let max = 0;
  let index = -1;
  for (let cursor = 0; cursor < left.length; cursor += 1) {
    const delta = Math.abs(left[cursor] - right[cursor]);
    if (delta > max) {
      max = delta;
      index = cursor;
    }
  }
  return { max, index };
}

function parameterCount(spec) {
  const [hiddenOne, hiddenTwo] = spec.hidden;
  return hiddenOne * spec.features.length + hiddenOne
    + hiddenTwo * hiddenOne + hiddenTwo
    + spec.labels.length * hiddenTwo + spec.labels.length;
}

// Deterministic starting profile, built without any external asset so the
// backend contract is tested on its own terms. The reference initializer stays
// covered by tests/l2-mlp.test.mjs.
function deterministicProfile() {
  let state = 20261025;
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const heads = {};
  for (const head of ["R", "D", "E", "A"]) {
    const spec = specs[head];
    heads[head] = {
      spec,
      parameters: Array.from({ length: parameterCount(spec) }, () => (next() - 0.5) * 0.4),
    };
  }
  return { schema: "nnanything.l2.mlp.v1", heads, calibration: "uncalibrated", adoption: "not_applied" };
}

async function workDir(name) {
  return mkdtemp(join(tmpdir(), `l2-backend-${name}-`));
}

function steps(events) {
  return events.filter(event => event.type === "step");
}

function phases(events, phase) {
  return events.filter(event => event.type === "phase" && event.phase === phase);
}

// V9: a J-step run that saves and exits, then a new run that resumes, must be
// identical to one unbroken K-step run, and must never re-run step 0.
test("V9 resume continues from the persisted step and matches an unbroken run", async () => {
  const work = await workDir("v9");
  const K = 6;
  const J = 2;
  const initialProfile = deterministicProfile();

  const continuousEvents = [];
  const continuous = await runBackendFit({
    ...baseInput(), initialProfile, epochs: K,
    onProgress: event => continuousEvents.push(event),
  });

  const checkpointPath = join(work, "checkpoint.json");
  const firstEvents = [];
  const first = await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, updatesThisRun: J,
    checkpointPath, checkpointEverySteps: 1,
    onProgress: event => firstEvents.push(event),
  });
  assert.equal(first.report.epochsCompleted, J);

  const resumedEvents = [];
  const resumed = await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, resume: true, checkpointPath,
    onProgress: event => resumedEvents.push(event),
  });

  // Only the remaining steps run, numbered J+1..K, with no overshoot.
  const resumedSteps = steps(resumedEvents).map(event => event.completedUpdates);
  assert.deepEqual(resumedSteps, [3, 4, 5, 6]);
  assert.equal(resumed.report.epochsCompleted, K);
  assert.deepEqual(
    steps(continuousEvents).map(event => event.completedUpdates),
    [1, 2, 3, 4, 5, 6],
  );

  // Epoch-zero baseline is reused, not recomputed on the step-2 weights.
  assert.deepEqual(resumed.report.epochZero, continuous.report.epochZero);
  assert.deepEqual(continuous.report.epochZero, first.report.epochZero);

  // Trained parameters match the unbroken run, and the trajectory has K entries.
  for (const head of ["R", "D", "E", "A"]) {
    const delta = maxAbsDiff(
      resumed.profile.heads[head].parameters,
      continuous.profile.heads[head].parameters,
    );
    assert.ok(delta.max <= 1e-6, `head ${head} resumed drift ${delta.max} at ${delta.index}`);
    assert.equal(resumed.report.trajectory.length, K);
  }
  await rm(work, { recursive: true, force: true });
});

// V10: resuming an already complete checkpoint performs zero updates.
test("V10 a full budget resume performs no update and keeps parameters bit-identical", async () => {
  const work = await workDir("v10");
  const checkpointPath = join(work, "checkpoint.json");
  const initialProfile = deterministicProfile();
  const complete = await runBackendFit({
    ...baseInput(), initialProfile, epochs: 3, checkpointPath, checkpointEverySteps: 1,
  });

  const events = [];
  const again = await runBackendFit({
    ...baseInput(), initialProfile, epochs: 3, resume: true, checkpointPath,
    onProgress: event => events.push(event),
  });

  assert.equal(steps(events).length, 0);
  assert.equal(again.report.epochsCompleted, 3);
  for (const head of ["R", "D", "E", "A"]) {
    assert.deepEqual(
      again.profile.heads[head].parameters.map(value => Math.fround(value)),
      complete.profile.heads[head].parameters.map(value => Math.fround(value)),
    );
  }
  const stored = await readL2Checkpoint(checkpointPath);
  assert.equal(stored.completedUpdates, 3);
  await rm(work, { recursive: true, force: true });
});

// V11: a hard kill during training restores the last committed checkpoint only,
// and the rotated `.prev` record stays readable.
test("V11 SIGKILL during training restores the last committed checkpoint and keeps .prev", async () => {
  const work = await workDir("v11");
  const checkpointPath = join(work, "checkpoint.json");
  const initialProfile = deterministicProfile();
  const K = 6;

  const continuous = await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, checkpointEverySteps: 2,
  });

  const childPath = join(work, "child.mjs");
  await writeFile(
    childPath,
    `import { runBackendFit } from ${JSON.stringify(BACKEND_MODULE)};
const input = JSON.parse(process.env.L2_CHILD_INPUT);
const result = await runBackendFit({
  ...input,
  onProgress: event => {
    if (event.type === "checkpoint") process.stdout.write("CHECKPOINT " + event.completedUpdates + "\\n");
  },
});
process.stdout.write("DONE " + result.report.epochsCompleted + "\\n");
`,
  );
  const child = spawn(process.execPath, [childPath], {
    env: {
      ...process.env,
      L2_CHILD_INPUT: JSON.stringify({
        ...baseInput(),
        initialProfile,
        epochs: K,
        checkpointPath,
        checkpointEverySteps: 2,
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let killedAt = null;
  await new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (killedAt === null && /CHECKPOINT 2/.test(stdout)) {
        killedAt = 2;
        child.kill("SIGKILL");
      }
    });
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(killedAt, 2, `child never reached the step-2 checkpoint: ${stdout.slice(-300)}`);
  assert.ok(!/DONE/.test(stdout), "child should have been killed mid run");

  const afterKill = await readL2Checkpoint(checkpointPath);
  assert.ok(Number.isInteger(afterKill.completedUpdates));
  assert.equal(afterKill.completedUpdates % 2, 0);
  assert.ok(afterKill.completedUpdates >= 2 && afterKill.completedUpdates < K);

  const previousPath = `${checkpointPath}.prev`;
  assert.ok(existsSync(previousPath), "rotated .prev checkpoint must exist");
  const previous = await readL2Checkpoint(previousPath);
  assert.ok(Number.isInteger(previous.completedUpdates));
  assert.ok(previous.completedUpdates <= afterKill.completedUpdates);

  const events = [];
  const resumed = await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, resume: true, checkpointPath,
    onProgress: event => events.push(event),
  });
  const resumedSteps = steps(events).map(event => event.completedUpdates);
  assert.deepEqual(
    resumedSteps,
    Array.from({ length: K - afterKill.completedUpdates }, (_, index) => afterKill.completedUpdates + index + 1),
  );
  assert.equal(resumed.report.epochsCompleted, K);
  for (const head of ["R", "D", "E", "A"]) {
    const delta = maxAbsDiff(
      resumed.profile.heads[head].parameters,
      continuous.profile.heads[head].parameters,
    );
    assert.ok(delta.max <= 1e-6, `head ${head} recovered drift ${delta.max}`);
  }
  await rm(work, { recursive: true, force: true });
});

// V12: every incompatible checkpoint is refused with an explicit resume error.
test("V12 damaged and incompatible checkpoints are refused explicitly", async () => {
  const work = await workDir("v12");
  const initialProfile = deterministicProfile();
  const checkpointPath = join(work, "checkpoint.json");
  await runBackendFit({
    ...baseInput(), initialProfile, epochs: 2, checkpointPath, checkpointEverySteps: 1,
  });
  const good = JSON.parse(await readFile(checkpointPath, "utf8"));

  const frozenPath = join(work, "frozen.json");
  const frozenEvents = [];
  await runBackendFit({
    ...baseInput(), rows: rowsFor(["A"]), initialProfile, epochs: 2, trainHeads: ["A"],
    checkpointPath: frozenPath, checkpointEverySteps: 1,
    onProgress: event => frozenEvents.push(event),
  });
  const frozen = JSON.parse(await readFile(frozenPath, "utf8"));
  assert.ok(frozenEvents.length > 0);

  const variants = {
    truncated: `{"schema":"nnanything.l2.mlp.checkpoint.v1","parameters":`,
    changedTrainedHeads: { ...good, trainedHeads: ["A"] },
    changedLearningRate: { ...good, learningRate: 0.5 },
    changedBudget: { ...good, totalBudget: 5 },
    changedLabels: {
      ...good,
      structure: {
        ...good.structure,
        R: { ...good.structure.R, labels: ["diff", "same", "later"] },
      },
    },
    changedDataRef: {
      ...good,
      dataRef: {
        ...good.dataRef,
        rawRowCountByHead: { ...good.dataRef.rawRowCountByHead, R: 99 },
      },
    },
  };

  for (const [name, payload] of Object.entries(variants)) {
    const path = join(work, `${name}.json`);
    await writeFile(path, typeof payload === "string" ? payload : `${JSON.stringify(payload, null, 2)}\n`);
    await assert.rejects(
      runBackendFit({ ...baseInput(), initialProfile, epochs: 2, resume: true, checkpointPath: path }),
      /resume:/,
      `${name} must be refused as a resume error`,
    );
  }

  // A tampered frozen head is refused even when everything else matches.
  const tamperedPath = join(work, "tampered-frozen.json");
  const tampered = {
    ...frozen,
    parameters: { ...frozen.parameters, R: [...frozen.parameters.R] },
  };
  tampered.parameters.R[3] = tampered.parameters.R[3] + 0.25;
  await writeFile(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  await assert.rejects(
    runBackendFit({
      ...baseInput(), rows: rowsFor(["A"]), initialProfile, epochs: 2, trainHeads: ["A"],
      resume: true, checkpointPath: tamperedPath,
    }),
    /resume:/,
    "a modified frozen head must be refused",
  );

  // The untouched frozen checkpoint still resumes, so the guard is not blanket.
  const resumed = await runBackendFit({
    ...baseInput(), rows: rowsFor(["A"]), initialProfile, epochs: 2, trainHeads: ["A"],
    resume: true, checkpointPath: frozenPath,
  });
  assert.equal(resumed.report.epochsCompleted, 2);
  await rm(work, { recursive: true, force: true });
});

// V13: the event stream is the observation source: every update emits one step
// event, phases are explicit, and the stream arrives before the fit resolves.
test("V13 every update emits one step event and phases arrive before the fit resolves", async () => {
  const work = await workDir("v13");
  const initialProfile = deterministicProfile();
  const checkpointPath = join(work, "checkpoint.json");
  const eventLogPath = join(work, "events.ndjson");
  const events = [];
  let resolved = false;
  // The external raw stream must be readable while the fit is still pending.
  const inFlight = [];
  const sampler = setInterval(() => {
    if (resolved) return;
    try {
      const text = readFileSync(eventLogPath, "utf8");
      const lines = text.split("\n").filter(line => line.trim().length > 0);
      inFlight.push({ bytes: Buffer.byteLength(text), lines: lines.length });
    } catch {
      // the file does not exist yet; a later sample will see it
    }
  }, 5);
  const result = await runBackendFit({
    ...baseInput(), initialProfile, epochs: 4,
    checkpointPath, checkpointEverySteps: 2, eventLogPath,
    onProgress: event => {
      assert.equal(resolved, false, "no event may arrive after the fit resolves");
      events.push(event);
    },
  });
  resolved = true;
  clearInterval(sampler);

  // init phases: initialize, data_prepare, device_load (with a real device), first_compute.
  assert.equal(events[0].type, "phase");
  assert.equal(events[0].phase, "initialize");
  assert.equal(events[0].stageStatus, "start");
  for (const phase of ["initialize", "data_prepare", "device_load", "first_compute"]) {
    const seen = phases(events, phase);
    assert.ok(seen.length >= 2, `phase ${phase} must report start and end`);
    assert.equal(seen[0].stageStatus, "start");
    assert.equal(seen.at(-1).stageStatus, "end");
  }
  const deviceLoadEnd = phases(events, "device_load").at(-1);
  assert.equal(deviceLoadEnd.device, process.env.NN_L2_BACKEND_DEVICE === "gpu" ? "mps" : "cpu");

  // Exactly one step event per optimizer update, in order, before resolution.
  const stepEvents = steps(events);
  assert.deepEqual(stepEvents.map(event => event.completedUpdates), [1, 2, 3, 4]);
  for (const event of stepEvents) {
    assert.equal(event.lossWindow, "pre_update");
    assert.deepEqual(Object.keys(event.recentLossByHead).sort(), ["A", "D", "E", "R"]);
    assert.equal(event.runId, result.runId);
    assert.ok(Number.isFinite(event.stepMs));
    assert.ok(Number.isFinite(event.elapsedMs));
  }
  assert.ok(stepEvents.at(-1).etaMs !== undefined);

  // Data provenance and save cadence travel with every step so a consumer can
  // relate each update to its material and persistence schedule.
  for (const event of stepEvents) {
    assert.ok(event.dataSource !== undefined, "every step must carry its data source");
    assert.equal(event.dataSource.partition, "train");
    assert.equal(event.persistInterval, 2);
  }

  // The external stream holds the same raw events, one NDJSON line each, and it
  // was growing before the fit resolved.
  const logged = readFileSync(eventLogPath, "utf8").split("\n").filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  // Boundary lines are file-level records, not training events.
  assert.equal(logged.filter(event => event.type === "log_boundary").length, 1);
  assert.equal(logged[0].type, "log_boundary");
  assert.equal(logged[0].boundary, "run_start");
  const trainingEvents = logged.filter(event => event.type !== "log_boundary");
  assert.equal(trainingEvents.filter(event => event.type === "step").length, 4);
  assert.deepEqual(logged.filter(event => event.type === "step").map(event => event.completedUpdates), [1, 2, 3, 4]);
  assert.ok(trainingEvents.every(event => typeof event.runId === "string"));
  const grewInFlight = inFlight.length >= 2 && inFlight.at(-1).bytes > inFlight[0].bytes;
  assert.ok(grewInFlight, "the event log must grow while the fit is still running");

  // Checkpoint records carry the committed step and the rotated previous path.
  // Step 0 is persisted before the first update so an interrupted run is always
  // restartable from a committed record.
  const checkpointEvents = events.filter(event => event.type === "checkpoint");
  assert.deepEqual(checkpointEvents.map(event => event.completedUpdates), [0, 2, 4, 4]);
  assert.equal(checkpointEvents[2].lastPersistedStep, 4);

  assert.equal(phases(events, "evaluate").at(-1).stageStatus, "end");
  assert.equal(phases(events, "complete").at(-1).state, "completed");
  assert.ok(events.some(event => event.type === "phase" && event.phase === "save_checkpoint"));
  await rm(work, { recursive: true, force: true });
});

// V13b: resuming onto the SAME event-log path must keep the earlier raw evidence
// instead of truncating it, and the resumed steps must continue from the
// persisted step in that one file.
test("V13b a same-path resume keeps earlier raw events and continues the step sequence", async () => {
  const work = await workDir("v13b");
  const initialProfile = deterministicProfile();
  const checkpointPath = join(work, "checkpoint.json");
  const eventLogPath = join(work, "events.ndjson");
  const K = 6;
  const J = 2;

  await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, updatesThisRun: J,
    checkpointPath, checkpointEverySteps: 1, eventLogPath,
  });
  const firstPass = readFileSync(eventLogPath, "utf8").split("\n").filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  const firstSteps = firstPass.filter(event => event.type === "step").map(event => event.completedUpdates);
  assert.deepEqual(firstSteps, [1, 2], "the interrupted run wrote steps 1..2");
  const firstBytes = Buffer.byteLength(readFileSync(eventLogPath, "utf8"));

  // Resume onto the same path. The earlier events must survive.
  await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, resume: true, checkpointPath, eventLogPath,
  });
  const secondPass = readFileSync(eventLogPath, "utf8").split("\n").filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  assert.ok(
    Buffer.byteLength(readFileSync(eventLogPath, "utf8")) > firstBytes,
    "the resumed run must append, not truncate",
  );

  // The original run's events are still there, in their original order.
  const allSteps = secondPass.filter(event => event.type === "step").map(event => event.completedUpdates);
  assert.deepEqual(allSteps, [1, 2, 3, 4, 5, 6], "the file holds the full sequence across the resume");
  const firstRunId = secondPass.filter(event => event.type === "step")[0].runId;
  const resumedRunId = secondPass.filter(event => event.type === "step").at(-1).runId;
  assert.notEqual(firstRunId, resumedRunId, "the resumed run is its own run, not a rewrite");

  // A resume boundary names where the resumed run starts.
  const boundaries = secondPass.filter(event => event.type === "log_boundary").map(event => event.boundary);
  assert.deepEqual(boundaries, ["run_start", "resume"], "both boundaries are recorded");

  // A fresh run must not silently erase a populated log.
  await assert.rejects(
    () => runBackendFit({
      ...baseInput(), initialProfile, epochs: 2, checkpointPath: join(work, "other.json"),
      checkpointEverySteps: 1, eventLogPath,
    }),
    error => error.kind === "save" && /already holds events/.test(error.message),
    "a non-resume run onto a populated log must be refused explicitly",
  );
  const afterRefusal = readFileSync(eventLogPath, "utf8").split("\n").filter(line => line.trim().length > 0);
  assert.equal(afterRefusal.length, secondPass.length, "the refused run left the log untouched");
  await rm(work, { recursive: true, force: true });
});

// V13c: if the raw event log cannot be written while training runs, the fit must
// fail explicitly with kind save and THIS fixture's bridge child must exit. The
// test records its own child PID through a private wrapper, so it never inspects
// other training processes on the machine.
test("V13c an event log write failure fails the fit explicitly and reaps its own child", async () => {
  const work = await workDir("v13c");
  const initialProfile = deterministicProfile();
  const eventLogPath = join(work, "events.ndjson");
  const pidFile = join(work, "bridge.pid");
  const wrapperPath = join(work, "record-pid-python.sh");
  // A test-private wrapper that records its own PID and then execs the real
  // interpreter, so the recorded PID is the bridge process itself.
  await writeFile(
    wrapperPath,
    `#!/bin/sh\necho $$ > "${pidFile}"\nexec "${PYTHON}" "$@"\n`,
    { mode: 0o755 },
  );

  // Make the log unwritable inside the first step callback. The next event then
  // hits a real append failure, which removes the timing race entirely.
  let locked = false;
  const pending = runBackendFit({
    ...baseInput(), initialProfile, epochs: 12, pythonBin: wrapperPath,
    checkpointPath: join(work, "checkpoint.json"), checkpointEverySteps: 0, eventLogPath,
    onProgress: event => {
      if (event.type === "step" && !locked) {
        chmodSync(eventLogPath, 0o444);
        locked = true;
      }
    },
  }).then(result => ({ result }), error => ({ error }));

  const outcome = await pending;
  const caught = outcome.error ?? null;
  assert.ok(locked, "the first step callback must have run");
  assert.ok(caught !== null, "an unwritable event log must fail the fit");
  assert.equal(caught.kind, "save", `expected kind save, got ${caught.kind}: ${caught.message}`);
  assert.match(caught.message, /event log write failed|progress consumer failed/);

  // The evidence written before the failure is still readable.
  const survived = readFileSync(eventLogPath, "utf8").split("\n").filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  assert.ok(survived.some(event => event.type === "step"), "events written before the failure stay readable");

  // Only this fixture's own child is checked, by exact PID from the wrapper.
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `wrapper must record a real pid, got ${pid}`);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const reapDeadline = Date.now() + 5000;
  while (alive() && Date.now() < reapDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(alive(), false, `the fixture bridge child ${pid} must exit after the failure`);
  await rm(work, { recursive: true, force: true });
});

// V15b: the accelerated backend is opt-in. A caller that names no backend keeps
// the handwired reference loop, and checkpoint/resume is refused rather than
// silently routing the caller onto an experimental backend.
test("V15b no backend means the reference loop and never an implicit switch", assetGated, async () => {
  const work = await workDir("v15b");
  const { computeBackend, pythonBin, bridgePath, ...defaultInput } = baseInput();

  // Default path: the reference loop, so the report carries no backend/device.
  const plain = await fitL2Mlp({ ...defaultInput, epochs: 3 });
  assert.equal(plain.report.backend, undefined, "the default fit must not name a backend");
  assert.equal(plain.report.device, undefined, "the default fit must not report an accelerated device");
  assert.equal(plain.report.epochsCompleted, 3);

  // Checkpoint/resume without an explicit backend is refused, not routed.
  await assert.rejects(
    () => fitL2Mlp({ ...defaultInput, epochs: 3, checkpointPath: join(work, "c.json") }),
    error => error.kind === "resume" && /explicit computeBackend/.test(error.message),
    "checkpointPath alone must not select an experimental backend",
  );
  await assert.rejects(
    () => fitL2Mlp({ ...defaultInput, epochs: 3, resume: true, checkpointPath: join(work, "c.json") }),
    error => error.kind === "resume" && /explicit computeBackend/.test(error.message),
  );

  // The accelerated entry itself has no default: calling it with no backend must
  // refuse rather than pick one. This pins the guard independently of how
  // `fitL2Mlp` routes, which is what the earlier V15b did not do.
  await assert.rejects(
    () => runBackendFit({ ...defaultInput, epochs: 3 }),
    /computeBackend .* is not an explicit backend/,
  );
  await assert.rejects(
    () => runBackendFit({ ...defaultInput, epochs: 3, computeBackend: undefined }),
    /computeBackend .* is not an explicit backend/,
  );
  await rm(work, { recursive: true, force: true });
});

// V14: numeric, save and device failures are typed and never silent.
test("V14 numeric, save and device failures are reported with their own kind", async () => {
  const work = await workDir("v14");
  const initialProfile = deterministicProfile();

  // A divergent learning rate must surface as a numeric failure, and the last
  // complete boundary committed before it must be saved rather than discarded.
  const numericPath = join(work, "numeric.json");
  const numericEvents = [];
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile, epochs: 3, learningRate: 1e30,
      checkpointPath: numericPath, checkpointEverySteps: 1,
      onProgress: event => numericEvents.push(event),
    }),
    /numeric:/,
  );
  const numericErrors = numericEvents.filter(event => event.type === "error");
  assert.equal(numericErrors.length, 1);
  assert.equal(numericErrors[0].error.kind, "numeric");
  const survived = await readL2Checkpoint(numericPath);
  assert.ok(
    Number.isInteger(survived.completedUpdates) && survived.completedUpdates >= 1,
    `the last complete boundary must survive a numeric failure, got ${survived.completedUpdates}`,
  );

  // A checkpoint path that cannot be written must surface as a save failure.
  const directoryPath = join(work, "as-directory");
  await writeFile(join(work, "placeholder"), "");
  await import("node:fs/promises").then(fs => fs.mkdir(directoryPath));
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile, epochs: 2, checkpointPath: directoryPath,
    }),
    /(save|resume):/,
  );

  // An unusable device is a device failure, not a silent CPU fallback.
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile, epochs: 2, pythonBin: "/nonexistent/python3.13",
    }),
    /device:/,
  );
  await rm(work, { recursive: true, force: true });
});

// V11b: a controlled cancel commits the last complete update boundary, reports
// `paused_or_cancelled`, and leaves a checkpoint a later run can resume.
test("V11b cancellation commits a complete boundary and stays resumable", async () => {
  const work = await workDir("v11b");
  const checkpointPath = join(work, "checkpoint.json");
  const initialProfile = deterministicProfile();
  const K = 60;
  const controller = new AbortController();
  const events = [];
  const result = await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, checkpointPath, checkpointEverySteps: 1,
    signal: controller.signal,
    onProgress: event => {
      events.push(event);
      if (event.type === "step" && event.completedUpdates === 3) controller.abort();
    },
  });

  // The signal is honoured at a step boundary, never mid update, and the run is
  // reported as cancelled instead of failed.
  const cancelled = events.filter(event => event.type === "phase" && event.phase === "cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].state, "paused_or_cancelled");
  assert.ok(result.report.epochsCompleted >= 3 && result.report.epochsCompleted < K);
  assert.equal(result.lastPersistedStep, result.report.epochsCompleted);

  const stored = await readL2Checkpoint(checkpointPath);
  assert.equal(stored.completedUpdates, result.report.epochsCompleted);
  assert.equal(stored.trajectory.length, stored.completedUpdates);

  // A later run continues only the remaining budget from that boundary.
  const resumeEvents = [];
  const resumed = await runBackendFit({
    ...baseInput(), initialProfile, epochs: K, resume: true, checkpointPath,
    onProgress: event => resumeEvents.push(event),
  });
  const resumedSteps = steps(resumeEvents).map(event => event.completedUpdates);
  assert.equal(resumedSteps[0], stored.completedUpdates + 1);
  assert.equal(resumed.report.epochsCompleted, K);
  await rm(work, { recursive: true, force: true });
});

// V15: the public entry survives a process boundary: fit, exit, resume in a new
// process, save the profile, then reload it in a third process and infer.
test("V15 public entry saves, resumes across processes and reloads for inference", assetGated, async () => {
  const work = await workDir("v15");
  const checkpointPath = join(work, "checkpoint.json");
  const profilePath = join(work, "profile.json");
  const K = 4;

  const childPath = join(work, "step.mjs");
  await writeFile(
    childPath,
    `import { fitL2Mlp, saveL2Profile } from ${JSON.stringify(MLP_MODULE)};
const input = JSON.parse(process.env.L2_CHILD_INPUT);
const events = [];
const result = await fitL2Mlp({ ...input, onProgress: event => events.push(event.type + ":" + event.phase) });
if (process.env.L2_SAVE_PROFILE === "1") await saveL2Profile(process.env.L2_PROFILE_PATH, result.profile);
process.stdout.write(JSON.stringify({
  epochsCompleted: result.report.epochsCompleted,
  device: result.report.device,
  backend: result.report.backend,
  resumedFromStep: result.report.resumedFromStep,
  lastPersistedStep: result.report.lastPersistedStep,
  events,
}) + "\\n");
`,
  );
  const runChild = async (env) => {
    const child = spawn(process.execPath, [childPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, `child failed: ${stderr}`);
    return JSON.parse(stdout.trim().split("\n").at(-1));
  };

  const common = {
    handwiredRoot: HANDWIRED_ROOT,
    specs,
    rows: trainingRows(),
    seed: 20261025,
    learningRate: 0.1,
    stopCheckpoints: [],
    computeBackend: process.env.NN_L2_BACKEND_DEVICE === "gpu" ? "gpu" : "batch-cpu",
    pythonBin: PYTHON,
    ...BRIDGE_OPTION,
    // Warm start from a saved initial profile, exactly like the real A/E runs.
    initialProfile: deterministicProfile(),
  };

  // Process 1: two steps, checkpoint committed, then the process exits.
  const first = await runChild({
    L2_CHILD_INPUT: JSON.stringify({
      ...common, epochs: K, updatesThisRun: 2, checkpointPath, checkpointEverySteps: 1,
    }),
  });
  assert.equal(first.epochsCompleted, 2);
  assert.equal(first.lastPersistedStep, 2);

  // Process 2: a brand-new process resumes the remaining budget and saves.
  const second = await runChild({
    L2_CHILD_INPUT: JSON.stringify({ ...common, epochs: K, resume: true, checkpointPath }),
    L2_SAVE_PROFILE: "1",
    L2_PROFILE_PATH: profilePath,
  });
  assert.equal(second.epochsCompleted, K);
  assert.ok(second.events.includes("step:update"));

  // Process 3: reload the saved profile and run real inference.
  const reloadPath = join(work, "reload.mjs");
  await writeFile(
    reloadPath,
    `import { createL2Unit, readL2Profile } from ${JSON.stringify(MLP_MODULE)};
const profile = await readL2Profile(process.env.L2_PROFILE_PATH);
const unit = await createL2Unit(profile, process.env.NN_HANDWIRED_ROOT);
const predictions = ["R", "D", "E", "A"].map(head => {
  const features = { R: [0.4, -0.2], D: [0.7], E: [0.9], A: [0.3, -0.4] }[head];
  const prediction = unit.infer(head, features);
  return { head: prediction.head, label: prediction.label, logits: prediction.logits.length };
});
process.stdout.write(JSON.stringify({ schema: profile.schema, predictions }) + "\\n");
`,
  );
  const child = spawn(process.execPath, [reloadPath], {
    env: { ...process.env, L2_PROFILE_PATH: profilePath, NN_HANDWIRED_ROOT: HANDWIRED_ROOT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let reloadOut = "";
  let reloadErr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { reloadOut += chunk; });
  child.stderr.on("data", chunk => { reloadErr += chunk; });
  const reloadCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(reloadCode, 0, `reload failed: ${reloadErr}`);
  const reloaded = JSON.parse(reloadOut.trim().split("\n").at(-1));
  assert.equal(reloaded.schema, "nnanything.l2.mlp.v1");
  assert.equal(reloaded.predictions.length, 4);
  for (const prediction of reloaded.predictions) {
    assert.ok(typeof prediction.label === "string" && prediction.label.length > 0);
  }

  // The checkpoint on disk is the committed record of the last process.
  const stored = await readL2Checkpoint(checkpointPath);
  assert.equal(stored.completedUpdates, K);
  const leftovers = await readdir(work);
  assert.ok(!leftovers.some(name => name.startsWith(".l2-checkpoint-")), "no temporary checkpoint may remain");
  await rm(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Findings from the independent overall review (Alice confirmed, 2026-10-25).
// Each test below fails on the pre-fix code and passes after the fix.
// ---------------------------------------------------------------------------

// P1-1: a bridge child that exits nonzero without a terminal record must settle
// the public promise. Before the fix the close handler settled first, so the
// no-record failure returned early and left the promise pending forever with
// the watchdog already cleared.
test("P1-1 a bridge child that exits without a terminal record rejects the fit", async () => {
  const work = await workDir("p11");
  const bridgePath = join(work, "silent-bridge.py");
  await writeFile(
    bridgePath,
    `import sys\nsys.stdin.readline()\nsys.stderr.write("bridge exploded before any record\\n")\nsys.exit(3)\n`,
  );
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile: deterministicProfile(), epochs: 4,
      bridgePath, timeoutMs: 20_000,
    }),
    error => {
      assert.ok(error !== null, "the fit must reject");
      assert.equal(error.kind, "protocol", `expected protocol, got ${error.kind}: ${error.message}`);
      assert.match(error.message, /exited 3/);
      assert.match(error.message, /bridge exploded/, "the child stderr must be retained");
      return true;
    },
  );
  await rm(work, { recursive: true, force: true });
});

// P1-1b: a terminal record that arrives without a trailing newline must still be
// honoured. The same nested settlement swallowed it before the fix.
test("P1-1b a buffered terminal record without a newline still resolves", async () => {
  const work = await workDir("p11b");
  const bridgePath = join(work, "no-newline-bridge.py");
  await writeFile(
    bridgePath,
    `import json, sys\nrequest = json.loads(sys.stdin.readline())\n`
      + `payload = {"type": "final", "ok": True, "runId": request.get("runId"),\n`
      + `  "finalWeights": {}, "completedUpdates": request.get("epochs"), "totalUpdates": request.get("epochs"),\n`
      + `  "trajectory": [], "lastPersistedStep": None, "device": "cpu", "timings": {}}\n`
      + `sys.stdout.write(json.dumps(payload))\nsys.stdout.flush()\n`,
  );
  // The bridge returns no parameters, so the failure must name the missing head
  // rather than hang: the terminal record was consumed and the promise settled.
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile: deterministicProfile(), epochs: 2,
      bridgePath, timeoutMs: 20_000,
    }),
    /returned no parameters for head/,
  );
  await rm(work, { recursive: true, force: true });
});

// P1-2: malformed JSON from the bridge must release the owned child. Before the
// fix this branch rejected and cleared the watchdog but never terminated the
// process, unlike the timeout and progress-consumer failures.
test("P1-2 a malformed bridge record rejects and reaps its own child", async () => {
  const work = await workDir("p12");
  const bridgePath = join(work, "garbage-bridge.py");
  const pidFile = join(work, "bridge.pid");
  await writeFile(
    bridgePath,
    `import os, sys, time\nopen(${JSON.stringify(pidFile)}, "w").write(str(os.getpid()))\n`
      + `sys.stdin.readline()\nsys.stdout.write("this is not json\\n")\nsys.stdout.flush()\n`
      + `time.sleep(60)\n`,
  );
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile: deterministicProfile(), epochs: 4,
      bridgePath, timeoutMs: 20_000,
    }),
    error => {
      assert.equal(error.kind, "protocol", `expected protocol, got ${error.kind}`);
      assert.match(error.message, /invalid JSON/);
      return true;
    },
  );
  // Only this fixture's own child is checked, by exact PID it wrote itself.
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 8000;
  while (alive() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(alive(), false, `the fixture bridge child ${pid} must be reaped`);
  await rm(work, { recursive: true, force: true });
});

// P1-3: resume must refuse changed training material, not accept it because the
// row and group counts are unchanged. Only ordered material fields travel; no
// hash or checksum is introduced.
test("P1-3 resume refuses changed training material with unchanged counts", async () => {
  const work = await workDir("p13");
  const checkpointPath = join(work, "checkpoint.json");
  const initialProfile = deterministicProfile();

  const first = await runBackendFit({
    ...baseInput(), initialProfile, epochs: 6, stopCheckpoints: [], updatesThisRun: 4,
    checkpointPath, checkpointEverySteps: 0,
  });
  assert.equal(first.report.epochsCompleted, 4);

  // Same counts and same labels, different supervision: the R feature values are
  // swapped so every count stays identical while the material does not.
  const swapped = trainingRows().map(row =>
    row.head === "R" ? { ...row, features: [row.features[1], row.features[0]] } : row,
  );
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile, epochs: 6, resume: true, updatesThisRun: 2,
      checkpointPath, rows: swapped,
    }),
    /resume:.*(material|data)/i,
  );
  await rm(work, { recursive: true, force: true });
});

// P1-4: the accelerated path must keep the warm-start spec check the reference
// path already performs. A profile whose labels are reordered with the same
// length must be refused instead of being silently reinterpreted.
test("P1-4 the accelerated path rejects a warm-start profile with reordered labels", async () => {
  const profile = deterministicProfile();
  profile.heads.R.spec = { ...specs.R, labels: [...specs.R.labels].reverse() };
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile: profile, epochs: 2,
    }),
    /spec/i,
  );
});

// P1-4b: reordered features must be refused too.
test("P1-4b the accelerated path rejects a warm-start profile with reordered features", async () => {
  const profile = deterministicProfile();
  profile.heads.R.spec = { ...specs.R, features: [...specs.R.features].reverse() };
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile: profile, epochs: 2,
    }),
    /spec/i,
  );
});

// P1-5: a catchable numeric failure must still persist the last complete valid
// boundary. Before the fix the global fail() wrote the error and exited with no
// access to persist(), so updates committed after the last periodic save were
// discarded even though the boundary was valid.
test("P1-5 a catchable numeric failure saves the last complete valid boundary", async () => {
  const work = await workDir("p15");
  const checkpointPath = join(work, "checkpoint.json");
  const events = [];
  await assert.rejects(
    runBackendFit({
      // The learning rate is large enough that the second update is non-finite
      // while the first update committed cleanly, so there is a valid boundary
      // between them that a plain failure would discard.
      ...baseInput(), initialProfile: deterministicProfile(), epochs: 8, learningRate: 500,
      checkpointPath, checkpointEverySteps: 0,
      onProgress: event => events.push(event),
    }),
    /numeric:/,
  );
  // The step-0 checkpoint plus every boundary committed after it must survive,
  // so the persisted step count must be at least one committed update.
  const stored = await readL2Checkpoint(checkpointPath);
  assert.ok(
    Number.isInteger(stored.completedUpdates) && stored.completedUpdates >= 1,
    `the last complete boundary must be persisted, got ${stored.completedUpdates}`,
  );
  const saveEvents = events.filter(event => event.type === "phase" && event.phase === "save_checkpoint");
  assert.ok(saveEvents.length >= 2, "a final save attempt must be observable");
  // The boundary save succeeded, so no save failure may be attached to the
  // reported numeric failure. This pins the persist() return-value contract:
  // success is not None, but it is not a failure either.
  const errorEvents = events.filter(event => event.type === "error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].error.boundarySaveError, undefined, "a successful boundary save must not be reported as a save failure");
  await rm(work, { recursive: true, force: true });
});

// P1-5b: when the boundary save itself fails while reporting a training failure,
// the original failure stays the reported failure and the save failure is
// reported separately on the same error.
test("P1-5b a failed boundary save is reported separately, never replacing the training failure", async () => {
  const work = await workDir("p15b");
  const checkpointPath = join(work, "checkpoint.json");
  // A directory occupying the .prev rotation target makes the boundary save's
  // rotate step fail after the checkpoint itself was written.
  await mkdir(join(work, "checkpoint.json.prev"), { recursive: true });
  const events = [];
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile: deterministicProfile(), epochs: 8, learningRate: 500,
      checkpointPath, checkpointEverySteps: 0,
      onProgress: event => events.push(event),
    }),
    /numeric:/,
  );
  const errorEvents = events.filter(event => event.type === "error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].error.kind, "numeric", "the original failure must be reported");
  assert.ok(
    typeof errorEvents[0].error.boundarySaveError === "string"
      && /checkpoint save failed/.test(errorEvents[0].error.boundarySaveError),
    "the save failure must be carried separately",
  );
  await rm(work, { recursive: true, force: true });
});

// P1-6: the per-step duration must cover the real training computation. Before
// the fix the timer started after the gradient was already computed and closed
// before the next evaluation, so the reported value excluded forward and
// backward work entirely.
test("P1-6 the per-step duration covers the training computation, not only the update", async () => {
  const events = [];
  const result = await runBackendFit({
    ...baseInput(), initialProfile: deterministicProfile(), epochs: 12,
    checkpointEverySteps: 0,
    onProgress: event => events.push(event),
  });
  const stepEvents = steps(events);
  assert.equal(stepEvents.length, 12);
  const totalStepMs = stepEvents.reduce((sum, event) => sum + event.stepMs, 0);
  assert.ok(totalStepMs > 0, "step events must carry a duration");
  const warmMs = result.timings.warmTrainingMs;
  assert.ok(
    totalStepMs >= warmMs * 0.95,
    `per-step durations ${totalStepMs.toFixed(2)} ms must cover the measured training work ${warmMs} ms`,
  );
  assert.equal(
    result.report.epochsCompleted,
    12,
    "the run must still complete its budget",
  );
});

// ---------------------------------------------------------------------------
// Second recheck findings (Alice confirmed, 2026-10-25). The first fix settled
// the terminal record correctly but left the close handler and the bridge error
// exits open. Each test below fails on the code before its fix.
// ---------------------------------------------------------------------------

// R1: once a terminal record settled the request, the child close must not add a
// second `failed` event. Before the fix the close handler ran its no-record
// branch unconditionally, and failWith emitted through onProgress before the
// settle guard, so a successful run was followed by a bogus failure event in
// both the callback and the raw event log.
test("R1 a normal final record is not followed by a bogus failure event on close", async () => {
  const work = await workDir("r1");
  const eventLogPath = join(work, "events.ndjson");
  const events = [];
  await runBackendFit({
    ...baseInput(), initialProfile: deterministicProfile(), epochs: 3,
    eventLogPath, onProgress: event => events.push(event),
  });
  // Wait for the child to close and for any trailing handler work to land. The
  // process exit is what used to append the spurious failure.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(
    events.filter(event => event.type === "error").length,
    0,
    "a completed fit must not report a failure event",
  );
  const logged = readFileSync(eventLogPath, "utf8").split("\n").filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line));
  assert.equal(
    logged.filter(event => event.type === "error").length,
    0,
    "the raw event log must not record a failure after the final record",
  );
  await rm(work, { recursive: true, force: true });
});

// R1b: the same holds for a run that ends on a real error record. The error is
// reported once; the later close must not append a second one.
test("R1b a real error record is reported once, not again on close", async () => {
  const work = await workDir("r1b");
  const bridgePath = join(work, "error-bridge.py");
  await writeFile(
    bridgePath,
    `import json, sys\nrequest = json.loads(sys.stdin.readline())\n`
      + `error = {"kind": "numeric", "message": "fixture refused the update", "phase": "update"}\n`
      + `sys.stdout.write(json.dumps({"type": "error", "error": error}) + "\\n")\nsys.stdout.flush()\n`
      + `sys.exit(0)\n`,
  );
  const events = [];
  await assert.rejects(
    runBackendFit({
      ...baseInput(), initialProfile: deterministicProfile(), epochs: 3,
      bridgePath, timeoutMs: 20_000, onProgress: event => events.push(event),
    }),
    /numeric: fixture refused the update/,
  );
  await new Promise(resolve => setTimeout(resolve, 1500));
  const errorEvents = events.filter(event => event.type === "error");
  assert.equal(errorEvents.length, 1, "the real error must be reported exactly once");
  assert.equal(errorEvents[0].error.message, "fixture refused the update");
  await rm(work, { recursive: true, force: true });
});

// R2: a training failure raised after at least one unsaved committed update must
// still save that boundary. Before the fix only the candidate-parameter check
// used fail_training; the failures raised inside evaluate() went through the
// global fail(), which exits without access to persist().
test("R2 a training failure inside evaluate saves the last complete boundary", async () => {
  const work = await workDir("r2");
  const checkpointPath = join(work, "checkpoint.json");
  const events = [];
  await assert.rejects(
    runBackendFit({
      // This learning rate commits several clean updates and then overflows inside
      // the next evaluation, so a valid boundary exists that the global fail()
      // discarded.
      ...baseInput(), initialProfile: deterministicProfile(), epochs: 12, learningRate: 300,
      checkpointPath, checkpointEverySteps: 0,
      onProgress: event => events.push(event),
    }),
    /numeric:.*(empty allowed set|non-finite)/,
  );
  const stored = await readL2Checkpoint(checkpointPath);
  assert.ok(
    Number.isInteger(stored.completedUpdates) && stored.completedUpdates >= 1,
    `the last complete boundary must survive an evaluate failure, got ${stored.completedUpdates}`,
  );
  const errorEvents = events.filter(event => event.type === "error");
  assert.equal(errorEvents.length, 1);
  assert.equal(errorEvents[0].error.kind, "numeric", "the training failure stays the reported failure");
  await rm(work, { recursive: true, force: true });
});

// R3: the first step's duration must not include the initial checkpoint write.
// Before the fix the first step interval started before the initial persist, so
// JSON serialization, fsync and the replace were charged to training compute
// while also being counted in checkpointWriteMs. P1-6 turned checkpoints off and
// could not see it.
test("R3 the first step duration excludes the initial checkpoint write", async () => {
  const work = await workDir("r3");
  const checkpointPath = join(work, "checkpoint.json");
  const events = [];
  const result = await runBackendFit({
    ...baseInput(), initialProfile: deterministicProfile(), epochs: 6,
    checkpointPath, checkpointEverySteps: 0,
    onProgress: event => events.push(event),
  });
  const stepEvents = steps(events);
  assert.equal(stepEvents.length, 6);
  const firstStepMs = stepEvents[0].stepMs;
  const writeMs = result.timings.checkpointWriteMs;
  const firstForwardMs = result.timings.firstComputeMs;
  assert.ok(writeMs > 0, "the initial checkpoint write must be recorded");
  assert.ok(firstForwardMs > 0, "the first forward pass must be measured on its own");
  // The declared contract: the first step is the forward/loss/gradient pass that
  // fed it (reported separately as firstComputeMs) plus the parameter update and
  // the device sync. The initial checkpoint write is charged to checkpointWriteMs
  // and must not be added on top. The residual therefore has to stay within one
  // typical step; including the 8 ms write would push it well past that.
  const laterSteps = stepEvents.slice(1).map(event => event.stepMs);
  const medianLater = [...laterSteps].sort((left, right) => left - right)[Math.floor(laterSteps.length / 2)];
  const residual = firstStepMs - firstForwardMs;
  assert.ok(
    residual <= medianLater,
    `first step ${firstStepMs} ms must add only update/sync time on top of the measured forward ${firstForwardMs} ms (residual ${residual.toFixed(3)} ms, typical step ${medianLater} ms)`,
  );
  assert.ok(
    firstStepMs < firstForwardMs + writeMs,
    `first step ${firstStepMs} ms must not include the ${writeMs} ms initial checkpoint write`,
  );
  await rm(work, { recursive: true, force: true });
});

// R2b: an unhandled internal exception raised after training started must also
// save the last complete boundary, and the original message must stay the
// reported error. The bridge protocol is exercised directly: the TS request
// builder cannot produce an internally inconsistent batch, so this covers the
// bridge's own last-resort handler.
test("R2b an internal bridge failure after training starts saves the boundary", async () => {
  const work = await workDir("r2b");
  const checkpointPath = join(work, "checkpoint.json");
  const request = {
    op: "fit",
    runId: "r2b",
    device: "cpu",
    epochs: 4,
    learningRate: 0.1,
    checkpointPath,
    checkpointEverySteps: 0,
    dataRef: { note: "r2b" },
    recipeRef: { note: "r2b" },
    trainedHeads: ["R"],
    heads: [{
      name: "R",
      structure: { features: ["f0"], labels: ["a", "b"], hidden: [2, 2] },
      parameters: Array.from({ length: 2 * 1 + 2 + 2 * 2 + 2 + 2 * 2 + 2 }, () => 0.1),
      features: [[0.5], [-0.5]],
      allowed: [[0], [1]],
      // Three weights for two rows: this raises inside the first evaluation, an
      // unhandled internal error rather than a checked numeric failure.
      weights: [1.0, 1.0, 1.0],
      rowCount: 2,
    }],
  };
  const bridgePath = join(DIST_ROOT, "training/l2-gpu-bridge.py");
  assert.ok(existsSync(bridgePath), "the bridge asset must be present for this test");
  const child = spawn(PYTHON, [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  const exited = new Promise(resolve => child.on("close", resolve));
  child.stdin.end(`${JSON.stringify(request)}\n`);
  const code = await exited;
  assert.equal(code, 0);
  const records = stdout.split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
  const errors = records.filter(record => record.type === "error");
  assert.equal(errors.length, 1, "one internal failure must be reported once");
  assert.equal(errors[0].error.kind, "internal", `expected internal, got ${errors[0].error.kind}`);
  assert.match(errors[0].error.message, /L2 backend bridge failed:/, "the original failure must be kept");
  const stored = await readL2Checkpoint(checkpointPath);
  assert.equal(stored.completedUpdates, 0, "the initial boundary is saved before the first update");
  await rm(work, { recursive: true, force: true });
});

// R2c: an admission rejection before training writes no checkpoint. The failure
// sink is registered only once training owns committed parameters, so a request
// rejected in data preparation must not create or overwrite a checkpoint.
test("R2c a pre-training admission rejection writes no checkpoint", async () => {
  const work = await workDir("r2c");
  const checkpointPath = join(work, "checkpoint.json");
  const request = {
    op: "fit",
    runId: "r2c",
    device: "cpu",
    epochs: 2,
    learningRate: 0.1,
    checkpointPath,
    checkpointEverySteps: 0,
    trainedHeads: ["R", "Z"],
    heads: [{
      name: "R",
      structure: { features: ["f0"], labels: ["a", "b"], hidden: [2, 2] },
      parameters: Array.from({ length: 2 * 1 + 2 + 2 * 2 + 2 + 2 * 2 + 2 }, () => 0.1),
      features: [[0.5]],
      allowed: [[0]],
      weights: [1.0],
      rowCount: 1,
    }],
  };
  const bridgePath = join(DIST_ROOT, "training/l2-gpu-bridge.py");
  assert.ok(existsSync(bridgePath), "the bridge asset must be present for this test");
  const child = spawn(PYTHON, [bridgePath], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  const exited = new Promise(resolve => child.on("close", resolve));
  child.stdin.end(`${JSON.stringify(request)}\n`);
  await exited;
  const records = stdout.split("\n").filter(line => line.trim().length > 0).map(line => JSON.parse(line));
  const errors = records.filter(record => record.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.kind, "protocol");
  assert.equal(existsSync(checkpointPath), false, "an admission rejection must not write a checkpoint");
  await rm(work, { recursive: true, force: true });
});
