import { createHmac } from 'node:crypto';
import { decodeManagedPollListCursor, encodeManagedPollListCursor } from '@maxim/contracts/poll';
import { ConflictException } from '@nestjs/common';
import { ChatEntityType, ManagedPollStatus, ManagedPollVisibility } from '../prisma/prisma-client';
import { ManagedPollService } from './managed-poll.service';
import type { MaxClientService } from '../max/max-client.service';
import {
  MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
  markMaxPreDispatchGuardRejected,
} from '../max/max-action-pre-dispatch-guard';

const POLL_IDENTITY_SALT = '12345678901234567890123456789012';
const POLL_RENDER_FORMAT_VERSION = 7;
const VOTE_EVENT_HASH = createHmac('sha256', POLL_IDENTITY_SALT)
  .update('event:bot-1:update-1')
  .digest('hex');

function createService(
  options: {
    visibility?: ManagedPollVisibility;
    existingOptionId?: string | null;
    existingEvent?: boolean;
    lastEventAt?: Date | null;
    status?: ManagedPollStatus;
    lastRenderError?: string | null;
    lockedAt?: Date | null;
    lastError?: string | null;
    publicationMessageId?: string | null;
    publicationBotId?: string | null;
    lockToken?: string | null;
    renderRevision?: number;
    renderedRevision?: number;
    renderFormatVersion?: number;
    entityType?: ChatEntityType;
  } = {},
) {
  const poll = {
    id: 'poll-1',
    chatId: 'channel-1',
    actorUserId: 'admin-1',
    question: 'Что выбираем?',
    status: options.status ?? ManagedPollStatus.ACTIVE,
    visibility: options.visibility ?? ManagedPollVisibility.ANONYMOUS,
    identitySalt: POLL_IDENTITY_SALT,
    renderRevision: options.renderRevision ?? 0,
    renderedRevision: options.renderedRevision ?? 0,
    renderFormatVersion: options.renderFormatVersion ?? POLL_RENDER_FORMAT_VERSION,
    publicationMessageId:
      options.publicationMessageId === undefined ? 'message-1' : options.publicationMessageId,
    publicationBotId: options.publicationBotId === undefined ? 'bot-1' : options.publicationBotId,
    publicationUrl: null,
    publishedAt: new Date(),
    closedAt: null,
    lockedAt: options.lockedAt ?? null,
    lockToken:
      options.lockToken === undefined
        ? options.lockedAt
          ? 'publication-lock'
          : null
        : options.lockToken,
    lastError: options.lastError ?? null,
    lastRenderError: options.lastRenderError ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
    chat: { entityType: options.entityType ?? ChatEntityType.CHANNEL },
    options: [
      {
        id: 'option-1',
        pollId: 'poll-1',
        position: 0,
        text: 'Первый',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'option-2',
        pollId: 'poll-1',
        position: 1,
        text: 'Второй',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
    managedPoll: {
      findUnique: jest.fn().mockResolvedValue(poll),
      update: jest.fn().mockResolvedValue(poll),
    },
    managedPollVoter: {
      findUnique: jest.fn().mockResolvedValue(
        options.existingOptionId
          ? {
              id: 'voter-1',
              lastEventAt: options.lastEventAt ?? null,
              recentEventHashes: options.existingEvent ? [VOTE_EVENT_HASH] : [],
              vote: { optionId: options.existingOptionId },
            }
          : null,
      ),
      update: jest.fn().mockResolvedValue({ id: 'voter-1' }),
      upsert: jest.fn().mockResolvedValue({ id: 'voter-1' }),
    },
    managedPollVote: {
      upsert: jest.fn().mockResolvedValue({ id: 'vote-1' }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const service = new ManagedPollService(prisma as never, {} as never, {} as never, {} as never);
  return { service, tx };
}

const voteParams = {
  pollId: 'poll-1',
  optionId: 'option-1',
  chatId: 'channel-1',
  messageId: 'message-1',
  callbackBotId: 'bot-1',
  publicationToken: null,
  eventId: 'bot-1:update-1',
  eventAt: new Date('2026-07-10T10:00:00.000Z'),
  voter: {
    userId: 'user-42',
    displayName: 'Анна Иванова',
    username: 'anna',
  },
};

describe('ManagedPollService vote persistence', () => {
  it('stores only a keyed identity for anonymous poll votes', async () => {
    const { service, tx } = createService();

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    const create = tx.managedPollVoter.upsert.mock.calls[0]?.[0]?.create;
    expect(create).toEqual(
      expect.objectContaining({
        pollId: 'poll-1',
        userId: null,
        displayName: null,
        username: null,
      }),
    );
    expect(create.identityHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(create.identityHash).not.toContain(voteParams.voter.userId);
    expect(tx.managedPoll.update).toHaveBeenCalledWith({
      where: { id: 'poll-1' },
      data: { renderRevision: { increment: 1 } },
    });
  });

  it('stores display identity for open poll votes', async () => {
    const { service, tx } = createService({ visibility: ManagedPollVisibility.OPEN });

    await (service as any).recordVote(voteParams);
    expect(tx.managedPollVoter.upsert.mock.calls[0]?.[0]?.create).toEqual(
      expect.objectContaining({
        userId: 'user-42',
        displayName: 'Анна Иванова',
        username: 'anna',
      }),
    );
  });

  it('does not increment the render revision for the same selected option', async () => {
    const { service, tx } = createService({ existingOptionId: 'option-1' });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: false,
      pollId: 'poll-1',
      needsRender: false,
    });
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastEventAt: voteParams.eventAt,
          recentEventHashes: [VOTE_EVENT_HASH],
        }),
      }),
    );
    expect(tx.managedPollVote.upsert).not.toHaveBeenCalled();
  });

  it('does not replay an already committed callback over a newer vote', async () => {
    const { service, tx } = createService({
      existingOptionId: 'option-2',
      existingEvent: true,
      lastEventAt: new Date('2026-07-10T10:01:00.000Z'),
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: false,
      replayed: true,
      pollId: 'poll-1',
      needsRender: false,
    });
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVote.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.update).not.toHaveBeenCalled();
  });

  it('records but ignores a callback older than the latest voter event', async () => {
    const { service, tx } = createService({
      existingOptionId: 'option-2',
      lastEventAt: new Date('2026-07-10T10:01:00.000Z'),
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: false,
      replayed: true,
      pollId: 'poll-1',
      needsRender: false,
    });
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVote.upsert).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.update).toHaveBeenCalledWith({
      where: { id: 'voter-1' },
      data: {
        recentEventHashes: [VOTE_EVENT_HASH],
      },
    });
  });

  it('marks a closed poll for render repair only when the last render failed', async () => {
    const { service } = createService({
      status: ManagedPollStatus.CLOSED,
      lastRenderError: 'edit failed',
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'closed',
      pollId: 'poll-1',
      needsRender: true,
    });
  });

  it('marks a closed poll for repair when its rendered revision is stale', async () => {
    const { service } = createService({
      status: ManagedPollStatus.CLOSED,
      renderRevision: 3,
      renderedRevision: 2,
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'closed',
      pollId: 'poll-1',
      needsRender: true,
    });
  });

  it('marks a legacy-format publication for repair even when its revision is current', async () => {
    const { service, tx } = createService({
      existingOptionId: 'option-1',
      renderFormatVersion: 2,
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({
      kind: 'recorded',
      changed: false,
      pollId: 'poll-1',
      needsRender: true,
    });
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
  });

  it('does not mark an unpublished draft for render repair', () => {
    const { service } = createService({
      status: ManagedPollStatus.DRAFT,
      publicationMessageId: null,
      renderFormatVersion: 1,
      renderRevision: 2,
      renderedRevision: 1,
      lastRenderError: 'stale draft error',
    });

    expect(
      (service as any).pollNeedsRenderRepair({
        publicationMessageId: null,
        renderFormatVersion: 1,
        renderRevision: 2,
        renderedRevision: 1,
        lastRenderError: 'stale draft error',
      }),
    ).toBe(false);
  });

  it('recovers a claimed routed publication from a callback before the sender settles', async () => {
    const { service, tx } = createService({
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      lastError: null,
      publicationMessageId: null,
      publicationBotId: 'route-bot',
      renderFormatVersion: 1,
    });

    await expect(
      (service as any).recordVote({
        ...voteParams,
        callbackBotId: 'route-bot',
        publicationToken: 'publication-lock',
      }),
    ).resolves.toEqual({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    expect(tx.managedPoll.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'poll-1' },
        data: expect.objectContaining({
          status: ManagedPollStatus.ACTIVE,
          publicationMessageId: 'message-1',
          lockedAt: null,
          lastError: null,
        }),
      }),
    );
    expect(tx.managedPoll.update.mock.calls[0]?.[0]?.data).not.toHaveProperty(
      'renderFormatVersion',
    );
    expect(tx.managedPoll.update.mock.calls[0]?.[0]?.data).not.toHaveProperty('lockToken');
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RECOVER_CHANNEL_POLL_PUBLICATION' }),
      }),
    );
  });

  it('does not recover a claimed draft from a callback for a removed option', async () => {
    const { service, tx } = createService({
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      publicationMessageId: null,
      publicationBotId: 'route-bot',
    });

    await expect(
      (service as any).recordVote({
        ...voteParams,
        optionId: 'removed-option',
        callbackBotId: 'route-bot',
        publicationToken: 'publication-lock',
      }),
    ).resolves.toEqual({ kind: 'stale' });

    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
  });

  it('does not recover a new claim from an older publication callback', async () => {
    const { service, tx } = createService({
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      lockToken: 'new-publication-claim',
      publicationMessageId: null,
      publicationBotId: 'route-bot',
    });

    await expect(
      (service as any).recordVote({
        ...voteParams,
        callbackBotId: 'route-bot',
        publicationToken: 'old-publication-claim',
      }),
    ).resolves.toEqual({ kind: 'stale' });

    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
  });

  it('does not promote a draft that has no publication claim token', async () => {
    const { service, tx } = createService({
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      lockToken: null,
      lastError: 'Публикация требует ручной проверки.',
      publicationMessageId: null,
    });

    await expect((service as any).recordVote(voteParams)).resolves.toEqual({ kind: 'stale' });
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
  });

  it('records callback recovery as a chat poll for chat entities', async () => {
    const { service, tx } = createService({
      entityType: ChatEntityType.CHAT,
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      publicationMessageId: null,
      publicationBotId: 'route-bot',
    });

    await (service as any).recordVote({
      ...voteParams,
      callbackBotId: 'route-bot',
      publicationToken: 'publication-lock',
    });

    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RECOVER_CHAT_POLL_PUBLICATION' }),
      }),
    );
  });

  it('rejects a callback delivered to a different bot', async () => {
    const { service, tx } = createService();

    await expect(
      (service as any).recordVote({ ...voteParams, callbackBotId: 'bot-2' }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(tx.managedPollVoter.upsert).not.toHaveBeenCalled();
  });
});

