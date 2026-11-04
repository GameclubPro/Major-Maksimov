import { randomUUID } from 'node:crypto';
import { observerFailure } from './local-observer-files.mjs';

export const OBSERVER_TIMING = Object.freeze({
  pollMs: 15000,
  pollGapMs: 45000,
  criticalMs: 120000,
  lostMs: 120000,
  warningMs: 10000,
  criticalLatencyMs: 30000,
});
export const OBSERVER_REASONS = Object.freeze([
  'RECEIPT_DELAY',
  'ACTION_LATENCY',
  'BOT_DISCONNECTED',
  'OBSERVATION_LOST',
  'STALE_OBSERVATION',
  'PARTIAL_OBSERVATION',
  'WORKER_OBSERVATION_MISSING',
  'CRITICAL_RUNTIME',
]);
const iso = (now) => new Date(now).toISOString();
const at = (value) => (typeof value === 'string' ? Date.parse(value) : NaN);
const elapsed = (now, value) => now - at(value);
const freshAt = (value, now, ttl) =>
  Number.isFinite(at(value)) && elapsed(now, value) >= -5000 && elapsed(now, value) < ttl;
const fresh = (row, now, ttl) =>
  row?.availability === 'FRESH' && row.value != null && freshAt(row.observedAt, now, ttl);
const sorted = (values) => [...new Set(values)].sort();

