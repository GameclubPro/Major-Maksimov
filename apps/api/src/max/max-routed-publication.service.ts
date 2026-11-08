import { Injectable, Logger, Optional } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import {
  MaxActionDispatchService,
  type MaxActionDispatchExecutionOptions,
} from './max-action-dispatch.service';
import { MaxActionNoExecutableRouteError } from './max-action-dispatch-error';
import { MaxBotLinkService, type MaxBotRoute } from './max-bot-link.service';
import type {
  MaxActionLedgerContext,
  MaxActionJob,
  MaxApiTrafficClass,
  MaxPublishedMessage,
  MaxSendMessageOptions,
} from './max-client.service';
import { MaxClientService } from './max-client.service';
import { ManagedEntityAccessLossService } from './managed-entity-access-loss.service';
import {
  parseMaxFutureNightStickyRouteProbe,
  type MaxFutureNightStickyRouteProbe,
} from './max-send-route-sticky-probe';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { isPublisherBotId } from '../publisher/publisher-bot-descriptor';
import { resolveExplicitMembershipAccessDenial } from './max-membership-access-error';

export type MaxRoutedPublicationRoutePurpose = 'send_message' | 'channel_poll';

export type MaxRoutedPublicationAttemptContext = {
  botId: string;
  job: MaxActionJob;
};

export type MaxRoutedPublicationRequest = {
  entityId: string;
  logicalIdempotencyKey: string;
  text: string;
  options?: MaxSendMessageOptions;
  routePurpose?: MaxRoutedPublicationRoutePurpose;
  trafficClass: MaxApiTrafficClass;
  actionHealthLane?: MaxActionJob['actionHealthLane'];
  sourceTag: string;
  preferredBotId?: string;
  requiredBotId?: string;
  /** Exact publisher route already validated against PublisherEntityBinding by the caller. */
  publisherExactBotId?: string;
  sendRouteHalfOpenProbe?: 'publication_exact_verification';
  sendRouteStickyProbe?: MaxFutureNightStickyRouteProbe;
  timeoutMs?: number;
  hydrateMessageUrl?: boolean;
  ignoreFailureMetricStatuses?: readonly number[];
  prepareAttempt?: (context: MaxRoutedPublicationAttemptContext) => Promise<{
    text?: string;
    options?: MaxSendMessageOptions;
    ledgerContext?: MaxActionLedgerContext;
  }>;
  onDispatchAttempt?: (context: MaxRoutedPublicationAttemptContext) => void | Promise<void>;
  beforeSendMutation?: (context: MaxRoutedPublicationAttemptContext) => void | Promise<void>;
};

export type MaxRoutedPublicationResult = MaxPublishedMessage & {
  botId: string;
  candidateBotIds: string[];
  routingVersion: number | null;
};

const MANAGED_POLL_ROUTE_ACCESS_MAX_AGE_MS = 30 * 60_000;

@Injectable()
export class MaxRoutedPublicationService {
  private readonly logger = new Logger(MaxRoutedPublicationService.name);

  constructor(
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly maxActionDispatchService: MaxActionDispatchService,
    private readonly maxClientService: MaxClientService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
  ) {}

