#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readFile, mkdir, realpath, writeFile } from "node:fs/promises";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const THRESHOLDS_PATH = resolve(
  REPO_ROOT,
  "tests/fixtures/unified-64-slot/feature-thresholds-r-unified-step-encoder-v2.json",
);

export const TSJS_COMPUTED_A1_MATERIALIZE_SCHEMA =
  "nnanything.tsjs.computed-a1-observe-materialize.v1";
export const TSJS_COMPUTED_A1_REPLAY_SCHEMA =
  "nnanything.tsjs.computed-a1-observe-replay.v1";
export const TSJS_COMPUTED_A1_LEAKAGE_SCHEMA =
  "nnanything.tsjs.computed-a1-observe-leakage.v1";

const OLD_TRAIN_ADMISSION_GROUPS = Object.freeze([
  "tsjs-train-module-export-alias-a",
  "tsjs-train-closure-call-a",
  "tsjs-train-runtime-helper-selector-r1",
  "tsjs-train-retention-contrast-r1",
  "tsjs-train-lexical-declaration-contrast-r1-20261113",
]);

const REQUIRED_MATRIX_FIELDS = Object.freeze([
  "cell",
  "source_family_id",
  "repo_root",
  "caller_file",
  "source_file",
  "call_site_ref",
  "symbol_name",
  "selector_form",
  "read_set",
  "semantic_proof_ref",
  "partition",
]);

const POSITIVE_CELLS = new Set(["TRAIN-P1", "TRAIN-P2", "TRAIN-P3", "TRAIN-P4"]);
const CONTROL_CELLS = new Set(["TRAIN-N1", "TRAIN-N2"]);
const DEV_CELLS = new Set(["DEV-P1", "DEV-P2", "DEV-N1"]);

const ALLOWED_CELL_PARTITIONS = Object.freeze([
  ...[...POSITIVE_CELLS].map(cell => [cell, "TRAIN"]),
  ...[...CONTROL_CELLS].map(cell => [cell, "TRAIN"]),
  ...[...DEV_CELLS].map(cell => [cell, "DEV"]),
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(message) {
  throw new TypeError(message);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
    fail(`${label} must be a non-empty string array`);
  }
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireRecordArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !isRecord(item))) {
    fail(`${label} must be a non-empty object array`);
  }
  return value;
}

async function resolveSourceFile(repoRoot, relativePath, label) {
  if (isAbsolute(relativePath)) fail(`${label} must be repository-relative`);
  const root = await realpath(repoRoot);
  const path = await realpath(resolve(root, relativePath));
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    fail(`${label} escapes the admitted repository root`);
  }
  return path;
}

async function resolveAdmittedRepoRoot(matrixPath, repoRoot) {
  const sourceBase = await realpath(join(dirname(resolve(matrixPath)), "sources"));
  const actualRoot = await realpath(repoRoot);
  const fromSourceBase = relative(sourceBase, actualRoot);
  if (
    fromSourceBase === ""
    || fromSourceBase === ".."
    || fromSourceBase.startsWith(`..${sep}`)
    || isAbsolute(fromSourceBase)
  ) {
    fail(`repo_root ${repoRoot} must be a family directory under the matrix sources directory`);
  }
  return actualRoot;
}

function hasExportModifier(node) {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function findTopLevelVariable(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
    }
  }
  return null;
}

function lineColumnAt(sourceFile, position) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function parseCallSiteRef(value, expectedFile) {
  const match = /^call:([^@]+)@(\d+):(\d+)-(\d+):(\d+)$/.exec(value);
  if (match === null || match[1] !== expectedFile) {
    fail(`call site ${value} must address ${expectedFile} with a concrete span`);
  }
  return {
    startLine: Number(match[2]),
    startColumn: Number(match[3]),
    endLine: Number(match[4]),
    endColumn: Number(match[5]),
  };
}

function approvedOperand(node) {
  if (ts.isStringLiteral(node)) return { kind: "string_literal", value: node.text };
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: "no_substitution_template_literal", value: node.text };
  }
  return null;
}

