import { withMarketplaceModerationMessage } from '../max/marketplace-publication-button';
import {
  chatRulesSchema,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  MAX_BROADCAST_LINK_BUTTONS,
  normalizeHttpButtonUrl,
  publishChatRulesResultSchema,
  type BroadcastLinkButton,
  type ChatRules,
  type PublishChatRulesResult,
  type PublishChatRulesRequest,
  type UpdateChatRulesRequest,
  updateChatRulesRequestSchema,
} from '@maxim/contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type {
  MaxActionDispatchOptions,
  MaxClientService,
  MaxMessageButton,
  MaxPublishedMessage,
  MaxSendMessageOptions,
} from '../max/max-client.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import type { ChatRules as PersistedChatRules, Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { advanceChatMutationOrder } from '../common/group-command-authority.service';
import { normalizeLegacyProfileButtonUrl } from './admin-profile-links';
import { isPrismaKnownError } from './admin-legacy-utils';
import {
  BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS,
  RULES_IMAGE_MAX_BYTES,
  type AdminActionSource,
} from './admin.service.support';

type ChatRulesMessageOptions =
  | Pick<MaxSendMessageOptions, 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'>
  | undefined;

type ChatRulesFormattedPublication = {
  text: string;
  textFormat?: MaxSendMessageOptions['textFormat'];
};

type ChatRulesDeleteOutcome = 'confirmed' | 'accepted' | 'waiting_capability' | 'failed';
type ChatRulesCleanupKind = 'republish_previous' | 'reset_current';
type DeletePublishedChatRulesMessage = (params: {
  chatId: string;
  messageId: string;
  botId?: string;
  cleanupKind: ChatRulesCleanupKind;
  directOptions: MaxActionDispatchOptions;
}) => Promise<ChatRulesDeleteOutcome>;

const CHAT_RULES_LINK_TIMEOUT_MS = 2_500;
const CHAT_RULES_SEND_TIMEOUT_MS = 12_000;
const CHAT_RULES_UPLOAD_TIMEOUT_MS = 30_000;
const CHAT_RULES_CLEANUP_ACCESS_ERROR =
  'Исходный бот пока не может удалить прежний пост правил. Проверьте, что он состоит в группе и имеет права администратора на удаление сообщений.';

function buildChatRulesReadOptions(botId?: string) {
  return {
    ...(botId ? { botId } : {}),
    trafficClass: 'interactive' as const,
    actionHealthLane: 'background' as const,
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: CHAT_RULES_LINK_TIMEOUT_MS,
  };
}

function buildChatRulesSendOptions(botId?: string) {
  return {
    ...(botId ? { botId } : {}),
    trafficClass: 'interactive' as const,
    actionHealthLane: 'interactive' as const,
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: CHAT_RULES_SEND_TIMEOUT_MS,
  };
}

function buildChatRulesUploadOptions(botId?: string) {
  return {
    ...(botId ? { botId } : {}),
    trafficClass: 'interactive' as const,
    actionHealthLane: 'interactive' as const,
    sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES,
    timeoutMs: CHAT_RULES_UPLOAD_TIMEOUT_MS,
  };
}

function buildChatRulesDeleteOptions(botId?: string) {
  return {
    immediate: true,
    ...buildChatRulesSendOptions(botId),
  };
}

async function deletePublishedChatRulesMessage(params: {
  maxClient: Pick<MaxClientService, 'deleteMessage'>;
  deleteMessage?: DeletePublishedChatRulesMessage;
  chatId: string;
  messageId: string;
  botId?: string;
  cleanupKind: ChatRulesCleanupKind;
}): Promise<ChatRulesDeleteOutcome> {
  const directOptions = buildChatRulesDeleteOptions(params.botId);
  if (params.deleteMessage) {
    return params.deleteMessage({
      chatId: params.chatId,
      messageId: params.messageId,
      botId: params.botId,
      cleanupKind: params.cleanupKind,
      directOptions,
    });
  }
  await params.maxClient.deleteMessage(params.chatId, params.messageId, directOptions);
  return 'confirmed';
}

async function reconcilePendingChatRulesCleanup(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  logger: Pick<Logger, 'warn'>;
  maxClient: Pick<MaxClientService, 'deleteMessage'>;
  deleteMessage?: DeletePublishedChatRulesMessage;
  rules: PersistedChatRules;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
}): Promise<PersistedChatRules> {
  const { rules } = params;
  if (!rules.pendingCleanupMessageId) return rules;
  const cleanupKind = rules.pendingCleanupKind;
  if (
    rules.publishOperationId ||
    rules.publishSendStartedAt ||
    (cleanupKind !== 'republish_previous' && cleanupKind !== 'reset_current') ||
    (cleanupKind === 'republish_previous' &&
      rules.pendingCleanupMessageId === rules.publishedMessageId) ||
    (cleanupKind === 'reset_current' && rules.pendingCleanupMessageId !== rules.publishedMessageId)
  ) {
    throw new BadRequestException(
      'Состояние публикации правил требует проверки. Обратитесь в поддержку.',
    );
  }

  const botId =
    normalizeOptionalBotId(rules.pendingCleanupBotId) ??
    normalizeOptionalBotId(await params.resolveBotId());
  let outcome: ChatRulesDeleteOutcome;
  try {
    outcome = await deletePublishedChatRulesMessage({
      maxClient: params.maxClient,
      deleteMessage: params.deleteMessage,
      chatId: rules.chatId,
      messageId: rules.pendingCleanupMessageId,
      botId,
      cleanupKind,
    });
  } catch (error: unknown) {
    if (!isMaxMessageMissingError(error)) {
      const details = readMaxApiErrorDetails(error);
      params.logger.warn(
        {
          chatId: rules.chatId,
          messageId: rules.pendingCleanupMessageId,
          botId,
          cleanupKind,
          statusCode: details.status,
          errorCode: details.code || null,
        },
        'Pending chat rules cleanup failed',
      );
      throw new BadRequestException(
        'Не удалось завершить удаление прежнего поста правил. Проверьте права исходного бота и повторите.',
      );
    }
    outcome = 'confirmed';
  }
  if (outcome !== 'confirmed') {
    if (outcome === 'waiting_capability') {
      throw new BadRequestException(CHAT_RULES_CLEANUP_ACCESS_ERROR);
    }
    throw new BadRequestException(
      outcome === 'accepted'
        ? 'Предыдущий пост правил ещё удаляется. Подождите немного и повторите.'
        : 'Удаление прежнего поста правил остановлено. Проверьте права исходного бота и обратитесь в поддержку.',
    );
  }

  // FLAG: Reconcile only the exact confirmed cleanup; never clear a newer publish/reset fence.
  await params.prisma.chatRules.updateMany({
    where: {
      chatId: rules.chatId,
      publishedMessageId: rules.publishedMessageId,
      publishedBotId: rules.publishedBotId,
      publishOperationId: null,
      publishSendStartedAt: null,
      pendingCleanupMessageId: rules.pendingCleanupMessageId,
      pendingCleanupBotId: rules.pendingCleanupBotId,
      pendingCleanupKind: cleanupKind,
    },
    data: {
      pendingCleanupMessageId: null,
      pendingCleanupBotId: null,
      pendingCleanupIntentId: null,
      pendingCleanupKind: null,
      ...(cleanupKind === 'reset_current'
        ? { publishedMessageId: null, publishedBotId: null, publishedUrl: null, publishedAt: null }
        : {}),
    },
  });
  const latest = await params.prisma.chatRules.findUnique({ where: { chatId: rules.chatId } });
  // FLAG: The durable executor may have finalized this exact cleanup before our CAS.
  // A draft save is safe to read afresh; a newer publication or cleanup must still stop us.
  const expectedPublishedMessageId =
    cleanupKind === 'reset_current' ? null : rules.publishedMessageId;
  const expectedPublishedBotId = cleanupKind === 'reset_current' ? null : rules.publishedBotId;
  if (
    !latest ||
    latest.publishOperationId ||
    latest.publishSendStartedAt ||
    latest.pendingCleanupMessageId ||
    latest.pendingCleanupKind ||
    latest.publishedMessageId !== expectedPublishedMessageId ||
    latest.publishedBotId !== expectedPublishedBotId
  ) {
    throw new BadRequestException(
      'Правила изменились во время удаления. Обновите экран и повторите.',
    );
  }
  await params.chatContextCache.invalidate(rules.chatId).catch(() => {
    params.logger.warn(
      { chatId: rules.chatId },
      'Failed to invalidate confirmed rules cleanup cache',
    );
  });
  return latest;
}

