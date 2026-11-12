import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ontologyPath = join(repoRoot, 'docs/inference-training-ontology.md');
const graphPath = join(repoRoot, 'workflows/project-design.graph.json');
const userApprovalQuote = '第一部分你已经落盘了吗?需要改成治理门禁';

const objectRows = [
  ['G', '| G / 根目标 |'],
  ['S', '| S / 真实状态 |'],
  ['K', '| K / 技能 |'],
  ['C', '| C / 候选 |'],
  ['W', '| W / 模型包 |'],
  ['A', '| A / 动作 |'],
  ['E', '| E / 评价与证据 |'],
  ['D', '| D / 样本 |'],
  ['T', '| T / 训练候选 |'],
];

const relationRows = [
  ['R1', ['G'], ['C'], '| R1 constrains |'],
  ['R2', ['S'], ['E'], '| R2 supports |'],
  ['R3', ['W', 'C'], ['A'], '| R3 selects |'],
  ['R4', ['A'], ['S'], '| R4 observes |'],
  ['R5', ['G'], ['Condition'], '| R5 decomposes |'],
  ['R6', ['D'], ['T'], '| R6 derives |'],
  ['R7', ['T'], ['E'], '| R7 compares |'],
];

const behaviorRows = [
  ['B1', '| B1 绑定 / engine |'],
  ['B2', '| B2 观测投影 / adapter + shared converter |'],
  ['B3', '| B3 单次选择 / student |'],
  ['B4', '| B4 分解与执行 / engine + adapter |'],
  ['B5', '| B5 评价 / evaluator + engine |'],
  ['B6', '| B6 准备 / researcher |'],
  ['B7', '| B7 拟合 / 固定 trainer |'],
  ['B8', '| B8 比较 / evaluator |'],
];

const priorConstraintQuote = '64 维输入、两层隐藏层；统一格式、统一推理、动态技能与权重；权重单次决策，推理引擎推动 Goal 拆解；真实证据与模型评分分离；训练资料来源隔离，后训练继承已有知识。';
const graphNodeIds = [
  '读取现有架构与能力缺口',
  '定义四元素与训练反推关系',
  '确定固定调用与执行责任',
  '设计数值连线与外层流程图纸',
  '设计独立样本及版本进化验收',
  '校验四元素闭合与最小必要性',
  '交付可实施设计或具体缺口',
];

let contractCounter = 0;

async function writeText(path, text) {
  await writeFile(path, text, 'utf8');
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'nn-ontology-governance-'));
  const approvalPath = join(root, 'approval.md');
  const acceptPath = join(root, 'review-accept.md');
  const reworkPath = join(root, 'review-rework.md');
  await writeText(approvalPath, [
    '# User approval excerpt',
    userApprovalQuote,
    priorConstraintQuote,
    'Scope: convert the first ontology section into design and delivery admission.',
    '',
  ].join('\n'));
  await writeText(acceptPath, [
    '# Synthetic review',
    'Decision: ACCEPT',
    'Scope: synthetic governance admission for this gate test',
    'Raw evidence: pass.raw.log',
    '',
  ].join('\n'));
  await writeText(reworkPath, [
    '# Synthetic review',
    'Decision: REWORK',
    'Scope: synthetic governance admission for this gate test',
    '',
  ].join('\n'));
  for (const caseId of [
    ...objectRows.map(([id]) => [`${id}-allow`, `${id}-deny`]).flat(),
    ...relationRows.map(([id]) => [`${id}-allow`, `${id}-deny`]).flat(),
    ...behaviorRows.map(([id]) => [`${id}-allow`, `${id}-deny`]).flat(),
  ]) {
    const rawPath = join(root, `${caseId}.raw.log`);
    await writeText(rawPath, `case: ${caseId}\nresult: PASS\n`);
    await writeText(join(root, `${caseId}.review.md`), [
      '# Synthetic case review',
      'Decision: ACCEPT',
      `Reviewed case: ${caseId}`,
      `Raw evidence: ${rawPath}`,
      'Scope: synthetic governance admission for this gate test',
      '',
    ].join('\n'));
  }

  return { root, approvalPath, acceptPath, reworkPath };
}

