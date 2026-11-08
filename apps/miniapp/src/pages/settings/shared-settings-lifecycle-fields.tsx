import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppIcon } from '../../components/ui/app-icon';
import { stepDeleteBotMessagesDelayMinutes } from '@maxim/contracts/settings';
import type { BroadcastLinkButton } from '@maxim/contracts/broadcast';
import type { NetworkSettingsChange } from '@maxim/contracts/network-settings';
import type {
  ChatSettingsFieldAdapter,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import {
  setChatBoolean,
  type ChatBooleanField,
} from '../../features/network-settings/chat-field-intents';
import { BroadcastLinkButtonsEditor } from '../../components/broadcast-link-buttons-editor';
import PublishedRulesButtonToggle from '../../components/published-rules-button-toggle';
import { Spinner } from '../../components/ui/spinner';
import { FieldList } from '../../features/network-settings/settings-field-controls';
import {
  createEmptyBroadcastLinkButton,
  validateBroadcastLinkButtons,
} from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { DeleteDelayStepper } from './settings-delete-delay-stepper';
import { SettingsHintAnchor } from './settings-hint-anchor';
import { getNightTimezoneOptions } from './settings-timezones';
import { SharedSpeechField } from './shared-bot-speech-field';
import type { SharedChatSettingsContext } from './shared-chat-settings-section';
import type { ComponentProps } from 'react';

const LazyNightTimeFields = recoverableLazyNamedComponent<
  ComponentProps<typeof import('./night-mode-time-fields').default>
>(() => import('./night-mode-time-fields'), 'default');
type FieldsProps = { fields: ChatSettingsFieldAdapter };
type LifecycleProps = FieldsProps & { context: SharedChatSettingsContext };
type Hint = { key: string; label: string; text: string; id?: string };

function useHint() {
  const [openHintKey, setOpenHintKey] = useState<string | null>(null);
  return {
    openHintKey,
    toggleHint: (key: string) => setOpenHintKey((current) => (current === key ? null : key)),
  };
}
type Hints = ReturnType<typeof useHint>;
function HintButton({ hint, hints }: { hint: Hint; hints: Hints }) {
  return (
    <button
      type="button"
      className={cn('settings-info-button', hints.openHintKey === hint.key && 'is-open')}
      aria-label={hint.label}
      aria-controls={hint.id ?? `settings-hint-${hint.key}`}
      aria-expanded={hints.openHintKey === hint.key}
      data-hint-key={hint.key}
      onClick={() => hints.toggleHint(hint.key)}
    >
      <AppIcon
        icon="InfoCircle"
        width="1.5em"
        height="1.5em"
        style={{ strokeWidth: 1.5 }}
        aria-hidden
      />
    </button>
  );
}
function HintText({ hint, hints }: { hint: Hint; hints: Hints }) {
  return hints.openHintKey === hint.key ? (
    <p id={hint.id ?? `settings-hint-${hint.key}`} className="settings-native-toggle__hint">
      {hint.text}
    </p>
  ) : null;
}
function Toggle({
  fields,
  path,
  title,
  ariaLabel,
  hint,
  hints,
  nested,
  state: stateOverride,
  onChange,
  titleAction,
  children,
}: FieldsProps & {
  path: ChatBooleanField;
  title: string;
  ariaLabel: string;
  hint?: Hint;
  hints?: Hints;
  nested?: boolean;
  state?: SettingsFieldState<boolean>;
  onChange?: (enabled: boolean) => void;
  titleAction?: ReactNode;
  children?: ReactNode;
}) {
  const state = stateOverride ?? fields.read(path);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <div
      className={cn(
        'settings-native-toggle',
        nested && 'settings-native-toggle--nested',
        fields.error(path) && 'field--error',
      )}
    >
      <div className="settings-native-toggle__row">
        <div className="settings-native-toggle__title-wrap">
          <span className="settings-native-toggle__title">{title}</span>
          {titleAction ? (
            <div className="settings-native-toggle__title-actions">{titleAction}</div>
          ) : null}
          {hint && hints ? <HintButton hint={hint} hints={hints} /> : null}
        </div>
        <label className="settings-native-switch" aria-label={ariaLabel}>
          <input
            ref={input}
            type="checkbox"
            checked={state.kind === 'common' && state.value}
            aria-checked={state.kind === 'mixed' ? 'mixed' : state.kind === 'common' && state.value}
            disabled={fields.readOnly || state.kind === 'loading'}
            onChange={(event) => {
              fields.setError(path, null);
              if (onChange) onChange(event.target.checked);
              else setChatBoolean(fields, path, event.target.checked);
            }}
          />
          <span className="toggle-switch" aria-hidden>
            <span className="toggle-switch__thumb" />
          </span>
        </label>
      </div>
      {state.kind === 'mixed' ? <p className="field__hint">Разные значения</p> : null}
      {hint && hints ? <HintText hint={hint} hints={hints} /> : null}
      {children}
      {fields.error(path) ? (
        <small className="field__hint" role="alert">
          {fields.error(path)}
        </small>
      ) : null}
    </div>
  );
}
const visible = (state: SettingsFieldState<boolean>) =>
  state.kind === 'mixed' || (state.kind === 'common' && state.value);
