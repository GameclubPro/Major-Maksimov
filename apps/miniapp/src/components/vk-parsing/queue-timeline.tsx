import { AppIcon as IconoirSprite } from '../ui/app-icon';
import { useEffect, useState } from 'react';
import { DateTime } from 'luxon';

import type { VkParsingPost } from '@maxim/contracts';
import { TimeField } from '../ui/time-field';
import { DateField } from '../ui/date-field';
import { ActionConfirmSheet } from '../ui/action-confirm-sheet';
import { parseVkQueueDate, resolveVkQueueQuickSlot } from './queue-time';
import { formatTimezoneLabel } from '../../lib/timezone-label';
import { vkPostBlockedReason } from './workflow';

type QueueTimelineProps = {
  timezone?: string;
  posts: VkParsingPost[];
  schedulingPostId: string | null;
  cancelingPostId: string | null;
  publishingNowPostId: string | null;
  onSchedulePost: (postId: string, scheduledAt: string) => void;
  onCancelPost: (postId: string) => void;
  onPublishNow: (postId: string) => void;
};

function QueueItem({
  post,
  busy,
  timezone,
  onSchedule,
  onAction,
}: {
  post: VkParsingPost;
  busy: boolean;
  timezone: string;
  onSchedule: (at: string) => void;
  onAction: (action: 'publish' | 'cancel') => void;
}) {
  const quarantined = vkPostBlockedReason({
    ...post,
    publishQueuedAt: null,
    publishLockedAt: null,
  });
  const unavailable = busy || Boolean(post.publishLockedAt) || Boolean(quarantined);
  const at = post.publishScheduledAt ?? post.publishQueuedAt;
  const server = at ? DateTime.fromISO(at, { zone: timezone }).toFormat("yyyy-MM-dd'T'HH:mm") : '';
  const [draft, setDraft] = useState(server);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(server);
  }, [server, editing]);
  const [date = '', time = ''] = draft.split('T');
  const parsed = parseVkQueueDate(draft, timezone);
  const dirty = draft !== server;
  useEffect(() => {
    if (editing && draft === server) setEditing(false);
  }, [draft, editing, server]);
  return (
    <article className="vk-queue-item">
      <div className="vk-queue-item__main">
        <strong>{post.sourceTitle}</strong>
        <span>
          {at
            ? DateTime.fromISO(at, { zone: timezone }).setLocale('ru').toFormat('d MMM, HH:mm')
            : 'Время не задано'}
        </span>
      </div>
      <div className="vk-queue-item__preview">
        {post.text ||
          (post.photoUrls.length
            ? 'Пост с фото'
            : post.videoUrls.length
              ? 'Пост с видео'
              : 'Пост без текста')}
      </div>
      <div className="vk-queue-item__schedule">
        <DateField
          label="Дата"
          aria-label={`Дата публикации: ${post.sourceTitle}`}
          placeholder="дд.мм.гггг"
          value={date}
          disabled={unavailable}
          onChange={(value) => {
            setEditing(true);
            setDraft(`${value}T${time}`);
          }}
        />
        <div className="vk-queue-item__time">
          <span>Время</span>
          <TimeField
            label={`Время публикации: ${post.sourceTitle}`}
            variant="compact"
            value={time}
            allowEmpty
            disabled={unavailable}
            onChange={(value) => {
              setEditing(true);
              setDraft(`${date}T${value}`);
            }}
          />
        </div>
      </div>
      {dirty ? (
        <div className="vk-queue-item__edit-actions">
          {!parsed ? <span role="status">Нужны будущая дата и время</span> : null}
          <button
            type="button"
            title="Отменить изменение времени"
            aria-label="Отменить изменение времени"
            disabled={unavailable}
            onClick={() => {
              setEditing(false);
              setDraft(server);
            }}
          >
            <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
          </button>
          <button
            type="button"
            disabled={unavailable || !parsed}
            onClick={() => {
              if (parsed) onSchedule(parsed);
            }}
          >
            <IconoirSprite variant="iconoir" icon="Check" aria-hidden />
            <span>Сохранить время</span>
          </button>
        </div>
      ) : null}
      <div className="vk-queue-item__actions">
        {(
          [
            { label: '+30 мин', minutes: 30 },
            { label: '+2 часа', minutes: 120 },
            { label: 'Завтра, 09:00', minutes: null },
          ] as const
        ).map((slot) => (
          <button
            key={slot.label}
            type="button"
            className="vk-source-preset"
            disabled={unavailable}
            onClick={() => {
              setEditing(false);
              onSchedule(resolveVkQueueQuickSlot(slot.minutes, timezone));
            }}
          >
            {slot.label}
          </button>
        ))}
        <button
          type="button"
          className="vk-source-preset"
          title="Опубликовать сейчас"
          aria-label={`Опубликовать сейчас: ${post.sourceTitle}`}
          disabled={unavailable}
          onClick={() => onAction('publish')}
        >
          <IconoirSprite variant="iconoir" icon="Send" aria-hidden />
        </button>
        <button
          type="button"
          className="vk-source-preset"
          title="Снять с очереди"
          aria-label={`Снять с очереди: ${post.sourceTitle}`}
          disabled={unavailable}
          onClick={() => onAction('cancel')}
        >
          <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
        </button>
      </div>
      {quarantined || post.publishLockedAt ? (
        <p className="vk-inline-warning" role="status">
          {quarantined ?? 'Пост отправляется.'}
        </p>
      ) : null}
    </article>
  );
}

export function QueueTimeline({
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  posts,
  schedulingPostId,
  cancelingPostId,
  publishingNowPostId,
  onSchedulePost,
  onCancelPost,
  onPublishNow,
}: QueueTimelineProps) {
  const [confirmation, setConfirmation] = useState<{
    post: VkParsingPost;
    action: 'publish' | 'cancel';
  } | null>(null);
  const busy = Boolean(schedulingPostId || cancelingPostId || publishingNowPostId);
  if (!posts.length) return null;
  return (
    <section className="vk-queue-timeline" aria-label="Очередь публикаций">
      <div className="vk-queue-timezone">{formatTimezoneLabel(timezone)}</div>
      <div className="vk-queue-list">
        {posts.map((post) => (
          <QueueItem
            key={post.id}
            post={post}
            timezone={timezone}
            busy={busy}
            onSchedule={(at) => onSchedulePost(post.id, at)}
            onAction={(action) => setConfirmation({ post, action })}
          />
        ))}
      </div>
      <ActionConfirmSheet
        id="vk-queue-confirm"
        open={confirmation !== null}
        title={confirmation?.action === 'publish' ? 'Опубликовать сейчас?' : 'Снять с очереди?'}
        previewTitle={confirmation?.post.sourceTitle}
        previewMeta={confirmation?.post.text.slice(0, 160)}
        confirmLabel={confirmation?.action === 'publish' ? 'Опубликовать' : 'Снять с очереди'}
        tone={confirmation?.action === 'publish' ? 'accent' : 'danger'}
        isBusy={busy}
        onClose={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation || busy) return;
          if (confirmation.action === 'publish') onPublishNow(confirmation.post.id);
          else onCancelPost(confirmation.post.id);
          setConfirmation(null);
        }}
      />
    </section>
  );
}