  async publish(request: MaxRoutedPublicationRequest): Promise<MaxRoutedPublicationResult> {
    const invocationReadyAt = new Date();
    const entityId = request.entityId.trim();
    const logicalIdempotencyKey = request.logicalIdempotencyKey.trim();
    if (!entityId) {
      throw new Error('entityId is required for routed MAX publication');
    }
    if (!logicalIdempotencyKey) {
      throw new Error('logicalIdempotencyKey is required for routed MAX publication');
    }

    const routePurpose = request.routePurpose ?? 'send_message';
    const publisherExactBotId = this.resolvePublisherExactBotId(request.publisherExactBotId);
    const requestedRequiredBotId = request.requiredBotId?.trim() ?? '';
    if (
      publisherExactBotId &&
      requestedRequiredBotId &&
      publisherExactBotId !== requestedRequiredBotId
    ) {
      throw new Error('Publisher exact route conflicts with requiredBotId');
    }
    const requiredBotId = publisherExactBotId || requestedRequiredBotId;
    const actionRoutePurpose = publisherExactBotId ? 'publisher_exact_send' : routePurpose;
    const baseJob: MaxActionJob = {
      actionType: 'SEND_MESSAGE',
      chatId: entityId,
      trafficClass: request.trafficClass,
      ...(request.actionHealthLane ? { actionHealthLane: request.actionHealthLane } : {}),
      sourceTag: request.sourceTag,
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.ignoreFailureMetricStatuses?.length
        ? { ignoreFailureMetricStatuses: [...request.ignoreFailureMetricStatuses] }
        : {}),
      text: request.text,
      ...(request.options ? { options: request.options } : {}),
      attempt: 1,
      idempotencyKey: logicalIdempotencyKey,
      createdAt: invocationReadyAt.toISOString(),
      ...(requiredBotId
        ? {
            routing: {
              purpose: actionRoutePurpose,
              requiredBotId,
            },
          }
        : {}),
    };
    const recovered = await this.maxActionDispatchService.recoverCompletedSend(baseJob);
    const recoveredBotId = recovered?.botId?.trim();
    if (recovered) {
      if (!recoveredBotId || (requiredBotId && recoveredBotId !== requiredBotId)) {
        throw new UnrecoverableError(
          `Recovered MAX publication ${logicalIdempotencyKey} is not bound to its required dispatch bot`,
        );
      }
      const url =
        recovered.url ??
        (await this.resolveRecoveredMessageUrl(request, {
          messageId: recovered.messageId,
          botId: recoveredBotId,
        }));
      return {
        messageId: recovered.messageId,
        url,
        ...(recovered.chatId ? { chatId: recovered.chatId } : {}),
        botId: recoveredBotId,
        candidateBotIds: [recoveredBotId],
        routingVersion: null,
      };
    }

    const route = publisherExactBotId
      ? {
          purpose: 'send_message' as const,
          chatId: entityId,
          primaryBotId: publisherExactBotId,
          botId: publisherExactBotId,
          candidateBotIds: [publisherExactBotId],
          reason: 'publisher_exact_binding',
          routingVersion: null,
        }
      : await this.resolveFreshRoute(entityId, routePurpose, request);
    const candidateBotIds = this.resolveRequestedCandidateBotIds(
      this.normalizeBotIds(route.candidateBotIds),
      request,
    );
    if (
      candidateBotIds.length === 0 &&
      (routePurpose === 'channel_poll' || Boolean(request.requiredBotId?.trim()))
    ) {
      throw new MaxActionNoExecutableRouteError('SEND_MESSAGE', entityId);
    }
    const job: MaxActionJob = {
      ...baseJob,
      ...(candidateBotIds[0] ? { botId: candidateBotIds[0] } : {}),
      candidateBotIds,
      routing: {
        purpose: actionRoutePurpose,
        primaryBotId: route.primaryBotId,
        reason: route.reason,
        routingVersion: route.routingVersion ?? null,
        ...(requiredBotId ? { requiredBotId } : {}),
        ...(request.sendRouteHalfOpenProbe
          ? { sendRouteHalfOpenProbe: request.sendRouteHalfOpenProbe }
          : {}),
        ...(request.sendRouteStickyProbe
          ? { sendRouteStickyProbe: request.sendRouteStickyProbe }
          : {}),
      },
    };
    const executionOptions: MaxActionDispatchExecutionOptions = {
      // FLAG: Direct publication has no BullMQ enqueue. Observe this invocation's
      // readiness before route/preparation waits; retained receipts keep their clocks.
      enqueuedAt: invocationReadyAt,
      ...(request.prepareAttempt
        ? {
            prepareAttempt: async ({ botId, job: attemptJob }) => {
              if (!botId) {
                throw new UnrecoverableError(
                  `MAX publication ${logicalIdempotencyKey} has no executable bot candidate`,
                );
              }
              return request.prepareAttempt!({ botId, job: attemptJob });
            },
          }
        : {}),
      ...(request.onDispatchAttempt
        ? {
            onDispatchAttempt: async ({ botId, job: attemptJob }) => {
              if (botId) {
                await request.onDispatchAttempt!({ botId, job: attemptJob });
              }
            },
          }
        : {}),
      ...(request.beforeSendMutation
        ? {
            beforeSendMutation: async ({ botId, job: attemptJob }) => {
              if (!botId) {
                throw new UnrecoverableError(
                  `MAX publication ${logicalIdempotencyKey} has no dispatch bot`,
                );
              }
              await request.beforeSendMutation!({ botId, job: attemptJob });
            },
          }
        : {}),
    };
    const result = await this.maxActionDispatchService.execute(job, executionOptions);
    if (!result || !result.botId) {
      throw new UnrecoverableError(
        `MAX publication ${logicalIdempotencyKey} completed without a routed send result`,
      );
    }

