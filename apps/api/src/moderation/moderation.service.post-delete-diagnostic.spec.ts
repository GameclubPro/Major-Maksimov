import { MaxApiInternalRateLimitError } from '../max/max-api-internal-rate-limit.error';
import type { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import type { ModerationDeleteAttemptResult } from './moderation-delete-intent.types';
import type { ModerationRuleSanctionGuardService } from './moderation-rule-sanction-guard.service';
import {
  createDeferred,
  createLiveNavigationEnvelopeUpdate,
  createLiveNavigationHarness,
} from './moderation.service.spec-support';
import type { WebhookHotPathProfile } from './moderation.service.support';

function createHarness() {
  const harness = createLiveNavigationHarness({ linkPolicy: 'ALLOWLIST_ONLY' });
  const entered = createDeferred<void>();
  const deletion = createDeferred<ModerationDeleteAttemptResult>();
  let ownReasonKey = '';
  const executor = {
    getRolloutForInput: jest.fn(() => 'execute' as const),
    ensureIntent: jest.fn(async () => ({
      intentId: 'diagnostic-intent',
      rollout: 'execute' as const,
      status: 'PENDING' as const,
    })),
    ensureAndAttempt: jest.fn<
      ReturnType<ModerationDeleteIntentService['ensureAndAttempt']>,
      Parameters<ModerationDeleteIntentService['ensureAndAttempt']>
    >(async (input) => {
      ownReasonKey = input.reasonKey;
      entered.resolve();
      return deletion.promise;
    }),
  } satisfies Pick<
    ModerationDeleteIntentService,
    'getRolloutForInput' | 'ensureIntent' | 'ensureAndAttempt'
  >;
  const quotaError = new MaxApiInternalRateLimitError('local quota', 250, 'bot');
  const guard = {
    assertAllowed: jest.fn<
      ReturnType<ModerationRuleSanctionGuardService['assertAllowed']>,
      Parameters<ModerationRuleSanctionGuardService['assertAllowed']>
    >(async () => {
      throw quotaError;
    }),
  } satisfies Pick<ModerationRuleSanctionGuardService, 'assertAllowed'>;
  Object.assign(harness.service, {
    moderationDeleteIntentService: executor,
    moderationRuleSanctionGuard: guard,
  });
  const now = Date.now();
  const profile: WebhookHotPathProfile = {
    startedAtMs: now,
    lastMarkedAtMs: now,
    latestStage: 'start',
    stages: new Map(),
    stageTimelineMs: new Map(),
    successBoundaryReached: false,
    successBoundaryStage: null,
  };
  const update = createLiveNavigationEnvelopeUpdate('message_created', {
    body: { text: 'https://blocked.example/path' },
  });
  const confirm = (reasonKeys = [ownReasonKey]) =>
    deletion.resolve({
      kind: 'confirmed',
      confirmed: true,
      intentId: 'diagnostic-intent',
      status: 'SUCCEEDED',
      botId: 'delete-peer',
      verifiedReasonKeys: reasonKeys,
    });
  return { ...harness, entered, deletion, executor, guard, quotaError, profile, update, confirm };
}

function expectNoFollowupEffects(harness: ReturnType<typeof createHarness>) {
  expect(harness.prisma.violation.create).not.toHaveBeenCalled();
  expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
  expect(harness.maxClient.banMember).not.toHaveBeenCalled();
  expect(harness.maxClient.kickMember).not.toHaveBeenCalled();
}

describe('post-delete hot-path diagnostics', () => {
  it('attributes a fresh authority rejection after confirmed DELETE to its own stage', async () => {
    const harness = createHarness();
    const handling = harness.service.handleUpdate(harness.update, harness.profile);
    const rejected = expect(handling).rejects.toBe(harness.quotaError);
    await harness.entered.promise;
    expect(harness.profile.latestStage).toBe('violation-delete');
    expect(harness.guard.assertAllowed).not.toHaveBeenCalled();
    harness.confirm();
    await rejected;
    expect(harness.profile.latestStage).toBe('violation-follow-up.authority');
    expect(harness.guard.assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'delete-peer' }),
      undefined,
    );
    expect(harness.executor.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expectNoFollowupEffects(harness);
  });

  it('keeps the DELETE stage when confirmation belongs to another reason', async () => {
    const harness = createHarness();
    const handling = harness.service.handleUpdate(harness.update, harness.profile);
    await harness.entered.promise;
    harness.confirm(['peer:reason']);
    await handling;
    expect(harness.profile.latestStage).toBe('violation-delete');
    expect(harness.guard.assertAllowed).not.toHaveBeenCalled();
    expect(harness.executor.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expectNoFollowupEffects(harness);
  });

  it('keeps the DELETE stage and original error when DELETE itself rejects', async () => {
    const harness = createHarness();
    const handling = harness.service.handleUpdate(harness.update, harness.profile);
    const rejected = expect(handling).rejects.toBe(harness.quotaError);
    await harness.entered.promise;
    harness.deletion.reject(harness.quotaError);
    await rejected;
    expect(harness.profile.latestStage).toBe('violation-delete');
    expect(harness.guard.assertAllowed).not.toHaveBeenCalled();
    expect(harness.executor.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expectNoFollowupEffects(harness);
  });
});
