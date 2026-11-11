import { useEffect, useId, useRef, useState, type ReactNode, type ChangeEvent } from 'react';
import {
  LINK_RULES_MAX,
  linkRulesPolicySchema,
  normalizeLinkRuleInput,
  type LinkRule,
  type LinkRuleEffect,
  type LinkRulesMode,
  type LinkRulesPolicy,
  type NavigationAllowlistKind,
} from '@maxim/contracts/settings';
import { AppIcon } from '../../components/ui/app-icon';
import type { AppIconName } from '../../components/ui/app-icon-names';
import { TimeField } from '../../components/ui/time-field';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { useNativeBackHandler } from '../../lib/native-back';
import { describeUserFacingError } from '../../lib/user-facing-error';
import type { SharedChatSettingsSectionProps } from './shared-chat-settings-section';
import {
  displayLinkRuleTarget,
  inferLinkRuleKind,
  LINK_RULE_KIND_LABELS,
  linkRuleContains,
  localExpiryParts,
  ruleExpiryLabel,
} from './link-settings-model';
import './link-rules-panel.css';

type Props = Pick<SharedChatSettingsSectionProps, 'fields' | 'context'> & {
  sanctions: ReactNode;
};
const MODES: Array<{ value: LinkRulesMode; label: string; icon: AppIconName }> = [
  { value: 'ALLOW_ALL', label: 'Разрешать все', icon: 'CheckCircle' },
  { value: 'DENY_SELECTED', label: 'Запрещать по списку', icon: 'FilterList' },
  { value: 'ALLOW_SELECTED', label: 'Разрешать по списку', icon: 'CheckSquare' },
  { value: 'DENY_ALL', label: 'Удалять все', icon: 'ShieldAlert' },
];
const PENDING_RULE_MESSAGE = 'Добавьте правило или отмените ввод перед сохранением.';

type RuleEditor = { effect: LinkRuleEffect; rule?: LinkRule; exception: boolean };

function ModeGrid({
  mode,
  disabled,
  onChange,
}: {
  mode: LinkRulesMode | null;
  disabled: boolean;
  onChange: (mode: LinkRulesMode) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={root}
      className="links-panel__modes"
      role="radiogroup"
      aria-label="Режим модерации ссылок"
    >
      {MODES.map((option, index) => (
        <button
          key={option.value}
          type="button"
          className="links-panel__mode"
          role="radio"
          aria-checked={mode === option.value}
          tabIndex={mode === option.value || (!mode && index === 0) ? 0 : -1}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const offsets: Record<string, number> = {
              ArrowLeft: -1,
              ArrowRight: 1,
              ArrowUp: -2,
              ArrowDown: 2,
            };
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? 3
                  : event.key in offsets
                    ? (index + offsets[event.key] + MODES.length) % MODES.length
                    : null;
            if (next === null) return;
            event.preventDefault();
            onChange(MODES[next].value);
            root.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
          }}
        >
          <AppIcon icon={option.icon} />
          <span>{option.label}</span>
          <span className="links-panel__mode-dot" aria-hidden />
        </button>
      ))}
    </div>
  );
}

function DetailHeading({ icon, children }: { icon: AppIconName; children: ReactNode }) {
  return (
    <summary>
      <span className="links-panel__detail-icon">
        <AppIcon icon={icon} />
      </span>
      <span>{children}</span>
      <AppIcon icon="NavArrowRight" className="links-panel__chevron" />
    </summary>
  );
}

