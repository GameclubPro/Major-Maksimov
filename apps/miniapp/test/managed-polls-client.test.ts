import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedEntityType } from '@maxim/contracts';
import type { CreateManagedPollRequest, ManagedPollDetails } from '@maxim/contracts/poll';
import {
  MANAGED_POLL_MUTATION_TIMEOUT_MS,
  createManagedPoll,
  getManagedPolls,
  publishManagedPoll,
  updateManagedPoll,
} from '../src/lib/api/managed-polls-client';
import { managedPollQueryKeys } from '../src/lib/managed-poll-query-keys';
import {
  createApiTransport,
  type ApiRequestInit,
  type ApiTransport,
} from '../src/lib/api/transport';

const pollCreatePayload: CreateManagedPollRequest = {
  question: 'Какой вариант выбрать?',
  questionFormat: 'plain',
  visibility: 'ANONYMOUS',
  images: [],
  options: [{ text: 'Первый ответ' }, { text: 'Второй ответ' }],
};
const pollCreatePaths: Record<ManagedEntityType, string> = {
  chat: '/chats/entity-1/polls',
  channel: '/channels/entity-1/polls',
};
const majorApiBase = 'https://major-maksimov.ru/api/v1';
const preferredTunnelApiBase = 'https://api-cdn.flex-craft.ru/api/v1';

function pollDraftFixture(id: string): ManagedPollDetails {
  return {
    id,
    channelId: 'entity-1',
    question: 'Какой вариант выбрать?',
    questionFormat: 'plain',
    status: 'DRAFT',
    visibility: 'ANONYMOUS',
    imageCount: 0,
    images: [],
    totalVotes: 0,
    options: [
      { id: `${id}-option-1`, position: 0, text: 'Первый ответ', votes: 0, percent: 0 },
      { id: `${id}-option-2`, position: 1, text: 'Второй ответ', votes: 0, percent: 0 },
    ],
    publicationPending: false,
    publicationNeedsReview: false,
    renderRepairNeeded: false,
    publicationUrl: null,
    publicationMessageId: null,
    publishedAt: null,
    closedAt: null,
    lastError: null,
    lastRenderError: null,
    createdAt: '2026-11-02T09:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
  };
}

