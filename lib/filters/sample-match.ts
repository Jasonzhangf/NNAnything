import { expectArray, expectNonEmptyString, expectRecord, expectString, expectStringArray } from "../core/schema.js";

export type AttributeValue = string | number | boolean | null;
export interface TeacherRecord {
  readonly tag?: string;
  readonly role?: string;
  readonly id?: string;
  readonly classList?: readonly string[];
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
}
export interface MatchCondition {
  readonly tag?: string;
  readonly role?: string;
  readonly idEquals?: string;
  readonly classIncludes?: readonly string[];
  readonly classExcludes?: readonly string[];
  readonly attributes?: Readonly<Record<string, AttributeValue>>;
}
export interface SampleMatchConfig {
  readonly ruleId: string;
  readonly rules: readonly { readonly semanticLabel: string; readonly ruleId?: string; readonly match: readonly MatchCondition[] }[];
}
export type MatchStatus = "matched" | "unmatched" | "unknown" | "conflict";
export interface SemanticResult {
  readonly matchStatus: MatchStatus;
  readonly semanticLabel: string | null;
  readonly matchedRuleIds: readonly string[];
  readonly reasons: readonly string[];
}

export function onlyKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${field} contains unsupported fields`);
}
function attributes(value: unknown): Record<string, AttributeValue> {
  const record = expectRecord(value, "attributes");
  const entries = Object.entries(record).map(([key, v]) => {
    if (v !== null && typeof v !== "string" && typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v))) throw new TypeError("attribute value must be a finite primitive");
    return [key, v] as [string, AttributeValue];
  });
  return Object.fromEntries(entries);
}
export function readTeacherRecord(value: unknown): TeacherRecord {
  const r = expectRecord(value, "teacher record");
  return {
    ...(r.tag !== undefined ? { tag: expectNonEmptyString(r.tag, "tag") } : {}),
    ...(r.role !== undefined ? { role: expectNonEmptyString(r.role, "role") } : {}),
    ...(r.id !== undefined ? { id: expectString(r.id, "id") } : {}),
    ...(r.classList !== undefined ? { classList: expectStringArray(r.classList, "classList") } : {}),
    ...(r.attributes !== undefined ? { attributes: attributes(r.attributes) } : {}),
  };
}
export function readMatchConfig(value: unknown): SampleMatchConfig {
  const r = expectRecord(value, "semantic config");
  onlyKeys(r, ["ruleId", "rules"], "semantic config");
  const rules = expectArray(r.rules, "rules").map(value => {
    const rule = expectRecord(value, "semantic rule");
    onlyKeys(rule, ["ruleId", "semanticLabel", "match"], "semantic rule");
    const match = expectArray(rule.match, "match").map(value => {
      const c = expectRecord(value, "condition");
      onlyKeys(c, ["tag", "role", "idEquals", "classIncludes", "classExcludes", "attributes"], "condition");
      if (!Object.keys(c).length) throw new TypeError("condition must contain a predicate");
      const result: MatchCondition = {
        ...(c.tag !== undefined ? { tag: expectNonEmptyString(c.tag, "condition.tag") } : {}),
        ...(c.role !== undefined ? { role: expectNonEmptyString(c.role, "condition.role") } : {}),
        ...(c.idEquals !== undefined ? { idEquals: expectString(c.idEquals, "condition.idEquals") } : {}),
        ...(c.classIncludes !== undefined ? { classIncludes: expectStringArray(c.classIncludes, "classIncludes") } : {}),
        ...(c.classExcludes !== undefined ? { classExcludes: expectStringArray(c.classExcludes, "classExcludes") } : {}),
        ...(c.attributes !== undefined ? { attributes: attributes(c.attributes) } : {}),
      };
      if (result.classIncludes?.length === 0 || result.classExcludes?.length === 0 || (result.attributes && !Object.keys(result.attributes).length)) throw new TypeError("condition predicate cannot be empty");
      return result;
    });
    if (!match.length) throw new TypeError("match must contain conditions");
    return { semanticLabel: expectNonEmptyString(rule.semanticLabel, "semanticLabel"), match, ...(rule.ruleId !== undefined ? { ruleId: expectNonEmptyString(rule.ruleId, "ruleId") } : {}) };
  });
  if (!rules.length) throw new TypeError("rules must contain semantic classes");
  return { ruleId: expectNonEmptyString(r.ruleId, "ruleId"), rules };
}

type Truth = boolean | null;
function condition(record: TeacherRecord, c: MatchCondition): Truth {
  const values: Truth[] = [];
  for (const key of ["tag", "role"] as const) if (c[key] !== undefined) values.push(record[key] === undefined ? null : record[key] === c[key]);
  if (c.idEquals !== undefined) values.push(record.id === undefined ? null : record.id === c.idEquals);
  if (c.classIncludes) values.push(record.classList === undefined ? null : c.classIncludes.every(x => record.classList!.includes(x)));
  if (c.classExcludes) values.push(record.classList === undefined ? null : c.classExcludes.every(x => !record.classList!.includes(x)));
  for (const [key, value] of Object.entries(c.attributes ?? {})) values.push(!record.attributes || !Object.hasOwn(record.attributes, key) ? null : record.attributes[key] === value);
  return values.includes(false) ? false : values.includes(null) ? null : true;
}

/** A deterministic semantic classifier. It has no training target or polarity. */
export function evaluateSemanticRules(rawRecords: unknown, rawConfig: unknown): SemanticResult[] {
  const config = readMatchConfig(rawConfig);
  return expectArray(rawRecords, "records").map(raw => {
    const record = readTeacherRecord(raw);
    const labels = new Map<string, { truths: Truth[]; ids: string[] }>();
    config.rules.forEach((rule, ri) => {
      const entry = labels.get(rule.semanticLabel) ?? { truths: [], ids: [] };
      rule.match.forEach((c, ci) => {
        const truth = condition(record, c);
        entry.truths.push(truth);
        if (truth === true) entry.ids.push(`${config.ruleId}:${rule.ruleId ?? rule.semanticLabel}#${ri}.${ci}`);
      });
      labels.set(rule.semanticLabel, entry);
    });
    const hits = [...labels].filter(([, e]) => e.truths.includes(true));
    const unknown = [...labels.values()].some(e => !e.truths.includes(true) && e.truths.includes(null));
    if (hits.length > 1) return { matchStatus: "conflict", semanticLabel: null, matchedRuleIds: hits.flatMap(([, e]) => e.ids), reasons: ["semantic_conflict"] };
    if (unknown) return { matchStatus: "unknown", semanticLabel: null, matchedRuleIds: [], reasons: hits.length ? ["unresolved_competing_class", "missing_teacher_field"] : ["missing_teacher_field"] };
    if (hits.length) return { matchStatus: "matched", semanticLabel: hits[0]![0], matchedRuleIds: hits[0]![1].ids, reasons: ["semantic_match"] };
    return { matchStatus: "unmatched", semanticLabel: null, matchedRuleIds: [], reasons: ["no_rule_match"] };
  });
}
