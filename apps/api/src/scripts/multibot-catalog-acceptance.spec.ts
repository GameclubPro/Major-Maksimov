import {
  buildCatalogManifest,
  evaluateCatalogOutcomes,
  parseCatalogTokenRps,
  type CatalogEventObservation,
  type CatalogExpectedEvent,
} from './multibot-catalog-acceptance';

const expectedBotIds = ['bot-0', 'bot-1', 'bot-2'] as const;
const chats = Array.from({ length: 12 }, (_, index) => `chat-${index}`);
const executorByChat = new Map(chats.map((chat, index) => [chat, `bot-${index % 3}`]));
function manifest(violationPercent = 100) {
  return buildCatalogManifest({
    caseId: 'fixed-case',
    chats,
    executorByChat,
    messages: 30,
    bots: 3,
    fixedRouting: true,
    profile: 'mixed',
    violationPercent,
  });
}
function confirmed(event: CatalogExpectedEvent, latencyMs = 100): CatalogEventObservation {
  return {
    ingressAtMs: 1000,
    receipts: expectedBotIds.map((botId, index) => ({
      botId,
      chatId: event.chatId,
      messageId: event.messageId,
      status: index === 0 ? 'PROCESSED' : 'DUPLICATE',
      deadlineAtMs: 301000,
    })),
    claims: [{ status: 'COMPLETED', botId: event.executorId, completedAtMs: 1100 }],
    intents:
      event.decision === 'DELETE'
        ? [
            {
              status: 'SUCCEEDED',
              chatId: event.chatId,
              botId: event.executorId,
              remoteBotId: event.executorId,
              remoteSucceededAtMs: 1000 + latencyMs,
              completedAtMs: 1000 + latencyMs,
              verified: true,
              dispatchStarted: true,
            },
          ]
        : [],
    deletes:
      event.decision === 'DELETE'
        ? [{ botId: event.executorId, observedAtMs: 1000 + latencyMs - 1 }]
        : [],
    messagePresent: event.decision === 'KEEP',
  };
}
function observations(events: readonly CatalogExpectedEvent[]) {
  return new Map(events.map((event) => [event.messageId, confirmed(event)]));
}

