#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { safetyDeskCommercialAiPoolResponseSchema } from '../packages/contracts/src/safety-desk-commercial-ai-pool.ts';
import {
  overviewFixture,
  overviewTimingGapFixture,
} from '../apps/admin/test/runtime-overview-fixture.ts';
import { smokeRuntimeOverview } from '../apps/admin/test/runtime-overview.browser.mjs';

const overviewOnly = process.argv.slice(2).includes('--runtime-overview');
if (process.argv.slice(2).some((argument) => argument !== '--runtime-overview'))
  throw new Error('Unknown Safety Desk smoke argument.');

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const generatedAt = '2026-07-19T00:00:00.000Z';
const queue = {
  generatedAt,
  items: [],
  summary: { review: 0, approved: 0, rejected: 0, blocked: 0, servicePosts: 0 },
  audit: [],
};
const supportQueue = { generatedAt, items: [], summary: { new: 0, closed: 0 } };
const statusCounts = Object.fromEntries(
  [
    'OBSERVED',
    'PENDING',
    'IN_PROGRESS',
    'RETRYABLE',
    'WAITING_CAPABILITY',
    'AMBIGUOUS',
    'SUCCEEDED',
    'ALREADY_ABSENT',
    'EXPIRED',
    'FAILED_TERMINAL',
  ].map((status) => [status, 0]),
);
const deleteItems = ['a', 'b'].map((key, index) => ({
  id: `smoke-delete-${key}`,
  chatId: `smoke-chat-${key}`,
  chatTitle: `Тест удаления ${key.toUpperCase()}`,
  messageId: `smoke-message-${key}`,
  subjectUserId: null,
  entityType: 'CHAT',
  originBotId: null,
  routingPolicy: 'origin_only',
  effectiveRoutingPolicy: 'origin_only',
  crossBotEnabled: false,
  routingState: 'NO_ELIGIBLE_BOT',
  rollout: 'execute',
  retentionOwned: false,
  retryAllowed: index === 1,
  status: index === 0 ? 'AMBIGUOUS' : 'FAILED_TERMINAL',
  ageMs: 1_000,
  attemptCount: 1,
  executeAt: generatedAt,
  nextAttemptAt: generatedAt,
  retryUntilAt: '2026-07-19T00:05:00.000Z',
  firstAttemptAt: generatedAt,
  lastAttemptAt: generatedAt,
  completedAt: null,
  leaseExpiresAt: null,
  deleteDispatchStartedAt: index === 0 ? generatedAt : null,
  deleteDispatchStartedBotId: null,
  remoteDeleteSucceededAt: null,
  remoteDeleteSucceededBotId: null,
  createdAt: generatedAt,
  updatedAt: generatedAt,
  lastBotId: null,
  succeededBotId: null,
  lastStatusCode: null,
  lastErrorCode: null,
  lastError: null,
  capability: { confirmed: false, activeMembershipCount: 0, confirmedBotIds: [], memberships: [] },
  reasons: [],
}));
const deleteRuntime = {
  generatedAt,
  rolloutMode: 'shadow',
  summary: {
    total: 2,
    open: 1,
    failed: 1,
    statusCounts: { ...statusCounts, AMBIGUOUS: 1, FAILED_TERMINAL: 1 },
    due: { count: 0, oldestAt: null },
    staleLeases: { count: 0, oldestAt: null },
    ambiguousSends: { count: 0, oldestAt: null },
    giveawayWinnerNotificationDeadEnds: {
      count: 0,
      ambiguous: 0,
      failedTerminal: 0,
      oldestAt: null,
    },
    oldestOpen: { createdAt: null, ageMs: null },
  },
  items: deleteItems,
  ambiguousSends: [],
  giveawayWinnerNotificationDeadEnds: [],
};

