import { SharedSettingsStorefrontFields } from './shared-settings-storefront-fields';
import { SharedSettingsCommandFields } from './shared-settings-command-fields';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import type { BroadcastLinkButton } from '@maxim/contracts/broadcast';
import type { NetworkSettingsChange } from '@maxim/contracts/network-settings';
import { SharedBotButtonsFields } from './shared-bot-buttons-fields';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { Spinner } from '../../components/ui/spinner';
import {
  FieldNumber,
  FieldSelect,
  FieldText,
  FieldToggle,
} from '../../features/network-settings/settings-field-controls';
import type {
  ChatMediaFieldPath,
  ChatSettingsFieldAdapter,
  ChatSettingsFieldValues,
} from '../../features/network-settings/field-model';
import {
  setChatBoolean,
  type ChatBooleanField,
  type ChatNumberField,
  type ChatStringField,
} from '../../features/network-settings/chat-field-intents';
import { parseSettingsField } from '../../features/network-settings/field-registry';
import { ReportsSettingsFields } from './reports-settings-fields';
import { SharedMuteStage } from './shared-mute-stage';
import { SharedEscalationFields } from './shared-escalation-fields';
import { SharedNativeSettingsToggle } from './shared-native-settings-toggle';
import { SharedSettingsLimitsFields } from './shared-settings-limits-fields';
import {
  SharedGreetingFields,
  SharedNightFields,
  SharedExtraFields,
} from './shared-settings-lifecycle-fields';
import type { SharedChatSettingsSectionProps } from './shared-chat-settings-section';
import { SharedSpeechField as Speech } from './shared-bot-speech-field';
import { SharedProfanitySettingsFields as LazySharedProfanitySettingsFields } from './shared-profanity-settings-fields';
const LazySharedCommercialSettingsFields = recoverableLazyNamedComponent<{
  fields: ChatSettingsFieldAdapter;
  actions: ReactNode;
  mode?: 'OFF' | 'OBSERVE' | 'DELETE_ONLY';
  scope?: import('./commercial-policy-model').CommercialSettingsScope;
}>(() => import('./shared-commercial-settings-fields'), 'SharedCommercialSettingsFields');
import './shared-chat-settings.css';

type BodyProps = Pick<SharedChatSettingsSectionProps, 'fields' | 'context'>;
type SpeechPath = import('./shared-bot-speech-editor').SharedSpeechPath;
type ButtonPath = {
  [K in keyof ChatSettingsFieldValues]: ChatSettingsFieldValues[K] extends BroadcastLinkButton[]
    ? K
    : never;
}[keyof ChatSettingsFieldValues] &
  string;
const yesOrMixed = (fields: ChatSettingsFieldAdapter, path: ChatBooleanField) => {
  const state = fields.read(path);
  return state.kind !== 'common' || state.value;
};