export function assertCallerSourceAdmission(entry, callerText, sourceText, record) {
  const callerFile = ts.createSourceFile(
    entry.caller_file,
    callerText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sourceFile = ts.createSourceFile(
    entry.source_file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sourceStem = entry.source_file.replace(/\.(?:tsx?|jsx?)$/u, "");
  const expectedModuleSpecifier = `./${sourceStem}`;
  let importedSymbolCount = 0;
  for (const statement of callerFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (namedBindings === undefined || !ts.isNamedImports(namedBindings)) continue;
    const moduleSpecifier = ts.isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    for (const element of namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName !== entry.symbol_name) continue;
      if (element.propertyName !== undefined) {
        fail(`family ${entry.source_family_id} must use an unaliased named import for ${entry.symbol_name}`);
      }
      if (moduleSpecifier !== expectedModuleSpecifier) {
        fail(`family ${entry.source_family_id} must import ${entry.symbol_name} from ${expectedModuleSpecifier}`);
      }
      importedSymbolCount += 1;
    }
  }
  if (importedSymbolCount !== 1) {
    fail(`family ${entry.source_family_id} must have exactly one unaliased named import for ${entry.symbol_name}`);
  }
  const actualDeclarations = sourceFile.statements.filter(statement =>
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === entry.symbol_name
    && hasExportModifier(statement)
  );
  if (actualDeclarations.length !== 1) {
    fail(`family ${entry.source_family_id} must contain one exported function ${entry.symbol_name}`);
  }
  const requestedName = requireString(
    record.request?.requestedDeclaration?.name,
    `admitted requested declaration name for ${entry.source_family_id}`,
  );
  const requestedDeclarations = sourceFile.statements.filter(statement =>
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === requestedName
    && hasExportModifier(statement)
  );
  if (requestedDeclarations.length !== 1) {
    fail(`family ${entry.source_family_id} requested declaration ${requestedName} is not exported by ${entry.source_file}`);
  }

  const expectedSpan = parseCallSiteRef(entry.call_site_ref, entry.caller_file);
  const matchingCalls = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const start = lineColumnAt(callerFile, node.getStart(callerFile));
      const end = lineColumnAt(callerFile, node.end);
      if (
        start.line === expectedSpan.startLine
        && start.column === expectedSpan.startColumn
        && end.line === expectedSpan.endLine
        && end.column === expectedSpan.endColumn
      ) {
        matchingCalls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(callerFile);
  if (matchingCalls.length !== 1) {
    fail(`family ${entry.source_family_id} call site ${entry.call_site_ref} must identify exactly one call expression`);
  }
  const call = matchingCalls[0];
  let callee = call.expression;
  while (ts.isCallExpression(callee)) callee = callee.expression;
  if (!ts.isElementAccessExpression(callee)) {
    fail(`family ${entry.source_family_id} call site must use an element access join`);
  }
  const tableName = callee.expression.getText(callerFile);
  const selectorName = callee.argumentExpression?.getText(callerFile);
  const tableDeclaration = findTopLevelVariable(callerFile, tableName);
  const selectorDeclaration = selectorName === undefined
    ? null
    : findTopLevelVariable(callerFile, selectorName);
  if (
    tableDeclaration === null
    || tableDeclaration.initializer === undefined
    || !ts.isObjectLiteralExpression(tableDeclaration.initializer)
    || selectorDeclaration === null
    || selectorDeclaration.initializer === undefined
  ) {
    fail(`family ${entry.source_family_id} must join the imported symbol through a declared table and selector`);
  }
  const tableMembers = tableDeclaration.initializer.properties.filter(property => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === entry.symbol_name;
    if (!ts.isPropertyAssignment(property)) return false;
    const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : null;
    return propertyName === entry.symbol_name
      && ts.isIdentifier(property.initializer)
      && property.initializer.text === entry.symbol_name;
  });
  if (tableMembers.length !== 1) {
    fail(`family ${entry.source_family_id} table must contain exactly one ${entry.symbol_name} join`);
  }
  const selectorExpression = selectorDeclaration.initializer;
  if (
    !ts.isBinaryExpression(selectorExpression)
    || selectorExpression.operatorToken.kind !== ts.SyntaxKind.PlusToken
  ) {
    fail(`family ${entry.source_family_id} selector must use exactly one binary plus`);
  }
  const left = approvedOperand(selectorExpression.left);
  const right = approvedOperand(selectorExpression.right);
  if (left === null || right === null) {
    fail(`family ${entry.source_family_id} selector operands are not approved literal forms`);
  }
  const expectedOperandKinds = entry.selector_form === "string_literal + string_literal"
    ? ["string_literal", "string_literal"]
    : entry.selector_form === "string_literal + no_substitution_template_literal"
      ? ["string_literal", "no_substitution_template_literal"]
      : null;
  if (expectedOperandKinds === null || expectedOperandKinds[0] !== left.kind || expectedOperandKinds[1] !== right.kind) {
    fail(`family ${entry.source_family_id} selector_form does not match the caller expression`);
  }
  if (`${left.value}${right.value}` !== entry.symbol_name) {
    fail(`family ${entry.source_family_id} selector value does not equal ${entry.symbol_name}`);
  }
  const positiveCell = POSITIVE_CELLS.has(entry.cell) || DEV_CELLS.has(entry.cell) && entry.cell !== "DEV-N1";
  const shouldMatch = new Set(["TRAIN-P1", "TRAIN-P3", "DEV-P1"]).has(entry.cell);
  if (positiveCell && shouldMatch !== (requestedName === entry.symbol_name)) {
    fail(`family ${entry.source_family_id} requested declaration match state disagrees with ${entry.cell}`);
  }
  return {
    requestedName,
    selectorExpression: selectorExpression.getText(callerFile),
  };
}

export async function assertSourceFamilyAdmission({ entry, matrixPath, record }) {
  const repoRoot = await resolveAdmittedRepoRoot(matrixPath, entry.repo_root);
  const proofPath = await resolveSourceFile(dirname(matrixPath), entry.semantic_proof_ref, "semantic_proof_ref");
  const callerPath = await resolveSourceFile(repoRoot, entry.caller_file, "caller_file");
  const sourcePath = await resolveSourceFile(repoRoot, entry.source_file, "source_file");
  const [callerText, sourceText, proofText] = await Promise.all([
    readFile(callerPath, "utf8"),
    readFile(sourcePath, "utf8"),
    readFile(proofPath, "utf8"),
  ]);
  const sourceFacts = assertCallerSourceAdmission(entry, callerText, sourceText, record);
  const proofTextForReferences = proofText.replaceAll("\\`", "`");
  for (const requiredReference of [
    entry.source_family_id,
    entry.caller_file,
    entry.source_file,
    entry.call_site_ref,
    entry.symbol_name,
    entry.partition,
    sourceFacts.requestedName,
    sourceFacts.selectorExpression,
  ]) {
    if (!proofTextForReferences.includes(requiredReference)) {
      fail(`semantic proof ${entry.semantic_proof_ref} does not reference ${requiredReference}`);
    }
  }
  return true;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function futureLeakageError(path, key) {
  const error = new TypeError(
    `${path}.${key} is future observation leakage; producer evidence belongs outside student records`,
  );
  error.code = "A1_OBSERVE_LEAKAGE";
  error.path = path;
  error.key = key;
  return error;
}

export function detectFutureObservationLeakage(value, path = "student") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => detectFutureObservationLeakage(item, `${path}[${index}]`));
    return false;
  }
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:A_g|gold|teacher|oracle|originalLabel|recomputed|selectedDeclaration|selectedMember|producerReceipt|producerEvidence|admittedObservation|nextJudge|executeObservation|resolvedSourceModule|selectedSourceModule)$/i.test(key)) {
      throw futureLeakageError(path, key);
    }
    detectFutureObservationLeakage(nested, `${path}.${key}`);
  }
  return false;
}

export function assertPreStepStudentRecord(record) {
  const owned = requireRecord(record, "record");
  detectFutureObservationLeakage(owned, "student");
  const requested = requireRecord(owned.request, "record.request");
  const requestedDeclaration = requireRecord(
    requested.requestedDeclaration,
    "record.request.requestedDeclaration",
  );
  requireString(requestedDeclaration.declarationRef, "requestedDeclaration.declarationRef");
  const relationObligation = requireRecord(
    requested.relationObligation,
    "record.request.relationObligation",
  );
  requireString(relationObligation.pendingRelationRef, "relationObligation.pendingRelationRef");
  requireString(relationObligation.callSiteRef, "relationObligation.callSiteRef");
  const steps = requireRecordArray(owned.steps, "record.steps");
  if (steps.length !== 1) fail("A1 source family must begin with one pre-observe step");
  if (Array.isArray(owned.receipts) && owned.receipts.length !== 0) {
    fail("pre-observe student record must not contain execution receipts");
  }
  for (const [index, step] of steps.entries()) {
    requireString(step.stepId, `steps[${index}].stepId`);
    requireRecord(step.localSyntax, `steps[${index}].localSyntax`);
    const obligations = step.remainingObligations ?? [];
    requireStringArray(
      obligations.map(obligation => obligation.ref).filter(ref => typeof ref === "string" && ref.length > 0),
      `steps[${index}].remainingObligations refs`,
    );
    if (step.sourceCandidateRefs !== undefined) {
      requireStringArray(step.sourceCandidateRefs, `steps[${index}].sourceCandidateRefs`);
    }
    if (step.currentRelation?.binding?.state !== "not_observed") {
      fail(`steps[${index}] must retain an unresolved pre-observe relation`);
    }
    if (Array.isArray(step.receipts) && step.receipts.length !== 0) {
      fail(`steps[${index}] must not contain execution receipts`);
    }
  }
  return true;
}

