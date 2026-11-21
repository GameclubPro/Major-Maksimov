import {
  ClosedChatMessageModerationService,
  type ClosedChatMessageDependencies,
} from './closed-chat-message-moderation.service';
import type { ModerationDeleteExecutionResult } from './profanity/profanity-delete-execution';
const message = {
  chatId: 'chat',
  userId: 'user',
  messageId: 'message',
  text: 'hello',
  createdAt: '2026-10-01T00:00:00Z',
};
const night = {
  ...message,
  nightModeStartTimeMinutes: 1380,
  nightModeEndTimeMinutes: 480,
  nightModeTimezone: 'Europe/Moscow',
};
const timed = {
  ...message,
  nightModeForceCloseForever: false,
  nightModeForceCloseUntil: '2026-10-02T00:00:00Z',
};
const result: ModerationDeleteExecutionResult = {
  accepted: true,
  gone: true,
  deleted: true,
  eventPersistedByIntent: false,
  botId: null,
};
const scenarios = [
  {
    name: 'night',
    rule: 'NIGHT_MODE_DELETE',
    run: (service: ClosedChatMessageModerationService) => service.handleNightModeMessage(night),
    metadata: {
      reason: 'Message removed while chat is closed for the night',
      nightModeTimezone: 'Europe/Moscow',
      nightModeStartTime: '23:00',
      nightModeEndTime: '08:00',
    },
  },
  {
    name: 'timed close',
    rule: 'MANUAL_GROUP_CLOSE_DELETE',
    run: (service: ClosedChatMessageModerationService) =>
      service.handleNightModeForceCloseMessage(timed),
    metadata: {
      reason: 'Message removed while group is manually closed',
      closeMode: 'timed',
      closeUntil: timed.nightModeForceCloseUntil,
    },
  },
  {
    name: 'permanent close',
    rule: 'MANUAL_GROUP_CLOSE_DELETE',
    run: (service: ClosedChatMessageModerationService) =>
      service.handleNightModeForceCloseMessage({ ...timed, nightModeForceCloseForever: true }),
    metadata: {
      reason: 'Message removed while group is manually closed',
      closeMode: 'forever',
      closeUntil: null,
    },
  },
];
function harness() {
  const effects: string[] = [];
  const dependencies = {
    ensureIntent: jest.fn(async () => {
      effects.push('ensure');
    }),
    ensureBothReasons: jest.fn(async () => {
      effects.push('both');
    }),
    claimAction: jest.fn(async (): Promise<boolean> => {
      effects.push('claim');
      return true;
    }),
    executeDelete: jest.fn(async () => {
      effects.push('delete');
      return result;
    }),
    createEvent: jest.fn(async () => {
      effects.push('event');
    }),
    warn: jest.fn(),
  } satisfies ClosedChatMessageDependencies;
  return { service: new ClosedChatMessageModerationService(dependencies), dependencies, effects };
}
describe.each(scenarios)('closed chat message: $name', ({ run, rule, metadata }) => {
  it('preserves intent, semantic claim and event order and metadata', async () => {
    const h = harness();
    await run(h.service);
    expect(h.effects).toEqual(['ensure', 'claim', 'delete', 'event']);
    const expected = expect.objectContaining({
      chatId: 'chat',
      messageId: 'message',
      subjectUserId: 'user',
      sourceMessageAt: message.createdAt,
      ruleCode: rule,
      reasonKey: rule,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: expect.objectContaining({
        userId: 'user',
        eventType: 'MESSAGE',
        score: 0.6,
        metadata,
      }),
    });
    expect(h.dependencies.ensureIntent).toHaveBeenCalledWith(expected);
    expect(h.dependencies.executeDelete).toHaveBeenCalledWith(expected);
    expect(h.dependencies.claimAction).toHaveBeenCalledWith({
      chatId: 'chat',
      userId: 'user',
      messageId: 'message',
      ruleCode: rule,
    });
    expect(h.dependencies.createEvent).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat',
        userId: 'user',
        messageId: 'message',
        ruleCode: rule,
        eventType: 'MESSAGE',
        operator: 'BOT',
        action: 'DELETE_MESSAGE',
        score: 0.6,
        metadata,
      }),
    });
  });
  it('materializes the durable intent even when another worker owns the message', async () => {
    const h = harness();
    h.dependencies.claimAction.mockImplementation(async () => {
      h.effects.push('claim');
      return false;
    });
    await run(h.service);
    expect(h.effects).toEqual(['ensure', 'claim']);
  });
  it.each(['ensureIntent', 'claimAction'] as const)(
    'propagates %s failures before delete handling',
    async (phase) => {
      const h = harness();
      h.dependencies[phase].mockRejectedValueOnce(new Error('store unavailable'));
      await expect(run(h.service)).rejects.toThrow('store unavailable');
      expect(h.dependencies.executeDelete).not.toHaveBeenCalled();
      expect(h.dependencies.warn).not.toHaveBeenCalled();
    },
  );
  it.each([
    { label: 'intent-owned event', value: { ...result, eventPersistedByIntent: true } },
    { label: 'already absent', value: { ...result, deleted: false } },
    { label: 'unconfirmed outcome', value: { ...result, gone: false, deleted: false } },
  ])('does not append an event for $label', async ({ value }) => {
    const h = harness();
    h.dependencies.executeDelete.mockResolvedValueOnce(value);
    await run(h.service);
    expect(h.dependencies.createEvent).not.toHaveBeenCalled();
  });
  it('contains execution failures and records the same diagnostic fields', async () => {
    const h = harness();
    h.dependencies.executeDelete.mockRejectedValueOnce(new Error('delete failed'));
    await run(h.service);
    expect(h.dependencies.createEvent).not.toHaveBeenCalled();
    expect(h.dependencies.warn).toHaveBeenCalledWith(
      { chatId: 'chat', userId: 'user', messageId: 'message', error: 'delete failed' },
      expect.any(String),
    );
  });
});
it('uses the previous fallbacks for invalid night schedule values', async () => {
  const h = harness();
  await h.service.handleNightModeMessage({
    ...night,
    nightModeTimezone: 'invalid',
    nightModeStartTimeMinutes: -1,
    nightModeEndTimeMinutes: 1440,
  });
  expect(h.dependencies.ensureIntent).toHaveBeenCalledWith(
    expect.objectContaining({
      event: expect.objectContaining({
        metadata: expect.objectContaining({
          nightModeTimezone: 'Europe/Moscow',
          nightModeStartTime: '23:00',
          nightModeEndTime: '08:00',
        }),
      }),
    }),
  );
});
