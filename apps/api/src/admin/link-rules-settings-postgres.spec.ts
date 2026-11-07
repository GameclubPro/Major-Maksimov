import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { chatSettingsSchema, type LinkRulesPolicy } from '@maxim/contracts/settings';
import { chatSummarySchema } from '@maxim/contracts';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readLinkRulesLegacySnapshot } from './link-rules-settings-policy';
import { saveChatSettings, sanitizeStoredChatSettings } from './admin-chat-settings';
import { AdminDomainAllowlistRuntime } from './admin-domain-allowlist-runtime';
import { applySettingsToAllChats } from './admin-settings-apply';
import { SETTINGS_SECTION_KEYS } from './admin.service.support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;
const selected: LinkRulesPolicy = {
  version: 1,
  mode: 'DENY_SELECTED',
  rules: [
    {
      id: 'selected',
      effect: 'DENY',
      kind: 'WEB_EXACT',
      target: 'https://example.com/offer',
      enabled: true,
      expiresAt: null,
    },
  ],
};

integration('link rules settings adoption and revision with PostgreSQL', () => {
  let db: PrismaClient;
  let chatId: string;
  let additionalChatIds: string[];
  const user = {
    userId: 'link-rules-' + randomUUID(),
    username: null,
    displayName: null,
    chatTitle: null,
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15_000 }),
    });
  });
  beforeEach(async () => {
    additionalChatIds = [];
    chatId = 'link-rules-' + randomUUID();
    await db.chat.create({
      data: { id: chatId, title: 'Ссылки', entityType: 'CHAT', settings: { create: {} } },
    });
  });
  afterEach(async () => {
    await db.auditLog.deleteMany({ where: { chatId: { in: [chatId, ...additionalChatIds] } } });
    await db.chat.deleteMany({ where: { id: { in: [chatId, ...additionalChatIds] } } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const row = () => db.chatSettings.findUniqueOrThrow({ where: { chatId } });
  async function settings() {
    const stored = await row();
    return {
      ...chatSettingsSchema.parse(sanitizeStoredChatSettings(stored)),
      settingsRevision: stored.updatedAt.toISOString(),
    };
  }
  async function adoption() {
    const current = await settings();
    return {
      ...current,
      linkRulesPolicy: selected,
      linkRulesLegacySnapshot: await readLinkRulesLegacySnapshot(
        db as PrismaService,
        chatId,
        current.linkPolicy,
      ),
    };
  }
  async function save(
    body: unknown,
    networkWrite?: Parameters<typeof saveChatSettings>[0]['networkWrite'],
  ) {
    return saveChatSettings({
      prisma: db as PrismaService,
      chatContextCache: { invalidate: async () => undefined },
      chatId,
      actorUserId: user.userId,
      body,
      source: 'miniapp',
      resolveBotAssignmentData: () => ({}),
      assertRequiredSubscriptionSettings: async () => undefined,
      reportsAvailable: () => false,
      assertBotCapabilities: async () => undefined,
      refreshExecutionReadiness: async () => undefined,
      networkWrite,
    });
  }
  function runtime() {
    return new AdminDomainAllowlistRuntime({
      prisma: db as PrismaService,
      chatContextCache: { invalidate: async () => undefined } as never,
      assertChatAdmin: async () => undefined,
    });
  }
  async function targetChat() {
    const id = 'link-target-' + randomUUID();
    additionalChatIds.push(id);
    await db.chat.create({
      data: { id, title: 'Получатель', entityType: 'CHAT', settings: { create: {} } },
    });
    return id;
  }
  async function bulk(targetId: string, body: unknown, beforeTarget?: () => Promise<void>) {
    return applySettingsToAllChats({
      prisma: db as PrismaService,
      chatContextCache: { invalidate: async () => undefined },
      sourceChatId: chatId,
      actorUserId: user.userId,
      body,
      source: 'miniapp',
      targetOrSettingKeys: { mode: 'selectedChats', favoriteTypes: [], chatIds: [targetId] },
      settingKeys: SETTINGS_SECTION_KEYS.links,
      normalizeSettings: (value) => value,
      resolveTargetChats: async () => [
        chatSummarySchema.parse({
          id: targetId,
          title: 'Получатель',
          createdAt: '2026-11-07T10:00:00.000Z',
        }),
      ],
      resolveBotAssignmentData: async () => {
        await beforeTarget?.();
        return {};
      },
      assertRequiredSubscriptionSettings: async () => undefined,
      assertBotCapabilities: async () => undefined,
      recordConcurrentWriteConflict: () => undefined,
      onPartialApplied: async () => undefined,
      isRequiredSubscriptionCurrentlyActive: () => false,
      scheduleReadinessRefresh: () => undefined,
    });
  }

  it('changes the baseline for JSON semantics, ignores equal JSON and retired allowlist writes', async () => {
    const original = await row();
    const first = await db.chatSettings.update({
      where: { chatId },
      data: { linkRulesPolicy: selected, linkPolicy: 'ALLOWLIST_ONLY' },
    });
    expect(first.linkPolicyRevision).toBe(original.linkPolicyRevision + 1);
    expect(first.linkPolicyEffectiveAt).not.toBeNull();
    const equal = await db.chatSettings.update({
      where: { chatId },
      data: { linkRulesPolicy: structuredClone(selected) },
    });
    expect(equal.linkPolicyRevision).toBe(first.linkPolicyRevision);
    expect(equal.linkPolicyEffectiveAt).toEqual(first.linkPolicyEffectiveAt);
    await db.domainAllowlist.create({ data: { chatId, domain: 'domain:ignored.example' } });
    expect((await row()).linkPolicyRevision).toBe(first.linkPolicyRevision);
    const changed = await db.chatSettings.update({
      where: { chatId },
      data: {
        linkRulesPolicy: { ...selected, rules: [{ ...selected.rules[0]!, enabled: false }] },
      },
    });
    expect(changed.linkPolicyRevision).toBe(first.linkPolicyRevision + 1);
    const disabled = await db.chatSettings.update({
      where: { chatId },
      data: {
        linkRulesPolicy: { version: 1, mode: 'ALLOW_ALL', rules: [] },
        linkPolicy: 'ALERT_ONLY',
      },
    });
    expect(disabled.linkPolicyRevision).toBe(changed.linkPolicyRevision + 1);
    expect(disabled.linkPolicyEffectiveAt).toBeNull();
  });

  it('rejects a stale legacy list revision and leaves both policy and sanctions untouched', async () => {
    const draft = await adoption();
    await runtime().addDomain(chatId, user, { domain: 'example.com', kind: 'WEB_DOMAIN' });
    await expect(save({ ...draft, linkBanEnabled: true })).rejects.toBeInstanceOf(
      ConflictException,
    );
    const stored = await row();
    expect(stored.linkRulesPolicy).toBeNull();
    expect(stored.linkBanEnabled).toBe(false);
  });

  it('commits policy and sanctions together, then rejects a waiting old-list writer', async () => {
    const draft = await adoption();
    let release!: () => void;
    let lockReady!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingSave = save(
      { ...draft, linkWarnEnabled: true },
      {
        beforeWrite: async () => {
          lockReady();
          await gate;
        },
      },
    );
    await locked;
    const pendingLegacyWrite = runtime().addDomain(chatId, user, {
      domain: 'waiting.example',
      kind: 'WEB_DOMAIN',
    });
    release();
    const results = await Promise.allSettled([pendingSave, pendingLegacyWrite]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(ConflictException) });
    const stored = await row();
    expect(stored.linkRulesPolicy).toEqual(selected);
    expect(stored.linkPolicy).toBe('ALLOWLIST_ONLY');
    expect(stored.linkWarnEnabled).toBe(true);
    expect(await db.domainAllowlist.count({ where: { chatId } })).toBe(0);
  });

  it('preserves an adopted policy on unrelated legacy writes and rejects clearing it', async () => {
    await save(await adoption());
    await save({ slowModeEnabled: true, linkPolicy: 'BLOCKLIST_ONLY' });
    expect((await row()).linkRulesPolicy).toEqual(selected);
    expect((await row()).linkPolicy).toBe('ALLOWLIST_ONLY');
    await expect(save({ linkRulesPolicy: null })).rejects.toBeInstanceOf(ConflictException);
  });

  it('preserves malformed raw JSON on an echoed inert copy and requires deliberate replacement', async () => {
    await db.chatSettings.update({
      where: { chatId },
      data: { linkRulesPolicy: { version: 999 }, linkPolicy: 'BLOCKLIST_ONLY' },
    });
    const inert = await settings();
    expect(inert.linkRulesStorageStatus).toBe('invalid');
    await save({ ...inert, slowModeEnabled: true });
    expect((await row()).linkRulesPolicy).toEqual({ version: 999 });
    await expect(save({ ...inert, linkRulesPolicy: selected })).rejects.toBeInstanceOf(
      ConflictException,
    );
    await save({
      ...(await settings()),
      linkRulesPolicy: selected,
      linkRulesReplaceInvalidStorage: true,
    });
    expect((await row()).linkRulesPolicy).toEqual(selected);
  });

  it('copies rules with expiry, their shadow and sanctions together in each target transaction', async () => {
    const targetId = await targetChat();
    const expiring: LinkRulesPolicy = {
      ...selected,
      rules: [{ ...selected.rules[0]!, expiresAt: '2030-01-01T10:00:00.000Z' }],
    };
    await save({ ...(await adoption()), linkRulesPolicy: expiring, linkWarnEnabled: true });
    const source = await settings();
    const before = await db.chatSettings.findUniqueOrThrow({ where: { chatId: targetId } });
    await bulk(targetId, source);
    const copied = await db.chatSettings.findUniqueOrThrow({ where: { chatId: targetId } });
    expect(copied.linkRulesPolicy).toEqual(expiring);
    expect(copied.linkPolicy).toBe('ALLOWLIST_ONLY');
    expect(copied.linkWarnEnabled).toBe(true);
    expect(copied.linkPolicyRevision).toBe(before.linkPolicyRevision + 1);
    expect(copied).not.toHaveProperty('linkRulesLegacySnapshot');
  });

  it('rejects an intervening target revision before copying either rules or sanctions', async () => {
    const targetId = await targetChat();
    await save({ ...(await adoption()), linkWarnEnabled: true });
    await expect(
      bulk(targetId, await settings(), async () => {
        await db.chatSettings.update({
          where: { chatId: targetId },
          data: { slowModeEnabled: true },
        });
      }),
    ).rejects.toBeDefined();
    const preserved = await db.chatSettings.findUniqueOrThrow({ where: { chatId: targetId } });
    expect(preserved.linkRulesPolicy).toBeNull();
    expect(preserved.linkWarnEnabled).toBe(false);
    expect(preserved.slowModeEnabled).toBe(true);
  });
});
