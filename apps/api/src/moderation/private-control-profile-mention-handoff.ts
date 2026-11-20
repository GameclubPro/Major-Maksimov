import type { MaxSendMessageOptions } from '../max/max-client.service';
import { escapePrivateHtml, escapePrivateHtmlAttribute } from './private-control-launcher-renderer';
export type PrivateProfileMentionMessage = {
  text: string;
  options: MaxSendMessageOptions;
};

export type PrivateProfileMentionHandoffPayload = {
  displayName: string;
  userId: string;
};

export function renderPrivateProfileMentionMessage(
  payload: PrivateProfileMentionHandoffPayload,
): PrivateProfileMentionMessage {
  const mentionText = `<a href="${escapePrivateHtmlAttribute(
    `max://user/${encodeURIComponent(payload.userId)}`,
  )}">${escapePrivateHtml(payload.displayName)}</a>`;

  return {
    text: `<strong>${escapePrivateHtml('Профиль пользователя')}</strong>\n${mentionText}`,
    options: {
      textFormat: 'html',
    },
  };
}
