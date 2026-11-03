import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import {
  PublisherAutoReplyDeliveryStatus,
  PublisherAutoReplyMatchKind,
  WebhookStatus,
  type WebhookEvent,
} from '../prisma/prisma-client';
import {
  PublisherAutoReplyProducerService,
  PublisherAutoReplyEnqueuePendingError,
} from './publisher-auto-reply-producer.service';
import {
  PublisherAutoReplyAdmissionError,
  type PublisherAutoReplyQueueService,
} from './publisher-auto-reply.queue';
import type { PublisherAutoReplyFloodGateResult } from './publisher-auto-reply-flood-gate.service';
import { PublisherAutoReplySourceReceiptHeldError } from './publisher-auto-reply-source-fence.service';

type AdmissionReceipt = Pick<
  WebhookEvent,
  | 'status'
  | 'errorMessage'
  | 'legacyDispositionId'
  | 'legacyDispositionReceiptId'
  | 'sourceDispositionId'
  | 'sourceDispositionReceiptId'
>;

function update(type = 'message_created', text = 'ПРАЙС'): MaxUpdate {
  return {
    updateId: `update-${type}`,
    botId: 'publisher-bot',
    type,
    message: {
      messageId: 'message-1',
      chatId: '-100',
      entityType: 'chat',
      senderId: 'user-1',
      text,
      createdAt: '2026-08-29T12:00:00.000Z',
    },
    raw: {
      update_type: type,
      message: {
        body: { mid: 'message-1', text },
        sender: { user_id: 'user-1' },
        recipient: { chat_id: '-100', chat_type: 'chat' },
      },
    },
  };
}

function triggerRow(
  options: {
    id?: string;
    ruleId?: string;
    position?: number;
    phrase?: string;
    normalizedPhrase?: string;
    version?: number;
    matchInContext?: boolean;
    fuzzyMatch?: boolean;
    currentContentRevisionId?: string;
  } = {},
) {
  const ruleId = options.ruleId ?? 'rule-1';
  return {
    id: options.id ?? 'trigger-1',
    ruleId,
    position: options.position ?? 0,
    phrase: options.phrase ?? 'Прайс',
    normalizedPhrase: options.normalizedPhrase ?? 'прайс',
    rule: {
      id: ruleId,
      version: options.version ?? 3,
      matchInContext: options.matchInContext ?? false,
      fuzzyMatch: options.fuzzyMatch ?? false,
      currentContentRevisionId: options.currentContentRevisionId ?? 'content-1',
    },
  };
}

