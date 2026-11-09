import { useEffect, useState } from 'react';
import {
  VK_PARSING_MAX_DELETE_AFTER_MINUTES,
  vkParsingSourceLinkUrlSchema,
  type UpdateVkParsingSettingsRequest,
  type VkParsingSettings,
} from '@maxim/contracts/vk-parsing';
import { parseEditorLinkHref } from '../../lib/max-rich-text-link';
import { AppIcon } from '../ui/app-icon';
import { VkSettingSwitch } from './setting-switch';
import { VkInfoButton } from './info-button';
import { CommittedNumberField } from './committed-number-field';

const DELETE_PRESETS = [60, 360, 1440, 10080];

export function VkPublicationOptions({
  settings,
  disabled,
  onUpdate,
}: {
  settings: VkParsingSettings;
  disabled: boolean;
  onUpdate: (patch: UpdateVkParsingSettingsRequest) => Promise<boolean>;
}) {
  const [customSource, setCustomSource] = useState(Boolean(settings.sourceLinkUrl));
  const [draftUrl, setDraftUrl] = useState(settings.sourceLinkUrl);
  const [urlError, setUrlError] = useState('');
  const [customDelay, setCustomDelay] = useState(false);
  const [lastDelay, setLastDelay] = useState(settings.deleteAfterMinutes ?? 1440);
  useEffect(() => {
    setDraftUrl(settings.sourceLinkUrl);
    setCustomSource(Boolean(settings.sourceLinkUrl));
  }, [settings.sourceLinkUrl]);

  async function saveUrl() {
    const candidate = parseEditorLinkHref(draftUrl);
    const parsed = vkParsingSourceLinkUrlSchema.safeParse(candidate);
    if (!parsed.success || !parsed.data) {
      setUrlError('Укажите HTTPS-ссылку без логина и пароля.');
      return;
    }
    setUrlError('');
    if (await onUpdate({ sourceLinkUrl: parsed.data })) setDraftUrl(parsed.data);
  }

  return (
    <section className="vk-publication-options" aria-label="Оформление и удаление постов">
      <div className="vk-publication-options__item">
        <div className="vk-publication-options__heading">
          <AppIcon icon="Link" aria-hidden />
          <VkSettingSwitch
            label="Первоисточник"
            checked={settings.sourceLinkEnabled}
            disabled={disabled}
            onChange={(sourceLinkEnabled) => onUpdate({ sourceLinkEnabled })}
          />
          <VkInfoButton title="О первоисточнике">
            <p>Ссылка «Источник» в конце поста. Сохраняется при включённом удалении ссылок.</p>
          </VkInfoButton>
        </div>
        {settings.sourceLinkEnabled ? (
          <div className="vk-publication-options__fields">
            <div className="vk-segmented-buttons" role="group" aria-label="Ссылка на первоисточник">
              <button
                type="button"
                aria-pressed={!customSource}
                disabled={disabled}
                className={!customSource ? 'is-active' : ''}
                onClick={() =>
                  void onUpdate({ sourceLinkUrl: '' }).then((saved) => {
                    if (saved) {
                      setCustomSource(false);
                      setDraftUrl('');
                      setUrlError('');
                    }
                  })
                }
              >
                Пост ВК
              </button>
              <button
                type="button"
                aria-pressed={customSource}
                disabled={disabled}
                className={customSource ? 'is-active' : ''}
                onClick={() => setCustomSource(true)}
              >
                Своя ссылка
              </button>
            </div>
            {customSource ? (
              <form
                className="vk-publication-options__url"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveUrl();
                }}
              >
                <label>
                  <span className="vk-parsing-sr-only">Ссылка на первоисточник</span>
                  <input
                    type="text"
                    inputMode="url"
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="https://…"
                    value={draftUrl}
                    disabled={disabled}
                    aria-invalid={Boolean(urlError)}
                    aria-describedby={urlError ? 'vk-source-url-error' : undefined}
                    onChange={(event) => {
                      setDraftUrl(event.target.value);
                      setUrlError('');
                    }}
                  />
                </label>
                <button
                  type="submit"
                  className="button button--accent"
                  disabled={disabled || !draftUrl.trim() || draftUrl === settings.sourceLinkUrl}
                >
                  Сохранить
                </button>
                {urlError ? (
                  <p id="vk-source-url-error" role="alert">
                    {urlError}
                  </p>
                ) : null}
              </form>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="vk-publication-options__item">
        <div className="vk-publication-options__heading">
          <AppIcon icon="Timer" aria-hidden />
          <VkSettingSwitch
            label="Автоудаление"
            checked={settings.deleteAfterMinutes !== null}
            disabled={disabled}
            onChange={(enabled) => {
              if (!enabled) setLastDelay(settings.deleteAfterMinutes ?? lastDelay);
              return onUpdate({ deleteAfterMinutes: enabled ? lastDelay : null });
            }}
          />
          <VkInfoButton title="Об автоудалении">
            <p>
              Удаляет новые посты из MAX через выбранный срок после публикации. Оригиналы ВК
              остаются.
            </p>
            <p>Уже опубликованные посты сохраняют назначенное время удаления.</p>
          </VkInfoButton>
        </div>
        {settings.deleteAfterMinutes !== null ? (
          <div className="vk-publication-options__fields">
            <label className="vk-publication-options__delay">
              <span>Удалить через</span>
              <select
                aria-label="Срок автоудаления постов ВК"
                disabled={disabled}
                value={
                  customDelay || !DELETE_PRESETS.includes(settings.deleteAfterMinutes)
                    ? 'custom'
                    : settings.deleteAfterMinutes
                }
                onChange={(event) => {
                  const custom = event.target.value === 'custom';
                  setCustomDelay(custom);
                  if (!custom) void onUpdate({ deleteAfterMinutes: Number(event.target.value) });
                }}
              >
                <option value="60">1 час</option>
                <option value="360">6 часов</option>
                <option value="1440">24 часа</option>
                <option value="10080">7 дней</option>
                <option value="custom">Свой срок</option>
              </select>
            </label>
            {customDelay || !DELETE_PRESETS.includes(settings.deleteAfterMinutes) ? (
              <CommittedNumberField
                label="Минут"
                ariaLabel="Срок автоудаления в минутах"
                value={settings.deleteAfterMinutes}
                min={1}
                max={VK_PARSING_MAX_DELETE_AFTER_MINUTES}
                disabled={disabled}
                onCommit={(deleteAfterMinutes) => onUpdate({ deleteAfterMinutes })}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
