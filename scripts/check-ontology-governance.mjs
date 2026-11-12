import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const objectIds = ['G', 'S', 'K', 'C', 'W', 'A', 'E', 'D', 'T'];
const relationIds = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];
const behaviorIds = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'];
const validStages = new Set(['design', 'delivery']);

class UsageError extends Error {}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== '--stage' && token !== '--contract') {
      throw new UsageError(`unknown argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new UsageError(`${token} requires a value`);
    }
    args[token.slice(2)] = value;
    index += 1;
  }
  if (!validStages.has(args.stage)) {
    throw new UsageError('--stage must be design or delivery');
  }
  if (!args.contract) {
    throw new UsageError('--contract is required');
  }
  return args;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasTextArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(hasText);
}

function isTextArray(value) {
  return Array.isArray(value) && value.every(hasText);
}

function hasDirectConflict(item) {
  if (!Array.isArray(item.mustHave) || !Array.isArray(item.mustNotHave)) return false;
  return item.mustHave.some(value => item.mustNotHave.includes(value));
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function extractGovernanceBlock(markdown, contractPath) {
  const lines = markdown.split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^```json\s+ontology-governance\s*$/.test(lines[index])) starts.push(index);
  }
  if (starts.length !== 1) {
    throw new UsageError(`${contractPath} must contain exactly one json ontology-governance block`);
  }
  const start = starts[0];
  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^```\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  if (end === -1) throw new UsageError(`${contractPath} has an unterminated ontology-governance block`);
  const source = lines.slice(start + 1, end).join('\n');
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new UsageError(`${contractPath} has invalid ontology-governance JSON: ${error.message}`);
  }
}

function addMissingIdGaps(items, expectedIds, kind, addGap) {
  if (!Array.isArray(items)) {
    addGap(`${kind}_COVERAGE_MISSING`, null, `${kind} coverage is missing`);
    return new Map();
  }
  const byId = new Map();
  for (const item of items) {
    if (!isObject(item) || !hasText(item.id)) {
      addGap(`${kind}_ID_MISSING`, null, `${kind} entry has no id`);
      continue;
    }
    if (byId.has(item.id)) {
      addGap(`${kind}_DUPLICATE`, item.id, `${kind} id ${item.id} is duplicated`);
      continue;
    }
    byId.set(item.id, item);
  }
  for (const id of expectedIds) {
    if (!byId.has(id)) addGap(`${kind}_MISSING`, id, `${kind} coverage is missing ${id}`);
  }
  for (const id of byId.keys()) {
    if (!expectedIds.includes(id)) addGap(`${kind}_UNKNOWN`, id, `${kind} coverage has unknown id ${id}`);
  }
  return byId;
}

function validateDefinitions(contract, addGap, verifySource) {
  const definitions = isObject(contract.definitions) ? contract.definitions : {};
  const objects = addMissingIdGaps(definitions.objects, objectIds, 'OBJECT_DEFINITION', addGap);
  const relations = addMissingIdGaps(definitions.relations, relationIds, 'RELATION_DEFINITION', addGap);
  const behaviors = addMissingIdGaps(definitions.behaviors, behaviorIds, 'BEHAVIOR_DEFINITION', addGap);

  for (const [id, item] of objects) {
    if (!hasText(item.owner)) addGap('OBJECT_DEFINITION_OWNER_MISSING', id, `object ${id} has no owner`);
    for (const field of ['identity', 'perception']) {
      if (!hasText(item[field])) addGap('OBJECT_DEFINITION_FIELD_MISSING', id, `object ${id} is missing ${field}`);
    }
    for (const field of ['attributes', 'mustHave', 'mustNotHave']) {
      if (!isTextArray(item[field])) addGap('OBJECT_DEFINITION_FIELD_MISSING', id, `object ${id} is missing ${field}`);
    }
    if (hasDirectConflict(item)) addGap('DEFINITION_CONFLICT', id, `object ${id} has a must-have/must-not-have conflict`);
    verifySource(item.source, `object ${id}`);
  }

  const auxiliaryEndpoints = new Map();
  for (const [id, item] of relations) {
    if (!hasText(item.owner)) addGap('RELATION_DEFINITION_OWNER_MISSING', id, `relation ${id} has no owner`);
    for (const field of ['kind', 'direction', 'cardinality', 'perception']) {
      if (!hasText(item[field])) addGap('RELATION_DEFINITION_FIELD_MISSING', id, `relation ${id} is missing ${field}`);
    }
    for (const field of ['mustHave', 'mustNotHave']) {
      if (!isTextArray(item[field])) addGap('RELATION_DEFINITION_FIELD_MISSING', id, `relation ${id} is missing ${field}`);
    }
    if (hasDirectConflict(item)) addGap('DEFINITION_CONFLICT', id, `relation ${id} has a must-have/must-not-have conflict`);
    verifySource(item.source, `relation ${id}`);
    if (!hasTextArray(item.from) || !hasTextArray(item.to)) {
      addGap('RELATION_ENDPOINTS_MISSING', id, `relation ${id} must declare from and to endpoints`);
    }
    for (const endpoint of Array.isArray(item.auxiliaryEndpoints) ? item.auxiliaryEndpoints : []) {
      if (!isObject(endpoint) || !hasText(endpoint.id)) {
        addGap('RELATION_AUXILIARY_ENDPOINT_MISSING', id, `relation ${id} has an auxiliary endpoint without id`);
        continue;
      }
      auxiliaryEndpoints.set(endpoint.id, endpoint);
      verifySource(endpoint.source, `relation ${id} auxiliary endpoint ${endpoint.id}`);
    }
  }

  for (const [id, item] of relations) {
    const endpoints = [
      ...(Array.isArray(item.from) ? item.from : []),
      ...(Array.isArray(item.to) ? item.to : []),
    ];
    for (const endpoint of endpoints) {
      if (!objectIds.includes(endpoint) && !auxiliaryEndpoints.has(endpoint)) {
        addGap(
          'RELATION_ENDPOINT_UNRESOLVED',
          id,
          `relation ${id} references undeclared endpoint ${endpoint}`,
        );
      }
    }
  }

  for (const [id, item] of behaviors) {
    if (!hasText(item.owner)) addGap('BEHAVIOR_DEFINITION_OWNER_MISSING', id, `behavior ${id} has no owner`);
    for (const field of ['precondition', 'input', 'output']) {
      if (!hasTextArray(item[field])) addGap('BEHAVIOR_DEFINITION_FIELD_MISSING', id, `behavior ${id} is missing ${field}`);
    }
    for (const field of ['effects', 'mustHave', 'mustNotHave']) {
      if (!isTextArray(item[field])) addGap('BEHAVIOR_DEFINITION_FIELD_MISSING', id, `behavior ${id} is missing ${field}`);
    }
    if (!isObject(item.transition) || !hasText(item.transition.from) || !hasText(item.transition.to)) {
      addGap('BEHAVIOR_TRANSITION_MISSING', id, `behavior ${id} has no complete transition`);
    }
    if (!hasText(item.perception)) addGap('BEHAVIOR_PERCEPTION_MISSING', id, `behavior ${id} has no perception path`);
    if (hasDirectConflict(item)) addGap('DEFINITION_CONFLICT', id, `behavior ${id} has a must-have/must-not-have conflict`);
    verifySource(item.source, `behavior ${id}`);
  }

  return { objects, relations, behaviors };
}

function validateClauses(contract, definitions, referencedClauseIds, addGap, verifySource, graph) {
  const clauseMap = new Map();
  const clauses = Array.isArray(contract.clauses) ? contract.clauses : [];
  if (clauses.length === 0) addGap('CLAUSES_MISSING', null, 'contract has no rule clauses');

  for (const clause of clauses) {
    if (!isObject(clause) || !hasText(clause.id)) {
      addGap('CLAUSE_ID_MISSING', null, 'rule clause has no id');
      continue;
    }
    if (clauseMap.has(clause.id)) {
      addGap('CLAUSE_DUPLICATE', clause.id, `rule clause ${clause.id} is duplicated`);
      continue;
    }
    clauseMap.set(clause.id, clause);
  }

  for (const [id, clause] of clauseMap) {
    for (const field of ['scope', 'owner', 'stateBefore', 'stateAfter']) {
      if (!hasText(clause[field])) addGap('CLAUSE_FIELD_MISSING', id, `clause ${id} is missing ${field}`);
    }
    for (const field of ['allowedActions', 'forbiddenActions']) {
      if (!hasTextArray(clause[field])) addGap('CLAUSE_FIELD_MISSING', id, `clause ${id} is missing ${field}`);
    }
    if (!hasText(clause.scenario) || !hasText(clause.trigger)) {
      addGap('CLAUSE_FIELD_MISSING', id, `clause ${id} is missing scenario or trigger`);
    }
    if (!Array.isArray(clause.effects)) addGap('CLAUSE_EFFECTS_MISSING', id, `clause ${id} must declare effects`);
    verifySource(clause.source, `clause ${id}`);

    if (referencedClauseIds.has(id)) {
      const approval = isObject(clause.approval) ? clause.approval : {};
      if (approval.state !== 'approved') {
        addGap('CLAUSE_NOT_APPROVED', id, `referenced clause ${id} is not approved`);
      }
      if (!hasText(approval.scope)) addGap('CLAUSE_APPROVAL_SCOPE_MISSING', id, `clause ${id} has no approval scope`);
      verifySource(approval.source, `clause ${id} approval`);
      const userApproval = contract.authority?.userApproval;
      if (
        !isObject(userApproval)
        || approval.source?.path !== userApproval.path
        || approval.source?.quote !== userApproval.quote
      ) {
        addGap(
          'CLAUSE_APPROVAL_NOT_USER_AUTHORITY',
          id,
          `clause ${id} approval must cite the declared user approval source and exact text`,
        );
      }
    }

    const axisIds = {
      object: new Set(definitions.objects.keys()),
      behavior: new Set(definitions.behaviors.keys()),
      relation: new Set(definitions.relations.keys()),
    };
    if (!axisIds[clause.axis]?.has(clause.axisId)) {
      addGap('CLAUSE_AXIS_UNRESOLVED', id, `clause ${id} axis ${clause.axis}:${clause.axisId} does not resolve`);
    }

    if (!isObject(clause.governance)) {
      addGap('CLAUSE_GOVERNANCE_MISSING', id, `clause ${id} has no governance binding`);
      continue;
    }
    for (const field of ['gateKind', 'check', 'allowCase', 'denyCase', 'observation']) {
      if (!hasText(clause.governance[field])) {
        addGap('CLAUSE_GOVERNANCE_FIELD_MISSING', id, `clause ${id} governance is missing ${field}`);
      }
    }
    const edge = isObject(clause.governance.edge) ? clause.governance.edge : {};
    if (!hasText(edge.from) || !hasText(edge.to) || !hasText(edge.arcId)) {
      addGap('GOVERNANCE_EDGE_MISSING', id, `clause ${id} has no complete DAG edge binding`);
      continue;
    }
    if (!graph.ready) continue;
    const edgeFound = graph.edges.some(candidate =>
      candidate.from === edge.from
      && candidate.to === edge.to
      && candidate.arcId === edge.arcId);
    if (!edgeFound) {
      addGap('GOVERNANCE_EDGE_NOT_FOUND', id, `clause ${id} edge ${edge.from} -> ${edge.to} (${edge.arcId}) does not exist`);
    }
  }

  for (const id of referencedClauseIds) {
    if (!clauseMap.has(id)) addGap('CLAUSE_UNKNOWN', id, `referenced clause ${id} does not exist`);
  }

  return clauseMap;
}

function validateCoverage(contract, addGap) {
  const capability = isObject(contract.capability) ? contract.capability : {};
  const objects = addMissingIdGaps(capability.objects, objectIds, 'COVERAGE', addGap);
  const relations = addMissingIdGaps(capability.relations, relationIds, 'COVERAGE', addGap);
  const behaviors = addMissingIdGaps(capability.behaviors, behaviorIds, 'COVERAGE', addGap);
  return { capability, objects, relations, behaviors };
}

function validateExclusion(item, kind, id, addGap, verifyReview) {
  if (!hasText(item.exclusionBasis)) {
    addGap(`${kind}_EXCLUSION_BASIS_MISSING`, id, `${kind} ${id} has no exclusion basis`);
  }
  verifyReview(item.review, `${kind} ${id} exclusion`);
}

function collectReferencedClauseIds(coverage) {
  const ids = new Set();
  for (const group of [coverage.objects, coverage.relations, coverage.behaviors]) {
    for (const item of group.values()) {
      if (item.applicable !== true) continue;
      for (const clauseId of Array.isArray(item.clauseIds) ? item.clauseIds : []) ids.add(clauseId);
    }
  }
  return ids;
}

function validateApplicableCoverage(coverage, addGap, verifyReview) {
  if (![...coverage.objects.values(), ...coverage.relations.values(), ...coverage.behaviors.values()]
    .some(item => item.applicable === true)) {
    addGap('EMPTY_APPLICABLE_SCOPE', coverage.capability.id, 'capability has no applicable ontology item');
  }
  for (const [id, item] of coverage.objects) {
    if (item.applicable !== true) {
      validateExclusion(item, 'OBJECT', id, addGap, verifyReview);
      continue;
    }
    if (!hasText(item.owner)) addGap('OBJECT_OWNER_MISSING', id, `object ${id} has no owner`);
    if (!hasText(item.observation)) addGap('OBJECT_OBSERVATION_MISSING', id, `object ${id} has no observation`);
    if (!hasTextArray(item.clauseIds)) addGap('OBJECT_CLAUSE_MISSING', id, `object ${id} has no clause`);
  }
  for (const [id, item] of coverage.relations) {
    if (item.applicable !== true) {
      validateExclusion(item, 'RELATION', id, addGap, verifyReview);
      continue;
    }
    if (!hasText(item.owner)) addGap('RELATION_OWNER_MISSING', id, `relation ${id} has no owner`);
    if (!hasText(item.observation)) addGap('RELATION_OBSERVATION_MISSING', id, `relation ${id} has no observation`);
    if (!hasTextArray(item.clauseIds)) addGap('RELATION_CLAUSE_MISSING', id, `relation ${id} has no clause`);
  }
  for (const [id, item] of coverage.behaviors) {
    if (item.applicable !== true) {
      validateExclusion(item, 'BEHAVIOR', id, addGap, verifyReview);
      continue;
    }
    if (!hasText(item.owner)) addGap('BEHAVIOR_OWNER_MISSING', id, `behavior ${id} has no owner`);
    if (!isTextArray(item.effects)) addGap('BEHAVIOR_EFFECTS_MISSING', id, `behavior ${id} has no effects array`);
    if (!hasText(item.observation)) addGap('BEHAVIOR_OBSERVATION_MISSING', id, `behavior ${id} has no observation`);
    if (!hasTextArray(item.clauseIds)) addGap('BEHAVIOR_CLAUSE_MISSING', id, `behavior ${id} has no clause`);
    for (const field of ['allowCase', 'denyCase']) {
      if (!isObject(item[field]) || !hasText(item[field].id) || !hasText(item[field].description)) {
        addGap('BEHAVIOR_CASE_MISSING', id, `behavior ${id} has no complete ${field}`);
      }
    }
  }
}

function loadGraph(contract, addGap) {
  const graph = isObject(contract.graph) ? contract.graph : {};
  if (!hasText(graph.path)) {
    addGap('GOVERNANCE_GRAPH_MISSING', null, 'contract has no governance graph path');
    return { ready: false, edges: [] };
  }
  const graphPath = resolveReference(graph.path);
  const projectDesignPath = join(rootDir, 'workflows/project-design.graph.json');
  if (graphPath !== projectDesignPath) {
    addGap('GOVERNANCE_GRAPH_NOT_PROJECT_DESIGN', null, 'governance binding must use workflows/project-design.graph.json');
    return { ready: false, edges: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(graphPath));
  } catch (error) {
    throw new UsageError(`cannot read or parse governance graph ${graphPath}: ${error.message}`);
  }
  const nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const nodeIds = new Set(nodes.map(node => node?.id).filter(hasText));
  const edges = Array.isArray(parsed.edges)
    ? parsed.edges.map(item => ({
        from: item.from,
        to: item.to,
        arcId: item.arcId ?? item.arc_id,
      }))
    : [];
  if (nodes.length === 0 || edges.length === 0) {
    addGap('GOVERNANCE_GRAPH_INVALID', null, `governance graph ${graphPath} has no nodes or edges`);
    return { ready: false, edges };
  }
  const nodeById = new Map(nodes.filter(isObject).map(node => [node.id, node]));
  if (!Array.isArray(graph.nodeIds) || graph.nodeIds.length !== nodeById.size) {
    addGap('GOVERNANCE_GRAPH_NODE_SET_INVALID', null, 'contract graph.nodeIds must list every project-design node');
  } else if (graph.nodeIds.some(id => !nodeById.has(id))) {
    addGap('GOVERNANCE_GRAPH_NODE_NOT_FOUND', null, 'contract graph.nodeIds must resolve to actual project-design nodes');
  }
  const edgeArcIds = new Set(edges.map(edge => edge.arcId));
  if (edgeArcIds.size !== edges.length) {
    addGap('GOVERNANCE_GRAPH_EDGE_NOT_UNIQUE', null, 'project-design edge arc ids must be unique');
  }
  for (const edge of edges) {
    const fromNode = nodeById.get(edge.from);
    const toNode = nodeById.get(edge.to);
    const graphInputs = Array.isArray(toNode?.inputs) ? toNode.inputs : [];
    if (!graphInputs.includes(edge.arcId)) {
      addGap('GOVERNANCE_GRAPH_EDGE_INCONSISTENT', edge.arcId, `edge ${edge.arcId} is not a node input arc`);
    }
    if (fromNode?.output?.id !== edge.arcId) {
      addGap('GOVERNANCE_GRAPH_EDGE_INCONSISTENT', edge.arcId, `edge ${edge.arcId} is not its from-node output`);
    }
    if (toNode?.id == null) {
      addGap('GOVERNANCE_GRAPH_EDGE_INCONSISTENT', edge.arcId, `edge ${edge.arcId} has no to-node`);
    }
  }
  return { ready: true, edges, nodeIds };
}

function resolveReference(value) {
  return isAbsolute(value) ? value : join(rootDir, value);
}

function reviewAccepted(review) {
  return isObject(review) && review.decision === 'ACCEPT';
}

function validateDesignReview(contract, addGap, verifyReview) {
  const review = isObject(contract.reviews) ? contract.reviews.design : null;
  if (!reviewAccepted(review)) {
    addGap('DESIGN_REVIEW_NOT_ACCEPTED', null, 'design review is missing or not ACCEPT');
  }
  verifyReview(review, 'design review');
}

function validateAuthority(contract, addGap, verifySource) {
  const authority = isObject(contract.authority) ? contract.authority : {};
  verifySource(authority.userApproval, 'user approval');
  if (!Array.isArray(authority.priorConstraints) || authority.priorConstraints.length === 0) {
    addGap('AUTHORITY_PRIOR_CONSTRAINTS_MISSING', null, 'prior architecture constraints are missing');
  } else {
    for (const constraint of authority.priorConstraints) verifySource(constraint, 'prior architecture constraint');
  }
}

function parseRecord(text) {
  const fields = new Map();
  const duplicates = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(case|result|Decision|Reviewed case|Raw evidence|Scope):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1])) duplicates.push(match[1]);
    else fields.set(match[1], match[2]);
  }
  return { fields, duplicates };
}

function validateDeliveryEvidence(contract, coverage, clauseMap, addGap, readSource, verifyReview) {
  const review = isObject(contract.reviews) ? contract.reviews.delivery : null;
  if (!reviewAccepted(review)) {
    addGap('DELIVERY_REVIEW_NOT_ACCEPTED', null, 'delivery review is missing or not ACCEPT');
  }
  verifyReview(review, 'delivery review');

  const evidence = Array.isArray(contract.deliveryEvidence) ? contract.deliveryEvidence : [];
  if (evidence.length === 0) {
    addGap('DELIVERY_EVIDENCE_MISSING', null, 'delivery evidence is missing');
  }

  const acceptedByCase = new Map();
  for (const item of evidence) {
    const caseId = hasText(item.caseId) ? item.caseId : null;
    const scope = caseId ?? 'delivery evidence';
    if (caseId && acceptedByCase.has(caseId)) {
      addGap('DELIVERY_CASE_DUPLICATE', caseId, `delivery case ${caseId} is duplicated`);
    }
    if (!caseId) addGap('DELIVERY_CASE_ID_MISSING', null, 'delivery evidence has no case id');
    if (!hasText(item.entry)) addGap('DELIVERY_ENTRY_MISSING', scope, 'delivery evidence has no public entry');
    if (!isObject(item.parameters)) addGap('DELIVERY_PARAMETERS_MISSING', scope, 'delivery evidence has no parameters');
    if (!hasTextArray(item.clauseIds)) addGap('DELIVERY_CLAUSES_MISSING', scope, 'delivery evidence has no clause ids');
    for (const clauseId of Array.isArray(item.clauseIds) ? item.clauseIds : []) {
      if (!clauseMap.has(clauseId)) addGap('DELIVERY_CLAUSE_UNKNOWN', scope, `delivery evidence references unknown clause ${clauseId}`);
    }
    if (item.result !== 'pass') addGap('DELIVERY_RESULT_NOT_PASS', scope, 'delivery evidence result is not pass');
    if (!isObject(item.raw)) {
      addGap('DELIVERY_RAW_MISSING', scope, 'delivery evidence has no raw output reference');
    }
    let rawReady = false;
    if (isObject(item.raw)) {
      const rawText = readSource(item.raw, `${scope} raw evidence`);
      if (rawText !== null) {
        const { fields: rawRecord, duplicates: rawDuplicates } = parseRecord(rawText);
        if (rawDuplicates.length > 0) {
          addGap('DELIVERY_RAW_FORMAT_INVALID', scope, `raw output repeats field ${rawDuplicates[0]}`);
        }
        if (rawRecord.get('case') !== caseId) {
          addGap('DELIVERY_RAW_CASE_MISMATCH', scope, `raw output case does not match ${caseId}`);
        } else if (!['PASS', 'FAIL', 'UNVERIFIED'].includes(rawRecord.get('result'))) {
          addGap('DELIVERY_RAW_FORMAT_INVALID', scope, 'raw output must declare PASS, FAIL, or UNVERIFIED');
        } else if (rawRecord.get('result') !== 'PASS') {
          addGap('DELIVERY_RESULT_NOT_PASS', scope, `raw output for ${caseId} is ${rawRecord.get('result')}`);
        } else {
          rawReady = true;
        }
      }
    }
    let reviewReady = verifyReview(item.review, `${scope} review`);
    if (reviewReady && isObject(item.review?.source)) {
      const reviewText = readSource(item.review.source, `${scope} review`);
      if (reviewText !== null) {
        const { fields: reviewRecord, duplicates: reviewDuplicates } = parseRecord(reviewText);
        const rawPath = resolveReference(item.raw?.path ?? '');
        if (
          reviewDuplicates.length > 0
          ||
          reviewRecord.get('Decision') !== 'ACCEPT'
          || reviewRecord.get('Reviewed case') !== caseId
          || reviewRecord.get('Raw evidence') !== rawPath
        ) {
          addGap('DELIVERY_REVIEW_EVIDENCE_MISMATCH', scope, `review must ACCEPT and name ${caseId} with its exact raw evidence path`);
          reviewReady = false;
        }
      }
    }
    if (
      caseId
      && item.result === 'pass'
      && rawReady
      && reviewReady
      && hasTextArray(item.clauseIds)
      && item.clauseIds.every(clauseId => clauseMap.has(clauseId))
    ) {
      acceptedByCase.set(caseId, item);
    }
  }

  for (const item of coverage.behaviors.values()) {
    if (item.applicable !== true) continue;
    const allowCase = isObject(item.allowCase) ? item.allowCase.id : null;
    const denyCase = isObject(item.denyCase) ? item.denyCase.id : null;
    for (const caseId of [allowCase, denyCase]) {
      const accepted = acceptedByCase.get(caseId);
      if (!accepted) {
        addGap('DELIVERY_CASE_EVIDENCE_MISSING', caseId ?? item.id, `accepted evidence is missing for ${caseId ?? item.id}`);
        continue;
      }
      const clauseIds = Array.isArray(item.clauseIds) ? item.clauseIds : [];
      if (!clauseIds.every(clauseId => accepted.clauseIds.includes(clauseId))) {
        addGap('DELIVERY_CASE_CLAUSE_MISMATCH', caseId, `evidence ${caseId} does not cover the behavior clause`);
      }
    }
  }

  return [...acceptedByCase.values()].map(item => ({
    caseId: item.caseId,
    clauseIds: item.clauseIds,
    result: item.result,
    raw: item.raw,
    review: item.review,
  }));
}

function validate(contract, stage) {
  const gaps = [];
  const addGap = (code, scope, message) => gaps.push({ code, scope, message });
  const sourceCache = new Map();

  function readSource(reference, scope) {
    if (!isObject(reference)) {
      addGap('SOURCE_MISSING', scope, `${scope} has no source reference`);
      return null;
    }
    if (!hasText(reference.path)) {
      addGap('SOURCE_PATH_MISSING', scope, `${scope} source has no path`);
      return null;
    }
    if (!hasText(reference.quote)) {
      addGap('SOURCE_QUOTE_MISSING', scope, `${scope} source has no quote`);
      return null;
    }
    const path = resolveReference(reference.path);
    let text;
    try {
      if (sourceCache.has(path)) {
        text = sourceCache.get(path);
      } else {
        text = readText(path);
        sourceCache.set(path, text);
      }
    } catch (error) {
      throw new UsageError(`cannot read source for ${scope} at ${path}: ${error.message}`);
    }
    if (!text.includes(reference.quote)) {
      addGap('SOURCE_QUOTE_MISSING', scope, `${scope} quote is not present in ${path}`);
      return null;
    }
    return text;
  }

  function verifySource(reference, scope) {
    return readSource(reference, scope) !== null;
  }

  function verifyReview(review, scope) {
    if (!isObject(review)) {
      addGap('REVIEW_MISSING', scope, `${scope} is missing`);
      return false;
    }
    if (!hasText(review.scope)) addGap('REVIEW_SCOPE_MISSING', scope, `${scope} has no scope`);
    if (review.decision !== 'ACCEPT') {
      addGap('REVIEW_NOT_ACCEPTED', scope, `${scope} decision is not ACCEPT`);
      return false;
    }
    const text = readSource(review.source, scope);
    if (text === null) return false;
    const { fields: record, duplicates } = parseRecord(text);
    if (duplicates.length > 0) {
      addGap('REVIEW_CONTENT_MISMATCH', scope, `${scope} repeats field ${duplicates[0]}`);
      return false;
    }
    if (record.get('Decision') !== review.decision || record.get('Scope') !== review.scope) {
      addGap('REVIEW_CONTENT_MISMATCH', scope, `${scope} source must contain the declared decision and scope`);
      return false;
    }
    return true;
  }

  if (!isObject(contract)) throw new UsageError('ontology-governance block must contain a JSON object');
  if (contract.ontology_version !== 1) {
    addGap('ONTOLOGY_VERSION_UNSUPPORTED', null, 'ontology_version must be 1');
  }

  const definitions = validateDefinitions(contract, addGap, verifySource);
  const coverage = validateCoverage(contract, addGap);
  if (!hasText(coverage.capability.id)) addGap('CAPABILITY_ID_MISSING', null, 'capability id is missing');
  if (!hasText(coverage.capability.scope)) addGap('CAPABILITY_SCOPE_MISSING', null, 'capability scope is missing');
  verifySource(coverage.capability.contractSource, 'capability contract');
  validateApplicableCoverage(coverage, addGap, verifyReview);

  const referencedClauseIds = collectReferencedClauseIds(coverage);
  const graph = loadGraph(contract, addGap);
  const clauseMap = validateClauses(
    contract,
    definitions,
    referencedClauseIds,
    addGap,
    verifySource,
    graph,
  );
  for (const item of coverage.behaviors.values()) {
    if (item.applicable !== true) continue;
    for (const id of Array.isArray(item.clauseIds) ? item.clauseIds : []) {
      const clause = clauseMap.get(id);
      if (!clause) continue; // Unknown clauses are reported by validateClauses.
      if (clause.axis !== 'behavior' || clause.axisId !== item.id) {
        addGap('BEHAVIOR_CLAUSE_AXIS_MISMATCH', item.id, `clause ${id} does not govern behavior ${item.id}`);
      }
      for (const field of ['allowCase', 'denyCase']) {
        if (item[field]?.id !== clause.governance?.[field]) {
          addGap('BEHAVIOR_CLAUSE_CASE_MISMATCH', item.id, `${field} must match clause ${id}`);
        }
      }
    }
  }
  validateAuthority(contract, addGap, verifySource);
  validateDesignReview(contract, addGap, verifyReview);

  let reviewedEvidence = [];
  if (stage === 'delivery') {
    reviewedEvidence = validateDeliveryEvidence(
      contract,
      coverage,
      clauseMap,
      addGap,
      readSource,
      verifyReview,
    );
  }

  const candidateClauses = [...clauseMap.values()]
    .filter(clause => clause.approval?.state !== 'approved')
    .map(clause => clause.id);

  return {
    scope: hasText(contract.capability?.id) ? contract.capability.id : null,
    stage,
    decision: gaps.length === 0 ? 'admitted' : 'rejected',
    behavior_verified: false,
    reviewed_behavior_evidence: reviewedEvidence,
    candidate_clauses: candidateClauses,
    gaps,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const contractPath = resolveReference(args.contract);
  let markdown;
  try {
    markdown = readText(contractPath);
  } catch (error) {
    throw new UsageError(`cannot read contract ${contractPath}: ${error.message}`);
  }
  const contract = extractGovernanceBlock(markdown, contractPath);
  const result = validate(contract, args.stage);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.decision === 'admitted' ? 0 : 1;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ontology governance gate: ${message}\n`);
  process.exitCode = 2;
}
