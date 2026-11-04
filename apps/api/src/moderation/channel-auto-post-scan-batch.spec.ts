import { MaxApiInternalRateLimitError } from '../max/max-client.service';
import { ChannelAutoPostScanManager } from './channel-auto-post-runtime';
import { runChannelAutoPostScanBatch } from './channel-auto-post-scan-batch';
import type { ManagedChannelContext } from './moderation.service.support';

type BatchInput = Parameters<typeof runChannelAutoPostScanBatch>[0];
type ScanInput = Parameters<ChannelAutoPostScanManager['processListedMessages']>[0];
type Attach = ScanInput['attach'];

function channel(chatId: string): ManagedChannelContext {
  return {
    channelSettings: {
      id: `settings-${chatId}`,
      chatId,
      revision: 0,
      postSuggestionsEnabled: false,
      postSuggestionsRequireSubscription: false,
      postSuggestionsDeleteOnUnsubscribe: false,
      postSuggestionsText: '',
      postSuggestionsDailyLimit: 10,
      postSuggestionsEntryMode: 'BOT',
      engagementMessageText: '',
      postSuggestionsButtonEnabled: false,
      postSuggestionsButtonText: '',
      postSuggestionsButtonUrl: '',
      commentsEnabled: true,
      commentsModerationEnabled: false,
      commentsBlockLinksEnabled: false,
      commentsAntiSpamEnabled: false,
      commentsLimitTwoInRowEnabled: false,
      commentsMessageText: '',
      postSignatureEnabled: false,
      quickButtonsEnabled: false,
      postSignaturePresentation: 'SIGNATURE',
      postSignatureText: '',
      postSignatureUrl: '',
      engagementPublishedMessageId: null,
      engagementPublishedBotId: null,
      engagementPublishedThreadId: null,
      engagementPublishedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    adminUserIds: [],
  };
}

function fixture() {
  let now = 10_000;
  const manager = new ChannelAutoPostScanManager({
    scanIntervalMs: 1_000,
    scanMaxChannels: 8,
    idleBackoffMaxMs: 8_000,
    repairSweepMs: 10,
    rateLimitBackoffMs: 100,
    throttleBackoffMaxMs: 500,
    now: () => now,
  });
  const processChannel = jest
    .fn<ReturnType<BatchInput['processChannel']>, Parameters<BatchInput['processChannel']>>()
    .mockResolvedValue(undefined);
  const onFailure = jest.fn<
    ReturnType<BatchInput['onFailure']>,
    Parameters<BatchInput['onFailure']>
  >();
  const onGlobalBackoff = jest.fn<
    ReturnType<BatchInput['onGlobalBackoff']>,
    Parameters<BatchInput['onGlobalBackoff']>
  >();
  const isTransientLookupError = jest
    .fn<
      ReturnType<BatchInput['isTransientLookupError']>,
      Parameters<BatchInput['isTransientLookupError']>
    >()
    .mockReturnValue(false);
  const sleep = jest
    .fn<ReturnType<BatchInput['sleep']>, Parameters<BatchInput['sleep']>>()
    .mockResolvedValue(undefined);
  const runDue = (...chatIds: string[]) =>
    runChannelAutoPostScanBatch({
      channels: manager
        .selectBatch(chatIds.map((chatId) => ({ chatId })))
        .map(({ chatId }) => channel(chatId)),
      plan: { interChannelDelayMs: 25, maxNewMessagesPerScan: 3 },
      manager,
      processChannel,
      sleep,
      onFailure,
      isTransientLookupError,
      onGlobalBackoff,
    });
  return {
    manager,
    processChannel,
    onFailure,
    onGlobalBackoff,
    isTransientLookupError,
    sleep,
    runDue,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function bareReadFailure(status: number): Error {
  return Object.assign(new Error('Request failed'), {
    response: { status, data: { message: 'Request failed' } },
  });
}

const post = (id: string, timestamp: number) => ({ id, timestamp, body: { text: 'Post' } });

describe('channel scan batch scheduling with the real scan manager', () => {
  it.each([403, 404])(
    'pauses a bare %i failure until expiry while another channel progresses',
    async (status) => {
      const { manager, processChannel, onFailure, onGlobalBackoff, runDue, setNow } = fixture();
      const error = bareReadFailure(status);
      processChannel.mockImplementation(async (context) => {
        if (context.channelSettings.chatId === 'blocked') throw error;
      });

      expect(await runDue('blocked', 'healthy')).toBe(false);
      expect(processChannel.mock.calls.map(([context]) => context.channelSettings.chatId)).toEqual([
        'blocked',
        'healthy',
      ]);
      expect(onFailure).toHaveBeenCalledWith('blocked', error);
      expect(manager.resolveBatchSize()).toBe(8);
      manager.markWebhookSeen('blocked', 'new-hint', 10_001);
      setNow(10_099);
      expect(manager.isDemandDue('blocked')).toBe(false);
      expect(await runDue('blocked', 'healthy')).toBe(false);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(processChannel).toHaveBeenCalledTimes(3);
      expect(processChannel).toHaveBeenLastCalledWith(channel('healthy'), {
        maxNewMessagesPerScan: 3,
      });

      setNow(10_100);
      expect(manager.isDemandDue('blocked')).toBe(true);
      expect(await runDue('blocked')).toBe(false);
      expect(onFailure).toHaveBeenCalledTimes(2);
      expect(onGlobalBackoff).not.toHaveBeenCalled();
    },
  );

  it('bounds repeated failures independently and resets escalation after a successful batch visit', async () => {
    const { manager, processChannel, onGlobalBackoff, runDue, setNow } = fixture();
    processChannel.mockRejectedValue(bareReadFailure(403));
    let now = 10_000;
    for (const delay of [100, 200, 400, 500, 500]) {
      expect(await runDue('blocked')).toBe(false);
      expect(manager.states.get('blocked')?.nextScanAtMs).toBe(now + delay);
      if (delay === 200) {
        await runDue('independent');
        expect(manager.states.get('independent')?.nextScanAtMs).toBe(now + 100);
      }
      const attempts = processChannel.mock.calls.length;
      setNow(now + delay - 1);
      await runDue('blocked');
      expect(processChannel).toHaveBeenCalledTimes(attempts);
      now += delay;
      setNow(now);
    }

    processChannel.mockResolvedValueOnce(undefined);
    await runDue('blocked');
    expect(manager.isDemandDue('blocked')).toBe(true);
    await runDue('blocked');
    expect(manager.states.get('blocked')?.nextScanAtMs).toBe(now + 100);
    expect(manager.resolveBatchSize()).toBe(8);
    expect(onGlobalBackoff).not.toHaveBeenCalled();
  });

  it('preserves completed and unfinished message positions across a failed batch and later pages', async () => {
    const { manager, processChannel, onGlobalBackoff, runDue, setNow } = fixture();
    const attach = jest.fn<ReturnType<Attach>, Parameters<Attach>>(async ({ messageId }) => {
      if (messageId === 'b') throw bareReadFailure(404);
      return 'attached';
    });
    let messages: ScanInput['messages'] = [post('a', 100), post('b', 100), post('c', 101)];
    processChannel.mockImplementation(async (context, options) => {
      if (context.channelSettings.chatId !== 'blocked') return;
      await manager.processListedMessages({
        chatId: 'blocked',
        messages,
        attach,
        maxNewMessagesPerScan: options.maxNewMessagesPerScan,
        adminUserIds: [],
        settingsUpdatedAtMs: 0,
      });
    });

    expect(await runDue('blocked', 'healthy')).toBe(false);
    expect(attach.mock.calls.map(([message]) => message.messageId)).toEqual(['a', 'b']);
    expect(manager.states.get('blocked')).toMatchObject({
      latestTimestampMs: 100,
      latestMessageIdsAtTimestamp: ['a'],
      nextScanAtMs: 10_100,
    });
    expect(processChannel).toHaveBeenLastCalledWith(channel('healthy'), {
      maxNewMessagesPerScan: 3,
    });

    setNow(10_100);
    messages = [post('c', 101)];
    await runDue('blocked');
    expect(manager.states.get('blocked')).toMatchObject({
      latestTimestampMs: 100,
      latestMessageIdsAtTimestamp: ['a'],
    });
    setNow(11_100);
    messages = [post('b', 100)];
    attach.mockResolvedValue('noop');
    await runDue('blocked');
    expect(attach.mock.calls.map(([message]) => message.messageId)).toEqual(['a', 'b', 'c', 'b']);
    expect(manager.states.get('blocked')).toMatchObject({
      latestTimestampMs: 101,
      latestMessageIdsAtTimestamp: ['c'],
    });
    expect(onGlobalBackoff).not.toHaveBeenCalled();
  });

  it.each(['bot', 'external_cooldown', 'chat', 'message_target'] as const)(
    'retains a typed %s Retry-After and continues the batch',
    async (scope) => {
      const { manager, processChannel, onGlobalBackoff, runDue, setNow } = fixture();
      processChannel.mockRejectedValueOnce(new MaxApiInternalRateLimitError('Wait', 2_000, scope));
      expect(await runDue('blocked', 'healthy')).toBe(false);
      expect(processChannel).toHaveBeenCalledTimes(2);
      expect(manager.resolveBatchSize()).toBe(8);
      setNow(11_999);
      expect(manager.isDue('blocked')).toBe(false);
      expect(manager.isDemandDue('blocked')).toBe(false);
      setNow(12_000);
      expect(manager.isDue('blocked')).toBe(true);
      expect(onGlobalBackoff).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      error: new MaxApiInternalRateLimitError('Wait', 2_000, 'role_class'),
      delay: 2_000,
      transient: false,
    },
    {
      error: new MaxApiInternalRateLimitError('Wait', 2_000, 'unknown'),
      delay: 2_000,
      transient: false,
    },
    { error: new Error('Transient lookup unavailable'), delay: 100, transient: true },
  ])(
    'keeps the shared backoff branch for $error and stops before the next channel',
    async ({ error, delay, transient }) => {
      const {
        manager,
        processChannel,
        onFailure,
        onGlobalBackoff,
        isTransientLookupError,
        sleep,
        runDue,
      } = fixture();
      processChannel.mockRejectedValueOnce(error);
      isTransientLookupError.mockReturnValue(transient);
      expect(await runDue('blocked', 'healthy')).toBe(true);
      expect(processChannel).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith('blocked', error);
      expect(onGlobalBackoff).toHaveBeenCalledWith(delay);
      expect(manager.resolveBatchSize()).toBe(4);
      expect(manager.isDue('healthy')).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
