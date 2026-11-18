import { DEFAULT_WEBHOOK_WORKER_GROUP_NAMES } from '../runtime/runtime-topology';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BotOwnershipFoundationSnapshot,
  SystemDashboardAlert,
  SystemDashboardResponse,
  SystemDashboardStatus,
  WebhookSubscriptionSnapshot,
} from '@maxim/contracts/system';
import { MaxBotOwnershipFoundationService } from '../max/max-bot-ownership-foundation.service';
import {
  classifyChannelSuggestionPublicationLedgerAudit,
  classifyChannelSuggestionPublicationRecovery,
  type ChannelSuggestionPublicationLedgerAuditDecision,
  type ChannelSuggestionPublicationLedgerRow,
} from '../admin/admin-channel-suggestion-publication-protocol';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
} from '../max/max-action.queue';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DEFAULT_WEBHOOK_P95_TARGET_MS,
  buildSystemCanaryState,
  getSystemLeaseFleet,
  buildSystemQueueGroupHealth,
  buildSystemRollbackReadiness,
  buildSystemRuntimeProfile,
} from '../runtime/runtime-reliability-profile';
import { ActionLatencyService } from './action-latency.service';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';
import { QueueMetricsService } from './queue-metrics.service';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { SystemModeService } from './system-mode.service';
import { WebhookSloService, type WebhookSloSnapshot } from './webhook-slo.service';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';

const QUEUE_LAG_WARNING_SEC = 5;
const FAILED_EVENTS_CRITICAL_COUNT = 100;
const ACTION_RATE_WARNING_THRESHOLD = 0.02;
const ACTION_RATE_CRITICAL_THRESHOLD = 0.05;
const ACTION_ERROR_MIN_TOTAL = 100;
const MAX_API_CRITICAL_LIMITER_WARNING_MIN_REJECTS = 3;
const MAX_API_CRITICAL_LIMITER_WARNING_BASE_WINDOW_SEC = 10 * 60;
const DEFAULT_WORKER_SKEW_WARNING_PRESSURE = 4;
const DEFAULT_WORKER_SKEW_WARNING_RATIO = 0.7;
const DEFAULT_WORKER_SKEW_CRITICAL_PRESSURE = 8;
const DEFAULT_WORKER_SKEW_CRITICAL_RATIO = 0.85;
const JOIN_BURST_WARNING_PRESSURE = 6;
const JOIN_BURST_CRITICAL_PRESSURE = 16;
const VK_PARSING_HEALTH_WINDOW_MIN = 30;
const VK_PARSING_SOURCE_FAILURE_WARNING_COUNT = 3;
const VK_PARSING_MEDIA_FAILURE_WARNING_RATIO = 0.2;
const VK_PARSING_PUBLISH_BACKLOG_WARNING_SEC = 10 * 60;
const DELIVERY_LEDGER_STALE_ACTION_MS = 15 * 60_000;
const DELIVERY_LEDGER_AUTO_DELETE_ACCESS_AMBIGUOUS_WINDOW_MS = 24 * 60 * 60_000;
const DELIVERY_LEDGER_STALE_BROADCAST_SENDING_MS = 5 * 60_000;
const DELIVERY_LEDGER_STALE_SUGGESTION_SENDING_MS = 2 * 60_000;
const SUGGESTION_PUBLICATION_STALE_MS = 15 * 60_000;
const SUGGESTION_PUBLICATION_AUDIT_LIMIT = 1_000;
const SUGGESTION_PUBLICATION_LEDGER_PAGE_SIZE = 250;
const SUGGESTION_PUBLICATION_LEDGER_SCAN_LIMIT = 2_000;
const DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT = 1_000;
const DELIVERY_LEDGER_WAITING_CAPABILITY_WARNING_MS = 5 * 60_000;
const HOT_PATH_SLOW_WARNING_COUNT = 3;
const HOT_PATH_SLOW_WARNING_MAX_MS = 5_000;
const NIGHT_MODE_RECONCILE_RISK_LIMIT = 1_000;
const NIGHT_MODE_RECONCILE_ALERT_GRACE_MS = 60_000;

type VkParsingGuardSnapshot = {
  checkedAt: string;
  windowMin: number;
  activeSources: number;
  sourceFailureCount: number;
  circuitOpenSources: number;
  recentMediaChecks: number;
  recentMediaFailures: number;
  recentMediaFailureRatio: number;
  publishBacklog: number;
  oldestPublishBacklogAgeSec: number;
};

type DeliveryLedgerRiskSnapshot = {
  checkedAt: string;
  actionAmbiguous: number;
  actionStaleInProgress: number;
  actionStaleRetryable: number;
  actionOldestRiskAgeSec: number;
  actionRecentAutoDeleteAccessAmbiguous: number;
  actionOldestAutoDeleteAccessAmbiguousAgeSec: number;
  broadcastAmbiguous: number;
  broadcastStaleSending: number;
  broadcastRiskBroadcasts: number;
  broadcastOldestRiskAgeSec: number;
  suggestionAmbiguous: number;
  suggestionTerminalFailed: number;
  suggestionStaleSending: number;
  suggestionRiskSuggestions: number;
  suggestionOldestRiskAgeSec: number;
  deleteIntentSafelyExpirable: number;
  deleteIntentStaleExpiredInProgress: number;
  deleteIntentOldestExpiredAgeSec: number;
  deleteIntentRiskCapped: boolean;
  deleteIntentStaleExpiredInProgressCapped: boolean;
  deleteIntentAgedWaitingCapability: number;
  deleteIntentAgedWaitingCapabilityChats: number;
  deleteIntentOldestWaitingCapabilityAgeSec: number;
  deleteIntentAgedWaitingCapabilityCapped: boolean;
};

type SuggestionPublicationProtocolSnapshot = {
  checkedAt: string;
  publishing: {
    safeRelease: number;
    completed: number;
    manual: number;
    legacy: number;
    audited: number;
    oldestAgeSec: number;
    capped: boolean;
  };
  ledgerAudit: {
    missingAudit: number;
    pendingAudit: number;
    publishedAudit: number;
    mismatchedAudit: number;
    linkedPublishing: number;
    audited: number;
    oldestAgeSec: number;
    capped: boolean;
  };
};

type SuggestionPublishingAuditRow = {
  suggestionId: string;
  chatId: string;
  actorUserId: string;
  createdAt: Date;
  claimAt: Date;
  payload: unknown;
  jobId: string | null;
  actionType: string | null;
  ledgerChatId: string | null;
  sourceTag: string | null;
  status: string | null;
  ambiguous: boolean | null;
  terminal: boolean | null;
  dispatchToken: string | null;
  dispatchStartedAt: Date | null;
  dispatchBotId: string | null;
  remoteMessageId: string | null;
  metadata: unknown;
};

type SuggestionLedgerAuditRow = {
  ledgerId: string;
  updatedAt: Date;
  jobId: string;
  actionType: string;
  ledgerChatId: string;
  sourceTag: string | null;
  status: string;
  ambiguous: boolean;
  terminal: boolean;
  dispatchToken: string | null;
  dispatchStartedAt: Date | null;
  dispatchBotId: string | null;
  remoteMessageId: string | null;
  metadata: unknown;
  auditId: string | null;
  auditChatId: string | null;
  actorUserId: string | null;
  auditAction: string | null;
  payload: unknown;
};

type SuggestionLedgerAuditPageParams = {
  checkedAt: Date;
  cursor: Pick<SuggestionLedgerAuditRow, 'ledgerId' | 'updatedAt'> | null;
  take: number;
};

type NightModeReconcileRiskSnapshot = {
  checkedAt: string;
  manualBlocked: number;
  unsafePriorDispatch: number;
  unsafePriorProvenance: number;
  noFreshAccess: number;
  failedJobUnclassified: number;
  agedDue: number;
  staleLeases: number;
  oldestManualBlockedAgeSec: number;
  oldestDueAgeSec: number;
  oldestStaleLeaseAgeSec: number;
  manualCapped: boolean;
  dueCapped: boolean;
  staleLeaseCapped: boolean;
};