export function assertFamilyAdmission({ entry, manifest, record }) {
  if (manifest.sourceGroup !== entry.source_family_id || manifest.partition !== entry.partition) {
    fail(`admitted manifest identity does not match family ${entry.source_family_id}`);
  }
  if (
    record.sourceGroup !== entry.source_family_id
    || record.partition !== entry.partition
    || record.sampleId !== entry.source_family_id
  ) {
    fail(`admitted pre-step record identity does not match family ${entry.source_family_id}`);
  }
  const requested = requireRecord(record.request?.requestedDeclaration, "admitted requestedDeclaration");
  const requestedName = requireString(
    requested.name,
    `admitted requestedDeclaration.name for ${entry.source_family_id}`,
  );
  if (
    requested.declarationRef !== `decl:${entry.source_file}#top:${requestedName}`
    || requested.moduleRef !== `module:${entry.source_file}`
  ) {
    fail(`admitted requested declaration does not match matrix for family ${entry.source_family_id}`);
  }
  const relation = requireRecord(record.request?.relationObligation, "admitted relationObligation");
  if (
    relation.callSiteRef !== entry.call_site_ref
    || relation.calleeName !== entry.symbol_name
  ) {
    fail(`admitted call site does not match matrix for family ${entry.source_family_id}`);
  }
  if (record.entryFile !== entry.caller_file) {
    fail(`admitted entry file does not match matrix for family ${entry.source_family_id}`);
  }
  const files = requireStringArray(entry.read_set.files, `matrix ${entry.cell}.read_set.files`);
  if (
    files.length !== 2
    || new Set(files).size !== 2
    || !files.includes(entry.caller_file)
    || !files.includes(entry.source_file)
  ) {
    fail(`read set for family ${entry.source_family_id} must contain only caller and source files`);
  }
  if (entry.read_set.callerFile !== entry.caller_file || entry.read_set.language !== "typescript") {
    fail(`read set metadata does not match matrix source family ${entry.source_family_id}`);
  }
  if (
    !Array.isArray(entry.read_set.grantedEffects)
    || entry.read_set.grantedEffects.length !== 1
    || entry.read_set.grantedEffects[0] !== "read_only"
  ) {
    fail(`family ${entry.source_family_id} must have only the declared read_only effect`);
  }
  return true;
}

export function decideGoldFromPreStep(input) {
  const owned = requireRecord(input, "input");
  const cell = requireString(owned.cell, "cell");
  const episode = requireRecord(owned.episode, "episode");
  const candidateRefs = requireStringArray(owned.candidateRefs, "candidateRefs");
  const isControl = CONTROL_CELLS.has(cell) || cell === "DEV-N1";
  const isPositive = POSITIVE_CELLS.has(cell) || cell === "DEV-P1" || cell === "DEV-P2";
  if (!isControl && !isPositive) fail(`unknown A1 cell ${cell}`);
  const obligations = episode.remainingObligations ?? [];
  const observeObligations = obligations.filter(
    obligation => isRecord(obligation)
      && obligation.kind === "observe"
      && typeof obligation.ref === "string"
      && obligation.ref.length > 0,
  );
  if (isPositive) {
    if (observeObligations.length !== 1) fail(`cell ${cell} requires exactly one observe obligation`);
    const observeObligation = observeObligations[0];
    const observeCandidateRef = `c:observe:${observeObligation.ref}`;
    const pendingRelationRef = requireString(
      observeObligation.pendingRelationRef,
      "observe obligation pendingRelationRef",
    );
    if (
      episode.pendingRelationRef !== undefined
      && episode.pendingRelationRef !== pendingRelationRef
    ) {
      fail("positive cell observe obligation must match the episode pending relation");
    }
    if (observeObligation.informationGain !== 1) {
      fail(`cell ${cell} requires positive pre-step information gain`);
    }
    const expectedPositiveCandidates = [
      "c:judge:true",
      "c:judge:false",
      "c:judge:unknown",
      observeCandidateRef,
      "c:defer",
    ];
    if (
      candidateRefs.length !== expectedPositiveCandidates.length
      || expectedPositiveCandidates.some((ref, index) => candidateRefs[index] !== ref)
    ) {
      fail(`cell ${cell} must retain the exact positive runtime candidate order`);
    }
    const producerEvidence = owned.producerEvidence;
    if (producerEvidence !== undefined) {
      const evidenceRecord = requireRecord(producerEvidence, "producerEvidence");
      if (evidenceRecord.rejected !== true) {
        if (requireString(evidenceRecord.selectedDeclarationRef, "producerEvidence.selectedDeclarationRef") === requireString(evidenceRecord.requestedDeclarationRef, "producerEvidence.requestedDeclarationRef")) {
          fail("producer evidence cannot be admitted inside positive student materialization");
        }
      }
    }
    return Object.freeze({
      kind: "positive",
      A_g: Object.freeze([observeCandidateRef]),
      labelAuthority: "accepted_a1_semantic_contract+pre_step_eligibility",
      oracleKind: "pre_step_observe_eligibility",
    });
  }
  if (cell === "TRAIN-N1" && observeObligations.length !== 0) {
    fail("TRAIN-N1 must have no matching observe obligation");
  }
  if (observeObligations.length > 0) {
    if (observeObligations.length !== 1) fail("control must have at most one observe obligation");
    const observeObligation = observeObligations[0];
    const gain = observeObligation.informationGain;
    if (!isRecord(gain) || gain.state !== "known" || gain.value !== "none") {
      fail("control with an observe obligation must have pre-step known none gain");
    }
  }
  if (candidateRefs.some(ref => typeof ref === "string" && ref.startsWith("c:observe:"))) {
    fail("control must not contain an observe candidate");
  }
  const expectedControlCandidates = [
    "c:judge:true",
    "c:judge:false",
    "c:judge:unknown",
    "c:return",
  ];
  if (
    candidateRefs.length !== expectedControlCandidates.length
    || expectedControlCandidates.some((ref, index) => candidateRefs[index] !== ref)
  ) {
    fail("control must retain the exact control runtime candidate order");
  }
  return Object.freeze({
    kind: "control",
    A_g: Object.freeze(["c:judge:unknown"]),
    labelAuthority: "accepted_a1_semantic_contract+pre_step_control",
    oracleKind: "pre_step_no_observe",
  });
}