function mockPollCreateBoundary(
  entityType: ManagedEntityType,
  directOutcome: 'success' | 'reply-lost' | 'method-rejected',
  apiBase = majorApiBase,
) {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; method: string }> = [];
  const committedDrafts: ManagedPollDetails[] = [];
  const expectedPath = pollCreatePaths[entityType];
  const commit = () => {
    const draft = pollDraftFixture(`poll-${committedDrafts.length + 1}`);
    committedDrafts.push(draft);
    return Response.json(draft);
  };

  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    assert.equal(url.origin, new URL(apiBase).origin);
    calls.push({ path: url.pathname, method });
    if (url.pathname === `/api/v1${expectedPath}`) {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), pollCreatePayload);
      if (directOutcome === 'method-rejected') {
        return new Response(null, { status: 405 });
      }
      const response = commit();
      if (directOutcome === 'reply-lost') {
        throw new TypeError('Reply lost after the draft committed');
      }
      return response;
    }

    assert.equal(url.pathname, '/api/v1/_mutation-tunnel');
    assert.equal(method, 'GET');
    assert.equal(url.searchParams.get('method'), 'POST');
    assert.equal(url.searchParams.get('path'), expectedPath);
    assert.equal(init?.body, undefined);
    const encodedBody = url.searchParams.get('body');
    assert.ok(encodedBody);
    assert.deepEqual(
      JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf8')),
      pollCreatePayload,
    );
    return commit();
  };

  return {
    api: createApiTransport('auth_date=1&hash=first', {
      apiBases: [apiBase],
      durableSession: false,
    }),
    calls,
    committedDrafts,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

for (const entityType of ['chat', 'channel'] as const satisfies readonly ManagedEntityType[]) {
  test(`${entityType} poll creation does not replay after losing a committed response`, async () => {
    const boundary = mockPollCreateBoundary(entityType, 'reply-lost');
    try {
      let returnedDraft: ManagedPollDetails | undefined;
      let requestError: unknown;
      try {
        returnedDraft = await createManagedPoll(
          boundary.api,
          entityType,
          'entity-1',
          pollCreatePayload,
        );
      } catch (error) {
        requestError = error;
      }

      assert.deepEqual(
        boundary.committedDrafts.map((draft) => draft.id),
        ['poll-1'],
      );
      assert.equal(returnedDraft, undefined);
      assert.ok(requestError instanceof Error);
      assert.match(requestError.message, /Нет связи с сервисом/u);
      assert.deepEqual(boundary.calls, [
        { path: `/api/v1${pollCreatePaths[entityType]}`, method: 'POST' },
      ]);
    } finally {
      boundary.restore();
    }
  });

  test(`${entityType} poll creation returns the one directly committed draft`, async () => {
    const boundary = mockPollCreateBoundary(entityType, 'success');
    try {
      const draft = await createManagedPoll(
        boundary.api,
        entityType,
        'entity-1',
        pollCreatePayload,
      );
      assert.deepEqual(draft, pollDraftFixture('poll-1'));
      assert.equal(boundary.committedDrafts.length, 1);
      assert.deepEqual(boundary.calls, [
        { path: `/api/v1${pollCreatePaths[entityType]}`, method: 'POST' },
      ]);
    } finally {
      boundary.restore();
    }
  });

  test(`${entityType} poll creation uses the tunnel once after a method rejection`, async () => {
    const boundary = mockPollCreateBoundary(entityType, 'method-rejected');
    try {
      const draft = await createManagedPoll(
        boundary.api,
        entityType,
        'entity-1',
        pollCreatePayload,
      );
      assert.equal(draft.id, 'poll-1');
      assert.equal(boundary.committedDrafts.length, 1);
      assert.deepEqual(boundary.calls, [
        { path: `/api/v1${pollCreatePaths[entityType]}`, method: 'POST' },
        { path: '/api/v1/_mutation-tunnel', method: 'GET' },
      ]);
    } finally {
      boundary.restore();
    }
  });

  test(`${entityType} poll creation starts with one tunnel request on a preferred host`, async () => {
    const boundary = mockPollCreateBoundary(entityType, 'success', preferredTunnelApiBase);
    try {
      const draft = await createManagedPoll(
        boundary.api,
        entityType,
        'entity-1',
        pollCreatePayload,
      );
      assert.equal(draft.id, 'poll-1');
      assert.equal(boundary.committedDrafts.length, 1);
      assert.deepEqual(boundary.calls, [{ path: '/api/v1/_mutation-tunnel', method: 'GET' }]);
    } finally {
      boundary.restore();
    }
  });

  test(`${entityType} poll mutations preserve authored text and reserve publication time`, async () => {
    const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
    const api: ApiTransport = {
      request: async (path, init) => {
        calls.push({ path, init });
        throw new Error('stop after request options');
      },
      requestKeepalive: () => undefined,
    };
    const payload = {
      question: 'Только текст администратора',
      questionFormat: 'plain' as const,
      visibility: 'ANONYMOUS' as const,
      images: [],
      options: [
        { id: 'option-1', text: 'Первый ответ' },
        { id: 'option-2', text: 'Второй ответ' },
      ],
    };
    const expectedUpdatedAt = '2026-08-19T10:00:00.000Z';
    const collection = entityType === 'chat' ? 'chats' : 'channels';

    await assert.rejects(
      () => createManagedPoll(api, entityType, 'entity-1', payload),
      /stop after request/u,
    );
    await assert.rejects(
      () =>
        updateManagedPoll(api, entityType, 'entity-1', 'poll-1', {
          ...payload,
          expectedUpdatedAt,
        }),
      /stop after request/u,
    );
    await assert.rejects(
      () => publishManagedPoll(api, entityType, 'entity-1', 'poll-1'),
      /stop after request/u,
    );

    assert.deepEqual(
      calls.map((call) => call.path),
      [
        `/${collection}/entity-1/polls`,
        `/${collection}/entity-1/polls/poll-1`,
        `/${collection}/entity-1/polls/poll-1/publish`,
      ],
    );
    assert.deepEqual(
      calls.map((call) => call.init?.timeoutMs),
      [
        MANAGED_POLL_MUTATION_TIMEOUT_MS,
        MANAGED_POLL_MUTATION_TIMEOUT_MS,
        MANAGED_POLL_MUTATION_TIMEOUT_MS,
      ],
    );

    const bodies = calls.slice(0, 2).map((call) => JSON.parse(String(call.init?.body)));
    for (const body of bodies) {
      assert.equal(body.question, payload.question);
      assert.deepEqual(
        body.options.map((option: { text: string }) => option.text),
        payload.options.map((option) => option.text),
      );
      assert.equal(JSON.stringify(body).includes('Опрос'), false);
      assert.equal(JSON.stringify(body).includes('голос'), false);
    }
    assert.equal('expectedUpdatedAt' in bodies[0], false);
    assert.equal(bodies[1].expectedUpdatedAt, expectedUpdatedAt);
  });
}

test('poll list client serializes scope and pagination', async () => {
  const calls: string[] = [];
  const api: ApiTransport = {
    request: async (path) => {
      calls.push(path);
      return { items: [], nextCursor: null, total: 0 };
    },
    requestKeepalive: () => undefined,
  };

  await getManagedPolls(api, 'chat', 'entity/1', {
    scope: 'archive',
    cursor: 'cursor value',
    limit: 7,
  });

  assert.deepEqual(calls, ['/chats/entity%2F1/polls?scope=archive&cursor=cursor+value&limit=7']);
});

test('poll query keys isolate entities and list scopes', () => {
  assert.notDeepEqual(
    managedPollQueryKeys.list('chat', 'same-id', 'current'),
    managedPollQueryKeys.list('channel', 'same-id', 'current'),
  );
  assert.notDeepEqual(
    managedPollQueryKeys.list('chat', 'same-id', 'current'),
    managedPollQueryKeys.list('chat', 'same-id', 'archive'),
  );
});
