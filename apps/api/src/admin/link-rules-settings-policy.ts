import {
  LINK_RULES_MAX,
  linkRulesPolicySchema,
  parseStoredAllowlistEntry,
  type ChatSettings,
  type LinkRule,
  type LinkRulesLegacySnapshot,
  type LinkRulesPolicy,
} from '@maxim/contracts/settings';
import { NETWORK_ALLOWLIST_PLAN_ROW_LIMIT } from '@maxim/contracts/network-settings';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export const LINK_RULES_METADATA_KEYS = [
  'linkRulesLegacySnapshot',
  'linkRulesStorageStatus',
  'linkRulesReplaceInvalidStorage',
] as const;

export function inactiveLinkRulesPolicy(): LinkRulesPolicy {
  return { version: 1, mode: 'ALLOW_ALL', rules: [] };
}

export function linkRulesStorageStatus(value: unknown): 'legacy' | 'valid' | 'invalid' {
  return value == null
    ? 'legacy'
    : linkRulesPolicySchema.safeParse(value).success
      ? 'valid'
      : 'invalid';
}

export function linkRulesLegacyShadow(policy: LinkRulesPolicy): ChatSettings['linkPolicy'] {
  return policy.mode === 'ALLOW_ALL'
    ? 'ALERT_ONLY'
    : policy.mode === 'DENY_ALL'
      ? 'BLOCKLIST_ONLY'
      : 'ALLOWLIST_ONLY';
}

export function linkRulesOwnershipConflict(): ConflictException {
  return new ConflictException({
    code: 'LINK_RULES_OWNERSHIP_CONFLICT',
    message: 'Ссылками уже управляет новый раздел. Откройте его, чтобы изменить правила.',
  });
}

export async function assertLegacyLinkAllowlistWrite(
  tx: Pick<Prisma.TransactionClient, 'chatSettings'>,
  chatId: string,
): Promise<void> {
  const settings = await tx.chatSettings.findUnique({
    where: { chatId },
    select: { linkRulesPolicy: true },
  });
  if (settings?.linkRulesPolicy != null) throw linkRulesOwnershipConflict();
}

export function buildLegacyLinkRulesPolicy(
  legacyPolicy: ChatSettings['linkPolicy'],
  rows: readonly { domain: string; removeAfterAt: Date | null }[],
  nowMs = Date.now(),
): LinkRulesPolicy | null {
  if (rows.length > NETWORK_ALLOWLIST_PLAN_ROW_LIMIT) return null;
  const rules = new Map<string, LinkRule>();
  for (const row of rows) {
    if (row.removeAfterAt && row.removeAfterAt.getTime() <= nowMs) continue;
    const parsed = parseStoredAllowlistEntry(row.domain);
    if (!parsed) return null;
    const key = `${parsed.kind}\0${parsed.target}`;
    const previous = rules.get(key);
    const expiresAt = previous
      ? previous.expiresAt === null || row.removeAfterAt === null
        ? null
        : new Date(Math.max(Date.parse(previous.expiresAt), +row.removeAfterAt)).toISOString()
      : (row.removeAfterAt?.toISOString() ?? null);
    rules.set(key, {
      id: `legacy-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`,
      kind: parsed.kind,
      target: parsed.target,
      effect: 'ALLOW',
      enabled: true,
      expiresAt,
    });
    if (rules.size > LINK_RULES_MAX) return null;
  }
  const result = linkRulesPolicySchema.safeParse({
    version: 1,
    mode:
      legacyPolicy === 'ALERT_ONLY'
        ? 'ALLOW_ALL'
        : legacyPolicy === 'BLOCKLIST_ONLY'
          ? 'DENY_ALL'
          : 'ALLOW_SELECTED',
    rules: [...rules.values()],
  });
  return result.success ? result.data : null;
}

export async function readLinkRulesLegacySnapshot(
  prisma: PrismaService,
  chatId: string,
  legacyPolicy: ChatSettings['linkPolicy'],
): Promise<LinkRulesLegacySnapshot | null> {
  return prisma.$transaction(async (tx) => {
    // FLAG: The list and its revision share the Chat lock used by every legacy writer.
    const chats = await tx.$queryRaw<
      Array<{ revision: number }>
    >`SELECT navigation_allowlist_revision AS revision FROM chats WHERE id=${chatId} FOR UPDATE`;
    if (!chats[0]) return null;
    const rows = await tx.domainAllowlist.findMany({
      where: { chatId, OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }] },
      orderBy: { domain: 'asc' },
      take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1,
      select: { domain: true, removeAfterAt: true },
    });
    const policy = buildLegacyLinkRulesPolicy(legacyPolicy, rows);
    return policy ? { revision: String(chats[0].revision), policy } : null;
  });
}

export function resolveLinkRulesSettingsWrite(params: {
  current: { linkRulesPolicy?: unknown; linkPolicy: ChatSettings['linkPolicy'] } | null;
  requested: ChatSettings;
  authored: boolean;
  networkReplacement: boolean;
}) {
  const raw = params.current?.linkRulesPolicy;
  const status = linkRulesStorageStatus(raw);
  const parsedStored = linkRulesPolicySchema.safeParse(raw);
  let writePolicy = params.authored && params.requested.linkRulesPolicy != null;
  if (raw != null && params.authored && params.requested.linkRulesPolicy == null)
    throw linkRulesOwnershipConflict();
  if (status === 'invalid' && writePolicy && !params.requested.linkRulesReplaceInvalidStorage) {
    // FLAG: A full save can echo the inert GET copy; it never repairs malformed JSON implicitly.
    if (!isDeepStrictEqual(params.requested.linkRulesPolicy, inactiveLinkRulesPolicy()))
      throw linkRulesOwnershipConflict();
    writePolicy = false;
  }
  const policy = writePolicy
    ? params.requested.linkRulesPolicy!
    : parsedStored.success
      ? parsedStored.data
      : status === 'invalid'
        ? inactiveLinkRulesPolicy()
        : null;
  const initialAdoption = writePolicy && status === 'legacy' && !params.networkReplacement;
  if (initialAdoption && !params.requested.linkRulesLegacySnapshot) {
    throw new ConflictException({
      code: 'LINK_RULES_LEGACY_SNAPSHOT_REQUIRED',
      message: 'Обновите раздел ссылок перед первым сохранением правил.',
    });
  }
  return {
    policy,
    writePolicy,
    initialAdoption,
    status: writePolicy ? ('valid' as const) : status,
    linkPolicy: policy ? linkRulesLegacyShadow(policy) : params.requested.linkPolicy,
    preserveLegacyShadow: status === 'invalid' && !writePolicy,
  };
}
