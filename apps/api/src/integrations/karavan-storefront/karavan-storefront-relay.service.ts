import {
  KaravanMarketplaceResolverService,
  type KaravanScopedPublication,
} from '../karavan-marketplace/karavan-marketplace-resolver.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import {
  KARAVAN_STOREFRONT_TEXT_DEFAULTS,
  resolveKaravanStorefrontTexts,
  type KaravanStorefrontTexts,
} from '@maxim/contracts/karavan-storefront';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  wasMaxMessageSendAttempted,
  type MaxActionDispatchOptions,
  type MaxSendMessageOptions,
} from '../../max/max-client.service';
import { RedisCounterService } from '../../moderation/redis-counter.service';
import { KaravanStorefrontAuthorizationService } from './karavan-storefront-authorization.service';

export type RelayContext = {
  karavanStorefrontEnabled: boolean;
  /** When true, only chat admins or active allowlist entries may publish. */
  karavanStorefrontAdminsOnly?: boolean;
  storefrontTexts?: Partial<KaravanStorefrontTexts>;
  updateType: string | null;
  chatId: string;
  messageId: string | null | undefined;
  /** User who sent the current message/update. */
  senderId: string;
  /** Optional seller identity extracted from a validated forwarded message. */
  storefrontOwnerUserId?: string | null;
  senderName?: string | null;
  text?: string | null;
  raw?: unknown;
  botId?: string | null;
};

export type KaravanStorefrontRelayResult = 'handled' | 'noop' | 'duplicate' | 'disabled' | 'failed';

const lookupResponseSchema = z.object({
  exists: z.boolean(),
  store: z
    .object({
      id: z.string().min(1),
      slug: z.string().min(1),
      name: z.string().min(1),
      sellerAccountId: z.string().min(1),
      url: z.string().url(),
      inviteUrl: z.string().url(),
    })
    .nullable(),
});

type LookupResponse = z.infer<typeof lookupResponseSchema>;
type LookupStore = Omit<NonNullable<LookupResponse['store']>, 'sellerAccountId'> & {
  sellerAccountId: string | null;
};

type CacheEntry = {
  expiresAtMs: number;
  response: LookupResponse;
};

const DEFAULT_LOOKUP_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_TTL_SEC = 120;
const DEFAULT_RELAY_LOCK_TTL_SEC = 3_600;
const MIN_PROCESSING_LOCK_TTL_MS = 15_000;
const RELAY_LOCK_PREFIX = 'karavan-storefront-relay:v1';
export const KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION = 'KARAVAN_STOREFRONT_RELAY';
const KARAVAN_STOREFRONT_RELAY_ENQUEUE_FAILED_AUDIT_ACTION =
  'KARAVAN_STOREFRONT_RELAY_ENQUEUE_FAILED';
export const KARAVAN_STOREFRONT_BUTTON_MESSAGE_TEXT =
  KARAVAN_STOREFRONT_TEXT_DEFAULTS.karavanStorefrontMessageText;
export const KARAVAN_STOREFRONT_CATALOG_BUTTON_TEXT =
  KARAVAN_STOREFRONT_TEXT_DEFAULTS.karavanStorefrontCatalogButtonText;
export const KARAVAN_STOREFRONT_CREATE_BUTTON_TEXT =
  KARAVAN_STOREFRONT_TEXT_DEFAULTS.karavanStorefrontCreateButtonText;
export const KARAVAN_STOREFRONT_CATALOG_URL = 'https://max.ru/se13381675_1_bot?startapp=';
export const KARAVAN_STOREFRONT_CREATE_URL = 'https://max.ru/se13381675_bot?startapp=storefront';

type StorefrontRelayTrigger = 'prefixed' | 'bare';
type StorefrontRelayVariant = 'storefront' | 'directory';

export function isKaravanStorefrontRelayCompanionText(value: unknown): boolean {
  return value === KARAVAN_STOREFRONT_BUTTON_MESSAGE_TEXT;
}

