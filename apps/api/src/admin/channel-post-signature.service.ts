import {
  assertFixedModeratorCapabilitiesForSettings,
  lockModeratorSettingsChat,
} from '../max/fixed-moderator-capabilities';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH,
  channelPostSignatureSettingsSchema,
  updateChannelPostSignatureRequestSchema,
  type ChannelPostSignatureSettings,
} from '@maxim/contracts';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import { renderMaxTextMarkupAsHtml } from '../common/max-text-markup.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxApiTrafficClass,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { hasConfirmedEditMessageAccess } from '../max/max-delete-message-access.util';
import { ChannelPostSignaturePresentation, ChatEntityType } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { NetworkSettingsWriteOptions } from './network-settings-write';
import { hasExecutionCapability } from '../max/max-execution-route-proof';

export const CHANNEL_POST_MAX_TEXT_LENGTH = 4_000;

export type ChannelPostText = {
  text: string;
  textFormat?: MaxSendMessageOptions['textFormat'];
  engagementText?: string;
};

@Injectable()
export class ChannelPostSignatureService {
  private readonly logger = new Logger(ChannelPostSignatureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
  ) {}

  async getSettings(
    chatId: string,
    db: Pick<PrismaService, 'channelSettings'> = this.prisma,
  ): Promise<ChannelPostSignatureSettings> {
    const settings = await db.channelSettings.findUnique({
      where: { chatId },
      select: {
        postSignatureEnabled: true,
        postSignaturePresentation: true,
        postSignatureText: true,
        postSignatureUrl: true,
        revision: true,
      },
    });
    return channelPostSignatureSettingsSchema.parse({
      enabled: settings?.postSignatureEnabled ?? false,
      presentation:
        settings?.postSignaturePresentation === ChannelPostSignaturePresentation.BUTTON
          ? 'button'
          : 'signature',
      text: settings?.postSignatureText ?? CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
      url: settings?.postSignatureUrl ?? '',
      revision: settings?.revision ?? 0,
    });
  }

