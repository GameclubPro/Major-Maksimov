import {
  lazy,
  Suspense,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useId,
  useState,
  type ReactNode,
} from 'react';
import {
  normalizeStopWordsValue,
  stopWordsRuleSchema,
  stopWordsPolicySchema,
  type StopWordsRule,
} from '@maxim/contracts/settings';
import type { BroadcastLinkButton } from '@maxim/contracts/broadcast';
import type {
  ChatSettingsFieldAdapter,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import type { ChatBooleanField } from '../../features/network-settings/chat-field-intents';
import { FieldList } from '../../features/network-settings/settings-field-controls';
import { prepareStopWordsLists } from '../../lib/stop-words-editor';
import { AppIcon } from '../../components/ui/app-icon';
import { SegmentedControl } from '../../components/ui/segmented-control';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { Spinner } from '../../components/ui/spinner';
import type { SharedChatSettingsSectionProps } from './shared-chat-settings-section';
import type { StopWordsFieldPath, StopWordsFocusRequest } from './stop-words-settings-feedback';
import './stop-words-policy-editor.css';

const Presets = lazy(() =>
  import('./shared-stop-words-preset-buttons').then((module) => ({
    default: module.SharedStopWordsPresetButtons,
  })),
);
const SpeechEditor = lazy(() =>
  import('./shared-bot-speech-editor').then((module) => ({
    default: module.SharedBotSpeechEditor,
  })),
);
type Props = Pick<SharedChatSettingsSectionProps, 'fields' | 'context'> & {
  presentation?: 'words' | 'sites';
};
const shown = (state: SettingsFieldState<boolean>) => state.kind !== 'common' || state.value;
const PENDING_INPUT_MESSAGE = 'Добавьте введённые записи или очистите ввод.';
const PENDING_EDIT_MESSAGE = 'Примените изменение записи или отмените ввод.';

function Toggle({
  label,
  state,
  onChange,
  children,
  field,
  error,
  focusKey,
}: {
  label: string;
  state: SettingsFieldState<boolean>;
  onChange: (value: boolean) => void;
  children?: ReactNode;
  field?: StopWordsFieldPath;
  error?: string | null;
  focusKey?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state.kind === 'mixed';
  }, [state.kind]);
  return (
    <div className="stop-words-editor__toggle" data-stop-words-field={field}>
      <span>{label}</span>
      {children}
      {state.kind === 'mixed' ? <small>Разные значения</small> : null}
      <label className="settings-native-switch" aria-label={label}>
        <input
          ref={ref}
          type="checkbox"
          checked={state.kind === 'common' && state.value}
          aria-checked={state.kind === 'mixed' ? 'mixed' : state.kind === 'common' && state.value}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? errorId : undefined}
          data-stop-words-rule-field={focusKey}
          disabled={state.kind === 'loading'}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </label>
      {error ? (
        <small id={errorId} role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

type ListProps = {
  fields: ChatSettingsFieldAdapter;
  active: boolean;
  toolbar?: ReactNode;
  notice?: ReactNode;
  focusRequest?: StopWordsFocusRequest;
} & (
  | { mode: 'words'; items: StopWordsRule[]; replace: (next: StopWordsRule[]) => void }
  | { mode: 'domains'; items: string[]; replace: (next: string[]) => void }
);
function StopWordsListEditor(props: ListProps) {
  const { fields, mode } = props;
  const resultId = useId();
  const ruleErrorId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const ruleRootRef = useRef<HTMLDivElement>(null);
  const ruleInitialFocusRef = useRef<HTMLElement | null>(null);
  const path = mode === 'words' ? 'stopWordsPolicy.rules' : 'stopWordsPolicy.domains';
  const rules = props.mode === 'words' ? props.items : [];
  const domains = props.mode === 'domains' ? props.items : [];
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(100);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingRule, setEditingRule] = useState<StopWordsRule | null>(null);
  const [editError, setEditError] = useState('');
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetError, setPresetError] = useState('');
  useLayoutEffect(() => {
    const index = props.focusRequest?.path[2];
    const leaf =
      props.focusRequest?.field === path &&
      typeof index === 'number' &&
      rules[index]?.id === editingRule?.id
        ? props.focusRequest.path[3]
        : 'value';
    const target = leaf === 'enabled' || leaf === 'matchMode' ? leaf : 'value';
    ruleInitialFocusRef.current =
      ruleRootRef.current?.querySelector<HTMLElement>(`[data-stop-words-rule-field="${target}"]`) ??
      null;
  }, [editingRule, props.focusRequest?.requestId]);
  useEffect(() => {
    if (!props.active || props.focusRequest?.field !== path) return;
    const index = props.focusRequest.path[2];
    if (mode === 'words' && typeof index === 'number' && rules[index]) {
      setEditingRule({ ...rules[index] });
      setEditError(fields.error(path) ?? 'Проверьте запись.');
    }
    const frame = requestAnimationFrame(() => {
      if (ruleRootRef.current) {
        const leaf = props.focusRequest?.path[3];
        const target = leaf === 'enabled' || leaf === 'matchMode' ? leaf : 'value';
        ruleRootRef.current
          .querySelector<HTMLInputElement>(`[data-stop-words-rule-field="${target}"]`)
          ?.focus();
      } else {
        inputRef.current?.focus();
        inputRef.current?.scrollIntoView({ block: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.focusRequest?.requestId, props.active]);
  const prepared = useMemo(
    () =>
      prepareStopWordsLists(
        { rules, domains },
        mode === 'words' ? input : '',
        mode === 'domains' ? input : '',
      ),
    [rules, domains, mode, input],
  );
  const filtered = (
    mode === 'words'
      ? rules
          .filter((rule) =>
            normalizeStopWordsValue(rule.value).includes(normalizeStopWordsValue(query)),
          )
          .map((rule) => ({ id: rule.id, value: rule.value, rule }))
      : domains
          .filter((domain) => domain.includes(query.trim().toLowerCase()))
          .map((domain) => ({ id: domain, value: domain, rule: null }))
  ).reverse();
  const dirtyRule =
    Boolean(editingRule) &&
    JSON.stringify(editingRule) !==
      JSON.stringify(rules.find((rule) => rule.id === editingRule?.id));
  const fieldError = fields.error(path);
  const pending = fieldError === PENDING_INPUT_MESSAGE || fieldError === PENDING_EDIT_MESSAGE;
  const clearError = () => fields.setError(path, null);
  const cancelRule = () => {
    setEditingRule(null);
    setEditError('');
    clearError();
  };
  const replaceRules = (next: StopWordsRule[]) => {
    if (props.mode === 'words') props.replace(next);
  };
  const replaceDomains = (next: string[]) => {
    if (props.mode === 'domains') props.replace(next);
  };
  const applyInput = () => {
    if (!input.trim() || prepared.errors.length) return;
    if (mode === 'words') replaceRules(prepared.lists.rules);
    else replaceDomains(prepared.lists.domains);
    setInput('');
    setQuery('');
    setLimit(100);
    clearError();
  };
  const saveRule = () => {
    if (!editingRule) return;
    const parsed = stopWordsRuleSchema.safeParse({
      ...editingRule,
      kind: normalizeStopWordsValue(editingRule.value).includes(' ') ? 'PHRASE' : 'WORD',
    });
    if (!parsed.success) {
      setEditError(parsed.error.issues[0]?.message ?? 'Проверьте запись.');
      return;
    }
    if (
      rules.some(
        (rule) =>
          rule.id !== parsed.data.id &&
          normalizeStopWordsValue(rule.value) === normalizeStopWordsValue(parsed.data.value),
      )
    ) {
      setEditError('Такая запись уже есть в списке.');
      return;
    }
    replaceRules(rules.map((rule) => (rule.id === parsed.data.id ? parsed.data : rule)));
    cancelRule();
  };
  return (
    <>
      <div className="stop-words-editor__input">
        <textarea
          ref={inputRef}
          rows={2}
          value={input}
          maxLength={160000}
          aria-label={mode === 'words' ? 'Добавить слова и фразы' : 'Добавить запрещённые сайты'}
          aria-invalid={Boolean((fieldError && !pending) || prepared.errors.length)}
          aria-describedby={resultId}
          placeholder={mode === 'words' ? 'Слово или фраза' : 'example.com'}
          inputMode={mode === 'domains' ? 'url' : 'text'}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => {
            setInput(event.target.value);
            fields.setError(path, event.target.value.trim() ? PENDING_INPUT_MESSAGE : null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              applyInput();
            }
          }}
        />
        <button
          type="button"
          className="stop-words-editor__icon"
          title="Добавить записи"
          aria-label="Добавить записи"
          disabled={!input.trim() || Boolean(prepared.errors.length)}
          onClick={applyInput}
        >
          <AppIcon icon="Plus" />
        </button>
      </div>
      <div id={resultId} className="stop-words-editor__input-result" aria-live="polite">
        {fieldError ? <p role={pending ? 'status' : 'alert'}>{fieldError}</p> : null}
        {prepared.errors.map((message, index) => (
          <p role="alert" key={index}>
            {message}
          </p>
        ))}
        {input.trim() && !prepared.errors.length ? (
          <>
            <span>
              Добавится: {prepared.added.length}. Уже в списке: {prepared.duplicates.length}.
            </span>
            <div className="stop-words-editor__preview-values">
              {prepared.added.slice(0, 20).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="stop-words-editor__toolbar">
        <label className="stop-words-editor__search">
          <AppIcon icon="Search" />
          <input
            type="search"
            aria-label="Поиск по списку"
            placeholder="Поиск"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(100);
            }}
          />
        </label>
        {mode === 'words' ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setPresetsOpen(true)}
          >
            Наборы
          </button>
        ) : null}
        {props.toolbar}
      </div>
      {props.notice}
      <div className="stop-words-editor__selection">
        <label>
          <input
            type="checkbox"
            aria-label="Выбрать найденные записи"
            checked={filtered.length > 0 && filtered.every((item) => selected.includes(item.id))}
            onChange={(event) =>
              setSelected(event.target.checked ? filtered.map((item) => item.id) : [])
            }
          />
          {selected.length ? 'Выбрано: ' + selected.length : 'Всего: ' + filtered.length}
        </label>
        <button
          type="button"
          className="stop-words-editor__icon"
          title="Удалить выбранное"
          aria-label="Удалить выбранное"
          disabled={!selected.length || Boolean(input.trim())}
          onClick={() => setConfirmDelete(true)}
        >
          <AppIcon icon="Trash" />
        </button>
      </div>
      <div
        className="stop-words-editor__list"
        aria-label={mode === 'words' ? 'Список слов и фраз' : 'Список сайтов'}
      >
        {!filtered.length ? (
          <p className="stop-words-editor__empty">{query ? 'Совпадений нет' : 'Список пуст'}</p>
        ) : null}
        {filtered.slice(0, limit).map(({ id, value, rule }) => (
          <div key={id} className="stop-words-editor__row">
            <label className="stop-words-editor__selection-box">
              <input
                type="checkbox"
                checked={selected.includes(id)}
                aria-label={'Выбрать ' + value}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked ? [...current, id] : current.filter((item) => item !== id),
                  )
                }
              />
            </label>
            <div className="stop-words-editor__value">
              <span>{value}</span>
              {rule ? (
                <small>
                  {rule.matchMode === 'MASKED' ? 'С маскировками' : 'Точное совпадение'}
                </small>
              ) : null}
            </div>
            {rule ? (
              <>
                <label className="settings-native-switch" aria-label={'Включить правило ' + value}>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={Boolean(input.trim())}
                    onChange={(event) =>
                      replaceRules(
                        rules.map((item) =>
                          item.id === id ? { ...item, enabled: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  <span className="toggle-switch" aria-hidden>
                    <span className="toggle-switch__thumb" />
                  </span>
                </label>
                <button
                  type="button"
                  className="stop-words-editor__icon"
                  title="Редактировать"
                  aria-label={'Редактировать ' + value}
                  disabled={Boolean(input.trim())}
                  onClick={() => {
                    setEditError('');
                    setEditingRule({ ...rule });
                  }}
                >
                  <AppIcon icon="EditPencil" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="stop-words-editor__icon"
                title="Удалить сайт"
                aria-label={'Удалить ' + value}
                disabled={Boolean(input.trim())}
                onClick={() => {
                  replaceDomains(domains.filter((item) => item !== value));
                  setSelected((current) => current.filter((item) => item !== value));
                }}
              >
                <AppIcon icon="Trash" />
              </button>
            )}
          </div>
        ))}
        {filtered.length > limit ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setLimit((current) => current + 100)}
          >
            Показать ещё
          </button>
        ) : null}
      </div>
      <ActionConfirmSheet
        id="stop-words-delete"
        open={confirmDelete}
        title="Удалить выбранные записи?"
        summary={'Записей: ' + selected.length}
        confirmLabel="Удалить"
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => {
          if (mode === 'words') replaceRules(rules.filter((rule) => !selected.includes(rule.id)));
          else replaceDomains(domains.filter((domain) => !selected.includes(domain)));
          setSelected([]);
          setConfirmDelete(false);
        }}
      />
      <SettingsDrilldownPanel
        id="stop-words-rule-editor"
        open={Boolean(editingRule)}
        title="Правило"
        initialFocusRef={ruleInitialFocusRef}
        confirmCloseWhen={dirtyRule}
        onClose={cancelRule}
        onDiscardChanges={cancelRule}
        footer={
          <button type="button" className="button button--accent" onClick={saveRule}>
            <AppIcon icon="Check" />
            Применить
          </button>
        }
      >
        {editingRule ? (
          <div className="stop-words-editor" ref={ruleRootRef}>
            <input
              autoFocus
              data-stop-words-rule-field="value"
              aria-invalid={Boolean(editError) || undefined}
              aria-describedby={editError ? ruleErrorId : undefined}
              aria-label="Слово или фраза"
              value={editingRule.value}
              maxLength={160}
              onChange={(event) => {
                setEditError('');
                setEditingRule({ ...editingRule, value: event.target.value });
                fields.setError(path, PENDING_EDIT_MESSAGE);
              }}
            />
            <Toggle
              label="Правило включено"
              focusKey="enabled"
              state={{ kind: 'common', value: editingRule.enabled }}
              onChange={(enabled) => {
                setEditingRule({ ...editingRule, enabled });
                fields.setError(path, PENDING_EDIT_MESSAGE);
              }}
            />
            <Toggle
              label="Распознавать маскировки"
              focusKey="matchMode"
              state={{ kind: 'common', value: editingRule.matchMode === 'MASKED' }}
              onChange={(masked) => {
                setEditingRule({ ...editingRule, matchMode: masked ? 'MASKED' : 'EXACT' });
                fields.setError(path, PENDING_EDIT_MESSAGE);
              }}
            />
            {editError ? (
              <p id={ruleErrorId} role="alert">
                {editError}
              </p>
            ) : null}
          </div>
        ) : null}
      </SettingsDrilldownPanel>
      <SettingsDrilldownPanel
        id="stop-words-presets"
        open={presetsOpen}
        title="Наборы"
        onClose={() => setPresetsOpen(false)}
      >
        <div className="stop-words-editor">
          <Suspense fallback={<Spinner label="Загружаем наборы" />}>
            <Presets
              items={rules}
              disabled={fields.readOnly || Boolean(input.trim())}
              replace={(next) => {
                replaceRules(next);
                setPresetError('');
                setPresetsOpen(false);
              }}
              onError={setPresetError}
            />
          </Suspense>
          {presetError ? <p role="alert">{presetError}</p> : null}
        </div>
      </SettingsDrilldownPanel>
    </>
  );
}

function StopWordsButtons({
  fields,
  items,
  replace,
  focusRequest,
}: {
  fields: ChatSettingsFieldAdapter;
  items: BroadcastLinkButton[];
  replace: (items: BroadcastLinkButton[]) => void;
  focusRequest?: StopWordsFocusRequest;
}) {
  const [buffer, setBuffer] = useState<BroadcastLinkButton[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const error = fields.error('stopWordsPolicy.sanctions.botButtons');
  const buttons = buffer ?? items;
  const validation = useMemo(
    () => stopWordsPolicySchema.safeParse({ sanctions: { botButtons: buttons } }),
    [buttons],
  );
  useEffect(() => {
    if (focusRequest?.field !== 'stopWordsPolicy.sanctions.botButtons') return;
    const localPath = validation.success ? null : validation.error.issues[0]?.path;
    const index = typeof focusRequest.path[3] === 'number' ? focusRequest.path[3] : localPath?.[2];
    const leaf = typeof focusRequest.path[4] === 'string' ? focusRequest.path[4] : localPath?.[3];
    const frame = requestAnimationFrame(() => {
      const target =
        typeof index === 'number' && (leaf === 'text' || leaf === 'url')
          ? rootRef.current?.querySelector<HTMLElement>(
              `[data-stop-words-button-index="${index}"][data-stop-words-button-field="${leaf}"]`,
            )
          : rootRef.current?.querySelector<HTMLElement>('input,button');
      target?.focus();
      target?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest?.requestId]);
  const change = (next: BroadcastLinkButton[]) => {
    const parsed = stopWordsPolicySchema.safeParse({ sanctions: { botButtons: next } });
    if (!parsed.success) {
      setBuffer(next);
      fields.setError(
        'stopWordsPolicy.sanctions.botButtons',
        'Укажите название и корректную ссылку для каждой кнопки.',
      );
      return;
    }
    setBuffer(null);
    replace(parsed.data.sanctions.botButtons);
    fields.setError('stopWordsPolicy.sanctions.botButtons', null);
  };
  return (
    <div
      ref={rootRef}
      className="stop-words-editor__buttons"
      data-stop-words-field="stopWordsPolicy.sanctions.botButtons"
    >
      {buttons.map((button, index) => (
        <div key={index}>
          <input
            aria-label={'Название кнопки ' + (index + 1)}
            data-stop-words-button-index={index}
            data-stop-words-button-field="text"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
            value={button.text}
            maxLength={32}
            onChange={(event) =>
              change(
                buttons.map((item, i) =>
                  i === index ? { ...item, text: event.target.value } : item,
                ),
              )
            }
          />
          <input
            type="url"
            aria-label={'Ссылка кнопки ' + (index + 1)}
            data-stop-words-button-index={index}
            data-stop-words-button-field="url"
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? errorId : undefined}
            value={button.url}
            onChange={(event) =>
              change(
                buttons.map((item, i) =>
                  i === index ? { ...item, url: event.target.value } : item,
                ),
              )
            }
          />
          <button
            type="button"
            className="stop-words-editor__icon"
            title="Удалить кнопку"
            aria-label={'Удалить кнопку ' + (index + 1)}
            onClick={() => change(buttons.filter((_, i) => i !== index))}
          >
            <AppIcon icon="Trash" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button button--ghost"
        disabled={fields.readOnly || buttons.length >= 8}
        onClick={() => change([...buttons, { text: '', url: '' }])}
      >
        <AppIcon icon="Plus" />
        Добавить кнопку
      </button>
      {error ? (
        <p id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function StopWordsMuteDuration({ fields }: { fields: ChatSettingsFieldAdapter }) {
  const path = 'stopWordsPolicy.sanctions.muteDurationHours';
  const state = fields.read(path);
  const [buffer, setBuffer] = useState<string | null>(null);
  const errorId = useId();
  const error = fields.error(path);
  return (
    <label className="stop-words-editor__field">
      Длительность ограничения, часов
      <input
        type="number"
        min={1}
        max={168}
        aria-label="Длительность ограничения, часов"
        data-stop-words-field={path}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? errorId : undefined}
        value={buffer ?? (state.kind === 'common' ? state.value : '')}
        placeholder={state.kind === 'mixed' ? 'Разные значения' : undefined}
        disabled={state.kind === 'loading'}
        onChange={(event) => {
          const raw = event.target.value;
          setBuffer(raw);
          const value = Number(raw);
          if (!raw.trim() || !Number.isInteger(value) || value < 1 || value > 168) {
            fields.setError(path, 'Укажите от 1 до 168 часов.');
            return;
          }
          setBuffer(null);
          fields.setScalar(path, value);
          fields.setError(path, null);
        }}
      />
      {error ? (
        <span id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

function StopWordsAdminUrl({ fields }: { fields: ChatSettingsFieldAdapter }) {
  const path = 'stopWordsPolicy.sanctions.adminContactButtonUrl';
  const state = fields.read(path);
  const [buffer, setBuffer] = useState<string | null>(null);
  const errorId = useId();
  const error = fields.error(path);
  const key = state.kind === 'common' ? state.value : state.kind;
  useEffect(() => setBuffer(null), [key]);
  return (
    <>
      <input
        type="url"
        aria-label="Ссылка администратора"
        data-stop-words-field={path}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? errorId : undefined}
        value={buffer ?? (state.kind === 'common' ? state.value : '')}
        placeholder={state.kind === 'mixed' ? 'Разные значения' : undefined}
        disabled={state.kind === 'loading'}
        onChange={(event) => {
          setBuffer(event.target.value);
          fields.setScalar(path, event.target.value);
          fields.setError(path, null);
        }}
      />
      {error ? (
        <p id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

export function SharedStopWordsSettingsFields({ fields, context, presentation = 'words' }: Props) {
  const [networkMode, setNetworkMode] = useState<'words' | 'domains'>('words');
  const mode =
    presentation === 'sites' ? 'domains' : context.mode === 'network' ? networkMode : 'words';
  const [speech, setSpeech] = useState<'explanation' | 'warning' | null>(null);
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const sanctionsRef = useRef<HTMLDetailsElement>(null);
  const imageScanRef = useRef<HTMLDetailsElement>(null);
  const [replacementAction, setReplacementAction] = useState<(() => void) | null>(null);
  const editor = context.stopWordsEditor;
  const storageBlocked = editor?.storageStatus === 'invalid' && !editor.replacementAuthorized;
  const focusRequest = editor?.focusRequest;
  useEffect(() => {
    if (!focusRequest || storageBlocked) return;
    const { field } = focusRequest;
    if (context.mode === 'network' && field === 'stopWordsPolicy.domains')
      setNetworkMode('domains');
    if (context.mode === 'network' && field === 'stopWordsPolicy.rules') setNetworkMode('words');
    if (field.startsWith('stopWordsPolicy.sanctions.') && sanctionsRef.current)
      sanctionsRef.current.open = true;
    if (field === 'stopWordsPolicy.imageScanEnabled' && imageScanRef.current)
      imageScanRef.current.open = true;
    if (
      field === 'stopWordsPolicy.sanctions.botMessageText' ||
      field.endsWith('.media.explanation')
    ) {
      setSpeech('explanation');
      return;
    }
    if (field === 'stopWordsPolicy.sanctions.warnMessageText' || field.endsWith('.media.warning')) {
      setSpeech('warning');
      return;
    }
    setSpeech(null);
    if (field === 'stopWordsPolicy.sanctions.botButtons') return;
    const frame = requestAnimationFrame(() => {
      const owner = rootRef.current?.querySelector<HTMLElement>(
        `[data-stop-words-field="${field}"]`,
      );
      const target = owner?.matches('input,textarea,button')
        ? owner
        : owner?.querySelector<HTMLElement>('input,textarea,button');
      target?.focus();
      target?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest?.requestId, storageBlocked]);
  const rules = fields.read('stopWordsPolicy.rules');
  const domains = fields.read('stopWordsPolicy.domains');
  const buttons = fields.read('stopWordsPolicy.sanctions.botButtons');
  const state = (path: ChatBooleanField) => fields.read(path);
  const toggle = (path: ChatBooleanField, label: string, children?: ReactNode) => (
    <Toggle
      label={label}
      field={path as StopWordsFieldPath}
      error={fields.error(path)}
      state={state(path)}
      onChange={(next) => {
        fields.setScalar(path, next);
        fields.setError(path, null);
        if (!next && path === 'stopWordsPolicy.sanctions.botButtonEnabled')
          fields.setError('stopWordsPolicy.sanctions.botButtons', null);
        if (!next && path === 'stopWordsPolicy.sanctions.adminContactButtonEnabled')
          fields.setError('stopWordsPolicy.sanctions.adminContactButtonUrl', null);
        if (!next && path === 'stopWordsPolicy.sanctions.muteEnabled')
          fields.setError('stopWordsPolicy.sanctions.muteDurationHours', null);
      }}
    >
      {children}
    </Toggle>
  );
  const sanctionStates = [
    'stopWordsPolicy.sanctions.botMessageEnabled',
    'stopWordsPolicy.sanctions.warnEnabled',
    'stopWordsPolicy.sanctions.muteEnabled',
    'stopWordsPolicy.sanctions.banEnabled',
  ] as const;
  const commonSanctions = sanctionStates.every((path) => state(path).kind === 'common');
  const duration = fields.read('stopWordsPolicy.sanctions.muteDurationHours');
  const summary = commonSanctions
    ? [
        shown(state('stopWordsPolicy.sanctions.botMessageEnabled')) ? 'Объяснение' : '',
        shown(state('stopWordsPolicy.sanctions.warnEnabled')) ? 'Предупреждение' : '',
        shown(state('stopWordsPolicy.sanctions.muteEnabled'))
          ? duration.kind === 'common'
            ? 'Ограничение ' + duration.value + ' ч'
            : 'Ограничение · разный срок'
          : '',
        shown(state('stopWordsPolicy.sanctions.banEnabled')) ? 'Блокировка' : '',
      ]
        .filter(Boolean)
        .join(' · ') || 'Только удаление'
    : 'Разные значения';
  if (
    (rules.kind === 'common' && !Array.isArray(rules.value)) ||
    (domains.kind === 'common' && !Array.isArray(domains.value))
  )
    return <div role="alert">Не удалось загрузить стоп-слова. Обновите настройки.</div>;
  return (
    <>
      {storageBlocked ? (
        <div role="alert">
          <p>Сохранённые настройки стоп-слов требуют проверки.</p>
          <button
            type="button"
            className="button button--accent"
            disabled={fields.readOnly}
            onClick={() => {
              if (editor) setReplacementAction(() => editor.onAuthorizeReplacement);
            }}
          >
            Создать новый список
          </button>
        </div>
      ) : null}
      {editor?.moduleError ? <p role="alert">{editor.moduleError}</p> : null}
      <ActionConfirmSheet
        id="shared-stop-words-replace"
        open={replacementAction !== null}
        title="Создать новый список?"
        summary="Сохранённые настройки будут заменены после сохранения нового списка."
        confirmLabel="Создать"
        onClose={() => setReplacementAction(null)}
        onConfirm={() => {
          replacementAction?.();
          setReplacementAction(null);
        }}
      />
      <fieldset
        ref={rootRef}
        className="stop-words-editor"
        disabled={fields.readOnly || storageBlocked}
        hidden={storageBlocked}
        style={storageBlocked ? { display: 'none' } : undefined}
      >
        {toggle(
          'stopWordsPolicy.enabled',
          presentation === 'sites' ? 'Запрещённые сайты включены' : 'Стоп-слова включены',
        )}
        {context.mode === 'network' && presentation === 'words' ? (
          <SegmentedControl
            value={networkMode}
            ariaLabel="Запрещённые слова и сайты"
            options={[
              {
                value: 'words',
                label: 'Слова и фразы',
                count: rules.kind === 'common' ? rules.value.length : undefined,
              },
              {
                value: 'domains',
                label: 'Сайты',
                count: domains.kind === 'common' ? domains.value.length : undefined,
              },
            ]}
            onChange={setNetworkMode}
          />
        ) : null}
        {presentation !== 'sites' ? (
          <div hidden={mode !== 'words'}>
            {rules.kind === 'common' ? (
              <StopWordsListEditor
                key="words"
                mode="words"
                active={mode === 'words'}
                focusRequest={focusRequest}
                fields={fields}
                items={rules.value}
                replace={(next) => fields.replaceList('stopWordsPolicy.rules', next)}
                toolbar={mode === 'words' ? context.stopWordsTools?.toolbar : null}
                notice={mode === 'words' ? context.stopWordsTools?.notice : null}
              />
            ) : (
              <FieldList<StopWordsRule>
                label="Слова и фразы"
                state={rules}
                disabled={fields.readOnly}
                onChange={(next) => fields.replaceList('stopWordsPolicy.rules', next)}
              >
                {(items, replace) => (
                  <StopWordsListEditor
                    key="words"
                    mode="words"
                    active={mode === 'words'}
                    focusRequest={focusRequest}
                    fields={fields}
                    items={items}
                    replace={replace}
                  />
                )}
              </FieldList>
            )}
          </div>
        ) : null}
        {presentation === 'sites' || context.mode === 'network' ? (
          <div hidden={mode !== 'domains'}>
            {domains.kind === 'common' ? (
              <StopWordsListEditor
                key="domains"
                mode="domains"
                active={mode === 'domains'}
                focusRequest={focusRequest}
                fields={fields}
                items={domains.value}
                replace={(next) => fields.replaceList('stopWordsPolicy.domains', next)}
                toolbar={mode === 'domains' ? context.stopWordsTools?.toolbar : null}
                notice={mode === 'domains' ? context.stopWordsTools?.notice : null}
              />
            ) : (
              <FieldList<string>
                label="Сайты"
                state={domains}
                disabled={fields.readOnly}
                onChange={(next) => fields.replaceList('stopWordsPolicy.domains', next)}
              >
                {(items, replace) => (
                  <StopWordsListEditor
                    key="domains"
                    mode="domains"
                    active={mode === 'domains'}
                    focusRequest={focusRequest}
                    fields={fields}
                    items={items}
                    replace={replace}
                  />
                )}
              </FieldList>
            )}
          </div>
        ) : null}
        {presentation === 'words' ? context.stopWordsTools?.preview : null}
        <details ref={sanctionsRef} className="stop-words-editor__section">
          <summary>
            Наказания и сообщения бота<small>{summary}</small>
          </summary>
          {toggle(
            'stopWordsPolicy.sanctions.botMessageEnabled',
            'Объяснение',
            <button
              type="button"
              className="stop-words-editor__icon"
              title="Изменить объяснение"
              aria-label="Изменить объяснение"
              onClick={() => setSpeech('explanation')}
            >
              <AppIcon icon="EditPencil" />
            </button>,
          )}
          {toggle(
            'stopWordsPolicy.sanctions.warnEnabled',
            'Предупреждение',
            <button
              type="button"
              className="stop-words-editor__icon"
              title="Изменить предупреждение"
              aria-label="Изменить предупреждение"
              onClick={() => setSpeech('warning')}
            >
              <AppIcon icon="EditPencil" />
            </button>,
          )}
          {toggle('stopWordsPolicy.sanctions.muteEnabled', 'Ограничение')}
          {shown(state('stopWordsPolicy.sanctions.muteEnabled')) ||
          fields.error('stopWordsPolicy.sanctions.muteDurationHours') ? (
            <StopWordsMuteDuration fields={fields} />
          ) : null}
          {toggle('stopWordsPolicy.sanctions.banEnabled', 'Блокировка')}
          {toggle('stopWordsPolicy.sanctions.rulesButtonEnabled', 'Кнопка правил')}
          {toggle(
            'stopWordsPolicy.sanctions.adminContactButtonEnabled',
            'Связаться с администратором',
          )}
          {shown(state('stopWordsPolicy.sanctions.adminContactButtonEnabled')) ||
          fields.error('stopWordsPolicy.sanctions.adminContactButtonUrl') ? (
            <StopWordsAdminUrl fields={fields} />
          ) : null}
          {toggle('stopWordsPolicy.sanctions.botButtonEnabled', 'Кнопки сообщения')}
          {shown(state('stopWordsPolicy.sanctions.botButtonEnabled')) ||
          fields.error('stopWordsPolicy.sanctions.botButtons') ? (
            buttons.kind === 'common' ? (
              <StopWordsButtons
                fields={fields}
                focusRequest={focusRequest}
                items={buttons.value}
                replace={(next) => fields.replaceList('stopWordsPolicy.sanctions.botButtons', next)}
              />
            ) : (
              <FieldList<BroadcastLinkButton>
                label="Кнопки сообщения"
                state={buttons}
                disabled={fields.readOnly}
                onChange={(next) =>
                  fields.replaceList('stopWordsPolicy.sanctions.botButtons', next)
                }
              >
                {(items, replace) => (
                  <StopWordsButtons
                    fields={fields}
                    items={items}
                    replace={replace}
                    focusRequest={focusRequest}
                  />
                )}
              </FieldList>
            )
          ) : null}
        </details>
        <details ref={imageScanRef} className="stop-words-editor__section">
          <summary>
            Текст на изображениях<small>Только удаление</small>
          </summary>
          {toggle('stopWordsPolicy.imageScanEnabled', 'Проверять изображения')}
          {context.stopWordsTools?.imageScan}
          {context.mode === 'network' ? (
            <p role="status">Доступность распознавания зависит от каждого выбранного чата.</p>
          ) : null}
        </details>
        {speech ? (
          <Suspense fallback={<Spinner label="Загружаем редактор сообщения" />}>
            <SpeechEditor
              fields={fields}
              path={
                speech === 'explanation'
                  ? 'stopWordsPolicy.sanctions.botMessageText'
                  : 'stopWordsPolicy.sanctions.warnMessageText'
              }
              mediaPath={
                speech === 'explanation'
                  ? 'stopWordsPolicy.sanctions.media.explanation'
                  : 'stopWordsPolicy.sanctions.media.warning'
              }
              title={speech === 'explanation' ? 'Объяснение' : 'Предупреждение'}
              textError={fields.error(
                speech === 'explanation'
                  ? 'stopWordsPolicy.sanctions.botMessageText'
                  : 'stopWordsPolicy.sanctions.warnMessageText',
              )}
              mediaError={fields.error(
                speech === 'explanation'
                  ? 'stopWordsPolicy.sanctions.media.explanation'
                  : 'stopWordsPolicy.sanctions.media.warning',
              )}
              focusRequest={
                focusRequest
                  ? {
                      target: focusRequest.field.includes('.media.') ? 'image' : 'text',
                      requestId: focusRequest.requestId,
                    }
                  : undefined
              }
              onClose={() => setSpeech(null)}
            />
          </Suspense>
        ) : null}
      </fieldset>
    </>
  );
}
