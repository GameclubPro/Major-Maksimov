import { AppIcon as IconoirSprite } from '../ui/app-icon';
import { useEffect, useState } from 'react';

import type {
  UpdateVkParsingSettingsRequest,
  VkParsingSettings,
} from '@maxim/contracts/vk-parsing';
import {
  hydrateMirroredItem,
  readLocalMirrorItem,
  saveMirroredItem,
} from '../../lib/native-storage';
import { timeMinutes } from './autopost-status';
import { TimeField } from '../ui/time-field';
import { formatTimezoneLabel } from '../../lib/timezone-label';
import { VkInfoButton } from './info-button';
import { vkAllDayScheduleUpdate } from './workflow';
import { VkSettingSwitch } from './setting-switch';

const TIMEZONES = [
  ['Europe/Kaliningrad', 'Калининград'],
  ['Europe/Moscow', 'Москва'],
  ['Europe/Samara', 'Самара'],
  ['Asia/Yekaterinburg', 'Екатеринбург'],
  ['Asia/Omsk', 'Омск'],
  ['Asia/Krasnoyarsk', 'Красноярск'],
  ['Asia/Irkutsk', 'Иркутск'],
  ['Asia/Yakutsk', 'Якутск'],
  ['Asia/Vladivostok', 'Владивосток'],
  ['Asia/Magadan', 'Магадан'],
  ['Asia/Kamchatka', 'Камчатка'],
  ['UTC', 'Всемирное время'],
] as const;

