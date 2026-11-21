import { chatSettingsSchema, chatSummarySchema, type MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { AdminService } from '../admin/admin.service';
import { saveChatSettings } from '../admin/admin-chat-settings';
import { applySettingsToAllChats } from '../admin/admin-settings-apply';
import type { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { ClosedChatDeleteGuardService } from '../moderation/closed-chat-delete-guard.service';
import { formatMinutesAsTime } from '../moderation/night-mode-transition-time.util';
import { WebhookOutboxService } from '../webhook/webhook-outbox.service';
import type { MaxClientService } from '../max/max-client.service';
import {
  ChatEntityType,
  createPrismaClient,
  Prisma,
  type PrismaClient,
} from '../prisma/prisma-client';
import {
  advanceChatMutationOrder,
  buildGroupCommandKey,
  buildLegacyStartLedgerKey,
  GroupCommandAuthorityService,
  runGroupCommandWithAuthority,
  type GroupCommandPermit,
} from './group-command-authority.service';
import { expireUnclaimedGroupStarts } from './group-command-start-expiry';
import {
  deliverGroupCommandNotice,
  groupCommandNoticeLedgerKey,
} from './group-command-notice-delivery';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgresRace = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

describePostgresRace('PostgreSQL durable GROUP command races', () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let peerPrisma: PrismaClient;
  const chatIds: string[] = [];
  const receiptIds: string[] = [];
  const ledgerIds: string[] = [];
  const expiryClaimIds: string[] = [];
  let migrationCutoff: Date;
  const actor = {
    userId: 'command-race-admin',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('GROUP races require local race_test PostgreSQL');
    pool = new Pool({ connectionString: databaseUrl, max: 4, statement_timeout: 10_000 });
    const result = await pool.query<{ version: string; timezone: string }>(
      "SELECT version(), current_setting('TimeZone') AS timezone",
    );
    if (
      !result.rows[0]?.version.startsWith('PostgreSQL ') ||
      /pglite|wasm/iu.test(result.rows[0].version) ||
      result.rows[0].timezone !== 'UTC' ||
      process.env.TZ !== 'UTC'
    ) {
      throw new Error('GROUP races require native PostgreSQL and process/server UTC');
    }
    prisma = createPrismaClient(databaseUrl, { max: 12, statement_timeout: 10_000 });
    peerPrisma = createPrismaClient(databaseUrl, { max: 12, statement_timeout: 10_000 });
    migrationCutoff = (
      await pool.query<{ finished_at: Date }>(
        `SELECT finished_at FROM _prisma_migrations
         WHERE migration_name = '20261005020000_add_multibot_order_fences'
           AND finished_at IS NOT NULL AND rolled_back_at IS NULL
         ORDER BY finished_at DESC LIMIT 1`,
      )
    ).rows[0]!.finished_at;
  });

  afterEach(async () => {
    if (!prisma) return;
    await prisma.maxActionLedgerEntry.deleteMany({ where: { id: { in: ledgerIds.splice(0) } } });
    await prisma.webhookExecutionClaim.deleteMany({
      where: { id: { in: expiryClaimIds.splice(0) } },
    });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receiptIds.splice(0) } } });
    await prisma.chat.deleteMany({ where: { id: { in: chatIds.splice(0) } } });
  });

  afterAll(async () => {
    await Promise.all([prisma?.$disconnect(), peerPrisma?.$disconnect(), pool?.end()]);
  });

  function admin(client: PrismaClient = prisma): AdminService {
    const service = Object.create(AdminService.prototype) as AdminService;
    Object.assign(service, {
      prisma: client,
      configService: new ConfigService({
        ERASER_ENABLED: false,
        ERASER_CONTROL_URL: '',
        ERASER_CONTROL_TOKEN: '',
      }),
      assertChatAdmin: jest.fn().mockResolvedValue(undefined),
      ensureEntityType: jest.fn().mockResolvedValue(undefined),
      chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
      scheduleDestructiveModerationAdminRosterWarmup: jest.fn(),
      maxClient: {},
      logger: { warn: jest.fn() },
      chatRulesTextRuntime: {
        upsertChatRules: (chatId: string) =>
          client.chatRules.upsert({
            where: { chatId },
            create: { chatId },
            update: {},
          }),
        normalizePublishedRulesUrl: (value: unknown) => (typeof value === 'string' ? value : null),
        normalizeImportedRulesText: (value: unknown) => (typeof value === 'string' ? value : null),
        mapChatRules: (value: unknown) => value,
      },
    });
    return service;
  }

  async function fixture(
    botCount: number,
    sourceAt = new Date(Date.now() - 60_000),
    chatId?: string,
    acceptedAt = new Date(),
  ): Promise<{ chatId: string; messageId: string; updates: MaxUpdate[] }> {
    const id = chatId ?? `group-race-${randomUUID()}`;
    if (!chatId) {
      chatIds.push(id);
      await prisma.chat.create({
        data: {
          id,
          title: 'GROUP race',
          entityType: ChatEntityType.CHAT,
          settings: { create: {} },
          rules: { create: {} },
        },
      });
    }
    const messageId = `command-${randomUUID()}`;
    const updates = Array.from(
      { length: botCount },
      (_, index) =>
        ({
          updateId: `update-${randomUUID()}`,
          botId: `bot-${index + 1}`,
          type: 'message_created',
          timestamp: sourceAt.toISOString(),
          message: {
            chatId: id,
            messageId,
            senderId: actor.userId,
            text: 'тишина 12',
            entityType: 'chat',
            createdAt: sourceAt.toISOString(),
          },
        }) as unknown as MaxUpdate,
    );
    for (const update of updates) {
      const receipt = await prisma.webhookEvent.create({
        data: {
          dedupKey: `${update.botId}:${update.updateId}`,
          botId: update.botId,
          semanticKey: `message:message_created:${id}:${messageId}`,
          status: 'QUEUED',
          createdAt: acceptedAt,
          normalizedPayload: update as unknown as Prisma.InputJsonValue,
          rawPayload: update as unknown as Prisma.InputJsonValue,
        },
      });
      receiptIds.push(receipt.id);
    }
    return { chatId: id, messageId, updates };
  }

  async function claim(update: MaxUpdate, client = prisma): Promise<GroupCommandPermit> {
    const permit = await new GroupCommandAuthorityService(client as never).claim(
      update,
      update.botId!,
    );
    if (!permit) throw new Error('Expected a command permit');
    return permit;
  }

  async function startExpiryFixture(botCount = 3) {
    const receiptOffset = receiptIds.length;
    const acceptedAt = new Date(Math.max(Date.now(), migrationCutoff.getTime() + 1));
    const data = await fixture(botCount, new Date(Date.now() - 600_000), undefined, acceptedAt);
    const ids = receiptIds.slice(receiptOffset);
    for (const [index, update] of data.updates.entries()) {
      update.message!.text = 'Старт';
      await prisma.webhookEvent.update({
        where: { id: ids[index]! },
        data: {
          normalizedPayload: update as unknown as Prisma.InputJsonValue,
          rawPayload: update as unknown as Prisma.InputJsonValue,
          status: index === 0 ? 'PROCESSED' : 'DUPLICATE',
          processedAt: new Date(),
          executionDeadlineAt: new Date(Date.now() - 1_000),
        },
      });
    }
    const authority = new GroupCommandAuthorityService(prisma as never);
    await authority.observeStart(data.updates[0]!);
    const command = await prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: {
        kind_semanticKey: {
          kind: 'COMMAND',
          semanticKey: buildGroupCommandKey(data.chatId, data.messageId),
        },
      },
    });
    expiryClaimIds.push(command.id);
    await prisma.webhookExecutionClaim.update({
      where: { id: command.id },
      data: { createdAt: acceptedAt },
    });
    const semanticKey = `message:message_created:${data.chatId}:${data.messageId}`;
    const finishedAt = new Date();
    const businessStartedAt = new Date(finishedAt.getTime() - 1);
    const journal = {
      kind: 'EXECUTION_FINISHED',
      authorityVersion: 'semantic-owner-lease-v1',
      webhookEventId: ids[0]!,
      semanticKey,
      executionBotId: 'bot-1',
      businessStartedAt: businessStartedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
    const execution = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: ids[0]!,
        executionBotId: 'bot-1',
        status: 'COMPLETED',
        enforced: true,
        createdAt: acceptedAt,
        preparedAt: new Date(finishedAt.getTime() - 2),
        businessStartedAt,
        completedAt: finishedAt,
        commandResult: journal,
      },
    });
    expiryClaimIds.push(execution.id);
    return { ...data, ids, command, execution, journal, acceptedAt, authority };
  }

  function cleanupService() {
    const service = Object.create(WebhookOutboxService.prototype) as {
      deleteCompletedWebhookBatch(cutoff: Date): Promise<{ removed: number; scanned: number }>;
    };
    const cursors = new Map<string, { id: string; createdAt: Date }>();
    Object.assign(service, { prisma, webhookRetentionCursors: cursors });
    return { service, cursors };
  }

  const retentionCutoff = () => new Date(Date.now() + 86_400_000);

  async function retainedTerminalBaseline() {
    // FLAG: Other native suites retain sealed evidence until disposable-store teardown.
    // Exercise that non-empty state deliberately and preserve every pre-existing row.
    const control = await prisma.webhookEvent.create({
      data: {
        dedupKey: `group-retention-control-${randomUUID()}`,
        status: 'PROCESSED',
        normalizedPayload: {},
        rawPayload: {},
      },
    });
    receiptIds.push(control.id);
    const rows = await prisma.webhookEvent.findMany({
      where: { status: { in: ['PROCESSED', 'DUPLICATE'] }, createdAt: { lt: retentionCutoff() } },
      select: { id: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 129,
    });
    expect(rows.length).toBeLessThanOrEqual(128);
    return rows;
  }

  async function expectRetainedBaseline(
    rows: Awaited<ReturnType<typeof retainedTerminalBaseline>>,
  ) {
    expect(
      await prisma.webhookEvent.findMany({
        where: { id: { in: rows.map((row) => row.id) } },
        select: { id: true, status: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ).toEqual(rows);
  }

  it('silently expires a denied, unclaimed Start and purges its settled mirrored bodies', async () => {
    const baseline = await retainedTerminalBaseline();
    const data = await startExpiryFixture();
    const { service } = cleanupService();
    expect(await service.deleteCompletedWebhookBatch(retentionCutoff())).toEqual({
      removed: 3,
      scanned: 3 + baseline.length,
    });
    await expectRetainedBaseline(baseline);
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }),
    ).toMatchObject({
      status: 'COMPLETED',
      webhookEventId: null,
      executionBotId: null,
      businessStartedAt: null,
      commandResult: { action: 'START_EXPIRED', applied: false, noticeText: null },
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.execution.id } }),
    ).toMatchObject({ status: 'COMPLETED', webhookEventId: null, commandResult: data.journal });
    expect(await prisma.maxActionLedgerEntry.count({ where: { chatId: data.chatId } })).toBe(0);
  });

  it('keeps a weak-first Start claimable by a healthy peer before its original deadline', async () => {
    const data = await startExpiryFixture();
    await prisma.webhookEvent.updateMany({
      where: { id: { in: data.ids } },
      data: { executionDeadlineAt: new Date(Date.now() + 60_000) },
    });
    expect(
      await expireUnclaimedGroupStarts(prisma as never, retentionCutoff(), undefined, 500),
    ).toBe(0);
    const permit = await claim(data.updates[2]!, peerPrisma);
    expect(permit).toMatchObject({
      webhookEventId: data.ids[0],
      executionBotId: 'bot-3',
      result: null,
    });
    await data.authority.release(permit);
    await prisma.webhookEvent.updateMany({
      where: { id: { in: data.ids } },
      data: { executionDeadlineAt: new Date(Date.now() - 1_000) },
    });
    expect(
      await expireUnclaimedGroupStarts(prisma as never, retentionCutoff(), undefined, 500),
    ).toBe(0);
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }),
    ).toMatchObject({ status: 'PENDING', executionBotId: 'bot-3', commandResult: null });
  });

  it.each(['receipt', 'command', 'execution'] as const)(
    'pins a Start with historical %s birth even when terminal receipts appear safe',
    async (historical) => {
      const data = await startExpiryFixture();
      const beforeCutover = new Date(migrationCutoff.getTime() - 1_000);
      if (historical === 'receipt') {
        await prisma.webhookEvent.update({
          where: { id: data.ids[0]! },
          data: { createdAt: beforeCutover },
        });
      } else {
        await prisma.webhookExecutionClaim.update({
          where: { id: historical === 'command' ? data.command.id : data.execution.id },
          data: { createdAt: beforeCutover },
        });
      }
      expect(
        await expireUnclaimedGroupStarts(prisma as never, retentionCutoff(), undefined, 500),
      ).toBe(0);
      expect(
        (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }))
          .status,
      ).toBe('PENDING');
    },
  );

  it.each(['active', 'retry', 'quarantine', 'ambiguous', 'locked'] as const)(
    'pins an observation while a semantic mirror is %s',
    async (fence) => {
      const data = await startExpiryFixture();
      if (fence === 'locked') {
        const locked = await pool.connect();
        try {
          await locked.query('BEGIN');
          await locked.query('SELECT id FROM webhook_events WHERE id = $1 FOR UPDATE', [
            data.ids[2]!,
          ]);
          expect(
            await expireUnclaimedGroupStarts(prisma as never, retentionCutoff(), undefined, 500),
          ).toBe(0);
        } finally {
          await locked.query('ROLLBACK');
          locked.release();
        }
      } else {
        await prisma.webhookEvent.update({
          where: { id: data.ids[2]! },
          data:
            fence === 'active'
              ? { status: 'RECEIVED', processedAt: null }
              : fence === 'retry'
                ? { status: 'FAILED', nextEnqueueAt: new Date() }
                : fence === 'quarantine'
                  ? { timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000) }
                  : { errorMessage: 'ambiguous prior send' },
        });
        expect(
          await expireUnclaimedGroupStarts(prisma as never, retentionCutoff(), undefined, 500),
        ).toBe(0);
      }
      expect(
        (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }))
          .status,
      ).toBe('PENDING');
    },
  );

  it.each(['lease', 'missing-journal', 'wrong-owner', 'wrong-payload', 'send-proof'] as const)(
    'requires exact completed shared proof and rejects %s',
    async (fence) => {
      const data = await startExpiryFixture();
      if (fence === 'lease') {
        await prisma.webhookExecutionClaim.update({
          where: { id: data.execution.id },
          data: { leaseToken: 'lost-lease' },
        });
      } else if (fence === 'missing-journal' || fence === 'wrong-owner') {
        await prisma.webhookExecutionClaim.update({
          where: { id: data.execution.id },
          data: {
            commandResult:
              fence === 'missing-journal'
                ? Prisma.DbNull
                : { ...data.journal, webhookEventId: 'different-owner' },
          },
        });
      } else if (fence === 'wrong-payload') {
        await prisma.webhookEvent.update({
          where: { id: data.ids[0]! },
          data: {
            normalizedPayload: {
              ...data.updates[0],
              message: { ...data.updates[0]!.message, text: 'тишина' },
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } else {
        const ledger = await prisma.maxActionLedgerEntry.create({
          data: {
            jobId: groupCommandNoticeLedgerKey(data.command.semanticKey),
            chatId: data.chatId,
            botId: 'bot-1',
            actionType: 'SEND_MESSAGE',
            status: 'AMBIGUOUS',
            ambiguous: true,
            dispatchStartedAt: new Date(),
          },
        });
        ledgerIds.push(ledger.id);
      }
      expect(
        await expireUnclaimedGroupStarts(prisma as never, retentionCutoff(), undefined, 500),
      ).toBe(0);
      expect(
        (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }))
          .status,
      ).toBe('PENDING');
    },
  );

  it('uses a retained completed execution tombstone without fabricating its missing owner', async () => {
    const data = await startExpiryFixture(4);
    const otherOwner = data.ids[3]!;
    const journal = { ...data.journal, webhookEventId: otherOwner };
    await prisma.webhookExecutionClaim.update({
      where: { id: data.execution.id },
      data: { webhookEventId: otherOwner, commandResult: journal },
    });
    await prisma.webhookEvent.delete({ where: { id: otherOwner } });
    expect(
      await expireUnclaimedGroupStarts(prisma as never, retentionCutoff(), undefined, 500),
    ).toBe(1);
    expect(
      (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }))
        .commandResult,
    ).toEqual({ action: 'START_EXPIRED', applied: false, noticeText: null });
  });

  it('uses the cleanup cursor to pass 500 pinned bodies and settle a later observation', async () => {
    const baseline = await retainedTerminalBaseline();
    const data = await startExpiryFixture(1);
    const old = new Date(
      Math.min(
        Date.parse('2020-01-01T00:00:00Z'),
        ...baseline.map((row) => row.createdAt.getTime() - 1),
      ),
    );
    const pinned = Array.from({ length: 500 }, (_, index) => ({
      id: `start-retention-prefix-${randomUUID()}-${index}`,
      dedupKey: `start-prefix-${randomUUID()}`,
      status: 'PROCESSED' as const,
      createdAt: old,
      normalizedPayload: {},
      rawPayload: {},
    }));
    receiptIds.push(...pinned.map(({ id }) => id));
    await prisma.webhookEvent.createMany({ data: pinned });
    const { service, cursors } = cleanupService();
    expect(await service.deleteCompletedWebhookBatch(retentionCutoff())).toEqual({
      removed: 0,
      scanned: 500,
    });
    expect(cursors.get('completed')).toBeDefined();
    expect(
      (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }))
        .status,
    ).toBe('PENDING');
    expect(await service.deleteCompletedWebhookBatch(retentionCutoff())).toEqual({
      removed: 1,
      scanned: 1 + baseline.length,
    });
    await expectRetainedBaseline(baseline);
    expect(cursors.get('completed')).toBeUndefined();
    expect(
      (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: data.command.id } }))
        .status,
    ).toBe('COMPLETED');
  });

  it('bounds Start expiry candidate and command probes over 36k rows with timestamp ties and status skew', async () => {
    const capture = jest.spyOn(prisma, '$queryRaw').mockResolvedValueOnce([]);
    const tiedAt = new Date(Math.max(Date.now(), migrationCutoff.getTime() + 1));
    let query: Prisma.Sql;
    try {
      expect(
        await expireUnclaimedGroupStarts(
          prisma as never,
          new Date(tiedAt.getTime() + 86_400_000),
          { id: 'tie-015000', createdAt: tiedAt },
          500,
        ),
      ).toBe(0);
      query = capture.mock.calls[0]![0] as Prisma.Sql;
    } finally {
      capture.mockRestore();
    }
    const client = await pool.connect();
    const schemaName = `start_expiry_plan_${randomUUID().replaceAll('-', '')}`;
    const schema = `"${schemaName}"`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
      await client.query(`
        CREATE TABLE webhook_events (
          id text PRIMARY KEY, semantic_key text, created_at timestamp(3),
          execution_deadline_at timestamp(3), status "WebhookStatus"
        );
        CREATE TABLE webhook_execution_claims (
          id text PRIMARY KEY, webhook_event_id text, kind text, enforced boolean,
          status "WebhookExecutionClaimStatus", execution_bot_id text,
          business_started_at timestamp(3), command_result jsonb, completed_at timestamp(3),
          lease_token text, lease_expires_at timestamp(3), prepared_at timestamp(3),
          created_at timestamp(3)
        );
        CREATE INDEX webhook_events_retention_completed_created_id_idx
          ON webhook_events (created_at, id)
          WHERE status IN ('PROCESSED'::"WebhookStatus", 'DUPLICATE'::"WebhookStatus");
        CREATE INDEX webhook_execution_claims_event_kind_idx
          ON webhook_execution_claims (webhook_event_id, kind);
      `);
      await client.query(
        `INSERT INTO webhook_events
         SELECT 'tie-' || lpad(value::text, 6, '0'), 'semantic-' || value,
           $1::timestamp, $1::timestamp - interval '1 hour',
           CASE WHEN value <= 20000 THEN 'PROCESSED'::"WebhookStatus"
             WHEN value <= 30000 THEN 'DUPLICATE'::"WebhookStatus"
             WHEN value <= 33000 THEN 'RECEIVED'::"WebhookStatus"
             ELSE 'FAILED'::"WebhookStatus" END
         FROM generate_series(1, 36000) value`,
        [tiedAt],
      );
      await client.query(
        `INSERT INTO webhook_execution_claims
         SELECT 'claim-' || value, 'outside-window-' || value, 'COMMAND', true,
           'PENDING'::"WebhookExecutionClaimStatus", NULL, NULL, NULL, NULL, NULL, NULL,
           $1::timestamp, $1::timestamp FROM generate_series(1, 6000) value`,
        [tiedAt],
      );
      await client.query('ANALYZE webhook_events');
      await client.query('ANALYZE webhook_execution_claims');
      const explained = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${query!.text}`, [
        ...query!.values,
      ]);
      const nodes: Array<Record<string, unknown>> = [];
      const collect = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(collect);
          return;
        }
        const node = value as Record<string, unknown>;
        if (typeof node['Node Type'] === 'string') nodes.push(node);
        Object.values(node).forEach(collect);
      };
      collect(explained.rows[0]['QUERY PLAN']);
      const window = nodes.find((node) => node['Subplan Name'] === 'CTE candidate_ids');
      expect(window?.['Actual Rows']).toBe(500);
      const eventScans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
      expect(eventScans).toHaveLength(1);
      expect(eventScans[0]).toMatchObject({
        'Index Name': 'webhook_events_retention_completed_created_id_idx',
        'Actual Rows': 500,
        'Actual Loops': 1,
      });
      expect(Number(eventScans[0]!['Rows Removed by Filter'] ?? 0)).toBe(0);
      const claimScans = nodes.filter(
        (node) => node['Relation Name'] === 'webhook_execution_claims',
      );
      expect(claimScans).toHaveLength(1);
      expect(claimScans[0]!['Index Name']).toBe('webhook_execution_claims_event_kind_idx');
      expect(Number(claimScans[0]!['Actual Loops'])).toBeLessThanOrEqual(500);
      expect(Number(claimScans[0]!['Actual Rows'])).toBeLessThanOrEqual(1);
      expect(
        nodes.some(
          (node) =>
            node['Node Type'] === 'Seq Scan' &&
            ['webhook_events', 'webhook_execution_claims'].includes(String(node['Relation Name'])),
        ),
      ).toBe(false);
    } finally {
      try {
        await client.query('SET search_path TO public');
        await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        client.release();
      }
    }
  });

  it.each(['unchanged', 'command lease lost', 'recovery source changed'] as const)(
    'rechecks GROUP notice authority after transport admission: %s',
    async (change) => {
      const sourceAt = new Date(Date.now() - 60_000);
      const data = await fixture(1, sourceAt);
      await prisma.webhookEvent.update({
        where: { id: receiptIds[receiptIds.length - 1]! },
        data: { executionDeadlineAt: new Date(sourceAt.getTime() + 300_000) },
      });
      const permit = await claim(data.updates[0]!);
      const authority = new GroupCommandAuthorityService(prisma as never);
      const transport = jest.fn();
      const beforeMutation = jest.fn(async () => {
        const source = await prisma.webhookEvent.findUniqueOrThrow({
          where: { id: permit.webhookEventId },
        });
        if (source.status !== 'QUEUED' || source.errorMessage !== null)
          throw new Error('Command recovery source changed');
      });
      const checkpoint = jest.fn(async () => {
        if (change === 'command lease lost')
          await peerPrisma.webhookExecutionClaim.update({
            where: { id: permit.claimId },
            data: { leaseToken: null, leaseExpiresAt: null },
          });
        if (change === 'recovery source changed')
          await peerPrisma.webhookEvent.update({
            where: { id: permit.webhookEventId },
            data: { errorMessage: 'fixture: recovery source changed during admission' },
          });
      });
      const sendMessage = jest.fn<
        ReturnType<MaxClientService['sendMessage']>,
        Parameters<MaxClientService['sendMessage']>
      >(async (_chatId, _text, _options, dispatchOptions) => {
        await dispatchOptions?.beforeImmediateSendMutation?.(checkpoint);
        transport();
      });
      const delivery = deliverGroupCommandNotice({
        max: { sendMessage } as unknown as MaxClientService,
        authority,
        permit,
        settings: { deleteBotMessagesEnabled: false, deleteBotMessagesDelayMinutes: 1 },
        text: 'Команда выполнена',
        beforeMutation,
      });
      if (change === 'unchanged') {
        await expect(delivery).resolves.toBeUndefined();
        expect(transport).toHaveBeenCalledTimes(1);
        expect(beforeMutation).toHaveBeenCalledTimes(1);
      } else {
        await expect(delivery).rejects.toMatchObject({
          cause: expect.objectContaining({
            message:
              change === 'command lease lost'
                ? 'Group command lease lost'
                : 'Command recovery source changed',
          }),
        });
        expect(transport).not.toHaveBeenCalled();
      }
      expect(checkpoint).toHaveBeenCalledTimes(1);
    },
  );

  it('does not revive a pending OPEN confirmation after a whole intervening night interval', async () => {
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const original = await fixture(1, new Date(now.getTime() - 4 * 60_000));
    await prisma.chatSettings.update({
      where: { chatId: original.chatId },
      data: {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: (minutes + 1438) % 1440,
        nightModeEndTimeMinutes: (minutes + 1439) % 1440,
        nightModeTimezone: 'UTC',
      },
    });
    const permit = await claim(original.updates[0]!);
    await admin().applyManualOpenChatCommand(original.chatId, actor, 'group_command', permit);
    // The original and present instants are both open, separated by a full scheduled restriction.
    await prisma.webhookExecutionClaim.update({
      where: { id: permit.claimId },
      data: { preparedAt: permit.sourceAt },
    });
    expect(
      await new GroupCommandAuthorityService(prisma as never).closureNoticeDeadline(permit),
    ).toBeLessThanOrEqual(Date.now());
  });

  it.each(['SILENCE', 'OPEN_CHAT'] as const)(
    'suppresses the original %s confirmation when another command commits during transport wait',
    async (action) => {
      const original = await fixture(1, new Date(Date.now() - 120_000));
      await prisma.webhookEvent.update({
        where: { id: receiptIds[receiptIds.length - 1]! },
        data: { executionDeadlineAt: new Date(Date.now() + 120_000) },
      });
      const first = await claim(original.updates[0]!);
      const later = await fixture(1, new Date(Date.now() - 60_000), original.chatId);
      const next = await claim(later.updates[0]!, peerPrisma);
      const apply = (permit: GroupCommandPermit, open: boolean, client: PrismaClient) =>
        open
          ? admin(client).applyManualOpenChatCommand(
              original.chatId,
              actor,
              'group_command',
              permit,
            )
          : admin(client).applyManualChatSilenceCommand(
              original.chatId,
              actor,
              { durationHours: 2 },
              'group_command',
              permit,
            );
      await apply(first, action === 'OPEN_CHAT', prisma);
      const authority = new GroupCommandAuthorityService(prisma as never);
      expect(await authority.closureNoticeDeadline(first)).toBeGreaterThan(Date.now());
      const transport = jest.fn();
      const sendMessage: MaxClientService['sendMessage'] = async (
        _chat,
        _text,
        _options,
        dispatch,
      ) => {
        await dispatch?.beforeImmediateSendMutation?.(async () => {
          await apply(next, action === 'SILENCE', peerPrisma);
        });
        transport();
      };
      await expect(
        deliverGroupCommandNotice({
          max: { sendMessage } as MaxClientService,
          authority,
          permit: first,
          settings: { deleteBotMessagesEnabled: false, deleteBotMessagesDelayMinutes: 1 },
        }),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: 'Saved group closure notice is no longer current',
        }),
      });
      expect(transport).not.toHaveBeenCalled();
      expect(
        (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: first.claimId } }))
          .commandResult,
      ).toEqual(first.result);
    },
  );

  it.each([1, 3, 4, 6, 9, 12])(
    'applies one SILENCE and notice result across %i mirrored bot receipts',
    async (botCount) => {
      const sourceAt = new Date(Date.now() - 60_000);
      const data = await fixture(botCount, sourceAt);
      const services = [
        new GroupCommandAuthorityService(prisma as never),
        new GroupCommandAuthorityService(peerPrisma as never),
      ];
      const permits = await Promise.all(
        data.updates.map((update, index) => services[index % 2]!.claim(update, update.botId!)),
      );
      const owned = permits.filter((permit): permit is GroupCommandPermit => permit !== null);
      expect(owned).toHaveLength(1);
      const permit = owned[0]!;
      await admin().applyManualChatSilenceCommand(
        data.chatId,
        actor,
        { durationHours: 12 },
        'group_command',
        permit,
      );
      expect(
        await prisma.auditLog.count({
          where: { chatId: data.chatId, action: 'MANUAL_CHAT_SILENCE' },
        }),
      ).toBe(1);
      const settings = await prisma.chatSettings.findUniqueOrThrow({
        where: { chatId: data.chatId },
      });
      expect(settings.nightModeForceCloseUntil).toBe(
        new Date(sourceAt.getTime() + 12 * 3_600_000).toISOString(),
      );
      const stored = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: permit.claimId },
      });
      expect(stored.status).toBe('READY');
      expect(stored.commandResult).toEqual(
        expect.objectContaining({ action: 'SILENCE', applied: true }),
      );
      await services[0]!.release(permit);
      const resumed = await services[1]!.claim(
        data.updates[data.updates.length - 1]!,
        'other-observer',
      );
      expect(resumed).toEqual(
        expect.objectContaining({
          executionBotId: permit.executionBotId,
          sourceAt,
          result: stored.commandResult,
        }),
      );
      await services[1]!.complete(resumed!);
      expect(await services[0]!.claim(data.updates[0]!, 'another-bot')).toBeNull();
      expect(
        await prisma.auditLog.count({
          where: { chatId: data.chatId, action: 'MANUAL_CHAT_SILENCE' },
        }),
      ).toBe(1);
    },
  );

  it('rolls back settings, source watermark, audit and result together when audit fails', async () => {
    const data = await fixture(4);
    const permit = await claim(data.updates[0]!);
    const failedClient = new Proxy(prisma, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            callback(
              new Proxy(tx, {
                get(client, field, nestedReceiver) {
                  if (field === 'auditLog')
                    return {
                      create: async () => {
                        throw new Error('audit unavailable');
                      },
                    };
                  return Reflect.get(client, field, nestedReceiver);
                },
              }),
            ),
          );
      },
    });
    await expect(
      admin(failedClient).applyManualChatSilenceCommand(
        data.chatId,
        actor,
        { durationHours: 12 },
        'group_command',
        permit,
      ),
    ).rejects.toThrow('audit unavailable');
    expect(
      (await prisma.chatSettings.findUniqueOrThrow({ where: { chatId: data.chatId } }))
        .nightModeForceCloseEnabled,
    ).toBe(false);
    expect(
      (await prisma.chat.findUniqueOrThrow({ where: { id: data.chatId } })).chatControlOrderAt,
    ).toBeNull();
    expect(await prisma.auditLog.count({ where: { chatId: data.chatId } })).toBe(0);
    const stored = await prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: permit.claimId },
    });
    expect(stored.status).toBe('PENDING');
    expect(stored.commandResult).toBeNull();
  });

  it.each(['queued', 'ignored'] as const)(
    'purges a completed %s command body while an unverified NULL result remains pinned',
    async (outcome) => {
      const old = new Date('2020-01-01T00:00:00Z');
      const settled = await fixture(1, old, undefined, old);
      const unverified = await fixture(1, old, undefined, old);
      const authority = new GroupCommandAuthorityService(prisma as never);
      const settledPermits: GroupCommandPermit[] = [];
      const enqueue = jest.fn().mockResolvedValue(true);
      const handled = await runGroupCommandWithAuthority(
        authority,
        settled.updates[0]!,
        settled.updates[0]!.botId!,
        {
          resume: async () => {
            throw new Error('Unexpected saved-command replay');
          },
          execute: async (permit) => {
            settledPermits.push(permit);
            if (outcome === 'ignored') return false;
            await enqueue();
            await authority.prepareQueuedResult(permit, 'BAN');
            return true;
          },
        },
      );
      expect(handled).toBe(outcome === 'queued');
      expect(enqueue).toHaveBeenCalledTimes(outcome === 'queued' ? 1 : 0);
      const settledPermit = settledPermits[0]!;
      const settledClaimId = settledPermit.claimId;
      const unverifiedPermit = await claim(unverified.updates[0]!);
      // FLAG: Preserve the historical COMPLETED/NULL case as missing durable proof.
      await authority.complete(unverifiedPermit);
      await prisma.webhookEvent.updateMany({
        where: { id: { in: [settledPermit.webhookEventId, unverifiedPermit.webhookEventId] } },
        data: { status: 'PROCESSED', processedAt: old },
      });
      const service = Object.create(WebhookOutboxService.prototype) as {
        deleteCompletedWebhookBatch(cutoff: Date): Promise<{ removed: number; scanned: number }>;
      };
      Object.assign(service, { prisma, webhookRetentionCursors: new Map() });
      expect(await service.deleteCompletedWebhookBatch(new Date('2021-01-01T00:00:00Z'))).toEqual({
        removed: 1,
        scanned: 2,
      });
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: settledClaimId } }),
      ).toMatchObject({
        status: 'COMPLETED',
        webhookEventId: null,
        commandResult:
          outcome === 'queued'
            ? { action: 'BAN', outcome: 'QUEUED', applied: false, noticeText: null }
            : { action: 'IGNORED', applied: false, noticeText: null },
      });
      expect(
        await prisma.webhookEvent.findUnique({ where: { id: unverifiedPermit.webhookEventId } }),
      ).not.toBeNull();
      await prisma.webhookExecutionClaim.deleteMany({
        where: { id: { in: [settledClaimId, unverifiedPermit.claimId] } },
      });
    },
  );

  it('keeps API CHAT_CONTROL and RULES ordering independent and rejects delayed commands', async () => {
    const data = await fixture(3);
    await prisma.$transaction(async (tx) => {
      await advanceChatMutationOrder(tx, data.chatId, 'CHAT_CONTROL');
      await tx.chatSettings.update({
        where: { chatId: data.chatId },
        data: { nightModeForceCloseEnabled: false },
      });
    });
    const silence = await claim(data.updates[0]!);
    const silenced = await admin().applyManualChatSilenceCommand(
      data.chatId,
      actor,
      { durationHours: 12 },
      'group_command',
      silence,
    );
    expect(silenced.skipped).toBe(true);
    expect(silence.result?.noticeText).toBeNull();
    const rulesData = await fixture(6, silence.sourceAt, data.chatId);
    const rules = await claim(rulesData.updates[0]!);
    const adopted = await admin().adoptChatRulesFromMessage(
      data.chatId,
      actor,
      {
        sourceMessageId: 'rules-source-1',
        sourceMessageUrl: 'https://max.ru/rules/1',
        text: 'Правила',
      },
      'group_command',
      rules,
    );
    expect(adopted.commandSkipped).toBeUndefined();
    await prisma.$transaction(async (tx) => {
      await advanceChatMutationOrder(tx, data.chatId, 'RULES');
      await tx.chatRules.update({
        where: { chatId: data.chatId },
        data: { text: 'Новые правила' },
      });
    });
    const staleData = await fixture(12, silence.sourceAt, data.chatId);
    const stale = await claim(staleData.updates[0]!);
    const staleResult = await admin().adoptChatRulesFromMessage(
      data.chatId,
      actor,
      {
        sourceMessageId: 'rules-old',
        sourceMessageUrl: 'https://max.ru/rules/old',
        text: 'Старые правила',
      },
      'group_command',
      stale,
    );
    expect(staleResult.commandSkipped).toBe(true);
    expect(
      (await prisma.chatRules.findUniqueOrThrow({ where: { chatId: data.chatId } })).text,
    ).toBe('Новые правила');
    expect(
      await prisma.auditLog.count({
        where: { chatId: data.chatId, action: 'ADOPT_CHAT_RULES_MESSAGE' },
      }),
    ).toBe(1);
  });

  it('does not let a delayed OPEN undo a confirmed bulk close', async () => {
    const source = await fixture(1);
    const target = await fixture(1);
    const closing = await prisma.chatSettings.update({
      where: { chatId: source.chatId },
      data: { nightModeForceCloseEnabled: true, nightModeForceCloseForever: true },
    });
    const confirmedRevision = closing.updatedAt.toISOString();
    await expect(
      applySettingsToAllChats({
        prisma: prisma as PrismaService,
        chatContextCache: { invalidate: async () => {} },
        sourceChatId: source.chatId,
        actorUserId: actor.userId,
        body: chatSettingsSchema.parse(closing),
        source: 'miniapp',
        targetOrSettingKeys: { mode: 'selectedChats', favoriteTypes: [], chatIds: [target.chatId] },
        settingKeys: ['nightModeForceCloseEnabled', 'nightModeForceCloseForever'],
        confirmedTargetChatIds: [target.chatId],
        expectedSourceSettingsRevision: confirmedRevision,
        normalizeSettings: (settings) => settings,
        resolveTargetChats: async () => [
          chatSummarySchema.parse({
            id: target.chatId,
            title: 'Target',
            createdAt: confirmedRevision,
          }),
        ],
        resolveBotAssignmentData: async () => ({}),
        assertRequiredSubscriptionSettings: async () => {},
        assertBotCapabilities: async () => {},
        recordConcurrentWriteConflict: jest.fn(),
        onPartialApplied: async () => {},
        isRequiredSubscriptionCurrentlyActive: () => false,
        scheduleReadinessRefresh: jest.fn(),
      }),
    ).resolves.toMatchObject({ appliedChatIds: [target.chatId] });
    const open = await claim(target.updates[0]!);
    await expect(
      admin().applyManualOpenChatCommand(target.chatId, actor, 'group_command', open),
    ).resolves.toMatchObject({ skipped: true });
    await expect(
      prisma.chatSettings.findUniqueOrThrow({ where: { chatId: target.chatId } }),
    ).resolves.toMatchObject({
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
    });
  });

  it.each(['disable/enable', 'schedule/restore', 'timezone/restore'])(
    'never revives old night deletes after API %s, and preserves RULES ordering',
    async (change) => {
      const data = await fixture(4);
      const sourceAt = new Date(Date.now() - 60_000);
      const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      const start = (minute + 1380) % 1440;
      const end = (minute + 60) % 1440;
      await prisma.chatSettings.update({
        where: { chatId: data.chatId },
        data: {
          nightModeEnabled: true,
          nightModeStartTimeMinutes: start,
          nightModeEndTimeMinutes: end,
          nightModeTimezone: 'UTC',
        },
      });
      const remoteRow = {
        sender: { user_id: 'ordinary-night-user' },
        recipient: { chat_id: data.chatId, chat_type: 'chat' },
        timestamp: sourceAt.getTime(),
        body: { mid: data.messageId, text: 'night message' },
      };
      const guard = new ClosedChatDeleteGuardService(
        prisma as never,
        {
          getChatMemberAccess: async () => ({
            userId: 'ordinary-night-user',
            isAdmin: false,
            isOwner: false,
          }),
          getExactMessageRow: async () => remoteRow,
        } as never,
        { isKnownBotUserId: () => false } as never,
        { consumeForMessage: async () => 'not_granted' } as never,
        new ConfigService(),
      );
      const authorization = {
        chatId: data.chatId,
        messageId: data.messageId,
        subjectUserId: 'ordinary-night-user',
        sourceMessageAt: sourceAt,
        botId: 'bot-4',
        reasons: [
          {
            ruleCode: 'NIGHT_MODE_DELETE',
            reasonKey: 'night',
            metadata: {
              nightModeTimezone: 'UTC',
              nightModeStartTime: formatMinutesAsTime(start),
              nightModeEndTime: formatMinutesAsTime(end),
            },
          },
        ],
      };
      await expect(guard.authorize(authorization)).resolves.toMatchObject({
        reasonKeys: ['night'],
      });
      const original = await prisma.chat.findUniqueOrThrow({ where: { id: data.chatId } });
      const bodies =
        change === 'disable/enable'
          ? [{ nightModeEnabled: false }, { nightModeEnabled: true }]
          : change === 'schedule/restore'
            ? [
                { nightModeStartTimeMinutes: (start + 1) % 1440 },
                { nightModeStartTimeMinutes: start },
              ]
            : [{ nightModeTimezone: 'Europe/Moscow' }, { nightModeTimezone: 'UTC' }];
      for (const body of bodies) {
        const snapshot: Record<string, unknown> = chatSettingsSchema.parse(
          await prisma.chatSettings.findUniqueOrThrow({ where: { chatId: data.chatId } }),
        );
        // This request edits the night section, not the independent rules attachment setting.
        delete snapshot.rulesAttachViolationsEnabled;
        await saveChatSettings({
          prisma: prisma as never,
          chatContextCache: { invalidate: async () => undefined },
          chatId: data.chatId,
          actorUserId: actor.userId,
          body: {
            ...snapshot,
            ...body,
          },
          source: 'miniapp',
          resolveBotAssignmentData: () => ({}),
          assertRequiredSubscriptionSettings: async () => undefined,
          assertBotCapabilities: async () => undefined,
          refreshExecutionReadiness: async () => undefined,
        });
      }
      const current = await prisma.chat.findUniqueOrThrow({ where: { id: data.chatId } });
      expect(current.chatControlOrderAt!.getTime()).toBeGreaterThan(sourceAt.getTime());
      expect(current.rulesOrderAt).toEqual(original.rulesOrderAt);
      await expect(guard.authorize(authorization)).rejects.toMatchObject({
        code: 'closed_chat_delete_no_longer_authorized',
      });
      // FLAG: The fence excludes old source events, not valid messages from the new session.
      const freshSource = new Date(Math.max(Date.now(), current.chatControlOrderAt!.getTime() + 1));
      remoteRow.timestamp = freshSource.getTime();
      await expect(
        guard.authorize({ ...authorization, sourceMessageAt: freshSource }),
      ).resolves.toMatchObject({
        reasonKeys: ['night'],
      });
      expect(
        await prisma.auditLog.count({ where: { chatId: data.chatId, action: 'UPDATE_SETTINGS' } }),
      ).toBe(2);
    },
  );

  it.each(['disabled', 'active', 'daytime', 'all-day'] as const)(
    'persists a truthful OPEN notice without changing the %s night schedule',
    async (schedule) => {
      const data = await fixture(3);
      const now = new Date();
      const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      const nightSettings = {
        nightModeEnabled: schedule !== 'disabled',
        nightModeStartTimeMinutes:
          schedule === 'daytime' ? (currentMinutes + 60) % 1440 : (currentMinutes + 1430) % 1440,
        nightModeEndTimeMinutes:
          schedule === 'all-day' ? (currentMinutes + 1430) % 1440 : (currentMinutes + 120) % 1440,
        nightModeTimezone: 'UTC',
        nightModeBotMessageEnabled: true,
        nightModeOpenMessageEnabled: true,
      };
      await prisma.chatSettings.update({
        where: { chatId: data.chatId },
        data: {
          ...nightSettings,
          nightModeForceCloseEnabled: true,
          nightModeForceCloseForever: true,
        },
      });
      const permit = await claim(data.updates[0]!);
      const result = await admin().applyManualOpenChatCommand(
        data.chatId,
        actor,
        'group_command',
        permit,
      );
      const message =
        schedule === 'active' || schedule === 'all-day'
          ? 'Ручное закрытие снято. Чат остаётся закрыт по ночному расписанию.'
          : 'Чат открыт. Для сообщений снова действуют обычные правила.';
      expect(result).toEqual({ ok: true, message });
      expect(
        await prisma.chatSettings.findUniqueOrThrow({ where: { chatId: data.chatId } }),
      ).toMatchObject({
        ...nightSettings,
        nightModeForceCloseEnabled: false,
        nightModeForceCloseForever: false,
        nightModeForceCloseUntil: '',
      });
      const commandResult = { action: 'OPEN_CHAT', applied: true, noticeText: message };
      expect(permit.result).toEqual(commandResult);
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: permit.claimId } }),
      ).toMatchObject({ status: 'READY', commandResult });
      expect(
        await prisma.auditLog.findFirstOrThrow({
          where: { chatId: data.chatId, action: 'MANUAL_CHAT_OPEN' },
        }),
      ).toMatchObject({ payload: { result: commandResult } });
    },
  );

  it('keeps a newer OPEN result when older SILENCE workers acquire the parent lock later', async () => {
    const oldData = await fixture(9, new Date(Date.now() - 120_000));
    const newData = await fixture(12, new Date(Date.now() - 60_000), oldData.chatId);
    const oldPermit = await claim(oldData.updates[0]!);
    const newPermit = await claim(newData.updates[0]!, peerPrisma);
    await admin(peerPrisma).applyManualOpenChatCommand(
      oldData.chatId,
      actor,
      'group_command',
      newPermit,
    );
    const late = await admin().applyManualChatSilenceCommand(
      oldData.chatId,
      actor,
      { durationHours: 48 },
      'group_command',
      oldPermit,
    );
    expect(late.skipped).toBe(true);
    expect(
      (await prisma.chatSettings.findUniqueOrThrow({ where: { chatId: oldData.chatId } }))
        .nightModeForceCloseEnabled,
    ).toBe(false);
    expect(await prisma.auditLog.count({ where: { chatId: oldData.chatId } })).toBe(1);
  });

  it('does not commit settings or result after command lease authority expires', async () => {
    const data = await fixture(6);
    const permit = await claim(data.updates[0]!);
    await prisma.webhookExecutionClaim.update({
      where: { id: permit.claimId },
      data: { leaseExpiresAt: new Date(0) },
    });
    await expect(
      admin().applyManualOpenChatCommand(data.chatId, actor, 'group_command', permit),
    ).rejects.toThrow('Group command lease lost');
    expect(
      (await prisma.chat.findUniqueOrThrow({ where: { id: data.chatId } })).chatControlOrderAt,
    ).toBeNull();
    expect(await prisma.auditLog.count({ where: { chatId: data.chatId } })).toBe(0);
  });

  it.each([3, 6, 12])(
    'holds unknown historical Start and recovers an old confirmed send with %i bots',
    async (botCount) => {
      const cutoff = (
        await prisma.$queryRaw<Array<{ at: Date }>>`
      SELECT finished_at AS at FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL LIMIT 1
    `
      )[0]?.at;
      expect(cutoff).toBeInstanceOf(Date);
      const acceptedAt = new Date(cutoff!.getTime() - 1_000);
      const data = await fixture(botCount, acceptedAt, undefined, acceptedAt);
      const authority = new GroupCommandAuthorityService(prisma as never);
      await authority.observeStart(data.updates[0]!);
      const permit = await claim(data.updates[botCount - 1]!);
      const bots = data.updates.map((update) => update.botId!);
      expect(await authority.inspectLegacyStart(permit, bots)).toBe('hold');
      const entry = await prisma.maxActionLedgerEntry.create({
        data: {
          jobId: buildLegacyStartLedgerKey(
            data.chatId,
            String(data.updates[0]!.updateId),
            bots[0]!,
          ),
          chatId: data.chatId,
          botId: bots[0],
          actionType: 'SEND_MESSAGE',
          status: 'SUCCEEDED',
          remoteMessageId: 'legacy-confirmation',
          terminal: true,
        },
      });
      ledgerIds.push(entry.id);
      expect(await authority.inspectLegacyStart(permit, bots)).toBe('recovered');
      await prisma.maxActionLedgerEntry.update({
        where: { id: entry.id },
        data: {
          status: 'AMBIGUOUS',
          ambiguous: true,
          remoteMessageId: null,
          dispatchToken: randomUUID(),
        },
      });
      expect(await authority.inspectLegacyStart(permit, bots)).toBe('hold');
    },
  );

  it('keeps a new weak-first Start fresh and bounds future source timestamps to receipt time', async () => {
    const acceptedAt = new Date();
    const data = await fixture(
      4,
      new Date(acceptedAt.getTime() + 86_400_000),
      undefined,
      acceptedAt,
    );
    const authority = new GroupCommandAuthorityService(prisma as never);
    await authority.observeStart(data.updates[0]!);
    await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: `message:message_created:${data.chatId}:${data.messageId}`,
        webhookEventId: receiptIds[0]!,
        executionBotId: 'bot-1',
        status: 'READY',
        preparedAt: new Date(),
      },
    });
    const permit = await claim(data.updates[3]!);
    expect(permit.executionBotId).toBe('bot-4');
    expect(permit.sourceAt).toEqual(acceptedAt);
    expect(
      await authority.inspectLegacyStart(
        permit,
        data.updates.map((update) => update.botId!),
      ),
    ).toBe('fresh');
  });
});