    const dispatchedBotId = result.botId;
    const url =
      result.url ??
      (await this.resolveRecoveredMessageUrl(request, {
        messageId: result.messageId,
        botId: dispatchedBotId,
      }));
    return {
      messageId: result.messageId,
      url,
      ...(result.chatId ? { chatId: result.chatId } : {}),
      botId: dispatchedBotId,
      candidateBotIds,
      routingVersion: route.routingVersion ?? null,
    };
  }

  private async resolveRecoveredMessageUrl(
    request: MaxRoutedPublicationRequest,
    result: { messageId: string; botId: string },
  ): Promise<string | null> {
    // FLAG: A confirmed send receipt can be persisted without a follow-up message lookup.
    if (request.hydrateMessageUrl === false) {
      return null;
    }
    try {
      return await this.maxClientService.resolveMessageLink(result.messageId, {
        botId: result.botId,
        trafficClass: request.trafficClass,
        sourceTag: request.sourceTag,
        ...(request.ignoreFailureMetricStatuses?.length
          ? { ignoreFailureMetricStatuses: [...request.ignoreFailureMetricStatuses] }
          : {}),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          entityId: request.entityId,
          messageId: result.messageId,
          botId: result.botId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to hydrate recovered routed MAX publication URL',
      );
      return null;
    }
  }

  private async resolveFreshRoute(
    chatId: string,
    purpose: MaxRoutedPublicationRoutePurpose,
    request: MaxRoutedPublicationRequest,
  ): Promise<MaxBotRoute> {
    if (purpose === 'channel_poll') {
      const route = await this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
      if (this.normalizeBotIds(route.candidateBotIds).length > 0) {
        return route;
      }
      return this.hydrateManagedPollRoute(chatId, route, request);
    }
    const stickyRouteProbe = this.readFutureNightStickyProbe(
      request,
      request.logicalIdempotencyKey.trim(),
    );
    return this.maxBotLinkService.resolveBotRoute({
      purpose: 'send_message',
      chatId,
      fallbackToPrimary: true,
      allowHalfOpenProbe: request.sendRouteHalfOpenProbe === 'publication_exact_verification',
      ...(stickyRouteProbe
        ? { stickyHalfOpenProbeFailureBefore: stickyRouteProbe.failureBefore }
        : {}),
    });
  }

  private readFutureNightStickyProbe(
    request: MaxRoutedPublicationRequest,
    logicalIdempotencyKey: string,
  ): MaxFutureNightStickyRouteProbe | null {
    if (request.sendRouteHalfOpenProbe !== 'publication_exact_verification') {
      return null;
    }
    return parseMaxFutureNightStickyRouteProbe(request.sendRouteStickyProbe, {
      chatId: request.entityId,
      idempotencyKey: logicalIdempotencyKey,
      sourceTag: request.sourceTag,
      occurredAt: new Date(),
    });
  }

  private prioritizePreferredBot(candidateBotIds: string[], preferredBotId: unknown): string[] {
    const preferred = typeof preferredBotId === 'string' ? preferredBotId.trim() : '';
    if (!preferred || !candidateBotIds.includes(preferred)) {
      return candidateBotIds;
    }
    return [preferred, ...candidateBotIds.filter((botId) => botId !== preferred)];
  }

  private resolvePublisherExactBotId(value: unknown): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return '';
    }
    const configuredPublisherBotId = process.env.MAX_PUBLISHER_BOT_ID?.trim();
    if (
      !roleRunsPublisher(getAppRole()) ||
      process.env.APP_SERVICE_NAME !== 'api-publisher' ||
      !isPublisherBotId(normalized, configuredPublisherBotId)
    ) {
      throw new Error('Publisher exact route is only available to api-publisher');
    }
    return normalized;
  }

  private resolveRequestedCandidateBotIds(
    candidateBotIds: string[],
    request: Pick<MaxRoutedPublicationRequest, 'preferredBotId' | 'requiredBotId'>,
  ): string[] {
    const requiredBotId =
      typeof request.requiredBotId === 'string' ? request.requiredBotId.trim() : '';
    if (requiredBotId) {
      return candidateBotIds.includes(requiredBotId) ? [requiredBotId] : [];
    }
    return this.prioritizePreferredBot(candidateBotIds, request.preferredBotId);
  }

  private async hydrateManagedPollRoute(
    chatId: string,
    emptyRoute: MaxBotRoute,
    request: MaxRoutedPublicationRequest,
  ): Promise<MaxBotRoute> {
    const probeRoute = await this.maxBotLinkService.resolveBotRoute({
      purpose: 'send_message',
      chatId,
      fallbackToPrimary: true,
    });
    const probeCandidateBotIds = this.normalizeBotIds(probeRoute.candidateBotIds);
    if (probeCandidateBotIds.length === 0) {
      return this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
    }

    let refreshedRoute = emptyRoute;
    let routeReadAfterLastCandidate = false;
    for (const botId of probeCandidateBotIds) {
      routeReadAfterLastCandidate = false;
      const stale = await this.maxBotLinkService.isBotAccessSnapshotStale({
        chatId,
        botId,
        maxAgeMs: MANAGED_POLL_ROUTE_ACCESS_MAX_AGE_MS,
      });
      if (!stale) {
        continue;
      }

      const accessProbeStartedAt = new Date();
      let accessProbeCompleted = false;
      try {
        const access = await this.maxClientService.getCurrentChatMemberAccess(chatId, {
          botId,
          bypassCache: true,
          trafficClass: request.trafficClass,
          ...(request.actionHealthLane ? { actionHealthLane: request.actionHealthLane } : {}),
          sourceTag: request.sourceTag,
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        });
        accessProbeCompleted = true;
        const persisted = await this.maxBotLinkService.recordBotAccessProbe({
          chatId,
          botId,
          access,
          source: 'managed_poll_route_hydration',
          checkedAt: accessProbeStartedAt,
        });
        if (!persisted) {
          refreshedRoute = await this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
          routeReadAfterLastCandidate = true;
          if (this.normalizeBotIds(refreshedRoute.candidateBotIds).length > 0) {
            return refreshedRoute;
          }
          continue;
        }
      } catch (error: unknown) {
        // FLAG: Only the own-member lookup can prove denial; later writes cannot.
        const lastErrorCode = accessProbeCompleted
          ? null
          : resolveExplicitMembershipAccessDenial(error);
        if (lastErrorCode) {
          try {
            await this.maxBotLinkService.recordBotAccessProbe({
              chatId,
              botId,
              access: null,
              source: 'managed_poll_route_hydration',
              checkedAt: accessProbeStartedAt,
              lastErrorCode,
            });
          } catch (persistenceError: unknown) {
            this.logger.warn(
              {
                chatId,
                botId,
                error:
                  persistenceError instanceof Error
                    ? persistenceError.message
                    : String(persistenceError),
              },
              'Failed to persist a terminal managed poll route access probe',
            );
          }
          try {
            await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost({
              chatId,
              botId,
              operation: 'lookup',
              source: 'managed_poll_route_hydration',
              error,
              lifecycleEventAt: accessProbeStartedAt,
              lifecycleEventType: 'live_probe',
              lifecycleSource: 'live_probe',
            });
          } catch (persistenceError: unknown) {
            this.logger.warn(
              {
                chatId,
                botId,
                error:
                  persistenceError instanceof Error
                    ? persistenceError.message
                    : String(persistenceError),
              },
              'Failed to record terminal managed poll access loss',
            );
          }
          refreshedRoute = await this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
          routeReadAfterLastCandidate = true;
          if (this.normalizeBotIds(refreshedRoute.candidateBotIds).length > 0) {
            return refreshedRoute;
          }
        }
        this.logger.warn(
          {
            chatId,
            botId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to hydrate a managed poll route candidate',
        );
        continue;
      }

      refreshedRoute = await this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
      routeReadAfterLastCandidate = true;
      if (this.normalizeBotIds(refreshedRoute.candidateBotIds).length > 0) {
        return refreshedRoute;
      }
    }
    return routeReadAfterLastCandidate
      ? refreshedRoute
      : this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId });
  }

  private normalizeBotIds(values: readonly unknown[]): string[] {
    return Array.from(
      new Set(
        values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean),
      ),
    );
  }
}