@Injectable()
export class SystemDashboardService {
  private readonly logger = new Logger(SystemDashboardService.name);
  private readonly queueLagCriticalThresholdSec: number;
  private readonly webhookSloTargetMs: number;
  private readonly actionCriticalBacklogThreshold: number;

  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    configService: ConfigService,
    @Optional()
    private readonly webhookSubscriptionStatusService?: WebhookSubscriptionStatusService,
    @Optional()
    private readonly ownershipFoundationService?: MaxBotOwnershipFoundationService,
    @Optional()
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly webhookSloService?: WebhookSloService,
    @Optional()
    private readonly prisma?: PrismaService,
    @Optional()
    private readonly actionLatencyService?: ActionLatencyService,
    @Optional()
    @Inject(WebhookDynamicLeaseStatusService)
    private readonly dynamicLeaseStatusService?: Pick<
      WebhookDynamicLeaseStatusService,
      'getHeartbeatObservation'
    >,
  ) {
    this.queueLagCriticalThresholdSec = configService.get<number>('QUEUE_LAG_DEGRADE_SEC', 10);
    this.webhookSloTargetMs = configService.get<number>(
      'SYSTEM_WEBHOOK_SLO_TARGET_MS',
      DEFAULT_WEBHOOK_P95_TARGET_MS,
    );
    this.actionCriticalBacklogThreshold =
      Math.max(1, configService.get<number>('MAX_ACTION_CRITICAL_CONCURRENCY', 3)) * 2;
  }

  async getSnapshot(): Promise<SystemDashboardResponse> {
    const webhookSubscriptionPromise = this.webhookSubscriptionStatusService
      ? this.webhookSubscriptionStatusService.getSnapshot()
      : Promise.resolve(this.buildFallbackWebhookSubscriptionSnapshot());
    const ownershipPromise = this.ownershipFoundationService
      ? this.ownershipFoundationService.getSnapshot()
      : Promise.resolve(this.buildFallbackOwnershipSnapshot());
    const [queues, mode, webhookSubscription, ownership, leaseHeartbeats] = await Promise.all([
      this.queueMetricsService.getSnapshot(),
      this.systemModeService.getEffectiveSnapshot(),
      webhookSubscriptionPromise,
      ownershipPromise,
      this.dynamicLeaseStatusService?.getHeartbeatObservation(),
    ]);
    await this.runtimeDiagnosticsService?.recordQueueLagSnapshot({
      queues,
      mode,
    });
    const [runtimeDiagnostics, backgroundBudget, criticalLimiter, webhookSlo, actionLatency] =
      await Promise.all([
        this.runtimeDiagnosticsService?.getDashboardSnapshot(),
        this.backgroundRuntimeGovernorService?.getDashboardBudgetSummary(),
        this.backgroundRuntimeGovernorService
          ?.getCriticalLimiterSnapshot?.()
          ?.catch((error: unknown) => {
            this.logger.warn(
              { err: error instanceof Error ? error.message : String(error) },
              'Critical limiter dashboard snapshot is unavailable; response remains fail-soft',
            );
            return undefined;
          }),
        this.webhookSloService?.getSnapshot(),
        this.actionLatencyService?.getSnapshot().catch((error: unknown) => {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'Action latency dashboard snapshot is unavailable; response remains fail-soft',
          );
          return undefined;
        }),
      ]);
    const [
      vkParsingGuard,
      deliveryLedgerRisk,
      suggestionPublicationProtocol,
      nightModeReconcileRisk,
    ] = await Promise.all([
      this.loadVkParsingGuardSnapshot(),
      this.loadDeliveryLedgerRiskSnapshot(),
      this.loadSuggestionPublicationProtocolSnapshot(),
      this.loadNightModeReconcileRiskSnapshot(),
    ]);
    const alerts: SystemDashboardAlert[] = [];
    const queueLagSec = queues.userFacingEffectiveLagSec ?? queues.effectiveLagSec;
    const failedCount = this.readActiveFailedCount(queues.webhookEvents.failed);
    const staleFailedCount = this.readStaleFailedCount(queues.webhookEvents.failed, failedCount);
    const failedWindowSec = queues.webhookEvents.failed.activeWindowSec ?? null;
    const criticalRate = mode.action.criticalRate;
    const errorRate = mode.action.errorRate;
    const stabilizing = this.isStabilizing(mode, queueLagSec);
    const hotPathTimeoutCount =
      runtimeDiagnostics?.hotPath.stages.reduce((sum, stage) => sum + stage.timeoutCount, 0) ?? 0;
    const hotPathSlowWarning = this.hasHotPathSlowWarning(runtimeDiagnostics?.hotPath);

    if (mode.source === 'manual') {
      alerts.push({
        code: 'manual-mode',
        level: 'info',
        title: 'Включён ручной режим',
        detail:
          mode.manualMode === 'degrade'
            ? 'Система удерживается в degrade вручную, даже если очереди уже выровнялись.'
            : 'Система зафиксирована в normal вручную. Автоматическое переключение временно отключено.',
        recommendedAction: 'Проверьте инцидент и верните режим в auto после стабилизации.',
      });
    }

    if (queueLagSec > QUEUE_LAG_WARNING_SEC) {
      const critical = queueLagSec > this.queueLagCriticalThresholdSec;
      alerts.push({
        code: 'queue-lag',
        level: critical ? 'critical' : 'warning',
        title: critical ? 'Очередь начала отставать' : 'Есть задержка в очереди',
        detail: `Старейшее событие ждёт обработки ${queueLagSec.toFixed(1)} сек.`,
        recommendedAction:
          'Проверьте backlog webhook events и rate limit MAX API. Если lag растёт, снижайте background-нагрузку.',
      });
    }

    if (failedCount > 0) {
      const critical = failedCount >= FAILED_EVENTS_CRITICAL_COUNT;
      alerts.push({
        code: 'failed-webhooks',
        level: critical ? 'critical' : 'warning',
        title: critical ? 'Есть заметный хвост failed webhook' : 'Появились failed webhook',
        detail: this.buildFailedWebhookAlertDetail(failedCount, staleFailedCount, failedWindowSec),
        recommendedAction:
          'Посмотрите последние ошибки доставки/обработки и очистите только подтверждённо мёртвые записи.',
      });
    }

    if (criticalRate > ACTION_RATE_WARNING_THRESHOLD) {
      const critical = criticalRate >= ACTION_RATE_CRITICAL_THRESHOLD;
      alerts.push({
        code: 'critical-rate',
        level: critical ? 'critical' : 'warning',
        title: critical ? 'MAX critical rate выше нормы' : 'MAX critical rate растёт',
        detail: `Критичные ошибки MAX API за окно: ${(criticalRate * 100).toFixed(2)}%.`,
        recommendedAction:
          'Защитите critical-трафик: режьте interactive/background запросы и проверяйте route split.',
      });
    }

    if (mode.action.total >= ACTION_ERROR_MIN_TOTAL && errorRate > ACTION_RATE_WARNING_THRESHOLD) {
      alerts.push({
        code: 'action-error-rate',
        level: 'warning',
        title: 'Растёт доля ошибок action-path',
        detail: `Общий error rate за окно: ${(errorRate * 100).toFixed(2)}%.`,
        recommendedAction:
          'Проверьте timeout и retries на MAX API, затем сопоставьте со всплесками UI или moderation-трафика.',
      });
    }

    if (stabilizing) {
      alerts.push({
        code: 'stabilizing',
        level: 'info',
        title: 'Система в окне стабилизации',
        detail:
          'Основные метрики уже выровнялись, но auto-mode ещё держит degrade до завершения защитного окна.',
        recommendedAction:
          'Наблюдайте за lag и critical rate. Если они остаются низкими, система вернётся в normal автоматически.',
      });
    }

    const webhookSubscriptionAlert = this.buildWebhookSubscriptionAlert(webhookSubscription);
    if (webhookSubscriptionAlert) {
      alerts.push(webhookSubscriptionAlert);
    }

    const runtimeProfile = buildSystemRuntimeProfile(
      webhookSlo?.targetProcessingMs ?? this.webhookSloTargetMs,
    );
    const fleet = getSystemLeaseFleet(queues, runtimeProfile, leaseHeartbeats);
    // The cached group totals may still be attributed to owners from the rejected summary.
    const rejectedLeaseSummary = Boolean(queues.webhookDynamicLeases && !fleet.snapshot);
    const defaultWorkerSkewAlert = this.buildDefaultWorkerSkewAlert(
      rejectedLeaseSummary ? undefined : queues.webhookDefaultWorkerGroups,
    );
    if (defaultWorkerSkewAlert) {
      alerts.push(defaultWorkerSkewAlert);
    }
    const dynamicLeaseAlert = fleet.monitor ? this.buildDynamicLeaseAlert(fleet.snapshot) : null;
    if (dynamicLeaseAlert) alerts.push(dynamicLeaseAlert);
    const workerWarning =
      fleet.monitor &&
      (!fleet.consensus || fleet.mixed || fleet.summaryConflict || !fleet.summaryMode);
    if (workerWarning) {
      const count = fleet.liveWorkerGroups.length;
      const expected = DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.length;
      alerts.push({
        code: 'dynamic-lease-worker-pool',
        level: 'warning',
        title: 'Требуется проверка групп обработки сообщений',
        detail: fleet.mixed
          ? 'Группы обработки сообщают разные режимы перераспределения очередей.'
          : fleet.summaryConflict
            ? 'Режим в сводке очередей расходится со свежими отметками групп обработки.'
            : fleet.unreadable > 0
              ? `Подтверждено групп: ${count} из ${expected}. Для остальных нет достоверных данных.`
              : count < expected
                ? `Свежие отметки получены от ${count} из ${expected} групп.`
                : 'Все группы ответили, но свежая сводка очередей недоступна.',
        recommendedAction: 'Проверьте группы обработки перед расширением пробного режима.',
      });
    }

    const joinBurstAlert = this.buildJoinBurstAlert(
      (
        queues as {
          webhookJoin?: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['webhookJoin'];
        }
      ).webhookJoin,
      queueLagSec,
    );
    if (joinBurstAlert) {
      alerts.push(joinBurstAlert);
    }

    const ownershipRepairAlert = this.buildOwnershipRepairAlert(ownership);
    if (ownershipRepairAlert) {
      alerts.push(ownershipRepairAlert);
    }

    const ownershipRebalanceAlert = this.buildOwnershipRebalanceAlert(ownership);
    if (ownershipRebalanceAlert) {
      alerts.push(ownershipRebalanceAlert);
    }

    const ownershipCoverageAlert = this.buildOwnershipCoverageAlert(ownership);
    if (ownershipCoverageAlert) {
      alerts.push(ownershipCoverageAlert);
    }

    const problemChatsAlert = this.buildProblemChatsAlert(runtimeDiagnostics?.problemChats);
    if (problemChatsAlert) {
      alerts.push(problemChatsAlert);
    }

    const hotPathAlert = this.buildHotPathAlert(runtimeDiagnostics?.hotPath);
    if (hotPathAlert) {
      alerts.push(hotPathAlert);
    }

    const webhookSloAlert = this.buildWebhookSloAlert(webhookSlo);
    if (webhookSloAlert) {
      alerts.push(webhookSloAlert);
    }

    const criticalLimiterAlert = this.buildCriticalLimiterAlert(criticalLimiter);
    if (criticalLimiterAlert) {
      alerts.push(criticalLimiterAlert);
    }

    const vkParsingAlert = this.buildVkParsingHealthAlert(vkParsingGuard);
    if (vkParsingAlert) {
      alerts.push(vkParsingAlert);
    }

    const actionQueueLaneAlert = this.buildActionQueueLaneAlert(queues.actionQueues);
    if (actionQueueLaneAlert) {
      alerts.push(actionQueueLaneAlert);
    }

    const actionLedgerWatchdogAlert = this.buildActionLedgerWatchdogAlert(
      queues.actionLedgerWatchdog,
    );
    if (actionLedgerWatchdogAlert) {
      alerts.push(actionLedgerWatchdogAlert);
    }

    const deliveryLedgerAlert = this.buildDeliveryLedgerRiskAlert(deliveryLedgerRisk);
    if (deliveryLedgerAlert) {
      alerts.push(deliveryLedgerAlert);
    }

    const suggestionPublishingAlert = this.buildSuggestionPublishingRiskAlert(
      suggestionPublicationProtocol,
    );
    if (suggestionPublishingAlert) {
      alerts.push(suggestionPublishingAlert);
    }

    const suggestionLedgerAuditAlert = this.buildSuggestionLedgerAuditAlert(
      suggestionPublicationProtocol,
    );
    if (suggestionLedgerAuditAlert) {
      alerts.push(suggestionLedgerAuditAlert);
    }

    const deleteCapabilityAlert = this.buildDeleteCapabilityBacklogAlert(deliveryLedgerRisk);
    if (deleteCapabilityAlert) {
      alerts.push(deleteCapabilityAlert);
    }

    const nightModeReconcileAlert = this.buildNightModeReconcileRiskAlert(nightModeReconcileRisk);
    if (nightModeReconcileAlert) {
      alerts.push(nightModeReconcileAlert);
    }

    const status = this.resolveStatus({
      mode: mode.mode,
      queueLagSec,
      failedCount,
      criticalRate,
      errorRate,
      webhookSubscriptionStatus: webhookSubscription.status,
      problemChatsCritical:
        runtimeDiagnostics?.problemChats?.items.some((item) => item.severity === 'critical') ??
        false,
      problemChatsWarning:
        runtimeDiagnostics?.problemChats?.items.some((item) => item.severity === 'warning') ??
        false,
      hotPathTimeoutCritical: hotPathTimeoutCount >= 10,
      hotPathTimeoutWarning: hotPathTimeoutCount > 0,
      hotPathSlowWarning,
      webhookSloStatus: webhookSlo?.status ?? null,
      criticalLimiterWarning: criticalLimiterAlert !== null,
      workerWarning,
      vkParsingWarning: vkParsingAlert !== null,
      actionQueueLaneCritical: actionQueueLaneAlert?.level === 'critical',
      actionQueueLaneWarning: actionQueueLaneAlert?.level === 'warning',
      actionLedgerWatchdogCritical: actionLedgerWatchdogAlert?.level === 'critical',
      actionLedgerWatchdogWarning: actionLedgerWatchdogAlert?.level === 'warning',
      deliveryLedgerWarning: deliveryLedgerAlert !== null,
      suggestionPublishingWarning:
        suggestionPublishingAlert !== null || suggestionLedgerAuditAlert !== null,
      deleteCapabilityWarning: deleteCapabilityAlert !== null,
      nightModeReconcileWarning: nightModeReconcileAlert !== null,
    });
    const queueGroupHealth = buildSystemQueueGroupHealth(queues);
    const canaryState = buildSystemCanaryState(
      {
        queues,
        dashboardStatus: status,
        queueLagSec,
        queueLagCriticalThresholdSec: this.queueLagCriticalThresholdSec,
        activeFailedWebhooks: failedCount,
        webhookSlo: webhookSlo ?? null,
      },
      runtimeProfile,
      fleet,
    );
    const rollbackReadiness = buildSystemRollbackReadiness({
      queues,
      dashboardStatus: status,
      queueLagSec,
      queueLagCriticalThresholdSec: this.queueLagCriticalThresholdSec,
      activeFailedWebhooks: failedCount,
      webhookSlo: webhookSlo ?? null,
    });

    return {
      summary: {
        status,
        title: this.buildSummaryTitle(status, stabilizing),
        detail: this.buildSummaryDetail(
          status,
          mode.reason,
          queueLagSec,
          failedCount,
          staleFailedCount,
          failedWindowSec,
          stabilizing,
        ),
        generatedAt: new Date().toISOString(),
        stabilizing,
      },
      alerts,
      queues: {
        ...queues,
        ...(rejectedLeaseSummary ? { webhookDefaultWorkerGroups: {} } : {}),
        webhookDynamicLeases: fleet.snapshot
          ? { ...fleet.snapshot, liveWorkerGroups: fleet.liveWorkerGroups }
          : null,
      },
      mode: {
        ...mode,
        condition: mode.condition ?? 'unknown',
      },
      webhookSubscription,
      ownership,
      runtimeProfile,
      canaryState,
      rollbackReadiness,
      queueGroupHealth,
      ...(runtimeDiagnostics
        ? {
            burst: runtimeDiagnostics.burst,
            hotPath: runtimeDiagnostics.hotPath,
            hotChats: runtimeDiagnostics.hotChats,
            membershipLookup: runtimeDiagnostics.membershipLookup,
            spammerSurfaces: runtimeDiagnostics.spammerSurfaces,
            spammerReadModel: runtimeDiagnostics.spammerReadModel,
            ...(runtimeDiagnostics.problemChats
              ? { problemChats: runtimeDiagnostics.problemChats }
              : {}),
          }
        : {}),
      ...(backgroundBudget ? { backgroundBudget } : {}),
      ...(webhookSlo ? { webhookSlo, slo: webhookSlo } : {}),
      ...(actionLatency ? { actionLatency } : {}),
    };
  }

  private resolveStatus(input: {
    mode: 'normal' | 'degrade';
    queueLagSec: number;
    failedCount: number;
    criticalRate: number;
    errorRate: number;
    webhookSubscriptionStatus: WebhookSubscriptionSnapshot['status'];
    problemChatsCritical?: boolean;
    problemChatsWarning?: boolean;
    hotPathTimeoutCritical?: boolean;
    hotPathTimeoutWarning?: boolean;
    hotPathSlowWarning?: boolean;
    webhookSloStatus?: WebhookSloSnapshot['status'] | null;
    criticalLimiterWarning?: boolean;
    workerWarning?: boolean;
    vkParsingWarning?: boolean;
    actionQueueLaneCritical?: boolean;
    actionQueueLaneWarning?: boolean;
    actionLedgerWatchdogCritical?: boolean;
    actionLedgerWatchdogWarning?: boolean;
    deliveryLedgerWarning?: boolean;
    suggestionPublishingWarning?: boolean;
    deleteCapabilityWarning?: boolean;
    nightModeReconcileWarning?: boolean;
  }): SystemDashboardStatus {
    if (
      input.mode === 'degrade' ||
      input.queueLagSec > this.queueLagCriticalThresholdSec ||
      input.failedCount >= FAILED_EVENTS_CRITICAL_COUNT ||
      input.criticalRate >= ACTION_RATE_CRITICAL_THRESHOLD ||
      input.webhookSubscriptionStatus === 'critical' ||
      input.problemChatsCritical === true ||
      input.hotPathTimeoutCritical === true ||
      input.actionQueueLaneCritical === true ||
      input.actionLedgerWatchdogCritical === true ||
      input.webhookSloStatus === 'critical'
    ) {
      return 'critical';
    }

    if (
      input.queueLagSec > QUEUE_LAG_WARNING_SEC ||
      input.failedCount > 0 ||
      input.criticalRate > ACTION_RATE_WARNING_THRESHOLD ||
      input.errorRate > ACTION_RATE_WARNING_THRESHOLD ||
      input.webhookSubscriptionStatus === 'warning' ||
      input.problemChatsWarning === true ||
      input.hotPathTimeoutWarning === true ||
      input.hotPathSlowWarning === true ||
      input.webhookSloStatus === 'warning' ||
      input.criticalLimiterWarning === true ||
      input.workerWarning === true ||
      input.vkParsingWarning === true ||
      input.actionQueueLaneWarning === true ||
      input.actionLedgerWatchdogWarning === true ||
      input.deliveryLedgerWarning === true ||
      input.suggestionPublishingWarning === true ||
      input.deleteCapabilityWarning === true ||
      input.nightModeReconcileWarning === true
    ) {
      return 'warning';
    }

    return 'healthy';
  }

  private buildSummaryTitle(status: SystemDashboardStatus, stabilizing: boolean): string {
    if (status === 'critical') {
      return stabilizing ? 'Система стабилизируется после инцидента' : 'Нужна реакция оператора';
    }

    if (status === 'warning') {
      return 'Система под нагрузкой, но управляемая';
    }

    return 'Бот работает ровно';
  }

  private buildSummaryDetail(
    status: SystemDashboardStatus,
    reason: string,
    queueLagSec: number,
    failedCount: number,
    staleFailedCount: number,
    failedWindowSec: number | null,
    stabilizing: boolean,
  ): string {
    if (status === 'healthy') {
      return 'Webhook-path чистый, backlog не копится, critical MAX budget не съедается UI-нагрузкой.';
    }

    const failedSummary = this.buildFailedSummary(failedCount, staleFailedCount, failedWindowSec);
    if (stabilizing) {
      return `Auto-mode ещё держит защитный degrade (${reason}), но backlog уже не растёт. Lag ${queueLagSec.toFixed(1)} сек, ${failedSummary}.`;
    }

    return `Причина текущего режима: ${reason}. Lag ${queueLagSec.toFixed(1)} сек, ${failedSummary}.`;
  }

  private readActiveFailedCount(metrics: { count: number; activeCount?: number }): number {
    return metrics.activeCount ?? metrics.count;
  }

  private readStaleFailedCount(
    metrics: { count: number; staleCount?: number },
    activeFailedCount: number,
  ): number {
    return metrics.staleCount ?? Math.max(0, metrics.count - activeFailedCount);
  }

  private buildFailedWebhookAlertDetail(
    activeFailedCount: number,
    staleFailedCount: number,
    windowSec: number | null,
  ): string {
    if (!windowSec || windowSec <= 0) {
      return `В статусе FAILED сейчас ${activeFailedCount} событий.`;
    }

    const windowLabel = this.formatShortTimeWindow(windowSec);
    if (staleFailedCount > 0) {
      return `За ${windowLabel} в статусе FAILED ${activeFailedCount} событий; ещё ${staleFailedCount} старых остаются хвостом.`;
    }

    return `За ${windowLabel} в статусе FAILED ${activeFailedCount} событий.`;
  }

  private buildFailedSummary(
    activeFailedCount: number,
    staleFailedCount: number,
    windowSec: number | null,
  ): string {
    if (!windowSec || windowSec <= 0) {
      return `failed ${activeFailedCount}`;
    }

    const windowLabel = this.formatShortTimeWindow(windowSec);
    if (staleFailedCount > 0) {
      return `failed ${activeFailedCount} за ${windowLabel} (+${staleFailedCount} stale)`;
    }

    return `failed ${activeFailedCount} за ${windowLabel}`;
  }

  private formatShortTimeWindow(windowSec: number): string {
    if (windowSec % 3_600 === 0) {
      return `${windowSec / 3_600} ч.`;
    }

    if (windowSec % 60 === 0) {
      return `${windowSec / 60} мин.`;
    }

    return `${windowSec} сек.`;
  }

  private isStabilizing(
    mode: Awaited<ReturnType<SystemModeService['getEffectiveSnapshot']>>,
    queueLagSec: number,
  ): boolean {
    if (mode.condition !== undefined) {
      return mode.condition === 'stabilizing';
    }

    return (
      mode.mode === 'degrade' &&
      mode.source === 'auto' &&
      queueLagSec <= QUEUE_LAG_WARNING_SEC &&
      mode.action.errorRate <= ACTION_RATE_WARNING_THRESHOLD &&
      mode.action.criticalRate <= ACTION_RATE_WARNING_THRESHOLD
    );
  }

  private buildWebhookSubscriptionAlert(
    snapshot: WebhookSubscriptionSnapshot,
  ): SystemDashboardAlert | null {
    const operationalDiagnostics = snapshot.operationalDiagnostics;
    if (
      snapshot.status === 'healthy' &&
      (!operationalDiagnostics || operationalDiagnostics.warningBotCount === 0)
    ) {
      return null;
    }

    if (snapshot.status === 'disabled') {
      return {
        code: 'webhook-subscription-disabled',
        level: 'info',
        title: 'Webhook reconcile отключён',
        detail: snapshot.note ?? 'Фоновая проверка webhook subscription сейчас не активна.',
        recommendedAction:
          'Для production это не норма. Проверьте app role и конфигурацию webhook URL/secret.',
      };
    }

    if (snapshot.status === 'critical') {
      const detail = !snapshot.configured
        ? 'Webhook URL не сконфигурирован, бот не сможет держать подписку в актуальном состоянии.'
        : snapshot.missingUpdateTypes.length > 0
          ? `У текущей subscription не хватает update types: ${snapshot.missingUpdateTypes.join(', ')}.`
          : 'Текущая webhook subscription для сконфигурированного URL не найдена.';
      return {
        code: 'webhook-subscription-critical',
        level: 'critical',
        title: 'Webhook coverage требует вмешательства',
        detail,
        recommendedAction:
          'Проверьте reconcile и текущие subscriptions. Не выполняйте ручную чистку чужих URL без подтверждения.',
      };
    }

    if (operationalDiagnostics && operationalDiagnostics.warningBotCount > 0) {
      const details: string[] = [`боты: ${operationalDiagnostics.warningBotIds.join(', ')}`];
      if (operationalDiagnostics.noActiveMembershipBotIds.length > 0) {
        details.push(
          `без active memberships: ${operationalDiagnostics.noActiveMembershipBotIds.join(', ')}`,
        );
      }
      if (operationalDiagnostics.noIncomingWebhookBotIds.length > 0) {
        details.push(
          `без входящих webhook: ${operationalDiagnostics.noIncomingWebhookBotIds.join(', ')}`,
        );
      }
      if (snapshot.otherSubscriptionsCount > 0) {
        details.push(`дополнительных subscriptions: ${snapshot.otherSubscriptionsCount}`);
      }
      if (snapshot.extraUpdateTypes.length > 0) {
        details.push(`лишние update types: ${snapshot.extraUpdateTypes.join(', ')}`);
      }
      if (snapshot.lastError) {
        details.push(`последняя ошибка: ${snapshot.lastError}`);
      }

      return {
        code: 'webhook-operational-bot-idle',
        level: 'warning',
        title: 'Active bot с подпиской не участвует в runtime',
        detail: details.join('; '),
        recommendedAction:
          'Проверьте, должен ли бот быть active: подключите его к managed chats/channels или переведите в dormant/disabled. Subscriptions не удаляйте без подтверждения владельца.',
      };
    }

    const warningDetails: string[] = [];
    if (snapshot.extraUpdateTypes.length > 0) {
      warningDetails.push(`лишние update types: ${snapshot.extraUpdateTypes.join(', ')}`);
    }
    if (snapshot.otherSubscriptionsCount > 0) {
      warningDetails.push(`дополнительных subscriptions: ${snapshot.otherSubscriptionsCount}`);
    }
    if (snapshot.lastError) {
      warningDetails.push(`последняя ошибка: ${snapshot.lastError}`);
    }

    return {
      code: 'webhook-subscription-warning',
      level: 'warning',
      title: 'Webhook subscription под наблюдением',
      detail:
        warningDetails.length > 0
          ? `Есть drift или ошибка reconcile: ${warningDetails.join('; ')}.`
          : (snapshot.note ?? 'Состояние webhook subscription требует внимания.'),
      recommendedAction:
        'Следите за drift и reconcile errors. MAX UI не должен делать прямой live-check в фоне на каждый refresh.',
    };
  }

  private buildProblemChatsAlert(
    problemChats:
      | Awaited<ReturnType<RuntimeDiagnosticsService['getDashboardSnapshot']>>['problemChats']
      | undefined,
  ): SystemDashboardAlert | null {
    const items = problemChats?.items ?? [];
    if (items.length === 0) {
      return null;
    }

    const criticalCount = items.filter((item) => item.severity === 'critical').length;
    const top = items[0];
    return {
      code: 'problem-chats',
      level: criticalCount > 0 ? 'critical' : 'warning',
      title:
        criticalCount > 0 ? 'Есть чаты с критичными runtime-проблемами' : 'Есть проблемные чаты',
      detail: `${items.length} чатов/сценариев за окно ${problemChats?.windowSec ?? 0} сек. Топ: ${top.chatId}, ${top.category}, ${top.reason}.`,
      recommendedAction:
        'Откройте system dashboard/problemChats или логи по chatId: чаще всего нужно восстановить права бота или снизить фоновые MAX-запросы.',
    };
  }

  private buildHotPathAlert(
    hotPath:
      | Awaited<ReturnType<RuntimeDiagnosticsService['getDashboardSnapshot']>>['hotPath']
      | undefined,
  ): SystemDashboardAlert | null {
    const stages = hotPath?.stages ?? [];
    const topTimeout = stages.find((stage) => stage.timeoutCount > 0);
    const totalTimeouts = stages.reduce((sum, stage) => sum + stage.timeoutCount, 0);
    if (topTimeout) {
      return {
        code: 'webhook-hot-path-timeouts',
        level: totalTimeouts >= 10 ? 'critical' : 'warning',
        title:
          totalTimeouts >= 10
            ? 'Webhook hot path регулярно упирается в watchdog'
            : 'Есть timeout в webhook hot path',
        detail: `${totalTimeouts} timeout за окно ${hotPath?.windowSec ?? 0} сек. Топ-стадия: ${topTimeout.stage}, max ${topTimeout.maxElapsedMs} мс.`,
        recommendedAction:
          'Уберите синхронный MAX API или тяжёлую работу из этой стадии; для group/admin actions используйте очередь.',
      };
    }

    const topSlow = stages.find(
      (stage) =>
        stage.slowCount >= HOT_PATH_SLOW_WARNING_COUNT ||
        stage.maxElapsedMs >= HOT_PATH_SLOW_WARNING_MAX_MS,
    );
    if (!topSlow) {
      return null;
    }

    const totalSlow = stages.reduce((sum, stage) => sum + stage.slowCount, 0);
    return {
      code: 'webhook-hot-path-slow',
      level: 'warning',
      title: 'Webhook hot path близко к watchdog',
      detail: `${totalSlow} slow completions за окно ${hotPath?.windowSec ?? 0} сек. Топ-стадия: ${topSlow.stage}, max ${topSlow.maxElapsedMs} мс.`,
      recommendedAction:
        'Перенесите синхронную работу из user-facing webhook path в очереди или сократите MAX/API ожидания до появления timeout.',
    };
  }

  private hasHotPathSlowWarning(
    hotPath:
      | Awaited<ReturnType<RuntimeDiagnosticsService['getDashboardSnapshot']>>['hotPath']
      | undefined,
  ): boolean {
    return (hotPath?.stages ?? []).some(
      (stage) =>
        stage.slowCount >= HOT_PATH_SLOW_WARNING_COUNT ||
        stage.maxElapsedMs >= HOT_PATH_SLOW_WARNING_MAX_MS,
    );
  }

  private buildWebhookSloAlert(
    snapshot: WebhookSloSnapshot | undefined,
  ): SystemDashboardAlert | null {
    if (!snapshot || snapshot.status === 'healthy') {
      return null;
    }

    const underTarget =
      snapshot.underTargetRatio === null
        ? 'n/a'
        : `${(snapshot.underTargetRatio * 100).toFixed(1)}%`;
    const enqueueUnderTarget =
      snapshot.enqueue?.underTargetRatio === null ||
      snapshot.enqueue?.underTargetRatio === undefined
        ? 'n/a'
        : `${(snapshot.enqueue.underTargetRatio * 100).toFixed(1)}%`;
    const ingressUnderTarget =
      snapshot.ingress.underTargetRatio === null
        ? 'n/a'
        : `${(snapshot.ingress.underTargetRatio * 100).toFixed(1)}%`;
    const claimsPerReceipt =
      snapshot.canonicalExecution.claimsPerReceiptRatio === null
        ? 'n/a'
        : snapshot.canonicalExecution.claimsPerReceiptRatio.toFixed(3);
    const route = snapshot.ingress.route;
    const routeOutcomes = route?.outcomes;
    const routeOutcomeDetail =
      `route attempts ${route?.attemptedRequests ?? 0}` +
      ` [accepted ${routeOutcomes?.accepted ?? 0}, auth rejected ${routeOutcomes?.authentication_rejected ?? 0},` +
      ` admission rejected ${routeOutcomes?.admission_rejected ?? 0}, invalid JSON ${routeOutcomes?.invalid_json ?? 0},` +
      ` invalid payload ${routeOutcomes?.invalid_payload ?? 0}, oversized ${routeOutcomes?.payload_too_large ?? 0},` +
      ` timed out ${routeOutcomes?.timed_out ?? 0}, failed ${routeOutcomes?.failed ?? 0}]`;
    const membershipCache = snapshot.membershipCache;
    const cacheMetrics = snapshot.ingress.membershipCache;
    const detachedCacheMetrics = cacheMetrics?.detached;
    const edgeAdvance = snapshot.ingress.membershipTransition?.edgeAdvance;
    const formatRatio = (value: number | null | undefined) =>
      value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
    const membershipCacheDetail =
      `membership cache ${membershipCache?.status ?? 'n/a'}` +
      ` [precheck fail-open ${formatRatio(membershipCache?.precheckFailOpen.ratio)},` +
      ` Lua conflicts ${formatRatio(membershipCache?.luaConflict.ratio)},` +
      ` Lua terminal failures ${formatRatio(membershipCache?.luaTerminalFailure.ratio)},` +
      ` budget timeouts ${formatRatio(membershipCache?.budgetTimeout.ratio)},` +
      ` detached failures/rejections ${formatRatio(membershipCache?.detachedFailure.ratio)}` +
      ` (failed ${detachedCacheMetrics?.failure ?? 0}, rejected ${detachedCacheMetrics?.rejected ?? 0},` +
      ` completed ${detachedCacheMetrics?.completed ?? 0}, peak in-flight ${detachedCacheMetrics?.peakInFlight ?? 0}),` +
      ` Lua p95 ${cacheMetrics?.lua.timing.p95DurationMs ?? 0} ms,` +
      ` budget p95 ${cacheMetrics?.budget.timing.p95DurationMs ?? 0} ms,` +
      ` edge no-op ${edgeAdvance?.noOpCalls ?? 0}/${edgeAdvance?.calls ?? 0}]`;
    return {
      code: 'webhook-slo',
      level: snapshot.status === 'critical' ? 'critical' : 'warning',
      title:
        snapshot.status === 'critical'
          ? 'Webhook SLO просел критично'
          : 'Webhook SLO требует внимания',
      detail: `ingress ${snapshot.ingress.available ? 'available' : 'unavailable'}, p95 ${snapshot.ingress.p95LatencyMs ?? 0} мс, p99 ${snapshot.ingress.p99LatencyMs ?? 0} мс, under target ${ingressUnderTarget}, persistence failures ${snapshot.ingress.failedReceipts}, receipt capacity rejects ${snapshot.ingress.rejectedReceipts}; ${routeOutcomeDetail}; ${membershipCacheDetail}; processing p95 ${snapshot.p95ProcessingMs ?? 0} мс, p99 ${snapshot.p99ProcessingMs ?? 0} мс, under target ${underTarget}, failed ${snapshot.failedEvents}, oldest unprocessed ${snapshot.oldestUnprocessedLagSec.toFixed(1)} сек; enqueue p95 ${snapshot.enqueue?.p95LatencyMs ?? 0} мс, enqueue under target ${enqueueUnderTarget}, oldest pending enqueue ${snapshot.enqueue?.oldestPendingLagSec.toFixed(1) ?? '0.0'} сек; receipts/EXECUTION claims ${snapshot.canonicalExecution.receipts}/${snapshot.canonicalExecution.executionClaims}, claims per receipt ${claimsPerReceipt}.`,
      recommendedAction:
        'Сверьте route outcomes и membership-cache ratios/timings, затем проверьте Redis, PostgreSQL receipt/edge-update latency, canonical claim preparation, backlog и MAX API rate limit.',
    };
  }

  private buildCriticalLimiterAlert(
    snapshot:
      | Awaited<ReturnType<BackgroundRuntimeGovernorService['getCriticalLimiterSnapshot']>>
      | undefined,
  ): SystemDashboardAlert | null {
    if (!snapshot) {
      return null;
    }

    const scaledThreshold = Math.ceil(
      (snapshot.windowSec / MAX_API_CRITICAL_LIMITER_WARNING_BASE_WINDOW_SEC) *
        MAX_API_CRITICAL_LIMITER_WARNING_MIN_REJECTS,
    );
    const warningThreshold = Math.max(
      MAX_API_CRITICAL_LIMITER_WARNING_MIN_REJECTS,
      scaledThreshold,
    );
    if (snapshot.internalRejects < warningThreshold) {
      return null;
    }

    return {
      code: 'max-api-critical-limiter-rejects',
      level: 'warning',
      title: 'Critical MAX-запросы упираются во внутренний limiter',
      detail: `${snapshot.internalRejects} critical rejects за ${this.formatShortTimeWindow(snapshot.windowSec)} (warning threshold ${warningThreshold}).`,
      recommendedAction:
        'Сверьте source tags, bot IDs и чаты в MAX diagnostics, critical action backlog и class capacity. Снижайте конкурирующий interactive/background трафик внутри перегруженного bot budget.',
    };
  }

  private async loadVkParsingGuardSnapshot(): Promise<VkParsingGuardSnapshot | null> {
    if (!this.prisma) {
      return null;
    }

    const checkedAt = new Date();
    const windowMin = VK_PARSING_HEALTH_WINDOW_MIN;
    const since = new Date(checkedAt.getTime() - windowMin * 60_000);
    try {
      const [sourceRows, mediaRows, publishRows] = await Promise.all([
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where status = 'ACTIVE')::int as "activeSources",
            count(*) filter (
              where status = 'ACTIVE'
                and updated_at >= ${since}
                and (sync_status in ('BACKOFF', 'ERROR') or last_error_code is not null)
            )::int as "sourceFailureCount",
            count(*) filter (
              where status = 'ACTIVE'
                and circuit_opened_at is not null
            )::int as "circuitOpenSources"
          from vk_parsing_sources
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (
              where coalesce(last_checked_at, updated_at) >= ${since}
            )::int as "recentMediaChecks",
            count(*) filter (
              where status = 'FAILED'
                and coalesce(last_checked_at, updated_at) >= ${since}
            )::int as "recentMediaFailures"
          from vk_parsing_media_cache
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where publish_queued_at is not null)::int as "publishBacklog",
            extract(epoch from (now() - min(publish_queued_at)))::int
              as "oldestPublishBacklogAgeSec"
          from vk_parsing_posts
          where publish_queued_at is not null
        `,
      ]);
      const sources = sourceRows[0] ?? {};
      const media = mediaRows[0] ?? {};
      const publish = publishRows[0] ?? {};
      const recentMediaChecks = this.readNumber(media.recentMediaChecks);
      const recentMediaFailures = this.readNumber(media.recentMediaFailures);
      return {
        checkedAt: checkedAt.toISOString(),
        windowMin,
        activeSources: this.readNumber(sources.activeSources),
        sourceFailureCount: this.readNumber(sources.sourceFailureCount),
        circuitOpenSources: this.readNumber(sources.circuitOpenSources),
        recentMediaChecks,
        recentMediaFailures,
        recentMediaFailureRatio:
          recentMediaChecks > 0 ? Math.min(1, recentMediaFailures / recentMediaChecks) : 0,
        publishBacklog: this.readNumber(publish.publishBacklog),
        oldestPublishBacklogAgeSec: this.readNumber(publish.oldestPublishBacklogAgeSec),
      };
    } catch {
      return null;
    }
  }

  private buildVkParsingHealthAlert(
    snapshot: VkParsingGuardSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot || snapshot.activeSources === 0) {
      return null;
    }

    const sourceFailuresHigh =
      snapshot.sourceFailureCount >= VK_PARSING_SOURCE_FAILURE_WARNING_COUNT;
    const mediaFailuresHigh =
      snapshot.recentMediaChecks > 0 &&
      snapshot.recentMediaFailureRatio >= VK_PARSING_MEDIA_FAILURE_WARNING_RATIO;
    const publishBacklogOld =
      snapshot.oldestPublishBacklogAgeSec >= VK_PARSING_PUBLISH_BACKLOG_WARNING_SEC;

    if (
      snapshot.circuitOpenSources === 0 &&
      !sourceFailuresHigh &&
      !mediaFailuresHigh &&
      !publishBacklogOld
    ) {
      return null;
    }

    const details = [
      snapshot.circuitOpenSources > 0 ? `circuit open: ${snapshot.circuitOpenSources}` : null,
      sourceFailuresHigh
        ? `source failures за ${snapshot.windowMin} мин: ${snapshot.sourceFailureCount}`
        : null,
      mediaFailuresHigh
        ? `media failures: ${(snapshot.recentMediaFailureRatio * 100).toFixed(1)}%`
        : null,
      publishBacklogOld
        ? `oldest publish backlog: ${snapshot.oldestPublishBacklogAgeSec} сек`
        : null,
    ].filter((item): item is string => item !== null);

    return {
      code: 'vk-parsing-health',
      level: 'warning',
      title: 'VK parsing требует внимания',
      detail: details.join('; '),
      recommendedAction:
        'Откройте VK diagnostics: проверьте noisy sources, media failures и publish backlog. Readiness при этом остаётся зелёной.',
    };
  }

  private async loadDeliveryLedgerRiskSnapshot(): Promise<DeliveryLedgerRiskSnapshot | null> {
    if (!this.prisma) {
      return null;
    }

    const checkedAt = new Date();
    const staleActionSince = new Date(checkedAt.getTime() - DELIVERY_LEDGER_STALE_ACTION_MS);
    const autoDeleteAccessAmbiguousSince = new Date(
      checkedAt.getTime() - DELIVERY_LEDGER_AUTO_DELETE_ACCESS_AMBIGUOUS_WINDOW_MS,
    );
    const staleBroadcastSendingSince = new Date(
      checkedAt.getTime() - DELIVERY_LEDGER_STALE_BROADCAST_SENDING_MS,
    );
    const staleSuggestionSendingSince = new Date(
      checkedAt.getTime() - DELIVERY_LEDGER_STALE_SUGGESTION_SENDING_MS,
    );
    const waitingCapabilityAgedSince = new Date(
      checkedAt.getTime() - DELIVERY_LEDGER_WAITING_CAPABILITY_WARNING_MS,
    );
    try {
      const [actionRows, broadcastRows, suggestionRows, deleteIntentRows] = await Promise.all([
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where status = 'AMBIGUOUS')::int as "actionAmbiguous",
            count(*) filter (
              where status = 'IN_PROGRESS'
                and updated_at < ${staleActionSince}
            )::int as "actionStaleInProgress",
            count(*) filter (
              where status = 'FAILED_RETRYABLE'
                and terminal = false
                and updated_at < ${staleActionSince}
            )::int as "actionStaleRetryable",
            extract(epoch from (now() - min(updated_at) filter (
              where status = 'AMBIGUOUS'
                 or (status = 'IN_PROGRESS' and updated_at < ${staleActionSince})
                 or (
                   status = 'FAILED_RETRYABLE'
                   and terminal = false
                   and updated_at < ${staleActionSince}
                 )
            )))::int as "actionOldestRiskAgeSec"
            , count(*) filter (
              where action_type = 'DELETE_MESSAGE'
                and status = 'FAILED_RETRYABLE'
                and terminal = true
                and ambiguous = false
                and source_tag = 'moderation_notice'
                and last_error_code = 'send_auto_delete_exact_verification_access_ambiguous'
                and updated_at >= ${autoDeleteAccessAmbiguousSince}
            )::int as "actionRecentAutoDeleteAccessAmbiguous"
            , extract(epoch from (now() - min(updated_at) filter (
              where action_type = 'DELETE_MESSAGE'
                and status = 'FAILED_RETRYABLE'
                and terminal = true
                and ambiguous = false
                and source_tag = 'moderation_notice'
                and last_error_code = 'send_auto_delete_exact_verification_access_ambiguous'
                and updated_at >= ${autoDeleteAccessAmbiguousSince}
            )))::int as "actionOldestAutoDeleteAccessAmbiguousAgeSec"
          from max_action_ledger
          where status = 'AMBIGUOUS'
             or (status = 'IN_PROGRESS' and updated_at < ${staleActionSince})
             or (
               status = 'FAILED_RETRYABLE'
               and terminal = false
               and updated_at < ${staleActionSince}
             )
             or (
               action_type = 'DELETE_MESSAGE'
               and status = 'FAILED_RETRYABLE'
               and terminal = true
               and ambiguous = false
               and source_tag = 'moderation_notice'
               and last_error_code = 'send_auto_delete_exact_verification_access_ambiguous'
               and updated_at >= ${autoDeleteAccessAmbiguousSince}
             )
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where status = 'AMBIGUOUS')::int as "broadcastAmbiguous",
            count(*) filter (
              where status = 'SENDING'
                and locked_at < ${staleBroadcastSendingSince}
            )::int as "broadcastStaleSending",
            count(distinct broadcast_id)::int as "broadcastRiskBroadcasts",
            extract(epoch from (now() - min(coalesce(locked_at, updated_at))))::int
              as "broadcastOldestRiskAgeSec"
          from managed_broadcast_deliveries
          where status = 'AMBIGUOUS'
             or (status = 'SENDING' and locked_at < ${staleBroadcastSendingSince})
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where d.status = 'AMBIGUOUS')::int as "suggestionAmbiguous",
            count(*) filter (
              where d.status = 'FAILED'
                and d.terminal = true
            )::int as "suggestionTerminalFailed",
            count(*) filter (
              where d.status = 'SENDING'
                and d.locked_at < ${staleSuggestionSendingSince}
            )::int as "suggestionStaleSending",
            count(distinct d.audit_log_id)::int as "suggestionRiskSuggestions",
            extract(epoch from (now() - min(coalesce(d.locked_at, d.updated_at))))::int
              as "suggestionOldestRiskAgeSec"
          from channel_suggestion_admin_deliveries d
          join audit_logs a on a.id = d.audit_log_id
          where a.action = 'CHANNEL_DIALOG_SUGGESTION'
            and coalesce(nullif(a.payload->>'reviewStatus', ''), 'pending') = 'pending'
            and (
              d.status = 'AMBIGUOUS'
              or (d.status = 'FAILED' and d.terminal = true)
              or (d.status = 'SENDING' and d.locked_at < ${staleSuggestionSendingSince})
            )
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          with risk_candidates as (
            select
              intent.status,
              intent.retry_until_at
            from moderation_delete_intents intent
            where intent.retry_until_at <= current_timestamp
              and intent.status in (
                'PENDING',
                'RETRYABLE',
                'WAITING_CAPABILITY',
                'AMBIGUOUS',
                'IN_PROGRESS'
              )
              and intent.remote_delete_succeeded_at is null
              and intent.remote_delete_succeeded_bot_id is null
              and intent.delete_dispatch_started_at is null
              and intent.delete_dispatch_started_bot_id is null
              and (
                intent.status <> 'IN_PROGRESS'
                or intent.lease_expires_at is null
                or intent.lease_expires_at <= current_timestamp
              )
            order by intent.retry_until_at asc, intent.created_at asc, intent.id asc
            limit ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT + 1}
          ),
          stale_in_progress_candidates as (
            select intent.retry_until_at
            from moderation_delete_intents intent
            where intent.retry_until_at <= current_timestamp
              and intent.status = 'IN_PROGRESS'
              and intent.remote_delete_succeeded_at is null
              and intent.remote_delete_succeeded_bot_id is null
              and intent.delete_dispatch_started_at is null
              and intent.delete_dispatch_started_bot_id is null
              and (
                intent.lease_expires_at is null
                or intent.lease_expires_at <= current_timestamp
              )
            order by intent.retry_until_at asc, intent.created_at asc, intent.id asc
            limit ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT + 1}
          ),
          waiting_capability_candidates as (
            select
              intent.chat_id,
              intent.first_attempt_at
            from moderation_delete_intents intent
            where intent.status = 'WAITING_CAPABILITY'
              and intent.retry_until_at > current_timestamp
              and intent.first_attempt_at <= ${waitingCapabilityAgedSince}
              and intent.remote_delete_succeeded_at is null
              and intent.remote_delete_succeeded_bot_id is null
              and intent.delete_dispatch_started_at is null
              and intent.delete_dispatch_started_bot_id is null
            order by intent.next_attempt_at asc, intent.execute_at asc
            limit ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT + 1}
          )
          select
            least(count(*), ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT})::int
              as "deleteIntentSafelyExpirable",
            (
              select least(count(*), ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT})::int
              from stale_in_progress_candidates
            ) as "deleteIntentStaleExpiredInProgress",
            extract(epoch from (now() - min(retry_until_at)))::int
              as "deleteIntentOldestExpiredAgeSec",
            count(*) > ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT}
              as "deleteIntentRiskCapped",
            (
              select count(*) > ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT}
              from stale_in_progress_candidates
            ) as "deleteIntentStaleExpiredInProgressCapped",
            (
              select least(count(*), ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT})::int
              from waiting_capability_candidates
            ) as "deleteIntentAgedWaitingCapability",
            (
              select least(
                count(distinct chat_id),
                ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT}
              )::int
              from waiting_capability_candidates
            ) as "deleteIntentAgedWaitingCapabilityChats",
            (
              select extract(epoch from (now() - min(first_attempt_at)))::int
              from waiting_capability_candidates
            ) as "deleteIntentOldestWaitingCapabilityAgeSec",
            (
              select count(*) > ${DELIVERY_LEDGER_DELETE_INTENT_RISK_LIMIT}
              from waiting_capability_candidates
            ) as "deleteIntentAgedWaitingCapabilityCapped"
          from risk_candidates
        `,
      ]);
      const action = actionRows[0] ?? {};
      const broadcast = broadcastRows[0] ?? {};
      const suggestion = suggestionRows[0] ?? {};
      const deleteIntent = deleteIntentRows[0] ?? {};

      return {
        checkedAt: checkedAt.toISOString(),
        actionAmbiguous: this.readNumber(action.actionAmbiguous),
        actionStaleInProgress: this.readNumber(action.actionStaleInProgress),
        actionStaleRetryable: this.readNumber(action.actionStaleRetryable),
        actionOldestRiskAgeSec: this.readNumber(action.actionOldestRiskAgeSec),
        actionRecentAutoDeleteAccessAmbiguous: this.readNumber(
          action.actionRecentAutoDeleteAccessAmbiguous,
        ),
        actionOldestAutoDeleteAccessAmbiguousAgeSec: this.readNumber(
          action.actionOldestAutoDeleteAccessAmbiguousAgeSec,
        ),
        broadcastAmbiguous: this.readNumber(broadcast.broadcastAmbiguous),
        broadcastStaleSending: this.readNumber(broadcast.broadcastStaleSending),
        broadcastRiskBroadcasts: this.readNumber(broadcast.broadcastRiskBroadcasts),
        broadcastOldestRiskAgeSec: this.readNumber(broadcast.broadcastOldestRiskAgeSec),
        suggestionAmbiguous: this.readNumber(suggestion.suggestionAmbiguous),
        suggestionTerminalFailed: this.readNumber(suggestion.suggestionTerminalFailed),
        suggestionStaleSending: this.readNumber(suggestion.suggestionStaleSending),
        suggestionRiskSuggestions: this.readNumber(suggestion.suggestionRiskSuggestions),
        suggestionOldestRiskAgeSec: this.readNumber(suggestion.suggestionOldestRiskAgeSec),
        deleteIntentSafelyExpirable: this.readNumber(deleteIntent.deleteIntentSafelyExpirable),
        deleteIntentStaleExpiredInProgress: this.readNumber(
          deleteIntent.deleteIntentStaleExpiredInProgress,
        ),
        deleteIntentOldestExpiredAgeSec: this.readNumber(
          deleteIntent.deleteIntentOldestExpiredAgeSec,
        ),
        deleteIntentRiskCapped: deleteIntent.deleteIntentRiskCapped === true,
        deleteIntentStaleExpiredInProgressCapped:
          deleteIntent.deleteIntentStaleExpiredInProgressCapped === true,
        deleteIntentAgedWaitingCapability: this.readNumber(
          deleteIntent.deleteIntentAgedWaitingCapability,
        ),
        deleteIntentAgedWaitingCapabilityChats: this.readNumber(
          deleteIntent.deleteIntentAgedWaitingCapabilityChats,
        ),
        deleteIntentOldestWaitingCapabilityAgeSec: this.readNumber(
          deleteIntent.deleteIntentOldestWaitingCapabilityAgeSec,
        ),
        deleteIntentAgedWaitingCapabilityCapped:
          deleteIntent.deleteIntentAgedWaitingCapabilityCapped === true,
      };
    } catch {
      return null;
    }
  }

  private async loadSuggestionPublicationProtocolSnapshot(): Promise<SuggestionPublicationProtocolSnapshot | null> {
    if (!this.prisma) {
      return null;
    }

    const checkedAt = new Date();
    const staleBefore = new Date(checkedAt.getTime() - SUGGESTION_PUBLICATION_STALE_MS);
    try {
      const [publishingRows, ledgerAudit] = await Promise.all([
        this.prisma.$queryRaw<SuggestionPublishingAuditRow[]>`
          with publishing_candidates as materialized (
            select
              audit.id as "suggestionId",
              audit.chat_id as "chatId",
              audit.actor_user_id as "actorUserId",
              audit.created_at as "createdAt",
              claim."claimAt",
              jsonb_build_object(
                'type', audit.payload->'type',
                'reviewStatus', audit.payload->'reviewStatus',
                'reviewAction', audit.payload->'reviewAction',
                'reviewPublicationProtocol', audit.payload->'reviewPublicationProtocol',
                'reviewPublicationLedgerJobId', audit.payload->'reviewPublicationLedgerJobId',
                'reviewClaimToken', audit.payload->'reviewClaimToken',
                'reviewClaimedAt', audit.payload->'reviewClaimedAt',
                'reviewClaimedByUserId', audit.payload->'reviewClaimedByUserId',
                'reviewClaimedByDisplayName', audit.payload->'reviewClaimedByDisplayName',
                'reviewPublicationContext', audit.payload->'reviewPublicationContext',
                'publishedMessageId', audit.payload->'publishedMessageId'
              ) as payload
            from audit_logs audit
            cross join lateral (
              select case
                when pg_input_is_valid(
                  audit.payload->>'reviewClaimedAt',
                  'timestamp with time zone'
                )
                  then (audit.payload->>'reviewClaimedAt')::timestamptz
                else audit.created_at
              end as "claimAt"
            ) claim
            where audit.action = 'CHANNEL_DIALOG_SUGGESTION'
              and audit.payload->>'type' = 'suggest'
              and audit.payload->>'reviewStatus' = 'publishing'
              and audit.created_at < ${staleBefore}
              and claim."claimAt" < ${staleBefore}
            order by claim."claimAt" asc, audit.created_at asc, audit.id asc
            limit ${SUGGESTION_PUBLICATION_AUDIT_LIMIT + 1}
          )
          select
            publishing.*,
            ledger.job_id as "jobId",
            ledger.action_type as "actionType",
            ledger.chat_id as "ledgerChatId",
            ledger.source_tag as "sourceTag",
            ledger.status::text as status,
            ledger.ambiguous,
            ledger.terminal,
            ledger.dispatch_token as "dispatchToken",
            ledger.dispatch_started_at as "dispatchStartedAt",
            ledger.dispatch_bot_id as "dispatchBotId",
            ledger.remote_message_id as "remoteMessageId",
            ledger.metadata
          from publishing_candidates publishing
          left join max_action_ledger ledger
            on ledger.job_id = 'channel-suggestion:publish:v1:' || publishing."suggestionId"
          order by
            publishing."claimAt" asc,
            publishing."createdAt" asc,
            publishing."suggestionId" asc
        `,
        this.loadSuggestionLedgerAudit(checkedAt),
      ]);

      const publishing = {
        safeRelease: 0,
        completed: 0,
        manual: 0,
        legacy: 0,
        audited: 0,
        oldestAgeSec: 0,
        capped: publishingRows.length > SUGGESTION_PUBLICATION_AUDIT_LIMIT,
      };
      for (const row of publishingRows.slice(0, SUGGESTION_PUBLICATION_AUDIT_LIMIT)) {
        const claimAt = this.readDate(row.claimAt) ?? this.readDate(row.createdAt);
        if (!claimAt || claimAt >= staleBefore) {
          continue;
        }
        publishing.audited += 1;
        publishing.oldestAgeSec = Math.max(
          publishing.oldestAgeSec,
          Math.max(0, Math.floor((checkedAt.getTime() - claimAt.getTime()) / 1_000)),
        );
        const payload = this.readRecord(row.payload) ?? {};
        const decision = classifyChannelSuggestionPublicationRecovery({
          payload,
          suggestionId: row.suggestionId,
          chatId: row.chatId,
          actorUserId: row.actorUserId,
          ledger: row.jobId ? this.mapSuggestionPublicationLedger(row) : null,
          nowMs: checkedAt.getTime(),
        });
        if (decision.kind === 'release_pre_dispatch') {
          publishing.safeRelease += 1;
        } else if (decision.kind === 'completed') {
          publishing.completed += 1;
        } else if (decision.kind === 'manual' && decision.reason === 'legacy') {
          publishing.legacy += 1;
        } else if (decision.kind === 'manual') {
          publishing.manual += 1;
        }
      }

      return {
        checkedAt: checkedAt.toISOString(),
        publishing,
        ledgerAudit,
      };
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Channel suggestion publication protocol dashboard audit is unavailable',
      );
      return null;
    }
  }

  private async loadSuggestionLedgerAudit(
    checkedAt: Date,
  ): Promise<SuggestionPublicationProtocolSnapshot['ledgerAudit']> {
    return this.prisma!.$transaction((tx) => this.scanSuggestionLedgerAudit(tx, checkedAt), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 15_000,
    });
  }

  private async scanSuggestionLedgerAudit(
    tx: Prisma.TransactionClient,
    checkedAt: Date,
  ): Promise<SuggestionPublicationProtocolSnapshot['ledgerAudit']> {
    const snapshot: SuggestionPublicationProtocolSnapshot['ledgerAudit'] = {
      missingAudit: 0,
      pendingAudit: 0,
      publishedAudit: 0,
      mismatchedAudit: 0,
      linkedPublishing: 0,
      audited: 0,
      oldestAgeSec: 0,
      capped: false,
    };
    let cursor: Pick<SuggestionLedgerAuditRow, 'ledgerId' | 'updatedAt'> | null = null;

    while (snapshot.audited < SUGGESTION_PUBLICATION_LEDGER_SCAN_LIMIT) {
      const take = Math.min(
        SUGGESTION_PUBLICATION_LEDGER_PAGE_SIZE,
        SUGGESTION_PUBLICATION_LEDGER_SCAN_LIMIT - snapshot.audited,
      );
      const rows = await this.loadSuggestionLedgerAuditPage(tx, {
        checkedAt,
        cursor,
        take: take + 1,
      });
      const page = rows.slice(0, take);
      if (page.length === 0) {
        return snapshot;
      }

      for (const row of page) {
        snapshot.audited += 1;
        const updatedAt = this.readDate(row.updatedAt);
        if (updatedAt) {
          snapshot.oldestAgeSec = Math.max(
            snapshot.oldestAgeSec,
            Math.max(0, Math.floor((checkedAt.getTime() - updatedAt.getTime()) / 1_000)),
          );
        }
        const decision = classifyChannelSuggestionPublicationLedgerAudit({
          ledger: this.mapSuggestionPublicationLedger(row),
          audit:
            row.auditId && row.auditChatId && row.actorUserId && row.auditAction
              ? {
                  id: row.auditId,
                  chatId: row.auditChatId,
                  actorUserId: row.actorUserId,
                  action: row.auditAction,
                  payload: this.readRecord(row.payload) ?? {},
                }
              : null,
        });
        this.incrementSuggestionLedgerAuditDecision(snapshot, decision);
      }

      if (rows.length <= take) {
        return snapshot;
      }
      const last = page.at(-1)!;
      cursor = { ledgerId: last.ledgerId, updatedAt: last.updatedAt };
    }

    snapshot.capped = true;
    return snapshot;
  }

  private async loadSuggestionLedgerAuditPage(
    tx: Prisma.TransactionClient,
    params: SuggestionLedgerAuditPageParams,
  ): Promise<SuggestionLedgerAuditRow[]> {
    return tx.$queryRaw<SuggestionLedgerAuditRow[]>(
      this.buildSuggestionLedgerAuditPageQuery(params),
    );
  }

  private buildSuggestionLedgerAuditPageQuery(params: SuggestionLedgerAuditPageParams): Prisma.Sql {
    const cursorUpdatedAt = params.cursor?.updatedAt ?? null;
    const cursorLedgerId = params.cursor?.ledgerId ?? null;
    return Prisma.sql`
      with suggestion_ledger_page as materialized (
        select
          ledger.id as "ledgerId",
          ledger.updated_at as "updatedAt",
          ledger.job_id as "jobId",
          ledger.action_type as "actionType",
          ledger.chat_id as "ledgerChatId",
          ledger.source_tag as "sourceTag",
          ledger.status::text as status,
          ledger.ambiguous,
          ledger.terminal,
          ledger.dispatch_token as "dispatchToken",
          ledger.dispatch_started_at as "dispatchStartedAt",
          ledger.dispatch_bot_id as "dispatchBotId",
          ledger.remote_message_id as "remoteMessageId",
          ledger.metadata
        from max_action_ledger ledger
        where ledger.action_type = 'SEND_MESSAGE'
          and ledger.source_tag = 'suggestion_delivery'
          and ledger.job_id like 'channel-suggestion:publish:v1:%'
          and ledger.updated_at <= ${params.checkedAt}::timestamp(3)
          and (
            ${cursorUpdatedAt}::timestamp(3) is null
            or (ledger.updated_at, ledger.id) < (
              ${cursorUpdatedAt}::timestamp(3),
              ${cursorLedgerId}::text
            )
          )
        order by ledger.updated_at desc, ledger.id desc
        limit ${params.take}
      )
      select
        page.*,
        audit.id as "auditId",
        audit.chat_id as "auditChatId",
        audit.actor_user_id as "actorUserId",
        audit.action as "auditAction",
        case
          when audit.id is null then null
          else jsonb_build_object(
            'type', audit.payload->'type',
            'reviewStatus', audit.payload->'reviewStatus',
            'reviewAction', audit.payload->'reviewAction',
            'reviewPublicationProtocol', audit.payload->'reviewPublicationProtocol',
            'reviewPublicationLedgerJobId', audit.payload->'reviewPublicationLedgerJobId',
            'reviewClaimToken', audit.payload->'reviewClaimToken',
            'reviewClaimedAt', audit.payload->'reviewClaimedAt',
            'reviewClaimedByUserId', audit.payload->'reviewClaimedByUserId',
            'reviewClaimedByDisplayName', audit.payload->'reviewClaimedByDisplayName',
            'reviewPublicationContext', audit.payload->'reviewPublicationContext',
            'publishedMessageId', audit.payload->'publishedMessageId'
          )
        end as payload
      from suggestion_ledger_page page
      left join audit_logs audit
        on audit.id = substring(
          page."jobId" from length('channel-suggestion:publish:v1:') + 1
        )
      order by page."updatedAt" desc, page."ledgerId" desc
    `;
  }

  private async loadNightModeReconcileRiskSnapshot(): Promise<NightModeReconcileRiskSnapshot | null> {
    if (!this.prisma) {
      return null;
    }
    const checkedAt = new Date();
    const agedBefore = new Date(checkedAt.getTime() - NIGHT_MODE_RECONCILE_ALERT_GRACE_MS);
    try {
      const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>`
        WITH manual_candidates AS (
          SELECT
            request."manual_blocked_at",
            request."manual_blocked_category"
          FROM "night_mode_transition_reconcile_requests" request
          WHERE request."manual_blocked_at" IS NOT NULL
            AND request."generation" = request."manual_blocked_generation"
            AND request."manual_acknowledged_at" IS NULL
          ORDER BY
            request."manual_blocked_at" ASC,
            request."manual_blocked_category" ASC,
            request."chat_id" ASC
          LIMIT ${NIGHT_MODE_RECONCILE_RISK_LIMIT + 1}
        ),
        aged_due_candidates AS (
          SELECT
            request."first_requested_at",
            request."requested_at",
            request."lease_token",
            request."lease_expires_at"
          FROM "night_mode_transition_reconcile_requests" request
          WHERE (
              request."manual_blocked_at" IS NULL
              OR request."generation" > request."manual_blocked_generation"
            )
            AND request."requested_at" <= ${agedBefore}
            AND (
              request."lease_token" IS NULL
              OR request."lease_expires_at" < ${agedBefore}
            )
          ORDER BY
            request."requested_at" ASC,
            request."lease_expires_at" ASC NULLS FIRST,
            request."chat_id" ASC
          LIMIT ${NIGHT_MODE_RECONCILE_RISK_LIMIT + 1}
        ),
        stale_lease_candidates AS (
          SELECT
            request."lease_expires_at"
          FROM "night_mode_transition_reconcile_requests" request
          WHERE (
              request."manual_blocked_at" IS NULL
              OR request."generation" > request."manual_blocked_generation"
            )
            AND request."requested_at" <= ${agedBefore}
            AND request."lease_token" IS NOT NULL
            AND request."lease_expires_at" < ${agedBefore}
          ORDER BY
            request."lease_expires_at" ASC,
            request."chat_id" ASC
          LIMIT ${NIGHT_MODE_RECONCILE_RISK_LIMIT + 1}
        ),
        manual_summary AS (
          SELECT
            COUNT(*)::int AS "manualBlocked",
            COUNT(*) FILTER (
              WHERE "manual_blocked_category" = 'unsafe_prior_dispatch'
            )::int AS "unsafePriorDispatch",
            COUNT(*) FILTER (
              WHERE "manual_blocked_category" = 'unsafe_prior_provenance'
            )::int AS "unsafePriorProvenance",
            COUNT(*) FILTER (
              WHERE "manual_blocked_category" = 'no_fresh_access'
            )::int AS "noFreshAccess",
            COUNT(*) FILTER (
              WHERE "manual_blocked_category" = 'failed_job_unclassified'
            )::int AS "failedJobUnclassified",
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("manual_blocked_at")))::int
              AS "oldestManualBlockedAgeSec",
            COUNT(*) > ${NIGHT_MODE_RECONCILE_RISK_LIMIT} AS "manualCapped"
          FROM manual_candidates
        ),
        due_summary AS (
          SELECT
            COUNT(*)::int AS "agedDue",
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("first_requested_at")))::int
              AS "oldestDueAgeSec",
            COUNT(*) > ${NIGHT_MODE_RECONCILE_RISK_LIMIT} AS "dueCapped"
          FROM aged_due_candidates
        ),
        stale_lease_summary AS (
          SELECT
            COUNT(*)::int AS "staleLeases",
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN("lease_expires_at")))::int
              AS "oldestStaleLeaseAgeSec",
            COUNT(*) > ${NIGHT_MODE_RECONCILE_RISK_LIMIT} AS "staleLeaseCapped"
          FROM stale_lease_candidates
        )
        SELECT
          manual_summary.*,
          due_summary.*,
          stale_lease_summary.*
        FROM manual_summary
        CROSS JOIN due_summary
        CROSS JOIN stale_lease_summary
      `;
      const row = rows[0] ?? {};
      return {
        checkedAt: checkedAt.toISOString(),
        manualBlocked: Math.min(
          this.readNumber(row.manualBlocked),
          NIGHT_MODE_RECONCILE_RISK_LIMIT,
        ),
        unsafePriorDispatch: Math.min(
          this.readNumber(row.unsafePriorDispatch),
          NIGHT_MODE_RECONCILE_RISK_LIMIT,
        ),
        unsafePriorProvenance: Math.min(
          this.readNumber(row.unsafePriorProvenance),
          NIGHT_MODE_RECONCILE_RISK_LIMIT,
        ),
        noFreshAccess: Math.min(
          this.readNumber(row.noFreshAccess),
          NIGHT_MODE_RECONCILE_RISK_LIMIT,
        ),
        failedJobUnclassified: Math.min(
          this.readNumber(row.failedJobUnclassified),
          NIGHT_MODE_RECONCILE_RISK_LIMIT,
        ),
        agedDue: Math.min(this.readNumber(row.agedDue), NIGHT_MODE_RECONCILE_RISK_LIMIT),
        staleLeases: Math.min(this.readNumber(row.staleLeases), NIGHT_MODE_RECONCILE_RISK_LIMIT),
        oldestManualBlockedAgeSec: this.readNumber(row.oldestManualBlockedAgeSec),
        oldestDueAgeSec: this.readNumber(row.oldestDueAgeSec),
        oldestStaleLeaseAgeSec: this.readNumber(row.oldestStaleLeaseAgeSec),
        manualCapped: row.manualCapped === true,
        dueCapped: row.dueCapped === true,
        staleLeaseCapped: row.staleLeaseCapped === true,
      };
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Night mode reconcile dashboard snapshot is unavailable; response remains fail-soft',
      );
      return null;
    }
  }

  private mapSuggestionPublicationLedger(
    row: SuggestionPublishingAuditRow | SuggestionLedgerAuditRow,
  ): ChannelSuggestionPublicationLedgerRow {
    return {
      jobId: row.jobId ?? '',
      actionType: row.actionType ?? '',
      chatId: row.ledgerChatId ?? '',
      sourceTag: row.sourceTag,
      status: row.status ?? '',
      ambiguous: row.ambiguous === true,
      terminal: row.terminal === true,
      dispatchToken: row.dispatchToken,
      dispatchStartedAt: this.readDate(row.dispatchStartedAt),
      dispatchBotId: row.dispatchBotId,
      remoteMessageId: row.remoteMessageId,
      metadata: row.metadata,
    };
  }

  private incrementSuggestionLedgerAuditDecision(
    snapshot: SuggestionPublicationProtocolSnapshot['ledgerAudit'],
    decision: ChannelSuggestionPublicationLedgerAuditDecision,
  ): void {
    if (decision === 'missing_audit') {
      snapshot.missingAudit += 1;
    } else if (decision === 'pending_audit') {
      snapshot.pendingAudit += 1;
    } else if (decision === 'published_audit') {
      snapshot.publishedAudit += 1;
    } else if (decision === 'linked_publishing') {
      snapshot.linkedPublishing += 1;
    } else {
      snapshot.mismatchedAudit += 1;
    }
  }

  private buildNightModeReconcileRiskAlert(
    snapshot: NightModeReconcileRiskSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot || (snapshot.manualBlocked === 0 && snapshot.agedDue === 0)) {
      return null;
    }
    const manualPrefix = snapshot.manualCapped ? '>=' : '';
    const duePrefix = snapshot.dueCapped ? '>=' : '';
    const staleLeasePrefix = snapshot.staleLeaseCapped ? '>=' : '';
    const details = [
      snapshot.manualBlocked > 0
        ? `manual blocked ${manualPrefix}${snapshot.manualBlocked} (unsafe dispatch ${snapshot.unsafePriorDispatch}, unsafe provenance ${snapshot.unsafePriorProvenance}, no fresh access ${snapshot.noFreshAccess}, unclassified ${snapshot.failedJobUnclassified}), oldest ${snapshot.oldestManualBlockedAgeSec} сек`
        : null,
      snapshot.agedDue > 0
        ? `aged due ${duePrefix}${snapshot.agedDue}, stale leases ${staleLeasePrefix}${snapshot.staleLeases}, oldest due ${snapshot.oldestDueAgeSec} сек, oldest stale lease ${snapshot.oldestStaleLeaseAgeSec} сек`
        : null,
    ].filter((item): item is string => item !== null);
    return {
      code: 'night-mode-transition-reconcile',
      level: 'warning',
      title: 'Night mode transitions требуют внимания',
      detail: details.join('; '),
      recommendedAction:
        'Откройте закрытый Safety Desk runtime night-mode-transitions. Unsafe send categories не повторяйте автоматически; сверяйте MAX и ledger перед acknowledge.',
    };
  }

  private buildDeliveryLedgerRiskAlert(
    snapshot: DeliveryLedgerRiskSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot) {
      return null;
    }

    const standardActionRisk =
      snapshot.actionAmbiguous + snapshot.actionStaleInProgress + snapshot.actionStaleRetryable;
    const autoDeleteAccessAmbiguousRisk = snapshot.actionRecentAutoDeleteAccessAmbiguous;
    const actionRisk = standardActionRisk + autoDeleteAccessAmbiguousRisk;
    const broadcastRisk = snapshot.broadcastAmbiguous + snapshot.broadcastStaleSending;
    const suggestionRisk =
      snapshot.suggestionAmbiguous +
      snapshot.suggestionTerminalFailed +
      snapshot.suggestionStaleSending;
    const deleteIntentRisk = snapshot.deleteIntentSafelyExpirable;
    if (actionRisk === 0 && broadcastRisk === 0 && suggestionRisk === 0 && deleteIntentRisk === 0) {
      return null;
    }

    const details = [
      standardActionRisk > 0
        ? `MAX action ledger: ambiguous ${snapshot.actionAmbiguous}, stale in-progress ${snapshot.actionStaleInProgress}, stale retryable ${snapshot.actionStaleRetryable}, oldest ${snapshot.actionOldestRiskAgeSec} сек`
        : null,
      autoDeleteAccessAmbiguousRisk > 0
        ? `MAX auto-delete verification за 24 ч: access-ambiguous ${autoDeleteAccessAmbiguousRisk}, oldest ${snapshot.actionOldestAutoDeleteAccessAmbiguousAgeSec} сек`
        : null,
      broadcastRisk > 0
        ? `managed broadcast delivery: ambiguous ${snapshot.broadcastAmbiguous}, stale sending ${snapshot.broadcastStaleSending}, broadcasts ${snapshot.broadcastRiskBroadcasts}, oldest ${snapshot.broadcastOldestRiskAgeSec} сек`
        : null,
      suggestionRisk > 0
        ? `suggestion delivery: ambiguous ${snapshot.suggestionAmbiguous}, terminal failed ${snapshot.suggestionTerminalFailed}, stale sending ${snapshot.suggestionStaleSending}, suggestions ${snapshot.suggestionRiskSuggestions}, oldest ${snapshot.suggestionOldestRiskAgeSec} сек`
        : null,
      deleteIntentRisk > 0
        ? `moderation delete intents: safely expirable ${snapshot.deleteIntentRiskCapped ? '>=' : ''}${deleteIntentRisk}, stale expired in-progress ${snapshot.deleteIntentStaleExpiredInProgressCapped ? '>=' : ''}${snapshot.deleteIntentStaleExpiredInProgress}, oldest ${snapshot.deleteIntentOldestExpiredAgeSec} сек`
        : null,
    ].filter((item): item is string => item !== null);

    return {
      code: 'delivery-ledger-risk',
      level: 'warning',
      title: 'Есть хвост доставок, требующий ручной сверки',
      detail: details.join('; '),
      recommendedAction: [
        'Для safely expirable delete-intent дождитесь reconciler и проверьте снижение счётчика. Сверьте MAX/логи/remoteMessageId перед любыми повторами; ambiguous send/delete/member actions и managed broadcast deliveries не ретрайте автоматически.',
        autoDeleteAccessAmbiguousRisk > 0
          ? 'Выполните bounded dry-run auto-delete recovery: npm run moderation:repair-bot-auto-delete-presence --workspace @maxim/api -- --discover-access-ambiguous --json.'
          : null,
      ]
        .filter((item): item is string => item !== null)
        .join(' '),
    };
  }

  private buildDeleteCapabilityBacklogAlert(
    snapshot: DeliveryLedgerRiskSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot || snapshot.deleteIntentAgedWaitingCapability === 0) {
      return null;
    }

    const thresholdMin = DELIVERY_LEDGER_WAITING_CAPABILITY_WARNING_MS / 60_000;
    const scopeDetail = snapshot.deleteIntentAgedWaitingCapabilityCapped
      ? `В ограниченной выборке чатов: ${snapshot.deleteIntentAgedWaitingCapabilityChats}, максимальный возраст от первой попытки: ${snapshot.deleteIntentOldestWaitingCapabilityAgeSec} сек.`
      : `Затронуто чатов: ${snapshot.deleteIntentAgedWaitingCapabilityChats}, максимальный возраст от первой попытки: ${snapshot.deleteIntentOldestWaitingCapabilityAgeSec} сек.`;
    return {
      code: 'moderation-delete-capability-backlog',
      level: 'warning',
      title: 'Старые удаления ожидают проверки доступности',
      detail: `${snapshot.deleteIntentAgedWaitingCapabilityCapped ? '>=' : ''}${snapshot.deleteIntentAgedWaitingCapability} delete intents сейчас в WAITING_CAPABILITY, а их первая попытка была больше ${thresholdMin} мин назад. ${scopeDetail}`,
      recommendedAction:
        'Проверьте effective delete permission и маршрут доступных ботов (для group chat требуется write), свежесть capability snapshot и unverified 404/message presence. Не удаляйте intents и не повторяйте действия вручную: durable retry продолжит работу после восстановления доступности.',
    };
  }

  private buildSuggestionPublishingRiskAlert(
    snapshot: SuggestionPublicationProtocolSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot) {
      return null;
    }

    const publishing = snapshot.publishing;
    const stalePublishing =
      publishing.safeRelease + publishing.completed + publishing.manual + publishing.legacy;
    if (stalePublishing === 0 && !publishing.capped) {
      return null;
    }
    const thresholdMin = SUGGESTION_PUBLICATION_STALE_MS / 60_000;
    return {
      code: 'channel-suggestion-publishing-stale',
      level: 'warning',
      title: 'Есть зависшие публикации предложек',
      detail: `${publishing.capped ? 'Выборка ограничена; ' : ''}${stalePublishing} предложек остаются в publishing дольше ${thresholdMin} мин: safe pre-dispatch ${publishing.safeRelease}, completed ${publishing.completed}, manual ${publishing.manual}, legacy ${publishing.legacy}. Проверено ${publishing.audited}, максимальный возраст claim ${publishing.oldestAgeSec} сек.`,
      recommendedAction:
        'Safe pre-dispatch можно восстанавливать только штатным повторным review-запросом; completed требует штатной финализации. Manual и legacy сверяйте с MAX и transport logs, не сбрасывайте claim и не отправляйте повторно вручную.',
    };
  }

  private buildSuggestionLedgerAuditAlert(
    snapshot: SuggestionPublicationProtocolSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot) {
      return null;
    }
    const audit = snapshot.ledgerAudit;
    const orphanRisk = audit.missingAudit + audit.pendingAudit + audit.mismatchedAudit;
    if (orphanRisk === 0 && !audit.capped) {
      return null;
    }
    return {
      code: 'channel-suggestion-ledger-audit',
      level: 'warning',
      title: 'Suggestion publication ledger требует сверки',
      detail: `${audit.capped ? `Выборка ограничена последними ${audit.audited} ledger; более старая история не проверена, поэтому предупреждение о неполном покрытии остается активным. ` : ''}orphan/mismatch ${orphanRisk}: missing audit ${audit.missingAudit}, pending audit ${audit.pendingAudit}, mismatched ${audit.mismatchedAudit}. Корректно связаны: publishing ${audit.linkedPublishing}, published ${audit.publishedAudit}. В выборке ${audit.audited}, максимальный возраст ledger в ней ${audit.oldestAgeSec} сек.`,
      recommendedAction:
        'Capped означает неполную диагностику, а не подтверждённое отсутствие orphan. Не удаляйте и не переотправляйте ledger автоматически. Сопоставьте suggestion id, immutable actor, claim/context digests, dispatch bot и remoteMessageId; исправляйте только после внешнего подтверждения MAX.',
    };
  }

  private buildActionQueueLaneAlert(
    actionQueues: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['actionQueues'],
  ): SystemDashboardAlert | null {
    const pending = (queueName: string) => {
      const queue = actionQueues?.[queueName as keyof typeof actionQueues];
      return (queue?.waiting ?? 0) + (queue?.prioritized ?? 0);
    };
    const criticalPending = pending(MAX_ACTION_CRITICAL_QUEUE);
    if (criticalPending === 0) {
      return null;
    }

    const critical = criticalPending >= this.actionCriticalBacklogThreshold;
    return {
      code: 'action-queue-critical-backlog',
      level: critical ? 'critical' : 'warning',
      title: critical
        ? 'Critical MAX actions накапливаются'
        : 'Critical MAX actions ожидают worker',
      detail: `pending: critical ${criticalPending}, interactive ${pending(MAX_ACTION_INTERACTIVE_QUEUE)}, background ${pending(MAX_ACTION_BACKGROUND_QUEUE)}, legacy ${pending(MAX_ACTION_LEGACY_QUEUE)}.`,
      recommendedAction:
        'Проверьте api-action, per-lane workers и MAX limiter/circuit. Не переносите jobs между очередями вручную.',
    };
  }

  private buildActionLedgerWatchdogAlert(
    snapshot: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['actionLedgerWatchdog'],
  ): SystemDashboardAlert | null {
    if (!snapshot) {
      return null;
    }

    const quarantined = snapshot.lastQuarantinedCount > 0;
    if (!snapshot.lastError && snapshot.staleCount === 0 && !quarantined) {
      return null;
    }

    const details = [
      `mode ${snapshot.mode}`,
      snapshot.lastError ? `последняя ошибка: ${snapshot.lastError}` : null,
      snapshot.staleCount > 0
        ? `stale: ${snapshot.staleCount} (enqueued ${snapshot.staleEnqueuedCount}, in-progress ${snapshot.staleInProgressCount}, retryable ${snapshot.staleRetryableCount}), oldest ${snapshot.oldestStaleAgeSec.toFixed(1)} сек`
        : null,
      snapshot.lastReconciledCount > 0
        ? `reconciled ${snapshot.lastReconciledCount}, requeued ${snapshot.lastRequeuedCount}, retry orphans terminalized ${snapshot.lastRetryOrphanTerminalizedCount}, quarantined ${snapshot.lastQuarantinedCount}, terminal failed ${snapshot.lastTerminalFailedCount}`
        : null,
      snapshot.lastShadowClassifiedCount > 0
        ? `shadow classified ${snapshot.lastShadowClassifiedCount}, would requeue ${snapshot.lastWouldRequeueCount}, would quarantine ${snapshot.lastWouldQuarantineCount}, would terminal-fail ${snapshot.lastWouldTerminalFailCount}, would recover ${snapshot.lastWouldRecoverSucceededCount}`
        : null,
      snapshot.lastRunAt ? `last run ${snapshot.lastRunAt}` : 'watchdog ещё не запускался',
    ].filter((item): item is string => item !== null);

    return {
      code: quarantined ? 'action-ledger-watchdog-quarantine' : 'action-ledger-watchdog',
      level: quarantined ? 'critical' : 'warning',
      title: quarantined
        ? 'Action ledger содержит новый неоднозначный исход'
        : 'Action ledger watchdog требует внимания',
      detail: details.join('; '),
      recommendedAction: quarantined
        ? 'Не повторяйте действие автоматически. Сверьте MAX, логи и объект назначения до ручного решения.'
        : 'Проверьте BullMQ action queues и состояние PostgreSQL; автоматическое восстановление ограничено свежими pre-dispatch member actions.',
    };
  }

  private buildFallbackWebhookSubscriptionSnapshot(): WebhookSubscriptionSnapshot {
    return {
      status: 'warning',
      configured: false,
      url: null,
      checkedAt: null,
      reconciledAt: null,
      requiredUpdateTypes: [],
      actualUpdateTypes: [],
      missingUpdateTypes: [],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: null,
      note: 'Webhook subscription snapshot пока недоступен.',
      botCount: 0,
      bots: {},
    };
  }

  private buildFallbackOwnershipSnapshot(): BotOwnershipFoundationSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      bots: {
        configured: 0,
        adminVisible: 0,
        active: 0,
        dormant: 0,
        draining: 0,
        disabled: 0,
      },
      entities: {
        total: {
          total: 0,
          withPrimary: 0,
          withoutPrimary: 0,
          coverageRatio: 1,
        },
        chats: {
          total: 0,
          withPrimary: 0,
          withoutPrimary: 0,
          coverageRatio: 1,
        },
        channels: {
          total: 0,
          withPrimary: 0,
          withoutPrimary: 0,
          coverageRatio: 1,
        },
      },
      routingStates: {
        ready: 0,
        noEligibleBot: 0,
      },
      anomalies: {
        noPrimary: 0,
        recoverableLegacyOnly: 0,
        recoverableFromMemberships: 0,
        noEligibleBot: 0,
        unbound: 0,
        primaryBotUnknown: 0,
        legacyBotUnknown: 0,
        activeMembershipBotUnknown: 0,
        primaryWithoutActiveMembership: 0,
        primaryWithoutAdminAccess: 0,
        sharedChats: 0,
      },
      repair: {
        enabled: false,
        activeOnThisRole: false,
        intervalMs: 300_000,
        rebalanceMode: 'off',
        rebalanceCanaryPercent: 0,
        rebalanceMaxMovesPerRun: 25,
        recommendedMoves: 0,
        lastAppliedMoves: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastAppliedChanges: 0,
        totalAppliedChanges: 0,
      },
    };
  }

  private buildOwnershipRepairAlert(
    ownership: BotOwnershipFoundationSnapshot,
  ): SystemDashboardAlert | null {
    if (ownership.repair.lastError) {
      return {
        code: 'ownership-repair-error',
        level: 'warning',
        title: 'Ownership foundation repair не завершился чисто',
        detail: `Последняя ошибка repair: ${ownership.repair.lastError}. Snapshot остаётся доступным, но multi-bot rollout лучше не продолжать до исправления.`,
        recommendedAction:
          'Проверьте api-admin logs и состояние chats/chat_bot_memberships. Не активируйте новых ботов, пока repair снова не станет зелёным.',
      };
    }

    if (!ownership.repair.enabled || !ownership.repair.lastSuccessAt) {
      return null;
    }

    const ageMs = Date.now() - Date.parse(ownership.repair.lastSuccessAt);
    if (!Number.isFinite(ageMs) || ageMs <= ownership.repair.intervalMs * 2) {
      return null;
    }

    return {
      code: 'ownership-repair-stale',
      level: 'warning',
      title: 'Ownership foundation snapshot устарел',
      detail: `Последний успешный repair был ${ownership.repair.lastSuccessAt}, что заметно старше ожидаемого окна ${Math.round(ownership.repair.intervalMs / 60_000)} мин.`,
      recommendedAction:
        'Проверьте, что api-admin работает и Redis lock не завис. До обновления snapshot не используйте ownership цифры как основание для multi-bot rollout.',
    };
  }

  private buildOwnershipCoverageAlert(
    ownership: BotOwnershipFoundationSnapshot,
  ): SystemDashboardAlert | null {
    const recoverableNow =
      ownership.anomalies.recoverableLegacyOnly + ownership.anomalies.recoverableFromMemberships;
    const unresolvedKnownIssues =
      ownership.anomalies.primaryBotUnknown +
      ownership.anomalies.legacyBotUnknown +
      ownership.anomalies.activeMembershipBotUnknown +
      ownership.anomalies.primaryWithoutActiveMembership +
      ownership.anomalies.noEligibleBot;
    const rightsLimitedPrimaries = ownership.anomalies.primaryWithoutAdminAccess;
    const totalGaps = ownership.entities.total.withoutPrimary;

    if (totalGaps === 0 && unresolvedKnownIssues === 0) {
      return null;
    }

    const additionalBotsPrepared = ownership.bots.configured > 1 || ownership.bots.dormant > 0;
    const level =
      unresolvedKnownIssues > 0 || (additionalBotsPrepared && totalGaps > 0) ? 'warning' : 'info';
    const parts = [
      `valid ownership coverage ${ownership.entities.total.withPrimary}/${ownership.entities.total.total}`,
      `without primary ${totalGaps}`,
      `recoverable now ${recoverableNow}`,
    ];
    if (ownership.anomalies.unbound > 0) {
      parts.push(`unbound ${ownership.anomalies.unbound}`);
    }
    if (ownership.anomalies.noEligibleBot > 0) {
      parts.push(`no eligible bot ${ownership.anomalies.noEligibleBot}`);
    }
    if (unresolvedKnownIssues > 0) {
      parts.push(`known anomalies ${unresolvedKnownIssues}`);
    }
    if (rightsLimitedPrimaries > 0) {
      parts.push(`primary without admin access ${rightsLimitedPrimaries}`);
    }

    return {
      code: 'ownership-foundation',
      level,
      title:
        level === 'warning'
          ? 'Ownership foundation ещё не готов к multi-bot rollout'
          : 'Ownership foundation ещё не доведён до полной coverage',
      detail: `${parts.join(', ')}.`,
      recommendedAction:
        'Закройте recoverable ownership gaps и держите shared-chat rollout выключенным, пока unbound/unknown/no-eligible cases не станут понятными оператору. Для no-eligible объектов выполните targeted access probe; не реактивируйте memberships массово.',
    };
  }

  private buildOwnershipRebalanceAlert(
    ownership: BotOwnershipFoundationSnapshot,
  ): SystemDashboardAlert | null {
    if (ownership.repair.recommendedMoves <= 0) {
      return null;
    }

    const mode = ownership.repair.rebalanceMode;
    return {
      code: `ownership-rebalance-${mode}`,
      level: 'info',
      title:
        mode === 'shadow'
          ? 'Ownership rebalance работает в shadow-режиме'
          : 'Ownership rebalance выполняется постепенно',
      detail: `Детерминированное распределение рекомендует ${ownership.repair.recommendedMoves} перемещений; последний запуск применил ${ownership.repair.lastAppliedMoves}.`,
      recommendedAction:
        mode === 'shadow' || mode === 'off'
          ? 'Сравните per-bot load и access snapshots перед включением canary.'
          : `Контролируйте failover и duplicate-action метрики; лимит одного запуска ${ownership.repair.rebalanceMaxMovesPerRun}.`,
    };
  }

  private buildDefaultWorkerSkewAlert(
    workerGroups?: Awaited<
      ReturnType<QueueMetricsService['getSnapshot']>
    >['webhookDefaultWorkerGroups'],
  ): SystemDashboardAlert | null {
    if (!workerGroups) {
      return null;
    }

    const groupLoads = Object.entries(workerGroups)
      .map(([groupName, metrics]) => ({
        groupName,
        queues: metrics.queues,
        pressure:
          metrics.counters.waiting + (metrics.counters.prioritized ?? 0) + metrics.counters.active,
      }))
      .filter((entry) => entry.pressure > 0)
      .sort((left, right) => right.pressure - left.pressure);

    const primary = groupLoads[0];
    if (!primary) {
      return null;
    }

    const totalPressure = groupLoads.reduce((sum, entry) => sum + entry.pressure, 0);
    if (totalPressure < DEFAULT_WORKER_SKEW_WARNING_PRESSURE) {
      return null;
    }

    const share = primary.pressure / totalPressure;
    if (share < DEFAULT_WORKER_SKEW_WARNING_RATIO) {
      return null;
    }

    const critical =
      primary.pressure >= DEFAULT_WORKER_SKEW_CRITICAL_PRESSURE &&
      share >= DEFAULT_WORKER_SKEW_CRITICAL_RATIO;

    return {
      code: 'default-worker-skew',
      level: critical ? 'critical' : 'warning',
      title: critical
        ? 'Один realtime worker забирает почти весь default burst'
        : 'Нагрузка default shard’ов перекошена по worker groups',
      detail: `${primary.groupName} сейчас держит ${primary.pressure} из ${totalPressure} active+pending по default webhook (${primary.queues.join(', ')}).`,
      recommendedAction:
        'Если перекос держится дольше пары минут, проверьте hot chats и текущую shard ownership map перед ростом concurrency.',
    };
  }

  private buildDynamicLeaseAlert(
    leaseSnapshot?: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['webhookDynamicLeases'],
  ): SystemDashboardAlert | null {
    if (!leaseSnapshot) {
      return null;
    }

    const queueEntries = Object.values(leaseSnapshot.queues);
    const recommendedMoves = queueEntries.filter(
      (entry) => entry.eligibleForDynamicLeases && entry.actualOwner !== entry.desiredOwner,
    ).length;
    const pendingHandoffs = queueEntries.filter((entry) => entry.handoffPending).length;
    if (leaseSnapshot.mode === 'shadow' && recommendedMoves > 0) {
      return {
        code: 'dynamic-lease-shadow',
        level: 'info',
        title: 'Dynamic leases работают в shadow-режиме',
        detail: `Планировщик уже рекомендовал ${recommendedMoves} перенос(а/ов) default shard’ов, но handoff ещё не включён.`,
        recommendedAction:
          'Проверьте suggested ownership и latency перед переходом к canary для небольшой группы shard’ов.',
      };
    }

    if ((leaseSnapshot.mode === 'canary' || leaseSnapshot.mode === 'on') && pendingHandoffs > 0) {
      return {
        code: 'dynamic-lease-handoff',
        level: 'info',
        title: 'Dynamic leases выполняют handoff shard’ов',
        detail: `Сейчас в handoff pending находится ${pendingHandoffs} shard’ов.`,
        recommendedAction:
          'Следите, чтобы handoff быстро сходился и не приводил к росту queue lag или duplicate processing.',
      };
    }

    return null;
  }

  private buildJoinBurstAlert(
    joinCounters:
      | Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['webhookJoin']
      | undefined,
    userFacingLagSec: number,
  ): SystemDashboardAlert | null {
    if (!joinCounters) {
      return null;
    }

    const pressure = joinCounters.waiting + joinCounters.active;
    if (pressure < JOIN_BURST_WARNING_PRESSURE || userFacingLagSec > QUEUE_LAG_WARNING_SEC) {
      return null;
    }

    const critical = pressure >= JOIN_BURST_CRITICAL_PRESSURE;
    return {
      code: 'join-burst-isolated',
      level: critical ? 'warning' : 'info',
      title: critical
        ? 'Join lane держит заметный burst'
        : 'Join lane принял локальный всплеск без влияния на ответы бота',
      detail: `В join lane сейчас ${pressure} active+waiting, при этом user-facing lag остаётся ${userFacingLagSec.toFixed(1)} сек.`,
      recommendedAction:
        'Проверьте hot chat по user_added и greeting/join path. Realtime default path сейчас изолирован и не требует срочного вмешательства.',
    };
  }

  private readNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readDate(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
}
