import type {
  ChatSettings,
  ChatClosureStatus,
  ChatClosureSummary,
} from '@maxim/contracts/settings';
import { ServiceUnavailableException } from '@nestjs/common';
import { CHAT_CLOSURE_POLICY_SELECT } from '../common/chat-closure-policy-change';
import type { NightModeNoticeRouteSnapshot } from '../moderation/night-mode-notice-diagnostics';
import {
  normalizeMembershipAccessSnapshot,
  membershipExplicitlyLacksAccess,
} from '../max/max-bot-access-policy.util';
import { isMajorManagedEntityActivationRequired } from '../max/managed-entity-activation.util';
import { executionRouteProof, hasExecutionCapability } from '../max/max-execution-route-proof';
import { classifyNightModeNoticeSendRoute } from '../moderation/night-mode-notice-diagnostics';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveEffectiveChatClosure,
} from '../moderation/night-mode-transition-time.util';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readChatClosureNoticeDiagnostics } from './chat-closure-notice-diagnostics';

function routeSelect(actionableBotIds: readonly string[]) {
  return {
    id: true,
    entityType: true,
    primaryBotId: true,
    fixedModeratorBotId: true,
    routingVersion: true,
    routingState: true,
    botMemberships: {
      where: { botId: { in: [...actionableBotIds] } },
      select: {
        botId: true,
        status: true,
        botAccessState: true,
        botAccessCheckedAt: true,
        botAccessExpiresAt: true,
        botAccessSource: true,
        permissionsSnapshot: true,
        sendRouteFailureCount: true,
        sendRouteQuarantinedUntil: true,
        sendRouteLastFailureCode: true,
      },
    },
  } satisfies Prisma.ChatSelect;
}

function deleteRoute(
  snapshot: NightModeNoticeRouteSnapshot | null,
  distinguishUnknown = false,
): ChatClosureSummary['deleteRoute'] {
  if (!snapshot || snapshot.entityType !== 'CHAT' || snapshot.routingState !== 'READY')
    return 'unavailable';
  const state = { ...snapshot, candidates: snapshot.botMemberships };
  let uncertain = false;
  for (const bot of snapshot.botMemberships) {
    if (snapshot.fixedModeratorBotId && snapshot.fixedModeratorBotId !== bot.botId) continue;
    if (
      executionRouteProof(state, bot.botId, 'moderation') &&
      executionRouteProof(state, bot.botId, 'delete_message')
    )
      return 'available';
    if (
      !distinguishUnknown ||
      bot.status !== 'ACTIVE' ||
      isMajorManagedEntityActivationRequired(bot, snapshot.entityType) ||
      !['UNKNOWN', 'STALE', 'CONFIRMED_ADMIN', 'CONFIRMED_OWNER'].includes(bot.botAccessState) ||
      membershipExplicitlyLacksAccess(bot.permissionsSnapshot)
    )
      continue;
    const rights = normalizeMembershipAccessSnapshot(bot.permissionsSnapshot);
    const ceiling = rights?.activationCapabilityCeiling;
    if (ceiling && (!ceiling.includes('moderation') || !ceiling.includes('delete_message')))
      continue;
    if (
      rights?.permissionsKnown === true &&
      (!hasExecutionCapability(bot, snapshot.entityType, 'moderation') ||
        !hasExecutionCapability(bot, snapshot.entityType, 'delete_message'))
    )
      continue;
    uncertain = true;
  }
  return uncertain ? 'unknown' : 'unavailable';
}

export async function readChatClosureSummary(
  prisma: PrismaService,
  chatId: string,
  actionableBotIds: readonly string[] | undefined,
  now = new Date(),
): Promise<ChatClosureSummary> {
  const chat = await prisma.chat.findUnique({
    where: { id: chatId },
    select: {
      ...routeSelect(actionableBotIds ?? []),
      settings: {
        select: {
          ...CHAT_CLOSURE_POLICY_SELECT,
          nightModeBotMessageEnabled: true,
          nightModeOpenMessageEnabled: true,
        },
      },
    },
  });
  if (chat?.entityType !== 'CHAT' || !chat.settings)
    throw new ServiceUnavailableException('Состояние чата временно недоступно.');
  const settings = chat.settings;
  const effective = resolveEffectiveChatClosure(settings, now);
  const route = { ...chat, chatId };
  return {
    observedAt: now.toISOString(),
    scheduleEnabled: settings.nightModeEnabled,
    restriction: effective.restriction,
    nightActive: effective.night?.status === 'closed',
    manualMode: effective.manual.mode,
    timezone: settings.nightModeTimezone,
    opensAt: effective.opensAt?.toISOString() ?? null,
    nextTransitionAt: effective.nextTransitionAt?.toISOString() ?? null,
    deleteRoute: actionableBotIds ? deleteRoute(route, true) : 'unknown',
    notificationsEnabled:
      settings.nightModeEnabled &&
      (settings.nightModeBotMessageEnabled || settings.nightModeOpenMessageEnabled),
    sendRoute: actionableBotIds ? classifyNightModeNoticeSendRoute(route, now) : 'unknown',
  };
}

export async function readChatClosureStatus(
  prisma: PrismaService,
  chatId: string,
  settings: ChatSettings,
  actionableBotIds: readonly string[],
  now = new Date(),
): Promise<ChatClosureStatus> {
  const night = resolveCurrentNightModeCloseOccurrence(settings, now);
  const effective = resolveEffectiveChatClosure(settings, now);
  const status: ChatClosureStatus = {
    observedAt: now.toISOString(),
    scheduleEnabled: settings.nightModeEnabled,
    restriction: effective.restriction,
    timezone: settings.nightModeTimezone,
    opensAt: effective.opensAt?.toISOString() ?? null,
    nextTransitionAt: effective.nextTransitionAt?.toISOString() ?? null,
    deleteRoute: 'unknown',
    notice: settings.nightModeBotMessageEnabled ? 'unknown' : 'disabled',
    recovery: 'unknown',
  };
  // FLAG: This is an exact-chat SQL read model, never a live rights check or SEND proof.
  // Failure to read diagnostics cannot prevent the settings screen from opening.
  const [chatResult, noticeResult] = await Promise.allSettled([
    prisma.chat.findUnique({
      where: { id: chatId },
      select: routeSelect(actionableBotIds),
    }),
    readChatClosureNoticeDiagnostics(prisma, chatId, settings, now),
  ]);
  if (noticeResult.status === 'fulfilled') {
    status.notices = noticeResult.value.notices;
    status.recovery = noticeResult.value.recovery;
  }
  if (chatResult.status === 'fulfilled') {
    const chat = chatResult.value;
    if (status.notices)
      status.notices.sendRouteNow = classifyNightModeNoticeSendRoute(
        chat ? { ...chat, chatId } : null,
        now,
      );
    status.deleteRoute = deleteRoute(chat ? { ...chat, chatId } : null);
  }
  if (!night)
    status.notice = settings.nightModeBotMessageEnabled
      ? effective.closed
        ? 'unknown'
        : 'not_expected'
      : 'disabled';
  else if (settings.nightModeBotMessageEnabled && status.notices?.close.latest) {
    const outcome = status.notices.close.latest.delivery.outcome;
    status.notice = outcome === 'sent' ? 'delivered' : outcome === 'not_sent' ? 'failed' : outcome;
  }
  return status;
}
