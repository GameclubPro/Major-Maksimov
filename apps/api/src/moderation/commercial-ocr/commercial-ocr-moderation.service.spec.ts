import { performance } from 'node:perf_hooks';
import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';

import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import { buildCommercialQualitySample } from '../commercial/commercial-quality-sampling';
import { buildWebhookSemanticEventKey } from '../../webhook/webhook-semantic-event-key';
import type {
  CommercialOcrAdmissionStore,
  CommercialOcrAdmissionActivationResult,
  CommercialOcrAdmissionSuppressionResult,
} from './commercial-ocr-admission.store';
import {
  COMMERCIAL_OCR_DECISION_POLICY_VERSION,
  evaluateCommercialOcrDecision,
  type CommercialOcrDecision,
  type CommercialOcrPass,
} from './commercial-ocr-decision-policy';
import {
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  parseCommercialOcrDeleteBinding,
} from './commercial-ocr-delete-guard.service';
import { CommercialOcrModerationService } from './commercial-ocr-moderation.service';
import type { CommercialOcrMetricsService } from './commercial-ocr-metrics.service';
import { CommercialOcrProcessor } from './commercial-ocr.processor';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_DEFAULT_VERSION,
  COMMERCIAL_OCR_JOB_NAME,
  COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
  type CommercialOcrJob,
} from './commercial-ocr.queue';
import { fingerprintCommercialOcrSettingsProfile } from './commercial-ocr-settings-profile';
import type { CommercialOcrRolloutMode } from './commercial-ocr.runtime';

const sourceCreatedAt = '2026-08-12T08:00:00.000Z';
const jobId = 'commercial-image-ocr__fixture';
const activeDeadlineAtMs = Date.now() + 60_000;

type AnalysisFixture =
  | {
      kind: 'complete';
      decision: CommercialOcrDecision;
      imageTextStopListDecision?:
        | { kind: 'no_action' }
        | {
            kind: 'match';
            ruleCode: 'MESSAGE_BLOCKED_WORD' | 'MESSAGE_BLOCKED_DOMAIN';
            value: string;
            imageIndex: number;
            primaryConfidencePermille: number;
            confirmationConfidencePermille: number;
          };
    }
  | {
      kind: 'incomplete';
      reason: string;
      imageIndex?: number;
      pass?: 'primary' | 'confirmation';
    }
  | { kind: 'retry'; reason: 'download_failed' | 'ocr_failed' };

type AccessFixture = {
  userId: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
};

type HarnessOptions = {
  mode?: CommercialOcrRolloutMode;
  nativeRuntimeFingerprint?: string;
  nativeComplete?: boolean;
  imageTextRolloutMode?: 'off' | 'shadow' | 'on';
  sandboxBoundaryVerified?: boolean;
  initialSettings?: ChatSettings;
  normalizedUpdate?: MaxUpdate;
  exactRows?: Array<Record<string, unknown> | null>;
  analysis?: AnalysisFixture;
  latches?: boolean[];
  admissionStates?: Array<'pending' | 'actionable' | 'observation'>;
  finalSettings?: ChatSettings;
  commitSettings?: ChatSettings;
  initialAdminUserIds?: string[];
  finalAdminUserIds?: string[];
  accessRows?: AccessFixture[];
  immunityResult?: 'granted' | 'not_granted';
  immunityError?: Error;
  runtimePolicies?: Array<{
    enforce: boolean;
    controlExpiresAt?: string;
    kind?: 'BASELINE' | 'CERTIFIED';
    behaviorIdentitySha256?: string;
    settingsFingerprint?: string;
    nativeBehaviorIdentitySha256?: string;
  }>;
  governorDecision?: {
    action: 'run' | 'slow' | 'pause';
    retryAfterMs: number;
    reason: string;
  };
  governorError?: Error;
  webhookStatus?: WebhookStatus;
  webhookError?: Error;
  exactError?: Error;
  reviewError?: Error;
  samplingSecret?: string;
  activationResult?: CommercialOcrAdmissionActivationResult;
  suppressionResult?: CommercialOcrAdmissionSuppressionResult;
  reservationTtlMs?: number;
};