describe('ManagedPollService callback rendering', () => {
  it('acknowledges a text poll with updated result buttons through the message response', async () => {
    const maxClient = {
      answerCallback: jest
        .fn<
          ReturnType<MaxClientService['answerCallback']>,
          Parameters<MaxClientService['answerCallback']>
        >()
        .mockResolvedValue(undefined),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    const recordVote = jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    const loadPollAggregate = jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'chat-1',
      chat: { entityType: ChatEntityType.CHAT },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      renderRevision: 2,
      imageCount: 0,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 1, percent: 100 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
      ],
    });
    const markRendered = jest.spyOn(service as any, 'markPollRendered').mockResolvedValue(true);

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'chat-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      undefined,
      expect.objectContaining({
        text: 'Текст администратора',
        messageId: 'message-1',
        options: expect.objectContaining({
          replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|', 'poll|v3|poll-1|'],
          buttons: [
            [
              {
                type: 'callback',
                text: 'Да  ██████████ 100%(1)',
                payload: 'poll|v2|poll-1|option-1',
              },
            ],
            [
              {
                type: 'callback',
                text: 'Нет  ░░░░░░░░░░ 0%(0)',
                payload: 'poll|v2|poll-1|option-2',
              },
            ],
          ],
        }),
      }),
      expect.objectContaining({
        botId: 'bot-1',
        trafficClass: 'critical',
        rateLimitEntityId: 'chat-1',
        boundObject: { kind: 'poll', id: 'poll-1' },
      }),
    );
    expect(markRendered).toHaveBeenCalledWith('poll-1', 2);
    expect(recordVote.mock.invocationCallOrder[0]).toBeLessThan(
      loadPollAggregate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('keeps callback results repairable when channel engagement lookup is inconclusive', async () => {
    const maxClient = { answerCallback: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      publicationUrl: 'https://max.ru/channel/message-1',
      renderRevision: 2,
      imageCount: 0,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 1, percent: 100 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
      ],
    });
    jest
      .spyOn(service as any, 'resolvePollChannelEngagement')
      .mockResolvedValue({ state: 'inconclusive' });
    const markRendered = jest.spyOn(service as any, 'markPollRendered').mockResolvedValue(true);
    const scheduleRepair = jest
      .spyOn(service as any, 'schedulePollRenderRepair')
      .mockImplementation(() => undefined);

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'channel-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      undefined,
      expect.objectContaining({
        messageId: 'message-1',
        options: expect.objectContaining({
          buttons: [
            [expect.objectContaining({ payload: 'poll|v2|poll-1|option-1' })],
            [expect.objectContaining({ payload: 'poll|v2|poll-1|option-2' })],
          ],
        }),
      }),
      expect.objectContaining({ botId: 'bot-1', trafficClass: 'critical' }),
    );
    expect(markRendered).not.toHaveBeenCalled();
    expect(scheduleRepair).toHaveBeenCalledWith('channel-1', 'poll-1');
  });

  it.each(['preparation', 'final guard'] as const)(
    'falls back to a notification and schedules repair when callback %s refuses dispatch',
    async (stage) => {
      const prepareError =
        stage === 'preparation'
          ? new Error('exact message lookup failed')
          : markMaxPreDispatchGuardRejected(
              new Error('authority changed'),
              MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
            );
      const maxClient = {
        answerCallback: jest
          .fn<
            ReturnType<MaxClientService['answerCallback']>,
            Parameters<MaxClientService['answerCallback']>
          >()
          .mockImplementationOnce(async (_callbackId, _notification, _edit, options) => {
            if (stage === 'final guard') await options?.onDispatchAttempt?.();
            throw prepareError;
          })
          .mockResolvedValueOnce(undefined),
      };
      const service = new ManagedPollService(
        {} as never,
        maxClient as never,
        {} as never,
        {} as never,
      );
      jest.spyOn(service as any, 'recordVote').mockResolvedValue({
        kind: 'recorded',
        changed: true,
        pollId: 'poll-1',
        needsRender: true,
      });
      jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
        id: 'poll-1',
        chatId: 'chat-1',
        chat: { entityType: ChatEntityType.CHAT },
        question: 'Текст администратора',
        questionFormat: 'plain',
        status: ManagedPollStatus.ACTIVE,
        publicationMessageId: 'message-1',
        publicationBotId: 'bot-1',
        renderRevision: 2,
        imageCount: 0,
        resultOptions: [
          { id: 'option-1', position: 0, text: 'Да', votes: 1, percent: 100 },
          { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
        ],
      });
      jest
        .spyOn(service as any, 'resolvePollChannelEngagement')
        .mockResolvedValue({ state: 'none' });
      const recordRenderError = jest
        .spyOn(service as any, 'recordPollRenderError')
        .mockResolvedValue(undefined);
      const scheduleRepair = jest
        .spyOn(service as any, 'schedulePollRenderRepair')
        .mockImplementation(() => undefined);
      const logger = (service as unknown as { logger: { warn: (...args: unknown[]) => void } })
        .logger;
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const render = jest.spyOn(service as any, 'renderPollPublication').mockResolvedValue(true);

      await expect(
        service.tryHandleCallback({
          updateId: 'update-1',
          botId: 'bot-1',
          message: { chatId: 'chat-1', messageId: 'message-1' },
          raw: {
            callback: {
              callback_id: 'callback-1',
              payload: 'poll|v2|poll-1|option-1',
              user: { user_id: 'user-1' },
            },
          },
        } as never),
      ).resolves.toBe(true);

      const firstOptions = maxClient.answerCallback.mock.calls[0]?.[3];
      expect(firstOptions?.onDispatchAttempt).toEqual(expect.any(Function));
      expect(maxClient.answerCallback).toHaveBeenNthCalledWith(
        2,
        'callback-1',
        'Голос учтён',
        undefined,
        expect.objectContaining({ botId: 'bot-1' }),
      );
      expect(recordRenderError).toHaveBeenCalledWith(
        'poll-1',
        2,
        'chat-1',
        'vote-callback-prepare',
        prepareError,
      );
      expect(scheduleRepair).toHaveBeenCalledWith('chat-1', 'poll-1');
      expect(warn).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
    },
  );

  it('treats callback failures after dispatch begins as ambiguous', async () => {
    const maxClient = {
      answerCallback: jest
        .fn<
          ReturnType<MaxClientService['answerCallback']>,
          Parameters<MaxClientService['answerCallback']>
        >()
        .mockImplementation(async (_callbackId, _notification, _edit, requestOptions) => {
          await requestOptions?.onDispatchAttempt?.();
          throw Object.assign(new Error('POST /answers timed out'), {
            code: 'ECONNABORTED',
            request: {},
          });
        }),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'chat-1',
      chat: { entityType: ChatEntityType.CHAT },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      renderRevision: 2,
      imageCount: 0,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 1, percent: 100 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
      ],
    });
    jest.spyOn(service as any, 'resolvePollChannelEngagement').mockResolvedValue({ state: 'none' });
    const recordRenderError = jest.spyOn(service as any, 'recordPollRenderError');
    const scheduleRepair = jest
      .spyOn(service as any, 'schedulePollRenderRepair')
      .mockImplementation(() => undefined);

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'chat-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(maxClient.answerCallback).toHaveBeenCalledTimes(1);
    expect(recordRenderError).not.toHaveBeenCalled();
    expect(scheduleRepair).toHaveBeenCalledWith('chat-1', 'poll-1');
  });

  it('bypasses channel signatures when acknowledging a callback with authored text', async () => {
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const maxClient = { answerCallback: jest.fn().mockResolvedValue(undefined) };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'x'.repeat(4_001),
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      channelPostSignatureService as never,
    );
    jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      renderRevision: 2,
      imageCount: 0,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 1, percent: 100 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
      ],
    });
    jest
      .spyOn(service as any, 'resolvePollChannelEngagement')
      .mockResolvedValue({ state: 'inconclusive' });
    const scheduleRepair = jest
      .spyOn(service as any, 'schedulePollRenderRepair')
      .mockImplementation(() => undefined);

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'channel-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      undefined,
      expect.objectContaining({
        text: 'Текст администратора',
        messageId: 'message-1',
      }),
      expect.objectContaining({ botId: 'bot-1', trafficClass: 'critical' }),
    );
    expect(channelPostSignatureService.preparePostText).not.toHaveBeenCalled();
    expect(prisma.managedPoll.updateMany).not.toHaveBeenCalled();
    expect(scheduleRepair).toHaveBeenCalledWith('channel-1', 'poll-1');
  });

  it('acknowledges an image poll callback without rewriting stable poll content', async () => {
    const maxClient = { answerCallback: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: false,
      replayed: true,
      pollId: 'poll-1',
      needsRender: false,
    });
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      publicationBotId: 'bot-1',
      renderRevision: 1,
      imageCount: 1,
      images: [],
    });
    const render = jest.spyOn(service as any, 'renderPollPublication').mockResolvedValue(true);

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'channel-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Голос учтён',
      undefined,
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(render).not.toHaveBeenCalled();
  });

  it('renders updated result buttons after a changed vote on an image poll', async () => {
    const maxClient = { answerCallback: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      publicationBotId: 'bot-1',
      renderRevision: 2,
      imageCount: 1,
      images: [],
    });
    const render = jest.spyOn(service as any, 'renderPollPublication').mockResolvedValue(true);

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'channel-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Голос учтён',
      undefined,
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(render).toHaveBeenCalledWith('channel-1', 'poll-1', 'vote-media');
  });

  it('persists a changed vote and schedules result repair when serialization is unavailable', async () => {
    const maxClient = { answerCallback: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'runPollRenderSerialized').mockResolvedValue(false);
    const recordVote = jest.spyOn(service as any, 'recordVote').mockResolvedValue({
      kind: 'recorded',
      changed: true,
      pollId: 'poll-1',
      needsRender: true,
    });
    const scheduleRepair = jest.spyOn(service as any, 'schedulePollRenderRepair');

    await expect(
      service.tryHandleCallback({
        updateId: 'update-1',
        botId: 'bot-1',
        message: { chatId: 'chat-1', messageId: 'message-1' },
        raw: {
          callback: {
            callback_id: 'callback-1',
            payload: 'poll|v2|poll-1|option-1',
            user: { user_id: 'user-1' },
          },
        },
      } as never),
    ).resolves.toBe(true);

    expect(recordVote).toHaveBeenCalledTimes(1);
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Голос учтён',
      undefined,
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(scheduleRepair).toHaveBeenCalledWith('chat-1', 'poll-1');
  });

  it('builds callback edits with authored question and compact result labels', async () => {
    const service = new ManagedPollService({} as never, {} as never, {} as never, {} as never);

    const edit = await (service as any).buildCallbackMessageEdit({
      id: 'poll-1',
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      publicationMessageId: 'message-1',
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 9, percent: 90 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 1, percent: 10 },
      ],
    });

    expect(edit.text).toBe('Текст администратора');
    expect(edit.messageId).toBe('message-1');
    expect(edit.options.replaceCallbackPayloadPrefixes).toEqual([
      'poll|v2|poll-1|',
      'poll|v3|poll-1|',
    ]);
    expect(edit.options.buttons.map((row: Array<{ text: string }>) => row[0]?.text)).toEqual([
      'Да  █████████░ 90%(9)',
      'Нет  █░░░░░░░░░ 10%(1)',
    ]);
    expect(edit.text).not.toMatch(/Опрос|голос|90|10| · /u);
  });

  it('renders active result buttons and commits the exact render revision and format', async () => {
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const maxClient = { editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'chat-1',
      chat: { entityType: ChatEntityType.CHAT },
      question: 'Кто кого',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 7, percent: 70 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 3, percent: 30 },
      ],
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      renderRevision: 4,
    });

    await expect(
      (service as any).renderPollPublication('chat-1', 'poll-1', 'background-repair'),
    ).resolves.toBe(true);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      'Кто кого',
      expect.objectContaining({
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|', 'poll|v3|poll-1|'],
        buttons: [
          [expect.objectContaining({ text: 'Да  ███████░░░ 70%(7)' })],
          [expect.objectContaining({ text: 'Нет  ███░░░░░░░ 30%(3)' })],
        ],
      }),
      expect.objectContaining({ botId: 'bot-1', trafficClass: 'background' }),
    );
    expect(prisma.managedPoll.updateMany).toHaveBeenCalledWith({
      where: { id: 'poll-1', renderRevision: 4 },
      data: {
        renderedRevision: 4,
        renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
        lastRenderError: null,
      },
    });
  });

  it('bypasses channel signatures when repairing a published poll', async () => {
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const maxClient = { editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined) };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'x'.repeat(4_001),
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      channelPostSignatureService as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Кто кого',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 7, percent: 70 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 3, percent: 30 },
      ],
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      renderRevision: 4,
    });
    jest.spyOn(service as any, 'resolvePollChannelEngagement').mockResolvedValue({ state: 'none' });

    await expect(
      (service as any).renderPollPublication('channel-1', 'poll-1', 'background-repair'),
    ).resolves.toBe(true);

    expect(channelPostSignatureService.preparePostText).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'message-1',
      'Кто кого',
      expect.objectContaining({
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|', 'poll|v3|poll-1|'],
      }),
      expect.objectContaining({ botId: 'bot-1', trafficClass: 'background' }),
    );
    expect(prisma.managedPoll.updateMany).toHaveBeenCalledWith({
      where: { id: 'poll-1', renderRevision: 4 },
      data: {
        renderedRevision: 4,
        renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
        lastRenderError: null,
      },
    });
  });

  it('does not let a stale render error overwrite a newer poll revision', async () => {
    const state = { renderRevision: 5, lastRenderError: null as string | null };
    const updateMany = jest.fn(
      async ({
        where,
        data,
      }: {
        where: { renderRevision: number };
        data: { lastRenderError: string };
      }) => {
        if (where.renderRevision !== state.renderRevision) {
          return { count: 0 };
        }
        state.lastRenderError = data.lastRenderError;
        return { count: 1 };
      },
    );
    const service = new ManagedPollService(
      { managedPoll: { updateMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (service as any).recordPollRenderError(
      'poll-1',
      4,
      'channel-1',
      'background-repair',
      new Error('stale failure'),
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'poll-1', renderRevision: 4 },
      data: { lastRenderError: 'stale failure' },
    });
    expect(state.lastRenderError).toBeNull();
  });

  it('puts an inconclusive background channel repair on cooldown without committing it', async () => {
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const maxClient = { editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Кто кого',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 7, percent: 70 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 3, percent: 30 },
      ],
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      publicationUrl: 'https://max.ru/channel/message-1',
      renderRevision: 4,
    });
    jest
      .spyOn(service as any, 'resolvePollChannelEngagement')
      .mockResolvedValue({ state: 'inconclusive' });
    const scheduleRepair = jest
      .spyOn(service as any, 'schedulePollRenderRepair')
      .mockImplementation(() => undefined);

    await expect(
      (service as any).renderPollPublication('channel-1', 'poll-1', 'background-repair'),
    ).resolves.toBe(false);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'message-1',
      'Кто кого',
      expect.objectContaining({
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|', 'poll|v3|poll-1|'],
        buttons: [
          [expect.objectContaining({ payload: 'poll|v2|poll-1|option-1' })],
          [expect.objectContaining({ payload: 'poll|v2|poll-1|option-2' })],
        ],
      }),
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(prisma.managedPoll.updateMany).toHaveBeenCalledWith({
      where: { id: 'poll-1', renderRevision: 4 },
      data: { lastRenderError: 'Не удалось подтвердить дополнительные кнопки канала.' },
    });
    expect(scheduleRepair).not.toHaveBeenCalled();
  });

  it('restores persisted channel engagement buttons during a format repair', async () => {
    const commentsButton = {
      type: 'link',
      text: '💬 Комментарии · 3',
      url: 'https://max.ru/bot-1?startapp=comments-thread-1',
    };
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: {
        findFirst: jest.fn().mockResolvedValue({
          payload: {
            messageId: 'message-1',
            threadId: 'thread-1',
            includeCommentsButton: true,
            includeSuggestButton: false,
            suggestionEntryMode: 'BOT',
            botId: 'bot-1',
          },
        }),
        count: jest.fn().mockResolvedValue(3),
      },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getExactChannelDialogButtonIdentities: jest
        .fn()
        .mockResolvedValue([{ chatId: 'channel-1', kind: 'comments', threadId: 'thread-1' }]),
    };
    const adminDialogLinkService = {
      buildChannelDialogButton: jest.fn().mockReturnValue(commentsButton),
    };
    const recordChannelPublicationEngagement = jest.fn().mockResolvedValue(undefined);
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      { recordChannelPublicationEngagement } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      adminDialogLinkService as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Кто кого',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 7, percent: 70 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 3, percent: 30 },
      ],
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      publicationUrl: 'https://max.ru/channel/message-1',
      renderRevision: 4,
      renderedRevision: 4,
    });

    await expect(
      (service as any).renderPollPublication('channel-1', 'poll-1', 'background-repair'),
    ).resolves.toBe(true);

    expect(adminDialogLinkService.buildChannelDialogButton).toHaveBeenCalledWith(
      'channel-1',
      'comments',
      'thread-1',
      '💬 Комментарии · 3',
      'bot-1',
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'message-1',
      'Кто кого',
      expect.objectContaining({
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|', 'poll|v3|poll-1|'],
        buttons: [
          [expect.objectContaining({ payload: 'poll|v2|poll-1|option-1' })],
          [expect.objectContaining({ payload: 'poll|v2|poll-1|option-2' })],
          [commentsButton],
        ],
      }),
      expect.objectContaining({ botId: 'bot-1', trafficClass: 'background' }),
    );
    expect(recordChannelPublicationEngagement).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'message-1',
        source: 'managed_poll',
      }),
    );
    expect(maxClient.getExactChannelDialogButtonIdentities).toHaveBeenCalledTimes(2);
  });

  it('recovers callback-crash engagement from the pre-vote publication ledger revision', async () => {
    const ledgerReference = {
      threadId: 'thread-ledger-callback',
      includeCommentsButton: true,
      includeSuggestButton: false,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
      botId: 'bot-1',
    };
    const findUnique = jest.fn().mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.jobId === 'managed-poll:publish:poll-1:revision:3:format:4'
          ? {
              metadata: {
                ledgerContext: {
                  managedPoll: { channelEngagement: ledgerReference },
                },
              },
            }
          : null,
      ),
    );
    const commentsButton = {
      type: 'link',
      text: '💬 Комментарии · 0',
      url: 'https://max.ru/bot-1',
    };
    const restoredContext = {
      buttons: [[commentsButton]],
      threadId: ledgerReference.threadId,
      includeCommentsButton: ledgerReference.includeCommentsButton,
      includeSuggestButton: ledgerReference.includeSuggestButton,
      suggestButtonText: ledgerReference.suggestButtonText,
      suggestionEntryMode: ledgerReference.suggestionEntryMode,
    };
    const adminDialogLinkService = {
      buildChannelDialogButton: jest.fn().mockReturnValue(commentsButton),
    };
    const service = new ManagedPollService(
      {
        auditLog: {
          findFirst: jest.fn().mockResolvedValue(null),
          count: jest.fn().mockResolvedValue(0),
        },
        maxActionLedgerEntry: { findUnique },
      } as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      adminDialogLinkService as never,
    );

    await expect(
      (service as any).resolvePollChannelEngagement(
        {
          id: 'poll-1',
          chatId: 'channel-1',
          chat: { entityType: ChatEntityType.CHANNEL },
          publicationMessageId: 'message-1',
          renderRevision: 4,
          renderedRevision: 0,
        },
        'bot-1',
      ),
    ).resolves.toEqual({ state: 'resolved', context: restoredContext, shouldRecord: true });

    expect(findUnique.mock.calls.map(([request]) => request.where.jobId)).toEqual([
      'managed-poll:publish:poll-1:revision:4:format:4',
      'managed-poll:publish:poll-1:revision:0:format:4',
      'managed-poll:publish:poll-1:revision:3:format:4',
    ]);
    expect(adminDialogLinkService.buildChannelDialogButton).toHaveBeenCalledWith(
      'channel-1',
      'comments',
      'thread-ledger-callback',
      '💬 Комментарии · 0',
      'bot-1',
    );
  });

  it('keeps an explicit no-engagement publication ledger result authoritative', async () => {
    const buildChannelPublicationEngagementContext = jest.fn().mockResolvedValue({
      buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://max.ru/entry-bot' }]],
      threadId: 'new-thread',
      includeCommentsButton: true,
      includeSuggestButton: false,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
    });
    const maxClient = {
      getExactChannelDialogButtonIdentities: jest.fn(),
    };
    const service = new ManagedPollService(
      {
        auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
        maxActionLedgerEntry: {
          findUnique: jest.fn().mockResolvedValue({
            metadata: {
              ledgerContext: {
                managedPoll: { channelEngagement: null },
              },
            },
          }),
        },
      } as never,
      maxClient as never,
      { buildChannelPublicationEngagementContext } as never,
      {} as never,
    );

    await expect(
      (service as any).resolvePollChannelEngagement(
        {
          id: 'poll-1',
          chatId: 'channel-1',
          chat: { entityType: ChatEntityType.CHANNEL },
          publicationMessageId: 'message-1',
          renderRevision: 4,
          renderedRevision: 4,
        },
        'bot-1',
      ),
    ).resolves.toEqual({ state: 'none' });

    expect(maxClient.getExactChannelDialogButtonIdentities).not.toHaveBeenCalled();
    expect(buildChannelPublicationEngagementContext).not.toHaveBeenCalled();
  });

  it('trusts a managed-poll engagement binding without repeating legacy exact verification', async () => {
    const commentsButton = {
      type: 'link',
      text: '💬 Комментарии · 4',
      url: 'https://max.ru/bot-1?startapp=trusted-thread',
    };
    const getExactChannelDialogButtonIdentities = jest.fn();
    const findUnique = jest.fn();
    const service = new ManagedPollService(
      {
        auditLog: {
          findFirst: jest.fn().mockResolvedValue({
            payload: {
              messageId: 'message-1',
              threadId: 'trusted-thread',
              includeCommentsButton: true,
              includeSuggestButton: false,
              suggestionEntryMode: 'BOT',
              source: 'managed_poll',
              botId: 'bot-1',
            },
          }),
          count: jest.fn().mockResolvedValue(4),
        },
        maxActionLedgerEntry: { findUnique },
      } as never,
      { getExactChannelDialogButtonIdentities } as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { buildChannelDialogButton: jest.fn().mockReturnValue(commentsButton) } as never,
    );

    await expect(
      (service as any).resolvePollChannelEngagement(
        {
          id: 'poll-1',
          chatId: 'channel-1',
          chat: { entityType: ChatEntityType.CHANNEL },
          publicationMessageId: 'message-1',
          renderRevision: 4,
          renderedRevision: 4,
        },
        'bot-1',
      ),
    ).resolves.toEqual({
      state: 'resolved',
      context: {
        buttons: [[commentsButton]],
        threadId: 'trusted-thread',
        includeCommentsButton: true,
        includeSuggestButton: false,
        suggestButtonText: null,
        suggestionEntryMode: 'BOT',
      },
      shouldRecord: false,
    });

    expect(getExactChannelDialogButtonIdentities).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('does not trust or rotate a persisted engagement after an inconclusive exact lookup', async () => {
    const buildChannelPublicationEngagementContext = jest.fn();
    const findUnique = jest.fn().mockResolvedValue({
      metadata: {
        ledgerContext: {
          managedPoll: {
            channelEngagement: {
              threadId: 'ledger-thread',
              includeCommentsButton: true,
              includeSuggestButton: false,
              suggestionEntryMode: 'BOT',
              botId: 'bot-1',
            },
          },
        },
      },
    });
    const service = new ManagedPollService(
      {
        auditLog: {
          findFirst: jest.fn().mockResolvedValue({
            payload: {
              messageId: 'message-1',
              threadId: 'stale-thread',
              includeCommentsButton: true,
              includeSuggestButton: false,
              suggestionEntryMode: 'BOT',
              botId: 'bot-1',
            },
          }),
        },
        maxActionLedgerEntry: { findUnique },
      } as never,
      {
        getExactChannelDialogButtonIdentities: jest
          .fn()
          .mockRejectedValue(new Error('temporary MAX read failure')),
      } as never,
      { buildChannelPublicationEngagementContext } as never,
      {} as never,
    );

    await expect(
      (service as any).resolvePollChannelEngagement(
        {
          id: 'poll-1',
          chatId: 'channel-1',
          chat: { entityType: ChatEntityType.CHANNEL },
          publicationMessageId: 'message-1',
          renderRevision: 4,
          renderedRevision: 4,
        },
        'bot-1',
      ),
    ).resolves.toEqual({ state: 'inconclusive' });

    expect(buildChannelPublicationEngagementContext).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('replaces a stale persisted binding with the thread exposed by the exact MAX message', async () => {
    const commentsButton = {
      type: 'link',
      text: '💬 Комментарии · 2',
      url: 'https://max.ru/bot-1?startapp=actual-thread',
    };
    const buildChannelPublicationEngagementContext = jest.fn().mockResolvedValue({
      buttons: [],
      threadId: 'unused-configured-thread',
      includeCommentsButton: true,
      includeSuggestButton: false,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
    });
    const getExactChannelDialogButtonIdentities = jest
      .fn()
      .mockResolvedValue([{ chatId: 'channel-1', kind: 'comments', threadId: 'actual-thread' }]);
    const findUnique = jest.fn().mockResolvedValue({
      metadata: {
        ledgerContext: {
          managedPoll: {
            channelEngagement: {
              threadId: 'ledger-thread',
              includeCommentsButton: true,
              includeSuggestButton: false,
              suggestionEntryMode: 'BOT',
              botId: 'bot-1',
            },
          },
        },
      },
    });
    const service = new ManagedPollService(
      {
        auditLog: {
          findFirst: jest.fn().mockResolvedValue({
            payload: {
              messageId: 'message-1',
              threadId: 'stale-thread',
              includeCommentsButton: true,
              includeSuggestButton: false,
              suggestionEntryMode: 'BOT',
              botId: 'bot-1',
            },
          }),
          count: jest.fn().mockResolvedValue(2),
        },
        maxActionLedgerEntry: { findUnique },
      } as never,
      { getExactChannelDialogButtonIdentities } as never,
      { buildChannelPublicationEngagementContext } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { buildChannelDialogButton: jest.fn().mockReturnValue(commentsButton) } as never,
    );

    await expect(
      (service as any).resolvePollChannelEngagement(
        {
          id: 'poll-1',
          chatId: 'channel-1',
          chat: { entityType: ChatEntityType.CHANNEL },
          publicationMessageId: 'message-1',
          renderRevision: 4,
          renderedRevision: 4,
        },
        'bot-1',
      ),
    ).resolves.toEqual({
      state: 'resolved',
      context: {
        buttons: [[commentsButton]],
        threadId: 'actual-thread',
        includeCommentsButton: true,
        includeSuggestButton: false,
        suggestButtonText: null,
        suggestionEntryMode: 'BOT',
      },
      shouldRecord: true,
    });

    expect(getExactChannelDialogButtonIdentities).toHaveBeenCalledTimes(1);
    expect(buildChannelPublicationEngagementContext).toHaveBeenCalledWith('channel-1', 'bot-1');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('records a restored engagement binding only when MAX exposes the same thread', async () => {
    const recordChannelPublicationEngagement = jest.fn();
    const getExactChannelDialogButtonIdentities = jest
      .fn()
      .mockResolvedValue([{ chatId: 'channel-1', kind: 'comments', threadId: 'existing-thread' }]);
    const service = new ManagedPollService(
      {} as never,
      { getExactChannelDialogButtonIdentities } as never,
      { recordChannelPublicationEngagement } as never,
      {} as never,
    );
    const context = {
      buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://max.ru/entry-bot' }]],
      threadId: 'new-thread',
      includeCommentsButton: true,
      includeSuggestButton: false,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
    };

    await (service as any).recordPollChannelEngagementSafely({
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      messageId: 'message-1',
      text: 'Вопрос',
      publishedUrl: null,
      context,
      botId: 'bot-1',
      verifyApplied: true,
    });
    expect(recordChannelPublicationEngagement).not.toHaveBeenCalled();

    getExactChannelDialogButtonIdentities.mockResolvedValueOnce([
      { chatId: 'channel-1', kind: 'comments', threadId: 'new-thread' },
    ]);
    await (service as any).recordPollChannelEngagementSafely({
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      messageId: 'message-1',
      text: 'Вопрос',
      publishedUrl: null,
      context,
      botId: 'bot-1',
      verifyApplied: true,
    });
    expect(recordChannelPublicationEngagement).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'message-1',
        context,
      }),
    );
  });

  it('closes a poll by removing only its callbacks without changing authored text', async () => {
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      getExactChannelDialogButtonIdentities: jest.fn().mockResolvedValue([]),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.CLOSED,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 3, percent: 75 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 1, percent: 25 },
      ],
      totalVotes: 4,
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      renderRevision: 2,
    });

    await expect(
      (service as any).renderPollPublication('channel-1', 'poll-1', 'close'),
    ).resolves.toBe(true);
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'channel-1',
      'message-1',
      'Текст администратора',
      { replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|', 'poll|v3|poll-1|'] },
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(prisma.managedPoll.updateMany).toHaveBeenCalledWith({
      where: { id: 'poll-1', renderRevision: 2 },
      data: {
        renderedRevision: 2,
        renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
        lastRenderError: null,
      },
    });
  });

  it('closes a stale active poll only after MAX confirms that its publication is absent', async () => {
    const tx = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      managedPoll: { updateMany: jest.fn() },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const missingError = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(missingError),
      getExactMessagePresence: jest.fn().mockResolvedValue('absent'),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      chatContextCache as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 0, percent: 0 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
      ],
      publicationMessageId: 'message-missing',
      publicationBotId: 'bot-1',
      publicationUrl: 'https://max.ru/channel/message-missing',
      renderRevision: 0,
    });

    await expect(
      (service as any).renderPollPublication('channel-1', 'poll-1', 'background-repair'),
    ).resolves.toBe(true);

    expect(maxClient.getExactMessagePresence).toHaveBeenCalledWith(
      'channel-1',
      'message-missing',
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        trafficClass: 'background',
        ignoreFailureMetricStatuses: [404],
      }),
    );
    expect(tx.managedPoll.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'poll-1',
        chatId: 'channel-1',
        status: ManagedPollStatus.ACTIVE,
        publicationMessageId: 'message-missing',
        renderRevision: 0,
      },
      data: expect.objectContaining({
        status: ManagedPollStatus.CLOSED,
        closedAt: expect.any(Date),
        publicationMessageId: null,
        publicationUrl: null,
        renderedRevision: 0,
        renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
        lastRenderError: null,
      }),
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'RECONCILE_MISSING_CHANNEL_POLL_PUBLICATION',
        payload: expect.objectContaining({
          pollId: 'poll-1',
          publicationMessageId: 'message-missing',
          previousStatus: ManagedPollStatus.ACTIVE,
        }),
      }),
    });
    expect(prisma.managedPoll.updateMany).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
  });

  it.each([
    [{ response: { status: 404 } }, 'access_ambiguous', 404],
    [{ response: { status: 403 } }, 'access_ambiguous', 403],
    [{ response: { status: 503 } }, 'upstream_5xx', 503],
    [{ code: 'ETIMEDOUT' }, 'timeout', null],
  ])(
    'keeps unknown poll presence pending and reports a bounded category',
    async (lookupError, kind, statusCode) => {
      const prisma = { managedPoll: { updateMany: jest.fn() }, $transaction: jest.fn() };
      const maxClient = {
        getExactMessagePresence: jest
          .fn()
          .mockRejectedValue({ ...lookupError, message: 'private remote body' }),
      };
      const service = new ManagedPollService(
        prisma as never,
        maxClient as never,
        {} as never,
        {} as never,
      );
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const poll = {
        id: 'poll-1',
        chatId: 'chat-1',
        publicationMessageId: 'message-1',
        publicationBotId: 'bot-1',
        renderRevision: 7,
      };
      expect(
        await (service as any).reconcileMissingPollPublication(poll, 'bot-1', 'chat', {
          response: { status: 404 },
        }),
      ).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.managedPoll.updateMany).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'exact_presence',
          outcome: 'unavailable',
          kind,
          statusCode,
        }),
        'Failed to verify missing managed poll publication',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private remote body');
    },
  );

  it('records terminal access loss from a missing-publication verification lookup', async () => {
    const lookupAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(lookupAttemptStartedAt);
    const missingError = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const lookupError = {
      response: {
        status: 403,
        data: { code: 'chat.denied', message: 'Bot cannot access chat' },
      },
    };
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(missingError),
      getExactMessagePresence: jest.fn().mockRejectedValue(lookupError),
    };
    const accessLoss = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        reason: 'bot_denied',
        recorded: { chatId: 'channel-1' },
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      {} as never,
      accessLoss as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      chat: { entityType: ChatEntityType.CHANNEL },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 0, percent: 0 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
      ],
      publicationMessageId: 'message-missing',
      publicationBotId: 'bot-1',
      publicationUrl: 'https://max.ru/channel/message-missing',
      renderRevision: 0,
    });

    try {
      await expect(
        (service as any).renderPollPublication('channel-1', 'poll-1', 'background-repair'),
      ).resolves.toBe(false);

      expect(accessLoss.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'channel-1',
        botId: 'bot-1',
        entityType: ChatEntityType.CHANNEL,
        source: 'managed_poll:lookup',
        operation: 'message_lookup',
        error: lookupError,
        lifecycleEventAt: lookupAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
      expect(prisma.managedPoll.updateMany).toHaveBeenCalledWith({
        where: { id: 'poll-1', renderRevision: 0 },
        data: { lastRenderError: 'Message not found' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not report reconciliation success when a newer poll revision wins the CAS', async () => {
    const tx = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      auditLog: { create: jest.fn() },
    };
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const missingError = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockRejectedValue(missingError),
      getExactMessagePresence: jest.fn().mockResolvedValue('absent'),
    };
    const chatContextCache = { invalidate: jest.fn() };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      {} as never,
      chatContextCache as never,
    );
    jest.spyOn(service as any, 'loadPollAggregate').mockResolvedValue({
      id: 'poll-1',
      chatId: 'chat-1',
      actorUserId: 'admin-1',
      chat: { entityType: ChatEntityType.CHAT },
      question: 'Текст администратора',
      questionFormat: 'plain',
      status: ManagedPollStatus.ACTIVE,
      resultOptions: [
        { id: 'option-1', position: 0, text: 'Да', votes: 0, percent: 0 },
        { id: 'option-2', position: 1, text: 'Нет', votes: 0, percent: 0 },
      ],
      publicationMessageId: 'message-missing',
      publicationBotId: 'bot-1',
      publicationUrl: null,
      renderRevision: 3,
    });

    await expect(
      (service as any).renderPollPublication('chat-1', 'poll-1', 'background-repair'),
    ).resolves.toBe(false);

    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
    expect(prisma.managedPoll.updateMany).toHaveBeenCalledWith({
      where: { id: 'poll-1', renderRevision: 3 },
      data: { lastRenderError: 'Message not found' },
    });
  });

  it('keeps raw poll images out of callback rendering reads', async () => {
    const now = new Date();
    const findFirst = jest.fn().mockResolvedValue({
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Вопрос',
      questionFormat: 'plain',
      imageCount: 1,
      status: ManagedPollStatus.ACTIVE,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 1,
      renderedRevision: 0,
      publicationMessageId: 'message-1',
      publicationBotId: 'bot-1',
      publicationUrl: null,
      publishedAt: now,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Да' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Нет' },
      ],
    });
    const service = new ManagedPollService(
      {
        managedPoll: { findFirst },
        managedPollVote: { groupBy: jest.fn().mockResolvedValue([]) },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (service as any).loadPollAggregate('channel-1', 'poll-1');

    const select = findFirst.mock.calls[0]?.[0]?.select;
    expect(select).toEqual(expect.objectContaining({ imageCount: true }));
    expect(select).not.toHaveProperty('images');
  });
});

