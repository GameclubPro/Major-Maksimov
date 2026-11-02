import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BotWebhookOperationalDiagnostics,
  BotWebhookSubscriptionSnapshot,
  WebhookSubscriptionSnapshot,
} from '@maxim/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import { getAppRole, roleRunsIngress } from '../runtime/app-role';
import {
  WebhookSubscriptionStatusService,
  type WebhookSubscriptionBotSyncState,
  type WebhookSubscriptionSyncState,
} from '../system/webhook-subscription-status.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from './max-client.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';
import { resolveRequiredWebhookUpdateTypes } from './max-webhook-subscription.constants';

const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 1_000;
const DEFAULT_STALE_INGRESS_MS = 5 * 60 * 1_000;
type BotWebhookMembershipDiagnostics = {
  activeMemberships: number;
  lastMembershipWebhookAt: string | null;
};
type ConfiguredWebhookSubscriptionTarget = {
  url: string | null;
  maskedUrl: string | null;
};

@Injectable()
export class MaxWebhookSubscriptionReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxWebhookSubscriptionReconcilerService.name);
  private readonly enabled = roleRunsIngress(getAppRole());
  private readonly reconcileIntervalMs: number;
  private readonly staleIngressMs: number;
  private readonly requiredUpdateTypes: readonly string[];
  private readonly requiredUpdateTypesSet: ReadonlySet<string>;
  private readonly replaceUpdateTypes: boolean;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly webhookSubscriptionStatusService: WebhookSubscriptionStatusService,
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.reconcileIntervalMs = configService.get<number>(
      'MAX_WEBHOOK_RECONCILE_INTERVAL_MS',
      DEFAULT_RECONCILE_INTERVAL_MS,
    );
    this.staleIngressMs = configService.get<number>(
      'MAX_WEBHOOK_STALE_INGRESS_MS',
      DEFAULT_STALE_INGRESS_MS,
    );
    const extendedLifecycleMode = configService.get<string>(
      'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE',
      'shadow',
    );
    this.requiredUpdateTypes = resolveRequiredWebhookUpdateTypes(extendedLifecycleMode);
    this.requiredUpdateTypesSet = new Set(this.requiredUpdateTypes);
    this.replaceUpdateTypes = extendedLifecycleMode === 'off';
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.reconcile('scheduled');
    }, this.reconcileIntervalMs);
    this.timer.unref();

    await this.reconcile('startup');
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async reconcile(reason: 'startup' | 'scheduled'): Promise<void> {
    if (this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      const syncState = await this.webhookSubscriptionStatusService.getSyncState();
      const operationalBots = this.getOperationalBots();
      const botIds = operationalBots.map((bot) => bot.id);
      const [latestRecordedIncomingByBot, membershipDiagnosticsByBot] = await Promise.all([
        this.resolveLatestRecordedIncomingWebhookAtByBot(syncState, botIds),
        this.resolveMembershipDiagnosticsByBot(botIds),
      ]);
      const latestRecordedIncomingWebhookAt = this.resolveLatestIso(
        Object.values(latestRecordedIncomingByBot),
      );
      const botResults: Array<{
        snapshot: BotWebhookSubscriptionSnapshot;
        syncState: WebhookSubscriptionBotSyncState;
      }> = [];
      let previousSnapshot: WebhookSubscriptionSnapshot | null | undefined;
      let previousSnapshotLoaded = false;
      const getPreviousSnapshot = async (): Promise<WebhookSubscriptionSnapshot | null> => {
        if (previousSnapshotLoaded) {
          return previousSnapshot ?? null;
        }

        previousSnapshotLoaded = true;
        try {
          previousSnapshot = await this.webhookSubscriptionStatusService.getSnapshot();
        } catch (error: unknown) {
          this.logger.warn(
            {
              reason,
              errorType: this.describeErrorType(error),
            },
            'Failed to load the previous MAX webhook subscription snapshot',
          );
        }

        return previousSnapshot ?? null;
      };
      for (const bot of operationalBots) {
        const previousBotSyncState = syncState?.bots?.[bot.id] ?? null;
        const botState = {
          latestRecordedIncomingWebhookAt: latestRecordedIncomingByBot[bot.id] ?? null,
          membershipDiagnostics: membershipDiagnosticsByBot[bot.id] ?? {
            activeMemberships: 0,
            lastMembershipWebhookAt: null,
          },
        };

        let target: ConfiguredWebhookSubscriptionTarget | null = null;
        try {
          target = this.maxClient.getConfiguredWebhookSubscriptionTarget(bot.id);
          botResults.push(
            await this.reconcileBot(bot, previousBotSyncState, botState, reason, target),
          );
        } catch (error: unknown) {
          const lastError = this.describeBotReconcileError(bot.id, error);
          const previousBotSnapshot = (await getPreviousSnapshot())?.bots?.[bot.id] ?? null;
          botResults.push(
            this.createFailedBotReconcileResult({
              bot,
              syncState: previousBotSyncState,
              botState,
              previousSnapshot: previousBotSnapshot,
              target,
              lastError,
            }),
          );
          this.logger.warn(
            {
              reason,
              botId: bot.id,
              errorType: this.describeErrorType(error),
            },
            'Failed to reconcile MAX webhook subscriptions for one bot',
          );
        }
      }
      const botSnapshots = Object.fromEntries(
        botResults.map((result) => [result.snapshot.botId, result.snapshot]),
      );
      const lastGlobalAutoRecreateAt =
        botResults
          .map((result) => result.syncState.lastAutoRecreateAt)
          .filter((value): value is string => typeof value === 'string')
          .sort((left, right) => right.localeCompare(left))[0] ??
        syncState?.lastGlobalAutoRecreateAt ??
        null;

      await this.webhookSubscriptionStatusService.writeSyncState({
        bots: Object.fromEntries(
          botResults.map((result) => [result.snapshot.botId, result.syncState]),
        ),
        lastGlobalIncomingWebhookAt: latestRecordedIncomingWebhookAt,
        lastGlobalAutoRecreateAt,
      });
      await this.webhookSubscriptionStatusService.writeSnapshot(
        this.buildAggregateSnapshot(botSnapshots, reason),
      );
    } catch (error: unknown) {
      const previous =
        (await this.webhookSubscriptionStatusService.getSnapshot().catch(() => null)) ??
        this.createDisabledSnapshot('Webhook coverage ещё не была синхронизирована.');
      const lastError = error instanceof Error ? error.message : String(error);
      await this.webhookSubscriptionStatusService
        .writeSnapshot({
          ...previous,
          status: previous.status === 'critical' ? 'critical' : 'warning',
          lastError,
          note: 'Последняя проверка webhook subscription завершилась с ошибкой.',
        })
        .catch((snapshotError: unknown) => {
          this.logger.warn(
            { reason, errorType: this.describeErrorType(snapshotError) },
            'Failed to persist MAX webhook subscription failure snapshot',
          );
        });
      this.logger.warn(
        {
          reason,
          err: lastError,
        },
        'Failed to reconcile MAX webhook subscriptions',
      );
    } finally {
      this.inFlight = false;
    }
  }

  private getOperationalBots(): MaxBotDefinition[] {
    if (typeof this.maxBotRegistry.getOperationalBots === 'function') {
      return [...this.maxBotRegistry.getOperationalBots()];
    }

    if (typeof this.maxBotRegistry.getAllBots === 'function') {
      return [...this.maxBotRegistry.getAllBots()];
    }

    return [];
  }

  private resolveStatus(input: {
    configured: boolean;
    hasCurrentSubscription: boolean;
    missingUpdateTypes: readonly string[];
    extraUpdateTypes: readonly string[];
    otherSubscriptionsCount: number;
    staleIngress: boolean;
    operationalIssues: readonly string[];
  }): WebhookSubscriptionSnapshot['status'] {
    if (!input.configured) {
      return 'disabled';
    }

    if (!input.hasCurrentSubscription || input.missingUpdateTypes.length > 0) {
      return 'critical';
    }

    if (input.extraUpdateTypes.length > 0 || input.otherSubscriptionsCount > 0) {
      return 'warning';
    }

    if (input.staleIngress) {
      return 'warning';
    }

    if (input.operationalIssues.length > 0) {
      return 'warning';
    }

    return 'healthy';
  }

  private resolveAggregateStatus(
    snapshots: readonly BotWebhookSubscriptionSnapshot[],
  ): WebhookSubscriptionSnapshot['status'] {
    if (snapshots.length === 0) {
      return 'disabled';
    }

    if (snapshots.every((snapshot) => snapshot.status === 'disabled')) {
      return 'disabled';
    }

    if (snapshots.some((snapshot) => snapshot.status === 'critical')) {
      return 'critical';
    }

    if (
      snapshots.some((snapshot) => snapshot.status === 'warning' || snapshot.status === 'disabled')
    ) {
      return 'warning';
    }

    return 'healthy';
  }

  private async reconcileBot(
    bot: MaxBotDefinition,
    syncState: WebhookSubscriptionBotSyncState | null,
    botState: {
      latestRecordedIncomingWebhookAt: string | null;
      membershipDiagnostics: BotWebhookMembershipDiagnostics;
    },
    reason: 'startup' | 'scheduled',
    target: ConfiguredWebhookSubscriptionTarget,
  ): Promise<{
    snapshot: BotWebhookSubscriptionSnapshot;
    syncState: WebhookSubscriptionBotSyncState;
  }> {
    const checkedAt = new Date().toISOString();
    const headerSecretFingerprint = this.maxBotRegistry.computeWebhookHeaderSecretFingerprint(
      bot.id,
    );

    if (!target.url) {
      return {
        snapshot: {
          botId: bot.id,
          status: 'disabled',
          configured: false,
          url: null,
          checkedAt,
          reconciledAt: null,
          requiredUpdateTypes: [...this.requiredUpdateTypes],
          actualUpdateTypes: [],
          missingUpdateTypes: [...this.requiredUpdateTypes],
          extraUpdateTypes: [],
          otherSubscriptionsCount: 0,
          lastError: null,
          note: 'Webhook URL для этого бота не сконфигурирован.',
        },
        syncState: {
          configuredUrl: null,
          headerSecretFingerprint,
          updatedAt: checkedAt,
          lastIncomingWebhookAt:
            botState.latestRecordedIncomingWebhookAt ?? syncState?.lastIncomingWebhookAt ?? null,
          lastAutoRecreateAt: syncState?.lastAutoRecreateAt ?? null,
        },
      };
    }

    const existing = await this.maxClient.listWebhookSubscriptions({
      trafficClass: 'background',
      botId: bot.id,
      sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
    });
    const current = existing.find((item) =>
      this.maxClient.matchesConfiguredWebhookUrl(item.url, bot.id),
    );
    const actualUpdateTypes = [...(current?.updateTypes ?? [])].sort();
    const missingUpdateTypes = this.requiredUpdateTypes.filter(
      (type) => !actualUpdateTypes.includes(type),
    );
    const extraUpdateTypes = actualUpdateTypes.filter(
      (type) => !this.requiredUpdateTypesSet.has(type),
    );
    const previousConfiguredUrl =
      syncState?.configuredUrl && syncState.configuredUrl !== target.url
        ? syncState.configuredUrl
        : null;
    const shouldRotateWebhookSecret =
      !syncState?.headerSecretFingerprint ||
      syncState.headerSecretFingerprint !== headerSecretFingerprint;
    const staleIngress = this.isStaleIngress(botState.latestRecordedIncomingWebhookAt);
    let reconciledAt: string | null = null;
    let subscriptionsChanged = false;
    const deletedSubscriptionUrls = new Set<string>();
    if (
      shouldRotateWebhookSecret ||
      !current ||
      missingUpdateTypes.length > 0 ||
      (this.replaceUpdateTypes && extraUpdateTypes.length > 0)
    ) {
      await this.maxClient.ensureWebhookSubscription([...this.requiredUpdateTypes], {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
        ...(shouldRotateWebhookSecret ? { forceUpsert: true } : {}),
        ...(this.replaceUpdateTypes ? { replaceUpdateTypes: true } : {}),
      });
      reconciledAt = new Date().toISOString();
      subscriptionsChanged = true;
    }

    const establishedSubscriptions = subscriptionsChanged
      ? await this.maxClient.listWebhookSubscriptions({
          trafficClass: 'background',
          botId: bot.id,
          sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
        })
      : existing;
    const establishedCurrent = establishedSubscriptions.find((item) =>
      this.maxClient.matchesConfiguredWebhookUrl(item.url, bot.id),
    );
    if (
      !establishedCurrent ||
      this.requiredUpdateTypes.some((type) => !establishedCurrent.updateTypes.includes(type))
    ) {
      throw new Error('Current webhook subscription could not be confirmed');
    }

    if (previousConfiguredUrl) {
      const hasPreviousConfiguredUrl = establishedSubscriptions.some(
        (item) => item.url === previousConfiguredUrl,
      );
      if (hasPreviousConfiguredUrl) {
        await this.maxClient.deleteWebhookSubscription(previousConfiguredUrl, {
          trafficClass: 'background',
          botId: bot.id,
          sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
        });
        deletedSubscriptionUrls.add(previousConfiguredUrl);
        reconciledAt = reconciledAt ?? new Date().toISOString();
        subscriptionsChanged = true;
      }
    }

    for (const subscription of establishedSubscriptions) {
      if (
        deletedSubscriptionUrls.has(subscription.url) ||
        this.maxClient.matchesConfiguredWebhookUrl(subscription.url, bot.id) ||
        !this.isOwnedBotWebhookSubscriptionUrl(subscription.url, bot.id, target.url)
      ) {
        continue;
      }

      await this.maxClient.deleteWebhookSubscription(subscription.url, {
        trafficClass: 'background',
        botId: bot.id,
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
      });
      deletedSubscriptionUrls.add(subscription.url);
      reconciledAt = reconciledAt ?? new Date().toISOString();
      subscriptionsChanged = true;
    }

    const confirmedSubscriptions =
      deletedSubscriptionUrls.size > 0
        ? await this.maxClient.listWebhookSubscriptions({
            trafficClass: 'background',
            botId: bot.id,
            sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
          })
        : establishedSubscriptions;
    const refreshedCurrent = confirmedSubscriptions.find((item) =>
      this.maxClient.matchesConfiguredWebhookUrl(item.url, bot.id),
    );
    const refreshedActualUpdateTypes = [...(refreshedCurrent?.updateTypes ?? [])].sort();
    const effectiveOtherSubscriptionsCount = confirmedSubscriptions.filter(
      (item) => !this.maxClient.matchesConfiguredWebhookUrl(item.url, bot.id),
    ).length;
    const operationalDiagnostics = this.buildOperationalDiagnostics({
      bot,
      hasCurrentSubscription: Boolean(refreshedCurrent?.url),
      latestRecordedIncomingWebhookAt: botState.latestRecordedIncomingWebhookAt,
      membershipDiagnostics: botState.membershipDiagnostics,
    });
    const operationalIssues = operationalDiagnostics?.issueCodes ?? [];

    return {
      snapshot: {
        botId: bot.id,
        status: this.resolveStatus({
          configured: true,
          hasCurrentSubscription: Boolean(refreshedCurrent?.url),
          missingUpdateTypes:
            reconciledAt === null
              ? missingUpdateTypes
              : this.requiredUpdateTypes.filter(
                  (type) => !refreshedActualUpdateTypes.includes(type),
                ),
          extraUpdateTypes: refreshedActualUpdateTypes.filter(
            (type) => !this.requiredUpdateTypesSet.has(type),
          ),
          otherSubscriptionsCount: effectiveOtherSubscriptionsCount,
          staleIngress,
          operationalIssues,
        }),
        configured: true,
        url: target.maskedUrl,
        checkedAt,
        reconciledAt,
        requiredUpdateTypes: [...this.requiredUpdateTypes],
        actualUpdateTypes: refreshedActualUpdateTypes,
        missingUpdateTypes: this.requiredUpdateTypes.filter(
          (type) => !refreshedActualUpdateTypes.includes(type),
        ),
        extraUpdateTypes: refreshedActualUpdateTypes.filter(
          (type) => !this.requiredUpdateTypesSet.has(type),
        ),
        otherSubscriptionsCount: effectiveOtherSubscriptionsCount,
        lastError: null,
        note:
          this.buildOperationalBotNote(bot.id, operationalDiagnostics) ??
          this.buildBotNote({
            botId: bot.id,
            reason,
            staleIngressAt: botState.latestRecordedIncomingWebhookAt,
          }),
        ...(operationalDiagnostics ? { operationalDiagnostics } : {}),
      },
      syncState: {
        configuredUrl: target.url,
        headerSecretFingerprint,
        updatedAt: checkedAt,
        lastIncomingWebhookAt:
          botState.latestRecordedIncomingWebhookAt ?? syncState?.lastIncomingWebhookAt ?? null,
        lastAutoRecreateAt: syncState?.lastAutoRecreateAt ?? null,
      },
    };
  }

  private createFailedBotReconcileResult(params: {
    bot: MaxBotDefinition;
    syncState: WebhookSubscriptionBotSyncState | null;
    botState: {
      latestRecordedIncomingWebhookAt: string | null;
      membershipDiagnostics: BotWebhookMembershipDiagnostics;
    };
    previousSnapshot: BotWebhookSubscriptionSnapshot | null;
    target: ConfiguredWebhookSubscriptionTarget | null;
    lastError: string;
  }): {
    snapshot: BotWebhookSubscriptionSnapshot;
    syncState: WebhookSubscriptionBotSyncState;
  } {
    const checkedAt = new Date().toISOString();
    const previousSnapshot = params.previousSnapshot;
    const configured =
      previousSnapshot?.configured ??
      Boolean(params.target?.url ?? params.syncState?.configuredUrl);

    return {
      snapshot: {
        botId: params.bot.id,
        status: previousSnapshot?.status === 'critical' ? 'critical' : 'warning',
        configured,
        url: previousSnapshot?.url ?? params.target?.maskedUrl ?? null,
        checkedAt,
        reconciledAt: previousSnapshot?.reconciledAt ?? null,
        requiredUpdateTypes: previousSnapshot?.requiredUpdateTypes ?? [...this.requiredUpdateTypes],
        actualUpdateTypes: previousSnapshot?.actualUpdateTypes ?? [],
        missingUpdateTypes: previousSnapshot?.missingUpdateTypes ?? [],
        extraUpdateTypes: previousSnapshot?.extraUpdateTypes ?? [],
        otherSubscriptionsCount: previousSnapshot?.otherSubscriptionsCount ?? 0,
        lastError: params.lastError,
        note: `Не удалось синхронизировать webhook subscription для ${params.bot.id}; сохранено последнее известное состояние.`,
        ...(previousSnapshot?.operationalDiagnostics
          ? { operationalDiagnostics: previousSnapshot.operationalDiagnostics }
          : {}),
      },
      syncState: {
        configuredUrl: params.syncState?.configuredUrl ?? params.target?.url ?? null,
        headerSecretFingerprint: params.syncState?.headerSecretFingerprint ?? null,
        updatedAt: params.syncState?.updatedAt ?? checkedAt,
        lastIncomingWebhookAt:
          params.botState.latestRecordedIncomingWebhookAt ??
          params.syncState?.lastIncomingWebhookAt ??
          null,
        lastAutoRecreateAt: params.syncState?.lastAutoRecreateAt ?? null,
      },
    };
  }

  private describeBotReconcileError(botId: string, error: unknown): string {
    return `Не удалось синхронизировать webhook subscription для ${botId} (${this.describeErrorType(error)}).`;
  }

  private describeErrorType(error: unknown): string {
    return error instanceof Error && error.name ? error.name : 'unknown error';
  }

  private buildOperationalDiagnostics(params: {
    bot: MaxBotDefinition;
    hasCurrentSubscription: boolean;
    latestRecordedIncomingWebhookAt: string | null;
    membershipDiagnostics: BotWebhookMembershipDiagnostics;
  }): BotWebhookOperationalDiagnostics | null {
    if (params.bot.state !== 'active') {
      return null;
    }

    const issueCodes: BotWebhookOperationalDiagnostics['issueCodes'] = [];
    if (params.hasCurrentSubscription && params.membershipDiagnostics.activeMemberships === 0) {
      issueCodes.push('no-active-memberships');
    }
    if (params.hasCurrentSubscription && !params.latestRecordedIncomingWebhookAt) {
      issueCodes.push('no-incoming-webhooks');
    }

    return {
      lifecycleState: params.bot.state,
      activeMemberships: params.membershipDiagnostics.activeMemberships,
      hasCurrentSubscription: params.hasCurrentSubscription,
      lastIncomingWebhookAt: params.latestRecordedIncomingWebhookAt,
      lastMembershipWebhookAt: params.membershipDiagnostics.lastMembershipWebhookAt,
      issueCodes,
    };
  }

  private isOwnedBotWebhookSubscriptionUrl(url: string, botId: string, targetUrl: string): boolean {
    try {
      const parsed = new URL(url);
      const target = new URL(targetUrl);
      const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
      return (
        parsed.origin === target.origin &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash &&
        segments.length === 5 &&
        segments[0] === 'api' &&
        segments[1] === 'webhook' &&
        segments[2] === 'max' &&
        decodeURIComponent(segments[3] ?? '') === botId &&
        segments[4].length > 0
      );
    } catch {
      return false;
    }
  }

  private buildOperationalBotNote(
    botId: string,
    diagnostics: BotWebhookOperationalDiagnostics | null,
  ): string | null {
    const issueCodes = diagnostics?.issueCodes ?? [];
    if (issueCodes.length === 0) {
      return null;
    }

    const details: string[] = [];
    if (issueCodes.includes('no-active-memberships')) {
      details.push('нет active chat_bot_memberships');
    }
    if (issueCodes.includes('no-incoming-webhooks')) {
      details.push('нет записанных входящих webhook');
    }

    return `Активный бот ${botId} имеет webhook subscription, но ${details.join(' и ')}.`;
  }

  private buildBotNote(params: {
    botId: string;
    reason: 'startup' | 'scheduled';
    staleIngressAt: string | null;
  }): string {
    if (this.isStaleIngress(params.staleIngressAt)) {
      return `Свежие входящие webhook по ${params.botId} не наблюдались с ${params.staleIngressAt}; subscription проверена через GET и оставлена без разрыва доставки.`;
    }

    return params.reason === 'startup'
      ? `Webhook coverage для ${params.botId} проверена при старте ingress.`
      : `Webhook coverage для ${params.botId} поддерживается фоновым reconcile.`;
  }

  private isStaleIngress(lastIngressAt: string | null): boolean {
    if (!lastIngressAt) {
      return false;
    }

    const lastIngressAtMs = Date.parse(lastIngressAt);
    if (!Number.isFinite(lastIngressAtMs)) {
      return false;
    }

    return Date.now() - lastIngressAtMs >= this.staleIngressMs;
  }

  private async resolveLatestRecordedIncomingWebhookAtByBot(
    syncState: WebhookSubscriptionSyncState | null,
    botIds: readonly string[],
  ): Promise<Record<string, string | null>> {
    const normalizedBotIds = [...new Set(botIds.map((botId) => botId.trim()).filter(Boolean))];
    if (normalizedBotIds.length === 0) {
      return {};
    }

    const latestMembershipRows = await this.prisma.chatBotMembership.groupBy({
      by: ['botId'],
      _max: {
        lastWebhookAt: true,
      },
      where: {
        botId: {
          in: normalizedBotIds,
        },
        lastWebhookAt: {
          not: null,
        },
      },
    });
    const latestMembershipByBot = new Map(
      latestMembershipRows.map((row) => [row.botId, row._max.lastWebhookAt?.toISOString() ?? null]),
    );

    return Object.fromEntries(
      normalizedBotIds.map((botId) => [
        botId,
        this.resolveLatestIso([
          syncState?.bots?.[botId]?.lastIncomingWebhookAt ?? null,
          latestMembershipByBot.get(botId) ?? null,
        ]),
      ]),
    );
  }

  private async resolveMembershipDiagnosticsByBot(
    botIds: readonly string[],
  ): Promise<Record<string, BotWebhookMembershipDiagnostics>> {
    const normalizedBotIds = [...new Set(botIds.map((botId) => botId.trim()).filter(Boolean))];
    if (normalizedBotIds.length === 0) {
      return {};
    }

    const rows = await this.prisma.chatBotMembership.groupBy({
      by: ['botId'],
      _count: {
        _all: true,
      },
      _max: {
        lastWebhookAt: true,
      },
      where: {
        botId: {
          in: normalizedBotIds,
        },
        status: ChatBotMembershipStatus.ACTIVE,
      },
    });
    const byBot = new Map(
      rows.map((row) => [
        row.botId,
        {
          activeMemberships: row._count._all,
          lastMembershipWebhookAt: row._max.lastWebhookAt?.toISOString() ?? null,
        } satisfies BotWebhookMembershipDiagnostics,
      ]),
    );

    return Object.fromEntries(
      normalizedBotIds.map((botId) => [
        botId,
        byBot.get(botId) ?? {
          activeMemberships: 0,
          lastMembershipWebhookAt: null,
        },
      ]),
    );
  }

  private resolveLatestIso(values: Iterable<string | null | undefined>): string | null {
    let latest: string | null = null;
    for (const value of values) {
      if (!value) {
        continue;
      }

      if (!latest || value.localeCompare(latest) > 0) {
        latest = value;
      }
    }

    return latest;
  }

  private buildAggregateSnapshot(
    snapshotsByBot: Record<string, BotWebhookSubscriptionSnapshot>,
    reason: 'startup' | 'scheduled',
  ): WebhookSubscriptionSnapshot {
    const snapshots = Object.values(snapshotsByBot);
    const aggregateActualUpdateTypes = Array.from(
      new Set(snapshots.flatMap((snapshot) => snapshot.actualUpdateTypes)),
    ).sort();
    const aggregateMissingUpdateTypes = Array.from(
      new Set(snapshots.flatMap((snapshot) => snapshot.missingUpdateTypes)),
    ).sort();
    const aggregateExtraUpdateTypes = Array.from(
      new Set(snapshots.flatMap((snapshot) => snapshot.extraUpdateTypes)),
    ).sort();
    const reconciledAtCandidates = snapshots
      .map((snapshot) => snapshot.reconciledAt)
      .filter((value): value is string => typeof value === 'string');
    const lastError = snapshots.find((snapshot) => snapshot.lastError)?.lastError ?? null;
    const failedBotIds = snapshots
      .filter((snapshot) => snapshot.lastError !== null)
      .map((snapshot) => snapshot.botId);
    const defaultBotId =
      typeof this.maxBotRegistry.getDefaultBot === 'function'
        ? this.maxBotRegistry.getDefaultBot().id
        : (snapshots[0]?.botId ?? null);
    const defaultBotUrl =
      snapshots.find((snapshot) => snapshot.botId === defaultBotId)?.url ?? null;

    return {
      status: this.resolveAggregateStatus(snapshots),
      configured: snapshots.length > 0 && snapshots.every((snapshot) => snapshot.configured),
      url: snapshots.length === 1 ? (snapshots[0]?.url ?? null) : defaultBotUrl,
      checkedAt: new Date().toISOString(),
      reconciledAt:
        reconciledAtCandidates.length > 0
          ? (reconciledAtCandidates.sort((left, right) => right.localeCompare(left))[0] ?? null)
          : null,
      requiredUpdateTypes: [...this.requiredUpdateTypes],
      actualUpdateTypes: aggregateActualUpdateTypes,
      missingUpdateTypes: aggregateMissingUpdateTypes,
      extraUpdateTypes: aggregateExtraUpdateTypes,
      otherSubscriptionsCount: snapshots.reduce(
        (total, snapshot) => total + snapshot.otherSubscriptionsCount,
        0,
      ),
      lastError,
      note:
        failedBotIds.length > 0
          ? `Webhook coverage не удалось синхронизировать для ${failedBotIds.join(', ')}; состояние остальных ботов обновлено.`
          : snapshots.length <= 1
            ? reason === 'startup'
              ? 'Webhook coverage проверена при старте ingress.'
              : 'Webhook coverage поддерживается фоновым reconcile.'
            : `Webhook coverage синхронизирована для ${snapshots.length} ботов.`,
      botCount: snapshots.length,
      bots: snapshotsByBot,
      operationalDiagnostics: this.buildAggregateOperationalDiagnostics(snapshots),
    };
  }

  private buildAggregateOperationalDiagnostics(
    snapshots: readonly BotWebhookSubscriptionSnapshot[],
  ): NonNullable<WebhookSubscriptionSnapshot['operationalDiagnostics']> {
    const warningBotIds: string[] = [];
    const noActiveMembershipBotIds: string[] = [];
    const noIncomingWebhookBotIds: string[] = [];

    for (const snapshot of snapshots) {
      const issueCodes = snapshot.operationalDiagnostics?.issueCodes ?? [];
      if (issueCodes.length === 0) {
        continue;
      }

      warningBotIds.push(snapshot.botId);
      if (issueCodes.includes('no-active-memberships')) {
        noActiveMembershipBotIds.push(snapshot.botId);
      }
      if (issueCodes.includes('no-incoming-webhooks')) {
        noIncomingWebhookBotIds.push(snapshot.botId);
      }
    }

    return {
      warningBotCount: warningBotIds.length,
      warningBotIds,
      noActiveMembershipBotIds,
      noIncomingWebhookBotIds,
    };
  }

  private createDisabledSnapshot(note: string): WebhookSubscriptionSnapshot {
    return {
      status: 'disabled',
      configured: false,
      url: null,
      checkedAt: null,
      reconciledAt: null,
      requiredUpdateTypes: [...this.requiredUpdateTypes],
      actualUpdateTypes: [],
      missingUpdateTypes: [...this.requiredUpdateTypes],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: null,
      note,
      botCount: 0,
      bots: {},
    };
  }
}
