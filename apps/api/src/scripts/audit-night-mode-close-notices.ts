import type { NightModeNoticeDeliveryEvidence } from '@maxim/contracts/settings';
import { NestFactory } from '@nestjs/core';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import { isNightModeTransitionMembershipCandidate } from '../moderation/night-mode-transition-eligibility.util';
import { buildNightModeTransitionJobId } from '../moderation/night-mode-transition.queue';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveLatestNightModeTransitionOccurrences,
  resolveNightModeNoticeCatchUpWindow,
  type NightModeTransitionKind,
  resolveNextNightModeTransitionOccurrences,
  type NightModeTransitionOccurrence,
} from '../moderation/night-mode-transition-time.util';
import {
  NIGHT_MODE_NOTICE_DIAGNOSTIC_LEDGER_SELECT,
  classifyNightModeNoticeLedger,
  classifyNightModeNoticeSendRoute,
  type NightModeNoticeDiagnosticLedgerRow,
} from '../moderation/night-mode-notice-diagnostics';
import { getAppRole } from '../runtime/app-role';

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;
const DEFAULT_MAX_CHATS = 50_000;
const MAX_MAX_CHATS = 100_000;
const DEFAULT_SAMPLE_LIMIT = 25;
const MAX_SAMPLE_LIMIT = 100;
const NIGHT_MODE_TRANSITION_RUNTIME_VERSION = 4;

export const NIGHT_MODE_CLOSE_NOTICE_AUDIT_USAGE = [
  'Usage:',
  '  [--page-size 1..500] [--max-chats 1..100000] [--sample-limit 0..100]',
  '  [--after <chat-id>] [--json]',
  '',
  'Read-only fleet audit for both notices in all enabled night-mode settings.',
  'Run it in a Major API role (api-admin is recommended), never api-publisher.',
  '--max-chats bounds ALL scanned settings, including disabled rows; --after resumes that cursor.',
  'The audit performs no MAX calls, queue calls, sends, or database mutations.',
].join('\n');

export type NightModeCloseNoticeAuditOptions = {
  pageSize: number;
  maxChats: number;
  sampleLimit: number;
  after: string | null;
};

const AUDIT_SETTINGS_SELECT = {
  chatId: true,
  nightModeEnabled: true,
  nightModeBotMessageEnabled: true,
  nightModeOpenMessageEnabled: true,
  nightModeStartTimeMinutes: true,
  nightModeEndTimeMinutes: true,
  nightModeTimezone: true,
  chat: {
    select: {
      title: true,
      entityType: true,
      routingState: true,
      primaryBotId: true,
      fixedModeratorBotId: true,
      routingVersion: true,
      _count: { select: { botMemberships: true } },
      botMemberships: {
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
          sendRouteLastFailureAt: true,
          sendRouteLastFailureCode: true,
          sendRouteLastSuccessAt: true,
        },
        orderBy: { botId: 'asc' },
      },
    },
  },
} satisfies Prisma.ChatSettingsSelect;

export type NightModeCloseNoticeAuditSettingsRow = Prisma.ChatSettingsGetPayload<{
  select: typeof AUDIT_SETTINGS_SELECT;
}>;

export type NightModeCloseNoticeRegistryRow = {
  chat_id: string;
  job_id: string;
  transition: string;
  session_key: string;
  scheduled_for: Date;
  schedule_fingerprint: string;
  runtime_version: number;
  recovery_payload: Prisma.JsonValue | null;
};

type NightModeCloseNoticeLedgerRow = NightModeNoticeDiagnosticLedgerRow;

type AuditPrisma = Pick<PrismaService, 'chatSettings' | 'maxActionLedgerEntry' | '$queryRaw'>;
type AuditBotRegistry = Pick<MaxBotRegistryService, 'getActionableBots'>;

type ChatCategory =
  | 'no_memberships'
  | 'no_actionable_route'
  | 'sticky_routes'
  | 'first_failures'
  | 'mixed_degraded'
  | 'healthy';

type NoRouteReason =
  | 'unsupported_entity'
  | 'routing_closed'
  | 'no_memberships'
  | 'no_configured_bot_membership'
  | 'no_active_configured_membership'
  | 'access_denied_or_lost'
  | 'no_actionable_access'
  | 'route_quarantined';

type RouteHealthCategory = 'sticky' | 'first_failure' | 'other_quarantined' | 'healthy';
type RegistryState = 'missing' | 'exact' | 'mismatch';
type LedgerState =
  | 'missing'
  | 'mismatch'
  | 'succeeded'
  | 'pending'
  | 'terminal_failure'
  | 'invalid_success'
  | 'ambiguous'
  | 'other';

type ExpectedCloseOccurrence = {
  scope: 'current' | 'latest' | 'next';
  transition: NightModeTransitionKind;
  enabledNow: boolean;
  catchUp: { state: 'within_window' | 'expired' | 'future'; endsAt: string };
  chatId: string;
  sessionKey: string;
  dueAt: Date;
  registryJobId: string;
  ledgerJobId: string;
  scheduleFingerprint: string;
  scheduleExpected: boolean;
};

