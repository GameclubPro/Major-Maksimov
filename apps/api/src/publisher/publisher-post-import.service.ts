import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  publisherPostImportCreateRequestSchema,
  publisherPostImportFailureCodeSchema,
  publisherPostImportOmissionSchema,
  publisherPostImportWarningSchema,
  type PublisherPostImportCurrentResponse,
  type PublisherPostImportOmission,
  type PublisherPostImportSession,
} from '@maxim/contracts/publisher';
import type { MaxUpdate } from '@maxim/contracts';
import { randomBytes, randomUUID } from 'node:crypto';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  PublicationLifecycle,
  PublisherPostImportStatus,
  PublisherPrivateFlowType,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import {
  PUBLISHER_POST_IMPORT_COLLECTION_LIMIT,
  PUBLISHER_POST_IMPORT_COLLECT_PREFIX,
  PUBLISHER_POST_IMPORT_FINISH_PREFIX,
  readPublisherPostImportInputMessages,
  type PublisherPostImportInputMessage,
} from './publisher-post-import-input';
import { PublisherPostImportQueueService } from './publisher-post-import.queue';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';
import {
  readPublisherPrivateCallback,
  readPublisherPrivateStartPayload,
} from './publisher-private-flow-update-reader';

const POST_IMPORT_WAITING_TTL_MS = 10 * 60_000;
const POST_IMPORT_PROCESSING_TTL_MS = 15 * 60_000;
const POST_IMPORT_RESULT_TTL_MS = 24 * 60 * 60_000;
const POST_IMPORT_SECOND_FORWARD_GUARD_MS = 60_000;
const POST_IMPORT_START_PREFIX = 'pi_';
const POST_IMPORT_CANCEL_PREFIX = 'pi_cancel_';

type SessionRow = {
  id: string;
  publisherBotId: string;
  actorUserId: string;
  requestId: string;
  startToken: string;
  status: PublisherPostImportStatus;
  privateChatId: string | null;
  incomingMessageId: string | null;
  publicationId: string | null;
  failureCode: string | null;
  omissions: unknown;
  expiresAt: Date;
  captureGuardUntil?: Date | null;
  inputMode?: string;
  inputOpenedAt?: Date | null;
  inputMessages?: unknown;
  warnings?: unknown;
};

export type PublisherPostImportAsset = {
  bytes: Buffer;
  mimeType: string;
};