describe('CommercialOcrModerationService', () => {
  it.each([WebhookStatus.PROCESSED, WebhookStatus.DUPLICATE])(
    'does not rebind or analyze an abandoned source with a retained %s receipt',
    async (webhookStatus) => {
      const harness = buildHarness({ webhookStatus, admissionStates: ['pending'] });
      harness.legacyHolds.isUpdateHeld.mockResolvedValue(true);
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed', terminal: { outcome: 'LEGITIMATE_SKIP' } });
      expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
      expect(harness.admissionStore.activate).not.toHaveBeenCalled();
      expect(harness.prisma.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.commercialReview.recordCandidate).not.toHaveBeenCalled();
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
      expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it('does not recreate an abandoned source as a technical review sample', async () => {
    const harness = buildHarness();
    harness.legacyHolds.isUpdateHeld.mockResolvedValue(true);
    await harness.service.recordTechnicalIncomplete(job(), jobId, 'ocr_timeout');
    expect(harness.legacyHolds.isUpdateHeld).toHaveBeenCalledWith(update());
    expect(harness.prisma.chat.findUnique).not.toHaveBeenCalled();
    expect(harness.commercialReview.recordCandidate).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('keeps another outer message by the same participant eligible for OCR', async () => {
    const harness = buildHarness();
    harness.legacyHolds.isUpdateHeld.mockImplementation(
      async (candidate: MaxUpdate) => candidate.message?.messageId === 'abandoned-other-message',
    );
    await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
  });

  it('fails closed before OCR source reads when the source hold read is unavailable', async () => {
    const harness = buildHarness();
    harness.legacyHolds.isUpdateHeld.mockRejectedValue(new Error('source hold read unavailable'));
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).rejects.toThrow('source hold read unavailable');
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('settles a no-replay source and suppresses pending OCR without rebind or new effects', async () => {
    const harness = buildHarness({
      webhookStatus: 'NO_REPLAY_HELD' as WebhookStatus,
      admissionStates: ['pending'],
    });
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed', terminal: { outcome: 'LEGITIMATE_SKIP' } });
    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.activate).not.toHaveBeenCalled();
    expect(harness.prisma.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each(['READY', 'COMPLETED'])(
    'treats a duplicate OCR mirror with a no-replay owner and %s claim as terminal',
    async (status) => {
      const normalizedUpdate = update();
      const semanticKey = buildWebhookSemanticEventKey(normalizedUpdate);
      const completedAt = new Date('2026-08-12T08:00:01.000Z');
      const harness = buildHarness({
        normalizedUpdate,
        webhookStatus: WebhookStatus.DUPLICATE,
        admissionStates: ['pending'],
      });
      harness.prisma.webhookExecutionClaim.findUnique.mockResolvedValue({
        id: 'claim-ocr-held-owner',
        semanticKey,
        webhookEventId: 'webhook-held-owner',
        executionBotId: 'execution-bot',
        enforced: true,
        status,
        preparedAt: new Date('2026-08-12T08:00:00.000Z'),
        completedAt: status === 'COMPLETED' ? completedAt : null,
        leaseToken: null,
        leaseExpiresAt: null,
        webhookEvent: {
          status: 'NO_REPLAY_HELD',
          processedAt: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          errorMessage: null,
          normalizedPayload: normalizedUpdate,
        },
      });
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed' });
      expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
      expect(harness.admissionStore.activate).not.toHaveBeenCalled();
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('limited'), {
      response: { status: 429, headers: { 'retry-after': '30' } },
    }),
    Object.assign(new Error('unavailable'), { response: { status: 503 } }),
  ])(
    'retries only a temporary exact-source read and leaves pending admission reserved: %o',
    async (exactError) => {
      const harness = buildHarness({ exactError, admissionStates: ['pending'] });
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({ kind: 'retry', reason: 'source_unavailable' });
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.admissionStore.suppress).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 410])(
    'keeps failed exact-source HTTP %s technically incomplete and terminal',
    async (status) => {
      const harness = buildHarness({
        exactError: Object.assign(new Error('denied'), { response: { status } }),
        admissionStates: ['pending'],
      });
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({
        kind: 'completed',
        terminal: { outcome: 'TECHNICAL_INCOMPLETE', reason: 'source_unavailable' },
      });
      expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 410])(
    'records HTTP %s through processor completion as a technical quality sample without retry or enforcement',
    async (status) => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(sourceCreatedAt) + 60_000);
      try {
        const harness = buildProcessorHarness({
          exactError: Object.assign(new Error('unavailable'), { response: { status } }),
          admissionStates: ['pending'],
        });
        await expect(harness.processor.process(harness.queueJob)).resolves.toBeUndefined();
        expect(harness.processorAdmission.finalize).toHaveBeenCalledWith(
          expect.objectContaining({
            terminal: { outcome: 'TECHNICAL_INCOMPLETE', reason: 'source_unavailable' },
          }),
        );
        expect(harness.commercialReview.recordCandidate).toHaveBeenCalledTimes(1);
        expect(harness.commercialReview.recordCandidate).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'OCR',
            samplingStratum: 'TECHNICAL',
            samplingProbability: 1,
            analysisOutcome: 'TECHNICAL_INCOMPLETE',
            reasons: ['source_unavailable'],
            decisionOutcome: null,
            deleteEligible: null,
            executionOutcome: 'NOT_REQUESTED',
            messageDisposition: 'KEEP',
          }),
        );
        expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
        expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
        expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
        expect(
          harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
        ).not.toHaveBeenCalled();
        expect(harness.queueJob.moveToDelayed).not.toHaveBeenCalled();
        expect(harness.queueJob.updateData).not.toHaveBeenCalled();
        expect(harness.queueJob.data).toEqual(harness.originalJobData);
        expect(harness.processorAdmission.release).toHaveBeenCalledWith({
          jobId: harness.queueJob.id,
          chatId: harness.queueJob.data.chatId,
        });
      } finally {
        now.mockRestore();
      }
    },
  );

  it('keeps successful source absence separate from incomplete reads through processor completion', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(sourceCreatedAt) + 60_000);
    try {
      const harness = buildProcessorHarness({ exactRows: [null], admissionStates: ['pending'] });
      await expect(harness.processor.process(harness.queueJob)).resolves.toBeUndefined();
      expect(harness.processorAdmission.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: { outcome: 'LEGITIMATE_SKIP', reason: 'source_absent' },
        }),
      );
      expect(harness.commercialReview.recordCandidate).not.toHaveBeenCalled();
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.queueJob.updateData).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('does not record another technical sample when the terminal claim was already settled', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(sourceCreatedAt) + 60_000);
    try {
      const harness = buildProcessorHarness({
        exactError: Object.assign(new Error('unavailable'), { response: { status: 403 } }),
        admissionStates: ['pending'],
      });
      harness.processorAdmission.finalize.mockResolvedValue('duplicate');
      await expect(harness.processor.process(harness.queueJob)).resolves.toBeUndefined();
      expect(harness.commercialReview.recordCandidate).not.toHaveBeenCalled();
      expect(harness.processorAdmission.release).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('rechecks changed settings and fresh administrator access on a recovered source read', async () => {
    const harness = buildHarness();
    harness.maxClient.getExactMessageRow.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    );
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'retry' });
    harness.maxClient.getChatMemberAccess.mockResolvedValueOnce({
      userId: 'user-1',
      isAdmin: true,
      isOwner: false,
      permissions: [],
    });
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(harness.prisma.chat.findUnique).toHaveBeenCalled();
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('captures technical analysis with the original caption and no recognition output', async () => {
    const harness = buildHarness({ analysis: { kind: 'incomplete', reason: 'ocr_timeout' } });
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      terminal: { outcome: 'TECHNICAL_INCOMPLETE', reason: 'ocr_timeout' },
    });
    expect(harness.commercialReview.recordCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'OCR',
        samplingStratum: 'TECHNICAL',
        samplingProbability: 1,
        hasDetection: false,
        decisionOutcome: null,
        deleteEligible: null,
        imageReviewRequired: true,
      }),
    );
  });

  it('includes a selected captionless no-detection photo in the independent sampling stream', async () => {
    const samplingSecret = Array.from(
      { length: 100 },
      (_, index) => `fixture-commercial-secret-${index}`,
    ).find((secret) =>
      buildCommercialQualitySample({
        secret,
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        text: '',
        messageCreatedAt: sourceCreatedAt,
        source: 'OCR',
        hasDetection: false,
      }),
    );
    expect(samplingSecret).toBeDefined();
    const normalizedUpdate = update();
    normalizedUpdate.message!.text = '';
    (normalizedUpdate.raw as { message: { body: { text: string } } }).message.body.text = '';
    const harness = buildHarness({
      samplingSecret,
      normalizedUpdate,
      exactRows: [exactMessage({ caption: '' })],
      analysis: {
        kind: 'complete',
        decision: { ...noActionDecision(['no_detection']), images: [] },
      },
    });
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ terminal: { outcome: 'COMPLETE_KEEP' } });
    expect(harness.commercialReview.recordCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '',
        source: 'OCR',
        hasDetection: false,
        samplingStratum: 'NO_HIT',
        samplingProbability: expect.closeTo(0.1, 8),
        imageReviewRequired: true,
        decisionOutcome: 'KEEP',
      }),
    );
  });

  it('rechecks immunity after a recovered source read before creating any delete intent', async () => {
    const harness = buildHarness({ immunityResult: 'granted' });
    harness.maxClient.getExactMessageRow.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    );
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'retry' });
    await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);
    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(1);
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });
  it('enforces the strict opt-in baseline with live native attestation and no fictional certificate', async () => {
    const harness = buildHarness({ mode: 'baseline', sandboxBoundaryVerified: true });
    await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);
    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    const binding = parseCommercialOcrDeleteBinding(persisted.intent.event.metadata)!;
    expect(binding.authority).toEqual({
      kind: 'BASELINE',
      behaviorIdentitySha256: 'a'.repeat(64),
      nativeBehaviorIdentitySha256: 'b'.repeat(64),
      settingsFingerprint: fingerprintCommercialOcrSettingsProfile(settings()),
    });
    expect(binding.ocrDeadlineAt).toBe(new Date(activeDeadlineAtMs).toISOString());
    expect(binding).not.toHaveProperty('controlRevision');
    expect(binding).not.toHaveProperty('controlExpiresAt');
    expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    { sandboxBoundaryVerified: false },
    { sandboxBoundaryVerified: true, nativeComplete: false },
    { sandboxBoundaryVerified: true, nativeRuntimeFingerprint: 'c'.repeat(64) },
  ])(
    'keeps the message when the live baseline sandbox cannot attest its exact identity: %o',
    async (nativeOptions) => {
      const harness = buildHarness({ mode: 'baseline', ...nativeOptions });
      await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: 'CERTIFIED' as const },
    { kind: 'BASELINE' as const, behaviorIdentitySha256: 'c'.repeat(64) },
    { kind: 'BASELINE' as const, nativeBehaviorIdentitySha256: 'c'.repeat(64) },
    { kind: 'BASELINE' as const, settingsFingerprint: 'c'.repeat(64) },
  ])('revokes a pending baseline decision when its authority changes: %o', async (changed) => {
    const harness = buildHarness({
      mode: 'baseline',
      sandboxBoundaryVerified: true,
      runtimePolicies: [{ enforce: true }, { enforce: true }, { enforce: true, ...changed }],
    });
    await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('captures OCR observations with visible caption only and never labels a pending deletion DELETE', async () => {
    const harness = buildHarness({ mode: 'baseline', sandboxBoundaryVerified: true });
    await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);
    expect(harness.commercialReview.recordCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'OCR',
        text: 'Buy now',
        messageDisposition: 'KEEP',
        decisionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(JSON.stringify(harness.commercialReview.recordCandidate.mock.calls)).not.toContain(
      '79991234567',
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(
      harness.commercialReview.recordCandidate.mock.calls.every(
        ([record]) => record.messageDisposition === 'KEEP',
      ),
    ).toBe(true);
  });

  it('keeps moderation independent from an unavailable optional review store', async () => {
    const harness = buildHarness({ reviewError: new Error('review unavailable') });
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
  });

  it('analyzes and binds the unchanged immutable photo source despite event timestamp jitter', async () => {
    const eventTimestamp = '2026-08-12T08:00:00.150Z';
    const normalizedUpdate = update();
    normalizedUpdate.message!.createdAt = eventTimestamp;
    const harness = buildHarness({ normalizedUpdate });

    await harness.service.processCommercialOcrJob(
      job({ eventTimestamp }),
      jobId,
      activeDeadlineAtMs,
    );

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('source.ready');
    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    expect(persisted.intent.sourceMessageAt).toBe(sourceCreatedAt);
    expect(parseCommercialOcrDeleteBinding(persisted.intent.event.metadata)?.sourceCreatedAt).toBe(
      sourceCreatedAt,
    );
  });

  it('rejects a changed immutable creation time even when the event clock still matches', async () => {
    const normalizedUpdate = update();
    (
      (normalizedUpdate.raw as Record<string, unknown>).message as Record<string, unknown>
    ).timestamp = '2026-08-12T07:59:59.000Z';
    const harness = buildHarness({ normalizedUpdate });

    await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);

    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('source.creation_time_mismatch');
  });

  it.each([
    { options: { webhookError: new Error('unavailable') }, counter: 'source.receipt.unavailable' },
    { options: { exactError: new Error('unavailable') }, counter: 'source.exact.unavailable' },
    { options: { exactRows: [null] }, counter: 'source.exact.absent' },
  ])(
    'records bounded terminal coverage for $counter without analysis',
    async ({ options, counter }) => {
      const harness = buildHarness(options);
      await harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs);
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.metrics.recordCounter).toHaveBeenCalledWith(counter);
    },
  );

  it('classifies a missing or inaccessible original without claiming absence or creating an intent', async () => {
    const harness = buildHarness({
      exactError: Object.assign(new Error('private response'), { response: { status: 404 } }),
    });
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'completed',
      terminal: { outcome: 'TECHNICAL_INCOMPLETE', reason: 'source_unavailable' },
    });

    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'source.exact.failure.initial.access_or_missing',
    );
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith('source.exact.absent');
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith('source.exact.retry');
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('does not analyze a pending commercial-only job after OCR is switched off', async () => {
    const harness = buildHarness({ mode: 'off' });
    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    await harness.service.recordTechnicalIncomplete(job(), jobId, 'ocr_timeout');
    expect(harness.prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
    expect(harness.commercialReview.recordCandidate).not.toHaveBeenCalled();
  });

  it('disables commercial analysis in a combined job while preserving image stop-list processing', async () => {
    const imageSettings = settings({
      commercialAdsFilterEnabled: true,
      messageLimitsImageTextScanEnabled: true,
      messageLimitsBlockedWords: ['казино'],
    });
    const harness = buildHarness({
      mode: 'off',
      imageTextRolloutMode: 'on',
      sandboxBoundaryVerified: true,
      initialSettings: imageSettings,
      analysis: { kind: 'complete', decision: noActionDecision(['commercial-scan-disabled']) },
    });
    await harness.service.processCommercialOcrJob(
      job({ commercialScanRequested: true, imageTextScanRequested: true }),
      jobId,
      activeDeadlineAtMs,
    );
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ commercialScanEnabled: false, imageTextStopListScanEnabled: true }),
    );
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
    expect(harness.commercialReview.recordCandidate).not.toHaveBeenCalled();
  });

  it('persists a confirmed image stop-list deletion without storing recognized text', async () => {
    const imageSettings = settings({
      commercialAdsFilterEnabled: false,
      messageLimitsImageTextScanEnabled: true,
      messageLimitsBlockedWords: ['казино'],
      messageLimitsBlockedDomains: [],
    });
    const harness = buildHarness({
      initialSettings: imageSettings,
      finalSettings: imageSettings,
      commitSettings: imageSettings,
      imageTextRolloutMode: 'on',
      sandboxBoundaryVerified: true,
      analysis: {
        kind: 'complete',
        decision: noActionDecision(['no-independent-delete-source']),
        imageTextStopListDecision: {
          kind: 'match',
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          value: 'казино',
          imageIndex: 0,
          primaryConfidencePermille: 960,
          confirmationConfidencePermille: 950,
        },
      },
    });

    await expect(
      harness.service.processCommercialOcrJob(
        job({
          commercialScanRequested: false,
          imageTextScanRequested: true,
          ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
        }),
        jobId,
        activeDeadlineAtMs,
      ),
    ).resolves.toMatchObject({ kind: 'completed' });

    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    expect(persisted.intent).toMatchObject({
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      subjectUserId: 'user-1',
      event: {
        metadata: {
          source: 'image_text_ocr',
          matchedRuleCode: 'MESSAGE_BLOCKED_WORD',
          imageIndex: 0,
          blockedWord: 'казино',
          primaryConfidencePermille: 960,
          confirmationConfidencePermille: 950,
        },
      },
    });
    expect(JSON.stringify(persisted)).not.toContain('Buy now');
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
  });

  it('suppresses an image stop-list deletion when the toggle changes after analysis', async () => {
    const initialSettings = settings({
      commercialAdsFilterEnabled: false,
      messageLimitsImageTextScanEnabled: true,
      messageLimitsBlockedWords: ['казино'],
      messageLimitsBlockedDomains: [],
    });
    const harness = buildHarness({
      initialSettings,
      finalSettings: settings({
        ...initialSettings,
        messageLimitsImageTextScanEnabled: false,
      }),
      imageTextRolloutMode: 'on',
      sandboxBoundaryVerified: true,
      analysis: {
        kind: 'complete',
        decision: noActionDecision(['no-independent-delete-source']),
        imageTextStopListDecision: {
          kind: 'match',
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          value: 'казино',
          imageIndex: 0,
          primaryConfidencePermille: 960,
          confirmationConfidencePermille: 950,
        },
      },
    });

    await harness.service.processCommercialOcrJob(
      job({ commercialScanRequested: false, imageTextScanRequested: true }),
      jobId,
      activeDeadlineAtMs,
    );

    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'image_text_stop_list.enforcement.suppressed',
    );
  });

  it('continues an independently authorized commercial deletion when image enforcement is suppressed', async () => {
    const combinedSettings = settings({
      messageLimitsImageTextScanEnabled: true,
      messageLimitsBlockedWords: ['казино'],
      messageLimitsBlockedDomains: [],
    });
    const harness = buildHarness({
      initialSettings: combinedSettings,
      finalSettings: combinedSettings,
      commitSettings: combinedSettings,
      imageTextRolloutMode: 'shadow',
      sandboxBoundaryVerified: true,
      analysis: {
        ...deleteAnalysis(),
        imageTextStopListDecision: {
          kind: 'match',
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          value: 'казино',
          imageIndex: 0,
          primaryConfidencePermille: 960,
          confirmationConfidencePermille: 950,
        },
      },
    });

    await harness.service.processCommercialOcrJob(
      job({ commercialScanRequested: true, imageTextScanRequested: true }),
      jobId,
      activeDeadlineAtMs,
    );

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        commercialScanEnabled: true,
        imageTextStopListScanEnabled: true,
      }),
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0].intent;
    expect(persisted.ruleCode).toBe(COMMERCIAL_OCR_DELETE_RULE_CODE);
    expect(persisted.event.metadata).toEqual({
      commercialOcrBinding: expect.any(Object),
    });
  });

  it('gives a confirmed explicit stop-list match ownership when both OCR decisions can enforce', async () => {
    const combinedSettings = settings({
      messageLimitsImageTextScanEnabled: true,
      messageLimitsBlockedWords: ['казино'],
      messageLimitsBlockedDomains: [],
    });
    const harness = buildHarness({
      initialSettings: combinedSettings,
      finalSettings: combinedSettings,
      commitSettings: combinedSettings,
      imageTextRolloutMode: 'on',
      sandboxBoundaryVerified: true,
      analysis: {
        ...deleteAnalysis(),
        imageTextStopListDecision: {
          kind: 'match',
          ruleCode: 'MESSAGE_BLOCKED_WORD',
          value: 'казино',
          imageIndex: 0,
          primaryConfidencePermille: 960,
          confirmationConfidencePermille: 950,
        },
      },
    });

    await harness.service.processCommercialOcrJob(
      job({ commercialScanRequested: true, imageTextScanRequested: true }),
      jobId,
      activeDeadlineAtMs,
    );

    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    expect(persisted.intent.event.metadata).toMatchObject({
      source: 'image_text_ocr',
      enforcementScope: 'delete_only',
      matchedRuleCode: 'MESSAGE_BLOCKED_WORD',
    });
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
  });

  it('does no work for a job whose absolute deadline already expired', async () => {
    const harness = buildHarness();

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, Date.now() - 1),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'normalized source identity mismatch',
      options: { normalizedUpdate: update({ messageId: 'other-message' }) },
    },
    {
      label: 'incomplete normalized photo identity',
      options: { normalizedUpdate: update({ incompleteAttachment: true }) },
    },
    {
      label: 'exact source photo mismatch',
      options: { exactRows: [exactMessage({ photoId: 'other-photo' })] },
    },
    {
      label: 'exact source caption mismatch',
      options: { exactRows: [exactMessage({ caption: 'Changed before analysis' })] },
    },
    {
      label: 'incomplete exact stable photo identity',
      options: { exactRows: [exactMessage({ photoId: null })] },
    },
    {
      label: 'exact bot author',
      options: {
        exactRows: [exactMessage({ sender: { user_id: 'user-1', is_bot: true } })],
      },
    },
    {
      label: 'exact service author',
      options: {
        exactRows: [exactMessage({ sender: { user_id: 'user-1', type: 'service' } })],
      },
    },
    {
      label: 'unknown exact author kind',
      options: { exactRows: [exactMessage({ sender: { user_id: 'user-1' } })] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'fails open on $label',
    async ({ options }) => {
      const harness = buildHarness(options);

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it('suppresses intent creation when certified settings change after final authorization', async () => {
    const harness = buildHarness({
      commitSettings: settings({ commercialAdsDeleteThreshold: 66 }),
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(1);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(2);
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'safe no-action decision',
      analysis: {
        kind: 'complete',
        decision: noActionDecision(['caption-safe-context:job_offer']),
      },
    },
    {
      label: 'incomplete OCR analysis',
      analysis: { kind: 'incomplete' as const, reason: 'ocr_failed' },
    },
    {
      label: 'terminal OCR timeout',
      analysis: { kind: 'incomplete' as const, reason: 'ocr_timeout' },
    },
  ] satisfies Array<{ label: string; analysis: AnalysisFixture }>)(
    'does not create an intent for $label',
    async ({ analysis }) => {
      const harness = buildHarness({ analysis });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
      expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
        analysis.kind === 'complete'
          ? 'analysis.complete.no_action'
          : `analysis.incomplete.${analysis.reason}`,
      );
      if (analysis.kind === 'incomplete') {
        const incompletePass = 'pass' in analysis ? analysis.pass : undefined;
        expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
          `analysis.incomplete.pass.${incompletePass ?? 'none'}`,
        );
      }
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it('runs shadow analysis without claiming or creating a delete intent', async () => {
    const harness = buildHarness({ mode: 'shadow', admissionStates: ['observation'] });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'completed',
    });
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('analysis.complete.delete');
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('enforcement.suppressed.admission');
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('analyzes the canonical webhook caption after exact-source parity succeeds', async () => {
    const normalizedUpdate = update();
    const rawMessage = (normalizedUpdate.raw as { message: { body: Record<string, unknown> } })
      .message;
    rawMessage.body.forwarded_message = {
      body: {
        text: 'Forwarded offer',
      },
    };
    const exact = exactMessage();
    (exact.body as Record<string, unknown>).forwarded_message = {
      body: {
        text: 'Forwarded offer',
      },
    };
    const harness = buildHarness({
      mode: 'shadow',
      normalizedUpdate,
      exactRows: [exact],
      admissionStates: ['observation'],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'completed',
    });
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ caption: 'Buy now Forwarded offer' }),
    );
  });

  it('refreshes persisted photo URLs from the exact MAX row after stable source parity', async () => {
    const harness = buildHarness({
      normalizedUpdate: update({ downloadUrl: 'https://i.oneme.ru/stale-photo-url' }),
      exactRows: [exactMessage({ downloadUrl: 'https://i.oneme.ru/fresh-photo-url' })],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        album: expect.objectContaining({
          images: [
            {
              source: 'direct',
              photoId: 'photo-1',
              downloadUrl: 'https://i.oneme.ru/fresh-photo-url',
            },
          ],
        }),
      }),
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'enforcement.suppressed.source_url_fallback',
    );
  });

  it('analyzes a persisted URL fallback but never creates a delete intent from it', async () => {
    const persistedDownloadUrl = 'https://i.oneme.ru/persisted-photo-url';
    const harness = buildHarness({
      normalizedUpdate: update({ downloadUrl: persistedDownloadUrl }),
      exactRows: [exactMessage({ downloadUrl: null })],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        album: expect.objectContaining({
          images: [expect.objectContaining({ downloadUrl: persistedDownloadUrl })],
        }),
      }),
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'enforcement.suppressed.source_url_fallback',
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('retries a non-retryable download failure when it used a persisted URL fallback', async () => {
    const harness = buildHarness({
      normalizedUpdate: update({ downloadUrl: 'https://i.oneme.ru/expired-photo-url' }),
      exactRows: [exactMessage({ downloadUrl: null })],
      analysis: { kind: 'incomplete', reason: 'download_failed', imageIndex: 0 },
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'retry', reason: 'download_failed' });

    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('analysis.retry.download_failed');
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'analysis.incomplete.download_failed',
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('logs completed decisions at info level with privacy-safe structured fields only', async () => {
    const harness = buildHarness({
      mode: 'shadow',
      admissionStates: ['observation'],
      analysis: {
        kind: 'complete',
        decision: {
          ...noActionDecision(['image-safe-context:0:request_or_recommendation']),
        },
      },
    });
    const log = jest.spyOn((harness.service as any).logger, 'log').mockImplementation(() => {});

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'completed',
    });

    expect(log).toHaveBeenCalledWith(
      {
        imageCount: 1,
        rolloutMode: 'shadow',
        action: 'NO_ACTION',
        reasonCodes: ['image-safe-context:0:request_or_recommendation'],
      },
      'Commercial OCR decision completed',
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /Buy now|photo-1|i\.oneme\.ru|chat-1|message-1|user-1|event-1/u,
    );
  });

  it('logs incomplete analysis coverage without OCR text or source media', async () => {
    const harness = buildHarness({
      mode: 'shadow',
      admissionStates: ['observation'],
      analysis: {
        kind: 'incomplete' as const,
        reason: 'ocr_truncated',
        imageIndex: 0,
        pass: 'primary',
      },
    });
    const log = jest.spyOn((harness.service as any).logger, 'log').mockImplementation(() => {});

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'completed',
    });

    expect(log).toHaveBeenCalledWith(
      {
        imageCount: 1,
        rolloutMode: 'shadow',
        outcome: 'INCOMPLETE',
        reason: 'ocr_truncated',
        imageIndex: 0,
        pass: 'primary',
      },
      'Commercial OCR analysis incomplete',
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /Buy now|photo-1|i\.oneme\.ru|chat-1|message-1|user-1|event-1/u,
    );
  });

  it('recovers a pending admission after durable webhook completion and exact source parity', async () => {
    const harness = buildHarness({
      admissionStates: ['pending', 'actionable'],
      reservationTtlMs: 420_000,
    });

    await expect(
      harness.service.processCommercialOcrJob(
        job({ actionEligible: false }),
        jobId,
        activeDeadlineAtMs,
      ),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.prisma.webhookEvent.findUnique).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(2);
    expect(harness.admissionStore.activate).toHaveBeenCalledWith({
      jobId,
      tombstoneTtlMs: 420_000,
    });
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.attempted',
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.activated',
    );
  });

  it('follows a duplicate OCR envelope to its validated completed semantic owner', async () => {
    const normalizedUpdate = update();
    const semanticKey = buildWebhookSemanticEventKey(normalizedUpdate);
    if (!semanticKey) {
      throw new Error('Expected the OCR source to have a semantic key');
    }
    const completedAt = new Date('2026-08-12T08:00:01.000Z');
    const harness = buildHarness({
      normalizedUpdate,
      webhookStatus: WebhookStatus.DUPLICATE,
      admissionStates: ['pending', 'actionable'],
    });
    harness.prisma.webhookExecutionClaim.findUnique.mockResolvedValue({
      id: 'claim-ocr-owner-1',
      semanticKey,
      webhookEventId: 'webhook-owner-1',
      executionBotId: 'execution-bot',
      enforced: true,
      status: 'COMPLETED',
      preparedAt: new Date('2026-08-12T08:00:00.000Z'),
      completedAt,
      leaseToken: null,
      leaseExpiresAt: null,
      webhookEvent: {
        botId: 'webhook-bot',
        status: WebhookStatus.PROCESSED,
        processedAt: completedAt,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
        normalizedPayload: normalizedUpdate,
      },
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.prisma.webhookExecutionClaim.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey } },
      }),
    );
    expect(harness.admissionStore.suppress).not.toHaveBeenCalled();
    expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
  });

  it('defers a duplicate OCR envelope while its semantic owner is still active', async () => {
    const normalizedUpdate = update();
    const semanticKey = buildWebhookSemanticEventKey(normalizedUpdate);
    if (!semanticKey) {
      throw new Error('Expected the OCR source to have a semantic key');
    }
    const harness = buildHarness({
      normalizedUpdate,
      webhookStatus: WebhookStatus.DUPLICATE,
      admissionStates: ['pending'],
    });
    harness.prisma.webhookExecutionClaim.findUnique.mockResolvedValue({
      id: 'claim-ocr-owner-active-1',
      semanticKey,
      webhookEventId: 'webhook-owner-active-1',
      executionBotId: 'execution-bot',
      enforced: true,
      status: 'READY',
      preparedAt: new Date('2026-08-12T08:00:00.000Z'),
      completedAt: null,
      leaseToken: 'owner-lease',
      leaseExpiresAt: new Date('2026-08-12T08:05:00.000Z'),
      webhookEvent: {
        botId: 'webhook-bot',
        status: WebhookStatus.QUEUED,
        processedAt: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
        normalizedPayload: normalizedUpdate,
      },
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'defer',
      delayMs: 5_000,
      reason: 'source_not_ready',
    });

    expect(harness.admissionStore.suppress).not.toHaveBeenCalled();
    expect(harness.admissionStore.activate).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
  });

  it('defers a pending admission until the webhook is durably processed', async () => {
    const harness = buildHarness({
      admissionStates: ['pending'],
      webhookStatus: WebhookStatus.RECEIVED,
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'defer',
      delayMs: 5_000,
      reason: 'source_not_ready',
    });

    expect(harness.prisma.webhookEvent.findUnique).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.admissionStore.activate).not.toHaveBeenCalled();
    expect(harness.admissionStore.suppress).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'admission.reconciliation.attempted',
    );
  });

  it.each([
    {
      label: 'webhook database lookup is unknown',
      options: { webhookError: new Error('database unavailable') },
    },
    {
      label: 'exact MAX lookup is unknown',
      options: { exactError: new Error('MAX unavailable') },
    },
    {
      label: 'exact source identity changed',
      options: { exactRows: [exactMessage({ caption: 'Changed before recovery' })] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'suppresses pending recovery when $label',
    async ({ options }) => {
      const harness = buildHarness({ ...options, admissionStates: ['pending'] });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed' });

      expect(harness.admissionStore.activate).not.toHaveBeenCalled();
      expect(harness.admissionStore.suppress).toHaveBeenCalledWith({
        jobId,
        chatId: 'chat-1',
        imageCount: 1,
        tombstoneTtlMs: 600_000,
      });
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
        'admission.reconciliation.attempted',
      );
    },
  );

  it.each(['suppressed', 'expired', 'missing'] as const)(
    'does not analyze when pending reconciliation resolves as %s',
    async (activationResult) => {
      const harness = buildHarness({ admissionStates: ['pending'], activationResult });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed' });

      expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
        'admission.reconciliation.suppressed',
      );
    },
  );

  it('absorbs an unknown pending activation and never treats it as actionable', async () => {
    const harness = buildHarness({
      admissionStates: ['pending'],
      activationResult: 'unavailable',
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.activate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.admissionStore.suppress.mock.invocationCallOrder[0]!,
    );
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.unavailable',
    );
  });

  it('still fails open when both activation and its absorbing tombstone are unavailable', async () => {
    const harness = buildHarness({
      admissionStates: ['pending'],
      activationResult: 'unavailable',
      suppressionResult: 'unavailable',
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.unavailable',
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('admission.suppression.unavailable');
  });

  it('accepts a producer-won activation race without attempting another state transition', async () => {
    const harness = buildHarness({
      admissionStates: ['pending', 'actionable'],
      activationResult: 'already_actionable',
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.activated',
    );
  });

  it.each(['actionable', 'observation'] as const)(
    'does not reconcile an admission initially observed as %s',
    async (state) => {
      const harness = buildHarness({
        mode: state === 'observation' ? 'shadow' : 'on',
        admissionStates: [state],
      });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed' });

      expect(harness.admissionStore.activate).not.toHaveBeenCalled();
      expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
        'admission.reconciliation.attempted',
      );
    },
  );

  it('suppresses pending recovery when the deadline expires after source validation', async () => {
    const startedAtMs = Date.now();
    const deadlineAtMs = startedAtMs + 1_000;
    let nowMs = startedAtMs;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const harness = buildHarness({ admissionStates: ['pending'] });
    harness.maxClient.getExactMessageRow.mockImplementation(async () => {
      nowMs = deadlineAtMs;
      return exactMessage();
    });

    try {
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, deadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed' });
    } finally {
      now.mockRestore();
    }

    expect(harness.admissionStore.activate).not.toHaveBeenCalled();
    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.suppressed',
    );
  });

  it('suppresses a recovered admission when the deadline expires during its CAS', async () => {
    const startedAtMs = Date.now();
    const deadlineAtMs = startedAtMs + 1_000;
    let nowMs = startedAtMs;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const harness = buildHarness({ admissionStates: ['pending'] });
    harness.admissionStore.activate.mockImplementation(async () => {
      nowMs = deadlineAtMs;
      return 'activated';
    });

    try {
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, deadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed' });
    } finally {
      now.mockRestore();
    }

    expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.activated',
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.suppressed',
    );
  });

  it.each([
    { action: 'run' as const, authorized: true },
    { action: 'slow' as const, authorized: true },
    { action: 'pause' as const, authorized: false },
  ])(
    'treats governor $action as heavy-stage authorization=$authorized',
    async ({ action, authorized }) => {
      const harness = buildHarness({
        governorDecision: {
          action,
          retryAfterMs: action === 'run' ? 0 : 20_000,
          reason: 'fixture pressure',
        },
      });

      await expect((harness.service as any).authorizeHeavyStage('ocr')).resolves.toMatchObject({
        allowed: authorized,
      });
      expect(harness.governor.decide).toHaveBeenCalledWith({
        component: 'commercial-image-ocr',
        sourceTag: 'commercial_image_ocr',
        allowRecoveryWindowRun: true,
        allowQueueBacklogSlowPath: true,
        ignoredPressureDomains: ['max_api_traffic'],
      });
    },
  );

  it('makes bounded progress under slow pressure while pause overrides an available slot', async () => {
    const harness = buildHarness({
      governorDecision: { action: 'slow', retryAfterMs: 20_000, reason: 'fixture pressure' },
    });
    const authorize = (stage: 'download' | 'ocr') =>
      (harness.service as any).authorizeHeavyStage(stage);
    await expect(authorize('download')).resolves.toMatchObject({ allowed: true });
    await expect(authorize('ocr')).resolves.toMatchObject({ allowed: true });
    await expect(authorize('download')).resolves.toMatchObject({ allowed: true });
    await expect(authorize('ocr')).resolves.toMatchObject({
      allowed: false,
      retryAfterMs: expect.any(Number),
    });
    harness.governor.decide.mockResolvedValueOnce({
      action: 'pause',
      retryAfterMs: 60_000,
      reason: 'emergency',
    });
    await expect(authorize('download')).resolves.toEqual({ allowed: false, retryAfterMs: 60_000 });
  });

  it.each([
    { label: 'automatic queue backlog', condition: 'queue_backlog', allowed: true },
    { label: 'manual pause', condition: 'manual', allowed: false },
    { label: 'MAX degradation', condition: 'max_api', allowed: false },
    { label: 'mixed degradation', condition: 'mixed', allowed: false },
    { label: 'unknown degradation', condition: 'unknown', allowed: false },
    { label: 'host CPU pressure', condition: 'queue_backlog', loadRatio1m: 2, allowed: false },
    { label: 'host IO pressure', condition: 'queue_backlog', ioWaitRatio: 0.5, allowed: false },
  ])('uses real governor fences during $label', async (scenario) => {
    const harness = buildHarness();
    const snapshot = {
      mode: {
        mode: 'degrade',
        source: scenario.condition === 'manual' ? 'manual' : 'auto',
        condition: scenario.condition,
        manualMode: scenario.condition === 'manual' ? 'degrade' : null,
        reason: scenario.label,
      },
      queues: { effectiveLagSec: 3600, operationalLagSec: 3600 },
      systemPressure: {
        enabled: true,
        loadRatio1m: scenario.loadRatio1m ?? 0.1,
        ioWaitRatio: scenario.ioWaitRatio ?? 0,
        thresholds: { loadSlow: 0.85, loadPause: 1.25, ioWaitSlow: 0.15, ioWaitPause: 0.35 },
      },
    };
    const governor = new BackgroundRuntimeGovernorService(
      {} as never,
      { getEffectiveSnapshot: async () => snapshot.mode } as never,
      {} as never,
      new ConfigService(),
    );
    const pressure = jest.spyOn(governor as any, 'getPressureSnapshot').mockResolvedValue(snapshot);
    harness.governor.decide.mockImplementation((request) => governor.decide(request));
    const authorize = (stage: 'download' | 'ocr' | 'ocr_dispatch') =>
      (harness.service as any).authorizeHeavyStage(stage);

    await expect(authorize('download')).resolves.toMatchObject({ allowed: scenario.allowed });
    await expect(authorize('ocr')).resolves.toMatchObject({ allowed: scenario.allowed });
    if (!scenario.allowed) return;
    expect(pressure).toHaveBeenCalled();
    await expect(authorize('ocr_dispatch')).resolves.toMatchObject({ allowed: true });
    // FLAG: The admitted native pass may finish; another cache miss cannot consume a second slot.
    await expect(authorize('ocr')).resolves.toMatchObject({ allowed: false });
    snapshot.mode.condition = 'manual';
    snapshot.mode.source = 'manual';
    snapshot.mode.manualMode = 'degrade';
    await expect(authorize('ocr_dispatch')).resolves.toMatchObject({ allowed: false });
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('admits the next slow OCR slot only after the unchanged interval', async () => {
    const clock = jest.spyOn(performance, 'now').mockReturnValue(1_000);
    try {
      const harness = buildHarness({
        governorDecision: { action: 'slow', retryAfterMs: 20_000, reason: 'queue backlog' },
      });
      const authorize = () => (harness.service as any).authorizeHeavyStage('ocr');
      await expect(authorize()).resolves.toMatchObject({ allowed: true });
      clock.mockReturnValue(20_999);
      await expect(authorize()).resolves.toEqual({ allowed: false, retryAfterMs: 1 });
      clock.mockReturnValue(21_000);
      await expect(authorize()).resolves.toMatchObject({ allowed: true });
      await expect(authorize()).resolves.toMatchObject({ allowed: false });
    } finally {
      clock.mockRestore();
    }
  });

  it('fails heavy-stage authorization closed when the governor is unavailable', async () => {
    const harness = buildHarness({ governorError: new Error('redis unavailable') });

    await expect((harness.service as any).authorizeHeavyStage('ocr')).resolves.toEqual({
      allowed: false,
      retryAfterMs: 30_000,
    });
  });

  it.each(['download_failed', 'ocr_failed'] as const)(
    'propagates transient analysis failure %s to the queue processor',
    async (reason) => {
      const harness = buildHarness({ analysis: { kind: 'retry', reason } });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({
        kind: 'retry',
        reason,
      });
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'absorbing admission latch is lowered immediately before action',
      options: { latches: [true, true, false] },
    },
    {
      label: 'commercial settings change after analysis',
      options: { finalSettings: settings({ commercialAdsWarnThreshold: 46 }) },
    },
    {
      label: 'exact source changes after analysis',
      options: {
        exactRows: [exactMessage(), exactMessage({ caption: 'Edited after analysis' })],
      },
    },
    {
      label: 'author becomes a remote administrator after analysis',
      options: {
        accessRows: [nonAdminAccess(), { ...nonAdminAccess(), isAdmin: true }],
      },
    },
    {
      label: 'author becomes a local administrator after analysis',
      options: { finalAdminUserIds: ['user-1'] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'rechecks final authorization when $label',
    async ({ options }) => {
      const harness = buildHarness(options);

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'participant immunity is granted', options: { immunityResult: 'granted' as const } },
    {
      label: 'participant immunity lookup fails',
      options: { immunityError: new Error('db down') },
    },
  ])('fails open before action ownership when $label', async ({ options }) => {
    const harness = buildHarness(options);

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'completed',
    });

    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      scope: 'commercial_ocr_delete',
      nightModeTimezone: 'Europe/Moscow',
    });
    expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['Latin-only', 'Window repair call +7 999 123 45 67'],
    ['mixed-script', 'Ремонт окон call +7 999 123 45 67'],
    ['phone-only', '+7 999 123 45 67'],
  ])('keeps a %s OCR delete candidate report-only', async (_label, text) => {
    const harness = buildHarness({ analysis: reportOnlyDeleteAnalysis(text) });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
    expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'before final authorization',
      runtimePolicies: [{ enforce: false }],
      expectedPolicyReads: 1,
      expectsImmunity: false,
    },
    {
      label: 'after final authorization',
      runtimePolicies: [{ enforce: true }, { enforce: false }],
      expectedPolicyReads: 2,
      expectsImmunity: false,
    },
    {
      label: 'immediately before intent commit',
      runtimePolicies: [{ enforce: true }, { enforce: true }, { enforce: false }],
      expectedPolicyReads: 3,
      expectsImmunity: true,
    },
  ])(
    'does not create an intent or call MAX delete when runtime control downgrades $label',
    async ({ runtimePolicies, expectedPolicyReads, expectsImmunity }) => {
      const harness = buildHarness({ runtimePolicies });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toMatchObject({ kind: 'completed' });

      expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(
        expectedPolicyReads,
      );
      expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(
        expectsImmunity ? 1 : 0,
      );
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it('reports runtime-control expiry separately from the job deadline', async () => {
    const harness = buildHarness({
      runtimePolicies: [
        { enforce: true },
        { enforce: true },
        { enforce: true, controlExpiresAt: new Date(Date.now() - 1).toISOString() },
      ],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'enforcement.suppressed.runtime_control_expired',
    );
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'enforcement.suppressed.deadline',
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('caps initial and final MAX authorization calls by the remaining absolute deadline', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const deadlineAtMs = now + 1_250;
    const harness = buildHarness();

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, deadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(2);
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledTimes(2);
    for (const call of harness.maxClient.getExactMessageRow.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timeoutMs: 1_250 }));
    }
    for (const call of harness.maxClient.getChatMemberAccess.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timeoutMs: 1_250 }));
    }
  });

  it('atomically persists action ownership, intent and binding-only reason metadata', async () => {
    const harness = buildHarness();

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({
      kind: 'completed',
    });

    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(3);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      settingsFingerprint: fingerprintCommercialOcrSettingsProfile(settings()),
    });
    expect(harness.participantImmunity.consumeForMessage.mock.invocationCallOrder[0]).toBeLessThan(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock
        .invocationCallOrder[0]!,
    );
    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    expect(persisted.claim).toMatchObject({
      chatId: 'chat-1',
      messageId: 'message-1',
      userId: 'user-1',
      ruleCode: 'COMMERCIAL_OCR_MESSAGE_ACTION',
      updateType: 'message_action',
    });
    const intent = persisted.intent;
    expect(intent).toMatchObject({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: `commercial-ocr-delete:${jobId}`,
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      subjectUserId: 'user-1',
      sourceMessageAt: sourceCreatedAt,
      originBotId: 'execution-bot',
      routingPolicy: 'delete_capable',
      event: { userId: 'user-1', eventType: 'MESSAGE', score: 1 },
    });
    expect(Object.keys(intent.event.metadata)).toEqual(['commercialOcrBinding']);
    const binding = parseCommercialOcrDeleteBinding(intent.event.metadata);
    expect(binding).toMatchObject({
      version: 5,
      policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
      ocrVersion: 'tesseract-rus-eng-v1',
      senderId: 'user-1',
      expectedImageCount: 1,
    });
    expect(JSON.stringify(intent.event.metadata)).not.toContain('Buy now');
    expect(JSON.stringify(intent.event.metadata)).not.toContain('photo-1');
    expect(JSON.stringify(intent.event.metadata)).not.toContain('BALANCED');
  });

  it('caps the durable delete deadline at the runtime-control expiry', async () => {
    const controlExpiresAt = new Date(Date.now() + 30_000).toISOString();
    const harness = buildHarness({
      runtimePolicies: [
        { enforce: true, controlExpiresAt },
        { enforce: true, controlExpiresAt },
        { enforce: true, controlExpiresAt },
      ],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toMatchObject({ kind: 'completed' });

    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    expect(persisted.intent.retryUntilAt).toEqual(new Date(controlExpiresAt));
    expect(persisted.intent.commercialOcrDeadlineAt).toEqual(new Date(controlExpiresAt));
    expect(parseCommercialOcrDeleteBinding(persisted.intent.event.metadata)).toMatchObject({
      authority: { kind: 'CERTIFIED', controlExpiresAt },
      ocrDeadlineAt: controlExpiresAt,
    });
  });
});