describe('ManagedPollService creation', () => {
  it('rejects a Markdown question without visible text before opening a transaction', async () => {
    const prisma = { $transaction: jest.fn() };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      {} as never,
    );

    await expect(
      service.createChannelPoll('channel-1', { userId: 'admin-1' } as never, {
        question: '** **',
        questionFormat: 'markdown',
        options: [{ text: 'Да' }, { text: 'Нет' }],
      }),
    ).rejects.toThrow('Введите вопрос.');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a 2000-character Markdown question that exceeds the rendered MAX limit', async () => {
    const prisma = { $transaction: jest.fn() };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      {} as never,
    );

    await expect(
      service.createChannelPoll('channel-1', { userId: 'admin-1' } as never, {
        question: '&'.repeat(2_000),
        questionFormat: 'markdown',
        options: [{ text: 'Да' }, { text: 'Нет' }],
      }),
    ).rejects.toThrow('Вопрос после форматирования слишком длинный');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates two independent polls in the same chat', async () => {
    const now = new Date('2026-08-11T10:00:00.000Z');
    const buildPoll = (id: string, question: string) => ({
      id,
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question,
      questionFormat: 'plain',
      imageCount: 0,
      images: [],
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: POLL_IDENTITY_SALT,
      renderRevision: 0,
      renderedRevision: 0,
      renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        {
          id: `${id}-option-1`,
          pollId: id,
          position: 0,
          text: 'Да',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: `${id}-option-2`,
          pollId: id,
          position: 1,
          text: 'Нет',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    const create = jest
      .fn()
      .mockResolvedValueOnce(buildPoll('poll-1', 'Первый вопрос?'))
      .mockResolvedValueOnce(buildPoll('poll-2', 'Второй вопрос?'));
    const tx = {
      managedPoll: { create },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      chatContextCache as never,
    );
    const request = (question: string) => ({
      question,
      options: [{ text: 'Да' }, { text: 'Нет' }],
    });

    const first = await service.createChannelPoll(
      'channel-1',
      { userId: 'admin-1' } as never,
      request('Первый вопрос?'),
    );
    const second = await service.createChannelPoll(
      'channel-1',
      { userId: 'admin-1' } as never,
      request('Второй вопрос?'),
    );

    expect([first.id, second.id]).toEqual(['poll-1', 'poll-2']);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map(([call]) => call.data.question)).toEqual([
      'Первый вопрос?',
      'Второй вопрос?',
    ]);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(2);
    expect(chatContextCache.invalidate).toHaveBeenCalledTimes(2);
  });
});

