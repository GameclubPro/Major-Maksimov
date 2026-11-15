import { randomUUID } from 'node:crypto';
import type {
  BroadcastLinkButton,
  ChannelSettings,
  ChatSettings,
  ChannelDialogType,
  ManagedEntityType,
} from '@maxim/contracts';
import type { MaxMessageButton } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import type { ChannelPostSignatureService } from './channel-post-signature.service';
import {
  normalizeManagedBroadcastButtons,
  buildManagedBroadcastLinkButtonRows,
} from './admin-managed-broadcast-buttons';
import type {
  ManagedBroadcastButtonContextOptions,
  ManagedBroadcastButtonContextResult,
} from './admin-managed-broadcast-runtime-context';

export type ManagedBroadcastButtonDependencies = {
  prisma: PrismaService;
  channelPostSignatureService?: ChannelPostSignatureService;
  shouldIncludeChatCommentsButton(
    settings: Pick<ChatSettings, 'commentsEnabled' | 'commentsChatBroadcastsEnabled'>,
  ): boolean;
  buildChatDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
  ): MaxMessageButton;
  buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
    suggestionEntryMode?: ChannelSettings['postSuggestionsEntryMode'],
  ): MaxMessageButton;
};

export async function resolveManagedBroadcastButtonContext(
  dependencies: ManagedBroadcastButtonDependencies,
  chatId: string,
  entityType: ManagedEntityType,
  options: ManagedBroadcastButtonContextOptions,
  botId?: string,
): Promise<ManagedBroadcastButtonContextResult> {
  const customButtons = normalizeManagedBroadcastButtons(options.customButtons, {
    buttonEnabled: options.includeCustomButton,
    buttonUrl: options.customButtonUrl,
    buttonText: options.customButtonText,
  });
  const customButtonRows = buildManagedBroadcastLinkButtonRows(
    customButtons,
    entityType === 'channel' ? { buttonsPerRow: 1 } : undefined,
  );

  if (entityType === 'chat') {
    const chatSettings = await dependencies.prisma.chatSettings.upsert({
      where: { chatId },
      create: { chatId },
      update: {},
      select: {
        commentsEnabled: true,
        commentsAdminsEnabled: true,
        commentsAllEnabled: true,
        commentsChatBroadcastsEnabled: true,
      },
    });
    const threadId = randomUUID();
    let commentDialogReference: {
      entityType: ManagedEntityType;
      threadId: string;
      includeCommentsButton: boolean;
      includeSuggestButton: boolean;
      suggestButtonText: string | null;
      customButtons: BroadcastLinkButton[];
      suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
      botId: string | null;
    } | null = null;

    if (dependencies.shouldIncludeChatCommentsButton(chatSettings)) {
      customButtonRows.push([
        dependencies.buildChatDialogButton(
          chatId,
          'comments',
          threadId,
          formatCommentsButtonText('💬 Комментарии', 0),
          botId,
        ),
      ]);
      commentDialogReference = {
        entityType: 'chat',
        threadId,
        includeCommentsButton: true,
        includeSuggestButton: false,
        suggestButtonText: null,
        customButtons,
        suggestionEntryMode: null,
        botId: botId ?? null,
      };
    }

    return {
      buttons: customButtonRows,
      commentDialogReference,
    };
  }

  if (entityType !== 'channel') {
    return {
      buttons: customButtonRows,
      commentDialogReference: null,
    };
  }

  const channelSettings = await dependencies.prisma.channelSettings.upsert({
    where: { chatId },
    create: {
      chatId,
      commentsEnabled: false,
    },
    update: {},
    select: {
      postSuggestionsEnabled: true,
      postSuggestionsEntryMode: true,
      postSuggestionsButtonText: true,
      commentsEnabled: true,
    },
  });
  const threadId = randomUUID();
  const includeCommentsButton = channelSettings.commentsEnabled;
  const includeSuggestButton = channelSettings.postSuggestionsEnabled;
  const suggestButtonText =
    channelSettings.postSuggestionsButtonText.trim() || '📰 Предложить пост';

  const commentsButton = includeCommentsButton
    ? dependencies.buildChannelDialogButton(
        chatId,
        'comments',
        threadId,
        formatCommentsButtonText('💬 Комментарии', 0),
        botId,
      )
    : null;
  const suggestButton = includeSuggestButton
    ? dependencies.buildChannelDialogButton(
        chatId,
        'suggest',
        threadId,
        suggestButtonText,
        botId,
        channelSettings.postSuggestionsEntryMode,
      )
    : null;
  const ctaButton = await dependencies.channelPostSignatureService?.buildPostButton(chatId, {
    entityType: 'channel',
    trafficClass: 'background',
    sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
  });
  const channelButtonRows =
    (await dependencies.channelPostSignatureService?.buildCustomPostButtons(chatId, {
      entityType: 'channel',
    })) ?? [];
  const rows = buildChannelPostActionRows({
    commentsButton,
    suggestButton,
    ctaButton,
    customButtonRows: [...channelButtonRows, ...customButtonRows],
  });

  return {
    buttons: rows,
    commentDialogReference:
      includeCommentsButton || includeSuggestButton
        ? {
            entityType: 'channel',
            threadId,
            includeCommentsButton,
            includeSuggestButton,
            suggestButtonText: includeSuggestButton ? suggestButtonText : null,
            customButtons,
            suggestionEntryMode: channelSettings.postSuggestionsEntryMode,
            botId: botId ?? null,
            buttonRows: rows.map((row) => row.map((button) => ({ ...button }))),
            commentsButton: includeCommentsButton
              ? { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' }
              : null,
          }
        : null,
  };
}