@Injectable()
export class PublisherPostImportService {
  private readonly logger = new Logger(PublisherPostImportService.name);
  private readonly publisherBotId: string;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherPostImportQueueService,
    configService: ConfigService,
    @Optional() private readonly privateFlows?: PublisherPrivateFlowLeaseService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    this.enabled = configService.get<boolean>('PUBLISHER_POST_IMPORT_ENABLED', false);
  }

  async create(
    user: AuthUser,
    body: unknown,
    withDetails = false,
  ): Promise<PublisherPostImportSession> {
    if (!this.enabled) {
      throw new ServiceUnavailableException({
        code: 'PUBLISHER_POST_IMPORT_DISABLED',
        message: 'Пересылка постов временно недоступна.',
      });
    }
    const parsed = publisherPostImportCreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const actorUserId = user.userId.trim();
    const now = new Date();
    await this.expireWaitingSessions(actorUserId, now);

    const replay = await this.prisma.publisherPostImportSession.findUnique({
      where: {
        publisherBotId_actorUserId_requestId: {
          publisherBotId: this.publisherBotId,
          actorUserId,
          requestId: parsed.data.requestId,
        },
      },
    });
    if (replay) {
      await this.ensurePrivateFlow(replay);
      return this.present(replay, withDetails);
    }

    const active = await this.findActiveSession(actorUserId);
    if (active) {
      await this.ensurePrivateFlow(active);
      return this.present(active, withDetails);
    }

    try {
      const created = await this.createSessionWithPrivateFlow({
        actorUserId,
        requestId: parsed.data.requestId,
        inputMode: parsed.data.inputMode,
        expiresAt: new Date(now.getTime() + POST_IMPORT_WAITING_TTL_MS),
      });
      return this.present(created, withDetails);
    } catch (error: unknown) {
      const exactReplay = await this.prisma.publisherPostImportSession.findUnique({
        where: {
          publisherBotId_actorUserId_requestId: {
            publisherBotId: this.publisherBotId,
            actorUserId,
            requestId: parsed.data.requestId,
          },
        },
      });
      if (exactReplay) {
        await this.ensurePrivateFlow(exactReplay);
        return this.present(exactReplay, withDetails);
      }
      if (!this.isUniqueConflict(error)) throw error;
      const concurrent = await this.findActiveSession(actorUserId);
      if (!concurrent) {
        throw error;
      }
      await this.ensurePrivateFlow(concurrent);
      return this.present(concurrent, withDetails);
    }
  }

  async getCurrent(
    user: AuthUser,
    withDetails = false,
  ): Promise<PublisherPostImportCurrentResponse> {
    const actorUserId = user.userId.trim();
    const now = new Date();
    await this.expireWaitingSessions(actorUserId, now);
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        expiresAt: { gt: now },
        OR: [
          {
            status: {
              in: [
                PublisherPostImportStatus.WAITING,
                PublisherPostImportStatus.PROCESSING,
                PublisherPostImportStatus.FAILED,
                PublisherPostImportStatus.EXPIRED,
              ],
            },
          },
          {
            status: PublisherPostImportStatus.READY,
            publication: { is: { lifecycle: PublicationLifecycle.DRAFT } },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { session: session ? this.present(session, withDetails) : null };
  }

  async getByToken(
    user: AuthUser,
    startToken: string,
    withDetails = false,
  ): Promise<PublisherPostImportCurrentResponse> {
    const normalizedToken = startToken.trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/u.test(normalizedToken)) {
      return { session: null };
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        startToken: normalizedToken,
        publisherBotId: this.publisherBotId,
        actorUserId: user.userId.trim(),
        expiresAt: { gt: new Date() },
        ...(withDetails
          ? {
              OR: [
                {
                  status: {
                    in: [PublisherPostImportStatus.FAILED, PublisherPostImportStatus.EXPIRED],
                  },
                },
                {
                  status: PublisherPostImportStatus.READY,
                  publication: { is: { lifecycle: PublicationLifecycle.DRAFT } },
                },
              ],
            }
          : {
              status: PublisherPostImportStatus.READY,
              publication: { is: { lifecycle: PublicationLifecycle.DRAFT } },
            }),
      },
    });
    return { session: session ? this.present(session, withDetails) : null };
  }

  async cancel(user: AuthUser, withDetails = false): Promise<PublisherPostImportSession> {
    const actorUserId = user.userId.trim();
    const active = await this.findActiveSession(actorUserId);
    if (!active) {
      throw new NotFoundException('Активный импорт не найден.');
    }
    const now = new Date();
    const updated = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: active.id,
        actorUserId,
        publisherBotId: this.publisherBotId,
        status: { in: [PublisherPostImportStatus.WAITING, PublisherPostImportStatus.PROCESSING] },
      },
      data: {
        status: PublisherPostImportStatus.CANCELED,
        lockedAt: null,
        lockToken: null,
        notificationKind: 'canceled',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        expiresAt: new Date(now.getTime() + POST_IMPORT_RESULT_TTL_MS),
      },
    });
    const current = await this.prisma.publisherPostImportSession.findUnique({
      where: { id: active.id },
    });
    if (!current) {
      throw new NotFoundException('Активный импорт не найден.');
    }
    if (updated.count === 1) {
      await this.releasePrivateFlow(current);
      await this.enqueueNotificationSafe({
        sessionId: current.id,
        notification: 'canceled',
        privateChatId: current.privateChatId,
        dedupeKey: `api-${current.updatedAt.getTime()}`,
      });
    }
    return this.present(current, withDetails);
  }

  async getImageAsset(
    sessionId: string,
    assetId: string,
    user: AuthUser,
  ): Promise<PublisherPostImportAsset> {
    const asset = await this.prisma.publicationAsset.findFirst({
      where: {
        id: assetId,
        actorUserId: user.userId,
        mimeType: { startsWith: 'image/' },
        bytes: { not: null },
        contentLinks: {
          some: {
            contentRevision: {
              publication: {
                is: {
                  actorUserId: user.userId,
                  postImportSession: {
                    is: {
                      id: sessionId,
                      publisherBotId: this.publisherBotId,
                      status: PublisherPostImportStatus.READY,
                    },
                  },
                },
              },
            },
          },
        },
      },
      select: { bytes: true, mimeType: true },
    });
    if (!asset?.bytes || !asset.mimeType.toLowerCase().startsWith('image/')) {
      throw new NotFoundException('Фото не найдено.');
    }
    return { bytes: Buffer.from(asset.bytes), mimeType: asset.mimeType };
  }

  async observeWebhook(
    update: MaxUpdate,
    webhookEventId?: string | null,
    options: { duplicate?: boolean } = {},
  ): Promise<boolean> {
    if (update.botId?.trim() !== this.publisherBotId) {
      return false;
    }

    const callback = readPublisherPrivateCallback(update);
    if (callback?.payload.startsWith(POST_IMPORT_CANCEL_PREFIX)) {
      await this.handleCancelCallback(update, callback);
      return true;
    }
    if (
      callback?.payload.startsWith(PUBLISHER_POST_IMPORT_COLLECT_PREFIX) ||
      callback?.payload.startsWith(PUBLISHER_POST_IMPORT_FINISH_PREFIX)
    ) {
      await this.handleCollectionCallback(callback);
      return true;
    }

    const startToken = this.extractImportStartToken(update);
    if (startToken !== null) {
      await this.handleImportStart(update, startToken);
      return true;
    }

    if (update.type.trim().toLowerCase() !== 'message_created') {
      return false;
    }
    const privateMessage = this.extractPrivateMessageIdentity(update);
    if (!privateMessage) {
      return false;
    }
    const now = new Date();
    await this.expireWaitingSessions(privateMessage.actorUserId, now);
    const forward = this.extractForwardedMessage(update);
    const hasDirectContent = this.hasDirectImportContent(update);
    if (forward || hasDirectContent) {
      const priorCapture = await this.prisma.publisherPostImportSession.findUnique({
        where: {
          publisherBotId_incomingMessageId: {
            publisherBotId: this.publisherBotId,
            incomingMessageId: privateMessage.incomingMessageId,
          },
        },
      });
      if (
        priorCapture?.actorUserId === privateMessage.actorUserId &&
        priorCapture.privateChatId === privateMessage.privateChatId
      ) {
        if (priorCapture.status === PublisherPostImportStatus.PROCESSING) {
          await this.enqueueProcessSafe(priorCapture.id);
        }
        return true;
      }
    }
    const activeFlow = await this.privateFlows?.read(
      this.publisherBotId,
      privateMessage.actorUserId,
    );
    if (activeFlow && activeFlow.flowType !== PublisherPrivateFlowType.POST_IMPORT) {
      return false;
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId: privateMessage.actorUserId,
        OR: [
          {
            status: {
              in: [PublisherPostImportStatus.WAITING, PublisherPostImportStatus.PROCESSING],
            },
          },
          { captureGuardUntil: { gt: now } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!session) {
      return false;
    }
    const mode = session.inputMode ?? 'forward';
    if (mode !== 'forward') {
      // FLAG: New imports accept input only after the exact owner's private bot handoff.
      // Never absorb a delayed message from before that handoff or from a different dialog.
      if (!session.inputOpenedAt || session.privateChatId !== privateMessage.privateChatId) {
        return false;
      }
      if (this.isPrivateCommand(update)) {
        return false;
      }
      const sentAt = Date.parse(update.message?.createdAt ?? '');
      if (!Number.isFinite(sentAt) || sentAt < session.inputOpenedAt.getTime() - 1_000) {
        return true;
      }
    }
    if (session.status !== PublisherPostImportStatus.WAITING && !forward) {
      return (
        mode !== 'forward' &&
        session.status === PublisherPostImportStatus.PROCESSING &&
        hasDirectContent
      );
    }
    if (options.duplicate) {
      return true;
    }
    if (session.status !== PublisherPostImportStatus.WAITING) {
      return true;
    }

    await this.ensurePrivateFlow(session);
    const hasContent = Boolean(forward) || (mode !== 'forward' && hasDirectContent);
    if (!hasContent && mode !== 'forward') {
      return true;
    }
    if (mode === 'collection') {
      await this.appendCollectionMessage(session.id, privateMessage, {
        messageId: privateMessage.incomingMessageId,
        webhookEventId: webhookEventId?.trim() || null,
      });
      return true;
    }
    if (!hasContent) {
      await this.prisma.publisherPostImportSession.updateMany({
        where: { id: session.id, status: PublisherPostImportStatus.WAITING },
        data: {
          notificationKind: 'need_forward',
          notificationPending: true,
          notificationLockedAt: null,
          notificationLockToken: null,
          notificationDispatchStartedAt: null,
        },
      });
      await this.enqueueNotificationSafe({
        sessionId: session.id,
        notification: 'need_forward',
        privateChatId: privateMessage.privateChatId,
        dedupeKey: `need-${Math.floor(now.getTime() / 5_000)}`,
      });
      return true;
    }

    try {
      const captured = await this.prisma.publisherPostImportSession.updateMany({
        where: {
          id: session.id,
          publisherBotId: this.publisherBotId,
          actorUserId: privateMessage.actorUserId,
          status: PublisherPostImportStatus.WAITING,
          incomingMessageId: null,
          ...(session.inputMode ? { inputMode: mode } : {}),
          expiresAt: { gt: now },
        },
        data: {
          status: PublisherPostImportStatus.PROCESSING,
          privateChatId: privateMessage.privateChatId,
          incomingMessageId: privateMessage.incomingMessageId,
          sourceWebhookEventId: webhookEventId?.trim() || null,
          capturedAt: now,
          captureGuardUntil: new Date(now.getTime() + POST_IMPORT_SECOND_FORWARD_GUARD_MS),
          expiresAt: new Date(now.getTime() + POST_IMPORT_PROCESSING_TTL_MS),
          failureCode: null,
          omissions: [],
          notificationKind: 'processing',
          notificationPending: true,
          notificationLockedAt: null,
          notificationLockToken: null,
          notificationDispatchStartedAt: null,
        },
      });
      if (captured.count === 0) {
        return true;
      }
    } catch (error: unknown) {
      if (!this.isUniqueConflict(error)) {
        throw error;
      }
      return true;
    }

    await Promise.all([
      this.enqueueNotificationSafe({
        sessionId: session.id,
        notification: 'processing',
        privateChatId: privateMessage.privateChatId,
        dedupeKey: privateMessage.incomingMessageId,
      }),
      this.enqueueProcessSafe(session.id),
    ]);
    await this.releasePrivateFlow(session);
    return true;
  }

  private async handleCollectionCallback(callback: {
    payload: string;
    actorUserId: string | null;
  }): Promise<void> {
    const isFinish = callback.payload.startsWith(PUBLISHER_POST_IMPORT_FINISH_PREFIX);
    const prefix = isFinish
      ? PUBLISHER_POST_IMPORT_FINISH_PREFIX
      : PUBLISHER_POST_IMPORT_COLLECT_PREFIX;
    const startToken = callback.payload.slice(prefix.length);
    if (!callback.actorUserId || !/^[A-Za-z0-9_-]{8,64}$/u.test(startToken)) return;
    const now = new Date();
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        startToken,
        publisherBotId: this.publisherBotId,
        actorUserId: callback.actorUserId,
        status: PublisherPostImportStatus.WAITING,
        expiresAt: { gt: now },
        inputMode: isFinish ? 'collection' : 'message',
        inputOpenedAt: { not: null },
        privateChatId: { not: null },
      },
    });
    if (!session?.privateChatId || !session.inputOpenedAt) return;
    await this.ensurePrivateFlow(session);
    const notification = isFinish ? 'processing' : 'collecting';
    const changed = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: session.id,
        status: PublisherPostImportStatus.WAITING,
        expiresAt: { gt: now },
        inputMode: isFinish ? 'collection' : 'message',
        ...(isFinish ? { incomingMessageId: { not: null } } : { incomingMessageId: null }),
      },
      data: {
        ...(isFinish
          ? {
              status: PublisherPostImportStatus.PROCESSING,
              notificationLockedAt: null,
              notificationLockToken: null,
              notificationDispatchStartedAt: null,
              capturedAt: now,
              captureGuardUntil: new Date(now.getTime() + POST_IMPORT_SECOND_FORWARD_GUARD_MS),
              expiresAt: new Date(now.getTime() + POST_IMPORT_PROCESSING_TTL_MS),
            }
          : { inputMode: 'collection', inputOpenedAt: now }),
        notificationKind: notification,
        notificationPending: true,
      },
    });
    if (changed.count !== 1) return;
    await Promise.all([
      this.enqueueNotificationSafe({
        sessionId: session.id,
        notification,
        privateChatId: session.privateChatId,
        dedupeKey: 'collection-transition',
      }),
      ...(isFinish ? [this.enqueueProcessSafe(session.id)] : []),
    ]);
    if (isFinish) await this.releasePrivateFlow(session);
  }

  private async appendCollectionMessage(
    sessionId: string,
    identity: { actorUserId: string; privateChatId: string },
    entry: PublisherPostImportInputMessage,
  ): Promise<void> {
    // FLAG: Commit the bounded list with a compare-and-set, including the WAITING status.
    // Finish and cancel can win a race without admitting another message into their snapshot.
    const where = {
      id: sessionId,
      publisherBotId: this.publisherBotId,
      actorUserId: identity.actorUserId,
      privateChatId: identity.privateChatId,
      inputMode: 'collection',
      status: PublisherPostImportStatus.WAITING,
      expiresAt: { gt: new Date() },
    };
    for (let attempt = 0; attempt < PUBLISHER_POST_IMPORT_COLLECTION_LIMIT; attempt++) {
      const session = await this.prisma.publisherPostImportSession.findFirst({ where });
      if (!session) return;
      const inputs = readPublisherPostImportInputMessages(session.inputMessages);
      if (
        inputs.length >= PUBLISHER_POST_IMPORT_COLLECTION_LIMIT ||
        inputs.some(({ messageId }) => messageId === entry.messageId)
      )
        return;
      const updated = await this.prisma.publisherPostImportSession.updateMany({
        where: { ...where, inputMessages: { equals: inputs } },
        data: {
          ...(inputs.length === 0
            ? {
                incomingMessageId: entry.messageId,
                sourceWebhookEventId: entry.webhookEventId,
              }
            : {}),
          inputMessages: [...inputs, entry],
          notificationKind: 'collected',
          notificationPending: true,
        },
      });
      if (updated.count === 1) {
        await this.enqueueNotificationSafe({
          sessionId,
          notification: 'collected',
          privateChatId: identity.privateChatId,
          dedupeKey: entry.messageId,
        });
        return;
      }
    }
    // Failure is visible to the authenticated webhook owner. A retry still uses the same message ID.
    throw new ServiceUnavailableException('Не удалось добавить сообщение в пост.');
  }

  private hasDirectImportContent(update: MaxUpdate): boolean {
    const message = this.extractRawMessage(update.raw);
    const body = this.asRecord(message?.body) ?? message;
    return Boolean(
      this.readString(body?.text) ||
      (Array.isArray(body?.attachments) && body.attachments.length > 0),
    );
  }

  private isPrivateCommand(update: MaxUpdate): boolean {
    const text = update.message?.text?.trim() ?? '';
    return (
      !this.extractForwardedMessage(update) &&
      (/^\/(?:start|vk)(?:\s|$)/iu.test(text) || /^старт$/iu.test(text))
    );
  }

  private async handleImportStart(update: MaxUpdate, startToken: string): Promise<void> {
    const identity = this.extractPrivateMessageIdentity(update);
    if (!identity) {
      return;
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: {
        startToken,
        publisherBotId: this.publisherBotId,
        actorUserId: identity.actorUserId,
        status: PublisherPostImportStatus.WAITING,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) {
      return;
    }
    await this.ensurePrivateFlow(session);
    if (session.privateChatId && session.privateChatId !== identity.privateChatId) return;
    const notification =
      session.inputMode === 'collection'
        ? readPublisherPostImportInputMessages(session.inputMessages).length > 0
          ? 'collected'
          : 'collecting'
        : 'prompt';
    const prepared = await this.prisma.publisherPostImportSession.updateMany({
      where: { id: session.id, status: PublisherPostImportStatus.WAITING },
      data: {
        privateChatId: identity.privateChatId,
        inputOpenedAt: session.inputOpenedAt ?? new Date(),
        notificationKind: notification,
        notificationPending: true,
      },
    });
    if (prepared.count === 0) return;
    await this.enqueueNotificationSafe({
      sessionId: session.id,
      notification,
      privateChatId: identity.privateChatId,
      dedupeKey: update.updateId,
    });
  }

  private async handleCancelCallback(
    update: MaxUpdate,
    callback: { payload: string; callbackId: string | null; actorUserId: string | null },
  ): Promise<void> {
    const startToken = callback.payload.slice(POST_IMPORT_CANCEL_PREFIX.length).trim();
    // FLAG: The source message author is not proof of who pressed its callback button.
    const actorUserId = callback.actorUserId;
    if (!startToken || !actorUserId) {
      return;
    }
    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: { startToken, publisherBotId: this.publisherBotId, actorUserId },
    });
    if (!session) {
      return;
    }
    const now = new Date();
    const canceled = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: session.id,
        publisherBotId: this.publisherBotId,
        actorUserId,
        status: PublisherPostImportStatus.WAITING,
      },
      data: {
        status: PublisherPostImportStatus.CANCELED,
        callbackId: callback.callbackId,
        notificationKind: 'canceled',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        expiresAt: new Date(now.getTime() + POST_IMPORT_RESULT_TTL_MS),
      },
    });
    if (canceled.count === 1) {
      await this.enqueueNotificationSafe({
        sessionId: session.id,
        notification: 'canceled',
        privateChatId: session.privateChatId ?? update.message?.chatId,
        callbackId: callback.callbackId,
        dedupeKey: callback.callbackId ?? update.updateId,
      });
      await this.releasePrivateFlow(session);
    }
  }

  private extractImportStartToken(update: MaxUpdate): string | null {
    const payload = readPublisherPrivateStartPayload(update);
    if (!payload?.startsWith(POST_IMPORT_START_PREFIX)) {
      return null;
    }
    return payload.slice(POST_IMPORT_START_PREFIX.length).trim();
  }

  private extractPrivateMessageIdentity(update: MaxUpdate): {
    actorUserId: string;
    privateChatId: string;
    incomingMessageId: string;
  } | null {
    const message = update.message;
    const actorUserId = message?.senderId?.trim() ?? '';
    const privateChatId = message?.chatId?.trim() ?? '';
    const incomingMessageId = message?.messageId?.trim() ?? '';
    if (
      !/^\d+$/u.test(actorUserId) ||
      !isPrivateDirectChatId(privateChatId) ||
      message?.entityType === 'channel' ||
      !incomingMessageId ||
      incomingMessageId.length > 512
    ) {
      return null;
    }
    const rawMessage = this.extractRawMessage(update.raw);
    const recipient = this.asRecord(rawMessage?.recipient);
    const chatType = this.readString(recipient?.chat_type ?? recipient?.chatType)?.toLowerCase();
    if (chatType && chatType !== 'dialog') {
      return null;
    }
    return { actorUserId, privateChatId, incomingMessageId };
  }

  private extractForwardedMessage(update: MaxUpdate): Record<string, unknown> | null {
    const message = this.extractRawMessage(update.raw);
    const link = this.asRecord(message?.link);
    if (this.readString(link?.type)?.toLowerCase() !== 'forward') {
      return null;
    }
    return this.asRecord(link?.message);
  }

  private extractRawMessage(rawValue: unknown): Record<string, unknown> | null {
    const raw = this.asRecord(rawValue);
    if (!raw) {
      return null;
    }
    const direct = this.asRecord(raw.message);
    if (direct) {
      return direct;
    }
    for (const key of ['message_created', 'data', 'event']) {
      const envelope = this.asRecord(raw[key]);
      const nested = this.asRecord(envelope?.message);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  private async expireWaitingSessions(actorUserId: string, now: Date): Promise<void> {
    await this.prisma.publisherPostImportSession.updateMany({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        status: PublisherPostImportStatus.WAITING,
        expiresAt: { lte: now },
      },
      data: {
        status: PublisherPostImportStatus.EXPIRED,
        notificationKind: null,
        notificationPending: false,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        expiresAt: new Date(now.getTime() + POST_IMPORT_RESULT_TTL_MS),
      },
    });
  }

  private findActiveSession(actorUserId: string) {
    return this.prisma.publisherPostImportSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        status: {
          in: [PublisherPostImportStatus.WAITING, PublisherPostImportStatus.PROCESSING],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  private async ensurePrivateFlow(session: SessionRow): Promise<void> {
    if (!this.privateFlows) return;
    if (session.status !== PublisherPostImportStatus.WAITING) {
      return;
    }
    const acquired = await this.privateFlows.acquire({
      publisherBotId: session.publisherBotId,
      actorUserId: session.actorUserId,
      flowType: PublisherPrivateFlowType.POST_IMPORT,
      flowId: session.id,
      leaseToken: session.id,
      expiresAt: session.expiresAt,
    });
    if (!acquired) {
      throw new ConflictException({
        code: 'PUBLISHER_PRIVATE_FLOW_CONFLICT',
        message: 'Сначала завершите текущую операцию в диалоге Публика.',
      });
    }
  }

  private async createSessionWithPrivateFlow(params: {
    actorUserId: string;
    requestId: string;
    inputMode?: 'forward' | 'message';
    expiresAt: Date;
  }) {
    const id = randomUUID();
    const data = {
      id,
      publisherBotId: this.publisherBotId,
      actorUserId: params.actorUserId,
      requestId: params.requestId,
      ...(params.inputMode ? { inputMode: params.inputMode } : {}),
      startToken: randomBytes(18).toString('base64url'),
      expiresAt: params.expiresAt,
    };
    const privateFlows = this.privateFlows;
    if (!privateFlows) {
      return this.prisma.publisherPostImportSession.create({ data });
    }
    return this.prisma.$transaction(async (tx) => {
      const lease = await privateFlows.acquire(
        {
          publisherBotId: this.publisherBotId,
          actorUserId: params.actorUserId,
          flowType: PublisherPrivateFlowType.POST_IMPORT,
          flowId: id,
          leaseToken: id,
          expiresAt: params.expiresAt,
        },
        tx,
      );
      if (!lease) {
        throw new ConflictException({
          code: 'PUBLISHER_PRIVATE_FLOW_CONFLICT',
          message: 'Сначала завершите текущую операцию в диалоге Публика.',
        });
      }
      return tx.publisherPostImportSession.create({ data });
    });
  }

  private async releasePrivateFlow(session: SessionRow): Promise<void> {
    await this.privateFlows?.release({
      publisherBotId: session.publisherBotId,
      actorUserId: session.actorUserId,
      flowType: PublisherPrivateFlowType.POST_IMPORT,
      flowId: session.id,
      leaseToken: session.id,
    });
  }

  private present(row: SessionRow, withDetails: boolean): PublisherPostImportSession {
    const status = row.status.toLowerCase() as PublisherPostImportSession['status'];
    const omissionParse = publisherPostImportOmissionSchema.array().safeParse(row.omissions);
    const omissions: PublisherPostImportOmission[] = omissionParse.success
      ? omissionParse.data
      : [];
    const legacyFailureCodes: Record<string, PublisherPostImportSession['failureCode']> = {
      empty_content: 'unsupported_content',
      media_invalid: 'media_download_failed',
      image_dimensions: 'image_too_large',
      draft_quota: 'internal_error',
    };
    const failureParse = publisherPostImportFailureCodeSchema.safeParse(
      (!withDetails && row.failureCode ? legacyFailureCodes[row.failureCode] : null) ??
        row.failureCode,
    );
    const warnings = withDetails
      ? publisherPostImportWarningSchema.array().max(128).safeParse(row.warnings)
      : null;
    const botUrl =
      row.status === PublisherPostImportStatus.WAITING
        ? `https://max.ru/${encodeURIComponent(this.publisherBotId)}?start=${encodeURIComponent(
            `${POST_IMPORT_START_PREFIX}${row.startToken}`,
          )}`
        : null;
    return {
      id: row.id,
      status,
      expiresAt: row.expiresAt.toISOString(),
      publicationId: row.publicationId,
      botUrl,
      failureCode:
        row.status === PublisherPostImportStatus.FAILED && failureParse.success
          ? failureParse.data
          : null,
      omissions,
      ...(withDetails && (row.inputMode === 'message' || row.inputMode === 'collection')
        ? { inputMode: row.inputMode }
        : {}),
      ...(withDetails && row.inputMode === 'collection'
        ? { collectedCount: readPublisherPostImportInputMessages(row.inputMessages).length }
        : {}),
      ...(warnings?.success && warnings.data.length > 0 ? { warnings: warnings.data } : {}),
    };
  }

  private async enqueueProcessSafe(sessionId: string): Promise<void> {
    try {
      await this.queue.enqueueProcess(sessionId);
    } catch (error: unknown) {
      this.logger.warn(
        { sessionId, err: error instanceof Error ? error.message : String(error) },
        'Publisher post import enqueue failed; bounded recovery will retry',
      );
    }
  }

  private async enqueueNotificationSafe(
    params: Parameters<PublisherPostImportQueueService['enqueueNotification']>[0],
  ): Promise<void> {
    try {
      await this.queue.enqueueNotification(params);
    } catch (error: unknown) {
      this.logger.warn(
        {
          sessionId: params.sessionId,
          notification: params.notification,
          err: error instanceof Error ? error.message : String(error),
        },
        'Publisher post import notification enqueue failed',
      );
    }
  }

  private isUniqueConflict(error: unknown): boolean {
    return (error as { code?: string }).code === 'P2002';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }
}

export const PUBLISHER_POST_IMPORT_RESULT_TTL_MS = POST_IMPORT_RESULT_TTL_MS;
export const PUBLISHER_POST_IMPORT_PROCESSING_TTL_MS = POST_IMPORT_PROCESSING_TTL_MS;
export const PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS = POST_IMPORT_SECOND_FORWARD_GUARD_MS;
export const PUBLISHER_POST_IMPORT_CANCEL_PAYLOAD_PREFIX = POST_IMPORT_CANCEL_PREFIX;