const numberValue = (state: SettingsFieldState<number>) =>
  state.kind === 'common' ? state.value : null;
function Delay({ fields, greeting = false }: FieldsProps & { greeting?: boolean }) {
  const path = greeting ? 'greetingDeleteBotMessageDelayMinutes' : 'deleteBotMessagesDelayMinutes';
  const state = fields.read(path);
  const value = numberValue(state);
  const subject = greeting ? 'приветствия' : 'сообщений бота';
  return (
    <DeleteDelayStepper
      title="Через сколько удалять"
      value={value}
      disabled={fields.readOnly || state.kind === 'loading'}
      fieldError={fields.error(path) ?? undefined}
      groupAriaLabel={`Задержка удаления ${subject}`}
      decreaseAriaLabel={`Уменьшить задержку удаления ${subject}`}
      increaseAriaLabel={`Увеличить задержку удаления ${subject}`}
      onSelect={(minutes) => fields.setScalar(path, minutes)}
      onAdjust={(direction) => {
        if (value !== null)
          fields.setScalar(path, stepDeleteBotMessagesDelayMinutes(value, direction));
      }}
    />
  );
}

function Buttons({
  fields,
  context,
  greeting,
  hints,
}: LifecycleProps & { greeting?: boolean; hints: Hints }) {
  const prefix = greeting ? 'greeting' : 'nightMode';
  const path = `${prefix}BotButtons` as const;
  const enabledPath = `${prefix}BotButtonEnabled` as const;
  const state = fields.read(path);
  const enabled = fields.read(enabledPath);
  const [buffer, setBuffer] = useState<BroadcastLinkButton[] | null>(null);
  const incoming = state.kind === 'common' ? JSON.stringify(state.value) : state.kind;
  useEffect(() => setBuffer(null), [incoming]);
  const hint = greeting
    ? {
        key: 'greetingBotButton',
        id: 'greeting-bot-button-hint',
        label: 'Пояснение для кнопки в приветствии',
        text: 'Добавляет кнопку в приветствие, например на чат или канал.',
      }
    : {
        key: 'nightBotButton',
        id: 'night-bot-button-hint',
        label: 'Пояснение для кнопки в сообщении ночного режима',
        text: 'Добавляет кнопку в сообщение о закрытии чата на ночь.',
      };
  const replace = (next: BroadcastLinkButton[]) => {
    setBuffer(next);
    // FLAG: Incomplete network rows remain a local editor draft; only valid lists enter the patch.
    if (
      context.mode === 'network' &&
      validateBroadcastLinkButtons(next).some((error) => error.text || error.url)
    ) {
      fields.setError(path, 'Заполните названия кнопок и укажите корректные ссылки.');
      return;
    }
    try {
      fields.setError(path, null);
      fields.transact([
        { op: 'replace', path, value: next },
        { op: 'set', path: enabledPath, value: next.length > 0 },
      ]);
    } catch (cause) {
      fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте кнопки сообщения.');
    }
  };
  const editor = (
    buttons: BroadcastLinkButton[],
    onChange: (next: BroadcastLinkButton[]) => void,
  ) => (
    <BroadcastLinkButtonsEditor
      api={context.api}
      buttons={buttons}
      errors={fields.error(path) ? validateBroadcastLinkButtons(buttons) : []}
      disabled={fields.readOnly}
      onChange={onChange}
      urlPlaceholder={greeting ? 'https://max.ru/channel/rules' : 'https://max.ru/channel/...'}
      textPlaceholder={greeting ? 'Открыть' : 'Правила чата'}
      title="Кнопки сообщения"
      subtitle="Название и ссылка"
    />
  );
  return (
    <Toggle
      fields={fields}
      path={enabledPath}
      title="Добавить кнопку"
      nested
      hints={hints}
      hint={hint}
      ariaLabel={
        greeting
          ? 'Добавить кнопку в приветственное сообщение'
          : 'Добавить кнопку в сообщение бота для ночного режима'
      }
      onChange={(nextEnabled) => {
        const changes: NetworkSettingsChange[] = [
          { op: 'set', path: enabledPath, value: nextEnabled },
        ];
        if (nextEnabled && state.kind === 'common' && state.value.length === 0) {
          const buttons = [createEmptyBroadcastLinkButton()];
          if (context.mode === 'network') {
            setBuffer(buttons);
            fields.setError(path, 'Заполните название кнопки и укажите корректную ссылку.');
          } else changes.push({ op: 'replace', path, value: buttons });
        }
        if (!nextEnabled) {
          setBuffer(null);
          fields.setError(path, null);
        }
        try {
          fields.transact(changes);
        } catch (cause) {
          fields.setError(
            path,
            cause instanceof Error ? cause.message : 'Проверьте кнопки сообщения.',
          );
        }
      }}
    >
      {visible(enabled) ? (
        state.kind === 'mixed' ? (
          <FieldList
            label="Кнопки сообщения"
            state={state}
            disabled={fields.readOnly}
            error={fields.error(path)}
            onChange={replace}
          >
            {(buttons) => editor(buffer ?? buttons, replace)}
          </FieldList>
        ) : state.kind === 'common' ? (
          editor(buffer ?? state.value, replace)
        ) : (
          <Spinner label="Загружаем кнопки" />
        )
      ) : null}
      {fields.error(path) ? (
        <small className="field__hint" role="alert">
          {fields.error(path)}
        </small>
      ) : null}
    </Toggle>
  );
}
function Rules({ fields, context, greeting }: LifecycleProps & { greeting?: boolean }) {
  const path = greeting ? 'greetingRulesButtonEnabled' : 'nightModeRulesButtonEnabled';
  const state = fields.read(path);
  return (
    <PublishedRulesButtonToggle
      ariaLabel={greeting ? 'Кнопка Правила в приветствии' : 'Кнопка Правила в ночном режиме'}
      enabled={state.kind === 'common' && state.value}
      mixed={state.kind === 'mixed'}
      disabled={fields.readOnly || state.kind === 'loading'}
      hasRules={context.hasPublishedRules}
      onChange={(enabled) => fields.setScalar(path, enabled)}
    />
  );
}

