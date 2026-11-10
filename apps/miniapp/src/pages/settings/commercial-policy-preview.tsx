import { useEffect, useId, useRef, useState } from 'react';
import {
  COMMERCIAL_ADS_PREVIEW_TEXT_MAX,
  type CommercialAdsPolicy,
  type CommercialAdsPreviewResponse,
  type CommercialSettingsProfile,
} from '@maxim/contracts/settings';
import { previewCommercialAds } from '../../lib/api/commercial-ads-client';
import { COMMERCIAL_CATEGORY_LABELS } from '../../lib/commercial-ads-category-labels';
import type { CommercialAuthor } from '../../lib/commercial-ads-policy';
import { commercialPreviewExplanation } from '../../lib/commercial-preview-explanation';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { AppIcon } from '../../components/ui/app-icon';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { AuthorControl, CommercialAuthorPicker } from './commercial-policy-author-control';
import type { CommercialSettingsScope } from './commercial-policy-model';
import './commercial-policy-sheets.css';

export function CommercialPreviewSheet({
  scope,
  policy,
  enabled,
  classification,
  dirty,
  onClose,
}: {
  scope: CommercialSettingsScope;
  policy: CommercialAdsPolicy | null;
  enabled: boolean;
  classification: CommercialSettingsProfile;
  dirty: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [author, setAuthor] = useState<CommercialAuthor | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ key: string; value: CommercialAdsPreviewResponse } | null>(
    null,
  );
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const resultElement = useRef<HTMLDivElement | null>(null);
  const key = JSON.stringify([
    scope.chatId,
    text,
    author?.userId ?? null,
    enabled,
    policy,
    classification,
  ]);
  const activeKey = useRef(key);
  activeKey.current = key;
  const resultId = useId();
  const visibleResult = result?.key === key ? result.value : null;
  const test = async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const submitted = key;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const value = await previewCommercialAds(
        scope.api,
        scope.chatId,
        { text, policy, enabled, classification, userId: author?.userId ?? null },
        request.signal,
      );
      if (!request.signal.aborted && activeKey.current === submitted)
        setResult({ key: submitted, value });
    } catch (cause) {
      if (!request.signal.aborted && activeKey.current === submitted)
        setError({
          key: submitted,
          message: describeUserFacingError(cause, 'Не удалось проверить сообщение.'),
        });
    } finally {
      if (controller.current === request) setBusy(false);
    }
  };
  useEffect(() => {
    controller.current?.abort();
    setBusy(false);
  }, [key]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (visibleResult)
      resultElement.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [visibleResult]);
  const title =
    visibleResult?.decision === 'DELETE'
      ? 'Удалить'
      : visibleResult?.decision === 'UNAVAILABLE'
        ? 'Не удалось проверить'
        : visibleResult?.decision === 'UNSURE'
          ? 'Недостаточно данных'
          : 'Оставить';
  return (
    <>
      <SettingsDrilldownPanel
        id="commercial-preview"
        open
        title="Проверить сообщение"
        className="commercial-panel"
        onClose={onClose}
        keepFooterVisibleWhenKeyboardOpen
        footer={
          <button
            type="button"
            className="button button--accent commercial-policy__submit"
            disabled={!text.trim() || busy}
            onClick={() => void test()}
          >
            <AppIcon icon={busy ? 'Refresh' : 'Play'} />
            {busy ? 'Проверяем' : 'Проверить'}
          </button>
        }
      >
        <div className="commercial-policy commercial-policy--sheet">
          <label className="commercial-policy__text-field">
            <span className="commercial-policy__label">Сообщение</span>
            <textarea
              rows={6}
              maxLength={COMMERCIAL_ADS_PREVIEW_TEXT_MAX}
              value={text}
              aria-label="Сообщение для проверки"
              aria-describedby={dirty ? `${resultId}-draft` : undefined}
              onChange={(event) => setText(event.target.value)}
            />
            <small>
              {text.length} / {COMMERCIAL_ADS_PREVIEW_TEXT_MAX}
            </small>
          </label>
          <AuthorControl
            value={author}
            optional
            onChoose={() => setPicker(true)}
            onClear={() => setAuthor(null)}
          />
          {dirty ? (
            <p id={`${resultId}-draft`} className="commercial-policy__notice">
              Проверка с несохранёнными настройками
            </p>
          ) : null}
          {error?.key === key ? (
            <p className="commercial-policy__error" role="alert">
              {error.message}
            </p>
          ) : null}
          {visibleResult ? (
            <div
              ref={resultElement}
              className="commercial-policy__result"
              data-decision={visibleResult.decision}
              role="status"
              aria-live="polite"
            >
              <span className="commercial-policy__result-icon">
                <AppIcon
                  icon={
                    visibleResult.decision === 'DELETE'
                      ? 'ShieldAlert'
                      : visibleResult.decision === 'UNAVAILABLE' ||
                          visibleResult.decision === 'UNSURE'
                        ? 'WarningTriangle'
                        : 'ShieldCheck'
                  }
                />
              </span>
              <div>
                <strong>{title}</strong>
                <p>{commercialPreviewExplanation(visibleResult)}</p>
                {visibleResult.categories.length ? (
                  <small>
                    {visibleResult.categories
                      .map((category) => COMMERCIAL_CATEGORY_LABELS[category])
                      .join(' · ')}
                  </small>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsDrilldownPanel>
      {picker ? (
        <CommercialAuthorPicker
          scope={scope}
          onClose={() => setPicker(false)}
          onSelect={(value) => {
            setAuthor(value);
            setPicker(false);
          }}
        />
      ) : null}
    </>
  );
}
