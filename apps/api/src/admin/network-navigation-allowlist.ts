import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
} from '@maxim/contracts/settings';
import {
  NETWORK_ALLOWLIST_PLAN_ROW_LIMIT,
  type NetworkNavigationAllowlistIntent,
  type NetworkNavigationAllowlistWitness,
  type NetworkNavigationAllowlistImpact,
  type NetworkSettingsRecipient,
} from '@maxim/contracts/network-settings';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../prisma/prisma-client';
import type { NetworkSettingsWriteOptions } from './network-settings-write';
import { assertLegacyLinkAllowlistWrite } from './link-rules-settings-policy';
type Row = { domain: string; removeAfterAt: Date | null };
export function allowlistPlanTooLarge() {
  return new BadRequestException({
    code: 'NETWORK_ALLOWLIST_PLAN_TOO_LARGE',
    message:
      'Список ссылок слишком большой для безопасного группового изменения. Изменения не записаны; остальные настройки доступны отдельно.',
  });
}
export function assertBoundedAllowlistRows<T>(rows: T[]): T[] {
  if (rows.length > NETWORK_ALLOWLIST_PLAN_ROW_LIMIT) throw allowlistPlanTooLarge();
  return rows;
}
const conflict = () =>
  new ConflictException({
    code: 'NETWORK_ALLOWLIST_CHANGED',
    message: 'Список ссылок или срок действия изменился. Проверьте изменения заново.',
  });
