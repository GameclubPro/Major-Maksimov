import type { BroadcastLinkButton, ManagedEntityType } from '@maxim/contracts';
import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import { MAX_API_SOURCE_TAGS, type MaxMessageButton } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import {
  buildManagedBroadcastLinkButtonRows,
  normalizeManagedBroadcastButtons,
} from './admin-managed-broadcast-buttons';
import {
  readManagedBroadcastLedgerCommentDialogContext,
  type ManagedBroadcastCommentDialogReference,
} from './admin-managed-broadcast-ledger';
import { ChannelPostSignatureService } from './channel-post-signature.service';

export type PublisherPreparedDialogContext = {
  version: 1;
  dialogBotId: string;
  buttons: MaxMessageButton[][];
  reference: ManagedBroadcastCommentDialogReference | null;
};

const MAX_PERSISTED_DIALOG_CONTEXT_BYTES = 64 * 1024;

export function readPublisherPreparedDialogContext(
  value: unknown,
  expectedDialogBotId: string,
): PublisherPreparedDialogContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_PERSISTED_DIALOG_CONTEXT_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  if (
    raw.version !== 1 ||
    raw.dialogBotId !== expectedDialogBotId ||
    !Array.isArray(raw.buttons) ||
    raw.buttons.some(
      (row) =>
        !Array.isArray(row) ||
        row.length === 0 ||
        row.some((button) => !button || typeof button !== 'object' || Array.isArray(button)),
    )
  ) {
    return null;
  }
  const parsedReference = readManagedBroadcastLedgerCommentDialogContext({
    ledgerContext: {
      managedBroadcast: { commentDialogReference: raw.reference ?? null },
    },
  });
  if (!parsedReference.found) {
    return null;
  }
  return {
    version: 1,
    dialogBotId: expectedDialogBotId,
    buttons: raw.buttons as MaxMessageButton[][],
    reference: parsedReference.reference,
  };
}

@Injectable()
export class PublisherDialogContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dialogLinks: PublisherDialogLinkService,
    @Optional() private readonly postSignature?: ChannelPostSignatureService,
  ) {}

  async prepare(params: {
    chatId: string;
    entityType: ManagedEntityType;
    dialogBotId: string;
    customButtons: readonly BroadcastLinkButton[];
    includeManagedDialogs?: boolean;
  }): Promise<PublisherPreparedDialogContext> {
    const customButtons = normalizeManagedBroadcastButtons(params.customButtons);
    let buttons = buildManagedBroadcastLinkButtonRows(
      customButtons,
      params.entityType === 'channel' ? { buttonsPerRow: 1 } : undefined,
    );
    const threadId = randomUUID();
    let reference: ManagedBroadcastCommentDialogReference | null = null;

    if (params.includeManagedDialogs === false) {
      return { version: 1, dialogBotId: params.dialogBotId, buttons, reference };
    }

    if (params.entityType === 'chat') {
      const settings = await this.prisma.publisherEntitySettings.upsert({
        where: { chatId: params.chatId },
        create: { chatId: params.chatId },
        update: {},
        select: { chatCommentsEnabled: true, chatCommentsPostsEnabled: true },
      });
      if (settings.chatCommentsEnabled && settings.chatCommentsPostsEnabled) {
        buttons.push([
          this.dialogLinks.buildChatDialogButton(
            params.chatId,
            'comments',
            threadId,
            formatCommentsButtonText('💬 Комментарии', 0),
          ),
        ]);
        reference = {
          entityType: 'chat',
          threadId,
          includeCommentsButton: true,
          includeSuggestButton: false,
          suggestButtonText: null,
          customButtons,
          suggestionEntryMode: null,
          botId: null,
          dialogBotId: params.dialogBotId,
          buttonRows: buttons.map((row) => row.map((button) => ({ ...button }))),
          commentsButton: {
            rowIndex: buttons.length - 1,
            columnIndex: 0,
            baseText: '💬 Комментарии',
          },
        };
      }
    } else {
      const settings = await this.prisma.publisherEntitySettings.upsert({
        where: { chatId: params.chatId },
        create: { chatId: params.chatId },
        update: {},
        select: { channelCommentsEnabled: true, channelSuggestionsEnabled: true },
      });
      const commentsText = '💬 Комментарии';
      const suggestText = '✍️ Предложить объявление';
      const commentsButton = settings.channelCommentsEnabled
        ? this.dialogLinks.buildChannelDialogButton(
            params.chatId,
            'comments',
            threadId,
            formatCommentsButtonText(commentsText, 0),
            'MINIAPP',
          )
        : null;
      const suggestButton = settings.channelSuggestionsEnabled
        ? this.dialogLinks.buildChannelDialogButton(
            params.chatId,
            'suggest',
            threadId,
            suggestText,
            'MINIAPP',
          )
        : null;
      const ctaButton =
        (await this.postSignature?.buildPostButton(params.chatId, {
          entityType: 'channel',
          botId: params.dialogBotId,
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
        })) ?? null;
      const channelButtonRows =
        (await this.postSignature?.buildCustomPostButtons(params.chatId, {
          entityType: 'channel',
        })) ?? [];
      const customButtonRows = [...channelButtonRows, ...buttons];
      buttons = buildChannelPostActionRows({
        commentsButton,
        suggestButton,
        ctaButton,
        customButtonRows,
      });
      if (settings.channelCommentsEnabled || settings.channelSuggestionsEnabled) {
        reference = {
          entityType: 'channel',
          threadId,
          includeCommentsButton: settings.channelCommentsEnabled,
          includeSuggestButton: settings.channelSuggestionsEnabled,
          suggestButtonText: settings.channelSuggestionsEnabled ? suggestText : null,
          customButtons,
          suggestionEntryMode: settings.channelSuggestionsEnabled ? 'MINIAPP' : null,
          botId: null,
          dialogBotId: params.dialogBotId,
          buttonRows: buttons.map((row) => row.map((button) => ({ ...button }))),
          commentsButton: settings.channelCommentsEnabled
            ? { rowIndex: 0, columnIndex: 0, baseText: commentsText }
            : null,
        };
      }
    }

    return { version: 1, dialogBotId: params.dialogBotId, buttons, reference };
  }

  read(value: unknown, expectedDialogBotId: string): PublisherPreparedDialogContext | null {
    return readPublisherPreparedDialogContext(value, expectedDialogBotId);
  }
}
