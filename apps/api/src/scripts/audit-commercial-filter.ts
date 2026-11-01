import { chatSettingsSchema, type MaxUpdate } from '@maxim/contracts';
import {
  buildAuditScanWindowSql,
  resolveCommercialAuditPrismaPoolConfig,
  type AuditCandidateCursor,
} from './commercial-audit-scan-window';
export {
  buildAuditCandidateCursorSql,
  buildAuditScanWindowSql,
  resolveCommercialAuditPrismaPoolConfig,
  type AuditCandidateCursor,
} from './commercial-audit-scan-window';
import {
  createPrismaClient,
  Prisma,
  PrismaClient,
  type ChatSettings,
} from '../prisma/prisma-client';
import { config as loadEnv } from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { access, link, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  InMemoryCommercialCampaignTracker,
  type CommercialCampaignContext,
} from '../moderation/commercial-campaign.util';
import {
  deriveCommercialSafeContextBucket,
  type CommercialSafeContextBucket,
} from '../moderation/commercial/commercial-safe-context';
import { COMMERCIAL_HARD_NEGATIVE_REASON_PREFIXES } from '../moderation/commercial/commercial-suppressors';
import { RuleEngineService, type RuleViolation } from '../moderation/rule-engine.service';
import {
  withCommercialAuditRunLock,
  type CommercialAuditRunLock,
} from './commercial-audit-run-lock.util';
import {
  isCommercialCorpusTextSanitized,
  sanitizeCommercialCorpusText,
} from './commercial-corpus-sanitization.util';
import {
  isCommercialMessageDeleteEligible,
  resolveCommercialMessageDisposition,
  type CommercialMessageDisposition,
} from '../moderation/commercial';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LIMIT = 1500;
const DEFAULT_SAMPLE = 6;
const PROGRESS_EVERY = 250;
const MAX_CAMPAIGN_WARMUP_HOURS = 7 * 24;
const MAX_AUDIT_PAGE_SIZE = 5_000;
const AUDIT_STREAM_BUFFER_BYTES = 1024 * 1024;

export const AUDIT_MESSAGE_EVENT_TYPES = ['message_created', 'message_edited'] as const;

loadEnv({ quiet: true });
loadEnv({ path: resolve(__dirname, '../../../../.env'), override: false, quiet: true });

type CliOptions = {
  since: Date;
  until: Date;
  limit: number | null;
  pageSize?: number;
  sample: number;
  chatId?: string;
  exportJsonlPath?: string;
  exportCorpusJsonlPath?: string;
  includeStableHits: boolean;
  exportAllCorpus: boolean;
  shadowAllChats: boolean;
  campaignWarmupHours: number;
  currentOnly: boolean;
};

type AuditCandidateScope = {
  logLabel: 'enabled-chats' | 'shadow-all-chats';
  settingsJoin: 'inner' | 'left';
  requireCommercialAdsFilterEnabled: boolean;
};

export type AuditCandidateRow = {
  webhookEventId: string;
  eventType: string;
  createdAt: Date;
  botId: string | null;
  chatId: string;
  chatTitle: string | null;
  chatEntityType: string | null;
  messageId: string;
  senderId: string | null;
  text: string;
  normalizedPayload: Prisma.JsonValue;
  historicalEventId: string | null;
  historicalScore: number | null;
  historicalMetadata: Prisma.JsonValue | null;
  hasHistoricalCommercialEvent: boolean;
};

type ChatContext = {
  settings: ChatSettings;
  domainAllowlist: string[];
  adminUserIds: Set<string>;
  botIdVariants: Set<string>;
};

const DEFAULT_AUDIT_CHAT_SETTINGS = chatSettingsSchema.parse({}) as unknown as ChatSettings;

type AuditSkipReason =
  | 'missing-chat-context'
  | 'missing-sender'
  | 'membership'
  | 'service-authored'
  | 'bot-authored'
  | 'own-bot'
  | 'local-admin';

export type AuditCategory = 'stable_hit' | 'historical_only' | 'current_only' | 'stable_clear';
type AuditPolicyCategory =
  | 'hard_delete'
  | 'gray_zone'
  | 'campaign_only'
  | 'false_positive_candidate'
  | 'false_negative_candidate'
  | 'none';

type AuditSegment =
  | 'CHANNEL_PLACEMENT'
  | 'PROPERTY'
  | 'RECRUITMENT'
  | 'INFO_PRODUCT'
  | 'GOODS'
  | 'SERVICES'
  | 'OTHER';

type AuditSafeContextBucket = CommercialSafeContextBucket;

type AuditCorpusLabel =
  | 'positive_candidate'
  | 'negative_candidate'
  | 'gray_candidate'
  | 'unlabeled';

type AuditCorpusLabelSource = 'commercial-audit-policy-v1' | null;

type AuditCorpusSettings = Pick<
  ChatSettings,
  'commercialAdsSensitivity' | 'commercialAdsWarnThreshold' | 'commercialAdsDeleteThreshold'
>;

export type CommercialSnapshot = {
  hit: boolean;
  score: number | null;
  actionScore: number | null;
  confidenceScore: number | null;
  decisionBand: string | null;
  primarySubtype: string | null;
  supportingSubtypes: string[];
  evidenceStrength: string | null;
  classifierVersion: string | null;
  commercialProbability: number | null;
  reviewProbability: number | null;
  classifierReasons: string[];
  reviewRecommended: boolean;
  reviewReasons: string[];
  matchedSignals: string[];
  negativeSignals: string[];
  decisionVersion: string | null;
  fpRisk: number | null;
  policyFpRisk?: number | null;
  evidenceTier: string | null;
  subtype: string | null;
  actionBand: string | null;
  messageDisposition?: CommercialMessageDisposition;
  reviewPriority: string | null;
  campaignStrength: string | null;
  safeContextBucket: string | null;
  actionable: boolean;
  recordable: boolean;
  deleteSuppressed: boolean;
  suppressionReasons: string[];
  reasonCodes: string[];
  featureVector: Record<string, number>;
};

export type AuditRecord = {
  category: AuditCategory;
  policyCategory: AuditPolicyCategory;
  segment: AuditSegment;
  safeContextBucket: AuditSafeContextBucket;
  label: AuditCorpusLabel;
  labelSource: AuditCorpusLabelSource;
  expectedAction: string | null;
  expectedSubtype: string | null;
  isHardNegative: boolean;
  createdAt: Date;
  webhookEventId: string;
  eventType: string;
  chatId: string;
  chatTitle: string | null;
  chatEntityType: string | null;
  messageId: string;
  senderId: string | null;
  text: string;
  sanitizedText: string;
  historical: CommercialSnapshot;
  current: CommercialSnapshot;
  sanitizedBaseline?: CommercialSnapshot;
  settings: AuditCorpusSettings;
  commercialCampaignContext: CommercialCampaignContext | null;
};

const NOOP_REDIS_COUNTER = {
  async incrementWithTtl(): Promise<number> {
    return 0;
  },
} as const;

const CHANNEL_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])канал(?:ы|а|у|е|ом|ов|ам|ами|ах)?(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:трафик|перелив|вп|max-tracker|er(?:24|48|72)|1\s*\/\s*(?:24|48|72))(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:места\s+на\s+завтра|цена\s+за\s+пост|активная\s+аудитория)(?=$|[^\p{L}\p{N}_-])/iu,
] as const;

const PROPERTY_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:квартир|студи|дом|участ|ижс|днт|снт|жк|этаж|ипотек|обремен|дкп)(?=[\p{L}\p{N}_-]|$)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:комисси|ключах|показ(?:\s|$)|евро\s*\d+\s*к|\d+\s*к\.?\s*кв\.?)(?=[\p{L}\p{N}_-]|$)/iu,
] as const;

const RECRUITMENT_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:ваканси|работ|подработ|смен|вахт|требу(?:ется|ются)?)(?=[\p{L}\p{N}_-]|$)/iu,
] as const;

const INFO_PRODUCT_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:курс|вебинар|марафон|обучен|наставнич|разбор|созвон|урок)(?=[\p{L}\p{N}_-]|$)/iu,
] as const;

export function readCliOptions(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const now = new Date();
  const since =
    readDateOption(args, '--since') ??
    new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const until = readDateOption(args, '--until') ?? now;
  const parsedLimit = readLimitOption(args, '--limit');
  const limit = parsedLimit === undefined ? DEFAULT_LIMIT : parsedLimit;
  const pageSize = readNonNegativeIntOption(args, '--page-size');
  const sample = readNonNegativeIntOption(args, '--sample') ?? DEFAULT_SAMPLE;
  const chatId = readStringOption(args, '--chat-id');
  const rawExportJsonlPath = readStringOption(args, '--export-jsonl');
  const rawExportCorpusJsonlPath = readStringOption(args, '--export-corpus-jsonl');
  const exportJsonlPath = rawExportJsonlPath ? resolve(rawExportJsonlPath) : undefined;
  const exportCorpusJsonlPath = rawExportCorpusJsonlPath
    ? resolve(rawExportCorpusJsonlPath)
    : undefined;
  const includeStableHits = args.includes('--include-stable-hits');
  const exportAllCorpus = args.includes('--export-all-corpus');
  const shadowAllChats = args.includes('--shadow-all-chats');
  const campaignWarmupHours = readNonNegativeIntOption(args, '--campaign-warmup-hours') ?? 0;
  const currentOnly = args.includes('--current-only');

  if (since.getTime() > until.getTime()) {
    throw new Error('--since must be earlier than or equal to --until');
  }
  if (campaignWarmupHours > MAX_CAMPAIGN_WARMUP_HOURS) {
    throw new Error(
      `--campaign-warmup-hours must be less than or equal to ${MAX_CAMPAIGN_WARMUP_HOURS}`,
    );
  }
  if (campaignWarmupHours > 0 && limit !== null) {
    throw new Error('--campaign-warmup-hours requires --limit all');
  }
  if (pageSize !== undefined && (pageSize <= 0 || pageSize > MAX_AUDIT_PAGE_SIZE)) {
    throw new Error(`--page-size must be an integer between 1 and ${MAX_AUDIT_PAGE_SIZE}`);
  }
  if (pageSize !== undefined && limit !== null) {
    throw new Error('--page-size requires --limit all');
  }
  if (limit === null && pageSize === undefined) {
    throw new Error('--limit all requires --page-size <1..5000>');
  }
  if (exportJsonlPath && exportCorpusJsonlPath && exportJsonlPath === exportCorpusJsonlPath) {
    throw new Error('--export-jsonl and --export-corpus-jsonl must resolve to different paths');
  }

  return {
    since,
    until,
    limit,
    ...(pageSize !== undefined ? { pageSize } : {}),
    sample,
    ...(chatId ? { chatId } : {}),
    ...(exportJsonlPath ? { exportJsonlPath } : {}),
    ...(exportCorpusJsonlPath ? { exportCorpusJsonlPath } : {}),
    includeStableHits,
    exportAllCorpus,
    shadowAllChats,
    campaignWarmupHours,
    currentOnly,
  };
}