function source(path, quote) {
  return { path, quote };
}

function graphEdges() {
  return graphNodeIds.slice(0, -1).map((from, index) => [
    from,
    graphNodeIds[index + 1],
    [
      'capability_design_observation',
      'capability_semantic_contract',
      'capability_boundary_design',
      'capability_wiring_design',
      'capability_acceptance_design',
      'capability_design_assessment',
    ][index],
  ]);
}

function governanceEdge(index) {
  const [from, to, arcId] = graphEdges()[index % graphEdges().length];
  return { graph: 'project-design', from, to, arcId };
}

function baseContract(fixture) {
  const edge = index => governanceEdge(index);
  const makeClause = (id, axis, axisId, quote, index) => ({
    id,
    axis,
    axisId,
    source: source(ontologyPath, quote),
    scope: 'Synthetic governance scope.',
    scenario: `When ${axisId} is in scope.`,
    trigger: `The ${axisId} gate is evaluated.`,
    allowedActions: [`Allow ${axisId} when its declared preconditions hold.`],
    forbiddenActions: [`Reject ${axisId} when its declared preconditions do not hold.`],
    stateBefore: 'declared precondition',
    stateAfter: 'declared output state',
    effects: [],
    owner: 'project ontology',
      approval: {
        state: 'approved',
        source: source(fixture.approvalPath, userApprovalQuote),
        scope: 'First ontology section governance conversion.',
      },
    governance: {
      edge: edge(index),
      gateKind: axis,
      check: `Check ${axisId}.`,
      allowCase: `${axisId}-allow`,
      denyCase: `${axisId}-deny`,
      observation: `Observe ${axisId} through the public gate.`,
    },
  });
  const objectClauses = {
    G: 'BEH-B4',
    S: 'BEH-B2',
    K: 'BEH-B4',
    C: 'BEH-B3',
    W: 'BEH-B3',
    A: 'BEH-B4',
    E: 'BEH-B5',
    D: 'BEH-B6',
    T: 'BEH-B7',
  };
  const relationClauses = {
    R1: 'BEH-B3',
    R2: 'BEH-B5',
    R3: 'BEH-B3',
    R4: 'BEH-B4',
    R5: 'BEH-B4',
    R6: 'BEH-B7',
    R7: 'BEH-B8',
  };
  const clauses = behaviorRows.map(([id, quote], index) => makeClause(`BEH-${id}`, 'behavior', id, quote, index));
  return {
    ontology_version: 1,
    definitions: {
      objects: objectRows.map(([id, quote]) => ({
        id,
        identity: `Identity for ${id}.`,
        owner: 'project ontology',
        attributes: [],
        perception: `Observe ${id} from its declared source.`,
        mustHave: [],
        mustNotHave: [],
        source: source(ontologyPath, quote),
      })),
      relations: relationRows.map(([id, from, to, quote], index) => ({
        id,
        from,
        to,
        kind: 'typed dependency',
        direction: 'directed',
        cardinality: 'declared in ontology source',
        owner: 'project ontology',
        perception: `Observe ${id} through its endpoints.`,
        mustHave: [],
        mustNotHave: [],
        source: source(ontologyPath, quote),
        ...(id === 'R5'
          ? {
              auxiliaryEndpoints: [{
                id: 'Condition',
                source: source(ontologyPath, '| R5 decomposes |'),
              }],
            }
          : {}),
      })),
      behaviors: behaviorRows.map(([id, quote]) => ({
        id,
        owner: 'project ontology',
        precondition: [`Precondition for ${id}.`],
        input: [`Input for ${id}.`],
        output: [`Output for ${id}.`],
        transition: { from: 'before', to: 'after' },
        effects: [],
        perception: `Observe ${id} through its public entry.`,
        mustHave: [],
        mustNotHave: [],
        source: source(ontologyPath, quote),
      })),
    },
    graph: {
      path: join(repoRoot, 'workflows/project-design.graph.json'),
      nodeIds: graphNodeIds,
    },
    authority: {
      userApproval: source(fixture.approvalPath, userApprovalQuote),
      priorConstraints: [source(fixture.approvalPath, priorConstraintQuote)],
    },
    capability: {
      id: 'inference-training-ontology-governance',
      scope: 'Synthetic capability for public gate admission tests.',
      contractSource: source(ontologyPath, '# 推理与训练 ontology 审计'),
      objects: objectRows.map(([id]) => ({
        id,
        applicable: true,
        owner: 'project ontology',
        observation: `Observe ${id} through the declared ontology source.`,
        clauseIds: [objectClauses[id]],
      })),
      relations: relationRows.map(([id]) => ({
        id,
        applicable: true,
        owner: 'project ontology',
        observation: `Observe ${id} through its declared endpoints.`,
        clauseIds: [relationClauses[id]],
      })),
      behaviors: behaviorRows.map(([id]) => ({
        id,
        applicable: true,
        owner: 'project ontology',
        effects: [],
        observation: `Observe ${id} through the public contract.`,
        clauseIds: [`BEH-${id}`],
        allowCase: { id: `${id}-allow`, description: `Allow ${id} with declared inputs.` },
        denyCase: { id: `${id}-deny`, description: `Reject ${id} without required inputs.` },
      })),
    },
    clauses,
    reviews: {
      design: {
        decision: 'ACCEPT',
        source: source(fixture.acceptPath, 'Decision: ACCEPT'),
        scope: 'synthetic governance admission for this gate test',
      },
    },
    deliveryEvidence: [],
  };
}

