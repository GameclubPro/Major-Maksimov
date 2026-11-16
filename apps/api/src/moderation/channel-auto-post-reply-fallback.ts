import type { Logger } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import { CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION } from './moderation.service.support';

export function channelPostButtonUrlFailure(error: unknown): 'invalid_button_url' | null {
  const response = (
    error as {
      response?: { status?: unknown; data?: { code?: unknown; message?: unknown } };
    } | null
  )?.response;
  // FLAG: Classify only the exact definitive MAX response. Never infer retry safety from text alone.
  return response?.status === 400 &&
    response.data?.code === 'proto.payload' &&
    response.data.message === 'Must have only http/https links format in buttons'
    ? 'invalid_button_url'
    : null;
}

export type ChannelAutoPostTerminalSkipInput = {
  chatId: string;
  messageId: string;
  senderId: string | null;
  botId: string | null;
  linkType: string | null;
  source: 'webhook' | 'poll';
  deliveryMode: 'edit_message' | 'reply_message' | 'replace_with_bot_message';
  terminalEditAttemptExhausted?: boolean;
  status: number | null;
  error: unknown;
};

export function buildMaxMessageFallbackUrl(
  chatId: string,
  messageId: string | null,
): string | null {
  const normalizedChatId = chatId.trim();
  const normalizedMessageId = messageId?.trim() ?? '';
  if (!normalizedChatId || !normalizedMessageId) {
    return null;
  }
  return `https://max.ru/chats/${encodeURIComponent(normalizedChatId)}/message/${encodeURIComponent(
    normalizedMessageId,
  )}`;
}

export async function recordChannelAutoPostTerminalSkip(
  prisma: Pick<PrismaService, 'auditLog'>,
  logger: Pick<Logger, 'warn'>,
  input: ChannelAutoPostTerminalSkipInput,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        chatId: input.chatId,
        actorUserId: input.senderId ?? 'system',
        action: CHANNEL_DIALOG_AUTO_ATTACH_SKIP_ACTION,
        payload: {
          messageId: input.messageId,
          reason: 'terminal_delivery_failure',
          linkType: input.linkType,
          source: input.source,
          deliveryMode: input.deliveryMode,
          ...(input.terminalEditAttemptExhausted === true
            ? { terminalEditAttemptExhausted: true }
            : {}),
          ...(input.botId ? { botId: input.botId } : {}),
          status: input.status,
          error: channelPostButtonUrlFailure(input.error) ?? readErrorMessage(input.error),
        },
      },
    });
  } catch (skipError: unknown) {
    logger.warn(
      {
        chatId: input.chatId,
        messageId: input.messageId,
        error: skipError instanceof Error ? skipError.message : 'Unknown error',
      },
      'Failed to persist channel auto-post terminal skip marker',
    );
  }
}

function readErrorMessage(error: unknown): string {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  if (typeof value?.message === 'string' && value.message.trim().length > 0) {
    return value.message.trim();
  }
  return String(error ?? 'Unknown error');
}