export function resolveAuditLoadSince(
  options: Pick<CliOptions, 'since' | 'campaignWarmupHours'>,
): Date {
  return new Date(options.since.getTime() - options.campaignWarmupHours * 60 * 60 * 1000);
}

export function resolveAuditCandidateScope(
  options: Pick<CliOptions, 'shadowAllChats'>,
): AuditCandidateScope {
  return options.shadowAllChats
    ? {
        logLabel: 'shadow-all-chats',
        settingsJoin: 'left',
        requireCommercialAdsFilterEnabled: false,
      }
    : {
        logLabel: 'enabled-chats',
        settingsJoin: 'inner',
        requireCommercialAdsFilterEnabled: true,
      };
}

export function resolveAuditChatSettings(settings: ChatSettings | null | undefined): ChatSettings {
  return settings ?? DEFAULT_AUDIT_CHAT_SETTINGS;
}

export function resolveAuditDetectionSettings(
  settings: ChatSettings,
  options: Pick<CliOptions, 'shadowAllChats'>,
): ChatSettings {
  return options.shadowAllChats ? { ...settings, commercialAdsFilterEnabled: true } : settings;
}

function readDateOption(args: readonly string[], name: string): Date | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO-8601 date`);
  }

  return parsed;
}

function readNonNegativeIntOption(args: readonly string[], name: string): number | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = parsePositiveInteger(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function readLimitOption(args: readonly string[], name: string): number | null | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  if (value.toLowerCase() === 'all') {
    return null;
  }

  const parsed = parsePositiveInteger(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer or "all"`);
  }

  return parsed;
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    return Number.NaN;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function readStringOption(args: readonly string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }

    return value.trim() || undefined;
  }

  const inlinePrefix = `${name}=`;
  const inlineValue = args.find((arg) => arg.startsWith(inlinePrefix));
  if (!inlineValue) {
    return undefined;
  }

  const value = inlineValue.slice(inlinePrefix.length);
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value.trim() || undefined;
}

export function compareAuditCandidateKeys(
  left: AuditCandidateCursor,
  right: AuditCandidateCursor,
): number {
  const timeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDifference !== 0) {
    return timeDifference;
  }
  if (left.webhookEventId === right.webhookEventId) {
    return 0;
  }
  return left.webhookEventId < right.webhookEventId ? -1 : 1;
}

export function resolveNextAuditCandidateCursor(
  rows: readonly AuditCandidateCursor[],
): AuditCandidateCursor | null {
  const last = rows.at(-1);
  return last
    ? {
        createdAt: new Date(last.createdAt.getTime()),
        webhookEventId: last.webhookEventId,
      }
    : null;
}

type AuditCandidatePageOptions = {
  pageSize: number;
  cursor?: AuditCandidateCursor;
};

type AuditCandidatePage = {
  candidates: AuditCandidateRow[];
  cursor: AuditCandidateCursor;
  scannedCount: number;
};

type AuditCandidatePageQueryRow = {
  scannedCount: number;
  scanCursorCreatedAt: Date | null;
  scanCursorWebhookEventId: string | null;
  webhookEventId: string | null;
  eventType: string | null;
  createdAt: Date | null;
  botId: string | null;
  chatId: string | null;
  chatTitle: string | null;
  chatEntityType: string | null;
  messageId: string | null;
  senderId: string | null;
  text: string | null;
  normalizedPayload: Prisma.JsonValue | null;
  historicalEventId: string | null;
  historicalScore: number | null;
  historicalMetadata: Prisma.JsonValue | null;
  hasHistoricalCommercialEvent: boolean;
};

function buildAuditCandidateQueryParts(options: CliOptions) {
  const scope = resolveAuditCandidateScope(options);
  return {
    loadSince: resolveAuditLoadSince(options),
    chatFilterSql: options.chatId ? Prisma.sql`and c.id = ${options.chatId}` : Prisma.sql``,
    settingsJoinSql:
      scope.settingsJoin === 'left'
        ? Prisma.sql`left join chat_settings s on s.chat_id = c.id`
        : Prisma.sql`join chat_settings s on s.chat_id = c.id`,
    commercialFilterSql: scope.requireCommercialAdsFilterEnabled
      ? Prisma.sql`and s.commercial_ads_filter_enabled = true`
      : Prisma.sql``,
    messageEventTypesSql: Prisma.join([...AUDIT_MESSAGE_EVENT_TYPES]),
  };
}

function buildHistoricalCandidateQueryParts(options: Pick<CliOptions, 'currentOnly'>) {
  return {
    historicalColumnsSql: options.currentOnly
      ? Prisma.sql`
          null::text as "historicalEventId",
          null::double precision as "historicalScore",
          null::jsonb as "historicalMetadata",
          false as "hasHistoricalCommercialEvent"
        `
      : Prisma.sql`
          historical.id as "historicalEventId",
          historical.score as "historicalScore",
          historical.metadata as "historicalMetadata",
          (historical.id is not null) as "hasHistoricalCommercialEvent"
        `,
    historicalJoinSql: options.currentOnly
      ? Prisma.sql``
      : Prisma.sql`
          left join lateral (
            select
              e.id,
              e.score,
              e.metadata
            from moderation_events e
            where e.chat_id = base."chatId"
              and e.message_id = base."messageId"
              and e.rule_code = 'COMMERCIAL_AD'
            order by e.created_at asc, e.id asc
            limit 1
          ) historical on true
        `,
  };
}

async function loadCandidates(
  prisma: PrismaClient,
  options: CliOptions,
): Promise<AuditCandidateRow[]> {
  const { loadSince, chatFilterSql, settingsJoinSql, commercialFilterSql, messageEventTypesSql } =
    buildAuditCandidateQueryParts(options);
  const limitSql = options.limit === null ? Prisma.sql`` : Prisma.sql`limit ${options.limit}`;
  const resultOrderSql = Prisma.sql`order by base."createdAt" asc, base."webhookEventId" asc`;
  const { historicalColumnsSql, historicalJoinSql } = buildHistoricalCandidateQueryParts(options);

  return prisma.$queryRaw<AuditCandidateRow[]>(Prisma.sql`
    with base as (
      select
        w.id as "webhookEventId",
        w.normalized_payload ->> 'type' as "eventType",
        w.created_at as "createdAt",
        w.bot_id as "botId",
        c.id as "chatId",
        c.title as "chatTitle",
        c.entity_type::text as "chatEntityType",
        w.normalized_payload #>> '{message,messageId}' as "messageId",
        nullif(w.normalized_payload #>> '{message,senderId}', '') as "senderId",
        w.normalized_payload #>> '{message,text}' as "text",
        w.normalized_payload as "normalizedPayload"
      from webhook_events w
      join chats c
        on c.id = w.normalized_payload #>> '{message,chatId}'
      ${settingsJoinSql}
      where w.created_at >= ${loadSince}
        and w.created_at <= ${options.until}
        and w.status = 'PROCESSED'
        and w.normalized_payload ->> 'type' in (${messageEventTypesSql})
        and coalesce(w.normalized_payload #>> '{message,text}', '') <> ''
        and coalesce(w.normalized_payload #>> '{message,messageId}', '') <> ''
        ${commercialFilterSql}
        ${chatFilterSql}
      order by w.created_at desc, w.id desc
      ${limitSql}
    )
    select
      base.*,
      ${historicalColumnsSql}
    from base
    ${historicalJoinSql}
    ${resultOrderSql}
  `);
}

function mapAuditCandidatePageRow(row: AuditCandidatePageQueryRow): AuditCandidateRow | null {
  if (row.webhookEventId === null) {
    return null;
  }
  if (
    typeof row.eventType !== 'string' ||
    !(row.createdAt instanceof Date) ||
    typeof row.chatId !== 'string' ||
    typeof row.messageId !== 'string' ||
    typeof row.text !== 'string' ||
    row.normalizedPayload === null ||
    typeof row.hasHistoricalCommercialEvent !== 'boolean'
  ) {
    throw new Error('Commercial audit candidate page returned an invalid candidate row');
  }

  return {
    webhookEventId: row.webhookEventId,
    eventType: row.eventType,
    createdAt: row.createdAt,
    botId: row.botId,
    chatId: row.chatId,
    chatTitle: row.chatTitle,
    chatEntityType: row.chatEntityType,
    messageId: row.messageId,
    senderId: row.senderId,
    text: row.text,
    normalizedPayload: row.normalizedPayload,
    historicalEventId: row.historicalEventId,
    historicalScore: row.historicalScore,
    historicalMetadata: row.historicalMetadata,
    hasHistoricalCommercialEvent: row.hasHistoricalCommercialEvent,
  };
}

