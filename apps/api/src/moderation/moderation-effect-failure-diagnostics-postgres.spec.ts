import type { Logger } from '@nestjs/common';
import { SanctionAction } from '../prisma/prisma-client';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../webhook/webhook-multibot-fullpath.spec-support';
import { ModerationStateDeleteRejectedError } from './moderation-state-delete-guard.service';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import type { SanctionNoticeParams } from './moderation-sanction-notice-delivery';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const stores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

type SpammerKickRuntime = {
  logger: Pick<Logger, 'warn'>;
  sendBanNoticeMessage(params: SanctionNoticeParams): Promise<void>;
  kickAndLogKnownSpammerEvent(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    reason: string;
    claimAlreadyAcquired: boolean;
  }): Promise<boolean>;
};

stores('moderation effect failure diagnostics on PostgreSQL/Redis/BullMQ', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    const owned = h;
    h = undefined;
    try {
      await owned?.dispose();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('preserves the actual final guard refusal without dispatching a member mutation', async () => {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' });
    const [chatId] = await h.seedCatalog(1, { deleteSpammersEnabled: false });
    expect(chatId).toBeDefined();
    const runtime = h.moderation as unknown as SpammerKickRuntime;
    const warn = jest.spyOn(runtime.logger, 'warn').mockImplementation(() => undefined);
    const guard = jest.spyOn(h.stateGuard, 'assertSpammerMemberAllowed');

    const result = await runtime.kickAndLogKnownSpammerEvent({
      chatId: chatId!,
      userId: 'fixture-user',
      messageId: 'fixture-spammer-message',
      text: 'Fixture content',
      reason: 'Fixture candidate became unauthorized before dispatch',
      claimAlreadyAcquired: true,
    });

    expect(result).toBe(false);
    expect(guard).toHaveBeenCalledTimes(1);
    await expect(guard.mock.results[0]!.value).rejects.toBeInstanceOf(
      ModerationStateDeleteRejectedError,
    );
    expect(
      h.effects.filter(
        (effect) => effect.method !== 'get' && effect.path === `/chats/${chatId}/members`,
      ),
    ).toHaveLength(0);
    expect(
      await h.prisma.moderationEvent.count({ where: { chatId, action: SanctionAction.KICK } }),
    ).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        userId: 'fixture-user',
        messageId: 'fixture-spammer-message',
        errorClass: 'ModerationStateDeleteRejectedError',
        errorCode: 'moderation_state_delete_no_longer_authorized',
        preDispatchGuardRejected: true,
      }),
      'Failed to kick known global spammer',
    );
  });

  it.each([false, true])(
    'preserves the actual ban notice guard refusal and rethrowOnFailure=%s without SEND',
    async (rethrowOnFailure) => {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' });
      const [chatId] = await h.seedCatalog(1);
      const runtime = h.moderation as unknown as SpammerKickRuntime;
      const warn = jest.spyOn(runtime.logger, 'warn').mockImplementation(() => undefined);
      const guard = jest.spyOn(h.sanctionGuard, 'assertAllowed');
      const authority = {
        chatId: chatId!,
        userId: 'fixture-user',
        messageId: 'fixture-ban-notice-message',
        reasonKey: 'fixture-expired-reason',
        ruleCode: 'LINKS',
        policySha256: 'fixture-expired-policy',
        deadlineAtMs: Date.now() - 1,
      };

      const outcome = await runtime
        .sendBanNoticeMessage({
          chatId: chatId!,
          userId: authority.userId,
          messageId: authority.messageId,
          userLabel: 'Fixture user',
          deleteBotMessagesEnabled: false,
          deleteBotMessagesDelayMinutes: 0,
          botSpeechStyle: null,
          sanctionNoticeText: 'Fixture ban notice',
          rethrowOnFailure,
          beforeSend: () => h!.sanctionGuard.assertAllowed(authority),
        })
        .then(
          () => ({ kind: 'fulfilled' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error }),
        );

      expect(guard).toHaveBeenCalledTimes(1);
      const refusal: unknown = await guard.mock.results[0]!.value.catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ModerationRuleSanctionRejectedError);
      if (rethrowOnFailure) {
        expect(outcome).toEqual({ kind: 'rejected', error: refusal });
        if (outcome.kind === 'rejected') expect(outcome.error).toBe(refusal);
      } else expect(outcome).toEqual({ kind: 'fulfilled' });
      expect(h.effects.filter((effect) => effect.method !== 'get')).toHaveLength(0);
      expect(
        await h.prisma.maxActionLedgerEntry.count({
          where: { chatId, actionType: 'SEND_MESSAGE' },
        }),
      ).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId,
          userId: authority.userId,
          messageId: authority.messageId,
          errorClass: 'ModerationRuleSanctionRejectedError',
          errorCode: 'moderation_rule_sanction_no_longer_authorized',
          preDispatchGuardRejected: false,
        }),
        'Failed to send permanent ban notice message',
      );
    },
  );
});