export function decodeRulesImageBase64(value: string): Buffer {
  const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
  if (!normalized) {
    throw new BadRequestException('Добавьте фото для правил.');
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(normalized, 'base64');
  } catch {
    throw new BadRequestException('Не удалось прочитать фото правил.');
  }

  if (imageBuffer.length === 0) {
    throw new BadRequestException('Не удалось прочитать фото правил.');
  }

  return imageBuffer;
}

export function normalizeStoredLinkButtons(
  rawButtons: unknown,
  legacy?: {
    buttonUrl?: string | null;
    buttonText?: string | null;
  },
): BroadcastLinkButton[] {
  const normalizedButtons: BroadcastLinkButton[] = [];

  if (Array.isArray(rawButtons)) {
    for (const item of rawButtons) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const row = item as { text?: unknown; url?: unknown };
      const url = normalizeLegacyProfileButtonUrl(typeof row.url === 'string' ? row.url : '');
      if (!url) {
        continue;
      }

      normalizedButtons.push({
        text:
          typeof row.text === 'string' && row.text.trim().length > 0
            ? row.text.trim()
            : DEFAULT_BROADCAST_BUTTON_TEXT,
        url,
      });

      if (normalizedButtons.length >= MAX_BROADCAST_LINK_BUTTONS) {
        break;
      }
    }
  }

  if (normalizedButtons.length > 0) {
    return normalizedButtons;
  }

  const legacyUrl = normalizeLegacyProfileButtonUrl(legacy?.buttonUrl ?? '');
  if (!legacyUrl) {
    return [];
  }

  return [
    {
      text: legacy?.buttonText?.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
      url: legacyUrl,
    },
  ];
}

export function buildStoredLinkButtonState(
  rawButtons: unknown,
  legacy?: {
    buttonUrl?: string | null;
    buttonText?: string | null;
  },
): {
  buttons: BroadcastLinkButton[];
  buttonUrl: string;
  buttonText: string;
} {
  const buttons = normalizeStoredLinkButtons(rawButtons, legacy);
  const primaryButton = buttons[0];

  return {
    buttons,
    buttonUrl: primaryButton?.url ?? '',
    buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
  };
}

function normalizeRulesAdminContactButton(rules: {
  adminContactButtonEnabled?: boolean | null;
  adminContactButtonUrl?: string | null;
}): {
  adminContactButtonEnabled: boolean;
  adminContactButtonUrl: string;
} {
  const trimmedUrl =
    typeof rules.adminContactButtonUrl === 'string' ? rules.adminContactButtonUrl.trim() : '';
  const adminContactButtonUrl = trimmedUrl ? (normalizeHttpButtonUrl(trimmedUrl) ?? '') : '';
  return {
    adminContactButtonEnabled:
      rules.adminContactButtonEnabled === true && adminContactButtonUrl.length > 0,
    adminContactButtonUrl,
  };
}

export function normalizeChatRulesDraft(value: UpdateChatRulesRequest): UpdateChatRulesRequest {
  const buttonState = buildStoredLinkButtonState(value.buttons, {
    buttonUrl: value.buttonUrl,
    buttonText: value.buttonText,
  });
  const baseDraft = {
    text: value.text,
    textFormat: value.textFormat,
    autoTextEnabled: value.autoTextEnabled,
    buttons: buttonState.buttons,
    buttonEnabled: value.buttonEnabled,
    buttonUrl: buttonState.buttonUrl,
    buttonText: buttonState.buttonText,
    adminContactButtonEnabled: value.adminContactButtonEnabled,
    adminContactButtonUrl: value.adminContactButtonEnabled ? value.adminContactButtonUrl : '',
  } satisfies Pick<
    UpdateChatRulesRequest,
    | 'text'
    | 'textFormat'
    | 'autoTextEnabled'
    | 'buttons'
    | 'buttonEnabled'
    | 'buttonUrl'
    | 'buttonText'
    | 'adminContactButtonEnabled'
    | 'adminContactButtonUrl'
  >;
  const normalizedImageBase64 = value.imageBase64.trim();
  if (!normalizedImageBase64) {
    return {
      ...baseDraft,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
    };
  }

  return {
    ...baseDraft,
    imageBase64: normalizedImageBase64,
    imageMimeType: value.imageMimeType.trim(),
    imageFileName: value.imageFileName.trim(),
  };
}