export function parseAuditCandidatePageRows(
  rows: readonly AuditCandidatePageQueryRow[],
): AuditCandidatePage | null {
  const summary = rows[0];
  if (!summary || !Number.isInteger(summary.scannedCount) || summary.scannedCount < 0) {
    throw new Error('Commercial audit scan page returned an invalid summary');
  }
  if (summary.scannedCount === 0) {
    if (summary.scanCursorCreatedAt !== null || summary.scanCursorWebhookEventId !== null) {
      throw new Error('Commercial audit empty scan page returned a cursor');
    }
    return null;
  }
  if (
    !(summary.scanCursorCreatedAt instanceof Date) ||
    typeof summary.scanCursorWebhookEventId !== 'string'
  ) {
    throw new Error('Commercial audit non-empty scan page returned no cursor');
  }

  return {
    scannedCount: summary.scannedCount,
    cursor: {
      createdAt: summary.scanCursorCreatedAt,
      webhookEventId: summary.scanCursorWebhookEventId,
    },
    candidates: rows
      .map(mapAuditCandidatePageRow)
      .filter((row): row is AuditCandidateRow => row !== null),
  };
}

export function buildAuditCandidatePageSql(
  options: CliOptions,
  page: AuditCandidatePageOptions,
): Prisma.Sql {
  const { loadSince, chatFilterSql, settingsJoinSql, commercialFilterSql, messageEventTypesSql } =
    buildAuditCandidateQueryParts(options);
  const { historicalColumnsSql, historicalJoinSql } = buildHistoricalCandidateQueryParts(options);
  const scanWindowSql = buildAuditScanWindowSql({
    loadSince,
    until: options.until,
    pageSize: page.pageSize,
    ...(page.cursor ? { cursor: page.cursor } : {}),
  });

  return Prisma.sql`
    with scan_page as materialized (
      ${scanWindowSql}
    ),
    scan_summary as (
      select
        count(*)::integer as "scannedCount",
        (
          select w.created_at
          from scan_page w
          order by w.created_at desc, w.id desc
          limit 1
        ) as "scanCursorCreatedAt",
        (
          select w.id
          from scan_page w
          order by w.created_at desc, w.id desc
          limit 1
        ) as "scanCursorWebhookEventId"
      from scan_page
    ),
    base as (
      select
        w.id as "webhookEventId",
        w.normalized_payload ->> 'type' as "eventType",
        w.created_at as "createdAt",
        w.bot_id as "botId",
        c.id as "chatId",
        c.title as "chatTitle",
        c.entity_type::text as "chatEntityType",
        w.normalized_payload #>> '{message,messageId}' as "messageId",
        nullif(w.normalized_payload #>> '{message,senderId}', '') as "senderId",
        w.normalized_payload #>> '{message,text}' as "text",
        w.normalized_payload as "normalizedPayload"
      from scan_page w
      join chats c
        on c.id = w.normalized_payload #>> '{message,chatId}'
      ${settingsJoinSql}
      where w.normalized_payload ->> 'type' in (${messageEventTypesSql})
        and coalesce(w.normalized_payload #>> '{message,text}', '') <> ''
        and coalesce(w.normalized_payload #>> '{message,messageId}', '') <> ''
        ${commercialFilterSql}
        ${chatFilterSql}
    )
    select
      scan_summary.*,
      base.*,
      ${historicalColumnsSql}
    from scan_summary
    left join base on true
    ${historicalJoinSql}
    order by base."createdAt" asc nulls last, base."webhookEventId" asc nulls last
  `;
}

async function loadCandidatePage(
  prisma: PrismaClient,
  options: CliOptions,
  page: AuditCandidatePageOptions,
): Promise<AuditCandidatePage | null> {
  const rows = await prisma.$queryRaw<AuditCandidatePageQueryRow[]>(
    buildAuditCandidatePageSql(options, page),
  );

  return parseAuditCandidatePageRows(rows);
}

async function loadChatContexts(
  prisma: PrismaClient,
  chatIds: readonly string[],
  activeAt: Date,
): Promise<Map<string, ChatContext>> {
  if (chatIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.chat.findMany({
    where: {
      id: {
        in: [...chatIds],
      },
    },
    include: {
      settings: true,
      domains: {
        where: {
          OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: activeAt } }],
        },
        select: {
          domain: true,
        },
      },
      admins: {
        select: {
          userId: true,
        },
      },
      botMemberships: {
        select: {
          botId: true,
        },
      },
    },
  });

  return new Map(
    rows.map((row) => {
      const botIdVariants = new Set<string>();
      for (const botId of [
        row.botId,
        row.primaryBotId,
        ...row.botMemberships.map((item) => item.botId),
      ]) {
        for (const variant of buildIdVariants(botId)) {
          botIdVariants.add(variant);
        }
      }

      return [
        row.id,
        {
          settings: resolveAuditChatSettings(row.settings),
          domainAllowlist: row.domains.map((item) => item.domain),
          adminUserIds: new Set(
            row.admins.map((item) => item.userId.trim()).filter((item) => item.length > 0),
          ),
          botIdVariants,
        },
      ] satisfies [string, ChatContext];
    }),
  );
}

async function ensureChatContexts(
  prisma: PrismaClient,
  cache: Map<string, ChatContext | null>,
  candidates: readonly Pick<AuditCandidateRow, 'chatId'>[],
  activeAt: Date,
): Promise<void> {
  const missingChatIds = Array.from(
    new Set(candidates.map((candidate) => candidate.chatId).filter((chatId) => !cache.has(chatId))),
  );
  if (missingChatIds.length === 0) {
    return;
  }

  const loaded = await loadChatContexts(prisma, missingChatIds, activeAt);
  for (const chatId of missingChatIds) {
    cache.set(chatId, loaded.get(chatId) ?? null);
  }
}

function buildIdVariants(value: string | null | undefined): Set<string> {
  if (typeof value !== 'string') {
    return new Set<string>();
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return new Set<string>();
  }

  const variants = new Set<string>([normalized]);

  if (normalized.startsWith('id') && normalized.length > 2) {
    variants.add(normalized.slice(2));
  }

  if (normalized.endsWith('_bot') && normalized.length > 4) {
    variants.add(normalized.slice(0, -4));
  }

  if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
    variants.add(normalized.slice(2, -4));
  }

  for (const variant of [...variants]) {
    const primary = variant.split('_')[0];
    if (/^\d+$/u.test(primary)) {
      variants.add(primary);
      variants.add(`id${primary}`);
      variants.add(`${primary}_bot`);
      variants.add(`id${primary}_bot`);
    }
  }

  return variants;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readLowerString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function extractSenderEntities(update: MaxUpdate): Array<Record<string, unknown>> {
  const raw = asRecord(update.raw);
  const message = asRecord(raw?.message);

  return [
    asRecord(message?.sender),
    asRecord(message?.from),
    asRecord(raw?.sender),
    asRecord(raw?.from),
  ].filter((item): item is Record<string, unknown> => item !== null);
}

function isBotEntity(node: Record<string, unknown>): boolean {
  const type = readLowerString(node.type) ?? readLowerString(node.kind);
  if (type === 'bot') {
    return true;
  }

  return node.is_bot === true || node.isBot === true || node.bot === true;
}

function isServiceEntity(node: Record<string, unknown>): boolean {
  const type = readLowerString(node.type) ?? readLowerString(node.kind);
  if (type === 'service') {
    return true;
  }

  return node.is_service === true || node.isService === true;
}

function resolveSkipReason(
  row: AuditCandidateRow,
  update: MaxUpdate,
  chatContext: ChatContext | undefined,
): AuditSkipReason | null {
  if (!chatContext) {
    return 'missing-chat-context';
  }

  const senderId = (update.message?.senderId ?? row.senderId ?? '').trim();
  if (!senderId) {
    return 'missing-sender';
  }

  if (update.membership) {
    return 'membership';
  }

  for (const entity of extractSenderEntities(update)) {
    if (isServiceEntity(entity)) {
      return 'service-authored';
    }
    if (isBotEntity(entity)) {
      return 'bot-authored';
    }
  }

  const senderVariants = buildIdVariants(senderId);
  if (
    senderVariants.has(senderId.toLowerCase().trim()) &&
    senderId.toLowerCase().trim().endsWith('_bot')
  ) {
    return 'own-bot';
  }

  for (const variant of senderVariants) {
    if (chatContext.botIdVariants.has(variant)) {
      return 'own-bot';
    }
  }

  if (chatContext.adminUserIds.has(senderId)) {
    return 'local-admin';
  }

  return null;
}