function Group({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="settings-native-toggle shared-chat-settings-group">
      <h3 className="settings-subsection-title">{title}</h3>
      {hint ? <p className="field__hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function controls(fields: ChatSettingsFieldAdapter) {
  const common = (path: keyof ChatSettingsFieldValues & string) => ({
    disabled: fields.readOnly,
    error: fields.error(path),
    onError: (error: string | null) => fields.setError(path, error),
  });
  return {
    toggle: (path: ChatBooleanField, label: string, description?: ReactNode, disabled = false) => (
      <FieldToggle
        key={path}
        {...common(path)}
        disabled={fields.readOnly || disabled}
        state={fields.read(path)}
        label={label}
        description={description}
        onChange={(value) => setChatBoolean(fields, path, value)}
      />
    ),
    number: (path: ChatNumberField, label: string, min: number, max: number, step = 1) => (
      <FieldNumber
        key={path}
        {...common(path)}
        state={fields.read(path)}
        label={label}
        min={min}
        max={max}
        step={step}
        onChange={(value) => fields.setScalar(path, value)}
      />
    ),
    text: (path: ChatStringField, label: string, maxLength = 1000, multiline = false) => (
      <FieldText
        key={path}
        {...common(path)}
        state={fields.read(path)}
        label={label}
        maxLength={maxLength}
        multiline={multiline}
        onChange={(value) => fields.setScalar(path, value as ChatSettingsFieldValues[typeof path])}
      />
    ),
    select: <K extends ChatStringField>(
      path: K,
      label: string,
      options: readonly { value: ChatSettingsFieldValues[K] & string; label: string }[],
      onChange?: (value: ChatSettingsFieldValues[K]) => void,
    ) => (
      <FieldSelect
        key={path}
        {...common(path)}
        state={fields.read(path)}
        label={label}
        options={options}
        onChange={(value) => (onChange ? onChange(value) : fields.setScalar(path, value))}
      />
    ),
  };
}

function Buttons({
  fields,
  context,
  path,
  enabledPath,
}: BodyProps & { path: ButtonPath; enabledPath: ChatBooleanField }) {
  const labels: Partial<Record<ChatBooleanField, string>> = {
    linkBotButtonEnabled: 'Добавить кнопку в сообщение бота для модерации ссылок',
    messageLimitsBotButtonEnabled: 'Добавить кнопку в сообщение бота для ограничений сообщений',
    textFiltersBotButtonEnabled: 'Добавить кнопку в сообщение бота для коммерческих объявлений',
  };
  return (
    <SharedBotButtonsFields
      fields={fields}
      api={context.api}
      path={path}
      enabledPath={enabledPath}
      activationLabel={labels[enabledPath]}
    />
  );
}

type SanctionPrefix =
  | 'link'
  | 'profanity'
  | 'textFilters'
  | 'duplicate'
  | 'messageLimits'
  | 'phoneNumbers'
  | 'requiredSubscription'
  | 'invitationAccess';
function Sanctions({
  fields,
  context,
  prefix,
  warningText = false,
  buttons = false,
  thresholds = false,
  mandatoryMessage = false,
  header = true,
}: BodyProps & {
  prefix: SanctionPrefix;
  warningText?: boolean;
  buttons?: boolean;
  thresholds?: boolean;
  mandatoryMessage?: boolean;
  header?: boolean;
}) {
  const c = controls(fields);
  const boolean = (suffix: string) => (prefix + suffix) as ChatBooleanField;
  const number = (suffix: string) => (prefix + suffix) as ChatNumberField;
  const speech = (suffix: string) => (prefix + suffix) as SpeechPath;
  const labels = {
    link: [
      'Включить объяснение для модерации ссылок',
      'Редактировать текст сообщения о ссылках',
      'Включить предупреждение за повторные ссылки',
      'Редактировать текст предупреждения за ссылки',
      'Включить блокировку за повторные ссылки',
      'Добавить связь с админом в сообщения о ссылках',
    ],
    profanity: [
      'Включить объяснение для нецензурной лексики',
      'Редактировать объяснение о нецензурной лексике',
      'Включить предупреждение за нецензурную лексику',
      'Редактировать предупреждение о нецензурной лексике',
      'Включить блокировку за повторную нецензурную лексику',
      'Добавить связь с админом в сообщения о нецензурной лексике',
    ],
    textFilters: [
      'Включить сообщение от бота для коммерческих объявлений',
      'Редактировать текст сообщения об удалении рекламы',
      'Включить предупреждение за второе нарушение коммерческого фильтра',
      'Редактировать текст предупреждения об удалении рекламы',
      'Включить блокировку за повторную рекламу',
      'Добавить связь с админом в сообщения о коммерческой рекламе',
    ],
    messageLimits: [
      'Включить сообщение от бота для ограничений сообщений',
      'Редактировать текст сообщения об ограничениях',
      'Включить предупреждение за второе нарушение ограничений сообщений за 12 часов',
      'Редактировать предупреждение об ограничениях',
      'Включить блокировку за повторные нарушения',
      'Добавить связь с админом в сообщения об ограничениях',
    ],
    requiredSubscription: [
      '',
      'Редактировать объяснение об обязательной подписке',
      'Включить предупреждение за второе сообщение без подписки',
      'Редактировать предупреждение об обязательной подписке',
      'Включить блокировку за сообщения без подписки',
      'Добавить связь с админом в сообщения об обязательной подписке',
    ],
  }[prefix as 'link' | 'profanity' | 'textFilters' | 'messageLimits' | 'requiredSubscription'];
  const admin = context.renderAdminContact ? (
    context.renderAdminContact({
      enabledPath: boolean('AdminContactButtonEnabled'),
      urlPath: (prefix + 'AdminContactButtonUrl') as ChatStringField,
      label: labels?.[5] ?? 'Добавить связь с админом',
    })
  ) : (
    <>
      {c.toggle(boolean('AdminContactButtonEnabled'), 'Добавить связь с админом')}
      {yesOrMixed(fields, boolean('AdminContactButtonEnabled'))
        ? c.text(
            (prefix + 'AdminContactButtonUrl') as ChatStringField,
            'Ссылка для связи с админом',
            2000,
          )
        : null}
    </>
  );
  return (
    <>
      {thresholds && (prefix === 'link' || prefix === 'phoneNumbers') ? (
        <SharedEscalationFields
          fields={fields}
          prefix={prefix}
          title={prefix === 'link' ? 'Повторные ссылки' : 'Повторные номера телефонов'}
        />
      ) : null}
      {header ? (
        <div
          className="settings-subsection-divider"
          role="separator"
          aria-label={
            mandatoryMessage ? 'Действия бота для обязательной подписки' : 'Блок действий бота'
          }
        >
          <span>{mandatoryMessage ? 'Без подписки' : 'Действия бота'}</span>
        </div>
      ) : null}
      <Speech
        fields={fields}
        path={speech('BotMessageText')}
        mediaPath={('botSpeechMedia.' + speech('BotMessageText')) as ChatMediaFieldPath}
        label={mandatoryMessage ? '1. Удаление и объяснение' : '1. Объяснение'}
        className={mandatoryMessage ? 'required-subscription__explanation' : undefined}
        enabledPath={mandatoryMessage ? undefined : boolean('BotMessageEnabled')}
        activationLabel={labels?.[0] ?? '1. Сообщение от бота'}
        editLabel={labels?.[1]}
        disableEditorWhenOff={!mandatoryMessage}
      />
      {mandatoryMessage ? admin : null}
      {warningText ? (
        <Speech
          fields={fields}
          path={speech('WarnMessageText')}
          mediaPath={('botSpeechMedia.' + speech('WarnMessageText')) as ChatMediaFieldPath}
          label="2. Предупреждение"
          activationLabel={labels?.[2]}
          editLabel={labels?.[3]}
          enabledPath={boolean('WarnEnabled')}
          nested
        />
      ) : (
        <SharedNativeSettingsToggle
          state={fields.read(boolean('WarnEnabled'))}
          title="2. Предупреждение"
          label={labels?.[2] ?? 'Включить предупреждение'}
          disabled={fields.readOnly}
          nested
          onChange={(enabled) => setChatBoolean(fields, boolean('WarnEnabled'), enabled)}
        />
      )}
      <SharedMuteStage
        fields={fields}
        enabledPath={boolean('MuteEnabled')}
        durationPath={number('MuteDurationHours')}
        title="3. Ограничение"
        durationLabel={
          {
            link: 'за ссылки',
            profanity: 'за нецензурную лексику',
            textFilters: 'за рекламу',
            duplicate: 'за повторы',
            messageLimits: 'за нарушения ограничений',
            phoneNumbers: 'за номера телефонов',
            requiredSubscription: 'за сообщения без подписки',
            invitationAccess: 'за сообщения без приглашения',
          }[prefix]
        }
        onChange={(enabled) => setChatBoolean(fields, boolean('MuteEnabled'), enabled)}
      />
      <SharedNativeSettingsToggle
        state={fields.read(boolean('BanEnabled'))}
        title="4. Блокировка"
        label={labels?.[4] ?? 'Включить блокировку за повторные нарушения'}
        disabled={fields.readOnly}
        nested
        onChange={(enabled) => setChatBoolean(fields, boolean('BanEnabled'), enabled)}
      />
      {buttons && yesOrMixed(fields, boolean('BotMessageEnabled')) ? (
        <Buttons
          fields={fields}
          context={context}
          path={(prefix + 'BotButtons') as ButtonPath}
          enabledPath={boolean('BotButtonEnabled')}
        />
      ) : null}
      {!mandatoryMessage ? admin : null}
    </>
  );
}

function Reports({ fields, context }: BodyProps) {
  return (
    <ReportsSettingsFields
      fields={fields}
      activationAvailable={context.reportsActivationAvailable}
    />
  );
}

const LazySharedLinkSettingsFields = recoverableLazyNamedComponent<
  BodyProps & { sanctions: ReactNode }
>(() => import('./shared-link-settings-fields'), 'SharedLinkSettingsFields');
function Links(props: BodyProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем правила ссылок" />}>
      <LazySharedLinkSettingsFields
        {...props}
        sanctions={
          <Sanctions {...props} prefix="link" warningText buttons thresholds header={false} />
        }
      />
    </Suspense>
  );
}

function Greeting(props: BodyProps) {
  return <SharedGreetingFields {...props} />;
}

function Profanity(props: BodyProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем настройки" />}>
      <LazySharedProfanitySettingsFields
        fields={props.fields}
        actions={<Sanctions {...props} prefix="profanity" warningText header={false} />}
      />
    </Suspense>
  );
}
function Commercial(props: BodyProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем настройки" />}>
      <LazySharedCommercialSettingsFields
        fields={props.fields}
        mode={props.context.commercialAiModerationMode}
        scope={props.context.commercialScope}
        actions={<Sanctions {...props} prefix="textFilters" warningText buttons header={false} />}
      />
    </Suspense>
  );
}

