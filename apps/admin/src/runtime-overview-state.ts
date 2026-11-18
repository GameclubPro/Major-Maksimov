import type {
  SafetyDeskOverviewPending,
  SafetyDeskOverviewResponse,
} from '@maxim/contracts/safety-desk';

export type OverviewAvailability = 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'INVALID';
export type OverviewObservation<T> = {
  availability: OverviewAvailability;
  observedAt: string | null;
  value: T | null;
};
export type OverviewTone = 'neutral' | 'success' | 'warning' | 'danger';
type OverviewStatus = { tone: OverviewTone; label: string };
type OverviewBot = SafetyDeskOverviewResponse['bots'][number];

export const overviewFreshness = {
  cheap: 25_000,
  work: 65_000,
  publisher: 45_000,
  subscription: 150_000,
  history: 120_000,
};

const incompleteLatency = 'Неполные данные задержки';
const unfinishedReview = 'Проверьте незавершённые действия';
const reviewUnfinishedAfterMs = 30_000;

export function overviewAvailability(
  source: { availability: OverviewAvailability; observedAt: string | null },
  now: number,
  maxAgeMs = overviewFreshness.work,
): OverviewAvailability {
  if (source.availability !== 'FRESH') return source.availability;
  if (source.observedAt === null) return 'UNAVAILABLE';
  const time = Date.parse(source.observedAt);
  if (!Number.isFinite(time) || time > now + 10_000) return 'INVALID';
  return now - time >= maxAgeMs ? 'STALE' : 'FRESH';
}

export function overviewDelayTone(value: number | null): OverviewTone {
  return value === null
    ? 'neutral'
    : value > 30_000
      ? 'danger'
      : value > 10_000
        ? 'warning'
        : 'success';
}

export function overviewOutcomeCount(outcomes: Array<{ count: number }> | null) {
  return outcomes?.reduce((sum, outcome) => sum + outcome.count, 0) ?? null;
}

export function overviewBotSignal(bot: OverviewBot) {
  return bot.kind === 'publisher'
    ? { label: 'Сигнал Публика', source: bot.publisher, maxAgeMs: overviewFreshness.publisher }
    : {
        label: 'Подписка модератора',
        source: bot.subscription,
        maxAgeMs: overviewFreshness.subscription,
      };
}

function freshValue<T>(row: OverviewObservation<T> | null, now: number, maxAgeMs?: number) {
  return row && overviewAvailability(row, now, maxAgeMs) === 'FRESH' ? row.value : null;
}

function sampleKnown(
  value: SafetyDeskOverviewPending | null,
  basis: SafetyDeskOverviewPending['ageBasis'],
) {
  return (
    value?.sampleComplete === true &&
    value.ageBasis === basis &&
    (value.countLowerBound === 0 || value.oldestAgeMs !== null)
  );
}

function receiptAge(value: SafetyDeskOverviewPending | null) {
  return value?.ageBasis === 'receipt_created' && value.countLowerBound > 0
    ? value.oldestAgeMs
    : null;
}

function oldUnfinishedWork(value: SafetyDeskOverviewPending | null) {
  return (
    value?.ageBasis === 'state_updated_sample' &&
    value.countLowerBound > 0 &&
    (value.oldestAgeMs ?? 0) > reviewUnfinishedAfterMs
  );
}

type BotStatus = OverviewStatus & {
  attention: boolean;
  reason?: 'unfinished' | 'latency-gap';
};

function attention(tone: OverviewTone, label: string, reason?: BotStatus['reason']): BotStatus {
  return { tone, label, attention: true, reason };
}

export function overviewBotStatus(
  bot: OverviewBot,
  now: number,
  actionSampleComplete = true,
): BotStatus {
  if (bot.state === 'disabled') return { tone: 'neutral', label: 'Отключён', attention: false };
  if (bot.state === 'dormant') return { tone: 'neutral', label: 'Не запущен', attention: false };

  const receipts = freshValue(bot.pendingReceipts, now);
  const unfinished = freshValue(bot.unfinishedActions, now);
  const latency = freshValue(bot.actionLatency, now);
  const outcomes = freshValue(bot.outcomes, now);
  const delays = [receiptAge(receipts), latency?.p95Ms ?? null].map(overviewDelayTone);
  if (delays.includes('danger')) return attention('danger', 'Долгое ожидание');
  if (delays.includes('warning')) return attention('warning', 'Есть задержка');
  if (bot.state === 'draining') return attention('warning', 'Завершает работу');

  const receiptsKnown = sampleKnown(receipts, 'receipt_created');
  const unfinishedKnown = sampleKnown(unfinished, 'state_updated_sample');
  const { maxAgeMs } = overviewBotSignal(bot);
  let intentionalPause = false;
  if (bot.kind === 'publisher') {
    const publisher = freshValue(bot.publisher, now, maxAgeMs);
    if (!publisher) return attention('neutral', 'Данные неполные');
    if (!publisher.dispatchEnabled) {
      intentionalPause =
        (publisher.blocker === 'global_paused' || publisher.blocker === 'runtime_disabled') &&
        receiptsKnown &&
        receipts?.countLowerBound === 0 &&
        unfinishedKnown &&
        unfinished?.countLowerBound === 0;
      if (!intentionalPause) return attention('warning', 'Проверьте паузу отправки');
    } else if (publisher.blocker !== null) {
      return attention('warning', 'Проверьте отправку');
    }
  } else {
    const subscription = freshValue(bot.subscription, now, maxAgeMs);
    if (!subscription) return attention('neutral', 'Данные неполные');
    if (!subscription.configured) return attention('warning', 'Не настроен');
    if (!subscription.subscribed) return attention('warning', 'Нет подписки');
  }
  if (oldUnfinishedWork(unfinished)) {
    return attention('neutral', unfinishedReview, 'unfinished');
  }
  if (!receipts || !unfinished || !latency || !outcomes) {
    return attention('neutral', 'Данные неполные');
  }
  if (!actionSampleComplete || !receiptsKnown || !unfinishedKnown) {
    return attention('neutral', 'Неполная выборка');
  }
  if (latency.sampleCount !== overviewOutcomeCount(outcomes)) {
    return attention('neutral', incompleteLatency, 'latency-gap');
  }
  return intentionalPause
    ? { tone: 'neutral', label: 'Плановая пауза отправки', attention: false }
    : { tone: 'success', label: 'Без превышений', attention: false };
}