async function writeContract(fixture, contract) {
  const path = join(fixture.root, `contract-${++contractCounter}.md`);
  await writeText(path, [
    '# Synthetic ontology governance contract',
    '',
    '```json ontology-governance',
    JSON.stringify(contract, null, 2),
    '```',
    '',
  ].join('\n'));
  return path;
}

function runGate(stage, contractPath) {
  const result = spawnSync('npm', [
    'run',
    '--silent',
    'gate:ontology',
    '--',
    '--stage',
    stage,
    '--contract',
    contractPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  let json = null;
  if (result.stdout.trim()) json = JSON.parse(result.stdout);
  return { ...result, json };
}

function hasGap(result, code) {
  return result.json?.gaps?.some(gap => gap.code === code) === true;
}

async function withFixture(run) {
  const fixture = await makeFixture();
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

function addPassingDeliveryEvidence(contract, fixture) {
  contract.reviews.delivery = {
    decision: 'ACCEPT',
    source: source(fixture.acceptPath, 'Decision: ACCEPT'),
    scope: 'synthetic governance admission for this gate test',
  };
  contract.deliveryEvidence = contract.capability.behaviors
    .filter(behavior => behavior.applicable)
    .flatMap(behavior => [behavior.allowCase, behavior.denyCase].map(testCase => ({
      caseId: testCase.id,
      clauseIds: behavior.clauseIds,
      entry: 'synthetic public behavior entry',
      parameters: { caseId: testCase.id },
      result: 'pass',
      raw: source(join(fixture.root, `${testCase.id}.raw.log`), `case: ${testCase.id}\nresult: PASS`),
      review: {
        decision: 'ACCEPT',
        source: source(join(fixture.root, `${testCase.id}.review.md`), [
          'Decision: ACCEPT',
          `Reviewed case: ${testCase.id}`,
          `Raw evidence: ${join(fixture.root, `${testCase.id}.raw.log`)}`,
          'Scope: synthetic governance admission for this gate test',
        ].join('\n')),
        scope: 'synthetic governance admission for this gate test',
      },
    })));
}

test('public CLI admits a legal design contract without claiming behavior', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.json.decision, 'admitted');
    assert.equal(result.json.stage, 'design');
    assert.equal(result.json.scope, contract.capability.id);
    assert.equal(result.json.behavior_verified, false);
    assert.deepEqual(result.json.gaps, []);
  });
});

test('missing object coverage is rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.capability.objects = contract.capability.objects.filter(item => item.id !== 'G');
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.json.decision, 'rejected');
    assert.equal(hasGap(result, 'COVERAGE_MISSING'), true);
  });
});

test('dangling relation endpoint is rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.definitions.relations.find(item => item.id === 'R1').to = ['NOPE'];
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'RELATION_ENDPOINT_UNRESOLVED'), true);
  });
});

