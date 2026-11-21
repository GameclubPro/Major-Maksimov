import { randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../webhook/webhook-multibot-fullpath.spec-support';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import type { MessageDuplicateBinding } from './message-duplicate/message-duplicate-state';
import { measureLegacyRecoverySqlPlan } from '../scripts/legacy-recovery-live-sql';
import { buildActiveMuteStateKey } from './moderation-state.util';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-guard.service';
import {
  bindMessageLimitEvidence,
  fingerprintModerationSettings,
} from './message-limits-delete-guard.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native permanent legacy effect holds', () => {
  let h: MultibotHarness | undefined;
  const certificates: string[] = [];
  const globalUsers: string[] = [];
  const globalCacheKeys: string[] = [];
  const ownedReceiptIds: string[] = [];
  afterEach(async () => {
    jest.restoreAllMocks();
    if (h) {
      for (const id of certificates.splice(0)) {
        await h.prisma
          .$executeRaw`DELETE FROM webhook_legacy_recoveries WHERE certificate_id = ${id}`;
        await h.prisma
          .$executeRaw`DELETE FROM webhook_legacy_quiescence_certificates WHERE id = ${id}`;
      }
      const users = globalUsers.splice(0);
      const cacheKeys = globalCacheKeys.splice(0);
      if (cacheKeys.length) await h.redis.del(...cacheKeys);
      await h.prisma.spammerObservation.deleteMany({ where: { userId: { in: users } } });
      await h.prisma.globalSpammerRuntimeProfile.deleteMany({ where: { userId: { in: users } } });
      await h.prisma.globalSpammer.deleteMany({ where: { userId: { in: users } } });
      const receipts = ownedReceiptIds.splice(0);
      await h.prisma.webhookExecutionClaim.deleteMany({
        where: { webhookEventId: { in: receipts } },
      });
      await h.prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
      await h.dispose();
      h = undefined;
    }
  });

  async function fixture(bots = 4, settings: Record<string, unknown> = {}) {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' }));
    await s.pause();
    await s.deleteQueue.pause();
    const [chatId, otherChatId] = await s.seedCatalog(2, {
      deleteSpammersEnabled: true,
      ...settings,
    });
    return { s, chatId: chatId!, otherChatId: otherChatId! };
  }

  // FLAG: These rows test durable effect consumers on isolated stores. They do not
  // certify production quiescence or exercise the separate offline installer workflow.
  async function installFixtureHold(
    s: MultibotHarness,
    chatId: string,
    messageId: string,
    userId = 'fixture-user',
  ) {
    const id = `legacy-consumer-fixture-${randomUUID()}`;
    certificates.push(id);
    // FLAG: This fixture uses one instant for quiescence and seal. The hold reader
    // compares quiesced_at; two clock_timestamp calls can straddle a millisecond.
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_legacy_quiescence_certificates
        (id, source_sha, image_id, attestation, attestation_digest, preview_sha256, quiesced_at, sealed_at)
      VALUES (${id}, ${'f'.repeat(40)}, ${`sha256:${'e'.repeat(64)}`}, '{}'::jsonb,
        ${'a'.repeat(64)}, ${'b'.repeat(64)}, statement_timestamp() AT TIME ZONE 'UTC', statement_timestamp() AT TIME ZONE 'UTC')
    `);
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_legacy_recoveries
        (id, semantic_key, owner_webhook_event_id, claim_id, chat_id, message_id, user_id, source_at,
         raw_payload_digest, normalized_payload_digest, owner_snapshot, claim_snapshot, settings_snapshot, certificate_id)
      VALUES (${`${id}:hold`}, ${`${id}:semantic`}, ${`${id}:owner`}, ${`${id}:claim`},
        ${chatId}, ${messageId}, ${userId}, clock_timestamp() AT TIME ZONE 'UTC',
        ${'c'.repeat(64)}, ${'d'.repeat(64)}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${id})
    `);
    return id;
  }

  function update(
    s: MultibotHarness,
    chatId: string,
    messageId: string,
    userId = 'fixture-user',
    edited = false,
  ) {
    const at = Date.now();
    const raw = {
      update_type: edited ? 'message_edited' : 'message_created',
      timestamp: at,
      message: {
        sender: { user_id: userId, name: 'Isolated fixture', is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: at,
        body: { mid: messageId, text: 'Long harmless message with a fresh source identity' },
      },
    };
    s.messages.set(messageId, raw.message);
    const value = new WebhookParser().parse(raw, { botId: s.bots[0]!.id });
    value.updateId = randomUUID();
    return value;
  }

  it('keeps a prepared message_removed under a newly installed permanent hold', async () => {
    const { s, chatId } = await fixture();
    Object.assign(s.ingress, {
      messageRetention: new MessageRetentionStore(s.prisma as never, s.config, s.legacyHolds),
    });
    const messageId = randomUUID();
    const removal = new WebhookParser().parse(
      {
        update_id: randomUUID(),
        update_type: 'message_removed',
        timestamp: Date.now(),
        chat_id: chatId,
        message_id: messageId,
        user_id: 'fixture-user',
      },
      { botId: s.bots[0]!.id },
    );
    const id = (await s.ingress.storeReceipt(removal, null)).webhookEventId!;
    ownedReceiptIds.push(id);
    await s.ingress.preparePersistedWebhookEvent(id);
    await installFixtureHold(s, chatId, messageId);
    const remove = jest.spyOn(s.history, 'remove');
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    await s.moderation.processWebhookEvent(id);
    // FLAG: This consumer fixture denies effects without a positive receipt disposition.
    // Keep the original receipt and unstarted claim fenced instead of inventing completion.
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'RECEIVED',
    });
    expect(
      await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      }),
    ).toMatchObject({
      status: 'READY',
      businessStartedAt: null,
      completedAt: null,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(s.requests).toEqual([]);
    expect(s.effects).toEqual([]);
  });

  it.each([1, 4, 9])('denies late own-bot cleanup with %i receiving bots', async (bots) => {
    const { s, chatId } = await fixture(bots);
    const at = Date.now() - 60_000;
    await installFixtureHold(s, chatId, `original-${randomUUID()}`);
    const ensure = jest.spyOn(s.intents, 'ensureIntent');
    const params = {
      chatId,
      userId: 'own-bot-user',
      messageId: `notice-${randomUUID()}`,
      text: 'Synthetic notice',
      createdAt: new Date().toISOString(),
      delayMinutes: 2,
      raw: {
        update_type: 'message_created',
        timestamp: Date.now(),
        message: {
          timestamp: at,
          sender: { user_id: 'own-bot-user', is_bot: true },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          body: { mid: '' },
        },
      },
    };
    params.raw.message.body.mid = params.messageId;
    await (s.moderation as any).handleBotMessageAutoDelete(params);
    await (s.moderation as any).handleBotMessageAutoDelete({ ...params, raw: undefined });
    expect(ensure).not.toHaveBeenCalled();
    expect(s.effects).toHaveLength(0);
  });

  it.each(['unproved', 'old-proof', 'at-seal-proof', 'post-seal-proof'] as const)(
    'checks persisted bot cleanup %s at preparation and final dispatch',
    async (kind) => {
      const { s, chatId } = await fixture();
      const before = new Date(Date.now() - 60_000);
      const certificateId = await installFixtureHold(s, chatId, `original-${randomUUID()}`);
      // FLAG: Bind the fixture to the persisted millisecond seal. Truncating a newer
      // SQL microsecond clock to a JS Date must not turn post-seal proof into equality.
      // Equality remains a separate negative case and never authorizes cleanup.
      const [{ at, sealedAt, quiescedAt }] = await s.prisma.$queryRaw<
        Array<{ at: Date; sealedAt: Date; quiescedAt: Date }>
      >`
        SELECT GREATEST(date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
          sealed_at + interval '1 millisecond') AS at, sealed_at AS "sealedAt",
          quiesced_at AS "quiescedAt"
        FROM webhook_legacy_quiescence_certificates WHERE id = ${certificateId}`;
      expect(quiescedAt.getTime()).toBe(sealedAt.getTime());
      expect(at.getTime()).toBeGreaterThan(sealedAt.getTime());
      const sourceAt = kind === 'old-proof' ? before : kind === 'at-seal-proof' ? sealedAt : at;
      const messageId = `bot-cleanup-${randomUUID()}`;
      const pending = await s.intents.ensureIntent({
        chatId,
        messageId,
        subjectUserId: 'own-bot-user',
        sourceMessageAt: at,
        originBotId: s.bots[0]!.id,
        routingPolicy: 'origin_only',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        reasonKey: 'BOT_MESSAGE_AUTO_DELETE',
        ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
        event: {
          userId: 'own-bot-user',
          metadata:
            kind === 'unproved'
              ? {}
              : {
                  botMessageOriginalCreatedAt: sourceAt.toISOString(),
                  botMessageOriginalCreatedAtSource: 'max_message_timestamp_v1',
                },
        },
      });
      const row = await (s.intents as any).loadRequiredIntent(pending.intentId);
      expect(await (s.intents as any).isLegacyIntentHeld(row)).toBe(kind !== 'post-seal-proof');
      if (kind === 'post-seal-proof') return;
      await expect(
        (s.intents as any).runDeletePreDispatchGuards(row, s.bots[0]!.id),
      ).rejects.toMatchObject({ guardError: { code: 'webhook_legacy_effect_held' } });
      expect((await s.intents.attemptIntent(pending.intentId!)).confirmed).toBe(false);
      expect(s.requests).toHaveLength(0);
      expect(s.effects).toHaveLength(0);
    },
  );

  it.each([1, 4, 9])(
    'preserves old strike/mute and denies late edits/new effects with %i bots',
    async (bots) => {
      const { s, chatId } = await fixture(bots);
      const oldMessageId = `legacy-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + 3_600_000);
      await s.prisma.violation.create({
        data: {
          chatId,
          userId: 'fixture-user',
          ruleCode: 'MESSAGE_TOO_LONG',
          score: 1,
        },
      });
      await s.prisma.moderationEvent.create({
        data: {
          chatId,
          userId: 'fixture-user',
          messageId: oldMessageId,
          ruleCode: 'MESSAGE_TOO_LONG',
          eventType: 'MESSAGE',
          action: 'MUTE',
          metadata: { muteExpiresAt: expiresAt.toISOString(), muteDurationHours: 1 },
        },
      });
      await (s.moderation as any).rememberActiveMuteState(chatId, 'fixture-user', {
        eventId: 'old-mute',
        issuedAt: new Date(),
        expiresAt,
        durationHours: 1,
        permanent: false,
      });
      const muteKey = buildActiveMuteStateKey(chatId, 'fixture-user');
      const redisBefore = await s.redis.get(muteKey);
      expect(redisBefore).not.toBeNull();
      const immunityBefore = await s.prisma.chatParticipantModerationImmunity.create({
        data: {
          chatId,
          userId: 'fixture-user',
          dailyViolationLimit: 5,
          expiresAt,
          dailyViolationUsage: 1,
          usageDateKey: '2026-10-06',
        },
      });
      const fencesBefore = await s.prisma.moderationEvent.findMany({
        where: { chatId, ruleCode: 'SANCTION_STATE_FENCE' },
      });
      await installFixtureHold(s, chatId, oldMessageId);
      const evaluate = jest.spyOn((s.moderation as any).ruleEngine, 'detect');
      for (const bot of s.bots) {
        const lateEdit = update(s, chatId, oldMessageId, 'fixture-user', true);
        lateEdit.botId = bot.id;
        await s.moderation.handleUpdate(lateEdit);
        await s.moderation.handleUpdate(update(s, chatId, `later-${randomUUID()}`));
      }
      expect(evaluate).not.toHaveBeenCalled();
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(1);
      expect(s.effects).toHaveLength(0);
      expect(await s.redis.get(muteKey)).toBe(redisBefore);
      await expect(
        (s.moderation as any).applySanctionAction({
          chatId,
          userId: 'fixture-user',
          messageId: oldMessageId,
          action: 'MUTE',
        }),
      ).rejects.toBeInstanceOf(ModerationRuleSanctionRejectedError);
      expect(
        await (s.moderation as any).consumeChatParticipantModerationImmunity({
          chatId,
          userId: 'fixture-user',
          messageId: oldMessageId,
          nightModeTimezone: 'UTC',
        }),
      ).toBe(true);
      expect(
        await s.prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
          where: { id: immunityBefore.id },
        }),
      ).toEqual(immunityBefore);
      expect(
        await s.prisma.moderationEvent.findMany({
          where: { chatId, ruleCode: 'SANCTION_STATE_FENCE' },
        }),
      ).toEqual(fencesBefore);
      expect(
        await (s.moderation as any).rememberActiveMuteState(chatId, 'fixture-user', {
          eventId: 'new-mute',
          issuedAt: new Date(),
          expiresAt: new Date(Date.now() + 7_200_000),
          durationHours: 2,
          permanent: false,
        }),
      ).toBe(false);
      expect(await s.redis.get(muteKey)).toBe(redisBefore);
    },
  );

  it('denies pending DELETE but settles an exact saved DELETE receipt without MAX calls', async () => {
    const { s, chatId } = await fixture();
    const messageId = `held-delete-${randomUUID()}`;
    await installFixtureHold(s, chatId, messageId);
    const input = {
      chatId,
      messageId,
      subjectUserId: 'fixture-user',
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      originBotId: s.bots[0]!.id,
      reasonKey: 'MESSAGE_TOO_LONG:violation-delete',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      sourceMessageAt: new Date(),
      event: { userId: 'fixture-user', eventType: 'MESSAGE' as const },
    };
    const pending = await s.intents.ensureIntent(input);
    const denied = await s.intents.attemptIntent(pending.intentId!);
    expect(denied.confirmed).toBe(false);
    expect(s.requests).toHaveLength(0);
    await s.prisma.moderationDeleteIntent.update({
      where: { id: pending.intentId! },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(Date.now() - 1000),
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: s.bots[0]!.id,
      },
    });
    expect((await s.intents.attemptIntent(pending.intentId!)).confirmed).toBe(true);
    expect(s.requests).toHaveLength(0);
    expect(s.effects).toHaveLength(0);
  });

  it.each([1, 4, 9])(
    'denies another-chat automatic moderation for the held author with %i bots and admits another author',
    async (bots) => {
      const { s, chatId, otherChatId } = await fixture(bots, { deleteSpammersEnabled: false });
      const userId = `held-cross-chat-${randomUUID()}`;
      const messageId = `new-cross-chat-${randomUUID()}`;
      await installFixtureHold(s, chatId, `old-cross-chat-${randomUUID()}`, userId);
      const holds = new WebhookLegacyHoldService(s.prisma as never);
      expect(await holds.isMessageHeld(otherChatId, messageId)).toBe(false);
      expect(await holds.isMemberHeld(otherChatId, userId)).toBe(false);
      expect(await holds.isGlobalUserHeld(userId)).toBe(true);
      const immunityBefore = await s.prisma.chatParticipantModerationImmunity.create({
        data: {
          chatId: otherChatId,
          userId,
          dailyViolationLimit: 5,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const detect = jest.spyOn((s.moderation as any).ruleEngine, 'detect');
      const source = update(s, otherChatId, messageId, userId);
      expect(await holds.isUpdateHeld(source)).toBe(true);
      // FLAG: This consumer fixture installs an effect hold without receipt authority.
      // Exercise the automatic engine directly; positive ingress disposition is covered
      // by the separate native offline installer/ingestion suite.
      await s.moderation.handleUpdate(source);
      expect(detect).not.toHaveBeenCalled();
      expect(await s.prisma.violation.count({ where: { chatId: otherChatId, userId } })).toBe(0);
      expect(await s.prisma.moderationEvent.count({ where: { chatId: otherChatId, userId } })).toBe(
        0,
      );
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId: otherChatId } })).toBe(
        0,
      );
      expect(s.effects).toHaveLength(0);
      expect(
        await s.prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
          where: { id: immunityBefore.id },
        }),
      ).toEqual(immunityBefore);

      const independent = update(s, otherChatId, `independent-${randomUUID()}`, 'independent-user');
      const receipt = await s.ingress.storeReceipt(independent, null);
      ownedReceiptIds.push(receipt.webhookEventId!);
      expect(await s.ingress.preparePersistedWebhookEvent(receipt.webhookEventId!)).toMatchObject({
        prepared: true,
        enforced: true,
      });
      await s.moderation.processWebhookEvent(receipt.webhookEventId!);
      expect(detect).toHaveBeenCalledTimes(1);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    },
  );

  it('ignores already warm global spammer caches and keeps queued global-delete immunity intact', async () => {
    const { s, chatId, otherChatId } = await fixture();
    const userId = `held-cached-global-${randomUUID()}`;
    globalUsers.push(userId);
    const cacheKey = `global-spammer:developer-forced:${userId}`;
    globalCacheKeys.push(cacheKey);
    await s.redis.set(cacheKey, '1', 'EX', 3600);
    const messageId = `queued-global-${randomUUID()}`;
    const source = update(s, otherChatId, messageId, userId);
    const pending = await s.intents.ensureIntent({
      chatId: otherChatId,
      messageId,
      subjectUserId: userId,
      sourceMessageAt: source.message!.createdAt,
      originBotId: s.bots[0]!.id,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'GLOBAL_SPAMMER:detected-message-delete',
      ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
      event: { userId },
    });
    const immunityBefore = await s.prisma.chatParticipantModerationImmunity.create({
      data: {
        chatId: otherChatId,
        userId,
        dailyViolationLimit: 5,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await installFixtureHold(s, chatId, `held-source-${randomUUID()}`, userId);
    expect(
      await (s.moderation as any).deleteAndKickDetectedGlobalSpammer({
        chatId: otherChatId,
        messageId,
        userId,
        text: 'Synthetic source',
        createdAt: source.message!.createdAt,
        reason: 'Legacy reputation',
      }),
    ).toBe(false);
    expect((await s.intents.attemptIntent(pending.intentId!)).confirmed).toBe(false);
    expect(
      await s.prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
        where: { id: immunityBefore.id },
      }),
    ).toEqual(immunityBefore);
    expect(await s.redis.get(cacheKey)).toBe('1');
    expect(s.effects).toHaveLength(0);
    expect(await s.prisma.moderationEvent.count({ where: { chatId: otherChatId, userId } })).toBe(
      0,
    );
  });

  it('denies global reputation/denorm and another-chat KICK while preserving old reputation', async () => {
    const { s, chatId, otherChatId } = await fixture();
    const userId = `held-global-${randomUUID()}`;
    globalUsers.push(userId);
    await s.prisma.globalSpammer.create({
      data: {
        userId,
        lastReason: 'SANCTION_BAN',
        lastChatId: chatId,
        confidenceScore: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const before = await s.prisma.globalSpammer.findUniqueOrThrow({ where: { userId } });
    await installFixtureHold(s, chatId, `legacy-global-${randomUUID()}`, userId);
    expect(
      (
        await s.globalPolicy.evaluatePolicy({
          userId,
          chatId: otherChatId,
          trigger: 'member_join',
          deleteSpammersEnabled: true,
        })
      ).action,
    ).toBe('NONE');
    await s.globalPolicy.recordObservation({
      userId,
      chatId: otherChatId,
      source: 'SANCTION_BAN',
      reason: 'Repeat',
      score: 1,
    });
    await s.globalPolicy.processObservationDenormJob({
      userId,
      chatId,
      observationId: 'old',
      source: 'SANCTION_BAN',
      reason: 'Legacy',
    } as never);
    await expect(s.max.kickMember(otherChatId, userId, { immediate: true })).rejects.toThrow();
    expect(await s.prisma.globalSpammer.findUniqueOrThrow({ where: { userId } })).toEqual(before);
    expect(await s.prisma.spammerObservation.count({ where: { userId } })).toBe(0);
    expect(s.effects).toHaveLength(0);
  });

  it.each(['same-chat', 'another-chat'])(
    'settles a genuinely confirmed modern BAN after a %s hold without repeating BAN or sending its notice',
    async (scope) => {
      const {
        s,
        chatId: heldChatId,
        otherChatId,
      } = await fixture(4, {
        messageLimitsWarnEnabled: false,
        messageLimitsBanEnabled: true,
        deleteSpammersEnabled: false,
      });
      const chatId = scope === 'same-chat' ? heldChatId : otherChatId;
      const messageId = `confirmed-ban-${randomUUID()}`;
      const source = update(s, chatId, messageId);
      const sourceAt = new Date(source.message!.createdAt);
      const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
      await s.prisma.violation.createMany({
        data: Array.from({ length: 3 }, () => ({
          chatId,
          userId: 'fixture-user',
          ruleCode: 'MESSAGE_TOO_LONG',
          score: 1,
        })),
      });
      const result = await s.intents.ensureIntentWithRuleFollowup(
        {
          chatId,
          messageId,
          subjectUserId: 'fixture-user',
          sourceMessageAt: sourceAt,
          originBotId: s.bots[0]!.id,
          routingPolicy: 'delete_capable',
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          reasonKey: 'MESSAGE_TOO_LONG:violation-delete',
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          event: {
            userId: 'fixture-user',
            eventType: 'MESSAGE',
            score: 1,
            metadata: bindMessageLimitEvidence(
              settings,
              sourceAt.getTime(),
              'MESSAGE_TOO_LONG_DELETE',
            ),
          },
        },
        fingerprintModerationSettings(settings, 'MESSAGE_TOO_LONG_DELETE'),
        {
          version: 1,
          updateType: 'message_created',
          originBotId: s.bots[0]!.id,
          userLabel: 'Fixture user',
          effectiveMessageLength: 60,
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        },
      );
      const row = await s.prisma.moderationRuleFollowup.findUniqueOrThrow({
        where: { id: result.followupId! },
      });
      expect((await s.intents.attemptIntent(row.intentId)).confirmed).toBe(true);
      const originalPersist = (s.moderation as any).persistRuleFollowupEvent.bind(s.moderation);
      const crash = jest
        .spyOn(s.moderation as any, 'persistRuleFollowupEvent')
        .mockRejectedValueOnce(new Error('Consumer fixture stopped after confirmed BAN'));
      await s.ruleFollowups.attempt(row.id);
      expect(
        (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }))
          .effects,
      ).toMatchObject({ phase: 'BAN_CONFIRMED' });
      expect(s.effects.filter((effect) => effect.path.endsWith('/members'))).toHaveLength(1);
      crash.mockImplementation(originalPersist);
      await installFixtureHold(s, heldChatId, messageId);
      await s.prisma.moderationRuleFollowup.update({
        where: { id: row.id },
        data: {
          nextAttemptAt: new Date(Date.now() - 1000),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      await s.ruleFollowups.attempt(row.id);
      expect(
        await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'BAN' } }),
      ).toBe(1);
      expect(s.effects.filter((effect) => effect.path.endsWith('/members'))).toHaveLength(1);
      expect(
        s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
      ).toHaveLength(0);
    },
  );

  it.each(['same-chat', 'another-chat'])(
    'cancels a %s held unprepared followup before author access or immunity consumption',
    async (scope) => {
      const { s, chatId: heldChatId, otherChatId } = await fixture();
      const chatId = scope === 'same-chat' ? heldChatId : otherChatId;
      const messageId = `unprepared-followup-${randomUUID()}`;
      const source = update(s, chatId, messageId);
      const sourceAt = new Date(source.message!.createdAt);
      const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
      const pending = await s.intents.ensureIntentWithRuleFollowup(
        {
          chatId,
          messageId,
          subjectUserId: 'fixture-user',
          sourceMessageAt: sourceAt,
          originBotId: s.bots[0]!.id,
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          reasonKey: 'MESSAGE_TOO_LONG:violation-delete',
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          event: {
            userId: 'fixture-user',
            eventType: 'MESSAGE',
            metadata: bindMessageLimitEvidence(
              settings,
              sourceAt.getTime(),
              'MESSAGE_TOO_LONG_DELETE',
            ),
          },
        },
        fingerprintModerationSettings(settings, 'MESSAGE_TOO_LONG_DELETE'),
        {
          version: 1,
          updateType: 'message_created',
          originBotId: s.bots[0]!.id,
          userLabel: 'Fixture user',
          effectiveMessageLength: 60,
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        },
      );
      const persistedIntent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId, messageId } },
        select: { id: true },
      });
      expect((await s.intents.attemptIntent(persistedIntent.id)).confirmed).toBe(true);
      const requestsBefore = s.requests.length;
      const effectsBefore = s.effects.length;
      const immunityBefore = await s.prisma.chatParticipantModerationImmunity.create({
        data: {
          chatId,
          userId: 'fixture-user',
          dailyViolationLimit: 5,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      await installFixtureHold(s, heldChatId, messageId);
      const holds = new WebhookLegacyHoldService(s.prisma as never);
      expect(await holds.isGlobalUserHeld('fixture-user')).toBe(true);
      expect(await holds.isMemberHeld(chatId, 'fixture-user')).toBe(scope === 'same-chat');
      expect(await holds.isMessageHeld(chatId, messageId)).toBe(scope === 'same-chat');
      expect(await s.ruleFollowups.attempt(pending.followupId!)).toBe(true);
      expect(
        await s.prisma.moderationRuleFollowup.findUniqueOrThrow({
          where: { id: pending.followupId! },
        }),
      ).toMatchObject({
        status: 'CANCELLED',
        actionPlan: null,
      });
      expect(
        await s.prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
          where: { id: immunityBefore.id },
        }),
      ).toEqual(immunityBefore);
      expect(s.requests).toHaveLength(requestsBefore);
      expect(s.effects).toHaveLength(effectsBefore);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    },
  );

  it.each([1, 4, 9])(
    'blocks an IMAGE comparison from a held original without holding the other author (%s bots)',
    async (bots) => {
      const { s, chatId, otherChatId } = await fixture(bots);
      const originalId = `held-image-${randomUUID()}`;
      const senderId = `independent-${randomUUID()}`;
      await installFixtureHold(s, chatId, originalId);
      const sources = [
        { messageId: 'new-image', userId: senderId },
        { messageId: originalId, userId: 'fixture-user' },
      ];
      expect(await s.legacyHolds.isGlobalUserHeld(senderId)).toBe(false);
      expect(await s.legacyHolds.isAnyMessageSourceHeld(chatId, sources)).toBe(true);
      expect(await s.legacyHolds.isAnyMessageSourceHeld(otherChatId, sources)).toBe(true);
      expect(await s.legacyHolds.isAnyMessageSourceHeld(chatId, [sources[0]!])).toBe(false);
      expect(
        await s.legacyHolds.isAnyMessageSourceHeld(chatId, [
          sources[0]!,
          { messageId: 'independent-original', userId: 'independent-original-author' },
        ]),
      ).toBe(false);
      const binding = {
        version: 3,
        lifecycleRevision: 'retained',
        authorization: {},
        compareMode: 'IMAGE',
        imageScope: 'CHAT',
        senderId,
        messageId: sources[0]!.messageId,
        original: {
          messageId: originalId,
          senderId: 'fixture-user',
          revision: 'retained',
          originalId: 'retained',
        },
      } as unknown as MessageDuplicateBinding;
      const requestsBefore = s.requests.length;
      await expect(s.duplicateGuard.assertQualificationAuthority(chatId, binding)).rejects.toThrow(
        'message_duplicate_source_held',
      );
      expect(s.requests).toHaveLength(requestsBefore);
      expect(s.effects).toHaveLength(0);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    },
  );

  it('bounds both immutable-source lookups against 12,000 unrelated holds', async () => {
    const { s, chatId } = await fixture();
    await installFixtureHold(s, chatId, 'held-image');
    const certificateId = certificates.at(-1)!;
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_legacy_recoveries
        (id, semantic_key, owner_webhook_event_id, claim_id, chat_id, message_id, user_id, source_at,
         raw_payload_digest, normalized_payload_digest, owner_snapshot, claim_snapshot, settings_snapshot, certificate_id)
      SELECT ${certificateId} || ':history:' || i, ${certificateId} || ':semantic:' || i,
        ${certificateId} || ':owner:' || i, ${certificateId} || ':claim:' || i,
        '-history:' || i, 'history:' || i, 'history-user:' || i, clock_timestamp() AT TIME ZONE 'UTC',
        ${'c'.repeat(64)}, ${'d'.repeat(64)}, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${certificateId}
      FROM generate_series(1, 12000) i`);
    await s.prisma.$executeRaw`ANALYZE webhook_legacy_recoveries`;
    const statements: Prisma.Sql[] = [];
    const client = {
      $queryRaw: (statement: Prisma.Sql) => {
        statements.push(statement);
        return s.prisma.$queryRaw(statement);
      },
    };
    for (const messageId of ['held-image', 'independent-image']) {
      expect(
        await s.legacyHolds.isAnyMessageSourceHeld(
          chatId,
          [
            { messageId: 'new-image', userId: 'independent' },
            { messageId, userId: 'another-independent' },
          ],
          client as never,
        ),
      ).toBe(messageId === 'held-image');
    }
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      const [plan] = await s.prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
      );
      const measured = measureLegacyRecoverySqlPlan(plan!['QUERY PLAN']);
      expect(measured.examinedRows).toBeLessThanOrEqual(2);
      expect(measured.indexes.length).toBeGreaterThan(0);
      expect(measured.bufferBytes).toBeLessThan(64 * 8192);
    }
  });

  it('uses the real durable reader and leaves an unrelated actor outside the hold', async () => {
    const { s, chatId } = await fixture();
    await installFixtureHold(s, chatId, 'held-source');
    const reader = new WebhookLegacyHoldService(s.prisma as never);
    expect(await reader.isMemberHeld(chatId, 'fixture-user')).toBe(true);
    expect(await reader.isMemberHeld(chatId, 'unrelated-user')).toBe(false);
    const source = update(s, chatId, `unrelated-${randomUUID()}`, 'unrelated-user');
    expect(await reader.isUpdateHeld(source)).toBe(false);
    const detect = jest.spyOn((s.moderation as any).ruleEngine, 'detect');
    const handle = jest.spyOn(s.moderation, 'handleUpdate');
    const receipt = await s.ingress.storeReceipt(source, null);
    expect(receipt.webhookEventId).toBeTruthy();
    ownedReceiptIds.push(receipt.webhookEventId!);
    expect(await s.ingress.preparePersistedWebhookEvent(receipt.webhookEventId!)).toMatchObject({
      prepared: true,
      enforced: true,
    });
    await s.moderation.processWebhookEvent(receipt.webhookEventId!);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(await detect.mock.results[0]!.value).toMatchObject({
      violations: expect.arrayContaining([
        expect.objectContaining({ ruleCode: 'MESSAGE_TOO_LONG' }),
      ]),
    });
    expect(
      await s.prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId, messageId: source.message!.messageId } },
        select: { status: true, lastErrorCode: true, lastError: true },
      }),
    ).toMatchObject({ status: 'SUCCEEDED', lastErrorCode: null, lastError: null });
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
  });
});