function buildProcessorHarness(options: HarnessOptions) {
  const harness = buildHarness(options);
  const jobData = job({ ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION });
  const originalJobData = {
    ...jobData,
    idempotencyKey: buildCommercialOcrJobId(jobData),
  } satisfies CommercialOcrJob;
  const queueJob = {
    id: originalJobData.idempotencyKey,
    name: COMMERCIAL_OCR_JOB_NAME,
    data: { ...originalJobData },
    timestamp: Date.parse(sourceCreatedAt),
    attemptsMade: 0,
    opts: { attempts: 3 },
    moveToDelayed: jest.fn(),
    updateData: jest.fn(),
  } as unknown as Job<CommercialOcrJob>;
  const processorAdmission = {
    recordStarted: jest
      .fn<
        ReturnType<CommercialOcrAdmissionStore['recordStarted']>,
        Parameters<CommercialOcrAdmissionStore['recordStarted']>
      >()
      .mockResolvedValue('recorded'),
    finalize: jest
      .fn<
        ReturnType<CommercialOcrAdmissionStore['finalize']>,
        Parameters<CommercialOcrAdmissionStore['finalize']>
      >()
      .mockResolvedValue('recorded'),
    release: jest
      .fn<
        ReturnType<CommercialOcrAdmissionStore['release']>,
        Parameters<CommercialOcrAdmissionStore['release']>
      >()
      .mockResolvedValue(true),
  } satisfies Pick<CommercialOcrAdmissionStore, 'recordStarted' | 'finalize' | 'release'>;
  const processorMetrics = {
    ...harness.metrics,
    recordQueueWait: jest.fn(),
    getLogicalRecordingContext: jest
      .fn<
        ReturnType<CommercialOcrMetricsService['getLogicalRecordingContext']>,
        Parameters<CommercialOcrMetricsService['getLogicalRecordingContext']>
      >()
      .mockReturnValue({
        identitySha256: 'a'.repeat(64),
        releaseKey: 'fixture-release',
        bucketKey: 'fixture-bucket',
        startedAtMs: Date.now(),
      }),
    observeLogicalRecording: jest.fn(),
  } satisfies Pick<
    CommercialOcrMetricsService,
    | 'recordCounter'
    | 'recordStageDuration'
    | 'recordQueueWait'
    | 'getLogicalRecordingContext'
    | 'observeLogicalRecording'
  >;
  return {
    ...harness,
    processor: new CommercialOcrProcessor(
      harness.service,
      processorAdmission as never,
      harness.configService,
      processorMetrics as never,
    ),
    processorAdmission,
    queueJob,
    originalJobData,
  };
}

