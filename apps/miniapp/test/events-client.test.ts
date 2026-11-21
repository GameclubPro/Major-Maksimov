import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANUAL_MODERATION_ACTION_TIMEOUT_MS,
  applyManualModerationAction,
  getChatParticipantsPage,
  getChatStatisticsIdentity,
  getGlobalSpammerReviewQueue,
} from '../src/lib/api/events-client';
import type { ApiTransport } from '../src/lib/api/transport';

test('participant requests keep the selected period and role filter server-side', async () => {
  let requestedPath = '';
  const api: ApiTransport = {
    async request(path) {
      requestedPath = path;
      return { items: [], totalCount: 0, hasMore: false, nextCursor: null };
    },
    requestKeepalive() {},
  };

  await getChatParticipantsPage(api, 'chat-1', {
    range: '30d',
    roleFilter: 'admins',
    limit: 24,
    search: 'Иван',
  });

  const url = new URL(requestedPath, 'https://miniapp.local');
  assert.equal(url.pathname, '/chats/chat-1/members');
  assert.equal(url.searchParams.get('range'), '30d');
  assert.equal(url.searchParams.get('roleFilter'), 'admins');
  assert.equal(url.searchParams.get('search'), 'Иван');
});

test('spammer review loads the next page with the exact opaque cursor', async () => {
  let requestedPath = '';
  const api: ApiTransport = {
    async request(path) {
      requestedPath = path;
      return { items: [], limit: 20, nextCursor: null };
    },
    requestKeepalive() {},
  };
  await getGlobalSpammerReviewQueue(api, 'chat-1', { limit: 20, cursor: 'a/b+c=' });
  const url = new URL(requestedPath, 'https://miniapp.local');
  assert.equal(url.pathname, '/chats/chat-1/spammer-review');
  assert.equal(url.searchParams.get('cursor'), 'a/b+c=');
});
test('manual moderation sends one bounded non-replayable mutation', async () => {
  let requestedPath = '';
  let requestedInit: Parameters<ApiTransport['request']>[1];
  const api: ApiTransport = {
    async request(path, init) {
      requestedPath = path;
      requestedInit = init;
      return {
        ok: true,
        action: 'BAN',
        userId: 'user/2',
        muteDurationHours: null,
        muteExpiresAt: null,
        message: 'Бан включён.',
      };
    },
    requestKeepalive() {},
  };

  await applyManualModerationAction(api, 'chat-1', 'user/2', {
    action: 'BAN',
    scope: 'all_chats',
  });

  assert.equal(requestedPath, '/chats/chat-1/members/user%2F2/moderation-action');
  assert.equal(requestedInit?.method, 'POST');
  assert.equal(requestedInit?.timeoutMs, MANUAL_MODERATION_ACTION_TIMEOUT_MS);
  assert.equal(requestedInit?.retryMutationOnTransportError, false);
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    action: 'BAN',
    scope: 'all_chats',
  });
});

test('participant requests reject unknown role filters before transport', async () => {
  const api: ApiTransport = {
    async request() {
      throw new Error('transport must not run');
    },
    requestKeepalive() {},
  };

  await assert.rejects(
    () =>
      getChatParticipantsPage(api, 'chat-1', {
        roleFilter: 'unknown' as never,
      }),
    /Invalid participant role filter/u,
  );
});

test('participant statistics load authoritative chat identity from the lightweight header', async () => {
  let requestedPath = '';
  let requestedSignal: AbortSignal | null | undefined;
  const controller = new AbortController();
  const api: ApiTransport = {
    async request(path, init) {
      requestedPath = path;
      requestedSignal = init?.signal;
      return {
        id: 'chat-1',
        entityType: 'chat',
        title: 'Садоводы Южного',
        avatarUrl: 'https://example.com/chat.png',
        participantsCount: 48,
      };
    },
    requestKeepalive() {},
  };

  const identity = await getChatStatisticsIdentity(api, 'chat-1', {
    signal: controller.signal,
  });

  assert.equal(requestedPath, '/chats/chat-1/header');
  assert.equal(requestedSignal, controller.signal);
  assert.deepEqual(identity, {
    id: 'chat-1',
    title: 'Садоводы Южного',
    avatarUrl: 'https://example.com/chat.png',
    participantsCount: 48,
  });
});

test('participant statistics reject a header from another chat', async () => {
  const api: ApiTransport = {
    async request() {
      return {
        id: 'chat-2',
        entityType: 'chat',
        title: 'Другой чат',
        avatarUrl: null,
        participantsCount: 12,
      };
    },
    requestKeepalive() {},
  };

  await assert.rejects(
    () => getChatStatisticsIdentity(api, 'chat-1'),
    /Invalid chat statistics identity/u,
  );
});
