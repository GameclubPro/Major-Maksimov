import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { MaxBotLinkService } from '../../max/max-bot-link.service';
import type { MaxClientService } from '../../max/max-client.service';
import { createPrismaClient, type PrismaClient } from '../../prisma/prisma-client';
import { finalizeDeleteAuthority } from '../moderation-delete-authority-preparation';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import {
  CommercialLlmDeleteGuardService,
  CommercialLlmGuardRejectedError,
} from './commercial-llm-delete-guard.service';
import type { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import {
  buildCommercialLlmOffer,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_DELETE_RULE_CODE,
} from './commercial-llm-enforcement.protocol';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';

(databaseUrl ? describe : describe.skip)('commercial AI protection authority on PostgreSQL', () => {
  let prisma: PrismaClient;
  const chats = new Set<string>();

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error(
        'Commercial AI protection tests require a disposable local race_test database',
      );
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (prisma) await prisma.chat.deleteMany({ where: { id: { in: [...chats] } } });
    chats.clear();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function fixture(grant = true, pool = false) {
    const chatId = `commercial-ai-protection-${randomUUID()}`;
    const messageId = randomUUID();
    const userId = 'synthetic-protected-user';
    const botId = 'synthetic-ai-bot';
    chats.add(chatId);
    await prisma.chat.create({
      data: {
        id: chatId,
        title: 'Commercial AI protection regression',
        settings: { create: { commercialAdsFilterEnabled: true } },
      },
    });
    const settings = await prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    if (grant)
      await prisma.chatParticipantModerationImmunity.create({
        data: {
          chatId,
          userId,
          dailyViolationLimit: 1,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    const now = Date.now();
    const text = 'Мастерская принимает заказы на ремонт мебели. Работаем по договору.';
    const offer = buildCommercialLlmOffer(
      {
        chatId,
        messageId,
        userId,
        originBotId: botId,
        text,
        eventAt: new Date(now).toISOString(),
        settings,
        origin: {
          sourceWebhookEventId: randomUUID(),
          sourceReceivingBotId: botId,
          sourceExecutionBotId: botId,
          sourceEventAtMs: now,
          sourceEvidenceVersion: 1,
        },
      },
      now,
      pool ? 'confirm-positive' : undefined,
    );
    if (!offer) throw new Error('Expected fresh synthetic AI source');
    const source = offer.source;
    const state = {
      enabled: true,
      proof: true,
      onSourceRead: async (): Promise<void> => undefined,
    };
    const max = {
      getChatMemberAccess: jest.fn<
        ReturnType<MaxClientService['getChatMemberAccess']>,
        Parameters<MaxClientService['getChatMemberAccess']>
      >(async () => ({ userId, isAdmin: false, isOwner: false, permissions: [] })),
      getExactMessageRow: jest.fn<
        ReturnType<MaxClientService['getExactMessageRow']>,
        Parameters<MaxClientService['getExactMessageRow']>
      >(async () => {
        await state.onSourceRead();
        return {
          sender: { user_id: userId, is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: now,
          body: { mid: messageId, text },
        };
      }),
    } satisfies Pick<MaxClientService, 'getChatMemberAccess' | 'getExactMessageRow'>;
    const admission = {
      enabled: () => state.enabled,
      hasProof: jest.fn<
        ReturnType<CommercialLlmEnforcementService['hasProof']>,
        Parameters<CommercialLlmEnforcementService['hasProof']>
      >(async () => state.proof),
    } satisfies Pick<CommercialLlmEnforcementService, 'enabled' | 'hasProof'>;
    const botLink = {
      isKnownBotUserId: () => false,
    } satisfies Pick<MaxBotLinkService, 'isKnownBotUserId'>;
    const immunity = new ParticipantModerationImmunityService(prisma as never);
    const consume = jest.spyOn(immunity, 'consumeForMessage');
    const guard = new CommercialLlmDeleteGuardService(
      prisma as never,
      max as never,
      botLink as never,
      immunity,
      new ConfigService({ MODERATION_DELETE_INTENT_TIMEOUT_MS: 5000 }),
      admission as never,
    );
    const reasonKey = `${COMMERCIAL_LLM_DELETE_RULE_CODE}:${commercialLlmSourceKey(source)}`;
    const input = {
      chatId,
      messageId,
      subjectUserId: userId,
      botId,
      reasons: [
        {
          ruleCode: COMMERCIAL_LLM_DELETE_RULE_CODE,
          reasonKey,
          metadata: { commercialLlmSource: source },
        },
      ],
    };
    const usage = async () => {
      const row = await prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
        where: { chatId_userId: { chatId, userId } },
      });
      return {
        usage: row.dailyViolationUsage,
        claims: await prisma.moderationViolationMessageClaim.count({ where: { chatId } }),
      };
    };
    return {
      guard,
      input,
      source,
      state,
      max,
      admission,
      consume,
      usage,
      chatId,
      userId,
      reasonKey,
    };
  }

  it.each([
    'expired',
    'ai_disabled',
    'chat_opt_out',
    'proof_lost',
    'settings_changed',
    'admin_added',
  ] as const)(
    'preserves the real daily allowance when %s changes during source lookup',
    async (change) => {
      const h = await fixture();
      let clock = Date.now();
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      h.state.onSourceRead = async () => {
        if (change === 'expired') clock = h.source.deadlineAtMs + 1;
        if (change === 'ai_disabled') h.state.enabled = false;
        if (change === 'proof_lost') h.state.proof = false;
        if (change === 'chat_opt_out' || change === 'settings_changed')
          await prisma.chatSettings.update({
            where: { chatId: h.chatId },
            data:
              change === 'chat_opt_out'
                ? { commercialAdsFilterEnabled: false }
                : { nightModeTimezone: 'UTC' },
          });
        if (change === 'admin_added')
          await prisma.chatAdminAllowlist.create({ data: { chatId: h.chatId, userId: h.userId } });
      };

      await expect(h.guard.authorize(h.input)).rejects.toBeInstanceOf(
        CommercialLlmGuardRejectedError,
      );
      expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(h.consume).not.toHaveBeenCalled();
      expect(await h.usage()).toEqual({ usage: 0, claims: 0 });
    },
  );

  it('preserves the allowance if authority expires during the fresh proof read', async () => {
    const h = await fixture();
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    h.admission.hasProof.mockImplementation(async () => {
      if (h.max.getExactMessageRow.mock.calls.length) clock = h.source.deadlineAtMs + 1;
      return true;
    });
    await expect(h.guard.authorize(h.input)).rejects.toBeInstanceOf(
      CommercialLlmGuardRejectedError,
    );
    expect(h.consume).not.toHaveBeenCalled();
    expect(await h.usage()).toEqual({ usage: 0, claims: 0 });
  });

  it.each([false, true])(
    'spends one allowance for a current protected message, pool=%s',
    async (pool) => {
      const h = await fixture(true, pool);
      await expect(h.guard.authorize(h.input)).rejects.toBeInstanceOf(
        CommercialLlmGuardRejectedError,
      );
      await expect(h.guard.authorize(h.input)).rejects.toBeInstanceOf(
        CommercialLlmGuardRejectedError,
      );
      expect(await h.usage()).toEqual({ usage: 1, claims: 1 });
    },
  );

  it('keeps current unprotected authority executable under the original deadline', async () => {
    const h = await fixture(false);
    await expect(h.guard.authorize(h.input)).resolves.toEqual({
      deadlineAtMs: h.source.deadlineAtMs,
      reasonKeys: [h.reasonKey],
    });
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(
      await prisma.moderationViolationMessageClaim.count({ where: { chatId: h.chatId } }),
    ).toBe(0);
  });

  it.each(['expired', 'ai_disabled', 'chat_opt_out', 'proof_lost'] as const)(
    'retains the final %s authority check after remote preparation',
    async (change) => {
      const h = await fixture(false);
      const prepared = await h.guard.prepareForDispatch(h.input);
      if (change === 'expired') jest.spyOn(Date, 'now').mockReturnValue(h.source.deadlineAtMs + 1);
      if (change === 'ai_disabled') h.state.enabled = false;
      if (change === 'proof_lost') h.state.proof = false;
      if (change === 'chat_opt_out')
        await prisma.chatSettings.update({
          where: { chatId: h.chatId },
          data: { commercialAdsFilterEnabled: false },
        });
      await expect(finalizeDeleteAuthority(prepared)).rejects.toBeInstanceOf(
        CommercialLlmGuardRejectedError,
      );
      expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(h.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
    },
  );
});
