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
  timeZone: 'Europe/Moscow',
});
const plural = new Intl.PluralRules('ru-RU');

function countWithNoun(count: number, one: string, few: string, many: string) {
  const form = plural.select(count);
  return `${count.toLocaleString('ru-RU')} ${form === 'one' ? one : form === 'few' ? few : many}`;
}

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
      : claimable && !readError && conditions.some((condition) => condition.state === 'missing')
        ? 'Подпишитесь, чтобы подтвердить выигрыш'
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
    loading ||
    checking ||
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
  const firstPrize = prizes[0];
  const firstPrizeTitle = firstPrize?.displayTitle || firstPrize?.title;
  const sharedPrize =
    firstPrize &&
    prizes.every(
      (prize, index) =>
        prize.position === index + 1 && (prize.displayTitle || prize.title) === firstPrizeTitle,
    );
  const coverVisible = imageSource && failedImage !== imageSource;
  const description = giveaway?.description.trim();
  const showStatus =
    personalStatusFirst || loading || checking || phase === 'SCHEDULED' || fatalError;
  const PrizeHeading = showStatus ? 'h2' : 'h1';
  const postLabel =
    phase === 'COMPLETED' && giveaway?.resultsUrl ? 'К опубликованным итогам' : 'К посту розыгрыша';
  const sortedConditions = [...conditions].sort(
    (a, b) => Number(b.state === 'missing') - Number(a.state === 'missing'),
  );
  const prizeList = (items: typeof prizes) => (
    <ol className="giveaway-page__prizes">
      {items.map((prize) => (
        <li key={prize.id}>
          <span>{prize.position}</span>
          <strong>{prize.displayTitle || prize.title}</strong>
        </li>
      ))}
    </ol>
  );
  const promotion = giveaway ? (
    <section className="giveaway-page__promotion" aria-label="О розыгрыше">
      {coverVisible ? (
        <img
          className="giveaway-page__cover"
          src={imageSource}
          alt="Обложка розыгрыша"
          onError={() => setFailedImage(imageSource)}
        />
      ) : null}
      <div className="giveaway-page__promotion-copy">
        {!coverVisible ? (
          <div className="giveaway-page__art" aria-hidden="true">
            <i />
            <i />
          </div>
        ) : null}
        {prizes.length ? (
          <p className="giveaway-page__places">
            {sharedPrize && prizes.length > 1
              ? `Места 1–${prizes.length}`
              : sharedPrize
                ? '1 место'
                : countWithNoun(prizes.length, 'призовое место', 'призовых места', 'призовых мест')}
          </p>
        ) : null}
        <PrizeHeading className="giveaway-page__title">{giveaway.title}</PrizeHeading>
        {sharedPrize ? (
          <p className="giveaway-page__featured-prize">{firstPrizeTitle}</p>
        ) : prizes.length ? (
          <div>
            {prizeList(prizes.slice(0, 3))}
            {prizes.length > 3 ? (
              <details>
                <summary>Все призовые места · {prizes.length}</summary>
                {prizeList(prizes.slice(3))}
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  ) : null;
  const descriptionDetails = description ? (
    <details className="giveaway-page__details">
      <summary>Описание розыгрыша</summary>
      <p>{description}</p>
    </details>
  ) : null;
  const prioritizeConditions = showConditions && (participant?.joined || unavailable) && !claimable;
  const metrics = giveaway ? (
    <section className="giveaway-page__metrics" aria-label="Сроки и заявки">
      {target ? (
        <div className="giveaway-page__timer">
          <span>
            {claimable ? 'Подтвердить до' : phase === 'SCHEDULED' ? 'Начало' : 'Приём заявок до'}
          </span>
          <time dateTime={target}>{dateFormatter.format(new Date(target))} МСК</time>
          <strong
            role="timer"
            aria-live="off"
            aria-label={`Осталось ${formatGiveawayCountdown(Date.parse(target), nowMs)}`}
          >
            Осталось {formatGiveawayCountdown(Date.parse(target), nowMs)}
          </strong>
        </div>
      ) : null}
      <div className="giveaway-page__counts">
        <small>Заявок</small>
        <strong>{giveaway.entriesCount.toLocaleString('ru-RU')}</strong>
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
            <strong>{giveaway?.sourceTitle ?? 'Майор'}</strong>
            <span>Розыгрыш</span>
          </div>
          <div className="giveaway-page__header-actions">
            {postUrl ? (
              <button
                type="button"
                className="giveaway-page__icon-button giveaway-page__post-link"
                aria-label={postLabel}
                title={postLabel}
                onClick={() => openMaxBotLink(postUrl)}
              >
                <IconoirSprite variant="iconoir" icon="OpenNewWindow" aria-hidden="true" />
              </button>
            ) : null}
            <button
              className="giveaway-page__icon-button"
              type="button"
              onClick={close}
              aria-label="Закрыть розыгрыш"
              title="Закрыть"
            >
              <IconoirSprite variant="iconoir" icon="Xmark" />
            </button>
          </div>
        </header>
        {!personalStatusFirst ? promotion : null}
        {showStatus ? (
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
            <h1 id="giveaway-overlay-title" aria-live="polite">
              {fatalError ? 'Не удалось открыть розыгрыш' : loading ? 'Загружаем розыгрыш' : title}
            </h1>
            {verified && entryOpen ? <p>Перед итогами проверим подписки ещё раз.</p> : null}
            {!loading && !unavailable && phase === 'COMPLETED' && !participant?.isWinner ? (
              <p>
                {participant?.joined
                  ? 'В этот раз ваша заявка не выиграла.'
                  : 'Приём заявок завершён.'}
              </p>
            ) : null}
            {!unavailable && participant?.eligibilityState === 'PENDING' && entryOpen ? (
              <p>Заявка сохранена. MAX ещё проверяет подписки.</p>
            ) : null}
            {participant?.isWinner && !expired && participant.prizePosition ? (
              <p className="giveaway-page__personal-prize">
                {participant.prizePosition} место
                {participant.prizeDisplayTitle || participant.prizeTitle
                  ? ` · ${participant.prizeDisplayTitle || participant.prizeTitle}`
                  : ''}
              </p>
            ) : null}
            {phase === 'CANCELED' ? <p>Победители не выбираются.</p> : null}
            {participant?.entryId && verified && (entryOpen || phase === 'DRAWING') ? (
              <div className="giveaway-page__ticket">
                <span>
                  Заявка № <strong>{participant.entryId}</strong>
                </span>
              </div>
            ) : null}
          </section>
        ) : null}
        {actionError || readError || fatalError ? (
          <p className="giveaway-page__error" role="alert">
            {actionError ??
              describeUserFacingError(readError, 'Не удалось загрузить данные. Повторите попытку.')}
          </p>
        ) : null}
        {!prioritizeConditions ? metrics : null}
        {showConditions ? (
          <section className="giveaway-page__conditions" aria-label="Условия участия">
            <div className="giveaway-page__section-heading">
              <h2>Подписки</h2>
              <span>
                {conditions.some(
                  (condition) => condition.state === 'verified' || condition.state === 'missing',
                )
                  ? `${checkedCount} из ${conditions.length}`
                  : giveaway.entityType === 'chat'
                    ? countWithNoun(conditions.length, 'условие', 'условия', 'условий')
                    : countWithNoun(conditions.length, 'канал', 'канала', 'каналов')}
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
              {sortedConditions.map((condition) => (
                <li key={condition.id} data-state={condition.state}>
                  <span className="giveaway-page__condition-mark" aria-hidden="true">
                    {condition.state === 'verified' ? (
                      <IconoirSprite variant="iconoir" icon="Check" />
                    ) : condition.state === 'checking' ? (
                      <IconoirSprite variant="iconoir" icon="RefreshDouble" />
                    ) : (
                      <IconoirSprite variant="iconoir" icon="Community" />
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
            {!unavailable && !showClaimConditions && participant?.checkedAt ? (
              <p className="giveaway-page__checked-at">
                Проверено{' '}
                <time dateTime={participant.checkedAt}>
                  {dateFormatter.format(new Date(participant.checkedAt))} МСК
                </time>
              </p>
            ) : null}
          </section>
        ) : null}
        {prioritizeConditions ? metrics : null}
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
        {personalStatusFirst && giveaway ? (
          <details className="giveaway-page__details">
            <summary>{giveaway.title}</summary>
            {promotion}
            {description ? <p>{description}</p> : null}
          </details>
        ) : (
          descriptionDetails
        )}
      </div>
      <footer className="giveaway-page__participation-actions">
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
      </footer>
    </main>
  );
}