export function mapChatRules(rules: PersistedChatRules): ChatRules {
  const buttonState = buildStoredLinkButtonState(rules.buttons, {
    buttonUrl: rules.buttonUrl,
    buttonText: rules.buttonText,
  });
  const adminContactButtonState = normalizeRulesAdminContactButton(rules);

  return chatRulesSchema.parse({
    revision: rules.updatedAt?.toISOString(),
    text: rules.text,
    textFormat: normalizeChatRulesTextFormat(rules.textFormat),
    imageBase64: rules.imageBase64,
    imageMimeType: rules.imageMimeType,
    imageFileName: rules.imageFileName,
    autoTextEnabled: rules.autoTextEnabled,
    buttons: buttonState.buttons,
    buttonEnabled: rules.buttonEnabled === true && buttonState.buttons.length > 0,
    buttonUrl: buttonState.buttonUrl,
    buttonText: buttonState.buttonText,
    adminContactButtonEnabled: adminContactButtonState.adminContactButtonEnabled,
    adminContactButtonUrl: adminContactButtonState.adminContactButtonUrl,
    publishedMessageId: rules.publishedMessageId,
    publishedUrl: normalizePublishedRulesUrl(rules.publishedUrl),
    publishedAt: rules.publishedAt ? rules.publishedAt.toISOString() : null,
  });
}

export function normalizePublishedRulesUrl(value: string | null | undefined): string | null {
  return typeof value === 'string' ? normalizeHttpButtonUrl(value) : null;
}

function normalizeOptionalBotId(value: string | null | undefined): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function normalizeChatRulesTextFormat(value: unknown): ChatRules['textFormat'] {
  return value === 'plain' ? 'plain' : 'markdown';
}

export function extractMaxApiErrorMessage(error: unknown): string {
  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  if (!responseData || typeof responseData !== 'object') {
    return '';
  }

  const row = responseData as Record<string, unknown>;
  const message = row.message;
  if (typeof message === 'string' && message.trim()) {
    return message.trim();
  }

  const code = row.code;
  if (typeof code === 'string' && code.trim()) {
    return `Ошибка MAX API: ${code.trim()}`;
  }

  return '';
}

function readMaxApiErrorDetails(error: unknown): {
  status: number | null;
  code: string;
  message: string;
} {
  const response = (error as { response?: { status?: unknown; data?: unknown } })?.response;
  const data =
    response?.data && typeof response.data === 'object' && !Array.isArray(response.data)
      ? (response.data as Record<string, unknown>)
      : null;
  const nestedError =
    data?.error && typeof data.error === 'object' && !Array.isArray(data.error)
      ? (data.error as Record<string, unknown>)
      : null;
  const code = String(nestedError?.code ?? data?.code ?? '')
    .trim()
    .toLowerCase();
  const message = String(nestedError?.message ?? data?.message ?? '')
    .trim()
    .toLowerCase();

  return {
    status: typeof response?.status === 'number' ? response.status : null,
    code,
    message,
  };
}

export function describeChatRulesPublishError(error: unknown): string {
  if (isAmbiguousMaxSendError(error)) {
    return 'MAX не подтвердил отправку. Проверьте чат и обратитесь в поддержку перед повтором.';
  }

  const { status, code, message } = readMaxApiErrorDetails(error);
  const combined = `${code} ${message}`;
  if (status === 403 || /chat\.denied|forbidden|permission|not (?:a )?member/u.test(combined)) {
    return 'Бот не может писать в этот чат. Верните ему доступ и право отправлять сообщения.';
  }
  if (status === 404 || /chat\.not\.found|dialog\.not\.found|chat not found/u.test(combined)) {
    return 'Бот больше не видит этот чат. Добавьте его в чат снова и обновите доступ.';
  }
  if (status === 429 || /rate[ ._-]?limit|too many requests/u.test(combined)) {
    return 'MAX временно ограничил отправку. Подождите немного и повторите.';
  }
  if (/attachment[ ._-]?not[ ._-]?ready|media|upload/u.test(combined)) {
    return 'MAX не подготовил фото. Выберите изображение заново и повторите.';
  }
  if (status === 400 && /format|markup|markdown|html|parse/u.test(combined)) {
    return 'MAX не принял форматирование текста. Упростите выделение и повторите.';
  }
  if (status === 400) {
    return 'MAX отклонил содержимое правил. Проверьте текст, фото и кнопки.';
  }

  return 'MAX не принял публикацию. Проверьте доступ бота и повторите позже.';
}

export function isMaxMessageMissingError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  if (!responseData || typeof responseData !== 'object' || Array.isArray(responseData)) {
    return false;
  }

  const row = responseData as Record<string, unknown>;
  const nestedError =
    row.error && typeof row.error === 'object' && !Array.isArray(row.error)
      ? (row.error as Record<string, unknown>)
      : null;
  const code = String(nestedError?.code ?? row.code ?? '')
    .trim()
    .toLowerCase();
  const message = String(nestedError?.message ?? row.message ?? '')
    .trim()
    .toLowerCase();
  const exactMessageCode = new Set([
    'message.not.found',
    'message_not_found',
    'message.not_found',
  ]).has(code);
  const exactMessageText =
    message.includes('message not found') || message.includes('message.not.found');

  return (
    (exactMessageCode && (status === 404 || status === 200)) || (status === 404 && exactMessageText)
  );
}

export function resolveRulesImageFileName(fileName: string, mimeType: string): string {
  const trimmed = fileName.trim();
  if (trimmed) {
    return trimmed;
  }

  if (mimeType === 'image/png') {
    return 'chat-rules.png';
  }
  if (mimeType === 'image/webp') {
    return 'chat-rules.webp';
  }
  if (mimeType === 'image/gif') {
    return 'chat-rules.gif';
  }

  return 'chat-rules.jpg';
}

export function buildBroadcastLinkButtonRows(
  buttons: readonly BroadcastLinkButton[],
): MaxMessageButton[][] {
  const rows: MaxMessageButton[][] = [];

  for (let index = 0; index < buttons.length; index += MAX_BROADCAST_LINK_BUTTONS_PER_ROW) {
    rows.push(
      buttons.slice(index, index + MAX_BROADCAST_LINK_BUTTONS_PER_ROW).map((button) => ({
        type: 'link',
        text: button.text,
        url: button.url,
      })),
    );
  }

  return rows;
}

export function buildChatRulesButtonRows(rules: {
  buttons: unknown;
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
}): MaxMessageButton[][] | null {
  const buttons = rules.buttonEnabled
    ? normalizeStoredLinkButtons(rules.buttons, {
        buttonUrl: rules.buttonUrl,
        buttonText: rules.buttonText,
      }).map((button) => ({
        ...button,
        url: normalizePublishedRulesUrl(button.url) ?? '',
      }))
    : [];
  const normalizedButtons = buttons.filter((button) => button.url.length > 0);
  if (normalizedButtons.length === 0) {
    return null;
  }

  return buildBroadcastLinkButtonRows(normalizedButtons);
}

