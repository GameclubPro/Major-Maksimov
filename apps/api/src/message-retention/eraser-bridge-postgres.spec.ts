import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { SafetyDeskRetentionService } from '../admin/safety-desk-retention.service';
import { MessageRetentionStore } from './message-retention-store.service';
import { retentionLegacyDiagnosticsQuery } from '../admin/safety-desk-retention-queries';
import { EraserControlService } from './eraser-control.service';
import { retentionBindingQuery } from './message-retention-binding';
import { retireTransferredChat, retirementCandidatePageQuery } from './eraser-legacy-retirement';
import { protectionEvidencePage } from './eraser-protection-provenance';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

native('independent Lastik bridge with PostgreSQL', () => {
  let db: PrismaClient;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('A disposable local race_test PostgreSQL is required');
    db = createPrismaClient(databaseUrl, { max: 4 });
    await db.$connect();
  });
  afterAll(async () => db?.$disconnect());
  afterEach(() => jest.restoreAllMocks());

  async function isolated(
    run: (
      tx: Prisma.TransactionClient,
      service: EraserControlService,
      chatId: string,
    ) => Promise<void>,
    enabled = true,
  ) {
    const rollback = new Error('rollback Lastik fixture');
    try {
      await db.$transaction(
        async (tx) => {
          const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 13)}`)}`;
          await tx.chat.create({ data: { id: chatId, title: 'Lastik isolated fixture' } });
          await tx.messageRetentionPolicy.create({
            data: { chatId, enabled: true, hours: 24, activationId: randomUUID(), quotaShard: 0 },
          });
          let nested = 0;
          const scoped = {
            $transaction: async <T>(work: (client: Prisma.TransactionClient) => Promise<T>) => {
              const name = `eraser_fixture_${++nested}`;
              await tx.$executeRaw(Prisma.raw(`SAVEPOINT ${name}`));
              try {
                const result = await work(tx);
                await tx.$executeRaw(Prisma.raw(`RELEASE SAVEPOINT ${name}`));
                return result;
              } catch (error) {
                await tx.$executeRaw(Prisma.raw(`ROLLBACK TO SAVEPOINT ${name}`));
                await tx.$executeRaw(Prisma.raw(`RELEASE SAVEPOINT ${name}`));
                throw error;
              }
            },
            $queryRaw: tx.$queryRaw.bind(tx),
            $executeRaw: tx.$executeRaw.bind(tx),
            messageRetentionPolicy: tx.messageRetentionPolicy,
            chatRules: tx.chatRules,
            managedGiveaway: tx.managedGiveaway,
            auditLog: tx.auditLog,
          };
          const service = new EraserControlService(
            scoped as unknown as PrismaService,
            new ConfigService({
              ERASER_ENABLED: enabled,
              ERASER_CONTROL_URL: 'http://eraser:3000',
              ERASER_CONTROL_TOKEN: 'a'.repeat(64),
            }),
          );
          await run(tx, service, chatId);
          throw rollback;
        },
        { timeout: 30_000, maxWait: 5_000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  function state(operationId: string, enabled = true) {
    return {
      enabled,
      hours: 168,
      revision: 1,
      status: enabled ? 'running' : 'off',
      enabledAt: null,
      captureAfter: null,
      pausedAt: null,
      pendingCount: 0,
      deletedCount: 0,
      skippedCount: 0,
      oldestDueAt: null,
      lastOperationId: operationId,
    };
  }

  it('reads a saved Lastik owner with execution disabled without bootstrap or legacy fallback', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id,legacy_hours) VALUES(${chatId},24)`;
      const before = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            ...state(randomUUID()),
            initialized: true,
            hours: 168,
            connectionRequest: { status: 'pending', expiresAt: '2026-11-01T00:00:00.000Z' },
          }),
          { status: 200 },
        ),
      );
      await expect(service.read(chatId)).resolves.toMatchObject({
        hours: 168,
        connectionRequest: { status: 'pending' },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/policy$/),
        expect.objectContaining({ method: 'GET' }),
      );
      expect(await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).toEqual(
        before,
      );
    }, false));

  it('initialized polling performs one read and never repeats bootstrap', async () =>
    isolated(async (_tx, service, chatId) => {
      const fetch = jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              ...state(randomUUID()),
              initialized: true,
              hours: 168,
            }),
            { status: 200 },
          ),
      );
      await service.read(chatId);
      await service.read(chatId);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    }));

  it('execution-disabled control refuses before storing an operation or taking ownership', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      const before = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      await expect(
        service.update(chatId, 'admin', {
          enabled: true,
          hours: 168,
          expectedRevision: 0,
          operationId,
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        await tx.$queryRaw`SELECT id FROM eraser_control_operations WHERE id=${operationId}`,
      ).toEqual([]);
      expect(
        await tx.$queryRaw`SELECT chat_id FROM eraser_chat_bindings WHERE chat_id=${chatId}`,
      ).toEqual([]);
      expect(await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).toEqual(
        before,
      );
    }, false));

  it('bootstraps only an explicit uninitialized source and reads back the imported legacy policy', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.messageRetentionPolicy.update({ where: { chatId }, data: { hours: 48 } });
      const fetch = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...state(randomUUID()), initialized: false }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ...state(randomUUID()), hours: 48, initialized: true }), {
            status: 200,
          }),
        );
      await expect(service.read(chatId)).resolves.toMatchObject({ hours: 48 });
      expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PUT', 'GET']);
      expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ hours: 48 });
    }));

  it('keeps a persisted missing source unavailable without reinitializing it', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id,legacy_hours) VALUES(${chatId},24)`;
      const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ ...state(randomUUID()), initialized: false }), {
          status: 200,
        }),
      );
      await expect(service.read(chatId)).rejects.toMatchObject({ status: 503 });
      expect(fetch).toHaveBeenCalledTimes(1);
    }));

  it('requires successful initialized readback after first bootstrap', async () =>
    isolated(async (_tx, service, chatId) => {
      const fetch = jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          new Response(JSON.stringify({ ...state(randomUUID()), initialized: false }), {
            status: 200,
          }),
      );
      await expect(service.read(chatId)).rejects.toMatchObject({ status: 503 });
      expect(fetch).toHaveBeenCalledTimes(3);
    }));

  it('allows only protection delivery to existing owners when execution is disabled', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id,legacy_hours) VALUES(${chatId},24)`;
      const fetch = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async () => new Response('{}', { status: 200 }));
      await service.request(`/chats/${chatId}/protection`, 'PUT', {}, 'protection');
      await service.request('/holds', 'PUT', {}, 'protection');
      await expect(
        service.request(`/chats/${chatId}1/protection`, 'PUT', {}, 'protection'),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        service.request(`/chats/${chatId}/policy`, 'PUT', {}, 'protection'),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        service.request(`/chats/${chatId}/retry`, 'POST', {}, 'protection'),
      ).rejects.toMatchObject({ status: 503 });
      expect(fetch).toHaveBeenCalledTimes(2);
    }, false));

  it('reads completed operation receipts but leaves pending operations untouched with execution disabled', async () =>
    isolated(async (tx, service, chatId) => {
      const saved = state(randomUUID());
      const pendingId = randomUUID();
      await tx.$executeRaw`INSERT INTO eraser_control_operations(id,chat_id,actor_user_id,request,result) VALUES
        (${saved.lastOperationId},${chatId},'admin','{}'::jsonb,${JSON.stringify(saved)}::jsonb),
        (${pendingId},${chatId},'admin','{}'::jsonb,NULL)`;
      const fetch = jest.spyOn(global, 'fetch');
      await expect(service.resume(chatId, 'admin', saved.lastOperationId)).resolves.toMatchObject(
        saved,
      );
      await expect(service.resume(chatId, 'admin', pendingId)).rejects.toMatchObject({
        status: 503,
      });
      expect(
        await tx.$queryRaw`SELECT chat_id FROM eraser_chat_bindings WHERE chat_id=${chatId}`,
      ).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    }, false));

  it('pages all 201 legacy review rows without gaps and rejects a changed policy cursor', async () =>
    isolated(async (tx, eraser, chatId) => {
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status,outcome_code)
        SELECT ${chatId},'review-'||LPAD(id::text,4,'0'),'5','bot',CURRENT_TIMESTAMP-INTERVAL '3 days',${policy.activationId},'skipped',
          CASE WHEN id%2=0 THEN 'reconciliation' ELSE 'terminal_review' END FROM generate_series(1,201) id`;
      const store = new MessageRetentionStore(
        tx as unknown as PrismaService,
        new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
      );
      const desk = new SafetyDeskRetentionService(
        tx as unknown as PrismaService,
        store,
        {} as never,
        eraser,
      );
      const request = jest.spyOn(eraser, 'request');
      const ids: string[] = [];
      let cursor: string | undefined;
      let first: string | undefined;
      do {
        const page = await desk.preview(chatId, cursor);
        expect(page.items.length).toBeLessThanOrEqual(20);
        expect(page.source).toBe('legacy');
        ids.push(...page.items.map((row) => row.messageId));
        cursor = page.nextAfter ?? undefined;
        first ??= cursor;
      } while (cursor);
      expect(request).not.toHaveBeenCalled();
      expect(ids).toHaveLength(201);
      expect(new Set(ids).size).toBe(201);
      expect(ids).toEqual([...ids].sort());
      const decoded = JSON.parse(Buffer.from(first!, 'base64url').toString('utf8'));
      for (const changed of [
        { source: 'eraser' },
        { chatId: '-123' },
        { activationId: 'changed' },
        { revision: policy.revision + 1 },
      ])
        await expect(
          desk.preview(
            chatId,
            Buffer.from(JSON.stringify({ ...decoded, ...changed })).toString('base64url'),
          ),
        ).rejects.toMatchObject({ status: 409 });
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: { revision: { increment: 1 } },
      });
      await expect(desk.preview(chatId, first)).rejects.toMatchObject({ status: 409 });
    }));

  it(
    'uses at most five real SQL statements for 50 mixed owners over the real Lastik HTTP boundary',
    async () =>
      isolated(async (tx, _eraser, chatId) => {
        const ids = Array.from(
          { length: 49 },
          (_, i) => `${chatId}${String(i + 1).padStart(2, '0')}`,
        );
        await tx.chat.createMany({
          data: ids.map((id) => ({ id, title: 'Mixed budget fixture' })),
        });
        const legacyIds = ids.slice(0, 24),
          ownedIds = ids.slice(24);
        await tx.messageRetentionPolicy.createMany({
          data: legacyIds.map((id) => ({ chatId: id, activationId: randomUUID(), quotaShard: 0 })),
        });
        await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id,legacy_hours) SELECT id,24 FROM chats WHERE id IN (${Prisma.join(ownedIds)})`;
        const child = fork(
          join(__dirname, '../../../eraser/test/support/runtime-native-fixture.mjs'),
          [],
          {
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: process.env,
          },
        );
        const exchange = (message: Record<string, unknown>) =>
          new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(
              () => done(new Error('Native HTTP fixture deadline exceeded')),
              20000,
            );
            const onMessage = (value: Record<string, unknown>) =>
              value.type === 'error'
                ? done(new Error('Native HTTP fixture failed'))
                : done(null, value);
            const onExit = () => done(new Error('Native HTTP fixture exited early'));
            const done = (error: Error | null, value?: Record<string, unknown>) => {
              clearTimeout(timer);
              child.off('message', onMessage);
              child.off('exit', onExit);
              if (error) reject(error);
              else resolve(value!);
            };
            child.once('message', onMessage);
            child.once('exit', onExit);
            child.send(message);
          });
        let errors = '';
        child.stderr?.on('data', (chunk) => {
          errors += String(chunk).slice(0, 2000);
        });
        try {
          const ready = await exchange({ type: 'start', chatIds: ownedIds });
          expect(ready.type).toBe('ready');
          const traced = { $queryRaw: jest.fn((query: Prisma.Sql) => tx.$queryRaw(query)) };
          const control = new EraserControlService(
            traced as unknown as PrismaService,
            new ConfigService({
              ERASER_ENABLED: false,
              ERASER_CONTROL_URL: ready.url,
              ERASER_CONTROL_TOKEN: 'a'.repeat(32),
            }),
          );
          const store = new MessageRetentionStore(
            traced as unknown as PrismaService,
            new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
          );
          const desk = new SafetyDeskRetentionService(
            traced as unknown as PrismaService,
            store,
            {} as never,
            control,
          );
          const page = await desk.runtime();
          const stats = await exchange({ type: 'stats' });
          expect(page.items).toHaveLength(50);
          expect(page.items.filter((row) => row.source === 'eraser')).toHaveLength(25);
          expect(page.items.filter((row) => row.source === 'legacy')).toHaveLength(25);
          expect(page.unavailableSources).toEqual([]);
          expect(page.nextAfter).toBeNull();
          expect(traced.$queryRaw).toHaveBeenCalledTimes(2);
          expect(stats.queries).toBe(2);
          expect(traced.$queryRaw.mock.calls.length + Number(stats.queries)).toBeLessThanOrEqual(5);
        } catch (error) {
          if (errors) process.stderr.write(errors);
          throw error;
        } finally {
          if (child.connected) {
            const exited = once(child, 'exit');
            await exchange({ type: 'stop' });
            await exited;
          } else if (child.exitCode === null) child.kill('SIGTERM');
        }
      }),
    30000,
  );

  it('pages mixed persisted owners with the flag off in two main-database queries', async () =>
    isolated(async (tx, eraser, chatId) => {
      const ownedId = `${chatId}7`;
      await tx.chat.create({ data: { id: ownedId, title: 'Independent owner' } });
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id,legacy_hours) VALUES(${ownedId},24)`;
      const request = jest.spyOn(eraser, 'request').mockResolvedValue({
        generatedAt: new Date().toISOString(),
        mode: 'on',
        nextAfter: null,
        quotas: [],
        items: [
          {
            ...state(randomUUID()),
            chatId: ownedId,
            chatTitle: 'Remote title',
            activationId: 'owned',
            nextRunAt: null,
            hasTerminalReview: false,
            hasUnresolvedReceipt: true,
            source: 'eraser',
            sourceStatus: 'available',
          },
        ],
      });
      const traced = {
        messageRetentionPolicy: tx.messageRetentionPolicy,
        messageRetentionQuota: tx.messageRetentionQuota,
        chat: tx.chat,
        $queryRaw: jest.fn((query: Prisma.Sql) => tx.$queryRaw(query)),
      };
      const store = new MessageRetentionStore(
        traced as unknown as PrismaService,
        new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
      );
      const desk = new SafetyDeskRetentionService(
        traced as unknown as PrismaService,
        store,
        {} as never,
        eraser,
      );
      const result = await desk.runtime();
      expect(result.items.filter((item) => [chatId, ownedId].includes(item.chatId))).toHaveLength(
        2,
      );
      expect(result).not.toHaveProperty('incomplete');
      expect(result.items.find((item) => item.chatId === ownedId)).toMatchObject({
        hours: 168,
        chatTitle: 'Independent owner',
        source: 'eraser',
      });
      expect(request).toHaveBeenCalledWith(`/runtime?chatIds=${encodeURIComponent(ownedId)}`);
      expect(traced.$queryRaw).toHaveBeenCalledTimes(2);
    }, false));

  it('keeps an unavailable persisted owner explicit without legacy values or invented counters', async () =>
    isolated(async (tx, eraser, chatId) => {
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id,legacy_hours) VALUES(${chatId},24)`;
      jest.spyOn(eraser, 'request').mockRejectedValue(new Error('private upstream error'));
      const store = new MessageRetentionStore(
        tx as unknown as PrismaService,
        new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
      );
      const desk = new SafetyDeskRetentionService(
        tx as unknown as PrismaService,
        store,
        {} as never,
        eraser,
      );
      const result = await desk.runtime();
      expect(result.items.some((item) => item.chatId === chatId)).toBe(false);
      expect(result.unavailableSources).toContainEqual({
        chatId,
        chatTitle: 'Lastik isolated fixture',
        source: 'eraser',
        reason: 'unavailable',
      });
      expect(result.incomplete).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private upstream');
    }, false));

  it('bounds legacy activation probes before deriving ages under retained-history skew', async () =>
    isolated(async (tx, _eraser, chatId) => {
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status)
        SELECT ${chatId},'retained-'||id,'5','bot',CURRENT_TIMESTAMP-INTERVAL '30 days','retired','pending' FROM generate_series(1,10000) id`;
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status)
        SELECT ${chatId},'current-'||id,'5','bot',CURRENT_TIMESTAMP-INTERVAL '3 days',${policy.activationId},'pending' FROM generate_series(1,201) id`;
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status,outcome_code)
        SELECT ${chatId},'outcome-'||outcome||'-'||id,'5','bot',CURRENT_TIMESTAMP-INTERVAL '30 days','retired','skipped',outcome
        FROM unnest(ARRAY['terminal_review','worker_error','waiting_access','reconciliation','deferred']) outcome CROSS JOIN generate_series(1,1000) id`;
      await tx.$executeRaw`ANALYZE message_retention_candidates`;
      const query = retentionLegacyDiagnosticsQuery([chatId]);
      const [result] =
        await tx.$queryRaw<
          Array<{ diagnostics: Array<{ incomplete: boolean; oldestSourceMs: number | null }> }>
        >(query);
      expect(result?.diagnostics[0]).toMatchObject({ incomplete: true, oldestSourceMs: null });
      type Plan = {
        ['Node Type']: string;
        ['Relation Name']?: string;
        ['Index Name']?: string;
        ['Actual Rows']?: number;
        ['Rows Removed by Filter']?: number;
        Plans?: Plan[];
      };
      const explained = await tx.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
        Prisma.sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,
      );
      const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
      const scans = nodes(explained[0]!['QUERY PLAN'][0]!.Plan).filter(
        (node) => node['Relation Name'] === 'message_retention_candidates',
      );
      expect(
        scans.some((node) => node['Index Name'] === 'message_retention_candidates_activation_idx'),
      ).toBe(true);
      expect(
        scans.every(
          (node) =>
            node['Node Type'] !== 'Seq Scan' &&
            (node['Actual Rows'] ?? 0) <= 201 &&
            (node['Rows Removed by Filter'] ?? 0) === 0,
        ),
      ).toBe(true);
    }));

  it('fences legacy execution before enable and preserves uncertain deletion evidence', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      const intentId = randomUUID();
      await tx.moderationDeleteIntent.create({
        data: {
          id: intentId,
          chatId,
          messageId: 'uncertain',
          status: 'IN_PROGRESS',
          retentionOwned: true,
          deleteDispatchStartedAt: new Date(),
          deleteDispatchStartedBotId: 'legacy-retention-bot',
          retryUntilAt: new Date(Date.now() + 86_400_000),
        },
      });
      await tx.chatRules.create({ data: { chatId, publishedMessageId: 'rules-original' } });
      await tx.managedGiveaway.create({
        data: {
          sourceChatId: chatId,
          actorUserId: 'admin',
          title: 'Protected fixture',
          endsAt: new Date(),
          publicationMessageId: 'giveaway-original',
          resultsMessageId: 'giveaway-results',
        },
      });
      const calls: { path: string; body: unknown }[] = [];
      jest.spyOn(service, 'request').mockImplementation(async (path, method, body) => {
        calls.push({ path, body });
        if (path.endsWith('/policy') && method === 'PUT') {
          expect(
            (await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).enabled,
          ).toBe(false);
          return state(operationId);
        }
        return path.endsWith('/policy') ? { ...state(operationId, false), revision: 0 } : {};
      });
      const input = { enabled: true, hours: 168 as const, expectedRevision: 0, operationId };
      await expect(service.update(chatId, 'admin', input)).rejects.toMatchObject({ status: 503 });
      expect(
        calls.filter(
          (row) => row.path.endsWith('/policy') && (row.body as { enabled?: boolean })?.enabled,
        ),
      ).toHaveLength(0);
      for (let i = 0; i < 8; i++) await service.syncChat(chatId);
      // Other native source fixtures retain immutable author projections. Drain them
      // through the same bounded delivery API instead of assuming an empty fleet.
      let globalReady = false;
      for (let page = 0; page < 200 && !globalReady; page++) {
        await service.syncGlobalHolds();
        const [row] = await tx.$queryRaw<{ ready: boolean }[]>`
          SELECT bootstrap_complete AND NOT EXISTS(SELECT 1 FROM eraser_held_authors WHERE delivered = FALSE LIMIT 1) AS ready
          FROM eraser_global_hold_state WHERE id = 1`;
        globalReady = row?.ready === true;
      }
      expect(globalReady).toBe(true);
      await expect(service.update(chatId, 'admin', input)).resolves.toMatchObject({
        hours: 168,
        lastOperationId: operationId,
      });
      const registry = await tx.$queryRaw<
        { messageId: string; held: boolean }[]
      >`SELECT message_id AS "messageId", held FROM eraser_protected_messages WHERE chat_id = ${chatId}`;
      expect(registry).toEqual(
        expect.arrayContaining([
          { messageId: 'rules-original', held: false },
          { messageId: 'giveaway-original', held: false },
          { messageId: 'giveaway-results', held: false },
          { messageId: 'uncertain', held: true },
        ]),
      );
      const [binding] = await tx.$queryRaw<{ eraserOwned: boolean }[]>(
        retentionBindingQuery(intentId),
      );
      expect(binding?.eraserOwned).toBe(true);
      const intent = await tx.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect(intent.status).toBe('IN_PROGRESS');
      expect(intent.deleteDispatchStartedAt).not.toBeNull();
    }));

  it('durably forwards explicit connection intent only after protection sync and preserves its one-hour receipt on retry', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const pending = {
        ...state(operationId, false),
        connectionRequest: { status: 'pending' as const, expiresAt },
      };
      const policyWrites: unknown[] = [];
      jest.spyOn(service, 'request').mockImplementation(async (path, method, body) => {
        if (!path.endsWith('/policy')) return {};
        if (method === 'PUT') {
          policyWrites.push(body);
          return pending;
        }
        return { ...state(operationId, false), revision: 0 };
      });
      const input = {
        enabled: true,
        hours: 168 as const,
        expectedRevision: 0,
        operationId,
        connectWhenReady: true,
      };
      await expect(service.update(chatId, '123', input)).rejects.toMatchObject({ status: 503 });
      expect(policyWrites).toHaveLength(0);
      for (let page = 0; page < 8; page++) await service.syncChat(chatId);
      let ready = false;
      for (let page = 0; page < 200 && !ready; page++) {
        await service.syncGlobalHolds();
        const [row] = await tx.$queryRaw<{ ready: boolean }[]>`
          SELECT bootstrap_complete AND NOT EXISTS(SELECT 1 FROM eraser_held_authors WHERE delivered = FALSE LIMIT 1) AS ready
          FROM eraser_global_hold_state WHERE id = 1`;
        ready = row?.ready === true;
      }
      expect(ready).toBe(true);
      await expect(service.update(chatId, '123', input)).resolves.toMatchObject(pending);
      expect(policyWrites).toEqual([{ ...input, actorUserId: '123' }]);
      await expect(service.update(chatId, '123', input)).resolves.toMatchObject(pending);
      expect(policyWrites).toHaveLength(1);
      await expect(
        service.update(chatId, '123', { ...input, connectWhenReady: false }),
      ).rejects.toMatchObject({ status: 409 });
      expect(policyWrites).toHaveLength(1);
      const [saved] = await tx.$queryRaw<
        { request: unknown; result: unknown; confirmed: boolean }[]
      >`SELECT request, result, confirmed_at IS NOT NULL AS confirmed FROM eraser_control_operations WHERE id = ${operationId}`;
      expect(saved).toMatchObject({ request: input, result: pending, confirmed: true });
      expect(
        (await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).enabled,
      ).toBe(false);
    }));

  it('captures replaced/deleted protected IDs transactionally and keeps source uncertainty below the watermark', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      const snapshots: Record<string, unknown>[] = [];
      jest.spyOn(service, 'request').mockImplementation(async (path, method, body) => {
        if (path.endsWith('/protection')) snapshots.push(body as Record<string, unknown>);
        return path.endsWith('/policy') ? state(operationId, false) : {};
      });
      await service.update(chatId, 'admin', {
        enabled: false,
        hours: 48,
        expectedRevision: 0,
        operationId,
      });
      const fenceAt = new Date(Date.now() - 3 * 86_400_000);
      await tx.chatRules.create({ data: { chatId, publishedMessageId: 'old-rules' } });
      await tx.chatRules.update({
        where: { chatId },
        data: {
          publishedMessageId: 'new-rules',
          publishOperationId: randomUUID(),
          publishSendStartedAt: fenceAt,
        },
      });
      for (let i = 0; i < 8; i++) await service.syncChat(chatId);
      expect(
        snapshots.some(
          (row) =>
            row.complete === true && Date.parse(String(row.completeThrough)) < fenceAt.getTime(),
        ),
      ).toBe(true);
      await tx.chatRules.delete({ where: { chatId } });
      const protectedIds = await tx.$queryRaw<
        { id: string }[]
      >`SELECT message_id AS id FROM eraser_protected_messages WHERE chat_id = ${chatId} ORDER BY message_id`;
      expect(protectedIds.map((row) => row.id)).toEqual(['new-rules', 'old-rules']);
    }));

  it('reuses an acknowledged remote operation when the local network receipt loses its lease', async () =>
    isolated(async (tx, service, chatId) => {
      const operationId = randomUUID();
      jest
        .spyOn(service, 'request')
        .mockImplementation(async (path) =>
          path.endsWith('/policy') ? state(operationId, false) : {},
        );
      const input = { enabled: false, hours: 168 as const, expectedRevision: 0, operationId };
      const precheck = jest.fn(async () => undefined);
      const receipt = jest.fn(async () => {
        throw new Error('lease superseded after remote acknowledgement');
      });
      await expect(
        service.update(chatId, 'admin', input, { beforeWrite: precheck, onCommitted: receipt }),
      ).rejects.toThrow('lease superseded');
      expect(precheck).toHaveBeenCalledTimes(2);
      const [unconfirmed] = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT result FROM eraser_control_operations WHERE id = ${operationId}`;
      expect(unconfirmed?.result).toBeNull();
      const committed = jest.fn(async () => undefined);
      await expect(
        service.resume(chatId, 'admin', operationId, { onCommitted: committed }),
      ).resolves.toMatchObject({ lastOperationId: operationId });
      expect(committed).toHaveBeenCalledTimes(1);
      const recorded = await tx.$queryRaw<
        { request: { operationId: string } }[]
      >`SELECT request FROM eraser_control_operations WHERE id = ${operationId}`;
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.request.operationId).toBe(operationId);
    }));

  it('imports historical human rules in bounded audit pages and captures unowned replacements', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.chatRules.create({
        data: {
          chatId,
          publishedMessageId: 'unowned-old-rules',
          publishedBotId: 'retired-module-bot',
        },
      });
      await tx.chatRules.update({
        where: { chatId },
        data: { publishedMessageId: 'unowned-new-rules' },
      });
      await tx.chatRules.delete({ where: { chatId } });
      await tx.auditLog.createMany({
        data: Array.from({ length: 501 }, (_, index) => ({
          id: randomUUID(),
          chatId,
          actorUserId: 'admin',
          action: 'ADOPT_CHAT_RULES_MESSAGE',
          createdAt: new Date(1_000_000 + index),
          payload: {
            messageId: `human-rule-${index}`,
            previousPublishedMessageId: index === 500 ? 'older-human-adopted-rules' : null,
            botId: 'historical-module-bot',
          },
        })),
      });
      const snapshots: Record<string, unknown>[] = [];
      const operationId = randomUUID();
      jest.spyOn(service, 'request').mockImplementation(async (path, _method, body) => {
        if (path.endsWith('/protection')) snapshots.push(body as Record<string, unknown>);
        return path.endsWith('/policy') ? state(operationId, false) : {};
      });
      await service.update(chatId, 'admin', {
        enabled: false,
        hours: 48,
        expectedRevision: 0,
        operationId,
      });
      const [first] = await tx.$queryRaw<
        { complete: boolean }[]
      >`SELECT rules_audit_complete AS complete FROM eraser_protection_outbox WHERE chat_id = ${chatId}`;
      expect(first?.complete).toBe(false);
      const [notYet] = await tx.$queryRaw<
        { found: boolean }[]
      >`SELECT EXISTS(SELECT 1 FROM eraser_protected_messages WHERE chat_id = ${chatId} AND message_id = 'older-human-adopted-rules') AS found`;
      expect(notYet?.found).toBe(false);
      for (let page = 0; page < 8; page++) await service.syncChat(chatId);
      expect(snapshots.flatMap((row) => row.protectedMessageIds)).toEqual(
        expect.arrayContaining([
          'unowned-old-rules',
          'unowned-new-rules',
          'human-rule-500',
          'older-human-adopted-rules',
        ]),
      );
      expect(snapshots.flatMap((row) => row.protectedBotIds)).toEqual(
        expect.arrayContaining(['retired-module-bot', 'historical-module-bot']),
      );
      const [binding] = await tx.$queryRaw<
        { createdAt: Date }[]
      >`SELECT created_at AS "createdAt" FROM eraser_chat_bindings WHERE chat_id = ${chatId}`;
      expect(snapshots.at(-1)).toMatchObject({
        complete: true,
        botHistoryCompleteFrom: binding!.createdAt.toISOString(),
      });
    }));

  it('imports exact giveaway publication audits across timestamp ties without requiring a surviving giveaway', async () =>
    isolated(async (tx, service, chatId) => {
      const prefix = randomUUID();
      await tx.auditLog.createMany({
        data: Array.from({ length: 501 }, (_, index) => ({
          id: `${prefix}-${String(index).padStart(4, '0')}`,
          chatId,
          actorUserId: 'admin',
          action: 'PUBLISH_GIVEAWAY',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          payload: {
            giveawayId: 'entity-no-longer-present',
            publicationMessageId: `historical-giveaway-${index}`,
            publicationBotId: '987654321',
          },
        })),
      });
      const snapshots: Record<string, unknown>[] = [];
      const operationId = randomUUID();
      jest.spyOn(service, 'request').mockImplementation(async (path, _method, body) => {
        if (path.endsWith('/protection')) snapshots.push(body as Record<string, unknown>);
        return path.endsWith('/policy') ? state(operationId, false) : {};
      });
      await service.update(chatId, 'admin', {
        enabled: false,
        hours: 48,
        expectedRevision: 0,
        operationId,
      });
      for (let page = 0; page < 10; page++) await service.syncChat(chatId);
      const refs = await tx.$queryRaw<{ id: string }[]>`
        SELECT message_id AS id FROM eraser_protected_messages WHERE chat_id=${chatId}`;
      expect(refs).toHaveLength(501);
      expect(snapshots.flatMap((row) => row.protectedMessageIds)).toEqual(
        expect.arrayContaining(['historical-giveaway-0', 'historical-giveaway-500']),
      );
      expect(snapshots.flatMap((row) => row.protectedBotIds)).toContain('987654321');
      const [binding] = await tx.$queryRaw<{ createdAt: Date }[]>`
        SELECT created_at AS "createdAt" FROM eraser_chat_bindings WHERE chat_id=${chatId}`;
      // FLAG: A complete audit page is an exact-reference import, not proof of all past results.
      expect(snapshots.at(-1)?.botHistoryCompleteFrom).toBe(binding!.createdAt.toISOString());
      await service.syncChat(chatId);
      expect(
        await tx.$queryRaw`SELECT message_id FROM eraser_protected_messages WHERE chat_id=${chatId}`,
      ).toHaveLength(501);
    }));

  it('retires only unissued transferred candidates, releases quota once and preserves uncertain journals', async () =>
    isolated(async (tx, _service, chatId) => {
      const oldActivation = randomUUID();
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: { enabled: false, activationId: randomUUID(), pendingCount: 7 },
      });
      const quotaBefore = await tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 0 } });
      await tx.messageRetentionQuota.update({
        where: { shard: 0 },
        data: { pendingCount: { increment: 7 } },
      });
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id) VALUES(${chatId})`;
      await tx.$executeRaw`INSERT INTO eraser_legacy_retirement(chat_id) VALUES(${chatId})`;
      const ids = new Map<string, string>();
      for (const name of ['safe-intent', 'unknown', 'confirmed', 'foreign', 'leased']) {
        const id = randomUUID();
        ids.set(name, id);
        await tx.moderationDeleteIntent.create({
          data: {
            id,
            chatId,
            messageId: name,
            retentionOwned: name !== 'foreign',
            status:
              name === 'unknown'
                ? 'AMBIGUOUS'
                : name === 'confirmed'
                  ? 'SUCCEEDED'
                  : name === 'leased'
                    ? 'IN_PROGRESS'
                    : 'PENDING',
            retryUntilAt: new Date(Date.now() + 86_400_000),
            ...(name === 'unknown'
              ? { deleteDispatchStartedAt: new Date(), deleteDispatchStartedBotId: '123' }
              : {}),
            ...(name === 'confirmed'
              ? { remoteDeleteSucceededAt: new Date(), remoteDeleteSucceededBotId: '123' }
              : {}),
            ...(name === 'leased'
              ? { leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) }
              : {}),
          },
        });
      }
      ids.set('missing', randomUUID());
      const messages = [
        'safe-no-intent',
        'safe-intent',
        'unknown',
        'confirmed',
        'missing',
        'foreign',
        'leased',
      ];
      await tx.messageRetentionCandidate.createMany({
        data: messages.map((messageId) => ({
          chatId,
          messageId,
          authorId: '5',
          originBotId: '123',
          sourceAt: new Date(0),
          activationId: oldActivation,
          intentId: ids.get(messageId) ?? null,
        })),
      });
      const journals = await tx.moderationDeleteIntent.findMany({
        where: { chatId },
        orderBy: { id: 'asc' },
      });
      await retireTransferredChat(tx, chatId);
      await retireTransferredChat(tx, chatId);
      const candidates = await tx.messageRetentionCandidate.findMany({ where: { chatId } });
      expect(
        candidates
          .filter((row) => row.status === 'cancelled')
          .map((row) => row.messageId)
          .sort(),
      ).toEqual(['safe-intent', 'safe-no-intent']);
      expect(candidates.find((row) => row.messageId === 'confirmed')).toMatchObject({
        status: 'pending',
        outcomeCode: 'reconciliation',
        reconcileAfter: expect.any(Date),
      });
      for (const messageId of ['unknown', 'missing', 'foreign', 'leased'])
        expect(candidates.find((row) => row.messageId === messageId)).toMatchObject({
          status: 'pending',
          intentId: ids.get(messageId),
          reconcileAfter: null,
        });
      expect(
        (await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).pendingCount,
      ).toBe(5);
      expect(
        (await tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 0 } })).pendingCount,
      ).toBe(quotaBefore.pendingCount + 5);
      expect(
        await tx.moderationDeleteIntent.findMany({ where: { chatId }, orderBy: { id: 'asc' } }),
      ).toEqual(journals);
      expect(
        await tx.$queryRaw`SELECT retired_count,reconciliation_count,retained_count,completed_at IS NOT NULL AS complete FROM eraser_legacy_retirement WHERE chat_id=${chatId}`,
      ).toEqual([
        { retired_count: 2n, reconciliation_count: 1n, retained_count: 4n, complete: true },
      ]);
    }));

  it('pages 201 transferred candidates through the active index beside 20000 terminal rows', async () =>
    isolated(async (tx, _service, chatId) => {
      const activation = randomUUID();
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: { enabled: false, activationId: randomUUID(), pendingCount: 201 },
      });
      const quota = await tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 0 } });
      await tx.messageRetentionQuota.update({
        where: { shard: 0 },
        data: { pendingCount: { increment: 201 } },
      });
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id) VALUES(${chatId})`;
      await tx.$executeRaw`INSERT INTO eraser_legacy_retirement(chat_id) VALUES(${chatId})`;
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status,completed_at)
        SELECT ${chatId},'a-terminal-'||lpad(i::text,6,'0'),'5','123',TIMESTAMP '2020-01-01',${activation},'deleted',CURRENT_TIMESTAMP
        FROM generate_series(1,20000) i`;
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id)
        SELECT ${chatId},'z-active-'||lpad(i::text,6,'0'),'5','123',TIMESTAMP '2020-01-01',${activation}
        FROM generate_series(1,201) i`;
      await tx.$executeRaw`ANALYZE message_retention_candidates`;
      const plans = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${retirementCandidatePageQuery(chatId, null)}`);
      assertRetirementPlan(plans, 201);
      expect(await tx.$queryRaw(retirementCandidatePageQuery(chatId, null))).toHaveLength(100);
      await retireTransferredChat(tx, chatId);
      expect(
        (await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).pendingCount,
      ).toBe(101);
      await retireTransferredChat(tx, chatId);
      await retireTransferredChat(tx, chatId);
      expect(
        (await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).pendingCount,
      ).toBe(0);
      expect(
        (await tx.messageRetentionQuota.findUniqueOrThrow({ where: { shard: 0 } })).pendingCount,
      ).toBe(quota.pendingCount);
      expect(
        await tx.$queryRaw`SELECT retired_count,completed_at IS NOT NULL AS complete FROM eraser_legacy_retirement WHERE chat_id=${chatId}`,
      ).toEqual([{ retired_count: 201n, complete: true }]);
    }));

  function assertRetirementPlan(plans: Array<{ 'QUERY PLAN': unknown }>, budget: number) {
    type Plan = {
      'Node Type': string;
      'Relation Name'?: string;
      'Actual Rows'?: number;
      'Actual Loops'?: number;
      'Rows Removed by Filter'?: number;
      Plans?: Plan[];
    };
    const root = (plans[0]!['QUERY PLAN'] as Array<{ Plan: Plan }>)[0]!.Plan;
    const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const scans = nodes(root).filter(
      (node) => node['Relation Name'] === 'message_retention_candidates',
    );
    expect(scans.length).toBeGreaterThan(0);
    // FLAG: PostgreSQL may prefer another bounded index for a small active pool.
    // Actual examined rows, including rejected rows, must stay independent of terminal history.
    for (const scan of scans) {
      expect(scan['Node Type']).toMatch(/^Index (Only )?Scan$/);
      expect(
        ((scan['Actual Rows'] ?? 0) + (scan['Rows Removed by Filter'] ?? 0)) *
          (scan['Actual Loops'] ?? 1),
      ).toBeLessThanOrEqual(budget);
    }
  }

  it('stops the retirement index walk at 100 inside a large active pool', async () =>
    isolated(async (tx, _service, chatId) => {
      const activation = randomUUID();
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id,status,completed_at)
        SELECT ${chatId},'a-terminal-'||lpad(i::text,6,'0'),'5','123',TIMESTAMP '2020-01-01',${activation},'deleted',CURRENT_TIMESTAMP
        FROM generate_series(1,20000) i`;
      await tx.$executeRaw`INSERT INTO message_retention_candidates(chat_id,message_id,author_id,origin_bot_id,source_at,activation_id)
        SELECT ${chatId},'z-active-'||lpad(i::text,6,'0'),'5','123',TIMESTAMP '2020-01-01',${activation}
        FROM generate_series(1,20001) i`;
      await tx.$executeRaw`ANALYZE message_retention_candidates`;
      for (const after of [null, 'z-active-010000']) {
        const plans = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
          EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${retirementCandidatePageQuery(chatId, after)}`);
        expect(JSON.stringify(plans)).toContain(
          'message_retention_candidates_eraser_retirement_idx',
        );
        assertRetirementPlan(plans, 100);
      }
    }));

  it('rolls back retirement on a concurrent intent lock and preserves its later dispatch marker', async () => {
    const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 13)}`)}`;
    const intentId = randomUUID();
    let unlock: (() => void) | undefined;
    let holder: Promise<unknown> | undefined;
    try {
      await db.chat.create({ data: { id: chatId, title: 'Isolated retirement race' } });
      await db.messageRetentionPolicy.create({
        data: {
          chatId,
          activationId: randomUUID(),
          enabled: false,
          quotaShard: 31,
          pendingCount: 1,
        },
      });
      await db.messageRetentionQuota.update({
        where: { shard: 31 },
        data: { pendingCount: { increment: 1 } },
      });
      await db.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id) VALUES(${chatId})`;
      await db.$executeRaw`INSERT INTO eraser_legacy_retirement(chat_id) VALUES(${chatId})`;
      await db.moderationDeleteIntent.create({
        data: {
          id: intentId,
          chatId,
          messageId: 'racing',
          retentionOwned: true,
          status: 'PENDING',
          retryUntilAt: new Date(Date.now() + 60_000),
        },
      });
      await db.messageRetentionCandidate.create({
        data: {
          chatId,
          messageId: 'racing',
          authorId: '5',
          originBotId: '123',
          sourceAt: new Date(0),
          activationId: randomUUID(),
          intentId,
        },
      });
      let locked!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM moderation_delete_intents WHERE id=${intentId} FOR UPDATE`;
          locked();
          await release;
          await tx.moderationDeleteIntent.update({
            where: { id: intentId },
            data: {
              status: 'AMBIGUOUS',
              deleteDispatchStartedAt: new Date(),
              deleteDispatchStartedBotId: '123',
            },
          });
        },
        { timeout: 5_000 },
      );
      await ready;
      await expect(
        db.$transaction((tx) => retireTransferredChat(tx, chatId)),
      ).rejects.toMatchObject({ code: 'P2010' });
      expect(
        await db.$queryRaw`SELECT cursor_message_id,retired_count FROM eraser_legacy_retirement WHERE chat_id=${chatId}`,
      ).toEqual([{ cursor_message_id: null, retired_count: 0n }]);
      unlock?.();
      await holder;
      await db.$transaction((tx) => retireTransferredChat(tx, chatId));
      expect(
        await db.messageRetentionCandidate.findUnique({
          where: { chatId_messageId: { chatId, messageId: 'racing' } },
        }),
      ).toMatchObject({ status: 'pending', intentId, completedAt: null });
      expect(
        (await db.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } })).pendingCount,
      ).toBe(1);
      expect(await db.moderationDeleteIntent.findUnique({ where: { id: intentId } })).toMatchObject(
        { status: 'AMBIGUOUS', deleteDispatchStartedAt: expect.any(Date) },
      );
    } finally {
      unlock?.();
      await holder?.catch(() => undefined);
      await db.$transaction(async (tx) => {
        const policy = await tx.messageRetentionPolicy.findUnique({ where: { chatId } });
        if (policy?.pendingCount)
          await tx.messageRetentionQuota.update({
            where: { shard: 31 },
            data: { pendingCount: { decrement: policy.pendingCount } },
          });
        await tx.messageRetentionCandidate.deleteMany({ where: { chatId } });
        await tx.moderationDeleteIntent.deleteMany({ where: { chatId } });
        await tx.$executeRaw`DELETE FROM eraser_legacy_retirement WHERE chat_id=${chatId}`;
        await tx.$executeRaw`DELETE FROM eraser_chat_bindings WHERE chat_id=${chatId}`;
        await tx.messageRetentionPolicy.deleteMany({ where: { chatId } });
        await tx.chat.deleteMany({ where: { id: chatId } });
      });
    }
  });

  it('restarts a bounded protection checksum when an earlier catalogue reference arrives', async () =>
    isolated(async (tx, service, chatId) => {
      const token = randomUUID();
      await tx.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id) VALUES(${chatId})`;
      await tx.$executeRaw`INSERT INTO eraser_protection_outbox(chat_id,lease_token) VALUES(${chatId},${token})`;
      await tx.$executeRaw`INSERT INTO eraser_protected_messages(chat_id,message_id)
        SELECT ${chatId},'m-'||lpad(i::text,5,'0') FROM generate_series(1,501) i`;
      expect(await protectionEvidencePage(tx, chatId, token)).toBeNull();
      await tx.$executeRaw`INSERT INTO eraser_protected_messages(chat_id,message_id) VALUES(${chatId},'a-before-cursor')`;
      await tx.$executeRaw`SELECT eraser_mark_protection_dirty(${chatId})`;
      expect(await protectionEvidencePage(tx, chatId, token)).toBeNull();
      expect(await protectionEvidencePage(tx, chatId, token)).toBeNull();
      const sealed = await protectionEvidencePage(tx, chatId, token);
      expect(sealed).toMatchObject({
        revision: 1,
        count: 502,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(await protectionEvidencePage(tx, chatId, token)).toEqual(sealed);
      expect(await service.protectionReport(chatId)).toMatchObject({
        status: 'available',
        catalog: { ready: true, referencesHashed: 502 },
        deliveredEvidence: null,
      });
    }));

  it('preserves the imported 48-hour interval while saving a weekly independent policy', async () =>
    isolated(async (tx, service, chatId) => {
      await tx.messageRetentionPolicy.update({ where: { chatId }, data: { hours: 48 } });
      const operationId = randomUUID();
      jest
        .spyOn(service, 'request')
        .mockImplementation(async (path) =>
          path.endsWith('/policy') ? state(operationId, false) : {},
        );
      await service.update(chatId, 'admin', {
        enabled: false,
        hours: 168,
        expectedRevision: 0,
        operationId,
      });
      const [binding] = await tx.$queryRaw<
        { hours: number }[]
      >`SELECT legacy_hours AS hours FROM eraser_chat_bindings WHERE chat_id = ${chatId}`;
      expect(binding?.hours).toBe(48);
    }));
});
