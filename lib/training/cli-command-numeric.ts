import { buildCliCommandCircuit } from "../nodes/trainable/cli-command-policy.js";
import { cliCommandFeatures, expandCliCommandProfile, validateCliCommandProfile, type CliCommandName, type CliCommandHead, type CliCommandProfile } from "../filters/cli-command-policy.js";
import type { StructuredCliGoal } from "../filters/cli-goal-policy.js";
import { loadHandwired } from "./handwired.js";

export type CliCommandFitRow = Readonly<{ goal: StructuredCliGoal; expectedHead: CliCommandHead }>;
export type CliCommandFitTiming = {
  backendLoadMs: number; circuitBuildMs: number; trainEpochGradMs: number; fitTotalMs: number;
  completedEpochs: number; processedRowCount: number; gradientRowEpochs: number; totalRowPasses: number; trainableParamCount: number;
};

export async function fitCliCommandProfile(input: Readonly<{
  initial: CliCommandProfile; commands: readonly CliCommandName[]; rows: readonly CliCommandFitRow[];
  handwiredRoot: string; epochs: number; learningRate: number;
}>) {
  const started = performance.now(), initial = expandCliCommandProfile(input.initial, input.commands);
  if (!Number.isInteger(input.epochs) || input.epochs < 0 || !Number.isFinite(input.learningRate) || input.learningRate <= 0) throw new TypeError("Invalid training budget");
  if (!Array.isArray(input.rows) || input.rows.length === 0) throw new TypeError("Nonempty command training rows required");
  const rows = input.rows.map(row => {
    if (!initial.heads.includes(row.expectedHead)) throw new TypeError("Teacher head is absent from this stage");
    return { features: cliCommandFeatures(row.goal, initial), expected: initial.heads.indexOf(row.expectedHead) };
  });
  const timing: CliCommandFitTiming = { backendLoadMs: 0, circuitBuildMs: 0, trainEpochGradMs: 0, fitTotalMs: 0,
    completedEpochs: 0, processedRowCount: rows.length, gradientRowEpochs: 0, totalRowPasses: 0, trainableParamCount: initial.heads.length * initial.wires.length };
  const trajectory: { epoch: number; loss: number }[] = [];
  let weights = initial.weights.flatMap(row => [...row]);
  try {
    if (input.epochs > 0) {
      const backendStarted = performance.now();
      const module = await loadHandwired(input.handwiredRoot);
      timing.backendLoadMs = performance.now() - backendStarted;
      const buildStarted = performance.now();
      const graph = buildCliCommandCircuit(module, initial.heads.length, initial.wires.length);
      timing.circuitBuildMs = performance.now() - buildStarted;
      for (let epoch = 0; epoch < input.epochs; epoch++) {
        const epochStarted = performance.now(), gradient = new Float64Array(weights.length);
        let totalLoss = 0;
        for (const row of rows) {
          const source = new Float32Array(graph.circuit.sourceSize);
          graph.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]!); });
          graph.features.forEach((wire, index) => { source[wire] = row.features[index]!; });
          const values = graph.circuit.evaluateReference(source);
          const logits = graph.logits.map(wire => values[wire]!);
          const max = Math.max(...logits), exps = logits.map(logit => Math.exp(logit - max)), sum = exps.reduce((a, b) => a + b, 0);
          const loss = Math.log(sum) + max - logits[row.expected]!;
          if (!Number.isFinite(loss)) throw new Error("Non-finite shared command loss");
          totalLoss += loss;
          const outputGradient = new Float32Array(values.length);
          graph.logits.forEach((wire, index) => { outputGradient[wire] = Math.fround(exps[index]! / sum - Number(index === row.expected)); });
          const sourceGradient = graph.circuit.backpropagateReference(values, outputGradient);
          graph.parameters.forEach((wire, index) => { gradient[index] = gradient[index]! + sourceGradient[wire]!; });
          timing.gradientRowEpochs++; timing.totalRowPasses++;
        }
        weights = weights.map((weight, index) => Math.fround(weight - input.learningRate * gradient[index]! / rows.length));
        if (!weights.every(Number.isFinite)) throw new Error("Non-finite shared command weights");
        timing.completedEpochs++; timing.trainEpochGradMs += performance.now() - epochStarted;
        trajectory.push({ epoch: epoch + 1, loss: totalLoss / rows.length });
      }
    }
    const profile = validateCliCommandProfile({ ...initial, weights: initial.heads.map((_, index) => weights.slice(index * initial.wires.length, (index + 1) * initial.wires.length)) });
    return { profile, initialProfile: initial, timing, trajectory };
  } catch (error) {
    if (error && typeof error === "object") Object.assign(error, { timing });
    throw error;
  } finally { timing.fitTotalMs = performance.now() - started; }
}