function harness(
  options: {
    duplicate?: boolean;
    queueFailure?: Error;
    admissionFailure?: Error;
    floodDecision?: PublisherAutoReplyFloodGateResult;
    floodFailure?: Error;
    floodReplayDecision?: PublisherAutoReplyFloodGateResult;
    floodReplayFailure?: Error;
    deliveryExists?: boolean;
    sourceFenceAdmit?: 'admitted' | 'canceled' | 'missing';
    sourceFenceRead?: 'admitted' | 'canceled' | 'missing';
    sourceFenceFailure?: Error;
    sourceReceiptStatus?: WebhookStatus;
    triggerRows?: ReturnType<typeof triggerRow>[];
    extendedMatchingMode?: 'off' | 'shadow' | 'on';
  } = {},
) {
  const delivery = {
    id: 'delivery-1',
    sourceWebhookEventId: 'webhook-source-1',
    status: PublisherAutoReplyDeliveryStatus.PENDING,
    dueAt: new Date('2026-08-29T12:00:01.500Z'),
    dispatchStartedAt: null,
  };
  const triggerRows = options.triggerRows ?? [triggerRow()];
  const deliveryModel = {
    createMany: jest.fn().mockResolvedValue({ count: options.duplicate ? 0 : 1 }),
    findUnique: jest.fn().mockResolvedValue(options.deliveryExists === false ? null : delivery),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const receipt: AdmissionReceipt = {
    status: options.sourceReceiptStatus ?? WebhookStatus.RECEIVED,
    errorMessage: null,
    legacyDispositionId: null,
    legacyDispositionReceiptId: null,
    sourceDispositionId: null,
    sourceDispositionReceiptId: null,
  };
  const queryRaw = jest.fn(async (): Promise<AdmissionReceipt[]> => [receipt]);
  const transaction = { publisherAutoReplyDelivery: deliveryModel, $queryRaw: queryRaw };
  const prisma = {
    $transaction: jest.fn(async (callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
    chat: {
      findFirst: jest.fn().mockResolvedValue({
        publisherSettings: {
          autoRepliesEnabled: true,
          autoReplyConfigRevision: 7,
          revision: 4,
        },
        publicationPolicy: { publikEnabled: true, revision: 2 },
      }),
    },
    publisherAutoReplyTrigger: {
      findMany: jest.fn().mockResolvedValue(triggerRows.slice(0, 201)),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { normalizedPhrase: string } }) =>
          Promise.resolve(
            triggerRows.find((row) => row.normalizedPhrase === where.normalizedPhrase) ?? null,
          ),
        ),
    },
    publisherAutoReplyRule: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
        const trigger = triggerRows.find((row) => row.ruleId === where.id);
        return Promise.resolve(
          trigger
            ? {
                id: trigger.rule.id,
                version: trigger.rule.version,
                currentContentRevisionId: trigger.rule.currentContentRevisionId,
              }
            : null,
        );
      }),
    },
    publisherAutoReplyDelivery: deliveryModel,
  };
  const queue = {
    assertNewDeliveryAdmissionEnabled: options.admissionFailure
      ? jest.fn().mockRejectedValue(options.admissionFailure)
      : jest.fn().mockResolvedValue(undefined),
    ensureDeliveryJob: jest
      .fn<
        ReturnType<PublisherAutoReplyQueueService['ensureDeliveryJob']>,
        Parameters<PublisherAutoReplyQueueService['ensureDeliveryJob']>
      >()
      .mockImplementation(async () => {
        if (options.queueFailure) throw options.queueFailure;
        return { outcome: 'add_acknowledged' };
      }),
  } satisfies Pick<
    PublisherAutoReplyQueueService,
    'assertNewDeliveryAdmissionEnabled' | 'ensureDeliveryJob'
  >;
  const floodGate = {
    reserve: options.floodFailure
      ? jest.fn().mockRejectedValue(options.floodFailure)
      : jest.fn().mockResolvedValue(options.floodDecision ?? { allowed: true, replayed: false }),
    replay: options.floodReplayFailure
      ? jest.fn().mockRejectedValue(options.floodReplayFailure)
      : jest
          .fn()
          .mockResolvedValue(
            options.floodReplayDecision ?? { allowed: false, reason: 'decision_missing' },
          ),
  };
  const sourceFence = {
    admit: options.sourceFenceFailure
      ? jest.fn().mockRejectedValue(options.sourceFenceFailure)
      : jest.fn().mockResolvedValue(options.sourceFenceAdmit ?? 'admitted'),
    read: options.sourceFenceFailure
      ? jest.fn().mockRejectedValue(options.sourceFenceFailure)
      : jest.fn().mockResolvedValue(options.sourceFenceRead ?? 'admitted'),
    cancel: options.sourceFenceFailure
      ? jest.fn().mockRejectedValue(options.sourceFenceFailure)
      : jest.fn().mockResolvedValue(undefined),
  };
  const service = new PublisherAutoReplyProducerService(
    prisma as never,
    queue as never,
    { isKnownBotUserId: jest.fn().mockReturnValue(false) } as never,
    floodGate as never,
    sourceFence as never,
    {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'MAX_PUBLISHER_BOT_ID') return 'publisher-bot';
        if (key === 'PUBLISHER_AUTO_REPLY_DELAY_MS') return 1_500;
        if (key === 'PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE') {
          return options.extendedMatchingMode ?? 'on';
        }
        return fallback;
      }),
    } as unknown as ConfigService,
  );
  return { service, prisma, queue, floodGate, sourceFence, delivery };
}

