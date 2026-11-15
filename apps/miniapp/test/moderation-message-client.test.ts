import assert from 'node:assert/strict';
import test from 'node:test';
import { getModerationMessage } from '../src/lib/api/moderation-message-client';
import type { ApiTransport } from '../src/lib/api/transport';

test('binds private message responses to the selected event and disables browser caching', async () => {
  const controller = new AbortController();
  const api: ApiTransport = {
    requestKeepalive() {},
    async request(path, init) {
      assert.equal(path, '/chats/chat%2Fone/moderation-feed/event%2Fone/message');
      assert.equal(init?.cache, 'no-store');
      assert.equal(init?.signal, controller.signal);
      return {
        eventId: 'another',
        state: 'not_captured',
        content: null,
        sourceAt: null,
        expiresAt: null,
      };
    },
  };
  await assert.rejects(
    getModerationMessage(api, 'chat/one', 'event/one', controller.signal),
    /Не удалось загрузить сообщение/u,
  );
});

test('accepts saved text containing 16000 Unicode code points', async () => {
  const api = {
    request: async () => ({
      eventId: 'event',
      state: 'saved',
      sourceAt: null,
      expiresAt: null,
      content: { text: '🙂'.repeat(16000), truncated: false, attachments: [] },
    }),
    requestKeepalive() {},
  };
  const result = await getModerationMessage(api, 'chat', 'event', new AbortController().signal);
  assert.equal(result.content?.text.length, 32000);
});

test('preview routes message details before the general moderation feed', async () => {
  const { createPreviewApiTransport } = await import('../src/lib/api/preview-transport');
  const { moderationFeedPageSchema } = await import('@maxim/contracts');
  const api = createPreviewApiTransport();
  const feed = moderationFeedPageSchema.parse(
    await api.request('/chats/preview-chat/moderation-feed'),
  );
  const event = feed.items[0]!;
  const result = await getModerationMessage(
    api,
    'preview-chat',
    event.id,
    new AbortController().signal,
  );
  assert.equal(result.eventId, event.id);
  assert.equal(result.content?.text ?? null, event.maskedExcerpt || null);
});
