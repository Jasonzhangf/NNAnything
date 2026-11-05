export interface UnifiedTensors {
  readonly W1: readonly number[];
  readonly b1: readonly number[];
  readonly W2: readonly number[];
  readonly b2: readonly number[];
  readonly W3: readonly number[];
  readonly b3: readonly number[];
}

export interface MutableUnifiedTensors {
  W1: number[];
  b1: number[];
  W2: number[];
  b2: number[];
  W3: number[];
  b3: number[];
}

export const UNIFIED_INPUT_SIZE = 64;
export const UNIFIED_HIDDEN_SIZE = 64;
export const UNIFIED_OUTPUT_SIZE = 1;

export const UNIFIED_PARAMETER_COUNTS = Object.freeze({
  W1: 4096,
  b1: 64,
  W2: 4096,
  b2: 64,
  W3: 64,
  b3: 1,
  total: 8385,
});

export interface ForwardTrace {
  readonly h1: readonly number[];
  readonly h2: readonly number[];
  readonly z1: readonly number[];
  readonly z2: readonly number[];
  readonly score: number;
}

export interface BackwardResult {
  readonly grads: UnifiedTensors;
  readonly dInput: readonly number[];
}

function assertFiniteVector(name: string, v: readonly number[], expected: number): void {
  if (!Array.isArray(v)) throw new TypeError(`${name} must be an array`);
  if (v.length !== expected) throw new TypeError(`${name} must have ${expected} entries, got ${v.length}`);
  for (let i = 0; i < v.length; i += 1) {
    const value = v[i];
    if (value === undefined || !Number.isFinite(value)) {
      throw new TypeError(`${name}[${i}] must be finite`);
    }
  }
}

export function assertUnifiedTensors(tensors: UnifiedTensors): void {
  assertFiniteVector("W1", tensors.W1, UNIFIED_PARAMETER_COUNTS.W1);
  assertFiniteVector("b1", tensors.b1, UNIFIED_PARAMETER_COUNTS.b1);
  assertFiniteVector("W2", tensors.W2, UNIFIED_PARAMETER_COUNTS.W2);
  assertFiniteVector("b2", tensors.b2, UNIFIED_PARAMETER_COUNTS.b2);
  assertFiniteVector("W3", tensors.W3, UNIFIED_PARAMETER_COUNTS.W3);
  assertFiniteVector("b3", tensors.b3, UNIFIED_PARAMETER_COUNTS.b3);
}

function dot(row: readonly number[], offset: number, x: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < x.length; i += 1) {
    const w = row[offset + i];
    const xv = x[i];
    if (w === undefined || xv === undefined) throw new TypeError("dot shape mismatch");
    total += w * xv;
  }
  return total;
}

export function forwardUnified(
  input: readonly number[],
  tensors: UnifiedTensors,
): ForwardTrace {
  if (input.length !== UNIFIED_INPUT_SIZE) {
    throw new TypeError(`unified input must have ${UNIFIED_INPUT_SIZE} entries, got ${input.length}`);
  }
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === undefined || !Number.isFinite(input[i])) {
      throw new TypeError(`input[${i}] must be finite`);
    }
  }
  assertUnifiedTensors(tensors);

  const z1 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  const h1 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  for (let j = 0; j < UNIFIED_HIDDEN_SIZE; j += 1) {
    const b = tensors.b1[j];
    if (b === undefined) throw new TypeError("b1 shape mismatch");
    const value = dot(tensors.W1, j * UNIFIED_INPUT_SIZE, input) + b;
    z1[j] = value;
    h1[j] = value > 0 ? value : 0;
  }

  const z2 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  const h2 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  for (let j = 0; j < UNIFIED_HIDDEN_SIZE; j += 1) {
    const b = tensors.b2[j];
    if (b === undefined) throw new TypeError("b2 shape mismatch");
    const value = dot(tensors.W2, j * UNIFIED_HIDDEN_SIZE, h1) + b;
    z2[j] = value;
    h2[j] = value > 0 ? value : 0;
  }

  const b3 = tensors.b3[0];
  if (b3 === undefined) throw new TypeError("b3 shape mismatch");
  const score = dot(tensors.W3, 0, h2) + b3;

  return { h1, h2, z1, z2, score };
}

export function forwardUnifiedScore(input: readonly number[], tensors: UnifiedTensors): number {
  return forwardUnified(input, tensors).score;
}