function buildHarness(options: HarnessOptions = {}) {
  const initialSettings = options.initialSettings ?? settings();
  const finalSettings = options.finalSettings ?? initialSettings;
  const commitSettings = options.commitSettings ?? finalSettings;
  const normalizedUpdate = options.normalizedUpdate ?? update();
  const exactRows = options.exactRows ?? [exactMessage(), exactMessage()];
  const accessRows = options.accessRows ?? [nonAdminAccess(), nonAdminAccess()];
  const admissionStates =
    options.admissionStates ??
    (options.latches ?? [true, true, true]).map((eligible) =>
      eligible ? ('actionable' as const) : ('observation' as const),
    );
  let exactRowIndex = 0;
  let accessRowIndex = 0;
  let latchIndex = 0;

  const prisma = {
    webhookEvent: {
      findUnique: options.webhookError
        ? jest.fn().mockRejectedValue(options.webhookError)
        : jest.fn().mockResolvedValue({
            botId: 'webhook-bot',
            status: options.webhookStatus ?? WebhookStatus.PROCESSED,
            nextEnqueueAt: null,
            normalizedPayload: normalizedUpdate,
            executionClaims: [{ executionBotId: 'execution-bot' }],
          }),
    },
    webhookExecutionClaim: {
      findUnique: jest.fn(),
    },
    chat: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: initialSettings,
          admins: (options.initialAdminUserIds ?? []).map((userId) => ({ userId })),
          domains: [],
        })
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: finalSettings,
          admins: (options.finalAdminUserIds ?? []).map((userId) => ({ userId })),
          domains: [],
        })
        .mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: commitSettings,
          admins: (options.finalAdminUserIds ?? []).map((userId) => ({ userId })),
          domains: [],
        }),
    },
    moderationViolationMessageClaim: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
  };
  const analysisService = {
    analyzeAlbum: jest.fn().mockResolvedValue(options.analysis ?? deleteAnalysis()),
  };
  const admissionStore = {
    resolveState: jest.fn().mockImplementation(async () => {
      const state = readSequence(admissionStates, latchIndex);
      latchIndex += 1;
      return { kind: 'available', state };
    }),
    activate: jest.fn().mockResolvedValue(options.activationResult ?? 'activated'),
    suppress: jest.fn().mockResolvedValue(options.suppressionResult ?? 'suppressed'),
  };
  const governor = {
    decide: options.governorError
      ? jest.fn().mockRejectedValue(options.governorError)
      : jest.fn().mockResolvedValue(
          options.governorDecision ?? {
            action: 'run',
            retryAfterMs: 0,
            reason: 'background headroom available',
          },
        ),
  };
  const maxClient = {
    deleteMessage: jest.fn(),
    getExactMessageRow: jest.fn().mockImplementation(async () => {
      if (options.exactError) {
        throw options.exactError;
      }
      const row = readSequence(exactRows, exactRowIndex);
      exactRowIndex += 1;
      return row;
    }),
    getChatMemberAccess: jest.fn().mockImplementation(async () => {
      const access = readSequence(accessRows, accessRowIndex);
      accessRowIndex += 1;
      return access;
    }),
  };
  const maxBotContextService = {
    runWithBot: jest.fn(async (_botId: string, operation: () => Promise<unknown>) => operation()),
  };
  const maxBotLinkService = {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
    getDefaultBotId: jest.fn().mockReturnValue('default-bot'),
  };
  const participantImmunity = {
    consumeForMessage: jest.fn().mockImplementation(async () => {
      if (options.immunityError) {
        throw options.immunityError;
      }
      return options.immunityResult ?? 'not_granted';
    }),
  };
  const moderationDeleteIntents = {
    getRolloutForRule: jest.fn().mockReturnValue('execute'),
    ensureIntentWithMessageActionClaim: jest.fn().mockResolvedValue({
      claim: 'claimed',
      intent: { intentId: 'intent-1', rollout: 'execute', status: 'PENDING' },
    }),
  };
  const defaultControlExpiresAt = new Date(Date.now() + 60_000).toISOString();
  let runtimePolicyIndex = 0;
  const runtimePolicies = options.runtimePolicies ?? [{ enforce: true }];
  const runtimePolicy = {
    resolveEffectivePolicy: jest.fn().mockImplementation(async () => {
      const policy = readSequence(runtimePolicies, runtimePolicyIndex);
      runtimePolicyIndex += 1;
      const baseline =
        (policy.kind ?? (options.mode === 'baseline' ? 'BASELINE' : 'CERTIFIED')) === 'BASELINE';
      const expiresAt = policy.controlExpiresAt ?? defaultControlExpiresAt;
      return {
        mode: policy.enforce ? (baseline ? 'baseline' : 'on') : 'shadow',
        process: true,
        enforce: policy.enforce,
        controlRevision: policy.enforce && !baseline ? 1 : null,
        controlExpiresAt: policy.enforce && !baseline ? expiresAt : null,
        authority: !policy.enforce
          ? null
          : baseline
            ? {
                kind: 'BASELINE',
                behaviorIdentitySha256: policy.behaviorIdentitySha256 ?? 'a'.repeat(64),
                nativeBehaviorIdentitySha256: policy.nativeBehaviorIdentitySha256 ?? 'b'.repeat(64),
                settingsFingerprint:
                  policy.settingsFingerprint ??
                  fingerprintCommercialOcrSettingsProfile(initialSettings),
              }
            : { kind: 'CERTIFIED', controlRevision: 1, controlExpiresAt: expiresAt },
        enforcementAuthority: policy.enforce ? 'authorized' : 'revoked',
      };
    }),
  };
  const configService = new ConfigService({
    MAX_WEBHOOK_SECRET_PATH: options.samplingSecret ?? 'fixture-secret-commercial-quality',
    COMMERCIAL_OCR_ROLLOUT_MODE: options.mode ?? 'on',
    IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: options.imageTextRolloutMode ?? 'shadow',
    COMMERCIAL_OCR_RESERVATION_TTL_MS: options.reservationTtlMs,
  });
  const metrics = { recordCounter: jest.fn(), recordStageDuration: jest.fn() };
  const nativeOcr = {
    isSandboxBoundaryVerified: jest.fn().mockReturnValue(options.sandboxBoundaryVerified ?? false),
    getRuntimeStatus: jest.fn().mockReturnValue({
      behaviorIdentity: {
        verified: options.sandboxBoundaryVerified ?? false,
        fingerprintSha256: 'b'.repeat(64),
        complete: options.nativeComplete ?? true,
        runtimeFingerprintSha256: options.nativeRuntimeFingerprint ?? 'b'.repeat(64),
      },
    }),
  };
  const commercialReview = {
    recordCandidate: options.reviewError
      ? jest.fn().mockRejectedValue(options.reviewError)
      : jest.fn().mockResolvedValue(undefined),
  };
  const legacyHolds = { isUpdateHeld: jest.fn().mockResolvedValue(false) };
  const service = new CommercialOcrModerationService(
    prisma as never,
    analysisService as never,
    admissionStore as never,
    governor as never,
    maxClient as never,
    maxBotContextService as never,
    maxBotLinkService as never,
    participantImmunity as never,
    moderationDeleteIntents as never,
    runtimePolicy as never,
    configService,
    metrics as never,
    nativeOcr as never,
    commercialReview as never,
    legacyHolds as never,
  );

  return {
    service,
    configService,
    prisma,
    analysisService,
    admissionStore,
    governor,
    maxClient,
    participantImmunity,
    moderationDeleteIntents,
    runtimePolicy,
    metrics,
    nativeOcr,
    commercialReview,
    legacyHolds,
  };
}

