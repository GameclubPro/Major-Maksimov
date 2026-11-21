import { matchesNightModeTransitionFenceAlias } from './night-mode-transition-fence-alias.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChatEntityType, Prisma, type ChatSettings } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildNightModeTransitionJobId,
  NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX,
  NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
  NIGHT_MODE_TRANSITION_PROCESS_STOP,
  NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
  NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
  NightModeRecoveryUnsafeError,
  parseNightModeStickyRouteProbe,
  parseNightModeTransitionRecoveryOnly,
  parseNightModeTransitionRecoveryObligation,
  type NightModeStickyRouteProbe,
  type NightModeTransitionJob,
  type NightModeTransitionProcessResult,
  type NightModeTransitionRecoveryOnly,
  type NightModeTransitionRecoveryObligation,
  type NightModeTransitionCloseCleanupRecovery,
} from './night-mode-transition.queue';
import {
  parseNightModeTransitionSessionKey,
  resolveEffectiveChatClosure,
  resolveNightModeNoticeCatchUpWindow,
  resolveNightModeTransitionSnapshot as resolveNightModeTransitionSnapshotValue,
  resolveNightModeTransitionSessionOpenAt,
  type NightModeTransitionSnapshot,
} from './night-mode-transition-time.util';
import {
  buildNightModeTransitionStateKey,
  NIGHT_MODE_TRANSITION_LOCK_TTL_MS,
  NIGHT_MODE_TRANSITION_STATE_TTL_SEC,
  parseNightModeTransitionState,
  type NightModeTransitionState,
} from './moderation.service.support';
import {
  isNightModeTransitionNoticeEventPersistenceError,
  type NightModeTransitionNoticeEventPersistenceError,
  type NightModeTransitionNoticeRuleCode,
} from './night-mode-transition-notice-persistence-error';
import { RedisCounterService } from './redis-counter.service';
import {
  buildNightModeTransitionScheduleFingerprint,
  buildNightModeTransitionSideEffectFingerprint,
} from './night-mode-transition-generation.util';
import type { NightModeCloseNoticeCleanupBinding } from './night-mode-close-notice-cleanup-binding';

const NIGHT_MODE_TRANSITION_LOCK_HEARTBEAT_MS = Math.max(
  1_000,
  Math.floor(NIGHT_MODE_TRANSITION_LOCK_TTL_MS / 3),
);

type NightModeTransitionExecutionFence = {
  transition: 'close' | 'open';
  chatId: string;
  jobId: string;
  sessionKey: string;
  fingerprint: string | null;
};

export type NightModeTransitionNoticeResult = NightModeTransitionProcessResult & {
  messageId: string | null;
  botId: string | null;
};

type NightModeTransitionExecutionSnapshot = NightModeTransitionSnapshot & {
  stickyRouteProbe?: NightModeStickyRouteProbe;
};

export type NightModeRecoverCloseNoticeEventParams = {
  chatId: string;
  sessionKey: string;
  messageId: string;
  botId: string;
  timezone: string;
  startMinutes: number;
  endMinutes: number;
};

export type NightModeRecoverCloseNoticeEventFromLedgerParams = Omit<
  NightModeRecoverCloseNoticeEventParams,
  'messageId' | 'botId'
>;

export type NightModeRecoveredCloseNoticeEvent = {
  eventId: string;
  sessionKey: string;
  messageId: string;
  botId: string;
};

export type NightModeTransitionRuntimeSettings = Pick<
  ChatSettings,
  | 'chatId'
  | 'nightModeEnabled'
  | 'nightModeStartTimeMinutes'
  | 'nightModeEndTimeMinutes'
  | 'nightModeTimezone'
  | 'nightModeBotMessageEnabled'
  | 'nightModeBotMessageText'
  | 'nightModeCommentsEnabled'
  | 'nightModeOpenMessageEnabled'
  | 'nightModeOpenMessageText'
  | 'nightModeForceCloseEnabled'
  | 'nightModeForceCloseForever'
  | 'nightModeForceCloseUntil'
  | 'nightModeBotButtons'
  | 'nightModeBotButtonEnabled'
  | 'nightModeBotButtonUrl'
  | 'nightModeBotButtonText'
  | 'nightModeRulesButtonEnabled'
  | 'commentsEnabled'
  | 'botSpeechStyle'
  | 'botSpeechMedia'
> & {
  updatedAt?: Date;
  chat?: {
    entityType?: ChatEntityType | null;
    rules?: {
      publishedUrl: string | null;
      publishedMessageId: string | null;
    } | null;
  } | null;
};