export function SharedGreetingFields({ fields, context }: LifecycleProps) {
  const hints = useHint();
  const greeting = fields.read('greetingEnabled');
  const message = fields.read('greetingBotMessageEnabled');
  const state: SettingsFieldState<boolean> =
    greeting.kind === 'loading' || message.kind === 'loading'
      ? { kind: 'loading' }
      : (greeting.kind === 'common' && !greeting.value) ||
          (message.kind === 'common' && !message.value)
        ? { kind: 'common', value: false }
        : greeting.kind === 'common' && message.kind === 'common'
          ? { kind: 'common', value: greeting.value && message.value }
          : { kind: 'mixed' };
  return (
    <>
      <Toggle
        fields={fields}
        path="greetingEnabled"
        title="Приветствие"
        state={state}
        ariaLabel="Включить приветствие новых участников"
        hints={hints}
        hint={{
          key: 'greetingEnabled',
          id: 'greeting-enabled-hint',
          label: 'Пояснение для приветствия новых участников',
          text: 'Бот отправит приветствие, когда в чат добавляют нового участника.',
        }}
      />
      {visible(state) ? (
        <>
          <SharedSpeechField
            fields={fields}
            path="greetingBotMessageText"
            mediaPath="botSpeechMedia.greetingBotMessageText"
            label="Текст приветствия"
            nested
            editLabel="Редактировать текст приветствия"
          />
          <Toggle
            fields={fields}
            path="greetingDeleteBotMessageEnabled"
            title="Удалять приветствие"
            nested
            hints={hints}
            ariaLabel="Включить автоудаление приветственных сообщений бота"
            hint={{
              key: 'greetingDeleteBotMessages',
              id: 'greeting-delete-bot-messages-hint',
              label: 'Пояснение для автоудаления приветствия',
              text: 'Бот будет автоматически удалять приветствие через выбранное время.',
            }}
          />
          {visible(fields.read('greetingDeleteBotMessageEnabled')) ? (
            <Delay fields={fields} greeting />
          ) : null}
          <Buttons fields={fields} context={context} greeting hints={hints} />
          <Rules fields={fields} context={context} greeting />
        </>
      ) : null}
    </>
  );
}