export function VkTimeRange({
  label,
  start,
  end,
  optional = false,
  disabled,
  onSave,
}: {
  label: string;
  start: string | null;
  end: string | null;
  optional?: boolean;
  disabled: boolean;
  onSave: (start: string | null, end: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState({ start: start ?? '', end: end ?? '' });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setDraft({ start: start ?? '', end: end ?? '' });
  }, [editing, start, end]);
  const dirty = draft.start !== (start ?? '') || draft.end !== (end ?? '');
  const incomplete =
    Boolean(draft.start) !== Boolean(draft.end) || (!optional && (!draft.start || !draft.end));
  const scheduleNote = incomplete
    ? 'Укажите начало и конец'
    : !draft.start && !draft.end
      ? 'Нет перерыва'
      : draft.start === draft.end
        ? optional
          ? 'Публикации остановлены на весь день'
          : 'Круглосуточно'
        : draft.start > draft.end
          ? 'Через полночь'
          : null;
  async function save() {
    if (disabled || saving || incomplete) return;
    setSaving(true);
    try {
      if (await onSave(draft.start || null, draft.end || null)) setEditing(false);
    } finally {
      setSaving(false);
    }
  }
  return (
    <fieldset className="vk-time-range" disabled={disabled || saving}>
      <legend>{label}</legend>
      <div className="vk-time-range__fields">
        <TimeField
          label={`${label}: с`}
          value={draft.start}
          allowEmpty={optional}
          variant="compact"
          disabled={disabled || saving}
          onChange={(value) => {
            setEditing(true);
            setDraft((current) => ({ ...current, start: value }));
          }}
        />
        <span aria-hidden>:</span>
        <TimeField
          label={`${label}: до`}
          value={draft.end}
          allowEmpty={optional}
          variant="compact"
          disabled={disabled || saving}
          onChange={(value) => {
            setEditing(true);
            setDraft((current) => ({ ...current, end: value }));
          }}
        />
      </div>
      {scheduleNote || dirty || (optional && (draft.start || draft.end)) ? (
        <div className="vk-time-range__footer">
          {scheduleNote ? (
            <span role={incomplete ? 'status' : undefined}>{scheduleNote}</span>
          ) : null}
          {optional && (draft.start || draft.end) ? (
            <button
              type="button"
              title="Отключить тихие часы"
              aria-label="Отключить тихие часы"
              onClick={() => {
                setEditing(true);
                setDraft({ start: '', end: '' });
              }}
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
            </button>
          ) : null}
          {dirty ? (
            <button
              type="button"
              disabled={incomplete}
              aria-label={`Сохранить: ${label}`}
              title="Сохранить время"
              onClick={() => void save()}
            >
              <IconoirSprite variant="iconoir" icon="Check" aria-hidden />
              <span>{saving ? 'Сохраняю' : 'Сохранить'}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

type ScheduleWindow = Pick<
  VkParsingSettings,
  'workHoursStart' | 'workHoursEnd' | 'quietHoursStart' | 'quietHoursEnd'
>;

function readPreviousScheduleWindow(value: string | null): ScheduleWindow | null {
  if (!value) return null;
  try {
    const { workHoursStart, workHoursEnd, quietHoursStart, quietHoursEnd } = JSON.parse(value);
    if (
      typeof workHoursStart !== 'string' ||
      timeMinutes(workHoursStart) === null ||
      typeof workHoursEnd !== 'string' ||
      timeMinutes(workHoursEnd) === null ||
      (quietHoursStart !== null &&
        (typeof quietHoursStart !== 'string' || timeMinutes(quietHoursStart) === null)) ||
      (quietHoursEnd !== null &&
        (typeof quietHoursEnd !== 'string' || timeMinutes(quietHoursEnd) === null)) ||
      (quietHoursStart === null) !== (quietHoursEnd === null) ||
      (workHoursStart === workHoursEnd && quietHoursStart === null)
    )
      return null;
    return { workHoursStart, workHoursEnd, quietHoursStart, quietHoursEnd };
  } catch {
    return null;
  }
}

export function ScheduleTimePanel({
  settings,
  storageKey,
  disabled,
  onUpdate,
}: {
  settings: VkParsingSettings;
  storageKey: string;
  disabled: boolean;
  onUpdate: (payload: UpdateVkParsingSettingsRequest) => Promise<boolean>;
}) {
  const allDay =
    settings.workHoursStart === settings.workHoursEnd &&
    !settings.quietHoursStart &&
    !settings.quietHoursEnd;
  const { workHoursStart, workHoursEnd, quietHoursStart, quietHoursEnd } = settings;
  const [storedWindow, setStoredWindow] = useState(() =>
    readPreviousScheduleWindow(readLocalMirrorItem(storageKey)),
  );
  useEffect(() => {
    if (!allDay) return;
    let alive = true;
    void hydrateMirroredItem(storageKey).then((value) => {
      if (alive) setStoredWindow(readPreviousScheduleWindow(value));
    });
    return () => {
      alive = false;
    };
  }, [allDay, storageKey]);
  async function toggleAllDay(checked: boolean) {
    if (!checked) {
      return onUpdate(
        storedWindow ?? {
          workHoursStart: '09:00',
          workHoursEnd: '22:00',
          quietHoursStart: null,
          quietHoursEnd: null,
        },
      );
    }
    const previous = { workHoursStart, workHoursEnd, quietHoursStart, quietHoursEnd };
    const saved = await onUpdate(vkAllDayScheduleUpdate());
    if (saved) {
      saveMirroredItem(storageKey, JSON.stringify(previous));
      setStoredWindow(previous);
    }
    return saved;
  }
  return (
    <div className="vk-schedule-time-panel">
      <div className="vk-section-heading">
        <h3>Когда публиковать</h3>
        <VkInfoButton title="О времени публикаций">
          <p>
            Часы относятся только к автоматической публикации в чат или канал. Согласование в личке
            работает круглосуточно.
          </p>
          <p>
            Перерыв запрещает отправку внутри выбранного промежутка. Его начало и конец сохраняются
            вместе.
          </p>
        </VkInfoButton>
      </div>
      <VkSettingSwitch
        label="Круглосуточно"
        checked={allDay}
        disabled={disabled}
        onChange={toggleAllDay}
      />
      <label className="vk-timezone-field">
        <span>Часовой пояс</span>
        <select
          aria-label="Часовой пояс автопостинга"
          value={settings.schedulerTimezone}
          disabled={disabled}
          onChange={(event) => void onUpdate({ schedulerTimezone: event.target.value })}
        >
          {!TIMEZONES.some(([zone]) => zone === settings.schedulerTimezone) ? (
            <option value={settings.schedulerTimezone}>
              {formatTimezoneLabel(settings.schedulerTimezone)}
            </option>
          ) : null}
          {TIMEZONES.map(([zone, label]) => (
            <option key={zone} value={zone}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {!allDay ? (
        <VkTimeRange
          label="Время публикаций"
          start={settings.workHoursStart}
          end={settings.workHoursEnd}
          disabled={disabled}
          onSave={(workHoursStart, workHoursEnd) =>
            onUpdate({ workHoursStart: workHoursStart!, workHoursEnd: workHoursEnd! })
          }
        />
      ) : null}
      <VkTimeRange
        label="Перерыв в публикациях"
        start={settings.quietHoursStart}
        end={settings.quietHoursEnd}
        optional
        disabled={disabled}
        onSave={(quietHoursStart, quietHoursEnd) => onUpdate({ quietHoursStart, quietHoursEnd })}
      />
    </div>
  );
}