export function reconcileOldReplay(input) {
  const owned = requireRecord(input, "input");
  const admissions = requireRecord(owned.admissions, "admissions");
  const familyAdmissions = requireRecordArray(admissions.familyAdmissions, "admissions.familyAdmissions");
  if (familyAdmissions.some(entry => entry.partition !== "TRAIN")) {
    fail("old TRAIN admissions contain a non-TRAIN family");
  }
  const admittedGroups = familyAdmissions.map(entry => requireString(entry.sourceGroup, "familyAdmissions.sourceGroup"));
  for (const sourceGroup of OLD_TRAIN_ADMISSION_GROUPS) {
    const admission = familyAdmissions.find(entry => entry.sourceGroup === sourceGroup);
    if (admission === undefined) fail(`old TRAIN replay is missing admission ${sourceGroup}`);
    if (requireString(admission.partition, "admission.partition") !== "TRAIN") fail(`old admission ${sourceGroup} must stay TRAIN`);
    if (requireBoolean(admission.usableForTrainingSupervision, "admission.usableForTrainingSupervision") !== true) {
      fail(`old admission ${sourceGroup} must remain usable for training`);
    }
  }
  if (admittedGroups.length !== new Set(admittedGroups).size) fail("old admissions contain duplicate source groups");
  const studentRows = requireRecordArray(owned.studentRows, "studentRows");
  const supervisionRows = requireRecordArray(owned.supervisionRows, "supervisionRows");
  const groupsBySupervision = new Map(supervisionRows.map(row => [
    requireString(row.group_id, "supervisionRow.group_id"),
    row,
  ]));
  if (groupsBySupervision.size !== supervisionRows.length) fail("old supervision rows contain duplicate group_id");
  const studentGroups = new Map();
  for (const row of studentRows) {
    const groupId = requireString(row.group_id, "studentRow.group_id");
    const group = studentGroups.get(groupId);
    if (group === undefined) {
      studentGroups.set(groupId, {
        sourceGroup: requireString(row.sourceGroup, "studentRow.sourceGroup"),
        partition: requireString(row.partition, "studentRow.partition"),
        candidates: [row],
      });
      continue;
    }
    if (group.sourceGroup !== requireString(row.sourceGroup, "studentRow.sourceGroup")) {
      fail(`old student group ${groupId} spans multiple source groups`);
    }
    if (group.partition !== requireString(row.partition, "studentRow.partition")) {
      fail(`old student group ${groupId} spans multiple partitions`);
    }
    group.candidates.push(row);
  }
  for (const [groupId, group] of studentGroups) {
    const supervision = groupsBySupervision.get(groupId);
    if (supervision === undefined) fail(`old TRAIN replay is missing supervision group ${groupId}`);
    if (supervision.partition !== group.partition || supervision.partition !== "TRAIN") {
      fail(`old group ${groupId} must stay TRAIN`);
    }
    if (supervision.sourceGroup !== group.sourceGroup) fail(`old group ${groupId} changed source group`);
    const allowed = requireStringArray(supervision.goldAllowedCandidateRefs, "supervisionRow.goldAllowedCandidateRefs");
    const candidates = group.candidates.map(candidate => requireString(candidate.candidateRef, "studentRow.candidateRef"));
    for (const ref of allowed) {
      if (!candidates.includes(ref)) fail(`old group ${groupId} allowed ref ${ref} is outside the candidate rows`);
    }
    if (group.candidates.some(candidate => candidate.x === undefined || !Array.isArray(candidate.x))) {
      fail(`old group ${groupId} candidate vector is missing`);
    }
  }
  for (const groupId of groupsBySupervision.keys()) {
    if (!studentGroups.has(groupId)) fail(`old supervision group ${groupId} has no student rows`);
  }
  return owned;
}

export function assertOldReplayCounts({ admissions, studentRows, supervisionRows, dataGateRows }) {
  if (!Array.isArray(admissions?.familyAdmissions)) {
    fail("old admissions.familyAdmissions must be an array");
  }
  const familyAdmissions = admissions.familyAdmissions;
  if (familyAdmissions.length !== 5) {
    fail(`old TRAIN replay must retain exactly 5 admissions, found ${familyAdmissions.length}`);
  }
  const student = requireRecordArray(studentRows, "old studentRows");
  if (student.length !== 95) {
    fail(`old TRAIN replay must retain exactly 95 student rows, found ${student.length}`);
  }
  const supervision = requireRecordArray(supervisionRows, "old supervisionRows");
  const supervisionGroups = new Set(
    supervision.map(row => requireString(row.group_id, "old supervisionRow.group_id")),
  );
  if (supervision.length !== 22 || supervisionGroups.size !== 22) {
    fail(
      `old TRAIN replay must retain exactly 22 supervision groups, found rows=${supervision.length} groups=${supervisionGroups.size}`,
    );
  }
  const dataGate = requireRecordArray(dataGateRows, "old dataGateRows");
  if (dataGate.length !== 22) {
    fail(`old TRAIN replay must retain exactly 22 data-gate rows, found ${dataGate.length}`);
  }
  return true;
}

export function reconcilePreparedGroups(groups, supervisionRows) {
  if (!Array.isArray(groups) || groups.length === 0) fail("prepared groups must be non-empty");
  if (!Array.isArray(supervisionRows) || supervisionRows.length !== groups.length) {
    fail("prepared supervision must contain exactly one row per student group");
  }
  const groupsById = new Map();
  for (const group of groups) {
    const groupId = requireString(group.group_id, "prepared group.group_id");
    if (groupsById.has(groupId)) fail(`prepared student groups contain duplicate group_id ${groupId}`);
    groupsById.set(groupId, group);
  }
  const supervisionById = new Map();
  for (const row of supervisionRows) {
    const groupId = requireString(row.group_id, "prepared supervision.group_id");
    if (supervisionById.has(groupId)) fail(`prepared supervision contains duplicate group_id ${groupId}`);
    supervisionById.set(groupId, row);
  }
  if (groupsById.size !== supervisionById.size) {
    fail("prepared student and supervision group counts do not match");
  }
  for (const [groupId, group] of groupsById) {
    const supervision = supervisionById.get(groupId);
    if (supervision === undefined) fail(`prepared supervision is missing group ${groupId}`);
    if (
      supervision.partition !== group.partition
      || supervision.sourceGroup !== group.sourceGroup
      || supervision.sampleId !== group.sampleId
      || supervision.stepId !== group.stepId
      || supervision.requestRef !== group.requestRef
    ) {
      fail(`prepared supervision join fields disagree for ${groupId}`);
    }
    if (supervision.trainingEligible !== (group.partition === "TRAIN")) {
      fail(`prepared training eligibility disagrees with partition for ${groupId}`);
    }
    const candidateRefs = group.candidates.map(candidate => candidate.candidateRef);
    const allowed = requireStringArray(supervision.goldAllowedCandidateRefs, `supervision ${groupId}.A_g`);
    if (allowed.length === 0 || allowed.some(ref => !candidateRefs.includes(ref))) {
      fail(`prepared A_g must be non-empty and within S_g for ${groupId}`);
    }
  }
  for (const groupId of supervisionById.keys()) {
    if (!groupsById.has(groupId)) fail(`prepared supervision has no student group ${groupId}`);
  }
  return true;
}

export function assertStudentRowsArePreStep(rows, groups) {
  const groupsById = new Map(groups.map(group => [group.group_id, group]));
  const seen = new Map();
  for (const row of rows) {
    detectFutureObservationLeakage(row, `studentRows.${row.group_id}.${row.candidateRef}`);
    const group = groupsById.get(row.group_id);
    if (group === undefined) continue;
    const expectedEvidence = group.evidenceRefs;
    if (!sameJson(row.evidenceRefs, expectedEvidence)) {
      fail(`student row ${row.group_id} contains evidence outside retained pre-step references`);
    }
    const prior = seen.get(row.group_id) ?? [];
    prior.push(row.candidateRef);
    seen.set(row.group_id, prior);
  }
  for (const group of groups) {
    const actual = seen.get(group.group_id) ?? [];
    const expected = group.candidates.map(candidate => candidate.candidateRef);
    if (!sameJson(actual, expected)) {
      fail(`student rows for ${group.group_id} do not derive from the retained candidate group`);
    }
  }
  return true;
}