function extractCommercialViolation(violations: readonly RuleViolation[]): RuleViolation | null {
  return violations.find((item) => item.ruleCode === 'COMMERCIAL_AD') ?? null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOptionalBoolean(value: unknown): boolean {
  return value === true;
}

function snapshotFromViolation(violation: RuleViolation | null): CommercialSnapshot {
  if (!violation) {
    return {
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
      policyFpRisk: null,
      evidenceTier: null,
      subtype: null,
      actionBand: null,
      messageDisposition: 'KEEP',
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
  }

  const metadata = asRecord(violation.metadata);
  return {
    hit: true,
    score: Number.isFinite(violation.score) ? violation.score : null,
    actionScore: readOptionalNumber(metadata?.actionScore),
    confidenceScore: readOptionalNumber(metadata?.confidenceScore),
    decisionBand: readOptionalString(metadata?.decisionBand),
    primarySubtype: readOptionalString(metadata?.primarySubtype),
    supportingSubtypes: readStringArray(metadata?.supportingSubtypes),
    evidenceStrength: readOptionalString(metadata?.evidenceStrength),
    classifierVersion: readOptionalString(metadata?.classifierVersion),
    commercialProbability: readOptionalNumber(metadata?.commercialProbability),
    reviewProbability: readOptionalNumber(metadata?.reviewProbability),
    classifierReasons: readStringArray(metadata?.classifierReasons),
    reviewRecommended: readOptionalBoolean(metadata?.reviewRecommended),
    reviewReasons: readStringArray(metadata?.reviewReasons),
    matchedSignals: readStringArray(metadata?.matchedSignals),
    negativeSignals: readStringArray(metadata?.negativeSignals),
    decisionVersion: readOptionalString(metadata?.decisionVersion),
    fpRisk: readOptionalNumber(metadata?.fpRisk),
    policyFpRisk:
      readOptionalNumber(metadata?.policyFpRisk) ?? readOptionalNumber(metadata?.fpRisk),
    evidenceTier: readOptionalString(metadata?.evidenceTier),
    subtype: readOptionalString(metadata?.subtype),
    actionBand: readOptionalString(metadata?.actionBand),
    messageDisposition: resolveCommercialMessageDisposition(
      readOptionalString(metadata?.actionBand),
      readOptionalBoolean(metadata?.actionable),
      metadata?.messageDisposition,
    ),
    reviewPriority: readOptionalString(metadata?.reviewPriority),
    campaignStrength: readOptionalString(metadata?.campaignStrength),
    safeContextBucket: readOptionalString(metadata?.safeContextBucket),
    actionable: readOptionalBoolean(metadata?.actionable),
    recordable: readOptionalBoolean(metadata?.recordable),
    deleteSuppressed: readOptionalBoolean(metadata?.deleteSuppressed),
    suppressionReasons: readStringArray(metadata?.suppressionReasons),
    reasonCodes: readStringArray(metadata?.reasonCodes),
    featureVector: readNumericRecord(metadata?.featureVector),
  };
}

function snapshotFromHistorical(
  hasHistoricalCommercialEvent: boolean,
  score: number | null,
  metadata: Prisma.JsonValue | null,
): CommercialSnapshot {
  const normalizedMetadata = asRecord(metadata);
  return {
    hit: hasHistoricalCommercialEvent,
    score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    actionScore: readOptionalNumber(normalizedMetadata?.actionScore),
    confidenceScore: readOptionalNumber(normalizedMetadata?.confidenceScore),
    decisionBand: readOptionalString(normalizedMetadata?.decisionBand),
    primarySubtype: readOptionalString(normalizedMetadata?.primarySubtype),
    supportingSubtypes: readStringArray(normalizedMetadata?.supportingSubtypes),
    evidenceStrength: readOptionalString(normalizedMetadata?.evidenceStrength),
    classifierVersion: readOptionalString(normalizedMetadata?.classifierVersion),
    commercialProbability: readOptionalNumber(normalizedMetadata?.commercialProbability),
    reviewProbability: readOptionalNumber(normalizedMetadata?.reviewProbability),
    classifierReasons: readStringArray(normalizedMetadata?.classifierReasons),
    reviewRecommended: readOptionalBoolean(normalizedMetadata?.reviewRecommended),
    reviewReasons: readStringArray(normalizedMetadata?.reviewReasons),
    matchedSignals: readStringArray(normalizedMetadata?.matchedSignals),
    negativeSignals: readStringArray(normalizedMetadata?.negativeSignals),
    decisionVersion: readOptionalString(normalizedMetadata?.decisionVersion),
    fpRisk: readOptionalNumber(normalizedMetadata?.fpRisk),
    policyFpRisk:
      readOptionalNumber(normalizedMetadata?.policyFpRisk) ??
      readOptionalNumber(normalizedMetadata?.fpRisk),
    evidenceTier: readOptionalString(normalizedMetadata?.evidenceTier),
    subtype: readOptionalString(normalizedMetadata?.subtype),
    actionBand: readOptionalString(normalizedMetadata?.actionBand),
    messageDisposition: resolveCommercialMessageDisposition(
      readOptionalString(normalizedMetadata?.actionBand),
      readOptionalBoolean(normalizedMetadata?.actionable),
      normalizedMetadata?.messageDisposition,
    ),
    reviewPriority: readOptionalString(normalizedMetadata?.reviewPriority),
    campaignStrength: readOptionalString(normalizedMetadata?.campaignStrength),
    safeContextBucket: readOptionalString(normalizedMetadata?.safeContextBucket),
    actionable: readOptionalBoolean(normalizedMetadata?.actionable),
    recordable: readOptionalBoolean(normalizedMetadata?.recordable),
    deleteSuppressed: readOptionalBoolean(normalizedMetadata?.deleteSuppressed),
    suppressionReasons: readStringArray(normalizedMetadata?.suppressionReasons),
    reasonCodes: readStringArray(normalizedMetadata?.reasonCodes),
    featureVector: readNumericRecord(normalizedMetadata?.featureVector),
  };
}

function readNumericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

function deriveCategory(historicalHit: boolean, currentHit: boolean): AuditCategory {
  if (historicalHit && currentHit) {
    return 'stable_hit';
  }
  if (historicalHit) {
    return 'historical_only';
  }
  if (currentHit) {
    return 'current_only';
  }
  return 'stable_clear';
}

function hasNonCampaignCommercialDealSignal(signals: readonly string[]): boolean {
  return signals.some(
    (signal) =>
      signal === 'transaction:price' ||
      signal === 'transaction:implied-price' ||
      signal === 'combo:contact+price' ||
      signal === 'transaction:buyout-deal' ||
      signal === 'transaction:handmade-channel-offer' ||
      signal === 'contact:phone' ||
      signal === 'contact:contextual-phone' ||
      signal === 'contact:masked-phone' ||
      signal === 'contact:handle' ||
      signal === 'contact:email' ||
      signal.startsWith('deal-channel:'),
  );
}

export function derivePolicyCategory(params: {
  category: AuditCategory;
  current: CommercialSnapshot;
}): AuditPolicyCategory {
  const { category, current } = params;
  if (category === 'historical_only') {
    return 'false_negative_candidate';
  }
  if (!current.hit) {
    return 'none';
  }
  if (
    (current.actionBand === 'WARN' || current.actionBand === 'REVIEW_ONLY') &&
    ((current.policyFpRisk ?? current.fpRisk ?? 0) >= 70 || current.reviewRecommended)
  ) {
    return 'gray_zone';
  }
  if ((current.policyFpRisk ?? current.fpRisk ?? 0) >= 70) {
    return 'false_positive_candidate';
  }
  if (
    current.evidenceStrength === 'CAMPAIGN' ||
    current.matchedSignals.some((item) => item.startsWith('campaign:'))
  ) {
    if (!hasNonCampaignCommercialDealSignal(current.matchedSignals)) {
      return 'campaign_only';
    }
  }
  if (current.actionBand === 'DELETE' || current.actionBand === 'DELETE_AND_ESCALATE') {
    return 'hard_delete';
  }
  if (
    current.reviewRecommended ||
    current.actionBand === 'WARN' ||
    current.actionBand === 'REVIEW_ONLY'
  ) {
    return 'gray_zone';
  }
  return 'none';
}

function hasHardNegativeSignals(snapshot: CommercialSnapshot): boolean {
  return snapshot.negativeSignals.some((signal) =>
    COMMERCIAL_HARD_NEGATIVE_REASON_PREFIXES.some((prefix) => signal.startsWith(prefix)),
  );
}

function deriveCorpusLabel(params: {
  category: AuditCategory;
  policyCategory: AuditPolicyCategory;
  current: CommercialSnapshot;
  historical: CommercialSnapshot;
}): Pick<
  AuditRecord,
  'label' | 'labelSource' | 'expectedAction' | 'expectedSubtype' | 'isHardNegative'
> {
  const { category, policyCategory, current, historical } = params;
  const currentSubtype = current.primarySubtype ?? current.subtype;
  const historicalSubtype = historical.primarySubtype ?? historical.subtype;
  const hardNegative =
    policyCategory === 'false_positive_candidate' || hasHardNegativeSignals(current);

  if (policyCategory === 'false_positive_candidate' || category === 'stable_clear') {
    return {
      label: 'negative_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: 'ALLOW',
      expectedSubtype: null,
      isHardNegative: hardNegative || category === 'stable_clear',
    };
  }

  if (policyCategory === 'false_negative_candidate') {
    return {
      label: 'positive_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: historical.actionBand ?? 'WARN',
      expectedSubtype: historicalSubtype,
      isHardNegative: false,
    };
  }

  if (policyCategory === 'gray_zone' || policyCategory === 'campaign_only') {
    return {
      label: 'gray_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: current.actionBand ?? 'REVIEW_ONLY',
      expectedSubtype: currentSubtype,
      isHardNegative: hardNegative,
    };
  }

  if (
    policyCategory === 'hard_delete' ||
    category === 'stable_hit' ||
    category === 'current_only'
  ) {
    return {
      label: 'positive_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: current.actionBand ?? 'WARN',
      expectedSubtype: currentSubtype,
      isHardNegative: false,
    };
  }

  return {
    label: 'unlabeled',
    labelSource: null,
    expectedAction: null,
    expectedSubtype: currentSubtype ?? historicalSubtype,
    isHardNegative: hardNegative,
  };
}

function mapSubtypeToSegment(subtype: string | null): AuditSegment | null {
  switch (subtype) {
    case 'CHANNEL_PLACEMENT':
    case 'GROUP_PROMOTION':
      return 'CHANNEL_PLACEMENT';
    case 'PROPERTY_AGENT':
    case 'PROPERTY_COMMERCIAL':
      return 'PROPERTY';
    case 'RECRUITMENT':
      return 'RECRUITMENT';
    case 'INFO_PRODUCT':
      return 'INFO_PRODUCT';
    case 'GOODS_RETAIL':
    case 'GOODS':
      return 'GOODS';
    case 'BUYOUT':
    case 'SERVICES':
      return 'SERVICES';
    default:
      return null;
  }
}

function deriveSegment(record: {
  text: string;
  currentSubtype: string | null;
  historicalSubtype: string | null;
  currentSignals: readonly string[];
  historicalSignals: readonly string[];
}): AuditSegment {
  const subtypeSegment = mapSubtypeToSegment(record.currentSubtype ?? record.historicalSubtype);
  if (subtypeSegment) {
    return subtypeSegment;
  }

  const signalText = [...record.currentSignals, ...record.historicalSignals]
    .join(' ')
    .toLowerCase();
  const text = record.text.toLowerCase();
  const combined = `${signalText}\n${text}`;

  if (
    combined.includes('channel-placement:') ||
    combined.includes('group-promo') ||
    CHANNEL_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'CHANNEL_PLACEMENT';
  }

  if (
    combined.includes('property-') ||
    PROPERTY_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'PROPERTY';
  }

  if (
    combined.includes('recruitment') ||
    combined.includes('job-seeking') ||
    RECRUITMENT_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'RECRUITMENT';
  }

  if (
    combined.includes('info-product') ||
    INFO_PRODUCT_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'INFO_PRODUCT';
  }

  if (
    combined.includes('service') ||
    combined.includes('business') ||
    combined.includes('deal') ||
    combined.includes('promo')
  ) {
    return 'SERVICES';
  }

  if (
    combined.includes('intent:') ||
    combined.includes('transaction:') ||
    combined.includes('contact:') ||
    combined.includes('group-trade:')
  ) {
    return 'GOODS';
  }

  return 'OTHER';
}

export function deriveSafeContextBucket(params: {
  text: string;
  current: CommercialSnapshot;
  historical: CommercialSnapshot;
}): AuditSafeContextBucket {
  return deriveCommercialSafeContextBucket({
    text: params.text,
    matchedSignals: [...params.current.matchedSignals, ...params.historical.matchedSignals],
    negativeSignals: [...params.current.negativeSignals, ...params.historical.negativeSignals],
    hasCommercialHit: params.current.hit || params.historical.hit,
  });
}

function makeExcerpt(text: string, limit = 220): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatSignals(signals: readonly string[]): string {
  if (signals.length === 0) {
    return 'none';
  }

  return signals.slice(0, 6).join(', ');
}

function formatCounts<T extends string>(counts: Map<T, number>): string {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function pushCount<T extends string>(map: Map<T, number>, key: T) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function deriveAuditEventFingerprint(
  record: Pick<
    AuditRecord,
    'createdAt' | 'webhookEventId' | 'eventType' | 'chatId' | 'messageId' | 'senderId'
  >,
): string {
  return createHash('sha256')
    .update('commercial-audit-event/v1\0')
    .update(
      JSON.stringify([
        record.createdAt.toISOString(),
        record.webhookEventId,
        record.eventType,
        record.chatId,
        record.messageId,
        record.senderId,
      ]),
    )
    .digest('hex');
}

export function serializeAuditRecord(record: AuditRecord): Record<string, unknown> {
  assertAuditTextSafe(record.sanitizedText);
  return {
    category: record.category,
    policyCategory: record.policyCategory,
    segment: record.segment,
    label: record.label,
    labelSource: record.labelSource,
    expectedAction: record.expectedAction,
    expectedSubtype: record.expectedSubtype,
    isHardNegative: record.isHardNegative,
    createdAt: record.createdAt.toISOString(),
    webhookEventId: record.webhookEventId,
    eventType: record.eventType,
    chatId: record.chatId,
    chatTitle: record.chatTitle,
    chatEntityType: record.chatEntityType,
    safeContextBucket: record.safeContextBucket,
    messageId: record.messageId,
    senderId: record.senderId,
    text: record.sanitizedText,
    settings: record.settings,
    commercialCampaignContext: record.commercialCampaignContext,
    historical: record.historical,
    current: record.current,
    executionAssessment: assessCommercialExecution(record.current),
    ...(record.sanitizedBaseline ? { sanitizedBaseline: record.sanitizedBaseline } : {}),
  };
}

export function serializeAuditCorpusRecord(record: AuditRecord): Record<string, unknown> {
  assertAuditTextSafe(record.sanitizedText);
  if (!record.sanitizedBaseline) {
    throw new Error('Corpus export record is missing its sanitized baseline');
  }

  return {
    label: record.label,
    labelSource: record.labelSource,
    expectedAction: record.expectedAction,
    expectedSubtype: record.expectedSubtype,
    isHardNegative: record.isHardNegative,
    category: record.category,
    policyCategory: record.policyCategory,
    segment: record.segment,
    safeContextBucket: record.safeContextBucket,
    createdAt: record.createdAt.toISOString(),
    eventFingerprint: deriveAuditEventFingerprint(record),
    eventType: record.eventType,
    text: record.sanitizedText,
    settings: record.settings,
    commercialCampaignContext: record.commercialCampaignContext,
    historical: record.historical,
    current: record.current,
    sanitizedBaseline: record.sanitizedBaseline,
    executionAssessment: assessCommercialExecution(record.current),
    sanitizationParity: assessCommercialSanitizationParity(
      record.current,
      record.sanitizedBaseline,
    ),
  };
}

function buildJsonlPayload(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

type AuditJsonlOutput = {
  pathname: string;
  payload: string;
};

type StagedAuditJsonlOutput = AuditJsonlOutput & {
  temporaryPath: string;
};

type PublishableAuditJsonlOutput = Pick<StagedAuditJsonlOutput, 'pathname' | 'temporaryPath'>;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }

  return typeof error.code === 'string' ? error.code : null;
}

async function unlinkOutputs(pathnames: readonly string[]): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const pathname of pathnames) {
    try {
      await unlink(pathname);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        errors.push(error);
      }
    }
  }
  return errors;
}