function ForceDuration({
  fields,
  path,
  title,
  unit,
  max,
  label,
}: FieldsProps & {
  path: 'nightModeForceCloseHours' | 'nightModeForceCloseDays';
  title: string;
  unit: string;
  max: number;
  label: string;
}) {
  const state = fields.read(path);
  const value = numberValue(state);
  const [mixedInput, setMixedInput] = useState(false);
  const [buffer, setBuffer] = useState<string | null>(null);
  return (
    <div className="settings-duration-stack__item">
      <div className="settings-native-toggle__row">
        <span className="settings-native-toggle__title settings-native-toggle__title--sub">
          {title}
        </span>
        <output className="settings-length-limit__value" aria-live="polite">
          {value === null ? 'Разные значения' : `${value}${unit}`}
        </output>
      </div>
      {value === null || mixedInput ? (
        <input
          type="number"
          min={0}
          max={max}
          step={1}
          value={buffer ?? (value === null ? '' : String(value))}
          aria-label={label}
          placeholder="Разные значения"
          disabled={fields.readOnly || state.kind === 'loading'}
          onFocus={() => setMixedInput(true)}
          onBlur={() => {
            if (!fields.error(path)) {
              setMixedInput(false);
              setBuffer(null);
            }
          }}
          onChange={(event) => {
            const raw = event.target.value;
            setBuffer(raw);
            const next = Number(raw);
            if (!raw.trim() || !Number.isInteger(next) || next < 0 || next > max) {
              fields.setError(path, `Укажите число от 0 до ${max}.`);
              return;
            }
            fields.setError(path, null);
            fields.setScalar(path, next);
          }}
        />
      ) : (
        <>
          <input
            className="settings-length-limit__slider"
            type="range"
            min={0}
            max={max}
            step={1}
            value={value}
            disabled={fields.readOnly}
            aria-label={label}
            onChange={(event) => fields.setScalar(path, Number(event.target.value))}
          />
          <div className="settings-length-limit__labels" aria-hidden>
            <span>0{unit}</span>
            <span>
              {max}
              {unit}
            </span>
          </div>
        </>
      )}
      {fields.error(path) ? (
        <small className="field__hint" role="alert">
          {fields.error(path)}
        </small>
      ) : null}
    </div>
  );
}