describe('multibot catalog independent workload acceptance', () => {
  it('interleaves rotating quiet chats with four hot chats deterministically', () => {
    const events = manifest(50);
    expect(events).toEqual(manifest(50));
    expect(
      events.filter((event) => event.cohort === 'quiet').map((event) => event.sequence),
    ).toEqual([2, 7, 12, 17, 22, 27]);
    expect(
      new Set(events.filter((event) => event.cohort === 'hot').map((event) => event.chatId)),
    ).toEqual(new Set(chats.slice(0, 4)));
    const quiet = events.filter((event) => event.cohort === 'quiet');
    expect(quiet.map((event) => event.chatId)).toEqual(chats.slice(4, 10));
    expect(new Set(quiet.map((event) => event.executorId)).size).toBe(3);
    expect(quiet.some((event) => event.decision === 'DELETE')).toBe(true);
    expect(quiet.some((event) => event.decision === 'KEEP')).toBe(true);
    expect(() =>
      buildCatalogManifest({
        caseId: 'short',
        chats: chats.slice(0, 4),
        executorByChat,
        messages: 5,
        bots: 3,
        fixedRouting: true,
        profile: 'mixed',
        violationPercent: 100,
      }),
    ).toThrow('Mixed profile');
  });

  it('retains the declared manifest denominator when quiet work is never submitted', () => {
    const events = manifest();
    const observed = observations(events);
    for (const event of events.filter((event) => event.cohort === 'quiet'))
      observed.delete(event.messageId);
    const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
    expect(result.correctnessStatus).toBe('failed');
    expect(result.cohorts.find((cohort) => cohort.cohort === 'quiet')).toMatchObject({
      expectedEvents: 6,
      submittedEvents: 0,
      incompleteEvents: 6,
      expectedReceipts: 18,
      observedReceipts: 0,
      missingReceipts: 18,
      deleteLatency: { expectedSamples: 6, samples: 0, complete: false, p99Ms: null },
    });
    expect(result.cohorts.find((cohort) => cohort.cohort === 'hot')?.incompleteEvents).toBe(0);
  });

  it('reports quiet effect latency separately from quick receipt/handler completion', () => {
    const events = manifest(50);
    const observed = observations(events);
    for (const event of events.filter(
      (event) => event.cohort === 'quiet' && event.decision === 'DELETE',
    ))
      observed.set(event.messageId, confirmed(event, 6000));
    const result = evaluateCatalogOutcomes(
      events,
      observed,
      expectedBotIds,
      { p95Ms: 1000, p99Ms: 2000 },
      8000,
    );
    expect(result).toMatchObject({ correctnessStatus: 'passed', status: 'failed' });
    expect(result.cohorts.find((cohort) => cohort.cohort === 'hot')?.deleteLatency.status).toBe(
      'passed',
    );
    expect(result.cohorts.find((cohort) => cohort.cohort === 'quiet')).toMatchObject({
      incompleteEvents: 0,
      deleteLatency: { complete: true, p99Ms: 6000, maxConfirmedMs: 6000, status: 'failed' },
    });
  });

  it('keeps quarantine, expiry and ambiguous effects visible despite healthy independent work', () => {
    const events = manifest();
    const observed = observations(events);
    const event = events.find((entry) => entry.cohort === 'quiet')!;
    const blocked = observed.get(event.messageId)!;
    blocked.receipts[0] = { ...blocked.receipts[0]!, status: 'QUARANTINED', deadlineAtMs: 2000 };
    blocked.claims[0]!.status = 'STARTED';
    blocked.intents[0]!.status = 'AMBIGUOUS';
    blocked.intents[0]!.remoteSucceededAtMs = null;
    const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
    expect(result.status).toBe('failed');
    expect(result.cohorts.find((cohort) => cohort.cohort === 'quiet')).toMatchObject({
      expectedEvents: 6,
      confirmedDeletes: 5,
      incompleteEvents: 1,
      quarantinedReceipts: 1,
      expiredReceipts: 1,
      unfinishedReceipts: 1,
      unknownEffectEvents: 1,
      deleteLatency: { samples: 5, expectedSamples: 6, complete: false, p99Ms: null },
    });
  });

  it.each([
    'remote_receipt',
    'verified_reason',
    'actual_absence',
    'owner',
    'wrong_target',
    'backward_remote_clock',
    'remote_executor',
    'effect_executor',
    'duplicate_effect',
  ])('refuses a nominal SUCCEEDED intent without %s proof', (fault) => {
    const events = manifest();
    const observed = observations(events);
    const first = observed.get(events[0]!.messageId)!;
    if (fault === 'remote_receipt') first.intents[0]!.remoteSucceededAtMs = null;
    if (fault === 'verified_reason') first.intents[0]!.verified = false;
    if (fault === 'actual_absence') first.messagePresent = true;
    if (fault === 'owner') first.claims = [];
    if (fault === 'wrong_target') first.intents[0]!.chatId = 'wrong-chat';
    if (fault === 'backward_remote_clock') first.intents[0]!.remoteSucceededAtMs = 999;
    if (fault === 'remote_executor') first.intents[0]!.remoteBotId = 'wrong-bot';
    if (fault === 'effect_executor') first.deletes[0]!.botId = 'wrong-bot';
    if (fault === 'duplicate_effect') first.deletes.push({ ...first.deletes[0]! });
    const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
    expect(result.correctnessStatus).toBe('failed');
    const hot = result.cohorts.find((cohort) => cohort.cohort === 'hot')!;
    if (fault === 'backward_remote_clock')
      expect(hot.deleteLatency).toMatchObject({ invalidClocks: 1, complete: false });
    else expect(hot.incompleteEvents).toBe(1);
  });

  it('rejects missing and backward clocks instead of treating them as fast outcomes', () => {
    const events = manifest(0);
    const observed = observations(events);
    observed.get(events[0]!.messageId)!.claims[0]!.completedAtMs = null;
    observed.get(events[1]!.messageId)!.claims[0]!.completedAtMs = 999;
    const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
    expect(result.correctnessStatus).toBe('failed');
    expect(result.cohorts.find((cohort) => cohort.cohort === 'hot')?.outcomeLatency).toMatchObject({
      invalidClocks: 2,
      complete: false,
      p99Ms: null,
    });
  });

  it('checks benign preservation independently and labels zero delete cohorts not applicable', () => {
    const events = manifest(0);
    const observed = observations(events);
    expect(evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000).status).toBe(
      'passed',
    );
    const first = observed.get(events[0]!.messageId)!;
    first.deletes.push({ botId: events[0]!.executorId, observedAtMs: 1100 });
    first.messagePresent = false;
    const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
    expect(result.cohorts.find((cohort) => cohort.cohort === 'hot')).toMatchObject({
      expectedDeletes: 0,
      unexpectedDeleteEvents: 1,
      incompleteEvents: 1,
      deleteLatency: { expectedSamples: 0, status: 'not_applicable' },
    });
    expect(result.correctnessStatus).toBe('failed');
  });

  it.each(
    [0, 100].flatMap((violationPercent) =>
      [
        'duplicate_bot',
        'unknown_bot',
        'missing_bot',
        'wrong_chat',
        'wrong_message',
        'missing_target',
        'extra_mirror',
      ].map((fault) => ({ violationPercent, fault })),
    ),
  )(
    'rejects $fault receipt proof with violations=$violationPercent',
    ({ violationPercent, fault }) => {
      const events = manifest(violationPercent);
      const observed = observations(events);
      const first = observed.get(events[0]!.messageId)!;
      if (fault === 'duplicate_bot') first.receipts[0]!.botId = expectedBotIds[1];
      if (fault === 'unknown_bot') first.receipts[0]!.botId = 'unrelated-bot';
      if (fault === 'missing_bot') first.receipts[0]!.botId = null;
      if (fault === 'wrong_chat') first.receipts[0]!.chatId = 'unrelated-chat';
      if (fault === 'wrong_message') first.receipts[0]!.messageId = 'unrelated-message';
      if (fault === 'missing_target') {
        first.receipts[0]!.chatId = null;
        first.receipts[0]!.messageId = null;
      }
      if (fault === 'extra_mirror') first.receipts.push({ ...first.receipts[0]! });
      const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
      expect(result.correctnessStatus).toBe('failed');
      const hot = result.cohorts.find((cohort) => cohort.cohort === 'hot')!;
      expect(hot.incompleteEvents).toBe(1);
      if (['wrong_chat', 'wrong_message', 'missing_target'].includes(fault))
        expect(hot.wrongTargetEvents).toBe(1);
      else if (fault === 'extra_mirror') expect(hot.duplicateMirrorReceipts).toBe(1);
      else expect(hot.missingReceipts).toBe(1);
    },
  );

  it('compares the exact mirror bot set independently of receipt order', () => {
    const events = manifest(50);
    const observed = observations(events);
    for (const observation of observed.values()) observation.receipts.reverse();
    expect(evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000).status).toBe(
      'passed',
    );
    expect(() => evaluateCatalogOutcomes(events, observed, ['bot-0', 'bot-0'], null, 5000)).toThrow(
      'unique',
    );
  });

  it.each(['owner', 'remote', 'intent_completion', 'effect'])(
    'rejects a future DELETE %s clock even without latency targets',
    (fault) => {
      const events = manifest();
      const observed = observations(events);
      const first = observed.get(events[0]!.messageId)!;
      if (fault === 'owner') first.claims[0]!.completedAtMs = 5001;
      if (fault === 'remote') first.intents[0]!.remoteSucceededAtMs = 5001;
      if (fault === 'intent_completion') first.intents[0]!.completedAtMs = 5001;
      if (fault === 'effect') first.deletes[0]!.observedAtMs = 5001;
      const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
      expect(result.correctnessStatus).toBe('failed');
      expect(
        result.cohorts.find((cohort) => cohort.cohort === 'hot')?.outcomeLatency,
      ).toMatchObject({ invalidClocks: 1, complete: false, p99Ms: null });
    },
  );

  it('rejects a future KEEP owner clock even without a delete intent', () => {
    const events = manifest(0);
    const observed = observations(events);
    observed.get(events[0]!.messageId)!.claims[0]!.completedAtMs = 5001;
    const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
    expect(result.correctnessStatus).toBe('failed');
    expect(result.cohorts.find((cohort) => cohort.cohort === 'hot')?.outcomeLatency).toMatchObject({
      invalidClocks: 1,
      complete: false,
      p99Ms: null,
    });
  });

  it.each(
    [0, 100].flatMap((violationPercent) =>
      [NaN, Infinity, -Infinity, 5001, 1000.5].map((ingressAtMs) => ({
        violationPercent,
        ingressAtMs,
      })),
    ),
  )(
    'rejects invalid ingress $ingressAtMs with violations=$violationPercent',
    ({ violationPercent, ingressAtMs }) => {
      const events = manifest(violationPercent);
      const observed = observations(events);
      observed.get(events[0]!.messageId)!.ingressAtMs = ingressAtMs;
      const result = evaluateCatalogOutcomes(events, observed, expectedBotIds, null, 5000);
      expect(result.correctnessStatus).toBe('failed');
      expect(result.cohorts.find((cohort) => cohort.cohort === 'hot')).toMatchObject({
        invalidIngressEvents: 1,
        outcomeLatency: { invalidClocks: 1, complete: false },
      });
    },
  );

  it('accepts clocks exactly at observation time without adding a tolerance', () => {
    const events = manifest(50);
    expect(
      evaluateCatalogOutcomes(events, observations(events), expectedBotIds, null, 1100).status,
    ).toBe('passed');
  });

  it('defaults to the explicit 25 RPS budget and refuses ambiguous/increased quota inputs', () => {
    expect(parseCatalogTokenRps()).toBe(25);
    expect(parseCatalogTokenRps('25')).toBe(25);
    expect(parseCatalogTokenRps('30')).toBe(30);
    for (const value of ['31', '100', '0', '25.0', '2.5e1', ' 25', '25 '])
      expect(() => parseCatalogTokenRps(value)).toThrow('quota');
  });
});
