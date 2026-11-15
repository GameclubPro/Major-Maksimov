import { summarizeDuplicateMessages } from './duplicate-diagnostics-summary';
import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  duplicateDiagnosticsResponseSchema,
  duplicateMessageLinkResponseSchema,
  type DuplicateDeletionAttempt,
  type DuplicateObservationOutcome,
} from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import { openLink } from '../../lib/max-bridge';

export const DUPLICATE_ATTEMPT_LABELS: Record<DuplicateDeletionAttempt['outcome'], string> = {
  DELETED: 'Удалено',
  ALREADY_ABSENT: 'Сообщение уже отсутствует',
  PENDING: 'Ожидает удаления',
  RETRYING: 'Ожидает повторной попытки',
  WAITING_ACCESS: 'Ожидает доступа к удалению',
  UNCONFIRMED: 'Удаление не подтверждено',
  EXPIRED: 'Срок удаления истёк',
  CANCELLED: 'Удаление отменено',
  OBSERVED: 'Наблюдение без удаления',
};
const REASON_LABELS: Record<NonNullable<DuplicateDeletionAttempt['reason']>, string> = {
  IMMUNITY: 'Иммунитет участника',
  AUTHOR_LEFT: 'Автор вышел из чата',
  CONTENT_CHANGED: 'Совпадение больше не подтверждается',
  POLICY_CHANGED: 'Условия проверки изменились',
  UNKNOWN: 'Причина не подтверждена',
};
const OBSERVATION_LABELS: Record<DuplicateObservationOutcome, string> = {
  OFF: 'Проверка остановлена',
  SCHEDULE_CLOSED: 'Вне расписания',
  EVENT_TIME_REJECTED: 'Время сообщения не подтверждено',
  UNTRACKED: 'Сообщение исключено из проверки',
  CONTENT_UNVERIFIED: 'Содержимое не подтверждено',
  UNSUPPORTED_CONTENT: 'Неподдерживаемое содержимое',
  MEDIA_QUEUED: 'Изображение ожидает проверки',
  MEDIA_CANDIDATE: 'Первое изображение ожидает сравнения',
  SOURCE_UNAVAILABLE: 'Исходное сообщение недоступно',
  POLICY_CHANGED: 'Режим проверки изменился',
  SETTINGS_CHANGED: 'Настройки или доступ изменились',
  STALE: 'Версия сообщения устарела',
  DEADLINE_EXPIRED: 'Срок проверки истёк',
  DEFERRED: 'Проверка отложена',
  COMPARISON_FAILED: 'Сравнение не завершилось',
  UNAVAILABLE: 'Проверку не удалось начать',
  COMPARED_NO_MATCH: 'Сравнено: повтора сверх допуска нет',
  MATCHED_INELIGIBLE: 'Повтор найден, удаление недоступно',
  MATCHED_QUALIFICATION_REJECTED: 'Повтор найден, условия удаления больше не выполняются',
  MATCHED_CLAIM_BLOCKED: 'Совпадение: сообщение обрабатывает другое правило',
  MATCHED_OBSERVE: 'Совпадение в режиме наблюдения',
  MATCHED_ACTION_FAILED: 'Повтор найден, запуск удаления не подтверждён',
  ENFORCEMENT_REQUESTED: 'Повтор найден, удаление запрошено',
};
const MATCH_LABELS = {
  exact: 'Одинаковый текст',
  content: 'Одинаковое содержимое',
  near: 'Близкое совпадение текста',
  link: 'Одинаковая ссылка',
  phone: 'Одинаковый номер телефона',
  image: 'Одинаковая картинка',
  image_set: 'Одинаковый альбом',
  unknown: 'Тип совпадения не подтверждён',
};
const SANCTION_LABELS = { WARN: 'Предупреждение', MUTE: 'Ограничение', BAN: 'Блокировка' };

