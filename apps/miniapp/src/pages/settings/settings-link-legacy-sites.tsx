import { AppIcon } from '../../components/ui/app-icon';
import type { SharedChatSettingsSectionProps } from './shared-chat-settings-section';
import { SharedStopWordsSettingsFields } from './shared-stop-words-settings-fields';

type Props = Pick<SharedChatSettingsSectionProps, 'fields' | 'context'> & {
  dirty: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => Promise<unknown>;
};

export function SettingsLinkLegacySites({
  fields,
  context,
  dirty,
  saving,
  onDiscard,
  onSave,
}: Props) {
  return (
    <details className="links-panel__detail" open={dirty}>
      <summary>
        <span className="links-panel__detail-icon">
          <AppIcon icon="Book" />
        </span>
        <span>Сайты из стоп-слов</span>
        <AppIcon icon="NavArrowRight" className="links-panel__chevron" />
      </summary>
      <div className="links-panel__detail-body">
        <p className="links-panel__hint">
          Включение, наказания и проверка изображений общие со стоп-словами. Эти настройки
          сохраняются отдельно.
        </p>
        <SharedStopWordsSettingsFields fields={fields} context={context} presentation="sites" />
        <div className="links-panel__editor-actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={saving || !dirty}
            onClick={onDiscard}
          >
            Отменить
          </button>
          <button
            type="button"
            className="button button--accent"
            disabled={saving || !dirty}
            onClick={async () => {
              try {
                await onSave();
              } catch {
                // FLAG: The existing mutation preserves the draft and reports the error.
              }
            }}
          >
            Сохранить сайты
          </button>
        </div>
      </div>
    </details>
  );
}
