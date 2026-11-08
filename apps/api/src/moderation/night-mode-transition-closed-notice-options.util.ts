import { randomUUID } from 'node:crypto';
import type { MaxMessageButton, MaxSendMessageOptions } from '../max/max-client.service';
import { NIGHT_MODE_COMMENT_THREAD_PREFIX } from '../common/night-mode-comment-thread.util';

export type NightModeCommentsButtonBuilder = (params: {
  chatId: string;
  threadId: string;
  text: string;
}) => MaxMessageButton;

export function buildNightModeClosedNoticeOptions(params: {
  baseOptions: MaxSendMessageOptions | null;
  commentsButton: MaxMessageButton | null;
}): MaxSendMessageOptions | null {
  if (!params.commentsButton) {
    return params.baseOptions;
  }

  const buttons: MaxMessageButton[][] = [[params.commentsButton]];
  if (params.baseOptions?.buttons?.length) {
    buttons.push(...params.baseOptions.buttons);
  } else if (params.baseOptions?.button) {
    buttons.push([params.baseOptions.button]);
  }

  return {
    buttons,
    ...(params.baseOptions?.messageLink ? { messageLink: params.baseOptions.messageLink } : {}),
    ...(params.baseOptions?.debugContext ? { debugContext: params.baseOptions.debugContext } : {}),
  };
}

export function buildNightModeCommentsButton(params: {
  chatId: string;
  nightModeCommentsEnabled: boolean;
  buildButton: NightModeCommentsButtonBuilder;
  createThreadId?: () => string;
}): MaxMessageButton | null {
  if (!params.nightModeCommentsEnabled) {
    return null;
  }

  return params.buildButton({
    chatId: params.chatId,
    threadId: `${NIGHT_MODE_COMMENT_THREAD_PREFIX}${params.createThreadId?.() ?? randomUUID()}`,
    text: '💬 Комментарии',
  });
}
