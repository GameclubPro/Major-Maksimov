import { randomUUID } from 'node:crypto';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import { CommercialAiObservationGate } from './commercial-ai-runtime-observation';
import type { CommercialAiObservationService } from './commercial-ai-observation.service';
import type { CommercialLlmEnforcementMailbox } from './commercial-llm-enforcement.mailbox';
import type { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { buildCommercialLlmOffer } from './commercial-llm-enforcement.protocol';
import { COMMERCIAL_LLM_POOL_PROFILES } from './commercial-llm-pool.protocol';
import {
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';

const result: CommercialLlmObservationResult = {
  ...COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity,
  classification: 'COMMERCIAL',
  reasonCodes: ['COMMERCIAL_OFFER'],
  policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
  durationMs: 3,
  pool: {
    version: 'commercial-pool-v2',
    nodeId: 'pc-b-9b',
    route: 'direct',
    policy: 'confirm-positive',
    attempts: 1,
  },
};
function fixture() {
  const now = Date.now();
  const offer = buildCommercialLlmOffer(
    {
      chatId: 'chat',
      messageId: 'message',
      userId: 'user',
      originBotId: 'bot',
      text: 'Мастерская принимает заказы на ремонт.',
      eventAt: new Date(now).toISOString(),
      settings: { commercialAdsFilterEnabled: true } as Parameters<
        typeof buildCommercialLlmOffer
      >[0]['settings'],
      origin: {
        sourceWebhookEventId: randomUUID(),
        sourceReceivingBotId: 'bot',
        sourceExecutionBotId: 'bot',
        sourceEventAtMs: now,
        sourceEvidenceVersion: 1,
      },
    },
    now,
    'confirm-positive',
  )!;
  let current = true;
  const worker = randomUUID();
  const request = { ...offer, worker, submittedAtMs: now };
  const mailbox: jest.Mocked<
    Pick<
      CommercialLlmEnforcementMailbox,
      'take' | 'ownsWorker' | 'owns' | 'prove' | 'hasProof' | 'finish'
    >
  > = {
    take: jest
      .fn<
        ReturnType<CommercialLlmEnforcementMailbox['take']>,
        Parameters<CommercialLlmEnforcementMailbox['take']>
      >()
      .mockResolvedValue({ request, raw: JSON.stringify(request) }),
    ownsWorker: jest.fn<
      ReturnType<CommercialLlmEnforcementMailbox['ownsWorker']>,
      Parameters<CommercialLlmEnforcementMailbox['ownsWorker']>
    >(async () => current),
    owns: jest.fn<
      ReturnType<CommercialLlmEnforcementMailbox['owns']>,
      Parameters<CommercialLlmEnforcementMailbox['owns']>
    >(async () => current),
    prove: jest.fn<
      ReturnType<CommercialLlmEnforcementMailbox['prove']>,
      Parameters<CommercialLlmEnforcementMailbox['prove']>
    >(async () => current),
    hasProof: jest.fn<
      ReturnType<CommercialLlmEnforcementMailbox['hasProof']>,
      Parameters<CommercialLlmEnforcementMailbox['hasProof']>
    >(async () => current),
    finish: jest
      .fn<
        ReturnType<CommercialLlmEnforcementMailbox['finish']>,
        Parameters<CommercialLlmEnforcementMailbox['finish']>
      >()
      .mockResolvedValue(undefined),
  };
  const writer: jest.Mocked<Pick<CommercialAiObservationService, 'update'>> = {
    update: jest
      .fn<
        ReturnType<CommercialAiObservationService['update']>,
        Parameters<CommercialAiObservationService['update']>
      >()
      .mockResolvedValue('written'),
  };
  const ensureIntent = jest
    .fn<
      ReturnType<ModerationDeleteIntentService['ensureIntent']>,
      Parameters<ModerationDeleteIntentService['ensureIntent']>
    >()
    .mockResolvedValue({ intentId: 'intent', rollout: 'execute', status: 'PENDING' });
  const gate = new CommercialAiObservationGate();
  return {
    offer,
    worker,
    mailbox,
    writer,
    ensureIntent,
    gate,
    loseSource: () => {
      current = false;
    },
  };
}
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('source-bound asynchronous AI observation', () => {
  it('retains the actual response before a later authority veto and never registers its deletion', async () => {
    const h = fixture();
    const processor = new CommercialLlmEnforcementProcessor(
      h.mailbox,
      {
        classify: async () => {
          h.loseSource();
          return result;
        },
      },
      { ensureIntent: h.ensureIntent },
      async () => true,
      { writer: h.writer, gate: h.gate },
    );
    expect(await processor.run(h.worker, new AbortController().signal)).toMatchObject({
      outcome: 'source_expired',
    });
    await settle();
    expect(h.ensureIntent).not.toHaveBeenCalled();
    expect(h.writer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        source: h.offer.source,
        admission: { state: 'ACCEPTED', reason: null },
        analysis: expect.objectContaining({
          state: 'COMPLETE',
          result,
          policyDeleteEligible: true,
        }),
        registration: { state: 'REJECTED', intentIdSha256: null, reason: 'SOURCE_EXPIRED' },
      }),
    );
  });
  it('contains evidence storage failure and keeps normal exact-source intent registration', async () => {
    const h = fixture();
    h.writer.update.mockRejectedValue(new Error('isolated optional storage outage'));
    const processor = new CommercialLlmEnforcementProcessor(
      h.mailbox,
      { classify: async () => result },
      { ensureIntent: h.ensureIntent },
      async () => true,
      { writer: h.writer, gate: h.gate },
    );
    expect(await processor.run(h.worker, new AbortController().signal)).toMatchObject({
      outcome: 'delete_registered',
    });
    await settle();
    expect(h.ensureIntent).toHaveBeenCalledTimes(1);
    expect(h.mailbox.finish).toHaveBeenCalledTimes(1);
    expect(h.gate.snapshot().failed).toBeGreaterThan(0);
    const cumulative = h.writer.update.mock.calls.find(
      ([patch]) => patch.registration?.state === 'REGISTERED',
    )?.[0];
    expect(cumulative).toMatchObject({
      analysis: { state: 'COMPLETE', result },
      execution: { state: 'PENDING' },
    });
  });
});
