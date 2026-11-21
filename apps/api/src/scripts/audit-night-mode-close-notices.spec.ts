import { legacyNightModeAuditArgs } from './repair-missed-night-mode-close-notices';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ChatRoutingState,
  MaxActionLedgerStatus,
  type Prisma,
} from '../prisma/prisma-client';
import type { NightModeNoticeDiagnosticLedgerRow } from '../moderation/night-mode-notice-diagnostics';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import { MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE } from '../max/max-send-route-health';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import { buildNightModeTransitionJobId } from '../moderation/night-mode-transition.queue';
import {
  resolveCurrentNightModeCloseOccurrence,
  resolveLatestNightModeTransitionOccurrences,
  resolveNextNightModeTransitionOccurrences,
} from '../moderation/night-mode-transition-time.util';
import {
  assertNightModeCloseNoticeAuditRuntime,
  readNightModeCloseNoticeAuditOptions,
  runNightModeCloseNoticeFleetAudit,
  type NightModeCloseNoticeAuditSettingsRow,
  type NightModeCloseNoticeRegistryRow,
} from './audit-night-mode-close-notices';

const NOW = new Date('2026-09-04T20:30:00.000Z');
const auditSource = readFileSync(resolve(__dirname, 'audit-night-mode-close-notices.ts'), 'utf8');
const auditModuleSource = readFileSync(
  resolve(__dirname, 'night-mode-close-notice-audit.module.ts'),
  'utf8',
);

type AuditMembership = NightModeCloseNoticeAuditSettingsRow['chat']['botMemberships'][number];

function membership(overrides: Partial<AuditMembership> = {}): AuditMembership {
  return {
    botId: 'bot-actionable',
    status: ChatBotMembershipStatus.ACTIVE,
    botAccessState: ChatBotAccessState.UNKNOWN,
    botAccessSource: null,
    botAccessCheckedAt: null,
    botAccessExpiresAt: null,
    permissionsSnapshot: null,
    sendRouteFailureCount: 0,
    sendRouteQuarantinedUntil: null,
    sendRouteLastFailureAt: null,
    sendRouteLastFailureCode: null,
    sendRouteLastSuccessAt: null,
    ...overrides,
  };
}

function settingsRow(
  chatId: string,
  memberships: AuditMembership[],
  overrides: Partial<NightModeCloseNoticeAuditSettingsRow> = {},
): NightModeCloseNoticeAuditSettingsRow {
  return {
    chatId,
    nightModeEnabled: true,
    nightModeBotMessageEnabled: true,
    nightModeOpenMessageEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    chat: {
      title: `Chat ${chatId}`,
      entityType: ChatEntityType.CHAT,
      routingState: ChatRoutingState.READY,
      primaryBotId: null,
      fixedModeratorBotId: null,
      routingVersion: 1,
      _count: { botMemberships: memberships.length },
      botMemberships: memberships,
    },
    ...overrides,
  };
}

function createPrismaFixture(params: {
  rows: NightModeCloseNoticeAuditSettingsRow[];
  registryRows?: NightModeCloseNoticeRegistryRow[];
  ledgerRows?: NightModeNoticeDiagnosticLedgerRow[];
}) {
  const findSettings = jest.fn(async (args: Prisma.ChatSettingsFindManyArgs) => {
    const ids = (args.where?.chatId as Prisma.StringFilter).in as string[];
    const selectedBots = (
      args.select?.chat as {
        select: {
          botMemberships: { where: { botId: { in: string[] } } };
        };
      }
    ).select.botMemberships.where.botId.in;
    return params.rows
      .filter((row) => ids.includes(row.chatId))
      .map((row) => ({
        ...row,
        chat: {
          ...row.chat,
          botMemberships: row.chat.botMemberships.filter((m) => selectedBots.includes(m.botId)),
        },
      }));
  });
  const queryRaw = jest.fn(async (query: Prisma.Sql) => {
    if (query.sql.includes('FROM "chat_settings"')) {
      const after = query.values.length > 1 ? (query.values[0] as string) : '';
      const take = query.values.at(-1) as number;
      return params.rows
        .filter((row) => row.chatId > after)
        .slice(0, take)
        .map(({ chatId, nightModeEnabled }) => ({ chatId, nightModeEnabled }));
    }
    return params.registryRows ?? [];
  });
  const findLedgers = jest.fn(async (args: { where: { jobId: { in: string[] } } }) => {
    const ids = new Set(args.where.jobId.in);
    return (params.ledgerRows ?? []).filter((row) => ids.has(row.jobId));
  });
  return {
    // Prisma's generic projection overload cannot describe this read-only fixture adapter.
    // All fixture records are checked against the actual production SELECT row types above.
    prisma: {
      chatSettings: { findMany: findSettings },
      maxActionLedgerEntry: { findMany: findLedgers },
      $queryRaw: queryRaw,
    } as unknown as Parameters<typeof runNightModeCloseNoticeFleetAudit>[0],
    findSettings,
    findLedgers,
    queryRaw,
  };
}

