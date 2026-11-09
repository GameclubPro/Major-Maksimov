import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import axios, { type InternalAxiosRequestConfig } from 'axios';
import { UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ActionHealthService } from '../system/action-health.service';
import { createDuplicateSanctionNoticeDispatchOptions } from '../moderation/moderation-execution-guard-callbacks';
import { deliverSanctionNotice } from '../moderation/moderation-sanction-notice-delivery';
import { ModerationService } from '../moderation/moderation.service';
import { MaxActionLedgerService } from './max-action-ledger.service';
import { buildMaxActionIdempotencyKey } from './max-action-idempotency';
import {
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
  wasMaxPreDispatchGuardRejected,
} from './max-action-pre-dispatch-guard';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import {
  MaxApiInternalRateLimitError,
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxActionJob,
  wasMaxMessageSendAttempted,
} from './max-client.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

type CapacityBoundary = {
  reserveRateLimitSlot: MaxClientService['reserveRateLimitSlot'];
};

integration('Immediate SEND terminal policy on real PostgreSQL', () => {
  let db: PrismaClient;
  let redis: Redis;
  let ledger: MaxActionLedgerService;
  let client: MaxClientService;
  let request: jest.Mock<Promise<Record<string, unknown>>, [InternalAxiosRequestConfig]>;
  let capacity: jest.SpyInstance<
    ReturnType<CapacityBoundary['reserveRateLimitSlot']>,
    Parameters<CapacityBoundary['reserveRateLimitSlot']>
  >;
  let jobId: string;
  let requestedKey: string;
  let chatId: string;
  const botId = `native-immediate-${randomUUID()}`;

  beforeAll(async () => {
    const pg = new URL(databaseUrl);
    const cache = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(pg.hostname) ||
      !pg.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(cache.hostname)
    ) {
      throw new Error('Local disposable PostgreSQL race_test and Redis required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    ledger = new MaxActionLedgerService(db as unknown as PrismaService);
  });

  beforeEach(() => {
    requestedKey = `native-immediate-send-${randomUUID()}`;
    jobId = buildMaxActionIdempotencyKey('explicit', [botId, 'SEND_MESSAGE', requestedKey]);
    chatId = `native-immediate-chat-${randomUUID()}`;
    request = jest.fn().mockResolvedValue({ message_id: `remote-${jobId}` });
    const config = new ConfigService({
      NODE_ENV: 'test',
      MAX_API_BASE_URL: 'https://immediate-send-fixture.invalid',
      REDIS_URL: redisUrl,
      MAX_BOT_ID: botId,
      MAX_BOT_TOKEN: 'synthetic-no-network-token',
      MAX_WEBHOOK_SECRET_PATH: 'synthetic-path',
      MAX_WEBHOOK_HEADER_SECRET: 'synthetic-header',
      MAX_ACTION_DISPATCH_ENABLED: false,
    });
    const health = {
      recordSuccessForLane: jest.fn(),
      recordFailureForLane: jest.fn(),
    } satisfies Pick<ActionHealthService, 'recordSuccessForLane' | 'recordFailureForLane'>;
    // FLAG: Only the HTTP adapter and capacity reservation are synthetic. Public immediate
    // dispatch, final guards, send-fence release and every ledger transition remain real.
    const http = new HttpService(
      axios.create({
        adapter: async (requestConfig) => {
          if (
            requestConfig.method !== 'post' ||
            requestConfig.url !== 'https://immediate-send-fixture.invalid/messages'
          )
            throw new Error('Immediate SEND fixture refuses non-synthetic HTTP');
          return {
            config: requestConfig,
            status: 200,
            statusText: 'OK',
            headers: {},
            data: await request(requestConfig),
          };
        },
      }),
    );
    client = new MaxClientService(
      http,
      config,
      health as unknown as ActionHealthService,
      new MaxBotRegistryService(config),
      new MaxBotContextService(),
      undefined,
      undefined,
      ledger,
    );
    capacity = jest
      .spyOn(client as unknown as CapacityBoundary, 'reserveRateLimitSlot')
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    try {
      await client?.onModuleDestroy();
    } finally {
      try {
        if (jobId) await db.maxActionLedgerEntry.deleteMany({ where: { jobId } });
      } finally {
        await redis.del(
          `maxapi:circuit:v1:${botId}:failures`,
          `maxapi:circuit:v1:${botId}:open-until`,
          `maxapi:circuit:v1:${botId}:half-open-probe`,
        );
      }
    }
  });

  afterAll(async () => {
    try {
      await redis?.quit();
    } finally {
      await db?.$disconnect();
    }
  });

  function options(overrides: Partial<MaxActionDispatchOptions> = {}): MaxActionDispatchOptions {
    return {
      immediate: true,
      immediateFailurePolicy: 'terminal',
      botId,
      idempotencyKey: requestedKey,
      trafficClass: 'interactive',
      ...overrides,
    };
  }

  function readLedger() {
    return db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } });
  }

  function action(): MaxActionJob {
    return {
      actionType: 'SEND_MESSAGE',
      chatId,
      botId,
      text: 'Synthetic connection confirmation',
      attempt: 1,
      idempotencyKey: jobId,
      createdAt: new Date().toISOString(),
    };
  }

  it.each(['authority', 'quota'] as const)(
    'settles a duplicate-sanction one-shot %s refusal through its actual notice sender',
    async (failure) => {
      const refused =
        failure === 'quota'
          ? new MaxApiInternalRateLimitError('Synthetic shared capacity refusal', 1_000, 'bot')
          : new Error('Synthetic original duplicate authority refusal');
      const authority = jest.fn(async (beforeFinalAuthority?: () => Promise<void>) => {
        await beforeFinalAuthority?.();
        if (failure === 'authority') throw refused;
      });
      if (failure === 'quota') capacity.mockRejectedValueOnce(refused);
      const moderation = new ModerationService(
        db as unknown as PrismaService,
        {} as never,
        {} as never,
        client,
      );
      type Sender = {
        sendBotMessageWithOptionalAutoDelete: Parameters<typeof deliverSanctionNotice>[0]['send'];
      };
      const sender = moderation as unknown as Sender;
      const logger = { warn: jest.fn() };

      // FLAG: Duplicate sanction delivery deliberately consumes notice failure. Its
      // source/lease closure has no serialized retry owner after this caller resolves.
      await expect(
        deliverSanctionNotice({
          notice: {
            chatId,
            botId,
            userId: 'synthetic-duplicate-user',
            messageId: 'synthetic-duplicate-message',
            userLabel: 'Synthetic participant',
            deleteBotMessagesEnabled: false,
            deleteBotMessagesDelayMinutes: 5,
            idempotencyKey: requestedKey,
            botSpeechStyle: null,
            noticeDispatchOptions: createDuplicateSanctionNoticeDispatchOptions(authority),
          },
          action: 'UNBAN',
          text: 'Synthetic duplicate sanction notice',
          send: (input) => sender.sendBotMessageWithOptionalAutoDelete(input),
          logger,
        }),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(authority).toHaveBeenCalledTimes(1);
      expect(wasMaxPreDispatchGuardRejected(refused)).toBe(true);
      expect(wasMaxMessageSendAttempted(refused)).toBe(false);
      expect(request).not.toHaveBeenCalled();
      const settled = await readLedger();
      expect(settled).toMatchObject({
        status: 'FAILED_RETRYABLE',
        terminal: true,
        ambiguous: false,
        completedAt: expect.any(Date),
        lastAttemptAt: expect.any(Date),
        lastErrorCode: MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });
      await expect(ledger.assertCanExecute(action())).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await readLedger()).toEqual(settled);
    },
  );

  it.each(['guard', 'quota'] as const)(
    'settles a one-shot %s refusal immediately without claiming a delivered message',
    async (failure) => {
      const refused =
        failure === 'quota'
          ? new MaxApiInternalRateLimitError('Synthetic shared capacity refusal', 1_000, 'bot')
          : new Error('Synthetic final authority refusal');
      const guard = jest.fn(async () => {
        if (failure === 'guard') throw refused;
      });
      if (failure === 'quota') capacity.mockRejectedValueOnce(refused);

      await expect(
        client.sendMessage(
          chatId,
          'Synthetic connection confirmation',
          undefined,
          options({
            beforeImmediateSendMutation: guard,
          }),
        ),
      ).rejects.toBe(refused);

      expect(wasMaxPreDispatchGuardRejected(refused)).toBe(true);
      expect(wasMaxMessageSendAttempted(refused)).toBe(false);
      expect(request).not.toHaveBeenCalled();
      const settled = await readLedger();
      expect(settled).toMatchObject({
        status: 'FAILED_RETRYABLE',
        terminal: true,
        ambiguous: false,
        completedAt: expect.any(Date),
        lastAttemptAt: expect.any(Date),
        lastErrorCode: MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });
      await expect(ledger.assertCanExecute(action())).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(
        client.sendMessage(chatId, 'Synthetic connection confirmation', undefined, options()),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await readLedger()).toEqual(settled);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('preserves nonterminal default immediate failures for their existing recovery owner', async () => {
    const refused = new MaxApiInternalRateLimitError(
      'Synthetic shared capacity refusal',
      1_000,
      'bot',
    );
    capacity.mockRejectedValueOnce(refused);
    await expect(
      client.sendMessage(
        chatId,
        'Synthetic connection confirmation',
        undefined,
        options({
          immediateFailurePolicy: undefined,
        }),
      ),
    ).rejects.toBe(refused);
    expect(await readLedger()).toMatchObject({
      status: 'FAILED_RETRYABLE',
      terminal: false,
      ambiguous: false,
      completedAt: null,
      lastErrorCode: MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
      dispatchToken: null,
      remoteMessageId: null,
    });
    await expect(ledger.assertCanExecute(action())).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('retains ambiguous dispatch evidence and refuses another HTTP attempt', async () => {
    request.mockRejectedValueOnce(
      Object.assign(new Error('Synthetic response timeout'), { code: 'ETIMEDOUT' }),
    );
    await expect(
      client.sendMessage(chatId, 'Synthetic connection confirmation', undefined, options()),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    const uncertain = await readLedger();
    expect(uncertain).toMatchObject({
      status: 'AMBIGUOUS',
      terminal: true,
      ambiguous: true,
      dispatchToken: expect.any(String),
      dispatchStartedAt: expect.any(Date),
      dispatchBotId: botId,
      remoteMessageId: null,
      completedAt: expect.any(Date),
    });
    await expect(
      client.sendMessage(chatId, 'Synthetic connection confirmation', undefined, options()),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(await readLedger()).toEqual(uncertain);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps a positive receipt monotonic after a later failure and recovers it without another SEND', async () => {
    const cleanupFailure = new Error('Synthetic post-receipt cleanup failure');
    jest
      .spyOn(client, 'ensureSendAutoDeleteScheduled')
      .mockResolvedValue(undefined)
      .mockRejectedValueOnce(cleanupFailure);
    const dispatchOptions = options({ autoDeleteDelayMs: 1_000 });
    await expect(
      client.sendMessage(chatId, 'Synthetic connection confirmation', undefined, dispatchOptions),
    ).rejects.toBe(cleanupFailure);
    const completed = await readLedger();
    expect(completed).toMatchObject({
      status: 'SUCCEEDED',
      terminal: true,
      ambiguous: false,
      remoteMessageId: `remote-${jobId}`,
      completedAt: expect.any(Date),
      dispatchBotId: botId,
    });
    await expect(
      client.sendMessage(chatId, 'Synthetic connection confirmation', undefined, dispatchOptions),
    ).resolves.toMatchObject({ messageId: `remote-${jobId}` });
    expect(await readLedger()).toEqual(completed);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