export function SharedNightFields({ fields, context }: LifecycleProps) {
  const hints = useHint();
  const enabled = fields.read('nightModeEnabled');
  const message = fields.read('nightModeBotMessageEnabled');
  const openMessage = fields.read('nightModeOpenMessageEnabled');
  const start = fields.read('nightModeStartTimeMinutes');
  const end = fields.read('nightModeEndTimeMinutes');
  const timezone = fields.read('nightModeTimezone');
  const closed = fields.read('nightModeForceCloseEnabled');
  const forever = fields.read('nightModeForceCloseForever');
  const timeError =
    fields.error('nightModeStartTimeMinutes') ?? fields.error('nightModeEndTimeMinutes');
  const closeHint = {
    key: 'nightBotMessage',
    id: 'night-bot-message-hint',
    label: 'Пояснение для тумблера сообщений ночного режима',
    text: 'Бот пишет, что чат закрыт на ночь, и поясняет удаление сообщения.',
  };
  const openHint = {
    key: 'nightOpenMessage',
    id: 'night-open-message-hint',
    label: 'Пояснение для сообщения об открытии группы',
    text: 'После окончания ночного режима бот пишет, что группа снова открыта, и удаляет предыдущее ночное сообщение.',
  };
  const setForceFlag = (
    path: 'nightModeForceCloseEnabled' | 'nightModeForceCloseForever',
    next: boolean,
  ) => {
    const hours = fields.read('nightModeForceCloseHours');
    const days = fields.read('nightModeForceCloseDays');
    const changes: NetworkSettingsChange[] = [{ op: 'set', path, value: next }];
    // FLAG: Default duration follows the original explicit toggle only when every prerequisite is known.
    if (
      (path === 'nightModeForceCloseEnabled'
        ? next && forever.kind === 'common' && !forever.value
        : !next) &&
      hours.kind === 'common' &&
      hours.value === 0 &&
      days.kind === 'common' &&
      days.value === 0
    )
      changes.push({ op: 'set', path: 'nightModeForceCloseHours', value: 8 });
    fields.transact(changes);
  };
  return (
    <>
      <Toggle
        fields={fields}
        path="nightModeEnabled"
        title="Закрывать по расписанию"
        hints={hints}
        ariaLabel="Включить закрытие чата на ночь"
        hint={{
          key: 'nightModeEnabled',
          id: 'night-mode-enabled-hint',
          label: 'Пояснение для ночного режима',
          text: 'Каждый день в выбранное время бот удаляет новые сообщения участников. Администраторы могут продолжать писать. Расписание работает по часовому поясу, выбранному ниже.',
        }}
      />
      {visible(enabled) ? (
        <>
          <div
            className={cn(
              'settings-native-toggle',
              (timeError || fields.error('nightModeTimezone')) && 'field--error',
            )}
          >
            <div className="night-window-grid">
              <Suspense fallback={<Spinner label="Загружаем время" />}>
                <LazyNightTimeFields
                  kind="night"
                  startMinutes={numberValue(start)}
                  endMinutes={numberValue(end)}
                  error={timeError ?? undefined}
                  disabled={fields.readOnly || start.kind === 'loading' || end.kind === 'loading'}
                  onChange={(path, minutes) => fields.setScalar(path, minutes)}
                />
              </Suspense>
            </div>
            <label className={cn('field', fields.error('nightModeTimezone') && 'field--error')}>
              <span className="field__label">Часовой пояс</span>
              <select
                value={timezone.kind === 'common' ? timezone.value : ''}
                disabled={fields.readOnly || timezone.kind === 'loading'}
                onChange={(event) => fields.setScalar('nightModeTimezone', event.target.value)}
              >
                {timezone.kind !== 'common' ? (
                  <option value="" disabled>
                    {timezone.kind === 'mixed' ? 'Разные значения' : 'Загрузка…'}
                  </option>
                ) : null}
                {getNightTimezoneOptions(
                  timezone.kind === 'common' ? timezone.value : undefined,
                ).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {fields.error('nightModeTimezone') ? (
                <small className="field__hint">{fields.error('nightModeTimezone')}</small>
              ) : null}
            </label>
          </div>
          <div
            className="settings-subsection-divider"
            role="separator"
            aria-label="Блок действий бота для ночного режима"
          >
            <span>Действия бота</span>
          </div>
          <SharedSpeechField
            fields={fields}
            path="nightModeBotMessageText"
            mediaPath="botSpeechMedia.nightModeBotMessageText"
            enabledPath="nightModeBotMessageEnabled"
            label="Сообщение от бота"
            activationLabel="Включить сообщение от бота для ночного режима"
            editLabel="Редактировать текст сообщения ночного режима"
            disableEditorWhenOff
            titleAction={<HintButton hint={closeHint} hints={hints} />}
            hint={<HintText hint={closeHint} hints={hints} />}
          />
          <SharedSpeechField
            fields={fields}
            path="nightModeOpenMessageText"
            mediaPath="botSpeechMedia.nightModeOpenMessageText"
            enabledPath="nightModeOpenMessageEnabled"
            label="Сообщение об открытии"
            activationLabel="Включить сообщение об открытии группы после ночного режима"
            editLabel="Редактировать текст сообщения об открытии группы"
            disableEditorWhenOff
            titleAction={<HintButton hint={openHint} hints={hints} />}
            hint={<HintText hint={openHint} hints={hints} />}
          />
          {visible(openMessage) ? (
            <Toggle
              fields={fields}
              path="nightModeOpenMessageDeleteOnFirstMessageEnabled"
              title="Удалять после первого сообщения"
              nested
              ariaLabel="Удалять сообщение об открытии после первого сообщения участника"
            />
          ) : null}
          {visible(message) ? (
            <>
              <Toggle
                fields={fields}
                path="nightModeCommentsEnabled"
                title="Комментарии"
                nested
                ariaLabel="Добавить комментарии под сообщением ночного режима"
                titleAction={
                  <SettingsHintAnchor
                    hintKey="nightComments"
                    openHintKey={hints.openHintKey}
                    onToggleHint={hints.toggleHint}
                    label="Как работают комментарии под ночным сообщением"
                  >
                    Кнопка «Комментарии» под сообщением о закрытии группы.
                  </SettingsHintAnchor>
                }
              />
              <Buttons fields={fields} context={context} hints={hints} />
              <Rules fields={fields} context={context} />
            </>
          ) : null}
        </>
      ) : null}
      <div
        className="settings-subsection-divider"
        role="separator"
        aria-label="Блок закрытия чата вручную"
      >
        <span>Закрыть сейчас</span>
      </div>
      <Toggle
        fields={fields}
        path="nightModeForceCloseEnabled"
        title="Закрыть вручную"
        hints={hints}
        ariaLabel="Включить ручное закрытие чата"
        onChange={(next) => setForceFlag('nightModeForceCloseEnabled', next)}
        hint={{
          key: 'nightForceClose',
          id: 'night-force-close-hint',
          label: 'Пояснение для ручного закрытия чата',
          text: 'После сохранения бот начнёт удалять новые сообщения участников без пояснений. Администраторы смогут продолжать писать. Ручное закрытие действует независимо от ночного расписания, до конца выбранного срока или пока вы его не выключите.',
        }}
      />
      {visible(closed) ? (
        <Toggle
          fields={fields}
          path="nightModeForceCloseForever"
          title="Без срока"
          nested
          ariaLabel="Включить бессрочное ручное закрытие чата"
          onChange={(next) => setForceFlag('nightModeForceCloseForever', next)}
        />
      ) : null}
      {visible(closed) && !(forever.kind === 'common' && forever.value) ? (
        <div className="settings-native-toggle settings-native-toggle--nested">
          <div className="settings-duration-stack">
            <ForceDuration
              fields={fields}
              path="nightModeForceCloseHours"
              title="Часы"
              unit="ч"
              max={23}
              label="Сколько часов держать чат закрытым"
            />
            <ForceDuration
              fields={fields}
              path="nightModeForceCloseDays"
              title="Дни"
              unit="д"
              max={30}
              label="Сколько дней держать чат закрытым"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

export function SharedExtraFields({ fields }: FieldsProps) {
  const hints = useHint();
  return (
    <>
      <Toggle
        fields={fields}
        path="deleteBotMessagesEnabled"
        title="Удалять сообщения бота"
        hints={hints}
        ariaLabel="Включить удаление собственных сообщений бота"
        hint={{
          key: 'deleteBotMessages',
          id: 'delete-bot-messages-hint',
          label: 'Пояснение для удаления своих сообщений ботом',
          text: 'Бот будет автоматически удалять собственные сообщения через выбранное время.',
        }}
      />
      {visible(fields.read('deleteBotMessagesEnabled')) ? <Delay fields={fields} /> : null}
      <Toggle
        fields={fields}
        path="removeBotsFromGroupEnabled"
        title="Удалять других ботов"
        hints={hints}
        ariaLabel="Включить удаление ботов из группы"
        hint={{
          key: 'removeBotsFromGroup',
          id: 'remove-bots-hint',
          label: 'Пояснение для удаления ботов из группы',
          text: 'Если включено, бот-аккаунты будут автоматически удаляться из группы.',
        }}
      />
    </>
  );
}