async function stageAuditJsonlOutput(output: AuditJsonlOutput): Promise<StagedAuditJsonlOutput> {
  const temporaryPath = `${output.pathname}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(output.payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const cleanupErrors = await unlinkOutputs([temporaryPath]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Audit JSONL staging failed and temporary cleanup was incomplete',
      );
    }
    throw error;
  }

  return { ...output, temporaryPath };
}

function resolveAuditJsonlPathnames(pathnames: readonly string[]): string[] {
  const resolved = pathnames.map((pathname) => resolve(pathname));
  if (new Set(resolved).size !== resolved.length) {
    throw new Error('Audit JSONL output paths must resolve to different files');
  }
  return resolved;
}

async function publishStagedAuditJsonlOutputs(
  staged: readonly PublishableAuditJsonlOutput[],
): Promise<void> {
  const publishedPaths: string[] = [];
  let publicationError: unknown;

  try {
    for (const output of staged) {
      try {
        await link(output.temporaryPath, output.pathname);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          throw new Error(`Refusing to overwrite existing audit export: ${output.pathname}`, {
            cause: error,
          });
        }
        throw error;
      }
      publishedPaths.push(output.pathname);
    }
  } catch (error) {
    const rollbackErrors = await unlinkOutputs([...publishedPaths].reverse());
    publicationError =
      rollbackErrors.length > 0
        ? new AggregateError(
            [error, ...rollbackErrors],
            'Audit JSONL publication failed and rollback was incomplete',
          )
        : error;
  }

  const cleanupErrors = await unlinkOutputs(staged.map((output) => output.temporaryPath));
  if (publicationError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [publicationError, ...cleanupErrors],
        'Audit JSONL publication failed and temporary cleanup was incomplete',
      );
    }
    throw publicationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Audit JSONL temporary cleanup failed');
  }
}

export async function publishAuditJsonlOutputs(
  outputs: readonly AuditJsonlOutput[],
): Promise<void> {
  // Caught failures roll back the pair, but process death between hard links can leave one output.
  const resolvedPathnames = resolveAuditJsonlPathnames(outputs.map((output) => output.pathname));
  const resolvedOutputs = outputs.map((output, index) => ({
    ...output,
    pathname: resolvedPathnames[index],
  }));

  for (const output of resolvedOutputs) {
    await mkdir(dirname(output.pathname), { recursive: true });
  }

  const staged: StagedAuditJsonlOutput[] = [];
  try {
    for (const output of resolvedOutputs) {
      staged.push(await stageAuditJsonlOutput(output));
    }
  } catch (error) {
    const cleanupErrors = await unlinkOutputs(staged.map((output) => output.temporaryPath));
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Audit JSONL staging failed and temporary cleanup was incomplete',
      );
    }
    throw error;
  }

  await publishStagedAuditJsonlOutputs(staged);
}

export type AuditJsonlStreamTarget<T> = {
  pathname: string;
  serialize(value: T): Record<string, unknown>;
};

type StreamedAuditJsonlOutput<T> = PublishableAuditJsonlOutput & {
  serialize(value: T): Record<string, unknown>;
  handle: FileHandle;
  buffer: string;
  bufferBytes: number;
  recordsWritten: number;
  closed: boolean;
};

export type AuditJsonlStreamWriter<T> = {
  append(value: T): Promise<void>;
  publish(): Promise<void>;
  abort(): Promise<void>;
};

export async function openAuditJsonlOutputStreams<T>(
  targets: readonly AuditJsonlStreamTarget<T>[],
): Promise<AuditJsonlStreamWriter<T>> {
  if (targets.length === 0) {
    throw new Error('At least one audit JSONL output path is required');
  }
  const targetSnapshots = targets.map((target) => ({
    pathname: target.pathname,
    serialize: target.serialize,
  }));
  const resolvedPathnames = resolveAuditJsonlPathnames(
    targetSnapshots.map((target) => target.pathname),
  );
  const resolvedTargets = targetSnapshots.map((target, index) => {
    const pathname = resolvedPathnames[index];
    if (!pathname) {
      throw new Error('Audit JSONL stream target resolution mismatch');
    }
    return { ...target, pathname };
  });
  for (const target of resolvedTargets) {
    await mkdir(dirname(target.pathname), { recursive: true });
    try {
      await access(target.pathname);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        continue;
      }
      throw error;
    }
    throw new Error(`Refusing to overwrite existing audit export: ${target.pathname}`);
  }

  const outputs: StreamedAuditJsonlOutput<T>[] = [];
  try {
    for (const target of resolvedTargets) {
      const temporaryPath = `${target.pathname}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, 'wx', 0o600);
      outputs.push({
        pathname: target.pathname,
        temporaryPath,
        serialize: target.serialize,
        handle,
        buffer: '',
        bufferBytes: 0,
        recordsWritten: 0,
        closed: false,
      });
    }
  } catch (error) {
    const closeErrors: unknown[] = [];
    for (const output of outputs) {
      try {
        await output.handle.close();
      } catch (closeError) {
        closeErrors.push(closeError);
      }
    }
    const cleanupErrors = await unlinkOutputs(outputs.map((output) => output.temporaryPath));
    if (closeErrors.length > 0 || cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...closeErrors, ...cleanupErrors],
        'Audit JSONL stream setup failed and temporary cleanup was incomplete',
      );
    }
    throw error;
  }

  let state: 'open' | 'closed' | 'failed' | 'finished' = 'open';

  const flushOutput = async (output: StreamedAuditJsonlOutput<T>): Promise<void> => {
    if (!output.buffer) {
      return;
    }
    const payload = output.buffer;
    output.buffer = '';
    output.bufferBytes = 0;
    await output.handle.writeFile(payload, 'utf8');
  };

  const closeOutputs = async (sync: boolean): Promise<unknown[]> => {
    const errors: unknown[] = [];
    for (const output of outputs) {
      if (output.closed) {
        continue;
      }
      if (sync) {
        try {
          await output.handle.sync();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await output.handle.close();
        output.closed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  };

  const abort = async (): Promise<void> => {
    if (state === 'finished') {
      return;
    }
    state = 'failed';
    const closeErrors = await closeOutputs(false);
    const cleanupErrors = await unlinkOutputs(outputs.map((output) => output.temporaryPath));
    if (closeErrors.length > 0 || cleanupErrors.length > 0) {
      throw new AggregateError(
        [...closeErrors, ...cleanupErrors],
        'Audit JSONL stream abort cleanup was incomplete',
      );
    }
    state = 'finished';
  };

  const abortAfterError = async (error: unknown): Promise<never> => {
    try {
      await abort();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Audit JSONL stream failed and temporary cleanup was incomplete',
      );
    }
    throw error;
  };

  return {
    async append(value) {
      if (state !== 'open') {
        throw new Error('Audit JSONL stream is not open');
      }

      try {
        const serializedOutputs = outputs.map((output) => ({
          output,
          payload: `${JSON.stringify(output.serialize(value))}\n`,
        }));
        for (const { output, payload } of serializedOutputs) {
          output.buffer += payload;
          output.bufferBytes += Buffer.byteLength(payload, 'utf8');
          output.recordsWritten += 1;
          if (output.bufferBytes >= AUDIT_STREAM_BUFFER_BYTES) {
            await flushOutput(output);
          }
        }
      } catch (error) {
        await abortAfterError(error);
      }
    },
    async publish() {
      if (state !== 'open') {
        throw new Error('Audit JSONL stream is not open');
      }
      try {
        for (const output of outputs) {
          if (output.recordsWritten === 0) {
            output.buffer = '\n';
          }
          await flushOutput(output);
        }
        const closeErrors = await closeOutputs(true);
        if (closeErrors.length > 0) {
          throw new AggregateError(closeErrors, 'Audit JSONL stream close failed');
        }
        state = 'closed';
      } catch (error) {
        await abortAfterError(error);
      }

      try {
        await publishStagedAuditJsonlOutputs(outputs);
        state = 'finished';
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },
    abort,
  };
}

function buildAuditJsonlOutput(
  pathname: string,
  records: readonly AuditRecord[],
): AuditJsonlOutput {
  return {
    pathname,
    payload: buildJsonlPayload(records.map(serializeAuditRecord)),
  };
}

function buildAuditCorpusJsonlOutput(
  pathname: string,
  records: readonly AuditRecord[],
): AuditJsonlOutput {
  return {
    pathname,
    payload: buildJsonlPayload(records.map(serializeAuditCorpusRecord)),
  };
}

function pickAuditCorpusSettings(settings: ChatSettings): AuditCorpusSettings {
  return {
    commercialAdsSensitivity: settings.commercialAdsSensitivity,
    commercialAdsWarnThreshold: settings.commercialAdsWarnThreshold,
    commercialAdsDeleteThreshold: settings.commercialAdsDeleteThreshold,
  };
}

export function sanitizeAuditText(value: string): string {
  const sanitized = sanitizeCommercialCorpusText(value, { preserveLayout: true });
  assertAuditTextSafe(sanitized);
  return sanitized;
}

function assertAuditTextSafe(value: string): void {
  // FLAG: Idempotent masking alone cannot prove privacy; refuse the whole export on uncertainty.
  if (!isCommercialCorpusTextSanitized(value))
    throw new Error('Commercial audit text privacy is unverified');
}

export function isCommercialEnforcementAction(actionBand: string | null): boolean {
  return isCommercialMessageDeleteEligible(actionBand, true);
}

export function assessCommercialExecution(snapshot: CommercialSnapshot) {
  return {
    messageDeleteEligible:
      snapshot.hit &&
      isCommercialMessageDeleteEligible(
        snapshot.actionBand,
        snapshot.actionable,
        snapshot.messageDisposition,
      ),
    executionVerified: false,
  };
}

export function assessCommercialSanitizationParity(
  current: CommercialSnapshot,
  sanitized: CommercialSnapshot,
) {
  const changedFields = (
    ['hit', 'actionBand', 'actionable', 'primarySubtype', 'messageDisposition'] as const
  ).filter((field) => current[field] !== sanitized[field]);
  return { decisionEquivalent: changedFields.length === 0, changedFields };
}

export async function resolveCorpusSanitizedBaseline(params: {
  corpusExportRequested: boolean;
  retainedForCorpus: boolean;
  rawText: string;
  sanitizedText: string;
  current: CommercialSnapshot;
  detectSanitized: () => Promise<CommercialSnapshot>;
}): Promise<CommercialSnapshot | undefined> {
  if (!params.corpusExportRequested || !params.retainedForCorpus) {
    return undefined;
  }
  if (params.sanitizedText === params.rawText) {
    return params.current;
  }
  return params.detectSanitized();
}

export function formatAuditSampleLines(record: AuditRecord): string[] {
  assertAuditTextSafe(record.sanitizedText);
  return [
    [
      `- ${record.createdAt.toISOString()}`,
      `eventFingerprint=${deriveAuditEventFingerprint(record)}`,
      `eventType=${record.eventType}`,
      `entityType=${record.chatEntityType ?? 'unknown'}`,
      `segment=${record.segment}`,
      `safeContext=${record.safeContextBucket}`,
      `policy=${record.policyCategory}`,
      `label=${record.label}`,
      `expectedAction=${record.expectedAction ?? 'n/a'}`,
      `expectedSubtype=${record.expectedSubtype ?? 'n/a'}`,
    ].join(' '),
    `  text=${makeExcerpt(record.sanitizedText)}`,
    `  historical score=${record.historical.score ?? 'n/a'} subtype=${record.historical.primarySubtype ?? 'n/a'} review=${record.historical.reviewRecommended ? 'yes' : 'no'} signals=${formatSignals(record.historical.matchedSignals)}`,
    `  current confidence=${record.current.confidenceScore ?? 'n/a'} band=${record.current.decisionBand ?? 'n/a'} action=${record.current.actionBand ?? 'n/a'} fpRisk=${record.current.fpRisk ?? 'n/a'} subtype=${record.current.primarySubtype ?? 'n/a'} review=${record.current.reviewRecommended ? 'yes' : 'no'} evidence=${record.current.evidenceTier ?? record.current.evidenceStrength ?? 'n/a'} signals=${formatSignals(record.current.matchedSignals)}`,
    ...(record.current.classifierVersion
      ? [
          `  classifier version=${record.current.classifierVersion} commercial=${record.current.commercialProbability ?? 'n/a'} review=${record.current.reviewProbability ?? 'n/a'} reasons=${formatSignals(record.current.classifierReasons)}`,
        ]
      : []),
    ...(record.current.reviewReasons.length > 0
      ? [`  current_review_reasons=${formatSignals(record.current.reviewReasons)}`]
      : []),
  ];
}

export function retainNewestAuditSample(
  samples: Map<AuditCategory, AuditRecord[]>,
  record: AuditRecord,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }
  const records = samples.get(record.category) ?? [];
  records.push(record);
  if (records.length > limit) {
    records.shift();
  }
  samples.set(record.category, records);
}

export function readNewestAuditSamples(
  samples: ReadonlyMap<AuditCategory, readonly AuditRecord[]>,
  category: AuditCategory,
): AuditRecord[] {
  return [...(samples.get(category) ?? [])].reverse();
}

export function assertCommercialAuditNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Commercial audit was interrupted');
}

