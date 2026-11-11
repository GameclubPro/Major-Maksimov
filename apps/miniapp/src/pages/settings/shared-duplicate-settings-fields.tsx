import { lazy, Suspense, useEffect, useState } from 'react';
import {
  buildDuplicateFlowThresholds,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  type ChatSettings,
} from '@maxim/contracts/settings';
import { AppIcon } from '../../components/ui/app-icon';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { SharedBotButtonsFields } from './shared-bot-buttons-fields';
import type {
  ChatSettingsFieldAdapter,
  ChatSettingsFieldValues,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import {
  readCommonDuplicateFlow,
  setChatBoolean,
  setChatDuplicatePreset,
  setChatDuplicateWindowHours,
  type ChatBooleanField,
} from '../../features/network-settings/chat-field-intents';
import { FieldNumber, FieldText } from '../../features/network-settings/settings-field-controls';
import { useHintPopoverAutoPosition } from '../../lib/hint-popover';
import type { SharedChatSettingsSectionProps } from './shared-chat-settings-section';
import { DUPLICATE_DETECTION_OPTIONS } from '../settings-page.constants';
import { EditToggleButton } from './settings-edit-toggle-button';
import { SettingsHintAnchor } from './settings-hint-anchor';
import { SharedMuteStage } from './shared-mute-stage';
import { SharedNativeSettingsToggle as DuplicateToggle } from './shared-native-settings-toggle';
import type { SettingsSectionHintProps } from './settings-section-shared';
import {
  resolveDuplicateSharedWindowSec,
  formatDuplicateClockTime,
} from './settings-duplicate-flow';
import { resolveDuplicatePhotoPresentationPolicy } from './settings-duplicate-photo-status';
import SettingsDuplicatePhotoControls from './settings-duplicate-photo-controls';
import SettingsDuplicateWindowControls from './settings-duplicate-window-controls';
import { buildDuplicateTextActionPreview } from './settings-duplicate-action-preview';
import './settings-duplicate-preview.css';
import './settings-duplicate-photo.css';

const SharedBotSpeechEditor = lazy(() =>
  import('./shared-bot-speech-editor').then((module) => ({
    default: module.SharedBotSpeechEditor,
  })),
);
type Props = Pick<SharedChatSettingsSectionProps, 'fields' | 'context'>;
type HintKey = SettingsSectionHintProps['openHintKey'];
const windowPaths = [
  'duplicateWarnEnabled',
  'duplicateMuteEnabled',
  'duplicateBanEnabled',
  'duplicateWarnWindowSec',
  'duplicateMuteWindowSec',
  'duplicateBanWindowSec',
] as const;
const stagePaths = [
  'duplicateBotMessageEnabled',
  'duplicateWarnEnabled',
  'duplicateMuteEnabled',
  'duplicateBanEnabled',
] as const;
function commonValues<
  const K extends readonly Extract<keyof ChatSettings, keyof ChatSettingsFieldValues>[],
>(fields: ChatSettingsFieldAdapter, paths: K): Pick<ChatSettings, K[number]> | null {
  const entries: [string, unknown][] = [];
  for (const path of paths) {
    const state = fields.read(path);
    if (state.kind !== 'common') return null;
    entries.push([path, state.value]);
  }
  return Object.fromEntries(entries) as Pick<ChatSettings, K[number]>;
}
const value = <T,>(state: SettingsFieldState<T>): T | null =>
  state.kind === 'common' ? state.value : null;
const shown = (state: SettingsFieldState<boolean>) => state.kind !== 'common' || state.value;

function DuplicateButtons({ fields, context }: Props) {
  const adminState = fields.read('duplicateAdminContactButtonEnabled');
  return (
    <>
      <SharedBotButtonsFields
        fields={fields}
        api={context.api}
        path="duplicateBotButtons"
        enabledPath="duplicateBotButtonEnabled"
        activationLabel="Кнопка в сообщении о дублях"
        urlPlaceholder="https://max.ru/profile/..."
      />
      {context.renderAdminContact ? (
        context.renderAdminContact({
          enabledPath: 'duplicateAdminContactButtonEnabled',
          urlPath: 'duplicateAdminContactButtonUrl',
          label: 'Добавить связь с админом в сообщения о дублях',
        })
      ) : (
        <>
          <DuplicateToggle
            title="Связь с админом"
            label="Добавить связь с админом в сообщения о дублях"
            state={adminState}
            disabled={fields.readOnly}
            nested
            onChange={(enabled) => fields.setScalar('duplicateAdminContactButtonEnabled', enabled)}
          />
          {shown(adminState) ? (
            <FieldText
              label="Ссылка на администратора"
              state={fields.read('duplicateAdminContactButtonUrl')}
              disabled={fields.readOnly}
              error={fields.error('duplicateAdminContactButtonUrl')}
              onChange={(next) => fields.setScalar('duplicateAdminContactButtonUrl', next)}
            />
          ) : null}
        </>
      )}
    </>
  );
}

export function SharedDuplicateSettingsFields({ fields, context }: Props) {
  const [openHintKey, setOpenHintKey] = useState<HintKey>(null);
  useHintPopoverAutoPosition(openHintKey !== null, openHintKey, () => setOpenHintKey(null));
  const [editorOpen, setEditorOpen] = useState(false);
  const [windowBuffer, setWindowBuffer] = useState<string | null>(null);
  const master = fields.read('antiDuplicateEnabled');
  const preset = fields.read('duplicateDetectionPreset');
  const flow = readCommonDuplicateFlow(fields);
  const stages = commonValues(fields, stagePaths);
  const windows = commonValues(fields, windowPaths);
  const windowHours = windows ? resolveDuplicateSharedWindowSec(windows) / 3600 : null;
  const windowKey = windowHours === null ? 'mixed' : String(windowHours);
  useEffect(() => setWindowBuffer(null), [windowKey]);
  const allowedCount = flow ? resolveDuplicateFlowAllowedCount(flow) : null;
  const maxAllowedCount = stages ? resolveDuplicateFlowAllowedCountMax(stages) : null;
  const setAllowedCount = (count: number) => {
    if (
      !stages ||
      !Number.isInteger(count) ||
      count < 0 ||
      maxAllowedCount === null ||
      count > maxAllowedCount
    )
      return;
    fields.transact(
      Object.entries(buildDuplicateFlowThresholds({ ...stages, allowedCount: count })).map(
        ([path, next]) => ({ op: 'set', path, value: next }),
      ),
    );
  };
  const onHoursChange = (raw: string) => {
    setWindowBuffer(raw);
    const hours = Number(raw);
    if (!raw.trim() || !Number.isInteger(hours) || hours < 1 || hours > 48) {
      fields.setError('duplicateWarnWindowSec', 'Укажите период от 1 до 48 часов.');
      return;
    }
    fields.setError('duplicateWarnWindowSec', null);
    setChatDuplicateWindowHours(fields, hours);
  };
  const hint = (key: NonNullable<HintKey>, label: string, children: string) => (
    <SettingsHintAnchor
      hintKey={key}
      openHintKey={openHintKey}
      onToggleHint={(next) => setOpenHintKey(openHintKey === next ? null : next)}
      label={label}
    >
      {children}
    </SettingsHintAnchor>
  );
  const toggle = (path: ChatBooleanField, title: string, label: string, nested = false) => (
    <DuplicateToggle
      key={path}
      state={fields.read(path)}
      title={title}
      label={label}
      disabled={fields.readOnly}
      nested={nested}
      onChange={(enabled) => setChatBoolean(fields, path, enabled)}
    />
  );
  const duration = value(fields.read('duplicateMuteDurationHours'));
  const previewRows =
    flow && allowedCount !== null && duration !== null
      ? buildDuplicateTextActionPreview(
          { ...flow, duplicateMuteDurationHours: duration },
          allowedCount,
        )
      : null;
  const start = value(fields.read('duplicateStartTimeMinutes'));
  const end = value(fields.read('duplicateEndTimeMinutes'));
  const windowMode = value(fields.read('duplicateWindowMode'));
  const photoPolicy = context.duplicatePresentation
    ? resolveDuplicatePhotoPresentationPolicy(context.duplicatePresentation.photoPolicy)
    : undefined;
  return (
    <div className="settings-section__collapse-inner">
      <DuplicateToggle
        title="Включить антидубль"
        label="Включить антидубль"
        state={master}
        disabled={fields.readOnly}
        onChange={(enabled) => fields.setScalar('antiDuplicateEnabled', enabled)}
        hint={hint(
          'antiDuplicate',
          'Пояснение для антидубля',
          'Первое сообщение остаётся. Бот реагирует на повторы по настройкам ниже. Администраторы, боты и участники с иммунитетом исключены.',
        )}
      />
      {shown(master) ? (
        <>
          {context.duplicatePresentation?.messageMode === 'OFF' ? (
            <p className="policy-mode-hint" role="status">
              Антидубль сейчас недоступен
            </p>
          ) : context.duplicatePresentation?.messageMode === 'OBSERVE' ? (
            <p className="policy-mode-hint" role="status">
              Проверка работает без удаления
            </p>
          ) : context.duplicatePresentation?.messageMode === 'DELETE_ONLY' ? (
            <p className="policy-mode-hint" role="status">
              Доступно только удаление
            </p>
          ) : null}
          <h3 className="duplicate-settings-group__title">Совпадения</h3>
          <div className="settings-policy">
            <div className="settings-policy__label-row">
              <span className="field__label">Как искать повторы</span>
              {hint(
                'duplicateTextMode',
                'Пояснение для поиска повторов',
                preset.kind === 'common' && preset.value === 'STANDARD'
                  ? 'Одинаковый текст без учёта регистра и пробелов.'
                  : preset.kind === 'common' && preset.value === 'STRICT'
                    ? 'Находить повторы даже с небольшими изменениями длинного текста.'
                    : 'Выберите, какие совпадения считать повторами.',
              )}
            </div>
            <SegmentedControl
              value={value(preset)}
              options={DUPLICATE_DETECTION_OPTIONS.map((option) => ({
                ...option,
                disabled: fields.readOnly,
              }))}
              onChange={(next) => {
                if (next === 'STANDARD' || next === 'STRICT' || next === 'CUSTOM')
                  setChatDuplicatePreset(fields, next);
              }}
              className="settings-mode-segments"
              ariaLabel="Как искать повторы"
            />
            {preset.kind !== 'common' ? <p className="field__hint">Разные значения</p> : null}
          </div>
          {preset.kind !== 'common' || preset.value === 'CUSTOM' ? (
            <>
              {toggle(
                'duplicateIgnoreLinksEnabled',
                'Одинаковая ссылка',
                'Считать одинаковую ссылку дублем',
                true,
              )}
              {toggle(
                'duplicateIgnorePhonesEnabled',
                'Одинаковый номер',
                'Считать одинаковый номер дублем',
                true,
              )}
              {toggle(
                'duplicateNearMatchEnabled',
                'Близкие совпадения',
                'Включить близкие совпадения дублей',
                true,
              )}
            </>
          ) : null}
          <SettingsDuplicatePhotoControls
            moderationPolicy={photoPolicy}
            scope={value(fields.read('duplicatePhotoScope'))}
            disabled={fields.readOnly}
            onScopeChange={(next) => fields.setScalar('duplicatePhotoScope', next)}
          />
          <h3 className="duplicate-settings-group__title">Когда срабатывать</h3>
          <article
            className={`duplicate-stage${fields.error('duplicateWarnWindowSec') || fields.error('duplicateWarnMaxCount') ? ' field--error' : ''}`}
          >
            <div className="duplicate-stage__top">
              <div className="settings-native-toggle__title-wrap">
                <span className="duplicate-stage__title">Период проверки</span>
                {hint(
                  'duplicateModerationStart',
                  'Пояснение для условий удаления дублей',
                  windowMode === 'DAILY'
                    ? 'Повторы учитываются только внутри выбранного периода. Каждый день история начинается заново. Время «По» не включается.'
                    : 'Интервал начинается с разрешённого оригинала. Удалённые повторы и правки без изменения содержания не продлевают его.',
                )}
              </div>
            </div>
            <SettingsDuplicateWindowControls
              fields={fields}
              windowHours={windowHours}
              inputValue={windowBuffer}
              onHoursChange={onHoursChange}
            />
            <div className="duplicate-trigger-count">
              <div className="duplicate-stage__field">
                <span className="duplicate-stage__field-label">Удалять начиная с</span>
                <div
                  className="duplicate-count-stepper"
                  role="group"
                  aria-label="Номер первого удаляемого одинакового сообщения"
                >
                  <button
                    type="button"
                    className="duplicate-count-stepper__button"
                    disabled={fields.readOnly || allowedCount === null || allowedCount <= 0}
                    aria-label="Начинать удаление раньше"
                    onClick={() => {
                      if (allowedCount !== null) setAllowedCount(allowedCount - 1);
                    }}
                  >
                    <AppIcon icon="Minus" />
                  </button>
                  <output className="duplicate-count-stepper__value" aria-live="polite">
                    {allowedCount === null ? 'Разные значения' : `${allowedCount + 2}-го`}
                  </output>
                  <button
                    type="button"
                    className="duplicate-count-stepper__button"
                    disabled={
                      fields.readOnly ||
                      allowedCount === null ||
                      maxAllowedCount === null ||
                      allowedCount >= maxAllowedCount
                    }
                    aria-label="Начинать удаление позже"
                    onClick={() => {
                      if (allowedCount !== null) setAllowedCount(allowedCount + 1);
                    }}
                  >
                    <AppIcon icon="Plus" />
                  </button>
                </div>
                <span className="field__hint">одинакового сообщения</span>
                {allowedCount === null ? (
                  <FieldNumber
                    label="Номер первого удаляемого одинакового сообщения"
                    state={{ kind: 'mixed' }}
                    min={2}
                    max={maxAllowedCount === null ? 22 : maxAllowedCount + 2}
                    disabled={fields.readOnly || !stages}
                    onChange={(next) => setAllowedCount(next - 2)}
                  />
                ) : null}
                {!stages ? (
                  <p className="field__hint">
                    Этапы различаются. Выберите общие действия ниже, затем задайте общий порог.
                  </p>
                ) : null}
              </div>
            </div>
            {fields.error('duplicateWarnMaxCount') ? (
              <small className="field__hint" role="alert">
                {fields.error('duplicateWarnMaxCount')}
              </small>
            ) : null}
          </article>
          <section className="duplicate-action-preview" aria-label="Итог действий антидубля">
            <div className="duplicate-stage__top">
              <div>
                <h3 className="duplicate-stage__title">По настройкам</h3>
                <span className="field__hint">
                  {windowMode === 'DAILY' && start !== null && end !== null
                    ? `Ежедневно ${formatDuplicateClockTime(start)}–${formatDuplicateClockTime(end)}${start > end ? ' следующего дня' : ''}`
                    : windowMode === 'INTERVAL' && windowHours !== null
                      ? `Повторы за ${windowHours} ч`
                      : 'Периоды различаются'}
                </span>
              </div>
            </div>
            {previewRows ? (
              <dl className="duplicate-action-preview__rows" aria-live="polite">
                {previewRows.map((row) => (
                  <div className="duplicate-action-preview__row" key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{row.action}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="field__hint">Действия различаются между выбранными чатами.</p>
            )}
          </section>
          <h3 className="duplicate-settings-group__title">Что делать</h3>
          <DuplicateToggle
            title="Сначала объяснить удаление"
            label="Сообщение о дублях"
            state={fields.read('duplicateBotMessageEnabled')}
            disabled={fields.readOnly}
            onChange={(enabled) => setChatBoolean(fields, 'duplicateBotMessageEnabled', enabled)}
            actions={
              <EditToggleButton
                label="Текст о дублях"
                disabled={fields.readOnly || !shown(fields.read('duplicateBotMessageEnabled'))}
                isOpen={editorOpen}
                onClick={() => setEditorOpen(!editorOpen)}
              />
            }
          />
          {shown(fields.read('duplicateBotMessageEnabled')) && editorOpen ? (
            <Suspense fallback={null}>
              <SharedBotSpeechEditor
                fields={fields}
                path="duplicateBotMessageText"
                mediaPath="botSpeechMedia.duplicateBotMessageText"
                title="Текст о дублях"
                onClose={() => setEditorOpen(false)}
              />
            </Suspense>
          ) : null}
          {shown(fields.read('duplicateBotMessageEnabled')) ? (
            <DuplicateButtons fields={fields} context={context} />
          ) : null}
          {toggle(
            'duplicateWarnEnabled',
            'Предупредить',
            'Включить предупреждение за повторы',
            true,
          )}
          <SharedMuteStage
            fields={fields}
            enabledPath="duplicateMuteEnabled"
            durationPath="duplicateMuteDurationHours"
            title="Ограничить отправку"
            durationLabel="за повторы"
            activationLabel="Включить ограничение сообщений за повторы"
            onChange={(enabled) => setChatBoolean(fields, 'duplicateMuteEnabled', enabled)}
          />
          {toggle('duplicateBanEnabled', 'Заблокировать', 'Включить блокировку за повторы', true)}
        </>
      ) : null}
    </div>
  );
}
