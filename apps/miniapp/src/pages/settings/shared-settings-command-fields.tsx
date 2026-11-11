import { useEffect, useState } from 'react';
import { ADMIN_COMMAND_NAME_MAX_LENGTH } from '@maxim/contracts/settings';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { cn } from '../../lib/cn';
import { useHintPopoverAutoPosition } from '../../lib/hint-popover';
import { SettingsHintAnchor } from './settings-hint-anchor';
import type { HintKey } from './settings-page-helpers';
import { commandCategories, type AdminCommandNameKey } from './settings-admin-command-config';
import '../../styles/settings-admin-commands.css';

function CommandInput({
  fields,
  path,
  title,
  defaultValue,
}: {
  fields: ChatSettingsFieldAdapter;
  path: AdminCommandNameKey;
  title: string;
  defaultValue: string;
}) {
  const state = fields.read(path);
  const key = state.kind === 'common' ? state.value : state.kind;
  const [buffer, setBuffer] = useState<string | null>(null);
  useEffect(() => setBuffer(null), [key]);
  const error = fields.error(path);
  return (
    <input
      id={`settings-command-${path}`}
      value={buffer ?? (state.kind === 'common' ? state.value : '')}
      onChange={(event) => {
        const value = event.target.value;
        setBuffer(value);
        try {
          fields.setScalar(path, value);
          fields.setError(path, null);
        } catch (cause) {
          fields.setError(path, cause instanceof Error ? cause.message : 'Проверьте значение.');
        }
      }}
      placeholder={state.kind === 'mixed' ? 'Разные значения' : defaultValue}
      aria-label={`Команда «${title}»`}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `settings-command-${path}-error` : undefined}
      maxLength={ADMIN_COMMAND_NAME_MAX_LENGTH}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      disabled={fields.readOnly || state.kind === 'loading'}
    />
  );
}
export function SharedSettingsCommandFields({ fields }: { fields: ChatSettingsFieldAdapter }) {
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  useHintPopoverAutoPosition(openHintKey !== null, openHintKey, () => setOpenHintKey(null));
  return (
    <div className="settings-admin-commands">
      <p className="settings-admin-commands__case-note">
        Названия команд можно изменить. Подсказки объясняют действие и область применения.
      </p>
      {commandCategories.map((category) => (
        <section className="settings-admin-commands__category" key={category.title}>
          <h3>{category.title}</h3>
          <div className="settings-admin-commands__grid">
            {category.items.map((item) => {
              const error = fields.error(item.key);
              return (
                <div
                  className={cn('settings-command-card', error && 'field--error')}
                  key={item.key}
                >
                  <div className="settings-command-card__row">
                    <span className="settings-command-card__copy">
                      <span className="settings-command-card__title">
                        <label htmlFor={`settings-command-${item.key}`}>
                          <strong>{item.title}</strong>
                        </label>
                        <SettingsHintAnchor
                          hintKey={item.hintKey}
                          openHintKey={openHintKey}
                          onToggleHint={(key) =>
                            setOpenHintKey((current) => (current === key ? null : key))
                          }
                          label={`Что делает команда «${item.title}»`}
                        >
                          {item.caption}
                        </SettingsHintAnchor>
                      </span>
                    </span>
                    <CommandInput
                      fields={fields}
                      path={item.key}
                      title={item.title}
                      defaultValue={item.defaultValue}
                    />
                  </div>
                  {error ? (
                    <small
                      id={`settings-command-${item.key}-error`}
                      className="field__hint"
                      role="alert"
                    >
                      {error}
                    </small>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
