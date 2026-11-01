import {
  AUDIT_MESSAGE_EVENT_TYPES,
  assessCommercialExecution,
  assessCommercialSanitizationParity,
  assertCommercialAuditNotAborted,
  buildAuditCandidatePageSql,
  buildAuditCandidateCursorSql,
  buildAuditScanWindowSql,
  compareAuditCandidateKeys,
  derivePolicyCategory,
  deriveSafeContextBucket,
  deriveAuditEventFingerprint,
  formatAuditSampleLines,
  isCommercialEnforcementAction,
  iterateLockedAuditCandidateRows,
  openAuditJsonlOutputStreams,
  parseAuditCandidatePageRows,
  publishAuditJsonlOutputs,
  readNewestAuditSamples,
  readCliOptions,
  resolveCommercialAuditPrismaPoolConfig,
  resolveNextAuditCandidateCursor,
  resolveAuditCandidateScope,
  resolveAuditChatSettings,
  resolveAuditDetectionSettings,
  resolveAuditLoadSince,
  resolveCorpusSanitizedBaseline,
  retainNewestAuditSample,
  sanitizeAuditText,
  serializeAuditRecord,
  serializeAuditCorpusRecord,
  type AuditJsonlStreamTarget,
  type AuditRecord,
} from './audit-commercial-filter';
import type { ChatSettings } from '../prisma/prisma-client';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emptySnapshot = {
  hit: false,
  score: null,
  actionScore: null,
  confidenceScore: null,
  decisionBand: null,
  primarySubtype: null,
  supportingSubtypes: [],
  evidenceStrength: null,
  classifierVersion: null,
  commercialProbability: null,
  reviewProbability: null,
  classifierReasons: [],
  reviewRecommended: false,
  reviewReasons: [],
  matchedSignals: [],
  negativeSignals: [],
  decisionVersion: null,
  fpRisk: null,
  evidenceTier: null,
  subtype: null,
  actionBand: null,
  reviewPriority: null,
  campaignStrength: null,
  safeContextBucket: null,
  actionable: false,
  recordable: false,
  deleteSuppressed: false,
  suppressionReasons: [],
  reasonCodes: [],
  featureVector: {},
};

function buildAuditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    category: 'current_only',
    policyCategory: 'hard_delete',
    segment: 'SERVICES',
    safeContextBucket: 'none',
    label: 'positive_candidate',
    labelSource: 'commercial-audit-policy-v1',
    expectedAction: 'DELETE',
    expectedSubtype: 'SERVICES',
    isHardNegative: false,
    createdAt: new Date('2026-07-23T10:11:12.000Z'),
    webhookEventId: 'webhook-secret-id',
    eventType: 'message_created',
    chatId: 'chat-secret-id',
    chatTitle: 'Secret Chat Title',
    chatEntityType: 'CHAT',
    messageId: 'message-secret-id',
    senderId: 'sender-secret-id',
    text: 'Сырой текст https://private.example/path +7 999 123-45-67',
    sanitizedText: 'Сырой текст [url] [phone]',
    historical: emptySnapshot,
    current: { ...emptySnapshot, hit: true, actionBand: 'DELETE' },
    sanitizedBaseline: { ...emptySnapshot, hit: true, actionBand: 'DELETE' },
    settings: {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    },
    commercialCampaignContext: null,
    ...overrides,
  };
}

function passthroughStreamTarget(pathname: string) {
  return {
    pathname,
    serialize: (value: Record<string, unknown>) => value,
  };
}

