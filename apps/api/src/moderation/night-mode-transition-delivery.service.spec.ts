import { MaxActionNoExecutableRouteError } from '../max/max-action-dispatch-error';
import { buildNightModeTransitionScheduleFingerprint } from './night-mode-transition-generation.util';
import {
  markMaxPreDispatchGuardRejected,
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
} from '../max/max-action-pre-dispatch-guard';
import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import type { NightModeTransitionDeliveryAdapters } from './night-mode-transition-delivery.service';
import { NightModeTransitionNoticeEventPersistenceError } from './night-mode-transition-notice-persistence-error';
import type { NightModeTransitionRuntimeSettings } from './night-mode-transition-runtime.service';
import type { NightModeCloseNoticeCleanupBinding } from './night-mode-close-notice-cleanup-binding';

const NIGHT_SCHEDULE_FINGERPRINT = buildNightModeTransitionScheduleFingerprint({
  nightModeEnabled: true,
  nightModeStartTimeMinutes: 23 * 60,
  nightModeEndTimeMinutes: 8 * 60,
  nightModeTimezone: 'Europe/Moscow',
});

const CLEANUP_BINDING: NightModeCloseNoticeCleanupBinding = {
  version: 1,
  sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
  scheduleFingerprint: `sha256:${'a'.repeat(64)}`,
  sideEffectFingerprint: `sha256:${'b'.repeat(64)}`,
  event: {
    id: 'night-close-event-1',
    ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
    messageId: 'close-message-1',
  },
};

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: code ? { code, message } : { message },
    },
  });
}

function createSettings(
  overrides: Partial<NightModeTransitionRuntimeSettings> = {},
): NightModeTransitionRuntimeSettings {
  return {
    chatId: 'chat-1',
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: true,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseUntil: '',
    nightModeBotButtons: null,
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: '',
    nightModeRulesButtonEnabled: false,
    commentsEnabled: false,
    botSpeechStyle: 'ROBOT',
    botSpeechMedia: null,
    updatedAt: new Date('2026-05-30T19:00:00.000Z'),
    chat: {
      rules: null,
    },
    ...overrides,
  };
}

function createAdapters(
  overrides: Partial<NightModeTransitionDeliveryAdapters> = {},
): NightModeTransitionDeliveryAdapters {
  return {
    getBotSpeechProfile: jest.fn((botId?: string | null) =>
      botId === 'bot-survivor'
        ? {
            persona: 'female',
            characterName: 'Майор Максимова',
          }
        : {
            persona: 'male',
            characterName: 'Майор Максимов',
          },
    ),
    buildClosedNoticeOptions: jest.fn().mockReturnValue({
      buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://example.test' }]],
    }),
    resolveBotId: jest.fn().mockResolvedValue('bot-1'),
    ...overrides,
  };
}

function createEventService() {
  return {
    createTransitionEvent: jest.fn().mockResolvedValue(undefined),
  };
}

