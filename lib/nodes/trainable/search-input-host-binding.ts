// B-A1 m2 R2: the production composition entry for the two units.
//
// One public entry performs the original milestone loop:
//
//   observe DOM (browser adapter)
//     -> project binder candidates (browser adapter, deterministic)
//     -> observe each host's usage relation (browser adapter, read only)
//     -> infer the relation member (pure, explicit profile)
//     -> attach the two supports to each candidate
//     -> infer the binder (pure, explicit profile)
//
// Why this file exists (milestone review P1-2, Alice ruling 2026-10-24): before
// it, the member-to-binder wiring existed only in a run-directory script, so the
// 36-wire binder could never receive real member support from production code.
// A capability reachable only from an evaluation script is not an integrated
// capability.
//
// Boundaries kept on purpose:
//   - observation stays in the browser adapter; this file reads no DOM itself
//     beyond the adapter calls it composes;
//   - both scores are pure infer calls with the profile passed in explicitly, so
//     no hidden weight source is consulted and an old profile stays old;
//   - one loop: candidates are projected once and enriched in place, then scored
//     once. There is no second pass and no second execution engine.

import {
  projectSearchInputHostCandidates,
  type SearchInputHostProjectionInput,
} from "../../adapters/browser/search-input-host-projection.js";
import { observeUsageRelation } from "../../adapters/browser/search-input-host-usage-observation.js";
import {
  inferUsageRelation,
  type UsageRelationProfile,
  type UsageRelationState,
} from "../../adapters/browser/search-input-host-usage-relation.js";
import type {
  UsageObservation,
  UsageTokenTable,
} from "../../adapters/browser/search-input-host-usage-contract.js";
import { SEARCH_INPUT_HOST_ROLE } from "../../adapters/browser/search-input-host-contract.js";
import type {
  SearchInputHostCandidate,
  SearchInputHostInferInput,
  SearchInputHostProfile,
  SearchInputHostResult,
} from "../../adapters/browser/search-input-host-contract.js";
import { inferSearchInputHostBinding } from "./search-input-host-binder.js";

/**
 * The live-dom evidence map entry for one control. `observeLiveDom` reports the
 * accessible name there, so a caller that has the snapshot passes it through.
 */
export type SearchInputHostEvidenceOf = (nodeRef: string) => Record<string, unknown> | null;

export interface SearchInputHostBindingInput extends SearchInputHostProjectionInput {
  readonly evidenceOf?: SearchInputHostEvidenceOf;
}

export interface SearchInputHostBindingResources {
  /** Binder profile: 36 wires, threshold frozen at 0.5. */
  readonly profile: SearchInputHostProfile;
  /** Relation member profile: two heads over the 27 declared form features. */
  readonly usageProfile: UsageRelationProfile;
  /** Caller-declared token tables. The member has no built-in table. */
  readonly usageTokens: UsageTokenTable;
}

export interface SearchInputHostMemberReport {
  readonly ref: string;
  readonly state: UsageRelationState;
  readonly querySupport: number | null;
  readonly fieldSupport: number | null;
}

export interface SearchInputHostObservedRelation {
  readonly ref: string;
  readonly observation: UsageObservation;
}

export interface SearchInputHostBindingOutcome {
  /** The request actually scored, after member support was attached. */
  readonly request: SearchInputHostInferInput;
  readonly result: SearchInputHostResult;
  /** Per-control member verdict, kept beside the binding for attribution. */
  readonly member: readonly SearchInputHostMemberReport[];
  /** The raw per-control observations the member scored, kept as evidence. */
  readonly observations: readonly SearchInputHostObservedRelation[];
}

/**
 * Attach the member's two real support scores to every projected candidate.
 *
 * A member that abstains keeps `null`. It is never folded into 0 here: the
 * binder decides what a missing support means, and it can only do that if the
 * missing value survives this step.
 */
export function attachUsageSupport(
  candidates: readonly SearchInputHostCandidate[],
  report: SearchInputHostMemberReport[],
): readonly SearchInputHostCandidate[] {
  const byRef = new Map(report.map(entry => [entry.ref, entry]));
  return Object.freeze(candidates.map(candidate => {
    const member = byRef.get(candidate.ref);
    if (member === undefined) return candidate;
    return Object.freeze({
      ...candidate,
      usageQuerySupport: member.querySupport,
      usageFieldSupport: member.fieldSupport,
    });
  }));
}

/**
 * Run the member and the binder over one observed scope.
 *
 * Deterministic: the same observation, profiles and tokens always give the same
 * outcome. Nothing is learned here and nothing is applied.
 */
export function bindSearchInputHostScope(
  input: SearchInputHostBindingInput,
  resources: SearchInputHostBindingResources,
): SearchInputHostBindingOutcome {
  const candidates = projectSearchInputHostCandidates(input);
  const nodesByRef = new Map(input.nodes.map(node => [node.nodeRef, node]));
  const member: SearchInputHostMemberReport[] = [];
  const observations: SearchInputHostObservedRelation[] = [];
  for (const candidate of candidates) {
    const node = nodesByRef.get(candidate.ref);
    if (node === undefined) continue;
    const observation: UsageObservation = observeUsageRelation({
      nodeRef: candidate.ref,
      scopeRef: input.scopeRef,
      documentRef: input.documentRef,
      observationId: input.observationId,
      revision: input.revision,
      scopeRoot: input.scopeRoot,
      element: node.element,
      properties: input.propertiesOf(candidate.ref),
      evidence: input.evidenceOf?.(candidate.ref) ?? null,
      access: input.access,
    });
    const outcome = inferUsageRelation(
      { observation, tokens: resources.usageTokens },
      { profile: resources.usageProfile },
    );
    observations.push({ ref: candidate.ref, observation });
    member.push({
      ref: candidate.ref,
      state: outcome.state,
      querySupport: outcome.querySupport,
      fieldSupport: outcome.fieldSupport,
    });
  }

  const enriched = attachUsageSupport(candidates, member);
  const request: SearchInputHostInferInput = {
    goal: { requestedRole: SEARCH_INPUT_HOST_ROLE, allowedScopeRef: input.scopeRef },
    candidates: enriched,
    coverage: input.coverage,
    currentControl: {
      documentRef: input.documentRef,
      observationId: input.observationId,
      revision: input.revision,
    },
  };
  const result = inferSearchInputHostBinding(request, { profile: resources.profile });
  return Object.freeze({
    request,
    result,
    member: Object.freeze(member.map(entry => Object.freeze(entry))),
    observations: Object.freeze(observations.map(entry => Object.freeze(entry))),
  });
}