export function SharedLinkSettingsFields({ fields, context, sanctions }: Props) {
  const state = fields.read('linkRulesPolicy');
  const legacy = context.linkRules?.legacySnapshot;
  const policy = state.kind === 'common' ? (state.value ?? legacy?.policy ?? null) : null;
  const storageBlocked =
    context.linkRules?.storageStatus === 'invalid' && !context.linkRules.replacementAuthorized;
  const ready =
    state.kind === 'common' && Boolean(policy) && !context.linkRules?.loading && !storageBlocked;
  const disabled =
    fields.readOnly || state.kind === 'loading' || Boolean(context.linkRules?.loading);
  const [editor, setEditor] = useState<RuleEditor | null>(null);
  const legacyFallback =
    context.mode === 'single' &&
    context.linkRules?.storageStatus === 'legacy' &&
    !legacy &&
    !policy;
  const [query, setQuery] = useState('');
  const [removal, setRemoval] = useState<LinkRule | null>(null);
  const [replaceMode, setReplaceMode] = useState<LinkRulesMode | null>(null);
  const [replaceInvalid, setReplaceInvalid] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const error = fields.error('linkRulesPolicy');
  const primary: LinkRuleEffect = policy?.mode === 'ALLOW_SELECTED' ? 'ALLOW' : 'DENY';
  const rules = policy?.rules ?? [];
  const listMode = policy?.mode === 'DENY_SELECTED' || policy?.mode === 'ALLOW_SELECTED';
  const search = query.trim().toLocaleLowerCase('ru-RU');
  const visible = (rule: LinkRule) =>
    !search || displayLinkRuleTarget(rule).toLocaleLowerCase('ru-RU').includes(search);
  const mainRules = rules.filter((rule) => rule.effect === primary);
  const exceptions = rules.filter((rule) => rule.effect !== primary);
  const dependent = removal
    ? rules.filter((rule) => rule.effect !== removal.effect && linkRuleContains(removal, rule))
    : [];

  const update = (next: LinkRulesPolicy) => {
    context.linkRules?.onPolicyAuthored?.();
    fields.setScalar('linkRulesPolicy', next);
    fields.setError('linkRulesPolicy', null);
  };
  const selectMode = (mode: LinkRulesMode) => {
    if (!ready || !policy) {
      if (state.kind === 'mixed') setReplaceMode(mode);
      return;
    }
    if (policy.mode === mode) return;
    update({ ...policy, mode });
    setEditor(null);
  };
  const closeEditor = () => {
    setEditor(null);
    fields.setError('linkRulesPolicy', null);
    requestAnimationFrame(() => addRef.current?.focus());
  };
  const removeRule = (rule: LinkRule) => {
    if (!policy) return;
    const children = rules.filter(
      (item) => item.effect !== rule.effect && linkRuleContains(rule, item),
    );
    if (children.length) setRemoval(rule);
    else update({ ...policy, rules: rules.filter((item) => item.id !== rule.id) });
  };
  const ruleList = (items: LinkRule[], label: string) => (
    <ul className="links-panel__list" aria-label={label}>
      {items.filter(visible).map((rule) => (
        <li key={rule.id} className="links-panel__rule" data-disabled={!rule.enabled || undefined}>
          <span className="links-panel__rule-icon" aria-hidden>
            <AppIcon icon={rule.kind === 'WEB_DOMAIN' ? 'Community' : 'Link'} />
          </span>
          <button
            type="button"
            className="links-panel__rule-copy"
            disabled={disabled || Boolean(editor)}
            aria-label={`Изменить правило ${displayLinkRuleTarget(rule)}`}
            onClick={() =>
              setEditor({ effect: rule.effect, rule, exception: rule.effect !== primary })
            }
          >
            <strong>{displayLinkRuleTarget(rule)}</strong>
            <small>{LINK_RULE_KIND_LABELS[rule.kind]}</small>
            <small>
              {!rule.enabled ? 'Выключено · ' : ''}
              {ruleExpiryLabel(rule.expiresAt)}
            </small>
          </button>
          <button
            type="button"
            className="links-panel__icon links-panel__remove"
            aria-label={`Удалить правило ${displayLinkRuleTarget(rule)}`}
            disabled={disabled || Boolean(editor)}
            onClick={() => removeRule(rule)}
          >
            <AppIcon icon="Trash" />
          </button>
        </li>
      ))}
      {!items.filter(visible).length ? (
        <li className="links-panel__empty">{search ? 'Ничего не найдено' : 'Список пуст'}</li>
      ) : null}
    </ul>
  );
  const note = !policy
    ? 'Прежние правила выбранных чатов сохраняются.'
    : {
        ALLOW_ALL: 'Списки ссылок не применяются.',
        DENY_SELECTED: mainRules.some(
          (rule) => rule.enabled && (!rule.expiresAt || Date.parse(rule.expiresAt) > Date.now()),
        )
          ? 'Запрещены адреса из списка с учётом исключений.'
          : 'Список пуст — запретов по нему нет.',
        ALLOW_SELECTED: mainRules.some(
          (rule) => rule.enabled && (!rule.expiresAt || Date.parse(rule.expiresAt) > Date.now()),
        )
          ? 'Остальные ссылки запрещены.'
          : 'Список пуст — все ссылки запрещены.',
        DENY_ALL: 'Сообщения со ссылками удаляются. Исключения не действуют.',
      }[policy.mode];
  return (
    <div className="links-panel">
      <section className="links-panel__hero" aria-label="Режим проверки ссылок">
        <div className="links-panel__hero-label">
          <span>Режим проверки</span>
          <AppIcon icon="Link" />
        </div>
        <ModeGrid
          mode={policy?.mode ?? null}
          disabled={disabled || Boolean(editor) || (!ready && state.kind !== 'mixed')}
          onChange={selectMode}
        />
        <p className="links-panel__mode-note">{note}</p>
      </section>
      {context.linkRules?.loading ? <p role="status">Загружаем правила…</p> : null}
      {storageBlocked ? (
        <div className="links-panel__detail-body" role="alert">
          <p className="links-panel__error">Сохранённые правила требуют проверки.</p>
          {context.linkRules?.onAuthorizeReplacement ? (
            <button
              type="button"
              className="button button--ghost"
              disabled={disabled}
              onClick={() => setReplaceInvalid(true)}
            >
              Настроить заново
            </button>
          ) : null}
        </div>
      ) : null}
      {context.linkRules?.error ? <p role="alert">{context.linkRules.error}</p> : null}
      {error ? (
        <p
          role={error === PENDING_RULE_MESSAGE ? 'status' : 'alert'}
          className={error === PENDING_RULE_MESSAGE ? 'links-panel__hint' : 'links-panel__error'}
        >
          {error}
        </p>
      ) : null}
      {!policy && context.mode === 'network' && state.kind !== 'loading' ? (
        <button
          type="button"
          className="button button--ghost"
          disabled={disabled}
          onClick={() => setReplaceMode('DENY_SELECTED')}
        >
          Настроить общие правила
        </button>
      ) : null}
      {state.kind === 'common' &&
      !policy &&
      context.mode === 'single' &&
      !legacyFallback &&
      !context.linkRules?.loading &&
      !context.linkRules?.error ? (
        <p role="status">Не удалось подготовить правила. Обновите настройки.</p>
      ) : null}
      {legacyFallback ? (
        <div className="links-panel__detail-body">
          <p className="links-panel__hint">
            Список нельзя перенести автоматически. Проверьте сохранённые адреса.
          </p>
          {context.navigationAllowlist}
        </div>
      ) : null}
      {listMode && policy && !storageBlocked ? (
        <>
          <div className="links-panel__list-head">
            <h3>
              {primary === 'DENY' ? 'Запрещённые' : 'Разрешённые'}{' '}
              <span className="links-panel__count">{mainRules.length}</span>
            </h3>
            <button
              ref={addRef}
              type="button"
              className="links-panel__add"
              aria-label="Добавить"
              disabled={disabled || Boolean(editor) || rules.length >= LINK_RULES_MAX}
              onClick={() => setEditor({ effect: primary, exception: false })}
            >
              <AppIcon icon="Plus" />
              <span>Добавить</span>
            </button>
          </div>
          {rules.length > 6 ? (
            <label className="links-panel__search">
              <AppIcon icon="Search" />
              <input
                type="search"
                aria-label="Найти ссылку или сайт"
                placeholder="Найти ссылку или сайт"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          ) : null}
          {ruleList(mainRules, primary === 'DENY' ? 'Запрещённые ссылки' : 'Разрешённые ссылки')}
          <details className="links-panel__detail">
            <DetailHeading icon="FilterList">
              Исключения <span className="links-panel__count">{exceptions.length}</span>
            </DetailHeading>
            <p className="links-panel__hint">
              {primary === 'DENY'
                ? 'Что разрешить внутри запрещённых сайтов.'
                : 'Что запретить внутри разрешённых сайтов.'}
            </p>
            {ruleList(exceptions, 'Исключения для ссылок')}
            <button
              type="button"
              className="links-panel__text-button"
              disabled={
                disabled ||
                Boolean(editor) ||
                !mainRules.some((rule) => rule.kind === 'WEB_DOMAIN') ||
                rules.length >= LINK_RULES_MAX
              }
              onClick={() =>
                setEditor({ effect: primary === 'DENY' ? 'ALLOW' : 'DENY', exception: true })
              }
            >
              <AppIcon icon="Plus" />
              Добавить исключение
            </button>
          </details>
        </>
      ) : null}
      {editor && policy ? (
        <LinkRuleEditor
          key={editor.rule?.id ?? `${editor.effect}-${editor.exception}`}
          editor={editor}
          policy={policy}
          disabled={disabled}
          onClose={closeEditor}
          onPendingChange={(pending) =>
            fields.setError('linkRulesPolicy', pending ? PENDING_RULE_MESSAGE : null)
          }
          onSave={(next) => {
            update(next);
            closeEditor();
          }}
        />
      ) : null}
      {policy && policy.mode !== 'ALLOW_ALL' && !storageBlocked ? (
        <>
          <p className="links-panel__consequence">
            Сообщение с запрещённой ссылкой удаляется целиком.
          </p>
          <details className="links-panel__detail">
            <DetailHeading icon="ShieldCheck">Наказания и сообщения</DetailHeading>
            <div className="links-panel__detail-body">{sanctions}</div>
          </details>
        </>
      ) : null}
      {policy && context.linkRules?.preview && !storageBlocked ? (
        <LinkRulesPreview
          policy={policy}
          preview={context.linkRules.preview}
          dirty={fields.isDirty('linkRulesPolicy')}
          disabled={disabled}
        />
      ) : null}
      {context.linkRules?.legacySites}
      <ActionConfirmSheet
        id="links-rule-remove"
        open={removal !== null}
        title="Удалить сайт и его исключения?"
        summary={`Будут удалены правило «${removal ? displayLinkRuleTarget(removal) : ''}» и исключения: ${dependent.map(displayLinkRuleTarget).join(', ')}.`}
        confirmLabel="Удалить"
        onClose={() => setRemoval(null)}
        onConfirm={() => {
          if (policy && removal)
            update({
              ...policy,
              rules: rules.filter(
                (rule) =>
                  rule.id !== removal.id && !dependent.some((child) => child.id === rule.id),
              ),
            });
          setRemoval(null);
        }}
      />
      <ActionConfirmSheet
        id="links-policy-replace"
        open={replaceMode !== null}
        title="Настроить общие правила?"
        summary="После сохранения прежние режимы и разрешённые списки выбранных чатов будут заменены. Новый список пока пуст; добавьте нужные адреса перед сохранением."
        confirmLabel="Настроить"
        onClose={() => setReplaceMode(null)}
        onConfirm={() => {
          if (replaceMode) update({ version: 1, mode: replaceMode, rules: [] });
          setReplaceMode(null);
        }}
      />
      <ActionConfirmSheet
        id="links-invalid-replace"
        open={replaceInvalid}
        title="Настроить правила заново?"
        summary="Прежние правила будут заменены после сохранения нового списка."
        confirmLabel="Настроить заново"
        onClose={() => setReplaceInvalid(false)}
        onConfirm={() => {
          context.linkRules?.onAuthorizeReplacement?.();
          setReplaceInvalid(false);
        }}
      />
    </div>
  );
}

