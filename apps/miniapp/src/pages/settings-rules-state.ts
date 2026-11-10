import {
  type ChatRules,
  type ChatSettingsScreenResponse,
  type PublishChatRulesRequest,
  type PublishChatRulesResult,
} from '@maxim/contracts/settings';
import type { UpdateChatRulesPayload } from '../lib/api/shared-types';

export type RulesPublicationMode = NonNullable<PublishChatRulesRequest['mode']>;

export function getRulesPublicationFeedback(
  result: Pick<PublishChatRulesResult, 'operation' | 'messageId'>,
  previousMessageId: string | null,
) {
  const operation =
    result.operation ?? (result.messageId === previousMessageId ? 'updated' : 'created');
  return operation === 'updated'
    ? {
        title: 'Прежний пост правил обновлён',
        description: 'Изменён прежний пост. Новое сообщение в чат не отправлялось.',
      }
    : {
        title: 'Новый пост правил опубликован',
        description: 'Новое сообщение отправлено в группу.',
      };
}

type RulesDraftSerializable = Pick<
  ChatRules,
  | 'text'
  | 'textFormat'
  | 'imageBase64'
  | 'imageMimeType'
  | 'imageFileName'
  | 'autoTextEnabled'
  | 'buttons'
  | 'buttonEnabled'
  | 'buttonUrl'
  | 'buttonText'
  | 'adminContactButtonEnabled'
  | 'adminContactButtonUrl'
> &
  Pick<
    UpdateChatRulesPayload,
    | 'text'
    | 'textFormat'
    | 'imageBase64'
    | 'imageMimeType'
    | 'imageFileName'
    | 'autoTextEnabled'
    | 'buttons'
    | 'buttonEnabled'
    | 'buttonUrl'
    | 'buttonText'
    | 'adminContactButtonEnabled'
    | 'adminContactButtonUrl'
  >;

export function serializeRulesDraftPayload(value: RulesDraftSerializable): string {
  return JSON.stringify({
    text: value.text,
    textFormat: value.textFormat,
    imageBase64: value.imageBase64,
    imageMimeType: value.imageMimeType,
    imageFileName: value.imageFileName,
    autoTextEnabled: value.autoTextEnabled,
    buttons: value.buttons,
    buttonEnabled: value.buttonEnabled,
    buttonUrl: value.buttonUrl,
    buttonText: value.buttonText,
    adminContactButtonEnabled: value.adminContactButtonEnabled,
    adminContactButtonUrl: value.adminContactButtonUrl,
  });
}

export function shouldHydrateRulesDraftFromServer(params: {
  currentDraft: ChatRules | null;
  previousServerSnapshot: string;
  nextServerDraft: ChatRules;
}): boolean {
  if (!params.currentDraft) {
    return true;
  }

  const currentSnapshot = serializeRulesDraftPayload(params.currentDraft);
  const nextServerSnapshot = serializeRulesDraftPayload(params.nextServerDraft);

  return (
    currentSnapshot === params.previousServerSnapshot || currentSnapshot === nextServerSnapshot
  );
}

export function mergeSavedRulesIntoSettingsScreen(
  current: ChatSettingsScreenResponse | undefined,
  saved: ChatRules,
): ChatSettingsScreenResponse | undefined {
  return current ? { ...current, rules: saved } : current;
}

export function mergeRulesPublicationIntoDraft(
  current: ChatRules | null,
  server: ChatRules,
  baseSnapshot: string,
): ChatRules {
  if (!current) return server;
  // FLAG: A receipt-only revision can advance a dirty draft; conflicting saved text cannot.
  return {
    ...current,
    ...(serializeRulesDraftPayload(server) === baseSnapshot ? { revision: server.revision } : {}),
    publishedMessageId: server.publishedMessageId,
    publishedUrl: server.publishedUrl,
    publishedAt: server.publishedAt,
  };
}

export async function runRulesSaveAttempt(params: {
  submittedDraft: ChatRules;
  save: () => Promise<ChatRules | null>;
  getCurrentDraft: () => ChatRules | null;
}): Promise<{ saved: ChatRules; isCurrent: boolean } | null> {
  const submittedSnapshot = serializeRulesDraftPayload(params.submittedDraft);
  const saved = await params.save();
  if (!saved) {
    return null;
  }

  const currentDraft = params.getCurrentDraft();
  if (!currentDraft) {
    return { saved, isCurrent: false };
  }

  const currentSnapshot = serializeRulesDraftPayload(currentDraft);
  return {
    saved,
    isCurrent:
      currentSnapshot === submittedSnapshot ||
      currentSnapshot === serializeRulesDraftPayload(saved),
  };
}
