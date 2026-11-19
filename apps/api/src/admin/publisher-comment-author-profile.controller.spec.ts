import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { InitDataService } from '../auth/init-data.service';
import { MiniappProfileGuard } from '../auth/miniapp-profile.guard';
import { PublisherInitDataKeyService } from '../auth/publisher-init-data-key.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { createPrismaClient, type Prisma, type PrismaClient } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherCommentProfileService } from '../publisher/publisher-comment-profile.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { PublisherDialogSigningKeyService } from '../publisher/publisher-dialog-signing-key.service';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import {
  CHANNEL_DIALOG_ACTION_COMMENT,
  PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
} from './admin.service.support';
import { PublisherCommentAuthorProfileController } from './publisher-comment-author-profile.controller';

const ACTOR_ID = '100001';
const PUBLISHER_ID = 'synthetic_publisher_bot';
const MAJOR_TOKEN = 'synthetic-major-token-100';
const PUBLISHER_TOKEN = 'synthetic-publisher-token-200';
const START_URL = `https://max.ru/${PUBLISHER_ID}?start=synthetic`;
const THREAD_ID = 'thread-published-1';

function initDataKey(token: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(token).digest();
}

function signedAuthorization(token: string): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: ACTOR_ID }),
  });
  const data = Array.from(params, ([key, value]) => `${key}=${value}`).join('\n');
  const hash = createHmac('sha256', initDataKey(token)).update(data).digest('hex');
  params.set('hash', hash);
  return `InitData ${params.toString()}`;
}

function newEntityId(): string {
  return String(-randomInt(1_000_000_000_000, 10_000_000_000_000));
}

