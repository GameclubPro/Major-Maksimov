import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { linkRulesPolicySchema } from '@maxim/contracts/settings';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { LinkHistoryRecoveryService } from './link-history-recovery.service';
import { LinkHistoryDeleteGuardService } from './link-history-delete-guard.service';
import { finalizeDeleteAuthority } from './moderation-delete-authority-preparation';
import { fingerprintLinkRulesPolicy } from './link-rules-policy.runtime';
import { activeLinkPolicySql, linkPolicySemanticEffectiveAtSql } from './link-rules-history.sql';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('link rules policy with PostgreSQL authority and recovery', () => {
  let db: PrismaClient;
  let chatId: string;
  const serviceName = process.env.APP_SERVICE_NAME;
  const policy = () =>
    linkRulesPolicySchema.parse({
      version: 1,
      mode: 'DENY_SELECTED',
      rules: [{ id: 'blocked', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'blocked.example' }],
    });
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable localhost PostgreSQL required');
    db = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 15_000 });
    await db.$connect();
  });
  beforeEach(async () => {
    process.env.APP_SERVICE_NAME = 'api-moderation-background';
    chatId = `link-rules-native-${randomUUID()}`;
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Links native',
        entityType: 'CHAT',
        settings: { create: { linkPolicy: 'ALLOWLIST_ONLY' } },
      },
    });
    await db.domainAllowlist.createMany({
      data: [
        { chatId, domain: 'domain:blocked.example' },
        { chatId, domain: 'domain:frozen.example', removeAfterAt: new Date(Date.now() + 90_000) },
      ],
    });
    await db.chatSettings.update({ where: { chatId }, data: { linkRulesPolicy: policy() } });
  });
  afterEach(async () => {
    await db.chat.deleteMany({ where: { id: chatId } });
  });
  afterAll(async () => {
    if (serviceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = serviceName;
    await db?.$disconnect();
  });
  const settings = () => db.chatSettings.findUniqueOrThrow({ where: { chatId } });

  it('runs real seed and lease SQL and binds the exact source to the new policy', async () => {
    const current = await settings();
    const row = {
      id: 'message-1',
      timestamp: current.linkPolicyEffectiveAt!.getTime(),
      recipient: { chat_id: chatId },
      sender: { user_id: 'user-1', is_bot: false },
      body: {
        mid: 'message-1',
        text: 'site',
        markup: [{ type: 'link', from: 0, length: 4, url: 'https://blocked.example/path' }],
      },
    };
    const max = {
      listMessages: jest.fn().mockResolvedValue([row]),
      getExactMessageRow: jest.fn().mockResolvedValue(row),
      getChatMemberAccess: jest
        .fn()
        .mockResolvedValue({ userId: 'user-1', isAdmin: false, isOwner: false, permissions: [] }),
    };
    const bots = {
      resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'link-native-bot' }),
      isKnownBotUserId: jest.fn().mockReturnValue(false),
    };
    const intents = {
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'native-link-intent',
        rollout: 'execute',
        status: 'PENDING',
      }),
    };
    const service = new LinkHistoryRecoveryService(
      db as never,
      max as never,
      bots as never,
      intents as never,
      { decide: async () => ({ action: 'run', retryAfterMs: 0, reason: 'ok' }) } as never,
      new ConfigService({
        MODERATION_LINK_HISTORY_SCAN_ENABLED: true,
        MODERATION_LINK_HISTORY_DELETE_ENABLED: true,
      }),
    );
    await expect(service.runOnce()).resolves.toBe(true);
    expect(intents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        sourceMessageAt: current.linkPolicyEffectiveAt,
        event: expect.objectContaining({
          metadata: expect.objectContaining({
            linkRulesPolicySha256: fingerprintLinkRulesPolicy(current.linkRulesPolicy),
            policyRevision: current.linkPolicyRevision,
          }),
        }),
      }),
    );
    const reason = {
      ruleCode: 'LINK_BLOCKED_DELETE',
      reasonKey: 'new-link',
      score: 1,
      metadata: {
        linkPolicyRevision: current.linkPolicyRevision,
        linkPolicyEffectiveAt: current.linkPolicyEffectiveAt!.toISOString(),
        linkRulesPolicySha256: fingerprintLinkRulesPolicy(current.linkRulesPolicy),
      },
    };
    const guardDb = {
      chatSettings: db.chatSettings,
      domainAllowlist: db.domainAllowlist,
      $transaction: db.$transaction.bind(db),
      moderationDeleteIntentReason: { findMany: async () => [reason] },
    };
    const guard = new LinkHistoryDeleteGuardService(
      guardDb as never,
      max as never,
      bots as never,
      new ConfigService(),
    );
    const input = {
      intentId: 'native-link-intent',
      chatId,
      messageId: 'message-1',
      subjectUserId: 'user-1',
      botId: 'link-native-bot',
    };
    const preparation = await guard.prepareForDispatch(input);
    await db.chatSettings.update({
      where: { chatId },
      data: { linkRulesPolicy: { ...policy(), rules: [] } },
    });
    const changed = await settings();
    expect(changed.linkPolicyRevision).toBeGreaterThan(current.linkPolicyRevision);
    expect(changed.linkPolicyEffectiveAt!.getTime()).toBeGreaterThanOrEqual(
      current.linkPolicyEffectiveAt!.getTime(),
    );
    await expect(finalizeDeleteAuthority(preparation)).rejects.toMatchObject({
      code: 'live_policy_revision_changed',
    });
  });

  it('uses bounded JSON allowance expiry instead of frozen legacy rows and tolerates malformed JSON expiry', async () => {
    const current = await settings();
    const expiresAt = new Date(current.linkPolicyEffectiveAt!.getTime() + 60_000);
    const now = new Date(expiresAt.getTime() + 60_000);
    await db.chatSettings.update({
      where: { chatId },
      data: {
        linkRulesPolicy: linkRulesPolicySchema.parse({
          version: 1,
          mode: 'ALLOW_SELECTED',
          rules: [
            {
              id: 'temporary',
              effect: 'ALLOW',
              kind: 'WEB_DOMAIN',
              target: 'allowed.example',
              expiresAt: expiresAt.toISOString(),
            },
          ],
        }),
      },
    });
    const baseline = await db.$queryRaw<Array<{ effectiveAt: Date; active: boolean }>>(
      Prisma.sql`SELECT ${linkPolicySemanticEffectiveAtSql(now)} AS "effectiveAt", ${activeLinkPolicySql()} AS active FROM chat_settings settings WHERE settings.chat_id=${chatId}`,
    );
    expect(baseline[0]!.effectiveAt).toEqual(expiresAt);
    expect(baseline[0]!.active).toBe(true);
    await db.chatSettings.update({
      where: { chatId },
      data: {
        linkRulesPolicy: {
          version: 1,
          mode: 'ALLOW_SELECTED',
          rules: [{ enabled: true, effect: 'ALLOW', expiresAt: 'invalid' }],
        },
      },
    });
    await expect(
      db.$queryRaw(
        Prisma.sql`SELECT ${linkPolicySemanticEffectiveAtSql(now)} AS "effectiveAt" FROM chat_settings settings WHERE settings.chat_id=${chatId}`,
      ),
    ).resolves.toHaveLength(1);
  });
});