@Injectable()
export class KaravanStorefrontRelayService {
  private readonly logger = new Logger(KaravanStorefrontRelayService.name);
  private readonly enabled: boolean;
  private readonly apiBaseUrl: string | null;
  private readonly integrationToken: string | null;
  private readonly lookupTimeoutMs: number;
  private readonly cacheTtlSec: number;
  private readonly relayLockTtlSec: number;
  private readonly catalogUrl: string;
  private readonly createUrl: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlightLookups = new Map<string, Promise<LookupResponse | null>>();

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly prisma: PrismaService,
    private readonly redisCounter: RedisCounterService,
    @Optional() private readonly configService?: ConfigService,
    @Optional()
    private readonly authorizationService?: KaravanStorefrontAuthorizationService,
    @Optional() private readonly marketplaceResolver?: KaravanMarketplaceResolverService,
  ) {
    this.enabled = this.readBooleanConfig('KARAVAN_STOREFRONT_RELAY_ENABLED', false);
    this.apiBaseUrl = this.normalizeBaseUrl(
      this.configService?.get<string>('KARAVAN_API_BASE_URL'),
    );
    this.integrationToken = this.normalizeToken(
      this.configService?.get<string>('KARAVAN_INTEGRATION_TOKEN'),
    );
    this.catalogUrl = this.readUrlConfig(
      'KARAVAN_STOREFRONT_CATALOG_URL',
      KARAVAN_STOREFRONT_CATALOG_URL,
    );
    this.createUrl = this.readUrlConfig(
      'KARAVAN_STOREFRONT_CREATE_URL',
      KARAVAN_STOREFRONT_CREATE_URL,
    );
    this.lookupTimeoutMs = this.readPositiveIntConfig(
      'KARAVAN_STOREFRONT_LOOKUP_TIMEOUT_MS',
      DEFAULT_LOOKUP_TIMEOUT_MS,
    );
    this.cacheTtlSec = this.readPositiveIntConfig(
      'KARAVAN_STOREFRONT_CACHE_TTL_SEC',
      DEFAULT_CACHE_TTL_SEC,
    );
    this.relayLockTtlSec = this.readPositiveIntConfig(
      'KARAVAN_STOREFRONT_RELAY_LOCK_TTL_SEC',
      DEFAULT_RELAY_LOCK_TTL_SEC,
    );
  }

  async handleMessageCreated(context: RelayContext): Promise<KaravanStorefrontRelayResult> {
    if (!context.karavanStorefrontEnabled) {
      return 'disabled';
    }

    if (!this.isConfigured()) {
      return this.enabled ? 'failed' : 'disabled';
    }

    if (!this.isEligibleContext(context)) {
      return 'noop';
    }

    const trigger = this.resolveStorefrontRelayTrigger(context);
    if (!trigger) {
      return 'noop';
    }

    if (
      context.karavanStorefrontAdminsOnly &&
      (!this.authorizationService ||
        !(await this.authorizationService.canPublish({
          chatId: context.chatId,
          actorUserId: context.senderId,
          adminsOnly: true,
        })))
    ) {
      return 'noop';
    }

    const lockKey = this.buildRelayLockKey(context.chatId, context.messageId!);
    const lockToken = await this.redisCounter.acquireLock(
      lockKey,
      this.resolveProcessingLockTtlMs(),
    );
    if (!lockToken) {
      return 'duplicate';
    }

    let keepClaim = false;
    let pendingAudit:
      | {
          id: string;
          payload: Prisma.InputJsonObject;
        }
      | undefined;
    try {
      // `$` is an explicit seller action, so each logical source message starts
      // from a fresh storefront lookup. Concurrent messages from the same seller
      // still share one in-flight request.
      const storefrontOwnerUserId = this.resolveStorefrontOwnerUserId(context);
      let scopedPublication: KaravanScopedPublication | null = null;
      let store: LookupStore | null | undefined;
      if (await this.marketplaceResolver?.shouldUseScopedRelay(context.chatId)) {
        if (!this.marketplaceResolver || !context.botId) return 'failed';
        const resolved = await this.marketplaceResolver.resolve({
          chatId: context.chatId,
          actorMaxUserId: context.senderId,
          subjectMaxUserId: storefrontOwnerUserId,
          sourceMessageId: context.messageId!,
          botId: context.botId,
        });
        scopedPublication = resolved.publication;
        if (!scopedPublication) return 'noop';
        const scopedStore =
          resolved.result.status === 'published' ? resolved.result.stores[0] : null;
        store = scopedStore ? { ...scopedStore, sellerAccountId: null } : null;
        if (!store && scopedPublication.format !== 'storefront' && trigger !== 'bare')
          return 'noop';
      } else {
        store = await this.lookupStorefront(storefrontOwnerUserId, { fresh: true });
        if (store === undefined) return 'failed';
        if (!store && trigger !== 'bare') return 'noop';
      }

      const idempotencyKey = this.buildRelayIdempotencyKey(context.chatId, context.messageId!);
      const variant: StorefrontRelayVariant =
        store || scopedPublication?.format === 'storefront' ? 'storefront' : 'directory';
      const texts = resolveKaravanStorefrontTexts(context.storefrontTexts);
      pendingAudit = await this.createPendingAuditLog({
        context,
        store,
        idempotencyKey,
        variant,
        scopedPublication,
      });
      await this.maxClient.sendMessage(
        context.chatId,
        texts.karavanStorefrontMessageText,
        scopedPublication
          ? {
              messageLink: { type: 'reply', mid: context.messageId! },
              buttons: [
                [
                  {
                    type: 'link',
                    text: store
                      ? texts.karavanStorefrontOpenButtonText
                      : texts.karavanStorefrontCatalogButtonText,
                    url: scopedPublication.url,
                  },
                ],
              ],
            }
          : store
            ? this.buildStorefrontMessageOptions(context.messageId!, store.url, texts)
            : this.buildDirectoryMessageOptions(context.messageId!, texts),
        this.buildDispatchOptions({ context, store, idempotencyKey, variant, scopedPublication }),
      );
      keepClaim = true;

      await this.renewCompletedClaim(lockKey, lockToken);
      await this.updateAuditDeliveryStatus(pendingAudit, 'queued');

      return 'handled';
    } catch (error) {
      const ambiguous = this.isAmbiguousDispatchAcceptance(error);
      if (ambiguous) {
        keepClaim = true;
        await this.renewCompletedClaim(lockKey, lockToken).catch(() => undefined);
      }
      if (pendingAudit) {
        await this.updateAuditDeliveryStatus(
          pendingAudit,
          ambiguous ? 'ambiguous' : 'enqueue_failed',
          ambiguous ? KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION : undefined,
        );
      }
      this.logger.warn(
        {
          chatId: context.chatId,
          messageId: context.messageId,
          senderId: context.senderId,
          err: this.formatError(error),
        },
        'Karavan storefront relay failed open before durable delivery was accepted',
      );
      return 'failed';
    } finally {
      if (!keepClaim) {
        await this.redisCounter.releaseLock(lockKey, lockToken).catch((error: unknown) => {
          this.logger.warn(
            {
              chatId: context.chatId,
              messageId: context.messageId,
              err: this.formatError(error),
            },
            'Failed to release an incomplete Karavan storefront relay claim',
          );
        });
      }
    }
  }

  isCompanionMessageCandidate(text: string, raw?: unknown): boolean {
    return (
      isKaravanStorefrontRelayCompanionText(text) || Boolean(this.extractReplySourceMessageId(raw))
    );
  }

  async recognizeCompanionMessage(params: {
    chatId: string;
    messageId: string;
    text: string;
    raw?: unknown;
  }): Promise<boolean> {
    if (!this.isCompanionMessageCandidate(params.text, params.raw)) {
      return false;
    }

    const existing = await this.prisma.auditLog.findFirst({
      where: {
        chatId: params.chatId,
        action: KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION,
        payload: {
          path: ['companionMessageId'],
          equals: params.messageId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return true;
    }

    const sourceMessageId = this.extractReplySourceMessageId(params.raw);
    if (!sourceMessageId) {
      return false;
    }

    const queuedAudit = await this.prisma.auditLog.findFirst({
      where: {
        chatId: params.chatId,
        action: KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION,
        payload: {
          path: ['sourceMessageId'],
          equals: sourceMessageId,
        },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, payload: true },
    });
    if (!queuedAudit) {
      return false;
    }

    const payload = this.asRecord(queuedAudit.payload) ?? {};
    // FLAG: A reply alone does not prove ownership. Match the immutable send-time text,
    // including legacy default copy, before protecting or promoting a companion.
    if (params.text !== (payload.messageText ?? KARAVAN_STOREFRONT_BUTTON_MESSAGE_TEXT)) {
      return false;
    }
    await this.prisma.auditLog
      .update({
        where: { id: queuedAudit.id },
        data: {
          payload: {
            ...payload,
            companionMessageId: params.messageId,
            deliveryStatus: 'sent',
            confirmedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            chatId: params.chatId,
            sourceMessageId,
            companionMessageId: params.messageId,
            err: this.formatError(error),
          },
          'Failed to promote queued Karavan storefront relay audit after delivery',
        );
      });

    return true;
  }

  private isConfigured(): boolean {
    return (
      this.enabled &&
      (this.readBooleanConfig('KARAVAN_MARKETPLACE_ENABLED', false)
        ? Boolean(this.marketplaceResolver)
        : Boolean(this.apiBaseUrl && this.integrationToken))
    );
  }

  private isEligibleContext(context: RelayContext): boolean {
    if (context.updateType !== 'message_created' && context.updateType !== 'message_edited') {
      return false;
    }
    if (!context.messageId?.trim()) {
      return false;
    }
    if (!context.senderId.trim()) {
      return false;
    }
    return !this.isPrivateDirectChat(context.chatId);
  }

  private resolveStorefrontRelayTrigger(context: RelayContext): StorefrontRelayTrigger | null {
    const visibleText = this.extractVisibleText(context);
    const normalized = visibleText?.trimStart();
    if (!normalized?.startsWith('$')) {
      return null;
    }

    return normalized.trim() === '$' ? 'bare' : 'prefixed';
  }

  // FLAG: Normalized text can include reply/quote previews; use it only without raw payload or after a validated forward.
  private extractVisibleText(context: RelayContext): string | null {
    const raw = this.asRecord(context.raw);
    const message = this.extractRawMessage(raw);
    if (!message) {
      return raw ? null : this.readString(context.text);
    }

    const directText = this.extractMessageText(message) ?? this.readString(raw?.text);
    if (directText) {
      return directText;
    }

    const link = this.asRecord(message.link);
    if (
      this.readLowerString(link?.type) !== 'forward' ||
      !this.isForwardFromContextSender(link, context.senderId, context.storefrontOwnerUserId)
    ) {
      return null;
    }

    return this.extractMessageText(this.asRecord(link?.message)) ?? this.readString(context.text);
  }

  private extractRawMessage(raw: Record<string, unknown> | null): Record<string, unknown> | null {
    const directMessage = this.asRecord(raw?.message);
    if (directMessage) {
      return directMessage;
    }

    const envelopeKeys = ['message_created', 'data', 'event'];
    for (const typeKey of [raw?.update_type, raw?.type]) {
      if (typeof typeKey === 'string' && typeKey.trim()) {
        envelopeKeys.push(typeKey);
      }
    }

    for (const key of envelopeKeys) {
      const envelope = this.asRecord(raw?.[key]);
      if (!envelope) {
        continue;
      }

      const nestedMessage = this.asRecord(envelope.message);
      if (nestedMessage) {
        return nestedMessage;
      }

      const nestedData = this.asRecord(envelope.data);
      const nestedDataMessage = this.asRecord(nestedData?.message);
      if (nestedDataMessage) {
        return nestedDataMessage;
      }
    }

    return null;
  }

  private extractMessageText(message: Record<string, unknown> | null): string | null {
    const body = this.asRecord(message?.body);
    const candidates = [
      body?.text,
      body?.caption,
      body?.plain,
      message?.text,
      message?.caption,
      message?.plain,
      message?.message_text,
      message?.messageText,
    ];

    for (const candidate of candidates) {
      const text = this.readString(candidate);
      if (text) {
        return text;
      }
    }

    return null;
  }

  private isForwardFromContextSender(
    link: Record<string, unknown> | null,
    contextSenderId: string,
    expectedOwnerUserId?: string | null,
  ): boolean {
    const sender = this.asRecord(link?.sender);
    const forwardSenderId = this.readString(
      link?.sender_id ?? link?.senderId ?? sender?.user_id ?? sender?.userId ?? sender?.id,
    );

    if (!forwardSenderId) {
      return true;
    }
    if (forwardSenderId === contextSenderId.trim()) {
      return true;
    }
    // A caller that parsed the update envelope may supply the forwarded seller
    // explicitly. Keep the old strict behavior for unannotated compatibility
    // contexts, while allowing actor/seller identity to be separated safely.
    return Boolean(expectedOwnerUserId?.trim() && forwardSenderId === expectedOwnerUserId.trim());
  }

  private resolveStorefrontOwnerUserId(context: RelayContext): string {
    const explicit = context.storefrontOwnerUserId?.trim();
    if (explicit) {
      return explicit;
    }

    const raw = this.asRecord(context.raw);
    const message = this.extractRawMessage(raw);
    const link = this.asRecord(message?.link);
    // A real outer message takes precedence over any forward metadata. In
    // that case the actor is also the storefront owner for lookup purposes.
    if (this.extractMessageText(message)?.trim()) {
      return context.senderId.trim();
    }
    if (this.readLowerString(link?.type) === 'forward') {
      const sender = this.asRecord(link?.sender);
      const forwardedUserId = this.readString(
        link?.sender_id ?? link?.senderId ?? sender?.user_id ?? sender?.userId ?? sender?.id,
      );
      if (forwardedUserId && forwardedUserId === context.senderId.trim()) {
        return forwardedUserId;
      }
    }
    return context.senderId.trim();
  }

  private isPrivateDirectChat(chatId: string): boolean {
    return /^\d+$/u.test(chatId.trim());
  }

  private async lookupStorefront(
    maxUserId: string,
    options: { fresh?: boolean } = {},
  ): Promise<LookupStore | null | undefined> {
    const normalizedMaxUserId = maxUserId.trim();
    const cached = options.fresh ? undefined : this.cache.get(normalizedMaxUserId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.response.exists ? cached.response.store : null;
    }

    const existing = this.inFlightLookups.get(normalizedMaxUserId);
    if (existing) {
      const response = await existing;
      if (!response) {
        return undefined;
      }
      return response.exists ? response.store : null;
    }

    const lookup = this.fetchLookup(normalizedMaxUserId)
      .catch((error: unknown) => {
        this.logger.warn(
          {
            maxUserId: normalizedMaxUserId,
            err: this.formatError(error),
          },
          'Karavan storefront lookup failed open',
        );
        return null;
      })
      .finally(() => {
        this.inFlightLookups.delete(normalizedMaxUserId);
      });

    this.inFlightLookups.set(normalizedMaxUserId, lookup);
    const response = await lookup;
    if (!response) {
      return undefined;
    }
    this.cache.set(normalizedMaxUserId, {
      expiresAtMs: Date.now() + this.cacheTtlSec * 1_000,
      response,
    });
    return response.exists ? response.store : null;
  }

  private buildStorefrontMessageOptions(
    messageId: string,
    url: string,
    texts: KaravanStorefrontTexts,
  ): MaxSendMessageOptions {
    return {
      messageLink: {
        type: 'reply',
        mid: messageId,
      },
      buttons: [
        [
          {
            type: 'link',
            text: texts.karavanStorefrontOpenButtonText,
            url,
          },
        ],
      ],
    };
  }

  private buildDirectoryMessageOptions(
    messageId: string,
    texts: KaravanStorefrontTexts,
  ): MaxSendMessageOptions {
    return {
      messageLink: {
        type: 'reply',
        mid: messageId,
      },
      // Keep each link on its own row. MAX currently normalizes link buttons
      // this way as well, and explicit rows keep the queued payload stable.
      buttons: [
        [
          {
            type: 'link',
            text: texts.karavanStorefrontCatalogButtonText,
            url: this.catalogUrl,
          },
        ],
        [
          {
            type: 'link',
            text: texts.karavanStorefrontCreateButtonText,
            url: this.createUrl,
          },
        ],
      ],
    };
  }

  private async fetchLookup(maxUserId: string): Promise<LookupResponse> {
    if (!this.apiBaseUrl || !this.integrationToken) {
      return { exists: false, store: null };
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.lookupTimeoutMs);
    timeout.unref();

    try {
      const url = `${this.apiBaseUrl}/v1/integrations/maxim/storefronts/by-max-user/${encodeURIComponent(maxUserId)}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.integrationToken}`,
        },
        signal: timeoutController.signal,
      });

      if (!response.ok) {
        throw new Error(`Karavan lookup returned HTTP ${response.status}`);
      }

      return lookupResponseSchema.parse(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRelayLockKey(chatId: string, messageId: string): string {
    return `${RELAY_LOCK_PREFIX}:${encodeURIComponent(chatId)}:${encodeURIComponent(messageId)}`;
  }

  private buildRelayIdempotencyKey(chatId: string, messageId: string): string {
    return `karavan-storefront-relay:v2:${encodeURIComponent(chatId)}:${encodeURIComponent(messageId)}`;
  }

  private buildDispatchOptions(params: {
    context: RelayContext;
    store: LookupStore | null;
    idempotencyKey: string;
    variant: StorefrontRelayVariant;
    scopedPublication?: KaravanScopedPublication | null;
  }): MaxActionDispatchOptions {
    return {
      idempotencyKey: params.idempotencyKey,
      ...(params.scopedPublication
        ? {
            botId: params.scopedPublication.botId,
            routing: {
              purpose: 'send_message' as const,
              requiredBotId: params.scopedPublication.botId,
            },
          }
        : {}),
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: MAX_API_SOURCE_TAGS.KARAVAN_STOREFRONT_RELAY,
      ledgerContext: {
        ...(params.scopedPublication
          ? { karavanMarketplacePublication: params.scopedPublication }
          : {}),
        karavanStorefrontRelay: {
          sourceMessageId: params.context.messageId ?? null,
          actorUserId: params.context.senderId,
          storefrontOwnerUserId: this.resolveStorefrontOwnerUserId(params.context),
          senderId: params.context.senderId,
          requestedBotId: params.context.botId ?? null,
          storeId: params.store?.id ?? null,
          storeSlug: params.store?.slug ?? null,
          variant: params.variant,
        },
      },
    };
  }

  private async createPendingAuditLog(params: {
    context: RelayContext;
    store: LookupStore | null;
    idempotencyKey: string;
    variant: StorefrontRelayVariant;
    scopedPublication?: KaravanScopedPublication | null;
  }): Promise<{ id: string; payload: Prisma.InputJsonObject }> {
    const payload: Prisma.InputJsonObject = {
      messageText: resolveKaravanStorefrontTexts(params.context.storefrontTexts)
        .karavanStorefrontMessageText,
      sourceMessageId: params.context.messageId ?? null,
      companionMessageId: null,
      publishedUrl: params.scopedPublication?.url ?? null,
      ...(params.scopedPublication ? { marketplacePublication: params.scopedPublication } : {}),
      deliveryStatus: 'pending',
      idempotencyKey: params.idempotencyKey,
      requestedBotId: params.context.botId ?? null,
      actorUserId: params.context.senderId,
      storefrontOwnerUserId: this.resolveStorefrontOwnerUserId(params.context),
      variant: params.variant,
      store: params.store
        ? {
            id: params.store.id,
            slug: params.store.slug,
            name: params.store.name,
            sellerAccountId: params.store.sellerAccountId,
            url: params.store.url,
            inviteUrl: params.store.inviteUrl,
          }
        : null,
    };
    const audit = await this.prisma.auditLog.create({
      data: {
        chatId: params.context.chatId,
        actorUserId: params.context.senderId,
        action: KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION,
        payload,
      },
      select: { id: true },
    });
    return { id: audit.id, payload };
  }

  private async updateAuditDeliveryStatus(
    audit: { id: string; payload: Prisma.InputJsonObject },
    deliveryStatus: 'queued' | 'enqueue_failed' | 'ambiguous',
    action = deliveryStatus === 'enqueue_failed'
      ? KARAVAN_STOREFRONT_RELAY_ENQUEUE_FAILED_AUDIT_ACTION
      : KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION,
  ): Promise<void> {
    await this.prisma.auditLog
      .update({
        where: { id: audit.id },
        data: {
          action,
          payload: {
            ...audit.payload,
            deliveryStatus,
            updatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          {
            auditLogId: audit.id,
            deliveryStatus,
            err: this.formatError(error),
          },
          'Failed to update Karavan storefront relay delivery audit',
        );
      });
  }

  private resolveProcessingLockTtlMs(): number {
    return Math.min(
      this.relayLockTtlSec * 1_000,
      Math.max(MIN_PROCESSING_LOCK_TTL_MS, this.lookupTimeoutMs + 10_000),
    );
  }

  private async renewCompletedClaim(lockKey: string, lockToken: string): Promise<void> {
    const renewed = await this.redisCounter.renewLock(
      lockKey,
      lockToken,
      this.relayLockTtlSec * 1_000,
    );
    if (!renewed) {
      this.logger.warn(
        { lockKey },
        'Karavan storefront relay was queued after its processing claim expired',
      );
    }
  }

  private extractReplySourceMessageId(rawValue: unknown): string | null {
    const raw = this.asRecord(rawValue);
    const message = this.extractRawMessage(raw);
    const link = this.asRecord(message?.link);
    if (this.readLowerString(link?.type) !== 'reply') {
      return null;
    }

    const linkedMessage = this.asRecord(link?.message);
    const linkedBody = this.asRecord(linkedMessage?.body);
    return this.readString(
      link?.mid ??
        link?.message_id ??
        link?.messageId ??
        linkedMessage?.mid ??
        linkedMessage?.message_id ??
        linkedMessage?.messageId ??
        linkedBody?.mid,
    );
  }

  private isAmbiguousDispatchAcceptance(error: unknown): boolean {
    return (
      wasMaxMessageSendAttempted(error) ||
      this.formatError(error).toLowerCase().includes('ambiguous bullmq ownership')
    );
  }

  private readBooleanConfig(key: string, fallback: boolean): boolean {
    const value = this.configService?.get<boolean | string>(key);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }

  private readPositiveIntConfig(key: string, fallback: number): number {
    const value = this.configService?.get<number | string>(key);
    const numeric = typeof value === 'string' ? Number(value) : value;
    return Number.isFinite(numeric) && numeric! > 0 ? Math.trunc(numeric!) : fallback;
  }

  private readUrlConfig(key: string, fallback: string): string {
    const value = this.configService?.get<string>(key);
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return fallback;
    }

    try {
      const url = new URL(normalized);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : fallback;
    } catch {
      return fallback;
    }
  }

  private normalizeBaseUrl(value: string | null | undefined): string | null {
    const normalized = value?.trim().replace(/\/+$/u, '') ?? '';
    if (!normalized) {
      return null;
    }

    try {
      const url = new URL(normalized);
      return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
    } catch {
      return null;
    }
  }

  private normalizeToken(value: string | null | undefined): string | null {
    const normalized = value?.trim() ?? '';
    return normalized.length >= 16 ? normalized : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readLowerString(value: unknown): string | null {
    const text = this.readString(value);
    return text ? text.toLowerCase() : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readInteger(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'string') {
      return null;
    }

    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed)) {
      return null;
    }

    return parsed;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