export function* iterateLockedAuditCandidateRows<T>(
  rows: readonly T[],
  runLock: CommercialAuditRunLock,
  signal?: AbortSignal,
): Generator<T> {
  for (const row of rows) {
    assertCommercialAuditNotAborted(signal);
    runLock.assertHeld();
    yield row;
  }
}

async function* iterateAuditCandidatePages(
  prisma: PrismaClient,
  options: CliOptions & { pageSize: number },
  runLock: CommercialAuditRunLock,
  signal?: AbortSignal,
): AsyncGenerator<AuditCandidateRow[]> {
  let cursor: AuditCandidateCursor | undefined;

  while (true) {
    assertCommercialAuditNotAborted(signal);
    runLock.assertHeld();
    const page = await loadCandidatePage(prisma, options, {
      pageSize: options.pageSize,
      ...(cursor ? { cursor } : {}),
    });
    assertCommercialAuditNotAborted(signal);
    runLock.assertHeld();
    if (!page) {
      return;
    }
    for (let index = 1; index < page.candidates.length; index += 1) {
      if (compareAuditCandidateKeys(page.candidates[index - 1], page.candidates[index]) >= 0) {
        throw new Error('Commercial audit candidate page is not strictly ordered');
      }
    }
    if (cursor && compareAuditCandidateKeys(cursor, page.cursor) >= 0) {
      throw new Error('Commercial audit scan page did not advance past its cursor');
    }
    if (
      cursor &&
      page.candidates[0] &&
      compareAuditCandidateKeys(cursor, page.candidates[0]) >= 0
    ) {
      throw new Error('Commercial audit candidate page crossed its scan cursor');
    }

    yield page.candidates;

    cursor = page.cursor;
    if (page.scannedCount < options.pageSize) {
      return;
    }
  }
}

