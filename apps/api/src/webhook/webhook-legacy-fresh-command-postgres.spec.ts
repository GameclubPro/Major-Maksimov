import { ManagedEntityHandshakeService } from '../max/managed-entity-handshake.service';
import { ManagedEntityAccessWriter } from '../max/managed-entity-access-writer.service';
import { ManagedEntityHandshakeOutcomeService } from '../max/managed-entity-handshake-outcome.service';
import type { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { GroupCommandAuthorityService } from '../common/group-command-authority.service';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { AdminService } from '../admin/admin.service';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import { WebhookService } from './webhook.service';
import { WebhookParser } from './webhook.parser';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { readFreshHeldCommandReceipt } from './webhook-legacy-fresh-command';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import {
  buildLegacyRecoveryPreviewDigest,
  createLegacyColdCertificate,
  inspectLegacyRecoveryCandidate,
  installAndSealLegacyRecoveryBatch,
  legacySnapshotDigest,
} from './webhook-legacy-cold-install';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
native('fresh held command ingress, real SQL authority, BullMQ and guarded MAX', () => {
  jest.setTimeout(60_000);
  let h: MultibotHarness, chatId: string, ownerId: string, certificateId: string;
  const previousOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
  beforeEach(async () => {
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 3 });
    await h.pause();
    chatId = (await h.seedCatalog(1))[0]!;
    const cutoff = (
      await h.prisma.$queryRaw<Array<{ at: Date }>>`SELECT finished_at AS at FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`
    )[0]!.at;
    const update = payload('Ordinary old source', 'held-user', cutoff.getTime() - 5000);
    const event = await h.prisma.webhookEvent.create({
      data: {
        botId: update.botId,
        dedupKey: `${update.botId}:${update.updateId}`,
        semanticKey: buildWebhookSemanticEventKey(update),
        normalizedPayload: JSON.parse(JSON.stringify(update)),
        rawPayload: update.raw!,
        status: 'FAILED',
        createdAt: new Date(cutoff.getTime() - 4000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    ownerId = event.id;
    h.receiptIds.push(ownerId);
    await h.prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: event.semanticKey!,
        webhookEventId: ownerId,
        enforced: false,
        createdAt: event.createdAt,
      },
    });
    const candidate = await inspectLegacyRecoveryCandidate(
      h.prisma,
      ownerId,
      h.bots.map((bot) => bot.id),
    );
    expect(candidate).not.toBeNull();
    const sourceSha = 'a'.repeat(40),
      imageId = `sha256:${'b'.repeat(64)}`;
    const cert = await createLegacyColdCertificate(h.prisma, {
      version: 1,
      sourceSha,
      imageId,
      transitionJournalSha256: 'c'.repeat(64),
      previewSha256: buildLegacyRecoveryPreviewDigest([candidate!], []),
      queueFenceNonce: 'disposable-fresh-command-only',
      roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
        (serviceName) => ({
          serviceName,
          containerId: legacySnapshotDigest(serviceName),
          sourceSha,
          imageId,
          stopped: true,
        }),
      ),
    });
    certificateId = cert.id;
    await installAndSealLegacyRecoveryBatch(h.prisma, cert.id, [candidate!], []);
    const admin = Object.create(AdminService.prototype) as AdminService;
    Object.assign(admin, {
      prisma: h.prisma,
      chatContextCache: h.cache,
      assertChatAdmin: async () => undefined,
      ensureEntityType: async () => undefined,
      scheduleDestructiveModerationAdminRosterWarmup: () => undefined,
    });
    Object.assign(h.moderation, { injectedManualModerationService: admin });
    await new Promise((resolve) => setTimeout(resolve, 2));
  });
  afterEach(async () => {
    if (h) {
      await h.pause();
      await h.prisma.webhookExecutionClaim.deleteMany({
        where: { webhookEventId: { in: h.receiptIds } },
      });
      await h.prisma.webhookEvent.deleteMany({ where: { id: { in: h.receiptIds } } });
      const authority = await h.prisma.webhookLegacySealedAuthority.findUnique({
        where: { certificateId },
      });
      if (authority)
        await h.prisma.webhookLegacyReceiptDisposition.deleteMany({
          where: { authorityId: authority.id },
        });
      await h.prisma.webhookLegacyMaterializationCursor.deleteMany({ where: { certificateId } });
      await h.prisma.webhookLegacySealedAuthority.deleteMany({ where: { certificateId } });
      await h.prisma.webhookLegacyRecovery.deleteMany({ where: { certificateId } });
      await h.prisma.webhookLegacyQuiescenceCertificate.deleteMany({
        where: { id: certificateId },
      });
      await h.dispose();
    }
    if (previousOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = previousOffline;
  });
  function payload(
    text: string,
    userId = 'held-user',
    at = Date.now(),
    messageId = randomUUID(),
    botId = h.bots[0]!.id,
  ) {
    return new WebhookParser().parse(
      {
        update_type: 'message_created',
        update_id: randomUUID(),
        timestamp: at,
        message: {
          sender: { user_id: userId, name: 'Fixture', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: at,
          body: { mid: messageId, text },
        },
      },
      { botId },
    );
  }
  async function store(update = payload('тишина 12')) {
    const result = await h.ingress.storeReceipt(update, null);
    expect(result.webhookEventId).toBeTruthy();
    h.receiptIds.push(result.webhookEventId!);
    return result.webhookEventId!;
  }
  async function runReceipts(ids: string[]) {
    await h.resume();
    const end = Date.now() + 15_000;
    for (;;) {
      await h.pumpOnce();
      const pending = await h.prisma.webhookEvent.count({
        where: { id: { in: ids }, status: { notIn: ['PROCESSED', 'DUPLICATE'] } },
      });
      if (!pending) break;
      if (Date.now() > end) {
        const states = await h.prisma.webhookEvent.findMany({
          where: { id: { in: ids } },
          select: { status: true, errorMessage: true },
        });
        throw new Error(JSON.stringify(states));
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await h.pause();
  }
  it('keeps a prepared user_removed observation under its real sealed legacy hold', async () => {
    const original = payload('', 'held-user');
    const update = {
      ...original,
      type: 'user_removed',
      membership: { action: 'removed' as const, memberUserIds: ['held-user'] },
      raw: { ...(original.raw as Record<string, unknown>), update_type: 'user_removed' },
    };
    const id = await store(update);
    await h.prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: buildWebhookSemanticEventKey(update)!,
        webhookEventId: id,
        enforced: true,
        status: 'READY',
        preparedAt: new Date(),
        executionBotId: h.bots[0]!.id,
      },
    });
    const handler = jest.spyOn(h.moderation, 'handleUpdate');
    const readiness = jest.spyOn(h.readiness, 'ensureReady');
    expect(await h.legacyHolds.isUpdateHeld(update)).toBe(true);
    await h.moderation.processWebhookEvent(id);
    expect((await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
      'RECEIVED',
    );
    expect(
      await h.prisma.webhookExecutionClaim.findFirstOrThrow({ where: { webhookEventId: id } }),
    ).toMatchObject({ businessStartedAt: null, completedAt: null, leaseToken: null });
    expect(handler).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    expect(h.effects).toEqual([]);
  });
  it.each(['тишина 12', '  тишина\n\t  12  '])(
    'runs one fresh configured command %j across mirrors and then admits another user without ordinary moderation',
    async (commandText) => {
      h.allowAdminUser('held-user');
      const messageId = randomUUID(),
        at = Date.now();
      const ids = await Promise.all(
        h.bots.map((bot) => store(payload(commandText, 'held-user', at, messageId, bot.id))),
      );
      const observe = jest.spyOn(h.duplicateService, 'observeLifecycle');
      await runReceipts(ids);
      expect(observe).not.toHaveBeenCalled();
      expect(
        h.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
      ).toHaveLength(1);
      expect(h.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
      expect(
        (await h.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } }))
          .nightModeForceCloseEnabled,
      ).toBe(true);
      const command = await h.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'COMMAND', webhookEventId: { in: ids } },
      });
      expect(command.status).toBe('COMPLETED');
      expect(
        await h.prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: { in: ids } } }),
      ).toBe(0);
      expect(
        (await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).status,
      ).toBe('FAILED');
      await h.prisma.chatSettings.update({
        where: { chatId },
        data: { nightModeForceCloseEnabled: false },
      });
      const independent = await store(payload('hello', 'unrelated-user'));
      await runReceipts([independent]);
      expect(observe).toHaveBeenCalledTimes(1);
    },
  );
  it('ignores cached administrator data and silently completes a command denied by the live actor check', async () => {
    await h.cache.setAdminAccess(chatId, 'held-user', 'granted');
    await h.cache.rememberChatAdminUser(chatId, 'held-user');
    const id = await store();
    await runReceipts([id]);
    expect(h.effects).toEqual([]);
    expect(
      h.requests.some((request) => request.method === 'get' && request.path.endsWith('/members')),
    ).toBe(true);
    expect(
      (await h.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } }))
        .nightModeForceCloseEnabled,
    ).toBe(false);
  });
  it('does not send or mutate settings after live bot access disappears', async () => {
    h.allowAdminUser('held-user');
    const id = await store();
    await h.ingress.preparePersistedWebhookEvent(id);
    for (const bot of h.bots) h.denyBot(bot.id);
    // Existing routing proof is still cached; the command's live check must reject it.
    await h.moderation.processWebhookEvent(id);
    expect(h.effects).toEqual([]);
    expect(
      (await h.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } }))
        .nightModeForceCloseEnabled,
    ).toBe(false);
  });
  it('settles an unstarted expired fresh command without replay and lets the next command pass', async () => {
    h.allowAdminUser('held-user');
    const id = await store();
    await h.prisma.webhookEvent.update({
      where: { id },
      data: { executionDeadlineAt: new Date(Date.now() - 1) },
    });
    await runReceipts([id]);
    expect(h.effects).toEqual([]);
    expect(
      (await h.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } }))
        .nightModeForceCloseEnabled,
    ).toBe(false);
    const next = await store();
    await runReceipts([next]);
    expect(
      (await h.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } }))
        .nightModeForceCloseEnabled,
    ).toBe(true);
  });
  it('uses the current custom command name and rechecks live actor access after claiming authority', async () => {
    h.allowAdminUser('held-user');
    await h.prisma.chatSettings.update({
      where: { chatId },
      data: { adminSilenceCommandName: 'пауза' },
    });
    const id = await store(payload('пауза 12'));
    expect((await readFreshHeldCommandReceipt(h.prisma, id))?.kind).toBe('ADMIN');
    const claim = h.groupCommands.claim.bind(h.groupCommands);
    const getAccess = h.max.getChatMemberAccess.bind(h.max);
    let revoked = false;
    const access = jest.spyOn(h.max, 'getChatMemberAccess').mockImplementation(async (...args) => {
      const result = await getAccess(...args);
      return revoked && result ? { ...result, isAdmin: false, isOwner: false } : result;
    });
    const lease = jest.spyOn(h.groupCommands, 'claim').mockImplementation(async (...args) => {
      const permit = await claim(...args);
      revoked = true;
      return permit;
    });
    try {
      await runReceipts([id]);
      expect(h.effects).toEqual([]);
      expect(
        (await h.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } }))
          .nightModeForceCloseEnabled,
      ).toBe(false);
    } finally {
      access.mockRestore();
      lease.mockRestore();
    }
    const next = await store(payload('пауза 12'));
    await runReceipts([next]);
    expect(
      (await h.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } }))
        .nightModeForceCloseEnabled,
    ).toBe(true);
  });
  it.each([false, true])(
    'recovers only the saved unattempted notice after late actor rejection, expired=%s',
    async (expired) => {
      h.allowAdminUser('held-user');
      const id = await store();
      await h.ingress.preparePersistedWebhookEvent(id);
      const handler = jest.spyOn(h.moderation, 'handleUpdate');
      const assertAccess = h.groupCommands.assertFreshHeldCommandAccess.bind(h.groupCommands);
      const getAccess = h.max.getChatMemberAccess.bind(h.max);
      let revoked = false;
      const access = jest
        .spyOn(h.max, 'getChatMemberAccess')
        .mockImplementation(async (...args) => {
          const result = await getAccess(...args);
          return revoked && result ? { ...result, isAdmin: false, isOwner: false } : result;
        });
      const finalCheck = jest
        .spyOn(h.groupCommands, 'assertFreshHeldCommandAccess')
        .mockImplementation(async (...args) => {
          revoked = true;
          return assertAccess(...args);
        });
      try {
        await expect(h.moderation.processWebhookEvent(id)).rejects.toThrow(
          'notice delivery remains pending',
        );
      } finally {
        access.mockRestore();
        finalCheck.mockRestore();
      }
      expect(h.effects).toEqual([]);
      const execution = await h.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: id },
      });
      expect(execution.commandResult).toMatchObject({ kind: 'COMMAND_NOTICE_PENDING' });
      const deadline = (await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id } }))
        .executionDeadlineAt!;
      const clock = expired
        ? jest.spyOn(Date, 'now').mockReturnValue(deadline.getTime() + 1)
        : null;
      try {
        await h.moderation.processWebhookEvent(id);
      } finally {
        clock?.mockRestore();
      }
      expect(handler).toHaveBeenCalledTimes(1);
      expect(
        h.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
      ).toHaveLength(expired ? 0 : 1);
      expect((await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
        'PROCESSED',
      );
      if (expired)
        expect(
          (await h.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: execution.id } }))
            .commandResult,
        ).toMatchObject({ kind: 'COMMAND_NOTICE_EXPIRED' });
    },
  );
  it.each([
    'old',
    'sender',
    'raw',
    'future',
    'same-message',
    'normalized-text',
    'forward-text',
    'forward-same-text',
  ] as const)('never grants a command exception for %s evidence', async (fault) => {
    let update = payload('тишина 12');
    if (fault === 'old') update.raw!.message = { ...(update.raw!.message as object), timestamp: 1 };
    if (fault === 'sender') update.message!.senderId = 'forged';
    if (fault === 'normalized-text') update.message!.text = 'тишина 24';
    if (fault === 'forward-text' || fault === 'forward-same-text') {
      update.raw!.message = {
        ...(update.raw!.message as object),
        link: {
          type: 'forward',
          message: { body: { text: fault === 'forward-text' ? 'foreign text' : 'тишина 12' } },
        },
      };
      update = new WebhookParser().parse(update.raw!, { botId: update.botId });
    }
    if (fault === 'future') update.raw!.timestamp = Date.now() + 60_000;
    if (fault === 'same-message') {
      const owner = await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
      const original = owner.normalizedPayload as unknown as { message: { messageId: string } };
      update.message!.messageId = original.message.messageId;
      (update.raw!.message as { body: { mid: string } }).body.mid = original.message.messageId;
    }
    const id = await store(update);
    if (fault === 'raw')
      await h.prisma.webhookEvent.update({
        where: { id },
        data: { rawPayload: { changed: true } },
      });
    expect(await readFreshHeldCommandReceipt(h.prisma, id)).toBeNull();
    expect(h.effects).toEqual([]);
  });
  it.each([true, false])(
    'runs the actual Start handshake with live actor access=%s and preserves source-message protection',
    async (authorized) => {
      if (authorized) h.allowAdminUser('held-user');
      const handshake = new ManagedEntityHandshakeService(
        new ManagedEntityAccessWriter(h.prisma as never, h.links, h.cache),
        h.max,
        h.links,
        (h.links as unknown as { botRegistry: MaxBotRegistryService }).botRegistry,
        {
          scheduleChatAdminRosterSync: async () => true,
        } satisfies Pick<MaxChatAdminRosterSyncService, 'scheduleChatAdminRosterSync'> as never,
        new ManagedEntityHandshakeOutcomeService(h.prisma as never),
        h.groupCommands,
      );
      Object.assign(h.ingress, { managedEntityHandshakeService: handshake });
      const id = await store(payload('Старт'));
      await runReceipts([id]);
      expect(
        h.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
      ).toHaveLength(authorized ? 1 : 0);
      expect(h.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
      expect(
        (await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).legacyDispositionId,
      ).toBeNull();
    },
  );

  it('constructs and initializes the actual ingress/canonical/command providers with one shared hold reader', async () => {
    const context = await Test.createTestingModule({
      providers: [
        WebhookLegacyHoldService,
        WebhookService,
        WebhookCanonicalExecutionService,
        GroupCommandAuthorityService,
        { provide: PrismaService, useValue: h.prisma },
        { provide: ConfigService, useValue: h.config },
        { provide: MaxBotLinkService, useValue: h.links },
      ],
    }).compile();
    await context.init();
    const holds = context.get(WebhookLegacyHoldService);
    for (const provider of [
      WebhookService,
      WebhookCanonicalExecutionService,
      GroupCommandAuthorityService,
    ])
      expect((context.get(provider) as unknown as { legacyHolds: unknown }).legacyHolds).toBe(
        holds,
      );
    await context.close();
  });
});