function fleetStatus(
  snapshot: SafetyDeskOverviewResponse,
  now: number,
  failedRefresh: boolean,
  bots: BotStatus[],
): OverviewStatus {
  if (
    failedRefresh ||
    overviewAvailability(snapshot.collector, now, overviewFreshness.cheap) !== 'FRESH'
  )
    return { tone: 'neutral', label: 'Наблюдения неполные' };

  const receipts = freshValue(snapshot.receipts, now);
  const unfinished = freshValue(snapshot.unfinishedActions, now);
  const actions = freshValue(snapshot.actions, now);
  const delays = [receiptAge(receipts), actions?.latency.p95Ms ?? null].map(overviewDelayTone);
  if (delays.includes('danger') || bots.some((bot) => bot.tone === 'danger'))
    return { tone: 'danger', label: 'Требует внимания' };
  if (delays.includes('warning') || bots.some((bot) => bot.tone === 'warning'))
    return { tone: 'warning', label: 'Есть задержки или паузы' };

  if (oldUnfinishedWork(unfinished) || bots.some((bot) => bot.reason === 'unfinished'))
    return { tone: 'neutral', label: unfinishedReview };
  if (
    actions?.latency.sampleCount !== actions?.sampleCount ||
    bots.some((bot) => bot.reason === 'latency-gap')
  )
    return { tone: 'neutral', label: incompleteLatency };
  const workers = freshValue(snapshot.workers, now, overviewFreshness.cheap);
  if (
    !workers?.expectedCount ||
    workers.freshCount !== workers.expectedCount ||
    !freshValue(snapshot.queues, now, overviewFreshness.cheap) ||
    bots.length === 0 ||
    bots.some((bot) => bot.attention) ||
    !sampleKnown(receipts, 'receipt_created') ||
    !sampleKnown(unfinished, 'state_updated_sample') ||
    !actions?.sampleComplete
  )
    return { tone: 'neutral', label: 'Наблюдения неполные' };
  return { tone: 'success', label: 'Без превышений в наблюдениях' };
}

export function overviewStatus(
  snapshot: SafetyDeskOverviewResponse,
  now: number,
  failedRefresh: boolean,
) {
  const actionSampleComplete = freshValue(snapshot.actions, now)?.sampleComplete === true;
  const cards = snapshot.bots.map((bot) => ({
    bot,
    status: overviewBotStatus(bot, now, actionSampleComplete),
  }));
  return {
    ...fleetStatus(
      snapshot,
      now,
      failedRefresh,
      cards.map((card) => card.status),
    ),
    cards,
  };
}

export function staleOverview(snapshot: SafetyDeskOverviewResponse): SafetyDeskOverviewResponse {
  const stale = <T extends { availability: OverviewAvailability }>(source: T): T =>
    source.availability === 'FRESH' ? { ...source, availability: 'STALE' } : source;
  return {
    ...snapshot,
    collector: stale(snapshot.collector),
    queues: stale(snapshot.queues),
    receipts: stale(snapshot.receipts),
    unfinishedActions: stale(snapshot.unfinishedActions),
    actions: stale(snapshot.actions),
    workers: stale(snapshot.workers),
    history: stale(snapshot.history),
    bots: snapshot.bots.map((bot) => ({
      ...bot,
      subscription: stale(bot.subscription),
      publisher: bot.publisher ? stale(bot.publisher) : null,
      pendingReceipts: stale(bot.pendingReceipts),
      unfinishedActions: stale(bot.unfinishedActions),
      actionLatency: stale(bot.actionLatency),
      lastTerminalAt: stale(bot.lastTerminalAt),
      outcomes: stale(bot.outcomes),
    })),
  };
}

export function overviewNumber(value: number | null | undefined) {
  return value === null || value === undefined
    ? 'Нет данных'
    : new Intl.NumberFormat('ru-RU').format(value);
}

export function overviewDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return 'Нет данных';
  if (value < 1_000) return `${Math.round(value)} мс`;
  if (value < 60_000)
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 1_000)} с`;
  if (value < 3_600_000)
    return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 60_000)} мин`;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value / 3_600_000)} ч`;
}
