import { useState } from 'react';
import { Link } from 'react-router';
import type { LogsDashboardViolation } from '@maxim/contracts';
import { commercialAdsUserIdSchema } from '@maxim/contracts/settings';
import type { ApiTransport } from '../lib/api/transport';
import { reportCommercialAdsMistake } from '../lib/api/commercial-ads-client';
import {
  commercialCategoriesFromMetadata,
  commercialExceptionSettingsSearch,
} from '../lib/commercial-ads-policy';
import { buildManagedEntitySettingsRoute } from '../lib/managed-entity-workspace';
import { describeUserFacingError } from '../lib/user-facing-error';
import { AppIcon } from './ui/app-icon';
import './commercial-journal-actions.css';

export function CommercialJournalActions({
  api,
  chatId,
  violation,
}: {
  api: ApiTransport;
  chatId: string;
  violation: LogsDashboardViolation;
}) {
  const [sent, setSent] = useState(violation.metadata?.commercialFeedbackReported === true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = commercialAdsUserIdSchema.safeParse(violation.userId);
  const category = commercialCategoriesFromMetadata(violation.metadata)[0];
  const report = async () => {
    if (busy || sent) return;
    setBusy(true);
    setError(null);
    try {
      await reportCommercialAdsMistake(api, chatId, violation.id);
      setSent(true);
    } catch (cause) {
      setError(describeUserFacingError(cause, 'Не удалось отправить отметку.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="commercial-journal-actions">
      <button
        type="button"
        className="button button--ghost"
        disabled={busy || sent}
        onClick={() => void report()}
      >
        <AppIcon icon={sent ? 'Check' : 'Reports'} />
        {sent ? 'Отметка отправлена' : busy ? 'Отправляем' : 'Ошибка распознавания'}
      </button>
      {user.success ? (
        <Link
          className="button button--ghost"
          to={
            buildManagedEntitySettingsRoute('chat', chatId) +
            commercialExceptionSettingsSearch({
              userId: user.data,
              userName: violation.userDisplayName?.trim() || 'Участник',
              ...(category ? { category } : {}),
            })
          }
        >
          <AppIcon icon="UserPlus" />
          Добавить исключение
        </Link>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