const port = await getAvailablePort();
const baseUrl = `http://127.0.0.1:${port}/`;
const server = spawn(
  process.execPath,
  [
    path.join(rootDir, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  { cwd: path.join(rootDir, 'apps/admin'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

let browser;
try {
  await waitForUrl(baseUrl, server);
  browser = await chromium.launch({ headless: true });
  for (const profile of [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'narrow', viewport: { width: 390, height: 844 } },
  ]) {
    await smokeProfile(browser, profile);
  }
  process.stdout.write('Safety Desk browser smoke passed: desktop, narrow\n');
} finally {
  await browser?.close();
  await stopServer(server);
}

async function smokeProfile(activeBrowser, profile) {
  const context = await activeBrowser.newContext({ viewport: profile.viewport, locale: 'ru-RU' });
  const page = await context.newPage();
  await page.clock.install();
  const errors = [];
  let startupDenied = true;
  let startupRequests = 0;
  const startupPaths = new Set([
    '/api/v1/safety-desk/queue',
    '/api/v1/support-requests/queue',
    '/api/v1/safety-desk/runtime/deletes',
  ]);
  let overviewRequests = 0;
  let overviewMode = 'fresh';
  const overviewControls = {
    readCount: () => overviewRequests,
    setMode: (mode) => {
      overviewMode = mode;
    },
  };
  let cohortRequests = 0;
  let cohortUnavailable = false;
  let publicationRequests = 0;
  let evidenceRequests = 0;
  let evidenceMalformed = false;
  let deleteCohortRequests = 0;
  let deliveryCohortRequests = 0;
  let deliveryEvidenceRequests = 0;
  let deliveryEvidenceMalformed = false;
  let deliveryEvidenceDenied = false;
  let commercialAiRequests = 0;
  let commercialAiPoolRequests = 0;
  let commercialAiMalformed = false;
  let commercialAiGate;
  let retentionRequests = 0;
  let commercialAi = {
    schemaVersion: 1,
    generatedAt: '2026-10-28T10:00:00.000Z',
    observedAt: '2026-10-28T09:59:50.000Z',
    mode: 'DELETE_ONLY',
    availability: 'FRESH',
    heartbeatAt: '2026-10-28T09:59:50.000Z',
    lastRecordedResultAt: '2026-10-28T09:58:00.000Z',
    observationStartedAt: '2026-10-28T07:00:00.000Z',
    observationProcessId: '1348126b-9210-4a0e-88cb-e8c1afbd959e',
    active: 1,
    admission: 'READY',
    admissionObservedAt: '2026-10-28T09:59:40.000Z',
    outcomeBasis: 'PROCESS_CUMULATIVE',
    outcomes: {
      kept: 12,
      unsure: 3,
      deleteRegistered: 5,
      deleteNotAdmitted: 2,
      registrationUnknown: 1,
      capacitySkipped: 4,
      unavailableSkipped: 6,
      sourceExpired: 7,
      pressureSkipped: 8,
      dependencyUnavailable: 9,
      other: 0,
    },
    pendingDiscardBasis: 'REDIS_NAMESPACE_CUMULATIVE',
    pendingDiscards: { expired: 15, foreignWorker: 16, invalidPending: 17 },
    trafficCoverage: 'NOT_ESTABLISHED',
    confirmedDeletes: null,
  };
  const commercialAiPool = safetyDeskCommercialAiPoolResponseSchema.parse({
    schemaVersion: 1,
    generatedAt: commercialAi.generatedAt,
    observedAt: commercialAi.observedAt,
    workersEnabled: true,
    routingEnabled: true,
    policy: 'confirm-positive',
    availability: 'FRESH',
    nodes: ['server-9b', 'pc-a-4b', 'pc-b-9b'].map((nodeId, index) => ({
      nodeId,
      state: ['SLOT_OCCUPIED', 'READY', 'OFFLINE'][index],
      validUntil: index === 2 ? null : commercialAi.generatedAt,
    })),
    metrics: {
      availability: 'FRESH',
      observedAt: commercialAi.observedAt,
      observationStartedAt: commercialAi.observationStartedAt,
      observationProcessId: commercialAi.observationProcessId,
      basis: 'PROCESS_MODEL_ATTEMPTS',
      diagnostics: {
        schemaVersion: 1,
        nodes: ['server-9b', 'pc-a-4b', 'pc-b-9b'].map((nodeId) => ({
          nodeId,
          completedAttempts: 0,
          failedAttempts: 0,
          lastCompletedAt: null,
          lastFailureAt: null,
          ewmaDurationMs: null,
        })),
        consultations: { completed: 0, noCapacity: 5, budgetExhausted: 1 },
      },
    },
    trafficCoverage: 'NOT_ESTABLISHED',
    confirmedDeletes: null,
  });
  let releaseDelayedDelivery;
  const delayedDelivery = new Promise((resolve) => {
    releaseDelayedDelivery = resolve;
  });
  const countPartition = (keys, selected) =>
    Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0]));
  const outcomeWindow = {
    schemaVersion: 1,
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: '2026-10-16T18:00:00.000Z',
    windowEndedAt: '2026-10-16T18:15:00.000Z',
    observedAt: '2026-10-16T18:15:30.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 1,
  };
  const deleteCohort = {
    ...outcomeWindow,
    basis: 'delete_intent_created_at',
    includesObservedOnly: true,
    rows: Object.keys(statusCounts).map((status) => ({
      status,
      countLowerBound: status === 'AMBIGUOUS' ? 1 : 0,
      truncated: false,
      outcomeCounts: countPartition(
        [
          'confirmed',
          'acknowledged',
          'already_absent',
          'unknown',
          'stopped',
          'observed',
          'pending',
        ],
        status === 'AMBIGUOUS' ? 'unknown' : null,
      ),
      deadlineCounts: countPartition(
        ['notElapsed', 'elapsed', 'invalid'],
        status === 'AMBIGUOUS' ? 'elapsed' : null,
      ),
      waitCounts: countPartition(
        [
          'notDue',
          'retryDue',
          'leaseActive',
          'leaseStale',
          'capability',
          'receiptSettlement',
          'effectUnknown',
        ],
        status === 'AMBIGUOUS' ? 'effectUnknown' : null,
      ),
      waitCountsOverlap: true,
      finalizedLatency: { sampleCount: 0, invalidClockCount: 0, p95Ms: null, p99Ms: null },
    })),
  };
  const deliveryStatuses = ['PENDING', 'SENDING', 'SENT', 'FAILED', 'AMBIGUOUS', 'CANCELED'];
  const deliveryWaitingReasons = [
    'scheduled_not_due',
    'deadline_elapsed',
    'deadline_unknown',
    'local_capacity',
    'max_rate_limit',
    'circuit_open',
    'other_capacity_reason',
    'retry_not_due',
    'retry_due',
    'actor_access_required',
    'target_setup_required',
    'publisher_unavailable',
    'other_blocker',
    'lease_active',
    'lease_stale',
    'lease_invalid',
    'receipt_verification_wait',
    'receipt_verification_due',
    'verification_not_enrolled',
    'post_action_wait',
    'post_action_due',
    'post_action_unknown',
    'effect_unknown',
    'unspecified_pending',
  ];
  const deliveryCohort = {
    ...outcomeWindow,
    basis: 'recipient_created_at',
    dispatchProfile: 'PUBLIK_V1',
    retryMembership: 'same_delivery',
    completionTimingEvidence: 'not_recorded',
    ledgerEvidence: 'not_joined',
    rows: deliveryStatuses.map((status) => ({
      status,
      countLowerBound: status === 'AMBIGUOUS' ? 1 : 0,
      truncated: false,
      effectiveStatusCounts: countPartition(
        deliveryStatuses,
        status === 'AMBIGUOUS' ? status : null,
      ),
      receiptEvidenceCounts: countPartition(
        ['saved', 'missing', 'legacy_unproven', 'invalid_evidence'],
        status === 'AMBIGUOUS' ? 'missing' : null,
      ),
      verificationCounts: countPartition(
        [
          'automated_stable',
          'operator_confirmed',
          'legacy_unproven',
          'pending',
          'not_recorded',
          'invalid_evidence',
        ],
        status === 'AMBIGUOUS' ? 'not_recorded' : null,
      ),
      deadlineCounts: countPartition(
        ['future', 'due', 'expired', 'unknown'],
        status === 'AMBIGUOUS' ? 'expired' : null,
      ),
      waitingReasonCounts: countPartition(
        deliveryWaitingReasons,
        status === 'AMBIGUOUS' ? 'effect_unknown' : null,
      ),
      waitingReasonCountsOverlap: true,
    })),
    examples: [
      {
        deliveryId: 'delivery-observed-1',
        acceptedAt: '2026-10-16T18:05:00.000Z',
        storedStatus: 'AMBIGUOUS',
        effectiveStatus: 'AMBIGUOUS',
        receipt: 'missing',
      },
    ],
  };
  let deliveryEvidenceObservedAt = outcomeWindow.observedAt;
  const deliveryEvidence = (deliveryId) => ({
    schemaVersion: 1,
    observedAt: deliveryEvidenceObservedAt,
    deliveryId,
    storedStatus: 'AMBIGUOUS',
    effectiveStatus: 'AMBIGUOUS',
    acceptedAt:
      deliveryId === 'delivery-slow' ? '2026-10-16T18:04:00.000Z' : '2026-10-16T18:05:00.000Z',
    completionTimingEvidence: 'not_recorded',
    binding: 'exact',
    action: {
      keyBasis: 'current',
      state: 'unknown',
      dispatchStartedAt: '2026-10-16T18:06:00.000Z',
      journalCompletedAt: null,
    },
    recipient: { state: 'missing', savedSendAt: null, agreesWithAction: null },
    verification: { state: 'not_recorded', observedAt: null },
    waiting: {
      reasons: ['effect_unknown'],
      reasonsOverlap: true,
      deadline: 'expired',
      nextAttemptAt: null,
      firstDeferredAt: null,
      lastDeferredAt: null,
      ageSinceFirstDeferralMs: null,
      recipientBlocker: null,
      parentBlocker: null,
      postActions: { pin: 'NONE', deletion: 'NONE', nextAt: null },
    },
    clientVisibility: 'not_observed',
    automaticRetryAllowed: false,
  });
  const cohort = {
    schemaVersion: 1,
    basis: 'receipt_created_at',
    windowSeconds: 30,
    graceSeconds: 30,
    windowStartedAt: '2026-10-16T18:00:00.000Z',
    windowEndedAt: '2026-10-16T18:00:30.000Z',
    observedAt: '2026-10-16T18:01:00.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    effectsEvidence: 'not_linked',
    rows: [
      'RECEIVED',
      'QUEUED',
      'PROCESSED',
      'DUPLICATE',
      'FAILED',
      'NO_REPLAY_HELD',
      'CANCELLED',
      'QUARANTINED',
    ].map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      oldestPendingAgeSec: null,
      expiredAtObservation: 0,
      quarantineTimestampPresent: 0,
      invalidProcessedClocks: 0,
      invalidQueuedClocks: 0,
      processedLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
      enqueueLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
    })),
  };
  const publicationCohort = {
    schemaVersion: 1,
    basis: 'occurrence_created_at',
    dispatchProfile: 'PUBLIK_V1',
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: '2026-10-16T18:00:00.000Z',
    windowEndedAt: '2026-10-16T18:15:00.000Z',
    observedAt: '2026-10-16T18:15:30.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 1,
    completionTimingEvidence: 'not_recorded',
    effectsEvidence: 'occurrence_status_only',
    rows: ['SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'].map(
      (status) => ({
        status,
        countLowerBound: status === 'AMBIGUOUS' ? 1 : 0,
        truncated: false,
        pendingNotDue: 0,
        pendingDue: 0,
        pendingExpired: 0,
        pendingTimingUnknown: 0,
        blockedPending: 0,
        retryAuthorizedCount: 0,
        oldestDueAgeSec: null,
        modeCounts: {
          NOW: status === 'AMBIGUOUS' ? 1 : 0,
          ONCE: 0,
          SLOTS: 0,
          RECURRENCE: 0,
          UNKNOWN: 0,
        },
        mediaCounts: { TEXT: 0, IMAGE: 0, VIDEO: 0, UNKNOWN: status === 'AMBIGUOUS' ? 1 : 0 },
      }),
    ),
  };
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      if (
        startupDenied &&
        [...startupPaths].some(
          (endpoint) => message.location().url === new URL(endpoint, baseUrl).href,
        ) &&
        /^Failed to load resource: the server responded with a status of 403\b/.test(message.text())
      )
        return;
      if (
        overviewMode === 'denied' &&
        message.location().url === `${baseUrl}api/v1/safety-desk/runtime/overview` &&
        /^Failed to load resource: the server responded with a status of 403\b/.test(message.text())
      )
        return;
      if (
        cohortUnavailable &&
        [
          'webhook-cohort',
          'publication-cohort',
          'delete-cohort',
          'publication-delivery-cohort',
        ].some(
          (endpoint) =>
            message.location().url === `${baseUrl}api/v1/safety-desk/runtime/${endpoint}`,
        ) &&
        /^Failed to load resource: the server responded with a status of 503\b/.test(message.text())
      )
        return;
      if (
        deliveryEvidenceDenied &&
        message.location().url ===
          `${baseUrl}api/v1/safety-desk/runtime/publication-deliveries/delivery-malformed/evidence` &&
        /^Failed to load resource: the server responded with a status of 403\b/.test(message.text())
      )
        return;
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) =>
    errors.push(
      `requestfailed: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
    ),
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.headers()['x-admin-access-code'] !== undefined)
      throw new Error('Safety Desk sent a retired access-code header.');
    if (startupPaths.has(url.pathname)) {
      if (request.method() !== 'GET' || request.postData())
        throw new Error('Safety Desk startup attempted a mutation.');
      ++startupRequests;
      if (startupDenied) {
        await route.fulfill({ status: 403, json: { message: 'Нет доступа к Safety Desk.' } });
        return;
      }
    }
    if (url.pathname.endsWith('/safety-desk/runtime/commercial-ai/pool')) {
      if (request.method() !== 'GET' || request.postData())
        throw new Error('Commercial AI pool observation attempted a mutation.');
      commercialAiPoolRequests += 1;
      if (commercialAiGate) await commercialAiGate;
      await route.fulfill({
        status: 200,
        json: commercialAiMalformed ? { schemaVersion: 0 } : commercialAiPool,
      });
      return;
    }
    if (url.pathname.endsWith('/safety-desk/runtime/commercial-ai')) {
      if (request.method() !== 'GET' || request.postData())
        throw new Error('Commercial AI observation attempted a mutation.');
      commercialAiRequests += 1;
      if (commercialAiGate) await commercialAiGate;
      await route.fulfill({
        status: 200,
        json: commercialAiMalformed ? { schemaVersion: 0 } : commercialAi,
      });
      return;
    }
    if (url.pathname.endsWith('/safety-desk/runtime/retention')) {
      if (request.method() !== 'GET' || request.postData())
        throw new Error('Retention observation attempted a mutation.');
      retentionRequests += 1;
      await route.fulfill({
        status: 200,
        json: {
          generatedAt,
          mode: 'on',
          nextAfter: null,
          quotas: [],
          items: [
            {
              chatId: 'retention-diagnostics-smoke',
              chatTitle: 'Диагностика истории',
              enabled: true,
              hours: 24,
              revision: 1,
              activationId: 'retention-smoke-activation',
              pendingCount: 1,
              deletedCount: 2,
              skippedCount: 0,
              status: 'error',
              oldestDueAt: generatedAt,
              nextRunAt: null,
              hasTerminalReview: false,
              hasUnresolvedReceipt: false,
              connectionStatus: 'connected',
              historyStatus: 'blocked',
              diagnostics: {
                lastError: 'delete_unconfirmed',
                historyBoundaryBlocked: true,
                awaitingCurrentProtection: false,
                awaitingHistoricalProtection: true,
              },
            },
          ],
        },
      });
      return;
    }
    for (const [endpoint, fixture] of [
      ['delete-cohort', deleteCohort],
      ['publication-delivery-cohort', deliveryCohort],
    ]) {
      if (!url.pathname.endsWith(`/safety-desk/runtime/${endpoint}`)) continue;
      if (request.method() !== 'GET') throw new Error('Outcome cohort attempted a mutation.');
      if (endpoint === 'delete-cohort') deleteCohortRequests += 1;
      else deliveryCohortRequests += 1;
      await route.fulfill(
        cohortUnavailable
          ? { status: 503, json: { message: 'Unavailable' } }
          : { status: 200, json: fixture },
      );
      return;
    }
    const deliveryMatch = url.pathname.match(
      /\/safety-desk\/runtime\/publication-deliveries\/([^/]+)\/evidence$/u,
    );
    if (deliveryMatch) {
      if (request.method() !== 'GET') throw new Error('Delivery evidence attempted a mutation.');
      deliveryEvidenceRequests += 1;
      const id = decodeURIComponent(deliveryMatch[1]);
      if (id === 'delivery-slow') await delayedDelivery;
      if (deliveryEvidenceDenied) {
        await route.fulfill({ status: 403, json: { message: 'Forbidden' } });
        return;
      }
      await route.fulfill({
        status: 200,
        json: deliveryEvidenceMalformed ? { deliveryId: id } : deliveryEvidence(id),
      });
      return;
    }
    if (url.pathname.endsWith('/safety-desk/runtime/webhook-cohort')) {
      cohortRequests += 1;
      await route.fulfill(
        cohortUnavailable
          ? { status: 503, json: { message: 'Сводка обработки временно недоступна.' } }
          : { status: 200, json: cohort },
      );
      return;
    }
    if (url.pathname.endsWith('/safety-desk/runtime/overview')) {
      if (request.method() !== 'GET') throw new Error('Bot overview attempted a mutation.');
      overviewRequests += 1;
      await route.fulfill(
        overviewMode === 'denied'
          ? { status: 403, json: { message: 'Forbidden' } }
          : {
              status: 200,
              json:
                overviewMode === 'invalid'
                  ? { schemaVersion: 1 }
                  : (overviewMode === 'timing-gap' ? overviewTimingGapFixture : overviewFixture)(
                      await page.evaluate(() => Date.now()),
                    ),
            },
      );
      return;
    }
    if (url.pathname.endsWith('/safety-desk/runtime/publication-cohort')) {
      if (request.method() !== 'GET') throw new Error('Publication cohort attempted a mutation.');
      publicationRequests += 1;
      await route.fulfill(
        cohortUnavailable
          ? { status: 503, json: { message: 'Publication observations unavailable' } }
          : { status: 200, json: publicationCohort },
      );
      return;
    }
    const evidenceItem = deleteItems.find((item) =>
      url.pathname.endsWith(`/safety-desk/runtime/deletes/${item.id}/evidence`),
    );
    if (evidenceItem) {
      if (request.method() !== 'GET') throw new Error('Delete evidence attempted a mutation.');
      evidenceRequests += 1;
      await route.fulfill({
        status: 200,
        json: evidenceMalformed
          ? { version: 0 }
          : {
              version: 1,
              observedAt: generatedAt,
              intentId: evidenceItem.id,
              webhookLink: 'not_recorded',
              originCoverage: 'partial',
              deletion: {
                status: evidenceItem.status,
                outcome: 'unknown',
                createdAt: generatedAt,
                sourceMessageAt: null,
                firstAttemptAt: generatedAt,
                dispatchStartedAt: generatedAt,
                acknowledgedAt: null,
                completedAt: null,
              },
              reasons: {
                sampleComplete: true,
                items: [
                  {
                    reasonKey: 'SMOKE_DELETE',
                    ruleCode: 'SMOKE_DELETE',
                    moderationEventId: null,
                    decisionRecorded: false,
                    origin: {
                      state: 'linked',
                      webhookEventId: 'smoke-receipt',
                      receivingBotId: 'smoke-receiver',
                      executionBotId: 'smoke-executor',
                      eventAt: generatedAt,
                      acceptedAt: generatedAt,
                      recordedAt: generatedAt,
                      evidenceVersion: 1,
                    },
                  },
                ],
              },
              followups: {
                sampleComplete: true,
                items: [
                  {
                    id: 'smoke-followup',
                    ruleCode: 'SMOKE_DELETE',
                    status: 'IN_PROGRESS',
                    sourceAt: generatedAt,
                    deadlineAt: '2026-07-19T00:05:00.000Z',
                    completedAt: null,
                    decisionRecorded: false,
                    explanation: { state: 'unknown', completedAt: null, remoteMessageId: null },
                    sanctionNotice: {
                      state: 'not_recorded',
                      completedAt: null,
                      remoteMessageId: null,
                    },
                  },
                ],
              },
            },
      });
      return;
    }
    const payload = url.pathname.endsWith('/safety-desk/queue')
      ? queue
      : url.pathname.endsWith('/support-requests/queue')
        ? supportQueue
        : url.pathname.endsWith('/safety-desk/runtime/deletes')
          ? deleteRuntime
          : null;
    if (!payload) {
      await route.fulfill({ status: 404, json: { message: 'unmocked smoke route' } });
      return;
    }
    await route.fulfill({ status: 200, json: payload });
  });

  const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
  if (!response?.ok()) {
    throw new Error(`${profile.name} failed to load Safety Desk.`);
  }
  await page.getByRole('alert').filter({ hasText: 'Нет доступа к Safety Desk.' }).waitFor();
  if (startupRequests !== 3 || (await page.locator('.desk-shell').count()))
    throw new Error('Denied startup displayed a loaded queue or repeated its reads.');
  if (await page.locator('input[type="password"]').count())
    throw new Error('Safety Desk still asks for an additional access code.');
  const deniedReads = startupRequests;
  await page.clock.fastForward(1_000);
  if (startupRequests !== deniedReads)
    throw new Error('Denied startup retried without an operator action.');
  startupDenied = false;
  await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await page.getByRole('button', { name: 'Публикации' }).waitFor();
  if (startupRequests !== deniedReads + 3)
    throw new Error('The startup retry did not load the server queues once.');
  await page.reload();
  await page.getByRole('button', { name: 'Публикации' }).waitFor();
  if (await page.locator('input[type="password"]').count())
    throw new Error('A fresh Safety Desk session still asks for an access code.');
  if (overviewOnly) {
    await page.getByRole('button', { name: 'Наблюдения', exact: true }).click();
    await smokeRuntimeOverview(page, profile, overviewControls);
    if (errors.length)
      throw new Error(`${profile.name} overview smoke failed:\n${errors.join('\n')}`);
    await context.close();
    return;
  }
  await page.getByRole('button', { name: 'Обращения' }).click();
  await page.getByRole('button', { name: 'Удаления' }).click();
  const evidencePanel = page.getByRole('region', { name: 'Подтверждения результата' });
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).waitFor();
  if (evidenceRequests !== 0)
    throw new Error('Delete evidence loaded without an explicit request.');
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).click();
  await evidencePanel.getByText('Исход удаления неизвестен', { exact: true }).waitFor();
  await evidencePanel
    .getByText('Объяснение: Исход отправки неизвестен', { exact: false })
    .waitFor();
  await evidencePanel
    .getByText('Исходное событие и исполнитель подтверждены.', { exact: false })
    .waitFor();
  if (evidenceRequests !== 1) throw new Error('Delete evidence request was repeated.');
  if (await page.getByRole('button', { name: 'Повторить удаление', exact: true }).count()) {
    throw new Error('Unknown delete result exposed a retry action.');
  }
  if (await evidencePanel.getByRole('button', { name: /повтор|отправить|публиковать/i }).count()) {
    throw new Error('Delete evidence panel exposed an effect action.');
  }
  await page.getByRole('button', { name: 'Все', exact: true }).click();
  await page.getByRole('button', { name: /Тест удаления B/ }).click();
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).waitFor();
  if (await evidencePanel.getByText('Исход удаления неизвестен', { exact: true }).count()) {
    throw new Error('Evidence from a previous delete remained visible after selection changed.');
  }
  if (evidenceRequests !== 1)
    throw new Error('Selecting another delete fetched evidence automatically.');
  await page.getByRole('button', { name: 'Повторить удаление', exact: true }).waitFor();
  evidenceMalformed = true;
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).click();
  await evidencePanel
    .getByRole('alert')
    .filter({ hasText: 'Не удалось загрузить подтверждения.' })
    .waitFor();
  if (evidenceRequests !== 2) throw new Error('Failed evidence read was retried automatically.');
  await page.getByRole('button', { name: 'Повторить удаление', exact: true }).waitFor();
  if (cohortRequests !== 0 || publicationRequests !== 0)
    throw new Error('Closed cohort loaded before its view was opened.');
  await page.getByRole('button', { name: 'Наблюдения' }).click();
  await smokeRuntimeOverview(page, profile, overviewControls);
  const observationSelector = page.getByRole('navigation', { name: 'Вид наблюдений' });
  await observationSelector.getByRole('button', { name: 'Входящие события', exact: true }).click();
  await page.getByText('За этот интервал события не наблюдались.', { exact: false }).waitFor();
  await page.getByText('Обработка события не подтверждает удаление', { exact: false }).waitFor();
  await page.getByText(/21:00:00 МСК — .*21:00:30 МСК/).waitFor();
  if (publicationRequests || deleteCohortRequests || deliveryCohortRequests || commercialAiRequests)
    throw new Error('Hidden observation families loaded eagerly.');
  cohort.sampleComplete = false;
  cohort.totalCountLowerBound = 512;
  cohort.rows[2].countLowerBound = 512;
  cohort.rows[2].truncated = true;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.getByText('Неполная выборка: достигнут предел чтения', { exact: false }).waitFor();
  await observationSelector.getByRole('button', { name: 'Запуски Публика', exact: true }).click();
  const publicationPanel = page.getByRole('region', { name: 'Результаты запусков Публика' });
  await publicationPanel.getByText('Исход неизвестен', { exact: true }).first().waitFor();
  await publicationPanel
    .getByText('Поздний ручной повтор отдельно не учитывается.', { exact: false })
    .waitFor();
  await publicationPanel.getByText('Режимы и содержимое запусков', { exact: true }).click();
  await publicationPanel.getByRole('columnheader', { name: 'Содержимое неизвестно' }).waitFor();
  if (publicationRequests !== 1) throw new Error('Publication cohort request repeated.');
  cohortUnavailable = true;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await publicationPanel
    .getByRole('alert')
    .filter({ hasText: 'Не удалось проверить запуски Публика.' })
    .waitFor();
  if (await publicationPanel.getByRole('table').count())
    throw new Error('Failed publication refresh retained stale success.');
  await observationSelector.getByRole('button', { name: 'Входящие события', exact: true }).click();
  await page
    .getByRole('region', { name: 'Результаты обработки событий' })
    .getByRole('alert')
    .waitFor();
  if (await page.getByRole('table').count())
    throw new Error('A remounted observation retained data from its previous request.');
  cohortUnavailable = false;
  await observationSelector
    .getByRole('button', { name: 'Намерения удаления', exact: true })
    .click();
  const deletionPanel = page.getByRole('region', { name: 'Намерения удаления', exact: true });
  await deletionPanel.getByRole('table').first().waitFor();
  await deletionPanel
    .getByText('Неизвестный исход не разрешает автоматический повтор.', { exact: false })
    .waitFor();
  if (deleteCohortRequests !== 1 || deliveryCohortRequests !== 0)
    throw new Error('DELETE observation loaded unrelated readers.');
  cohortUnavailable = true;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await deletionPanel.getByRole('alert').waitFor();
  if (await deletionPanel.getByRole('table').count())
    throw new Error('DELETE observation retained stale success.');
  cohortUnavailable = false;
  await observationSelector.getByRole('button', { name: 'Доставки Публика', exact: true }).click();
  const deliveryPanel = page.getByRole('region', { name: 'Доставки Публика', exact: true });
  await deliveryPanel.getByRole('table').first().waitFor();
  if (deliveryCohortRequests !== 1 || deliveryEvidenceRequests !== 0)
    throw new Error('Delivery evidence loaded without selection.');
  await deliveryPanel.getByText('Проверить отдельную доставку из выборки', { exact: true }).click();
  await deliveryPanel.getByRole('button', { name: /delivery-observed-1/ }).click();
  const deliveryEvidencePanel = page.getByRole('region', {
    name: 'Подтверждения доставки',
    exact: true,
  });
  await deliveryEvidencePanel
    .getByText('Исход отправки неизвестен', { exact: true })
    .first()
    .waitFor();
  if (deliveryEvidenceRequests !== 1) throw new Error('Delivery evidence retried automatically.');
  await page.getByLabel('Идентификатор доставки', { exact: true }).fill('delivery-slow');
  const slowRequest = page.waitForRequest((request) =>
    request.url().endsWith('/publication-deliveries/delivery-slow/evidence'),
  );
  await page.getByRole('button', { name: 'Проверить доставку', exact: true }).click();
  await slowRequest;
  await page.getByLabel('Идентификатор доставки', { exact: true }).fill('delivery-observed-2');
  await page.getByRole('button', { name: 'Проверить доставку', exact: true }).click();
  await deliveryEvidencePanel
    .getByText('Исход отправки неизвестен', { exact: true })
    .first()
    .waitFor();
  const slowResponse = page.waitForResponse((response) =>
    response.url().endsWith('/publication-deliveries/delivery-slow/evidence'),
  );
  releaseDelayedDelivery();
  await slowResponse;
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  if (await deliveryEvidencePanel.getByText(/21:04:00 МСК/).count())
    throw new Error('Delayed response replaced another delivery evidence.');
  deliveryEvidenceMalformed = true;
  await page.getByLabel('Идентификатор доставки', { exact: true }).fill('delivery-malformed');
  await page.getByRole('button', { name: 'Проверить доставку', exact: true }).click();
  await deliveryEvidencePanel.getByRole('alert').waitFor();
  if (await deliveryEvidencePanel.getByText('Исход отправки неизвестен', { exact: true }).count())
    throw new Error('Malformed delivery response retained previous success.');
  if (deliveryEvidenceRequests !== 4) throw new Error('Malformed delivery read retried.');
  deliveryEvidenceMalformed = false;
  deliveryEvidenceObservedAt = '2026-10-16T18:16:30.000Z';
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await deliveryEvidencePanel.getByText(/21:16:30 МСК/).waitFor();
  if (
    deliveryEvidenceRequests !== 5 ||
    (await deliveryEvidencePanel.locator('code').textContent()) !== 'delivery-malformed'
  )
    throw new Error('Global refresh did not reread the selected delivery.');
  deliveryEvidenceDenied = true;
  cohortUnavailable = true;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await deliveryEvidencePanel
    .getByRole('alert')
    .filter({ hasText: 'Нет доступа к наблюдениям.' })
    .waitFor();
  if (
    deliveryEvidenceRequests !== 6 ||
    (await deliveryEvidencePanel.getByText('Исход отправки неизвестен', { exact: true }).count()) ||
    (await deliveryEvidencePanel.locator('.delete-timeline').count())
  )
    throw new Error('Global refresh retained delivery evidence after access was denied.');
  await deliveryPanel.getByRole('alert').waitFor();
  if (await deliveryPanel.getByRole('table').count())
    throw new Error('Delivery cohort retained stale success.');
  if (await page.getByRole('button', { name: /повтор|публиковать/i }).count()) {
    throw new Error('Read-only cohort exposed an effect retry action.');
  }
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) {
    throw new Error(`${profile.name} cohort view has horizontal overflow.`);
  }

  if (commercialAiRequests !== 0 || commercialAiPoolRequests !== 0)
    throw new Error('Commercial AI loaded before its observation family was selected.');
  await observationSelector.getByRole('button', { name: 'Рекламный ИИ', exact: true }).click();
  const aiPanel = page.getByRole('region', { name: 'Рекламный ИИ', exact: true });
  await aiPanel.getByText('Сигнал был свежим на момент снимка', { exact: true }).waitFor();
  await aiPanel.getByText('Последний учтённый результат', { exact: true }).waitFor();
  await aiPanel.getByText(/Данные обновляются кнопкой «Обновить»/).waitFor();
  await aiPanel
    .getByText('Регистрация намерения не подтверждает удаление сообщения.', { exact: false })
    .waitFor();
  if (commercialAiRequests !== 1) throw new Error('Commercial AI request repeated.');
  const poolPanel = page.getByRole('region', { name: 'Модели рекламного ИИ', exact: true });
  await poolPanel.getByText('Слот занят', { exact: true }).waitFor();
  await poolPanel.getByText('Нет свежей регистрации', { exact: true }).waitFor();
  await poolPanel.getByText('Без свободной 9B для перепроверки', { exact: true }).waitFor();
  if (commercialAiPoolRequests !== 1) throw new Error('Commercial AI pool request repeated.');
  await aiPanel.getByText('Отброшенные ожидания', { exact: true }).click();
  await aiPanel.getByText('включая предыдущие процессы', { exact: false }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1))
    throw new Error(`${profile.name} commercial AI view has horizontal overflow.`);

  let releaseCommercialAi;
  commercialAiGate = new Promise((resolve) => {
    releaseCommercialAi = resolve;
  });
  commercialAi.availability = 'STALE';
  commercialAi.admission = 'GOVERNOR_PAUSED';
  const delayedAiRequest = page.waitForRequest((request) =>
    request.url().endsWith('/safety-desk/runtime/commercial-ai'),
  );
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await delayedAiRequest;
  await aiPanel.getByText('Читаю сохранённые наблюдения…', { exact: true }).waitFor();
  await poolPanel.getByText('Читаю сохранённые наблюдения…', { exact: true }).waitFor();
  if (await poolPanel.locator('.commercial-ai-snapshot').count())
    throw new Error('Pool refresh retained observations from the previous snapshot.');
  if (await aiPanel.locator('.commercial-ai-metrics').count())
    throw new Error('Commercial AI refresh retained counters from the previous snapshot.');
  releaseCommercialAi();
  commercialAiGate = undefined;
  await aiPanel.getByText('Сигнал процесса устарел', { exact: true }).waitFor();
  await aiPanel.getByText(/Пауза из-за нагрузки на основные задачи/).waitFor();

  commercialAi = {
    ...commercialAi,
    availability: 'MISSING',
    observedAt: null,
    heartbeatAt: null,
    lastRecordedResultAt: null,
    observationStartedAt: null,
    observationProcessId: null,
    active: null,
    admission: 'UNKNOWN',
    admissionObservedAt: null,
    outcomes: null,
    pendingDiscards: null,
  };
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await aiPanel.getByText('Нет наблюдений', { exact: true }).waitFor();
  await aiPanel.getByText('Счётчики результатов отсутствуют.', { exact: true }).waitFor();
  await aiPanel.getByText('Начало периода не записано.', { exact: false }).waitFor();
  if (await aiPanel.locator('.commercial-ai-metrics').count())
    throw new Error('Missing AI observations were rendered as counters.');

  commercialAiMalformed = true;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await aiPanel.getByRole('alert').waitFor();
  await poolPanel.getByRole('alert').waitFor();
  if (await poolPanel.locator('.commercial-ai-snapshot').count())
    throw new Error('Invalid pool response retained the previous snapshot.');
  if (await aiPanel.locator('.commercial-ai-snapshot').count())
    throw new Error('Invalid AI response retained the previous snapshot.');
  const previousAiReads = commercialAiRequests;
  cohortUnavailable = false;
  await observationSelector.getByRole('button', { name: 'Входящие события', exact: true }).click();
  await page
    .getByRole('region', { name: 'Результаты обработки событий' })
    .getByRole('table')
    .waitFor();
  const webhookRefreshResponse = page.waitForResponse((response) =>
    response.url().endsWith('/safety-desk/runtime/webhook-cohort'),
  );
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  const refreshedWebhook = await webhookRefreshResponse;
  const webhookRefreshFailure = await refreshedWebhook.finished();
  if (!refreshedWebhook.ok() || webhookRefreshFailure)
    throw new Error(
      `Webhook refresh did not finish successfully: ${webhookRefreshFailure ?? refreshedWebhook.status()}`,
    );
  // The webhook panel keeps its previous table while refreshing; its presence is not completion.
  await page
    .locator('section[aria-label="Результаты обработки событий"][aria-busy="false"]')
    .waitFor();
  if (commercialAiRequests !== previousAiReads)
    throw new Error('Hidden commercial AI observations were refreshed.');

  // A fresh owner session requires a new explicit delivery selection.
  cohortUnavailable = false;
  deliveryEvidenceMalformed = false;
  deliveryEvidenceDenied = false;
  const previousEvidenceReads = deliveryEvidenceRequests;
  await page.reload();
  await page.getByRole('button', { name: 'Публикации', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Наблюдения', exact: true }).click();
  await observationSelector.getByRole('button', { name: 'Доставки Публика', exact: true }).click();
  await deliveryPanel.getByRole('table').first().waitFor();
  if (
    deliveryEvidenceRequests !== previousEvidenceReads ||
    (await deliveryEvidencePanel.count()) ||
    (await page.getByLabel('Идентификатор доставки', { exact: true }).inputValue())
  ) {
    throw new Error('A new owner session retained or loaded the previous delivery selection.');
  }
  if (retentionRequests !== 0) throw new Error('Hidden retention diagnostics loaded eagerly.');
  await page.getByRole('button', { name: 'Очистка', exact: true }).click();
  const retentionPanel = page.getByRole('region', { name: 'Очистка старых сообщений' });
  await retentionPanel
    .getByText('История: граница обхода не подтверждена', { exact: true })
    .waitFor();
  await retentionPanel
    .getByText('Нет подтверждения защиты старой истории', { exact: true })
    .waitFor();
  await retentionPanel.getByText('MAX не подтвердил результат удаления', { exact: true }).waitFor();
  if (retentionRequests !== 1)
    throw new Error('Retention diagnostics repeated the runtime request.');
  if (await retentionPanel.getByRole('button', { name: /повтор|удалить/i }).count())
    throw new Error('Retention diagnostics exposed a recovery action without a selected record.');
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1))
    throw new Error(`${profile.name} retention diagnostics have horizontal overflow.`);
  await page.getByRole('button', { name: 'Публикации' }).click();

  const state = await page.evaluate(() => ({
    hasOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  if (state.hasOverflow) {
    errors.push(`horizontal overflow at ${profile.viewport.width}px`);
  }
  if (errors.length > 0) {
    throw new Error(`${profile.name} Safety Desk smoke failed:\n${errors.join('\n')}`);
  }
  await context.close();
}

function getAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const selectedPort = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => {
        if (error || !selectedPort) {
          reject(error ?? new Error('Could not allocate an admin smoke port.'));
        } else {
          resolvePort(selectedPort);
        }
      });
    });
  });
}

async function waitForUrl(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Safety Desk preview exited early:\n${serverOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Preview startup is expected to refuse connections briefly.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Safety Desk preview:\n${serverOutput}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