type AuditedChat = {
  row: NightModeCloseNoticeAuditSettingsRow;
  category: ChatCategory;
  actionableMemberships: NightModeCloseNoticeAuditSettingsRow['chat']['botMemberships'];
  routeHealth: Array<{
    membership: NightModeCloseNoticeAuditSettingsRow['chat']['botMemberships'][number];
    category: RouteHealthCategory;
  }>;
  occurrences: ExpectedCloseOccurrence[];
  hasCloseBoundary: boolean;
  sendRouteNow: 'available' | 'unavailable' | 'unknown';
  noRouteReason: NoRouteReason | null;
};

type ChatSample = {
  chatId: string;
  title: string;
  routingState: string;
  category: ChatCategory;
  noRouteReason: NoRouteReason | null;
  membershipCount: number;
  actionableRouteCount: number;
  stickyRouteCount: number;
  firstFailureRouteCount: number;
  healthyRouteCount: number;
};

type RouteSample = {
  chatId: string;
  title: string;
  botId: string;
  failureCount: number;
  quarantinedUntil: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  lastSuccessAt: string | null;
  halfOpenEligible: boolean;
};

type CoverageSample = {
  transition: NightModeTransitionKind;
  enabledNow: boolean;
  sendRouteNow: AuditedChat['sendRouteNow'];
  catchUp: ExpectedCloseOccurrence['catchUp'];
  delivery: NightModeNoticeDeliveryEvidence;
  chatId: string;
  title: string;
  sessionKey: string;
  dueAt: string;
  registryJobId: string;
  ledgerJobId: string;
  registryState: RegistryState;
  ledgerState: LedgerState;
  ledgerStatus: string | null;
  ledgerTerminal: boolean | null;
  ledgerAmbiguous: boolean | null;
  ledgerHasCompletedAt: boolean;
  ledgerHasDispatchBot: boolean;
  ledgerHasRemoteMessage: boolean;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
};

type SampledChatCounter = { count: number; samples: ChatSample[] };
type SampledRouteCounter = { count: number; affectedChats: number; samples: RouteSample[] };

type CoverageCounter = {
  expectationBasis: 'historical_unknown' | 'current_eligibility';
  occurrences: number;
  notificationEnabledNow: number;
  delivery: Record<NightModeNoticeDeliveryEvidence['outcome'], number>;
  catchUp: Record<'within_window' | 'expired' | 'future', number>;
  scheduleExpected: number;
  registry: {
    exact: number;
    missing: number;
    mismatch: number;
    unexpectedWhenUnscheduled: number;
  };
  ledger: {
    exact: number;
    missing: number;
    mismatch: number;
    succeeded: number;
    pending: number;
    terminalFailure: number;
    invalidSuccess: number;
    ambiguous: number;
    other: number;
  };
  durableCovered: number;
  absentRegistryAndLedger: number;
  missingDurable: number;
  successfulDeliveries: number;
  withoutSuccessfulDelivery: number;
  samples: {
    missingDurable: CoverageSample[];
    registryMismatch: CoverageSample[];
    ledgerMismatch: CoverageSample[];
    ledgerMissing: CoverageSample[];
    ledgerPending: CoverageSample[];
    ledgerFailedOrAmbiguous: CoverageSample[];
    ledgerInvalidSuccess: CoverageSample[];
    withoutSuccessfulDelivery: CoverageSample[];
    unexpectedRegistry: CoverageSample[];
  };
};

export type NightModeCloseNoticeFleetAudit = {
  schemaVersion: 2;
  readOnly: true;
  generatedAt: string;
  snapshot: 'best_effort_read_only';
  scope: {
    nightModeEnabled: true;
    notices: 'close_and_open_regardless_of_current_notice_switch';
    expectationBasis: 'current_schedule';
    evidenceScope: 'exact_send_ledger';
    historicalSettings: 'not_available';
    legacyCoverage: 'current_and_next_close_with_close_switch_enabled_now';
    scanBudget: 'all_settings_rows_before_eligibility';
    routeHealthPopulation: 'configured_actionable_bots_in_matching_chats';
    bullPayload: 'not_inspected_scheduler_self_heals_from_registry';
  };
  limits: {
    pageSize: number;
    maxChats: number;
    sampleLimit: number;
    after: string | null;
  };
  scan: {
    pages: number;
    scannedChats: number;
    scannedSettings: number;
    complete: boolean;
    nextAfter: string | null;
  };
  notices: Record<
    NightModeTransitionKind,
    { enabledNow: number; disabledNow: number; latest: CoverageCounter; next: CoverageCounter }
  >;
  sendRouteNow: Record<AuditedChat['sendRouteNow'], number>;
  configuredActionableBots: number;
  categories: Record<ChatCategory, SampledChatCounter>;
  noRouteReasons: Record<NoRouteReason, SampledChatCounter>;
  routes: {
    memberships: number;
    configuredBotMemberships: number;
    excludedMemberships: number;
    actionable: number;
    sticky: SampledRouteCounter;
    firstFailures: SampledRouteCounter;
    otherQuarantined: SampledRouteCounter;
    healthy: SampledRouteCounter;
  };
  schedule: {
    withoutCloseBoundary: SampledChatCounter;
  };
  coverage: {
    current: CoverageCounter;
    next: CoverageCounter;
  };
};

function readRequiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function readBoundedInteger(value: string, option: string, min: number, max: number): number {
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${option} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${option} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function readNightModeCloseNoticeAuditOptions(
  argv: readonly string[],
): NightModeCloseNoticeAuditOptions {
  let pageSize = DEFAULT_PAGE_SIZE;
  let maxChats = DEFAULT_MAX_CHATS;
  let sampleLimit = DEFAULT_SAMPLE_LIMIT;
  let after: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      continue;
    }
    if (arg === '--page-size') {
      pageSize = readBoundedInteger(readRequiredValue(argv, index, arg), arg, 1, MAX_PAGE_SIZE);
      index += 1;
      continue;
    }
    if (arg === '--max-chats') {
      maxChats = readBoundedInteger(readRequiredValue(argv, index, arg), arg, 1, MAX_MAX_CHATS);
      index += 1;
      continue;
    }
    if (arg === '--sample-limit') {
      sampleLimit = readBoundedInteger(
        readRequiredValue(argv, index, arg),
        arg,
        0,
        MAX_SAMPLE_LIMIT,
      );
      index += 1;
      continue;
    }
    if (arg === '--after') {
      after = readRequiredValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(NIGHT_MODE_CLOSE_NOTICE_AUDIT_USAGE);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return { pageSize, maxChats, sampleLimit, after };
}

export function assertNightModeCloseNoticeAuditRuntime(): void {
  if (getAppRole() === 'publisher') {
    throw new Error('Run night-mode close-notice audit in a Major API role, not api-publisher');
  }
}

function createSampledChatCounter(): SampledChatCounter {
  return { count: 0, samples: [] };
}

function createSampledRouteCounter(): SampledRouteCounter {
  return { count: 0, affectedChats: 0, samples: [] };
}

function createCoverageCounter(
  expectationBasis: CoverageCounter['expectationBasis'] = 'current_eligibility',
): CoverageCounter {
  return {
    expectationBasis,
    occurrences: 0,
    notificationEnabledNow: 0,
    delivery: { sent: 0, not_recorded: 0, pending: 0, not_sent: 0, unknown: 0 },
    catchUp: { within_window: 0, expired: 0, future: 0 },
    scheduleExpected: 0,
    registry: { exact: 0, missing: 0, mismatch: 0, unexpectedWhenUnscheduled: 0 },
    ledger: {
      exact: 0,
      missing: 0,
      mismatch: 0,
      succeeded: 0,
      pending: 0,
      terminalFailure: 0,
      invalidSuccess: 0,
      ambiguous: 0,
      other: 0,
    },
    durableCovered: 0,
    absentRegistryAndLedger: 0,
    missingDurable: 0,
    successfulDeliveries: 0,
    withoutSuccessfulDelivery: 0,
    samples: {
      missingDurable: [],
      registryMismatch: [],
      ledgerMismatch: [],
      ledgerMissing: [],
      ledgerPending: [],
      ledgerFailedOrAmbiguous: [],
      ledgerInvalidSuccess: [],
      withoutSuccessfulDelivery: [],
      unexpectedRegistry: [],
    },
  };
}

function createAudit(
  options: NightModeCloseNoticeAuditOptions,
  generatedAt: Date,
  configuredActionableBots: number,
): NightModeCloseNoticeFleetAudit {
  return {
    schemaVersion: 2,
    readOnly: true,
    generatedAt: generatedAt.toISOString(),
    snapshot: 'best_effort_read_only',
    scope: {
      nightModeEnabled: true,
      notices: 'close_and_open_regardless_of_current_notice_switch',
      expectationBasis: 'current_schedule',
      evidenceScope: 'exact_send_ledger',
      historicalSettings: 'not_available',
      legacyCoverage: 'current_and_next_close_with_close_switch_enabled_now',
      scanBudget: 'all_settings_rows_before_eligibility',
      routeHealthPopulation: 'configured_actionable_bots_in_matching_chats',
      bullPayload: 'not_inspected_scheduler_self_heals_from_registry',
    },
    limits: { ...options },
    scan: { pages: 0, scannedChats: 0, scannedSettings: 0, complete: true, nextAfter: null },
    notices: {
      close: {
        enabledNow: 0,
        disabledNow: 0,
        latest: createCoverageCounter('historical_unknown'),
        next: createCoverageCounter(),
      },
      open: {
        enabledNow: 0,
        disabledNow: 0,
        latest: createCoverageCounter('historical_unknown'),
        next: createCoverageCounter(),
      },
    },
    sendRouteNow: { available: 0, unavailable: 0, unknown: 0 },
    configuredActionableBots,
    categories: {
      no_memberships: createSampledChatCounter(),
      no_actionable_route: createSampledChatCounter(),
      sticky_routes: createSampledChatCounter(),
      first_failures: createSampledChatCounter(),
      mixed_degraded: createSampledChatCounter(),
      healthy: createSampledChatCounter(),
    },
    noRouteReasons: {
      unsupported_entity: createSampledChatCounter(),
      routing_closed: createSampledChatCounter(),
      no_memberships: createSampledChatCounter(),
      no_configured_bot_membership: createSampledChatCounter(),
      no_active_configured_membership: createSampledChatCounter(),
      access_denied_or_lost: createSampledChatCounter(),
      no_actionable_access: createSampledChatCounter(),
      route_quarantined: createSampledChatCounter(),
    },
    routes: {
      memberships: 0,
      configuredBotMemberships: 0,
      excludedMemberships: 0,
      actionable: 0,
      sticky: createSampledRouteCounter(),
      firstFailures: createSampledRouteCounter(),
      otherQuarantined: createSampledRouteCounter(),
      healthy: createSampledRouteCounter(),
    },
    schedule: { withoutCloseBoundary: createSampledChatCounter() },
    coverage: { current: createCoverageCounter(), next: createCoverageCounter() },
  };
}

function pushBounded<T>(target: T[], value: T, limit: number): void {
  if (target.length < limit) {
    target.push(value);
  }
}

function classifyRouteHealth(
  membership: NightModeCloseNoticeAuditSettingsRow['chat']['botMemberships'][number],
  now: Date,
): RouteHealthCategory {
  if (
    membership.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
    membership.sendRouteFailureCount >= 2
  ) {
    return 'sticky';
  }
  if (
    membership.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
    membership.sendRouteFailureCount === 1
  ) {
    return 'first_failure';
  }
  if ((membership.sendRouteQuarantinedUntil?.getTime() ?? 0) > now.getTime()) {
    return 'other_quarantined';
  }
  return 'healthy';
}

function classifyChat(
  membershipCount: number,
  routeHealth: readonly { category: RouteHealthCategory }[],
  routingState: string,
): ChatCategory {
  if (membershipCount === 0) {
    return 'no_memberships';
  }
  if (routingState !== 'READY' || routeHealth.length === 0) {
    return 'no_actionable_route';
  }
  if (routeHealth.some((route) => route.category === 'healthy')) {
    return routeHealth.every((route) => route.category === 'healthy')
      ? 'healthy'
      : 'mixed_degraded';
  }
  if (routeHealth.every((route) => route.category === 'first_failure')) {
    return 'first_failures';
  }
  if (routeHealth.every((route) => route.category === 'sticky')) {
    return 'sticky_routes';
  }
  if (routeHealth.every((route) => route.category === 'other_quarantined')) {
    return 'no_actionable_route';
  }
  return routeHealth.length > 1 ? 'mixed_degraded' : 'no_actionable_route';
}

function resolveNoRouteReason(
  row: NightModeCloseNoticeAuditSettingsRow,
  configuredMemberships: NightModeCloseNoticeAuditSettingsRow['chat']['botMemberships'],
  actionableMemberships: NightModeCloseNoticeAuditSettingsRow['chat']['botMemberships'],
  routeHealth: readonly { category: RouteHealthCategory }[],
): NoRouteReason | null {
  if (row.chat._count.botMemberships === 0) {
    return 'no_memberships';
  }
  if (row.chat.entityType !== ChatEntityType.CHAT) {
    return 'unsupported_entity';
  }
  if (configuredMemberships.length === 0) {
    return 'no_configured_bot_membership';
  }
  const activeMemberships = configuredMemberships.filter(
    (membership) => membership.status === 'ACTIVE',
  );
  if (activeMemberships.length === 0) {
    return 'no_active_configured_membership';
  }
  if (
    activeMemberships.every((membership) =>
      ['DENIED', 'LOST', 'CONFIRMED_MEMBER'].includes(membership.botAccessState),
    )
  ) {
    return 'access_denied_or_lost';
  }
  if (row.chat.routingState !== 'READY') {
    return 'routing_closed';
  }
  if (actionableMemberships.length === 0) {
    return 'no_actionable_access';
  }
  if (routeHealth.every((route) => route.category === 'other_quarantined')) {
    return 'route_quarantined';
  }
  return null;
}

function buildExpectedOccurrence(
  scope: ExpectedCloseOccurrence['scope'],
  row: NightModeCloseNoticeAuditSettingsRow,
  occurrence: NightModeTransitionOccurrence,
  scheduleExpected: boolean,
  now: Date,
): ExpectedCloseOccurrence {
  const catchUp = resolveNightModeNoticeCatchUpWindow(occurrence, row, now);
  return {
    scope,
    transition: occurrence.transition,
    enabledNow:
      occurrence.transition === 'close'
        ? row.nightModeBotMessageEnabled
        : row.nightModeOpenMessageEnabled,
    catchUp: {
      state: occurrence.dueAt > now ? 'future' : catchUp.state,
      endsAt: catchUp.endsAt.toISOString(),
    },
    chatId: row.chatId,
    sessionKey: occurrence.sessionKey,
    dueAt: occurrence.dueAt,
    registryJobId: buildNightModeTransitionJobId(
      row.chatId,
      occurrence.transition,
      occurrence.dueAt.toISOString(),
      occurrence.sessionKey,
    ),
    ledgerJobId: buildNightModeNoticeIdempotencyKey(
      occurrence.transition,
      row.chatId,
      occurrence.sessionKey,
    ),
    scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(row),
    scheduleExpected,
  };
}

function inspectChat(
  row: NightModeCloseNoticeAuditSettingsRow,
  actionableBotIds: ReadonlySet<string>,
  now: Date,
): AuditedChat {
  const memberships = row.chat.botMemberships;
  const actionableMemberships =
    row.chat.entityType === ChatEntityType.CHAT
      ? memberships.filter((membership) =>
          isNightModeTransitionMembershipCandidate(membership, {
            isActionableBotId: (botId) => actionableBotIds.has(botId),
          }),
        )
      : [];
  const routableMemberships = row.chat.routingState === 'READY' ? actionableMemberships : [];
  const routeHealth = routableMemberships.map((membership) => ({
    membership,
    category: classifyRouteHealth(membership, now),
  }));
  const category = classifyChat(row.chat._count.botMemberships, routeHealth, row.chat.routingState);
  const noRouteReason =
    category === 'no_memberships' || category === 'no_actionable_route'
      ? resolveNoRouteReason(row, memberships, actionableMemberships, routeHealth)
      : null;
  const scheduleExpected =
    row.chat.entityType === ChatEntityType.CHAT && actionableMemberships.length > 0;
  const current = resolveCurrentNightModeCloseOccurrence(row, now);
  const latest = resolveLatestNightModeTransitionOccurrences(row, now);
  const next = resolveNextNightModeTransitionOccurrences(row, now);
  const occurrences: ExpectedCloseOccurrence[] = [];
  // Compatibility counters retain their original close-switch population. Latest evidence
  // includes both switches in either state; today's switches cannot prove yesterday's intent.
  if (current && row.nightModeBotMessageEnabled) {
    occurrences.push(buildExpectedOccurrence('current', row, current, scheduleExpected, now));
  }
  for (const item of [latest.close, latest.open]) {
    if (item) occurrences.push(buildExpectedOccurrence('latest', row, item, scheduleExpected, now));
  }
  for (const item of next) {
    occurrences.push(buildExpectedOccurrence('next', row, item, scheduleExpected, now));
  }
  return {
    row,
    category,
    actionableMemberships: routableMemberships,
    routeHealth,
    occurrences,
    hasCloseBoundary: Boolean(latest.close || next.some((item) => item.transition === 'close')),
    sendRouteNow: classifyNightModeNoticeSendRoute({ chatId: row.chatId, ...row.chat }, now),
    noRouteReason,
  };
}

function occurrenceRegistryKey(chatId: string, jobId: string): string {
  return JSON.stringify([chatId, jobId]);
}

export async function loadExactNightModeCloseNoticeRegistryRows(
  prisma: Pick<AuditPrisma, '$queryRaw'>,
  occurrences: readonly ExpectedCloseOccurrence[],
): Promise<NightModeCloseNoticeRegistryRow[]> {
  const uniquePairs = new Map<string, { chatId: string; jobId: string }>();
  for (const occurrence of occurrences) {
    uniquePairs.set(occurrenceRegistryKey(occurrence.chatId, occurrence.registryJobId), {
      chatId: occurrence.chatId,
      jobId: occurrence.registryJobId,
    });
  }
  const pairs = [...uniquePairs.values()];
  if (pairs.length === 0) {
    return [];
  }

  // At most four distinct transition occurrences per bounded settings page hit the registry PK.
  const pairSql = pairs.map(({ chatId, jobId }) => Prisma.sql`(${chatId}, ${jobId})`);
  return prisma.$queryRaw<NightModeCloseNoticeRegistryRow[]>(Prisma.sql`
    SELECT
      registry."chat_id",
      registry."job_id",
      registry."transition",
      registry."session_key",
      registry."scheduled_for",
      registry."schedule_fingerprint",
      registry."runtime_version",
      registry."recovery_payload"
    FROM "night_mode_transition_scheduled_jobs" registry
    WHERE (registry."chat_id", registry."job_id") IN (${Prisma.join(pairSql)})
    ORDER BY registry."chat_id" ASC, registry."job_id" ASC
  `);
}

async function loadExactLedgerRows(
  prisma: Pick<AuditPrisma, 'maxActionLedgerEntry'>,
  occurrences: readonly ExpectedCloseOccurrence[],
): Promise<NightModeCloseNoticeLedgerRow[]> {
  const jobIds = [...new Set(occurrences.map((occurrence) => occurrence.ledgerJobId))];
  if (jobIds.length === 0) {
    return [];
  }
  return prisma.maxActionLedgerEntry.findMany({
    where: { jobId: { in: jobIds } },
    select: NIGHT_MODE_NOTICE_DIAGNOSTIC_LEDGER_SELECT,
    orderBy: { jobId: 'asc' },
  });
}

function resolveRegistryState(
  occurrence: ExpectedCloseOccurrence,
  row: NightModeCloseNoticeRegistryRow | undefined,
): RegistryState {
  if (!row) {
    return 'missing';
  }
  return row.chat_id === occurrence.chatId &&
    row.job_id === occurrence.registryJobId &&
    row.transition === occurrence.transition &&
    row.session_key === occurrence.sessionKey &&
    row.scheduled_for.getTime() === occurrence.dueAt.getTime() &&
    row.schedule_fingerprint === occurrence.scheduleFingerprint &&
    row.runtime_version === NIGHT_MODE_TRANSITION_RUNTIME_VERSION &&
    row.recovery_payload === null
    ? 'exact'
    : 'mismatch';
}

function resolveLedgerState(evidence: NightModeNoticeDeliveryEvidence): LedgerState {
  switch (evidence.reason) {
    case 'ledger_missing':
      return 'missing';
    case 'identity_mismatch':
      return 'mismatch';
    case 'successful_receipt':
      return 'succeeded';
    case 'awaiting_first_attempt':
      return 'pending';
    case 'proven_pre_dispatch_failure':
      return 'terminal_failure';
    case 'incomplete_success':
      return 'invalid_success';
    case 'ambiguous':
      return 'ambiguous';
    default:
      return 'other';
  }
}

function toChatSample(chat: AuditedChat): ChatSample {
  const countRoutes = (category: RouteHealthCategory) =>
    chat.routeHealth.filter((route) => route.category === category).length;
  return {
    chatId: chat.row.chatId,
    title: chat.row.chat.title,
    routingState: chat.row.chat.routingState,
    category: chat.category,
    noRouteReason: chat.noRouteReason,
    membershipCount: chat.row.chat._count.botMemberships,
    actionableRouteCount: chat.actionableMemberships.length,
    stickyRouteCount: countRoutes('sticky'),
    firstFailureRouteCount: countRoutes('first_failure'),
    healthyRouteCount: countRoutes('healthy'),
  };
}

function toRouteSample(
  chat: AuditedChat,
  membership: AuditedChat['actionableMemberships'][number],
  now: Date,
): RouteSample {
  return {
    chatId: chat.row.chatId,
    title: chat.row.chat.title,
    botId: membership.botId,
    failureCount: membership.sendRouteFailureCount,
    quarantinedUntil: membership.sendRouteQuarantinedUntil?.toISOString() ?? null,
    lastFailureAt: membership.sendRouteLastFailureAt?.toISOString() ?? null,
    lastFailureCode: membership.sendRouteLastFailureCode,
    lastSuccessAt: membership.sendRouteLastSuccessAt?.toISOString() ?? null,
    halfOpenEligible:
      membership.sendRouteLastFailureCode === MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE &&
      membership.sendRouteFailureCount === 1 &&
      (membership.sendRouteQuarantinedUntil?.getTime() ?? 0) <= now.getTime(),
  };
}

function recordRouteCounters(
  audit: NightModeCloseNoticeFleetAudit,
  chat: AuditedChat,
  now: Date,
  sampleLimit: number,
): void {
  audit.routes.memberships += chat.row.chat._count.botMemberships;
  audit.routes.configuredBotMemberships += chat.row.chat.botMemberships.length;
  audit.routes.excludedMemberships += Math.max(
    0,
    chat.row.chat._count.botMemberships - chat.row.chat.botMemberships.length,
  );
  audit.routes.actionable += chat.actionableMemberships.length;
  const affected = new Set<RouteHealthCategory>();
  for (const route of chat.routeHealth) {
    const target =
      route.category === 'sticky'
        ? audit.routes.sticky
        : route.category === 'first_failure'
          ? audit.routes.firstFailures
          : route.category === 'other_quarantined'
            ? audit.routes.otherQuarantined
            : audit.routes.healthy;
    target.count += 1;
    pushBounded(target.samples, toRouteSample(chat, route.membership, now), sampleLimit);
    affected.add(route.category);
  }
  for (const category of affected) {
    const target =
      category === 'sticky'
        ? audit.routes.sticky
        : category === 'first_failure'
          ? audit.routes.firstFailures
          : category === 'other_quarantined'
            ? audit.routes.otherQuarantined
            : audit.routes.healthy;
    target.affectedChats += 1;
  }
}

function recordCoverage(
  target: CoverageCounter,
  chat: AuditedChat,
  occurrence: ExpectedCloseOccurrence,
  registryRows: ReadonlyMap<string, NightModeCloseNoticeRegistryRow>,
  ledgerRows: ReadonlyMap<string, NightModeCloseNoticeLedgerRow>,
  sampleLimit: number,
): void {
  const registryState = resolveRegistryState(
    occurrence,
    registryRows.get(occurrenceRegistryKey(occurrence.chatId, occurrence.registryJobId)),
  );
  const ledgerRow = ledgerRows.get(occurrence.ledgerJobId);
  const delivery = classifyNightModeNoticeLedger({
    chatId: occurrence.chatId,
    transition: occurrence.transition,
    sessionKey: occurrence.sessionKey,
    ledger: { state: 'read', row: ledgerRow ?? null },
  });
  const ledgerState = resolveLedgerState(delivery);
  const sample: CoverageSample = {
    transition: occurrence.transition,
    enabledNow: occurrence.enabledNow,
    sendRouteNow: chat.sendRouteNow,
    catchUp: occurrence.catchUp,
    delivery,
    chatId: chat.row.chatId,
    title: chat.row.chat.title,
    sessionKey: occurrence.sessionKey,
    dueAt: occurrence.dueAt.toISOString(),
    registryJobId: occurrence.registryJobId,
    ledgerJobId: occurrence.ledgerJobId,
    registryState,
    ledgerState,
    ledgerStatus: ledgerRow?.status ?? null,
    ledgerTerminal: ledgerRow?.terminal ?? null,
    ledgerAmbiguous: ledgerRow?.ambiguous ?? null,
    ledgerHasCompletedAt: ledgerRow?.completedAt instanceof Date,
    ledgerHasDispatchBot: Boolean(ledgerRow?.dispatchBotId?.trim()),
    ledgerHasRemoteMessage: Boolean(ledgerRow?.remoteMessageId?.trim()),
    lastStatusCode: ledgerRow?.lastStatusCode ?? null,
    lastErrorCode: ledgerRow?.lastErrorCode ?? null,
  };

  target.occurrences += 1;
  target.notificationEnabledNow += Number(occurrence.enabledNow);
  target.delivery[delivery.outcome] += 1;
  target.catchUp[occurrence.catchUp.state] += 1;
  if (target.expectationBasis === 'current_eligibility' && occurrence.scheduleExpected) {
    target.scheduleExpected += 1;
  }
  target.registry[registryState] += 1;
  if (
    target.expectationBasis === 'current_eligibility' &&
    !occurrence.scheduleExpected &&
    registryState !== 'missing'
  ) {
    target.registry.unexpectedWhenUnscheduled += 1;
    pushBounded(target.samples.unexpectedRegistry, sample, sampleLimit);
  }
  if (ledgerState === 'missing') {
    target.ledger.missing += 1;
    pushBounded(target.samples.ledgerMissing, sample, sampleLimit);
  } else if (ledgerState === 'mismatch') {
    target.ledger.mismatch += 1;
    pushBounded(target.samples.ledgerMismatch, sample, sampleLimit);
  } else {
    target.ledger.exact += 1;
    if (ledgerState === 'terminal_failure') {
      target.ledger.terminalFailure += 1;
      pushBounded(target.samples.ledgerFailedOrAmbiguous, sample, sampleLimit);
    } else if (ledgerState === 'invalid_success') {
      target.ledger.invalidSuccess += 1;
      pushBounded(target.samples.ledgerInvalidSuccess, sample, sampleLimit);
    } else if (ledgerState === 'ambiguous') {
      target.ledger.ambiguous += 1;
      pushBounded(target.samples.ledgerFailedOrAmbiguous, sample, sampleLimit);
    } else if (ledgerState === 'pending') {
      target.ledger.pending += 1;
      pushBounded(target.samples.ledgerPending, sample, sampleLimit);
    } else {
      target.ledger[ledgerState] += 1;
    }
  }
  if (registryState === 'mismatch') {
    pushBounded(target.samples.registryMismatch, sample, sampleLimit);
  }

  if (ledgerState === 'succeeded') {
    target.successfulDeliveries += 1;
  } else {
    target.withoutSuccessfulDelivery += 1;
    pushBounded(target.samples.withoutSuccessfulDelivery, sample, sampleLimit);
  }

  const registryCovered = registryState === 'exact';
  const ledgerCovered = ledgerState !== 'missing' && ledgerState !== 'mismatch';
  if (registryCovered || ledgerCovered) {
    target.durableCovered += 1;
  } else {
    if (registryState === 'missing' && ledgerState === 'missing')
      target.absentRegistryAndLedger += 1;
    // FLAG: Completed ordinary jobs are retired and may never have required a notice.
    // Current eligibility cannot turn absent historical records into missing work.
    if (target.expectationBasis === 'current_eligibility' && occurrence.scheduleExpected) {
      target.missingDurable += 1;
      pushBounded(target.samples.missingDurable, sample, sampleLimit);
    }
  }
}

export function buildNightModeAuditCursorQuery(after: string | null, take: number): Prisma.Sql {
  // FLAG: Limit the unfiltered primary-key walk before any sparse eligibility predicate or
  // membership relation. Keep the raw cursor even when the whole page is disabled.
  return Prisma.sql`SELECT "chat_id" AS "chatId", "night_mode_enabled" AS "nightModeEnabled"
    FROM "chat_settings"
    ${after === null ? Prisma.empty : Prisma.sql`WHERE "chat_id" > ${after}`}
    ORDER BY "chat_id" ASC LIMIT ${take}`;
}

type CursorRow = { chatId: string; nightModeEnabled: boolean };

async function loadSettingsPage(
  prisma: Pick<AuditPrisma, 'chatSettings'>,
  chatIds: readonly string[],
  actionableBotIds: readonly string[],
): Promise<NightModeCloseNoticeAuditSettingsRow[]> {
  if (chatIds.length === 0) return [];
  return prisma.chatSettings.findMany({
    where: { chatId: { in: [...chatIds] } },
    select: {
      ...AUDIT_SETTINGS_SELECT,
      chat: {
        select: {
          ...AUDIT_SETTINGS_SELECT.chat.select,
          botMemberships: {
            ...AUDIT_SETTINGS_SELECT.chat.select.botMemberships,
            where: { botId: { in: [...actionableBotIds] } },
          },
        },
      },
    },
    orderBy: { chatId: 'asc' },
    take: chatIds.length,
  });
}

async function processPage(
  prisma: AuditPrisma,
  audit: NightModeCloseNoticeFleetAudit,
  rows: readonly NightModeCloseNoticeAuditSettingsRow[],
  actionableBotIds: ReadonlySet<string>,
  generatedAt: Date,
  sampleLimit: number,
): Promise<void> {
  const chats = rows.map((row) => inspectChat(row, actionableBotIds, generatedAt));
  const occurrences = chats.flatMap((chat) => chat.occurrences);
  const registryRows = await loadExactNightModeCloseNoticeRegistryRows(prisma, occurrences);
  const ledgerRows = await loadExactLedgerRows(prisma, occurrences);
  const registryByKey = new Map(
    registryRows.map((row) => [occurrenceRegistryKey(row.chat_id, row.job_id), row]),
  );
  const ledgerByJobId = new Map(ledgerRows.map((row) => [row.jobId, row]));

  for (const chat of chats) {
    audit.sendRouteNow[chat.sendRouteNow] += 1;
    audit.notices.close[chat.row.nightModeBotMessageEnabled ? 'enabledNow' : 'disabledNow'] += 1;
    audit.notices.open[chat.row.nightModeOpenMessageEnabled ? 'enabledNow' : 'disabledNow'] += 1;
    const chatCounter = audit.categories[chat.category];
    const chatSample = toChatSample(chat);
    chatCounter.count += 1;
    pushBounded(chatCounter.samples, chatSample, sampleLimit);
    if (chat.noRouteReason) {
      const reasonCounter = audit.noRouteReasons[chat.noRouteReason];
      reasonCounter.count += 1;
      pushBounded(reasonCounter.samples, chatSample, sampleLimit);
    }
    recordRouteCounters(audit, chat, generatedAt, sampleLimit);
    if (!chat.hasCloseBoundary) {
      audit.schedule.withoutCloseBoundary.count += 1;
      pushBounded(audit.schedule.withoutCloseBoundary.samples, chatSample, sampleLimit);
    }
    for (const occurrence of chat.occurrences) {
      const targets =
        occurrence.scope === 'current'
          ? [audit.coverage.current]
          : [audit.notices[occurrence.transition][occurrence.scope]];
      if (occurrence.scope === 'next' && occurrence.transition === 'close' && occurrence.enabledNow)
        targets.push(audit.coverage.next);
      for (const target of targets)
        recordCoverage(target, chat, occurrence, registryByKey, ledgerByJobId, sampleLimit);
    }
  }
}

export async function runNightModeCloseNoticeFleetAudit(
  prisma: AuditPrisma,
  botRegistry: AuditBotRegistry,
  options: NightModeCloseNoticeAuditOptions,
  now: () => Date = () => new Date(),
): Promise<NightModeCloseNoticeFleetAudit> {
  const generatedAt = now();
  const actionableBotIdList = botRegistry.getActionableBots().map((bot) => bot.id);
  const actionableBotIds = new Set(actionableBotIdList);
  const audit = createAudit(options, generatedAt, actionableBotIds.size);
  let cursor = options.after;

  while (audit.scan.scannedSettings < options.maxChats) {
    const remaining = options.maxChats - audit.scan.scannedSettings;
    const take = Math.min(options.pageSize, remaining);
    const page = await prisma.$queryRaw<CursorRow[]>(buildNightModeAuditCursorQuery(cursor, take));
    if (page.length === 0) break;
    audit.scan.pages += 1;
    const eligibleIds = page.filter((row) => row.nightModeEnabled).map((row) => row.chatId);
    const rows = (await loadSettingsPage(prisma, eligibleIds, actionableBotIdList)).filter(
      (row) => row.nightModeEnabled,
    );
    await processPage(prisma, audit, rows, actionableBotIds, generatedAt, options.sampleLimit);
    audit.scan.scannedSettings += page.length;
    audit.scan.scannedChats += rows.length;
    cursor = page[page.length - 1]!.chatId;
    if (page.length < take) break;
  }

  if (audit.scan.scannedSettings === options.maxChats && cursor !== null) {
    const lookahead = await prisma.$queryRaw<CursorRow[]>(
      buildNightModeAuditCursorQuery(cursor, 1),
    );
    if (lookahead.length > 0) {
      audit.scan.complete = false;
      audit.scan.nextAfter = cursor;
    }
  }
  return audit;
}

async function main(argv: readonly string[]): Promise<void> {
  assertNightModeCloseNoticeAuditRuntime();
  const options = readNightModeCloseNoticeAuditOptions(argv);
  const [{ NightModeCloseNoticeAuditModule }, { PrismaService }, { MaxBotRegistryService }] =
    await Promise.all([
      import('./night-mode-close-notice-audit.module'),
      import('../prisma/prisma.service'),
      import('../max/max-bot-registry.service'),
    ]);
  const app = await NestFactory.createApplicationContext(NightModeCloseNoticeAuditModule, {
    logger: false,
  });
  try {
    const result = await runNightModeCloseNoticeFleetAudit(
      app.get(PrismaService),
      app.get(MaxBotRegistryService),
      options,
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

export function runNightModeNoticeAuditCli(argv: readonly string[]): void {
  void main(argv).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

if (require.main === module) runNightModeNoticeAuditCli(process.argv.slice(2));