function MessageLinkButton({
  api,
  path,
  role,
  userId,
}: {
  api: ApiTransport;
  path: string;
  role: 'original' | 'target';
  userId: string | null;
}) {
  const scope = useMemo(() => ({ api, path, role, userId }), [api, path, role, userId]);
  const activeScope = useRef<typeof scope | null>(scope);
  activeScope.current = scope;
  const link = useMutation({
    mutationFn: async (request: typeof scope) =>
      duplicateMessageLinkResponseSchema.parse(
        await request.api.request(`${request.path}/message-link/${request.role}`),
      ),
    // FLAG: A delayed link reply must never open a message after leaving its chat/account.
    onSuccess: (value, request) => {
      if (activeScope.current === request && value.url) openLink(value.url);
    },
  });
  useLayoutEffect(() => {
    activeScope.current = scope;
    link.reset();
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
    };
  }, [scope]);
  return (
    <>
      <button
        type="button"
        className="button button--ghost"
        disabled={link.isPending}
        onClick={() => link.mutate(scope)}
      >
        {role === 'original' ? 'Открыть оригинал' : 'Открыть повтор'}
      </button>
      {(link.isError || link.data?.state === 'UNAVAILABLE') && (
        <span role="status">Ссылка недоступна</span>
      )}
    </>
  );
}
function formatTime(value: string) {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function SettingsDuplicateDiagnostics({
  api,
  chatId,
  userId,
}: {
  api: ApiTransport;
  chatId: string;
  userId: string | null;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['duplicate-diagnostics', userId, chatId];
  const path = `/chats/${encodeURIComponent(chatId)}/duplicate-diagnostics`;
  const scope = useMemo(() => ({ api, path, userId, chatId }), [api, path, userId, chatId]);
  const activeScope = useRef<typeof scope | null>(scope);
  useLayoutEffect(() => {
    activeScope.current = scope;
    return () => {
      if (activeScope.current === scope) activeScope.current = null;
    };
  }, [scope]);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) =>
      duplicateDiagnosticsResponseSchema.parse(await api.request(path, { signal })),
    enabled: Boolean(userId),
    staleTime: 30_000,
    // FLAG: Reopening after save must refresh the saved state even while the old cache is fresh.
    refetchOnMount: 'always',
    retry: false,
    refetchOnWindowFocus: false,
  });
  type RecheckRequest = {
    scope: typeof scope;
    state: ReturnType<typeof queryClient.getQueryState>;
  };
  const recheck = useMutation({
    mutationFn: async (request: RecheckRequest) =>
      duplicateDiagnosticsResponseSchema.parse(
        await request.scope.api.request(`${request.scope.path}/recheck`, { method: 'POST' }),
      ),
    onSuccess: (data, request) => {
      const key = ['duplicate-diagnostics', request.scope.userId, request.scope.chatId];
      // FLAG: Saving settings invalidates immutable query state before its fresh GET finishes.
      // A later reply, even in the same millisecond, cannot restore the pre-save snapshot.
      if (
        activeScope.current !== request.scope ||
        !request.state ||
        queryClient.getQueryState(key) !== request.state
      )
        return;
      queryClient.setQueryData(key, data);
    },
  });
  const busy = query.isFetching || recheck.isPending;
  const failed = query.isError || recheck.isError;
  const data = query.data;
  const epoch = useMemo(
    () => ({
      scope,
      updatedAt: query.dataUpdatedAt,
      firstPageCount: data?.history.attempts.length ?? 0,
    }),
    [scope, query.dataUpdatedAt, data],
  );
  const historyEpoch = useRef<typeof epoch | null>(epoch);
  historyEpoch.current = epoch;
  const [olderPage, setOlderPage] = useState<{
    epoch: typeof epoch;
    attempts: DuplicateDeletionAttempt[];
    cursor: string | null;
  }>();
  const older = olderPage?.epoch === epoch ? olderPage.attempts : [];
  const nextCursor = olderPage?.epoch === epoch ? olderPage.cursor : data?.history.nextCursor;
  const loadMore = useMutation({
    mutationFn: async (request: { cursor: string; epoch: typeof epoch }) => {
      const value = duplicateDiagnosticsResponseSchema.parse(
        await request.epoch.scope.api.request(
          `${request.epoch.scope.path}?cursor=${encodeURIComponent(request.cursor)}`,
        ),
      );
      if (!value.history.available) throw new Error('История временно недоступна');
      return value;
    },
    onSuccess: (value, request) => {
      if (request.epoch !== historyEpoch.current) return;
      setOlderPage((current) => ({
        epoch: request.epoch,
        attempts: [
          ...(current?.epoch === request.epoch ? current.attempts : []),
          ...value.history.attempts,
        ].slice(0, Math.max(0, 50 - request.epoch.firstPageCount)),
        cursor: value.history.nextCursor ?? null,
      }));
    },
  });
  useLayoutEffect(() => {
    historyEpoch.current = epoch;
    setOlderPage(undefined);
    loadMore.reset();
    recheck.reset();
    return () => {
      if (historyEpoch.current === epoch) historyEpoch.current = null;
    };
  }, [epoch]);
  const attempts = [...(data?.history.attempts ?? []), ...older];
  const messageSummary = summarizeDuplicateMessages(attempts);
  const capability = failed ? 'UNKNOWN' : data?.capability.state;
  const capabilityLabel = busy
    ? 'Проверяем права'
    : capability === 'CONFIRMED'
      ? 'Права удаления подтверждены'
      : capability === 'MISSING'
        ? 'Нет прав удаления'
        : 'Права удаления не подтверждены';
  return (
    <section className="duplicate-diagnostics" aria-label="Состояние бота">
      <div className="duplicate-diagnostics__heading">
        <div>
          <h3 className="duplicate-stage__title">Состояние бота</h3>
          <p
            className="duplicate-diagnostics__status"
            data-state={busy ? 'UNKNOWN' : (capability ?? 'UNKNOWN')}
            role="status"
          >
            {capabilityLabel}
          </p>
        </div>
        <button
          type="button"
          className="button button--ghost duplicate-diagnostics__refresh"
          aria-label="Проверить права"
          title="Проверить права"
          disabled={busy || !userId}
          onClick={() => recheck.mutate({ scope, state: queryClient.getQueryState(queryKey) })}
        >
          <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
        </button>
      </div>
      {failed && (
        <p className="field__hint" role="alert">
          Не удалось обновить проверку
        </p>
      )}
      {data && (
        <details className="duplicate-diagnostics__history">
          <summary>Проверка и история</summary>
          <dl className="duplicate-diagnostics__facts">
            <div>
              <dt>Сохранённая настройка</dt>
              <dd>{data.enabled ? 'Включена' : 'Выключена'}</dd>
            </div>
            <div>
              <dt>Режим</dt>
              <dd>
                {data.mode === 'FULL'
                  ? 'Действия по настройкам'
                  : data.mode === 'DELETE_ONLY'
                    ? 'Расширенная проверка: только удаление'
                    : data.mode === 'OFF'
                      ? 'Проверка остановлена'
                      : data.mode === 'OBSERVE'
                        ? 'Наблюдение без удаления'
                        : data.mode === 'LEGACY_TEXT'
                          ? 'Основная проверка текста'
                          : 'Не подтверждён'}
              </dd>
            </div>
            <div>
              <dt>Права проверены</dt>
              <dd>
                {data.capability.checkedAt ? formatTime(data.capability.checkedAt) : 'Нет данных'}
              </dd>
            </div>
          </dl>
          <h4 className="duplicate-stage__title">Проверка сообщений</h4>
          {!data.observation || data.observation.state === 'UNAVAILABLE' ? (
            <p role="status">Статистика проверок временно недоступна</p>
          ) : data.observation.state === 'NO_DATA' ? (
            <p role="status">Данные о проверках ещё не поступили</p>
          ) : (
            <>
              <p className="field__hint">
                Неполная статистика попыток с {formatTime(data.observation.since)}. Повторные
                попытки учитываются отдельно; обновление может запаздывать.
              </p>
              <p>
                {data.observation.coverage === null
                  ? 'Нет данных для оценки полноты сравнения'
                  : `Сравнение завершено: ${data.observation.verifiedAttempts} из ${data.observation.supportedAttempts} поддерживаемых попыток (${Math.round(data.observation.coverage * 100)}%)`}
              </p>
              <dl className="duplicate-diagnostics__facts">
                {data.observation.outcomes.map(({ outcome, count }) => (
                  <div key={outcome}>
                    <dt>{OBSERVATION_LABELS[outcome]}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
              <p className="field__hint">Результат сравнения не подтверждает удаление сообщения.</p>
            </>
          )}
          <h4 className="duplicate-stage__title">Результаты по сообщениям</h4>
          <div className="duplicate-diagnostics__history-meta">
            <span>За 24 часа</span>
            <time dateTime={data.generatedAt}>{formatTime(data.generatedAt)}</time>
          </div>
          {!data.history.available ? (
            <p role="status">История временно недоступна</p>
          ) : (
            <>
              {data.history.limited && <p className="field__hint">Неполная выборка</p>}
              {data.history.coverage === 'PROJECTED_ONLY' && (
                <p className="field__hint">
                  Показаны зарегистрированные решения антидубля. Более ранняя история может быть
                  неполной.
                </p>
              )}
              {messageSummary.total > 0 && (
                <p className="field__hint">
                  В выборке: {messageSummary.total}.{' '}
                  {messageSummary.outcomes
                    .map(([outcome, count]) => `${DUPLICATE_ATTEMPT_LABELS[outcome]}: ${count}`)
                    .join('; ')}
                  .
                </p>
              )}
              {attempts.length === 0 ? (
                <p>
                  {data.history.limited
                    ? 'В выборке нет попыток антидубля'
                    : 'Попыток удаления не было'}
                </p>
              ) : (
                <ol className="duplicate-diagnostics__attempts">
                  {attempts.map((attempt) => (
                    <li key={attempt.id}>
                      <time dateTime={attempt.createdAt}>{formatTime(attempt.createdAt)}</time>
                      <div>
                        <strong>{DUPLICATE_ATTEMPT_LABELS[attempt.outcome]}</strong>
                        {attempt.target && (
                          <>
                            <span>Номер повтора: {attempt.target.messageId}</span>
                            <MessageLinkButton
                              api={api}
                              path={`${path}/${encodeURIComponent(attempt.id)}`}
                              role="target"
                              userId={userId}
                            />
                          </>
                        )}
                        {attempt.comparison && (
                          <>
                            <span>{MATCH_LABELS[attempt.comparison.kind]}</span>
                            <span>
                              Период: {attempt.comparison.windowSeconds / 3600} ч; удаление с №
                              {attempt.comparison.firstDeletedMessageNumber}
                            </span>
                          </>
                        )}
                        {attempt.sanction && (
                          <span>
                            {SANCTION_LABELS[attempt.sanction.action]}:{' '}
                            {attempt.sanction.state === 'CONFIRMED'
                              ? 'выполнение подтверждено'
                              : 'запланировано, выполнение не подтверждено'}
                          </span>
                        )}
                        {attempt.reason && <span>{REASON_LABELS[attempt.reason]}</span>}
                        {attempt.original && (
                          <>
                            <span>Оригинал: {formatTime(attempt.original.publishedAt)}</span>
                            <span>
                              Повтор разрешён с {formatTime(attempt.original.repeatAllowedAt)}
                            </span>
                            <span>Номер оригинала: {attempt.original.messageId}</span>
                            <MessageLinkButton
                              api={api}
                              path={`${path}/${encodeURIComponent(attempt.id)}`}
                              role="original"
                              userId={userId}
                            />
                          </>
                        )}
                        {attempt.nextAttemptAt && (
                          <span>Следующая попытка: {formatTime(attempt.nextAttemptAt)}</span>
                        )}
                        {attempt.registeredAt && (
                          <span>В истории с {formatTime(attempt.registeredAt)}</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {nextCursor && attempts.length < 50 && (
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={loadMore.isPending}
                  onClick={() => loadMore.mutate({ cursor: nextCursor, epoch })}
                >
                  Показать ещё
                </button>
              )}
              {loadMore.isError && <p role="alert">Не удалось загрузить следующую страницу</p>}
            </>
          )}
        </details>
      )}
    </section>
  );
}