export async function ensureChatRules(params: {
  prisma: PrismaService;
  chatId: string;
}): Promise<PersistedChatRules> {
  try {
    return await params.prisma.chatRules.upsert({
      where: { chatId: params.chatId },
      create: {
        chatId: params.chatId,
        autoTextEnabled: true,
      },
      update: {},
    });
  } catch (error: unknown) {
    if (!isPrismaKnownError(error, 'P2002')) {
      throw error;
    }

    const existing = await params.prisma.chatRules.findUnique({
      where: { chatId: params.chatId },
    });
    if (existing) {
      return existing;
    }

    throw error;
  }
}

export async function hydratePublishedRulesUrl(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'resolveMessageLink'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  rules: PersistedChatRules;
  resolveBotId?: () => Promise<string | undefined> | string | undefined;
}): Promise<PersistedChatRules> {
  const currentUrl = normalizePublishedRulesUrl(params.rules.publishedUrl);
  if (currentUrl || !params.rules.publishedMessageId?.trim()) {
    return {
      ...params.rules,
      publishedUrl: currentUrl,
    };
  }

  let botId = normalizeOptionalBotId(params.rules.publishedBotId);
  try {
    botId ??= normalizeOptionalBotId(await params.resolveBotId?.());
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: params.rules.publishedMessageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to resolve bot for published chat rules url recovery',
    );
  }

  let resolvedUrl: string | null = null;
  try {
    resolvedUrl = normalizePublishedRulesUrl(
      await params.maxClient.resolveMessageLink(
        params.rules.publishedMessageId,
        buildChatRulesReadOptions(botId),
      ),
    );
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: params.rules.publishedMessageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to recover published chat rules url',
    );
    return params.rules;
  }

  if (!resolvedUrl) {
    return params.rules;
  }

  await params.prisma.chatRules.update({
    where: { chatId: params.chatId },
    data: {
      publishedUrl: resolvedUrl,
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

  return {
    ...params.rules,
    publishedUrl: resolvedUrl,
  };
}

export async function readChatRules(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'resolveMessageLink'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  resolveBotId?: () => Promise<string | undefined> | string | undefined;
}): Promise<ChatRules> {
  const rules = await ensureChatRules({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  const hydratedRules = await hydratePublishedRulesUrl({
    prisma: params.prisma,
    chatContextCache: params.chatContextCache,
    maxClient: params.maxClient,
    logger: params.logger,
    chatId: params.chatId,
    rules,
    resolveBotId: params.resolveBotId,
  });
  const adminContactButtonState = normalizeRulesAdminContactButton(hydratedRules);
  if (
    adminContactButtonState.adminContactButtonEnabled !== hydratedRules.adminContactButtonEnabled ||
    adminContactButtonState.adminContactButtonUrl !== hydratedRules.adminContactButtonUrl
  ) {
    const repaired = await params.prisma.chatRules.updateMany({
      where: {
        chatId: params.chatId,
        adminContactButtonEnabled: hydratedRules.adminContactButtonEnabled,
        adminContactButtonUrl: hydratedRules.adminContactButtonUrl,
      },
      data: adminContactButtonState,
    });
    if (repaired.count > 0) {
      await params.chatContextCache.invalidate(params.chatId);
      const current = await params.prisma.chatRules.findUnique({
        where: { chatId: params.chatId },
      });
      if (current) return mapChatRules(current);
    }
  }

  return mapChatRules({
    ...hydratedRules,
    ...adminContactButtonState,
  });
}

function hasRetriableRulesAttachment(options: ChatRulesMessageOptions): boolean {
  return Boolean(options?.imagePayload) || Boolean(options?.attachments?.length);
}

function isAttachmentNotReadyError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status !== 400) {
    return false;
  }

  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  const normalized = JSON.stringify(responseData ?? '').toLowerCase();
  return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishChatRulesMessageWithRetry(params: {
  maxClient: Pick<MaxClientService, 'sendMessageImmediateWithResolvedLink'>;
  chatId: string;
  text: string;
  options: ChatRulesMessageOptions;
  botId?: string;
  sleep?: (ms: number) => Promise<void>;
}): Promise<MaxPublishedMessage> {
  let lastError: unknown = null;
  const attempts = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS.length + 1;
  const sleep = params.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return params.botId
        ? await params.maxClient.sendMessageImmediateWithResolvedLink(
            params.chatId,
            params.text,
            withMarketplaceModerationMessage(
              params.options,
              params.chatId,
              'MODERATION_NOTICE',
              'RULES',
            ),
            buildChatRulesSendOptions(params.botId),
          )
        : await params.maxClient.sendMessageImmediateWithResolvedLink(
            params.chatId,
            params.text,
            withMarketplaceModerationMessage(
              params.options,
              params.chatId,
              'MODERATION_NOTICE',
              'RULES',
            ),
            buildChatRulesSendOptions(),
          );
    } catch (error: unknown) {
      lastError = error;
      if (
        !hasRetriableRulesAttachment(params.options) ||
        !isAttachmentNotReadyError(error) ||
        attempt >= attempts
      ) {
        throw error;
      }
      const delayMs = BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? 1_500;
      await sleep(delayMs);
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Message publish failed without error details');
}

export async function publishChatRules(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<
    MaxClientService,
    'deleteMessage' | 'resolveMessageLink' | 'sendMessageImmediateWithResolvedLink' | 'uploadImage'
  > &
    Partial<Pick<MaxClientService, 'replaceOwnMessage'>>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  actorUserId: string;
  source: AdminActionSource;
  mode?: PublishChatRulesRequest['mode'];
  resolveBotId: () => Promise<string | undefined> | string | undefined;
  buildAutofilledText: () => Promise<string>;
  buildFormattedText: (
    sourceText: string,
    options: {
      textFormat: ChatRules['textFormat'];
      adminContactButtonEnabled: boolean;
      adminContactButtonUrl: string;
    },
  ) => Promise<ChatRulesFormattedPublication>;
  sendPrivateConfirmation: (
    publishedUrl: string | null,
    operation: 'created' | 'updated',
  ) => Promise<void>;
  deletePreviousPublishedMessage?: DeletePublishedChatRulesMessage;
  expectedUpdatedAt?: Date;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PublishChatRulesResult> {
  let storedRules = await ensureChatRules({ prisma: params.prisma, chatId: params.chatId });
  if (
    params.expectedUpdatedAt &&
    storedRules.updatedAt.getTime() !== params.expectedUpdatedAt.getTime()
  ) {
    throw new BadRequestException('Правила изменились после проверки. Повторите проверку.');
  }
  // FLAG: A new post may follow a reset only after its exact deletion is confirmed.
  // Reuse the guarded cleanup path; an active or ambiguous SEND must remain fenced.
  if (params.mode === 'new_message' && storedRules.pendingCleanupKind === 'reset_current') {
    storedRules = await reconcilePendingChatRulesCleanup({
      ...params,
      deleteMessage: params.deletePreviousPublishedMessage,
      rules: storedRules,
    });
  }
  const pendingRepublish = Boolean(
    storedRules.pendingCleanupKind === 'republish_previous' &&
    storedRules.pendingCleanupMessageId &&
    storedRules.publishedMessageId &&
    storedRules.pendingCleanupMessageId !== storedRules.publishedMessageId,
  );
  const idlePublication = !storedRules.publishOperationId && !storedRules.publishSendStartedAt;
  const noPendingCleanup =
    !storedRules.pendingCleanupMessageId &&
    !storedRules.pendingCleanupKind &&
    !storedRules.pendingCleanupBotId &&
    !storedRules.pendingCleanupIntentId;
  // FLAG: Only an explicit new-message request may append a post while old cleanup stays owned.
  // Never clear that cleanup, delete a previous/pinned post, or bypass an unconfirmed reset/SEND.
  const publishNew =
    params.mode === 'new_message' && idlePublication && (noPendingCleanup || pendingRepublish);
  if (params.mode === 'new_message' && !publishNew) {
    throw new BadRequestException(
      'Предыдущая операция с правилами ещё не завершена. Проверьте её результат перед новой публикацией.',
    );
  }
  const editExisting = Boolean(
    params.mode !== 'new_message' &&
    params.maxClient.replaceOwnMessage &&
    (params.mode === 'update' ? noPendingCleanup || pendingRepublish : pendingRepublish) &&
    storedRules.publishedMessageId &&
    normalizeOptionalBotId(storedRules.publishedBotId) &&
    idlePublication,
  );
  if (params.mode === 'update' && !editExisting) {
    throw new BadRequestException(
      'Нет доступного поста правил для обновления или предыдущая операция ещё не завершена.',
    );
  }
  const preserveCleanup = editExisting || publishNew;
  const rules = preserveCleanup
    ? storedRules
    : await reconcilePendingChatRulesCleanup({
        ...params,
        deleteMessage: params.deletePreviousPublishedMessage,
        rules: storedRules,
      });
  const previousPublishedMessageId = rules.publishedMessageId?.trim() || null;
  const previousPublishedBotId = normalizeOptionalBotId(rules.publishedBotId);
  const autofilledText =
    rules.autoTextEnabled && !rules.text.trim() ? await params.buildAutofilledText() : null;
  const messageText = (autofilledText ?? rules.text).trim();
  if (!messageText) {
    throw new BadRequestException('Сначала заполните текст правил.');
  }
  const resolvedBotId = editExisting
    ? previousPublishedBotId
    : normalizeOptionalBotId(await params.resolveBotId());

  let imagePayload: Record<string, unknown> | undefined;
  if (rules.imageBase64.trim()) {
    const imageMimeType = rules.imageMimeType.trim().toLowerCase();
    if (!imageMimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }

    const imageBuffer = decodeRulesImageBase64(rules.imageBase64);
    if (imageBuffer.length > RULES_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото правил слишком большое.');
    }

    try {
      imagePayload = resolvedBotId
        ? await params.maxClient.uploadImage(
            imageBuffer,
            resolveRulesImageFileName(rules.imageFileName, imageMimeType),
            imageMimeType,
            buildChatRulesUploadOptions(resolvedBotId),
          )
        : await params.maxClient.uploadImage(
            imageBuffer,
            resolveRulesImageFileName(rules.imageFileName, imageMimeType),
            imageMimeType,
            buildChatRulesUploadOptions(),
          );
    } catch (error: unknown) {
      params.logger.warn(
        {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Rules image upload failed',
      );
      throw new BadRequestException(
        'Не удалось загрузить фото правил. Попробуйте другое изображение.',
      );
    }
  }

  let published: MaxPublishedMessage;
  const buttonRows = buildChatRulesButtonRows(rules);
  const formattedMessage = await params.buildFormattedText(messageText, {
    textFormat: rules.autoTextEnabled ? 'plain' : normalizeChatRulesTextFormat(rules.textFormat),
    adminContactButtonEnabled: rules.adminContactButtonEnabled,
    adminContactButtonUrl: rules.adminContactButtonUrl,
  });
  const publishOperationId = randomUUID();
  const claimed = await params.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM chats WHERE id = ${params.chatId} FOR UPDATE`;
    const result = await tx.chatRules.updateMany({
      where: {
        chatId: params.chatId,
        updatedAt: rules.updatedAt,
        publishOperationId: null,
        publishSendStartedAt: null,
        pendingCleanupMessageId: preserveCleanup ? rules.pendingCleanupMessageId : null,
        ...(preserveCleanup
          ? {
              publishedMessageId: previousPublishedMessageId,
              publishedBotId: previousPublishedBotId,
              pendingCleanupBotId: rules.pendingCleanupBotId,
              pendingCleanupKind: rules.pendingCleanupKind,
            }
          : {}),
      },
      data: {
        publishOperationId,
        publishOperationBotId: resolvedBotId ?? null,
        publishSendStartedAt: new Date(),
      },
    });
    if (result.count === 1) await advanceChatMutationOrder(tx, params.chatId, 'RULES');
    return result;
  });
  if (claimed.count !== 1) {
    const latest = await params.prisma.chatRules
      .findUnique({ where: { chatId: params.chatId } })
      .catch(() => null);
    if (latest && latest.updatedAt.getTime() !== rules.updatedAt.getTime()) {
      throw new BadRequestException(
        'Черновик правил изменился во время публикации. Обновите экран и повторите.',
      );
    }
    if (latest?.pendingCleanupMessageId) {
      throw new BadRequestException(
        'Предыдущий пост правил ещё удаляется. Подождите немного и повторите.',
      );
    }
    throw new BadRequestException(
      'Предыдущая публикация правил ещё проверяется. Проверьте чат и обратитесь в поддержку перед повтором.',
    );
  }
  const messageOptions: ChatRulesMessageOptions =
    formattedMessage.textFormat || imagePayload || buttonRows
      ? {
          ...(formattedMessage.textFormat ? { textFormat: formattedMessage.textFormat } : {}),
          ...(imagePayload ? { imagePayload } : {}),
          ...(buttonRows ? { buttons: buttonRows } : {}),
        }
      : undefined;
  let editMutationAuthorized = false;
  try {
    if (editExisting) {
      await params.maxClient.replaceOwnMessage!(
        params.chatId,
        previousPublishedMessageId!,
        formattedMessage.text,
        messageOptions,
        { ...buildChatRulesSendOptions(resolvedBotId), botId: resolvedBotId! },
        async () => {
          const current = await params.prisma.chatRules.findUnique({
            where: { chatId: params.chatId },
          });
          if (
            current?.publishOperationId !== publishOperationId ||
            current.publishedMessageId !== previousPublishedMessageId ||
            current.publishedBotId !== previousPublishedBotId
          ) {
            throw new BadRequestException(
              'Публикация правил изменилась. Обновите экран и повторите.',
            );
          }
          editMutationAuthorized = true;
        },
      );
      published = { messageId: previousPublishedMessageId!, url: rules.publishedUrl };
    } else {
      published = await publishChatRulesMessageWithRetry({
        maxClient: params.maxClient,
        chatId: params.chatId,
        text: formattedMessage.text,
        options: messageOptions,
        botId: resolvedBotId,
        sleep: params.sleep,
      });
      if (
        (published.chatId && published.chatId !== params.chatId) ||
        (publishNew && published.messageId === previousPublishedMessageId)
      ) {
        throw new Error('Ambiguous MAX rules publication returned an unexpected message target');
      }
    }
  } catch (error: unknown) {
    // FLAG: A failed read-only edit preflight cannot leave an ambiguous mutation fence.
    const ambiguous = isAmbiguousMaxSendError(error) && (!editExisting || editMutationAuthorized);
    if (!ambiguous) {
      await params.prisma.chatRules
        .updateMany({
          where: { chatId: params.chatId, publishOperationId },
          data: {
            publishOperationId: null,
            publishOperationBotId: null,
            publishSendStartedAt: null,
          },
        })
        .catch((releaseError: unknown) => {
          params.logger.warn(
            {
              chatId: params.chatId,
              actorUserId: params.actorUserId,
              err: releaseError instanceof Error ? releaseError.message : String(releaseError),
            },
            'Failed to release a safely rejected chat rules publish fence',
          );
        });
    }
    const details = readMaxApiErrorDetails(error);
    params.logger.warn(
      {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        botId: resolvedBotId ?? null,
        statusCode: details.status,
        errorCode: details.code || null,
        ambiguous,
      },
      'Chat rules publication failed before confirmation',
    );
    throw new BadRequestException(
      editExisting && !editMutationAuthorized && isAmbiguousMaxSendError(error)
        ? 'MAX не ответил при проверке опубликованных правил. Изменения не отправлялись. Повторите попытку.'
        : describeChatRulesPublishError(error),
    );
  }

  const publishedAt = new Date();
  const needsPreviousCleanup = Boolean(
    !publishNew && previousPublishedMessageId && previousPublishedMessageId !== published.messageId,
  );
  try {
    const finalized = await params.prisma.chatRules.updateMany({
      where: {
        chatId: params.chatId,
        publishOperationId,
      },
      data: {
        ...(autofilledText !== null ? { text: autofilledText, textFormat: 'plain' } : {}),
        publishedMessageId: published.messageId,
        publishedBotId: resolvedBotId ?? null,
        publishedUrl: published.url,
        publishedAt,
        publishOperationId: null,
        publishOperationBotId: null,
        publishSendStartedAt: null,
        ...(!preserveCleanup
          ? {
              pendingCleanupMessageId: needsPreviousCleanup ? previousPublishedMessageId : null,
              pendingCleanupBotId: needsPreviousCleanup
                ? (previousPublishedBotId ?? resolvedBotId ?? null)
                : null,
              pendingCleanupIntentId: null,
              pendingCleanupKind: needsPreviousCleanup ? 'republish_previous' : null,
            }
          : {}),
      },
    });
    if (finalized.count !== 1) {
      throw new Error('Chat rules publish fence ownership was lost before finalization');
    }
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'MAX accepted chat rules, but the publication state could not be finalized',
    );
    throw new BadRequestException(
      'MAX принял публикацию, но её результат не удалось сохранить. Повтор не выполняйте; проверьте Safety Desk.',
    );
  }

  let previousCleanupOutcome: ChatRulesDeleteOutcome | 'not_needed' = 'not_needed';
  let previousCleanupError: string | null = null;
  let previousCleanupBotId: string | null = null;
  if (needsPreviousCleanup && previousPublishedMessageId) {
    const deleteBotId = previousPublishedBotId ?? resolvedBotId;
    previousCleanupBotId = deleteBotId ?? null;
    try {
      const outcome = await deletePublishedChatRulesMessage({
        maxClient: params.maxClient,
        deleteMessage: params.deletePreviousPublishedMessage,
        chatId: params.chatId,
        messageId: previousPublishedMessageId,
        botId: deleteBotId,
        cleanupKind: 'republish_previous',
      });
      previousCleanupOutcome = outcome;
      if (outcome === 'failed' || outcome === 'waiting_capability') {
        previousCleanupError =
          outcome === 'waiting_capability'
            ? 'Durable cleanup is waiting for the original bot capability'
            : 'Durable cleanup reached a terminal state';
        params.logger.warn(
          {
            chatId: params.chatId,
            actorUserId: params.actorUserId,
            messageId: previousPublishedMessageId,
          },
          'Durable cleanup could not accept previous published chat rules post deletion',
        );
      }
    } catch (error: unknown) {
      if (isMaxMessageMissingError(error)) {
        previousCleanupOutcome = 'confirmed';
      } else {
        previousCleanupOutcome = 'failed';
        previousCleanupError = error instanceof Error ? error.message : String(error);
        params.logger.warn(
          {
            chatId: params.chatId,
            actorUserId: params.actorUserId,
            messageId: previousPublishedMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to delete previous published chat rules post during republish',
        );
      }
    }
  }
  if (previousCleanupOutcome === 'confirmed' && previousPublishedMessageId) {
    await params.prisma.chatRules
      .updateMany({
        where: {
          chatId: params.chatId,
          pendingCleanupMessageId: previousPublishedMessageId,
        },
        data: {
          pendingCleanupMessageId: null,
          pendingCleanupBotId: null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: null,
        },
      })
      .catch((error: unknown) => {
        params.logger.warn(
          {
            chatId: params.chatId,
            messageId: previousPublishedMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to finalize confirmed previous rules cleanup state',
        );
      });
  }

  try {
    await params.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        action: 'PUBLISH_CHAT_RULES',
        payload: {
          messageId: published.messageId,
          botId: resolvedBotId ?? null,
          url: published.url,
          publishedAt: publishedAt.toISOString(),
          buttonEnabled: rules.buttonEnabled,
          adminContactButtonEnabled: rules.adminContactButtonEnabled,
          hasImage: Boolean(imagePayload),
          autofilledTextApplied: autofilledText !== null,
          textFormat: rules.autoTextEnabled
            ? 'plain'
            : normalizeChatRulesTextFormat(rules.textFormat),
          replacedPreviousPost: needsPreviousCleanup,
          previousPublishedMessageId: preserveCleanup ? null : previousPublishedMessageId,
          updatedExistingPost: editExisting,
          ...(params.mode ? { publicationMode: params.mode } : {}),
          ...(preserveCleanup ? { preservedCleanupMessageId: rules.pendingCleanupMessageId } : {}),
          previousPublishedBotId: previousCleanupBotId,
          // FLAG: Recovery and older images recognize accepted; capability waits remain retryable.
          previousCleanupOutcome:
            previousCleanupOutcome === 'waiting_capability' ? 'accepted' : previousCleanupOutcome,
          ...(previousCleanupError ? { previousCleanupError } : {}),
          source: params.source,
        },
      },
    });
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to persist post-commit chat rules publish audit',
    );
  }

  const committedRules: PersistedChatRules = {
    ...rules,
    ...(autofilledText !== null ? { text: autofilledText, textFormat: 'plain' } : {}),
    publishedMessageId: published.messageId,
    publishedBotId: resolvedBotId ?? null,
    publishedUrl: published.url,
    publishedAt,
    publishOperationId: null,
    publishOperationBotId: null,
    publishSendStartedAt: null,
    ...(!preserveCleanup
      ? {
          pendingCleanupMessageId: needsPreviousCleanup ? previousPublishedMessageId : null,
          pendingCleanupBotId: needsPreviousCleanup
            ? (previousPublishedBotId ?? resolvedBotId ?? null)
            : null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: needsPreviousCleanup ? 'republish_previous' : null,
        }
      : {}),
  };
  let hydratedRules = committedRules;
  try {
    hydratedRules = await hydratePublishedRulesUrl({
      prisma: params.prisma,
      chatContextCache: params.chatContextCache,
      maxClient: params.maxClient,
      logger: params.logger,
      chatId: params.chatId,
      rules: committedRules,
      resolveBotId: () => resolvedBotId,
    });
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to hydrate committed chat rules publication url',
    );
  }
  try {
    await params.chatContextCache.invalidate(params.chatId);
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: published.messageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to invalidate chat rules cache after committed publish',
    );
  }

  if (params.source === 'miniapp') {
    try {
      await params.sendPrivateConfirmation(
        hydratedRules.publishedUrl,
        editExisting ? 'updated' : 'created',
      );
    } catch (error: unknown) {
      params.logger.warn(
        {
          chatId: params.chatId,
          messageId: published.messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send post-commit chat rules publication confirmation',
      );
    }
  }

  return publishChatRulesResultSchema.parse({
    operation: editExisting ? 'updated' : 'created',
    chatId: params.chatId,
    messageId: published.messageId,
    url: hydratedRules.publishedUrl,
    publishedAt: publishedAt.toISOString(),
  });
}

export async function resetPublishedChatRules(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'deleteMessage'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  actorUserId: string;
  source: AdminActionSource;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
  deletePublishedMessage?: DeletePublishedChatRulesMessage;
}): Promise<ChatRules> {
  const rules = await reconcilePendingChatRulesCleanup({
    ...params,
    deleteMessage: params.deletePublishedMessage,
    rules: await ensureChatRules({ prisma: params.prisma, chatId: params.chatId }),
  });
  const publishedMessageId = rules.publishedMessageId?.trim() ?? '';
  const resolvedBotId = normalizeOptionalBotId(await params.resolveBotId());
  const deleteBotId = normalizeOptionalBotId(rules.publishedBotId) ?? resolvedBotId;
  let cleanupOutcome: ChatRulesDeleteOutcome | 'not_needed' = 'not_needed';

  if (publishedMessageId) {
    const alreadyOwned =
      rules.pendingCleanupKind === 'reset_current' &&
      rules.pendingCleanupMessageId === publishedMessageId;
    if (!alreadyOwned) {
      const claimed = await params.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM chats WHERE id = ${params.chatId} FOR UPDATE`;
        const result = await tx.chatRules.updateMany({
          where: {
            chatId: params.chatId,
            publishedMessageId,
            publishOperationId: null,
            publishSendStartedAt: null,
            pendingCleanupMessageId: null,
          },
          data: {
            pendingCleanupMessageId: publishedMessageId,
            pendingCleanupBotId: deleteBotId ?? null,
            pendingCleanupIntentId: null,
            pendingCleanupKind: 'reset_current',
          },
        });
        if (result.count === 1) await advanceChatMutationOrder(tx, params.chatId, 'RULES');
        return result;
      });
      if (claimed.count !== 1) {
        throw new BadRequestException(
          'Публикация или очистка правил уже выполняется. Обновите данные и повторите позже.',
        );
      }
    }

    try {
      cleanupOutcome = await deletePublishedChatRulesMessage({
        maxClient: params.maxClient,
        deleteMessage: params.deletePublishedMessage,
        chatId: params.chatId,
        messageId: publishedMessageId,
        botId: deleteBotId,
        cleanupKind: 'reset_current',
      });
      if (cleanupOutcome === 'failed') {
        throw new Error('Durable chat rules cleanup reached a terminal state');
      }
    } catch (error: unknown) {
      if (isMaxMessageMissingError(error)) {
        cleanupOutcome = 'confirmed';
      } else {
        const maxApiMessage = extractMaxApiErrorMessage(error);
        throw new BadRequestException(
          maxApiMessage || 'Не удалось удалить опубликованный пост правил.',
        );
      }
    }
    if (cleanupOutcome === 'waiting_capability') {
      throw new BadRequestException(CHAT_RULES_CLEANUP_ACCESS_ERROR);
    }
  }

  if (cleanupOutcome === 'confirmed' && publishedMessageId) {
    try {
      // FLAG: Confirming this deletion cannot clear a newer publication or cleanup.
      await params.prisma.chatRules.updateMany({
        where: {
          chatId: params.chatId,
          publishedMessageId,
          publishedBotId: rules.publishedBotId,
          publishOperationId: null,
          publishSendStartedAt: null,
          pendingCleanupMessageId: publishedMessageId,
          pendingCleanupBotId: deleteBotId ?? null,
          pendingCleanupKind: 'reset_current',
        },
        data: {
          publishedMessageId: null,
          publishedBotId: null,
          publishedUrl: null,
          publishedAt: null,
          pendingCleanupMessageId: null,
          pendingCleanupBotId: null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: null,
        },
      });
    } catch (error: unknown) {
      params.logger.warn(
        {
          chatId: params.chatId,
          messageId: publishedMessageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to finalize confirmed chat rules reset state',
      );
    }
  }

  try {
    await params.prisma.auditLog.create({
      data: {
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        action: 'RESET_CHAT_RULES_PUBLICATION',
        payload: {
          deletedPost: cleanupOutcome === 'confirmed',
          cleanupOutcome,
          messageId: publishedMessageId || null,
          botId: deleteBotId ?? null,
          source: params.source,
        },
      },
    });
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: publishedMessageId || null,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to persist post-commit chat rules reset audit',
    );
  }
  try {
    await params.chatContextCache.invalidate(params.chatId);
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to invalidate chat rules cache after reset',
    );
  }

  // FLAG: Both accepted cleanup and confirmed finalization advance the stored revision.
  // Return one fresh snapshot, including any intervening draft save or executor completion.
  const updatedRules = publishedMessageId
    ? await params.prisma.chatRules.findUnique({ where: { chatId: params.chatId } })
    : rules;
  if (!updatedRules) {
    throw new BadRequestException('Не удалось обновить состояние правил. Обновите экран.');
  }
  return mapChatRules(updatedRules);
}

