import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { NIGHT_MODE_COMMENT_THREAD_PREFIX } from '../common/night-mode-comment-thread.util';
import type { MaxClientService } from '../max/max-client.service';
import {
  buildNightModeClosedNoticeOptions,
  buildNightModeCommentsButton,
} from '../moderation/night-mode-transition-closed-notice-options.util';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { saveChatSettings, sanitizeStoredChatSettings } from './admin-chat-settings';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import { readDialogButtonToken } from './admin-service-focused-test-support';
import { AdminService } from './admin.service';
import { CHANNEL_DIALOG_ACTION_COMMENT } from './admin.service.support';
import { ChannelDialogService } from './channel-dialog.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

native('night close comments with independently saved PostgreSQL settings', () => {
  const botId = '777000_bot';
  const botToken = 'night-comments-native-test-token';
  const config = new ConfigService({
    APP_BASE_URL: 'https://major-maksimov.ru',
    MAX_BOT_ID: botId,
    MAX_BOT_CONTACT_ID: '777000',
    MAX_BOT_TOKEN: botToken,
  });
  const links = new AdminDialogLinkHelper({
    appBaseUrl: 'https://major-maksimov.ru',
    explicitBotContactId: '777000',
    ownBotUserId: botId,
    maxBotToken: botToken,
    maxBotTokenValidationSecrets: [botToken],
  });
  const cache = {
    invalidate: jest
      .fn<
        ReturnType<ChatContextCacheService['invalidate']>,
        Parameters<ChatContextCacheService['invalidate']>
      >()
      .mockResolvedValue(undefined),
  } satisfies Pick<ChatContextCacheService, 'invalidate'>;
  const maxClient = {
    getChatAdminIds: jest
      .fn<
        ReturnType<MaxClientService['getChatAdminIds']>,
        Parameters<MaxClientService['getChatAdminIds']>
      >()
      .mockResolvedValue([]),
  } satisfies Pick<MaxClientService, 'getChatAdminIds'>;
  let db: PrismaClient;
  let chatId: string;
  let user: AuthUser;
  let dialogs: ChannelDialogService;

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local PostgreSQL required');
    db = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 10_000 });
  });
  beforeEach(async () => {
    const suffix = randomUUID();
    chatId = `night-comments-${suffix}`;
    user = { userId: `author-${suffix}`, username: null, displayName: 'Участник' };
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Ночные комментарии',
        entityType: 'CHAT',
        settings: { create: {} },
        publisherSettings: { create: {} },
      },
    });
    const admin = new AdminService(
      db as PrismaService,
      maxClient as unknown as MaxClientService,
      cache as unknown as ChatContextCacheService,
      config,
    );
    dialogs = new ChannelDialogService(admin, config, db as PrismaService);
  });
  afterEach(async () => {
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function saveNightComments(enabled: boolean) {
    const row = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    await saveChatSettings({
      prisma: db as PrismaService,
      chatContextCache: cache,
      chatId,
      actorUserId: user.userId,
      body: {
        ...chatSettingsSchema.parse(sanitizeStoredChatSettings(row)),
        settingsRevision: row.updatedAt.toISOString(),
        nightModeEnabled: true,
        nightModeBotMessageEnabled: true,
        nightModeCommentsEnabled: enabled,
      },
      source: 'miniapp',
      resolveBotAssignmentData: () => ({}),
      assertRequiredSubscriptionSettings: async () => undefined,
      reportsAvailable: () => false,
      assertBotCapabilities: async () => undefined,
      refreshExecutionReadiness: async () => undefined,
    });
    return db.chatSettings.findUniqueOrThrow({ where: { chatId } });
  }

  async function nightToken() {
    const settings = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const button = buildNightModeCommentsButton({
      chatId,
      nightModeCommentsEnabled: settings.nightModeCommentsEnabled,
      buildButton: ({ chatId: target, threadId, text }) =>
        links.buildChatDialogButton(target, 'comments', threadId, text),
    });
    expect(button).not.toBeNull();
    const options = buildNightModeClosedNoticeOptions({
      commentsButton: button,
      baseOptions: { button: { text: 'Районный чат', url: 'https://example.com/local-chat' } },
    });
    expect(options?.buttons?.[1]?.[0]).toMatchObject({ text: 'Районный чат' });
    const launch = options?.buttons?.[0]?.[0];
    if (!launch || !('url' in launch)) throw new Error('Expected a signed discussion launch link');
    const token = readDialogButtonToken(launch);
    expect(links.resolveChatDialogThreadId(chatId, 'comments', token)).toMatch(
      new RegExp(`^${NIGHT_MODE_COMMENT_THREAD_PREFIX}`),
    );
    return token;
  }

  it.each([false, true])(
    'saves, opens and mutates a night discussion with legacy comments off and Publik=%s',
    async (publisherEnabled) => {
      await db.publisherEntitySettings.update({
        where: { chatId },
        data: { chatCommentsEnabled: publisherEnabled },
      });
      const settings = await saveNightComments(true);
      expect(settings.commentsEnabled).toBe(false);
      expect(settings.nightModeCommentsEnabled).toBe(true);
      const token = await nightToken();
      expect((await dialogs.getChatDialog(chatId, user, 'comments', token)).messages).toEqual([]);

      const created = await dialogs.createChatDialogMessage(chatId, user, 'comments', {
        token,
        text: 'Обсудим завтра',
      });
      const messageId = created.message.id;
      await expect(
        dialogs.updateChatDialogMessage(chatId, user, 'comments', messageId, {
          token,
          text: 'Уточним завтра утром',
        }),
      ).resolves.toMatchObject({ ok: true, message: { text: 'Уточним завтра утром' } });
      await expect(
        dialogs.toggleChatDialogReaction(chatId, user, 'comments', messageId, {
          token,
          emoji: '👍',
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        dialogs.updateChatDialogNotifications(chatId, user, 'comments', {
          token,
          mode: 'all',
          scope: 'thread',
        }),
      ).resolves.toMatchObject({ ok: true, notificationSettings: { mode: 'all' } });
      const reply = await dialogs.createChatDialogMessage(chatId, user, 'comments', {
        token,
        text: 'Ответ в той же теме',
        replyToMessageId: messageId,
      });
      await expect(
        dialogs.deleteChatDialogMessage(chatId, user, 'comments', reply.message.id, { token }),
      ).resolves.toMatchObject({ ok: true });
      const readback = await dialogs.getChatDialog(chatId, user, 'comments', token);
      expect(readback.messages).toHaveLength(1);
      expect(readback.messages[0]).toMatchObject({
        id: messageId,
        text: 'Уточним завтра утром',
        reactionGroups: [{ emoji: '👍', count: 1, reactedByMe: true }],
      });
      const stored = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
      expect(stored.commentsEnabled).toBe(false);
      expect(
        (await db.publisherEntitySettings.findUniqueOrThrow({ where: { chatId } }))
          .chatCommentsEnabled,
      ).toBe(publisherEnabled);
    },
  );

  it('denies ordinary, cross-chat and forged night threads while the night switch is on', async () => {
    await saveNightComments(true);
    const ordinary = links.buildEntityDialogToken('chat', chatId, 'comments', randomUUID());
    await expect(dialogs.getChatDialog(chatId, user, 'comments', ordinary)).rejects.toThrow(
      'Комментарии для этого чата сейчас закрыты',
    );
    const forged = JSON.parse(Buffer.from(ordinary.slice(4), 'base64url').toString('utf8')) as {
      v: number;
      d: string;
      s: string;
    };
    forged.d = `${NIGHT_MODE_COMMENT_THREAD_PREFIX}${randomUUID()}`;
    const token = `cdt-${Buffer.from(JSON.stringify(forged)).toString('base64url')}`;
    await expect(dialogs.getChatDialog(chatId, user, 'comments', token)).rejects.toThrow();
    const crossChat = links.buildEntityDialogToken(
      'chat',
      'different-chat',
      'comments',
      `${NIGHT_MODE_COMMENT_THREAD_PREFIX}${randomUUID()}`,
    );
    await expect(dialogs.getChatDialog(chatId, user, 'comments', crossChat)).rejects.toThrow();
    expect(
      await db.auditLog.count({ where: { chatId, action: CHANNEL_DIALOG_ACTION_COMMENT } }),
    ).toBe(0);
  });

  it('revokes new night discussion operations on OFF while preserving legacy discussions', async () => {
    await saveNightComments(true);
    const token = await nightToken();
    const created = await dialogs.createChatDialogMessage(chatId, user, 'comments', {
      token,
      text: 'Сохранённый комментарий',
    });
    await db.chatSettings.update({ where: { chatId }, data: { commentsEnabled: true } });
    const messageId = created.message.id;
    const unscoped = links.buildEntityDialogToken('chat', chatId, 'comments');
    const legacy = await dialogs.createChatDialogMessage(chatId, user, 'comments', {
      token: unscoped,
      text: 'Прежнее общее обсуждение',
    });
    const historical = await db.auditLog.create({
      data: {
        chatId,
        actorUserId: user.userId,
        action: CHANNEL_DIALOG_ACTION_COMMENT,
        payload: {
          type: 'comments',
          text: 'Историческое сообщение без поля темы',
          authorDisplayName: user.displayName,
        },
      },
    });
    const legacyIds = [legacy.message.id, historical.id].sort();
    const aggregate = await dialogs.getChatDialog(chatId, user, 'comments', unscoped);
    expect(aggregate.messages.map((message) => message.id).sort()).toEqual(legacyIds);
    const unscopedNightOperations = [
      () =>
        dialogs.createChatDialogMessage(chatId, user, 'comments', {
          token: unscoped,
          text: 'Обход через ответ',
          replyToMessageId: messageId,
        }),
      () =>
        dialogs.updateChatDialogMessage(chatId, user, 'comments', messageId, {
          token: unscoped,
          text: 'Обход через старую ссылку',
        }),
      () =>
        dialogs.deleteChatDialogMessage(chatId, user, 'comments', messageId, { token: unscoped }),
      () =>
        dialogs.toggleChatDialogReaction(chatId, user, 'comments', messageId, {
          token: unscoped,
          emoji: '👍',
        }),
    ];
    for (const operation of unscopedNightOperations) await expect(operation()).rejects.toThrow();

    await saveNightComments(false);
    const operations = [
      () => dialogs.getChatDialog(chatId, user, 'comments', token),
      () => dialogs.createChatDialogMessage(chatId, user, 'comments', { token, text: 'Новый' }),
      () =>
        dialogs.updateChatDialogMessage(chatId, user, 'comments', messageId, {
          token,
          text: 'Правка',
        }),
      () => dialogs.deleteChatDialogMessage(chatId, user, 'comments', messageId, { token }),
      () =>
        dialogs.toggleChatDialogReaction(chatId, user, 'comments', messageId, {
          token,
          emoji: '👍',
        }),
      () => dialogs.updateChatDialogNotifications(chatId, user, 'comments', { token, mode: 'all' }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow('Комментарии для этого чата сейчас закрыты');
    }
    for (const operation of unscopedNightOperations) await expect(operation()).rejects.toThrow();
    const ordinary = links.buildEntityDialogToken('chat', chatId, 'comments', randomUUID());
    await expect(dialogs.getChatDialog(chatId, user, 'comments', ordinary)).resolves.toMatchObject({
      messages: [],
    });
    const afterDisable = await dialogs.getChatDialog(chatId, user, 'comments', unscoped);
    expect(afterDisable.messages.map((message) => message.id).sort()).toEqual(legacyIds);
    expect(
      (await db.auditLog.findUniqueOrThrow({ where: { id: messageId } })).payload,
    ).toMatchObject({
      text: 'Сохранённый комментарий',
    });
  });
});