export async function readJsonl(path, label) {
  const text = await readFile(path, "utf8");
  return text.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return [];
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) fail(`${label} line ${index + 1} must be an object`);
      return [parsed];
    } catch (error) {
      if (error.code === undefined && error.message.startsWith(`${label} line`)) throw error;
      fail(`${label} line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export async function readJsonFile(path, label) {
  const text = await readFile(path, "utf8");
  try {
    return requireRecord(JSON.parse(text), label);
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} ${path} is invalid JSON: ${error.message}`);
    throw error;
  }
}

export function validateMatrixEntry(entry, index) {
  const path = `matrix[${index}]`;
  requireRecord(entry, path);
  for (const field of REQUIRED_MATRIX_FIELDS) {
    if (entry[field] === undefined) fail(`${path}.${field} is required`);
  }
  const cell = requireString(entry.cell, `${path}.cell`);
  const allowed = ALLOWED_CELL_PARTITIONS.find(([allowedCell]) => allowedCell === cell);
  if (allowed === undefined) fail(`${path}.cell ${cell} is not an accepted A1 cell`);
  const [, partition] = allowed;
  if (requireString(entry.partition, `${path}.partition`).toUpperCase() !== partition) {
    fail(`${path}.partition ${entry.partition} does not match cell ${cell}`);
  }
  const sourceFamilyId = requireString(entry.source_family_id, `${path}.source_family_id`);
  const expectedFamilyId = `tsjs-computed-a1-${cell.toLowerCase()}`;
  if (sourceFamilyId !== expectedFamilyId) {
    fail(`${path}.source_family_id must be ${expectedFamilyId}`);
  }
  requireString(entry.repo_root, `${path}.repo_root`);
  requireString(entry.caller_file, `${path}.caller_file`);
  requireString(entry.source_file, `${path}.source_file`);
  requireString(entry.call_site_ref, `${path}.call_site_ref`);
  requireString(entry.symbol_name, `${path}.symbol_name`);
  requireString(entry.selector_form, `${path}.selector_form`);
  const readSet = requireRecord(entry.read_set, `${path}.read_set`);
  if (readSet.files !== undefined) requireStringArray(readSet.files, `${path}.read_set.files`);
  requireString(entry.semantic_proof_ref, `${path}.semantic_proof_ref`);
}

export function assertAcceptedCellCoverage(families) {
  const actual = families.map(entry => entry.cell);
  const expected = ALLOWED_CELL_PARTITIONS.map(([cell]) => cell);
  if (
    actual.length !== expected.length
    || new Set(actual).size !== actual.length
    || expected.some(cell => !actual.includes(cell))
  ) {
    fail(`matrix must contain each accepted A1 cell exactly once: ${expected.join(", ")}`);
  }
  return true;
}

export async function assertSourceMatrixDisjointness(families) {
  const files = new Map();
  const symbols = new Map();
  const callSites = new Map();
  const authoredTemplates = new Map();
  for (const entry of families) {
    const family = entry.source_family_id;
    for (const file of [entry.caller_file, entry.source_file]) {
      const absoluteFile = resolve(entry.repo_root, file);
      const previous = files.get(absoluteFile);
      if (previous !== undefined && previous !== family) {
        fail(`source file ${absoluteFile} is shared by ${previous} and ${family}`);
      }
      files.set(absoluteFile, family);
    }
    const previousSymbol = symbols.get(entry.symbol_name);
    if (previousSymbol !== undefined && previousSymbol !== family) {
      fail(`source symbol ${entry.symbol_name} is shared by ${previousSymbol} and ${family}`);
    }
    symbols.set(entry.symbol_name, family);
    const callSiteKey = `${resolve(entry.repo_root)}|${entry.call_site_ref}`;
    const previousCallSite = callSites.get(callSiteKey);
    if (previousCallSite !== undefined && previousCallSite !== family) {
      fail(`call site ${callSiteKey} is shared by ${previousCallSite} and ${family}`);
    }
    callSites.set(callSiteKey, family);

    const callerText = await readFile(resolve(entry.repo_root, entry.caller_file), "utf8");
    const sourceText = await readFile(resolve(entry.repo_root, entry.source_file), "utf8");
    const template = JSON.stringify({ callerText, sourceText });
    const previousTemplate = authoredTemplates.get(template);
    if (previousTemplate !== undefined && previousTemplate !== family) {
      fail(`authored source template is shared by ${previousTemplate} and ${family}`);
    }
    authoredTemplates.set(template, family);
  }
  return true;
}

