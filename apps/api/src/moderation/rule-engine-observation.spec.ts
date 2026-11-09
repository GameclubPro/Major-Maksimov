import {
  RULE_COVERAGE_COUNTERS,
  RULE_COVERAGE_FAMILIES,
  RULE_COVERAGE_SCHEMA,
  createRuleEngineObservation,
  type RuleCoverageFamily,
  type RuleCoverageSnapshot,
} from './rule-engine-observation';

function counts(snapshot: RuleCoverageSnapshot, family: RuleCoverageFamily) {
  const row = snapshot.rows[RULE_COVERAGE_FAMILIES.indexOf(family)]!;
  return Object.fromEntries(RULE_COVERAGE_COUNTERS.map((counter, index) => [counter, row[index]]));
}

describe('per-detect rule coverage', () => {
  it('counts one family once across repeated source paragraphs', () => {
    const scope = createRuleEngineObservation();
    const words = scope.family('blocked-words');
    for (const matched of [false, false, true, true]) {
      words.configured(true);
      words.eligible();
      words.finish({ kind: 'evaluated', matched });
    }
    const snapshot = scope.close();
    expect(snapshot.schema).toBe(RULE_COVERAGE_SCHEMA);
    expect(snapshot.rows).toHaveLength(14);
    expect(counts(snapshot, 'blocked-words')).toEqual({
      configured: 1,
      eligible: 1,
      evaluated: 1,
      matched: 1,
      skippedDisabled: 0,
      skippedContent: 0,
      skippedState: 0,
      expired: 0,
      errors: 0,
      interrupted: 0,
    });
    expect(snapshot.rows[RULE_COVERAGE_FAMILIES.indexOf('blocked-domains')]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('preserves evaluated and matched evidence before and after content-only paragraphs', () => {
    const scope = createRuleEngineObservation();
    const domains = scope.family('blocked-domains');
    domains.configured(true);
    domains.finish({ kind: 'skip', reason: 'content' });
    domains.configured(true);
    domains.eligible();
    domains.finish({ kind: 'evaluated', matched: true });
    domains.configured(true);
    domains.finish({ kind: 'skip', reason: 'content' });
    expect(counts(scope.close(), 'blocked-domains')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 1,
      matched: 1,
      skippedContent: 0,
      errors: 0,
    });
  });

  it.each(['state', 'expired'] as const)(
    'keeps a %s skip when later source paragraphs contain no usable content',
    (reason) => {
      const scope = createRuleEngineObservation();
      const words = scope.family('blocked-words');
      words.configured(true);
      words.finish({ kind: 'skip', reason });
      for (const later of ['content', 'disabled', 'content'] as const) {
        words.configured(later !== 'disabled');
        words.finish({ kind: 'skip', reason: later });
      }
      expect(counts(scope.close(), 'blocked-words')).toMatchObject({
        configured: 1,
        evaluated: 0,
        matched: 0,
        skippedDisabled: 0,
        skippedContent: 0,
        skippedState: +(reason === 'state'),
        expired: +(reason === 'expired'),
        errors: 0,
      });
    },
  );

  it('preserves the strongest unavailable skip independently of paragraph order', () => {
    for (const reasons of [
      ['content', 'state', 'expired', 'content'],
      ['expired', 'content', 'state', 'disabled'],
    ] as const) {
      const scope = createRuleEngineObservation();
      const domains = scope.family('blocked-domains');
      for (const reason of reasons) {
        domains.configured(true);
        domains.finish({ kind: 'skip', reason });
      }
      expect(counts(scope.close(), 'blocked-domains')).toMatchObject({
        evaluated: 0,
        skippedContent: 0,
        skippedState: 0,
        skippedDisabled: 0,
        expired: 1,
      });
    }
  });

  it('distinguishes disabled settings from configured rules skipped for content or state', () => {
    const scope = createRuleEngineObservation();
    const profanity = scope.family('profanity');
    profanity.configured(false);
    profanity.finish({ kind: 'skip', reason: 'disabled' });
    const links = scope.family('links');
    links.configured(true);
    links.finish({ kind: 'skip', reason: 'content' });
    const duplicate = scope.family('duplicate-state');
    duplicate.configured(true);
    duplicate.finish({ kind: 'skip', reason: 'state' });
    const photo = scope.family('photo-cooldown');
    photo.configured(true);
    photo.eligible();
    photo.finish({ kind: 'skip', reason: 'expired' });
    const snapshot = scope.close();
    expect(counts(snapshot, 'profanity')).toMatchObject({
      configured: 0,
      eligible: 0,
      evaluated: 0,
      skippedDisabled: 1,
    });
    expect(counts(snapshot, 'links')).toMatchObject({
      configured: 1,
      eligible: 0,
      evaluated: 0,
      skippedContent: 1,
    });
    expect(counts(snapshot, 'duplicate-state')).toMatchObject({
      configured: 1,
      eligible: 0,
      evaluated: 0,
      skippedState: 1,
    });
    expect(counts(snapshot, 'photo-cooldown')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 0,
      expired: 1,
    });
  });

  it('keeps completed observations, marks the active failure and interrupts later families', () => {
    const scope = createRuleEngineObservation();
    const profanity = scope.family('profanity');
    profanity.configured(true);
    profanity.eligible();
    profanity.finish({ kind: 'evaluated', matched: false });
    const commercial = scope.family('commercial-ad');
    commercial.configured(true);
    commercial.eligible();
    const snapshot = scope.close(true);
    expect(counts(snapshot, 'profanity')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 1,
      matched: 0,
      errors: 0,
      interrupted: 0,
    });
    expect(counts(snapshot, 'commercial-ad')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 0,
      errors: 1,
      interrupted: 0,
    });
    expect(counts(snapshot, 'links')).toMatchObject({
      configured: 0,
      eligible: 0,
      evaluated: 0,
      errors: 0,
      interrupted: 1,
    });
    expect(scope.close(false)).toEqual(snapshot);
  });

  it('marks a later paragraph failure without losing its earlier completed evaluation', () => {
    const scope = createRuleEngineObservation();
    const words = scope.family('blocked-words');
    words.configured(true);
    words.eligible();
    words.finish({ kind: 'evaluated', matched: false });
    words.configured(true);
    words.eligible();
    expect(counts(scope.close(true), 'blocked-words')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 1,
      matched: 0,
      errors: 1,
      interrupted: 0,
    });
  });

  it('retains an explicitly observed error when execution continues after that family', () => {
    const scope = createRuleEngineObservation();
    const traffic = scope.family('traffic-protection');
    traffic.configured(true);
    traffic.eligible();
    traffic.finish({ kind: 'error' });
    const duplicate = scope.family('duplicate-state');
    duplicate.configured(true);
    duplicate.eligible();
    duplicate.finish({ kind: 'evaluated', matched: false });
    const snapshot = scope.close();
    expect(counts(snapshot, 'traffic-protection')).toMatchObject({
      configured: 1,
      eligible: 1,
      evaluated: 0,
      errors: 1,
      interrupted: 0,
    });
    expect(counts(snapshot, 'duplicate-state')).toMatchObject({
      evaluated: 1,
      errors: 0,
      interrupted: 0,
    });
  });

  it('ignores late callbacks after close, including observers first requested after close', () => {
    const scope = createRuleEngineObservation();
    const links = scope.family('links');
    links.configured(true);
    links.eligible();
    links.finish({ kind: 'evaluated', matched: false });
    const snapshot = scope.close();
    links.configured(false);
    links.eligible();
    links.finish({ kind: 'evaluated', matched: true });
    links.finish({ kind: 'error' });
    const late = scope.family('phone-numbers');
    late.configured(true);
    late.eligible();
    late.finish({ kind: 'evaluated', matched: true });
    expect(scope.close(true)).toEqual(snapshot);
  });

  it('returns independent snapshots and keeps interleaved detection scopes separate', () => {
    const first = createRuleEngineObservation();
    const second = createRuleEngineObservation();
    first.family('links').configured(true);
    second.family('links').configured(true);
    first.family('links').eligible();
    second.family('links').finish({ kind: 'skip', reason: 'state' });
    first.family('links').finish({ kind: 'evaluated', matched: true });
    const saved = first.close();
    const snapshot = first.close();
    expect(snapshot).toEqual(saved);
    expect(snapshot).not.toBe(saved);
    expect(snapshot.rows).not.toBe(saved.rows);
    expect(snapshot.rows[0]).not.toBe(saved.rows[0]);
    snapshot.rows[RULE_COVERAGE_FAMILIES.indexOf('links')]![0] = 900;
    snapshot.rows.push([9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    expect(first.close()).toEqual(saved);
    expect(counts(second.close(), 'links')).toMatchObject({
      configured: 1,
      eligible: 0,
      evaluated: 0,
      matched: 0,
      skippedState: 1,
    });
  });
});
