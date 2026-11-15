import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { from } from 'rxjs';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { fingerprintModerationSettings } from '../moderation/moderation-settings-fingerprint';
import type { ParticipantModerationImmunityService } from '../moderation/participant-moderation-immunity.service';
import type { RequiredSubscriptionNoticeAuthority } from '../moderation/required-subscription-notice-authority';
import { MaxClientService, type MaxActionJob } from './max-client.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxActionLedgerService } from './max-action-ledger.service';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import { MaxRequiredSubscriptionNoticeGuardService } from './max-required-subscription-notice.guard';
import type { MaxBotLinkService } from './max-bot-link.service';
import type { ActionHealthService } from '../system/action-health.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

integration('Queued subscription notice after its exact committed DELETE', () => {
  let db: PrismaClient;
  const chats: string[] = [];
  const jobs: string[] = [];
  const clients: MaxClientService[] = [];
  beforeAll(async () => {
    const pg = new URL(databaseUrl);
    const cache = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(pg.hostname) ||
      !pg.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(cache.hostname)
    )
      throw new Error('Disposable local PostgreSQL and Redis required');
    db = createPrismaClient(databaseUrl);
    await db.$connect();
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.onModuleDestroy();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await db?.maxActionLedgerEntry.deleteMany({ where: { jobId: { in: jobs } } });
    await db?.chat.deleteMany({ where: { id: { in: chats } } });
    await db?.$disconnect();
  });

  async function fixture() {
    const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)}`;
    const botId = `notice-receipt-${randomUUID()}`;
    const targetId = 'subscription-target';
    chats.push(chatId);
    await db.chat.create({ data: { id: chatId, title: 'Synthetic notice receipt test' } });
    const settings = await db.chatSettings.create({
      data: {
        chatId,
        requiredSubscriptionEnabled: true,
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionChannelIds: [targetId],
      },
    });
    const sourceAtMs = Date.now() - 10_000;
    const proof: RequiredSubscriptionNoticeAuthority = {
      version: 1,
      chatId,
      messageId: 'source-message',
      userId: '12345',
      reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
      sourceAtMs,
      deadlineAtMs: sourceAtMs + 300_000,
      policySha256: fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION'),
    };
    const metadata = {
      moderationDeleteVerified: true,
      requiredSubscriptionGuardVersion: 1,
      requiredSubscriptionPolicySha256: proof.policySha256,
      requiredSubscriptionSourceAtMs: sourceAtMs,
      requiredSubscriptionDeadlineAtMs: proof.deadlineAtMs,
    };
    const intent = await db.moderationDeleteIntent.create({
      data: {
        id: randomUUID(),
        chatId,
        messageId: proof.messageId,
        subjectUserId: proof.userId,
        sourceMessageAt: new Date(sourceAtMs),
        status: 'SUCCEEDED',
        retryUntilAt: new Date(proof.deadlineAtMs),
        completedAt: new Date(),
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: botId,
        reasons: {
          create: {
            id: randomUUID(),
            reasonKey: proof.reasonKey,
            ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
            userId: proof.userId,
            metadata,
          },
        },
      },
    });
    const config = new ConfigService({
      MAX_API_BASE_URL: 'https://platform-api2.max.ru',
      REDIS_URL: redisUrl,
      MAX_BOT_ID: botId,
      MAX_BOT_TOKEN: `synthetic-${botId}`,
      MAX_WEBHOOK_SECRET_PATH: 'synthetic',
      MAX_WEBHOOK_HEADER_SECRET: 'synthetic',
      MAX_ACTION_DISPATCH_ENABLED: true,
      APP_SERVICE_NAME: 'test-notice-receipt',
    });
    const registry = new MaxBotRegistryService(config);
    const ledger = new MaxActionLedgerService(db as unknown as PrismaService);
    const immunity = {
      consumeForMessage: jest.fn(async () => 'not_granted' as const),
    } satisfies Pick<ParticipantModerationImmunityService, 'consumeForMessage'>;
    const guard = new MaxRequiredSubscriptionNoticeGuardService(
      db as unknown as PrismaService,
      registry,
      immunity as unknown as ParticipantModerationImmunityService,
      config,
    );
    let sourceStatus = 404;
    let memberStatus = 200;
    let denyPolicyOnTarget = false;
    let failSend = false;
    const http = jest.fn(async (request: { method: string; url: string }) => {
      if (request.method === 'get' && request.url.includes('/messages'))
        throw { response: { status: sourceStatus, data: { code: 'message.not.found' } } };
      if (request.method === 'get' && request.url.includes(`/chats/${chatId}/members`)) {
        if (memberStatus !== 200) throw { response: { status: memberStatus } };
        return { status: 200, data: { members: [{ user_id: proof.userId, role: 'member' }] } };
      }
      if (request.method === 'get' && request.url.includes(`/chats/${targetId}/members`)) {
        if (denyPolicyOnTarget)
          await db.chatSettings.update({
            where: { chatId },
            data: { requiredSubscriptionEnabled: false },
          });
        return { status: 200, data: { members: [] } };
      }
      if (request.method === 'post' && request.url.endsWith('/messages')) {
        if (failSend)
          throw Object.assign(new Error('Synthetic HTTP response lost'), { code: 'ETIMEDOUT' });
        return { status: 200, data: { message: { body: { mid: 'sent-notice' } } } };
      }
      throw new Error(`Unexpected synthetic HTTP ${request.method}`);
    });
    const links = { resolveBotIdForRead: jest.fn(async () => botId) } satisfies Pick<
      MaxBotLinkService,
      'resolveBotIdForRead'
    >;
    const health = {
      recordSuccessForLane: jest.fn(),
      recordFailureForLane: jest.fn(),
    } satisfies Pick<ActionHealthService, 'recordSuccessForLane' | 'recordFailureForLane'>;
    const client = new MaxClientService(
      {
        request: (request: Parameters<typeof http>[0]) => from(http(request)),
      } as unknown as HttpService,
      config,
      health as unknown as ActionHealthService,
      registry,
      new MaxBotContextService(),
      undefined,
      undefined,
      ledger,
      links as unknown as MaxBotLinkService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      guard,
    );
    clients.push(client);
    // FLAG: The unchanged executor-capability boundary is synthetic. Source GET,
    // member/target HTTP parsing, notice authority, Redis limiter and SQL journals are real.
    jest
      .spyOn(
        client as unknown as { assertChatMutationExecutionProof(): Promise<null> },
        'assertChatMutationExecutionProof',
      )
      .mockResolvedValue(null);
    const action: MaxActionJob = {
      actionType: 'SEND_MESSAGE',
      chatId,
      botId,
      text: 'Subscribe',
      sourceTag: 'moderation_notice',
      trafficClass: 'interactive',
      idempotencyKey: randomUUID(),
      createdAt: new Date().toISOString(),
      attempt: 1,
      ledgerContext: { requiredSubscriptionNotice: proof },
    };
    jobs.push(action.idempotencyKey);
    await ledger.recordEnqueuedIfAbsent(action, new Date());
    const dispatch = new MaxActionDispatchService(client, undefined, ledger);
    return {
      action,
      intent,
      proof,
      metadata,
      http,
      immunity,
      ledger,
      dispatch,
      setSourceStatus: (status: number) => {
        sourceStatus = status;
      },
      setMemberStatus: (status: number) => {
        memberStatus = status;
      },
      revokePolicyOnTarget: () => {
        denyPolicyOnTarget = true;
      },
      loseSendResponse: () => {
        failSend = true;
      },
      row: () =>
        db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: action.idempotencyKey } }),
    };
  }

  it('sends once after source404 using its own exact reason and recovers the SEND receipt', async () => {
    const s = await fixture();
    await expect(s.dispatch.execute(s.action)).resolves.toMatchObject({ messageId: 'sent-notice' });
    const calls = s.http.mock.calls.length;
    await expect(s.dispatch.execute(s.action)).resolves.toMatchObject({ messageId: 'sent-notice' });
    expect(s.http).toHaveBeenCalledTimes(calls);
    expect(s.http.mock.calls.filter(([r]) => r.method === 'post')).toHaveLength(1);
    expect(s.http.mock.calls.some(([r]) => r.method === 'delete')).toBe(false);
    expect(await s.row()).toMatchObject({
      status: 'SUCCEEDED',
      terminal: true,
      ambiguous: false,
      dispatchToken: expect.any(String),
      remoteMessageId: 'sent-notice',
    });
    expect(s.proof.deadlineAtMs).toBe(s.proof.sourceAtMs + 300_000);
  });

  it.each([
    'unconfirmed',
    'foreign-author',
    'different-source-time',
    'wrong-policy',
    'source503',
    'member404',
  ])('preserves missing or unknown authority: %s', async (kind) => {
    const s = await fixture();
    if (kind === 'unconfirmed')
      await db.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: { status: 'AMBIGUOUS' },
      });
    if (kind === 'foreign-author')
      await db.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: { subjectUserId: 'other' },
      });
    if (kind === 'different-source-time')
      await db.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: { sourceMessageAt: new Date(s.proof.sourceAtMs - 1) },
      });
    if (kind === 'wrong-policy')
      await db.moderationDeleteIntentReason.updateMany({
        where: { intentId: s.intent.id },
        data: { metadata: { ...s.metadata, requiredSubscriptionPolicySha256: 'f'.repeat(64) } },
      });
    if (kind === 'source503') s.setSourceStatus(503);
    if (kind === 'member404') s.setMemberStatus(404);
    await expect(s.dispatch.execute(s.action)).rejects.toBeDefined();
    expect(s.http.mock.calls.every(([r]) => r.method === 'get')).toBe(true);
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    expect(await s.row()).toMatchObject({
      status: 'FAILED_RETRYABLE',
      terminal: false,
      ambiguous: false,
      dispatchToken: null,
      remoteMessageId: null,
    });
  });

  it('rechecks current policy after receipt reuse and fresh target reads', async () => {
    const s = await fixture();
    s.revokePolicyOnTarget();
    await expect(s.dispatch.execute(s.action)).rejects.toMatchObject({
      code: 'required_subscription_notice_no_longer_authorized',
    });
    expect(s.http.mock.calls.every(([r]) => r.method === 'get')).toBe(true);
    expect(await s.row()).toMatchObject({
      status: 'FAILED_TERMINAL',
      terminal: true,
      ambiguous: false,
    });
  });

  it('keeps an unknown SEND fenced even though the source DELETE is confirmed', async () => {
    const s = await fixture();
    s.loseSendResponse();
    await expect(s.dispatch.execute(s.action)).rejects.toBeDefined();
    const calls = s.http.mock.calls.length;
    await expect(s.dispatch.execute(s.action)).rejects.toBeDefined();
    expect(s.http).toHaveBeenCalledTimes(calls);
    expect(await s.row()).toMatchObject({ status: 'AMBIGUOUS', terminal: true, ambiguous: true });
  });
});