function parseArgs(argv) {
  const required = ["--matrix", "--old-run", "--out"];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!required.includes(name)) {
      throw new TypeError(`unknown argument ${name}; expected ${required.join(", ")}`);
    }
    if (values.has(name)) throw new TypeError(`duplicate argument ${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new TypeError(`missing value for ${name}`);
    values.set(name, value);
    index += 1;
  }
  for (const name of required) {
    if (!values.has(name)) throw new TypeError(`missing required argument ${name}`);
  }
  return {
    matrixPath: values.get("--matrix"),
    oldRunPath: values.get("--old-run"),
    outPath: values.get("--out"),
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function studentRowsForRunner(groups) {
  return groups.flatMap(group =>
    group.candidates.map(candidate => ({
      schema: "nnanything.unified.student-row.v1",
      group_id: group.group_id,
      sampleId: group.sampleId,
      requestRef: group.requestRef,
      stepId: group.stepId,
      targetRef: group.targetRef,
      pendingRelationRef: group.pendingRelationRef,
      sourceGroup: group.sourceGroup,
      language: group.language,
      adapterRef: group.adapterRef,
      derivationFamily: group.derivationFamily,
      semanticStratum: group.semanticStratum,
      stepContextRef: group.stepContextRef,
      candidateGroupRef: group.candidateGroupRef,
      featureSchemaVersion: group.featureSchemaVersion,
      encoderVersion: group.encoderVersion,
      partition: group.partition,
      candidateEnumeration: group.candidateEnumeration,
      coverageCursorRef: group.coverageCursorRef,
      evidenceRefs: group.evidenceRefs,
      failureMode: group.failureMode,
      candidateRef: candidate.candidateRef,
      optionSemantics: candidate.optionSemantics,
      candidateKind: candidate.candidateKind,
      x: candidate.input,
      missingMode: candidate.missingMode,
    })));
}

function dataGateRowsForRunner(groups, supervisionRows, route) {
  const supervisionByGroup = new Map(supervisionRows.map(row => [row.group_id, row]));
  return groups.map(group => {
    const supervision = supervisionByGroup.get(group.group_id);
    if (supervision === undefined) fail(`missing supervision for ${group.group_id}`);
    const first = group.candidates[0];
    if (first === undefined) fail(`candidate set S_g is empty for ${group.group_id}`);
    if (group.partition === "VERIFICATION") fail(`data gate does not accept VERIFICATION group ${group.group_id}`);
    const candidates = group.candidates.map(candidate => candidate.candidateRef);
    const allowed = supervision.labelMissing ? candidates : supervision.goldAllowedCandidateRefs;
    return {
      schema: "nnanything.unified.data-row.v1",
      rowId: group.group_id,
      sourceGroup: group.sourceGroup,
      partition: group.partition,
      route,
      input: first.input,
      candidateInputs: group.candidates.map(candidate => ({
        candidateRef: candidate.candidateRef,
        input: candidate.input,
      })),
      missingMode: first.missingMode,
      candidates,
      allowed,
      gold: supervision.labelMissing ? "unknown" : (allowed[0] ?? "unknown"),
      labelMissing: supervision.labelMissing,
      enumeration: group.candidateEnumeration,
    };
  });
}

export function classifyProducerOutcome(producer, callSiteRef) {
  if (!isRecord(producer)) {
    return { outcome: "rejected", reason: "producer result must be an object", observation: null };
  }
  if (producer.status !== "ok") {
    const reason = typeof producer.reasonCode === "string" && producer.reasonCode.length > 0
      ? producer.reasonCode
      : "producer rejected without a reason code";
    return { outcome: "rejected", reason, observation: null };
  }
  const producerPayload = requireRecord(producer.result, "producer result");
  const forbiddenProducerFields = [
    "A_g",
    "gold",
    "candidateRefs",
    "candidateGroup",
    "studentRecord",
    "supervisionRecord",
  ];
  const attemptedMutation = forbiddenProducerFields.find(field =>
    Object.hasOwn(producerPayload, field)
  );
  if (attemptedMutation !== undefined) {
    return {
      outcome: "rejected",
      reason: `producer result attempted to mutate fixed student supervision via ${attemptedMutation}`,
      observation: null,
    };
  }
  const observations = producerPayload.constantComputedPropertyObservations;
  if (!Array.isArray(observations)) {
    return {
      outcome: "rejected",
      reason: "producer result has no constant-computed observation array",
      observation: null,
    };
  }
  const observation = observations.find(item =>
    isRecord(item) && item.callSiteRef === callSiteRef
  );
  if (observation === undefined) {
    return {
      outcome: "rejected",
      reason: "producer result has no matching constant-computed observation",
      observation: null,
    };
  }
  return { outcome: "success", reason: null, observation };
}

function loadProducer() {
  return null;
}

async function loadRuntimeOwners() {
  const [
    stepContextModule,
    studentModule,
    supervisionModule,
    packageModule,
    missingModeModule,
  ] = await Promise.all([
    import(pathToFileURL(join(REPO_ROOT, "dist/training/unified-step-context-builder.js")).href),
    import(pathToFileURL(join(REPO_ROOT, "dist/training/unified-student-converter.js")).href),
    import(pathToFileURL(join(REPO_ROOT, "dist/training/unified-supervision-converter.js")).href),
    import(pathToFileURL(join(REPO_ROOT, "dist/training/unified-model-package.js")).href),
    import(pathToFileURL(join(REPO_ROOT, "dist/training/unified-missing-mode.js")).href),
  ]);
  return {
    relationStepContext: stepContextModule.relationStepContext,
    convertEpisodeToStudentGroup: studentModule.convertEpisodeToStudentGroup,
    loadStepwiseEpisodeFamily: studentModule.loadStepwiseEpisodeFamily,
    loadStepwiseSupervisionFamily: supervisionModule.loadStepwiseSupervisionFamily,
    stepwiseSupervisionSchema: supervisionModule.STEPWISE_SUPERVISION_SCHEMA,
    stepwiseSupervisionFile: supervisionModule.STEPWISE_SUPERVISION_FILE,
    validateMissingModeConsistency: missingModeModule.validateMissingModeConsistency,
    loadUnifiedModelPackageFromFile: packageModule.loadUnifiedModelPackageFromFile,
  };
}

async function prepareFamily({ entry, matrixPath, thresholds, producer, validateMissingModeConsistency }) {
  const familyDir = join(entry.__out, entry.partition.toLowerCase(), entry.source_family_id);
  await mkdir(familyDir, { recursive: true });
  const manifest = await readJsonFile(join(entry.sourceDir, "manifest.json"), "admitted family manifest");
  if (manifest.sourceGroup !== entry.source_family_id || manifest.partition !== entry.partition) {
    fail(`admitted manifest identity does not match family ${entry.source_family_id}`);
  }
  await writeJson(join(familyDir, "manifest.json"), manifest);
  const requestRef = `request:${entry.source_family_id}`;
  const producerRequest = {
    repo: entry.repo_root,
    language: "typescript",
    scope: ["."],
    files: Array.isArray(entry.read_set.files) ? entry.read_set.files : [],
  };
  await writeJson(join(familyDir, "producer-request.json"), {
    producerRequest,
    declaredProducerSurface: "accepted_request_blind_tsjs_symbol_table_v1",
  });
  const admittedRecords = await readJsonl(join(entry.sourceDir, "student-observations.jsonl"), "admitted student observations");
  if (admittedRecords.length !== 1) {
    fail(`family ${entry.source_family_id} must have exactly one admitted pre-step record`);
  }
  const record = admittedRecords[0];
  assertPreStepStudentRecord(record);
  assertFamilyAdmission({ entry, manifest, record });
  await assertSourceFamilyAdmission({ entry, matrixPath, record });
  await writeJsonl(join(familyDir, "student-observations.jsonl"), [record]);
  const runtimeOwners = await loadRuntimeOwners();
  const episodes = await runtimeOwners.loadStepwiseEpisodeFamily(familyDir);
  if (episodes.length !== 1) fail(`family ${entry.source_family_id} must have one step`);
  const episode = episodes[0];
  const group = runtimeOwners.convertEpisodeToStudentGroup(episode, thresholds);
  for (const candidate of group.candidates) {
    const missingCheck = validateMissingModeConsistency(candidate.input, candidate.missingMode);
    if (!missingCheck.ok) {
      fail(
        `family ${entry.source_family_id} candidate ${candidate.candidateRef} has invalid missing mode: ${missingCheck.message}`,
      );
    }
  }
  const candidateRefs = group.candidates.map(candidate => candidate.candidateRef);
  const supervisionDecision = decideGoldFromPreStep({
    cell: entry.cell,
    episode,
    candidateRefs,
  });
  const admittedSupervision = await readJsonl(
    join(entry.sourceDir, runtimeOwners.stepwiseSupervisionFile),
    "admitted independent supervision",
  );
  if (admittedSupervision.length !== 1) {
    fail(`family ${entry.source_family_id} must have exactly one admitted supervision record`);
  }
  const admittedSupervisionRecord = requireRecord(
    admittedSupervision[0],
    `admitted supervision ${entry.source_family_id}`,
  );
  if (
    requireString(admittedSupervisionRecord.sampleId, "admitted supervision sampleId") !== record.sampleId
    || requireString(admittedSupervisionRecord.family, "admitted supervision family") !== record.family
    || requireString(admittedSupervisionRecord.requestRef, "admitted supervision requestRef") !== requestRef
  ) {
    fail(`admitted supervision identity for family ${entry.source_family_id} does not match the pre-step record`);
  }
  if (admittedSupervisionRecord.trainingEligible !== (entry.partition === "TRAIN")) {
    fail(`admitted supervision training eligibility disagrees for family ${entry.source_family_id}`);
  }
  const admittedStep = requireRecord(
    admittedSupervisionRecord.steps?.[0],
    `admitted supervision step ${entry.source_family_id}`,
  );
  if (requireString(admittedStep.stepId, "admitted supervision stepId") !== episode.stepId) {
    fail(`admitted supervision stepId for family ${entry.source_family_id} does not match the pre-step episode`);
  }
  const admittedSg = requireStringArray(admittedStep.S_g, "admitted supervision S_g");
  if (!sameJson(admittedSg, candidateRefs)) {
    fail(`admitted supervision S_g for family ${entry.source_family_id} disagrees with the runtime candidate group`);
  }
  const admittedAg = requireStringArray(admittedStep.A_g, "admitted supervision A_g");
  if (!sameJson(admittedAg, [...supervisionDecision.A_g])) {
    fail(`admitted supervision A_g for family ${entry.source_family_id} disagrees with pre-step gold decision`);
  }
  const admittedLabelAuthority = requireString(
    admittedStep.labelAuthority,
    "admitted supervision labelAuthority",
  );
  const admittedOracleKind = requireString(admittedStep.oracleKind, "admitted supervision oracleKind");
  const admittedUnknownReason = admittedStep.unknownReason === null || admittedStep.unknownReason === undefined
    ? null
    : requireString(admittedStep.unknownReason, "admitted supervision unknownReason");
  const supervisionRecord = {
    schemaVersion: runtimeOwners.stepwiseSupervisionSchema,
    sampleId: record.sampleId,
    family: record.family,
    requestRef,
    steps: [{
      stepId: episode.stepId,
      S_g: candidateRefs,
      A_g: [...supervisionDecision.A_g],
      agSubsetOfSg: true,
      labelAuthority: admittedLabelAuthority,
      oracleKind: admittedOracleKind,
      unknownReason: admittedUnknownReason,
    }],
    trainingEligible: entry.partition === "TRAIN",
    notReadyReason: null,
  };
  await writeJsonl(join(familyDir, runtimeOwners.stepwiseSupervisionFile), [supervisionRecord]);
  const supervisionRows = await runtimeOwners.loadStepwiseSupervisionFamily(familyDir);
  const preStepSnapshot = structuredClone({
    record,
    candidateRefs,
    episode,
    group,
    supervisionDecision,
    supervisionRecord,
    supervisionRows,
  });
  let producerOutcome = "unavailable";
  let producerReason = "accepted A1 producer is not integrated in this worktree";
  if (producer !== null && producer !== undefined) {
    try {
      const producerResult = await producer(producerRequest);
      const classified = classifyProducerOutcome(producerResult, entry.call_site_ref);
      producerOutcome = classified.outcome;
      producerReason = classified.reason;
      if (classified.outcome === "success") {
        const evidenceDir = join(entry.__out, "teacher-evidence", entry.source_family_id);
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(
          join(evidenceDir, "producer-result.json"),
          `${JSON.stringify(producerResult.result, null, 2)}\n`,
          "utf8",
        );
        await writeFile(
          join(evidenceDir, "producer-observation.json"),
          `${JSON.stringify(classified.observation, null, 2)}\n`,
          "utf8",
        );
      }
    } catch (error) {
      producerOutcome = "unavailable";
      producerReason = error instanceof Error ? error.message : String(error);
    }
  }
  const postStepSnapshot = structuredClone({
    record,
    candidateRefs,
    episode,
    group,
    supervisionDecision,
    supervisionRecord,
    supervisionRows,
  });
  if (!sameJson(postStepSnapshot, preStepSnapshot)) {
    fail(`family ${entry.source_family_id} changed pre-step facts during producer execution`);
  }
  detectFutureObservationLeakage(postStepSnapshot.record, "student");
  return {
    familyDir,
    group,
    supervisionRows,
    preStepSnapshot,
    candidateRefs,
    supervisionRecord,
    producerOutcome,
    producerReason,
  };
}

function resolveOldPackagePath(oldRun) {
  return `${oldRun}/candidate-package.json`;
}

export async function runMaterialization(parsedArgs, options = {}) {
  const args = parsedArgs;
  const matrixPath = resolve(args.matrixPath);
  const oldRunPath = resolve(args.oldRunPath);
  const outPath = resolve(args.outPath);
  const matrix = await readJsonFile(matrixPath, "matrix");
  if (matrix.runtimeRoot !== undefined) {
    fail("matrix.runtimeRoot is not accepted by this preparation surface; the producer owner must integrate the accepted A1 runtime in this worktree");
  }
  if (!Array.isArray(matrix.families) || matrix.families.length === 0) {
    fail("matrix.families must be a non-empty array");
  }
  matrix.families.forEach(validateMatrixEntry);
  assertAcceptedCellCoverage(matrix.families);
  await assertSourceMatrixDisjointness(matrix.families);
  const familyIds = matrix.families.map(entry => entry.source_family_id);
  if (familyIds.length !== new Set(familyIds).size) fail("matrix source_family_id values must be unique");
  const oldRun = oldRunPath;
  const oldAdmissions = await readJsonFile(`${oldRun}/corpus-admissions.train-only.json`, "old admissions");
  const oldStudentRows = await readJsonl(`${oldRun}/student-rows.jsonl`, "old student rows");
  const oldSupervisionRows = await readJsonl(`${oldRun}/supervision-rows.jsonl`, "old supervision rows");
  const oldDataGateRows = await readJsonl(`${oldRun}/data-gate-rows.jsonl`, "old data gate rows");
  const oldReplay = reconcileOldReplay({
    admissions: oldAdmissions,
    studentRows: oldStudentRows,
    supervisionRows: oldSupervisionRows,
  });
  assertOldReplayCounts({
    admissions: oldAdmissions,
    studentRows: oldStudentRows,
    supervisionRows: oldSupervisionRows,
    dataGateRows: oldDataGateRows,
  });
  const runtimeOwners = await loadRuntimeOwners();
  const producer = options.producer ?? loadProducer();
  const thresholdModule = await import(pathToFileURL(join(REPO_ROOT, "dist/training/unified-thresholds.js")).href);
  const { loadFeatureThresholdsFromFile } = thresholdModule;
  const thresholds = await loadFeatureThresholdsFromFile(THRESHOLDS_PATH);
  const { loadUnifiedModelPackageFromFile } = runtimeOwners;
  const packageRef = resolveOldPackagePath(oldRun);
  const packageResource = await loadUnifiedModelPackageFromFile(packageRef, { verifyResources: false });
  const packageBinding = packageResource.bind();
  if (packageBinding.modelId !== "nn-code.tsjs.symbols.r") {
    fail(`unexpected model package ${packageBinding.modelId}`);
  }
  const oldRunStats = {
    admissions: oldAdmissions.familyAdmissions.length,
    studentRows: oldStudentRows.length,
    supervisionRows: oldSupervisionRows.length,
  };
  const prepared = [];
  for (const entry of matrix.families) {
    entry.__out = outPath;
    entry.sourceDir = resolve(entry.repo_root);
    prepared.push(await prepareFamily({
      entry,
      matrixPath,
      thresholds,
      producer,
      validateMissingModeConsistency: runtimeOwners.validateMissingModeConsistency,
    }));
  }
  const studentRows = [
    ...oldStudentRows,
    ...studentRowsForRunner(prepared.map(preparedFamily => preparedFamily.group)),
  ];
  const preparedGroups = prepared.map(preparedFamily => preparedFamily.group);
  const supervisionRows = [
    ...oldSupervisionRows,
    ...prepared.flatMap(preparedFamily => preparedFamily.supervisionRows),
  ];
  reconcilePreparedGroups(preparedGroups, prepared.flatMap(preparedFamily => preparedFamily.supervisionRows));
  assertStudentRowsArePreStep(
    studentRowsForRunner(preparedGroups),
    preparedGroups,
  );
  const route = { domain: "tsjs", decisionKind: "R" };
  const dataGateRows = [
    ...oldDataGateRows,
    ...dataGateRowsForRunner(
      prepared.map(preparedFamily => preparedFamily.group),
      supervisionRows,
      route,
    ),
  ];
  const partitionTotals = {};
  for (const preparedFamily of prepared) {
    const partition = preparedFamily.group.partition;
    partitionTotals[partition] = (partitionTotals[partition] ?? 0) + 1;
  }
  const admissionFamilies = matrix.families.map(entry => ({
    sourceGroup: entry.source_family_id,
    partition: entry.partition,
    admission: "accepted_preparation",
    usableForTrainingSupervision: entry.partition === "TRAIN",
    usableForIndependentVerification: false,
    semanticProofRef: entry.semantic_proof_ref,
  }));
  await writeJson(`${outPath}/corpus-admissions.train-only.json`, {
    schemaVersion: oldAdmissions.schemaVersion,
    scope: "A1 observe TRAIN admission union; DEV remains separate",
    familyAdmissions: [
      ...structuredClone(oldAdmissions.familyAdmissions),
      ...admissionFamilies.filter(entry => entry.partition === "TRAIN"),
    ],
  });
  await writeJson(`${outPath}/corpus-admissions.dev-only.json`, {
    schemaVersion: "neural-cli-corpus-admissions-v1",
    scope: "A1 observe DEV admission only",
    familyAdmissions: admissionFamilies.filter(entry => entry.partition === "DEV"),
  });
  await writeJsonl(`${outPath}/student-rows.train.jsonl`, studentRows.filter(row => row.partition === "TRAIN"));
  await writeJsonl(`${outPath}/supervision-rows.train.jsonl`, supervisionRows.filter(row => row.partition === "TRAIN"));
  await writeJsonl(`${outPath}/data-gate-rows.train.jsonl`, dataGateRows.filter(row => row.partition === "TRAIN"));
  await writeJsonl(`${outPath}/student-rows.dev.jsonl`, studentRows.filter(row => row.partition === "DEV"));
  await writeJsonl(`${outPath}/supervision-rows.dev.jsonl`, supervisionRows.filter(row => row.partition === "DEV"));
  const hasUnavailableProducer = prepared.some(
    preparedFamily => preparedFamily.producerOutcome === "unavailable",
  );
  const hasRejectedProducer = prepared.some(
    preparedFamily => preparedFamily.producerOutcome === "rejected",
  );
  const status = hasUnavailableProducer
    ? "UNAVAILABLE"
    : hasRejectedProducer
      ? "INVALID"
      : "READY";
  const leakageReceipt = {
    schema: TSJS_COMPUTED_A1_LEAKAGE_SCHEMA,
    status: "READY",
    checkedFamilies: prepared.map(preparedFamily => preparedFamily.group.sourceGroup),
    checkedGroups: preparedGroups.map(preparedGroup => preparedGroup.group_id),
    preStepStudentRowsVerified: true,
  };
  const replayReceipt = {
    schema: TSJS_COMPUTED_A1_REPLAY_SCHEMA,
    status: "READY",
    retainedAdmissions: OLD_TRAIN_ADMISSION_GROUPS,
    retainedSupervisionGroups: oldReplay.supervisionRows.length,
    retainedStudentRows: oldReplay.studentRows.length,
    retainedDataGateRows: oldDataGateRows.length,
  };
  const receipt = {
    schema: TSJS_COMPUTED_A1_MATERIALIZE_SCHEMA,
    status,
    matrixPath,
    outPath,
    oldRun: oldRunStats,
    oldReplay: {
      admissions: oldReplay.admissions.familyAdmissions.length,
      retainedStudentRows: oldStudentRows.length,
      retainedSupervisionGroups: oldSupervisionRows.length,
      retainedDataGateRows: oldDataGateRows.length,
    },
    modelPackage: {
      packageRef: packageBinding.packageRef,
      modelId: packageBinding.modelId,
      version: packageBinding.version,
    },
    families: prepared.map(preparedFamily => ({
      sourceGroup: preparedFamily.group.sourceGroup,
      partition: preparedFamily.group.partition,
      candidateRefs: preparedFamily.candidateRefs,
      A_g: preparedFamily.supervisionRecord.steps[0].A_g,
      producerOutcome: preparedFamily.producerOutcome,
      producerReason: preparedFamily.producerReason,
      groupRows: preparedFamily.group.candidates.length,
      supervisionRows: preparedFamily.supervisionRows.length,
    })),
    partitionTotals,
    newGroups: partitionTotals,
    optimizationSeconds: 0,
    fitStatus: "not_trained",
    producerAvailability: producer === null
      ? "accepted A1 producer is not integrated in this worktree"
      : "injected accepted A1 producer dependency",
  };
  await writeJson(`${outPath}/materialize-receipt.json`, receipt);
  await writeJson(`${outPath}/leakage-receipt.json`, leakageReceipt);
  await writeJson(`${outPath}/replay-receipt.json`, replayReceipt);
  return receipt;
}

async function main(argv) {
  try {
    const parsedArgs = parseArgs(argv);
    const receipt = await runMaterialization(parsedArgs);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    if (receipt.status === "UNAVAILABLE") process.exitCode = 2;
    else if (receipt.status === "INVALID") process.exitCode = 1;
  } catch (error) {
    const receipt = {
      schema: TSJS_COMPUTED_A1_MATERIALIZE_SCHEMA,
      status: "INVALID",
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        code: error?.code ?? null,
      },
    };
    process.stderr.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