function job(overrides: Partial<CommercialOcrJob> = {}): CommercialOcrJob {
  return {
    webhookEventId: 'webhook-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    sourceCreatedAt,
    eventTimestamp: sourceCreatedAt,
    imageCount: 1,
    schemaVersion: COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
    ocrVersion: 'tesseract-rus-eng-v1',
    actionEligible: true,
    commercialScanRequested: true,
    imageTextScanRequested: false,
    idempotencyKey: jobId,
    sourceTag: 'commercial-image-ocr',
    createdAt: sourceCreatedAt,
    ...overrides,
  };
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    nightModeTimezone: 'Europe/Moscow',
    ...overrides,
  } as ChatSettings;
}

function update(
  options: { messageId?: string; incompleteAttachment?: boolean; downloadUrl?: string } = {},
): MaxUpdate {
  const messageId = options.messageId ?? 'message-1';
  const attachment = options.incompleteAttachment
    ? { type: 'image', payload: {} }
    : photoAttachment('photo-1', options.downloadUrl);
  return {
    updateId: 'update-1',
    botId: 'payload-bot',
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'User One',
      text: 'Buy now',
      createdAt: sourceCreatedAt,
    },
    raw: {
      message: {
        id: messageId,
        timestamp: sourceCreatedAt,
        recipient: { chat_id: 'chat-1' },
        sender: { user_id: 'user-1', is_bot: false },
        body: { mid: messageId, text: 'Buy now', attachments: [attachment] },
      },
    },
  };
}

