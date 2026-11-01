import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import {
  CommercialLlmEnforcementMailbox,
  type CommercialLlmAdmissionResult,
} from './commercial-llm-enforcement.mailbox';
import { createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { prepareCommercialLlmOffer } from './commercial-llm-enforcement.protocol';
import { withCanonicalWebhookOrigin } from '../webhook-effect-origin-context';
import { CommercialAiObservationService } from './commercial-ai-observation.service';
import {
  buildCommercialAiObservationContext,
  CommercialAiObservationGate,
} from './commercial-ai-runtime-observation';
import { commercialLlmRequestSchema } from './commercial-llm-enforcement.protocol';

const settings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
  nightModeTimezone: 'Europe/Moscow',
  textFiltersWarnEnabled: true,
  textFiltersMuteEnabled: true,
  textFiltersBanEnabled: true,
  textFiltersMuteDurationHours: 1,
  textFiltersBotMessageEnabled: true,
};
function input(now: number) {
  return {
    chatId: 'chat',
    messageId: 'message',
    userId: 'user',
    originBotId: 'bot',
    text: 'Наша мастерская принимает заказы на ремонт.',
    eventAt: new Date(now).toISOString(),
    settings,
    origin: {
      sourceWebhookEventId: 'receipt',
      sourceReceivingBotId: 'bot',
      sourceExecutionBotId: 'bot',
      sourceEventAtMs: now,
      sourceEvidenceVersion: 1 as const,
    },
  };
}
describe('commercial AI eligibility accounting', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it.each(['resolve', 'reject'] as const)(
    'admits another source while optional evidence remains pending and later %ss',
    async (settlement) => {
      const now = Date.parse('2026-11-01T15:00:00.000Z');
      jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
      const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      let finish!: () => void;
      const pending = new Promise<'written'>((resolve, reject) => {
        finish = () =>
          settlement === 'resolve' ? resolve('written') : reject(new Error('evidence unavailable'));
      });
      const events: string[] = [];
      const writer = new CommercialAiObservationService({} as never);
      const seed = jest.spyOn(writer, 'seed').mockImplementation((value) => {
        events.push(`seed:${value.request.source.messageId}`);
        expect(value.request.submittedAtMs).toBe(now);
        return pending;
      });
      jest.spyOn(writer, 'update').mockResolvedValue('missing');
      const gate = new CommercialAiObservationGate();
      const service = new CommercialLlmEnforcementService(
        new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
        writer,
        gate,
      );
      const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
      const mailbox = new CommercialLlmEnforcementMailbox(redis);
      const submit = jest
        .spyOn(mailbox, 'offerDetailed')
        .mockImplementation(async (offer, beforeAdmission) => {
          const request = commercialLlmRequestSchema.parse({
            ...offer,
            worker: '00000000-0000-4000-8000-000000000001',
            submittedAtMs: now,
          });
          await beforeAdmission?.(request);
          events.push(`accepted:${offer.source.messageId}`);
          return 'accepted';
        });
      jest.spyOn(service, 'mailbox').mockResolvedValue(mailbox);
      async function offer(messageId: string) {
        const source = { ...input(now), messageId };
        const observation = buildCommercialAiObservationContext(
          {
            ...source,
            source: 'TEXT',
            score: 0,
            actionBand: 'ALLOW',
            decisionFingerprint: 'synthetic',
            detectorVersion: 'synthetic',
            messageDisposition: 'KEEP',
            requiredPolicyCohorts: [],
          },
          [],
        );
        await withCanonicalWebhookOrigin(
          {
            webhookEvent: { id: `receipt-${messageId}`, botId: 'bot' },
            activeBotId: 'bot',
            update: {
              updateId: messageId,
              botId: 'bot',
              type: 'message_created',
              eventTimestampSource: 'payload',
              raw: { timestamp: now },
              message: {
                chatId: 'chat',
                messageId,
                senderId: 'user',
                text: source.text,
                createdAt: source.eventAt,
              },
            },
          },
          async () => {
            service.offer({ ...source, observation });
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      try {
        await offer('first');
        await offer('second');
        expect(submit).toHaveBeenCalledTimes(2);
        expect(seed).toHaveBeenCalledTimes(2);
        expect(events).toEqual(['seed:first', 'accepted:first', 'seed:second', 'accepted:second']);
        expect(Date.now()).toBe(now);
        expect(gate.snapshot().unsettled).toBe(2);
        expect(JSON.stringify(logs.mock.calls)).not.toContain('producer_busy');
      } finally {
        finish();
        await new Promise<void>((resolve) => setImmediate(resolve));
        service.onModuleDestroy();
        redis.disconnect();
      }
      expect(submit).toHaveBeenCalledTimes(2);
      expect(gate.snapshot().unsettled).toBe(0);
    },
  );
  it('separates disabled/missing-origin inputs from eligible busy and accepted sources', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
    const mailbox = new CommercialLlmEnforcementMailbox(redis);
    let finish!: (value: CommercialLlmAdmissionResult) => void;
    const pending = new Promise<CommercialLlmAdmissionResult>((resolve) => {
      finish = resolve;
    });
    const submit = jest.spyOn(mailbox, 'offerDetailed').mockReturnValue(pending);
    jest.spyOn(service, 'mailbox').mockResolvedValue(mailbox);
    const source = input(now);
    service.offer({ ...source, settings: { ...settings, commercialAdsFilterEnabled: false } });
    service.offer(source);
    await withCanonicalWebhookOrigin(
      {
        webhookEvent: { id: 'receipt', botId: 'bot' },
        activeBotId: 'bot',
        update: {
          updateId: 'update',
          botId: 'bot',
          type: 'message_created',
          eventTimestampSource: 'payload',
          raw: { timestamp: now },
          message: {
            chatId: 'chat',
            messageId: 'message',
            senderId: 'user',
            text: source.text,
            createdAt: source.eventAt,
          },
        },
      },
      async () => {
        service.offer(source);
        service.offer(source);
      },
    );
    expect(submit).toHaveBeenCalledTimes(1);
    now += 31_000;
    finish('accepted');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      logs.mock.calls
        .filter(([value]) => typeof value === 'object' && value.stage === 'commercial-ai-admission')
        .at(-1)?.[0],
    ).toMatchObject({
      schemaVersion: 3,
      offered: 4,
      ineligible: 2,
      eligible: 2,
      accepted: 1,
      skipped: 1,
      unavailable: 0,
      inFlight: 0,
      ineligibleReasons: { filter_disabled: 1, invalid_origin: 1 },
      skipReasons: { producer_busy: 1 },
    });
    expect(JSON.stringify(logs.mock.calls)).not.toContain(source.text);
    service.onModuleDestroy();
    redis.disconnect();
  });
  it('settles a delayed admission in its original UTC window and never closes it while in flight', async () => {
    const now = Date.parse('2026-10-27T12:00:59.000Z');
    jest.useFakeTimers({ now, doNotFake: ['setImmediate'] });
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    const redis = createCommercialLlmRedis('redis://127.0.0.1:1');
    const mailbox = new CommercialLlmEnforcementMailbox(redis);
    let finish!: (value: CommercialLlmAdmissionResult) => void;
    jest.spyOn(mailbox, 'offerDetailed').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    jest.spyOn(service, 'mailbox').mockResolvedValue(mailbox);
    service.onModuleInit();
    const source = input(now);
    await withCanonicalWebhookOrigin(
      {
        webhookEvent: { id: 'receipt', botId: 'bot' },
        activeBotId: 'bot',
        update: {
          updateId: 'update',
          botId: 'bot',
          type: 'message_created',
          eventTimestampSource: 'payload',
          raw: { timestamp: now },
          message: {
            chatId: 'chat',
            messageId: 'message',
            senderId: 'user',
            text: source.text,
            createdAt: source.eventAt,
          },
        },
      },
      async () => {
        service.offer(source);
      },
    );
    jest.advanceTimersByTime(11_000);
    const windows = () =>
      logs.mock.calls.filter(
        ([value]) => typeof value === 'object' && value.stage === 'commercial-ai-admission-window',
      );
    expect(windows()).toHaveLength(0);
    finish('buffer_full');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(windows()).toHaveLength(1);
    expect(windows()[0]?.[0]).toMatchObject({
      windowStartAt: '2026-10-27T12:00:00.000Z',
      windowEndAt: '2026-10-27T12:01:00.000Z',
      offered: 1,
      eligible: 1,
      accepted: 0,
      skipped: 1,
      unavailable: 0,
      inFlight: 0,
      skipReasons: { buffer_full: 1 },
      ineligibleReasons: {},
      observationProcessId: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      observationStartedAt: '2026-10-27T12:00:59.000Z',
      selectionBasis: 'offers_or_evaluate_calls',
      evaluation: {
        scope: 'evaluate_calls_while_enforcement_enabled',
        evaluated: 0,
        forwardedToOffer: 0,
        excluded: 0,
        exclusionReasons: {},
      },
    });
    jest.advanceTimersByTime(60_000);
    expect(windows()).toHaveLength(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(source.text);
    service.onModuleDestroy();
    redis.disconnect();
  });
  it('accounts for evaluate exclusions without changing rule routing or the offer denominator', () => {
    const now = Date.parse('2026-10-27T12:00:15.000Z');
    jest.useFakeTimers({ now });
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    service.onModuleInit();
    const source = input(now);
    const update: MaxUpdate = {
      updateId: 'private-update',
      botId: 'private-bot',
      type: 'message_created',
      eventTimestampSource: 'payload',
      message: {
        chatId: 'private-chat',
        messageId: 'private-message',
        senderId: 'private-user',
        text: source.text,
        createdAt: source.eventAt,
      },
    };
    const commercial = { ruleCode: 'COMMERCIAL_AD', score: 1, reason: 'commercial' };
    const other = { ruleCode: 'LINK_BLOCKED', score: 1, reason: 'link' };
    const submit = jest.spyOn(service, 'offer');
    const connect = jest.spyOn(service, 'mailbox');

    expect(
      service.evaluate([commercial], { ...update, message: undefined }, settings, true),
    ).toEqual([]);
    expect(
      service.evaluate([], { ...update, eventTimestampSource: 'ingress' }, settings, true),
    ).toEqual([]);
    expect(service.evaluate([commercial], update, settings, true)).toEqual([]);
    expect(service.evaluate([commercial, other], update, settings, false)).toEqual([other]);
    expect(
      service.evaluate([], update, { ...settings, commercialAdsFilterEnabled: false }, false),
    ).toEqual([]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60_000);
    const windows = logs.mock.calls.filter(
      ([value]) => typeof value === 'object' && value.stage === 'commercial-ai-admission-window',
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.[0]).toMatchObject({
      offered: 1,
      ineligible: 1,
      eligible: 0,
      ineligibleReasons: { filter_disabled: 1 },
      skipReasons: {},
      evaluation: {
        scope: 'evaluate_calls_while_enforcement_enabled',
        evaluated: 5,
        forwardedToOffer: 1,
        excluded: 4,
        exclusionReasons: {
          missing_message: 1,
          untrusted_event_time: 1,
          protected_author: 1,
          other_rule: 1,
        },
      },
      fleetCoverage: 'not_established',
      intakeBoundaryObserved: false,
    });
    const output = JSON.stringify(logs.mock.calls);
    for (const privateValue of ['private-chat', 'private-message', 'private-user', source.text])
      expect(output).not.toContain(privateValue);
    service.onModuleDestroy();
  });

  it('binds the original candidate and pre-routing detector decision at the focused AI boundary', () => {
    const source = input(Date.now());
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    const submit = jest.spyOn(service, 'offer').mockImplementation(() => undefined);
    const candidate = {
      ...source,
      source: 'TEXT' as const,
      score: 0,
      actionBand: 'ALLOW',
      decisionFingerprint: 'synthetic',
      detectorVersion: 'synthetic',
      detectorSourceSha256: 'a'.repeat(64),
      messageDisposition: 'KEEP' as const,
      requiredPolicyCohorts: [],
    };
    const violations = [
      {
        ruleCode: 'COMMERCIAL_AD',
        score: 0.8,
        reason: 'synthetic',
        metadata: { actionable: true, messageDisposition: 'DELETE', actionBand: 'DELETE' },
      },
    ];
    expect(
      service.evaluate(
        violations,
        {
          updateId: 'update',
          type: 'message_created',
          eventTimestampSource: 'payload',
          message: {
            chatId: source.chatId,
            messageId: source.messageId,
            senderId: source.userId,
            text: source.text,
            createdAt: source.eventAt,
          },
        },
        settings,
        false,
        candidate,
      ),
    ).toEqual([]);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          candidate,
          activeAuthority: 'AI_DELETE_ONLY',
          detectorBaseline: expect.objectContaining({
            decision: expect.objectContaining({ hasDetection: true, deleteEligible: true }),
          }),
          actualSynchronousDecision: {
            semantics: 'actual_post_routing_v1',
            decision: expect.objectContaining({ hasDetection: false, deleteEligible: false }),
          },
        }),
      }),
    );
    service.onModuleDestroy();
  });

  it('emits a real evaluation-only window once and never fabricates quiet traffic', () => {
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    jest.useFakeTimers({ now });
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const service = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
    );
    service.onModuleInit();
    service.evaluate([], { updateId: 'private-update', type: 'message_created' }, settings, false);
    jest.advanceTimersByTime(180_000);
    const windows = logs.mock.calls.filter(
      ([value]) => typeof value === 'object' && value.stage === 'commercial-ai-admission-window',
    );
    expect(windows).toHaveLength(1);
    expect(windows[0]?.[0]).toMatchObject({
      selectionBasis: 'offers_or_evaluate_calls',
      offered: 0,
      accepted: 0,
      eligible: 0,
      evaluation: { evaluated: 1, excluded: 1, exclusionReasons: { missing_message: 1 } },
    });
    const cumulative = logs.mock.calls.find(
      ([value]) => typeof value === 'object' && value.stage === 'commercial-ai-admission',
    )?.[0];
    expect(cumulative).toMatchObject({
      observationProcessId: windows[0]?.[0].observationProcessId,
      observationStartedAt: '2026-10-27T12:00:00.000Z',
    });
    service.onModuleDestroy();
  });

  it('keeps separate generations and leaves disabled enforcement silent', () => {
    jest.useFakeTimers({ now: new Date('2026-10-27T12:00:00.000Z') });
    const logs = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const disabled = new CommercialLlmEnforcementService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: false }),
    );
    disabled.onModuleInit();
    const commercial = { ruleCode: 'COMMERCIAL_AD', score: 1, reason: 'commercial' };
    const update: MaxUpdate = { updateId: 'private-update', type: 'message_created' };
    expect(disabled.evaluate([commercial], update, settings, false)).toEqual([commercial]);
    jest.advanceTimersByTime(60_000);
    expect(logs).not.toHaveBeenCalled();
    disabled.onModuleDestroy();

    const services = [0, 1].map(
      () =>
        new CommercialLlmEnforcementService(
          new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true }),
        ),
    );
    for (const service of services) service.evaluate([], update, settings, false);
    const identities = logs.mock.calls.map(([value]) => value.observationProcessId);
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
    services.forEach((service) => service.onModuleDestroy());
  });
  it('reports ineligibility without conflating it with an AI decision or capacity failure', () => {
    const now = Date.now(),
      source = input(now);
    expect(prepareCommercialLlmOffer({ ...source, text: '' }, now)).toEqual({
      reason: 'empty_text',
    });
    expect(prepareCommercialLlmOffer({ ...source, text: 'a'.repeat(2501) }, now)).toEqual({
      reason: 'oversized_text',
    });
    expect(prepareCommercialLlmOffer({ ...source, eventAt: 'invalid' }, now)).toEqual({
      reason: 'invalid_event_time',
    });
    expect(
      prepareCommercialLlmOffer({ ...source, eventAt: new Date(now - 10_001).toISOString() }, now),
    ).toEqual({ reason: 'stale_event' });
    expect(
      prepareCommercialLlmOffer(
        { ...source, origin: { ...source.origin, sourceEventAtMs: now - 1 } },
        now,
      ),
    ).toEqual({ reason: 'invalid_origin' });
    expect(prepareCommercialLlmOffer(source, now).offer).toBeDefined();
  });
});