function newCommentId(): string {
  return `c${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

describe('Publisher comment author profile HTTP handoff', () => {
  const channelId = newEntityId();
  const chatId = newEntityId();
  const otherChannelId = newEntityId();
  const channelComment = newCommentId();
  const chatComment = newCommentId();
  const wrongThreadComment = newCommentId();
  const wrongNamespaceComment = newCommentId();
  const otherChannelComment = newCommentId();
  const rows = [
    {
      id: channelComment,
      chatId: channelId,
      action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
      payload: { threadId: THREAD_ID },
    },
    {
      id: chatComment,
      chatId,
      action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
      payload: { threadId: THREAD_ID },
    },
    {
      id: wrongThreadComment,
      chatId: channelId,
      action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
      payload: { threadId: 'another-thread' },
    },
    {
      id: wrongNamespaceComment,
      chatId: channelId,
      action: CHANNEL_DIALOG_ACTION_COMMENT,
      payload: { threadId: THREAD_ID },
    },
    {
      id: otherChannelComment,
      chatId: otherChannelId,
      action: PUBLISHER_CHAT_DIALOG_ACTION_COMMENT,
      payload: { threadId: THREAD_ID },
    },
  ] as const;
  const findComment = jest.fn(async ({ where }: Prisma.AuditLogFindUniqueArgs) => {
    if (
      !where.payload ||
      !('equals' in where.payload) ||
      !('path' in where.payload) ||
      where.payload.path?.length !== 1 ||
      where.payload.path[0] !== 'threadId'
    ) {
      return null;
    }
    const threadId = where.payload.equals;
    const row = rows.find(
      (entry) =>
        entry.id === where.id &&
        entry.chatId === where.chatId &&
        entry.action === where.action &&
        entry.payload.threadId === threadId,
    );
    return row ? { id: row.id } : null;
  });
  const assertEntityReady = jest.fn<
    ReturnType<PublisherReadinessService['assertEntityReady']>,
    Parameters<PublisherReadinessService['assertEntityReady']>
  >();
  const buildStartUrl = jest.fn<
    ReturnType<PublisherCommentProfileService['buildStartUrl']>,
    Parameters<PublisherCommentProfileService['buildStartUrl']>
  >();
  const config = new ConfigService({
    MAX_BOT_ID: 'synthetic_major_bot',
    MAX_BOT_TOKEN: MAJOR_TOKEN,
    MAX_WEBHOOK_SECRET_PATH: 'synthetic-major-webhook-path',
    MAX_WEBHOOK_HEADER_SECRET: 'synthetic-major-webhook-header',
    MAX_PUBLISHER_BOT_ID: PUBLISHER_ID,
  });
  const signingKeys = { getSigningKeys: () => ['synthetic-publisher-dialog-key'] } satisfies Pick<
    PublisherDialogSigningKeyService,
    'getSigningKeys'
  >;
  const initDataKeys = {
    getVerificationKeys: () => ({ botId: PUBLISHER_ID, keys: [initDataKey(PUBLISHER_TOKEN)] }),
  } satisfies Pick<PublisherInitDataKeyService, 'getVerificationKeys'>;
  const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim();
  let db: PrismaClient | undefined;
  let app: NestFastifyApplication | undefined;

  beforeAll(async () => {
    if (databaseUrl) {
      const url = new URL(databaseUrl);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      ) {
        throw new Error('Disposable local race_test database required');
      }
      db = createPrismaClient(databaseUrl, { max: 1, statement_timeout: 5_000 });
      await db.chat.createMany({
        data: [
          { id: channelId, title: 'Publisher test channel', entityType: 'CHANNEL' },
          { id: chatId, title: 'Publisher test chat', entityType: 'CHAT' },
          { id: otherChannelId, title: 'Other Publisher test channel', entityType: 'CHANNEL' },
        ],
      });
      await db.auditLog.createMany({
        data: rows.map((row) => ({ ...row, actorUserId: '200001' })),
      });
    }
    const module = await Test.createTestingModule({
      controllers: [PublisherCommentAuthorProfileController],
      providers: [
        InitDataService,
        MiniappProfileGuard,
        MaxBotRegistryService,
        PublisherDialogLinkService,
        { provide: ConfigService, useValue: config },
        { provide: PublisherInitDataKeyService, useValue: initDataKeys },
        { provide: PublisherDialogSigningKeyService, useValue: signingKeys },
        { provide: PrismaService, useValue: db ?? { auditLog: { findUnique: findComment } } },
        { provide: PublisherReadinessService, useValue: { assertEntityReady } },
        { provide: PublisherCommentProfileService, useValue: { buildStartUrl } },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }, 15_000);

  beforeEach(() => {
    findComment.mockClear();
    buildStartUrl.mockReset().mockReturnValue(START_URL);
    assertEntityReady.mockReset().mockImplementation(async (entityId) => ({
      chatId: entityId,
      entityType: entityId === chatId ? 'chat' : 'channel',
      requiredBotId: PUBLISHER_ID,
      policyRevision: 1,
    }));
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      try {
        await db.chat.deleteMany({ where: { id: { in: [channelId, chatId, otherChannelId] } } });
      } finally {
        await db.$disconnect();
      }
    }
  });

  function dialogToken(entity: 'channel' | 'chat', entityId: string): string {
    if (!app) throw new Error('Missing Nest test app');
    const links = app.get(PublisherDialogLinkService);
    const button =
      entity === 'channel'
        ? links.buildChannelDialogButton(entityId, 'comments', THREAD_ID, 'Comments')
        : links.buildChatDialogButton(entityId, 'comments', THREAD_ID, 'Comments');
    if (button.type !== 'link') throw new Error('Missing signed Publisher link');
    const launchParam = new URL(button.url).searchParams.get('startapp');
    if (!launchParam) throw new Error('Missing signed Publisher launch parameter');
    const token = JSON.parse(Buffer.from(launchParam.slice(3), 'base64url').toString())?.t;
    if (typeof token !== 'string') throw new Error('Missing signed Publisher comment token');
    return token;
  }

  function request(
    entity: 'channel' | 'chat',
    entityId: string,
    commentId: string,
    body: Record<string, string>,
    authorization = signedAuthorization(PUBLISHER_TOKEN),
  ) {
    if (!app) throw new Error('Missing Nest test app');
    return app.inject({
      method: 'POST',
      url: `/v1/${entity}s/${entityId}/dialog/comments/messages/${commentId}/profile/handoff`,
      headers: { authorization },
      payload: body,
    });
  }

  it.each([
    ['channel', channelId, channelComment],
    ['chat', chatId, chatComment],
  ] as const)(
    'opens the exact comment for a Publisher reader in a %s',
    async (entity, entityId, commentId) => {
      const response = await request(entity, entityId, commentId, {
        token: dialogToken(entity, entityId),
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ botUrl: START_URL });
      expect(assertEntityReady).toHaveBeenCalledWith(entityId, 'publication');
      expect(buildStartUrl).toHaveBeenCalledWith({ actorUserId: ACTOR_ID, commentId });
    },
  );

  it('rejects moderation credentials, a caller-supplied target and a token for another entity before reading state', async () => {
    const token = dialogToken('channel', channelId);
    const deniedProfile = await request(
      'channel',
      channelId,
      channelComment,
      { token },
      signedAuthorization(MAJOR_TOKEN),
    );
    expect(deniedProfile.statusCode).toBe(403);
    expect(deniedProfile.json()).toMatchObject({ code: 'MINIAPP_PROFILE_FORBIDDEN' });
    const explicitTarget = await request('channel', channelId, channelComment, {
      token,
      targetUserId: '900009',
    });
    expect(explicitTarget.statusCode).toBe(400);
    const crossChat = await request('channel', otherChannelId, channelComment, { token });
    expect(crossChat.statusCode).toBe(400);
    const crossEntity = await request('chat', channelId, channelComment, { token });
    expect(crossEntity.statusCode).toBe(400);
    expect(assertEntityReady).not.toHaveBeenCalled();
    expect(findComment).not.toHaveBeenCalled();
    expect(buildStartUrl).not.toHaveBeenCalled();
  });

  it.each([wrongThreadComment, wrongNamespaceComment, otherChannelComment, newCommentId()])(
    'hides a comment outside the signed Publisher discussion (%s)',
    async (commentId) => {
      const response = await request('channel', channelId, commentId, {
        token: dialogToken('channel', channelId),
      });
      expect(response.statusCode).toBe(404);
      expect(buildStartUrl).not.toHaveBeenCalled();
    },
  );
});
