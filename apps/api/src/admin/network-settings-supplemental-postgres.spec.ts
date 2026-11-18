import { ManagedEntityNetworksService } from './managed-entity-networks.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { chatRulesSchema, chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts';
import type {
  NetworkSettingsChange,
  NetworkSettingsSection,
} from '@maxim/contracts/network-settings';
import { createPrismaAdapter, Prisma, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { AdminSettingsService } from './admin-settings.service';
import type { AdminSettingsBotCapabilityService } from './admin-settings-bot-capability.service';
import type { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import type { MaxClientService } from '../max/max-client.service';
import { AdminMessageRetentionService } from './admin-message-retention.service';
import { AdvertisingPlacementService } from './advertising-placement.service';
import { NetworkSettingsService } from './network-settings.service';
import { NetworkNavigationAllowlist } from './network-navigation-allowlist';
import { saveChatSettings, sanitizeStoredChatSettings } from './admin-chat-settings';
import { saveChatRulesDraft, writeNetworkChatRulesDraft } from './admin-chat-rules';
import { AdminStopWordsService } from './admin-stop-words.service';
import {
  readStopWordsPolicy,
  stopWordsPolicyStorage,
} from '../moderation/stop-words/stop-words.policy';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('supplemental network settings with PostgreSQL', () => {
  let db: PrismaClient;
  let service: NetworkSettingsService;
  let retention: AdminMessageRetentionService;
  let advertising: AdvertisingPlacementService;
  let stopWords: AdminStopWordsService;
  const suffix = randomUUID();
  const number = BigInt(`0x${suffix.replaceAll('-', '').slice(0, 13)}`);
  const ids = [`-${number}`, `-${number + 1n}`];
  const operations: string[] = [];
  const user = { userId: '323459159', username: null, displayName: null };
  const cache = { invalidate: async () => undefined };
  const followup = jest
    .fn<
      ReturnType<AdminSettingsService['finishNetworkSettingsFollowup']>,
      Parameters<AdminSettingsService['finishNetworkSettingsFollowup']>
    >()
    .mockResolvedValue(undefined);
  const access = {
    assertChatAdminAccess: jest.fn(async () => undefined),
    assertManagedEntityAdminAccess: jest.fn(async () => undefined),
  } satisfies Pick<
    ManagedEntitiesService,
    'assertChatAdminAccess' | 'assertManagedEntityAdminAccess'
  >;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15_000 }),
    });
    for (const [index, id] of ids.entries()) {
      await db.chat.create({
        data: {
          id,
          title: `Supplemental ${suffix} ${index}`,
          entityType: 'CHAT',
          settings: {
            create: { greetingBotMessageText: `Own greeting ${index}`, botSpeechStyle: 'FRIENDLY' },
          },
          rules: {
            create: {
              text: `Own rules ${index}`,
              publishedMessageId: `receipt-${index}`,
              publishedUrl: `https://max.ru/rules${index}`,
            },
          },
        },
      });
      await db.messageRetentionPolicy.create({
        data: {
          chatId: id,
          hours: index === 0 ? 24 : 48,
          activationId: randomUUID(),
          quotaShard: 0,
        },
      });
      await db.advertisingPlacement.create({
        data: { chatId: id, enabled: true, listingId: randomUUID() },
      });
    }
    const prisma = db as PrismaService;
    retention = new AdminMessageRetentionService(
      prisma,
      access as unknown as ManagedEntitiesService,
      {
        assertChatSettingsBotCapabilities: async () => undefined,
      } as unknown as AdminSettingsBotCapabilityService,
      {
        allows: () => true,
        mode: 'on',
        diagnostics: async () => ({ oldestDueAt: null, blockerStatus: null }),
      } as unknown as MessageRetentionStore,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: 'publisher' }),
    );
    advertising = new AdvertisingPlacementService(
      prisma,
      access as unknown as ManagedEntitiesService,
      {} as MaxClientService,
      new ConfigService({}),
    );
    const settings = {
      commercialAiModerationMode: () => 'DELETE_ONLY' as const,
      getSettings: async (id: string) => {
        const row = await db.chatSettings.findUniqueOrThrow({ where: { chatId: id } });
        return {
          ...chatSettingsSchema.parse(sanitizeStoredChatSettings(row)),
          settingsRevision: row.updatedAt.toISOString(),
        };
      },
      updateNetworkChatSettings: async (id, actor, body, networkWrite) =>
        saveChatSettings({
          prisma,
          chatContextCache: cache,
          chatId: id,
          actorUserId: actor.userId,
          body,
          source: 'miniapp',
          networkWrite,
          resolveBotAssignmentData: () => ({}),
          assertRequiredSubscriptionSettings: async () => undefined,
          assertBotCapabilities: async () => undefined,
          refreshExecutionReadiness: async () => undefined,
        }),
      finishNetworkSettingsFollowup: followup,
      buildNetworkRulesText: async (id: string) =>
        `Generated ${(await db.chatSettings.findUniqueOrThrow({ where: { chatId: id } })).greetingBotMessageText}`,
    } satisfies Pick<
      AdminSettingsService,
      | 'commercialAiModerationMode'
      | 'getSettings'
      | 'updateNetworkChatSettings'
      | 'finishNetworkSettingsFollowup'
      | 'buildNetworkRulesText'
    >;
    const capabilities = {
      assertChatSettingsBotCapabilities: async () => undefined,
    } satisfies Pick<AdminSettingsBotCapabilityService, 'assertChatSettingsBotCapabilities'>;
    stopWords = new AdminStopWordsService(
      prisma,
      access as unknown as ManagedEntitiesService,
      settings as unknown as AdminSettingsService,
      capabilities as unknown as AdminSettingsBotCapabilityService,
      cache as unknown as ChatContextCacheService,
      new ConfigService({ IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'off' }),
    );
    service = new NetworkSettingsService(
      prisma,
      new ManagedEntityNetworksService(prisma, {
        getAllBots: () => [],
      } as unknown as MaxBotRegistryService),
      access as unknown as ManagedEntitiesService,
      settings as unknown as AdminSettingsService,
      stopWords,
      {} as never,
      new NetworkNavigationAllowlist(prisma),
      retention,
      advertising,
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.networkSettingsOperation.deleteMany({ where: { id: { in: operations } } });
    await db.auditLog.deleteMany({ where: { chatId: { in: ids } } });
    await db.messageRetentionPolicy.deleteMany({ where: { chatId: { in: ids } } });
    await db.advertisingPlacement.deleteMany({ where: { chatId: { in: ids } } });
    await db.chat.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  async function prepared(section: NetworkSettingsSection, changes: NetworkSettingsChange[]) {
    const scope = {
      entityType: 'chat' as const,
      section,
      target: { mode: 'selected' as const, entityIds: ids },
    };
    const read = await service.read(user, scope);
    const operationId = randomUUID();
    operations.push(operationId);
    const result = await service.preview(user, {
      ...scope,
      operationId,
      changes,
      compositionVersion: read.compositionVersion,
      recipients: read.recipients,
    });
    for (let i = 0; i < 8 && (await service.status(user, operationId)).status === 'PREVIEWING'; i++)
      await service.tick(1);
    expect((await service.status(user, operationId)).status).toBe('PREPARED');
    return { operationId, previewHash: result.previewHash };
  }
  async function apply(input: { operationId: string; previewHash: string }) {
    await service.apply(user, input);
    for (let i = 0; i < 12; i++) {
      const state = await service.status(user, input.operationId);
      if (['COMPLETE', 'PARTIAL', 'FAILED'].includes(state.status)) return state;
      await service.tick(1);
    }
    throw new Error('Operation did not settle within its bounded tick count');
  }

  it('applies speech style and a rules flag while preserving each draft, media and published receipt', async () => {
    expect(
      (
        await apply(
          await prepared('speechStyle', [{ path: 'botSpeechStyle', op: 'set', value: 'IRONIC' }]),
        )
      ).status,
    ).toBe('COMPLETE');
    const input = await prepared('rules', [
      { path: 'rulesAttachViolationsEnabled', op: 'set', value: true },
    ]);
    expect((await apply(input)).status).toBe('COMPLETE');
    expect((await service.apply(user, input)).status).toBe('COMPLETE');
    for (const [index, id] of ids.entries()) {
      expect(await db.chatSettings.findUniqueOrThrow({ where: { chatId: id } })).toMatchObject({
        botSpeechStyle: 'IRONIC',
        greetingBotMessageText: `Own greeting ${index}`,
        rulesAttachViolationsEnabled: true,
      });
      expect(await db.chatRules.findUniqueOrThrow({ where: { chatId: id } })).toMatchObject({
        text: `Own rules ${index}`,
        publishedMessageId: `receipt-${index}`,
      });
    }
    expect(
      await db.networkSettingsOperationTarget.count({
        where: { operationId: input.operationId, status: 'COMPLETE' },
      }),
    ).toBe(2);
  });
  it('keeps each retention duration and commits advertising changes without sending', async () => {
    expect(
      (
        await apply(
          await prepared('messageRetention', [
            { path: 'messageRetention.enabled', op: 'set', value: true },
          ]),
        )
      ).status,
    ).toBe('COMPLETE');
    for (const [index, id] of ids.entries())
      expect(
        await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: id } }),
      ).toMatchObject({ enabled: true, hours: index === 0 ? 24 : 48, revision: 1 });
    expect(
      (
        await apply(
          await prepared('advertising', [{ path: 'advertising.enabled', op: 'set', value: false }]),
        )
      ).status,
    ).toBe('COMPLETE');
    expect(await db.advertisingPlacementSend.count({ where: { chatId: { in: ids } } })).toBe(0);
  });
  it('generates each rules draft from its own confirmed settings', async () => {
    expect(
      (
        await apply(
          await prepared('rules', [{ path: 'rules.autoTextEnabled', op: 'set', value: true }]),
        )
      ).status,
    ).toBe('COMPLETE');
    for (const [index, id] of ids.entries())
      expect(await db.chatRules.findUniqueOrThrow({ where: { chatId: id } })).toMatchObject({
        text: `Generated Own greeting ${index}`,
        autoTextEnabled: true,
        publishedMessageId: `receipt-${index}`,
      });
  });
  it('rejects a changed independent policy after confirmation and leaves every target untouched', async () => {
    const input = await prepared('messageRetention', [
      { path: 'messageRetention.hours', op: 'set', value: 48 },
    ]);
    await db.messageRetentionPolicy.update({
      where: { chatId: ids[0]! },
      data: { revision: { increment: 1 } },
    });
    expect((await apply(input)).status).toBe('FAILED');
    expect(
      (await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: ids[0]! } })).hours,
    ).toBe(24);
  });
  it('rolls back the policy and audit if its durable receipt cannot commit', async () => {
    const id = ids[1]!;
    const current = await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: id } });
    const auditCount = await db.auditLog.count({
      where: { chatId: id, action: 'UPDATE_MESSAGE_RETENTION' },
    });
    await expect(
      retention.update(
        id,
        user,
        { enabled: false, hours: 24, expectedRevision: current.revision },
        {
          onCommitted: async () => {
            throw new Error('receipt rejected');
          },
        },
      ),
    ).rejects.toThrow('receipt rejected');
    expect(await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId: id } })).toEqual(
      current,
    );
    expect(
      await db.auditLog.count({ where: { chatId: id, action: 'UPDATE_MESSAGE_RETENTION' } }),
    ).toBe(auditCount);
  });
  it('allows only one concurrent rules writer at a shared revision and preserves publication state', async () => {
    const id = ids[0]!;
    const row = await db.chatRules.findUniqueOrThrow({ where: { chatId: id } });
    const draft = chatRulesSchema.parse({ ...row, publishedAt: null });
    const writes = await Promise.allSettled([
      db.$transaction((tx) =>
        writeNetworkChatRulesDraft(
          tx,
          id,
          user.userId,
          { ...draft, text: 'Group draft' },
          row.updatedAt.toISOString(),
          ['rules.text'],
        ),
      ),
      saveChatRulesDraft({
        prisma: db as PrismaService,
        chatContextCache: cache,
        chatId: id,
        actorUserId: user.userId,
        source: 'miniapp',
        body: { ...draft, text: 'Single draft', expectedRevision: row.updatedAt.toISOString() },
      }),
    ]);
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      (await db.chatRules.findUniqueOrThrow({ where: { chatId: id } })).publishedMessageId,
    ).toBe(row.publishedMessageId);
  });

  const stopWordsScope = {
    entityType: 'chat' as const,
    section: 'stopWords' as const,
    target: { mode: 'selected' as const, entityIds: ids },
  };

  async function seedStopWords() {
    for (const [index, id] of ids.entries())
      await db.chatSettings.update({
        where: { chatId: id },
        data: {
          ...stopWordsPolicyStorage(
            stopWordsPolicySchema.parse({
              enabled: true,
              rules: [{ id: `own-${index}`, kind: 'WORD', value: `private${index}` }],
              domains: [`own${index}.example`],
            }),
          ),
          stopWordsRevision: 7,
        },
      });
  }

  it.each(['policy', 'media'] as const)(
    'refuses an invalid %s as a network source without rewriting or exposing it',
    async (field) => {
      await seedStopWords();
      await db.chatSettings.update({
        where: { chatId: ids[0]! },
        data:
          field === 'policy'
            ? { stopWordsPolicy: { version: 999, privateSource: 'private-policy' } }
            : { stopWordsMedia: { explanation: { base64: 17, privateSource: 'private-media' } } },
      });
      const before = await db.chatSettings.findMany({ where: { chatId: { in: ids } } });
      const audits = await db.auditLog.count({ where: { chatId: { in: ids } } });
      await expect(service.read(user, stopWordsScope)).rejects.toMatchObject({
        response: { code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED', revision: 7, fieldPaths: [] },
      });
      try {
        await service.read(user, stopWordsScope);
      } catch (error: unknown) {
        expect(JSON.stringify(error)).not.toMatch(/private-policy|private-media|private0/);
      }
      expect(await db.chatSettings.findMany({ where: { chatId: { in: ids } } })).toEqual(before);
      expect(await db.auditLog.count({ where: { chatId: { in: ids } } })).toBe(audits);
    },
  );

  it('keeps valid and convertible legacy target rules during a sanctions-only network change', async () => {
    await seedStopWords();
    await db.chatSettings.update({
      where: { chatId: ids[1]! },
      data: {
        stopWordsPolicy: Prisma.DbNull,
        messageLimitsBlockedWords: ['legacyword'],
        messageLimitsBlockedDomains: ['legacy.example'],
      },
    });
    const before = await Promise.all(ids.map((id) => stopWords.read(id, user)));
    expect(before.map((state) => state.storageStatus)).toEqual(['valid', 'legacy']);
    const input = await prepared('stopWords', [
      { path: 'stopWordsPolicy.sanctions.warnEnabled', op: 'set', value: true },
    ]);
    expect((await apply(input)).status).toBe('COMPLETE');
    for (const [index, id] of ids.entries()) {
      const stored = await db.chatSettings.findUniqueOrThrow({ where: { chatId: id } });
      expect(stored.stopWordsRevision).toBe(before[index]!.revision + 1);
      expect(readStopWordsPolicy(stored)).toEqual({
        ...before[index]!.policy,
        sanctions: { ...before[index]!.policy.sanctions, warnEnabled: true },
      });
    }
  });

  it('rejects a retained preview built from an invalid fallback without writing any target', async () => {
    await seedStopWords();
    const read = await service.read(user, stopWordsScope);
    const original = await db.chatSettings.findUniqueOrThrow({ where: { chatId: ids[0]! } });
    // FLAG: Retain the old reader's exact fence: this represents an already-invalid row
    // whose disabled fallback was accepted into a preview before the compatible guard.
    await db.chatSettings.update({
      where: { chatId: ids[0]! },
      data: { stopWordsMedia: { explanation: { base64: 17 } }, updatedAt: original.updatedAt },
    });
    const before = await db.chatSettings.findMany({ where: { chatId: { in: ids } } });
    const audits = await db.auditLog.count({ where: { chatId: { in: ids } } });
    const previousFollowups = followup.mock.calls.length;
    const operationId = randomUUID();
    operations.push(operationId);
    await service.preview(user, {
      ...stopWordsScope,
      operationId,
      compositionVersion: read.compositionVersion,
      recipients: read.recipients,
      changes: [{ path: 'stopWordsPolicy.sanctions.warnEnabled', op: 'set', value: true }],
    });
    await service.tick(1);
    const failed = await service.status(user, operationId);
    expect(failed.status).toBe('FAILED');
    expect(failed.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: ids[0], status: 'FAILED', failureCode: 'CONFLICT' }),
        expect.objectContaining({
          entityId: ids[1],
          status: 'FAILED',
          failureCode: 'PREFLIGHT_ABORTED',
        }),
      ]),
    );
    await service.tick(1);
    expect(await db.chatSettings.findMany({ where: { chatId: { in: ids } } })).toEqual(before);
    expect(await db.auditLog.count({ where: { chatId: { in: ids } } })).toBe(audits);
    expect(followup.mock.calls).toHaveLength(previousFollowups);
  });

  it('resumes only the followup of a committed target even if its current storage is invalid', async () => {
    await seedStopWords();
    const input = await prepared('stopWords', [
      { path: 'stopWordsPolicy.imageScanEnabled', op: 'set', value: true },
    ]);
    await service.apply(user, input);
    await service.tick(1);
    followup
      .mockRejectedValueOnce(new Error('followup temporarily unavailable'))
      .mockRejectedValueOnce(new Error('followup temporarily unavailable'));
    await service.tick(1);
    expect((await service.status(user, input.operationId)).status).toBe('RUNNING');
    expect(
      await db.networkSettingsOperationTarget.count({
        where: { operationId: input.operationId, status: 'COMMITTED' },
      }),
    ).toBe(2);
    await db.chatSettings.update({
      where: { chatId: ids[0]! },
      data: { stopWordsMedia: { explanation: { base64: 17 } } },
    });
    const before = await db.chatSettings.findMany({ where: { chatId: { in: ids } } });
    const audits = await db.auditLog.count({ where: { chatId: { in: ids } } });
    const previousFollowups = followup.mock.calls.length;
    await service.tick(1);
    expect((await service.status(user, input.operationId)).status).toBe('COMPLETE');
    expect(followup.mock.calls.length - previousFollowups).toBe(2);
    expect(await db.chatSettings.findMany({ where: { chatId: { in: ids } } })).toEqual(before);
    expect(await db.auditLog.count({ where: { chatId: { in: ids } } })).toBe(audits);
  });
});