describe('ManagedPollService draft editing', () => {
  it.each(['omitted', 'equal', 'changed', 'cleared', 'renamed'] as const)(
    'preserves draft fields and writes images only when %s media changes',
    async (mediaCase) => {
      const now = new Date();
      const images = [
        {
          base64: Buffer.from('draft-image').toString('base64'),
          mimeType: 'image/jpeg',
          fileName: 'draft.jpg',
        },
      ];
      const requestedImages =
        mediaCase === 'omitted'
          ? undefined
          : mediaCase === 'cleared'
            ? []
            : images.map((image) => ({
                ...image,
                ...(mediaCase === 'changed'
                  ? { base64: Buffer.from('replacement-image').toString('base64') }
                  : {}),
                ...(mediaCase === 'renamed' ? { fileName: 'replacement.jpg' } : {}),
              }));
      const expectedImages = requestedImages ?? images;
      const poll = {
        id: 'poll-1',
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        question: '**Старый вопрос**',
        questionFormat: 'markdown',
        imageCount: 1,
        images,
        status: ManagedPollStatus.DRAFT,
        visibility: ManagedPollVisibility.OPEN,
        identitySalt: POLL_IDENTITY_SALT,
        renderRevision: 0,
        renderedRevision: 0,
        publicationMessageId: null,
        publicationBotId: null,
        publicationUrl: null,
        publishedAt: null,
        closedAt: null,
        lockedAt: null,
        lockToken: null,
        lastError: null,
        lastRenderError: null,
        createdAt: now,
        updatedAt: now,
        options: [
          {
            id: 'option-1',
            pollId: 'poll-1',
            position: 0,
            text: 'Да',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'option-2',
            pollId: 'poll-1',
            position: 1,
            text: 'Нет',
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
        managedPoll: {
          findFirst: jest.fn().mockResolvedValue(poll),
          update: jest.fn().mockImplementation(async ({ data }) => {
            Object.assign(poll, data, { renderRevision: 1 });
            return poll;
          }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(poll),
        },
        managedPollOption: {
          deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
          createMany: jest.fn().mockResolvedValue({ count: 2 }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
      };
      const service = new ManagedPollService(
        {
          $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
        } as never,
        {} as never,
        { assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined) } as never,
        { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      );

      const result = await service.updateChannelPoll(
        'channel-1',
        'poll-1',
        { userId: 'admin-1' } as never,
        {
          question: 'Новый вопрос',
          expectedUpdatedAt: now.toISOString(),
          ...(requestedImages ? { images: requestedImages } : {}),
          options: [
            { id: 'option-1', text: 'Да' },
            { id: 'option-2', text: 'Нет' },
          ],
        },
      );

      expect(tx.managedPoll.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            questionFormat: 'markdown',
            visibility: ManagedPollVisibility.OPEN,
            imageCount: expectedImages.length,
            renderRevision: { increment: 1 },
          }),
        }),
      );
      const updatedData = tx.managedPoll.update.mock.calls[0]?.[0]?.data;
      if (mediaCase === 'omitted' || mediaCase === 'equal') {
        expect(updatedData).not.toHaveProperty('images');
      } else {
        expect(updatedData.images).toEqual(expectedImages);
      }
      expect(result.images).toEqual(expectedImages);
      expect(poll.renderRevision).toBe(1);
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ visibility: ManagedPollVisibility.OPEN }),
        }),
      });
    },
  );

  it('rejects a stale revision under the row lock before mutating poll options', async () => {
    const updatedAt = new Date('2026-08-19T10:00:00.000Z');
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      status: ManagedPollStatus.DRAFT,
      lockedAt: null,
      updatedAt,
      options: [],
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn(),
      },
      managedPollOption: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      auditLog: { create: jest.fn() },
    };
    const chatContextCache = { invalidate: jest.fn() };
    const service = new ManagedPollService(
      {
        $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      } as never,
      {} as never,
      { assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined) } as never,
      chatContextCache as never,
    );

    let conflict: unknown;
    try {
      await service.updateChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never, {
        question: 'Локальный вопрос',
        expectedUpdatedAt: '2026-08-19T09:59:59.000Z',
        options: [{ text: 'Да' }, { text: 'Нет' }],
      });
    } catch (error: unknown) {
      conflict = error;
    }

    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getStatus()).toBe(409);
    expect((conflict as ConflictException).message).toBe(
      'Черновик опроса уже изменён. Обновите экран.',
    );
    expect(tx.$queryRaw.mock.calls[0]?.[0]?.join(' ')).toContain('FOR UPDATE');
    expect(tx.managedPollOption.deleteMany).not.toHaveBeenCalled();
    expect(tx.managedPollOption.createMany).not.toHaveBeenCalled();
    expect(tx.managedPoll.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });
});

