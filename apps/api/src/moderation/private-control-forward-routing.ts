import { MAX_BOT_SPEECH_TEXT_LENGTH, type MaxUpdate } from '@maxim/contracts';
import { BOT_SPEECH_EDITABLE_FIELD_KEYS } from '@maxim/contracts/bot-speech';
import {
  extractIncomingFormattedTextPayload,
  extractIncomingSuggestionTextPayload,
} from './private-control-markup-importer';
import type { PendingInput, PrivateSession } from './private-control.types';

const BOT_SPEECH_EDITABLE_FIELD_KEY_SET = new Set<string>(BOT_SPEECH_EDITABLE_FIELD_KEYS);

export function isBotSpeechEditableTextInput(
  pendingInput: PendingInput | null,
): pendingInput is Extract<PendingInput, { kind: 'set_field' }> {
  return (
    pendingInput?.kind === 'set_field' &&
    pendingInput.type === 'text' &&
    BOT_SPEECH_EDITABLE_FIELD_KEY_SET.has(String(pendingInput.key))
  );
}

export function resolvePrivateControlSetFieldInputText(
  pendingInput: PendingInput,
  update: MaxUpdate,
  fallbackText: string,
): string {
  if (!isBotSpeechEditableTextInput(pendingInput)) {
    return fallbackText;
  }

  const formattedText = extractIncomingFormattedTextPayload(update, fallbackText).text;
  return formattedText.length <= MAX_BOT_SPEECH_TEXT_LENGTH
    ? formattedText
    : extractIncomingSuggestionTextPayload(update, fallbackText).text;
}

export function shouldPreferActiveContentInputForForward(
  session: Pick<
    PrivateSession,
    | 'pendingInput'
    | 'pendingKaravanAllowlist'
    | 'screen'
    | 'selectedChatId'
    | 'selectedEntityType'
    | 'section'
  >,
  actorUserId: string,
  botId: string | null,
): boolean {
  const flow = session.pendingKaravanAllowlist;
  if (
    flow &&
    flow.actorUserId === actorUserId &&
    (!flow.botId || flow.botId === botId) &&
    flow.expiresAt > Date.now()
  )
    return true;
  const pendingInput = session.pendingInput;
  if (!pendingInput) {
    return false;
  }

  if (pendingInput.kind === 'channel_suggestion') {
    return pendingInput.chatId.trim().length > 0 && pendingInput.token.trim().length > 0;
  }

  const hasSelectedTarget = Boolean(session.selectedChatId?.trim() && session.selectedEntityType);
  if (!hasSelectedTarget) {
    return false;
  }

  if (pendingInput.kind === 'rules_text') {
    return session.screen === 'rules' && session.selectedEntityType === 'chat';
  }
  if (pendingInput.kind === 'broadcast_content' || pendingInput.kind === 'broadcast_text') {
    return session.screen === 'broadcast';
  }
  if (pendingInput.kind === 'giveaway_content') {
    return session.screen === 'giveaway';
  }
  if (isBotSpeechEditableTextInput(pendingInput)) {
    return (
      session.screen === 'section' &&
      session.selectedEntityType === 'chat' &&
      session.section === pendingInput.section
    );
  }

  return false;
}
