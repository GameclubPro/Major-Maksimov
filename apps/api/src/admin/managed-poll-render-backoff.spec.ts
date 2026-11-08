import { ChatEntityType, ManagedPollStatus, type Prisma } from '../prisma/prisma-client';
import { ManagedPollService } from './managed-poll.service';
import type { MaxClientService } from '../max/max-client.service';

describe('managed poll rendering after an uncertain MAX result', () => {
  afterEach(() => jest.useRealTimers());

  it('does not retry the second ambiguous failure after only five minutes on a fresh replica', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-08T00:00:00Z'));
    const poll: Awaited<ReturnType<ManagedPollService['loadPollAggregate']>> = {
      id: 'poll',
      chatId: 'chat',
      actorUserId: 'author',
      chat: { entityType: ChatEntityType.CHAT },
      question: 'Question?',
      questionFormat: 'plain',
      status: ManagedPollStatus.CLOSED,
      resultOptions: [],
      publicationMessageId: 'message',
      publicationBotId: 'bot',
      publicationUrl: null,
      renderRevision: 2,
      renderRetryCount: 0,
      renderRetryAt: null,
      renderRetryMessageId: null,
      renderRetryBotId: null,
      totalVotes: 0,
      options: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      imageCount: 0,
      visibility: 'ANONYMOUS',
      identitySalt: 'native-poll-identity-salt-1234567890',
      renderedRevision: 1,
      renderFormatVersion: 7,
      publishedAt: new Date(),
      closedAt: new Date(),
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastRenderError: null,
    };
    const updateMany = jest.fn(async ({ data }: Prisma.ManagedPollUpdateManyArgs) => {
      if (data) Object.assign(poll, data);
      return { count: 1 };
    });
    const maxClient: jest.Mocked<
      Pick<MaxClientService, 'editMessageInlineKeyboard' | 'getExactMessagePresence'>
    > = {
      editMessageInlineKeyboard: jest.fn().mockRejectedValue({ response: { status: 404 } }),
      getExactMessagePresence: jest.fn().mockRejectedValue({ response: { status: 503 } }),
    };
    const makeService = () => {
      const service = new ManagedPollService(
        { managedPoll: { updateMany } } as never,
        maxClient as never,
        {} as never,
        {} as never,
      );
      const internal = service as unknown as {
        loadPollAggregate: ManagedPollService['loadPollAggregate'];
        renderPollPublication: ManagedPollService['renderPollPublication'];
      };
      jest.spyOn(internal, 'loadPollAggregate').mockImplementation(async () => ({ ...poll }));
      return internal;
    };
    await makeService().renderPollPublication('chat', 'poll', 'background-repair');
    jest.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await makeService().renderPollPublication('chat', 'poll', 'background-repair');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
    poll.renderRevision++;
    jest.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await makeService().renderPollPublication('chat', 'poll', 'background-repair');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
    jest.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await makeService().renderPollPublication('chat', 'poll', 'background-repair');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(3);
  });

  it.each([true, false])(
    'backs off without losing the publication; shared Redis available=%s',
    async (shared) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-13T00:00:00Z'));
      const cache = new Map<string, string>();
      const redis = {
        getString: jest.fn(async (key: string) => {
          if (!shared) throw new Error('Redis unavailable');
          return cache.get(key) ?? null;
        }),
        setStringWithTtl: jest.fn(async (key: string, value: string) => {
          if (!shared) throw new Error('Redis unavailable');
          cache.set(key, value);
        }),
      };
      const poll = {
        id: 'poll',
        chatId: 'chat',
        actorUserId: 'author',
        chat: { entityType: ChatEntityType.CHAT },
        question: 'Question?',
        questionFormat: 'plain',
        status: ManagedPollStatus.ACTIVE,
        resultOptions: [{ id: 'option', position: 0, text: 'Yes', votes: 1, percent: 100 }],
        publicationMessageId: 'message',
        publicationBotId: 'bot',
        publicationUrl: null,
        renderRevision: 2,
      };
      const prisma = { managedPoll: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
      const maxClient = {
        editMessageInlineKeyboard: jest.fn().mockRejectedValue({ response: { status: 404 } }),
        getExactMessagePresence: jest.fn().mockRejectedValue({ response: { status: 503 } }),
      };
      const accessLoss = { recordIfManagedEntityAccessLost: jest.fn() };
      const makeService = () => {
        const service = new ManagedPollService(
          prisma as never,
          maxClient as never,
          {} as never,
          {} as never,
          accessLoss as never,
          redis as never,
        );
        jest
          .spyOn(service as any, 'loadPollAggregate')
          .mockImplementation(async () => ({ ...poll }));
        jest.spyOn(service as any, 'markPollRendered').mockResolvedValue(true);
        return service as any;
      };
      const first = makeService();
      await expect(first.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        false,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
      expect(accessLoss.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
      const next = shared ? makeService() : first;
      poll.renderRevision += 1;
      await expect(next.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        false,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
      expect(prisma.managedPoll.updateMany.mock.calls[0][0].data).not.toHaveProperty(
        'publicationMessageId',
      );
      maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
      poll.publicationMessageId = 'replacement';
      await expect(next.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        true,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(2);
      poll.publicationMessageId = 'message';
      jest.setSystemTime(Date.now() + 5 * 60_000 + 1);
      await expect(next.renderPollPublication('chat', 'poll', 'background-repair')).resolves.toBe(
        true,
      );
      expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(3);
    },
  );
});