describe('audit-commercial-filter CLI options', () => {
  it('keeps --limit all as an unlimited paged audit', () => {
    expect(readCliOptions(['--limit', 'all', '--page-size', '750']).limit).toBeNull();
    expect(readCliOptions(['--limit=all', '--page-size=750']).limit).toBeNull();
    expect(readCliOptions(['--limit=ALL', '--page-size', '750']).limit).toBeNull();
  });

  it('uses the default limit only when --limit is omitted', () => {
    expect(readCliOptions([]).limit).toBe(1500);
  });

  it('rejects non-integer limit values instead of truncating them', () => {
    expect(() => readCliOptions(['--limit', '10x'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
    expect(() => readCliOptions(['--limit', '1e6'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
    expect(() => readCliOptions(['--limit', '0'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
  });

  it('keeps missing option values explicit', () => {
    expect(() => readCliOptions(['--limit'])).toThrow('--limit requires a value');
    expect(() => readCliOptions(['--sample'])).toThrow('--sample requires a value');
    expect(() => readCliOptions(['--page-size'])).toThrow('--page-size requires a value');
  });

  it('enables bounded paging only for unlimited audits', () => {
    expect(readCliOptions(['--limit', 'all', '--page-size', '750']).pageSize).toBe(750);
    expect(readCliOptions(['--limit=all', '--page-size=5000']).pageSize).toBe(5000);
    expect(() => readCliOptions(['--limit', 'all'])).toThrow(
      '--limit all requires --page-size <1..5000>',
    );

    expect(() => readCliOptions(['--page-size', '750'])).toThrow(
      '--page-size requires --limit all',
    );
    expect(() => readCliOptions(['--limit', '100', '--page-size', '50'])).toThrow(
      '--page-size requires --limit all',
    );
  });

  it('rejects unsafe page sizes', () => {
    expect(() => readCliOptions(['--limit', 'all', '--page-size', '0'])).toThrow(
      '--page-size must be an integer between 1 and 5000',
    );
    expect(() => readCliOptions(['--limit', 'all', '--page-size', '5001'])).toThrow(
      '--page-size must be an integer between 1 and 5000',
    );
    expect(() => readCliOptions(['--limit', 'all', '--page-size', '1.5'])).toThrow(
      '--page-size must be a non-negative integer',
    );
  });

  it('rejects audit and corpus outputs that resolve to the same path', () => {
    expect(() =>
      readCliOptions([
        '--export-jsonl',
        'artifacts/commercial-audit/output.jsonl',
        '--export-corpus-jsonl',
        'artifacts/commercial-audit/./output.jsonl',
      ]),
    ).toThrow('--export-jsonl and --export-corpus-jsonl must resolve to different paths');
  });

  it('allows --sample 0 for aggregate-only audits', () => {
    expect(readCliOptions(['--sample', '0']).sample).toBe(0);
  });

  it('keeps the default audit scoped to chats where the filter is enabled', () => {
    expect(readCliOptions([]).shadowAllChats).toBe(false);
  });

  it('can run a shadow commercial pass across all chats', () => {
    expect(readCliOptions(['--shadow-all-chats']).shadowAllChats).toBe(true);
  });

  it('supports a bounded campaign warm-up only for unlimited chronological audits', () => {
    const options = readCliOptions([
      '--since',
      '2026-07-21T11:20:41.000Z',
      '--limit',
      'all',
      '--page-size',
      '750',
      '--campaign-warmup-hours',
      '36',
      '--current-only',
    ]);

    expect(options.campaignWarmupHours).toBe(36);
    expect(options.pageSize).toBe(750);
    expect(options.currentOnly).toBe(true);
    expect(resolveAuditLoadSince(options).toISOString()).toBe('2026-07-19T23:20:41.000Z');
  });

  it('rejects campaign warm-up when a newest-row limit would discard the pre-roll', () => {
    expect(() => readCliOptions(['--campaign-warmup-hours', '36'])).toThrow(
      '--campaign-warmup-hours requires --limit all',
    );
    expect(() => readCliOptions(['--limit', 'all', '--campaign-warmup-hours', '169'])).toThrow(
      '--campaign-warmup-hours must be less than or equal to 168',
    );
  });

  it('rejects non-integer sample values instead of truncating them', () => {
    expect(() => readCliOptions(['--sample', '2x'])).toThrow(
      '--sample must be a non-negative integer',
    );
    expect(() => readCliOptions(['--sample', '1e6'])).toThrow(
      '--sample must be a non-negative integer',
    );
  });
});

describe('commercial audit keyset pagination', () => {
  it('uses a single non-parallel query connection with a bounded server statement timeout', () => {
    expect(
      resolveCommercialAuditPrismaPoolConfig(
        {
          application_name: 'api-admin',
          max: 12,
          options: '-c work_mem=16MB',
          statement_timeout: 60_000,
        },
        42,
      ),
    ).toEqual({
      application_name: 'maxim_commercial_audit_query_42',
      max: 1,
      options: '-c max_parallel_workers_per_gather=0',
      statement_timeout: 10_000,
    });
  });

  it('uses the event id as a stable cursor tie-breaker without gaps', () => {
    const firstTimestamp = new Date('2026-07-28T10:00:00.000Z');
    const secondTimestamp = new Date('2026-07-28T10:00:01.000Z');
    const rows = [
      { createdAt: firstTimestamp, webhookEventId: 'event-a' },
      { createdAt: firstTimestamp, webhookEventId: 'event-b' },
      { createdAt: firstTimestamp, webhookEventId: 'event-c' },
      { createdAt: secondTimestamp, webhookEventId: 'event-a' },
    ];

    const firstPage = rows.slice(0, 2);
    const cursor = resolveNextAuditCandidateCursor(firstPage);
    expect(cursor).toEqual(firstPage[1]);
    expect(cursor).not.toBe(firstPage[1]);
    expect(rows.filter((row) => cursor && compareAuditCandidateKeys(cursor, row) < 0)).toEqual(
      rows.slice(2),
    );
    expect(compareAuditCandidateKeys(rows[0], rows[1])).toBeLessThan(0);
    expect(compareAuditCandidateKeys(rows[2], rows[3])).toBeLessThan(0);
    expect(resolveNextAuditCandidateCursor([])).toBeNull();
  });

  it('uses an index-seekable row-value cursor predicate', () => {
    const createdAt = new Date('2026-07-28T10:00:00.000Z');
    const query = buildAuditCandidateCursorSql({
      createdAt,
      webhookEventId: 'event-b',
    });

    expect(query.strings.join('?').replace(/\s+/gu, ' ').trim()).toBe(
      'and (w.created_at, w.id) > (?, ?)',
    );
    expect(query.values).toEqual([createdAt, 'event-b']);
  });

  it('bounds the raw indexed scan before JSON predicates and chat joins', () => {
    const loadSince = new Date('2026-07-28T10:00:00.000Z');
    const until = new Date('2026-07-29T10:00:00.000Z');
    const cursor = {
      createdAt: new Date('2026-07-28T11:00:00.000Z'),
      webhookEventId: 'event-b',
    };
    const scanSql = buildAuditScanWindowSql({
      loadSince,
      until,
      pageSize: 500,
      cursor,
    });
    const scanShape = scanSql.strings.join('?').replace(/\s+/gu, ' ').trim();

    expect(scanShape).toContain('from webhook_events w');
    expect(scanShape).toContain("and w.status = 'PROCESSED'");
    expect(scanShape).toContain('and (w.created_at, w.id) > (?, ?)');
    expect(scanShape).toContain('order by w.created_at asc, w.id asc limit ?');
    expect(scanShape).not.toContain(' join ');
    expect(scanShape).not.toContain('normalized_payload ->>');
    expect(scanSql.values).toEqual([loadSince, until, cursor.createdAt, 'event-b', 500]);

    const options = readCliOptions([
      '--since',
      loadSince.toISOString(),
      '--until',
      until.toISOString(),
      '--limit',
      'all',
      '--page-size',
      '500',
      '--current-only',
    ]);
    const pageSql = buildAuditCandidatePageSql(options, { pageSize: 500, cursor });
    const pageShape = pageSql.strings.join('?').replace(/\s+/gu, ' ').trim();
    const boundedLimitOffset = pageShape.indexOf('limit ?');
    const candidateBaseOffset = pageShape.indexOf('base as (');

    expect(pageShape).toContain('with scan_page as materialized (');
    expect(boundedLimitOffset).toBeGreaterThan(0);
    expect(candidateBaseOffset).toBeGreaterThan(boundedLimitOffset);
    expect(pageShape.indexOf('join chats c')).toBeGreaterThan(candidateBaseOffset);
    expect(pageShape.indexOf("normalized_payload ->> 'type' in")).toBeGreaterThan(
      candidateBaseOffset,
    );
  });

  it('advances with the raw scan cursor when a page has no commercial candidates', () => {
    const loadSince = new Date('2026-07-28T10:00:00.000Z');
    const until = new Date('2026-07-29T10:00:00.000Z');
    const scanCursorCreatedAt = new Date('2026-07-28T10:05:00.000Z');
    const page = parseAuditCandidatePageRows([
      {
        scannedCount: 500,
        scanCursorCreatedAt,
        scanCursorWebhookEventId: 'raw-event-500',
        webhookEventId: null,
        eventType: null,
        createdAt: null,
        botId: null,
        chatId: null,
        chatTitle: null,
        chatEntityType: null,
        messageId: null,
        senderId: null,
        text: null,
        normalizedPayload: null,
        historicalEventId: null,
        historicalScore: null,
        historicalMetadata: null,
        hasHistoricalCommercialEvent: false,
      },
    ]);

    expect(page).not.toBeNull();
    if (!page) {
      throw new Error('Expected a non-empty raw scan page');
    }
    expect(page.candidates).toEqual([]);
    expect(page.cursor).toEqual({
      createdAt: scanCursorCreatedAt,
      webhookEventId: 'raw-event-500',
    });

    const nextScanSql = buildAuditScanWindowSql({
      loadSince,
      until,
      pageSize: 500,
      cursor: page.cursor,
    });
    expect(nextScanSql.values).toEqual([
      loadSince,
      until,
      scanCursorCreatedAt,
      'raw-event-500',
      500,
    ]);
  });

  it('recognizes the terminal empty scan sentinel and rejects a contradictory cursor', () => {
    const terminalSentinel = {
      scannedCount: 0,
      scanCursorCreatedAt: null,
      scanCursorWebhookEventId: null,
      webhookEventId: null,
      eventType: null,
      createdAt: null,
      botId: null,
      chatId: null,
      chatTitle: null,
      chatEntityType: null,
      messageId: null,
      senderId: null,
      text: null,
      normalizedPayload: null,
      historicalEventId: null,
      historicalScore: null,
      historicalMetadata: null,
      hasHistoricalCommercialEvent: false,
    };

    expect(parseAuditCandidatePageRows([terminalSentinel])).toBeNull();
    expect(() =>
      parseAuditCandidatePageRows([
        {
          ...terminalSentinel,
          scanCursorCreatedAt: new Date('2026-07-28T10:05:00.000Z'),
          scanCursorWebhookEventId: 'unexpected-cursor',
        },
      ]),
    ).toThrow('Commercial audit empty scan page returned a cursor');
  });

  it('stops row processing when an interrupt signal is observed', () => {
    const controller = new AbortController();
    const interruptError = new Error('Commercial audit interrupted by SIGTERM');
    controller.abort(interruptError);

    expect(() => assertCommercialAuditNotAborted(controller.signal)).toThrow(interruptError);
    expect(() =>
      iterateLockedAuditCandidateRows(
        ['first'],
        { assertHeld: jest.fn() },
        controller.signal,
      ).next(),
    ).toThrow(interruptError);
  });

  it('stops the current page before processing another row after lock loss', () => {
    const lockError = new Error('Commercial audit run lock session was lost');
    const assertHeld = jest
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw lockError;
      });
    const rows = iterateLockedAuditCandidateRows(['first', 'second', 'third'], { assertHeld });

    expect(rows.next()).toEqual({ done: false, value: 'first' });
    expect(() => rows.next()).toThrow(lockError);
    expect(assertHeld).toHaveBeenCalledTimes(2);
  });
});

describe('paged commercial audit samples', () => {
  it('retains only the newest bounded records and reads them newest-first', () => {
    const samples = new Map<AuditRecord['category'], AuditRecord[]>();
    const records = [
      buildAuditRecord({ createdAt: new Date('2026-07-28T10:00:00.000Z') }),
      buildAuditRecord({ createdAt: new Date('2026-07-28T10:00:01.000Z') }),
      buildAuditRecord({ createdAt: new Date('2026-07-28T10:00:02.000Z') }),
    ];

    for (const record of records) {
      retainNewestAuditSample(samples, record, 2);
    }

    expect(readNewestAuditSamples(samples, 'current_only')).toEqual([records[2], records[1]]);
    retainNewestAuditSample(samples, records[0], 0);
    expect(readNewestAuditSamples(samples, 'current_only')).toHaveLength(2);
  });
});

describe('commercial enforcement action semantics', () => {
  it('counts WARN because moderation deletes the message before sending its warning', () => {
    expect(isCommercialEnforcementAction('WARN')).toBe(true);
    expect(isCommercialEnforcementAction('DELETE')).toBe(true);
    expect(isCommercialEnforcementAction('DELETE_AND_ESCALATE')).toBe(true);
    expect(isCommercialEnforcementAction('REVIEW_ONLY')).toBe(false);
    expect(isCommercialEnforcementAction('ALLOW')).toBe(false);
    expect(isCommercialEnforcementAction(null)).toBe(false);
  });
});

describe('audit-commercial-filter scope helpers', () => {
  it('audits created and edited message events because moderation handles both', () => {
    expect(AUDIT_MESSAGE_EVENT_TYPES).toEqual(['message_created', 'message_edited']);
  });

  it('keeps the default candidate scope on chats where the filter is enabled', () => {
    expect(resolveAuditCandidateScope({ shadowAllChats: false })).toEqual({
      logLabel: 'enabled-chats',
      settingsJoin: 'inner',
      requireCommercialAdsFilterEnabled: true,
    });
  });

  it('uses a left settings join for all-chat shadow audits', () => {
    expect(resolveAuditCandidateScope({ shadowAllChats: true })).toEqual({
      logLabel: 'shadow-all-chats',
      settingsJoin: 'left',
      requireCommercialAdsFilterEnabled: false,
    });
  });

  it('uses default commercial settings when a shadow-audited chat has no settings row', () => {
    const settings = resolveAuditChatSettings(null);

    expect(settings.commercialAdsFilterEnabled).toBe(false);
    expect(settings.commercialAdsSensitivity).toBe('BALANCED');
    expect(settings.commercialAdsWarnThreshold).toBe(45);
    expect(settings.commercialAdsDeleteThreshold).toBe(65);
  });

  it('enables commercial detection only inside the shadow audit pass', () => {
    const settings = {
      commercialAdsFilterEnabled: false,
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    } as ChatSettings;

    expect(
      resolveAuditDetectionSettings(settings, { shadowAllChats: false }).commercialAdsFilterEnabled,
    ).toBe(false);
    expect(
      resolveAuditDetectionSettings(settings, { shadowAllChats: true }).commercialAdsFilterEnabled,
    ).toBe(true);
  });
});

describe('deriveSafeContextBucket', () => {
  it('does not classify commercial ads as moderation context just because they mention admins or bots', () => {
    for (const text of [
      'АДМИНИСТРАТОР на ресепшен, 74400 руб., смены, опыт приветствуется, писать в тг',
      'В нашей группе можно купить и продать все, что не запрещено законом РФ',
      'Предлагаем публикацию вашей рекламы в чате, где нет ботов, за подробностями в личные сообщения',
    ]) {
      expect(
        deriveSafeContextBucket({
          text,
          current: emptySnapshot,
          historical: emptySnapshot,
        }),
      ).not.toBe('rules_or_moderation_context');
    }
  });

  it('keeps actual ad-moderation discussions in the rules bucket', () => {
    expect(
      deriveSafeContextBucket({
        text: 'По правилам чата реклама и ссылки запрещены, бот удалит такие объявления.',
        current: emptySnapshot,
        historical: emptySnapshot,
      }),
    ).toBe('rules_or_moderation_context');
  });

  it('does not let text-only rules wording override an existing commercial hit', () => {
    expect(
      deriveSafeContextBucket({
        text: 'Объявления Казань. Тут только ссылки на группы, другие удаляем. Присоединяйся к чату.',
        current: {
          ...emptySnapshot,
          hit: true,
          actionBand: 'REVIEW_ONLY',
          primarySubtype: 'CHANNEL_PLACEMENT',
        },
        historical: emptySnapshot,
      }),
    ).not.toBe('rules_or_moderation_context');
  });
});

describe('derivePolicyCategory', () => {
  it('uses policy risk instead of a lower base risk and retains the legacy fallback', () => {
    const current = {
      ...emptySnapshot,
      hit: true,
      actionBand: 'DELETE',
      fpRisk: 0,
      policyFpRisk: 90,
    };
    expect(derivePolicyCategory({ category: 'current_only', current })).toBe(
      'false_positive_candidate',
    );
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: { ...current, policyFpRisk: undefined, fpRisk: 90 },
      }),
    ).toBe('false_positive_candidate');
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: { ...current, actionBand: 'REVIEW_ONLY' },
      }),
    ).toBe('gray_zone');
  });

  it('keeps high-fp review-only detections in the gray zone instead of negative corpus labels', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          confidenceScore: 41,
          decisionBand: 'MEDIUM',
          actionBand: 'REVIEW_ONLY',
          fpRisk: 82,
          reviewRecommended: true,
        },
      }),
    ).toBe('gray_zone');
  });

  it('still flags high-fp hard deletes as false-positive candidates', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          confidenceScore: 80,
          decisionBand: 'HIGH',
          actionBand: 'DELETE',
          fpRisk: 82,
        },
      }),
    ).toBe('false_positive_candidate');
  });

  it('does not mark campaign-assisted direct deal detections as campaign-only', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          actionBand: 'DELETE',
          evidenceStrength: 'CAMPAIGN',
          matchedSignals: [
            'transaction:implied-price',
            'contact:contextual-phone',
            'campaign:cross-chat-text',
          ],
        },
      }),
    ).toBe('hard_delete');
  });
});

