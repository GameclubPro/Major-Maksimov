import type { MaxActionJob } from './max-client.service';
import type { MaxActionDispatchExecutionOptions } from './max-action-dispatch.service';
import { UnrecoverableError } from 'bullmq';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import { MaxActionNoExecutableRouteError } from './max-action-dispatch-error';
import { MaxRoutedPublicationService } from './max-routed-publication.service';
import type { MaxBotLinkService } from './max-bot-link.service';

describe('MaxRoutedPublicationService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses a fresh route while keeping the logical idempotency key bot-independent', async () => {
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
        routingVersion: 7,
      }),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest
        .fn()
        .mockImplementation(
          async (job: MaxActionJob, options: MaxActionDispatchExecutionOptions) => {
            const prepared = await options.prepareAttempt!({ botId: 'bot-2', job });
            await options.onDispatchAttempt!({ botId: 'bot-2', job: { ...job, ...prepared } });
            await options.beforeSendMutation!({ botId: 'bot-2', job: { ...job, ...prepared } });
            return {
              messageId: 'mid-1',
              url: 'https://max.ru/channel-1/mid-1',
              botId: 'bot-2',
            };
          },
        ),
    };
    const prepareAttempt = jest.fn().mockResolvedValue({
      options: { imagePayload: { token: 'bot-2-upload' } },
    });
    const onDispatchAttempt = jest.fn();
    const beforeSendMutation = jest.fn();
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      { resolveMessageLink: jest.fn() } as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'publication:logical-1',
        text: 'publication',
        trafficClass: 'interactive',
        sourceTag: 'test_publication',
        ignoreFailureMetricStatuses: [403, 404],
        prepareAttempt,
        onDispatchAttempt,
        beforeSendMutation,
      }),
    ).resolves.toEqual({
      messageId: 'mid-1',
      url: 'https://max.ru/channel-1/mid-1',
      botId: 'bot-2',
      candidateBotIds: ['bot-1', 'bot-2'],
      routingVersion: 7,
    });

    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        idempotencyKey: 'publication:logical-1',
        ignoreFailureMetricStatuses: [403, 404],
        routing: expect.objectContaining({
          purpose: 'send_message',
          routingVersion: 7,
        }),
      }),
      expect.any(Object),
    );
    expect(prepareAttempt).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-2' }));
    expect(onDispatchAttempt).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-2' }));
    expect(beforeSendMutation).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot-2' }));
    expect(
      (maxActionDispatchService.execute.mock.calls[0]?.[0] as MaxActionJob).idempotencyKey,
    ).not.toContain('bot-1');
  });

  it('observes immediate readiness before route selection without deriving it from payload history', async () => {
    const startedAt = new Date('2026-11-08T19:00:00.000Z');
    jest.useFakeTimers().setSystemTime(startedAt);
    const links = {
      resolveBotRoute: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date(startedAt.getTime() + 2_500));
        return { primaryBotId: 'bot-1', candidateBotIds: ['bot-1'], routingVersion: 7 };
      }),
    };
    const execute = jest
      .fn<
        Promise<{ messageId: string; botId: string; url: string | null }>,
        [MaxActionJob, MaxActionDispatchExecutionOptions]
      >()
      .mockResolvedValue({ messageId: 'mid-ready', botId: 'bot-1', url: null });
    const service = new MaxRoutedPublicationService(
      links as never,
      { recoverCompletedSend: jest.fn().mockResolvedValue(null), execute } as never,
      { resolveMessageLink: jest.fn() } as never,
    );
    await service.publish({
      entityId: 'channel-1',
      logicalIdempotencyKey: 'publication:ready-clock',
      text: 'publication',
      trafficClass: 'interactive',
      sourceTag: 'test_publication',
      hydrateMessageUrl: false,
    });
    const [job, options] = execute.mock.calls[0]!;
    expect(options.enqueuedAt).toEqual(startedAt);
    expect(job.createdAt).toBe(startedAt.toISOString());
    expect(Date.now() - options.enqueuedAt!.getTime()).toBe(2_500);
  });

  it.each([
    { label: 'new', recovered: false, url: null },
    { label: 'new with a direct URL', recovered: false, url: 'https://max.ru/channel-1/mid-1' },
    { label: 'recovered', recovered: true, url: null },
    {
      label: 'recovered with a ledger URL',
      recovered: true,
      url: 'https://max.ru/channel-1/mid-1',
    },
  ])(
    'returns a $label receipt without a message lookup when hydration is disabled',
    async ({ recovered, url }) => {
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({
          purpose: 'send_message',
          chatId: 'channel-1',
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1'],
          reason: 'primary_confirmed',
          routingVersion: 7,
        }),
      };
      const receipt = { messageId: 'mid-1', url, chatId: 'channel-1', botId: 'bot-1' };
      const maxActionDispatchService = {
        recoverCompletedSend: jest.fn().mockResolvedValue(recovered ? receipt : null),
        execute: jest.fn().mockResolvedValue(receipt),
      };
      const maxClientService = { resolveMessageLink: jest.fn() };
      const service = new MaxRoutedPublicationService(
        maxBotLinkService as never,
        maxActionDispatchService as never,
        maxClientService as never,
      );

      await expect(
        service.publish({
          entityId: 'channel-1',
          logicalIdempotencyKey: 'publication:receipt-without-hydration',
          text: 'publication',
          trafficClass: 'background',
          sourceTag: 'managed_broadcast',
          requiredBotId: 'bot-1',
          hydrateMessageUrl: false,
        }),
      ).resolves.toEqual({
        ...receipt,
        candidateBotIds: ['bot-1'],
        routingVersion: recovered ? null : 7,
      });

      expect(maxClientService.resolveMessageLink).not.toHaveBeenCalled();
      if (recovered) {
        expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
        expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
      } else {
        expect(maxActionDispatchService.execute).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([
    { label: 'new', recovered: false },
    { label: 'recovered', recovered: true },
  ])('hydrates a $label receipt URL by default', async ({ recovered }) => {
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
        routingVersion: 7,
      }),
    };
    const receipt = { messageId: 'mid-1', url: null, botId: 'bot-1' };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(recovered ? receipt : null),
      execute: jest.fn().mockResolvedValue(receipt),
    };
    const maxClientService = {
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/channel-1/mid-1'),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'publication:default-url-hydration',
        text: 'publication',
        trafficClass: 'interactive',
        sourceTag: 'test_publication',
      }),
    ).resolves.toMatchObject({
      messageId: 'mid-1',
      url: 'https://max.ru/channel-1/mid-1',
      botId: 'bot-1',
    });

    expect(maxClientService.resolveMessageLink).toHaveBeenCalledWith('mid-1', {
      botId: 'bot-1',
      trafficClass: 'interactive',
      sourceTag: 'test_publication',
    });
  });

  it('exposes sticky routing only from an exact future-night session proof', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T20:00:01.000Z'));
    const sessionKey = 'v1:Europe/Moscow:23:00:08:00:2026-07-27';
    const failureBefore = '2026-07-27T20:00:00.000Z';
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
        routingVersion: 7,
      }),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({ messageId: 'mid-night-1', url: null, botId: 'bot-1' }),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      { resolveMessageLink: jest.fn().mockResolvedValue(null) } as never,
    );

    await service.publish({
      entityId: 'chat-1',
      logicalIdempotencyKey: `night-mode:close:chat-1:session:${sessionKey}`,
      text: 'night close',
      trafficClass: 'background',
      sourceTag: 'night_mode_transition',
      sendRouteHalfOpenProbe: 'publication_exact_verification',
      sendRouteStickyProbe: {
        kind: 'future_night_close_v1',
        authorizedAt: '2026-07-27T19:55:00.000Z',
        failureBefore,
        sessionKey,
        scheduleFingerprint: buildNightModeTransitionScheduleFingerprint({
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
        }),
      },
    });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        allowHalfOpenProbe: true,
        stickyHalfOpenProbeFailureBefore: failureBefore,
      }),
    );
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        routing: expect.objectContaining({
          sendRouteStickyProbe: expect.objectContaining({ sessionKey, failureBefore }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('restricts a bot-scoped publication to its required executable token owner', async () => {
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'media-bot'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-media-1',
        url: null,
        botId: 'media-bot',
      }),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      { resolveMessageLink: jest.fn().mockResolvedValue(null) } as never,
    );

    await service.publish({
      entityId: 'channel-1',
      logicalIdempotencyKey: 'channel-suggestion:publish:v1:suggestion-1',
      text: 'video',
      trafficClass: 'interactive',
      sourceTag: 'suggestion_delivery',
      preferredBotId: 'media-bot',
      requiredBotId: 'media-bot',
    });

    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'media-bot',
        candidateBotIds: ['media-bot'],
        routing: expect.objectContaining({ requiredBotId: 'media-bot' }),
      }),
      expect.objectContaining<MaxActionDispatchExecutionOptions>({ enqueuedAt: expect.any(Date) }),
    );
  });

  it('uses the guarded exact Publik route without consulting managed-bot ownership', async () => {
    const previousRole = process.env.APP_ROLE;
    const previousServiceName = process.env.APP_SERVICE_NAME;
    const previousPublisherBotId = process.env.MAX_PUBLISHER_BOT_ID;
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
    process.env.MAX_PUBLISHER_BOT_ID = 'se14088825_bot';
    try {
      const maxBotLinkService = {
        resolveBotRoute: jest.fn(),
        resolveBotRouteForManagedPoll: jest.fn(),
      };
      const maxActionDispatchService = {
        recoverCompletedSend: jest.fn().mockResolvedValue(null),
        execute: jest.fn().mockResolvedValue({
          messageId: 'mid-publik-1',
          url: null,
          botId: 'se14088825_bot',
        }),
      };
      const service = new MaxRoutedPublicationService(
        maxBotLinkService as never,
        maxActionDispatchService as never,
        { resolveMessageLink: jest.fn().mockResolvedValue(null) } as never,
      );

      await expect(
        service.publish({
          entityId: 'channel-1',
          logicalIdempotencyKey: 'vk-parsing:publish:post-1:intent-1',
          text: 'VK post',
          trafficClass: 'background',
          sourceTag: 'vk_parsing',
          publisherExactBotId: 'se14088825_bot',
        }),
      ).resolves.toMatchObject({
        messageId: 'mid-publik-1',
        botId: 'se14088825_bot',
        candidateBotIds: ['se14088825_bot'],
      });

      expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
      expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: 'se14088825_bot',
          candidateBotIds: ['se14088825_bot'],
          routing: expect.objectContaining({
            purpose: 'publisher_exact_send',
            requiredBotId: 'se14088825_bot',
          }),
        }),
        expect.objectContaining<MaxActionDispatchExecutionOptions>({
          enqueuedAt: expect.any(Date),
        }),
      );
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
      else process.env.APP_SERVICE_NAME = previousServiceName;
      if (previousPublisherBotId === undefined) delete process.env.MAX_PUBLISHER_BOT_ID;
      else process.env.MAX_PUBLISHER_BOT_ID = previousPublisherBotId;
    }
  });

  it('rejects the exact publisher route outside api-publisher', async () => {
    const previousRole = process.env.APP_ROLE;
    const previousServiceName = process.env.APP_SERVICE_NAME;
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    try {
      const service = new MaxRoutedPublicationService(
        { resolveBotRoute: jest.fn() } as never,
        { recoverCompletedSend: jest.fn(), execute: jest.fn() } as never,
        { resolveMessageLink: jest.fn() } as never,
      );

      await expect(
        service.publish({
          entityId: 'channel-1',
          logicalIdempotencyKey: 'vk-parsing:publish:post-1:wrong-role',
          text: 'VK post',
          trafficClass: 'background',
          sourceTag: 'vk_parsing',
          publisherExactBotId: 'se14088825_bot',
        }),
      ).rejects.toThrow('only available to api-publisher');
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
      else process.env.APP_SERVICE_NAME = previousServiceName;
    }
  });

  it('fails closed before dispatch when a required media bot left the fresh route', async () => {
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      { resolveMessageLink: jest.fn() } as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'channel-suggestion:publish:v1:suggestion-2',
        text: 'video',
        trafficClass: 'interactive',
        sourceTag: 'suggestion_delivery',
        requiredBotId: 'media-bot',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'another bot', recoveredBotId: 'foreign-bot' },
    { label: 'no proven bot', recoveredBotId: null },
  ])(
    'fails closed without a resend when a completed required publication has $label',
    async ({ recoveredBotId }) => {
      const maxBotLinkService = {
        resolveBotRoute: jest.fn(),
      };
      const maxActionDispatchService = {
        recoverCompletedSend: jest.fn().mockResolvedValue({
          messageId: 'mid-recovered-required',
          url: null,
          botId: recoveredBotId,
        }),
        execute: jest.fn(),
      };
      const service = new MaxRoutedPublicationService(
        maxBotLinkService as never,
        maxActionDispatchService as never,
        { resolveMessageLink: jest.fn() } as never,
      );

      await expect(
        service.publish({
          entityId: 'channel-1',
          logicalIdempotencyKey: 'channel-suggestion:publish:v1:suggestion-recovered-required',
          text: 'video',
          trafficClass: 'interactive',
          sourceTag: 'suggestion_delivery',
          requiredBotId: 'media-bot',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(maxActionDispatchService.recoverCompletedSend).toHaveBeenCalledWith(
        expect.objectContaining({
          routing: { purpose: 'send_message', requiredBotId: 'media-bot' },
        }),
      );
      expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
      expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
    },
  );

  it('uses the poll-specific eligible candidate route', async () => {
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-3'],
        reason: 'alternate_confirmed',
        routingVersion: 9,
      }),
      resolveBotRoute: jest.fn(),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-poll-1',
        url: null,
        botId: 'bot-2',
      }),
    };
    const maxClientService = {
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/channel-1/mid-poll-1'),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-1',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        botId: 'bot-2',
        url: 'https://max.ru/channel-1/mid-poll-1',
      }),
    );

    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledWith({
      chatId: 'channel-1',
    });
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-3'],
        routing: expect.objectContaining({ purpose: 'channel_poll', routingVersion: 9 }),
      }),
      expect.objectContaining<MaxActionDispatchExecutionOptions>({ enqueuedAt: expect.any(Date) }),
    );
    expect(maxClientService.resolveMessageLink).toHaveBeenCalledWith('mid-poll-1', {
      botId: 'bot-2',
      trafficClass: 'interactive',
      sourceTag: 'managed_poll',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  it('recovers a completed poll before rejecting its now-empty route', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'channel-1',
      primaryBotId: 'former-dispatch-bot',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 10,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
      resolveBotRoute: jest.fn().mockResolvedValue(emptyRoute),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue({
        messageId: 'mid-recovered-poll-1',
        url: null,
        botId: 'former-dispatch-bot',
      }),
      execute: jest.fn(),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn(),
      resolveMessageLink: jest
        .fn()
        .mockResolvedValue('https://max.ru/channel-1/mid-recovered-poll-1'),
    };
    const prepareAttempt = jest.fn();
    const onDispatchAttempt = jest.fn();
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-recovered-1',
        routePurpose: 'channel_poll',
        text: 'admin-authored poll question',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
        ignoreFailureMetricStatuses: [403, 404],
        prepareAttempt,
        onDispatchAttempt,
      }),
    ).resolves.toEqual({
      messageId: 'mid-recovered-poll-1',
      url: 'https://max.ru/channel-1/mid-recovered-poll-1',
      botId: 'former-dispatch-bot',
      candidateBotIds: ['former-dispatch-bot'],
      routingVersion: null,
    });

    expect(maxActionDispatchService.recoverCompletedSend).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        idempotencyKey: 'managed-poll:publish:poll-recovered-1',
        text: 'admin-authored poll question',
      }),
    );
    expect(maxClientService.resolveMessageLink).toHaveBeenCalledWith('mid-recovered-poll-1', {
      botId: 'former-dispatch-bot',
      trafficClass: 'interactive',
      sourceTag: 'managed_poll',
      ignoreFailureMetricStatuses: [403, 404],
    });
    expect(maxBotLinkService.resolveBotRouteForManagedPoll).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(maxClientService.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
    expect(prepareAttempt).not.toHaveBeenCalled();
    expect(onDispatchAttempt).not.toHaveBeenCalled();
  });

  it('hydrates an unknown poll route candidate before dispatch', async () => {
    const accessProbeStartedAt = new Date('2026-08-20T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(accessProbeStartedAt);
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const confirmedRoute = {
      ...emptyRoute,
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
      routingVersion: 5,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest
        .fn()
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(confirmedRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_fallback',
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-poll-1',
        url: 'https://max.ru/chat-1/mid-chat-poll-1',
        botId: 'bot-1',
      }),
    };
    const access = {
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-20T10:00:05.000Z'));
        return access;
      }),
      resolveMessageLink: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-chat-1',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
        timeoutMs: 12_000,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: 'mid-chat-poll-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxClientService.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'interactive',
      sourceTag: 'managed_poll',
      timeoutMs: 12_000,
    });
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      access,
      source: 'managed_poll_route_hydration',
      checkedAt: accessProbeStartedAt,
    });
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: expect.objectContaining({ purpose: 'channel_poll', routingVersion: 5 }),
      }),
      expect.objectContaining<MaxActionDispatchExecutionOptions>({ enqueuedAt: expect.any(Date) }),
    );
  });

  it('uses a fresh poll grant persisted between its initial route reads', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-concurrent-poll-grant',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const confirmedRoute = {
      ...emptyRoute,
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
      routingVersion: 5,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest
        .fn()
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(confirmedRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(false),
      recordBotAccessProbe: jest.fn(),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-concurrent-poll-grant',
        url: null,
        botId: 'bot-1',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-concurrent-poll-grant',
        logicalIdempotencyKey: 'managed-poll:publish:concurrent-grant',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxClientService.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1', candidateBotIds: ['bot-1'] }),
      expect.objectContaining<MaxActionDispatchExecutionOptions>({ enqueuedAt: expect.any(Date) }),
    );
  });

  it('uses a poll grant persisted after an empty general-route read', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-late-poll-grant',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const confirmedRoute = {
      ...emptyRoute,
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
      routingVersion: 5,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest
        .fn()
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(confirmedRoute),
      resolveBotRoute: jest.fn().mockResolvedValue(emptyRoute),
      isBotAccessSnapshotStale: jest.fn(),
      recordBotAccessProbe: jest.fn(),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-late-poll-grant',
        url: null,
        botId: 'bot-1',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-late-poll-grant',
        logicalIdempotencyKey: 'managed-poll:publish:late-grant',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.isBotAccessSnapshotStale).not.toHaveBeenCalled();
    expect(maxClientService.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1', candidateBotIds: ['bot-1'] }),
      expect.objectContaining<MaxActionDispatchExecutionOptions>({ enqueuedAt: expect.any(Date) }),
    );
  });

  it('keeps a probed non-admin poll route closed without dispatching', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const memberAccess = {
      userId: 'bot-user-1',
      isAdmin: false,
      isOwner: false,
      permissions: [],
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue(memberAccess),
      resolveMessageLink: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-chat-member',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ access: memberAccess }),
    );
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    'keeps an opaque HTTP %s poll probe closed without revoking access',
    async (status) => {
      const emptyRoute = {
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: null,
        candidateBotIds: [],
        reason: null,
        routingVersion: 4,
      };
      const maxBotLinkService = {
        resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
        resolveBotRoute: jest.fn().mockResolvedValue({
          ...emptyRoute,
          botId: 'bot-1',
          candidateBotIds: ['bot-1'],
        }),
        isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
        recordBotAccessProbe: jest.fn(),
      };
      const maxActionDispatchService = {
        recoverCompletedSend: jest.fn().mockResolvedValue(null),
        execute: jest.fn(),
      };
      const maxClientService = {
        getCurrentChatMemberAccess: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('chat denied; forbidden'), { response: { status } }),
          ),
        resolveMessageLink: jest.fn(),
      };
      const managedEntityAccessLossService = {
        recordIfManagedEntityAccessLost: jest.fn(),
      };
      const service = new MaxRoutedPublicationService(
        maxBotLinkService as never,
        maxActionDispatchService as never,
        maxClientService as never,
        managedEntityAccessLossService as never,
      );

      await expect(
        service.publish({
          entityId: 'chat-1',
          logicalIdempotencyKey: 'managed-poll:publish:poll-chat-denied',
          routePurpose: 'channel_poll',
          text: 'poll',
          trafficClass: 'interactive',
          sourceTag: 'managed_poll',
        }),
      ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

      expect(maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
      expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['access.denied', 'chat.denied', 'chat.not.found'])(
    'persists explicit poll access lookup denial %s before closing the route',
    async (code) => {
      const accessProbeStartedAt = new Date('2026-08-20T10:00:00.000Z');
      jest.useFakeTimers().setSystemTime(accessProbeStartedAt);
      const emptyRoute = {
        purpose: 'send_message',
        chatId: 'chat-terminal-poll-lookup',
        primaryBotId: 'bot-1',
        botId: null,
        candidateBotIds: [],
        reason: null,
        routingVersion: 4,
      };
      const maxBotLinkService = {
        resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
        resolveBotRoute: jest.fn().mockResolvedValue({
          ...emptyRoute,
          botId: 'bot-1',
          candidateBotIds: ['bot-1'],
        }),
        isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
        recordBotAccessProbe: jest.fn().mockResolvedValue(true),
      };
      const maxActionDispatchService = {
        recoverCompletedSend: jest.fn().mockResolvedValue(null),
        execute: jest.fn(),
      };
      const maxClientService = {
        getCurrentChatMemberAccess: jest.fn().mockRejectedValue(
          Object.assign(new Error('chat not found'), {
            response: { status: 404, data: { code } },
          }),
        ),
        resolveMessageLink: jest.fn(),
      };
      const managedEntityAccessLossService = {
        recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
      };
      const service = new MaxRoutedPublicationService(
        maxBotLinkService as never,
        maxActionDispatchService as never,
        maxClientService as never,
        managedEntityAccessLossService as never,
      );

      await expect(
        service.publish({
          entityId: 'chat-terminal-poll-lookup',
          logicalIdempotencyKey: 'managed-poll:publish:terminal-lookup',
          routePurpose: 'channel_poll',
          text: 'poll',
          trafficClass: 'interactive',
          sourceTag: 'managed_poll',
        }),
      ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

      expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
        chatId: 'chat-terminal-poll-lookup',
        botId: 'bot-1',
        access: null,
        source: 'managed_poll_route_hydration',
        checkedAt: accessProbeStartedAt,
        lastErrorCode: code,
      });
      expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-terminal-poll-lookup',
        botId: 'bot-1',
        operation: 'lookup',
        source: 'managed_poll_route_hydration',
        error: expect.objectContaining({ message: 'chat not found' }),
        lifecycleEventAt: accessProbeStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
      expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
      expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
    },
  );

  it('does not turn a poll access writer failure into an own-member denial', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const recordBotAccessProbe: jest.MockedFunction<MaxBotLinkService['recordBotAccessProbe']> =
      jest.fn().mockRejectedValue(
        Object.assign(new Error('write failed'), {
          response: { status: 403, data: { code: 'chat.denied' } },
        }),
      );
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe,
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const access = {
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue(access),
      resolveMessageLink: jest.fn(),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:failed-access-write',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(recordBotAccessProbe).toHaveBeenCalledWith(expect.objectContaining({ access }));
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it('keeps a poll route closed when live access persistence is superseded', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest.fn().mockResolvedValue(emptyRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn(),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
      resolveMessageLink: jest.fn(),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:superseded-access',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxActionDispatchService.execute).not.toHaveBeenCalled();
  });

  it('uses a newer persisted poll grant when its own access CAS is superseded', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const refreshedRoute = {
      ...emptyRoute,
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
      routingVersion: 5,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest
        .fn()
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(refreshedRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'poll-message-1',
        url: null,
        botId: 'bot-1',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:newer-access',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: 'poll-message-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routingVersion: 5,
      }),
    );

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.resolveBotRouteForManagedPoll).toHaveBeenCalledTimes(2);
    expect(maxActionDispatchService.execute).toHaveBeenCalledTimes(1);
  });

  it('tries the next unknown poll candidate after the first remains ineligible', async () => {
    const emptyRoute = {
      purpose: 'send_message',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: null,
      candidateBotIds: [],
      reason: null,
      routingVersion: 4,
    };
    const alternateRoute = {
      ...emptyRoute,
      botId: 'bot-2',
      candidateBotIds: ['bot-2'],
      reason: 'alternate_confirmed',
      routingVersion: 6,
    };
    const maxBotLinkService = {
      resolveBotRouteForManagedPoll: jest
        .fn()
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(emptyRoute)
        .mockResolvedValueOnce(alternateRoute),
      resolveBotRoute: jest.fn().mockResolvedValue({
        ...emptyRoute,
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
      }),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const maxActionDispatchService = {
      recoverCompletedSend: jest.fn().mockResolvedValue(null),
      execute: jest.fn().mockResolvedValue({
        messageId: 'mid-chat-poll-2',
        url: null,
        botId: 'bot-2',
      }),
    };
    const maxClientService = {
      getCurrentChatMemberAccess: jest
        .fn()
        .mockResolvedValueOnce({
          userId: 'bot-user-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })
        .mockResolvedValueOnce({
          userId: 'bot-user-2',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        }),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chat-1/mid-chat-poll-2'),
    };
    const service = new MaxRoutedPublicationService(
      maxBotLinkService as never,
      maxActionDispatchService as never,
      maxClientService as never,
    );

    await expect(
      service.publish({
        entityId: 'chat-1',
        logicalIdempotencyKey: 'managed-poll:publish:poll-chat-alternate',
        routePurpose: 'channel_poll',
        text: 'poll',
        trafficClass: 'interactive',
        sourceTag: 'managed_poll',
      }),
    ).resolves.toEqual(expect.objectContaining({ botId: 'bot-2' }));

    expect(maxClientService.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
    expect(maxActionDispatchService.execute).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2', candidateBotIds: ['bot-2'] }),
      expect.objectContaining<MaxActionDispatchExecutionOptions>({ enqueuedAt: expect.any(Date) }),
    );
  });
});
