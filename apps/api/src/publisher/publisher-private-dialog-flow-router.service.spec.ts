import { PublisherPrivateDialogFlowRouterService } from './publisher-private-dialog-flow-router.service';

describe('PublisherPrivateDialogFlowRouterService', () => {
  it('consumes native card replies before auto-reply, import or legacy review', async () => {
    const other = { observeWebhook: jest.fn().mockResolvedValue(true) };
    const native = { observeWebhook: jest.fn().mockResolvedValue(true) };
    const router = new PublisherPrivateDialogFlowRouterService(
      other as never,
      other as never,
      other as never,
      other as never,
      other as never,
      native as never,
    );
    await expect(
      router.observeWebhook({ updateId: 'native', type: 'message_created' } as never, null),
    ).resolves.toBe(true);
    expect(other.observeWebhook).not.toHaveBeenCalled();
  });

  it('routes suggestion review callbacks before other Publisher private flows', async () => {
    const suggestionAdminCallbacks = { observeWebhook: jest.fn().mockResolvedValue(true) };
    const autoReplyAuthoring = { observeWebhook: jest.fn() };
    const postImport = { observeWebhook: jest.fn() };
    const start = { observeWebhook: jest.fn() };
    const router = new PublisherPrivateDialogFlowRouterService(
      suggestionAdminCallbacks as never,
      autoReplyAuthoring as never,
      postImport as never,
      start as never,
    );
    const update = { updateId: 'update-1', type: 'message_callback' };

    await expect(router.observeWebhook(update as never, 'webhook-1')).resolves.toBe(true);

    expect(suggestionAdminCallbacks.observeWebhook).toHaveBeenCalledWith(update, 'webhook-1', {});
    expect(autoReplyAuthoring.observeWebhook).not.toHaveBeenCalled();
    expect(postImport.observeWebhook).not.toHaveBeenCalled();
    expect(start.observeWebhook).not.toHaveBeenCalled();
  });

  it('preserves the existing auto-reply and post-import fallback order', async () => {
    const suggestionAdminCallbacks = { observeWebhook: jest.fn().mockResolvedValue(false) };
    const autoReplyAuthoring = { observeWebhook: jest.fn().mockResolvedValue(false) };
    const postImport = { observeWebhook: jest.fn().mockResolvedValue(true) };
    const start = { observeWebhook: jest.fn() };
    const router = new PublisherPrivateDialogFlowRouterService(
      suggestionAdminCallbacks as never,
      autoReplyAuthoring as never,
      postImport as never,
      start as never,
    );
    const update = { updateId: 'update-1', type: 'message_callback' };

    await expect(router.observeWebhook(update as never, 'webhook-1')).resolves.toBe(true);

    expect(suggestionAdminCallbacks.observeWebhook).toHaveBeenCalledTimes(1);
    expect(autoReplyAuthoring.observeWebhook).toHaveBeenCalledTimes(1);
    expect(postImport.observeWebhook).toHaveBeenCalledTimes(1);
    expect(start.observeWebhook).not.toHaveBeenCalled();
  });

  it('greets plain starts only after the specialized private flows decline them', async () => {
    const unhandled = { observeWebhook: jest.fn().mockResolvedValue(false) };
    const start = { observeWebhook: jest.fn().mockResolvedValue(true) };
    const router = new PublisherPrivateDialogFlowRouterService(
      unhandled as never,
      unhandled as never,
      unhandled as never,
      start as never,
    );
    const update = { updateId: 'start-1', type: 'bot_started' };
    await expect(
      router.observeWebhook(update as never, 'webhook-1', { duplicate: true }),
    ).resolves.toBe(true);
    expect(start.observeWebhook).toHaveBeenCalledWith(update);
    expect(unhandled.observeWebhook).toHaveBeenCalledTimes(3);
  });
});