function LinkRuleEditor({
  editor,
  policy,
  disabled,
  onClose,
  onPendingChange,
  onSave,
}: {
  editor: RuleEditor;
  policy: LinkRulesPolicy;
  disabled: boolean;
  onClose: () => void;
  onPendingChange: (pending: boolean) => void;
  onSave: (policy: LinkRulesPolicy) => void;
}) {
  const [input, setInput] = useState(editor.rule ? displayLinkRuleTarget(editor.rule) : '');
  const [kind, setKind] = useState<NavigationAllowlistKind>(editor.rule?.kind ?? 'WEB_EXACT');
  const [scopeTouched, setScopeTouched] = useState(Boolean(editor.rule));
  const [bulk, setBulk] = useState(false);
  const [error, setError] = useState('');
  const [enabled, setEnabled] = useState(editor.rule?.enabled ?? true);
  const initialExpiry = localExpiryParts(editor.rule?.expiresAt ?? null);
  const [expiryDay, setExpiryDay] = useState(initialExpiry.day);
  const [expiryTime, setExpiryTime] = useState(initialExpiry.time);
  const dirty =
    (Boolean(editor.rule) || Boolean(input.trim()) || Boolean(expiryDay)) &&
    (input !== (editor.rule ? displayLinkRuleTarget(editor.rule) : '') ||
      kind !== (editor.rule?.kind ?? 'WEB_EXACT') ||
      bulk ||
      enabled !== (editor.rule?.enabled ?? true) ||
      expiryDay !== initialExpiry.day ||
      expiryTime !== initialExpiry.time);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pendingCallback = useRef(onPendingChange);
  pendingCallback.current = onPendingChange;
  useEffect(() => {
    pendingCallback.current(dirty);
  }, [dirty]);
  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const root = useRef<HTMLElement>(null);
  const title = `${editor.effect === 'DENY' ? 'Запретить' : 'Разрешить'} ссылку`;
  useEffect(() => {
    inputRef.current?.focus();
    root.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  useNativeBackHandler(
    () => {
      requestClose();
      return true;
    },
    { priority: 710 },
  );
  const save = () => {
    const values = bulk
      ? input
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter(Boolean)
      : [input.trim()];
    if (!values.length || !values[0]) {
      setError('Вставьте ссылку или адрес сайта.');
      return;
    }
    let expiresAt: string | null = null;
    if (expiryDay) {
      const date = new Date(`${expiryDay}T${expiryTime}:00`);
      if (!Number.isFinite(+date) || +date <= Date.now()) {
        setError('Выберите будущие дату и время.');
        return;
      }
      expiresAt = date.toISOString();
    }
    const additions: LinkRule[] = [];
    for (const value of values) {
      const parsed = normalizeLinkRuleInput(value, kind);
      if (!parsed) {
        setError(`Не удалось распознать адрес: ${value}`);
        return;
      }
      const rule: LinkRule = {
        id: editor.rule?.id ?? crypto.randomUUID(),
        effect: editor.effect,
        kind: parsed.kind,
        target: parsed.target,
        enabled,
        expiresAt,
      };
      if (
        editor.exception &&
        !policy.rules.some(
          (parent) => parent.effect !== rule.effect && linkRuleContains(parent, rule),
        )
      ) {
        setError('Исключение должно находиться внутри сайта из основного списка.');
        return;
      }
      additions.push(rule);
    }
    const next = {
      ...policy,
      rules: [...policy.rules.filter((rule) => rule.id !== editor.rule?.id), ...additions],
    };
    const result = linkRulesPolicySchema.safeParse(next);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? 'Проверьте правило.');
      return;
    }
    onSave(result.data);
  };
  const props = {
    id: inputId,
    value: input,
    disabled,
    autoCapitalize: 'none' as const,
    autoCorrect: 'off',
    spellCheck: false,
    'aria-invalid': Boolean(error),
    'aria-describedby': error ? errorId : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      setInput(value);
      if (!scopeTouched) setKind(inferLinkRuleKind(value));
      setError('');
    },
  };
  return (
    <section
      ref={root}
      className="links-panel__editor"
      aria-label={editor.rule ? 'Изменение правила' : 'Добавление правила'}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node)) {
          event.preventDefault();
          requestClose();
        }
      }}
    >
      <div className="links-panel__list-head">
        <h3>{editor.rule ? 'Изменить правило' : title}</h3>
        <button
          type="button"
          className="links-panel__icon"
          aria-label="Закрыть редактор правила"
          onClick={requestClose}
        >
          <AppIcon icon="Xmark" />
        </button>
      </div>
      <label className="links-panel__label" htmlFor={inputId}>
        {bulk ? 'По одному адресу в строке' : 'Ссылка или сайт'}
      </label>
      {bulk ? (
        <textarea
          {...props}
          ref={(node) => {
            inputRef.current = node;
          }}
          rows={4}
          placeholder="Вставьте адреса"
        />
      ) : (
        <input
          {...props}
          ref={(node) => {
            inputRef.current = node;
          }}
          type="text"
          inputMode="url"
          placeholder="Вставьте адрес"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          }}
        />
      )}
      <label className="links-panel__label">
        Область правила
        <select
          value={kind}
          disabled={disabled}
          aria-label="Область правила"
          onChange={(event) => {
            setKind(event.target.value as NavigationAllowlistKind);
            setScopeTouched(true);
            setError('');
          }}
        >
          {Object.entries(LINK_RULE_KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {input.trim() && !bulk ? (
        <p className="links-panel__hint">
          {LINK_RULE_KIND_LABELS[kind]} ·{' '}
          {normalizeLinkRuleInput(input, kind)?.target ?? 'Проверьте адрес'}
        </p>
      ) : null}
      <details className="links-panel__expiry">
        <summary>
          <AppIcon icon="Calendar" />
          {expiryDay ? `До ${expiryDay}` : 'Без срока'}
        </summary>
        <div className="links-panel__expiry-fields">
          <label className="links-panel__label">
            День
            <input
              type="date"
              value={expiryDay}
              disabled={disabled}
              aria-label="Последний день действия правила"
              onChange={(event) => {
                setExpiryDay(event.target.value);
                setError('');
              }}
            />
          </label>
          <TimeField
            label="Время окончания"
            value={expiryTime}
            disabled={disabled}
            onChange={(value) => {
              setExpiryTime(value);
              setError('');
            }}
          />
        </div>
        {expiryDay ? (
          <button
            type="button"
            className="links-panel__text-button"
            onClick={() => setExpiryDay('')}
          >
            Убрать срок
          </button>
        ) : null}
      </details>
      {editor.rule ? (
        <label className="links-panel__checkbox">
          <input
            type="checkbox"
            checked={enabled}
            disabled={disabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Правило включено
        </label>
      ) : (
        <label className="links-panel__checkbox">
          <input
            type="checkbox"
            checked={bulk}
            disabled={disabled}
            onChange={(event) => {
              setBulk(event.target.checked);
              setScopeTouched(true);
              setError('');
            }}
          />
          Добавить несколько адресов
        </label>
      )}
      {error ? (
        <p id={errorId} role="alert" className="links-panel__error">
          {error}
        </p>
      ) : null}
      <div className="links-panel__editor-actions">
        <button type="button" className="button button--ghost" onClick={requestClose}>
          Отмена
        </button>
        <button type="button" className="button button--accent" disabled={disabled} onClick={save}>
          {editor.rule ? 'Применить' : 'Добавить'}
        </button>
      </div>
      <ActionConfirmSheet
        id="link-rule-discard"
        open={confirmDiscard}
        title="Отменить изменения правила?"
        confirmLabel="Отменить изменения"
        cancelLabel="Продолжить редактирование"
        onClose={() => setConfirmDiscard(false)}
        onConfirm={onClose}
      />
    </section>
  );
}

function LinkRulesPreview({
  policy,
  preview,
  dirty,
  disabled,
}: {
  policy: LinkRulesPolicy;
  preview: NonNullable<NonNullable<Props['context']['linkRules']>['preview']>;
  dirty: boolean;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{
    key: string;
    value: Awaited<ReturnType<typeof preview>>;
  } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const key = JSON.stringify({ policy, text });
  const current = useRef(key);
  current.current = key;
  useEffect(
    () => () => {
      current.current = '';
    },
    [],
  );
  useEffect(() => {
    setPending(false);
  }, [key]);
  const check = async () => {
    const submitted = key;
    setPending(true);
    setError(null);
    try {
      const value = await preview(policy, text);
      if (current.current === submitted) setResult({ key: submitted, value });
    } catch (cause) {
      if (current.current === submitted)
        setError({
          key: submitted,
          message: describeUserFacingError(
            cause,
            'Не удалось проверить сообщение. Повторите попытку.',
          ),
        });
    } finally {
      if (current.current === submitted) setPending(false);
    }
  };
  const value = result?.key === key ? result.value : null;
  const matched = value?.ruleId ? policy.rules.find((rule) => rule.id === value.ruleId) : null;
  return (
    <details className="links-panel__detail">
      <DetailHeading icon="Flask">Проверить сообщение</DetailHeading>
      <div className="links-panel__detail-body">
        <label className="links-panel__label">
          Сообщение
          <textarea
            rows={3}
            maxLength={4000}
            value={text}
            aria-label="Сообщение для проверки ссылок"
            onChange={(event) => {
              setText(event.target.value);
              setPending(false);
            }}
          />
        </label>
        {dirty ? <p className="links-panel__hint">Проверка несохранённых правил.</p> : null}
        <button
          type="button"
          className="button button--ghost"
          disabled={disabled || pending || !text.trim()}
          onClick={() => void check()}
        >
          <AppIcon icon="Play" />
          {pending ? 'Проверяем…' : 'Проверить'}
        </button>
        {error?.key === key ? <p role="alert">{error.message}</p> : null}
        {value ? (
          <div className="links-panel__result" role="status">
            <strong>
              {value.targetsCount === 0
                ? 'Ссылки не найдены'
                : value.allowed
                  ? 'Все ссылки разрешены'
                  : 'Есть запрещённая ссылка'}
            </strong>
            {matched ? (
              <small>
                {matched.effect === 'DENY' ? 'Запрет' : 'Разрешение'}:{' '}
                {displayLinkRuleTarget(matched)}
              </small>
            ) : value.target ? (
              <small>{value.target}</small>
            ) : null}
            <small>Другие фильтры проверяются отдельно.</small>
          </div>
        ) : null}
      </div>
    </details>
  );
}
