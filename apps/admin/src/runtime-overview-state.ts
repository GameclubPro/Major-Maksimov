import type { SafetyDeskOverviewResponse } from '@maxim/contracts/safety-desk';

export type OverviewAvailability = 'FRESH' | 'STALE' | 'UNAVAILABLE' | 'INVALID';
export type OverviewObservation<T> = {
  availability: OverviewAvailability;
  observedAt: string | null;
  value: T | null;
};
export type OverviewTone = 'neutral' | 'success' | 'warning' | 'danger';
export type OverviewStatus = { tone: OverviewTone; label: string };

export function overviewAvailability(
  source: { availability: OverviewAvailability; observedAt: string | null },
  now: number,
  maxAgeMs = 90_000,
): OverviewAvailability {
  if (source.availability !== 'FRESH') return source.availability;
  if (source.observedAt === null) return 'UNAVAILABLE';
  const time = Date.parse(source.observedAt);
  if (!Number.isFinite(time) || time > now + 10_000) return 'INVALID';
  return now - time > maxAgeMs ? 'STALE' : 'FRESH';
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

export function overviewBotStatus(
  bot: SafetyDeskOverviewResponse['bots'][number],
  now: number,
  actionSampleComplete = true,
): OverviewStatus {
  if (bot.state === 'disabled') return { tone: 'neutral', label: 'Отключён' };
  if (bot.state === 'dormant') return { tone: 'neutral', label: 'Не запущен' };
  if (bot.state === 'draining') return { tone: 'warning', label: 'Завершает работу' };
  const observations: Array<{ availability: OverviewAvailability; observedAt: string | null }> = [
    bot.subscription,
    bot.pendingReceipts,
    bot.unfinishedActions,
    bot.actionLatency,
    bot.outcomes,
  ];
  if (bot.publisher) observations.push(bot.publisher);
  if (observations.some((source) => overviewAvailability(source, now) !== 'FRESH'))
    return { tone: 'neutral', label: 'Данные неполные' };
  const delays = [
    bot.pendingReceipts.value?.oldestAgeMs ?? null,
    bot.actionLatency.value?.p95Ms ?? null,
  ];
  if (delays.some((delay) => overviewDelayTone(delay) === 'danger'))
    return { tone: 'danger', label: 'Долгое ожидание' };
  if (delays.some((delay) => overviewDelayTone(delay) === 'warning'))
    return { tone: 'warning', label: 'Есть задержка' };
  if (bot.publisher?.value?.dispatchEnabled === false)
    return { tone: 'warning', label: 'Отправка приостановлена' };
  if (bot.subscription.value?.configured === false)
    return { tone: 'warning', label: 'Не настроен' };
  if (bot.subscription.value?.subscribed === false)
    return { tone: 'warning', label: 'Нет подписки' };
  if (
    !actionSampleComplete ||
    !bot.pendingReceipts.value?.sampleComplete ||
    !bot.unfinishedActions.value?.sampleComplete
  )
    return { tone: 'neutral', label: 'Неполная выборка' };
  if (bot.actionLatency.value?.sampleCount !== overviewOutcomeCount(bot.outcomes.value))
    return { tone: 'neutral', label: 'Неполные данные задержки' };
  return { tone: 'success', label: 'Без превышений' };
}

export function overviewStatus(
  snapshot: SafetyDeskOverviewResponse,
  now: number,
  failedRefresh: boolean,
): OverviewStatus {
  const observations = [
    snapshot.queues,
    snapshot.receipts,
    snapshot.unfinishedActions,
    snapshot.actions,
    snapshot.workers,
  ];
  if (
    failedRefresh ||
    overviewAvailability(snapshot.collector, now, 45_000) !== 'FRESH' ||
    observations.some((source) => overviewAvailability(source, now) !== 'FRESH')
  )
    return { tone: 'neutral', label: 'Наблюдения неполные' };
  const bots = snapshot.bots.map((bot) =>
    overviewBotStatus(bot, now, snapshot.actions.value?.sampleComplete === true),
  );
  const delays = [
    snapshot.receipts.value?.oldestAgeMs ?? null,
    snapshot.actions.value?.latency.p95Ms ?? null,
  ];
  if (
    bots.some((bot) => bot.tone === 'danger') ||
    delays.some((delay) => overviewDelayTone(delay) === 'danger')
  )
    return { tone: 'danger', label: 'Требует внимания' };
  if (
    bots.some((bot) => bot.tone === 'warning') ||
    delays.some((delay) => overviewDelayTone(delay) === 'warning')
  )
    return { tone: 'warning', label: 'Есть задержки или паузы' };
  if (
    snapshot.actions.value?.latency.sampleCount !== snapshot.actions.value?.sampleCount ||
    bots.some((bot) => bot.label === 'Неполные данные задержки')
  )
    return { tone: 'neutral', label: 'Неполные данные задержки' };
  if (
    snapshot.bots.length === 0 ||
    !snapshot.workers.value?.expectedCount ||
    snapshot.workers.value?.freshCount !== snapshot.workers.value?.expectedCount ||
    bots.some((bot) => bot.label === 'Данные неполные' || bot.label === 'Неполная выборка') ||
    snapshot.receipts.value?.sampleComplete !== true ||
    snapshot.unfinishedActions.value?.sampleComplete !== true ||
    snapshot.actions.value?.sampleComplete !== true
  )
    return { tone: 'neutral', label: 'Наблюдения неполные' };
  return { tone: 'success', label: 'Без превышений в наблюдениях' };
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
