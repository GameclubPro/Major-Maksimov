import { useId, useState, type ReactNode } from 'react';
import {
  inferCommercialSliderPosition,
  resolveCommercialSanctionAction,
} from '@maxim/contracts/settings';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import {
  setChatBoolean,
  setChatCommercialSensitivity,
} from '../../features/network-settings/chat-field-intents';
import { AppIcon } from '../../components/ui/app-icon';
import { SharedNativeSettingsToggle } from './shared-native-settings-toggle';
import './commercial-filter-studio.css';
import { CommercialPolicyFields } from './commercial-policy-fields';
import type { CommercialSettingsScope } from './commercial-policy-model';

const profiles = [
  { value: 20, label: 'Мягко' },
  { value: 69, label: 'Баланс' },
  { value: 85, label: 'Строго' },
] as const;

export function SharedCommercialSettingsFields({
  fields,
  actions,
  mode,
  scope,
}: {
  fields: ChatSettingsFieldAdapter;
  actions: ReactNode;
  mode?: 'OFF' | 'OBSERVE' | 'DELETE_ONLY';
  scope?: CommercialSettingsScope;
}) {
  const aiDeletes = mode === 'DELETE_ONLY';
  const id = useId();
  const [openHint, setOpenHint] = useState<'master' | 'sensitivity' | null>(null);
  const enabled = fields.read('commercialAdsFilterEnabled');
  const sensitivity = fields.read('commercialAdsSensitivity');
  const warning = fields.read('commercialAdsWarnThreshold');
  const deletion = fields.read('commercialAdsDeleteThreshold');
  const common =
    sensitivity.kind === 'common' && warning.kind === 'common' && deletion.kind === 'common';
  const position = common
    ? inferCommercialSliderPosition({
        commercialAdsSensitivity: sensitivity.value,
        commercialAdsWarnThreshold: warning.value,
        commercialAdsDeleteThreshold: deletion.value,
      })
    : null;
  const selected = position === null ? null : position < 25 ? 0 : position < 70 ? 1 : 2;
  const loading = [enabled, sensitivity, warning, deletion].some(
    (field) => field.kind === 'loading',
  );
  const stages = {
    warn: fields.read('textFiltersWarnEnabled'),
    mute: fields.read('textFiltersMuteEnabled'),
    ban: fields.read('textFiltersBanEnabled'),
    message: fields.read('textFiltersBotMessageEnabled'),
  };
  const ladder =
    stages.warn.kind === 'common' &&
    stages.mute.kind === 'common' &&
    stages.ban.kind === 'common' &&
    stages.message.kind === 'common'
      ? [1, 2, 3, 4].map((count) => {
          const action = resolveCommercialSanctionAction(count, {
            warnEnabled: stages.warn.kind === 'common' && stages.warn.value,
            muteEnabled: stages.mute.kind === 'common' && stages.mute.value,
            banEnabled: stages.ban.kind === 'common' && stages.ban.value,
          });
          return count === 1 && stages.message.kind === 'common' && stages.message.value
            ? 'Объяснение'
            : {
                NONE: 'Без наказания',
                WARN: 'Предупреждение',
                MUTE: 'Ограничение',
                BAN: 'Блокировка',
              }[action];
        })
      : null;
  const infoButton = (key: 'master' | 'sensitivity', label: string) => (
    <button
      type="button"
      className="commercial-studio__info"
      aria-label={label}
      aria-controls={`${id}-${key}`}
      aria-expanded={openHint === key}
      onClick={() => setOpenHint(openHint === key ? null : key)}
    >
      <AppIcon icon="InfoCircle" />
    </button>
  );

  return (
    <div className="commercial-studio">
      <div
        className="commercial-studio__hero"
        data-enabled={enabled.kind === 'common' && enabled.value}
      >
        <div className="commercial-studio__hero-top">
          <span className="commercial-studio__mark" aria-hidden>
            <AppIcon icon="ShieldCheck" />
          </span>
          <span className="commercial-studio__status">
            {enabled.kind === 'mixed'
              ? 'Разные значения'
              : enabled.kind === 'loading'
                ? 'Загрузка…'
                : enabled.value
                  ? 'Включён'
                  : 'Выключен'}
          </span>
          {infoButton('master', 'Как работает фильтр рекламы')}
        </div>
        <SharedNativeSettingsToggle
          className="commercial-studio__toggle"
          title={aiDeletes ? 'Удалять рекламу' : 'Фильтр рекламы'}
          label={aiDeletes ? 'Удалять рекламу' : 'Фильтровать коммерческую рекламу'}
          state={enabled}
          disabled={fields.readOnly}
          onChange={(next) => setChatBoolean(fields, 'commercialAdsFilterEnabled', next)}
        />
        {openHint === 'master' ? (
          <p id={`${id}-master`} className="commercial-studio__hint">
            {aiDeletes
              ? 'Подтверждённая реклама удаляется по правилам чата. Неоднозначные сообщения остаются. Другие фильтры работают независимо.'
              : 'Фильтр ищет коммерческие предложения и удаляет подтверждённую рекламу. Разовые личные продажи старается пропускать.'}
          </p>
        ) : null}
      </div>

      {!aiDeletes ? (
        <div className="commercial-studio__ai">
          <span className="commercial-studio__ai-icon" aria-hidden>
            <AppIcon icon="Sparks" />
          </span>
          <div>
            <strong>{mode === 'OBSERVE' ? 'ИИ-анализ' : 'Текстовый фильтр'}</strong>
            <span>
              {mode === 'OBSERVE' ? 'Пока без автоматических удалений' : 'По настройкам сообщества'}
            </span>
          </div>
          <span className="commercial-studio__badge">
            {mode === 'OBSERVE' ? 'Тест' : 'Правила'}
          </span>
        </div>
      ) : null}

      <CommercialPolicyFields fields={fields} scope={scope} aiActive={aiDeletes} />
      {aiDeletes ? null : enabled.kind !== 'common' || enabled.value ? (
        <>
          <section
            className="commercial-studio__sensitivity"
            aria-labelledby={`${id}-sensitivity-title`}
          >
            <div className="commercial-studio__section-head">
              <h4 id={`${id}-sensitivity-title`}>Чувствительность</h4>
              {infoButton('sensitivity', 'Как выбрать чувствительность')}
            </div>
            <div
              className="commercial-studio__profiles"
              role="group"
              aria-label="Чувствительность коммерческого фильтра"
            >
              {profiles.map((profile, index) => (
                <button
                  type="button"
                  key={profile.value}
                  aria-pressed={selected === index}
                  disabled={fields.readOnly || loading}
                  onClick={() => setChatCommercialSensitivity(fields, profile.value)}
                >
                  <span className="commercial-studio__bars" aria-hidden data-level={index}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>{profile.label}</span>
                </button>
              ))}
            </div>
            {position === null ? (
              <p className="commercial-studio__hint">
                {loading
                  ? 'Загрузка настроек…'
                  : common
                    ? 'Свои настройки. Сохранены без изменений.'
                    : 'Разные настройки. Выберите общий вариант.'}
              </p>
            ) : null}
            {openHint === 'sensitivity' ? (
              <p id={`${id}-sensitivity`} className="commercial-studio__hint">
                Профиль меняет чувствительность текстовых правил. Спорные сообщения остаются. На
                решения ИИ эта настройка не влияет.
              </p>
            ) : null}
          </section>

          <details className="commercial-studio__repeat">
            <summary>
              <span>
                <strong>Повторные нарушения</strong>
                <small>Действия бота · за 24 часа</small>
              </span>
              <AppIcon icon="NavArrowDown" />
            </summary>
            {ladder ? (
              <ol className="commercial-studio__ladder" aria-label="Действия по номеру нарушения">
                {ladder.map((action, index) => (
                  <li key={index}>
                    <b>{index + 1}</b>
                    <span>{action}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="commercial-studio__hint">Действия различаются между чатами.</p>
            )}
            <div className="commercial-studio__actions">{actions}</div>
          </details>
        </>
      ) : null}
    </div>
  );
}
