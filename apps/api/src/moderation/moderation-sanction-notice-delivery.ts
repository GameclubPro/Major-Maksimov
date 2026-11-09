import { withMarketplaceModerationMessage } from '../max/marketplace-publication-button';
import type { BotSpeechStyle } from '@maxim/contracts/bot-speech';
import type {
  MaxActionDispatchOptions,
  MaxActionLedgerContext,
  MaxSendMessageOptions,
} from '../max/max-client.service';
import { withModerationReleaseButton } from './moderation-release-callback.util';
import { warnModerationEffectFailure } from './moderation-effect-failure-diagnostics';

export type ModerationNoticeImmediateOptions = {
  immediate?: boolean;
  immediateFailurePolicy?: MaxActionDispatchOptions['immediateFailurePolicy'];
  beforeImmediateSendMutation?: (beforeFinalAuthority?: () => Promise<void>) => Promise<void>;
};

export type SanctionNoticeParams = {
  chatId: string;
  userId: string;
  messageId: string;
  userLabel: string;
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
  botMessageOptions?: MaxSendMessageOptions;
  sanctionNoticeText?: string;
  bypassNoticeBucket?: boolean;
  idempotencyKey?: string;
  rethrowOnFailure?: boolean;
  botSpeechStyle: BotSpeechStyle | null;
  botId?: string;
  sanctionEventId?: string | null;
  beforeSend?: () => Promise<void>;
  ledgerContext?: MaxActionLedgerContext;
  noticeDispatchOptions?: ModerationNoticeImmediateOptions;
};

export async function deliverSanctionNotice(params: {
  notice: SanctionNoticeParams;
  action: 'UNMUTE' | 'UNBAN';
  text: string;
  send: (
    input: {
      chatId: string;
      botId?: string;
      text: string;
      messageOptions?: MaxSendMessageOptions;
      deleteBotMessagesEnabled: boolean;
      deleteBotMessagesDelayMinutes: number;
      userFacing: true;
      bypassNoticeBucket?: boolean;
      idempotencyKey?: string;
      beforeSend?: () => Promise<void>;
      ledgerContext?: MaxActionLedgerContext;
    } & ModerationNoticeImmediateOptions,
  ) => Promise<boolean>;
  logger: { warn: (data: Record<string, unknown>, message: string) => void };
}): Promise<void> {
  const input = params.notice;
  try {
    await params.send({
      ...input.noticeDispatchOptions,
      chatId: input.chatId,
      botId: input.botId,
      text: params.text,
      messageOptions: withMarketplaceModerationMessage(
        input.sanctionEventId
          ? withModerationReleaseButton(input.botMessageOptions, {
              action: params.action,
              sanctionEventId: input.sanctionEventId,
            })
          : input.botMessageOptions,
        input.chatId,
        'MODERATION_NOTICE',
      ),
      deleteBotMessagesEnabled: input.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: input.deleteBotMessagesDelayMinutes,
      userFacing: true,
      bypassNoticeBucket: input.bypassNoticeBucket,
      idempotencyKey: input.idempotencyKey,
      beforeSend: input.beforeSend,
      // FLAG: Generic notices retain exact source identity for permanent legacy holds.
      // Completed SEND receipts settle before these identities can deny a new dispatch.
      ledgerContext: {
        ...input.ledgerContext,
        moderationSource: {
          version: 1,
          chatId: input.chatId,
          messageId: input.messageId,
          userId: input.userId,
        },
      },
    });
  } catch (error) {
    warnModerationEffectFailure(
      params.logger,
      { chatId: input.chatId, userId: input.userId, messageId: input.messageId },
      error,
      params.action === 'UNMUTE'
        ? 'Failed to send mute notice message'
        : 'Failed to send permanent ban notice message',
    );
    if (input.rethrowOnFailure) throw error;
  }
}
