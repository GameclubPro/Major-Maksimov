// FLAG: Fixed invocation coverage only; never identities, policy contents or action authority.
// FLAG: This schema fixes the family/counter order and meaning. Additions or reorderings
// require another schema, even when the resulting matrix has the same dimensions.
export const RULE_COVERAGE_SCHEMA = 'rule-engine-coverage-v1' as const;
export const RULE_COVERAGE_FAMILIES = [
  'profanity',
  'commercial-ad',
  'links',
  'message-length',
  'anti-spam-burst',
  'message-count-limit',
  'blocked-words',
  'blocked-domains',
  'phone-numbers',
  'attachments',
  'traffic-protection',
  'duplicate-state',
  'photo-cooldown',
  'sticker-cooldown',
] as const;
export type RuleCoverageFamily = (typeof RULE_COVERAGE_FAMILIES)[number];
export const RULE_COVERAGE_COUNTERS = [
  'configured',
  'eligible',
  'evaluated',
  'matched',
  'skippedDisabled',
  'skippedContent',
  'skippedState',
  'expired',
  'errors',
  'interrupted',
] as const;
export type RuleCoverageRow = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
// Tuple order is the schema's fixed family/counter order; this bounds the process report size.
export type RuleCoverageSnapshot = {
  schema: typeof RULE_COVERAGE_SCHEMA;
  rows: RuleCoverageRow[];
};
export type RuleSkipReason = 'disabled' | 'content' | 'state' | 'expired';
const RULE_SKIP_PRIORITY: Record<RuleSkipReason, number> = {
  disabled: 0,
  content: 1,
  state: 2,
  expired: 3,
};
export type RuleEvaluationOutcome =
  | { kind: 'evaluated'; matched: boolean }
  | { kind: 'skip'; reason: RuleSkipReason }
  | { kind: 'error' };
export interface RuleEvaluationObserver {
  configured(enabled: boolean): void;
  eligible(): void;
  finish(outcome: RuleEvaluationOutcome): void;
}

type CoverageState = {
  visited: boolean;
  configured: boolean;
  eligible: boolean;
  evaluated: boolean;
  matched: boolean;
  error: boolean;
  skip?: RuleSkipReason;
  finished: boolean;
};

export function createRuleEngineObservation(): {
  family(family: RuleCoverageFamily): RuleEvaluationObserver;
  close(failed?: boolean): RuleCoverageSnapshot;
} {
  let closed: RuleCoverageSnapshot | undefined;
  const states: CoverageState[] = RULE_COVERAGE_FAMILIES.map(() => ({
    visited: false,
    configured: false,
    eligible: false,
    evaluated: false,
    matched: false,
    error: false,
    finished: false,
  }));
  const observers = states.map(
    (state): RuleEvaluationObserver => ({
      configured(enabled) {
        if (closed) return;
        state.visited = true;
        state.finished = false;
        state.configured ||= enabled;
      },
      eligible() {
        if (closed) return;
        state.visited = true;
        state.eligible = true;
      },
      finish(outcome) {
        if (closed) return;
        state.visited = true;
        state.finished = true;
        if (outcome.kind === 'evaluated') {
          state.evaluated = true;
          state.matched ||= outcome.matched;
        } else if (outcome.kind === 'error') {
          state.error = true;
        } else {
          // Multiple source paragraphs still describe one engine/family invocation.
          // Any evaluated paragraph takes precedence over a content-only skip at close.
          // FLAG: Later empty content cannot hide unavailable state or an expired deadline.
          if (
            state.skip === undefined ||
            RULE_SKIP_PRIORITY[outcome.reason] > RULE_SKIP_PRIORITY[state.skip]
          ) {
            state.skip = outcome.reason;
          }
        }
      },
    }),
  );
  return {
    family(family) {
      return observers[RULE_COVERAGE_FAMILIES.indexOf(family)]!;
    },
    close(failed = false) {
      if (!closed) {
        closed = {
          schema: RULE_COVERAGE_SCHEMA,
          rows: states.map((state): RuleCoverageRow => {
            const error = state.error || (failed && state.visited && !state.finished);
            const interrupted = failed && !state.visited;
            const skip = !state.evaluated && !error ? state.skip : undefined;
            return [
              +state.configured,
              +state.eligible,
              +state.evaluated,
              +state.matched,
              +(skip === 'disabled'),
              +(skip === 'content'),
              +(skip === 'state'),
              +(skip === 'expired'),
              +error,
              +interrupted,
            ];
          }),
        };
      }
      return {
        schema: RULE_COVERAGE_SCHEMA,
        rows: closed.rows.map((row): RuleCoverageRow => [...row]),
      };
    },
  };
}
