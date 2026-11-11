import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';
import { useEffect, useState, type ReactNode } from 'react';
import type { ChatSettings } from '@maxim/contracts/settings';
import { ADMIN_COMMAND_NAME_MAX_LENGTH } from '@maxim/contracts/settings';
import { commandCategories, type AdminCommandNameKey } from './settings-admin-command-config';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../components/ui/settings-section-toggle';
import { cn } from '../../lib/cn';
import { useHintPopoverAutoPosition } from '../../lib/hint-popover';
import { SettingsHintAnchor } from './settings-hint-anchor';
import type { FieldErrors, HintKey } from './settings-page-helpers';
import '../../styles/settings-admin-commands.css';

type SettingsAdminCommandsSectionProps = {
  sharedContent?: ReactNode;
  draft: ChatSettings;
  expanded: boolean;
  fieldErrors: FieldErrors;
  headerAction?: ReactNode;
  footer: ReactNode;
  hasChanges: boolean;
  onDiscardChanges: () => void;
  onToggleSection: () => void;
  onFieldChange: (key: AdminCommandNameKey, value: string) => void;
};

function readCommandName(value: string | null | undefined, fallback: string) {
  return value?.trim().replace(/\s+/g, ' ') || fallback;
}

const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'commands');

export function SettingsAdminCommandsSection({
  sharedContent,
  draft,
  expanded,
  fieldErrors,
  headerAction,
  footer,
  hasChanges,
  onDiscardChanges,
  onToggleSection,
  onFieldChange,
}: SettingsAdminCommandsSectionProps) {
  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const activeHintKey = expanded ? openHintKey : null;
  const toggleHint = (key: HintKey) => setOpenHintKey((current) => (current === key ? null : key));
  useHintPopoverAutoPosition(activeHintKey !== null, activeHintKey, () => setOpenHintKey(null));
  useEffect(() => {
    if (!expanded) setOpenHintKey(null);
  }, [expanded]);
  const filledCount = commandCategories
    .flatMap((category) => category.items)
    .filter((item) => readCommandName(draft[item.key], '').length > 0).length;
  const commandCount = commandCategories.reduce(
    (count, category) => count + category.items.length,
    0,
  );
  const headerSummary =
    filledCount === commandCount ? `${commandCount} команд настроено` : 'Нужно заполнить команды';
  const cardStatus = `${filledCount}/${commandCount}`;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '344ms', order: SECTION_PRESENTATION.order }}
      aria-label="Команды"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title={SECTION_PRESENTATION.title}
          summary={headerSummary}
          status={cardStatus}
          icon={SECTION_PRESENTATION.icon}
          tone={SECTION_PRESENTATION.tone}
          open={expanded}
          controls="settings-commands-content"
          onClick={onToggleSection}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-commands-content"
        icon={<SettingsSectionIcon name={SECTION_PRESENTATION.icon} />}
        open={expanded}
        title={SECTION_PRESENTATION.title}
        summary={headerSummary}
        tone={SECTION_PRESENTATION.tone}
        className={SECTION_PRESENTATION.panelClassName}
        onClose={onToggleSection}
        headerAction={headerAction}
        confirmCloseWhen={hasChanges}
        onDiscardChanges={onDiscardChanges}
        footer={hasChanges ? footer : null}
      >
        {sharedContent ? (
          expanded ? (
            sharedContent
          ) : null
        ) : (
          <>
            <div
              id="settings-commands-content"
              className={cn('settings-section__collapse', expanded && 'is-open')}
            >
              {expanded ? (
                <div className="settings-section__collapse-inner settings-admin-commands">
                  <p className="settings-admin-commands__case-note">
                    Названия команд можно изменить. Подсказки объясняют действие и область
                    применения.
                  </p>
                  {commandCategories.map((category) => (
                    <section className="settings-admin-commands__category" key={category.title}>
                      <h3>{category.title}</h3>
                      <div className="settings-admin-commands__grid">
                        {category.items.map((item) => {
                          const error = fieldErrors[item.key];

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
                                      openHintKey={activeHintKey}
                                      onToggleHint={toggleHint}
                                      label={`Что делает команда «${item.title}»`}
                                    >
                                      {item.caption}
                                    </SettingsHintAnchor>
                                  </span>
                                </span>
                                <input
                                  id={`settings-command-${item.key}`}
                                  value={draft[item.key]}
                                  onChange={(event) => onFieldChange(item.key, event.target.value)}
                                  placeholder={item.defaultValue}
                                  aria-label={`Команда «${item.title}»`}
                                  aria-invalid={Boolean(error)}
                                  aria-describedby={
                                    error ? `settings-command-${item.key}-error` : undefined
                                  }
                                  maxLength={ADMIN_COMMAND_NAME_MAX_LENGTH}
                                  autoCapitalize="none"
                                  autoCorrect="off"
                                  spellCheck={false}
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
              ) : null}
            </div>
          </>
        )}
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