export function backwardUnified(
  input: readonly number[],
  tensors: UnifiedTensors,
  trace: ForwardTrace,
  dScore: number,
): BackwardResult {
  if (!Number.isFinite(dScore)) throw new TypeError("dScore must be finite");

  const dW1 = new Array<number>(UNIFIED_PARAMETER_COUNTS.W1).fill(0);
  const dB1 = new Array<number>(UNIFIED_PARAMETER_COUNTS.b1).fill(0);
  const dW2 = new Array<number>(UNIFIED_PARAMETER_COUNTS.W2).fill(0);
  const dB2 = new Array<number>(UNIFIED_PARAMETER_COUNTS.b2).fill(0);

  const dW3 = new Array<number>(UNIFIED_PARAMETER_COUNTS.W3).fill(0);
  const db3 = [dScore];
  const dh2 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  for (let j = 0; j < UNIFIED_HIDDEN_SIZE; j += 1) {
    const h2j = trace.h2[j];
    const w3j = tensors.W3[j];
    if (h2j === undefined || w3j === undefined) throw new TypeError("W3 shape mismatch");
    dW3[j] = dScore * h2j;
    dh2[j] = dScore * w3j;
  }

  const dz2 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  const dh1 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  for (let j = 0; j < UNIFIED_HIDDEN_SIZE; j += 1) {
    const z = trace.z2[j];
    if (z === undefined) throw new TypeError("z2 shape mismatch");
    const dj = (dh2[j] ?? 0) * (z > 0 ? 1 : 0);
    dz2[j] = dj;
    dB2[j] = (dB2[j] ?? 0) + dj;
    for (let i = 0; i < UNIFIED_HIDDEN_SIZE; i += 1) {
      const h1i = trace.h1[i];
      const w2 = tensors.W2[j * UNIFIED_HIDDEN_SIZE + i];
      if (h1i === undefined || w2 === undefined) throw new TypeError("W2 shape mismatch");
      dW2[j * UNIFIED_HIDDEN_SIZE + i] = (dW2[j * UNIFIED_HIDDEN_SIZE + i] ?? 0) + dj * h1i;
      dh1[i] = (dh1[i] ?? 0) + dj * w2;
    }
  }

  const dz1 = new Array<number>(UNIFIED_HIDDEN_SIZE).fill(0);
  const dInput = new Array<number>(UNIFIED_INPUT_SIZE).fill(0);
  for (let j = 0; j < UNIFIED_HIDDEN_SIZE; j += 1) {
    const z = trace.z1[j];
    if (z === undefined) throw new TypeError("z1 shape mismatch");
    const dj = (dh1[j] ?? 0) * (z > 0 ? 1 : 0);
    dz1[j] = dj;
    dB1[j] = (dB1[j] ?? 0) + dj;
    for (let i = 0; i < UNIFIED_INPUT_SIZE; i += 1) {
      const xi = input[i];
      const w1 = tensors.W1[j * UNIFIED_INPUT_SIZE + i];
      if (xi === undefined || w1 === undefined) throw new TypeError("W1 shape mismatch");
      dW1[j * UNIFIED_INPUT_SIZE + i] = (dW1[j * UNIFIED_INPUT_SIZE + i] ?? 0) + dj * xi;
      dInput[i] = (dInput[i] ?? 0) + dj * w1;
    }
  }

  return {
    grads: { W1: dW1, b1: dB1, W2: dW2, b2: dB2, W3: dW3, b3: db3 },
    dInput,
  };
}

export function createXavierTensors(seed: number): MutableUnifiedTensors {
  if (!Number.isFinite(seed)) throw new TypeError("seed must be finite");
  let state = (Math.floor(seed) >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const xavier = (fanIn: number, fanOut: number): number => {
    const limit = Math.sqrt(6 / (fanIn + fanOut));
    return (next() * 2 - 1) * limit;
  };

  const W1 = new Array<number>(UNIFIED_PARAMETER_COUNTS.W1).fill(0).map(() => xavier(UNIFIED_INPUT_SIZE, UNIFIED_HIDDEN_SIZE));
  const W2 = new Array<number>(UNIFIED_PARAMETER_COUNTS.W2).fill(0).map(() => xavier(UNIFIED_HIDDEN_SIZE, UNIFIED_HIDDEN_SIZE));
  const W3 = new Array<number>(UNIFIED_PARAMETER_COUNTS.W3).fill(0).map(() => xavier(UNIFIED_HIDDEN_SIZE, UNIFIED_OUTPUT_SIZE));
  return {
    W1,
    b1: new Array<number>(UNIFIED_PARAMETER_COUNTS.b1).fill(0),
    W2,
    b2: new Array<number>(UNIFIED_PARAMETER_COUNTS.b2).fill(0),
    W3,
    b3: new Array<number>(UNIFIED_PARAMETER_COUNTS.b3).fill(0),
  };
}

export function cloneTensors(tensors: UnifiedTensors): MutableUnifiedTensors {
  assertUnifiedTensors(tensors);
  return {
    W1: [...tensors.W1],
    b1: [...tensors.b1],
    W2: [...tensors.W2],
    b2: [...tensors.b2],
    W3: [...tensors.W3],
    b3: [...tensors.b3],
  };
}

export function applyFullBatchSgd(
  tensors: MutableUnifiedTensors,
  grads: UnifiedTensors,
  learningRate: number,
): void {
  if (!Number.isFinite(learningRate) || learningRate <= 0) {
    throw new TypeError("learningRate must be a positive finite number");
  }
  assertUnifiedTensors(grads);
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const target = tensors[key];
    const grad = grads[key];
    for (let i = 0; i < target.length; i += 1) {
      const g = grad[i];
      const v = target[i];
      if (g === undefined || v === undefined) throw new TypeError(`${key} shape mismatch`);
      target[i] = v - learningRate * g;
    }
  }
}

export function zeroTensors(): UnifiedTensors {
  return {
    W1: new Array<number>(UNIFIED_PARAMETER_COUNTS.W1).fill(0),
    b1: new Array<number>(UNIFIED_PARAMETER_COUNTS.b1).fill(0),
    W2: new Array<number>(UNIFIED_PARAMETER_COUNTS.W2).fill(0),
    b2: new Array<number>(UNIFIED_PARAMETER_COUNTS.b2).fill(0),
    W3: new Array<number>(UNIFIED_PARAMETER_COUNTS.W3).fill(0),
    b3: new Array<number>(UNIFIED_PARAMETER_COUNTS.b3).fill(0),
  };
}

export function addTensorsInto(target: MutableUnifiedTensors, source: UnifiedTensors, scale: number): void {
  if (!Number.isFinite(scale)) throw new TypeError("scale must be finite");
  assertUnifiedTensors(source);
  for (const key of ["W1", "b1", "W2", "b2", "W3", "b3"] as const) {
    const dest = target[key];
    const src = source[key];
    for (let i = 0; i < dest.length; i += 1) {
      const s = src[i];
      const d = dest[i];
      if (s === undefined || d === undefined) throw new TypeError(`${key} shape mismatch`);
      dest[i] = d + s * scale;
    }
  }
}