describe('ManagedPollService render serialization', () => {
  it('defers rendering instead of using an unsafe local lock when Redis fails', async () => {
    const redisCounter = {
      acquireLock: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      releaseLock: jest.fn(),
    };
    const service = new ManagedPollService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      redisCounter as never,
    );
    const operation = jest.fn().mockResolvedValue(undefined);

    await expect((service as any).runPollRenderSerialized('poll-1', operation)).resolves.toBe(
      false,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(redisCounter.releaseLock).not.toHaveBeenCalled();
  });

  it('defers rendering when the distributed lock stays busy', async () => {
    jest.useFakeTimers();
    try {
      const redisCounter = {
        acquireLock: jest.fn().mockResolvedValue(null),
        releaseLock: jest.fn(),
      };
      const service = new ManagedPollService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        redisCounter as never,
      );
      const operation = jest.fn().mockResolvedValue(undefined);

      const result = (service as any).runPollRenderSerialized('poll-1', operation);
      await jest.advanceTimersByTimeAsync(4_100);

      await expect(result).resolves.toBe(false);
      expect(redisCounter.acquireLock).toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(redisCounter.releaseLock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases the distributed lock when rendering fails', async () => {
    const redisCounter = {
      acquireLock: jest.fn().mockResolvedValue('lock-token'),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedPollService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      redisCounter as never,
    );
    const operation = jest.fn().mockRejectedValue(new Error('render failed'));

    await expect((service as any).runPollRenderSerialized('poll-1', operation)).rejects.toThrow(
      'render failed',
    );
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(
      'managed-poll:render:v1:poll-1',
      'lock-token',
    );
  });

  it('renews the distributed lock while a render is still running', async () => {
    jest.useFakeTimers();
    try {
      let finishOperation: () => void = () => undefined;
      const redisCounter = {
        acquireLock: jest.fn().mockResolvedValue('lock-token'),
        renewLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      };
      const service = new ManagedPollService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        redisCounter as never,
      );
      const operation = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finishOperation = resolve;
          }),
      );

      const result = (service as any).runPollRenderSerialized('poll-1', operation);
      await jest.advanceTimersByTimeAsync(30_000);

      expect(redisCounter.renewLock).toHaveBeenCalledWith(
        'managed-poll:render:v1:poll-1',
        'lock-token',
        120_000,
      );
      finishOperation();
      await expect(result).resolves.toBe(true);
      expect(redisCounter.releaseLock).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a coalesced repair when MAX rendering reports failure', async () => {
    jest.useFakeTimers();
    try {
      const service = new ManagedPollService({} as never, {} as never, {} as never, {} as never);
      jest
        .spyOn(service as any, 'runPollRenderSerialized')
        .mockImplementation(async (...args: unknown[]) => {
          const operation = args[1] as () => Promise<unknown>;
          await operation();
          return true;
        });
      const render = jest
        .spyOn(service as any, 'renderPollPublication')
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      (service as any).schedulePollRenderRepair('channel-1', 'poll-1');
      const repair = (service as any).scheduledRenderRepairs.get('poll-1');
      await jest.runAllTimersAsync();
      await repair;

      expect(render).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ManagedPollService publication', () => {
  it('reloads the claimed draft before sending it to MAX', async () => {
    const basePoll = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Старый вопрос',
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'old-1', pollId: 'poll-1', position: 0, text: 'Старый 1' },
        { id: 'old-2', pollId: 'poll-1', position: 1, text: 'Старый 2' },
      ],
    };
    const claimedPoll = {
      ...basePoll,
      question: 'Новый вопрос',
      options: [
        { id: 'new-1', pollId: 'poll-1', position: 0, text: 'Новый 1' },
        { id: 'new-2', pollId: 'poll-1', position: 1, text: 'Новый 2' },
      ],
    };
    const managedPoll = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(claimedPoll),
    };
    const auditLog = { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const prisma = {
      managedPoll,
      auditLog,
      $transaction: jest.fn(
        async (
          callback: (client: {
            managedPoll: typeof managedPoll;
            auditLog: typeof auditLog;
          }) => unknown,
        ) => callback({ managedPoll, auditLog }),
      ),
    };
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'message-1',
        url: 'https://max.ru/channel/message-1',
      }),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChannelPollBotId: jest.fn().mockResolvedValue('bot-1'),
      buildChannelPublicationEngagementContext: jest.fn().mockResolvedValue({
        buttons: [],
        threadId: null,
        includeCommentsButton: false,
        includeSuggestButton: false,
        suggestButtonText: null,
        suggestionEntryMode: 'BOT',
      }),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const channelPostSignatureService = {
      preparePostText: jest.fn().mockResolvedValue({
        text: 'Новый вопрос\n\nПодпись канала',
        textFormat: 'html',
        signatureApplied: true,
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      chatContextCache as never,
      undefined,
      undefined,
      undefined,
      channelPostSignatureService as never,
    );
    jest
      .spyOn(service as any, 'findPoll')
      .mockResolvedValueOnce(basePoll)
      .mockResolvedValueOnce(claimedPoll);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Новый вопрос',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: 'Новый 1  ░░░░░░░░░░ 0%(0)',
              payload: expect.stringMatching(/^poll\|v3\|poll-1\|[0-9a-f-]{36}\|new-1$/u),
            }),
          ],
          [expect.objectContaining({ text: 'Новый 2  ░░░░░░░░░░ 0%(0)' })],
        ],
      }),
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[1]).not.toContain(
      'Старый вопрос',
    );
    expect(channelPostSignatureService.preparePostText).not.toHaveBeenCalled();
    expect(managedPoll.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'poll-1',
          lockToken: expect.any(String),
          status: ManagedPollStatus.DRAFT,
        }),
        data: expect.objectContaining({
          renderedRevision: 0,
          renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
        }),
      }),
    );
  });

  it('uploads poll images and publishes authored HTML under a format-versioned dispatch key', async () => {
    const draft = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: '**Новый вопрос**',
      questionFormat: 'markdown',
      imageCount: 1,
      images: [
        {
          base64: `data:image/jpeg;base64,${Buffer.from('poll-image').toString('base64')}`,
          mimeType: 'image/jpeg',
          fileName: 'poll.jpg',
        },
      ],
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Второй' },
      ],
    };
    const managedPoll = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(draft),
    };
    const auditLog = { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const prisma = {
      managedPoll,
      auditLog,
      $transaction: jest.fn(
        async (
          callback: (client: {
            managedPoll: typeof managedPoll;
            auditLog: typeof auditLog;
          }) => unknown,
        ) => callback({ managedPoll, auditLog }),
      ),
    };
    const maxClient = {
      uploadImage: jest.fn().mockResolvedValue({ token: 'poll-image-token' }),
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChannelPollBotId: jest.fn().mockResolvedValue('bot-1'),
      buildChannelPublicationEngagementContext: jest.fn().mockResolvedValue({
        buttons: [
          [{ type: 'link', text: 'Комментарии', url: 'https://example.com/comments' }],
          [{ type: 'link', text: 'Предложить', url: 'https://example.com/suggest' }],
        ],
        threadId: 'thread-1',
        includeCommentsButton: true,
        includeSuggestButton: true,
        suggestButtonText: 'Предложить',
        suggestionEntryMode: 'BOT',
      }),
      recordChannelPublicationEngagement: jest.fn().mockResolvedValue(undefined),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const publicationToken = String(request.logicalIdempotencyKey).match(
          /^managed-poll:publish:poll-1:attempt:([0-9a-f-]{36}):revision:0:format:4$/u,
        )?.[1];
        expect(publicationToken).toBeDefined();
        const prepared = await request.prepareAttempt({ botId: 'bot-2', job: {} });
        await request.onDispatchAttempt({ botId: 'bot-2', job: { options: prepared.options } });
        expect(prepared.options).toEqual(
          expect.objectContaining({
            textFormat: 'html',
            imagePayload: { token: 'poll-image-token' },
            buttons: [
              [
                expect.objectContaining({
                  payload: `poll|v3|poll-1|${publicationToken}|option-1`,
                }),
              ],
              [
                expect.objectContaining({
                  payload: `poll|v3|poll-1|${publicationToken}|option-2`,
                }),
              ],
              [{ type: 'link', text: 'Комментарии', url: 'https://example.com/comments' }],
              [{ type: 'link', text: 'Предложить', url: 'https://example.com/suggest' }],
            ],
          }),
        );
        expect(prepared.ledgerContext).toEqual({
          managedPoll: {
            renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
            channelEngagement: {
              threadId: 'thread-1',
              includeCommentsButton: true,
              includeSuggestButton: true,
              suggestButtonText: 'Предложить',
              suggestionEntryMode: 'BOT',
              botId: 'bot-2',
            },
          },
        });
        return {
          messageId: 'message-1',
          url: 'https://max.ru/channel/message-1',
          botId: 'bot-2',
          candidateBotIds: ['bot-1', 'bot-2'],
          routingVersion: 4,
        };
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    jest.spyOn(service as any, 'findPoll').mockResolvedValue(draft);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never);

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from('poll-image'),
      'poll.jpg',
      'image/jpeg',
      expect.objectContaining({
        botId: 'bot-2',
        sourceTag: 'managed_poll',
      }),
    );
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'channel-1',
        logicalIdempotencyKey: expect.stringMatching(
          /^managed-poll:publish:poll-1:attempt:[0-9a-f-]{36}:revision:0:format:4$/u,
        ),
        routePurpose: 'channel_poll',
        text: '<strong>Новый вопрос</strong>',
        options: expect.objectContaining({
          buttons: [
            [expect.objectContaining({ text: 'Первый  ░░░░░░░░░░ 0%(0)' })],
            [expect.objectContaining({ text: 'Второй  ░░░░░░░░░░ 0%(0)' })],
          ],
        }),
      }),
    );
    expect(adminService.resolveChannelPollBotId).not.toHaveBeenCalled();
    expect(adminService.buildChannelPublicationEngagementContext).toHaveBeenCalledWith(
      'channel-1',
      'bot-2',
    );
    expect(adminService.recordChannelPublicationEngagement).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        messageId: 'message-1',
        text: '**Новый вопрос**',
        source: 'managed_poll',
        botId: 'bot-2',
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(managedPoll.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ images: [], publicationBotId: 'bot-2' }),
      }),
    );
  });

  it('recovers the exact engagement binding when routed publication completes from its ledger', async () => {
    const draft = {
      id: 'poll-ledger-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Какой вариант?',
      questionFormat: 'plain',
      imageCount: 0,
      images: [],
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 2,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-ledger-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-ledger-1', position: 1, text: 'Второй' },
      ],
    };
    const managedPoll = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue(draft),
    };
    const auditLog = {
      create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      count: jest.fn().mockResolvedValue(0),
    };
    const prisma = {
      managedPoll,
      auditLog,
      maxActionLedgerEntry: {
        findUnique: jest.fn().mockResolvedValue({
          metadata: {
            ledgerContext: {
              managedPoll: {
                renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
                channelEngagement: {
                  threadId: 'thread-ledger-1',
                  includeCommentsButton: true,
                  includeSuggestButton: false,
                  suggestButtonText: null,
                  suggestionEntryMode: 'BOT',
                  botId: 'bot-ledger-1',
                },
              },
            },
          },
        }),
      },
      $transaction: jest.fn(
        async (
          callback: (client: {
            managedPoll: typeof managedPoll;
            auditLog: typeof auditLog;
          }) => unknown,
        ) => callback({ managedPoll, auditLog }),
      ),
    };
    const restoredContext = {
      buttons: [
        [
          {
            type: 'link',
            text: '💬 Комментарии · 0',
            url: 'https://max.ru/bot-ledger-1?startapp=thread-ledger-1',
          },
        ],
      ],
      threadId: 'thread-ledger-1',
      includeCommentsButton: true,
      includeSuggestButton: false,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      recordChannelPublicationEngagement: jest.fn().mockResolvedValue(undefined),
    };
    const adminDialogLinkService = {
      buildChannelDialogButton: jest.fn().mockReturnValue(restoredContext.buttons[0][0]),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockResolvedValue({
        messageId: 'message-ledger-1',
        url: 'https://max.ru/channel/message-ledger-1',
        botId: 'bot-ledger-1',
        candidateBotIds: ['bot-ledger-1'],
        routingVersion: 4,
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
      undefined,
      adminDialogLinkService as never,
    );
    jest.spyOn(service as any, 'findPoll').mockResolvedValue(draft);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: draft.id });
    const scheduleRepair = jest
      .spyOn(service as any, 'schedulePollRenderRepair')
      .mockImplementation(() => undefined);

    await service.publishChannelPoll('channel-1', draft.id, {
      userId: 'admin-1',
    } as never);

    expect(prisma.maxActionLedgerEntry.findUnique).toHaveBeenCalledWith({
      where: {
        jobId: expect.stringMatching(
          /^managed-poll:publish:poll-ledger-1:attempt:[0-9a-f-]{36}:revision:2:format:4$/u,
        ),
      },
      select: { metadata: true },
    });
    expect(adminDialogLinkService.buildChannelDialogButton).toHaveBeenCalledWith(
      'channel-1',
      'comments',
      'thread-ledger-1',
      '💬 Комментарии · 0',
      'bot-ledger-1',
    );
    expect(adminService.recordChannelPublicationEngagement).toHaveBeenCalledWith({
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      messageId: 'message-ledger-1',
      text: 'Какой вариант?',
      publishedUrl: 'https://max.ru/channel/message-ledger-1',
      context: restoredContext,
      source: 'managed_poll',
      botId: 'bot-ledger-1',
    });
    expect(managedPoll.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
        }),
      }),
    );
    expect(scheduleRepair).not.toHaveBeenCalled();
  });

  it('keeps a completed pre-context v4 publication repairable after ledger recovery', async () => {
    const draft = {
      id: 'poll-legacy-ledger-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Старый опубликованный вопрос',
      questionFormat: 'plain',
      imageCount: 0,
      images: [],
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: POLL_IDENTITY_SALT,
      renderRevision: 2,
      renderedRevision: 0,
      renderFormatVersion: 4,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-legacy-ledger-1', position: 0, text: 'Да' },
        { id: 'option-2', pollId: 'poll-legacy-ledger-1', position: 1, text: 'Нет' },
      ],
    };
    const managedPoll = {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const auditLog = { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
    const maxActionLedgerEntry = {
      findUnique: jest.fn().mockResolvedValue({
        metadata: {
          ledgerContext: {
            managedPoll: {
              channelEngagement: {
                threadId: 'thread-legacy-ledger-1',
                includeCommentsButton: true,
                includeSuggestButton: false,
                suggestButtonText: null,
                suggestionEntryMode: 'BOT',
                botId: 'bot-legacy-1',
              },
            },
          },
        },
      }),
    };
    const prisma = {
      managedPoll,
      auditLog,
      maxActionLedgerEntry,
      $transaction: jest.fn(
        async (
          callback: (client: {
            managedPoll: typeof managedPoll;
            auditLog: typeof auditLog;
          }) => unknown,
        ) => callback({ managedPoll, auditLog }),
      ),
    };
    const buildChannelPublicationEngagementContext = jest.fn();
    const recordChannelPublicationEngagement = jest.fn();
    const adminDialogLinkService = {
      buildChannelDialogButton: jest.fn().mockReturnValue({
        type: 'link',
        text: '💬 Комментарии · 0',
        url: 'https://max.ru/bot-legacy-1?startapp=thread-legacy-ledger-1',
      }),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockResolvedValue({
        messageId: 'message-v4-recovered-1',
        url: 'https://max.ru/channel/message-v4-recovered-1',
        botId: 'bot-legacy-1',
        candidateBotIds: ['bot-legacy-1'],
        routingVersion: 3,
      }),
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      {
        assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
        buildChannelPublicationEngagementContext,
        recordChannelPublicationEngagement,
      } as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
      undefined,
      adminDialogLinkService as never,
    );
    jest.spyOn(service as any, 'findPoll').mockResolvedValue(draft);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: draft.id });
    const scheduleRepair = jest
      .spyOn(service as any, 'schedulePollRenderRepair')
      .mockImplementation(() => undefined);

    await service.publishChannelPoll('channel-1', draft.id, {
      userId: 'admin-1',
    } as never);

    expect(maxActionLedgerEntry.findUnique).toHaveBeenCalledWith({
      where: {
        jobId: expect.stringMatching(
          /^managed-poll:publish:poll-legacy-ledger-1:attempt:[0-9a-f-]{36}:revision:2:format:4$/u,
        ),
      },
      select: { metadata: true },
    });
    expect(managedPoll.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: draft.id,
          status: ManagedPollStatus.DRAFT,
        }),
        data: expect.objectContaining({
          publicationMessageId: 'message-v4-recovered-1',
          renderedRevision: 2,
          renderFormatVersion: 4,
        }),
      }),
    );
    expect(scheduleRepair).toHaveBeenCalledWith('channel-1', draft.id);
    expect(buildChannelPublicationEngagementContext).not.toHaveBeenCalled();
    expect(recordChannelPublicationEngagement).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'message-v4-recovered-1',
        botId: 'bot-legacy-1',
        context: expect.objectContaining({
          threadId: 'thread-legacy-ledger-1',
          includeCommentsButton: true,
          includeSuggestButton: false,
        }),
      }),
    );
  });

  it('builds gallery attachments from multiple uploaded poll images', async () => {
    const maxClient = {
      uploadImage: jest
        .fn()
        .mockResolvedValueOnce({ token: 'first-image' })
        .mockResolvedValueOnce({ token: 'second-image' }),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );

    await expect(
      (service as any).resolvePollPublicationMedia(
        [
          {
            base64: Buffer.from('first').toString('base64'),
            mimeType: 'image/png',
            fileName: 'first.png',
          },
          {
            base64: Buffer.from('second').toString('base64'),
            mimeType: 'image/webp',
            fileName: 'second.webp',
          },
        ],
        'bot-1',
      ),
    ).resolves.toEqual({
      attachments: [
        { type: 'image', payload: { token: 'first-image' } },
        { type: 'image', payload: { token: 'second-image' } },
      ],
    });
  });

  it('renews a publication claim while media is being prepared', async () => {
    jest.useFakeTimers();
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const service = new ManagedPollService(
      { managedPoll: { updateMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    try {
      const claim = (service as any).startPublicationClaimHeartbeat('poll-1', 'claim-1');

      await jest.advanceTimersByTimeAsync(15_000);

      await expect(claim.stop()).resolves.toBe(true);
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: 'poll-1',
          lockToken: 'claim-1',
          status: ManagedPollStatus.DRAFT,
        },
        data: { lockedAt: expect.any(Date) },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed when a publication claim cannot be renewed', async () => {
    const service = new ManagedPollService(
      {
        managedPoll: {
          updateMany: jest.fn().mockRejectedValue(new Error('database unavailable')),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const claim = (service as any).startPublicationClaimHeartbeat('poll-1', 'claim-1');

    await expect(claim.renew()).resolves.toBe(false);
    await expect(claim.stop()).resolves.toBe(false);
  });

  it('does not recover a completed ledger entry from an older publication attempt', async () => {
    const oldActionKey =
      'managed-poll:publish:poll-1:attempt:old-publication-claim:revision:2:format:4';
    const completedByActionKey = new Map([
      [
        oldActionKey,
        {
          messageId: 'old-message',
          url: 'https://max.ru/channel/old-message',
          botId: 'old-bot',
          candidateBotIds: ['old-bot'],
          routingVersion: 3,
        },
      ],
    ]);
    const onDispatchAttempt = jest.fn();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const recovered = completedByActionKey.get(request.logicalIdempotencyKey);
        if (recovered) {
          return recovered;
        }
        const prepared = await request.prepareAttempt({ botId: 'new-bot', job: {} });
        await request.onDispatchAttempt({
          botId: 'new-bot',
          job: { options: prepared.options },
        });
        return {
          messageId: 'new-message',
          url: 'https://max.ru/channel/new-message',
          botId: 'new-bot',
          candidateBotIds: ['new-bot'],
          routingVersion: 4,
        };
      }),
    };
    const service = new ManagedPollService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );

    await expect(
      (service as any).sendPollPublicationWithRetry(
        'channel-1',
        'poll-1',
        2,
        'new-publication-claim',
        'Опрос',
        {},
        [],
        null,
        onDispatchAttempt,
      ),
    ).resolves.toEqual(expect.objectContaining({ messageId: 'new-message', botId: 'new-bot' }));

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalIdempotencyKey:
          'managed-poll:publish:poll-1:attempt:new-publication-claim:revision:2:format:4',
      }),
    );
    expect(onDispatchAttempt).toHaveBeenCalledWith('new-bot');
    expect((service as any).buildPollPublicationActionKey('poll-1', 2, null)).toBe(
      'managed-poll:publish:poll-1:revision:2:format:4',
    );
  });

  it('retries a deterministic attachment-not-ready rejection after image upload', async () => {
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValueOnce({
          response: { status: 400, data: { code: 'attachment.not.ready' } },
        })
        .mockResolvedValueOnce({ messageId: 'message-1', url: null }),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);

    await expect(
      (service as any).sendPollPublicationWithRetry(
        'channel-1',
        'poll-1',
        0,
        'claim-1',
        'Опрос',
        { imagePayload: { token: 'poll-image-token' } },
        [],
        'bot-1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({ messageId: 'message-1', url: null, botId: 'bot-1' }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous media publication failure', async () => {
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValue({ response: { status: 504, data: { message: 'gateway timeout' } } }),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);

    await expect(
      (service as any).sendPollPublicationWithRetry(
        'channel-1',
        'poll-1',
        0,
        'claim-1',
        'Опрос',
        { imagePayload: { token: 'poll-image-token' } },
        [],
        'bot-1',
      ),
    ).rejects.toMatchObject({ response: { status: 504 } });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
  });

  it('fails closed in production when routed publication wiring is missing', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest.fn(),
    };
    const service = new ManagedPollService(
      {} as never,
      maxClient as never,
      {} as never,
      {} as never,
    );

    try {
      await expect(
        (service as any).sendPollPublicationWithRetry(
          'channel-1',
          'poll-1',
          0,
          'claim-1',
          'Опрос',
          {},
          [],
          'bot-1',
        ),
      ).rejects.toThrow('Routed MAX publication service is required for production managed polls');
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('binds the routed bot before keeping an ambiguous publication claimed', async () => {
    const draft = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Что выбираем?',
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Второй' },
      ],
    };
    const prisma = {
      managedPoll: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxClient = {};
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        await request.prepareAttempt({ botId: 'route-bot', job: {} });
        await request.onDispatchAttempt({ botId: 'route-bot', job: {} });
        throw { response: { status: 504, data: { message: 'gateway timeout' } } };
      }),
    };
    const accessLoss = { recordIfManagedEntityAccessLost: jest.fn() };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      {} as never,
      accessLoss as never,
      undefined,
      maxRoutedPublicationService as never,
    );
    jest.spyOn(service as any, 'findPoll').mockResolvedValue(draft);

    await expect(
      service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never),
    ).rejects.toThrow('MAX мог принять публикацию. Проверьте канал перед повтором.');

    expect(prisma.managedPoll.updateMany).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        where: expect.objectContaining({ id: 'poll-1', lockToken: expect.any(String) }),
        data: { lastError: 'Публикация требует ручной проверки.' },
      }),
    );
    expect(prisma.managedPoll.updateMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({ id: 'poll-1', lockToken: expect.any(String) }),
        data: { publicationBotId: 'route-bot', lockedAt: expect.any(Date) },
      }),
    );
    expect(
      prisma.managedPoll.updateMany.mock.calls.every(
        ([request]) => !Object.hasOwn(request.data, 'renderFormatVersion'),
      ),
    ).toBe(true);
    expect(accessLoss.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
    expect(maxClient).not.toHaveProperty('sendMessageImmediateWithResolvedLink');
  });

  it('releases the claim when draft reload fails before sending', async () => {
    const draft = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Что выбираем?',
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Второй' },
      ],
    };
    const prisma = {
      managedPoll: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    };
    const maxClient = { sendMessageImmediateWithResolvedLink: jest.fn() };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChannelPollBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const accessLoss = { recordIfManagedEntityAccessLost: jest.fn() };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      {} as never,
      accessLoss as never,
    );
    jest
      .spyOn(service as any, 'findPoll')
      .mockResolvedValueOnce(draft)
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      service.publishChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never),
    ).rejects.toThrow('database unavailable');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.managedPoll.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          lockedAt: null,
          lockToken: null,
          publicationBotId: null,
        }),
      }),
    );
    expect(accessLoss.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('forwards the direct publication attempt epoch on terminal access loss', async () => {
    const attemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(attemptStartedAt);
    const terminalError = Object.assign(new Error('Forbidden'), {
      response: { status: 403, data: { code: 'chat.denied', message: 'Forbidden' } },
    });
    const draft = {
      id: 'poll-1',
      chatId: 'chat-1',
      actorUserId: 'admin-1',
      question: 'Что выбираем?',
      questionFormat: 'plain',
      images: [],
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: POLL_IDENTITY_SALT,
      renderRevision: 0,
      renderedRevision: 0,
      renderFormatVersion: POLL_RENDER_FORMAT_VERSION,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: attemptStartedAt,
      updatedAt: attemptStartedAt,
      options: [
        { id: 'option-1', pollId: 'poll-1', position: 0, text: 'Первый' },
        { id: 'option-2', pollId: 'poll-1', position: 1, text: 'Второй' },
      ],
    };
    const prisma = {
      managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-20T12:00:05.000Z'));
        throw terminalError;
      }),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      resolveChatPollBotId: jest.fn().mockResolvedValue('bot-1'),
    };
    const accessLoss = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedPollService(
      prisma as never,
      maxClient as never,
      adminService as never,
      {} as never,
      accessLoss as never,
    );
    jest.spyOn(service as any, 'findPoll').mockResolvedValue(draft);

    try {
      await expect(
        service.publishChannelPoll('chat-1', 'poll-1', { userId: 'admin-1' } as never, 'chat'),
      ).rejects.toThrow('Forbidden');

      expect(accessLoss.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-1',
        entityType: ChatEntityType.CHAT,
        source: 'managed_poll:send',
        operation: 'send',
        error: terminalError,
        lifecycleEventAt: attemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('ManagedPollService lifecycle', () => {
  it('closes an active poll and renders the final state', async () => {
    const poll = { id: 'poll-1', chatId: 'channel-1', status: ManagedPollStatus.ACTIVE };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn().mockResolvedValue(poll),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      chatContextCache as never,
    );
    const render = jest.spyOn(service as any, 'renderPollPublication').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.closeChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never);

    expect(tx.managedPoll.update).toHaveBeenCalledWith({
      where: { id: 'poll-1' },
      data: {
        status: ManagedPollStatus.CLOSED,
        closedAt: expect.any(Date),
        renderRevision: { increment: 1 },
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'CLOSE_CHANNEL_POLL' }),
      }),
    );
    expect(render).toHaveBeenCalledWith('channel-1', 'poll-1', 'close');
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
  });

  it('unlocks only an ambiguous draft publication', async () => {
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(),
      lastError: 'Публикация требует ручной проверки.',
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn().mockResolvedValue(poll),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      chatContextCache as never,
    );
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.resetChannelPollPublication('channel-1', 'poll-1', {
      userId: 'admin-1',
    } as never);

    expect(tx.managedPoll.update).toHaveBeenCalledWith({
      where: { id: 'poll-1' },
      data: {
        lockedAt: null,
        lockToken: null,
        publicationBotId: null,
        lastError: null,
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'RESET_CHANNEL_POLL_PUBLICATION' }),
      }),
    );
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('channel-1');
  });

  it('allows an expired publication claim to be reset after checking the channel', async () => {
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      status: ManagedPollStatus.DRAFT,
      lockedAt: new Date(Date.now() - 61_000),
      lastError: null,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: poll.id }]),
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue(poll),
        update: jest.fn().mockResolvedValue(poll),
      },
      auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const adminService = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      chatContextCache as never,
    );
    jest.spyOn(service as any, 'readPollDetails').mockResolvedValue({ id: 'poll-1' });

    await service.resetChannelPollPublication('channel-1', 'poll-1', {
      userId: 'admin-1',
    } as never);

    expect(tx.managedPoll.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lockedAt: null, lockToken: null, lastError: null }),
      }),
    );
  });
});

