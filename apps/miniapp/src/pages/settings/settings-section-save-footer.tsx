import type { ApplySectionKey } from '../settings-page-state';
import { AppIcon } from '../../components/ui/app-icon';
import { HOME_ENTITY_FAVORITE_ICONS } from '../../components/ui/compact-icons';
import type { ManagedEntityFavoriteType } from '@maxim/contracts/managed-entities';
import type { ApplySettingsTarget } from '@maxim/contracts/settings';
import { useSettingsSaveFolder } from './use-settings-save-folder';

type SettingsSectionSaveFooterOptions = {
  note?: string | null;
  saveLabel?: string;
};

type SettingsSectionSaveFooterProps = {
  section: ApplySectionKey;
  options?: SettingsSectionSaveFooterOptions;
  disabled?: boolean;
  hasChanges: boolean;
  onSaveAll?: () => void;
  folder?: { type: ManagedEntityFavoriteType; label: string; onSave: () => void } | null;
  isSavingSettings: boolean;
  savingSection: ApplySectionKey | null;
  isApplyingSectionToAll: boolean;
  applyingSection: ApplySectionKey | null;
  onSaveSection: (section: ApplySectionKey) => void;
  conflict?: { viewingSaved: boolean; onToggle: () => void };
};

export function SettingsChatSectionSaveFooter({
  chatId,
  routeState,
  canSaveAll,
  onSaveTarget,
  ...props
}: Omit<SettingsSectionSaveFooterProps, 'folder' | 'onSaveAll'> & {
  chatId: string | undefined;
  routeState: unknown;
  canSaveAll: boolean;
  onSaveTarget: (target: ApplySettingsTarget) => void;
}) {
  const folder = useSettingsSaveFolder(chatId, routeState);
  return (
    <SettingsSectionSaveFooter
      {...props}
      onSaveAll={
        canSaveAll ? () => onSaveTarget({ mode: 'all', favoriteTypes: [], chatIds: [] }) : undefined
      }
      folder={
        folder
          ? {
              ...folder,
              onSave: () =>
                onSaveTarget({ mode: 'favoriteTypes', favoriteTypes: [folder.type], chatIds: [] }),
            }
          : null
      }
    />
  );
}

export function SettingsSectionSaveFooter({
  section,
  options,
  disabled = false,
  hasChanges,
  onSaveAll,
  folder,
  isSavingSettings,
  savingSection,
  isApplyingSectionToAll,
  applyingSection,
  onSaveSection,
  conflict,
}: SettingsSectionSaveFooterProps) {
  const isCurrentSectionSaving = isSavingSettings && savingSection === section;
  const isCurrentSectionApplying = isApplyingSectionToAll && applyingSection === section;
  const footerNote = options?.note !== undefined ? options.note : null;
  const busy = isSavingSettings || isApplyingSectionToAll;
  const FolderIcon = folder ? HOME_ENTITY_FAVORITE_ICONS[folder.type] : null;

  return (
    <>
      {conflict ? (
        <div
          role="status"
          className="settings-drilldown__footer-note settings-drilldown__footer-conflict"
        >
          <p>
            Настройки изменились. Ваш черновик сохранён. Сейчас показан{' '}
            {conflict.viewingSaved ? 'сохранённый вариант' : 'ваш черновик'}.
          </p>
          <button type="button" className="button button--ghost" onClick={conflict.onToggle}>
            {conflict.viewingSaved ? 'Показать мой черновик' : 'Сравнить с сохранённым'}
          </button>
        </div>
      ) : null}
      {footerNote ? <p className="settings-drilldown__footer-note">{footerNote}</p> : null}
      <div className="settings-save-actions">
        <button
          type="button"
          className="button button--accent settings-save-actions__current"
          onClick={() => onSaveSection(section)}
          disabled={disabled || busy || (!hasChanges && !conflict)}
          aria-busy={isCurrentSectionSaving || isCurrentSectionApplying || undefined}
        >
          <AppIcon icon="Check" />
          <span>
            {isCurrentSectionSaving || isCurrentSectionApplying
              ? 'Сохраняем...'
              : conflict
                ? conflict.viewingSaved
                  ? 'Оставить сохранённый вариант'
                  : 'Сохранить мой вариант'
                : (options?.saveLabel ?? 'Сохранить в этом чате')}
          </span>
        </button>
        {onSaveAll || folder ? (
          <div className="settings-save-actions__targets">
            {folder && FolderIcon ? (
              <button
                type="button"
                className="button settings-save-actions__target"
                aria-label={`Сохранить в папке «${folder.label}»`}
                disabled={disabled || busy || Boolean(conflict)}
                onClick={folder.onSave}
              >
                <FolderIcon aria-hidden />
                <span className="settings-save-actions__folder">
                  <small>В папке</small>
                  <strong>{folder.label}</strong>
                </span>
              </button>
            ) : null}
            {onSaveAll ? (
              <button
                type="button"
                className="button settings-save-actions__target"
                aria-label="Сохранить во всех чатах"
                disabled={disabled || busy || Boolean(conflict)}
                onClick={onSaveAll}
              >
                <AppIcon icon="Community" />
                <span>Во всех чатах</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
