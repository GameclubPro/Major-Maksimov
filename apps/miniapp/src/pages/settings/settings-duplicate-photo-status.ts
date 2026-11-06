import type {
  ChatSettings,
  DuplicatePhotoEffectivePolicy,
  DuplicatePhotoModerationMode,
  DuplicatePhotoPolicyMatrix,
} from '@maxim/contracts/settings';
import {
  formatDuplicateAllowanceLabel,
  formatDuplicateWindowLabel,
  resolveDuplicateAllowedCount,
} from './settings-duplicate-flow';
import {
  formatDuplicatePhotoScopeSummary,
  type DuplicatePhotoScope,
} from './settings-duplicate-photo-options';

export type DuplicatePhotoPresentationPolicy = DuplicatePhotoEffectivePolicy;

export function formatDuplicateSettingsSummary(
  settings: ChatSettings | null,
  windowHours: number,
  photoPolicy?: DuplicatePhotoEffectivePolicy,
): string {
  if (!settings?.antiDuplicateEnabled) return 'Выключено';
  const photo =
    photoPolicy && resolveDuplicatePhotoPresentationPolicy(photoPolicy).moderationMode === 'FULL'
      ? ' • картинки включены'
      : ' • картинки недоступны';
  return `${formatDuplicateAllowanceLabel(resolveDuplicateAllowedCount(settings))} • ${formatDuplicateWindowLabel(settings, windowHours)}${photo}`;
}

export function resolveDuplicatePhotoPresentationPolicy(
  policy: DuplicatePhotoEffectivePolicy,
): DuplicatePhotoPresentationPolicy {
  return {
    moderationMode:
      policy.moderationMode === 'FULL' && policy.allowedMatchKinds.includes('canonical_sha256')
        ? 'FULL'
        : 'OFF',
    actionCeiling: 'BAN',
    allowedMatchKinds: policy.allowedMatchKinds.includes('canonical_sha256')
      ? ['canonical_sha256']
      : [],
  };
}

export function resolveDuplicatePhotoPolicyForDraft(
  matrix: DuplicatePhotoPolicyMatrix | undefined,
  legacyMode: DuplicatePhotoModerationMode,
): DuplicatePhotoEffectivePolicy {
  return resolveDuplicatePhotoPresentationPolicy(
    matrix?.base ?? {
      moderationMode: legacyMode,
      actionCeiling: 'DELETE_MESSAGE',
      allowedMatchKinds:
        legacyMode === 'FULL' || legacyMode === 'DELETE_ONLY' ? ['canonical_sha256'] : [],
    },
  );
}

export function formatDuplicatePhotoCoverageLabel(
  textLabel: string,
  enabled: boolean,
  policy: DuplicatePhotoPresentationPolicy,
): string {
  return `Текст: ${textLabel}${enabled ? (policy.moderationMode === 'FULL' ? ' • одинаковые картинки: включены' : ' • картинки: недоступно') : ''}`;
}

export function formatDuplicatePhotoModerationHint(
  policy: DuplicatePhotoPresentationPolicy,
  scope: DuplicatePhotoScope,
): string {
  return policy.moderationMode === 'FULL'
    ? `Поиск повторов картинок: ${formatDuplicatePhotoScopeSummary(scope).toLowerCase()}.`
    : 'Удаление одинаковых картинок сейчас недоступно.';
}

export function formatDuplicateActionSummary(
  settings: Pick<
    ChatSettings,
    | 'duplicatePhotoScope'
    | 'duplicateBotMessageEnabled'
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
    | 'duplicateMuteDurationHours'
  >,
  allowedCount: number,
  photoPolicy: DuplicatePhotoPresentationPolicy,
): string {
  const firstRemoved = Math.max(2, Math.round(allowedCount) + 2);
  let next = firstRemoved + (settings.duplicateBotMessageEnabled ? 1 : 0);
  const actions: string[] = [];
  if (settings.duplicateWarnEnabled) actions.push(`предупреждение с №${next++}`);
  if (settings.duplicateMuteEnabled)
    actions.push(
      `ограничение на ${Math.max(1, Math.round(settings.duplicateMuteDurationHours))} ч с №${next++}`,
    );
  if (settings.duplicateBanEnabled) actions.push(`блокировка с №${next}`);
  return [
    `Повторы удаляются с сообщения №${firstRemoved}.`,
    settings.duplicateBotMessageEnabled ? 'Бот объясняет первое удаление.' : '',
    actions.length
      ? `Дальнейшие действия: ${actions.join('; ')}.`
      : 'Предупреждения и ограничения выключены.',
    formatDuplicatePhotoModerationHint(photoPolicy, settings.duplicatePhotoScope),
  ]
    .filter(Boolean)
    .join(' ');
}