test('missing source quote is rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.definitions.objects[0].source.quote = 'quote that is not present in the ontology source';
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'SOURCE_QUOTE_MISSING'), true);
  });
});

test('approved clause without a user source is rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    delete contract.clauses.find(item => item.id === 'BEH-B1').approval.source;
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'SOURCE_MISSING'), true);
  });
});

test('missing owner, effects, and observation are rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    delete contract.capability.behaviors.find(item => item.id === 'B3').owner;
    delete contract.capability.behaviors.find(item => item.id === 'B4').effects;
    contract.capability.behaviors.find(item => item.id === 'B5').observation = '';
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'BEHAVIOR_OWNER_MISSING'), true);
    assert.equal(hasGap(result, 'BEHAVIOR_EFFECTS_MISSING'), true);
    assert.equal(hasGap(result, 'BEHAVIOR_OBSERVATION_MISSING'), true);
  });
});

test('nonexistent DAG edge is rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.clauses[0].governance.edge = {
      from: 'not-a-project-design-node',
      to: 'also-not-a-project-design-node',
      arcId: 'not-a-project-design-edge',
    };
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'GOVERNANCE_EDGE_NOT_FOUND'), true);
  });
});

test('an empty reviewed scope cannot obtain delivery admission', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    addPassingDeliveryEvidence(contract, fixture);
    for (const group of [contract.capability.objects, contract.capability.relations, contract.capability.behaviors]) {
      for (const item of group) {
        item.applicable = false;
        item.exclusionBasis = 'Excluded by the synthetic review.';
        item.review = structuredClone(contract.reviews.design);
      }
    }
    const result = runGate('delivery', await writeContract(fixture, contract));
    assert.equal(result.status, 1, result.stdout);
    assert.equal(hasGap(result, 'EMPTY_APPLICABLE_SCOPE'), true);
  });
});

test('coverage cases cannot substitute unrelated clause cases', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    addPassingDeliveryEvidence(contract, fixture);
    contract.clauses[0].governance.allowCase = 'unrelated-allow';
    const path = await writeContract(fixture, contract);
    for (const stage of ['design', 'delivery']) {
      const result = runGate(stage, path);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(hasGap(result, 'BEHAVIOR_CLAUSE_CASE_MISMATCH'), true);
    }
  });
});

test('a clause for another behavior cannot govern this behavior', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.clauses[0].axisId = 'B2';
    const result = runGate('design', await writeContract(fixture, contract));
    assert.equal(result.status, 1, result.stdout);
    assert.equal(hasGap(result, 'BEHAVIOR_CLAUSE_AXIS_MISMATCH'), true);
  });
});

test('declared ACCEPT cannot override a REWORK source in design or case review', async () => {
  await withFixture(async fixture => {
    const designContract = baseContract(fixture);
    designContract.reviews.design.source = source(fixture.reworkPath, 'Decision: REWORK');
    const design = runGate('design', await writeContract(fixture, designContract));
    assert.equal(design.status, 1, design.stdout);
    assert.equal(hasGap(design, 'REVIEW_CONTENT_MISMATCH'), true);
    const deliveryContract = baseContract(fixture);
    addPassingDeliveryEvidence(deliveryContract, fixture);
    deliveryContract.deliveryEvidence[0].review.source = source(fixture.reworkPath, 'Decision: REWORK');
    const delivery = runGate('delivery', await writeContract(fixture, deliveryContract));
    assert.equal(delivery.status, 1, delivery.stdout);
    assert.equal(hasGap(delivery, 'REVIEW_CONTENT_MISMATCH'), true);
  });
});

test('design review REWORK is rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.reviews.design.decision = 'REWORK';
    contract.reviews.design.source = source(fixture.reworkPath, 'Decision: REWORK');
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'DESIGN_REVIEW_NOT_ACCEPTED'), true);
  });
});

test('design needs no runtime proof but delivery does', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    const contractPath = await writeContract(fixture, contract);

    const design = runGate('design', contractPath);
    assert.equal(design.status, 0, design.stderr || design.stdout);

    const delivery = runGate('delivery', contractPath);
    assert.equal(delivery.status, 1, delivery.stderr || delivery.stdout);
    assert.equal(hasGap(delivery, 'DELIVERY_EVIDENCE_MISSING'), true);
  });
});

