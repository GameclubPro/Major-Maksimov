import { ForbiddenException } from '@nestjs/common';
import Fastify from 'fastify';
import {
  MAX_WEBHOOK_ROUTE_CONFIG_KEY,
  readMaxWebhookAckDeadlineAtMs,
  registerMaxWebhookHttpRouteLimits,
} from './webhook-http-route-limit';
import { WebhookIngestionService } from './webhook-ingestion.service';

describe('WebhookIngestionService', () => {
  const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

  const createService = (
    overrides: {
      allowed?: boolean;
      bot?: { id: string } | null;
      ackDeadlineMs?: number;
      receiptMaxInFlight?: number;
    } = {},
  ) => {
    const botRegistry = {
      resolveWebhookBot: jest.fn(({ botId, secretPath, providedHeaderSecret }) => {
        if (overrides.bot !== undefined) {
          return overrides.bot;
        }
        if (
          botId === 'bot-1' &&
          secretPath === 'secret-path' &&
          providedHeaderSecret === 'secret-header'
        ) {
          return { id: 'bot-1' };
        }
        return null;
      }),
    };
    const parser = {
      parse: jest.fn().mockReturnValue({ updateId: '1', type: 'message_created' }),
    };
    const webhookService = {
      storeReceipt: jest.fn().mockResolvedValue({
        duplicate: false,
        webhookEventId: 'event-1',
      }),
      repairDuplicateReceiptReadModels: jest.fn().mockResolvedValue(undefined),
      schedulePersistedWebhookPreparation: jest.fn(),
    };
    const webhookRateLimitService = {
      isAllowed: jest.fn().mockResolvedValue(overrides.allowed ?? true),
    };
    const webhookSubscriptionStatusService = {
      markIncomingWebhook: jest.fn().mockResolvedValue(undefined),
    };
    const webhookIngressMetricsService = {
      recordReceiptPersistence: jest.fn().mockResolvedValue(undefined),
      observeReceiptWork: async <T>(operation: () => Promise<T>): Promise<T> => operation(),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'WEBHOOK_ACK_DEADLINE_MS') {
          return overrides.ackDeadlineMs;
        }
        if (key === 'WEBHOOK_RECEIPT_MAX_IN_FLIGHT') {
          return overrides.receiptMaxInFlight;
        }
        return undefined;
      }),
    };

    return {
      service: new WebhookIngestionService(
        botRegistry as never,
        parser as never,
        webhookService as never,
        webhookRateLimitService as never,
        webhookSubscriptionStatusService as never,
        configService as never,
        webhookIngressMetricsService as never,
      ),
      botRegistry,
      parser,
      webhookService,
      webhookRateLimitService,
      webhookSubscriptionStatusService,
      webhookIngressMetricsService,
    };
  };

  it('rejects invalid route or header signatures before parsing', async () => {
    const { service, parser, webhookService } = createService();

    await expect(
      service.ingest({ botId: 'wrong', secretPath: 'bad' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toThrow(ForbiddenException);
    expect(parser.parse).not.toHaveBeenCalled();
    expect(webhookService.storeReceipt).not.toHaveBeenCalled();
  });

  it('requests redelivery before parsing or persistence when admission is over budget', async () => {
    const {
      service,
      parser,
      webhookService,
      webhookRateLimitService,
      webhookIngressMetricsService,
    } = createService({ allowed: false });

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, { type: 'message_created' }, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toMatchObject({ status: 503 });
    expect(webhookRateLimitService.isAllowed).toHaveBeenCalledWith('127.0.0.1');
    expect(parser.parse).not.toHaveBeenCalled();
    expect(webhookService.storeReceipt).not.toHaveBeenCalled();
    expect(webhookService.schedulePersistedWebhookPreparation).not.toHaveBeenCalled();
    expect(webhookService.repairDuplicateReceiptReadModels).not.toHaveBeenCalled();
    await flushImmediate();
    expect(webhookIngressMetricsService.recordReceiptPersistence).not.toHaveBeenCalled();
  });

  it('performs pre-body admission once and reuses it at the ingestion boundary', async () => {
    const { service, webhookRateLimitService, parser, webhookService } = createService();
    const fastify = Fastify();
    registerMaxWebhookHttpRouteLimits(fastify, {
      bodyLimit: 1_024,
      ackDeadlineMs: 5_000,
      admitRequest: (request, deadlineAtMs) => {
        const params = request.params as { botId: string; secretPath: string };
        return service.admitBeforeBody(params, request, deadlineAtMs);
      },
    });
    fastify.post(
      '/webhook/:botId/:secretPath',
      { config: { [MAX_WEBHOOK_ROUTE_CONFIG_KEY]: true } },
      async (request) =>
        service.ingest(
          request.params as { botId: string; secretPath: string },
          request.body as Record<string, unknown>,
          request,
          readMaxWebhookAckDeadlineAtMs(request),
        ),
    );

    try {
      const response = await fastify.inject({
        method: 'POST',
        url: '/webhook/bot-1/secret-path',
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        payload: { type: 'message_created' },
      });

      expect(response.statusCode).toBe(200);
      expect(webhookRateLimitService.isAllowed).toHaveBeenCalledTimes(1);
      expect(parser.parse).toHaveBeenCalledTimes(1);
      expect(webhookService.storeReceipt).toHaveBeenCalledTimes(1);
    } finally {
      await fastify.close();
    }
  });

  it('records incoming webhook status asynchronously', async () => {
    const { service, webhookSubscriptionStatusService } = createService();

    await service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
      headers: { 'x-max-bot-api-secret': 'secret-header' },
      ip: '127.0.0.1',
    } as never);
    await Promise.resolve();

    expect(webhookSubscriptionStatusService.markIncomingWebhook).toHaveBeenCalledWith('bot-1');
  });

  it('acknowledges a persisted webhook when Redis cannot record its delivery time', async () => {
    const { service, webhookService, webhookSubscriptionStatusService } = createService();
    webhookSubscriptionStatusService.markIncomingWebhook.mockRejectedValueOnce(
      new Error('Redis unavailable'),
    );
    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toMatchObject({ ok: true });
    await flushImmediate();
    expect(webhookService.storeReceipt).toHaveBeenCalledTimes(1);
    expect(webhookSubscriptionStatusService.markIncomingWebhook).toHaveBeenCalledWith('bot-1');
  });

  it('acknowledges a legacy-compatible duplicate without scheduling business preparation', async () => {
    const { service, webhookService } = createService();
    webhookService.storeReceipt.mockResolvedValueOnce({
      duplicate: true,
      webhookEventId: null,
    });

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toEqual(expect.objectContaining({ ok: true, duplicate: true }));

    expect(webhookService.schedulePersistedWebhookPreparation).not.toHaveBeenCalled();
    expect(webhookService.repairDuplicateReceiptReadModels).toHaveBeenCalledWith({
      updateId: '1',
      type: 'message_created',
    });
  });

  it('asks MAX to retry when duplicate read-model repair fails', async () => {
    const { service, webhookService } = createService();
    webhookService.storeReceipt.mockResolvedValueOnce({
      duplicate: true,
      webhookEventId: null,
    });
    webhookService.repairDuplicateReceiptReadModels.mockRejectedValueOnce(
      new Error('postgres unavailable'),
    );

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toMatchObject({ status: 503 });

    expect(webhookService.repairDuplicateReceiptReadModels).toHaveBeenCalledWith({
      updateId: '1',
      type: 'message_created',
    });
  });

  it('returns a retryable service error when the durable receipt cannot be stored', async () => {
    const {
      service,
      webhookService,
      webhookRateLimitService,
      webhookIngressMetricsService,
      webhookSubscriptionStatusService,
    } = createService();
    webhookService.storeReceipt.mockRejectedValueOnce(new Error('postgres unavailable'));

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toMatchObject({ status: 503 });

    expect(webhookService.schedulePersistedWebhookPreparation).not.toHaveBeenCalled();
    expect(webhookRateLimitService.isAllowed).toHaveBeenCalledWith('127.0.0.1');
    await flushImmediate();
    expect(webhookIngressMetricsService.recordReceiptPersistence).toHaveBeenCalledWith({
      botId: 'bot-1',
      outcome: 'failed',
      latencyMs: expect.any(Number),
    });
    expect(webhookSubscriptionStatusService.markIncomingWebhook).not.toHaveBeenCalled();
  });

  it('does not wait for Redis metric persistence before resolving the webhook ACK path', async () => {
    const { service, webhookIngressMetricsService } = createService();
    webhookIngressMetricsService.recordReceiptPersistence.mockReturnValueOnce(
      new Promise<void>(() => undefined),
    );

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).resolves.toMatchObject({ ok: true });
    await flushImmediate();
    expect(webhookIngressMetricsService.recordReceiptPersistence).toHaveBeenCalledTimes(1);
  });

  it('does not reset a pre-body absolute ACK deadline inside ingestion', async () => {
    const { service, webhookService, webhookRateLimitService } = createService();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_002);

    try {
      await expect(
        service.ingest(
          { botId: 'bot-1', secretPath: 'secret-path' },
          {},
          {
            headers: { 'x-max-bot-api-secret': 'secret-header' },
            ip: '127.0.0.1',
          } as never,
          1_001,
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(webhookRateLimitService.isAllowed).not.toHaveBeenCalled();
      expect(webhookService.storeReceipt).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('bounds webhook admission by the absolute ACK deadline', async () => {
    const { service, webhookService, webhookRateLimitService, webhookIngressMetricsService } =
      createService({ ackDeadlineMs: 1 });
    webhookRateLimitService.isAllowed.mockReturnValueOnce(new Promise(() => undefined));

    await expect(
      service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
        headers: { 'x-max-bot-api-secret': 'secret-header' },
        ip: '127.0.0.1',
      } as never),
    ).rejects.toMatchObject({ status: 503 });
    expect(webhookService.storeReceipt).not.toHaveBeenCalled();
    await flushImmediate();
    expect(webhookIngressMetricsService.recordReceiptPersistence).not.toHaveBeenCalled();
  });

  it('bounds durable receipt work by the webhook ACK deadline', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      const { service, webhookService, webhookIngressMetricsService } = createService({
        ackDeadlineMs: 1,
      });
      webhookService.storeReceipt.mockReturnValueOnce(new Promise(() => undefined));

      await expect(
        service.ingest({ botId: 'bot-1', secretPath: 'secret-path' }, {}, {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never),
      ).rejects.toMatchObject({ status: 503 });
      await flushImmediate();
      expect(webhookIngressMetricsService.recordReceiptPersistence).toHaveBeenCalledWith({
        botId: 'bot-1',
        outcome: 'failed',
        latencyMs: expect.any(Number),
      });
    } finally {
      now.mockRestore();
    }
  });

  it('does not start SQL after priority observation exhausts the original ACK deadline', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const { service, webhookService, webhookIngressMetricsService } = createService({
      receiptMaxInFlight: 1,
    });
    webhookIngressMetricsService.observeReceiptWork = async <T>(
      operation: () => Promise<T>,
    ): Promise<T> => {
      now.mockReturnValue(1_002);
      return operation();
    };
    const ingest = (deadlineAtMs: number) =>
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        deadlineAtMs,
      );

    try {
      await expect(ingest(1_001)).rejects.toMatchObject({ status: 503 });
      expect(webhookService.storeReceipt).not.toHaveBeenCalled();
      expect(webhookService.schedulePersistedWebhookPreparation).not.toHaveBeenCalled();

      await expect(ingest(1_005)).resolves.toMatchObject({ ok: true });
      expect(webhookService.storeReceipt).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps timed-out receipt work capped until the underlying operation settles', async () => {
    let resolveReceipt!: (value: { duplicate: boolean; webhookEventId: string }) => void;
    const pendingReceipt = new Promise<{ duplicate: boolean; webhookEventId: string }>(
      (resolve) => {
        resolveReceipt = resolve;
      },
    );
    const { service, webhookService } = createService({ receiptMaxInFlight: 1 });
    const logger = (
      service as unknown as {
        logger: { warn: (...args: unknown[]) => void };
      }
    ).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    webhookService.storeReceipt.mockReturnValueOnce(pendingReceipt);

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 5,
      ),
    ).rejects.toMatchObject({ status: 503 });

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(webhookService.storeReceipt).toHaveBeenCalledTimes(1);

    resolveReceipt({ duplicate: false, webhookEventId: 'event-late' });
    await flushImmediate();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        updateId: '1',
        duplicate: false,
      }),
      'Webhook receipt persistence completed after its ACK deadline',
    );

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(webhookService.storeReceipt).toHaveBeenCalledTimes(2);
  });

  it('observes late receipt failures and releases their capacity', async () => {
    let rejectReceipt!: (error: Error) => void;
    const pendingReceipt = new Promise<{ duplicate: boolean; webhookEventId: string }>(
      (_resolve, reject) => {
        rejectReceipt = reject;
      },
    );
    const { service, webhookService } = createService({ receiptMaxInFlight: 1 });
    const logger = (
      service as unknown as {
        logger: { warn: (...args: unknown[]) => void };
      }
    ).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    webhookService.storeReceipt.mockReturnValueOnce(pendingReceipt);

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 5,
      ),
    ).rejects.toMatchObject({ status: 503 });

    rejectReceipt(new Error('late postgres failure'));
    await flushImmediate();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        updateId: '1',
        err: 'late postgres failure',
      }),
      'Webhook receipt persistence failed after its ACK deadline',
    );

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('keeps timed-out duplicate repair inside the shared receipt-work cap', async () => {
    let resolveRepair!: () => void;
    const pendingRepair = new Promise<void>((resolve) => {
      resolveRepair = resolve;
    });
    const { service, webhookService } = createService({ receiptMaxInFlight: 1 });
    const logger = (
      service as unknown as {
        logger: { warn: (...args: unknown[]) => void };
      }
    ).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    webhookService.storeReceipt.mockResolvedValueOnce({
      duplicate: true,
      webhookEventId: null,
    });
    webhookService.repairDuplicateReceiptReadModels.mockReturnValueOnce(pendingRepair);

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 5,
      ),
    ).rejects.toMatchObject({ status: 503 });

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(webhookService.storeReceipt).toHaveBeenCalledTimes(1);

    resolveRepair();
    await flushImmediate();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        updateId: '1',
      }),
      'Webhook duplicate read-model repair completed after its ACK deadline',
    );

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(webhookService.storeReceipt).toHaveBeenCalledTimes(2);
  });

  it('releases receipt capacity after a synchronous storage failure', async () => {
    const { service, webhookService } = createService({ receiptMaxInFlight: 1 });
    webhookService.storeReceipt.mockImplementationOnce(() => {
      throw new Error('synchronous adapter failure');
    });

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).rejects.toMatchObject({ status: 503 });

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(webhookService.storeReceipt).toHaveBeenCalledTimes(2);
  });

  it('releases shared capacity after a synchronous duplicate-repair failure', async () => {
    const { service, webhookService } = createService({ receiptMaxInFlight: 1 });
    webhookService.storeReceipt.mockResolvedValueOnce({
      duplicate: true,
      webhookEventId: null,
    });
    webhookService.repairDuplicateReceiptReadModels.mockImplementationOnce(() => {
      throw new Error('synchronous repair failure');
    });

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).rejects.toMatchObject({ status: 503 });

    await expect(
      service.ingest(
        { botId: 'bot-1', secretPath: 'secret-path' },
        {},
        {
          headers: { 'x-max-bot-api-secret': 'secret-header' },
          ip: '127.0.0.1',
        } as never,
        Date.now() + 1_000,
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(webhookService.storeReceipt).toHaveBeenCalledTimes(2);
  });
});
