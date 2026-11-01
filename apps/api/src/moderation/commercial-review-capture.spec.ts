import { ConfigService } from '@nestjs/config';
import {
  routeCommercialAiViolations,
  type CommercialLlmEnforcementService,
} from './commercial/commercial-llm-enforcement.service';
import { buildCommercialQualitySample } from './commercial/commercial-quality-sampling';
import type { CommercialReviewService } from './commercial/commercial-review.service';
import type { RuleViolation } from './rule-engine.contract';
import {
  ModerationService,
  createDeferred,
  createSettings,
  createUpdate,
} from './moderation.service.spec-support';

describe('commercial quality capture ordering', () => {
  it('records asynchronous uncertainty when active AI removes the synchronous commercial verdict', async () => {
    const secret = 'private-test-observation-key-1234567890';
    const settings = createSettings({ commercialAdsFilterEnabled: true });
    const update = createUpdate();
    const message = update.message!;
    message.text = 'Предлагаю услуги ремонта квартир. Подробности по телефону.';
    let sampled = false;
    for (let index = 0; index < 1000; index += 1) {
      message.messageId = `asynchronous-review-${index}`;
      sampled =
        buildCommercialQualitySample({
          secret,
          chatId: message.chatId,
          userId: message.senderId,
          messageId: message.messageId,
          text: message.text,
          messageCreatedAt: message.createdAt,
          source: 'TEXT',
          hasDetection: false,
        }) !== null;
      if (sampled) break;
    }
    if (!sampled) throw new Error('No synthetic source selected by the real sampling boundary');
    update.raw = { message: { timestamp: message.createdAt } };
    const commercialViolation: RuleViolation = {
      ruleCode: 'COMMERCIAL_AD',
      score: 0.9,
      reason: 'synthetic offer',
      metadata: { actionBand: 'DELETE', actionable: true, messageDisposition: 'DELETE' },
    };
    const commercialAi: jest.Mocked<Pick<CommercialLlmEnforcementService, 'enabled' | 'evaluate'>> =
      {
        enabled: jest.fn(() => true),
        evaluate: jest.fn((...args: Parameters<CommercialLlmEnforcementService['evaluate']>) =>
          routeCommercialAiViolations(args[0], true),
        ),
      };
    const observed = createDeferred<Parameters<CommercialReviewService['recordCandidate']>[0]>();
    const recordCandidate = jest.fn<
      ReturnType<CommercialReviewService['recordCandidate']>,
      Parameters<CommercialReviewService['recordCandidate']>
    >(async (input) => {
      observed.resolve(input);
    });
    const prisma = {
      chat: {
        upsert: jest
          .fn()
          .mockResolvedValue({ id: 'chat-1', title: 'Chat 1', domains: [], settings }),
      },
      violation: { create: jest.fn() },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
    };
    const detect = jest.fn().mockResolvedValue({ violations: [commercialViolation] });
    const service = new ModerationService(
      prisma as never,
      { detect } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      new ConfigService({ MAX_WEBHOOK_SECRET_PATH: secret }),
    );
    const ensure = jest.fn();
    const execute = jest.fn();
    Object.assign(service, {
      commercialAi,
      commercialReview: { recordCandidate, recordExecution: jest.fn() },
      ensureModerationDeleteIntent: ensure,
      executeModerationDelete: execute,
    });
    await service.handleUpdate(update);
    const capture = await observed.promise;
    expect(commercialAi.evaluate).toHaveBeenCalledWith(
      [commercialViolation],
      update,
      settings,
      false,
      expect.objectContaining({
        messageId: message.messageId,
        source: 'TEXT',
        sourceExcerptComplete: true,
      }),
    );
    expect(commercialAi.evaluate.mock.results[0]!.value).toEqual([]);
    expect(commercialAi.enabled).toHaveBeenCalled();
    expect(recordCandidate).toHaveBeenCalledTimes(1);
    expect(capture).toMatchObject({
      messageId: message.messageId,
      detectorVersion: 'commercial-ai-asynchronous-v1',
      actionBand: 'NOT_EVALUATED',
      decisionOutcome: null,
      deleteEligible: null,
      executionOutcome: 'UNKNOWN',
      analysisOutcome: 'NOT_APPLICABLE',
      samplingStratum: 'NO_HIT',
      randomEvaluationIncluded: true,
    });
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it('awaits the frozen sample before persisting or executing its delete intent when initial capture is slow', async () => {
    const pendingReached = createDeferred<void>();
    const captureCompleted = createDeferred<void>();
    const recordCandidate = jest.fn((input: { executionOutcome: string }) => {
      if (input.executionOutcome === 'PENDING') pendingReached.resolve();
      return captureCompleted.promise;
    });
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          domains: [],
          settings: createSettings({ commercialAdsFilterEnabled: true }),
        }),
      },
      violation: { create: jest.fn() },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = new ModerationService(
      prisma as never,
      {
        detect: jest.fn().mockResolvedValue({
          violations: [
            {
              ruleCode: 'COMMERCIAL_AD',
              score: 0.9,
              reason: 'test',
              metadata: { actionBand: 'DELETE', actionable: true, messageDisposition: 'DELETE' },
            },
          ],
        }),
      } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      new ConfigService({ MAX_WEBHOOK_SECRET_PATH: 'private-test-observation-key-1234567890' }),
    );
    const ensure = jest.fn().mockResolvedValue(undefined);
    const execute = jest.fn().mockResolvedValue({ deleted: false, gone: false });
    Object.assign(service, {
      commercialReview: { recordCandidate, recordExecution: jest.fn() },
      ensureModerationDeleteIntent: ensure,
      executeModerationDelete: execute,
    });
    const update = createUpdate();
    update.raw = { message: { timestamp: update.message!.createdAt } };
    const processing = service.handleUpdate(update);
    await pendingReached.promise;
    expect(ensure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    captureCompleted.resolve();
    await processing;
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]![0].event.metadata.commercialReviewBinding).toMatchObject({
      schemaVersion: 1,
      source: 'TEXT',
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