const LazySharedDuplicateSettingsFields = recoverableLazyNamedComponent<BodyProps>(
  () => import('./shared-duplicate-settings-fields'),
  'SharedDuplicateSettingsFields',
);

function Duplicates(props: BodyProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем настройки" />}>
      <LazySharedDuplicateSettingsFields {...props} />
    </Suspense>
  );
}

function Limits(props: BodyProps) {
  return (
    <SharedSettingsLimitsFields
      {...props}
      actions={<Sanctions {...props} prefix="messageLimits" buttons />}
    />
  );
}

const LazySharedStopWordsSettingsFields = recoverableLazyNamedComponent<BodyProps>(
  () => import('./shared-stop-words-settings-fields'),
  'SharedStopWordsSettingsFields',
);
function StopWords(props: BodyProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем стоп-слова" />}>
      <LazySharedStopWordsSettingsFields {...props} />
    </Suspense>
  );
}

function Phones(props: BodyProps) {
  const c = controls(props.fields);
  return (
    <>
      <Group
        title="Номера телефонов"
        hint="Когда номера запрещены, бот проверяет текст сообщений и применяет выбранные меры."
      >
        {c.toggle('phoneNumbersEnabled', 'Разрешить номера телефонов')}
      </Group>
      <Sanctions {...props} prefix="messageLimits" buttons />
    </>
  );
}