describe('NightModeTransitionDeliveryService', () => {
  it('repairs an opening event from its own exact accepted receipt without MAX calls', async () => {
    const maxClient = { sendMessage: jest.fn(), deleteMessage: jest.fn() };
    const eventService = {
      ensureTransitionEvent: jest.fn().mockResolvedValue({ id: 'open-event' }),
    };
    const ledger = {
      inspectCompletedNightModeOpenNoticeDispatch: jest.fn().mockResolvedValue({
        kind: 'completed',
        jobId: 'night-mode:open:chat-1:session:session-1',
        remoteMessageId: 'open-message',
        dispatchBotId: 'bot-1',
        completedAt: new Date(),
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {} as never,
      eventService as never,
      undefined,
      undefined,
      undefined,
      ledger as never,
    );
    const params = {
      chatId: 'chat-1',
      sessionKey: 'session-1',
      messageId: 'open-message',
      botId: 'bot-1',
      timezone: 'Europe/Moscow',
      startMinutes: 1380,
      endMinutes: 480,
    };
    await expect(service.recoverOpenedNoticeEvent(params)).resolves.toMatchObject({
      eventId: 'open-event',
      messageId: 'open-message',
    });
    expect(eventService.ensureTransitionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
        messageId: 'open-message',
        botId: 'bot-1',
      }),
    );
    await expect(
      service.recoverOpenedNoticeEvent({ ...params, botId: 'foreign-bot' }),
    ).rejects.toThrow('Exact completed night mode open send is not proven');
    expect(eventService.ensureTransitionEvent).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('hands an exact recovery obligation to the durable scheduler and propagates persistence failure', async () => {
    const error = new Error('registry unavailable');
    const scheduler = { scheduleRecoveryObligation: jest.fn().mockRejectedValue(error) };
    const service = new NightModeTransitionDeliveryService(
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scheduler as never,
    );
    const recovery = {
      kind: 'open_notice_event' as const,
      version: 1 as const,
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      messageId: 'open-message',
      botId: 'bot-1',
      timezone: 'Europe/Moscow',
      startMinutes: 1380,
      endMinutes: 480,
    };
    await expect(service.scheduleRecoveryObligation('chat-1', recovery)).rejects.toBe(error);
    expect(scheduler.scheduleRecoveryObligation).toHaveBeenCalledWith('chat-1', recovery);
  });

  it('recovers a close event only from exact completed ledger proof without MAX calls', async () => {
    const completedAt = new Date('2026-05-30T20:00:01.000Z');
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const eventService = {
      createTransitionEvent: jest.fn(),
      ensureTransitionEvent: jest.fn().mockResolvedValue({ id: 'night-close-event-recovered-1' }),
    };
    const maxActionLedgerService = {
      getExactCompletedNightModeCloseNoticeDispatch: jest.fn().mockResolvedValue({
        jobId: 'night-mode:close:chat-1:session:session-1',
        remoteMessageId: 'mid-close-1',
        dispatchBotId: 'bot-survivor',
        completedAt,
        routeHalfOpenProbe: true,
      }),
    };
    const routeVerificationService = {
      isSchedulingAvailable: jest.fn().mockReturnValue(true),
      schedule: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {} as never,
      eventService as never,
      undefined,
      undefined,
      undefined,
      maxActionLedgerService as never,
      routeVerificationService as never,
    );

    await expect(
      service.recoverClosedNoticeEvent({
        chatId: 'chat-1',
        sessionKey: 'session-1',
        messageId: 'mid-close-1',
        botId: 'bot-survivor',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).resolves.toEqual({
      eventId: 'night-close-event-recovered-1',
      sessionKey: 'session-1',
      messageId: 'mid-close-1',
      botId: 'bot-survivor',
    });

    expect(
      maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch,
    ).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: 'session-1',
      messageId: 'mid-close-1',
      dispatchBotId: 'bot-survivor',
    });
    expect(eventService.ensureTransitionEvent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'mid-close-1',
      botId: 'bot-survivor',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: 'session-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    });
    expect(routeVerificationService.schedule).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: 'session-1',
      messageId: 'mid-close-1',
      botId: 'bot-survivor',
      sentAt: completedAt,
    });
    expect(routeVerificationService.schedule.mock.invocationCallOrder[0]).toBeLessThan(
      eventService.ensureTransitionEvent.mock.invocationCallOrder[0]!,
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not persist a recovered close event when route verification scheduling fails', async () => {
    const completedAt = new Date('2026-05-30T20:00:01.000Z');
    const schedulingError = new Error('verification queue unavailable');
    const eventService = {
      createTransitionEvent: jest.fn(),
      ensureTransitionEvent: jest.fn(),
    };
    const maxActionLedgerService = {
      getExactCompletedNightModeCloseNoticeDispatch: jest.fn().mockResolvedValue({
        jobId: 'night-mode:close:chat-1:session:session-1',
        remoteMessageId: 'mid-close-1',
        dispatchBotId: 'bot-survivor',
        completedAt,
        routeHalfOpenProbe: true,
      }),
    };
    const routeVerificationService = {
      isSchedulingAvailable: jest.fn().mockReturnValue(true),
      schedule: jest.fn().mockRejectedValue(schedulingError),
    };
    const service = new NightModeTransitionDeliveryService(
      { sendMessage: jest.fn(), deleteMessage: jest.fn() } as never,
      {} as never,
      eventService as never,
      undefined,
      undefined,
      undefined,
      maxActionLedgerService as never,
      routeVerificationService as never,
    );

    await expect(
      service.recoverClosedNoticeEvent({
        chatId: 'chat-1',
        sessionKey: 'session-1',
        messageId: 'mid-close-1',
        botId: 'bot-survivor',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).rejects.toBe(schedulingError);

    expect(routeVerificationService.schedule).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: 'session-1',
      messageId: 'mid-close-1',
      botId: 'bot-survivor',
      sentAt: completedAt,
    });
    expect(eventService.ensureTransitionEvent).not.toHaveBeenCalled();
  });

  it('retains recovery failure when exact completed ledger proof is missing', async () => {
    const eventService = {
      createTransitionEvent: jest.fn(),
      ensureTransitionEvent: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      { sendMessage: jest.fn(), deleteMessage: jest.fn() } as never,
      {} as never,
      eventService as never,
      undefined,
      undefined,
      undefined,
      {
        getExactCompletedNightModeCloseNoticeDispatch: jest.fn().mockResolvedValue(null),
      } as never,
    );

    await expect(
      service.recoverClosedNoticeEvent({
        chatId: 'chat-1',
        sessionKey: 'session-1',
        messageId: 'mid-close-1',
        botId: 'bot-1',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).rejects.toThrow(
      'Exact completed night mode close send is not proven (night-mode:close:chat-1:session:session-1)',
    );
    expect(eventService.ensureTransitionEvent).not.toHaveBeenCalled();
  });

  it('recovers a markerless close event from an exact completed session ledger', async () => {
    const eventService = {
      createTransitionEvent: jest.fn(),
      ensureTransitionEvent: jest.fn().mockResolvedValue({ id: 'night-close-event-ledger-1' }),
    };
    const maxActionLedgerService = {
      inspectCompletedNightModeCloseNoticeDispatch: jest.fn().mockResolvedValue({
        kind: 'completed',
        jobId: 'night-mode:close:chat-1:session:session-1',
        remoteMessageId: 'mid-close-ledger-1',
        dispatchBotId: 'bot-ledger-1',
      }),
    };
    const maxClient = { sendMessage: jest.fn(), deleteMessage: jest.fn() };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {} as never,
      eventService as never,
      undefined,
      undefined,
      undefined,
      maxActionLedgerService as never,
    );

    await expect(
      service.recoverClosedNoticeEventFromLedger({
        chatId: 'chat-1',
        sessionKey: 'session-1',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).resolves.toEqual({
      eventId: 'night-close-event-ledger-1',
      sessionKey: 'session-1',
      messageId: 'mid-close-ledger-1',
      botId: 'bot-ledger-1',
    });
    expect(eventService.ensureTransitionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'mid-close-ledger-1',
        botId: 'bot-ledger-1',
        sessionKey: 'session-1',
      }),
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('distinguishes a missing close ledger from unsafe persisted provenance', async () => {
    const eventService = {
      createTransitionEvent: jest.fn(),
      ensureTransitionEvent: jest.fn(),
    };
    const inspectCompletedNightModeCloseNoticeDispatch = jest
      .fn()
      .mockResolvedValueOnce({
        kind: 'missing',
        jobId: 'night-mode:close:chat-1:session:session-1',
      })
      .mockResolvedValueOnce({
        kind: 'mismatch',
        jobId: 'night-mode:close:chat-1:session:session-1',
      });
    const service = new NightModeTransitionDeliveryService(
      { sendMessage: jest.fn(), deleteMessage: jest.fn() } as never,
      {} as never,
      eventService as never,
      undefined,
      undefined,
      undefined,
      { inspectCompletedNightModeCloseNoticeDispatch } as never,
    );
    const params = {
      chatId: 'chat-1',
      sessionKey: 'session-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    };

    await expect(service.recoverClosedNoticeEventFromLedger(params)).resolves.toBeNull();
    await expect(service.recoverClosedNoticeEventFromLedger(params)).rejects.toThrow(
      'Night mode close send ledger provenance is unsafe',
    );
    expect(eventService.ensureTransitionEvent).not.toHaveBeenCalled();
  });

  it('does not treat an unavailable recovery ledger as a missing row', async () => {
    const service = new NightModeTransitionDeliveryService(
      { sendMessage: jest.fn(), deleteMessage: jest.fn() } as never,
      {} as never,
      { createTransitionEvent: jest.fn(), ensureTransitionEvent: jest.fn() } as never,
    );

    await expect(
      service.recoverClosedNoticeEventFromLedger({
        chatId: 'chat-1',
        sessionKey: 'session-1',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).rejects.toThrow(
      'Night mode close-event recovery ledger is unavailable (night-mode:close:chat-1:session:session-1)',
    );
  });

  it('routes a scheduled close notice with a stable session key and bot-scoped media preparation', async () => {
    const completedAt = new Date('2026-07-11T20:00:01.000Z');
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue({
        base64: 'aW1hZ2U=',
        mimeType: 'image/png',
        fileName: 'night.png',
        fieldKey: 'nightModeBotMessageText',
      }),
      withMediaOptions: jest.fn(async (options) => ({
        ...(options ?? {}),
        imagePayload: { token: 'survivor-upload' },
      })),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const job = { idempotencyKey: request.logicalIdempotencyKey };
        const prepared = await request.prepareAttempt({ botId: 'bot-survivor', job });
        expect(prepared).toEqual(
          expect.objectContaining({
            text: '<strong>Майор Максимова</strong>: <em>Новые сообщения временно не принимаются.</em>',
          }),
        );
        expect(prepared).toEqual({
          text: '<strong>Майор Максимова</strong>: <em>Новые сообщения временно не принимаются.</em>',
          options: expect.objectContaining({
            textFormat: 'html',
            imagePayload: { token: 'survivor-upload' },
          }),
        });
        await request.onDispatchAttempt({ botId: 'bot-survivor', job: { ...job, ...prepared } });
        await request.beforeSendMutation({
          botId: 'bot-survivor',
          job: { ...job, ...prepared },
        });
        return {
          messageId: 'msg-routed-close-1',
          url: null,
          botId: 'bot-survivor',
          candidateBotIds: ['bot-primary', 'bot-survivor'],
          routingVersion: 11,
        };
      }),
    };
    const eventService = createEventService();
    const maxActionLedgerService = {
      getExactCompletedNightModeCloseNoticeDispatch: jest.fn().mockResolvedValue({
        jobId: 'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-07-11',
        remoteMessageId: 'msg-routed-close-1',
        dispatchBotId: 'bot-survivor',
        completedAt,
        routeHalfOpenProbe: true,
      }),
    };
    const routeVerificationService = {
      isSchedulingAvailable: jest.fn().mockReturnValue(true),
      schedule: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
      undefined,
      maxRoutedPublicationService as never,
      undefined,
      maxActionLedgerService as never,
      routeVerificationService as never,
    );
    const adapters = createAdapters();

    await expect(
      service.sendClosedNotice(
        createSettings({
          nightModeBotMessageText: '**{bot_character_name}**: _{night_status}_',
        }),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
          stickyRouteProbe: {
            kind: 'future_night_close',
            version: 1,
            authorizedAt: '2026-07-11T19:55:00.000Z',
            scheduledFor: '2026-07-11T20:00:00.000Z',
            sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
            scheduleFingerprint: NIGHT_SCHEDULE_FINGERPRINT,
          },
        },
        adapters,
      ),
    ).resolves.toEqual({
      shouldEnqueueNext: true,
      messageId: 'msg-routed-close-1',
      botId: 'bot-survivor',
    });

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'chat-1',
        logicalIdempotencyKey:
          'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-07-11',
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        hydrateMessageUrl: false,
        ignoreFailureMetricStatuses: [403, 404],
        sendRouteHalfOpenProbe: 'publication_exact_verification',
        sendRouteStickyProbe: {
          kind: 'future_night_close_v1',
          authorizedAt: '2026-07-11T19:55:00.000Z',
          failureBefore: '2026-07-11T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
          scheduleFingerprint: NIGHT_SCHEDULE_FINGERPRINT,
        },
      }),
    );
    expect(botSpeechMediaService.withMediaOptions).toHaveBeenCalledWith(
      expect.objectContaining({ textFormat: 'html' }),
      expect.objectContaining({ fieldKey: 'nightModeBotMessageText' }),
      { botId: 'bot-survivor', sourceTag: 'night_mode_transition' },
    );
    expect(adapters.resolveBotId).not.toHaveBeenCalled();
    expect(adapters.getBotSpeechProfile).toHaveBeenCalledWith('bot-survivor');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(eventService.createTransitionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-routed-close-1',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
      }),
    );
    expect(routeVerificationService.schedule).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
      messageId: 'msg-routed-close-1',
      botId: 'bot-survivor',
      sentAt: completedAt,
    });
    expect(routeVerificationService.schedule.mock.invocationCallOrder[0]).toBeLessThan(
      eventService.createTransitionEvent.mock.invocationCallOrder[0]!,
    );
  });

  it('does not persist a freshly accepted close event when verification scheduling fails', async () => {
    const completedAt = new Date('2026-07-11T20:00:01.000Z');
    const schedulingError = new Error('verification queue unavailable');
    const eventService = createEventService();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockResolvedValue({
        messageId: 'msg-routed-close-1',
        url: null,
        botId: 'bot-survivor',
        candidateBotIds: ['bot-survivor'],
        routingVersion: 11,
      }),
    };
    const maxActionLedgerService = {
      getExactCompletedNightModeCloseNoticeDispatch: jest.fn().mockResolvedValue({
        jobId: 'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-07-11',
        remoteMessageId: 'msg-routed-close-1',
        dispatchBotId: 'bot-survivor',
        completedAt,
        routeHalfOpenProbe: true,
      }),
    };
    const routeVerificationService = {
      isSchedulingAvailable: jest.fn().mockReturnValue(true),
      schedule: jest.fn().mockRejectedValue(schedulingError),
    };
    const service = new NightModeTransitionDeliveryService(
      { sendMessage: jest.fn(), deleteMessage: jest.fn() } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      eventService as never,
      undefined,
      maxRoutedPublicationService as never,
      undefined,
      maxActionLedgerService as never,
      routeVerificationService as never,
    );

    await expect(
      service.sendClosedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
        },
        createAdapters(),
      ),
    ).rejects.toBe(schedulingError);

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    const publicationRequest = maxRoutedPublicationService.publish.mock.calls[0]![0];
    expect(publicationRequest).not.toHaveProperty('sendRouteStickyProbe');
    expect(routeVerificationService.schedule).toHaveBeenCalledWith({
      chatId: 'chat-1',
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
      messageId: 'msg-routed-close-1',
      botId: 'bot-survivor',
      sentAt: completedAt,
    });
    expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
  });

  it('never opts an opening notice into send-route half-open probing', async () => {
    const eventService = createEventService();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockResolvedValue({
        messageId: 'msg-routed-open-1',
        url: null,
        botId: 'bot-survivor',
        candidateBotIds: ['bot-survivor'],
        routingVersion: 11,
      }),
    };
    const maxActionLedgerService = {
      getExactCompletedNightModeCloseNoticeDispatch: jest.fn(),
    };
    const routeVerificationService = {
      isSchedulingAvailable: jest.fn().mockReturnValue(true),
      schedule: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      { sendMessage: jest.fn(), deleteMessage: jest.fn() } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      eventService as never,
      undefined,
      maxRoutedPublicationService as never,
      undefined,
      maxActionLedgerService as never,
      routeVerificationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
        },
        createAdapters(),
      ),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    const request = maxRoutedPublicationService.publish.mock.calls[0]![0];
    expect(request).not.toHaveProperty('sendRouteHalfOpenProbe');
    expect(request).not.toHaveProperty('sendRouteStickyProbe');
    expect(routeVerificationService.schedule).not.toHaveBeenCalled();
    expect(
      maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch,
    ).not.toHaveBeenCalled();
    expect(eventService.createTransitionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-routed-open-1',
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      }),
    );
  });

  it('revalidates state after routed preparation and immediately before MAX dispatch', async () => {
    const eventService = createEventService();
    const validateBeforeDispatch = jest.fn().mockResolvedValue(false);
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        await request.prepareAttempt({
          botId: 'bot-routed',
          job: { idempotencyKey: request.logicalIdempotencyKey },
        });
        await request.onDispatchAttempt({ botId: 'bot-routed', job: {} });
        expect(validateBeforeDispatch).not.toHaveBeenCalled();
        await request.beforeSendMutation({ botId: 'bot-routed', job: {} });
        throw new Error('unreachable HTTP dispatch');
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      eventService as never,
      undefined,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-final-dispatch-fence',
        },
        createAdapters(),
        validateBeforeDispatch,
      ),
    ).rejects.toThrow('Night mode transition state changed before dispatch (chat-1)');

    expect(validateBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
  });

  it('fails closed in production when routed publication wiring is missing', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(),
      } as never,
      createEventService() as never,
    );

    try {
      await expect(
        service.sendClosedNotice(
          createSettings(),
          {
            startMinutes: 23 * 60,
            endMinutes: 8 * 60,
            timezone: 'Europe/Moscow',
            sessionKey: 'session-1',
          },
          createAdapters(),
        ),
      ).rejects.toThrow(
        'Routed MAX publication service is required for production night mode notices',
      );
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('does not create a transition event when routed delivery has no executable bot', async () => {
    const noRouteError = new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1');
    const eventService = createEventService();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockRejectedValue(noRouteError),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(),
      } as never,
      eventService as never,
      undefined,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-no-route',
        },
        createAdapters(),
      ),
    ).rejects.toBe(noRouteError);

    expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
  });

  it('records a routed terminal send against the dispatch attempt epoch', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    const errorHandledAt = new Date('2026-08-20T12:00:05.456Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        await request.onDispatchAttempt({ botId: 'bot-routed', job: {} });
        await request.beforeSendMutation({ botId: 'bot-routed', job: {} });
        jest.setSystemTime(errorHandledAt);
        throw createMaxApiError(403, 'Request failed with status code 403', 'chat.denied');
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      maxRoutedPublicationService as never,
    );

    try {
      await expect(
        service.sendOpenedNotice(
          createSettings(),
          {
            startMinutes: 23 * 60,
            endMinutes: 8 * 60,
            timezone: 'Europe/Moscow',
            sessionKey: 'session-routed-terminal',
          },
          createAdapters(),
        ),
      ).resolves.toEqual({ shouldEnqueueNext: false });

      expect(accessLoss.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-routed',
        reason: 'bot_denied',
        source: 'night_mode_transition:send-open-notice',
        lastMaxErrorCode: 'chat.denied',
        lastMaxErrorMessage: 'request failed with status code 403',
        lastMaxStatusCode: 403,
        lifecycleEventAt: dispatchAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([403, 404])(
    'retains a failed notice when MAX returns an ambiguous HTTP %s',
    async (status) => {
      const error = createMaxApiError(status, `Request failed with status code ${status}`);
      const maxClient = {
        sendMessage: jest.fn().mockRejectedValue(error),
        deleteMessage: jest.fn(),
      };
      const accessLoss = { recordManagedEntityAccessLost: jest.fn() };
      const eventService = createEventService();
      const service = new NightModeTransitionDeliveryService(
        maxClient as never,
        {
          resolveMedia: jest.fn().mockReturnValue(null),
          withMediaOptions: jest.fn(async (options) => options),
        } as never,
        eventService as never,
        accessLoss as never,
      );
      await expect(
        service.sendClosedNotice(
          createSettings(),
          {
            startMinutes: 23 * 60,
            endMinutes: 8 * 60,
            timezone: 'Europe/Moscow',
            sessionKey: 'unknown-status',
          },
          createAdapters(),
        ),
      ).rejects.toBe(error);
      expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
      expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
    },
  );

  it('does not record access loss for a terminal-shaped pre-dispatch failure', async () => {
    const preDispatchError = createMaxApiError(403, 'Request failed with status code 403');
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn(),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockRejectedValue(preDispatchError),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-routed-pre-dispatch',
        },
        createAdapters(),
      ),
    ).rejects.toBe(preDispatchError);

    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('does not record access loss when the final send guard rejects after attempt tracking', async () => {
    const guardError = markMaxPreDispatchGuardRejected(
      createMaxApiError(403, 'Validation lookup was denied'),
      MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn(),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        await request.onDispatchAttempt({ botId: 'bot-routed', job: {} });
        throw guardError;
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-routed-guard-denied',
        },
        createAdapters(),
      ),
    ).rejects.toBe(guardError);

    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('does not duplicate routed access loss already recorded by action dispatch', async () => {
    const terminalError = Object.assign(
      createMaxApiError(403, 'Request failed with status code 403'),
      { maxManagedEntityAccessLossRecorded: true },
    );
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn(),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        await request.onDispatchAttempt({ botId: 'bot-routed', job: {} });
        await request.beforeSendMutation({ botId: 'bot-routed', job: {} });
        throw terminalError;
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-routed-recorded',
        },
        createAdapters(),
      ),
    ).resolves.toEqual({ shouldEnqueueNext: false });

    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('sends a closed notice with markdown, background request options, media adapter, and event', async () => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue({ messageId: 'msg-close-1' }),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue({
        base64: 'aW1hZ2U=',
        mimeType: 'image/png',
        fileName: 'night.png',
        fieldKey: 'nightModeBotMessageText',
      }),
      withMediaOptions: jest.fn(async (options) => ({
        ...(options ?? {}),
        imagePayload: { token: 'image-token' },
      })),
    };
    const eventService = createEventService();
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
    );
    const adapters = createAdapters();

    await expect(
      service.sendClosedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-1',
        },
        adapters,
      ),
    ).resolves.toEqual({
      shouldEnqueueNext: true,
      messageId: 'msg-close-1',
      botId: 'bot-1',
    });

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      '🌙 Перерыв в общении: 23:00-08:00 (Москва). До открытия новые сообщения будут удаляться.',
      expect.objectContaining({
        textFormat: 'html',
        imagePayload: { token: 'image-token' },
      }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'bot-1',
        immediate: true,
        idempotencyKey: 'night-mode:close:chat-1:session:session-1',
        beforeImmediateSendMutation: expect.any(Function),
      }),
    );
    expect(botSpeechMediaService.resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'nightModeBotMessageText',
    );
    expect(botSpeechMediaService.withMediaOptions).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ fieldKey: 'nightModeBotMessageText' }),
      { botId: 'bot-1', sourceTag: 'night_mode_transition' },
    );
    expect(eventService.createTransitionEvent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'msg-close-1',
      botId: 'bot-1',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: 'session-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    });
  });

  it.each([
    {
      transition: 'close',
      scenario: 'whitespace-only override',
      settings: { nightModeBotMessageText: ' \t\n ' },
      expectedText:
        '🌙 Перерыв в общении: 23:00-08:00 (Москва). До открытия новые сообщения будут удаляться.',
    },
    {
      transition: 'open',
      scenario: 'whitespace-only override',
      settings: { nightModeOpenMessageText: ' \t\n ' },
      expectedText: 'Чат снова открыт.',
    },
    {
      transition: 'close',
      scenario: 'placeholder-only override',
      settings: { nightModeBotMessageText: '{user}' },
      expectedText:
        '🌙 Перерыв в общении: 23:00-08:00 (Москва). До открытия новые сообщения будут удаляться.',
    },
    {
      transition: 'open',
      scenario: 'placeholder-only override',
      settings: { nightModeOpenMessageText: '{user}' },
      expectedText: 'Чат снова открыт.',
    },
    {
      transition: 'close',
      scenario: 'meaningful surrounding whitespace',
      settings: { nightModeBotMessageText: '  Свой текст закрытия.  ' },
      expectedText: '&nbsp;&nbsp;Свой текст закрытия.&nbsp;&nbsp;',
    },
    {
      transition: 'open',
      scenario: 'meaningful surrounding whitespace',
      settings: { nightModeOpenMessageText: '  Свой текст открытия.  ' },
      expectedText: '&nbsp;&nbsp;Свой текст открытия.&nbsp;&nbsp;',
    },
  ] as const)(
    'delivers safe $transition notice copy for $scenario when media is absent',
    async ({ transition, settings, expectedText }) => {
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({ messageId: `msg-${transition}-fallback` }),
        deleteMessage: jest.fn(),
      };
      const botSpeechMediaService = {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      };
      const service = new NightModeTransitionDeliveryService(
        maxClient as never,
        botSpeechMediaService as never,
        createEventService() as never,
      );
      const runtimeSettings = createSettings({ ...settings });
      const snapshot = {
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
        timezone: 'Europe/Moscow',
        sessionKey: `session-${transition}-fallback`,
      };

      if (transition === 'close') {
        await service.sendClosedNotice(runtimeSettings, snapshot, createAdapters());
      } else {
        await service.sendOpenedNotice(runtimeSettings, snapshot, createAdapters());
      }

      expect(botSpeechMediaService.resolveMedia).toHaveReturnedWith(null);
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        expectedText,
        expect.any(Object),
        expect.any(Object),
      );
    },
  );

  it('falls back to bounded MAX markdown when rendered night-mode HTML expands past the limit', async () => {
    const sourceText = '&'.repeat(1_000);
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue({ messageId: 'msg-close-bounded-1' }),
      deleteMessage: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
    );

    await expect(
      service.sendClosedNotice(
        createSettings({ nightModeBotMessageText: sourceText }),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-bounded-1',
        },
        createAdapters(),
      ),
    ).resolves.toEqual({
      shouldEnqueueNext: true,
      messageId: 'msg-close-bounded-1',
      botId: 'bot-1',
    });

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      sourceText,
      expect.objectContaining({ textFormat: 'markdown' }),
      expect.any(Object),
    );
  });

  it('keeps the accepted close notice id when event persistence fails after send', async () => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue({ messageId: 'msg-close-1' }),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue(null),
      withMediaOptions: jest.fn(async (options) => options),
    };
    const eventError = new Error('database is temporarily unavailable');
    const eventService = {
      createTransitionEvent: jest.fn().mockRejectedValue(eventError),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
    );

    const result = service.sendClosedNotice(
      createSettings(),
      {
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
        timezone: 'Europe/Moscow',
        sessionKey: 'session-1',
      },
      createAdapters(),
    );

    await expect(result).rejects.toBeInstanceOf(NightModeTransitionNoticeEventPersistenceError);
    await expect(result).rejects.toMatchObject({
      name: 'NightModeTransitionNoticeEventPersistenceError',
      details: {
        chatId: 'chat-1',
        messageId: 'msg-close-1',
        botId: 'bot-1',
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        sessionKey: 'session-1',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      },
    });
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('sends an opened notice and creates an open event', async () => {
    const maxClient = {
      sendMessage: jest.fn().mockResolvedValue({ messageId: 'msg-open-1' }),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue(null),
      withMediaOptions: jest.fn(async (options) => options),
    };
    const eventService = createEventService();
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
    );
    const adapters = createAdapters();

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-1',
        },
        adapters,
      ),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Чат снова открыт.',
      expect.objectContaining({ textFormat: 'html' }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        botId: 'bot-1',
        immediate: true,
        idempotencyKey: 'night-mode:open:chat-1:session:session-1',
        beforeImmediateSendMutation: expect.any(Function),
      }),
    );
    expect(botSpeechMediaService.resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'nightModeOpenMessageText',
    );
    expect(eventService.createTransitionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-open-1',
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      }),
    );
  });

  it.each(['limiter', 'route'])(
    'revalidates the direct fallback after %s interleave at the immediate send hook',
    async (interleave) => {
      let current = true;
      let releaseLimiter: () => void = () => undefined;
      const limiterGate = new Promise<void>((resolve) => {
        releaseLimiter = resolve;
      });
      let markLimiterEntered: () => void = () => undefined;
      const limiterEntered = new Promise<void>((resolve) => {
        markLimiterEntered = resolve;
      });
      let httpSendCalled = false;
      const maxClient = {
        sendMessage: jest.fn(
          async (
            _chatId: string,
            _text: string,
            _options: unknown,
            dispatchOptions: {
              idempotencyKey?: string;
              beforeImmediateSendMutation?: (
                revalidateRoute?: () => Promise<void>,
              ) => Promise<void>;
            },
          ) => {
            expect(dispatchOptions.idempotencyKey).toBe(
              'night-mode:open:chat-1:session:session-direct-final-guard',
            );
            markLimiterEntered();
            await limiterGate;
            await dispatchOptions.beforeImmediateSendMutation?.(async () => {
              if (interleave === 'route') current = false;
            });
            httpSendCalled = true;
            return { messageId: 'unexpected-message' };
          },
        ),
        deleteMessage: jest.fn(),
      };
      const eventService = createEventService();
      const service = new NightModeTransitionDeliveryService(
        maxClient as never,
        {
          resolveMedia: jest.fn().mockReturnValue(null),
          withMediaOptions: jest.fn(async (options) => options),
        } as never,
        eventService as never,
      );
      const validateBeforeDispatch = jest.fn(async () => current);

      const delivery = service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-direct-final-guard',
        },
        createAdapters(),
        validateBeforeDispatch,
      );
      await limiterEntered;
      if (interleave === 'limiter') current = false;
      releaseLimiter();

      await expect(delivery).rejects.toThrow(
        'Night mode transition state changed before dispatch (chat-1)',
      );
      expect(validateBeforeDispatch).toHaveBeenCalledTimes(1);
      expect(httpSendCalled).toBe(false);
      expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the direct immediate send completes without a message id', async () => {
    const eventService = createEventService();
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      eventService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-missing-message-id',
        },
        createAdapters(),
      ),
    ).rejects.toThrow(
      'Immediate MAX night mode publication night-mode:open:chat-1:session:session-missing-message-id completed without a message id',
    );
    expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
  });

  it('records access loss and stops scheduling on terminal send errors', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T13:00:00.123Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const maxClient = {
      sendMessage: jest
        .fn()
        .mockRejectedValue(
          createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
        ),
      deleteMessage: jest.fn(),
    };
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
    );

    try {
      await expect(
        service.sendClosedNotice(
          createSettings(),
          {
            startMinutes: 23 * 60,
            endMinutes: 8 * 60,
            timezone: 'Europe/Moscow',
            sessionKey: 'session-1',
          },
          createAdapters(),
        ),
      ).resolves.toEqual({ shouldEnqueueNext: false, messageId: null, botId: null });

      expect(accessLoss.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'chat_not_found',
        source: 'night_mode_transition:send-close-notice',
        lastMaxErrorCode: 'chat.not.found',
        lastMaxErrorMessage: 'request failed with status code 404',
        lastMaxStatusCode: 404,
        lifecycleEventAt: dispatchAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands close notice cleanup to a durable origin-only intent in execute rollout', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const eventService = createEventService();
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-close-notice-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      eventService as never,
      undefined,
      undefined,
      deleteIntents as never,
    );

    await expect(
      service.deleteClosedNotice(
        'chat-1',
        'close-message-1',
        'origin-bot-1',
        CLEANUP_BINDING,
        createAdapters(),
      ),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(deleteIntents.ensureIntent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'close-message-1',
      reasonKey: 'NIGHT_MODE_CLOSE_NOTICE_CLEANUP',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE_CLEANUP',
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'origin-bot-1',
      routingPolicy: 'origin_only',
      event: {
        eventType: 'SYSTEM',
        metadata: {
          nightModeCloseNoticeCleanup: CLEANUP_BINDING,
        },
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
  });

  it('revalidates state immediately before creating a durable close-notice delete intent', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      undefined,
      undefined,
      deleteIntents as never,
    );
    const validateBeforeDispatch = jest.fn().mockResolvedValue(false);

    await expect(
      service.deleteClosedNotice(
        'chat-1',
        'close-message-stale-1',
        'origin-bot-1',
        CLEANUP_BINDING,
        createAdapters(),
        validateBeforeDispatch,
      ),
    ).rejects.toThrow('Night mode transition state changed before dispatch (chat-1)');

    expect(validateBeforeDispatch).toHaveBeenCalledTimes(1);
    expect(deleteIntents.ensureIntent).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not create an origin-only intent when a historical close notice has no author bot', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      undefined,
      undefined,
      deleteIntents as never,
    );

    await expect(
      service.deleteClosedNotice(
        'chat-1',
        'historical-close-1',
        null,
        CLEANUP_BINDING,
        createAdapters(),
      ),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(deleteIntents.ensureIntent).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'historical-close-1',
      expect.objectContaining({ botId: 'bot-1', immediate: true }),
    );
  });

  it('revalidates direct cleanup after limiter interleave and before the HTTP mutation', async () => {
    let current = true;
    let releaseLimiter: () => void = () => undefined;
    const limiterGate = new Promise<void>((resolve) => {
      releaseLimiter = resolve;
    });
    let markLimiterEntered: () => void = () => undefined;
    const limiterEntered = new Promise<void>((resolve) => {
      markLimiterEntered = resolve;
    });
    let httpDeleteCalled = false;
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          options: { beforeImmediateDeleteMutation?: () => Promise<void> },
        ) => {
          markLimiterEntered();
          await limiterGate;
          await options.beforeImmediateDeleteMutation?.();
          httpDeleteCalled = true;
        },
      ),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
    );
    const validateBeforeDispatch = jest.fn(async () => current);

    const cleanup = service.deleteClosedNotice(
      'chat-1',
      'historical-close-1',
      null,
      CLEANUP_BINDING,
      createAdapters(),
      validateBeforeDispatch,
    );
    await limiterEntered;
    current = false;
    releaseLimiter();

    await expect(cleanup).rejects.toThrow(
      'Night mode transition state changed before dispatch (chat-1)',
    );
    expect(validateBeforeDispatch).toHaveBeenCalledTimes(2);
    expect(httpDeleteCalled).toBe(false);
  });

  it('does not treat an arbitrary 404 as successful historical notice deletion', async () => {
    const error = createMaxApiError(404, 'Request failed with status code 404');
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn().mockRejectedValue(error),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
    );

    await expect(
      service.deleteClosedNotice(
        'chat-1',
        'historical-close-1',
        null,
        CLEANUP_BINDING,
        createAdapters(),
      ),
    ).rejects.toBe(error);
  });

  it('records terminal direct deletion against the MAX attempt epoch', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T14:00:00.123Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest
        .fn()
        .mockRejectedValue(createMaxApiError(404, 'Chat not found', 'chat.not.found')),
    };
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
    );

    try {
      await expect(
        service.deleteClosedNotice(
          'chat-1',
          'historical-close-1',
          null,
          CLEANUP_BINDING,
          createAdapters(),
        ),
      ).resolves.toEqual({ shouldEnqueueNext: false });

      expect(accessLoss.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'chat_not_found',
        source: 'night_mode_transition:delete-close-notice',
        lastMaxErrorCode: 'chat.not.found',
        lastMaxErrorMessage: 'chat not found',
        lastMaxStatusCode: 404,
        lifecycleEventAt: dispatchAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps direct close-notice deletion as the shadow fallback', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest
        .fn()
        .mockRejectedValue(
          createMaxApiError(404, 'Request failed with status code 404', 'message.not.found'),
        ),
    };
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn(),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-close-notice-shadow-1',
        rollout: 'observed',
        status: 'OBSERVED',
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      undefined,
      deleteIntents as never,
    );

    await expect(
      service.deleteClosedNotice(
        'chat-1',
        'close-message-1',
        'origin-bot-1',
        CLEANUP_BINDING,
        createAdapters(),
      ),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(deleteIntents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'close-message-1',
        originBotId: 'origin-bot-1',
        routingPolicy: 'origin_only',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'close-message-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'origin-bot-1',
      }),
    );
    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });
});