async function runCommercialAudit(
  options: CliOptions,
  runLock: CommercialAuditRunLock,
  signal?: AbortSignal,
) {
  const prisma = createPrismaClient(undefined, resolveCommercialAuditPrismaPoolConfig());
  const ruleEngine = new RuleEngineService(NOOP_REDIS_COUNTER as never);
  let streamWriter: AuditJsonlStreamWriter<AuditRecord> | undefined;

  try {
    assertCommercialAuditNotAborted(signal);
    await prisma.$connect();
    assertCommercialAuditNotAborted(signal);
    runLock.assertHeld();
    const paged = options.pageSize !== undefined;
    const candidates = paged ? null : await loadCandidates(prisma, options);
    assertCommercialAuditNotAborted(signal);
    runLock.assertHeld();
    const auditScope = resolveAuditCandidateScope(options);
    const loadSince = resolveAuditLoadSince(options);
    const orderedCandidates = [...(candidates ?? [])].sort(compareAuditCandidateKeys);
    let loadedCandidateCount = candidates?.length ?? 0;
    let targetCandidateCount = (candidates ?? []).filter(
      (item) => item.createdAt.getTime() >= options.since.getTime(),
    ).length;
    const chatContexts = new Map<string, ChatContext | null>();
    const chatContextActiveAt = new Date();
    if (!paged) {
      await ensureChatContexts(prisma, chatContexts, candidates ?? [], chatContextActiveAt);
      assertCommercialAuditNotAborted(signal);
    }
    const campaignTracker = new InMemoryCommercialCampaignTracker();

    const streamTargets: AuditJsonlStreamTarget<AuditRecord>[] = [];
    if (paged && options.exportJsonlPath) {
      streamTargets.push({
        pathname: options.exportJsonlPath,
        serialize: serializeAuditRecord,
      });
    }
    if (paged && options.exportCorpusJsonlPath) {
      streamTargets.push({
        pathname: options.exportCorpusJsonlPath,
        serialize: serializeAuditCorpusRecord,
      });
    }
    if (streamTargets.length > 0) {
      streamWriter = await openAuditJsonlOutputStreams(streamTargets);
    }

    const skipCounts = new Map<AuditSkipReason, number>();
    const categoryCounts = new Map<AuditCategory, number>();
    const policyCategoryCounts = new Map<AuditPolicyCategory, number>();
    const corpusLabelCounts = new Map<AuditCorpusLabel, number>();
    const segmentCounts = new Map<`${AuditCategory}:${AuditSegment}`, number>();
    const safeContextBucketCounts = new Map<AuditSafeContextBucket, number>();
    const currentSignalCounts = new Map<string, number>();
    const currentSubtypeCounts = new Map<string, number>();
    const currentReviewReasonCounts = new Map<string, number>();
    const currentClassifierReasonCounts = new Map<string, number>();
    const currentClassifierVersionCounts = new Map<string, number>();
    const eventTypeCounts = new Map<string, number>();
    let evaluatedCount = 0;
    let warmupTrackedCount = 0;
    let currentReviewRecommendedCount = 0;
    let deleteFalsePositiveCandidates = 0;
    let grayDeleteCandidates = 0;
    let campaignOnlyDeleteCandidates = 0;
    let enforcementFalsePositiveCandidates = 0;
    let grayEnforcementCandidates = 0;
    let campaignOnlyEnforcementCandidates = 0;
    let messageDeleteEligibleCount = 0;
    let sanitizationComparedCount = 0;
    let sanitizationDecisionDriftCount = 0;
    const actionBandCounts = new Map<string, number>();
    let processedCandidateCount = 0;
    let retainedRecordCount = 0;
    const auditedRecords: AuditRecord[] = [];
    const pagedSamples = new Map<AuditCategory, AuditRecord[]>();

    console.log(
      [
        'COMMERCIAL_AD audit started',
        `window=${options.since.toISOString()}..${options.until.toISOString()}`,
        `loadWindow=${loadSince.toISOString()}..${options.until.toISOString()}`,
        `limit=${options.limit === null ? 'all' : options.limit}`,
        `sample=${options.sample}`,
        `chatFilter=${options.chatId ? 'single-chat' : 'all'}`,
        `scope=${auditScope.logLabel}`,
        `currentOnly=${options.currentOnly ? 'yes' : 'no'}`,
        ...(paged
          ? [
              `pageSize=${options.pageSize}`,
              'exportOrder=chronological',
              'loadedCandidates=paged',
              'targetCandidates=paged',
            ]
          : [
              `loadedCandidates=${loadedCandidateCount}`,
              `targetCandidates=${targetCandidateCount}`,
            ]),
      ].join(' '),
    );

    const candidatePages: AsyncIterable<readonly AuditCandidateRow[]> =
      options.pageSize !== undefined
        ? iterateAuditCandidatePages(
            prisma,
            { ...options, pageSize: options.pageSize },
            runLock,
            signal,
          )
        : (async function* () {
            yield orderedCandidates;
          })();

    for await (const candidatePage of candidatePages) {
      assertCommercialAuditNotAborted(signal);
      if (paged) {
        loadedCandidateCount += candidatePage.length;
        targetCandidateCount += candidatePage.filter(
          (item) => item.createdAt.getTime() >= options.since.getTime(),
        ).length;
      }
      await ensureChatContexts(prisma, chatContexts, candidatePage, chatContextActiveAt);
      assertCommercialAuditNotAborted(signal);

      for (const row of iterateLockedAuditCandidateRows(candidatePage, runLock, signal)) {
        processedCandidateCount += 1;
        const isTargetWindow = row.createdAt.getTime() >= options.since.getTime();
        const update = row.normalizedPayload as MaxUpdate;
        const chatContext = chatContexts.get(row.chatId) ?? undefined;
        const skipReason = resolveSkipReason(row, update, chatContext);
        if (skipReason) {
          if (isTargetWindow) {
            pushCount(skipCounts, skipReason);
          }
          if (processedCandidateCount % PROGRESS_EVERY === 0) {
            console.log(
              paged
                ? `processed=${processedCandidateCount}`
                : `processed=${processedCandidateCount}/${orderedCandidates.length}`,
            );
          }
          continue;
        }
        if (!chatContext) {
          if (isTargetWindow) {
            pushCount(skipCounts, 'missing-chat-context');
          }
          if (processedCandidateCount % PROGRESS_EVERY === 0) {
            console.log(
              paged
                ? `processed=${processedCandidateCount}`
                : `processed=${processedCandidateCount}/${orderedCandidates.length}`,
            );
          }
          continue;
        }

        const senderId = (update.message?.senderId ?? row.senderId ?? '').trim();
        const text = typeof update.message?.text === 'string' ? update.message.text : row.text;
        const commercialCampaignContext = campaignTracker.track({
          createdAt: row.createdAt,
          chatId: row.chatId,
          senderId,
          text,
        });
        if (!isTargetWindow) {
          warmupTrackedCount += 1;
          if (processedCandidateCount % PROGRESS_EVERY === 0) {
            console.log(
              paged
                ? `processed=${processedCandidateCount}`
                : `processed=${processedCandidateCount}/${orderedCandidates.length}`,
            );
          }
          continue;
        }
        const detectionSettings = resolveAuditDetectionSettings(chatContext.settings, options);
        const detection = await ruleEngine.detect({
          chatId: row.chatId,
          userId: senderId,
          text,
          settings: detectionSettings,
          domainAllowlist: chatContext.domainAllowlist,
          effectiveLength: text.length,
          skipDuplicateState: true,
          commercialCampaignContext,
        });
        evaluatedCount += 1;

        const current = snapshotFromViolation(extractCommercialViolation(detection.violations));
        const historical = snapshotFromHistorical(
          row.hasHistoricalCommercialEvent,
          row.historicalScore,
          row.historicalMetadata,
        );
        const category = deriveCategory(historical.hit, current.hit);
        const segment = deriveSegment({
          text,
          currentSubtype: current.primarySubtype,
          historicalSubtype: historical.primarySubtype,
          currentSignals: current.matchedSignals,
          historicalSignals: historical.matchedSignals,
        });
        const safeContextBucket = deriveSafeContextBucket({ text, current, historical });
        const policyCategory = derivePolicyCategory({ category, current });
        const corpusLabel = deriveCorpusLabel({ category, policyCategory, current, historical });

        pushCount(categoryCounts, category);
        pushCount(policyCategoryCounts, policyCategory);
        pushCount(corpusLabelCounts, corpusLabel.label);
        pushCount(segmentCounts, `${category}:${segment}`);
        pushCount(safeContextBucketCounts, safeContextBucket);
        pushCount(eventTypeCounts, row.eventType);
        pushCount(actionBandCounts, current.actionBand ?? 'NONE');
        if (assessCommercialExecution(current).messageDeleteEligible) {
          messageDeleteEligibleCount += 1;
        }
        for (const signal of current.matchedSignals) {
          pushCount(currentSignalCounts, signal);
        }
        if (current.primarySubtype) {
          pushCount(currentSubtypeCounts, current.primarySubtype);
        }
        if (current.classifierVersion) {
          pushCount(currentClassifierVersionCounts, current.classifierVersion);
        }
        if (current.reviewRecommended) {
          currentReviewRecommendedCount += 1;
        }
        for (const reason of current.reviewReasons) {
          pushCount(currentReviewReasonCounts, reason);
        }
        for (const reason of current.classifierReasons) {
          pushCount(currentClassifierReasonCounts, reason);
        }

        const shouldRetainRecord =
          options.exportAllCorpus ||
          (options.includeStableHits
            ? category !== 'stable_clear'
            : category === 'historical_only' ||
              category === 'current_only' ||
              policyCategory !== 'none');
        if (shouldRetainRecord) {
          retainedRecordCount += 1;
          const shouldStoreSample =
            paged &&
            options.sample > 0 &&
            category !== 'stable_clear' &&
            (category !== 'stable_hit' || options.includeStableHits);
          if (!paged || streamWriter || shouldStoreSample) {
            const sanitizedText = sanitizeAuditText(text);
            const sanitizedBaseline = await resolveCorpusSanitizedBaseline({
              corpusExportRequested: Boolean(options.exportCorpusJsonlPath),
              retainedForCorpus: shouldRetainRecord,
              rawText: text,
              sanitizedText,
              current,
              detectSanitized: async () =>
                snapshotFromViolation(
                  extractCommercialViolation(
                    (
                      await ruleEngine.detect({
                        chatId: row.chatId,
                        userId: senderId,
                        text: sanitizedText,
                        settings: detectionSettings,
                        domainAllowlist: chatContext.domainAllowlist,
                        effectiveLength: sanitizedText.length,
                        skipDuplicateState: true,
                        commercialCampaignContext,
                      })
                    ).violations,
                  ),
                ),
            });
            if (sanitizedBaseline) {
              sanitizationComparedCount += 1;
              if (
                !assessCommercialSanitizationParity(current, sanitizedBaseline).decisionEquivalent
              ) {
                sanitizationDecisionDriftCount += 1;
              }
            }
            const auditRecord: AuditRecord = {
              category,
              policyCategory,
              segment,
              safeContextBucket,
              ...corpusLabel,
              createdAt: row.createdAt,
              webhookEventId: row.webhookEventId,
              eventType: row.eventType,
              chatId: row.chatId,
              chatTitle: row.chatTitle,
              chatEntityType: row.chatEntityType,
              messageId: row.messageId,
              senderId,
              text,
              sanitizedText,
              historical,
              current,
              ...(sanitizedBaseline ? { sanitizedBaseline } : {}),
              settings: pickAuditCorpusSettings(detectionSettings),
              commercialCampaignContext,
            };

            if (paged) {
              if (shouldStoreSample) {
                retainNewestAuditSample(pagedSamples, auditRecord, options.sample);
              }
              if (streamWriter) {
                await streamWriter.append(auditRecord);
              }
            } else {
              auditedRecords.push(auditRecord);
            }
          }
        }

        if (
          corpusLabel.label === 'negative_candidate' &&
          (current.actionBand === 'DELETE' || current.actionBand === 'DELETE_AND_ESCALATE')
        ) {
          deleteFalsePositiveCandidates += 1;
        }
        if (
          corpusLabel.label === 'gray_candidate' &&
          (current.actionBand === 'DELETE' || current.actionBand === 'DELETE_AND_ESCALATE')
        ) {
          grayDeleteCandidates += 1;
        }
        if (
          policyCategory === 'campaign_only' &&
          (current.actionBand === 'DELETE' || current.actionBand === 'DELETE_AND_ESCALATE')
        ) {
          campaignOnlyDeleteCandidates += 1;
        }
        if (
          corpusLabel.label === 'negative_candidate' &&
          isCommercialEnforcementAction(current.actionBand)
        ) {
          enforcementFalsePositiveCandidates += 1;
        }
        if (
          corpusLabel.label === 'gray_candidate' &&
          isCommercialEnforcementAction(current.actionBand)
        ) {
          grayEnforcementCandidates += 1;
        }
        if (
          policyCategory === 'campaign_only' &&
          isCommercialEnforcementAction(current.actionBand)
        ) {
          campaignOnlyEnforcementCandidates += 1;
        }

        if (processedCandidateCount % PROGRESS_EVERY === 0) {
          console.log(
            paged
              ? `processed=${processedCandidateCount}`
              : `processed=${processedCandidateCount}/${orderedCandidates.length}`,
          );
        }
      }
    }

    auditedRecords.sort((left, right) => -compareAuditCandidateKeys(left, right));

    const exportable = auditedRecords;

    console.log('');
    console.log('Summary');
    if (paged) {
      console.log(`loaded_candidates=${loadedCandidateCount}`);
      console.log(`target_candidates=${targetCandidateCount}`);
    }
    console.log(`evaluated=${evaluatedCount}`);
    console.log(`warmup_tracked=${warmupTrackedCount}`);
    console.log(`skipped=${[...skipCounts.values()].reduce((sum, value) => sum + value, 0)}`);
    console.log(`skip_breakdown=${formatCounts(skipCounts) || 'none'}`);
    console.log(`category_breakdown=${formatCounts(categoryCounts) || 'none'}`);
    console.log(`event_type_breakdown=${formatCounts(eventTypeCounts) || 'none'}`);
    console.log(`policy_category_breakdown=${formatCounts(policyCategoryCounts) || 'none'}`);
    console.log(`corpus_label_breakdown=${formatCounts(corpusLabelCounts) || 'none'}`);
    console.log(`safe_context_bucket_breakdown=${formatCounts(safeContextBucketCounts) || 'none'}`);
    console.log(
      `historical_only_segments=${
        formatCounts(
          new Map(
            [...segmentCounts.entries()]
              .filter(([key]) => key.startsWith('historical_only:'))
              .map(([key, value]) => [key.slice('historical_only:'.length) as AuditSegment, value]),
          ),
        ) || 'none'
      }`,
    );
    console.log(
      `current_only_segments=${
        formatCounts(
          new Map(
            [...segmentCounts.entries()]
              .filter(([key]) => key.startsWith('current_only:'))
              .map(([key, value]) => [key.slice('current_only:'.length) as AuditSegment, value]),
          ),
        ) || 'none'
      }`,
    );
    console.log(
      `top_current_signals=${
        formatCounts(
          new Map([...currentSignalCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
        ) || 'none'
      }`,
    );
    console.log(
      `current_primary_subtypes=${
        formatCounts(
          new Map([...currentSubtypeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
        ) || 'none'
      }`,
    );
    console.log(
      `current_classifier_versions=${
        formatCounts(
          new Map(
            [...currentClassifierVersionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
          ),
        ) || 'none'
      }`,
    );
    console.log(`current_review_recommended=${currentReviewRecommendedCount}`);
    console.log(`action_band_breakdown=${formatCounts(actionBandCounts) || 'none'}`);
    console.log(`message_delete_eligible=${messageDeleteEligibleCount} execution_verified=no`);
    console.log(
      `sanitization_compared=${sanitizationComparedCount} sanitization_decision_drift=${sanitizationDecisionDriftCount}`,
    );
    console.log(`delete_false_positive_candidates=${deleteFalsePositiveCandidates}`);
    console.log(`gray_delete_candidates=${grayDeleteCandidates}`);
    console.log(`campaign_only_delete_candidates=${campaignOnlyDeleteCandidates}`);
    console.log(`enforcement_false_positive_candidates=${enforcementFalsePositiveCandidates}`);
    console.log(`gray_enforcement_candidates=${grayEnforcementCandidates}`);
    console.log(`campaign_only_enforcement_candidates=${campaignOnlyEnforcementCandidates}`);
    console.log(
      `current_review_reasons=${
        formatCounts(
          new Map(
            [...currentReviewReasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
          ),
        ) || 'none'
      }`,
    );
    console.log(
      `current_classifier_reasons=${
        formatCounts(
          new Map(
            [...currentClassifierReasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
          ),
        ) || 'none'
      }`,
    );

    const categoriesToPrint: AuditCategory[] = ['historical_only', 'current_only', 'stable_hit'];
    for (const category of categoriesToPrint) {
      if (category === 'stable_hit' && !options.includeStableHits) {
        continue;
      }

      const rows = paged
        ? readNewestAuditSamples(pagedSamples, category)
        : auditedRecords.filter((record) => record.category === category).slice(0, options.sample);
      if (rows.length === 0) {
        continue;
      }

      console.log('');
      console.log(category);
      for (const record of rows) {
        for (const line of formatAuditSampleLines(record)) {
          console.log(line);
        }
      }
    }

    assertCommercialAuditNotAborted(signal);
    runLock.assertHeld();
    if (paged) {
      await streamWriter?.publish();
    } else {
      const jsonlOutputs: AuditJsonlOutput[] = [];
      if (options.exportJsonlPath) {
        jsonlOutputs.push(buildAuditJsonlOutput(options.exportJsonlPath, exportable));
      }
      if (options.exportCorpusJsonlPath) {
        jsonlOutputs.push(buildAuditCorpusJsonlOutput(options.exportCorpusJsonlPath, exportable));
      }
      await publishAuditJsonlOutputs(jsonlOutputs);
    }
    assertCommercialAuditNotAborted(signal);
    runLock.assertHeld();

    if (options.exportJsonlPath) {
      console.log('');
      console.log(`exported=${retainedRecordCount} path=${options.exportJsonlPath}`);
    }
    if (options.exportCorpusJsonlPath) {
      console.log('');
      console.log(`exported_corpus=${retainedRecordCount} path=${options.exportCorpusJsonlPath}`);
    }
  } finally {
    try {
      await streamWriter?.abort();
    } finally {
      await prisma.$disconnect();
    }
  }
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const interruptController = new AbortController();
  const interrupt = (signalName: 'SIGINT' | 'SIGTERM') => {
    if (interruptController.signal.aborted) {
      return;
    }
    console.error(
      `Commercial audit received ${signalName}; waiting for bounded query and export cleanup`,
    );
    interruptController.abort(new Error(`Commercial audit interrupted by ${signalName}`));
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    await withCommercialAuditRunLock((runLock) =>
      runCommercialAudit(options, runLock, interruptController.signal),
    );
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
