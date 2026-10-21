import type {ActionObservation, SingleActionControl} from './single-action-contract.js';
import type {BrowserObservationError, BrowserObservationFeedback, BrowserObservationObligation} from './action-observation.js';
import type {RecursiveGoalLimits} from '../../workflow/recursive-goal/contracts.js';

export type BrowserSearchPhase = 'root' | 'input' | 'submitted' | 'results';
export interface BrowserSearchGoal {
  readonly kind: 'BrowserSearch';
  readonly query: string;
  readonly collectionRef: string;
  readonly containsText: string;
  readonly minimumMatches: number;
  readonly coverage: 'matched_items' | 'visible_batch';
  readonly phase: BrowserSearchPhase;
}
export interface BrowserSearchBindings {
  readonly documentRef: string;
  readonly scopeRef: string;
  readonly inputRef: string;
  readonly submitRef: string;
  readonly resultScopeRef: string;
  readonly collectionRef: string;
}
export interface BrowserSearchObservation extends SingleActionControl {
  readonly scopeRef: string;
  readonly input: {
    readonly ref: string;
    readonly tag: 'input' | 'textarea' | 'contenteditable' | 'unknown';
    readonly type: string;
    readonly value: ActionObservation<string>;
    readonly editable: ActionObservation<boolean>;
  };
  readonly submitRef: string;
  readonly submittedQuery: ActionObservation<string>;
  readonly resultsFor: ActionObservation<string>;
  readonly request: 'loading' | 'settled' | 'error' | 'unknown';
  readonly display: 'none' | 'old' | 'current' | 'empty' | 'partial' | 'unknown';
  readonly access: 'available' | 'login_required' | 'challenge' | 'unknown';
  readonly collection: {
    readonly ref: string;
    readonly scopeRef: string;
    readonly items: readonly {readonly ref: string; readonly text: ActionObservation<string>}[];
    readonly batch: ActionObservation<string>;
  };
  readonly evidence: readonly {readonly id: string; readonly source: string; readonly fact: unknown}[];
}
export interface BrowserSearchState {
  readonly observation: BrowserSearchObservation;
  readonly checkedObservationId: string | null;
}
export interface BrowserSearchRequest {
  readonly requestId: string;
  readonly goal: Omit<BrowserSearchGoal, 'phase'>;
  readonly satisfactionThreshold: 100;
  readonly bindings: BrowserSearchBindings;
  readonly limits?: RecursiveGoalLimits;
  readonly maxResultReads?: number;
}
export type BrowserSearchAction = 'input' | 'submit' | 'read';
export interface BrowserSearchDecision {
  readonly kind: 'selected' | 'defer';
  readonly action: BrowserSearchAction | null;
}
export interface BrowserSearchDecisionBinding {
  readonly id: string;
  readonly source: 'handwired' | 'model';
  readonly select: (input: {readonly goal: BrowserSearchGoal; readonly state: BrowserSearchState;
    readonly bindings: BrowserSearchBindings}) => BrowserSearchDecision | Promise<BrowserSearchDecision>;
}
export interface BrowserSearchNativeReceipt {
  readonly dispatched: boolean;
  readonly ok: boolean;
  readonly effectKnowledge: 'none' | 'known' | 'unknown';
  readonly error: BrowserObservationError | null;
  readonly source: string;
}
export interface BrowserSearchInvocation extends SingleActionControl {
  readonly kind: 'input' | 'submit';
  readonly targetRef: string;
  readonly value: string | null;
}
export interface BrowserSearchEpisode {
  readonly action: BrowserSearchAction;
  readonly decisionSource: {readonly id: string; readonly source: 'handwired' | 'model'};
  readonly decision: BrowserSearchDecision | null;
  readonly invocation: BrowserSearchInvocation | null;
  readonly receipt: BrowserSearchNativeReceipt | null;
  readonly dispatchState: 'not_dispatched' | 'dispatched' | 'unknown';
  readonly effectKnowledge: 'none' | 'known' | 'unknown';
  readonly state: BrowserSearchState | null;
  readonly observationFeedback: BrowserObservationFeedback;
  readonly executionErrors: readonly BrowserObservationError[];
  readonly collectionError: string | null;
}
export interface BrowserSearchResources {
  readonly grantedEffects: ReadonlySet<string>;
  readonly decision: BrowserSearchDecisionBinding;
  readonly observe: (obligation: BrowserObservationObligation) => Promise<BrowserSearchObservation>;
  readonly readResults: (obligation: BrowserObservationObligation) => Promise<BrowserSearchObservation>;
  readonly currentControl: () => SingleActionControl | Promise<SingleActionControl>;
  readonly nativeInputText: (invocation: BrowserSearchInvocation) => Promise<BrowserSearchNativeReceipt>;
  readonly nativeSubmit: (invocation: BrowserSearchInvocation) => Promise<BrowserSearchNativeReceipt>;
  readonly collect: (episode: BrowserSearchEpisode) => Promise<void>;
  readonly collectRoot?: (report: unknown) => Promise<void>;
  readonly signal?: AbortSignal;
}