function Night(props: BodyProps) {
  return <SharedNightFields {...props} />;
}

function RequiredSubscriptionButtonText({ fields }: Pick<BodyProps, 'fields'>) {
  const state = fields.read('requiredSubscriptionButtonText');
  const [buffer, setBuffer] = useState<string | null>(null);
  const key = state.kind === 'common' ? state.value : state.kind;
  useEffect(() => setBuffer(null), [key]);
  return (
    <label className="field settings-text-field required-subscription__button-label">
      <span>Текст кнопки</span>
      <input
        type="text"
        maxLength={32}
        placeholder={state.kind === 'mixed' ? 'Разные значения' : 'Канал'}
        value={buffer ?? (state.kind === 'common' ? state.value : '')}
        disabled={fields.readOnly || state.kind === 'loading'}
        onChange={(event) => {
          const value = event.target.value;
          setBuffer(value);
          try {
            fields.setScalar('requiredSubscriptionButtonText', value);
            fields.setError('requiredSubscriptionButtonText', null);
          } catch {
            fields.setError('requiredSubscriptionButtonText', 'Проверьте текст кнопки.');
          }
        }}
      />
      {fields.error('requiredSubscriptionButtonText') ? (
        <small className="field__hint" role="alert">
          {fields.error('requiredSubscriptionButtonText')}
        </small>
      ) : null}
    </label>
  );
}
function RequiredSubscription(props: BodyProps) {
  return (
    <div className="managed-giveaway required-subscription__workspace">
      {props.context.requiredSubscriptionSources}
      <div className="required-subscription__actions">
        <Sanctions {...props} prefix="requiredSubscription" warningText mandatoryMessage />
        <RequiredSubscriptionButtonText fields={props.fields} />
      </div>
    </div>
  );
}