describe('merged-session notice delivery', () => {
  it.each(['close', 'open'] as const)(
    'refuses a second %s with an old member effect',
    async (transition) => {
      const maxClient = { sendMessage: jest.fn(), deleteMessage: jest.fn() };
      const eventService = createEventService();
      const ledger = { hasNightModeAliasSendProvenance: jest.fn().mockResolvedValue(true) };
      const service = new NightModeTransitionDeliveryService(
        maxClient as never,
        {
          resolveMedia: jest.fn().mockReturnValue(null),
          withMediaOptions: jest.fn(async (options) => options),
        } as never,
        eventService as never,
        undefined,
        undefined,
        undefined,
        ledger as never,
      );
      const snapshot = {
        startMinutes: 180,
        endMinutes: 150,
        timezone: 'Europe/Berlin',
        sessionKey: 'v1:Europe/Berlin:03:00:02:30:2026-03-28',
      };
      const result =
        transition === 'close'
          ? service.sendClosedNotice(createSettings(), snapshot, createAdapters())
          : service.sendOpenedNotice(createSettings(), snapshot, createAdapters());
      await expect(result).rejects.toThrow('retains another SEND identity');
      expect(ledger.hasNightModeAliasSendProvenance).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          transition,
          sessionKey: snapshot.sessionKey,
        }),
      );
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
    },
  );
});
