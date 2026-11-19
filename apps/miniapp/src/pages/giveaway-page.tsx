import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import type { ManagedGiveawayParticipantState } from '@maxim/contracts/giveaway';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { EntityAvatar } from '../components/ui/entity-avatar';
import {
  claimGiveaway,
  enterGiveaway,
  getGiveawayParticipantState,
  getPublicGiveaway,
} from '../lib/api/giveaway-client';
import { ApiRequestError } from '../lib/api-request-error';
import type { ApiTransport } from '../lib/api/transport';
import {
  buildGiveawayConditions,
  canClaimGiveaway,
  formatGiveawayCountdown,
  isGiveawayEntryOpen,
  resolveGiveawayDisplayPhase,
} from '../lib/giveaway-state';
import { giveawayImageSource } from '../lib/giveaway-image';
import { closeMaxMiniApp, maxNotify, openMaxBotLink } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { queryKeys } from '../lib/query-keys';
import { describeUserFacingError } from '../lib/user-facing-error';
import '../styles/giveaway-page.css';

const conditionLabels = {
  unknown: 'Не проверено',
  checking: 'Проверяем',
  verified: 'Подписка подтверждена',
  missing: 'Нужна подписка',
};
const winnerLabels = {
  SELECTED: 'Ожидает подтверждения',
  CLAIMED: 'Подтверждено',
  DELIVERED: 'Выдано',
  EXPIRED: 'Срок истёк',
  REROLLED: 'Заменён',
};
const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

export function GiveawayPage({ api }: { api: ApiTransport }) {
  const { giveawayId = '' } = useParams();
  return <GiveawayParticipation key={giveawayId} api={api} giveawayId={giveawayId} />;
}