/** Consumes the public SafetyDeskOverviewResponse after its contract has parsed it. */
export function inspectObserverSnapshot(snapshot, now) {
  const sourceAt = at(snapshot.collector.observedAt);
  if (
    snapshot.collector.availability !== 'FRESH' ||
    !Number.isFinite(sourceAt) ||
    now - sourceAt < -5000 ||
    now - sourceAt >= 25000
  )
    return { complete: false, critical: false, sourceAt: null, reasons: ['STALE_OBSERVATION'] };
  let complete = true;
  const reasons = [];
  const criticalTimes = [];
  const affected = new Set();
  const incomplete = (botId) => {
    complete = false;
    if (botId) affected.add(botId);
  };
  const add = (reason, row, botId) => {
    reasons.push(reason);
    criticalTimes.push(at(row.observedAt));
    if (botId) affected.add(botId);
  };
  const checkPending = (row, botId) => {
    if (!fresh(row, now, 65000)) {
      incomplete(botId);
      return false;
    }
    const known =
      row.value.sampleComplete &&
      (row.value.countLowerBound === 0 ||
        (row.value.oldestAgeMs !== null && row.value.ageBasis === 'receipt_created'));
    if (!known) incomplete(botId);
    if (
      row.value.countLowerBound > 0 &&
      row.value.oldestAgeMs > OBSERVER_TIMING.criticalLatencyMs &&
      row.value.ageBasis === 'receipt_created'
    )
      add('RECEIPT_DELAY', row, botId);
    return known && row.value.countLowerBound === 0;
  };
  const checkLatency = (row, botId, nested = false) => {
    if (!fresh(row, now, 65000)) {
      incomplete(botId);
      return;
    }
    const value = nested ? row.value.latency : row.value;
    if (nested && !row.value.sampleComplete) incomplete(botId);
    if (value.sampleCount > 0 && value.p95Ms > OBSERVER_TIMING.criticalLatencyMs)
      add('ACTION_LATENCY', row, botId);
  };
  checkPending(snapshot.receipts);
  checkLatency(snapshot.actions, undefined, true);
  if (!fresh(snapshot.queues, now, 25000)) complete = false;
  if (
    !fresh(snapshot.workers, now, 25000) ||
    snapshot.workers.value.expectedCount < 1 ||
    snapshot.workers.value.freshCount !== snapshot.workers.value.expectedCount ||
    snapshot.workers.value.rows.length !== snapshot.workers.value.expectedCount ||
    new Set(snapshot.workers.value.rows.map((row) => row.service)).size !==
      snapshot.workers.value.expectedCount ||
    snapshot.workers.value.rows.some((row) => !freshAt(row.observedAt, now, 90000))
  ) {
    complete = false;
    reasons.push('WORKER_OBSERVATION_MISSING');
  }
  // FLAG: A state-update sample is not action execution latency. An old unfinished head
  // prevents a healthy/recovery claim, even when completed-action p95 looks good.
  const checkUnfinished = (row, botId) => {
    if (
      !fresh(row, now, 65000) ||
      !row.value.sampleComplete ||
      (row.value.countLowerBound > 0 &&
        (row.value.oldestAgeMs === null ||
          row.value.ageBasis !== 'state_updated_sample' ||
          row.value.oldestAgeMs > OBSERVER_TIMING.criticalLatencyMs))
    ) {
      incomplete(botId);
      return false;
    }
    return row.value.countLowerBound === 0;
  };
  checkUnfinished(snapshot.unfinishedActions);
  const activeBots = snapshot.bots.filter(
    (bot) =>
      ['active', 'draining'].includes(bot.state) ||
      (bot.kind === 'publisher' && bot.state === 'configured'),
  );
  for (const bot of activeBots) {
    const receiptsIdle = checkPending(bot.pendingReceipts, bot.botId);
    checkLatency(bot.actionLatency, bot.botId);
    const unfinishedIdle = checkUnfinished(bot.unfinishedActions, bot.botId);
    if (bot.kind === 'publisher') {
      if (!fresh(bot.publisher, now, 45000)) {
        incomplete(bot.botId);
        reasons.push('WORKER_OBSERVATION_MISSING');
      } else if (!bot.publisher.value.dispatchEnabled) {
        // FLAG: A configured pause proves no failure only with fresh, complete idle evidence.
        const intentionallyIdle =
          ['runtime_disabled', 'global_paused'].includes(bot.publisher.value.blocker) &&
          receiptsIdle &&
          unfinishedIdle;
        if (!intentionallyIdle) add('CRITICAL_RUNTIME', bot.publisher, bot.botId);
      } else if (bot.publisher.value.blocker !== null) incomplete(bot.botId);
    }
    // FLAG: Only moderator reconciliation writes the shared subscription snapshot.
    // Publisher health comes from its own heartbeat; a missing moderator row proves nothing about it.
    if (bot.kind === 'moderator') {
      if (!fresh(bot.subscription, now, 150000)) incomplete(bot.botId);
      else if (!bot.subscription.value.configured || !bot.subscription.value.subscribed)
        add('BOT_DISCONNECTED', bot.subscription, bot.botId);
    }
  }
  if (!complete) reasons.push('PARTIAL_OBSERVATION');
  const receiptsKnown =
    fresh(snapshot.receipts, now, 65000) &&
    snapshot.receipts.value.sampleComplete &&
    (snapshot.receipts.value.countLowerBound === 0 ||
      (snapshot.receipts.value.oldestAgeMs !== null &&
        snapshot.receipts.value.ageBasis === 'receipt_created'));
  return {
    complete,
    critical: criticalTimes.length > 0,
    sourceAt,
    criticalAt: criticalTimes.length ? Math.min(...criticalTimes) : null,
    reasons: sorted(reasons),
    ...(receiptsKnown
      ? {
          counts: {
            affectedBots: affected.size,
            totalBots: activeBots.length,
            pending: snapshot.receipts.value.countLowerBound,
            oldestPendingAgeMs:
              snapshot.receipts.value.countLowerBound === 0
                ? 0
                : snapshot.receipts.value.oldestAgeMs,
          },
        }
      : {}),
  };
}

export function initialObserverModel() {
  return {
    schemaVersion: 1,
    lastPollAt: null,
    lastSuccessfulSampleAt: null,
    lastSourceObservedAt: null,
    degradedSince: null,
    candidate: null,
    incident: null,
    events: [],
  };
}

function event(model, kind, incident, evidence, now, uuid) {
  // FLAG: Capacity exhaustion retains all uncertain/delivery evidence and stops work.
  if (model.events.length >= 256) observerFailure('OBSERVER_EVENT_CAPACITY');
  const row = {
    event: {
      id: uuid(),
      kind,
      startedAt: incident.startedAt,
      observedAt: iso(now),
      reasonCodes: sorted(evidence.reasons),
      ...(evidence.counts ? { counts: evidence.counts } : {}),
    },
    state: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    outcomeCode: null,
  };
  model.events.push(row);
  return row.event.id;
}