function exactMessage(
  options: {
    photoId?: string | null;
    caption?: string;
    downloadUrl?: string | null;
    sender?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const photoId = options.photoId === undefined ? 'photo-1' : options.photoId;
  const downloadUrl =
    options.downloadUrl === undefined ? 'https://i.oneme.ru/photo-1' : options.downloadUrl;
  return {
    id: 'message-1',
    timestamp: sourceCreatedAt,
    recipient: { chat_id: 'chat-1' },
    sender: options.sender ?? { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: options.caption ?? 'Buy now',
      attachments: [
        {
          type: 'image',
          payload: {
            ...(photoId === null ? {} : { photo_id: photoId }),
            ...(downloadUrl === null ? {} : { url: downloadUrl }),
          },
        },
      ],
    },
  };
}

function photoAttachment(photoId: string, downloadUrl = `https://i.oneme.ru/${photoId}`) {
  return {
    type: 'image',
    payload: {
      photo_id: photoId,
      url: downloadUrl,
    },
  };
}

function nonAdminAccess(): AccessFixture {
  return {
    userId: 'user-1',
    isAdmin: false,
    isOwner: false,
    permissions: [],
  };
}

function deleteAnalysis(
  text = 'Ремонт окон, звоните +7 999 123 45 67',
): Extract<AnalysisFixture, { kind: 'complete' }> {
  return {
    kind: 'complete',
    decision: evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [
        {
          imageIndex: 0,
          source: 'direct',
          primary: recognizedPass(text),
          verification: recognizedPass(text),
        },
      ],
      settings: settings(),
      detector: {
        detect: () => deleteDetection(text),
      },
    }),
  };
}