function GiveawayParticipation({ api, giveawayId }: { api: ApiTransport; giveawayId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [nowMs, setNowMs] = useState(Date.now);
  const [actionError, setActionError] = useState<string | null>(null);
  const [claimFailureChannels, setClaimFailureChannels] = useState<string[] | null>(null);
  const [returnPending, setReturnPending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const actionInFlight = useRef(false);
  const awaitingReturn = useRef(false);
  const mounted = useRef(true);
  const clockAnchor = useRef({ server: Date.now(), monotonic: performance.now() });
  const publicKey = queryKeys.publicGiveaway(giveawayId);
  const participantKey = queryKeys.giveawayParticipant(giveawayId);
  const giveawayQuery = useQuery({
    queryKey: publicKey,
    queryFn: async ({ signal }) => {
      const data = await getPublicGiveaway(api, giveawayId, { signal });
      clockAnchor.current = {
        server: data.serverTime ? Date.parse(data.serverTime) : Date.now(),
        monotonic: performance.now(),
      };
      return data;
    },
    enabled: Boolean(giveawayId),
    refetchOnWindowFocus: true,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'ACTIVE' || status === 'SCHEDULED' ? 30_000 : false;
    },
  });
  const participantQuery = useQuery({
    queryKey: participantKey,
    queryFn: ({ signal }) => getGiveawayParticipantState(api, giveawayId, { signal }),
    enabled: Boolean(giveawayId) && giveawayQuery.isSuccess,
    refetchOnWindowFocus: () => !actionInFlight.current,
  });
  const giveaway = giveawayQuery.data ?? null;
  const participant = participantQuery.data ?? null;
  const phase = giveaway ? resolveGiveawayDisplayPhase(giveaway, nowMs) : null;
  const entryOpen = giveaway ? isGiveawayEntryOpen(giveaway, nowMs) : false;
  const refreshQueries = () => {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: publicKey }),
      queryClient.invalidateQueries({ queryKey: participantKey }),
    ]);
  };
  const refresh = useEffectEvent(refreshQueries);
  useEffect(() => {
    mounted.current = true;
    const tick = () => {
      if (document.visibilityState !== 'hidden')
        setNowMs(clockAnchor.current.server + performance.now() - clockAnchor.current.monotonic);
    };
    const timer = window.setInterval(tick, 1_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  useEffect(() => {
    if (phase) refresh();
  }, [phase]);
  useEffect(() => {
    if (phase !== 'DRAWING') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [phase]);
  const enterMutation = useMutation({
    mutationFn: () => enterGiveaway(api, giveawayId),
    onSuccess: (next: ManagedGiveawayParticipantState) => {
      queryClient.setQueryData(participantKey, next);
      void queryClient.invalidateQueries({ queryKey: publicKey });
      if (mounted.current) maxNotify(next.eligibilityState === 'VERIFIED' ? 'success' : 'warning');
    },
  });
  const claimMutation = useMutation({
    mutationFn: () => claimGiveaway(api, giveawayId),
    onSuccess: () => {
      if (mounted.current) maxNotify('success');
      refreshQueries();
    },
  });
  const runAction = async (kind: 'enter' | 'claim') => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    awaitingReturn.current = false;
    setReturnPending(false);
    setActionError(null);
    setClaimFailureChannels(null);
    try {
      // FLAG: An older GET must not overwrite the result of an explicit check.
      await queryClient.cancelQueries({ queryKey: participantKey });
      if (kind === 'enter') await enterMutation.mutateAsync();
      else await claimMutation.mutateAsync();
    } catch (error) {
      if (mounted.current) {
        if (kind === 'claim') {
          const ids =
            error instanceof ApiRequestError && error.code === 'GIVEAWAY_CLAIM_MISSING_CHANNELS'
              ? error.payload?.missingChannelIds
              : null;
          setClaimFailureChannels(
            Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
          );
        }
        setActionError(describeUserFacingError(error, 'Проверка недоступна. Повторите попытку.'));
        maxNotify('error');
        refreshQueries();
      }
    } finally {
      actionInFlight.current = false;
    }
  };
  const onReturn = useEffectEvent(() => {
    if (document.visibilityState === 'hidden' || !awaitingReturn.current || actionInFlight.current)
      return;
    awaitingReturn.current = false;
    setReturnPending(false);
    if (
      giveaway &&
      isGiveawayEntryOpen(
        giveaway,
        clockAnchor.current.server + performance.now() - clockAnchor.current.monotonic,
      )
    )
      void runAction('enter');
    else refresh();
  });
  useEffect(() => {
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, []);
  const close = () => closeMaxMiniApp(() => navigate('/', { replace: true }));
  useNativeBackHandler(
    () => {
      close();
      return true;
    },
    { enabled: true, priority: 500 },
  );
  const checking = enterMutation.isPending;
  const busy = checking || claimMutation.isPending || refreshing;
  const readError = participantQuery.error ?? giveawayQuery.error;
  const unavailable = Boolean(readError || actionError);
  const conditionsAtEntry = giveaway
    ? buildGiveawayConditions(giveaway, unavailable ? null : participant, checking)
    : [];
  const conditions =
    claimFailureChannels !== null
      ? conditionsAtEntry.map((condition) => ({
          ...condition,
          state: claimFailureChannels.includes(condition.id)
            ? ('missing' as const)
            : ('unknown' as const),
        }))
      : conditionsAtEntry;
  const checkedCount = conditions.filter((condition) => condition.state === 'verified').length;
  const verified =
    participant?.joined && participant.eligibilityState === 'VERIFIED' && !unavailable;
  const claimable = phase === 'COMPLETED' && canClaimGiveaway(participant, nowMs);
  const expired =
    participant?.winnerStatus === 'EXPIRED' ||
    (participant?.winnerStatus === 'SELECTED' &&
      Boolean(participant.claimDeadlineAt) &&
      Date.parse(participant.claimDeadlineAt!) <= nowMs);
  const loading = giveawayQuery.isPending || (giveaway && participantQuery.isPending);
  const fatalError = !giveawayId || (!giveaway && giveawayQuery.isError);
  const title = !giveaway
    ? 'Розыгрыш'
    : checking
      ? 'Проверяем условия'
      : unavailable
        ? 'Проверка недоступна'
        : phase === 'CANCELED'
          ? 'Розыгрыш отменён'
          : participant?.isWinner
            ? expired
              ? 'Срок подтверждения истёк'
              : participant.winnerStatus === 'DELIVERED'
                ? 'Приз выдан'
                : participant.winnerStatus === 'CLAIMED'
                  ? 'Выигрыш подтверждён'
                  : 'Вы победили!'
            : phase === 'COMPLETED'
              ? 'Итоги подведены'
              : phase === 'DRAWING'
                ? 'Подводим итоги'
                : phase === 'SCHEDULED'
                  ? 'Скоро начинаем'
                  : verified
                    ? 'Вы участвуете'
                    : participant?.eligibilityState === 'REJECTED'
                      ? 'Осталось подписаться'
                      : participant?.eligibilityState === 'PENDING'
                        ? 'Заявка ожидает проверки'
                        : 'Ваше участие';
  const target = claimable
    ? participant?.claimDeadlineAt
    : phase === 'SCHEDULED'
      ? giveaway?.startsAt
      : phase === 'ACTIVE'
        ? giveaway?.endsAt
        : null;
  const actionLabel = fatalError
    ? 'Повторить'
    : loading
      ? 'Загружаем статус'
      : busy
        ? refreshing
          ? 'Обновляем статус'
          : checking
            ? 'Проверяем условия'
            : 'Подтверждаем'
        : claimable && claimFailureChannels !== null && !readError
          ? 'Повторить подтверждение'
          : unavailable
            ? 'Повторить проверку'
            : claimable
              ? 'Подтвердить выигрыш'
              : entryOpen
                ? verified
                  ? 'Проверить ещё раз'
                  : participant?.joined || returnPending
                    ? 'Проверить подписки'
                    : 'Проверить и участвовать'
                : phase === 'DRAWING'
                  ? 'Обновить итоги'
                  : 'Обновить статус';
  const showClaimConditions = claimable && claimFailureChannels !== null;
  const showConditions =
    giveaway && ((phase !== 'COMPLETED' && phase !== 'CANCELED') || showClaimConditions);
  const statusTone =
    fatalError || unavailable
      ? 'error'
      : phase === 'CANCELED' || expired
        ? 'muted'
        : participant?.isWinner
          ? 'winner'
          : verified
            ? 'success'
            : 'default';
  const StateIcon =
    fatalError || unavailable
      ? 'WarningTriangle'
      : phase === 'CANCELED' || expired
        ? 'Xmark'
        : participant?.isWinner && !expired
          ? 'Trophy'
          : verified
            ? 'CheckCircle'
            : phase === 'DRAWING' || phase === 'SCHEDULED'
              ? 'Clock'
              : 'ShieldCheck';
  const publicWinners = giveaway?.winners.filter((winner) => winner.status !== 'REROLLED') ?? [];
  const postUrl =
    phase === 'COMPLETED'
      ? (giveaway?.resultsUrl ?? giveaway?.publicationUrl)
      : giveaway?.publicationUrl;
  const personalStatusFirst = Boolean(
    participant?.joined ||
    participant?.isWinner ||
    unavailable ||
    phase === 'CANCELED' ||
    phase === 'DRAWING' ||
    phase === 'COMPLETED',
  );
  const imageSource = giveaway ? giveawayImageSource(giveaway) : null;
  const prizes = [...(giveaway?.prizes ?? [])].sort(
    (left, right) => left.position - right.position,
  );
  const description = giveaway?.description.trim() ?? '';
  const promotion = giveaway ? (
    <section className="giveaway-page__promotion" aria-label="О розыгрыше">
      {imageSource && failedImage !== imageSource ? (
        <img
          className="giveaway-page__cover"
          src={imageSource}
          alt="Обложка розыгрыша"
          onError={() => setFailedImage(imageSource)}
        />
      ) : null}
      <div className="giveaway-page__promotion-copy">
        <span className="giveaway-page__eyebrow">
          {phase === 'COMPLETED'
            ? 'Розыгрыш завершён'
            : phase === 'ACTIVE'
              ? 'Участвуйте и выигрывайте'
              : phase === 'SCHEDULED'
                ? 'Скоро начнётся'
                : phase === 'DRAWING'
                  ? 'Подводим итоги'
                  : phase === 'CANCELED'
                    ? 'Розыгрыш отменён'
                    : 'О розыгрыше'}
        </span>
        <h2>{giveaway.title}</h2>
        {prizes.length ? (
          <div className="giveaway-page__prizes">
            <h3>
              <IconoirSprite variant="iconoir" icon="Trophy" aria-hidden="true" /> Призы
            </h3>
            <ol>
              {prizes.slice(0, 3).map((prize) => (
                <li key={prize.id}>
                  <span>{prize.position}</span>
                  <strong>{prize.displayTitle || prize.title}</strong>
                </li>
              ))}
            </ol>
            {prizes.length > 3 ? (
              <details>
                <summary>Все призовые места · {prizes.length}</summary>
                <ol start={4}>
                  {prizes.slice(3).map((prize) => (
                    <li key={prize.id}>
                      <span>{prize.position}</span>
                      <strong>{prize.displayTitle || prize.title}</strong>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </div>
        ) : null}
        {description.length > 220 ? (
          <details className="giveaway-page__description">
            <summary>
              {description.slice(0, 220).trimEnd()}… <span>Подробнее</span>
            </summary>
            <p>{description}</p>
          </details>
        ) : description ? (
          <p className="giveaway-page__description">{description}</p>
        ) : null}
      </div>
    </section>
  ) : null;
  return (
    <main
      className="giveaway-page"
      data-phase={phase}
      data-tone={statusTone}
      data-personal-status-first={personalStatusFirst}
    >
      <div className="giveaway-page__content">
        <header className="giveaway-page__header">
          <EntityAvatar
            className="giveaway-page__avatar"
            title={giveaway?.sourceTitle ?? ''}
            entityType={giveaway?.entityType ?? 'chat'}
            avatarUrl={giveaway?.sourceAvatarUrl}
          />
          <div className="giveaway-page__source">
            <span>Розыгрыш в MAX</span>
            <strong>{giveaway?.sourceTitle ?? 'Майор'}</strong>
          </div>
          <button
            className="giveaway-page__icon-button"
            type="button"
            onClick={close}
            aria-label="Закрыть розыгрыш"
            title="Закрыть"
          >
            <IconoirSprite variant="iconoir" icon="Xmark" />
          </button>
        </header>
        {!personalStatusFirst ? promotion : null}
        <section
          className="giveaway-page__participation-status"
          aria-busy={Boolean(loading || busy)}
        >
          <div
            className={`giveaway-page__verification ${loading || checking || phase === 'DRAWING' ? 'is-checking' : ''} ${statusTone === 'success' || statusTone === 'winner' ? 'is-verified' : ''}`}
            aria-hidden="true"
          >
            <IconoirSprite variant="iconoir" icon={StateIcon} />
          </div>
          <p className="giveaway-page__eyebrow">
            {phase === 'COMPLETED'
              ? 'Результат розыгрыша'
              : phase === 'DRAWING'
                ? 'Приём завершён'
                : 'Ваш статус'}
          </p>
          <h1 id="giveaway-overlay-title" aria-live="polite">
            {fatalError ? 'Не удалось открыть розыгрыш' : loading ? 'Загружаем розыгрыш' : title}
          </h1>
          {!loading && !unavailable && !participant?.joined && entryOpen ? (
            <p>Ваша заявка ещё не зарегистрирована.</p>
          ) : null}
          {verified && entryOpen ? (
            <p>Подписки подтверждены. Перед итогами проверим их снова.</p>
          ) : null}
          {!loading && !unavailable && phase === 'COMPLETED' && !participant?.isWinner ? (
            <p>
              {participant?.joined
                ? 'В этот раз ваша заявка не выиграла.'
                : 'Приём заявок завершён.'}
            </p>
          ) : null}
          {phase === 'DRAWING' ? <p>Приём заявок закрыт. Ожидаем результаты.</p> : null}
          {!unavailable && participant?.eligibilityState === 'PENDING' && entryOpen ? (
            <p>MAX пока не подтвердил подписки. Заявка сохранена, допуск ещё не подтверждён.</p>
          ) : null}
          {participant?.isWinner && !expired && participant.prizePosition ? (
            <p className="giveaway-page__personal-prize">
              {participant.prizePosition} место
              {participant.prizeDisplayTitle || participant.prizeTitle
                ? ` · ${participant.prizeDisplayTitle || participant.prizeTitle}`
                : ''}
            </p>
          ) : null}
          {phase === 'CANCELED' ? <p>Приём заявок остановлен. Победители не выбираются.</p> : null}
        </section>
        {giveaway ? (
          <section className="giveaway-page__metrics" aria-label="Сроки и заявки">
            {target ? (
              <div className="giveaway-page__timer">
                <span>
                  {claimable
                    ? 'На подтверждение'
                    : phase === 'SCHEDULED'
                      ? 'До начала'
                      : 'До закрытия приёма'}
                </span>
                <strong
                  role="timer"
                  aria-label={formatGiveawayCountdown(Date.parse(target), nowMs)}
                >
                  {formatGiveawayCountdown(Date.parse(target), nowMs)}
                </strong>
                <time dateTime={target}>{dateFormatter.format(new Date(target))}</time>
              </div>
            ) : null}
            <div className="giveaway-page__counts">
              <span>
                <IconoirSprite variant="iconoir" icon="User" aria-hidden="true" />
                <strong>{giveaway.entriesCount.toLocaleString('ru-RU')}</strong>
                <small>заявок</small>
              </span>
              <span>
                <IconoirSprite variant="iconoir" icon="Trophy" aria-hidden="true" />
                <strong>{giveaway.prizes.length}</strong>
                <small>мест</small>
              </span>
            </div>
          </section>
        ) : null}
        {personalStatusFirst ? promotion : null}
        {showConditions ? (
          <section className="giveaway-page__conditions" aria-label="Условия участия">
            <div className="giveaway-page__section-heading">
              <h2>Условия участия</h2>
              <span>
                {checkedCount} из {conditions.length}
              </span>
            </div>
            <div
              className="giveaway-page__progress"
              role="progressbar"
              aria-label="Подтверждённые условия"
              aria-valuemin={0}
              aria-valuemax={conditions.length}
              aria-valuenow={checkedCount}
            >
              {conditions.map((condition) => (
                <span key={condition.id} data-state={condition.state} />
              ))}
            </div>
            <ol className="giveaway-page__condition-list">
              {conditions.map((condition, index) => (
                <li key={condition.id} data-state={condition.state}>
                  <span className="giveaway-page__condition-mark" aria-hidden="true">
                    {condition.state === 'verified' ? (
                      <IconoirSprite variant="iconoir" icon="Check" />
                    ) : condition.state === 'checking' ? (
                      <IconoirSprite variant="iconoir" icon="RefreshDouble" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div>
                    <strong>{condition.title}</strong>
                    <small>
                      {conditionLabels[condition.state]}
                      {!condition.link && condition.state !== 'verified'
                        ? ' · Ссылка недоступна'
                        : ''}
                    </small>
                  </div>
                  {condition.link ? (
                    <button
                      type="button"
                      className="giveaway-page__icon-button"
                      aria-label={`Открыть ${condition.title}`}
                      title={`Открыть ${condition.title}`}
                      disabled={busy}
                      onClick={() => {
                        if (entryOpen) {
                          awaitingReturn.current = true;
                          setReturnPending(true);
                        }
                        openMaxBotLink(condition.link!);
                      }}
                    >
                      <IconoirSprite variant="iconoir" icon="NavArrowRight" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ol>
            {!showClaimConditions && participant?.checkedAt ? (
              <p className="giveaway-page__checked-at">
                Последняя проверка:{' '}
                <time dateTime={participant.checkedAt}>
                  {dateFormatter.format(new Date(participant.checkedAt))}
                </time>
              </p>
            ) : null}
          </section>
        ) : null}
        {participant?.entryId && verified && (entryOpen || phase === 'DRAWING') ? (
          <div className="giveaway-page__ticket">
            <IconoirSprite variant="iconoir" icon="CheckCircle" aria-hidden="true" />
            <span>
              Заявка принята<strong>№ {participant.entryId}</strong>
            </span>
          </div>
        ) : null}
        {phase === 'COMPLETED' ? (
          <section className="giveaway-page__results">
            <h2>Победители</h2>
            {publicWinners.length ? (
              <ol>
                {publicWinners.map((winner) => (
                  <li key={winner.prizePosition} data-status={winner.status}>
                    <span className="giveaway-page__winner-rank">{winner.prizePosition}</span>
                    <div>
                      <strong>{winner.displayName || 'Участник'}</strong>
                      <small>{winnerLabels[winner.status]}</small>
                    </div>
                    {winner.status === 'EXPIRED' ? (
                      <IconoirSprite variant="iconoir" icon="Clock" aria-hidden="true" />
                    ) : (
                      <IconoirSprite variant="iconoir" icon="Trophy" aria-hidden="true" />
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p>Нет участников, допущенных к выбору победителей.</p>
            )}
          </section>
        ) : null}
      </div>
      <footer className="giveaway-page__participation-actions">
        {actionError || readError || fatalError ? (
          <p className="giveaway-page__error" role="alert">
            {actionError ??
              describeUserFacingError(readError, 'Не удалось загрузить данные. Повторите попытку.')}
          </p>
        ) : null}
        <button
          type="button"
          className="giveaway-page__primary"
          disabled={Boolean(loading || busy || !giveawayId)}
          onClick={async () => {
            if (busy || actionInFlight.current) return;
            if (fatalError || (!entryOpen && !claimable) || readError) {
              actionInFlight.current = true;
              setActionError(null);
              setRefreshing(true);
              try {
                await refreshQueries();
              } finally {
                actionInFlight.current = false;
                if (mounted.current) setRefreshing(false);
              }
            } else void runAction(claimable ? 'claim' : 'enter');
          }}
        >
          {busy ? (
            <IconoirSprite
              variant="iconoir"
              icon="RefreshDouble"
              className="giveaway-page__spin"
              aria-hidden="true"
            />
          ) : claimable || verified ? (
            <IconoirSprite variant="iconoir" icon="CheckCircle" aria-hidden="true" />
          ) : (
            <IconoirSprite variant="iconoir" icon="ShieldCheck" aria-hidden="true" />
          )}
          <span>{actionLabel}</span>
        </button>
        {postUrl ? (
          <button
            type="button"
            className="giveaway-page__post-link"
            onClick={() => openMaxBotLink(postUrl)}
          >
            {phase === 'COMPLETED' && giveaway?.resultsUrl
              ? 'К опубликованным итогам'
              : 'К посту розыгрыша'}
            <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden="true" />
          </button>
        ) : null}
      </footer>
    </main>
  );
}