describe('sanitizeAuditText', () => {
  it('masks local 10-digit phone numbers in exported audit text', () => {
    expect(sanitizeAuditText('Звонить 9132349385, цена 750 тр.')).toBe(
      'Звонить [phone], цена 750 тр.',
    );
  });

  it('masks payment-card numbers in exported audit text', () => {
    expect(sanitizeAuditText('Перевод на карту 2202 2002 0000 0001, получатель Иван.')).toBe(
      'Перевод на карту [card], получатель Иван.',
    );
    expect(sanitizeAuditText('Карта: 2202200200000001')).toBe('Карта: [card]');
    expect(sanitizeAuditText('PAN 1234567890123')).toBe('PAN [card]');
    expect(sanitizeAuditText('Счёт 12345678901234567890')).toBe('Счёт [account]');
  });
});

describe('audit export privacy', () => {
  it('refuses residual contact data before any audit or corpus output', () => {
    const text = 'Телефон +1🟢234🟢567🟢890🟢123🟢456';
    const record = buildAuditRecord({ sanitizedText: text });
    for (const output of [
      () => sanitizeAuditText(text),
      () => serializeAuditRecord(record),
      () => serializeAuditCorpusRecord(record),
      () => formatAuditSampleLines(record),
    ]) {
      expect(output).toThrow('Commercial audit text privacy is unverified');
    }
  });

  it('prints only sanitized text and pseudonymous event metadata in samples', () => {
    const record = buildAuditRecord();
    const output = formatAuditSampleLines(record).join('\n');

    expect(output).toContain(`eventFingerprint=${deriveAuditEventFingerprint(record)}`);
    expect(output).toContain('text=Сырой текст [url] [phone]');
    for (const sensitiveValue of [
      record.chatTitle,
      record.chatId,
      record.messageId,
      record.senderId,
      'https://private.example/path',
      '+7 999 123-45-67',
    ]) {
      expect(output).not.toContain(sensitiveValue);
    }
    expect(output).not.toContain('chatId=');
    expect(output).not.toContain('messageId=');
    expect(output).not.toContain('senderId=');
  });

  it('adds time and a stable fingerprint to corpus records without raw identifiers', () => {
    const record = buildAuditRecord();
    const serialized = serializeAuditCorpusRecord(record);
    const payload = JSON.stringify(serialized);

    expect(serialized).toMatchObject({
      createdAt: '2026-07-23T10:11:12.000Z',
      eventFingerprint: deriveAuditEventFingerprint(record),
      eventType: 'message_created',
      text: 'Сырой текст [url] [phone]',
      sanitizedBaseline: record.sanitizedBaseline,
    });
    expect(serialized.eventFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    for (const rawKey of ['webhookEventId', 'chatId', 'chatTitle', 'messageId', 'senderId']) {
      expect(serialized).not.toHaveProperty(rawKey);
    }
    for (const sensitiveValue of [
      record.webhookEventId,
      record.chatId,
      record.chatTitle,
      record.messageId,
      record.senderId,
    ]) {
      expect(payload).not.toContain(sensitiveValue);
    }
  });

  it('rejects a corpus record whose sanitized baseline was not computed', () => {
    expect(() =>
      serializeAuditCorpusRecord(buildAuditRecord({ sanitizedBaseline: undefined })),
    ).toThrow('Corpus export record is missing its sanitized baseline');
  });
});

describe('corpus sanitized baseline scheduling', () => {
  it('reports actual cleanup eligibility without claiming a completed deletion', () => {
    expect(
      assessCommercialExecution({
        ...emptySnapshot,
        hit: true,
        actionable: true,
        actionBand: 'WARN',
      }),
    ).toEqual({ messageDeleteEligible: true, executionVerified: false });
    expect(
      assessCommercialExecution({ ...emptySnapshot, hit: true, actionBand: 'WARN' })
        .messageDeleteEligible,
    ).toBe(false);
  });

  it('honors an explicit KEEP even when legacy band and flags allow cleanup', () => {
    const snapshot = { ...emptySnapshot, hit: true, actionable: true, actionBand: 'WARN' };
    expect(assessCommercialExecution({ ...snapshot, messageDisposition: 'KEEP' })).toEqual({
      messageDeleteEligible: false,
      executionVerified: false,
    });
    expect(
      assessCommercialExecution({ ...snapshot, messageDisposition: 'DELETE' })
        .messageDeleteEligible,
    ).toBe(true);
    expect(
      assessCommercialSanitizationParity(
        { ...snapshot, messageDisposition: 'KEEP' },
        { ...snapshot, messageDisposition: 'DELETE' },
      ),
    ).toEqual({ decisionEquivalent: false, changedFields: ['messageDisposition'] });
  });

  it('flags action changes introduced by sanitization separately from explanations', () => {
    const warn = { ...emptySnapshot, hit: true, actionable: true, actionBand: 'WARN' };
    expect(assessCommercialSanitizationParity(emptySnapshot, warn)).toEqual({
      decisionEquivalent: false,
      changedFields: ['hit', 'actionBand', 'actionable'],
    });
    expect(
      assessCommercialSanitizationParity(warn, {
        ...warn,
        matchedSignals: ['contact:contextual-phone'],
      }),
    ).toEqual({ decisionEquivalent: true, changedFields: [] });
  });

  it('does not run the sanitized detector without a requested retained corpus record', async () => {
    const detectSanitized = jest.fn(async () => emptySnapshot);
    const current = { ...emptySnapshot, hit: true };

    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: false,
        retainedForCorpus: true,
        rawText: 'raw +7 999 123-45-67',
        sanitizedText: 'raw [phone]',
        current,
        detectSanitized,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: true,
        retainedForCorpus: false,
        rawText: 'raw +7 999 123-45-67',
        sanitizedText: 'raw [phone]',
        current,
        detectSanitized,
      }),
    ).resolves.toBeUndefined();
    expect(detectSanitized).not.toHaveBeenCalled();
  });

  it('reuses an unchanged snapshot and detects only changed sanitized text', async () => {
    const sanitizedSnapshot = { ...emptySnapshot, hit: false };
    const detectSanitized = jest.fn(async () => sanitizedSnapshot);
    const current = { ...emptySnapshot, hit: true };

    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: true,
        retainedForCorpus: true,
        rawText: 'unchanged',
        sanitizedText: 'unchanged',
        current,
        detectSanitized,
      }),
    ).resolves.toBe(current);
    expect(detectSanitized).not.toHaveBeenCalled();

    await expect(
      resolveCorpusSanitizedBaseline({
        corpusExportRequested: true,
        retainedForCorpus: true,
        rawText: 'raw +7 999 123-45-67',
        sanitizedText: 'raw [phone]',
        current,
        detectSanitized,
      }),
    ).resolves.toBe(sanitizedSnapshot);
    expect(detectSanitized).toHaveBeenCalledTimes(1);
  });
});