function reportOnlyDeleteAnalysis(text: string): Extract<AnalysisFixture, { kind: 'complete' }> {
  const base = deleteAnalysis();
  const letterScript = /\p{Script=Latin}/u.test(text)
    ? /\p{Script=Cyrillic}/u.test(text)
      ? 'mixed'
      : 'latin_only'
    : /\p{Script=Cyrillic}/u.test(text)
      ? 'cyrillic_only'
      : 'unknown';
  return {
    kind: 'complete',
    decision: {
      ...base.decision,
      images: base.decision.images.map((image) => ({
        ...image,
        primary: { ...image.primary, letterScript },
        verification: image.verification
          ? { ...image.verification, letterScript }
          : image.verification,
      })),
    },
  };
}

function noActionDecision(reasonCodes: string[]): CommercialOcrDecision {
  return {
    ...deleteAnalysis().decision,
    action: 'NO_ACTION',
    deleteSource: null,
    reasonCodes,
  };
}

function recognizedPass(text: string): CommercialOcrPass {
  return {
    status: 'recognized',
    text,
    confidencePermille: 950,
    criticalEvidence: [
      { kind: 'commercial_anchor', semanticKey: 'service:repair', confidencePermille: 950 },
      { kind: 'contact', semanticKey: 'phone:+79991234567', confidencePermille: 950 },
    ],
  };
}

function deleteDetection(rawText: string) {
  return {
    rawText,
    confidenceScore: 99,
    decisionBand: 'HIGH' as const,
    matchedSignals: ['service-specialty:repair', 'contact:phone'],
    negativeSignals: [],
    primarySubtype: 'SERVICES' as const,
    supportingSubtypes: [],
    evidenceStrength: 'DIRECT' as const,
    reviewRecommended: false,
    reviewReasons: [],
    campaignContext: null,
    appliedThresholds: {
      warnThreshold: 45,
      deleteThreshold: 65,
      sensitivity: 'BALANCED' as const,
      strictness: 0.5,
    },
    classifierVersion: 'test',
    commercialProbability: 0.99,
    reviewProbability: 0,
    classifierReasons: [],
    actionScore: 99,
    policyFpRisk: 0,
    evidenceTier: 'DIRECT',
    actionBand: 'DELETE',
    safeContextBucket: 'none',
    actionable: true,
    recordable: true,
    deleteSuppressed: false,
    suppressionReasons: [],
    reasonCodes: [],
  };
}

function readSequence<T>(values: readonly T[], index: number): T {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) {
    throw new Error('Fixture sequence is empty');
  }
  return value;
}