describe('ManagedPollService admin reads', () => {
  it('uses chat-scoped read access for chat polls', async () => {
    const prisma = {
      managedPoll: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      managedPollVote: { groupBy: jest.fn() },
    };
    const adminService = { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      {} as never,
    );

    await service.listChannelPolls('chat-1', { userId: 'admin-1' } as never, {}, 'chat');

    expect(adminService.assertManagedEntityReadAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      'chat',
    );
    expect(prisma.managedPoll.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId: 'chat-1' } }),
    );
    expect(prisma.managedPoll.count).toHaveBeenCalledWith({ where: { chatId: 'chat-1' } });
  });

  it('filters current and archived polls on the server and reports each scoped total', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(9);
    const prisma = {
      managedPoll: { findMany, count },
      managedPollVote: { groupBy: jest.fn() },
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );

    await expect(
      service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
        scope: 'current',
      }),
    ).resolves.toMatchObject({ items: [], nextCursor: null, total: 4 });
    await expect(
      service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
        scope: 'archive',
      }),
    ).resolves.toMatchObject({ items: [], nextCursor: null, total: 9 });

    const currentWhere = {
      chatId: 'channel-1',
      status: { in: [ManagedPollStatus.DRAFT, ManagedPollStatus.ACTIVE] },
    };
    const archiveWhere = { chatId: 'channel-1', status: ManagedPollStatus.CLOSED };
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: currentWhere }));
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: archiveWhere }));
    expect(count).toHaveBeenNthCalledWith(1, { where: currentWhere });
    expect(count).toHaveBeenNthCalledWith(2, { where: archiveWhere });
  });

  it('paginates poll history before aggregating votes', async () => {
    const now = new Date();
    const createPoll = (id: string) => ({
      id,
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: `Вопрос ${id}`,
      questionFormat: 'markdown',
      imageCount: 1,
      images: [
        {
          base64: Buffer.from(`image-${id}`).toString('base64'),
          mimeType: 'image/jpeg',
          fileName: `${id}.jpg`,
        },
      ],
      status: ManagedPollStatus.CLOSED,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 1,
      renderedRevision: 1,
      publicationMessageId: `message-${id}`,
      publicationBotId: 'bot-1',
      publicationUrl: null,
      publishedAt: now,
      closedAt: now,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        { id: `${id}-1`, pollId: id, position: 0, text: 'Да', createdAt: now, updatedAt: now },
        { id: `${id}-2`, pollId: id, position: 1, text: 'Нет', createdAt: now, updatedAt: now },
      ],
    });
    const polls = [createPoll('poll-3'), createPoll('poll-2'), createPoll('poll-1')];
    const prisma = {
      managedPoll: {
        findMany: jest.fn().mockResolvedValue(polls),
        count: jest.fn().mockResolvedValue(3),
      },
      managedPollVote: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const adminService = { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      {} as never,
    );

    const response = await service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
      limit: '2',
    });

    expect(response).toMatchObject({
      items: [{ id: 'poll-3' }, { id: 'poll-2' }],
      nextCursor: expect.any(String),
      total: 3,
    });
    expect(decodeManagedPollListCursor(response.nextCursor ?? '')).toEqual({
      v: 1,
      createdAt: now.toISOString(),
      id: 'poll-2',
      chatId: 'channel-1',
      scope: 'all',
    });
    expect(response.items[0]).toEqual(
      expect.objectContaining({ questionFormat: 'markdown', imageCount: 1 }),
    );
    expect(response.items[0]).not.toHaveProperty('images');
    expect(prisma.managedPoll.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 3,
        select: expect.objectContaining({ imageCount: true }),
      }),
    );
    expect(prisma.managedPoll.findMany.mock.calls[0]?.[0]?.select).not.toHaveProperty('images');
    expect(prisma.managedPoll.findMany.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(prisma.managedPoll.findMany.mock.calls[0]?.[0]).not.toHaveProperty('skip');
    expect(prisma.managedPoll.count).toHaveBeenCalledWith({ where: { chatId: 'channel-1' } });
    expect(prisma.managedPollVote.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { pollId: { in: ['poll-3', 'poll-2'] } } }),
    );
  });

  it('uses a route-bound keyset cursor without narrowing the scoped total', async () => {
    const createdAt = new Date('2026-08-19T09:30:00.000Z');
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(7);
    const prisma = {
      managedPoll: { findMany, count },
      managedPollVote: { groupBy: jest.fn() },
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );
    const cursor = encodeManagedPollListCursor({
      v: 1,
      createdAt: createdAt.toISOString(),
      id: 'poll-2',
      chatId: 'channel-1',
      scope: 'archive',
    });

    await expect(
      service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
        scope: 'archive',
        cursor,
      }),
    ).resolves.toMatchObject({ items: [], nextCursor: null, total: 7 });

    const baseWhere = { chatId: 'channel-1', status: ManagedPollStatus.CLOSED };
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            baseWhere,
            {
              OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'poll-2' } }],
            },
          ],
        },
      }),
    );
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('skip');
    expect(count).toHaveBeenCalledWith({ where: baseWhere });
  });

  it('rejects opaque poll cursors from another scope or managed entity', async () => {
    const findMany = jest.fn();
    const count = jest.fn();
    const findFirst = jest.fn();
    const prisma = {
      managedPoll: { findMany, count, findFirst },
      managedPollVote: { groupBy: jest.fn() },
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );
    const cursorPayload = {
      v: 1,
      createdAt: '2026-08-19T09:30:00.000Z',
      id: 'poll-2',
      chatId: 'channel-1',
      scope: 'current',
    } as const;

    await expect(
      service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
        scope: 'archive',
        cursor: encodeManagedPollListCursor(cursorPayload),
      }),
    ).rejects.toThrow('Курсор списка опросов недействителен.');
    await expect(
      service.listChannelPolls('channel-2', { userId: 'admin-1' } as never, {
        scope: 'current',
        cursor: encodeManagedPollListCursor(cursorPayload),
      }),
    ).rejects.toThrow('Курсор списка опросов недействителен.');

    expect(findFirst).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('accepts a same-chat legacy cursor even after the referenced poll leaves the scope', async () => {
    const createdAt = new Date('2026-08-19T09:30:00.000Z');
    const findFirst = jest.fn().mockResolvedValue({ id: 'poll-legacy', createdAt });
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(2);
    const prisma = {
      managedPoll: { findFirst, findMany, count },
      managedPollVote: { groupBy: jest.fn() },
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );

    await expect(
      service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
        scope: 'current',
        cursor: 'poll-legacy',
      }),
    ).resolves.toMatchObject({ items: [], nextCursor: null, total: 2 });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'poll-legacy', chatId: 'channel-1' },
      select: { id: true, createdAt: true },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              chatId: 'channel-1',
              status: { in: [ManagedPollStatus.DRAFT, ManagedPollStatus.ACTIVE] },
            },
            {
              OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'poll-legacy' } }],
            },
          ],
        },
      }),
    );
  });

  it('rejects an unknown or foreign legacy poll cursor', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const findMany = jest.fn();
    const count = jest.fn();
    const prisma = {
      managedPoll: { findFirst, findMany, count },
      managedPollVote: { groupBy: jest.fn() },
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );

    await expect(
      service.listChannelPolls('channel-1', { userId: 'admin-1' } as never, {
        cursor: 'poll-from-another-chat',
      }),
    ).rejects.toThrow('Курсор списка опросов недействителен.');

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'poll-from-another-chat', chatId: 'channel-1' },
      select: { id: true, createdAt: true },
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('returns saved images only from poll details', async () => {
    const now = new Date();
    const images = [
      {
        base64: Buffer.from('detail-image').toString('base64'),
        mimeType: 'image/png',
        fileName: 'detail.png',
      },
    ];
    const poll = {
      id: 'poll-1',
      chatId: 'channel-1',
      actorUserId: 'admin-1',
      question: 'Вопрос',
      questionFormat: 'markdown',
      imageCount: 1,
      images,
      status: ManagedPollStatus.DRAFT,
      visibility: ManagedPollVisibility.ANONYMOUS,
      identitySalt: '12345678901234567890123456789012',
      renderRevision: 0,
      renderedRevision: 0,
      publicationMessageId: null,
      publicationBotId: null,
      publicationUrl: null,
      publishedAt: null,
      closedAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
      createdAt: now,
      updatedAt: now,
      options: [
        {
          id: 'option-1',
          pollId: 'poll-1',
          position: 0,
          text: 'Да',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'option-2',
          pollId: 'poll-1',
          position: 1,
          text: 'Нет',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const prisma = {
      managedPoll: { findFirst: jest.fn().mockResolvedValue(poll) },
      managedPollVote: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      { assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
    );

    await expect(
      service.getChannelPoll('channel-1', 'poll-1', { userId: 'admin-1' } as never),
    ).resolves.toMatchObject({
      questionFormat: 'markdown',
      imageCount: 1,
      images,
    });
  });

  it('does not expose voters for an anonymous poll', async () => {
    const prisma = {
      managedPoll: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'poll-1',
          visibility: ManagedPollVisibility.ANONYMOUS,
        }),
      },
      managedPollVoter: { findMany: jest.fn() },
    };
    const adminService = { assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      prisma as never,
      {} as never,
      adminService as never,
      {} as never,
    );

    await expect(
      service.getChannelPollVoters('channel-1', 'poll-1', { userId: 'admin-1' } as never, {}),
    ).rejects.toThrow('В анонимном опросе список участников скрыт.');
    expect(prisma.managedPollVoter.findMany).not.toHaveBeenCalled();
  });
});