export function validateChatRulesDraft(body: unknown): UpdateChatRulesRequest {
  const parsed = updateChatRulesRequestSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.format());
  const normalized = normalizeChatRulesDraft(parsed.data);
  if (normalized.imageBase64) {
    if (decodeRulesImageBase64(normalized.imageBase64).length > RULES_IMAGE_MAX_BYTES)
      throw new BadRequestException('Фото правил слишком большое.');
    if (!normalized.imageMimeType.toLowerCase().startsWith('image/'))
      throw new BadRequestException('Поддерживаются только изображения.');
  }
  return normalized;
}

export async function writeNetworkChatRulesDraft(
  tx: Prisma.TransactionClient,
  chatId: string,
  actorUserId: string,
  draft: unknown,
  expectedRevision: string | null,
  paths: readonly string[],
): Promise<void> {
  const normalized = validateChatRulesDraft(draft);
  const current = await tx.chatRules.findUnique({ where: { chatId } });
  if ((current?.updatedAt.toISOString() ?? null) !== expectedRevision)
    throw new ConflictException('Правила уже изменены. Проверьте изменения заново.');
  const authored = new Set(
    paths.filter((path) => path.startsWith('rules.')).map((path) => path.slice(6)),
  );
  if (!authored.size) return;
  if (authored.has('buttons')) {
    authored.add('buttonUrl');
    authored.add('buttonText');
  }
  if (authored.has('imageBase64') && !normalized.imageBase64) {
    authored.add('imageMimeType');
    authored.add('imageFileName');
  }
  const data = Object.fromEntries(Object.entries(normalized).filter(([key]) => authored.has(key)));
  // FLAG: Rules draft, ordinary settings flag, audit and durable operation receipt share
  // the caller's transaction. Publication ownership and published receipts are never copied.
  await advanceChatMutationOrder(tx, chatId, 'RULES');
  if (current) {
    const saved = await tx.chatRules.updateMany({
      where: { chatId, updatedAt: current.updatedAt },
      data,
    });
    if (saved.count !== 1) throw new ConflictException('Правила уже изменены.');
  } else {
    await tx.chatRules.create({ data: { chatId, ...data } });
  }
  await tx.auditLog.create({
    data: {
      chatId,
      actorUserId,
      action: 'UPDATE_CHAT_RULES',
      payload: { source: 'miniapp', settingKeys: [...authored], group: true },
    },
  });
}