export function observeRuntime(model, snapshot, now, { uuid = randomUUID } = {}) {
  if (!Number.isFinite(now)) observerFailure('OBSERVER_CLOCK_INVALID');
  const next = structuredClone(model);
  const gap = next.lastPollAt !== null && elapsed(now, next.lastPollAt) > OBSERVER_TIMING.pollGapMs;
  if (next.lastPollAt !== null && elapsed(now, next.lastPollAt) < 0)
    observerFailure('OBSERVER_CLOCK_MOVED_BACKWARDS');
  next.lastPollAt = iso(now);
  let evidence = snapshot
    ? inspectObserverSnapshot(snapshot, now)
    : { complete: false, critical: false, sourceAt: null, reasons: ['OBSERVATION_LOST'] };
  if (
    evidence.sourceAt !== null &&
    next.lastSourceObservedAt !== null &&
    evidence.sourceAt < at(next.lastSourceObservedAt)
  )
    evidence = { complete: false, critical: false, sourceAt: null, reasons: ['STALE_OBSERVATION'] };
  if (evidence.sourceAt !== null && evidence.sourceAt > at(next.lastSourceObservedAt ?? '')) {
    next.lastSuccessfulSampleAt = iso(now);
    next.lastSourceObservedAt = iso(evidence.sourceAt);
  } else if (evidence.sourceAt !== null && next.lastSourceObservedAt === null) {
    next.lastSuccessfulSampleAt = iso(now);
    next.lastSourceObservedAt = iso(evidence.sourceAt);
  }
  if (gap || !evidence.complete || !evidence.critical || evidence.sourceAt === null)
    next.candidate = null;
  if (evidence.complete && evidence.critical) {
    if (next.candidate === null || evidence.criticalAt < at(next.candidate.lastEvidenceAt))
      next.candidate = {
        since: iso(now),
        firstEvidenceAt: iso(evidence.criticalAt),
        lastEvidenceAt: iso(evidence.criticalAt),
      };
    else if (evidence.criticalAt > at(next.candidate.lastEvidenceAt))
      next.candidate.lastEvidenceAt = iso(evidence.criticalAt);
  }
  if (evidence.complete) next.degradedSince = null;
  else if (next.degradedSince === null || gap) next.degradedSince = iso(now);
  const sustained =
    next.candidate !== null &&
    elapsed(now, next.candidate.since) >= OBSERVER_TIMING.criticalMs &&
    at(next.candidate.lastEvidenceAt) - at(next.candidate.firstEvidenceAt) >=
      OBSERVER_TIMING.criticalMs;
  const lost =
    next.degradedSince !== null && elapsed(now, next.degradedSince) >= OBSERVER_TIMING.lostMs;
  if (next.incident === null && (sustained || lost)) {
    const incident = {
      id: uuid(),
      startedAt: sustained ? next.candidate.since : next.degradedSince,
      problemEventId: null,
    };
    incident.problemEventId = event(next, 'PROBLEM', incident, evidence, now, uuid);
    next.incident = incident;
  } else if (next.incident !== null && evidence.complete && !evidence.critical) {
    const problem = next.events.find((row) => row.event.id === next.incident.problemEventId);
    if (!problem) observerFailure('OBSERVER_INCIDENT_EVIDENCE_MISSING');
    if (['SENT', 'UNCERTAIN'].includes(problem.state))
      event(
        next,
        'RECOVERY',
        next.incident,
        { ...evidence, reasons: problem.event.reasonCodes },
        now,
        uuid,
      );
    else if (['PENDING', 'REJECTED'].includes(problem.state)) problem.state = 'SUPPRESSED';
    else observerFailure('OBSERVER_DELIVERY_STILL_ACTIVE');
    next.incident = null;
  }
  return next;
}

export function recoverObserverModel(model) {
  const next = structuredClone(model);
  next.candidate = null;
  next.degradedSince = null;
  for (const row of next.events) {
    // FLAG: A crash after fsync(SENDING) can follow SMTP acceptance. Never replay it.
    if (row.state === 'SENDING') {
      row.state = 'UNCERTAIN';
      row.outcomeCode = 'OBSERVER_RESTART_DURING_SEND';
    }
  }
  return next;
}