  async updateSettings(
    chatId: string,
    actorUserId: string,
    body: unknown,
    networkWrite?: NetworkSettingsWriteOptions,
  ): Promise<ChannelPostSignatureSettings> {
    const parsed = updateChannelPostSignatureRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    await this.assertChannel(chatId);
    const current = await this.getSettings(chatId);
    if (current.revision !== parsed.data.expectedRevision) throw this.revisionConflict();
    const { expectedRevision, ...changes } = parsed.data;
    const validateNext = (currentSettings: ChannelPostSignatureSettings) => {
      const result = channelPostSignatureSettingsSchema.safeParse({
        ...currentSettings,
        ...changes,
      });
      if (!result.success) {
        throw new BadRequestException(result.error.format());
      }
      return result.data;
    };
    const preview = validateNext(current);
    if (preview.enabled && (networkWrite || parsed.data.enabled === true || !current.enabled)) {
      await this.assertEditAccessAvailable(chatId);
    }
    const channelLinkVerified = preview.enabled && !preview.url;
    if (channelLinkVerified) {
      await this.resolveChannelLink(chatId, 'interactive');
    }

    return this.prisma.$transaction(async (tx) => {
      // FLAG: Serialize partial updates even before a channel_settings row exists.
      // MAX preflight stays outside the transaction so network waits never hold this lock.
      const lockedChat = await lockModeratorSettingsChat(tx, chatId);
      const lockedCurrent = await this.getSettings(chatId, tx);
      if (lockedCurrent.revision !== expectedRevision) throw this.revisionConflict();
      const next = validateNext(lockedCurrent);
      if (next.enabled && !next.url && !channelLinkVerified) {
        throw new ConflictException('Настройки подписи изменились. Повторите сохранение.');
      }
      await assertFixedModeratorCapabilitiesForSettings(
        tx,
        lockedChat,
        next.enabled ? ['edit_message'] : [],
      );
      if (networkWrite?.validateOnly) return next;
      if (
        next.enabled === lockedCurrent.enabled &&
        next.presentation === lockedCurrent.presentation &&
        next.text === lockedCurrent.text &&
        next.url === lockedCurrent.url
      ) {
        await networkWrite?.onCommitted?.(tx, String(lockedCurrent.revision));
        return lockedCurrent;
      }
      const data = {
        postSignatureEnabled: next.enabled,
        postSignaturePresentation:
          next.presentation === 'button'
            ? ChannelPostSignaturePresentation.BUTTON
            : ChannelPostSignaturePresentation.SIGNATURE,
        postSignatureText: next.text,
        postSignatureUrl: next.url,
      };
      const exists = await tx.channelSettings.findUnique({
        where: { chatId },
        select: { revision: true },
      });
      if (exists) {
        const written = await tx.channelSettings.updateMany({
          where: { chatId, revision: expectedRevision },
          data: { ...data, revision: { increment: 1 } },
        });
        if (written.count !== 1) throw this.revisionConflict();
      } else {
        if (expectedRevision !== 0) throw this.revisionConflict();
        await tx.channelSettings.create({ data: { chatId, ...data, revision: 1 } });
      }
      const written = await tx.channelSettings.findUniqueOrThrow({
        where: { chatId },
        select: { revision: true },
      });
      await networkWrite?.onCommitted?.(tx, String(written.revision));
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId,
          action: 'UPDATE_CHANNEL_POST_SIGNATURE',
          payload: { settingKeys: Object.keys(changes) },
        },
      });
      return { ...next, revision: written.revision };
    });
  }

  private revisionConflict(): ConflictException {
    return new ConflictException({
      code: 'CHANNEL_SETTINGS_CONCURRENT_UPDATE',
      message: 'Настройки канала изменились. Обновите экран.',
    });
  }

  async assertNetworkSettingsEditingAccess(chatId: string): Promise<void> {
    await this.assertChannel(chatId);
    await this.assertEditAccessAvailable(chatId);
    const botId = await this.maxBotLinkService.resolveBotIdForSend({
      chatId,
      fallbackToPrimary: false,
    });
    if (!botId || this.maxBotLinkService.getExecutableBotById(botId)?.id !== botId)
      throw new BadRequestException(
        'Для этих настроек предоставьте боту право отправлять сообщения канала.',
      );
    let access;
    try {
      access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
        botId,
        bypassCache: true,
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        timeoutMs: 2_000,
      });
    } catch {
      throw new ServiceUnavailableException('Не удалось проверить права бота. Повторите позже.');
    }
    if (
      !hasExecutionCapability(
        { permissionsSnapshot: { ...access, checkedAt: null } },
        ChatEntityType.CHANNEL,
        'send_message',
      )
    )
      throw new BadRequestException(
        'Для этих настроек предоставьте боту право отправлять сообщения канала.',
      );
  }

  async preparePostText(
    chatId: string,
    input: ChannelPostText,
    options: {
      entityType?: 'chat' | 'channel';
      trafficClass?: MaxApiTrafficClass;
      sourceTag?: string;
      maxLength?: number;
      botId?: string;
    } = {},
  ): Promise<ChannelPostText & { signatureApplied: boolean }> {
    if (options.entityType === 'chat') {
      return { ...input, signatureApplied: false };
    }
    const settings = await this.getSettings(chatId);
    if (!settings.enabled || settings.presentation === 'button') {
      return { ...input, signatureApplied: false };
    }
    await this.assertChannel(chatId);
    const signatureUrl =
      settings.url ||
      (await this.resolveChannelLink(
        chatId,
        options.trafficClass ?? 'background',
        options.sourceTag,
        options.botId,
      ));
    const baseHtml =
      input.textFormat === 'html'
        ? input.text
        : input.textFormat === 'markdown'
          ? renderSupportedMarkdownAsHtml(input.text, { blockMode: 'raw' })
          : escapeMaxHtmlText(input.text);
    const signatureHtml = renderMaxTextMarkupAsHtml(settings.text, [
      { type: 'link', from: 0, length: settings.text.length, url: signatureUrl, userLink: null },
    ])!;
    const normalizedBaseHtml = baseHtml.trimEnd();
    const signatureAlreadyPresent = normalizedBaseHtml.endsWith(signatureHtml);
    // FLAG: Keep authored spaces and blank lines when appending the channel signature.
    const separator =
      !baseHtml || baseHtml.endsWith('\n\n') ? '' : baseHtml.endsWith('\n') ? '\n' : '\n\n';
    const text = signatureAlreadyPresent ? baseHtml : `${baseHtml}${separator}${signatureHtml}`;
    const maxLength = options.maxLength ?? CHANNEL_POST_MAX_TEXT_LENGTH;
    if (text.length > maxLength) {
      throw new BadRequestException(
        `Текст вместе с подписью слишком длинный. Максимум ${maxLength} символов.`,
      );
    }
    if (signatureAlreadyPresent) {
      return {
        ...input,
        text,
        textFormat: 'html',
        signatureApplied: false,
      };
    }
    const engagementText = [
      (input.engagementText ?? input.text).trim(),
      `[${escapeMarkdownLinkLabel(settings.text)}](${escapeMarkdownLinkDestination(signatureUrl)})`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { text, textFormat: 'html', engagementText, signatureApplied: true };
  }

  async buildPostButton(
    chatId: string,
    options: {
      entityType?: 'chat' | 'channel';
      trafficClass?: MaxApiTrafficClass;
      sourceTag?: string;
      botId?: string;
    } = {},
  ): Promise<MaxMessageButton | null> {
    if (options.entityType === 'chat') {
      return null;
    }
    const settings = await this.getSettings(chatId);
    if (!settings.enabled || settings.presentation !== 'button') {
      return null;
    }
    await this.assertChannel(chatId);
    const url =
      settings.url ||
      (await this.resolveChannelLink(
        chatId,
        options.trafficClass ?? 'background',
        options.sourceTag,
        options.botId,
      ));
    return {
      type: 'link',
      text: settings.text,
      url,
    };
  }

  async assertChannelLinkAvailable(
    chatId: string,
    trafficClass: MaxApiTrafficClass = 'interactive',
  ): Promise<void> {
    await this.assertChannel(chatId);
    const settings = await this.getSettings(chatId);
    if (settings.url) {
      return;
    }
    await this.resolveChannelLink(chatId, trafficClass);
  }

  private async assertChannel(chatId: string): Promise<void> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    if (chat?.entityType !== ChatEntityType.CHANNEL) {
      throw new BadRequestException('Подпись публикаций доступна только для канала.');
    }
  }

  private async assertEditAccessAvailable(chatId: string): Promise<void> {
    const candidates = await this.maxBotLinkService.resolveBotIdsForModerationAction({
      chatId,
      action: 'edit_message',
      fallbackToPrimary: false,
    });
    let lookupFailed = false;
    for (const botId of new Set(candidates)) {
      if (this.maxBotLinkService.getExecutableBotById(botId)?.id !== botId) continue;
      try {
        const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
          botId,
          bypassCache: true,
          trafficClass: 'interactive',
          sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
          timeoutMs: 2_000,
        });
        if (hasConfirmedEditMessageAccess({ ...access, checkedAt: null }, ChatEntityType.CHANNEL)) {
          return;
        }
      } catch {
        lookupFailed = true;
      }
    }
    if (lookupFailed) {
      throw new ServiceUnavailableException('Не удалось проверить права бота. Повторите позже.');
    }
    throw new BadRequestException(
      'Для подписи под постами предоставьте боту право редактировать сообщения канала.',
    );
  }

  private async resolveChannelLink(
    chatId: string,
    trafficClass: MaxApiTrafficClass,
    sourceTag: string = MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
    requiredBotId?: string,
  ): Promise<string> {
    try {
      const audienceSnapshot = await this.prisma.channelAudienceSnapshot.findFirst({
        where: { chatId, link: { not: null } },
        orderBy: { capturedAt: 'desc' },
        select: { link: true },
      });
      const knownLink = normalizeMaxChannelLink(audienceSnapshot?.link);
      if (knownLink) {
        return knownLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to read cached channel audience link');
    }

    try {
      const catalogEntry = await this.prisma.managedBotChatCatalog.findFirst({
        where: {
          chatId,
          entityType: ChatEntityType.CHANNEL,
          status: 'ACTIVE',
          link: { not: null },
        },
        orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
        select: { link: true },
      });
      const knownLink = normalizeMaxChannelLink(catalogEntry?.link);
      if (knownLink) {
        return knownLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to read cached managed channel link');
    }

    try {
      const botId = requiredBotId ?? (await this.maxBotLinkService.resolveBotIdForSend({ chatId }));
      if (!botId) {
        throw new Error('No bot can resolve the MAX channel link');
      }
      const snapshot = await this.maxClient.getChatSnapshot(chatId, {
        botId,
        trafficClass,
        sourceTag,
      });
      const resolvedLink = normalizeMaxChannelLink(snapshot.link);
      if (snapshot.entityType === 'channel' && resolvedLink) {
        return resolvedLink;
      }
    } catch (error) {
      this.logger.warn({ chatId, err: error }, 'Failed to resolve MAX channel post signature link');
      throw new ServiceUnavailableException('Не удалось получить ссылку канала. Повторите позже.');
    }

    throw new BadRequestException('У канала нет публичной ссылки MAX.');
  }
}

function normalizeMaxChannelLink(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (hostname !== 'max.ru' && hostname !== 'www.max.ru') ||
      Boolean(parsed.username || parsed.password || parsed.port) ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.protocol = 'https:';
    parsed.hostname = 'max.ru';
    parsed.hash = '';
    parsed.search = '';
    const canonical = parsed.toString();
    return escapeMaxHtmlAttribute(canonical).length <= CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH
      ? canonical
      : null;
  } catch {
    return null;
  }
}

function escapeMaxHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeMaxHtmlAttribute(value: string): string {
  return escapeMaxHtmlText(value).replace(/"/gu, '&quot;');
}

function escapeMarkdownLinkLabel(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\[/gu, '\\[').replace(/\]/gu, '\\]');
}

function escapeMarkdownLinkDestination(value: string): string {
  return value
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('[', '%5B')
    .replaceAll(']', '%5D');
}