export type NightModeTransitionRuntimeHooks = {
  scheduleRecoveryObligation(
    chatId: string,
    recovery: NightModeTransitionRecoveryObligation,
  ): Promise<void>;
  recoverOpenedNoticeEvent(
    params: NightModeRecoverCloseNoticeEventParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent>;
  recoverOpenedNoticeEventFromLedger(
    params: NightModeRecoverCloseNoticeEventFromLedgerParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent | null>;
  recoverClosedNoticeEvent(
    params: NightModeRecoverCloseNoticeEventParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent>;
  recoverClosedNoticeEventFromLedger(
    params: NightModeRecoverCloseNoticeEventFromLedgerParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent | null>;
  sendClosedNotice(
    settings: NightModeTransitionRuntimeSettings,
    snapshot: {
      startMinutes: number;
      endMinutes: number;
      timezone: string;
      sessionKey: string;
      stickyRouteProbe?: NightModeStickyRouteProbe;
    },
    validateBeforeDispatch?: () => Promise<boolean>,
  ): Promise<NightModeTransitionNoticeResult>;
  sendOpenedNotice(
    settings: Pick<
      NightModeTransitionRuntimeSettings,
      'chatId' | 'nightModeOpenMessageText' | 'botSpeechStyle' | 'botSpeechMedia'
    >,
    snapshot: {
      startMinutes: number;
      endMinutes: number;
      timezone: string;
      sessionKey: string;
    },
    validateBeforeDispatch?: () => Promise<boolean>,
  ): Promise<NightModeTransitionProcessResult>;
  deleteClosedNotice(
    chatId: string,
    messageId: string,
    originBotId: string | null,
    binding: NightModeCloseNoticeCleanupBinding,
    validateBeforeDispatch?: () => Promise<boolean>,
  ): Promise<NightModeTransitionProcessResult>;
};

type NightModeTransitionLock = {
  key: string;
  token: string;
  redis: boolean;
  healthy: boolean;
  heartbeat: NodeJS.Timeout | null;
  renewalChain: Promise<void>;
};

class NightModeTransitionLockLostError extends Error {
  constructor(chatId: string) {
    super(`Night mode transition lock ownership was lost (${chatId})`);
    this.name = 'NightModeTransitionLockLostError';
  }
}

@Injectable()
export class NightModeTransitionRuntimeService {
  private readonly logger = new Logger(NightModeTransitionRuntimeService.name);
  private readonly runtimeStartedAtMs = Date.now();
  private readonly nightModeTransitionMemoryState = new Map<string, NightModeTransitionState>();
  private readonly nightModeTransitionMemoryLocks = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redisCounter?: RedisCounterService,
  ) {}

  async processNightModeTransitionJob(
    job: NightModeTransitionJob,
    hooks: NightModeTransitionRuntimeHooks,
  ): Promise<NightModeTransitionProcessResult> {
    if (job.recoveryOnly !== undefined) {
      const recovery = parseNightModeTransitionRecoveryObligation(job.recoveryOnly);
      if (!recovery || recovery.sessionKey !== job.sessionKey) {
        throw new Error(`Night mode recovery envelope is invalid (${job.chatId})`);
      }
      if (recovery.kind === NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY) {
        const event = await hooks.recoverOpenedNoticeEvent({ chatId: job.chatId, ...recovery });
        if (
          !event.eventId.trim() ||
          event.sessionKey !== recovery.sessionKey ||
          event.messageId !== recovery.messageId ||
          event.botId !== recovery.botId
        ) {
          throw new Error(
            `Night mode open-event recovery returned mismatched proof (${job.chatId})`,
          );
        }
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }
      if (recovery.kind === NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY) {
        return this.processCloseCleanupRecoveryOnly(job.chatId, recovery, hooks);
      }
      return this.processCloseEventRecoveryOnly(job, hooks);
    }
    const scheduledForMs = Date.parse(job.scheduledFor);
    const carriedByCurrentRuntimeIntent =
      job.transitionRuntimeVersion !== 4 &&
      Number.isFinite(scheduledForMs) &&
      scheduledForMs < this.runtimeStartedAtMs
        ? await this.hasExactCurrentRuntimeIntent(job)
        : false;
    if (
      job.transitionRuntimeVersion !== 4 &&
      (!Number.isFinite(scheduledForMs) ||
        (scheduledForMs < this.runtimeStartedAtMs && !carriedByCurrentRuntimeIntent))
    ) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    const executionFence = this.buildExecutionFence(job);
    if (executionFence && (await this.isExactTransitionManuallyFenced(executionFence))) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    if (typeof this.prisma.chatSettings?.findUnique !== 'function') {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: job.chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            rules: {
              select: {
                publishedUrl: true,
                publishedMessageId: true,
              },
            },
          },
        },
      },
    });
    if (!settings?.nightModeEnabled) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    if (settings.chat?.entityType === ChatEntityType.CHANNEL) {
      return NIGHT_MODE_TRANSITION_PROCESS_STOP;
    }
    const scheduleFingerprint = buildNightModeTransitionScheduleFingerprint(settings);
    const jobScheduleFingerprint =
      job.scheduleFingerprint?.trim() ||
      (job.transitionRuntimeVersion !== 4
        ? this.resolveSessionScheduleFingerprint(job.sessionKey)
        : null);
    if (!jobScheduleFingerprint || jobScheduleFingerprint !== scheduleFingerprint) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    const scheduledFor = new Date(job.scheduledFor);
    if (Number.isNaN(scheduledFor.getTime())) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    const scheduledSnapshot = this.resolveNightModeTransitionSnapshot(settings, scheduledFor);
    const currentSnapshot = this.resolveNightModeTransitionSnapshot(settings);
    if (
      !scheduledSnapshot ||
      !currentSnapshot ||
      scheduledSnapshot.startMinutes === scheduledSnapshot.endMinutes ||
      currentSnapshot.startMinutes === currentSnapshot.endMinutes
    ) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    if (
      scheduledSnapshot.sessionKey !== job.sessionKey ||
      currentSnapshot.sessionKey !== job.sessionKey
    ) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    if (job.transition === 'close') {
      if (
        scheduledSnapshot.status !== 'closed' ||
        !scheduledSnapshot.isCloseBoundary ||
        currentSnapshot.status !== 'closed'
      ) {
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }

      return this.processNightModeTransitionForChat(
        settings,
        hooks,
        this.withStickyRouteProbeAuthorization(job, scheduledSnapshot),
        executionFence,
      );
    }

    if (
      scheduledSnapshot.status !== 'open' ||
      !scheduledSnapshot.isOpenBoundary ||
      currentSnapshot.status !== 'open'
    ) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    return this.processNightModeTransitionForChat(
      settings,
      hooks,
      scheduledSnapshot,
      executionFence,
    );
  }

  private async processCloseEventRecoveryOnly(
    job: NightModeTransitionJob,
    hooks: NightModeTransitionRuntimeHooks,
  ): Promise<NightModeTransitionProcessResult> {
    const recovery = parseNightModeTransitionRecoveryOnly(job.recoveryOnly);
    if (!recovery || recovery.sessionKey !== job.sessionKey) {
      throw new Error(`Night mode close-event recovery envelope is invalid (${job.chatId})`);
    }
    const event = await hooks.recoverClosedNoticeEvent({
      chatId: job.chatId,
      sessionKey: recovery.sessionKey,
      messageId: recovery.messageId,
      botId: recovery.botId,
      timezone: recovery.timezone,
      startMinutes: recovery.startMinutes,
      endMinutes: recovery.endMinutes,
    });
    if (
      !event.eventId.trim() ||
      event.sessionKey !== recovery.sessionKey ||
      event.messageId !== recovery.messageId ||
      event.botId !== recovery.botId
    ) {
      throw new Error(`Night mode close-event recovery returned mismatched proof (${job.chatId})`);
    }
    await this.clearRecoveredCloseEventMarker(job.chatId, recovery);
    return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
  }

  private async clearRecoveredCloseEventMarker(
    chatId: string,
    recovery: NightModeTransitionRecoveryOnly,
  ): Promise<void> {
    const lock = await this.acquireNightModeTransitionLock(chatId);
    if (!lock) {
      throw new Error(`Night mode close-event recovery lock is busy (${chatId})`);
    }
    try {
      const state = await this.readNightModeTransitionState(chatId);
      const marker = state?.closeNoticeEventRecovery;
      if (
        state?.status !== 'closed' ||
        state.sessionKey !== recovery.sessionKey ||
        state.closeNoticeMessageId?.trim() !== recovery.messageId ||
        state.closeNoticeBotId?.trim() !== recovery.botId ||
        marker?.version !== 2 ||
        marker.timezone !== recovery.timezone ||
        marker.startMinutes !== recovery.startMinutes ||
        marker.endMinutes !== recovery.endMinutes
      ) {
        return;
      }
      await this.writeNightModeTransitionState(
        chatId,
        {
          status: 'closed',
          sessionKey: recovery.sessionKey,
          closeNoticeMessageId: recovery.messageId,
          closeNoticeBotId: recovery.botId,
          updatedAt: new Date().toISOString(),
        },
        lock,
      );
    } finally {
      await this.releaseNightModeTransitionLock(lock);
    }
  }

  async processNightModeTransitionForChat(
    settings: NightModeTransitionRuntimeSettings,
    hooks: NightModeTransitionRuntimeHooks,
    providedSnapshot?: NightModeTransitionExecutionSnapshot,
    executionFence?: NightModeTransitionExecutionFence | null,
  ): Promise<NightModeTransitionProcessResult> {
    const snapshot = providedSnapshot ?? this.resolveNightModeTransitionSnapshot(settings);
    if (!snapshot) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }

    const lock = await this.acquireNightModeTransitionLock(settings.chatId);
    if (!lock) {
      throw new Error(`${NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX} (${settings.chatId})`);
    }

    try {
      if (snapshot.status === 'open') {
        return await this.processOpeningForChat(settings, snapshot, hooks, lock, executionFence);
      }
      let currentState = await this.readNightModeTransitionState(settings.chatId);
      // FLAG: Redis state from another session cannot authorize any recovery or external effect.
      // An opening has its own durable occurrence and is handled independently above.
      if (currentState && currentState.sessionKey !== snapshot.sessionKey) {
        currentState = null;
      }
      let recoveredCloseNoticeEvent: NightModeRecoveredCloseNoticeEvent | null = null;
      if (currentState?.closeNoticeEventRecovery?.pending === true) {
        const recovery = await this.recoverPendingCloseNoticeEvent(
          settings.chatId,
          currentState,
          snapshot,
          hooks,
          lock,
        );
        currentState = recovery.state;
        recoveredCloseNoticeEvent = recovery.event;
      }
      if (!recoveredCloseNoticeEvent && currentState?.status === 'closed') {
        const recovery = await this.recoverUntrackedCloseNoticeEvent(
          settings.chatId,
          currentState,
          snapshot,
          hooks,
          lock,
        );
        if (recovery) {
          currentState = recovery.state;
          recoveredCloseNoticeEvent = recovery.event;
        }
      }
      if (snapshot.status === 'closed') {
        const closedStateForSession =
          currentState?.status === 'closed' && currentState.sessionKey === snapshot.sessionKey
            ? currentState
            : null;
        if (
          closedStateForSession &&
          (!snapshot.isCloseBoundary ||
            !settings.nightModeBotMessageEnabled ||
            closedStateForSession.closeNoticeMessageId)
        ) {
          return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
        }

        let closeNoticeMessageId = closedStateForSession
          ? (closedStateForSession.closeNoticeMessageId ?? null)
          : null;
        let closeNoticeBotId = closedStateForSession
          ? (closedStateForSession.closeNoticeBotId ?? null)
          : null;
        if (
          snapshot.isCloseBoundary &&
          settings.nightModeBotMessageEnabled &&
          (!closeNoticeMessageId || !closeNoticeBotId)
        ) {
          const persistedCloseNotice = await this.findPersistedCloseNotice(
            settings.chatId,
            snapshot.sessionKey,
          );
          closeNoticeMessageId = closeNoticeMessageId ?? persistedCloseNotice?.messageId ?? null;
          if (
            persistedCloseNotice?.messageId === closeNoticeMessageId &&
            persistedCloseNotice.botId
          ) {
            closeNoticeBotId = persistedCloseNotice.botId;
          }
        }
        if (
          snapshot.isCloseBoundary &&
          settings.nightModeBotMessageEnabled &&
          !closeNoticeMessageId
        ) {
          const sideEffectSettings = await this.readCurrentSideEffectSettings(
            settings.chatId,
            snapshot,
          );
          if (!sideEffectSettings) {
            return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
          }
          if (!sideEffectSettings.nightModeBotMessageEnabled) {
            await this.writeNightModeTransitionState(
              settings.chatId,
              {
                status: 'closed',
                sessionKey: snapshot.sessionKey,
                closeNoticeMessageId: null,
                closeNoticeBotId: null,
                updatedAt: new Date().toISOString(),
              },
              lock,
            );
            return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
          }
          const noticeResult = await this.sendClosedNoticeAndCaptureAcceptedState(
            sideEffectSettings,
            snapshot,
            hooks,
            lock,
            executionFence,
          );
          if (!noticeResult.shouldEnqueueNext) {
            return noticeResult;
          }
          closeNoticeMessageId = noticeResult.messageId;
          closeNoticeBotId = noticeResult.botId;
        }

        await this.writeNightModeTransitionState(
          settings.chatId,
          {
            status: 'closed',
            sessionKey: snapshot.sessionKey,
            closeNoticeMessageId,
            closeNoticeBotId,
            updatedAt: new Date().toISOString(),
          },
          lock,
        );
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }

      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    } finally {
      await this.releaseNightModeTransitionLock(lock);
    }
  }

  private async processOpeningForChat(
    settings: NightModeTransitionRuntimeSettings,
    snapshot: NightModeTransitionSnapshot,
    hooks: NightModeTransitionRuntimeHooks,
    lock: NightModeTransitionLock,
    executionFence?: NightModeTransitionExecutionFence | null,
  ): Promise<NightModeTransitionProcessResult> {
    if (!snapshot.isOpenBoundary) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    const currentSettings = await this.readCurrentScheduledSettings(settings.chatId, snapshot);
    if (!currentSettings) {
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    }
    const openAt = resolveNightModeTransitionSessionOpenAt(snapshot.sessionKey);
    if (!openAt) {
      throw new Error(`Night mode opening session is invalid (${settings.chatId})`);
    }
    await this.assertNightModeTransitionLock(lock, settings.chatId);
    // FLAG: Persist the cleanup obligation before proceeding, without reading the closing receipt.
    // Close failures and cleanup retries must never become authority to withhold a valid opening.
    await hooks.scheduleRecoveryObligation(settings.chatId, {
      kind: NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
      version: 1,
      sessionKey: snapshot.sessionKey,
      timezone: snapshot.timezone,
      startMinutes: snapshot.startMinutes,
      endMinutes: snapshot.endMinutes,
      openScheduledFor: openAt.toISOString(),
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(currentSettings),
      sideEffectFingerprint: buildNightModeTransitionSideEffectFingerprint(currentSettings),
    });
    if (resolveEffectiveChatClosure(currentSettings).manual.active)
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    const state = await this.readNightModeTransitionState(settings.chatId);
    const alreadyOpen = state?.status === 'open' && state.sessionKey === snapshot.sessionKey;
    const eventExists = await this.hasPersistedOpenNotice(settings.chatId, snapshot.sessionKey);
    if (!eventExists && alreadyOpen) {
      // FLAG: A prior accepted send may have lost its event write. Repair only its exact ledger receipt;
      // a Redis marker alone never authorizes another publication.
      await hooks.recoverOpenedNoticeEventFromLedger({
        chatId: settings.chatId,
        sessionKey: snapshot.sessionKey,
        timezone: snapshot.timezone,
        startMinutes: snapshot.startMinutes,
        endMinutes: snapshot.endMinutes,
      });
    } else if (!eventExists && currentSettings.nightModeOpenMessageEnabled) {
      const result = await this.sendOpenedNoticeAndCaptureAcceptedState(
        currentSettings,
        snapshot,
        hooks,
        lock,
        executionFence,
      );
      if (!result.shouldEnqueueNext) {
        return result;
      }
    }
    await this.writeNightModeTransitionState(
      settings.chatId,
      {
        status: 'open',
        sessionKey: snapshot.sessionKey,
        closeNoticeMessageId: null,
        closeNoticeBotId: null,
        updatedAt: new Date().toISOString(),
      },
      lock,
    );
    return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
  }

  private async processCloseCleanupRecoveryOnly(
    chatId: string,
    recovery: NightModeTransitionCloseCleanupRecovery,
    hooks: NightModeTransitionRuntimeHooks,
  ): Promise<NightModeTransitionProcessResult> {
    const snapshot: NightModeTransitionSnapshot = {
      status: 'open',
      sessionKey: recovery.sessionKey,
      timezone: recovery.timezone,
      startMinutes: recovery.startMinutes,
      endMinutes: recovery.endMinutes,
      isOpenBoundary: true,
      isCloseBoundary: false,
    };
    const lock = await this.acquireNightModeTransitionLock(chatId);
    if (!lock) {
      throw new Error(`${NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX} (${chatId})`);
    }
    try {
      const settings = await this.readCurrentScheduledSettings(chatId, snapshot);
      const fence: NightModeTransitionExecutionFence = {
        transition: 'open',
        chatId,
        sessionKey: recovery.sessionKey,
        jobId: buildNightModeTransitionJobId(
          chatId,
          'open',
          recovery.openScheduledFor,
          recovery.sessionKey,
        ),
        fingerprint: recovery.scheduleFingerprint,
      };
      // FLAG: A durable cleanup job is not permission to delete an older session's notice.
      // Revalidate both committed settings and the original occurrence acknowledgement fence.
      if (
        !settings ||
        buildNightModeTransitionScheduleFingerprint(settings) !== recovery.scheduleFingerprint ||
        buildNightModeTransitionSideEffectFingerprint(settings) !==
          recovery.sideEffectFingerprint ||
        (await this.isExactTransitionManuallyFenced(fence))
      ) {
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }
      const receipt = await hooks.recoverClosedNoticeEventFromLedger({
        chatId,
        sessionKey: recovery.sessionKey,
        timezone: recovery.timezone,
        startMinutes: recovery.startMinutes,
        endMinutes: recovery.endMinutes,
      });
      if (
        receipt &&
        (receipt.sessionKey !== recovery.sessionKey ||
          !receipt.eventId.trim() ||
          !receipt.messageId.trim() ||
          !receipt.botId.trim())
      ) {
        throw new NightModeRecoveryUnsafeError(
          `Night mode cleanup receipt identity does not match (${chatId})`,
        );
      }
      const persisted = receipt
        ? null
        : await this.findPersistedCloseNotice(chatId, recovery.sessionKey);
      const eventId = receipt?.eventId ?? persisted?.id;
      const messageId = receipt?.messageId ?? persisted?.messageId;
      const botId = receipt?.botId ?? persisted?.botId;
      if (!receipt && !persisted) {
        this.logger.log(
          { chatId, sessionKey: recovery.sessionKey, outcome: 'no_proven_cleanup_target' },
          'Night mode cleanup has no proven target; closing delivery remains unverified',
        );
        return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
      }
      if (!eventId || !messageId || !botId) {
        throw new NightModeRecoveryUnsafeError(
          `Exact night mode closing receipt is not proven for cleanup (${chatId})`,
        );
      }
      if (resolveEffectiveChatClosure(settings).manual.active) {
        return { shouldEnqueueNext: false, waitForManualOpening: true };
      }
      await this.assertNightModeTransitionLock(lock, chatId);
      const result = await hooks.deleteClosedNotice(
        chatId,
        messageId,
        botId ?? null,
        {
          version: 1,
          sessionKey: recovery.sessionKey,
          scheduleFingerprint: recovery.scheduleFingerprint,
          sideEffectFingerprint: recovery.sideEffectFingerprint,
          event: { id: eventId, ruleCode: 'NIGHT_MODE_CLOSE_NOTICE', messageId },
        },
        async () => {
          await this.assertNightModeTransitionLock(lock, chatId);
          return this.isCurrentSideEffectGeneration(settings, snapshot, fence);
        },
      );
      if (!result.shouldEnqueueNext) {
        throw new Error(`Night mode close cleanup has no executable route (${chatId})`);
      }
      return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
    } finally {
      await this.releaseNightModeTransitionLock(lock);
    }
  }

  resolveNightModeTransitionSnapshot(
    settings: Pick<
      ChatSettings,
      | 'nightModeEnabled'
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
    >,
    now = new Date(),
  ): NightModeTransitionSnapshot | null {
    return resolveNightModeTransitionSnapshotValue(settings, now);
  }

  private async hasExactCurrentRuntimeIntent(job: NightModeTransitionJob): Promise<boolean> {
    if (typeof this.prisma.$queryRaw !== 'function') {
      return false;
    }
    const chatId = job.chatId.trim();
    const scheduledFor = new Date(job.scheduledFor);
    const scheduleFingerprint =
      job.scheduleFingerprint?.trim() || this.resolveSessionScheduleFingerprint(job.sessionKey);
    if (!chatId || Number.isNaN(scheduledFor.getTime()) || !scheduleFingerprint) {
      return false;
    }
    const jobId = buildNightModeTransitionJobId(
      chatId,
      job.transition,
      job.scheduledFor,
      job.sessionKey,
    );
    const rows = await this.prisma.$queryRaw<Array<{ job_id: string }>>(Prisma.sql`
      SELECT "job_id"
      FROM "night_mode_transition_scheduled_jobs"
      WHERE "chat_id" = ${chatId}
        AND "job_id" = ${jobId}
        AND "transition" = ${job.transition}
        AND "session_key" = ${job.sessionKey}
        AND "scheduled_for" = ${scheduledFor}
        AND "schedule_fingerprint" = ${scheduleFingerprint}
        AND "runtime_version" = 4
      LIMIT 1
    `);
    return rows.length === 1 && rows[0]?.job_id === jobId;
  }

  private resolveSessionScheduleFingerprint(sessionKey: string): string | null {
    const parsed = parseNightModeTransitionSessionKey(sessionKey);
    return parsed
      ? buildNightModeTransitionScheduleFingerprint({
          nightModeEnabled: true,
          nightModeStartTimeMinutes: parsed.startMinutes,
          nightModeEndTimeMinutes: parsed.endMinutes,
          nightModeTimezone: parsed.timezone,
        })
      : null;
  }

  // FLAG: Queue cleanup cannot remove an active BullMQ job. Re-read committed SQL state under the
  // runtime lock immediately before every external send/delete so a disable or reschedule wins.
  private async readCurrentSideEffectSettings(
    chatId: string,
    expectedSnapshot: NightModeTransitionSnapshot,
  ): Promise<NightModeTransitionRuntimeSettings | null> {
    const settings = await this.readCurrentScheduledSettings(chatId, expectedSnapshot);
    if (
      settings &&
      expectedSnapshot.status === 'open' &&
      resolveEffectiveChatClosure(settings).manual.active
    )
      return null;
    return settings;
  }

  private async readCurrentScheduledSettings(
    chatId: string,
    expectedSnapshot: NightModeTransitionSnapshot,
  ): Promise<NightModeTransitionRuntimeSettings | null> {
    if (typeof this.prisma.chatSettings?.findUnique !== 'function') {
      return null;
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            rules: {
              select: {
                publishedUrl: true,
                publishedMessageId: true,
              },
            },
          },
        },
      },
    });
    if (!settings?.nightModeEnabled || settings.chat?.entityType !== ChatEntityType.CHAT) {
      return null;
    }

    const currentSnapshot = this.resolveNightModeTransitionSnapshot(settings);
    if (
      !currentSnapshot ||
      currentSnapshot.status !== expectedSnapshot.status ||
      currentSnapshot.sessionKey !== expectedSnapshot.sessionKey ||
      currentSnapshot.startMinutes !== expectedSnapshot.startMinutes ||
      currentSnapshot.endMinutes !== expectedSnapshot.endMinutes ||
      currentSnapshot.timezone !== expectedSnapshot.timezone
    ) {
      return null;
    }
    return settings;
  }

  private async isCurrentSideEffectGeneration(
    expectedSettings: NightModeTransitionRuntimeSettings,
    expectedSnapshot: NightModeTransitionSnapshot,
    executionFence?: NightModeTransitionExecutionFence | null,
  ): Promise<boolean> {
    const currentSettings = await this.readCurrentSideEffectSettings(
      expectedSettings.chatId,
      expectedSnapshot,
    );
    const generationMatches =
      currentSettings !== null &&
      this.buildSideEffectGeneration(currentSettings) ===
        this.buildSideEffectGeneration(expectedSettings);
    if (!generationMatches) {
      return false;
    }
    return executionFence ? !(await this.isExactTransitionManuallyFenced(executionFence)) : true;
  }

  private buildExecutionFence(
    job: NightModeTransitionJob,
  ): NightModeTransitionExecutionFence | null {
    const chatId = job.chatId.trim();
    const parsedSession = parseNightModeTransitionSessionKey(job.sessionKey);
    const fingerprint =
      job.scheduleFingerprint?.trim() ||
      (parsedSession
        ? buildNightModeTransitionScheduleFingerprint({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: parsedSession.startMinutes,
            nightModeEndTimeMinutes: parsedSession.endMinutes,
            nightModeTimezone: parsedSession.timezone,
          })
        : null);
    if (!chatId) {
      return null;
    }
    return {
      transition: job.transition,
      chatId,
      jobId: buildNightModeTransitionJobId(
        chatId,
        job.transition,
        job.scheduledFor,
        job.sessionKey,
      ),
      sessionKey: job.sessionKey,
      fingerprint,
    };
  }

  private withStickyRouteProbeAuthorization(
    job: NightModeTransitionJob,
    snapshot: NightModeTransitionSnapshot,
  ): NightModeTransitionExecutionSnapshot {
    const marker = parseNightModeStickyRouteProbe(job.stickyRouteProbe);
    if (
      !marker ||
      job.transition !== 'close' ||
      job.recoveryOnly !== undefined ||
      job.routeVerification !== undefined ||
      job.transitionRuntimeVersion !== 4 ||
      marker.scheduledFor !== job.scheduledFor ||
      marker.sessionKey !== job.sessionKey ||
      marker.scheduleFingerprint !== job.scheduleFingerprint ||
      marker.sessionKey !== snapshot.sessionKey ||
      !snapshot.isCloseBoundary
    ) {
      return snapshot;
    }
    return {
      ...snapshot,
      stickyRouteProbe: marker,
    };
  }

  private async isExactTransitionManuallyFenced(
    fence: NightModeTransitionExecutionFence,
  ): Promise<boolean> {
    if (typeof this.prisma.nightModeTransitionReconcileRequest?.findUnique !== 'function') {
      return false;
    }
    const row = await this.prisma.nightModeTransitionReconcileRequest.findUnique({
      where: { chatId: fence.chatId },
      select: {
        manualBlockedAt: true,
        manualBlockedCategory: true,
        manualBlockedJobId: true,
        manualBlockedSessionKey: true,
        manualBlockedFingerprint: true,
      },
    });
    return (
      row?.manualBlockedAt instanceof Date &&
      this.isManualBlockCategory(row.manualBlockedCategory) &&
      matchesNightModeTransitionFenceAlias(fence, {
        sessionKey: row.manualBlockedSessionKey,
        jobId: row.manualBlockedJobId,
      }) &&
      (fence.fingerprint === null || row.manualBlockedFingerprint === fence.fingerprint)
    );
  }

  private isManualBlockCategory(value: string | null): boolean {
    return (
      value === 'unsafe_prior_dispatch' ||
      value === 'unsafe_prior_provenance' ||
      value === 'no_fresh_access' ||
      value === 'failed_job_unclassified'
    );
  }

  private buildSideEffectGeneration(settings: NightModeTransitionRuntimeSettings): string {
    return buildNightModeTransitionSideEffectFingerprint(settings);
  }

  private buildNightModeTransitionLockKey(chatId: string): string {
    return `night-mode-transition-lock:v1:${chatId}`;
  }

  private async findPersistedCloseNotice(
    chatId: string,
    sessionKey: string,
  ): Promise<{ id: string; messageId: string; botId: string | null } | null> {
    if (typeof this.prisma.moderationEvent?.findFirst !== 'function') {
      return null;
    }

    const event = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        messageId: {
          not: null,
        },
        metadata: {
          path: ['sessionKey'],
          equals: sessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: {
        id: true,
        messageId: true,
        botId: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    const messageId = event?.messageId?.trim() ?? '';
    if (!messageId) {
      return null;
    }
    return {
      id: event!.id,
      messageId,
      botId: event?.botId?.trim() || null,
    };
  }

  private async hasPersistedOpenNotice(chatId: string, sessionKey: string): Promise<boolean> {
    if (typeof this.prisma.moderationEvent?.findFirst !== 'function') {
      return false;
    }

    const event = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
        metadata: {
          path: ['sessionKey'],
          equals: sessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: {
        id: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    return Boolean(event);
  }

  // FLAG: A pending marker represents a MAX send that was accepted before its moderation event
  // became durable. Recovery must never re-enter publication; only exact SQL proof may clear it.
  private async recoverPendingCloseNoticeEvent(
    chatId: string,
    state: NightModeTransitionState,
    snapshot: NightModeTransitionSnapshot,
    hooks: NightModeTransitionRuntimeHooks,
    lock: NightModeTransitionLock,
  ): Promise<{
    state: NightModeTransitionState;
    event: NightModeRecoveredCloseNoticeEvent;
  }> {
    const marker = state.closeNoticeEventRecovery;
    const messageId = state.closeNoticeMessageId?.trim() ?? '';
    const botId = state.closeNoticeBotId?.trim() ?? '';
    if (
      state.status !== 'closed' ||
      marker?.version !== 2 ||
      !messageId ||
      !botId ||
      !state.sessionKey.trim() ||
      state.sessionKey !== snapshot.sessionKey ||
      marker.timezone !== snapshot.timezone ||
      marker.startMinutes !== snapshot.startMinutes ||
      marker.endMinutes !== snapshot.endMinutes
    ) {
      throw new Error(`Night mode close-event recovery marker is unsupported (${chatId})`);
    }

    await this.assertNightModeTransitionLock(lock, chatId);
    const event = await hooks.recoverClosedNoticeEvent({
      chatId,
      sessionKey: state.sessionKey,
      messageId,
      botId,
      timezone: marker.timezone,
      startMinutes: marker.startMinutes,
      endMinutes: marker.endMinutes,
    });
    await this.assertNightModeTransitionLock(lock, chatId);
    if (
      !event.eventId.trim() ||
      event.sessionKey !== state.sessionKey ||
      event.messageId !== messageId ||
      event.botId !== botId
    ) {
      throw new Error(`Night mode close-event recovery returned mismatched proof (${chatId})`);
    }
    const recoveredState: NightModeTransitionState = {
      status: 'closed',
      sessionKey: state.sessionKey,
      closeNoticeMessageId: messageId,
      closeNoticeBotId: botId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeNightModeTransitionState(chatId, recoveredState, lock);
    return {
      state: recoveredState,
      event,
    };
  }

  private async recoverUntrackedCloseNoticeEvent(
    chatId: string,
    state: NightModeTransitionState | null,
    snapshot: NightModeTransitionSnapshot,
    hooks: NightModeTransitionRuntimeHooks,
    lock: NightModeTransitionLock,
  ): Promise<{
    state: NightModeTransitionState;
    event: NightModeRecoveredCloseNoticeEvent;
  } | null> {
    if (state?.status === 'open' && state.sessionKey === snapshot.sessionKey) {
      return null;
    }
    if (state?.status === 'closed' && state.sessionKey !== snapshot.sessionKey) {
      throw new Error(`Night mode close recovery session changed (${chatId})`);
    }

    const stateForSession =
      state?.status === 'closed' && state.sessionKey === snapshot.sessionKey ? state : null;
    const expectedMessageId = stateForSession?.closeNoticeMessageId?.trim() ?? '';
    const expectedBotId = stateForSession?.closeNoticeBotId?.trim() ?? '';
    const event = await hooks.recoverClosedNoticeEventFromLedger({
      chatId,
      sessionKey: snapshot.sessionKey,
      timezone: snapshot.timezone,
      startMinutes: snapshot.startMinutes,
      endMinutes: snapshot.endMinutes,
    });
    if (!event) {
      return null;
    }
    if (
      event.sessionKey !== snapshot.sessionKey ||
      !event.eventId.trim() ||
      (expectedMessageId && event.messageId !== expectedMessageId) ||
      (expectedBotId && event.botId !== expectedBotId)
    ) {
      throw new Error(`Night mode close ledger recovery mismatched runtime state (${chatId})`);
    }

    const recoveredState: NightModeTransitionState = {
      status: 'closed',
      sessionKey: snapshot.sessionKey,
      closeNoticeMessageId: event.messageId,
      closeNoticeBotId: event.botId,
      updatedAt: new Date().toISOString(),
    };
    await this.writeNightModeTransitionState(chatId, recoveredState, lock);
    return { state: recoveredState, event };
  }

  private async sendClosedNoticeAndCaptureAcceptedState(
    settings: NightModeTransitionRuntimeSettings,
    snapshot: NightModeTransitionSnapshot,
    hooks: NightModeTransitionRuntimeHooks,
    lock: NightModeTransitionLock,
    executionFence?: NightModeTransitionExecutionFence | null,
  ): Promise<NightModeTransitionNoticeResult> {
    try {
      await this.assertNightModeTransitionLock(lock, settings.chatId);
      return await hooks.sendClosedNotice(settings, snapshot, async () => {
        await this.assertNightModeTransitionLock(lock, settings.chatId);
        return this.isCurrentSideEffectGeneration(settings, snapshot, executionFence);
      });
    } catch (error: unknown) {
      if (
        this.isAcceptedNoticeForSnapshot(
          error,
          settings.chatId,
          snapshot,
          'NIGHT_MODE_CLOSE_NOTICE',
        )
      ) {
        await this.writeNightModeTransitionState(
          settings.chatId,
          {
            status: 'closed',
            sessionKey: snapshot.sessionKey,
            closeNoticeMessageId: error.details.messageId,
            closeNoticeBotId: error.details.botId,
            closeNoticeEventRecovery: {
              version: 2,
              pending: true,
              timezone: snapshot.timezone,
              startMinutes: snapshot.startMinutes,
              endMinutes: snapshot.endMinutes,
            },
            updatedAt: new Date().toISOString(),
          },
          lock,
        ).catch((stateError: unknown) => {
          this.logger.warn(
            {
              chatId: settings.chatId,
              error: stateError instanceof Error ? stateError.message : String(stateError),
            },
            'Accepted close notice could not update runtime state; persisted send recovery remains authoritative',
          );
        });
      }
      throw error;
    }
  }

  private async sendOpenedNoticeAndCaptureAcceptedState(
    settings: NightModeTransitionRuntimeSettings,
    snapshot: NightModeTransitionSnapshot,
    hooks: NightModeTransitionRuntimeHooks,
    lock: NightModeTransitionLock,
    executionFence?: NightModeTransitionExecutionFence | null,
  ): Promise<NightModeTransitionProcessResult> {
    try {
      await this.assertNightModeTransitionLock(lock, settings.chatId);
      return await hooks.sendOpenedNotice(settings, snapshot, async () => {
        await this.assertNightModeTransitionLock(lock, settings.chatId);
        if (!(await this.isCurrentSideEffectGeneration(settings, snapshot, executionFence)))
          return false;
        const dueAt = resolveNightModeTransitionSessionOpenAt(snapshot.sessionKey);
        return (
          dueAt !== null &&
          resolveNightModeNoticeCatchUpWindow(
            { transition: 'open', dueAt, sessionKey: snapshot.sessionKey },
            settings,
          ).state === 'within_window'
        );
      });
    } catch (error: unknown) {
      if (
        this.isAcceptedNoticeForSnapshot(error, settings.chatId, snapshot, 'NIGHT_MODE_OPEN_NOTICE')
      ) {
        if (!error.details.botId) {
          throw error;
        }
        await hooks.scheduleRecoveryObligation(settings.chatId, {
          kind: NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY,
          version: 1,
          sessionKey: snapshot.sessionKey,
          messageId: error.details.messageId,
          botId: error.details.botId,
          timezone: snapshot.timezone,
          startMinutes: snapshot.startMinutes,
          endMinutes: snapshot.endMinutes,
        });
        await this.writeNightModeTransitionState(
          settings.chatId,
          {
            status: 'open',
            sessionKey: snapshot.sessionKey,
            closeNoticeMessageId: null,
            closeNoticeBotId: null,
            updatedAt: new Date().toISOString(),
          },
          lock,
        ).catch((stateError: unknown) => {
          this.logger.warn(
            {
              chatId: settings.chatId,
              error: stateError instanceof Error ? stateError.message : String(stateError),
            },
            'Accepted open notice could not update runtime state; persisted send recovery remains authoritative',
          );
        });
      }
      throw error;
    }
  }

  private isAcceptedNoticeForSnapshot(
    error: unknown,
    chatId: string,
    snapshot: NightModeTransitionSnapshot,
    ruleCode: NightModeTransitionNoticeRuleCode,
  ): error is NightModeTransitionNoticeEventPersistenceError {
    const acceptedError = this.asAcceptedNoticePersistenceError(error);
    return (
      acceptedError !== null &&
      acceptedError.details.chatId === chatId &&
      acceptedError.details.ruleCode === ruleCode &&
      acceptedError.details.sessionKey === snapshot.sessionKey
    );
  }

  private asAcceptedNoticePersistenceError(
    error: unknown,
  ): NightModeTransitionNoticeEventPersistenceError | null {
    return isNightModeTransitionNoticeEventPersistenceError(error) ? error : null;
  }

  private async readNightModeTransitionState(
    chatId: string,
  ): Promise<NightModeTransitionState | null> {
    const key = buildNightModeTransitionStateKey(chatId);
    const raw = this.redisCounter
      ? await this.redisCounter.getString(key)
      : JSON.stringify(this.nightModeTransitionMemoryState.get(key) ?? null);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return parseNightModeTransitionState(parsed);
    } catch {
      return null;
    }
  }

  private async writeNightModeTransitionState(
    chatId: string,
    state: NightModeTransitionState,
    lock: NightModeTransitionLock,
  ): Promise<void> {
    await this.assertNightModeTransitionLock(lock, chatId);
    const key = buildNightModeTransitionStateKey(chatId);
    if (this.redisCounter) {
      await this.redisCounter.setStringWithTtl(
        key,
        JSON.stringify(state),
        NIGHT_MODE_TRANSITION_STATE_TTL_SEC,
      );
      return;
    }

    this.nightModeTransitionMemoryState.set(key, state);
  }

  private async acquireNightModeTransitionLock(
    chatId: string,
  ): Promise<NightModeTransitionLock | null> {
    const key = this.buildNightModeTransitionLockKey(chatId);
    if (this.redisCounter) {
      const token = await this.redisCounter.acquireLock(key, NIGHT_MODE_TRANSITION_LOCK_TTL_MS);
      if (!token) {
        return null;
      }
      const lock: NightModeTransitionLock = {
        key,
        token,
        redis: true,
        healthy: true,
        heartbeat: null,
        renewalChain: Promise.resolve(),
      };
      lock.heartbeat = setInterval(() => {
        lock.renewalChain = lock.renewalChain
          .then(async () => {
            if (
              !(await this.redisCounter?.renewLock(
                lock.key,
                lock.token,
                NIGHT_MODE_TRANSITION_LOCK_TTL_MS,
              ))
            ) {
              lock.healthy = false;
            }
          })
          .catch((error: unknown) => {
            lock.healthy = false;
            this.logger.warn(
              {
                chatId,
                error: error instanceof Error ? error.message : String(error),
              },
              'Night mode transition lock renewal failed',
            );
          });
      }, NIGHT_MODE_TRANSITION_LOCK_HEARTBEAT_MS);
      lock.heartbeat.unref();
      return lock;
    }

    if (this.nightModeTransitionMemoryLocks.has(key)) {
      return null;
    }

    const token = randomUUID();
    this.nightModeTransitionMemoryLocks.set(key, token);
    return {
      key,
      token,
      redis: false,
      healthy: true,
      heartbeat: null,
      renewalChain: Promise.resolve(),
    };
  }

  private async releaseNightModeTransitionLock(lock: NightModeTransitionLock): Promise<void> {
    if (lock.heartbeat) {
      clearInterval(lock.heartbeat);
      lock.heartbeat = null;
    }
    await lock.renewalChain.catch(() => undefined);
    if (lock.redis) {
      await this.redisCounter?.releaseLock(lock.key, lock.token);
      return;
    }

    if (this.nightModeTransitionMemoryLocks.get(lock.key) === lock.token) {
      this.nightModeTransitionMemoryLocks.delete(lock.key);
    }
  }

  private async assertNightModeTransitionLock(
    lock: NightModeTransitionLock,
    chatId: string,
  ): Promise<void> {
    await lock.renewalChain;
    if (!lock.healthy) {
      throw new NightModeTransitionLockLostError(chatId);
    }
    if (lock.redis) {
      const renewed = await this.redisCounter?.renewLock(
        lock.key,
        lock.token,
        NIGHT_MODE_TRANSITION_LOCK_TTL_MS,
      );
      if (!renewed) {
        lock.healthy = false;
        throw new NightModeTransitionLockLostError(chatId);
      }
      return;
    }
    if (this.nightModeTransitionMemoryLocks.get(lock.key) !== lock.token) {
      lock.healthy = false;
      throw new NightModeTransitionLockLostError(chatId);
    }
  }
}