function canonicalTarget(target: {
  value: string;
  kind: Parameters<typeof normalizeStoredAllowlistEntry>[1];
}) {
  const key = normalizeStoredAllowlistEntry(target.value, target.kind);
  const parsed = key ? parseStoredAllowlistEntry(key) : null;
  if (!parsed) throw new BadRequestException('Укажите корректную ссылку выбранного вида.');
  return parsed;
}
export function normalizeNetworkAllowlistIntent(
  intent: NetworkNavigationAllowlistIntent,
): NetworkNavigationAllowlistIntent {
  const seen = new Set<string>();
  const normalize = (target: {
    value: string;
    kind: Parameters<typeof normalizeStoredAllowlistEntry>[1];
  }) => {
    const parsed = canonicalTarget(target);
    if (seen.has(parsed.normalizedValue))
      throw new BadRequestException('Одна ссылка указана несколько раз.');
    seen.add(parsed.normalizedValue);
    return { value: parsed.target, kind: parsed.kind };
  };
  return intent.mode === 'edit'
    ? {
        mode: 'edit',
        actions: intent.actions.map((action) => ({ ...action, target: normalize(action.target) })),
      }
    : {
        mode: 'replace',
        entries: intent.entries.map((entry) => ({
          ...normalize(entry),
          removeAfterAt: entry.removeAfterAt,
        })),
      };
}
@Injectable()
export class NetworkNavigationAllowlist {
  constructor(private readonly prisma: PrismaService) {}
  private async rows(tx: Prisma.TransactionClient, chatId: string): Promise<Row[]> {
    // FLAG: The composite PK supplies bounded stable row work; the sentinel is a refusal, never a truncated plan.
    return assertBoundedAllowlistRows(
      await tx.domainAllowlist.findMany({
        where: { chatId },
        orderBy: { domain: 'asc' },
        take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1,
        select: { domain: true, removeAfterAt: true },
      }),
    );
  }
  private async lock(tx: Prisma.TransactionClient, chatId: string) {
    const rows = await tx.$queryRaw<
      Array<{ revision: number }>
    >`SELECT navigation_allowlist_revision AS revision FROM chats WHERE id=${chatId} FOR UPDATE`;
    if (!rows[0]) throw conflict();
    return rows[0].revision;
  }
  private active(rows: Row[], now: Date) {
    const entries = new Map<
      string,
      {
        kind: ReturnType<typeof canonicalTarget>['kind'];
        removeAfterAt: Date | null;
        aliases: string[];
      }
    >();
    for (const row of rows) {
      const parsed = parseStoredAllowlistEntry(row.domain);
      if (!parsed)
        throw new BadRequestException({
          code: 'NETWORK_ALLOWLIST_LEGACY_VALUE',
          message: 'В списке есть неподдерживаемая запись. Групповое изменение не выполнено.',
        });
      if (row.removeAfterAt && row.removeAfterAt <= now) continue;
      const old = entries.get(parsed.normalizedValue);
      entries.set(parsed.normalizedValue, {
        kind: parsed.kind,
        aliases: [...(old?.aliases ?? []), row.domain],
        removeAfterAt: old
          ? old.removeAfterAt === null || row.removeAfterAt === null
            ? null
            : new Date(Math.max(+old.removeAfterAt, +row.removeAfterAt))
          : row.removeAfterAt,
      });
    }
    return entries;
  }
  private witness(revision: number, rows: Row[], now: Date): NetworkNavigationAllowlistWitness {
    const dates = rows.flatMap((row) =>
      row.removeAfterAt && row.removeAfterAt > now ? [+row.removeAfterAt] : [],
    );
    return {
      revision: String(revision),
      observedAt: now.toISOString(),
      nextExpiryAt: dates.length ? new Date(Math.min(...dates)).toISOString() : null,
    };
  }
  async read(chatId: string, cursor?: string, includeEntries = true) {
    return this.prisma.$transaction(async (tx) => {
      const revision = await this.lock(tx, chatId);
      const now = new Date();
      const rows = await this.rows(tx, chatId);
      const entries = [...this.active(rows, now)].sort(([a], [b]) => a.localeCompare(b));
      const start = cursor ? entries.findIndex(([value]) => value === cursor) + 1 : 0;
      if (cursor && start === 0) throw conflict();
      const selected = includeEntries ? entries.slice(start, start + 50) : [];
      const complete = !includeEntries || start + selected.length >= entries.length;
      return {
        entityId: chatId,
        witness: this.witness(revision, rows, now),
        entries: selected.map(([value, entry]) => ({
          value: parseStoredAllowlistEntry(value)!.target,
          kind: entry.kind,
          removeAfterAt: entry.removeAfterAt?.toISOString() ?? null,
        })),
        totalEntries: entries.length,
        complete,
        nextCursor: complete ? null : selected.at(-1)![0],
      };
    });
  }
  async planInTransaction(
    tx: Prisma.TransactionClient,
    chatId: string,
    intentInput: NetworkNavigationAllowlistIntent,
    expected: NetworkNavigationAllowlistWitness,
    actorUserId: string,
    validateOnly: boolean,
  ): Promise<NetworkNavigationAllowlistImpact> {
    const revision = await this.lock(tx, chatId);
    await assertLegacyLinkAllowlistWrite(tx, chatId);
    const now = new Date();
    const rows = await this.rows(tx, chatId);
    const actual = this.witness(revision, rows, now);
    if (
      expected.revision !== actual.revision ||
      expected.nextExpiryAt !== actual.nextExpiryAt ||
      Date.parse(expected.observedAt) > +now ||
      Date.parse(expected.observedAt) < +now - 10 * 60_000 ||
      (expected.nextExpiryAt && Date.parse(expected.nextExpiryAt) <= +now)
    )
      throw conflict();
    const intent = normalizeNetworkAllowlistIntent(intentInput);
    const before = this.active(rows, now);
    const after = new Map(before);
    let noops = 0;
    const expiry = (raw: string | null) => {
      const value = raw === null ? null : new Date(raw);
      if (value && +value <= +now)
        throw new BadRequestException('Срок удаления должен быть в будущем.');
      return value;
    };
    if (intent.mode === 'replace') {
      after.clear();
      for (const entry of intent.entries)
        after.set(canonicalTarget(entry).normalizedValue, {
          kind: entry.kind,
          aliases: [],
          removeAfterAt: expiry(entry.removeAfterAt),
        });
    } else
      for (const action of intent.actions) {
        const key = canonicalTarget(action.target).normalizedValue;
        const old = after.get(key);
        if (action.op === 'remove') {
          if (!after.delete(key)) noops++;
          continue;
        }
        if (action.op === 'setExpiry' && !old)
          throw new BadRequestException(
            'Ссылка отсутствует или её срок уже истёк. Добавьте её явно.',
          );
        const removeAfterAt =
          action.op === 'add' && !Object.hasOwn(action, 'removeAfterAt')
            ? (old?.removeAfterAt ?? null)
            : expiry(action.removeAfterAt ?? null);
        if (
          old &&
          (old.removeAfterAt?.toISOString() ?? null) === (removeAfterAt?.toISOString() ?? null)
        )
          noops++;
        after.set(key, { kind: action.target.kind, aliases: old?.aliases ?? [], removeAfterAt });
      }
    const touched = new Set(
      intent.mode === 'replace'
        ? [
            ...rows.map((row) => parseStoredAllowlistEntry(row.domain)!.normalizedValue),
            ...after.keys(),
          ]
        : intent.actions.map((action) => canonicalTarget(action.target).normalizedValue),
    );
    const aliasesByTarget = new Map<string, Row[]>();
    for (const row of rows) {
      const key = parseStoredAllowlistEntry(row.domain)!.normalizedValue;
      aliasesByTarget.set(key, [...(aliasesByTarget.get(key) ?? []), row]);
    }
    const deletedDomains: string[] = [];
    const updates: Array<{ domains: string[]; removeAfterAt: Date | null }> = [];
    const creates: Array<{ chatId: string; domain: string; removeAfterAt: Date | null }> = [];
    for (const key of touched) {
      const aliases = aliasesByTarget.get(key) ?? [];
      const desired = after.get(key);
      const previous = before.get(key);
      if (!desired) {
        deletedDomains.push(...aliases.map((row) => row.domain));
        continue;
      }
      if (
        previous &&
        (previous.removeAfterAt?.toISOString() ?? null) ===
          (desired.removeAfterAt?.toISOString() ?? null)
      ) {
        if (intent.mode === 'replace') noops++;
        continue;
      }
      if (aliases.length)
        updates.push({
          domains: aliases.map((row) => row.domain),
          removeAfterAt: desired.removeAfterAt,
        });
      else creates.push({ chatId, domain: key, removeAfterAt: desired.removeAfterAt });
    }
    // FLAG: Bound physical rows, including legacy aliases, before any mutation. Semantic size alone is insufficient.
    if (rows.length - deletedDomains.length + creates.length > NETWORK_ALLOWLIST_PLAN_ROW_LIMIT)
      throw allowlistPlanTooLarge();
    const impact = {
      entityId: chatId,
      before: before.size,
      after: after.size,
      added: [...after.keys()].filter((k) => !before.has(k)).length,
      removed: [...before.keys()].filter((k) => !after.has(k)).length,
      expiryChanged: [...after].filter(
        ([k, v]) =>
          before.has(k) &&
          (before.get(k)!.removeAfterAt?.toISOString() ?? null) !==
            (v.removeAfterAt?.toISOString() ?? null),
      ).length,
      noops,
    };
    if (validateOnly) return impact;
    // FLAG: Preserve target-owned creation dates and unchanged aliases; identical intent performs no list writes.
    if (deletedDomains.length)
      await tx.domainAllowlist.deleteMany({ where: { chatId, domain: { in: deletedDomains } } });
    for (const update of updates)
      await tx.domainAllowlist.updateMany({
        where: { chatId, domain: { in: update.domains } },
        data: { removeAfterAt: update.removeAfterAt },
      });
    if (creates.length) await tx.domainAllowlist.createMany({ data: creates });
    await tx.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action: 'UPDATE_DOMAIN_ALLOWLIST',
        payload: {
          source: 'miniapp',
          mode: intent.mode,
          actionCount: intent.mode === 'edit' ? intent.actions.length : intent.entries.length,
          impact,
        },
      },
    });
    return impact;
  }
  async assertWitnessInTransaction(
    tx: Prisma.TransactionClient,
    chatId: string,
    expected: NetworkNavigationAllowlistWitness,
  ): Promise<void> {
    const revision = await this.lock(tx, chatId);
    const now = new Date();
    const actual = this.witness(revision, await this.rows(tx, chatId), now);
    if (
      expected.revision !== actual.revision ||
      expected.nextExpiryAt !== actual.nextExpiryAt ||
      (expected.nextExpiryAt !== null && Date.parse(expected.nextExpiryAt) <= +now)
    )
      throw conflict();
  }
  async validate(
    chatId: string,
    intent: NetworkNavigationAllowlistIntent,
    witness: NetworkNavigationAllowlistWitness,
    actorUserId: string,
  ) {
    return this.prisma.$transaction((tx) =>
      this.planInTransaction(tx, chatId, intent, witness, actorUserId, true),
    );
  }
  async commitOnly(
    chatId: string,
    recipient: NetworkSettingsRecipient,
    intent: NetworkNavigationAllowlistIntent,
    actorUserId: string,
    options: NetworkSettingsWriteOptions,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx, chatId);
      const settings = await tx.chatSettings.findUnique({
        where: { chatId },
        select: { updatedAt: true },
      });
      if (settings?.updatedAt.toISOString() !== recipient.revision) throw conflict();
      const impact = await this.planInTransaction(
        tx,
        chatId,
        intent,
        recipient.navigationAllowlistWitness!,
        actorUserId,
        Boolean(options.validateOnly),
      );
      if (!options.validateOnly) await options.onCommitted?.(tx, String(recipient.revision));
      return impact;
    });
  }
}
