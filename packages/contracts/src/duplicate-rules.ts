import type { ChatSettings } from './core.js';
import {
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateIntervalWindowSec,
  resolveDuplicateTextRuleSubjects,
  type DuplicatePhotoModerationMode,
} from './duplicate-settings.js';

export type DuplicateRulesSettings = Pick<
  ChatSettings,
  | 'antiDuplicateEnabled'
  | 'duplicateWindowMode'
  | 'duplicateStartTimeMinutes'
  | 'duplicateEndTimeMinutes'
  | 'duplicateTimezone'
  | 'duplicateCompareMode'
  | 'duplicatePhotoScope'
  | 'duplicateDetectionPreset'
  | 'duplicateIgnoreLinksEnabled'
  | 'duplicateIgnorePhonesEnabled'
  | 'duplicateNearMatchEnabled'
  | 'duplicateBotMessageEnabled'
  | 'duplicateWarnEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateBanEnabled'
  | 'duplicateWarnMaxCount'
  | 'duplicateMuteMaxCount'
  | 'duplicateBanMaxCount'
  | 'duplicateWarnWindowSec'
  | 'duplicateMuteWindowSec'
  | 'duplicateBanWindowSec'
>;

/** Describes validated settings for newly generated rules; never modifies saved manual text. */
export function buildDuplicateRulesTextItems(
  settings: DuplicateRulesSettings,
  photoModerationMode?: DuplicatePhotoModerationMode,
): string[] {
  if (!settings.antiDuplicateEnabled) return [];

  const items: string[] = [];
  if (settings.duplicateWindowMode === 'DAILY') {
    items.push(
      `Антидубль действует ежедневно с ${formatTime(settings.duplicateStartTimeMinutes)} до ${formatTime(settings.duplicateEndTimeMinutes)}${settings.duplicateStartTimeMinutes > settings.duplicateEndTimeMinutes ? ' следующего дня' : ''} (${settings.duplicateTimezone}). Вне этого периода повторы разрешены.`,
    );
  } else {
    const seconds = resolveDuplicateIntervalWindowSec(settings);
    const duration = seconds % 3_600 === 0 ? `${seconds / 3_600} ч` : `${seconds} сек`;
    items.push(
      `Повторы учитываются в течение ${duration} с принятого оригинала. Удалённые повторы не продлевают этот срок.`,
    );
  }
  const subjects = resolveDuplicateTextRuleSubjects(settings);
  const subject =
    subjects.length < 2
      ? (subjects[0] ?? '')
      : `${subjects.slice(0, -1).join(', ')} и ${subjects.at(-1)}`;
  const allowedCount = resolveDuplicateFlowAllowedCount(settings);
  items.push(
    allowedCount === 0
      ? `Не отправляйте ${subject}.`
      : `Не отправляйте ${subject}: бот среагирует после ${allowedCount} ${allowedCount === 1 ? 'дубля' : 'дублей'}.`,
  );

  // FLAG: Verified images supplement text in the unified rule; retired selectors have no authority.
  if (photoModerationMode === 'FULL') {
    items.push(
      settings.duplicatePhotoScope === 'CHAT'
        ? 'Одинаковые картинки считаются повтором независимо от автора и подписи. Действует общая цепочка антидубля; счётчик отдельный для каждого участника.'
        : 'Одинаковые картинки одного участника считаются повтором независимо от подписи. Действует общая цепочка антидубля.',
    );
  }
  return items;
}

function formatTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