export async function saveChatRulesDraft(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  chatId: string;
  actorUserId: string;
  body: unknown;
  source: AdminActionSource;
}): Promise<ChatRules> {
  const parsed = updateChatRulesRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const normalizedDraft = validateChatRulesDraft(parsed.data);

  const rulesUpdate = {
    ...normalizedDraft,
  };
  let upsertUniqueConflict: unknown;
  const writeDraft = () =>
    params.prisma.$transaction(async (tx) => {
      await advanceChatMutationOrder(tx, params.chatId, 'RULES');
      let rules: PersistedChatRules;
      try {
        if (parsed.data.expectedRevision === null) {
          if (await tx.chatRules.findUnique({ where: { chatId: params.chatId } }))
            throw new ConflictException('Правила уже изменены. Обновите экран.');
          rules = await tx.chatRules.create({
            data: { chatId: params.chatId, ...normalizedDraft },
          });
        } else if (parsed.data.expectedRevision) {
          const saved = await tx.chatRules.updateMany({
            where: { chatId: params.chatId, updatedAt: new Date(parsed.data.expectedRevision) },
            data: rulesUpdate,
          });
          if (saved.count !== 1)
            throw new ConflictException('Правила уже изменены. Обновите экран.');
          rules = await tx.chatRules.findUniqueOrThrow({ where: { chatId: params.chatId } });
        } else
          rules = await tx.chatRules.upsert({
            where: { chatId: params.chatId },
            create: { chatId: params.chatId, ...normalizedDraft },
            update: rulesUpdate,
          });
      } catch (error: unknown) {
        if (isPrismaKnownError(error, 'P2002')) upsertUniqueConflict = error;
        throw error;
      }
      await tx.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          action: 'UPDATE_CHAT_RULES',
          payload: {
            autoTextEnabled: normalizedDraft.autoTextEnabled,
            textFormat: normalizedDraft.textFormat,
            buttonEnabled: normalizedDraft.buttonEnabled,
            adminContactButtonEnabled: normalizedDraft.adminContactButtonEnabled,
            hasImage: Boolean(normalizedDraft.imageBase64),
            textLength: normalizedDraft.text.length,
            source: params.source,
          },
        },
      });
      return rules;
    });
  let rules: PersistedChatRules;
  try {
    rules = await writeDraft();
  } catch (error: unknown) {
    // FLAG: Only this exact upsert conflict may restart the fully rolled-back
    // transaction once. Audit/order failures cannot retry or continue an aborted tx.
    if (error !== upsertUniqueConflict || !isPrismaKnownError(error, 'P2002')) throw error;
    upsertUniqueConflict = undefined;
    rules = await writeDraft();
  }
  await params.chatContextCache.invalidate(params.chatId);

  return mapChatRules(rules);
}
