import { parseCatalogViolationPercent } from './multibot-catalog-workload';
import {
  buildCatalogManifest,
  evaluateCatalogOutcomes,
  parseCatalogTokenRps,
  type CatalogEventObservation,
  type CatalogProfile,
} from './multibot-catalog-acceptance';
import { evaluateCatalogLatency, parseCatalogLatencyTargets } from './multibot-catalog-latency';
import {
  collectFixtureBatches,
  countFixtureBatches,
} from '../webhook/multibot-harness-batches.spec-support';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../webhook/webhook-multibot-fullpath.spec-support';
import {
  createSplitMultibotHarness,
  type SplitRoleReport,
} from '../webhook/webhook-multibot-split.spec-support';
import { ModerationDeleteIntentStatus } from '../prisma/prisma-client';

const profilesAllowed = new Set<CatalogProfile>(['uniform', 'hot', 'cold', 'media', 'mixed']);
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--([a-z]+)=(.+)$/u.exec(arg);
    if (!match)
      throw new Error(
        'Use --chats=10000,12000,30000 --bots=6 --messages=120 --rate=2 --routing=legacy|fixed --enqueue=fixture|production --topology=single|split --profiles=uniform,hot,cold,media,mixed --quota=25|30 --violations=100 --latency=2000,10000 --output=path',
      );
    return [match[1]!, match[2]!];
  }),
);
for (const key of Object.keys(args))
  if (
    ![
      'chats',
      'bots',
      'messages',
      'rate',
      'routing',
      'enqueue',
      'topology',
      'profiles',
      'latency',
      'violations',
      'quota',
      'output',
    ].includes(key)
  )
    throw new Error(`Unknown option ${key}`);
function positive(value: string, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error(`${name} must be a positive integer`);
  return result;
}
const catalogs = (args.chats ?? '10000,12000,30000')
  .split(',')
  .map((value) => positive(value, 'chats'));
const bots = positive(args.bots ?? '9', 'bots');
const messageCount = positive(args.messages ?? '120', 'messages');
const rate = positive(args.rate ?? '2', 'rate');
const tokenRps = parseCatalogTokenRps(args.quota);
const routing = args.routing ?? 'legacy';
if (routing !== 'legacy' && routing !== 'fixed') throw new Error('Unsupported routing mode');
const enqueue = args.enqueue ?? 'fixture';
if (enqueue !== 'fixture' && enqueue !== 'production')
  throw new Error('Unsupported enqueue profile');
const topology = args.topology ?? 'single';
if (topology !== 'single' && topology !== 'split') throw new Error('Unsupported fixture topology');
if (topology === 'split' && (enqueue !== 'production' || messageCount > 10_000 || bots > 12))
  throw new Error(
    'Split fixture requires production selection and at most 10,000 messages / 12 bots',
  );
const profiles = (args.profiles ?? 'uniform,hot,cold,media').split(',') as CatalogProfile[];
if (profiles.some((profile) => !profilesAllowed.has(profile)))
  throw new Error('Unsupported profile');
if (
  profiles.includes('mixed') &&
  (catalogs.some((catalog) => catalog < 5) || messageCount < 5 || messageCount > 10_000)
)
  throw new Error('Mixed profile requires at least 5 chats and 5..10,000 messages');
const latencyTargets = parseCatalogLatencyTargets(args.latency);
const violationPercent = parseCatalogViolationPercent(args.violations);
const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl)
  throw new Error(
    'Run through scripts/agent/with-test-stores.mjs --migrate; local disposable stores are required',
  );
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reports: unknown[] = [];
const pendingActionStatuses = [
  ModerationDeleteIntentStatus.PENDING,
  ModerationDeleteIntentStatus.IN_PROGRESS,
  ModerationDeleteIntentStatus.RETRYABLE,
  ModerationDeleteIntentStatus.WAITING_CAPABILITY,
  ModerationDeleteIntentStatus.AMBIGUOUS,
];

