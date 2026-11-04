import { BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChunkedMutationTunnelUploadStore,
  DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS,
  type ChunkedMutationTunnelUploadMetadata,
} from './chunked-mutation-tunnel-upload.store';
import { MiniappMutationTunnelController } from './miniapp-mutation-tunnel.controller';

type ReplyMock = {
  header: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
};

function createReply(): ReplyMock {
  return {
    header: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
  };
}

const TEST_USER: AuthUser = {
  userId: 'user-1',
  username: null,
  displayName: 'Test User',
};

function createUploadMetadata(
  overrides: Partial<ChunkedMutationTunnelUploadMetadata> = {},
): ChunkedMutationTunnelUploadMetadata {
  return {
    method: 'POST',
    path: '/channels/channel-1/broadcast',
    contentType: 'application/json',
    authHash: 'auth-hash-1',
    authUserKey: 'user-key-1',
    chunkCount: 1,
    maxBodyBytes: DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxBodyBytes,
    ...overrides,
  };
}

describe('MiniappMutationTunnelController', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('accepts enough chunks for the full 34 MiB client payload budget', () => {
    const controller = new MiniappMutationTunnelController();
    const fullBudgetChunkCount = Math.ceil((34 * 1024 * 1024) / 4_200);

    expect((controller as any).normalizeChunkCount(String(fullBudgetChunkCount))).toBe(
      fullBudgetChunkCount,
    );
    expect(() => (controller as any).normalizeChunkCount('9001')).toThrow(BadRequestException);
    controller.onModuleDestroy();
  });

  it('allows only the exact source-free network metadata POST paths', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    try {
      for (const path of [
        '/networks/settings/read',
        '/networks/settings/preview',
        '/networks/settings/apply',
        '/networks/settings/navigation-allowlist/read',
        '/networks/settings/required-subscription/resolve',
        '/networks/settings/admin-contacts/read',
        '/networks/settings/admin-contacts/resolve',
      ])
        await controller.tunnel(
          { method: 'POST', path },
          'InitData auth_date=1&hash=test',
          TEST_USER,
          createReply() as never,
        );
      expect(global.fetch).toHaveBeenCalledTimes(7);
      for (const path of [
        '/networks/settings/admin-contacts/read/extra',
        '/networks/settings/admin-contacts',
        '/networks/settings/required-subscription/resolve/extra',
        '/networks/settings/navigation-allowlist/write',
      ])
        await expect(
          controller.tunnel(
            { method: 'POST', path },
            'InitData auth_date=1&hash=test',
            TEST_USER,
            createReply() as never,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.tunnel(
          { method: 'PUT', path: '/networks/settings/read' },
          'InitData auth_date=1&hash=test',
          TEST_USER,
          createReply() as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(global.fetch).toHaveBeenCalledTimes(7);
    } finally {
      controller.onModuleDestroy();
    }
  });

  it('allows only the exact POST channel ban route through the tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const path = '/channels/channel-1/members/user-1/ban';
    try {
      await controller.tunnel(
        { method: 'POST', path },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      );
      expect(global.fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:3001/api/v1${path}`,
        expect.objectContaining({ method: 'POST' }),
      );
      await expect(
        controller.tunnel(
          { method: 'DELETE', path },
          'InitData auth_date=1&hash=test',
          TEST_USER,
          createReply() as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      controller.onModuleDestroy();
    }
  });

  it('allows only the exact PATCH chat speech-style route through the tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const path = '/chats/chat-1/settings/speech-style';
    const payload = { botSpeechStyle: 'IRONIC' };
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    try {
      await controller.tunnel(
        {
          method: 'PATCH',
          path,
          body: Buffer.from(JSON.stringify(payload)).toString('base64url'),
          contentType: 'application/json',
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      );
      expect(global.fetch).toHaveBeenCalledWith(
        `http://127.0.0.1:3001/api/v1${path}`,
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify(payload) }),
      );

      for (const invalid of [
        { method: 'PUT', path },
        { method: 'PATCH', path: '/channels/chat-1/settings/speech-style' },
        { method: 'PATCH', path: `${path}/extra` },
      ]) {
        await expect(
          controller.tunnel(
            invalid,
            'InitData auth_date=1&hash=test',
            TEST_USER,
            createReply() as never,
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(global.fetch).toHaveBeenCalledTimes(1);
    } finally {
      controller.onModuleDestroy();
    }
  });

  it('forwards session credentials and request-origin signals to the local API', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const body = Buffer.from(JSON.stringify({ enabled: true }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PUT',
        path: '/chats/chat-1/settings?prefetch=1',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
      {
        headers: {
          cookie: '__Host-maxim_session=session-token',
          'x-miniapp-csrf-token': 'csrf-token',
          origin: 'https://major-maksimov.ru',
          'sec-fetch-site': 'same-origin',
        },
        miniappAuth: {
          source: 'session',
          principalKey: 'session-principal-key',
        },
      } as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/chats/chat-1/settings?prefetch=1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          Cookie: '__Host-maxim_session=session-token',
          'Content-Type': 'application/json',
          Origin: 'https://major-maksimov.ru',
          'Sec-Fetch-Site': 'same-origin',
          'X-Miniapp-Csrf-Token': 'csrf-token',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    expect(reply.header).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Vary', 'Authorization');
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it('allows miniapp boot trace through the CDN mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({
      phase: 'index_loaded',
      sessionId: 'session-1',
      elapsedMs: 1,
    });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'POST',
        path: '/system/miniapp-boot-trace',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/system/miniapp-boot-trace',
      expect.objectContaining({
        method: 'POST',
        body: payload,
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'Content-Type': 'application/json',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('allows saving a channel post signature through the mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({ enabled: true, text: 'Читать канал' });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, text: 'Читать канал' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PATCH',
        path: '/channels/channel-1/post-signature',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/channels/channel-1/post-signature',
      expect.objectContaining({
        method: 'PATCH',
        body: payload,
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('allows refreshing a published giveaway keyboard through the mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'POST',
        path: '/channels/-75313361194252/giveaways/cmqh0qohe02jk01pohd5l12ax/refresh-publication',
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/channels/-75313361194252/giveaways/cmqh0qohe02jk01pohd5l12ax/refresh-publication',
      expect.objectContaining({
        method: 'POST',
        body: undefined,
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('allows saving a VK review draft through the mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({ text: 'На модерации', photoUrls: [], linkUrls: [] });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PATCH',
        path: '/publisher/entities/channel/-68195407437828/vk-parsing/posts/vkpost-1/review-draft',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/publisher/entities/channel/-68195407437828/vk-parsing/posts/vkpost-1/review-draft',
      expect.objectContaining({
        method: 'PATCH',
        body: payload,
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it.each([
    '/chats/chat-1/vk-parsing/settings',
    '/channels/channel-1/vk-parsing/posts/post-1/publish',
  ])('rejects retired moderation-profile VK mutation target %s', async (path) => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        {
          method: path.endsWith('/settings') ? 'PATCH' : 'POST',
          path,
          body: Buffer.from('{}', 'utf8').toString('base64url'),
          contentType: 'application/json',
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'PATCH',
      '/publisher/entities/chat/chat-1/modules',
      { expectedRevision: 2, chatCommentsEnabled: true },
    ],
    [
      'PATCH',
      '/publisher/entities/channel/channel-1/modules',
      { expectedRevision: 3, channelSuggestionsEnabled: true },
    ],
    [
      'POST',
      '/publisher/entities/channel/channel-1/suggestions/suggestion-1/review',
      { action: 'publish' },
    ],
    ['PATCH', '/publisher/entities/channel/channel-1/vk-parsing/bot-review', { action: 'CONNECT' }],
    ['POST', '/publisher/entities/channel/channel-1/vk-parsing/bot-review/posts/post-1', {}],
    [
      'POST',
      '/channels/channel-1/dialog/suggest/video',
      { video: { base64: 'dmlkZW8=', mimeType: 'video/mp4' } },
    ],
  ])('forwards exact Publisher control mutation %s %s', async (method, path, payload) => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const serialized = JSON.stringify(payload);
    const body = Buffer.from(serialized, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      { method, path, body, contentType: 'application/json; charset=utf-8' },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:3001/api/v1${path}`,
      expect.objectContaining({
        method,
        body: serialized,
        headers: expect.objectContaining({
          'Content-Type': 'application/json; charset=utf-8',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['PUT', '/publisher/entities/chat/chat-1/modules'],
    ['PATCH', '/publisher/entities/chat/chat-1/vk-parsing/bot-review'],
    ['POST', '/publisher/entities/channel/channel-1/vk-parsing/bot-review'],
    ['PATCH', '/publisher/entities/channel/channel-1/vk-parsing/bot-review/extra'],
    ['DELETE', '/publisher/entities/channel/channel-1/vk-parsing/bot-review/posts/post-1'],
    ['POST', '/publisher/entities/chat/chat-1/modules'],
    ['PATCH', '/publisher/entities/chat/chat-1/modules/'],
    ['PATCH', '/publisher/entities/unknown/chat-1/modules'],
    ['PATCH', '/publisher/entities/chat/chat-1/modules/extra'],
    ['PATCH', '/publisher/entities/channel/channel-1/suggestions/suggestion-1/review'],
    ['POST', '/publisher/entities/chat/chat-1/suggestions/suggestion-1/review'],
    ['POST', '/publisher/entities/channel/channel-1/suggestions/review'],
    ['POST', '/publisher/entities/channel/channel-1/suggestions/suggestion-1/review/'],
    ['POST', '/publisher/entities/channel/channel-1/suggestions/suggestion-1/review/extra'],
    ['POST', '/chats/chat-1/dialog/suggest/video'],
    ['POST', '/channels/channel-1/dialog/comments/video'],
    ['POST', '/channels/channel-1/dialog/suggest/video/extra'],
    ['PUT', '/channels/channel-1/dialog/suggest/video'],
  ])('rejects non-exact Publisher control target %s %s', async (method, path) => {
    const controller = new MiniappMutationTunnelController();
    const body = Buffer.from('{}', 'utf8').toString('base64url');
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        { method, path, body, contentType: 'application/json' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing body',
      {
        method: 'PATCH',
        path: '/publisher/entities/chat/chat-1/modules',
        contentType: 'application/json',
      },
    ],
    [
      'non-JSON content type',
      {
        method: 'PATCH',
        path: '/publisher/entities/chat/chat-1/modules',
        body: Buffer.from('{}', 'utf8').toString('base64url'),
        contentType: 'text/plain',
      },
    ],
    [
      'JSON array',
      {
        method: 'POST',
        path: '/publisher/entities/channel/channel-1/suggestions/suggestion-1/review',
        body: Buffer.from('[]', 'utf8').toString('base64url'),
        contentType: 'application/json',
      },
    ],
    [
      'malformed JSON',
      {
        method: 'POST',
        path: '/publisher/entities/channel/channel-1/suggestions/suggestion-1/review',
        body: Buffer.from('{', 'utf8').toString('base64url'),
        contentType: 'application/json',
      },
    ],
    [
      'oversized JSON object',
      {
        method: 'PATCH',
        path: '/publisher/entities/channel/channel-1/modules',
        body: Buffer.from(JSON.stringify({ value: 'x'.repeat(16 * 1024) }), 'utf8').toString(
          'base64url',
        ),
        contentType: 'application/json',
      },
    ],
  ])('rejects Publisher control mutation with %s', async (_case, query) => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(query, 'InitData auth_date=1&hash=test', TEST_USER, createReply() as never),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['PUT', '/managed-entities/networks/chat/composition'],
    ['PUT', '/managed-entities/networks/channel/composition'],
    ['POST', '/networks/settings/read'],
    ['POST', '/networks/settings/preview'],
    ['POST', '/networks/settings/apply'],
  ])('forwards network %s %s without changing revision conflicts', async (method, path) => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({ code: 'NETWORK_SETTINGS_CHANGED' });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(payload, {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;
    await controller.tunnel(
      {
        method,
        path,
        body: Buffer.from('{}').toString('base64url'),
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:3001/api/v1${path}`,
      expect.objectContaining({ method, body: '{}' }),
    );
    expect(reply.status).toHaveBeenCalledWith(409);
  });

  it('allows durable favorite-label saves through the mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({
      labels: { important: 'VIP чаты' },
      expectedRevision: 1,
    });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          initialized: true,
          labels: { important: 'VIP чаты' },
          revision: 2,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      ),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PUT',
        path: '/managed-entities/favorite-labels',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/managed-entities/favorite-labels',
      expect.objectContaining({
        method: 'PUT',
        body: payload,
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('forwards favorite-label revision conflicts without changing the status or payload', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({
      labels: { important: 'VIP чаты' },
      expectedRevision: 1,
    });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
    const conflictPayload = JSON.stringify({
      code: 'MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT',
      message: 'Названия категорий уже изменились.',
    });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(conflictPayload, {
        status: 409,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PUT',
        path: '/managed-entities/favorite-labels',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/managed-entities/favorite-labels',
      expect.objectContaining({ method: 'PUT', body: payload }),
    );
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(conflictPayload);
  });

  it.each([
    ['GET', '/managed-entities/favorite-labels'],
    ['POST', '/managed-entities/favorite-labels'],
    ['DELETE', '/managed-entities/favorite-labels'],
    ['PUT', '/managed-entities/favorite-labels/'],
    ['PUT', '/managed-entities/favorite-labels/extra'],
  ])('rejects non-exact favorite-label tunnel target %s %s', async (method, path) => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    global.fetch = jest.fn();

    await expect(
      controller.tunnel(
        { method, path, contentType: 'application/json' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        reply as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/chats/-123/karavan-marketplace/setup'],
    ['POST', '/chats/-123/karavan-marketplace/connection/binding'],
    ['POST', '/chats/-123/karavan-marketplace/connection/import-binding'],
    ['POST', '/chats/-123/karavan-marketplace/connection/operations/operation-1/resume'],
    ['POST', '/chats/-123/karavan-marketplace/handoffs'],
    ['POST', '/chats/-123/karavan-marketplace/bindings/marketplace-1'],
    ['POST', '/chats/chat-1/broadcast/handoff'],
    ['DELETE', '/chats/chat-1/broadcast/handoff'],
    ['PUT', '/chats/chat-1/broadcasts/broadcast-1'],
    ['DELETE', '/channels/channel-1/broadcasts/broadcast-1'],
    ['POST', '/channels/channel-1/broadcasts/broadcast-1/retry'],
    ['POST', '/chats/chat-1/autopost-rules'],
    ['PUT', '/channels/channel-1/autopost-rules/rule-1'],
    ['DELETE', '/channels/channel-1/autopost-rules/rule-1'],
    ['POST', '/autopost-rules'],
    ['PUT', '/autopost-rules/rule-1'],
    ['DELETE', '/autopost-rules/rule-1'],
    ['POST', '/publications'],
    ['POST', '/publications/test'],
    ['POST', '/publications/calendar-availability'],
    ['POST', '/publications/drafts'],
    ['POST', '/publications/video-uploads'],
    ['POST', '/publications/video-uploads/upload_request_123456/complete'],
    ['PUT', '/publications/drafts/draft-1'],
    ['DELETE', '/publications/drafts/draft-1'],
    ['POST', '/publications/publication-1/deliveries/delivery-1/post-actions'],
    ['POST', '/publisher/post-imports'],
    ['DELETE', '/publisher/post-imports'],
    ['POST', '/publisher/entities/channel/channel-1/refresh'],
    ['POST', '/publisher/entities/refresh'],
    ['POST', '/publisher/entities/resolve'],
    ['POST', '/publisher/entities/refresh-selected'],
    ['PUT', '/publications/publication-1'],
    ['DELETE', '/publications/publication-1'],
    ['POST', '/publications/publication-1/pause'],
    ['POST', '/publications/publication-1/resume'],
    ['POST', '/publications/publication-1/cancel'],
    ['POST', '/publications/publication-1/targets/refresh'],
    ['POST', '/publications/publication-1/occurrences/occurrence-1/retry'],
    ['POST', '/publications/publication-1/occurrences/occurrence-1/resolve-ambiguous'],
    ['POST', '/channels/channel-1/polls'],
    ['PUT', '/channels/channel-1/polls/poll-1'],
    ['DELETE', '/channels/channel-1/polls/poll-1'],
    ['POST', '/channels/channel-1/polls/poll-1/publish'],
    ['POST', '/channels/channel-1/polls/poll-1/close'],
    ['POST', '/channels/channel-1/polls/poll-1/refresh'],
    ['POST', '/channels/channel-1/polls/poll-1/reset-publication'],
    ['POST', '/chats/chat-1/polls'],
    ['PUT', '/chats/chat-1/polls/poll-1'],
    ['DELETE', '/chats/chat-1/polls/poll-1'],
    ['POST', '/chats/chat-1/polls/poll-1/publish'],
    ['POST', '/chats/chat-1/polls/poll-1/close'],
    ['POST', '/chats/chat-1/polls/poll-1/refresh'],
    ['POST', '/chats/chat-1/polls/poll-1/reset-publication'],
  ])('allows managed broadcast %s %s through the mutation tunnel', async (method, path) => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method,
        path,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:3001/api/v1${path}`,
      expect.objectContaining({
        method,
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('accepts gzip-compressed tunnel bodies', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({ message: 'x'.repeat(4096) });
    const bodyGzip = gzipSync(Buffer.from(payload, 'utf8'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PUT',
        path: '/chats/chat-1/settings',
        bodyGzip,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/chats/chat-1/settings',
      expect.objectContaining({
        method: 'PUT',
        body: payload,
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalledWith();
  });

  it('rejects gzip bodies whose decompressed output exceeds the tunnel limit', async () => {
    const controller = new MiniappMutationTunnelController();
    const bodyGzip = gzipSync(Buffer.from('x'.repeat(128 * 1024 + 1), 'utf8'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        {
          method: 'PUT',
          path: '/chats/chat-1/settings',
          bodyGzip,
          contentType: 'application/json',
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('bounds active chunked uploads per validated user and across the process', async () => {
    const controller = new MiniappMutationTunnelController();
    const storePart = async (index: number, userId: string) =>
      controller.tunnel(
        {
          method: 'POST',
          path: '/channels/channel-1/broadcast',
          contentType: 'application/json',
          uploadId: `active-upload-${String(index).padStart(4, '0')}`,
          chunkIndex: '0',
          chunkCount: '2',
          chunk: 'eA',
        },
        `InitData auth_date=${index + 1}&hash=test-${index}`,
        { ...TEST_USER, userId },
        createReply() as never,
      );

    try {
      await storePart(0, 'same-user');
      await storePart(1, 'same-user');
      await expect(storePart(2, 'same-user')).rejects.toThrow(BadRequestException);

      for (let index = 2; index < 16; index += 1) {
        await storePart(index, `user-${index}`);
      }
      await expect(storePart(16, 'user-16')).rejects.toThrow(BadRequestException);
    } finally {
      controller.onModuleDestroy();
    }
  });

  it('assembles chunked tunnel bodies before forwarding the mutation', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({
      imageBase64: 'x'.repeat(20_000),
      imageMimeType: 'image/jpeg',
    });
    const encoded = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
    const chunks = Array.from({ length: Math.ceil(encoded.length / 4_200) }, (_, index) =>
      encoded.slice(index * 4_200, (index + 1) * 4_200),
    );

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    for (const [chunkIndex, chunk] of chunks.entries()) {
      const chunkReply = createReply();
      await controller.tunnel(
        {
          method: 'POST',
          path: '/channels/channel-1/broadcast',
          contentType: 'application/json',
          uploadId: 'test-upload-id-123456',
          chunkIndex: String(chunkIndex),
          chunkCount: String(chunks.length),
          chunk,
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        chunkReply as never,
      );
      expect(chunkReply.status).toHaveBeenCalledWith(200);
    }

    await controller.tunnel(
      {
        method: 'POST',
        path: '/channels/channel-1/broadcast',
        contentType: 'application/json',
        uploadId: 'test-upload-id-123456',
        chunkCount: String(chunks.length),
        commit: '1',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/channels/channel-1/broadcast',
      expect.objectContaining({
        method: 'POST',
        body: Buffer.from(payload, 'utf8'),
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'Content-Type': 'application/json',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it('enforces Publisher control body limits while retaining chunk parts', async () => {
    const controller = new MiniappMutationTunnelController();
    const chunk = Buffer.alloc(4_200, 1).toString('base64url');
    global.fetch = jest.fn() as typeof fetch;

    try {
      for (let chunkIndex = 0; chunkIndex < 3; chunkIndex += 1) {
        await controller.tunnel(
          {
            method: 'PATCH',
            path: '/publisher/entities/chat/chat-1/modules',
            contentType: 'application/json',
            uploadId: 'publisher-control-limit-1',
            chunkIndex: String(chunkIndex),
            chunkCount: '4',
            chunk,
          },
          'InitData auth_date=1&hash=test',
          TEST_USER,
          createReply() as never,
        );
      }

      await expect(
        controller.tunnel(
          {
            method: 'PATCH',
            path: '/publisher/entities/chat/chat-1/modules',
            contentType: 'application/json',
            uploadId: 'publisher-control-limit-1',
            chunkIndex: '3',
            chunkCount: '4',
            chunk,
          },
          'InitData auth_date=1&hash=test',
          TEST_USER,
          createReply() as never,
        ),
      ).rejects.toThrow(BadRequestException);
      expect((controller as any).chunkedUploadStore.getUsage()).toMatchObject({
        activeUploads: 1,
        retainedBytes: 12_600,
      });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      controller.onModuleDestroy();
    }
  });

  it('binds chunked uploads to the resolved session principal across credential rotation', async () => {
    const controller = new MiniappMutationTunnelController();
    const sessionRequest = (principalKey: string) =>
      ({
        headers: {},
        miniappAuth: {
          source: 'session',
          principalKey,
        },
      }) as never;

    global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch;

    try {
      await controller.tunnel(
        {
          method: 'POST',
          path: '/channels/channel-1/broadcast',
          contentType: 'application/json',
          uploadId: 'principal-bound-upload-123',
          chunkIndex: '0',
          chunkCount: '1',
          chunk: 'e30',
        },
        'InitData auth_date=1&hash=old',
        TEST_USER,
        createReply() as never,
        sessionRequest('session-principal-a'),
      );

      await expect(
        controller.tunnel(
          {
            method: 'POST',
            path: '/channels/channel-1/broadcast',
            contentType: 'application/json',
            uploadId: 'principal-bound-upload-123',
            chunkCount: '1',
            commit: '1',
          },
          'InitData auth_date=2&hash=new',
          TEST_USER,
          createReply() as never,
          sessionRequest('session-principal-b'),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(global.fetch).not.toHaveBeenCalled();

      await controller.tunnel(
        {
          method: 'POST',
          path: '/channels/channel-1/broadcast',
          contentType: 'application/json',
          uploadId: 'principal-bound-upload-123',
          chunkCount: '1',
          commit: '1',
        },
        'InitData auth_date=2&hash=new',
        TEST_USER,
        createReply() as never,
        sessionRequest('session-principal-a'),
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:3001/api/v1/channels/channel-1/broadcast',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'InitData auth_date=2&hash=new',
          }),
        }),
      );
    } finally {
      controller.onModuleDestroy();
    }
  });

  it('rejects ambiguous compressed and plain tunnel bodies', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        {
          method: 'PUT',
          path: '/chats/chat-1/settings',
          body: 'e30',
          bodyGzip: 'e30',
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects recursive tunnel targets', async () => {
    const controller = new MiniappMutationTunnelController();

    await expect(
      controller.tunnel(
        { method: 'POST', path: '/_mutation-tunnel' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects targets outside the miniapp mutation allowlist', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        { method: 'POST', path: '/mode' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed tunnel bodies before forwarding', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        { method: 'PUT', path: '/chats/chat-1/settings', body: 'not-valid*' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps local API aborts to a gateway timeout', async () => {
    jest.useFakeTimers();
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();

    global.fetch = jest.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    ) as typeof fetch;

    const request = controller.tunnel(
      { method: 'PUT', path: '/channels/channel-1/settings', body: 'e30' },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );
    const assertion = expect(request).rejects.toThrow(GatewayTimeoutException);

    await jest.advanceTimersByTimeAsync(25_000);
    await assertion;
  });
});

describe('ChunkedMutationTunnelUploadStore', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retains the full 34 MiB product payload budget', () => {
    expect(DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxBodyBytes).toBe(34 * 1024 * 1024);
    expect(DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxRetainedBytes).toBeGreaterThanOrEqual(
      DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxBodyBytes,
    );
  });

  it('enforces aggregate bytes and keeps replacement accounting atomic', () => {
    const store = new ChunkedMutationTunnelUploadStore({
      maxActiveUploads: 4,
      maxActiveUploadsPerUser: 4,
      maxBodyBytes: 10,
      maxRetainedBytes: 10,
      ttlMs: 60_000,
    });
    const uploadAMetadata = createUploadMetadata();
    const uploadBMetadata = createUploadMetadata({
      authHash: 'auth-hash-2',
      authUserKey: 'user-key-2',
    });

    try {
      store.storeChunk({
        uploadId: 'upload-a',
        metadata: uploadAMetadata,
        chunkIndex: 0,
        chunk: Buffer.alloc(8, 1),
      });
      expect(() =>
        store.storeChunk({
          uploadId: 'upload-b',
          metadata: uploadBMetadata,
          chunkIndex: 0,
          chunk: Buffer.alloc(3, 2),
        }),
      ).toThrow(BadRequestException);
      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 8 });

      store.storeChunk({
        uploadId: 'upload-b',
        metadata: uploadBMetadata,
        chunkIndex: 0,
        chunk: Buffer.alloc(2, 2),
      });
      expect(() =>
        store.storeChunk({
          uploadId: 'upload-a',
          metadata: uploadAMetadata,
          chunkIndex: 0,
          chunk: Buffer.alloc(9, 3),
        }),
      ).toThrow(BadRequestException);
      expect(store.getUsage()).toMatchObject({ activeUploads: 2, retainedBytes: 10 });

      const committed = store.beginCompletedUpload('upload-a', uploadAMetadata);
      expect(committed.chunks[0]).toEqual(Buffer.alloc(8, 1));
      expect(store.getUsage()).toMatchObject({ activeUploads: 2, retainedBytes: 10 });
      expect(store.deleteUpload('upload-a')).toBe(true);
      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 2 });
      expect(store.deleteUpload('upload-b')).toBe(true);
      expect(store.getUsage()).toMatchObject({ activeUploads: 0, retainedBytes: 0 });
    } finally {
      store.dispose();
    }
  });

  it('rejects an oversized replacement without discarding the accepted chunk', () => {
    const store = new ChunkedMutationTunnelUploadStore({
      maxActiveUploads: 2,
      maxActiveUploadsPerUser: 2,
      maxBodyBytes: 8,
      maxRetainedBytes: 20,
      ttlMs: 60_000,
    });
    const metadata = createUploadMetadata();

    try {
      store.storeChunk({
        uploadId: 'upload-a',
        metadata,
        chunkIndex: 0,
        chunk: Buffer.alloc(8, 1),
      });
      expect(() =>
        store.storeChunk({
          uploadId: 'upload-a',
          metadata,
          chunkIndex: 0,
          chunk: Buffer.alloc(9, 2),
        }),
      ).toThrow(BadRequestException);

      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 8 });
      expect(store.beginCompletedUpload('upload-a', metadata).chunks[0]).toEqual(
        Buffer.alloc(8, 1),
      );
      expect(store.deleteUpload('upload-a')).toBe(true);
      expect(store.getUsage()).toMatchObject({ activeUploads: 0, retainedBytes: 0 });
    } finally {
      store.dispose();
    }
  });

  it('expires uploads and releases count and byte budgets without another request', async () => {
    jest.useFakeTimers();
    const store = new ChunkedMutationTunnelUploadStore({
      maxActiveUploads: 1,
      maxActiveUploadsPerUser: 1,
      maxBodyBytes: 4,
      maxRetainedBytes: 4,
      ttlMs: 1_000,
    });

    try {
      store.storeChunk({
        uploadId: 'upload-a',
        metadata: createUploadMetadata({ chunkCount: 2 }),
        chunkIndex: 0,
        chunk: Buffer.alloc(4, 1),
      });
      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 4 });

      await jest.advanceTimersByTimeAsync(1_000);

      expect(store.getUsage()).toMatchObject({ activeUploads: 0, retainedBytes: 0 });
      expect(store.getUsage().activeUploadsByUser.size).toBe(0);
    } finally {
      store.dispose();
    }
  });
});