test('delivery pass without raw evidence is rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    addPassingDeliveryEvidence(contract, fixture);
    delete contract.deliveryEvidence[0].raw;
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('delivery', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'DELIVERY_RAW_MISSING'), true);
    assert.equal(result.json.behavior_verified, false);
  });
});

test('delivery raw output must match the declared case', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    addPassingDeliveryEvidence(contract, fixture);
    const rawPath = join(fixture.root, 'mismatched.raw.log');
    await writeText(rawPath, 'case: not-the-declared-case\nresult: PASS\n');
    contract.deliveryEvidence[0].raw = source(rawPath, 'case: not-the-declared-case\nresult: PASS');
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('delivery', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'DELIVERY_RAW_CASE_MISMATCH'), true);
  });
});

test('failed delivery evidence cannot masquerade as admitted', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    addPassingDeliveryEvidence(contract, fixture);
    contract.deliveryEvidence[0].result = 'fail';
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('delivery', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'DELIVERY_RESULT_NOT_PASS'), true);
    assert.equal(result.json.behavior_verified, false);
  });
});

test('an explicit reviewed scope subset can pass delivery', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    for (const item of contract.capability.objects) {
      item.applicable = false;
      item.exclusionBasis = 'Outside the reviewed synthetic capability scope.';
      item.review = {
        decision: 'ACCEPT',
        source: source(fixture.acceptPath, 'Decision: ACCEPT'),
        scope: 'synthetic governance admission for this gate test',
      };
    }
    for (const item of contract.capability.relations) {
      item.applicable = false;
      item.exclusionBasis = 'Outside the reviewed synthetic capability scope.';
      item.review = {
        decision: 'ACCEPT',
        source: source(fixture.acceptPath, 'Decision: ACCEPT'),
        scope: 'synthetic governance admission for this gate test',
      };
    }
    for (const behavior of contract.capability.behaviors) {
      if (behavior.id === 'B1') continue;
      behavior.applicable = false;
      behavior.exclusionBasis = 'Outside the reviewed synthetic capability scope.';
      behavior.review = {
        decision: 'ACCEPT',
        source: source(fixture.acceptPath, 'Decision: ACCEPT'),
        scope: 'synthetic governance admission for this gate test',
      };
    }
    addPassingDeliveryEvidence(contract, fixture);
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('delivery', contractPath);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.json.decision, 'admitted');
    assert.equal(result.json.behavior_verified, false);
    assert.equal(result.json.reviewed_behavior_evidence.length, 2);
  });
});

test('a candidate clause cannot be used as an approved mandatory basis', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.clauses.push({
      ...contract.clauses[0],
      id: 'G08',
      approval: {
        state: 'candidate',
        scope: 'Proposed extra policy not approved by the user.',
      },
    });
    contract.capability.behaviors.find(item => item.id === 'B1').clauseIds = ['G08'];
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'CLAUSE_NOT_APPROVED'), true);
  });
});

test('malformed ontology-governance marker exits with parameter or syntax code', async () => {
  await withFixture(async fixture => {
    const path = join(fixture.root, 'malformed.md');
    await writeText(path, '# Missing marker\n');
    const result = runGate('design', path);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(result.json, null);
  });
});

test('referenced source files are read from disk, not inferred from non-empty strings', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    contract.definitions.objects = contract.definitions.objects.map(item => item.id === 'S'
      ? { ...item, source: source(join(fixture.root, 'absent.md'), '| S / 真实状态 |') }
      : item);
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(result.json, null);
  });
});

test('conflicting duplicate review decisions are rejected', async () => {
  await withFixture(async fixture => {
    const contract = baseContract(fixture);
    await writeText(fixture.acceptPath, [
      '# Synthetic review with conflicting history',
      'Decision: REWORK',
      'Decision: ACCEPT',
      'Scope: synthetic governance admission for this gate test',
      '',
    ].join('\n'));
    const contractPath = await writeContract(fixture, contract);
    const result = runGate('design', contractPath);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(hasGap(result, 'REVIEW_CONTENT_MISMATCH'), true);
  });
});
