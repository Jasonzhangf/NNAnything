import { performance } from "node:perf_hooks";
import { FEEDBACK_HEADS, FEEDBACK_WIRES, type FeedbackFitInput, type FeedbackFitResult, type FeedbackProfile, type FeedbackTrajectoryEntry } from "../adapters/browser/feedback-contract.js";
import { feedbackFeatures, validateFeedbackProfile } from "../filters/browser-feedback.js";
import { buildBrowserFeedbackCircuit } from "../nodes/trainable/browser-feedback.js";
import { loadHandwired } from "./handwired.js";

export async function fitFeedbackProfile(input: FeedbackFitInput): Promise<FeedbackFitResult> {
  const started = performance.now();
  const initial = validateFeedbackProfile(input.initial);
  const objective = input.objective === undefined ? "distinct_projection_coverage" : input.objective;
  if (objective !== "distinct_projection_coverage" && objective !== "class_balanced_projection_coverage") throw new TypeError("Unsupported feedback objective");
  if (!Number.isInteger(input.epochs) || input.epochs < 0 || !Number.isFinite(input.learningRate) || input.learningRate <= 0) throw new TypeError("Invalid feedback fit budget");
  if (!Array.isArray(input.episodes) || input.episodes.length === 0 || input.episodes.some(row => row.partition !== "train" || !FEEDBACK_HEADS.includes(row.teacher.head))) throw new TypeError("Feedback fitter accepts nonempty train episodes only");
  const rows = input.episodes.map(row => ({ features: feedbackFeatures(row.input), expected: FEEDBACK_HEADS.indexOf(row.teacher.head) }));
  const groups = new Map<string, { count: number; expected: number }>();
  for (const row of rows) {
    const key = JSON.stringify(row.features);
    const group = groups.get(key);
    if (group && group.expected !== row.expected) throw new TypeError("Conflicting feedback labels for one student projection");
    groups.set(key, { count: (group?.count ?? 0) + 1, expected: row.expected });
  }
  const classProjectionCounts = FEEDBACK_HEADS.map((_, head) => [...groups.values()].filter(group => group.expected === head).length);
  const classCount = classProjectionCounts.filter(count => count > 0).length;
  const loadStarted = performance.now();
  const module = await loadHandwired(input.handwiredRoot);
  const backendLoadMs = performance.now() - loadStarted;
  const circuitStarted = performance.now();
  const circuit = buildBrowserFeedbackCircuit(module);
  const circuitBuildMs = performance.now() - circuitStarted;
  const trajectory: FeedbackTrajectoryEntry[] = [];
  let weights = initial.weights.flatMap(row => [...row]);
  const fitStarted = performance.now();
  try {
    for (let epoch = 1; epoch <= input.epochs; epoch += 1) {
      const gradient = new Float64Array(weights.length);
      let loss = 0;
      for (const row of rows) {
        const group = groups.get(JSON.stringify(row.features))!;
        const scale = objective === "class_balanced_projection_coverage"
          ? 1 / (classCount * classProjectionCounts[row.expected]! * group.count)
          : 1 / (groups.size * group.count);
        const source = new Float32Array(circuit.circuit.sourceSize);
        circuit.parameters.forEach((wire, index) => { source[wire] = Math.fround(weights[index]!); });
        circuit.features.forEach((wire, index) => { source[wire] = Math.fround(row.features[index]!); });
        const values = circuit.circuit.evaluateReference(source);
        const logits = circuit.logits.map(wire => values[wire]!);
        const maximum = Math.max(...logits);
        const exps = logits.map(logit => Math.exp(logit - maximum));
        const total = exps.reduce((a, b) => a + b, 0);
        loss += scale * (Math.log(total) + maximum - logits[row.expected]!);
        const outputGradients = new Float32Array(values.length);
        circuit.logits.forEach((wire, index) => { outputGradients[wire] = Math.fround(exps[index]! / total - Number(index === row.expected)); });
        const derivatives = circuit.circuit.backpropagateReference(values, outputGradients);
        circuit.parameters.forEach((wire, index) => { gradient[index] = gradient[index]! + scale * derivatives[wire]!; });
      }
      if (!Number.isFinite(loss) || [...gradient].some(value => !Number.isFinite(value))) throw new Error("Non-finite feedback fit");
      weights = weights.map((weight, index) => Math.fround(weight - input.learningRate * gradient[index]!));
      if (weights.some(weight => !Number.isFinite(weight))) throw new Error("Non-finite feedback parameter");
      trajectory.push({ epoch, loss, gradient: [...gradient], weights: [...weights] });
    }
  } catch (cause) {
    throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { trajectory, epochsCompleted: trajectory.length, rows: rows.length });
  }
  const profile: FeedbackProfile = { ...initial, weights: FEEDBACK_HEADS.map((_, index) => weights.slice(index * FEEDBACK_WIRES.length, (index + 1) * FEEDBACK_WIRES.length)) };
  return { profile: validateFeedbackProfile(profile), trajectory,
    objective: { kind: objective, projectionCount: groups.size, groupSizes: [...groups.values()].map(group => group.count),
      ...(objective === "class_balanced_projection_coverage" ? { classCount, classProjectionCounts } : {}) }, timing: { backendLoadMs, circuitBuildMs,
    fitMs: performance.now() - fitStarted, totalMs: performance.now() - started, epochs: trajectory.length,
    rows: rows.length, gradientRowEpochs: rows.length * trajectory.length, trainableParamCount: weights.length } };
}
