import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChannelSettingsFieldAdapter } from '../../features/network-settings/field-model';
import { AppIcon } from '../../components/ui/app-icon';
import { SegmentedControl } from '../../components/ui/segmented-control';
import {
  channelPostSignatureUrlSchema,
  channelCustomPostButtonInputSchema,
  layoutChannelCustomButtonRows,
  CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH,
  CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH,
} from '@maxim/contracts/channel-post-signature';
import { ChannelSettingsTextField } from './channel-settings-text-field';
import { ChannelCustomButtonsFields } from './channel-custom-buttons-fields';

export function ChannelPostSignatureFields({
  fields,
  onBlur,
  fallbackUrl,
  children,
  systemButtons = [],
  onEditorOpen,
}: {
  fields: ChannelSettingsFieldAdapter;
  onBlur?: () => void;
  fallbackUrl?: string;
  children?: ReactNode;
  systemButtons?: readonly string[];
  onEditorOpen?: (open: boolean) => void;
}) {
  const [previewOpen, setPreviewOpen] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(min-width: 900px)').matches,
  );
  const enabled = fields.read('enabled');
  const presentation = fields.read('presentation');
  const text = fields.read('text');
  const url = fields.read('url');
  const signatureUrl = channelPostSignatureUrlSchema.safeParse(
    url.kind === 'common' ? url.value || fallbackUrl || '' : '',
  );
  const customEnabled = fields.read('customButtonsEnabled');
  const custom = fields.read('customButtons');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = enabled.kind === 'mixed';
  }, [enabled.kind]);
  const isEnabled = enabled.kind === 'common' && enabled.value;
  const isButton = presentation.kind === 'common' && presentation.value === 'button';
  const label =
    text.kind === 'common'
      ? text.value.trim() || CHANNEL_POST_SIGNATURE_DEFAULT_TEXT
      : 'Разные значения';
  const customPreviewRows =
    customEnabled.kind === 'common' && customEnabled.value && custom.kind === 'common'
      ? layoutChannelCustomButtonRows(
          custom.value.filter(
            (button) => channelCustomPostButtonInputSchema.safeParse(button).success,
          ),
        )
          .map((row) =>
            row.filter(
              (button) =>
                !(
                  isEnabled &&
                  isButton &&
                  signatureUrl.success &&
                  signatureUrl.data === button.url
                ),
            ),
          )
          .filter((row) => row.length > 0)
      : [];
  const previewRows = [
    ...systemButtons.map((text) => [{ text }]),
    ...(isEnabled && isButton ? [[{ text: label }]] : []),
    ...customPreviewRows,
  ];
  return (
    <div className="channel-post-actions">
      <details
        className="channel-post-actions__preview"
        open={previewOpen}
        onToggle={(event) => setPreviewOpen(event.currentTarget.open)}
      >
        <summary>
          <AppIcon icon="Eye" />
          Предпросмотр
          <AppIcon icon="NavArrowDown" />
        </summary>
        {children ?? (
          <div className="channel-post-actions__message">
            <div className="channel-post-actions__text">
              <span className="channel-post-signature__message-lines" aria-hidden>
                <i />
                <i />
              </span>
              {isEnabled && !isButton && (
                <span className="channel-post-actions__signature">{label}</span>
              )}
            </div>
            {previewRows.map((row, index) => (
              <div key={index} className="channel-post-actions__preview-row">
                {row.map((button, buttonIndex) => (
                  <div key={buttonIndex} className="channel-post-actions__preview-button">
                    {button.text}
                  </div>
                ))}
              </div>
            ))}
            {(custom.kind === 'mixed' || customEnabled.kind === 'mixed') && (
              <span className="channel-post-actions__mixed">Разные кнопки в каналах</span>
            )}
          </div>
        )}
      </details>
      <div className="channel-post-actions__settings">
        <details className="channel-post-actions__signature-settings">
          <summary>
            <AppIcon icon="Link" />
            Подпись{isEnabled && <span>{isButton ? 'Кнопка' : 'Ссылка'}</span>}
            <AppIcon icon="NavArrowDown" />
          </summary>
          <div className="channel-post-signature__activation">
            <strong>Добавлять подпись</strong>
            <label className="settings-native-switch channel-post-signature__switch">
              <input
                ref={input}
                type="checkbox"
                checked={isEnabled}
                aria-label="Добавлять подпись"
                aria-checked={enabled.kind === 'mixed' ? 'mixed' : isEnabled}
                disabled={fields.readOnly || enabled.kind === 'loading'}
                onChange={(event) => fields.setScalar('enabled', event.target.checked)}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>
          <SegmentedControl
            value={presentation.kind === 'common' ? presentation.value : ''}
            options={[
              { value: 'signature', label: 'Ссылка в тексте', disabled: fields.readOnly },
              { value: 'button', label: 'Кнопка', disabled: fields.readOnly },
            ]}
            ariaLabel="Формат действия под публикацией"
            onChange={(value) => {
              if (value === 'signature' || value === 'button')
                fields.setScalar('presentation', value);
            }}
          />
          <ChannelSettingsTextField
            fields={fields}
            path="text"
            label={isButton ? 'Текст кнопки' : 'Текст ссылки'}
            id="channel-post-signature-text"
            className="channel-post-signature__field"
            maxLength={
              isButton
                ? CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH
                : CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH
            }
            onBlur={onBlur}
          />
          <ChannelSettingsTextField
            fields={fields}
            path="url"
            label="Адрес ссылки"
            id="channel-post-signature-url"
            className="channel-post-signature__field"
            placeholder={fallbackUrl || 'https://max.ru/...'}
            maxLength={CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH}
            onBlur={onBlur}
          />
        </details>
        <ChannelCustomButtonsFields fields={fields} onEditorOpen={onEditorOpen} />
      </div>
    </div>
  );
}