async function main() {
  for (const catalog of catalogs) {
    const harness: MultibotHarness & {
      roleReports?: SplitRoleReport[];
      snapshotEffects?: () => Promise<boolean>;
    } = await (topology === 'split' ? createSplitMultibotHarness : createMultibotHarness)({
      databaseUrl: databaseUrl!,
      redisUrl: redisUrl!,
      bots,
      mode: 'on',
      quotaProfile: 'production',
      tokenRps,
      productionEnqueueCapacity: enqueue === 'production',
      productionOutboxSelection: enqueue === 'production',
      recoverDueDeletes: true,
    });
    let failureSnapshot: ((error: unknown) => Promise<unknown>) | undefined;
    try {
      const seededAt = performance.now();
      const chats = await harness.seedCatalog(catalog);
      const assignedBots = new Map<string, string>();
      for (const [index, chatId] of chats.entries()) {
        assignedBots.set(chatId, harness.bots[routing === 'fixed' ? index % bots : 0]!.id);
      }
      if (routing === 'fixed') {
        // FLAG: Disposable fixture setup only; production preservation never redistributes chats.
        for (const bot of harness.bots) {
          const assigned = chats.filter((chatId) => assignedBots.get(chatId) === bot.id);
          await harness.prisma.chat.updateMany({
            where: { id: { in: assigned } },
            data: {
              fixedModeratorBotId: bot.id,
              primaryBotId: bot.id,
              botId: bot.id,
              routingVersion: { increment: 1 },
            },
          });
          await harness.prisma.chatBotMembership.updateMany({
            where: { chatId: { in: assigned } },
            data: { role: 'STANDBY' },
          });
          await harness.prisma.chatBotMembership.updateMany({
            where: { chatId: { in: assigned }, botId: bot.id },
            data: { role: 'PRIMARY' },
          });
        }
      }
      const seedMs = performance.now() - seededAt;
      for (const profile of profiles) {
        const caseId = `load-${randomUUID()}`;
        const beforeEffectIds = new Set(harness.effects.map((effect) => effect.callId));
        const beforeRequests = harness.requests.length;
        const beforeViolations = await harness.prisma.violation.count({
          where: { chatId: { in: chats } },
        });
        const expectedManifest = buildCatalogManifest({
          caseId,
          chats,
          executorByChat: assignedBots,
          messages: messageCount,
          bots,
          fixedRouting: routing === 'fixed',
          profile,
          violationPercent,
        });
        const expectedDeleteIds = new Set(
          expectedManifest
            .filter((event) => event.decision === 'DELETE')
            .map((event) => event.messageId),
        );
        const ingressClocks = new Map<string, number>();
        const receiptsByMessage = new Map<string, string[]>();
        const receiptIds: string[] = [];
        const unsettledReceiptIds = new Set<string>();
        const touchedChatIds = new Set<string>();
        const messageIds: string[] = [];
        const expectedExecutors = new Map<string, string>();
        const ingressLatencyMs: number[] = [];
        const producerLatenessMs: number[] = [];
        let producing = true;
        let peakPendingReceipts = 0;
        let peakOldestReceiptAgeMs = 0;
        let peakPendingActions = 0;
        let peakOldestActionAgeMs = 0;
        let pumpError: unknown;
        const startedAt = performance.now();
        let productionFinishedAt = startedAt;
        const collectOutcomeAcceptance = async () => {
          const [receiptRows, claims, intentRows] = await Promise.all([
            collectFixtureBatches(receiptIds, (ids) =>
              harness.prisma.webhookEvent.findMany({
                where: { id: { in: ids } },
                select: {
                  id: true,
                  botId: true,
                  normalizedPayload: true,
                  status: true,
                  executionDeadlineAt: true,
                },
              }),
            ),
            collectFixtureBatches(receiptIds, (ids) =>
              harness.prisma.webhookExecutionClaim.findMany({
                where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
                select: {
                  webhookEventId: true,
                  status: true,
                  executionBotId: true,
                  completedAt: true,
                },
              }),
            ),
            collectFixtureBatches(messageIds, (ids) =>
              harness.prisma.moderationDeleteIntent.findMany({
                where: { messageId: { in: ids } },
                select: {
                  messageId: true,
                  chatId: true,
                  status: true,
                  succeededBotId: true,
                  remoteDeleteSucceededAt: true,
                  remoteDeleteSucceededBotId: true,
                  completedAt: true,
                  deleteDispatchStartedAt: true,
                  reasons: {
                    where: { ruleCode: 'MESSAGE_TOO_LONG_DELETE' },
                    select: { metadata: true },
                    take: 1,
                  },
                },
              }),
            ),
          ]);
          const receiptById = new Map(receiptRows.map((row) => [row.id, row]));
          const claimsByReceipt = new Map<string, typeof claims>();
          for (const claim of claims) {
            if (!claim.webhookEventId) continue;
            const rows = claimsByReceipt.get(claim.webhookEventId) ?? [];
            rows.push(claim);
            claimsByReceipt.set(claim.webhookEventId, rows);
          }
          const intentsByMessage = new Map<string, typeof intentRows>();
          for (const intent of intentRows) {
            const rows = intentsByMessage.get(intent.messageId) ?? [];
            rows.push(intent);
            intentsByMessage.set(intent.messageId, rows);
          }
          const deletesByMessage = new Map<string, typeof harness.effects>();
          for (const effect of harness.effects) {
            if (effect.method !== 'delete' || effect.path !== '/messages' || !effect.messageId)
              continue;
            const rows = deletesByMessage.get(effect.messageId) ?? [];
            rows.push(effect);
            deletesByMessage.set(effect.messageId, rows);
          }
          const observations = new Map<string, CatalogEventObservation>();
          // FLAG: Compare the whole pre-ingress oracle, including unsubmitted and missing work.
          for (const event of expectedManifest) {
            const ingressAtMs = ingressClocks.get(event.messageId);
            if (ingressAtMs === undefined) continue;
            const ids = new Set(receiptsByMessage.get(event.messageId) ?? []);
            observations.set(event.messageId, {
              ingressAtMs,
              receipts: [...ids].flatMap((id) => {
                const row = receiptById.get(id);
                const payload = row?.normalizedPayload;
                const message =
                  payload &&
                  typeof payload === 'object' &&
                  !Array.isArray(payload) &&
                  payload.message &&
                  typeof payload.message === 'object' &&
                  !Array.isArray(payload.message)
                    ? payload.message
                    : null;
                return row
                  ? [
                      {
                        botId: row.botId,
                        chatId: typeof message?.chatId === 'string' ? message.chatId : null,
                        messageId:
                          typeof message?.messageId === 'string' ? message.messageId : null,
                        status: row.status,
                        deadlineAtMs: row.executionDeadlineAt?.getTime() ?? null,
                      },
                    ]
                  : [];
              }),
              claims: [...ids]
                .flatMap((id) => claimsByReceipt.get(id) ?? [])
                .map((claim) => ({
                  status: claim.status,
                  botId: claim.executionBotId,
                  completedAtMs: claim.completedAt?.getTime() ?? null,
                })),
              intents: (intentsByMessage.get(event.messageId) ?? []).map((intent) => ({
                status: intent.status,
                chatId: intent.chatId,
                botId: intent.succeededBotId,
                remoteBotId: intent.remoteDeleteSucceededBotId,
                remoteSucceededAtMs: intent.remoteDeleteSucceededAt?.getTime() ?? null,
                completedAtMs: intent.completedAt?.getTime() ?? null,
                dispatchStarted: intent.deleteDispatchStartedAt !== null,
                verified: intent.reasons.some(
                  (reason) =>
                    (reason.metadata as Record<string, unknown> | null)
                      ?.moderationDeleteVerified === true,
                ),
              })),
              deletes: (deletesByMessage.get(event.messageId) ?? []).map((effect) => ({
                botId: effect.botId,
                observedAtMs: effect.observedAtMs,
              })),
              messagePresent: await harness.hasSimulatedMessage(event.messageId),
            });
          }
          return evaluateCatalogOutcomes(
            expectedManifest,
            observations,
            harness.bots.map((bot) => bot.id),
            latencyTargets,
            Date.now(),
          );
        };
        const manifest = {
          version: 1,
          sha256: createHash('sha256').update(JSON.stringify(expectedManifest)).digest('hex'),
          events: expectedManifest,
        };
        failureSnapshot = async (error) => {
          const effectsComplete = harness.snapshotEffects
            ? await harness.snapshotEffects().catch(() => false)
            : true;
          return {
            status: 'failed',
            catalog,
            bots,
            routing,
            profile,
            enqueueCapacity: harness.capacity,
            failureCode:
              error instanceof Error && error.name === 'MaxApiInternalRateLimitError'
                ? 'internal_quota'
                : 'benchmark_failed',
            logicalMessagesSubmitted: messageIds.length,
            expectedDeletesSubmitted: messageIds.filter((id) => expectedDeleteIds.has(id)).length,
            expectedKeptSubmitted: messageIds.filter((id) => !expectedDeleteIds.has(id)).length,
            manifest,
            outcomeAcceptance: await collectOutcomeAcceptance(),
            quotas: { perTokenRps: tokenRps, globalBurst: 0 },
            receipts: receiptIds.length,
            requestedLogicalRatePerSec: rate,
            elapsedMs: Math.round(performance.now() - startedAt),
            pendingReceipts: await countFixtureBatches(receiptIds, (ids) =>
              harness.prisma.webhookEvent.count({
                where: { id: { in: ids }, status: { in: ['RECEIVED', 'QUEUED', 'FAILED'] } },
              }),
            ),
            pendingActions: await harness.prisma.moderationDeleteIntent.count({
              where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
            }),
            effectsComplete,
            remoteDeletesObserved: harness.effects
              .filter((effect) => !beforeEffectIds.has(effect.callId))
              .filter((effect) => effect.method === 'delete').length,
          };
        };
        const pump = (async () => {
          try {
            while (producing) {
              // Keep whole-fixture accounting out of every admission tick. The bounded
              // sampling below and final drain still inspect pending work and effects.
              await harness.pumpWork();
              await wait(10);
            }
            await harness.drain(60_000);
          } catch (error) {
            pumpError = error;
          }
        })();
        try {
          for (let index = 0; index < messageCount; index += 1) {
            if (pumpError) throw pumpError;
            const event = expectedManifest[index]!;
            const { chatId, messageId, executorId } = event;
            if (profile === 'cold') {
              harness.links.forgetChatBotBinding(chatId);
              await harness.cache.invalidate(chatId);
              await harness.prisma.chatBotMembership.updateMany({
                where: { chatId },
                data: {
                  botAccessCheckedAt: new Date(Date.now() - 6 * 60_000),
                  botAccessExpiresAt: new Date(Date.now() - 1_000),
                },
              });
            }
            messageIds.push(messageId);
            const violation = event.decision === 'DELETE';
            touchedChatIds.add(chatId);
            expectedExecutors.set(messageId, executorId);
            const at = Date.now();
            const enteredAt = performance.now();
            ingressClocks.set(messageId, at);
            producerLatenessMs.push(Math.max(0, enteredAt - (startedAt + (index * 1000) / rate)));
            const mirrorResults = await Promise.allSettled(
              harness.bots.map((bot) =>
                harness.ingest({
                  chatId,
                  messageId,
                  botId: bot.id,
                  at,
                  text: violation ? `Local catalog length violation ${caseId} ${index}` : 'Hello',
                  ...(profile === 'media'
                    ? {
                        attachments: [
                          {
                            type: 'image',
                            payload: {
                              url: 'https://max-harness.invalid/photo.jpg',
                              photo_id: messageId,
                            },
                          },
                        ],
                      }
                    : {}),
                }),
              ),
            );
            const mirrors = mirrorResults.flatMap((result) =>
              result.status === 'fulfilled' ? [result.value] : [],
            );
            receiptsByMessage.set(messageId, mirrors);
            receiptIds.push(...mirrors);
            const rejected = mirrorResults.find((result) => result.status === 'rejected');
            if (rejected?.status === 'rejected') throw rejected.reason;
            for (const id of mirrors) unsettledReceiptIds.add(id);
            ingressLatencyMs.push(performance.now() - enteredAt);
            if (index % 10 === 0) {
              // Observe only receipts not yet seen terminal; final checks still read every ID.
              const trackedIds = [...unsettledReceiptIds];
              const [receiptRows, pendingActions, oldestAction] = await Promise.all([
                collectFixtureBatches(trackedIds, (ids) =>
                  harness.prisma.webhookEvent.findMany({
                    where: { id: { in: ids } },
                    select: { id: true, status: true, createdAt: true },
                  }),
                ),
                harness.prisma.moderationDeleteIntent.count({
                  where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
                }),
                harness.prisma.moderationDeleteIntent.findFirst({
                  where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
                  orderBy: { createdAt: 'asc' },
                  select: { createdAt: true },
                }),
              ]);
              if (receiptRows.length !== trackedIds.length)
                throw new Error('Fixture receipt observation is incomplete');
              let pending = 0;
              let oldest: { createdAt: Date } | null = null;
              for (const row of receiptRows) {
                if (['RECEIVED', 'QUEUED', 'FAILED'].includes(row.status)) {
                  pending += 1;
                  if (!oldest || row.createdAt < oldest.createdAt) oldest = row;
                } else unsettledReceiptIds.delete(row.id);
              }
              peakPendingReceipts = Math.max(peakPendingReceipts, pending);
              peakOldestReceiptAgeMs = Math.max(
                peakOldestReceiptAgeMs,
                oldest ? Date.now() - oldest.createdAt.getTime() : 0,
              );
              peakPendingActions = Math.max(peakPendingActions, pendingActions);
              peakOldestActionAgeMs = Math.max(
                peakOldestActionAgeMs,
                oldestAction ? Date.now() - oldestAction.createdAt.getTime() : 0,
              );
            }
            await wait(Math.max(0, startedAt + ((index + 1) * 1000) / rate - performance.now()));
          }
        } finally {
          productionFinishedAt = performance.now();
          producing = false;
          await pump;
        }
        if (pumpError) throw pumpError;
        const finishedAt = performance.now();
        const elapsedMs = finishedAt - startedAt;
        const owned = await countFixtureBatches(receiptIds, (ids) =>
          harness.prisma.webhookExecutionClaim.count({
            where: { kind: 'EXECUTION', webhookEventId: { in: ids }, status: 'COMPLETED' },
          }),
        );
        const violations =
          (await harness.prisma.violation.count({ where: { chatId: { in: chats } } })) -
          beforeViolations;
        const intents = await harness.prisma.moderationDeleteIntent.count({
          where: { messageId: { in: messageIds } },
        });
        const observedEffects = harness.effects.filter(
          (effect) => !beforeEffectIds.has(effect.callId),
        );
        const unexpectedMutations = observedEffects.filter(
          (effect) => effect.method !== 'delete' || effect.path !== '/messages',
        ).length;
        const deletes = observedEffects.filter(
          (effect) => effect.method === 'delete' && effect.path === '/messages',
        );
        const finalPendingReceipts = await countFixtureBatches(receiptIds, (ids) =>
          harness.prisma.webhookEvent.count({
            where: { id: { in: ids }, status: { notIn: ['PROCESSED', 'DUPLICATE'] } },
          }),
        );
        const wrongExecutorEffects = deletes.filter(
          (effect) => !effect.messageId || expectedExecutors.get(effect.messageId) !== effect.botId,
        ).length;
        const unexpectedDeletions = deletes.filter(
          (effect) => !effect.messageId || !expectedDeleteIds.has(effect.messageId),
        ).length;
        const expectedDeletes = expectedDeleteIds.size;
        const successfulIntents = await harness.prisma.moderationDeleteIntent.count({
          where: { messageId: { in: messageIds }, status: ModerationDeleteIntentStatus.SUCCEEDED },
        });
        const violationClaims = await harness.prisma.moderationViolationMessageClaim.findMany({
          where: {
            chatId: { in: [...touchedChatIds] },
            messageId: { in: messageIds },
            ruleCode: 'MESSAGE_TOO_LONG',
          },
          select: { messageId: true },
          take: messageCount + 1,
        });
        const violationClaimIds = new Set(violationClaims.map((claim) => claim.messageId));
        const finalPendingActions = await harness.prisma.moderationDeleteIntent.count({
          where: { messageId: { in: messageIds }, status: { in: pendingActionStatuses } },
        });
        const completions = await collectFixtureBatches(receiptIds, (ids) =>
          harness.prisma.webhookEvent.findMany({
            where: { id: { in: ids }, status: 'PROCESSED' },
            select: { createdAt: true, processedAt: true },
          }),
        );
        const completionLatencyMs = completions
          .map((event) => (event.processedAt?.getTime() ?? NaN) - event.createdAt.getTime())
          .sort((a, b) => a - b);
        const completedActions = await harness.prisma.moderationDeleteIntent.findMany({
          where: { messageId: { in: messageIds }, status: ModerationDeleteIntentStatus.SUCCEEDED },
          select: { createdAt: true, completedAt: true },
        });
        const actionLatencyMs = completedActions
          .map((intent) =>
            Math.max(0, (intent.completedAt?.getTime() ?? Date.now()) - intent.createdAt.getTime()),
          )
          .sort((a, b) => a - b);
        const outcomeAcceptance = await collectOutcomeAcceptance();
        if (
          outcomeAcceptance.correctnessStatus === 'failed' ||
          finalPendingReceipts ||
          finalPendingActions ||
          wrongExecutorEffects ||
          unexpectedDeletions ||
          unexpectedMutations ||
          successfulIntents !== expectedDeletes ||
          violationClaims.length !== expectedDeletes ||
          violationClaimIds.size !== expectedDeletes ||
          [...expectedDeleteIds].some((id) => !violationClaimIds.has(id)) ||
          owned !== messageCount ||
          violations !== expectedDeletes ||
          intents !== expectedDeletes ||
          deletes.length !== expectedDeletes ||
          new Set(deletes.map((effect) => effect.messageId)).size !== expectedDeletes
        ) {
          throw new Error(
            `Logical authority/effect mismatch: messages=${messageCount}, expectedDeletes=${expectedDeletes}, unexpectedDeletions=${unexpectedDeletions}, unexpectedMutations=${unexpectedMutations}, claims=${owned}, violations=${violations}, violationClaims=${violationClaims.length}, uniqueViolationClaims=${violationClaimIds.size}, intents=${intents}, successfulIntents=${successfulIntents}, deletes=${deletes.length}, wrongExecutorEffects=${wrongExecutorEffects}, pendingReceipts=${finalPendingReceipts}, pendingActions=${finalPendingActions}`,
          );
        }
        ingressLatencyMs.sort((a, b) => a - b);
        producerLatenessMs.sort((a, b) => a - b);
        const latencyAcceptance = evaluateCatalogLatency(
          completionLatencyMs,
          messageCount,
          latencyTargets,
        );
        const report = {
          status:
            latencyAcceptance.status === 'failed' || outcomeAcceptance.status === 'failed'
              ? 'failed'
              : 'passed',
          correctnessStatus: 'passed',
          syntheticWorkload: {
            violationPercent,
            expectedDeletes,
            expectedKept: messageCount - expectedDeletes,
            measuredProductionMix: false,
          },
          unexpectedDeletions,
          unexpectedMutations,
          latencyAcceptance,
          outcomeAcceptance,
          manifest,
          catalog,
          bots,
          routing,
          profile,
          enqueueCapacity: harness.capacity,
          logicalMessages: messageCount,
          receipts: receiptIds.length,
          executorDistribution:
            routing === 'fixed'
              ? 'round-robin fixed assignments across fixture bots; no automatic takeover'
              : 'all chats share one healthy primary; other configured bots are reserves',
          wrongExecutorEffects,
          executorsExercised: new Set(deletes.map((effect) => effect.botId)).size,
          quotas: {
            perTokenRps: tokenRps,
            globalBurst: 0,
            perBotChatRps: 5,
            managedRefreshRps: 2,
            perTargetMutationRps: 2,
          },
          requestedLogicalRatePerSec: rate,
          requestedReceiptRatePerSec: rate * bots,
          actualReceiptIngressRatePerSec: Number(
            ((receiptIds.length * 1000) / (productionFinishedAt - startedAt)).toFixed(2),
          ),
          producerLatenessP95Ms: Math.round(
            producerLatenessMs[Math.floor(producerLatenessMs.length * 0.95)] ?? 0,
          ),
          elapsedMs: Math.round(elapsedMs),
          submissionElapsedMs: Math.round(productionFinishedAt - startedAt),
          drainMs: Math.round(finishedAt - productionFinishedAt),
          observedLogicalRatePerSec: Number(((messageCount * 1000) / elapsedMs).toFixed(2)),
          seedMs: Math.round(seedMs),
          ingressP95Ms: Math.round(
            ingressLatencyMs[Math.floor(ingressLatencyMs.length * 0.95)] ?? 0,
          ),
          completionP95Ms: latencyAcceptance.p95Ms,
          completionP99Ms: latencyAcceptance.p99Ms,
          actionP95Ms: actionLatencyMs[Math.floor(actionLatencyMs.length * 0.95)] ?? 0,
          actionP99Ms: actionLatencyMs[Math.floor(actionLatencyMs.length * 0.99)] ?? 0,
          sampledPeakPendingReceipts: peakPendingReceipts,
          sampledPeakOldestReceiptAgeMs: peakOldestReceiptAgeMs,
          sampledPeakPendingActions: peakPendingActions,
          sampledPeakOldestActionAgeMs: peakOldestActionAgeMs,
          backlogSampling: 'every 10 logical ingress messages; drain peaks excluded',
          finalPendingReceipts,
          finalPendingActions,
          maxRequests: harness.requests.length - beforeRequests,
          claims: owned,
          violations,
          intents,
          successfulIntents,
          uniqueViolationMessageClaims: violationClaimIds.size,
          remoteDeletes: deletes.length,
          ...(harness.roleReports
            ? {
                processRoles: harness.roleReports.map(
                  ({ effects: _effects, requests: _requests, ...role }) => role,
                ),
              }
            : {}),
          mediaScope:
            profile === 'media'
              ? 'attachment ingress and text/length rules; native IMAGE/OCR capacity excluded'
              : null,
        };
        reports.push(report);
        process.stdout.write(`${JSON.stringify(report)}\n`);
        await saveReports();
        if (latencyAcceptance.status === 'failed' || outcomeAcceptance.status === 'failed')
          process.exitCode = 1;
        failureSnapshot = undefined;
      }
    } catch (error) {
      const failed = failureSnapshot
        ? await failureSnapshot(error).catch(() => ({
            status: 'failed',
            catalog,
            failureCode: 'snapshot_unavailable',
          }))
        : { status: 'failed', catalog, failureCode: 'catalog_initialization_failed' };
      reports.push(failed);
      process.stdout.write(`${JSON.stringify(failed)}\n`);
      await saveReports();
      throw error;
    } finally {
      await harness.dispose();
    }
  }
}

