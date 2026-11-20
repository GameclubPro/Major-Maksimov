import { isVkAutomaticSource } from './model';
import type { VkParsingSettings, VkParsingSource } from '@maxim/contracts/vk-parsing';

export type AutopostStatusTone = 'success' | 'warning' | 'danger' | 'muted';
export type AutopostStatusModel = { title: string; reason: string; tone: AutopostStatusTone };

export function timeMinutes(value: string | null): number | null {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/u.exec(value ?? '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function withinRange(now: number, start: string | null, end: string | null): boolean {
  const from = timeMinutes(start);
  const to = timeMinutes(end);
  if (from === null || to === null) return false;
  if (from === to) return true;
  return from < to ? now >= from && now < to : now >= from || now < to;
}

export function buildAutopostStatus(
  settings: VkParsingSettings,
  sources: VkParsingSource[],
  now = new Date(),
): AutopostStatusModel {
  if (settings.autoPublishKillSwitchEnabled) {
    return { title: 'На паузе', reason: '', tone: 'muted' };
  }
  if (!settings.autoPublishEnabled) {
    return { title: 'Ручной режим', reason: '', tone: 'muted' };
  }
  const active = sources.filter((source) => source.status === 'ACTIVE' && source.importEnabled);
  if (!active.length) {
    return {
      title: 'Нет источников',
      reason: '',
      tone: 'warning',
    };
  }
  if (
    active.every((source) => source.publishMode === 'REVIEW' || source.publishMode === 'BOT_REVIEW')
  ) {
    return {
      title: 'На проверке',
      reason: 'Все группы требуют подтверждения',
      tone: 'muted',
    };
  }
  const blocked = active.filter((source) => source.autoPublishPausedReason === 'circuit_breaker');
  const automatic = active.filter(isVkAutomaticSource);
  if (!automatic.length && blocked.length) {
    return { title: 'Сработала защита', reason: '', tone: 'danger' };
  }
  if (!automatic.length) {
    return {
      title: 'Авто не настроено',
      reason: 'У групп выбрана ручная отправка',
      tone: 'warning',
    };
  }

  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: settings.schedulerTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    minutes =
      Number(parts.find((part) => part.type === 'hour')?.value) * 60 +
      Number(parts.find((part) => part.type === 'minute')?.value);
  } catch {
    return {
      title: 'Проверьте время',
      reason: 'Часовой пояс недоступен на устройстве',
      tone: 'warning',
    };
  }
  if (!withinRange(minutes, settings.workHoursStart, settings.workHoursEnd)) {
    return {
      title: 'Ожидает расписания',
      reason: `Рабочее время ${settings.workHoursStart} - ${settings.workHoursEnd}`,
      tone: 'muted',
    };
  }
  if (withinRange(minutes, settings.quietHoursStart, settings.quietHoursEnd)) {
    return {
      title: 'Тихие часы',
      reason: `Пауза ${settings.quietHoursStart} - ${settings.quietHoursEnd}`,
      tone: 'muted',
    };
  }
  const available = automatic.filter(
    (source) => !withinRange(minutes, source.quietHoursStart, source.quietHoursEnd),
  );
  if (!available.length) {
    return {
      title: 'Источники на паузе',
      reason: 'Перерыв по расписанию групп',
      tone: 'warning',
    };
  }
  const errors = automatic.filter(
    (source) => source.syncStatus === 'ERROR' || source.circuitOpenedAt !== null,
  );
  if (errors.length || blocked.length) {
    return {
      title: 'Требует внимания',
      reason: errors.length ? 'Проверьте группы с ошибками' : '',
      tone: 'warning',
    };
  }
  return {
    title: 'Авто включено',
    reason: '',
    tone: 'success',
  };
}
