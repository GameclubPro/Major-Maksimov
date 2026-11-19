import type { Job, Queue } from 'bullmq';
import { WebhookParser } from '../webhook/webhook.parser';
import { PublisherCommentProfileService } from './publisher-comment-profile.service';
import { PublisherStartProcessor } from './publisher-start.processor';
import type { PublisherStartJob, PublisherStartQueueService } from './publisher-start.queue';
import type { MaxActionDispatchOptions, MaxClientService } from '../max/max-client.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { PublisherDialogSigningKeyService } from './publisher-dialog-signing-key.service';

describe('Publisher comment profile handoff', () => {
  const botId = 'example_publik_bot';
  const now = new Date('2026-11-19T12:04:00.000Z');
  const parser = new WebhookParser();
  const previousRole = process.env.APP_ROLE;
  const previousService = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousService;
  });

  function fixture() {
    const add = jest.fn<Promise<void>, [string, PublisherStartJob, { jobId: string }]>();
    const registry = {
      getPublisherBotDescriptor: () => ({
        id: botId,
        label: 'Публик',
        kind: 'publisher',
        contactId: null,
      }),
    } satisfies Pick<MaxBotRegistryService, 'getPublisherBotDescriptor'>;
    const keys = { getSigningKeys: () => ['publisher-signing-test-key'] } satisfies Pick<
      PublisherDialogSigningKeyService,
      'getSigningKeys'
    >;
    const queue = { add } as unknown as Queue<PublisherStartJob>;
    const workerService = new PublisherCommentProfileService(
      queue,
      registry as MaxBotRegistryService,
      keys as unknown as PublisherDialogSigningKeyService,
    );
    const service = new PublisherCommentProfileService(
      queue,
      registry as MaxBotRegistryService,
      { getSigningKeys: () => [] } as unknown as PublisherDialogSigningKeyService,
    );
    const link = new URL(
      workerService.buildStartUrl({ actorUserId: '42', commentId: 'comment-1' }),
    );
    const payload = link.searchParams.get('start')!;
    return { service, workerService, add, link, payload, registry };
  }

  function start(payload: string, fields: Record<string, unknown> = {}, eventBotId = botId) {
    return parser.parse(
      {
        update_type: 'bot_started',
        timestamp: now.toISOString(),
        update_id: 'start-profile-42',
        chat_id: 123,
        user: { user_id: 42 },
        payload,
        ...fields,
      },
      { botId: eventBotId },
    );
  }

  async function workerFixture(rewritePayload = (payload: string) => payload) {
    const { service, workerService, add, payload, registry } = fixture();
    await service.observeWebhook(start(rewritePayload(payload)));
    const [name, data, { jobId }] = add.mock.calls[0];
    const job = {
      id: jobId,
      name,
      data,
      updateData: jest.fn(async (newData: PublisherStartJob) => {
        job.data = newData;
      }),
    } as unknown as Job<PublisherStartJob>;
    const maxClient = {
      sendMessage: jest.fn<
        ReturnType<MaxClientService['sendMessage']>,
        Parameters<MaxClientService['sendMessage']>
      >(async (_chatId, _text, _messageOptions, dispatchOptions?: MaxActionDispatchOptions) => {
        await dispatchOptions?.beforeImmediateSendMutation?.();
      }),
    };
    const startQueue = {
      findProfileComment: jest
        .fn<
          ReturnType<PublisherStartQueueService['findProfileComment']>,
          Parameters<PublisherStartQueueService['findProfileComment']>
        >()
        .mockResolvedValue({
          actorUserId: '77',
          payload: { authorDisplayName: 'Анна & <В>' },
        }),
      claimDispatch: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true),
    };
    const processor = new PublisherStartProcessor(
      maxClient as unknown as MaxClientService,
      registry as MaxBotRegistryService,
      {} as never,
      {} as never,
      { assertDispatchEnabled: jest.fn() } as never,
      { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
      { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) } as never,
      startQueue as unknown as PublisherStartQueueService,
      workerService,
    );
    return { processor, job, maxClient, startQueue };
  }

  it('uses the exact Publik bot and the requesting actor’s distinct private chat, preserving the queue identity across duplicate starts', async () => {
    const { service, add, payload, link } = fixture();
    expect(link.origin).toBe('https://max.ru');
    expect(link.pathname).toBe('/example_publik_bot');
    await expect(service.observeWebhook(start(payload))).resolves.toBe(true);
    await expect(service.observeWebhook(start(payload, { update_id: 'duplicate' }))).resolves.toBe(
      true,
    );
    expect(add).toHaveBeenCalledWith(
      'comment-author-profile',
      expect.objectContaining({
        version: 4,
        publisherBotId: botId,
        privateChatId: '123',
        actorUserId: '42',
        signedStartPayload: payload,
      }),
      expect.objectContaining({ attempts: 3 }),
    );
    expect(add.mock.calls[0][2].jobId).toBe(add.mock.calls[1][2].jobId);
  });

  it('rejects cross-actor, group, channel, malformed, wrong-bot and stale starts at admission', async () => {
    const { service, add, payload } = fixture();
    const malformed = payload.replace('comment-1', 'comment_1');
    for (const update of [
      start(payload, { user: { user_id: 43 } }),
      start(payload, { chat_id: -123 }),
      start(payload, { chat_type: 'channel' }),
      start(malformed),
      start(payload, {}, 'major-bot'),
      start(payload, { timestamp: now.getTime() - 61_000 }),
      { ...start(payload), eventTimestampSource: 'ingress' as const },
    ])
      await service.observeWebhook(update);
    jest.setSystemTime(now.getTime() + 5 * 60_000);
    await service.observeWebhook(start(payload));
    expect(add).not.toHaveBeenCalled();
  });

  it('sends only the original comment author link to the requesting private chat', async () => {
    const { processor, job, maxClient, startQueue } = await workerFixture();
    await processor.process(job);
    expect(startQueue.findProfileComment).toHaveBeenCalledWith('comment-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '123',
      '<strong>Профиль пользователя</strong>\n<a href="max://user/77">Анна &amp; &lt;В&gt;</a>',
      { textFormat: 'html' },
      expect.objectContaining({ immediate: true, botId, idempotencyKey: job.id }),
    );
    expect(startQueue.claimDispatch).toHaveBeenCalledWith(job.id);
  });

  it('verifies the signature in the worker before reading the comment', async () => {
    const { processor, job, maxClient, startQueue } = await workerFixture((payload) =>
      payload.replace('comment-1', 'comment-2'),
    );
    await processor.process(job);
    expect(startQueue.findProfileComment).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('skips a deleted or expired comment request before a send', async () => {
    const { processor, job, maxClient, startQueue } = await workerFixture();
    startQueue.findProfileComment.mockResolvedValueOnce(null);
    await processor.process(job);
    jest.setSystemTime(now.getTime() + 5 * 60_000);
    await processor.process(job);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(startQueue.findProfileComment).toHaveBeenCalledTimes(1);
  });
});