describe('ManagedPollService access-loss attribution', () => {
  it('attributes failed chat poll actions to a chat entity', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const accessLoss = { recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined) };
    const service = new ManagedPollService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      accessLoss as never,
    );
    const error = new Error('denied');

    await (service as any).recordAccessLoss(
      { id: 'poll-1', chatId: 'chat-1' },
      'bot-1',
      'edit',
      error,
      'chat',
      lifecycleEventAt,
    );

    expect(accessLoss.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      entityType: ChatEntityType.CHAT,
      source: 'managed_poll:edit',
      operation: 'edit',
      error,
      lifecycleEventAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
  });
});

describe('ManagedPollService background render repair', () => {
  it('processes a bounded stale-publication batch through the serialized renderer', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        { id: 'poll-1', chatId: 'chat-1' },
        { id: 'poll-2', chatId: 'channel-1' },
      ]),
    };
    const service = new ManagedPollService(prisma as never, {} as never, {} as never, {} as never);
    const render = jest.spyOn(service as any, 'renderPollPublication').mockResolvedValue(true);
    jest
      .spyOn(service as any, 'runPollRenderSerialized')
      .mockImplementation(async (...args: unknown[]) => {
        const operation = args[1] as () => Promise<void>;
        await operation();
        return true;
      });

    await expect(service.processPendingPollRenderRepairs()).resolves.toBe(2);
    expect(render).toHaveBeenNthCalledWith(1, 'chat-1', 'poll-1', 'background-repair');
    expect(render).toHaveBeenNthCalledWith(2, 'channel-1', 'poll-2', 'background-repair');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const query = prisma.$queryRaw.mock.calls[0]?.[0]?.join(' ');
    expect(query).toContain('WHERE "publication_message_id" IS NOT NULL');
    expect(query).toContain('OR "render_format_version" <');
    expect(query).toContain('OR "last_render_error" IS NOT NULL');
    expect(prisma.$queryRaw.mock.calls[0]?.[1]).toBe(POLL_RENDER_FORMAT_VERSION);
  });
});
