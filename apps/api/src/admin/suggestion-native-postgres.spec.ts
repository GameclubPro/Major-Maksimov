import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { ForbiddenException } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import {
  createPrismaClient,
  type PrismaClient,
  type AuditLog,
  type ChannelSuggestionAdminDelivery,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { MaxClientService } from '../max/max-client.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import type { ChannelDialogService } from './channel-dialog.service';
import type { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import type { ChannelPostSignatureService } from './channel-post-signature.service';
import type { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import type { PublisherSuggestionAdminJob } from '../publisher/publisher-suggestion-admin.queue';
import type { AdminSuggestionDeliveryJob } from './admin-suggestion-delivery.queue';
import {
  SuggestionNativeQueueService,
  type SuggestionNativeJob,
} from '../publisher/suggestion-native.queue';
import { SuggestionNativeService } from './suggestion-native.service';
import { SuggestionReviewService } from './suggestion-review.service';
import { SuggestionReviewEffectsService } from './suggestion-review-effects.service';
import { suggestionObject } from './suggestion-review-effects.service';
import {
  AdminChannelSuggestionPublicationRuntime,
  type AdminChannelSuggestionPublicationRuntimeContext,
} from './admin-channel-suggestion-publication-runtime';
import {
  buildChannelSuggestionPublicationLedgerJobId,
  withChannelSuggestionPublicationContextDigest,
  CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
} from './admin-channel-suggestion-publication-protocol';
import { suggestionContentPatch, suggestionRequestPatch } from './suggestion-review-content';
import {
  parseSuggestionNativeCallback,
  suggestionNativeButtons,
  type SuggestionNativeAction,
} from './suggestion-native-protocol';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(30000);

native('native suggestion dialog on real PostgreSQL/Redis', () => {
  let db: PrismaClient;
  let major: Queue<SuggestionNativeJob>;
  let publisher: Queue<SuggestionNativeJob>;
  let service: SuggestionNativeService;
  let review: SuggestionReviewService;
  let effects: SuggestionReviewEffectsService;
  let ingress: SuggestionNativeQueueService;
  let edit: jest.MockedFunction<MaxClientService['editMessageInlineKeyboard']>;
  let send: jest.MockedFunction<MaxClientService['sendMessageImmediateToUser']>;
  let answer: jest.MockedFunction<MaxClientService['answerCallback']>;
  let authorize: jest.MockedFunction<ManagedEntitiesService['assertChannelAdminAccess']>;
  const chats: string[] = [];
  const messages = new Map<string, Record<string, unknown>>();
  const attachmentBuilder = Object.create(MaxClientService.prototype) as {
    buildEditableMessageAttachments(
      message: Record<string, unknown>,
      options: Parameters<MaxClientService['editMessageInlineKeyboard']>[3],
    ): Record<string, unknown>[];
  };
  type Fixture = {
    row: AuditLog;
    card: ChannelSuggestionAdminDelivery;
    profile: MiniappProfile;
    botId: string;
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl),
      redis = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1', '::1'].includes(redis.hostname)
    )
      throw new Error('Disposable stores required');
    db = createPrismaClient(databaseUrl, { max: 8 });
    await db.$connect();
    const connection = { host: redis.hostname, port: Number(redis.port) };
    major = new Queue(`native-major-${randomUUID()}`, { connection });
    publisher = new Queue(`native-publisher-${randomUUID()}`, { connection });
  });
  beforeEach(() => {
    edit = jest
      .fn<
        ReturnType<MaxClientService['editMessageInlineKeyboard']>,
        Parameters<MaxClientService['editMessageInlineKeyboard']>
      >()
      .mockImplementation(async (_chat, id, text, options) => {
        const source = messages.get(id);
        if (!source) throw new Error('Test card snapshot missing');
        const attachments = attachmentBuilder.buildEditableMessageAttachments(source, options);
        await options?.beforeEditMutation?.();
        messages.set(id, { body: { text, attachments } });
        return true;
      });
    send = jest
      .fn<
        ReturnType<MaxClientService['sendMessageImmediateToUser']>,
        Parameters<MaxClientService['sendMessageImmediateToUser']>
      >()
      .mockImplementation(async (_id, _text, options) => {
        await options?.beforeSend?.();
        return { messageId: 'reply-receipt', url: null };
      });
    answer = jest
      .fn<
        ReturnType<MaxClientService['answerCallback']>,
        Parameters<MaxClientService['answerCallback']>
      >()
      .mockResolvedValue(undefined);
    authorize = jest
      .fn<
        ReturnType<ManagedEntitiesService['assertChannelAdminAccess']>,
        Parameters<ManagedEntitiesService['assertChannelAdminAccess']>
      >()
      .mockResolvedValue();
    const max = {
      editMessageInlineKeyboard: edit,
      sendMessageImmediateToUser: send,
      answerCallback: answer,
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({ isAdmin: true }),
      getChatMemberAccess: jest.fn().mockResolvedValue({ isAdmin: true }),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/confirmed-post'),
    } satisfies Pick<
      MaxClientService,
      | 'editMessageInlineKeyboard'
      | 'sendMessageImmediateToUser'
      | 'answerCallback'
      | 'getCurrentChatMemberAccess'
      | 'getChatMemberAccess'
      | 'resolveMessageLink'
    >;
    const registry = {
      getPublisherBotDescriptor: () => ({ id: 'publisher' }),
      getActionableBots: () => [{ id: 'major' }],
      isKnownBotUserId: () => false,
    } as unknown as MaxBotRegistryService;
    effects = new SuggestionReviewEffectsService(
      db as unknown as PrismaService,
      max as unknown as MaxClientService,
      {
        assertChatBotAccessProbeAllowed: jest.fn().mockResolvedValue({}),
      } as unknown as MaxBotLinkService,
      major as unknown as Queue<AdminSuggestionDeliveryJob>,
      publisher as unknown as Queue<PublisherSuggestionAdminJob>,
      registry,
      {
        assertEntityReady: jest.fn().mockResolvedValue({ requiredBotId: 'publisher' }),
      } as unknown as PublisherReadinessService,
    );
    const reconciliationContext = {
      prisma: db as unknown as PrismaService,
      maxClient: max as unknown as MaxClientService,
      logger: { warn: jest.fn() },
      assertChatAdmin: authorize,
      readObjectPayload: suggestionObject,
      readTrimmedString: (value: unknown) =>
        typeof value === 'string' ? value.trim() || null : null,
      readLowerString: (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : null),
      syncChannelSuggestionAdminReviewMessages: jest.fn().mockResolvedValue(undefined),
    };
    const publication = new AdminChannelSuggestionPublicationRuntime(
      reconciliationContext as unknown as AdminChannelSuggestionPublicationRuntimeContext,
    );
    const dialogs = {
      reconcileSuggestion: (id, user) => publication.reconcileReview(id, user),
    } satisfies Pick<ChannelDialogService, 'reconcileSuggestion'>;
    review = new SuggestionReviewService(
      db as unknown as PrismaService,
      { assertChannelAdminAccess: authorize } as unknown as ManagedEntitiesService,
      { getEntity: jest.fn().mockResolvedValue({}) } as unknown as PublisherPolicyService,
      {} as PublisherSuggestionService,
      dialogs as ChannelDialogService,
      { getBotId: () => 'publisher' } as PublisherDialogLinkService,
      {
        preparePostText: jest.fn(async (_chat, content) => content),
      } as unknown as ChannelPostSignatureService,
      effects,
    );
    service = new SuggestionNativeService(
      db as unknown as PrismaService,
      review,
      effects,
      max as unknown as MaxClientService,
    );
    ingress = new SuggestionNativeQueueService(
      db as unknown as PrismaService,
      registry,
      major,
      publisher,
    );
  });
  afterEach(async () => {
    messages.clear();
    jest.restoreAllMocks();
    await db.maxActionLedgerEntry.deleteMany({ where: { chatId: { in: chats } } });
    await db.suggestionReviewContact.deleteMany({ where: { channelId: { in: chats } } });
    await db.chat.deleteMany({ where: { id: { in: chats.splice(0) } } });
    await db.suggestionReviewCardUpgrade.deleteMany();
    await major.drain(true);
    await publisher.drain(true);
  });
  afterAll(async () => {
    await major?.close();
    await publisher?.close();
    await db?.$disconnect();
  });

  async function seed(profile: MiniappProfile = 'moderation'): Promise<Fixture> {
    const chatId = `native-${randomUUID()}`,
      botId = profile === 'publisher' ? 'publisher' : 'major';
    chats.push(chatId);
    await db.chat.create({ data: { id: chatId, title: 'Объявления' } });
    const row = await db.auditLog.create({
      data: {
        chatId,
        actorUserId: '42',
        action:
          profile === 'publisher'
            ? 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
            : 'CHANNEL_DIALOG_SUGGESTION',
        payload: {
          type: 'suggest',
          text: '  Цена 300 ₽\n\n',
          textMarkup: [{ type: 'strong', from: 2, length: 4, url: null, userLink: null }],
          actorUserId: '42',
          authorDisplayName: 'Анна',
          authorProfileUrl: 'https://max.ru/anna',
          suggestionSourceBotId: botId,
        },
      },
    });
    const card = await db.channelSuggestionAdminDelivery.create({
      data: {
        auditLogId: row.id,
        adminUserId: '101',
        botKey: profile === 'publisher' ? 'publisher:publisher' : 'major',
        botId,
        privateChatId: '101',
        remoteMessageId: `card-${randomUUID()}`,
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    messages.set(card.remoteMessageId!, {
      body: {
        text: 'Карточка предложки',
        attachments: [
          { type: 'image', payload: { token: 'original-photo' } },
          { type: 'inline_keyboard', payload: { buttons: suggestionNativeButtons(row.id) } },
        ],
      },
    });
    return { row, card, profile, botId };
  }
  async function callback(
    f: Fixture,
    action: SuggestionNativeAction,
    patch: Partial<SuggestionNativeJob> = {},
  ) {
    const session = await db.suggestionReviewDialog.findUnique({
      where: { deliveryId: f.card.id },
    });
    const current = await db.auditLog.findUniqueOrThrow({ where: { id: f.row.id } });
    const revision = Number(
      (current.payload as Record<string, unknown>).reviewContentRevision ?? 0,
    );
    const job: SuggestionNativeJob = {
      version: 1,
      kind: 'suggestion-native',
      profile: f.profile,
      requiredBotId: f.botId,
      actorId: '101',
      privateChatId: '101',
      messageId: f.card.remoteMessageId!,
      callbackId: randomUUID(),
      callback: { action, id: f.row.id, revision, version: session?.version ?? 0 },
      eventId: randomUUID(),
      requestedAt: new Date().toISOString(),
      ...patch,
    };
    await service.process(job);
    return job;
  }

  async function seedPublication(f: Fixture, outcome: 'confirmed' | 'unknown' | 'unattempted') {
    const ledgerJobId = buildChannelSuggestionPublicationLedgerJobId(f.row.id);
    const context = withChannelSuggestionPublicationContextDigest({
      protocol: 'max_action_ledger_v1',
      preparedAt: new Date().toISOString(),
      messageDigest: 'b'.repeat(64),
      botId: f.botId,
      threadId: null,
      buttons: [],
      includeCommentsButton: false,
      includeSuggestButton: false,
      suggestButtonText: null,
      suggestionEntryMode: 'BOT',
      authorAttribution: {
        userId: '42',
        displayName: 'Анна',
        mentionDisplayName: 'Анна',
        username: null,
        profileUrl: 'https://max.ru/anna',
      },
    });
    await db.auditLog.update({
      where: { id: f.row.id },
      data: {
        payload: {
          ...suggestionObject(f.row.payload),
          reviewStatus: 'publishing',
          reviewAction: 'publish',
          reviewPublicationProtocol: context.protocol,
          reviewPublicationLedgerJobId: ledgerJobId,
          reviewClaimToken: 'retained-claim',
          reviewClaimedByUserId: '101',
          reviewClaimedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          ...(outcome !== 'unattempted' ? { reviewPublicationContext: context } : {}),
        },
      },
    });
    if (outcome !== 'unattempted')
      await db.maxActionLedgerEntry.create({
        data: {
          jobId: ledgerJobId,
          chatId: f.row.chatId,
          actionType: 'SEND_MESSAGE',
          sourceTag: CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
          status: outcome === 'confirmed' ? 'SUCCEEDED' : 'IN_PROGRESS',
          terminal: outcome === 'confirmed',
          ambiguous: outcome === 'unknown',
          dispatchToken: 'dispatch',
          dispatchStartedAt: new Date(),
          dispatchBotId: f.botId,
          remoteMessageId: outcome === 'confirmed' ? 'confirmed-message' : null,
          metadata: {
            ledgerContext: {
              suggestionId: f.row.id,
              publicationProtocol: context.protocol,
              claimToken: 'retained-claim',
              actorUserId: '42',
              messageDigest: context.messageDigest,
              contextDigest: context.contextDigest,
            },
          },
        },
      });
    return ledgerJobId;
  }

  it('reconciles a confirmed publication from the native card without another SEND', async () => {
    const f = await seed();
    await seedPublication(f, 'confirmed');
    await callback(f, 'publish');
    expect(
      (await db.auditLog.findUniqueOrThrow({ where: { id: f.row.id } })).payload,
    ).toMatchObject({ reviewStatus: 'published', publishedMessageId: 'confirmed-message' });
    expect(edit.mock.calls.at(-1)?.[3]?.buttons).toEqual([
      [
        expect.objectContaining({
          text: 'Опубликовано',
          payload: expect.stringContaining('sr1|hint|'),
        }),
      ],
    ]);
    expect(messages.get(f.card.remoteMessageId!)?.body).toMatchObject({
      attachments: [
        { type: 'image', payload: { token: 'original-photo' } },
        { type: 'inline_keyboard' },
      ],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps unknown publication effects fenced on repeated native clicks', async () => {
    const f = await seed();
    const jobId = await seedPublication(f, 'unknown');
    const before = await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } });
    await callback(f, 'publish');
    await callback(f, 'publish');
    expect(await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } })).toEqual(before);
    expect(answer.mock.calls.at(-1)?.[1]).toContain('Повторная отправка отключена');
    expect(send).not.toHaveBeenCalled();
  });

  it('releases only stale unattempted publication state without sending from reconciliation', async () => {
    const f = await seed();
    await seedPublication(f, 'unattempted');
    await review.reconcilePublication(f.row.id, f.profile, {
      userId: '101',
      username: null,
      displayName: null,
    });
    expect(
      (await db.auditLog.findUniqueOrThrow({ where: { id: f.row.id } })).payload,
    ).toMatchObject({ reviewStatus: 'pending' });
    expect(send).not.toHaveBeenCalled();
  });

  it('retains the exact edit request across a safe pre-dispatch failure and revision increment', async () => {
    const f = await seed();
    await callback(f, 'edit');
    await input(f, '  Цена 500 ₽\n\n');
    const error = new Error('temporary preparation failure');
    const publish = jest
      .spyOn(review, 'publish')
      .mockImplementationOnce(async (id, _profile, actor, body) => {
        const input = body as { requestId: string; expectedRevision: number; text: string };
        const row = await db.auditLog.findUniqueOrThrow({ where: { id } });
        const payload = suggestionObject(row.payload);
        await db.auditLog.update({
          where: { id },
          data: {
            payload: {
              ...payload,
              ...suggestionContentPatch(payload, input, actor.userId),
              ...suggestionRequestPatch(payload, 'publish', actor.userId, input, 1),
              reviewStatus: 'pending',
            },
          },
        });
        throw error;
      })
      .mockImplementationOnce(async (id, profile, actor) => review.get(id, profile, actor));
    const session = await db.suggestionReviewDialog.findUniqueOrThrow({
      where: { deliveryId: f.card.id },
    });
    const eventId = randomUUID();
    const patch = {
      eventId,
      callback: { action: 'publish' as const, id: f.row.id, revision: 0, version: session.version },
    };
    await expect(callback(f, 'publish', patch)).rejects.toBe(error);
    await callback(f, 'publish', patch);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[3]).toEqual(publish.mock.calls[0]?.[3]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['moderation', 'publisher'] as const)(
    'queues old %s publish buttons with bounded retries',
    async (profile) => {
      const f = await seed(profile);
      const update = {
        botId: f.botId,
        updateId: randomUUID(),
        type: 'message_callback',
        message: {
          messageId: f.card.remoteMessageId!,
          chatId: '101',
          senderId: '101',
          text: '',
          createdAt: new Date().toISOString(),
        },
        raw: {
          timestamp: Date.now(),
          callback: {
            callback_id: randomUUID(),
            user: { user_id: '101' },
            payload:
              profile === 'publisher'
                ? `psa:v1:publish:${f.row.id}`
                : `pc2|suggestion_review_publish|${f.row.id}`,
          },
        },
      } satisfies MaxUpdate;
      expect(await ingress.observeWebhook(update)).toBe(true);
      expect(await ingress.observeWebhook(update)).toBe(true);
      const jobs = await (profile === 'publisher' ? publisher : major).getJobs([
        'wait',
        'prioritized',
      ]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.data.callback).toEqual({
        action: 'publish',
        id: f.row.id,
        revision: 0,
        version: 0,
      });
      expect(jobs[0]?.opts.attempts).toBe(5);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('reports an exhausted transient failure without leaking raw transport details', async () => {
    const f = await seed();
    authorize.mockRejectedValue(new Error('internal password=secret'));
    const job: SuggestionNativeJob = {
      version: 1,
      kind: 'suggestion-native',
      profile: f.profile,
      requiredBotId: f.botId,
      actorId: '101',
      privateChatId: '101',
      messageId: f.card.remoteMessageId!,
      callbackId: 'callback',
      callback: { action: 'publish', id: f.row.id, revision: 0, version: 0 },
      eventId: randomUUID(),
      requestedAt: new Date().toISOString(),
    };
    await expect(service.process(job, { finalAttempt: false })).rejects.toThrow('internal');
    expect(answer).not.toHaveBeenCalled();
    await expect(service.process(job, { finalAttempt: true })).rejects.toThrow('internal');
    expect(answer.mock.calls[0]?.[1]).toContain('Не удалось подтвердить');
    expect(answer.mock.calls[0]?.[1]).not.toContain('secret');
    expect(send).not.toHaveBeenCalled();
  });
  async function input(f: Fixture, text: string, patch: Partial<SuggestionNativeJob> = {}) {
    const session = await db.suggestionReviewDialog.findUniqueOrThrow({
      where: { deliveryId: f.card.id },
    });
    const job: SuggestionNativeJob = {
      version: 1,
      kind: 'suggestion-native',
      profile: f.profile,
      requiredBotId: f.botId,
      actorId: '101',
      privateChatId: '101',
      messageId: randomUUID(),
      deliveryId: f.card.id,
      input: { text, markup: [] },
      eventId: randomUUID(),
      requestedAt: new Date().toISOString(),
      openedAt: session.openedAt.toISOString(),
      ...patch,
    };
    await service.process(job);
    return job;
  }

  it.each(['moderation', 'publisher'] as const)(
    'edits and saves through %s while preserving author, media and whitespace',
    async (profile) => {
      const f = await seed(profile);
      const media = await db.channelSuggestionImageAsset.create({
        data: {
          auditLogId: f.row.id,
          position: 0,
          bytes: Buffer.from('test'),
          sizeBytes: 4,
          mimeType: 'image/png',
        },
      });
      await callback(f, 'edit');
      expect(edit.mock.calls.at(-1)?.[2]).toBe('  **Цена** 300 ₽\n\n');
      expect(send).not.toHaveBeenCalled();
      const sent = await input(f, '  Цена 350 ₽\n\n');
      expect(edit.mock.calls.at(-1)?.[2]).toContain(
        '[Анна](https://max.ru/anna)\n\n  **Цена** 350 ₽\n\n',
      );
      const saved = await callback(f, 'save');
      await service.process(saved);
      await service.process(sent);
      const detail = await review.get(f.row.id, profile, {
        userId: '101',
        username: null,
        displayName: null,
      });
      expect(detail).toMatchObject({
        revision: 1,
        status: 'pending',
        text: '  **Цена** 350 ₽\n\n',
        author: { userId: '42', url: 'https://max.ru/anna' },
      });
      expect(await db.channelSuggestionImageAsset.findUnique({ where: { id: media.id } })).toEqual(
        media,
      );
      expect(edit.mock.calls.every((call) => call[3]?.requireAllAttachmentsPreserved)).toBe(true);
    },
  );
  it.each(['paid', 'details', 'topic', 'rules'] as const)(
    'rejects with %s in two clicks and delivers the reply only once',
    async (reason) => {
      const f = await seed('publisher');
      await db.suggestionReviewContact.create({
        data: { channelId: f.row.chatId, actorId: '101', url: 'https://max.ru/editor' },
      });
      await callback(f, 'reject');
      const job = await callback(f, reason);
      await service.process(job);
      const effect = await db.suggestionReviewEffect.findFirstOrThrow({
        where: { suggestionId: f.row.id, kind: 'notify' },
      });
      await effects.process(effect.id, f.profile, f.botId);
      await effects.process(effect.id, f.profile, f.botId);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]?.[3]?.botId).toBe('publisher');
      if (reason === 'paid')
        expect(send.mock.calls[0]?.[1]).toContain('Размещение такого объявления платное');
    },
  );
  it('sets a channel contact once in the bot and requires the save-and-send action', async () => {
    const f = await seed();
    await callback(f, 'reject');
    await callback(f, 'paid');
    await input(f, 'https://max.ru/editor');
    expect(
      await db.suggestionReviewEffect.count({ where: { suggestionId: f.row.id, kind: 'notify' } }),
    ).toBe(0);
    await callback(f, 'confirm_contact');
    expect(
      await db.suggestionReviewContact.findUnique({ where: { channelId: f.row.chatId } }),
    ).toMatchObject({ url: 'https://max.ru/editor' });
    expect(
      await db.suggestionReviewEffect.count({ where: { suggestionId: f.row.id, kind: 'notify' } }),
    ).toBe(1);
  });
  it('rejects silently without manufacturing a notification', async () => {
    const f = await seed();
    await callback(f, 'reject');
    await callback(f, 'silent');
    expect(
      await db.suggestionReviewEffect.count({ where: { suggestionId: f.row.id, kind: 'notify' } }),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it('routes only the exact private reply/edit and preserves unrelated flows', async () => {
    const f = await seed('publisher');
    await callback(f, 'edit');
    const update: MaxUpdate = {
      botId: 'publisher',
      updateId: randomUUID(),
      type: 'message_created',
      message: {
        messageId: 'input-1',
        chatId: '101',
        senderId: '101',
        text: 'Цена 500 ₽',
        createdAt: new Date().toISOString(),
      },
      raw: {
        update_type: 'message_created',
        timestamp: Date.now(),
        message: {
          body: { mid: 'input-1', text: 'Цена 500 ₽' },
          link: { type: 'reply', message: { mid: f.card.remoteMessageId } },
        },
      },
    };
    expect(
      await ingress.observeWebhook({
        ...update,
        raw: { ...update.raw, message: { body: { text: 'another flow' } } },
      }),
    ).toBe(false);
    expect(
      await ingress.observeWebhook({ ...update, message: { ...update.message!, senderId: '102' } }),
    ).toBe(false);
    expect(await ingress.observeWebhook(update)).toBe(true);
    expect(await ingress.observeWebhook(update)).toBe(true);
    expect(
      (await publisher.getJobs(['wait', 'prioritized'])).filter(
        (job) => job.data.kind === 'suggestion-native',
      ),
    ).toHaveLength(1);
    const worker = new Worker<SuggestionNativeJob>(publisher.name, async () => undefined, {
      connection: publisher.opts.connection,
      autorun: false,
    });
    try {
      const job = (await worker.getNextJob('native-test'))!;
      await service.process(job.data);
      await job.moveToCompleted(undefined, 'native-test', false);
      expect(
        await db.suggestionReviewDialog.findUnique({ where: { deliveryId: f.card.id } }),
      ).toMatchObject({ mode: 'preview', inputMessageId: 'input-1' });
    } finally {
      await worker.close();
    }
    expect(await major.getWaitingCount()).toBe(0);
  });
  it.each(['moderation', 'publisher'] as const)(
    'handles old %s rejection buttons without opening the mini app',
    async (profile) => {
      const f = await seed(profile);
      const update = {
        botId: f.botId,
        updateId: randomUUID(),
        type: 'message_callback',
        message: {
          messageId: f.card.remoteMessageId!,
          chatId: '101',
          senderId: '101',
          text: '',
          createdAt: new Date().toISOString(),
        },
        raw: {
          timestamp: Date.now(),
          callback: {
            callback_id: randomUUID(),
            user: { user_id: '101' },
            payload:
              profile === 'publisher'
                ? `psa:v1:cancel:${f.row.id}`
                : `pc2|suggestion_review_cancel|${f.row.id}`,
          },
        },
      } satisfies MaxUpdate;
      expect(
        await ingress.observeWebhook({
          ...update,
          raw: { ...update.raw, callback: { ...(update.raw.callback as object), user: {} } },
        }),
      ).toBe(true);
      const queue = profile === 'publisher' ? publisher : major;
      expect(await queue.getJobs(['wait', 'prioritized'])).toHaveLength(0);
      expect(await ingress.observeWebhook(update)).toBe(true);
      const [job] = await queue.getJobs(['wait', 'prioritized']);
      await service.process(job!.data);
      expect(
        await db.suggestionReviewDialog.findUnique({ where: { deliveryId: f.card.id } }),
      ).toMatchObject({ mode: 'reject' });
      expect(
        edit.mock.calls
          .at(-1)?.[3]
          ?.buttons?.flat()
          .every((button) => button.type === 'callback'),
      ).toBe(true);
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('updates the existing preview after an edit but ignores an older or cancelled input', async () => {
    const f = await seed();
    await callback(f, 'edit');
    const sent = await input(f, 'Цена 400 ₽');
    await input(f, 'Цена 450 ₽', {
      messageId: sent.messageId,
      edited: true,
      requestedAt: new Date(Date.parse(sent.requestedAt) + 1).toISOString(),
    });
    await service.process(sent);
    expect(edit.mock.calls.at(-1)?.[2]).toContain('450');
    await callback(f, 'back');
    await callback(f, 'edit');
    await service.process({ ...sent, eventId: randomUUID() });
    expect(
      await db.suggestionReviewDialog.findUnique({ where: { deliveryId: f.card.id } }),
    ).toMatchObject({ mode: 'edit', inputMessageId: null });
  });
  it('does not overwrite a concurrently changed suggestion or publish an unaccepted format', async () => {
    const f = await seed();
    await callback(f, 'edit');
    await input(f, 'Новый текст');
    const publish = jest.spyOn(review, 'publish');
    await callback(f, 'publish');
    expect(publish).not.toHaveBeenCalled();
    await review.save(
      f.row.id,
      f.profile,
      { userId: '102', username: null, displayName: null },
      { requestId: randomUUID(), expectedRevision: 0, text: 'Другой администратор' },
    );
    await callback(f, 'save', {
      callback: { action: 'save', id: f.row.id, revision: 0, version: 2 },
    });
    expect(
      (await review.get(f.row.id, f.profile, { userId: '101', username: null, displayName: null }))
        .text,
    ).toBe('Другой администратор');
  });
  it('cannot edit another card or continue after access is removed', async () => {
    const f = await seed();
    await callback(f, 'edit', { actorId: '102' });
    expect(edit).not.toHaveBeenCalled();
    authorize.mockRejectedValue(new ForbiddenException('Access removed'));
    await callback(f, 'edit').catch(() => undefined);
    expect(edit).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'publishes the exact %s edited preview through the real Publisher claim',
    async (edited) => {
      const f = await seed('publisher');
      const claimant = Object.assign(Object.create(PublisherSuggestionService.prototype), {
        prisma: db,
      }) as {
        claimPending: (
          id: string,
          chatId: string,
          actor: object,
          action: 'publish',
          source: AuditLog,
          editor: object,
        ) => Promise<unknown>;
      };
      const dispatch = jest.fn(async (_chat, id, actor, body) => {
        const source = await db.auditLog.findUniqueOrThrow({ where: { id } });
        await claimant.claimPending(id, source.chatId, actor, 'publish', source, body.editor);
      });
      Object.assign(review, { publisher: { review: dispatch } });
      if (edited) {
        await callback(f, 'edit');
        await input(f, '  Цена 900 ₽\n\n');
      }
      const job = await callback(f, 'publish');
      await service.process(job);
      expect(dispatch).toHaveBeenCalledTimes(1);
      const stored = await db.auditLog.findUniqueOrThrow({ where: { id: f.row.id } });
      expect(stored.payload).toMatchObject({
        reviewStatus: 'publishing',
        reviewPublicationText: `От подписчика [Анна](https://max.ru/anna)\n\n  **Цена** ${edited ? '900' : '300'} ₽\n\n`,
      });
    },
  );
  it('keeps a formatting warning on repeated plain replies and rejects expired drafts', async () => {
    const f = await seed();
    await callback(f, 'edit');
    await input(f, 'Новый текст');
    await input(f, 'Новый текст', { requestedAt: new Date(Date.now() + 1).toISOString() });
    expect(
      await db.suggestionReviewDialog.findUnique({ where: { deliveryId: f.card.id } }),
    ).toMatchObject({ mode: 'format' });
    await callback(f, 'accept_format');
    await db.suggestionReviewDialog.update({
      where: { deliveryId: f.card.id },
      data: { expiresAt: new Date(0) },
    });
    const publish = jest.spyOn(review, 'publish');
    await callback(f, 'publish');
    expect(publish).not.toHaveBeenCalled();
    expect(
      await db.suggestionReviewDialog.findUnique({ where: { deliveryId: f.card.id } }),
    ).toMatchObject({ mode: 'idle', draft: null });
  });
  it('rejects old input and stale buttons without discarding the current preview', async () => {
    const f = await seed();
    const opening = await callback(f, 'edit');
    await input(f, 'Цена 1 ₽', {
      requestedAt: new Date(Date.parse(opening.requestedAt) - 1).toISOString(),
    });
    expect(
      await db.suggestionReviewDialog.findUnique({ where: { deliveryId: f.card.id } }),
    ).toMatchObject({ mode: 'edit' });
    await input(f, '  Цена 700 ₽\n\n');
    await callback(f, 'back', {
      callback: { action: 'back', id: f.row.id, revision: 0, version: 1 },
    });
    expect(
      await db.suggestionReviewDialog.findUnique({ where: { deliveryId: f.card.id } }),
    ).toMatchObject({ mode: 'preview' });
  });
  it('serializes simultaneous choices and does not overwrite a personal editor during sync', async () => {
    const f = await seed();
    await callback(f, 'reject');
    await Promise.all([callback(f, 'details'), callback(f, 'rules')]);
    expect(
      await db.suggestionReviewEffect.count({ where: { suggestionId: f.row.id, kind: 'notify' } }),
    ).toBe(1);
    const other = await seed();
    await effects.upgradeNativeCards('moderation');
    const sync = await db.suggestionReviewEffect.findFirstOrThrow({
      where: { suggestionId: other.row.id, kind: 'native-sync' },
    });
    edit.mockImplementationOnce(async (_chat, _id, _text, options) => {
      await db.suggestionReviewDialog.create({
        data: {
          deliveryId: other.card.id,
          botId: other.botId,
          actorId: '101',
          privateChatId: '101',
          cardMessageId: other.card.remoteMessageId!,
          profile: other.profile,
          mode: 'edit',
          revision: 0,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      await options?.beforeEditMutation?.();
      throw new Error('Sync must not reach PUT');
    });
    await effects.process(sync.id, 'moderation');
    expect(await db.suggestionReviewEffect.findUnique({ where: { id: sync.id } })).toMatchObject({
      status: 'PENDING',
    });
    expect(
      await db.suggestionReviewDialog.findUnique({ where: { deliveryId: other.card.id } }),
    ).toMatchObject({ mode: 'edit' });
  });
  it('rechecks current MAX access at the final card mutation', async () => {
    const f = await seed();
    jest
      .spyOn(effects, 'assertDispatchAccess')
      .mockResolvedValueOnce()
      .mockRejectedValue(new ForbiddenException('Access removed'));
    let dispatched = false;
    edit.mockImplementation(async (_chat, _id, _text, options) => {
      await options?.beforeEditMutation?.();
      dispatched = true;
      return true;
    });
    await callback(f, 'edit');
    expect(dispatched).toBe(false);
  });
  it('upgrades old pending card buttons in bounded pages without new messages or reviving terminal work', async () => {
    const f = await seed();
    messages.set(f.card.remoteMessageId!, {
      body: {
        text: 'Старая карточка',
        attachments: [
          { type: 'image', payload: { token: 'original-photo' } },
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [
                  {
                    type: 'callback',
                    text: 'Опубликовать',
                    payload: `pc2|suggestion_review_publish|${f.row.id}`,
                  },
                ],
              ],
            },
          },
        ],
      },
    });
    const terminal = await seed();
    await db.auditLog.update({
      where: { id: terminal.row.id },
      data: { payload: { type: 'suggest', reviewStatus: 'cancelled' } },
    });
    await db.channelSuggestionAdminDelivery.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({
        id: `a-history-${String(i).padStart(6, '0')}`,
        auditLogId: terminal.row.id,
        adminUserId: `history-${i}`,
        botKey: 'major',
        botId: 'major',
        status: 'FAILED' as const,
      })),
    });
    const pages = jest.spyOn(db.channelSuggestionAdminDelivery, 'findMany');
    for (let i = 0; i < 82; i++) await effects.upgradeNativeCards('moderation');
    expect(pages.mock.calls).toHaveLength(81);
    for (const [args] of pages.mock.calls)
      expect(args).toMatchObject({
        take: 25,
        orderBy: { id: 'asc' },
        where: { id: { gt: expect.any(String) } },
      });
    pages.mockRestore();
    const rows = await db.suggestionReviewEffect.findMany({
      where: { kind: 'native-sync', suggestionId: { in: [f.row.id, terminal.row.id] } },
    });
    expect(rows).toHaveLength(1);
    await effects.process(rows[0]!.id, 'moderation');
    expect(
      await db.suggestionReviewEffect.findUnique({ where: { id: rows[0]!.id } }),
    ).toMatchObject({ status: 'SENT' });
    for (const button of edit.mock.calls.at(-1)?.[3]?.buttons?.flat() ?? []) {
      expect(button.type).toBe('callback');
      if (button.type === 'callback')
        expect(parseSuggestionNativeCallback(button.payload)).toMatchObject({
          id: f.row.id,
          revision: 0,
        });
    }
    expect(send).not.toHaveBeenCalled();
  });
});