async function saveReports() {
  const result = {
    measuredAt: new Date().toISOString(),
    node: process.version,
    hardware: {
      platform: process.platform,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
    },
    transport: 'local simulated MAX with explicitly recorded token quota; no external requests',
    fixtureTopology: {
      processes: topology === 'split' ? 10 : 1,
      outboxSelection:
        enqueue === 'production' ? 'production enqueueBatch' : 'fixture receipt list',
      systemMode: 'controlled normal; production governor not exercised',
      productionOutboxPollFloorMs: enqueue === 'production' ? 200 : null,
      physicalWebhookQueues: topology === 'split' ? 23 : 1,
      physicalDeleteQueues: 1,
      webhookWorkerConcurrency:
        topology === 'split'
          ? 'static runtime groups: 16 default slots, 4 join, 4 critical, 2 background, 1 legacy'
          : 4,
      deleteWorkerConcurrency: topology === 'split' ? 2 : 4,
      deleteDueSweepIntervalMs: 1000,
      defaultShardNames: 16,
      dynamicLeaseWorkers: false,
      nativeMedia: false,
    },
    tokenQuota: { perTokenRps: tokenRps, globalBurst: 0 },
    quotaServiceLanes:
      topology === 'split'
        ? { criticalRps: 12, interactiveRps: 10, backgroundRps: '4; action/background roles 3' }
        : {
            criticalRps: Math.floor(tokenRps * 0.45),
            interactiveRps: Math.floor(tokenRps * 0.35),
            backgroundRps: tokenRps - Math.floor(tokenRps * 0.45) - Math.floor(tokenRps * 0.35),
          },
    workload: {
      kind: 'synthetic_length_rule',
      violationPercent,
      distribution: 'evenly spaced per expected executor; other messages must remain intact',
      measuredProductionMix: false,
      limitations:
        'all bots mirror every message; native media and other product decisions excluded',
    },
    scope:
      'finite synthetic local profiles, not a production capacity certificate or 24-hour sustained-load acceptance',
    reports,
  };
  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`);
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
