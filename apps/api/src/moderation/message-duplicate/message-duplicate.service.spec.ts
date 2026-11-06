import { MessageDuplicateService } from './message-duplicate.service';
import { duplicateSettings, duplicateUpdate } from './message-duplicate-test-fixtures';

describe('message duplicate main-path admission', () => {
  it('marks full rollout authoritative so the legacy filter cannot claim the same message first', async () => {
    const policy = { resolve: jest.fn().mockResolvedValue({ mode: 'full' }) };
    const service = new MessageDuplicateService(
      policy as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(await service.isAuthoritative('-123')).toBe(true);
    policy.resolve.mockResolvedValue({ mode: 'delete_only' });
    expect(await service.isAuthoritative('-123')).toBe(true);
  });
  function setup() {
    const policy = { resolve: jest.fn().mockResolvedValue({ mode: 'delete_only', revision: 1 }) };
    const observe = jest.fn().mockResolvedValue({ hit: {}, binding: {} });
    const history = {
      observe,
      observeWithOutcome: jest.fn(async (input) => {
        const match = await observe(input);
        return { match, outcome: match ? 'MATCHED' : 'COMPARED_NO_MATCH' };
      }),
    };
    const enforcement = {
      enqueue: jest.fn().mockResolvedValue({ kind: 'intent_accepted', intentId: 'intent' }),
    };
    const queue = { enqueue: jest.fn() };
    const metrics = {
      record: jest.fn(),
      recordContentRejection: jest.fn(),
      recordObservation: jest.fn(),
      recordPhase: jest.fn(),
    };
    const authorization = { revoke: jest.fn() };
    const service = new MessageDuplicateService(
      policy as never,
      history as never,
      enforcement as never,
      queue as never,
      authorization as never,
      metrics as never,
    );
    const update = duplicateUpdate();
    const params = {
      update,
      webhookEventId: 'receipt',
      eventTimestampMs: Date.parse(update.message!.createdAt),
      settings: duplicateSettings(),
      botId: 'bot',
      actionEligible: true,
      track: true,
    };
    return { service, params, policy, history, enforcement, queue, metrics };
  }
  it('does not observe or queue content outside a daily period, including delayed events', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T15:00Z'));
    try {
      const s = setup();
      s.params.settings.duplicateWindowMode = 'DAILY';
      await s.service.observe(s.params);
      s.params.eventTimestampMs = Date.parse('2026-09-29T14:59Z');
      await s.service.observe(s.params);
      expect(s.history.observe).not.toHaveBeenCalled();
      expect(s.queue.enqueue).not.toHaveBeenCalled();
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('admission.schedule_closed');
    } finally {
      clock.mockRestore();
    }
  });
  it('admits short messages inline and never silently acknowledges state failures', async () => {
    const s = setup();
    await s.service.observe(s.params);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    expect(s.queue.enqueue).not.toHaveBeenCalled();
    s.history.observe.mockRejectedValue(new Error('state deadline'));
    await expect(s.service.observe(s.params)).rejects.toThrow('state deadline');
    expect(s.metrics.recordObservation).toHaveBeenLastCalledWith(
      s.params.update.message!.chatId,
      'COMPARISON_FAILED',
      true,
    );
  });

  it.each([
    ['qualification_rejected', 'MATCHED_QUALIFICATION_REJECTED'],
    ['claim_blocked', 'MATCHED_CLAIM_BLOCKED'],
    ['policy_changed', 'POLICY_CHANGED'],
    ['binding_invalid', 'MATCHED_INELIGIBLE'],
  ] as const)('reports actual %s refusal after a text match', async (reason, outcome) => {
    const s = setup();
    s.enforcement.enqueue.mockResolvedValue({ kind: 'rejected', reason });
    expect(await s.service.observe(s.params)).toBe(outcome);
    expect(s.metrics.recordObservation).toHaveBeenLastCalledWith('-123', outcome, true);
  });

  it('counts TEXT captions with known unsupported media as supported comparisons', async () => {
    const s = setup();
    s.params.settings.duplicateCompareMode = 'TEXT';
    s.params.update = duplicateUpdate('caption', s.params.eventTimestampMs, 'caption', [
      { type: 'location', payload: { latitude: 55.7, longitude: 37.6 } },
    ]);
    expect(await s.service.observe(s.params)).toBe('ENFORCEMENT_REQUESTED');
    expect(s.metrics.recordObservation).toHaveBeenLastCalledWith(
      '-123',
      'ENFORCEMENT_REQUESTED',
      true,
    );
    expect(s.queue.enqueue).not.toHaveBeenCalled();
  });
  it.each(['MESSAGE', 'TEXT'] as const)(
    'enforces a repeated caption before image analysis with retained %s settings',
    async (duplicateCompareMode) => {
      const s = setup();
      s.params.settings.duplicateCompareMode = duplicateCompareMode;
      s.params.update = duplicateUpdate('photo', s.params.eventTimestampMs, 'same offer', [
        { type: 'image', payload: { photo_id: 'new-photo', url: 'https://i.oneme.ru/new' } },
      ]);
      expect(await s.service.observe(s.params)).toBe('ENFORCEMENT_REQUESTED');
      expect(s.history.observeWithOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ comparison: 'TEXT' }),
      );
      expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
      expect(s.queue.enqueue).not.toHaveBeenCalled();
    },
  );
  it('distinguishes stale/unverified history from a verified non-match and keeps action failures separate', async () => {
    const s = setup();
    s.history.observeWithOutcome.mockResolvedValue({ outcome: 'STALE', match: null });
    expect(await s.service.observe(s.params)).toBe('STALE');
    expect(s.metrics.recordObservation).toHaveBeenLastCalledWith(
      s.params.update.message!.chatId,
      'STALE',
      true,
    );
    s.history.observeWithOutcome.mockResolvedValue({ outcome: 'COMPARED_NO_MATCH', match: null });
    expect(await s.service.observe(s.params)).toBe('COMPARED_NO_MATCH');
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    s.history.observeWithOutcome.mockResolvedValue({
      outcome: 'MATCHED',
      match: { hit: {}, binding: {} },
    });
    const original = new Error('intent unavailable');
    s.enforcement.enqueue.mockRejectedValue(original);
    await expect(s.service.observe(s.params)).rejects.toBe(original);
    expect(s.metrics.recordObservation).toHaveBeenLastCalledWith(
      s.params.update.message!.chatId,
      'MATCHED_ACTION_FAILED',
      true,
    );
  });
  it('keeps diagnostic faults out of the moderation result', async () => {
    const s = setup();
    s.metrics.recordObservation.mockImplementation(() => {
      throw new Error('diagnostics unavailable');
    });
    s.metrics.recordPhase.mockImplementation(() => {
      throw new Error('diagnostics unavailable');
    });
    await expect(s.service.observe(s.params)).resolves.toBe('ENFORCEMENT_REQUESTED');
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
  });
  it.each(['MESSAGE', 'TEXT'] as const)(
    'queues optional media only when text has no match with retained %s settings',
    async (duplicateCompareMode) => {
      const s = setup();
      s.params.settings.duplicateCompareMode = duplicateCompareMode;
      s.history.observe.mockResolvedValue(null);
      s.params.update = duplicateUpdate('m2', s.params.eventTimestampMs, 'new caption', [
        { type: 'image', payload: { photo_id: 'photo', url: 'https://i.oneme.ru/photo' } },
      ]);
      expect(await s.service.observe(s.params)).toBe('MEDIA_QUEUED');
      expect(s.queue.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookEventId: 'receipt',
          comparison: 'IMAGE',
          actionEligible: false,
        }),
      );
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );
  it('retains non-photo media comparison as a fallback after text', async () => {
    const s = setup();
    s.history.observe.mockResolvedValue(null);
    s.params.update = duplicateUpdate('file', s.params.eventTimestampMs, '', [
      { type: 'file', payload: { url: 'https://fd.oneme.ru/file' } },
    ]);
    expect(await s.service.observe(s.params)).toBe('MEDIA_QUEUED');
    expect(s.queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ webhookEventId: 'receipt', actionEligible: true }),
    );
  });
  it('observes shadow and competing legacy outcomes without new actions', async () => {
    const s = setup();
    await s.service.observe({ ...s.params, actionEligible: false });
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    await s.service.observe({ ...s.params, track: false });
    expect(s.history.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: expect.objectContaining({ complete: false }) }),
    );
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    s.policy.resolve.mockResolvedValue({ mode: 'shadow', revision: 1 });
    await s.service.observe(s.params);
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });
  it('does not admit disabled, non-canary, or untrusted ingress-clock observations', async () => {
    const s = setup();
    await s.service.observe({ ...s.params, eventTimestampMs: undefined });
    await s.service.observe({
      ...s.params,
      settings: duplicateSettings({ antiDuplicateEnabled: false }),
    });
    s.policy.resolve.mockResolvedValue({ mode: 'off' });
    await s.service.observe(s.params);
    expect(s.history.observe).not.toHaveBeenCalled();
    expect(s.metrics.record).toHaveBeenCalledWith('admission.event_time_rejected');
    expect(s.metrics.record).toHaveBeenCalledWith('admission.off');
  });
});