describe('audit JSONL publication', () => {
  it('publishes complete sibling-staged files as mode 0600 and never overwrites them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-export-'));
    const outputPath = join(directory, 'nested', 'audit.jsonl');

    try {
      await publishAuditJsonlOutputs([{ pathname: outputPath, payload: '{"run":1}\n' }]);

      expect(await readFile(outputPath, 'utf8')).toBe('{"run":1}\n');
      expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(directory, 'nested'))).toEqual(['audit.jsonl']);

      await expect(
        publishAuditJsonlOutputs([{ pathname: outputPath, payload: '{"run":2}\n' }]),
      ).rejects.toThrow('Refusing to overwrite existing audit export');
      expect(await readFile(outputPath, 'utf8')).toBe('{"run":1}\n');
      expect(await readdir(join(directory, 'nested'))).toEqual(['audit.jsonl']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back the first output when no-clobber publication of the second fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-export-pair-'));
    const auditPath = join(directory, 'audit.jsonl');
    const corpusPath = join(directory, 'corpus.jsonl');

    try {
      await writeFile(corpusPath, 'existing corpus\n', { mode: 0o600 });

      await expect(
        publishAuditJsonlOutputs([
          { pathname: auditPath, payload: 'new audit\n' },
          { pathname: corpusPath, payload: 'new corpus\n' },
        ]),
      ).rejects.toThrow('Refusing to overwrite existing audit export');
      await expect(access(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(corpusPath, 'utf8')).toBe('existing corpus\n');
      expect((await readdir(directory)).sort()).toEqual(['corpus.jsonl']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('streamed audit JSONL publication', () => {
  it('fails before staging when a final output already exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-existing-'));
    const outputPath = join(directory, 'audit.jsonl');

    try {
      await writeFile(outputPath, 'existing\n', { mode: 0o600 });
      await expect(
        openAuditJsonlOutputStreams([passthroughStreamTarget(outputPath)]),
      ).rejects.toThrow('Refusing to overwrite existing audit export');
      expect(await readFile(outputPath, 'utf8')).toBe('existing\n');
      expect(await readdir(directory)).toEqual(['audit.jsonl']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('streams paired records to mode 0600 outputs and publishes only on success', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-'));
    const auditPath = join(directory, 'nested', 'audit.jsonl');
    const corpusPath = join(directory, 'nested', 'corpus.jsonl');

    try {
      const writer = await openAuditJsonlOutputStreams([
        {
          pathname: auditPath,
          serialize: (value: { sequence: number }) => ({ sequence: value.sequence }),
        },
        {
          pathname: corpusPath,
          serialize: (value: { sequence: number }) => ({ corpusSequence: value.sequence }),
        },
      ]);
      await writer.append({ sequence: 1 });
      await writer.append({ sequence: 2 });

      await expect(access(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(corpusPath)).rejects.toMatchObject({ code: 'ENOENT' });

      await writer.publish();

      expect(await readFile(auditPath, 'utf8')).toBe('{"sequence":1}\n{"sequence":2}\n');
      expect(await readFile(corpusPath, 'utf8')).toBe(
        '{"corpusSequence":1}\n{"corpusSequence":2}\n',
      );
      expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
      expect((await stat(corpusPath)).mode & 0o777).toBe(0o600);
      expect((await readdir(join(directory, 'nested'))).sort()).toEqual([
        'audit.jsonl',
        'corpus.jsonl',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('snapshots each pathname and serializer binding before asynchronous setup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-snapshot-'));
    const outputPath = join(directory, 'audit.jsonl');
    const targets: AuditJsonlStreamTarget<{ sequence: number }>[] = [
      {
        pathname: outputPath,
        serialize: (value: { sequence: number }) => ({ original: value.sequence }),
      },
    ];

    try {
      const opening = openAuditJsonlOutputStreams(targets);
      targets[0] = {
        pathname: join(directory, 'mutated.jsonl'),
        serialize: (value) => ({ mutated: value.sequence }),
      };
      const writer = await opening;
      await writer.append({ sequence: 1 });
      await writer.publish();

      expect(await readFile(outputPath, 'utf8')).toBe('{"original":1}\n');
      await expect(access(targets[0].pathname)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('removes staged data when a streamed audit is aborted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-abort-'));
    const outputPath = join(directory, 'audit.jsonl');

    try {
      const writer = await openAuditJsonlOutputStreams([passthroughStreamTarget(outputPath)]);
      await writer.append({ incomplete: true });
      await writer.abort();

      await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('cleans up immediately and prevents publication after serialization fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-error-'));
    const outputPath = join(directory, 'audit.jsonl');

    try {
      const writer = await openAuditJsonlOutputStreams([passthroughStreamTarget(outputPath)]);
      await expect(writer.append({ unsupported: 1n })).rejects.toThrow();
      await expect(writer.publish()).rejects.toThrow('Audit JSONL stream is not open');

      await expect(access(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('appends records after flushing the bounded stream buffer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-flush-'));
    const outputPath = join(directory, 'audit.jsonl');
    const largeValue = 'x'.repeat(1024 * 1024);

    try {
      const writer = await openAuditJsonlOutputStreams([passthroughStreamTarget(outputPath)]);
      await writer.append({ largeValue });
      await writer.append({ afterFlush: true });
      await writer.publish();

      const lines = (await readFile(outputPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual({ largeValue });
      expect(JSON.parse(lines[1])).toEqual({ afterFlush: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rolls back a paired publication if the second final output already exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-collision-'));
    const auditPath = join(directory, 'audit.jsonl');
    const corpusPath = join(directory, 'corpus.jsonl');

    try {
      const writer = await openAuditJsonlOutputStreams([
        {
          pathname: auditPath,
          serialize: (value: { audit: string; corpus: string }) => ({ audit: value.audit }),
        },
        {
          pathname: corpusPath,
          serialize: (value: { audit: string; corpus: string }) => ({ corpus: value.corpus }),
        },
      ]);
      await writer.append({ audit: 'new', corpus: 'new' });
      await writeFile(corpusPath, 'existing corpus\n', { mode: 0o600 });

      await expect(writer.publish()).rejects.toThrow('Refusing to overwrite existing audit export');
      await expect(access(auditPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(corpusPath, 'utf8')).toBe('existing corpus\n');
      expect(await readdir(directory)).toEqual(['corpus.jsonl']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves the existing one-newline empty-export serialization', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'commercial-audit-stream-empty-'));
    const outputPath = join(directory, 'audit.jsonl');

    try {
      const writer = await openAuditJsonlOutputStreams([passthroughStreamTarget(outputPath)]);
      await writer.publish();
      expect(await readFile(outputPath, 'utf8')).toBe('\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