describe('PublisherAutoReplyProducerService', () => {
  it('freezes the matching epochs before enqueueing only the delivery id', async () => {
    const { service, prisma, queue, floodGate } = harness();
    await expect(service.observeWebhook(update(), 'webhook-1')).resolves.toEqual({
      matched: true,
      disposition: 'selected',
    });

    expect(prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: '-100',
          ruleId: 'rule-1',
          contentRevisionId: 'content-1',
          publisherBotId: 'publisher-bot',
          sourceMessageId: 'message-1',
          sourceUserId: 'user-1',
          matchedRuleVersion: 3,
          matchedNormalizedPhrase: 'прайс',
          matchedTriggerId: 'trigger-1',
          matchKind: PublisherAutoReplyMatchKind.EXACT_FULL,
          distance: 0,
          matcherVersion: 1,
          autoReplyConfigRevision: 7,
          publisherSettingsRevision: 4,
          publicationPolicyRevision: 2,
        }),
      ],
      skipDuplicates: true,
    });
    expect(queue.assertNewDeliveryAdmissionEnabled).toHaveBeenCalledTimes(1);
    expect(floodGate.reserve).toHaveBeenCalledWith({
      publisherBotId: 'publisher-bot',
      chatId: '-100',
      senderUserId: 'user-1',
      sourceMessageId: 'message-1',
    });
    expect(queue.assertNewDeliveryAdmissionEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      floodGate.reserve.mock.invocationCallOrder[0]!,
    );
    expect(floodGate.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.publisherAutoReplyDelivery.createMany.mock.invocationCallOrder[0]!,
    );
    expect(queue.ensureDeliveryJob).toHaveBeenCalledWith('delivery-1', expect.any(Date));
  });

  it('selects an exact alias and freezes the matched trigger identity', async () => {
    const { service, prisma } = harness({
      triggerRows: [
        triggerRow(),
        triggerRow({
          id: 'trigger-alias',
          position: 1,
          phrase: 'Стоимость',
          normalizedPhrase: 'стоимость',
        }),
      ],
    });

    await expect(
      service.observeWebhook(update('message_created', 'СТОИМОСТЬ'), 'webhook-alias-1'),
    ).resolves.toEqual({ matched: true, disposition: 'selected' });

    expect(prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            ruleId: 'rule-1',
            matchedTriggerId: 'trigger-alias',
            matchedNormalizedPhrase: 'стоимость',
            matchKind: PublisherAutoReplyMatchKind.EXACT_FULL,
            distance: 0,
          }),
        ],
      }),
    );
  });

  it('keeps exact matching available when a legacy chat exceeds the candidate budget', async () => {
    const triggerRows = Array.from({ length: 202 }, (_, index) =>
      triggerRow({
        id: `trigger-${index}`,
        ruleId: `rule-${index}`,
        phrase: index === 201 ? 'Нужный ответ' : `Фраза ${index}`,
        normalizedPhrase: index === 201 ? 'нужный ответ' : `фраза ${index}`,
      }),
    );
    const { service, prisma } = harness({ triggerRows });

    await expect(
      service.observeWebhook(update('message_created', 'НУЖНЫЙ ОТВЕТ'), 'webhook-over-budget-1'),
    ).resolves.toEqual({ matched: true, disposition: 'selected' });

    expect(prisma.publisherAutoReplyTrigger.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 201 }),
    );
    expect(prisma.publisherAutoReplyTrigger.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ normalizedPhrase: 'нужный ответ' }),
      }),
    );
    expect(prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            ruleId: 'rule-201',
            matchedTriggerId: 'trigger-201',
            matchedNormalizedPhrase: 'нужный ответ',
            matchKind: PublisherAutoReplyMatchKind.EXACT_FULL,
          }),
        ],
      }),
    );
  });

  it('refreshes the selected rule epoch while reusing the matcher configuration cache', async () => {
    const fixture = harness();
    fixture.prisma.publisherAutoReplyRule.findFirst
      .mockResolvedValueOnce({ id: 'rule-1', version: 3, currentContentRevisionId: 'content-1' })
      .mockResolvedValueOnce({ id: 'rule-1', version: 4, currentContentRevisionId: 'content-2' });

    await fixture.service.observeWebhook(update(), 'webhook-cache-1');
    const second = update();
    second.updateId = 'update-cache-2';
    second.message!.messageId = 'message-2';
    ((second.raw?.message as Record<string, unknown>).body as Record<string, unknown>).mid =
      'message-2';
    await fixture.service.observeWebhook(second, 'webhook-cache-2');

    expect(fixture.prisma.publisherAutoReplyTrigger.findMany).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.publisherAutoReplyRule.findFirst).toHaveBeenCalledTimes(2);
    expect(fixture.prisma.publisherAutoReplyDelivery.createMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: [
          expect.objectContaining({
            matchedRuleVersion: 4,
            contentRevisionId: 'content-2',
            sourceMessageId: 'message-2',
          }),
        ],
      }),
    );
  });

  it.each([
    {
      label: 'contains',
      message: 'Подскажите прайс, пожалуйста',
      row: triggerRow({ matchInContext: true }),
      matchKind: PublisherAutoReplyMatchKind.EXACT_CONTEXT,
      distance: 0,
    },
    {
      label: 'fuzzy',
      message: 'ПРАЙСС',
      row: triggerRow({ fuzzyMatch: true }),
      matchKind: PublisherAutoReplyMatchKind.FUZZY_FULL,
      distance: 1,
    },
  ])('selects a $label trigger through the extended matcher', async (example) => {
    const { service, prisma } = harness({ triggerRows: [example.row] });

    await expect(
      service.observeWebhook(
        update('message_created', example.message),
        `webhook-${example.label}`,
      ),
    ).resolves.toEqual({ matched: true, disposition: 'selected' });

    expect(prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            matchedTriggerId: 'trigger-1',
            matchKind: example.matchKind,
            distance: example.distance,
          }),
        ],
      }),
    );
  });

  it('returns an ambiguous disposition without reserving or enqueueing delivery work', async () => {
    const { service, prisma, queue, floodGate, sourceFence } = harness({
      triggerRows: [
        triggerRow({
          id: 'trigger-price',
          ruleId: 'rule-price',
          phrase: 'Цена',
          normalizedPhrase: 'цена',
          matchInContext: true,
        }),
        triggerRow({
          id: 'trigger-term',
          ruleId: 'rule-term',
          phrase: 'Срок',
          normalizedPhrase: 'срок',
          matchInContext: true,
        }),
      ],
    });

    await expect(
      service.observeWebhook(update('message_created', 'ЦЕНА СРОК'), 'webhook-ambiguous-1'),
    ).resolves.toEqual({ matched: true, disposition: 'ambiguous' });

    expect(queue.assertNewDeliveryAdmissionEnabled).not.toHaveBeenCalled();
    expect(floodGate.reserve).not.toHaveBeenCalled();
    expect(sourceFence.admit).not.toHaveBeenCalled();
    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
  });

  it('keeps an extended-only match as no_match in shadow mode', async () => {
    const { service, prisma, queue, floodGate } = harness({
      extendedMatchingMode: 'shadow',
      triggerRows: [triggerRow({ matchInContext: true })],
    });

    await expect(
      service.observeWebhook(
        update('message_created', 'Подскажите прайс, пожалуйста'),
        'webhook-shadow-1',
      ),
    ).resolves.toEqual({ matched: false, disposition: 'no_match' });

    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
    expect(queue.assertNewDeliveryAdmissionEnabled).not.toHaveBeenCalled();
    expect(floodGate.reserve).not.toHaveBeenCalled();
  });

  it('ensures the pending job again after a repeated canonical preparation claim', async () => {
    const { service, queue } = harness({ duplicate: true });
    await expect(service.observeWebhook(update(), 'webhook-repeated-1')).resolves.toEqual({
      matched: true,
      disposition: 'selected',
    });
    expect(queue.ensureDeliveryJob).toHaveBeenCalledTimes(1);
  });

  it('defers the webhook when a durable delivery cannot be confirmed in BullMQ', async () => {
    const { service } = harness({ queueFailure: new Error('redis unavailable') });
    await expect(
      service.observeWebhook(update(), 'webhook-queue-ambiguous-1'),
    ).rejects.toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);
  });

  it('defers a freshly admitted row when the final backlog claim loses the race', async () => {
    const { service, prisma } = harness({
      queueFailure: new PublisherAutoReplyAdmissionError('backlog_limit'),
    });

    await expect(
      service.observeWebhook(update(), 'webhook-final-backlog-1'),
    ).rejects.toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);

    expect(prisma.publisherAutoReplyDelivery.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    new PublisherAutoReplyAdmissionError('backlog_unavailable'),
    new PublisherAutoReplyAdmissionError('backlog_limit'),
  ])('defers an existing row after a temporary final quota failure: %s', async (queueFailure) => {
    const { service, prisma } = harness({ duplicate: true, queueFailure });

    await expect(
      service.observeWebhook(update(), 'webhook-existing-backlog-1'),
    ).rejects.toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);

    expect(prisma.publisherAutoReplyDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a replay-admitted row pending when the final backlog remains full', async () => {
    const { service, prisma } = harness({
      floodDecision: { allowed: true, replayed: true },
      queueFailure: new PublisherAutoReplyAdmissionError('backlog_limit'),
    });

    await expect(
      service.observeWebhook(update(), 'webhook-replayed-backlog-1'),
    ).rejects.toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);

    expect(prisma.publisherAutoReplyDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('defers an ambiguous flood-gate EVAL so its stored decision can replay', async () => {
    const { service, prisma } = harness({
      floodFailure: new Error('Publisher auto-reply flood-gate outcome is ambiguous'),
    });

    await expect(
      service.observeWebhook(update(), 'webhook-flood-ambiguous-1'),
    ).rejects.toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);
    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
  });

  it('materializes an ambiguous admission only after duplicate repair replays stored allow', async () => {
    const fixture = harness({
      floodFailure: new Error('Publisher auto-reply flood-gate outcome is ambiguous'),
      floodReplayDecision: { allowed: true, replayed: true },
    });
    fixture.prisma.publisherAutoReplyDelivery.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(fixture.delivery);

    await expect(
      fixture.service.observeWebhook(update(), 'webhook-flood-ambiguous-2'),
    ).rejects.toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);
    await expect(
      fixture.service.observeWebhook(update(), 'webhook-flood-ambiguous-2', {
        duplicateRepair: true,
      }),
    ).resolves.toEqual({ matched: true, disposition: 'selected' });

    expect(fixture.floodGate.reserve).toHaveBeenCalledTimes(1);
    expect(fixture.floodGate.replay).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ sourceWebhookEventId: 'webhook-flood-ambiguous-2' })],
      }),
    );
    expect(fixture.queue.ensureDeliveryJob).toHaveBeenCalledTimes(1);
  });

  it('suppresses a source canceled before admission without creating a delivery', async () => {
    const { service, prisma, queue } = harness({ sourceFenceAdmit: 'canceled' });

    await expect(service.observeWebhook(update(), 'webhook-source-canceled-1')).resolves.toEqual({
      matched: true,
      disposition: 'suppressed',
    });

    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
  });

  it('cancels a row when edit/removal wins between admission and enqueue', async () => {
    const { service, prisma, queue } = harness({ sourceFenceRead: 'canceled' });

    await expect(service.observeWebhook(update(), 'webhook-source-race-1')).resolves.toEqual({
      matched: true,
      disposition: 'suppressed',
    });

    expect(prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.publisherAutoReplyDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'delivery-1', dispatchStartedAt: null }),
        data: expect.objectContaining({
          status: PublisherAutoReplyDeliveryStatus.CANCELED,
          failureCode: 'SOURCE_CHANGED',
        }),
      }),
    );
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
  });

  it.each([
    { allowed: false, reason: 'user_burst' },
    { allowed: false, reason: 'chat_rolling' },
    { allowed: false, reason: 'unavailable' },
  ] as const)('suppresses $reason before creating a durable delivery', async (floodDecision) => {
    const { service, prisma, queue } = harness({ floodDecision });

    await expect(service.observeWebhook(update(), 'webhook-flood-denied-1')).resolves.toEqual({
      matched: true,
      disposition: 'suppressed',
    });

    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
    expect(prisma.publisherAutoReplyDelivery.findUnique).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
  });

  it.each(['backlog_limit', 'backlog_unavailable'] as const)(
    'persists and suppresses %s before the durable row',
    async (reason) => {
      const { service, prisma, queue, floodGate } = harness({
        admissionFailure: new PublisherAutoReplyAdmissionError(reason),
        floodDecision: { allowed: false, reason },
      });

      await expect(service.observeWebhook(update(), 'webhook-backlog-denied-1')).resolves.toEqual({
        matched: true,
        disposition: 'suppressed',
      });

      expect(floodGate.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ upstreamDenialReason: reason }),
      );
      expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
      expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    },
  );

  it('recovers a prior admitted source despite a later backlog denial', async () => {
    const { service, prisma, queue, floodGate } = harness({
      admissionFailure: new PublisherAutoReplyAdmissionError('backlog_limit'),
      floodDecision: { allowed: true, replayed: true },
    });

    await expect(service.observeWebhook(update(), 'webhook-backlog-replay-1')).resolves.toEqual({
      matched: true,
      disposition: 'selected',
    });

    expect(floodGate.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamDenialReason: 'backlog_limit' }),
    );
    expect(prisma.publisherAutoReplyDelivery.createMany).toHaveBeenCalledTimes(1);
    expect(queue.ensureDeliveryJob).toHaveBeenCalledTimes(1);
  });

  it('lets duplicate repair restore only an existing durable delivery', async () => {
    const { service, prisma, queue, floodGate } = harness();

    await expect(
      service.observeWebhook(update(), null, { duplicateRepair: true }),
    ).resolves.toEqual({ matched: true, disposition: 'selected' });

    expect(prisma.publisherAutoReplyDelivery.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId_sourceMessageId: { chatId: '-100', sourceMessageId: 'message-1' } },
      }),
    );
    expect(queue.ensureDeliveryJob).toHaveBeenCalledWith('delivery-1', expect.any(Date));
    expect(prisma.chat.findFirst).not.toHaveBeenCalled();
    expect(queue.assertNewDeliveryAdmissionEnabled).not.toHaveBeenCalled();
    expect(floodGate.reserve).not.toHaveBeenCalled();
    expect(floodGate.replay).not.toHaveBeenCalled();
    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
  });

  it('consumes a late duplicate without creating a delivery when no durable row exists', async () => {
    const { service, prisma, queue, floodGate } = harness({ deliveryExists: false });

    await expect(
      service.observeWebhook(update(), null, { duplicateRepair: true }),
    ).resolves.toEqual({ matched: true, disposition: 'suppressed' });

    expect(prisma.publisherAutoReplyDelivery.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
    expect(prisma.chat.findFirst).not.toHaveBeenCalled();
    expect(queue.assertNewDeliveryAdmissionEnabled).not.toHaveBeenCalled();
    expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    expect(floodGate.reserve).not.toHaveBeenCalled();
    expect(floodGate.replay).toHaveBeenCalledWith({
      publisherBotId: 'publisher-bot',
      chatId: '-100',
      senderUserId: 'user-1',
      sourceMessageId: 'message-1',
    });
  });

  it('defers duplicate repair when an existing durable delivery cannot be re-enqueued', async () => {
    const { service, prisma, floodGate } = harness({
      queueFailure: new Error('BullMQ ownership is unavailable'),
    });

    await expect(
      service.observeWebhook(update(), null, { duplicateRepair: true }),
    ).rejects.toBeInstanceOf(PublisherAutoReplyEnqueuePendingError);

    expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
    expect(floodGate.reserve).not.toHaveBeenCalled();
    expect(floodGate.replay).not.toHaveBeenCalled();
  });

  it('consumes an explicitly external-bot-authored group message before rule lookup', async () => {
    const { service, prisma, queue, floodGate } = harness();
    const externalBotUpdate = update();
    (externalBotUpdate.raw?.message as { sender: Record<string, unknown> }).sender = {
      user_id: 'external-bot-1',
      is_bot: true,
    };
    externalBotUpdate.message!.senderId = 'external-bot-1';

    await expect(service.observeWebhook(externalBotUpdate)).resolves.toEqual({
      matched: true,
      disposition: 'bot_authored',
    });

    expect(prisma.chat.findFirst).not.toHaveBeenCalled();
    expect(queue.assertNewDeliveryAdmissionEnabled).not.toHaveBeenCalled();
    expect(floodGate.reserve).not.toHaveBeenCalled();
  });

  it.each(['message_edited', 'message_removed'] as const)(
    'preserves delivery journals when %s belongs to a held receipt',
    async (type) => {
      const { service, prisma, queue } = harness({
        sourceFenceFailure: new PublisherAutoReplySourceReceiptHeldError(),
      });

      await expect(service.observeWebhook(update(type), 'webhook-held')).resolves.toEqual({
        matched: false,
        disposition: 'no_match',
      });

      expect(prisma.publisherAutoReplyDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.publisherAutoReplyDelivery.createMany).not.toHaveBeenCalled();
      expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
    },
  );

  it.each(['message_edited', 'message_removed'] as const)(
    'preserves the journal when %s closes after source cancellation returns',
    async (type) => {
      const { service, prisma, sourceFence } = harness({
        sourceReceiptStatus: WebhookStatus.NO_REPLAY_HELD,
      });
      await expect(service.observeWebhook(update(type), 'webhook-closed')).resolves.toEqual({
        matched: false,
        disposition: 'no_match',
      });
      expect(sourceFence.cancel).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.publisherAutoReplyDelivery.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['message_edited', 'message_removed'] as const)(
    'cancels an unsent delivery on %s without creating another one',
    async (type) => {
      const { service, prisma, queue, sourceFence } = harness();
      await expect(service.observeWebhook(update(type), `webhook-${type}`)).resolves.toEqual({
        matched: false,
        disposition: 'no_match',
      });
      expect(prisma.publisherAutoReplyDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            chatId: '-100',
            sourceMessageId: 'message-1',
            dispatchStartedAt: null,
          }),
          data: expect.objectContaining({
            status: PublisherAutoReplyDeliveryStatus.CANCELED,
            failureCode: type === 'message_edited' ? 'SOURCE_EDITED' : 'SOURCE_REMOVED',
          }),
        }),
      );
      expect(prisma.chat.findFirst).not.toHaveBeenCalled();
      expect(queue.ensureDeliveryJob).not.toHaveBeenCalled();
      expect(sourceFence.cancel).toHaveBeenCalledWith({
        publisherBotId: 'publisher-bot',
        chatId: '-100',
        sourceMessageId: 'message-1',
        sourceWebhookEventId: `webhook-${type}`,
      });
      expect(sourceFence.cancel.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.publisherAutoReplyDelivery.updateMany.mock.invocationCallOrder[0]!,
      );
    },
  );
});
