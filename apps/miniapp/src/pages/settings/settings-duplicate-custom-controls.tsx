import { SettingsHintAnchor } from './settings-hint-anchor';
import type {
  SettingsSectionHintProps,
  SettingsSectionMutationProps,
} from './settings-section-shared';

const OPTIONS = [
  {
    key: 'duplicateIgnoreLinksEnabled',
    title: 'Одинаковая ссылка',
    hintKey: 'duplicateIgnoreLinks',
    label: 'Считать одинаковую ссылку дублем',
    hint: 'Сообщения с одной и той же ссылкой считаются повтором. Остальной текст может отличаться.',
  },
  {
    key: 'duplicateIgnorePhonesEnabled',
    title: 'Одинаковый номер',
    hintKey: 'duplicateIgnorePhones',
    label: 'Считать одинаковый номер дублем',
    hint: 'Сообщения с одним и тем же номером телефона считаются повтором. Остальной текст может отличаться.',
  },
  {
    key: 'duplicateNearMatchEnabled',
    title: 'Близкие совпадения',
    hintKey: 'duplicateNearMatch',
    label: 'Включить близкие совпадения дублей',
    hint: 'Сравнивает длинные сообщения с разными пробелами вокруг знаков препинания. Слова, их порядок, числа и сами знаки должны совпадать. Короткие ответы не сравниваются приблизительно.',
  },
] as const;

export default function SettingsDuplicateCustomControls({
  draft,
  setFieldValue,
  openHintKey,
  toggleHint,
}: Pick<SettingsSectionMutationProps, 'draft' | 'setFieldValue'> &
  Pick<SettingsSectionHintProps, 'openHintKey' | 'toggleHint'>) {
  return (
    <>
      {OPTIONS.map((option) => (
        <div key={option.key} className="settings-native-toggle settings-native-toggle--nested">
          <div className="settings-native-toggle__row">
            <div className="settings-native-toggle__title-wrap">
              <span className="settings-native-toggle__title">{option.title}</span>
              <SettingsHintAnchor
                hintKey={option.hintKey}
                openHintKey={openHintKey}
                onToggleHint={toggleHint}
                label={option.title}
              >
                {option.hint}
              </SettingsHintAnchor>
            </div>
            <label className="settings-native-switch" aria-label={option.label}>
              <input
                type="checkbox"
                checked={draft[option.key]}
                onChange={(event) => setFieldValue(option.key, event.target.checked)}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>
        </div>
      ))}
    </>
  );
}
