import { SegmentedControl } from '../../components/ui/segmented-control';
import {
  DUPLICATE_PHOTO_SCOPE_OPTIONS,
  type DuplicatePhotoScope,
} from './settings-duplicate-photo-options';
import type { DuplicatePhotoPresentationPolicy } from './settings-duplicate-photo-status';

export default function SettingsDuplicatePhotoControls({
  moderationPolicy,
  scope,
  onScopeChange,
  disabled = false,
}: {
  moderationPolicy?: DuplicatePhotoPresentationPolicy;
  scope: DuplicatePhotoScope | null;
  onScopeChange: (value: DuplicatePhotoScope) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <div
        className="duplicate-photo-settings"
        role="group"
        aria-label="Удаление одинаковых картинок"
      >
        <div className="settings-policy duplicate-photo-settings__policy">
          <span className="field__label">Чьи картинки сравнивать</span>
          <SegmentedControl
            value={scope}
            options={DUPLICATE_PHOTO_SCOPE_OPTIONS.map((option) => ({ ...option, disabled }))}
            onChange={(value) => {
              if (value === 'CHAT' || value === 'SAME_AUTHOR') onScopeChange(value);
            }}
            className="settings-mode-segments duplicate-photo-settings__segments"
            ariaLabel="Чьи картинки сравнивать"
          />
          {scope === null ? <p className="field__hint">Разные значения</p> : null}
        </div>
        {moderationPolicy?.moderationMode !== 'FULL' ? (
          <p className="policy-mode-hint" role="status">
            {moderationPolicy
              ? 'Проверка картинок сейчас недоступна'
              : 'Доступность проверки зависит от каждого чата'}
          </p>
        ) : null}
      </div>
    </>
  );
}
