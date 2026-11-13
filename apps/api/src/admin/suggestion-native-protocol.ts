import type { MaxMessageButton } from '../max/max-client.service';

export const SUGGESTION_NATIVE_PREFIX = 'sr1|';
export const SUGGESTION_NATIVE_ACTIONS = [
  'publish',
  'edit',
  'reject',
  'back',
  'save',
  'hint',
  'paid',
  'details',
  'topic',
  'rules',
  'silent',
  'contact',
  'confirm_contact',
  'accept_format',
] as const;
export type SuggestionNativeAction = (typeof SUGGESTION_NATIVE_ACTIONS)[number];
export type SuggestionNativeCallback = {
  action: SuggestionNativeAction;
  id: string;
  revision: number;
  version: number;
};

export function suggestionNativeButton(
  text: string,
  action: SuggestionNativeAction,
  id: string,
  revision = 0,
  version = 0,
): MaxMessageButton {
  return {
    type: 'callback',
    text,
    payload: `${SUGGESTION_NATIVE_PREFIX}${action}|${id}|${revision}|${version}`,
  };
}

export function parseSuggestionNativeCallback(value: string): SuggestionNativeCallback | null {
  const match = /^sr1\|([a-z_]+)\|([A-Za-z0-9_-]{1,160})\|(\d{1,9})\|(\d{1,9})$/u.exec(value);
  if (!match || !SUGGESTION_NATIVE_ACTIONS.includes(match[1] as SuggestionNativeAction))
    return null;
  return {
    action: match[1] as SuggestionNativeAction,
    id: match[2]!,
    revision: Number(match[3]),
    version: Number(match[4]),
  };
}

export function suggestionNativeButtons(
  id: string,
  revision = 0,
  version = 0,
): MaxMessageButton[][] {
  return [
    [suggestionNativeButton('Опубликовать', 'publish', id, revision, version)],
    [
      suggestionNativeButton('Править', 'edit', id, revision, version),
      suggestionNativeButton('Отклонить', 'reject', id, revision, version),
    ],
  ];
}