function ledger(
  row: NightModeCloseNoticeAuditSettingsRow,
  transition: 'close' | 'open',
  overrides: Partial<NightModeNoticeDiagnosticLedgerRow> = {},
): NightModeNoticeDiagnosticLedgerRow {
  const occurrence = resolveLatestNightModeTransitionOccurrences(row, NOW)[transition]!;
  return {
    jobId: buildNightModeNoticeIdempotencyKey(transition, row.chatId, occurrence.sessionKey),
    actionType: 'SEND_MESSAGE',
    chatId: row.chatId,
    sourceTag: 'night_mode_transition',
    status: MaxActionLedgerStatus.ENQUEUED,
    terminal: false,
    ambiguous: false,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageId: null,
    completedAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    ...overrides,
  };
}

const botRegistry = {
  getActionableBots: () => [{ id: 'bot-actionable' }],
} as unknown as Parameters<typeof runNightModeCloseNoticeFleetAudit>[1];

describe('night mode close notice fleet audit', () => {
  it('limits the former repair command to the same read-only audit', () => {
    const parse = (argv: string[]) =>
      readNightModeCloseNoticeAuditOptions(legacyNightModeAuditArgs(argv));
    expect(parse([])).toEqual({ pageSize: 100, maxChats: 100, sampleLimit: 0, after: null });
    expect(parse(['--dry-run', '--limit', '12', '--after', 'chat-cursor'])).toEqual({
      pageSize: 100,
      maxChats: 12,
      sampleLimit: 0,
      after: 'chat-cursor',
    });
    expect(() => parse(['--execute'])).toThrow(/Unknown option/u);
    expect(() => parse(['--limit', '100001'])).toThrow(/between/u);
    const legacySource = readFileSync(
      resolve(__dirname, 'repair-missed-night-mode-close-notices.ts'),
      'utf8',
    );
    expect(legacySource).not.toMatch(
      /AppModule|processNightModeTransitionJob|ModerationExecutionService/u,
    );
  });

  it('parses bounded, read-only CLI options', () => {
    expect(
      readNightModeCloseNoticeAuditOptions([
        '--json',
        '--page-size',
        '50',
        '--max-chats',
        '5000',
        '--sample-limit',
        '0',
        '--after',
        'chat-100',
      ]),
    ).toEqual({ pageSize: 50, maxChats: 5_000, sampleLimit: 0, after: 'chat-100' });

    expect(() => readNightModeCloseNoticeAuditOptions(['--page-size', '501'])).toThrow(
      /--page-size/u,
    );
    expect(() => readNightModeCloseNoticeAuditOptions(['--sample-limit', '-1'])).toThrow(
      /--sample-limit/u,
    );
    expect(() => readNightModeCloseNoticeAuditOptions(['--apply'])).toThrow(/Unknown option/u);
  });

  it('bounds the raw fleet scan before enabled settings and classifies chats missing memberships', async () => {
    const rows = [
      settingsRow('chat-01', []),
      settingsRow('chat-02', [
        membership({ botId: 'unknown-bot', botAccessState: ChatBotAccessState.DENIED }),
      ]),
      settingsRow('chat-03', [
        membership({
          sendRouteFailureCount: 2,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          sendRouteQuarantinedUntil: new Date('2026-09-05T02:00:00.000Z'),
        }),
      ]),
      settingsRow('chat-04', [
        membership({
          sendRouteFailureCount: 1,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          sendRouteQuarantinedUntil: new Date('2026-09-04T19:00:00.000Z'),
        }),
      ]),
      settingsRow('chat-05', [membership()]),
    ];
    const fixture = createPrismaFixture({ rows });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 2, maxChats: 100, sampleLimit: 1, after: null },
      () => NOW,
    );

    expect(result.scan).toEqual({
      pages: 3,
      scannedChats: 5,
      scannedSettings: 5,
      complete: true,
      nextAfter: null,
    });
    expect(result.categories.no_memberships.count).toBe(1);
    expect(result.categories.no_actionable_route.count).toBe(1);
    expect(result.categories.sticky_routes.count).toBe(1);
    expect(result.categories.first_failures.count).toBe(1);
    expect(result.categories.healthy.count).toBe(1);
    expect(result.routes).toMatchObject({
      memberships: 4,
      actionable: 3,
      sticky: { count: 1, affectedChats: 1 },
      firstFailures: { count: 1, affectedChats: 1 },
      healthy: { count: 1, affectedChats: 1 },
    });
    expect(result.routes.firstFailures.samples[0]).toMatchObject({
      chatId: 'chat-04',
      halfOpenEligible: true,
    });
    expect(result.coverage.current.scheduleExpected).toBe(3);
    expect(result.coverage.current.missingDurable).toBe(3);
    expect(result.coverage.current.successfulDeliveries).toBe(0);
    expect(result.coverage.current.withoutSuccessfulDelivery).toBe(5);
    expect(result.coverage.next.scheduleExpected).toBe(3);
    expect(result.coverage.next.missingDurable).toBe(3);
    expect(result.coverage.current.samples.missingDurable).toHaveLength(1);
    expect(result.coverage.current.samples.ledgerMissing).toHaveLength(1);
    expect(result.coverage.current.samples.withoutSuccessfulDelivery).toHaveLength(1);
    expect(result.categories.no_memberships.samples).toHaveLength(1);
    expect(result.scope).toMatchObject({
      nightModeEnabled: true,
      notices: 'close_and_open_regardless_of_current_notice_switch',
      expectationBasis: 'current_schedule',
      historicalSettings: 'not_available',
      scanBudget: 'all_settings_rows_before_eligibility',
    });
    expect(fixture.findSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { chatId: { in: ['chat-01', 'chat-02'] } },
        take: 2,
        orderBy: { chatId: 'asc' },
      }),
    );
    expect(fixture.findSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { chatId: { in: ['chat-03', 'chat-04'] } },
      }),
    );
    expect(fixture.queryRaw).toHaveBeenCalledTimes(6);
    expect(fixture.findLedgers).toHaveBeenCalledTimes(3);
  });

  it('separates routing closure, access loss, and mixed degraded routes', async () => {
    const routingClosed = settingsRow('chat-routing-closed', [membership()]);
    routingClosed.chat.routingState = ChatRoutingState.NO_ELIGIBLE_BOT;
    const denied = settingsRow('chat-denied', [
      membership({ botAccessState: ChatBotAccessState.DENIED }),
    ]);
    denied.chat.routingState = ChatRoutingState.NO_ELIGIBLE_BOT;
    const mixed = settingsRow('chat-mixed', [
      membership(),
      membership({
        botId: 'bot-actionable-2',
        sendRouteFailureCount: 2,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
      }),
    ]);
    mixed.chat._count.botMemberships = 4;
    const quarantined = settingsRow('chat-quarantined', [
      membership({ sendRouteQuarantinedUntil: new Date('2026-09-05T02:00:00.000Z') }),
      membership({
        botId: 'bot-actionable-2',
        sendRouteQuarantinedUntil: new Date('2026-09-05T03:00:00.000Z'),
      }),
    ]);
    const fixture = createPrismaFixture({ rows: [denied, mixed, quarantined, routingClosed] });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      {
        getActionableBots: () => [{ id: 'bot-actionable' }, { id: 'bot-actionable-2' }],
      } as unknown as typeof botRegistry,
      { pageSize: 10, maxChats: 10, sampleLimit: 10, after: null },
      () => NOW,
    );

    expect(result.categories.no_actionable_route.count).toBe(3);
    expect(result.categories.mixed_degraded.count).toBe(1);
    expect(result.noRouteReasons.routing_closed.count).toBe(1);
    expect(result.noRouteReasons.access_denied_or_lost.count).toBe(1);
    expect(result.noRouteReasons.route_quarantined.count).toBe(1);
    expect(result.routes).toMatchObject({
      memberships: 8,
      configuredBotMemberships: 6,
      excludedMemberships: 2,
      sticky: { count: 1 },
      healthy: { count: 1 },
      otherQuarantined: { count: 2 },
    });
  });

  it('rejects the publisher-only runtime registry', () => {
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'publisher';
    try {
      expect(() => assertNightModeCloseNoticeAuditRuntime()).toThrow(/api-publisher/u);
    } finally {
      if (previousRole === undefined) {
        delete process.env.APP_ROLE;
      } else {
        process.env.APP_ROLE = previousRole;
      }
    }
  });

  it('checks exact current and next registry and ledger identities', async () => {
    const row = settingsRow('chat-exact', [membership()]);
    const current = resolveCurrentNightModeCloseOccurrence(row, NOW)!;
    const next = resolveNextNightModeTransitionOccurrences(row, NOW).find(
      (occurrence) => occurrence.transition === 'close',
    )!;
    const fingerprint = buildNightModeTransitionScheduleFingerprint(row);
    const registryRow = (
      occurrence: typeof current,
      runtimeVersion = 4,
    ): NightModeCloseNoticeRegistryRow => ({
      chat_id: row.chatId,
      job_id: buildNightModeTransitionJobId(
        row.chatId,
        'close',
        occurrence.dueAt.toISOString(),
        occurrence.sessionKey,
      ),
      transition: 'close',
      session_key: occurrence.sessionKey,
      scheduled_for: occurrence.dueAt,
      schedule_fingerprint: fingerprint,
      runtime_version: runtimeVersion,
      recovery_payload: null,
    });
    const currentLedgerJobId = buildNightModeNoticeIdempotencyKey(
      'close',
      row.chatId,
      current.sessionKey,
    );
    const nextLedgerJobId = buildNightModeNoticeIdempotencyKey(
      'close',
      row.chatId,
      next.sessionKey,
    );
    const fixture = createPrismaFixture({
      rows: [row],
      registryRows: [registryRow(current), registryRow(next, 3)],
      ledgerRows: [
        {
          jobId: currentLedgerJobId,
          actionType: 'SEND_MESSAGE',
          chatId: row.chatId,
          sourceTag: 'night_mode_transition',
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          attemptCount: 1,
          firstAttemptAt: NOW,
          lastAttemptAt: NOW,
          dispatchToken: 'token',
          dispatchStartedAt: NOW,
          lastStatusCode: 200,
          lastErrorCode: null,
          completedAt: new Date('2026-09-04T20:00:05.000Z'),
          dispatchBotId: 'bot-actionable',
          remoteMessageId: 'mid.close',
        },
        {
          jobId: nextLedgerJobId,
          actionType: 'SEND_MESSAGE',
          chatId: row.chatId,
          sourceTag: 'wrong_source',
          status: MaxActionLedgerStatus.ENQUEUED,
          ambiguous: false,
          terminal: false,
          attemptCount: 0,
          firstAttemptAt: null,
          lastAttemptAt: null,
          dispatchToken: null,
          dispatchStartedAt: null,
          lastStatusCode: null,
          lastErrorCode: null,
          completedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
        },
      ],
    });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 10, maxChats: 10, sampleLimit: 5, after: null },
      () => NOW,
    );

    expect(result.coverage.current).toMatchObject({
      occurrences: 1,
      scheduleExpected: 1,
      registry: { exact: 1, missing: 0, mismatch: 0 },
      ledger: { exact: 1, succeeded: 1, mismatch: 0 },
      durableCovered: 1,
      missingDurable: 0,
      successfulDeliveries: 1,
      withoutSuccessfulDelivery: 0,
    });
    expect(result.coverage.next).toMatchObject({
      occurrences: 1,
      scheduleExpected: 1,
      registry: { exact: 0, missing: 0, mismatch: 1 },
      ledger: { exact: 0, mismatch: 1 },
      durableCovered: 0,
      missingDurable: 1,
    });
    expect(result.coverage.next.samples.registryMismatch).toHaveLength(1);
    expect(result.coverage.next.samples.ledgerMismatch).toHaveLength(1);
    expect(fixture.findLedgers).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: { in: expect.arrayContaining([currentLedgerJobId, nextLedgerJobId]) } },
      }),
    );
  });

  it('reports malformed succeeded ledger provenance separately from terminal failure', async () => {
    const row = settingsRow('chat-invalid-success', [membership()]);
    const current = resolveCurrentNightModeCloseOccurrence(row, NOW)!;
    const ledgerJobId = buildNightModeNoticeIdempotencyKey('close', row.chatId, current.sessionKey);
    const fixture = createPrismaFixture({
      rows: [row],
      ledgerRows: [
        {
          jobId: ledgerJobId,
          actionType: 'SEND_MESSAGE',
          chatId: row.chatId,
          sourceTag: 'night_mode_transition',
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          attemptCount: 1,
          firstAttemptAt: NOW,
          lastAttemptAt: NOW,
          dispatchToken: 'token',
          dispatchStartedAt: NOW,
          lastStatusCode: 200,
          lastErrorCode: null,
          completedAt: new Date('2026-09-04T20:00:05.000Z'),
          dispatchBotId: 'bot-actionable',
          remoteMessageId: null,
        },
      ],
    });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 10, maxChats: 10, sampleLimit: 5, after: null },
      () => NOW,
    );

    expect(result.coverage.current.ledger).toMatchObject({
      invalidSuccess: 1,
      terminalFailure: 0,
    });
    expect(result.coverage.current.samples.ledgerInvalidSuccess).toEqual([
      expect.objectContaining({
        ledgerState: 'invalid_success',
        ledgerStatus: MaxActionLedgerStatus.SUCCEEDED,
        ledgerTerminal: true,
        ledgerHasCompletedAt: true,
        ledgerHasDispatchBot: true,
        ledgerHasRemoteMessage: false,
      }),
    ]);
  });

  it.each([null, { version: 1, kind: 'close_notice_cleanup' }])(
    'keeps historical registry evidence separate from eligibility and rejects a recovery envelope on an ordinary job: %j',
    async (recoveryPayload) => {
      const row = settingsRow('chat-registry-envelope', []);
      const occurrence = resolveLatestNightModeTransitionOccurrences(row, NOW).close!;
      const fixture = createPrismaFixture({
        rows: [row],
        registryRows: [
          {
            chat_id: row.chatId,
            job_id: buildNightModeTransitionJobId(
              row.chatId,
              'close',
              occurrence.dueAt.toISOString(),
              occurrence.sessionKey,
            ),
            transition: 'close',
            session_key: occurrence.sessionKey,
            scheduled_for: occurrence.dueAt,
            schedule_fingerprint: buildNightModeTransitionScheduleFingerprint(row),
            runtime_version: 4,
            recovery_payload: recoveryPayload,
          },
        ],
      });
      const result = await runNightModeCloseNoticeFleetAudit(
        fixture.prisma,
        botRegistry,
        { pageSize: 5, maxChats: 5, sampleLimit: 2, after: null },
        () => NOW,
      );
      expect(result.notices.close.latest).toMatchObject({
        expectationBasis: 'historical_unknown',
        missingDurable: 0,
        registry: {
          exact: recoveryPayload === null ? 1 : 0,
          mismatch: recoveryPayload === null ? 0 : 1,
          unexpectedWhenUnscheduled: 0,
        },
        delivery: { not_recorded: 1 },
      });
    },
  );

  it('caps the scan and returns an exact resume cursor', async () => {
    const fixture = createPrismaFixture({
      rows: [settingsRow('chat-01', []), settingsRow('chat-02', []), settingsRow('chat-03', [])],
    });

    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 2, maxChats: 2, sampleLimit: 0, after: null },
      () => NOW,
    );

    expect(result.scan).toEqual({
      pages: 1,
      scannedChats: 2,
      scannedSettings: 2,
      complete: false,
      nextAfter: 'chat-02',
    });
    expect(fixture.queryRaw.mock.calls.at(-1)![0].values).toEqual(['chat-02', 1]);
  });

  it('keeps the dedicated bootstrap and audit path strictly read-only', () => {
    expect(auditSource).toContain('classifyNightModeNoticeLedger');
    expect(auditSource).toContain('buildNightModeAuditCursorQuery');
    expect(auditSource).toContain(
      'WHERE (registry."chat_id", registry."job_id") IN (${Prisma.join(pairSql)})',
    );
    expect(auditSource).not.toMatch(
      /\$executeRaw|\.update(?:Many)?\(|\.create\(|\.delete(?:Many)?\(/u,
    );
    expect(auditSource).not.toMatch(/MaxClientService|new Queue\(|getExactMessagePresence/u);
    expect(auditModuleSource).toContain('PrismaModule');
    expect(auditModuleSource).toContain('MaxBotRegistryService');
    expect(auditModuleSource).not.toMatch(/HttpModule|MaxClientService|Redis/u);
  });

  it('preserves the raw resume cursor across wholly disabled pages and includes opening-only chats', async () => {
    const fixture = createPrismaFixture({
      rows: [
        settingsRow('chat-01', [], { nightModeEnabled: false }),
        settingsRow('chat-02', [], { nightModeEnabled: false }),
        settingsRow('chat-03', [membership()], { nightModeBotMessageEnabled: false }),
        settingsRow('chat-04', [membership()], {
          nightModeBotMessageEnabled: false,
          nightModeOpenMessageEnabled: false,
        }),
      ],
    });
    const first = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 1, maxChats: 2, sampleLimit: 0, after: null },
      () => NOW,
    );
    expect(first.scan).toEqual({
      pages: 2,
      scannedChats: 0,
      scannedSettings: 2,
      complete: false,
      nextAfter: 'chat-02',
    });
    expect(fixture.findSettings).not.toHaveBeenCalled();
    expect(fixture.findLedgers).not.toHaveBeenCalled();
    const second = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 2, maxChats: 10, sampleLimit: 0, after: first.scan.nextAfter },
      () => NOW,
    );
    expect(second.scan).toMatchObject({ scannedSettings: 2, scannedChats: 2, complete: true });
    expect(second.coverage.current.occurrences).toBe(0);
    expect(second.notices.open).toMatchObject({
      enabledNow: 1,
      disabledNow: 1,
      latest: { occurrences: 2, notificationEnabledNow: 1, catchUp: { expired: 2 } },
      next: { occurrences: 2 },
    });
    expect(second.notices.close).toMatchObject({
      enabledNow: 0,
      disabledNow: 2,
      latest: { occurrences: 2 },
    });
    expect(second.notices.open.latest).toMatchObject({
      expectationBasis: 'historical_unknown',
      scheduleExpected: 0,
      missingDurable: 0,
      absentRegistryAndLedger: 2,
      registry: { unexpectedWhenUnscheduled: 0 },
    });
    expect(second.notices.open.next).toMatchObject({
      expectationBasis: 'current_eligibility',
      scheduleExpected: 2,
      missingDurable: 2,
    });
  });

  it('keeps exact opening success after its window ends, even when its current switch or route is off', async () => {
    const row = settingsRow('chat-sent', [], { nightModeOpenMessageEnabled: false });
    const fixture = createPrismaFixture({
      rows: [row],
      ledgerRows: [
        ledger(row, 'open', {
          status: MaxActionLedgerStatus.SUCCEEDED,
          terminal: true,
          attemptCount: 1,
          dispatchBotId: 'original-bot',
          remoteMessageId: 'original-mid',
          completedAt: new Date('2026-09-04T05:00:02.000Z'),
        }),
      ],
    });
    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 5, maxChats: 5, sampleLimit: 2, after: null },
      () => NOW,
    );
    expect(result.notices.open.latest).toMatchObject({
      occurrences: 1,
      notificationEnabledNow: 0,
      delivery: { sent: 1 },
      catchUp: { expired: 1 },
      successfulDeliveries: 1,
    });
    expect(result.sendRouteNow.unavailable).toBe(1);
  });

  it('does not label attempted or ambiguous openings as merely waiting or proven unsent', async () => {
    const attempted = settingsRow('chat-attempted', [membership()]);
    const ambiguous = settingsRow('chat-ambiguous', [membership()]);
    const fixture = createPrismaFixture({
      rows: [ambiguous, attempted],
      ledgerRows: [
        ledger(attempted, 'open', {
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          attemptCount: 1,
          firstAttemptAt: NOW,
        }),
        ledger(ambiguous, 'open', {
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          lastStatusCode: 503,
        }),
      ],
    });
    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 5, maxChats: 5, sampleLimit: 2, after: null },
      () => NOW,
    );
    expect(result.notices.open.latest.delivery).toEqual({
      sent: 0,
      not_recorded: 0,
      pending: 0,
      not_sent: 0,
      unknown: 2,
    });
    expect(
      result.notices.open.latest.samples.withoutSuccessfulDelivery.map((s) => s.delivery.reason),
    ).toEqual(['ambiguous', 'attempted_without_receipt']);
  });

  it('retains the latest close after opening and shows continuous schedules without invented boundaries', async () => {
    const row = settingsRow('chat-day', [membership()]);
    const continuous = settingsRow('chat-full-day', [], { nightModeEndTimeMinutes: 23 * 60 });
    const fixture = createPrismaFixture({ rows: [row, continuous] });
    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      botRegistry,
      { pageSize: 5, maxChats: 5, sampleLimit: 2, after: null },
      () => new Date('2026-09-04T12:00:00Z'),
    );
    expect(result.coverage.current.occurrences).toBe(0);
    expect(result.notices.close.latest.occurrences).toBe(1);
    expect(result.notices.open.latest.occurrences).toBe(1);
    expect(result.notices.open.latest.samples.ledgerMissing[0]).toMatchObject({
      dueAt: '2026-09-04T05:00:00.000Z',
      delivery: { outcome: 'not_recorded' },
      catchUp: { state: 'expired' },
    });
    expect(result.schedule.withoutCloseBoundary.count).toBe(1);
  });

  it('does not advertise a healthy peer as a send route for an inaccessible fixed moderator', async () => {
    const row = settingsRow('chat-fixed', [
      membership({ botId: 'fixed', botAccessState: ChatBotAccessState.DENIED }),
      membership({
        botId: 'peer',
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-09-04T20:00:00Z'),
        botAccessSource: 'start',
        permissionsSnapshot: {
          isAdmin: true,
          isOwner: false,
          permissionsKnown: true,
          permissions: ['write', 'read_all_messages'],
        },
      }),
    ]);
    row.chat.primaryBotId = row.chat.fixedModeratorBotId = 'fixed';
    const fixture = createPrismaFixture({ rows: [row] });
    const result = await runNightModeCloseNoticeFleetAudit(
      fixture.prisma,
      {
        getActionableBots: () => [{ id: 'fixed' }, { id: 'peer' }],
      } as unknown as typeof botRegistry,
      { pageSize: 5, maxChats: 5, sampleLimit: 1, after: null },
      () => NOW,
    );
    expect(result.sendRouteNow.unavailable).toBe(1);
    expect(result.notices.open.latest.samples.ledgerMissing[0]?.sendRouteNow).toBe('unavailable');
  });
});
