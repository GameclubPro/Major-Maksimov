import { useEffect, useState } from 'react';
import type { LogsDashboardViolation, ModerationMessageDetails } from '@maxim/contracts';
import type { ApiTransport } from '../lib/api/transport';
import { getModerationMessage } from '../lib/api/moderation-message-client';
import { resolveModerationFeedReason } from '../lib/moderation-feed-reason';
import { describeUserFacingError } from '../lib/user-facing-error';
import { SettingsDrilldownPanel } from './ui/settings-drilldown-panel';
import { AppIcon } from './ui/app-icon';
import { PersonAvatar } from './ui/person-avatar';
import { Spinner } from './ui/spinner';
import { CommercialJournalActions } from './commercial-journal-actions';
import './moderation-message-sheet.css';

const attachmentLabels = {
  image: 'Фото',
  video: 'Видео',
  audio: 'Аудио',
  file: 'Файл',
  sticker: 'Стикер',
  contact: 'Контакт',
  location: 'Местоположение',
  other: 'Вложение',
};

type Props = {
  api: ApiTransport;
  chatId: string;
  event: LogsDashboardViolation;
  onClose: () => void;
  onParticipant?: () => void;
};

export function ModerationMessageSheet({ api, chatId, event, onClose, onParticipant }: Props) {
  const [loaded, setLoaded] = useState<{
    identity: string;
    value: ModerationMessageDetails;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const identity = `${chatId}:${event.id}`;
  const message = loaded?.identity === identity ? loaded.value : null;
  useEffect(() => {
    const abort = new AbortController();
    setLoaded(null);
    setError(null);
    void getModerationMessage(api, chatId, event.id, abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setLoaded({ identity, value });
      },
      (cause) => {
        if (!abort.signal.aborted)
          setError(describeUserFacingError(cause, 'Не удалось загрузить сообщение.'));
      },
    );
    return () => abort.abort();
  }, [api, chatId, event.id, identity, attempt]);
  const author = event.userDisplayName?.trim() || 'Участник';
  const attachments = new Map<string, number>();
  for (const type of message?.content?.attachments ?? []) {
    const label = attachmentLabels[type];
    attachments.set(label, (attachments.get(label) ?? 0) + 1);
  }
  return (
    <SettingsDrilldownPanel
      id="moderation-message"
      open
      title="Сообщение"
      tone="ink"
      className="moderation-message"
      onClose={onClose}
    >
      <div className="moderation-message__identity">
        <button
          type="button"
          className="moderation-message__author"
          onClick={onParticipant}
          disabled={!onParticipant}
        >
          <PersonAvatar
            avatarUrl={event.avatarUrl}
            fallback={author.slice(0, 1)}
            className="moderation-message__avatar"
          />
          <strong>{author}</strong>
          {onParticipant ? <AppIcon icon="NavArrowRight" aria-hidden /> : null}
        </button>
        <time dateTime={event.createdAt}>
          {new Date(event.createdAt).toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      <section className="moderation-message__paper" aria-label="Содержание сообщения">
        {error ? (
          <div className="moderation-message__error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Повторить
            </button>
          </div>
        ) : !message ? (
          <Spinner label="Загружаем сообщение" />
        ) : message.content ? (
          <>
            {message.state === 'partial' ? (
              <span className="moderation-message__label">Фрагмент</span>
            ) : null}
            {message.content.text ? (
              <p className="moderation-message__text">{message.content.text}</p>
            ) : null}
            {attachments.size ? (
              <div className="moderation-message__attachments">
                {Array.from(attachments, ([label, count]) => (
                  <span key={label}>
                    <AppIcon icon="Attachment" aria-hidden />
                    {label}
                    {count > 1 ? ` · ${count}` : ''}
                  </span>
                ))}
                <small>Копии вложений нет</small>
              </div>
            ) : null}
            {!message.content.text && !attachments.size ? (
              <p className="moderation-message__empty">Содержимое не сохранено</p>
            ) : null}
          </>
        ) : (
          <p className="moderation-message__empty">
            {message.state === 'expired' ? 'Срок хранения истёк' : 'Текст не сохранён'}
          </p>
        )}
      </section>
      <section className="moderation-message__reason" aria-label="Причина">
        <span className="moderation-message__label">Причина</span>
        <p>{resolveModerationFeedReason(event)}</p>
      </section>
      {event.ruleCode === 'COMMERCIAL_AD' || event.ruleCode === 'COMMERCIAL_LLM_DELETE' ? (
        <CommercialJournalActions api={api} chatId={chatId} violation={event} />
      ) : null}
    </SettingsDrilldownPanel>
  );
}