function Invitation(props: BodyProps) {
  const c = controls(props.fields);
  return (
    <>
      <Group
        title="Доступ за приглашения"
        hint="Активация этой функции пока недоступна. Параметры можно подготовить и сохранить для будущего включения."
      >
        {c.toggle(
          'invitationAccessEnabled',
          'Включить доступ за приглашения',
          undefined,
          !props.context.invitationActivationAvailable,
        )}
        {c.number('invitationAccessRequiredCount', 'Сколько участников пригласить', 1, 10)}
      </Group>
      <Sanctions {...props} prefix="invitationAccess" warningText />
    </>
  );
}

function Commands({ fields }: BodyProps) {
  return <SharedSettingsCommandFields fields={fields} />;
}

function Storefront({ fields, context }: BodyProps) {
  return <SharedSettingsStorefrontFields fields={fields} scope={context.mode} />;
}

function Extra(props: BodyProps) {
  return <SharedExtraFields {...props} />;
}

const SECTION_BODIES = {
  reports: Reports,
  links: Links,
  greeting: Greeting,
  profanityFilter: Profanity,
  commercialFilter: Commercial,
  duplicates: Duplicates,
  limits: Limits,
  stopWords: StopWords,
  phones: Phones,
  night: Night,
  requiredSubscription: RequiredSubscription,
  invitationAccess: Invitation,
  commands: Commands,
  storefront: Storefront,
  extra: Extra,
} satisfies Record<SharedChatSettingsSectionProps['section'], (props: BodyProps) => ReactNode>;

export function SharedChatSettingsFields({
  section,
  fields,
  context,
}: SharedChatSettingsSectionProps) {
  const Body = SECTION_BODIES[section];
  const publish = (changes: Parameters<ChatSettingsFieldAdapter['transact']>[0]) => {
    let currentPath = changes[0]?.path;
    try {
      const checked: NetworkSettingsChange[] = changes.map((change) => {
        currentPath = change.path;
        if (change.op === 'clear') return change;
        const value = parseSettingsField('chat', section, change.path, change.value);
        if (change.op === 'replace') {
          if (!Array.isArray(value)) throw new Error('Для списка требуется явная замена.');
          return { op: 'replace', path: change.path, value };
        }
        return { op: 'set', path: change.path, value };
      });
      fields.transact(checked);
      for (const change of changes)
        fields.setError(change.path as keyof ChatSettingsFieldValues, null);
    } catch (cause) {
      if (currentPath)
        fields.setError(
          currentPath as keyof ChatSettingsFieldValues,
          cause instanceof Error ? cause.message : 'Проверьте значение поля.',
        );
    }
  };
  const guarded: ChatSettingsFieldAdapter = {
    ...fields,
    setScalar: (path, value) => publish([{ op: 'set', path, value }]),
    replaceList: (path, value) => publish([{ op: 'replace', path, value }]),
    transact: publish,
  };
  return (
    <div className="shared-chat-settings-fields" data-settings-section={section}>
      {context.runtimeNotes?.[section]}
      <Body fields={guarded} context={context} />
      {context.sectionTools?.[section]}
    </div>
  );
}
