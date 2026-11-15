import { channelCustomButtonsEligible } from '../common/channel-custom-post-buttons';
import type { InternalChannelDialogButtonIdentity } from '../common/channel-dialog-button-identity.util';
import type { PrismaService } from '../prisma/prisma.service';
import { isMaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import { isChannelAutoPostScopedWait } from './channel-auto-post-error-scope';
import type { ManagedChannelContext } from './moderation.service.support';
import type {
  LegacyChannelEditRecoveryAuditCursor,
  LegacyChannelEditRecoveryCandidate,
  LegacyChannelEditRecoveryCandidatePage,
  LegacyChannelEditRecoveryMarkerCursor,
  ReplacementAttachMarkerStore,
} from './replacement-attach-marker.store';
import type { ChannelAutoPostAttachOutcome } from './channel-auto-post-runtime';

const LEGACY_RECOVERY_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const LEGACY_RECOVERY_MINIMUM_AGE_MS = 5 * 60_000;
const LEGACY_RECOVERY_SWEEP_INTERVAL_MS = 5 * 60_000;
const LEGACY_RECOVERY_SCAN_LIMIT = 100;
const LEGACY_RECOVERY_MUTATION_LIMIT = 3;
const LEGACY_RECOVERY_LOOKUP_LIMIT = 8;

type ExactChannelDialogLookupOptions = {
  trafficClass: 'background';
  actionHealthLane: 'background';
  sourceTag: 'channel_auto_post';
  botId?: string;
};

export type ExactChannelDialogButtonLookupPort = (
  chatId: string,
  messageId: string,
  options: ExactChannelDialogLookupOptions,
) => Promise<InternalChannelDialogButtonIdentity[] | null>;

export type ChannelAutoPostLegacyRecoveryAttachInput = {
  chatId: string;
  messageId: string;
  text: null;
  textFormat: null;
  linkType: null;
  existingDialogButtonKinds: readonly InternalChannelDialogButtonIdentity['kind'][];
  existingDialogThreadId: string | null;
  managedChannel: ManagedChannelContext;
  source: 'poll';
  sourceMessageAt?: string | null;
  senderId: null;
  senderAdminVerified: false;
  allowSenderlessEngagement: boolean;
  requiredAuthorUserId: null;
};

type LegacyRecoveryMarkerStore = Pick<
  ReplacementAttachMarkerStore,
  'listLegacyChannelEditRecoveryCandidates' | 'claimChannelAutoPost' | 'completeChannelAutoPost'
>;

type LegacyRecoveryLogger = {
  warn: (context: Record<string, unknown>, message: string) => void;
};

export type ChannelAutoPostLegacyRecoveryRunResult = {
  status: 'not_due' | 'completed' | 'deferred';
  deferReason:
    | 'same_channel_limit'
    | 'lookup_limit'
    | 'lookup_error'
    | 'mutation_limit'
    | 'attach_error'
    | 'marker_in_progress'
    | 'marker_error'
    | 'work_error'
    | null;
  stopCurrentTick: boolean;
  scannedCandidates: number;
  remoteLookups: number;
  mutationAttempts: number;
  terminalizedCandidates: number;
};

type FinishWithoutMutationOutcome = 'completed' | 'done' | 'deferred';

export class ChannelAutoPostLegacyRecovery {
  private nextSweepAtMs = 0;
  private markerCursor: LegacyChannelEditRecoveryMarkerCursor | null = null;
  private auditCursor: LegacyChannelEditRecoveryAuditCursor | null = null;
  private inFlight = false;
  private resumeAfterCandidateKey: string | null = null;

  constructor(
    private readonly dependencies: {
      prisma: Pick<PrismaService, 'channelSettings'>;
      markerStore: LegacyRecoveryMarkerStore;
      isMessageHeld: (chatId: string, messageId: string) => Promise<boolean>;
      lookupExactButtonIdentities: ExactChannelDialogButtonLookupPort;
      lookupExactSourceAt?: (
        chatId: string,
        messageId: string,
        options: ExactChannelDialogLookupOptions,
      ) => Promise<string | null>;
      resolveUnifiedLookupBotId?: (params: {
        chatId: string;
        capability: 'background_scans';
        fallbackToPrimary: true;
      }) => Promise<string | null>;
      attach: (
        input: ChannelAutoPostLegacyRecoveryAttachInput,
      ) => Promise<ChannelAutoPostAttachOutcome>;
      logger?: LegacyRecoveryLogger;
      now?: () => number;
    },
  ) {}

  async runIfDue(): Promise<ChannelAutoPostLegacyRecoveryRunResult> {
    const nowMs = this.dependencies.now?.() ?? Date.now();
    if (this.inFlight || nowMs < this.nextSweepAtMs) {
      return this.result('not_due');
    }

    this.inFlight = true;
    this.nextSweepAtMs = nowMs + LEGACY_RECOVERY_SWEEP_INTERVAL_MS;
    try {
      let page: LegacyChannelEditRecoveryCandidatePage;
      try {
        page = await this.dependencies.markerStore.listLegacyChannelEditRecoveryCandidates({
          now: new Date(nowMs),
          limit: LEGACY_RECOVERY_SCAN_LIMIT,
          lookbackMs: LEGACY_RECOVERY_LOOKBACK_MS,
          minimumAgeMs: LEGACY_RECOVERY_MINIMUM_AGE_MS,
          markerCursor: this.markerCursor,
          auditCursor: this.auditCursor,
        });
      } catch (error: unknown) {
        this.warn(error, null, 'Failed to list legacy channel button recovery candidates');
        return this.result('deferred', 0, 'work_error');
      }

      let contexts: Map<string, ManagedChannelContext>;
      try {
        contexts = await this.loadContexts(page.candidates);
      } catch (error: unknown) {
        this.warn(error, null, 'Failed to load legacy channel button recovery contexts');
        return this.result('deferred', page.candidates.length, 'work_error');
      }

      const seenChatIds = new Set<string>();
      let remoteLookups = 0;
      let mutationAttempts = 0;
      let terminalizedCandidates = 0;
      let cursorCanAdvance = true;
      let stopCurrentTick = false;
      let deferReason: ChannelAutoPostLegacyRecoveryRunResult['deferReason'] = null;

      for (const candidate of this.orderCandidates(page.candidates)) {
        // FLAG: A held source preserves its uncertain marker; never claim, finish or replay it.
        if (await this.dependencies.isMessageHeld(candidate.chatId, candidate.messageId)) continue;
        if (seenChatIds.has(candidate.chatId)) {
          cursorCanAdvance = false;
          deferReason ??= 'same_channel_limit';
          continue;
        }
        seenChatIds.add(candidate.chatId);

        const context = contexts.get(candidate.chatId) ?? null;
        if (!context) {
          const finished = await this.finishWithoutMutation(
            candidate,
            'SKIPPED',
            'Managed channel context is unavailable for legacy button recovery.',
            null,
          );
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        if (
          candidate.evidence === 'retryable_edit_marker' ||
          (candidate.evidence === 'predispatch_marker' &&
            (context.channelSettings.postSignatureEnabled ||
              context.channelSettings.customPostButtonsEnabled))
        ) {
          if (mutationAttempts >= LEGACY_RECOVERY_MUTATION_LIMIT) {
            cursorCanAdvance = false;
            deferReason ??= 'mutation_limit';
            continue;
          }
          try {
            let sourceMessageAt: string | null = null;
            if (context.channelSettings.customPostButtonsEnabled) {
              if (remoteLookups >= LEGACY_RECOVERY_LOOKUP_LIMIT) {
                cursorCanAdvance = false;
                deferReason ??= 'lookup_limit';
                continue;
              }
              const botId = await this.dependencies.resolveUnifiedLookupBotId?.({
                chatId: candidate.chatId,
                capability: 'background_scans',
                fallbackToPrimary: true,
              });
              remoteLookups += 1;
              // FLAG: Marker creation time never substitutes for the original post time.
              sourceMessageAt =
                (await this.dependencies.lookupExactSourceAt?.(
                  candidate.chatId,
                  candidate.messageId,
                  {
                    trafficClass: 'background',
                    actionHealthLane: 'background',
                    sourceTag: 'channel_auto_post',
                    ...(botId ? { botId } : {}),
                  },
                )) ?? null;
              if (
                !channelCustomButtonsEligible(context.channelSettings, sourceMessageAt) &&
                !context.channelSettings.commentsEnabled &&
                !context.channelSettings.postSuggestionsEnabled &&
                !context.channelSettings.postSignatureEnabled
              ) {
                const finished = await this.finishWithoutMutation(
                  candidate,
                  'SKIPPED',
                  'Original post time does not authorize current custom buttons.',
                  null,
                );
                if (finished === 'deferred') {
                  cursorCanAdvance = false;
                  deferReason ??= 'marker_in_progress';
                }
                terminalizedCandidates += finished === 'completed' ? 1 : 0;
                continue;
              }
            }
            mutationAttempts += 1;
            // FLAG: The durable edit intent authorizes a fresh locked GET/PUT, never a send.
            // Keep the current signature enabled even when no discussion buttons are configured.
            const outcome = await this.dependencies.attach({
              chatId: candidate.chatId,
              messageId: candidate.messageId,
              text: null,
              textFormat: null,
              linkType: null,
              existingDialogButtonKinds: [],
              existingDialogThreadId: null,
              managedChannel: context,
              source: 'poll',
              sourceMessageAt,
              senderId: null,
              senderAdminVerified: false,
              allowSenderlessEngagement: true,
              requiredAuthorUserId: null,
            });
            if (outcome !== 'attached') {
              cursorCanAdvance = false;
              deferReason ??= 'marker_in_progress';
            }
          } catch (error: unknown) {
            this.warn(error, candidate, 'Deferred channel post edit recovery');
            cursorCanAdvance = false;
            deferReason = 'attach_error';
            if (this.isolateCandidateFailure(error, candidate)) continue;
            stopCurrentTick = true;
            break;
          }
          continue;
        }

        const commentsEnabled = context.channelSettings.commentsEnabled === true;
        const suggestionsEnabled = context.channelSettings.postSuggestionsEnabled === true;
        if (!commentsEnabled && !suggestionsEnabled) {
          const finished = await this.finishWithoutMutation(
            candidate,
            'SKIPPED',
            'Channel comments and post suggestions are disabled.',
            null,
          );
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        if (remoteLookups >= LEGACY_RECOVERY_LOOKUP_LIMIT) {
          cursorCanAdvance = false;
          deferReason ??= 'lookup_limit';
          continue;
        }

        let identities: InternalChannelDialogButtonIdentity[] | null;
        try {
          const lookupRoute = {
            chatId: candidate.chatId,
            capability: 'background_scans',
            fallbackToPrimary: true,
          } as const;
          const botId = await this.dependencies.resolveUnifiedLookupBotId?.(lookupRoute);
          remoteLookups += 1;
          identities = await this.dependencies.lookupExactButtonIdentities(
            candidate.chatId,
            candidate.messageId,
            {
              trafficClass: 'background',
              actionHealthLane: 'background',
              sourceTag: 'channel_auto_post',
              ...(botId ? { botId } : {}),
            },
          );
        } catch (error: unknown) {
          this.warn(error, candidate, 'Deferred legacy channel button recovery after lookup error');
          cursorCanAdvance = false;
          deferReason = 'lookup_error';
          if (this.isolateCandidateFailure(error, candidate)) continue;
          stopCurrentTick = true;
          break;
        }

        if (identities === null) {
          const finished = await this.finishWithoutMutation(
            candidate,
            'SKIPPED',
            '[absent_or_inaccessible] The legacy channel post is absent or inaccessible to the selected MAX bot.',
            404,
          );
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        const existing = this.summarizeIdentities(candidate.chatId, identities);
        const commentsMissing = commentsEnabled && !existing.kinds.includes('comments');
        const suggestionsMissing = suggestionsEnabled && !existing.kinds.includes('suggest');
        if (!commentsMissing && !suggestionsMissing) {
          const finished = await this.finishWithoutMutation(candidate, 'SUCCEEDED', null, null);
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        if (candidate.evidence === 'predispatch_marker') {
          const finished = await this.finishWithoutMutation(
            candidate,
            'SKIPPED',
            'Predispatch channel edit was not replayed because the historical post author cannot be verified.',
            null,
          );
          if (finished === 'deferred') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
          terminalizedCandidates += finished === 'completed' ? 1 : 0;
          continue;
        }

        if (mutationAttempts >= LEGACY_RECOVERY_MUTATION_LIMIT) {
          cursorCanAdvance = false;
          deferReason ??= 'mutation_limit';
          continue;
        }

        mutationAttempts += 1;
        try {
          const outcome = await this.dependencies.attach({
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            text: null,
            textFormat: null,
            linkType: null,
            existingDialogButtonKinds: existing.kinds,
            existingDialogThreadId: existing.threadId,
            managedChannel: {
              channelSettings: {
                ...context.channelSettings,
                postSignatureEnabled: false,
              },
              adminUserIds: context.adminUserIds,
            },
            source: 'poll',
            senderId: null,
            senderAdminVerified: false,
            allowSenderlessEngagement: false,
            requiredAuthorUserId: null,
          });
          if (outcome === 'skipped') {
            const finished = await this.finishWithoutMutation(
              candidate,
              'SKIPPED',
              'MAX post edit skipped because the legacy candidate has no verifiable bot author.',
              null,
            );
            if (finished === 'deferred') {
              cursorCanAdvance = false;
              deferReason = 'marker_in_progress';
              break;
            }
            terminalizedCandidates += finished === 'completed' ? 1 : 0;
            continue;
          }
          if (outcome === 'in_progress' || outcome === 'noop') {
            cursorCanAdvance = false;
            deferReason = 'marker_in_progress';
            break;
          }
        } catch (error: unknown) {
          this.warn(error, candidate, 'Deferred legacy channel button recovery after attach error');
          cursorCanAdvance = false;
          deferReason = 'attach_error';
          if (this.isolateCandidateFailure(error, candidate)) continue;
          stopCurrentTick = true;
          break;
        }
      }

      if (cursorCanAdvance) {
        this.markerCursor = page.markerScanExhausted ? null : page.nextMarkerCursor;
        this.auditCursor = page.nextAuditCursor;
        this.resumeAfterCandidateKey = null;
      }
      return {
        status: cursorCanAdvance ? 'completed' : 'deferred',
        deferReason,
        stopCurrentTick,
        scannedCandidates: page.candidates.length,
        remoteLookups,
        mutationAttempts,
        terminalizedCandidates,
      };
    } finally {
      this.inFlight = false;
    }
  }

  private isolateCandidateFailure(
    error: unknown,
    candidate: LegacyChannelEditRecoveryCandidate,
  ): boolean {
    if (!isChannelAutoPostScopedWait(error) && !isMaxExactMessageLookupMissingIdError(error))
      return false;
    this.resumeAfterCandidateKey = `${candidate.chatId}\u0000${candidate.messageId}`;
    return true;
  }

  private orderCandidates(
    candidates: LegacyChannelEditRecoveryCandidate[],
  ): LegacyChannelEditRecoveryCandidate[] {
    // FLAG: Rotate only the freshly reloaded bounded page. The SQL cursors stay before
    // unresolved work; this scheduling hint never settles or drops a failed marker.
    const lastIndex = candidates.findIndex(
      (candidate) =>
        `${candidate.chatId}\u0000${candidate.messageId}` === this.resumeAfterCandidateKey,
    );
    if (lastIndex < 0) return candidates;
    return [...candidates.slice(lastIndex + 1), ...candidates.slice(0, lastIndex + 1)];
  }

  private async loadContexts(
    candidates: readonly LegacyChannelEditRecoveryCandidate[],
  ): Promise<Map<string, ManagedChannelContext>> {
    const chatIds = [...new Set(candidates.map((candidate) => candidate.chatId))];
    if (chatIds.length === 0) {
      return new Map();
    }
    const rows = await this.dependencies.prisma.channelSettings.findMany({
      where: {
        chatId: { in: chatIds },
        chat: { entityType: 'CHANNEL' },
      },
      include: {
        chat: {
          select: {
            admins: { select: { userId: true } },
          },
        },
      },
    });
    return new Map(
      rows.map((row) => [
        row.chatId,
        {
          channelSettings: row,
          adminUserIds: row.chat.admins.map((admin) => admin.userId),
        },
      ]),
    );
  }

  private summarizeIdentities(
    chatId: string,
    identities: readonly InternalChannelDialogButtonIdentity[],
  ): {
    kinds: InternalChannelDialogButtonIdentity['kind'][];
    threadId: string | null;
  } {
    const matching = identities.filter((identity) => identity.chatId === chatId);
    return {
      kinds: [...new Set(matching.map((identity) => identity.kind))],
      threadId:
        matching.find((identity) => identity.kind === 'comments' && identity.threadId)?.threadId ??
        matching.find((identity) => identity.threadId)?.threadId ??
        null,
    };
  }

  private async finishWithoutMutation(
    candidate: LegacyChannelEditRecoveryCandidate,
    status: 'SUCCEEDED' | 'SKIPPED',
    lastError: string | null,
    lastStatusCode: number | null,
  ): Promise<FinishWithoutMutationOutcome> {
    try {
      if (await this.dependencies.isMessageHeld(candidate.chatId, candidate.messageId))
        return 'done';
      const claim = await this.dependencies.markerStore.claimChannelAutoPost({
        chatId: candidate.chatId,
        messageId: candidate.messageId,
        source: 'poll',
        botId: null,
        linkType: null,
        hasEngagementButtons: true,
        replaySafeEdit: candidate.evidence === 'retryable_edit_marker',
      });
      if (claim.status !== 'claimed') {
        return claim.status === 'done' ? 'done' : 'deferred';
      }
      await this.dependencies.markerStore.completeChannelAutoPost({
        chatId: candidate.chatId,
        messageId: candidate.messageId,
        lockToken: claim.lockToken,
        status,
        source: 'poll',
        botId: null,
        linkType: null,
        deliveryMode: 'edit_message',
        ...(status === 'SKIPPED' ? { terminalEditAttemptExhausted: true } : {}),
        lastError,
        lastStatusCode,
      });
      return 'completed';
    } catch (error: unknown) {
      this.warn(error, candidate, 'Deferred legacy channel button recovery after marker error');
      return 'deferred';
    }
  }

  private result(
    status: ChannelAutoPostLegacyRecoveryRunResult['status'],
    scannedCandidates = 0,
    deferReason: ChannelAutoPostLegacyRecoveryRunResult['deferReason'] = null,
  ): ChannelAutoPostLegacyRecoveryRunResult {
    return {
      status,
      deferReason,
      stopCurrentTick: false,
      scannedCandidates,
      remoteLookups: 0,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    };
  }

  private warn(
    error: unknown,
    candidate: LegacyChannelEditRecoveryCandidate | null,
    message: string,
  ): void {
    this.dependencies.logger?.warn(
      {
        ...(candidate
          ? {
              chatId: candidate.chatId,
              messageId: candidate.messageId,
              evidence: candidate.evidence,
            }
          : {}),
        error: error instanceof Error ? error.message : String(error),
      },
      message,
    );
  }
}
