import { NETWORK_ALLOWLIST_PLAN_ROW_LIMIT } from '@maxim/contracts/network-settings';
import { assertBoundedAllowlistRows } from './network-navigation-allowlist';
import { assertLegacyLinkAllowlistWrite } from './link-rules-settings-policy';
import {
  addDomainRequestSchema,
  inferAllowlistMatchType,
  normalizeStoredAllowlistEntry,
  parseStoredAllowlistEntry,
  scheduleDomainRemovalRequestSchema,
  type AllowlistMatchType,
  type DomainAllowlistEntry,
  type NavigationAllowlistKind,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../prisma/prisma-client';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { mapWithConcurrencyLimit } from './admin-legacy-utils';
import type { AdminDomainAllowlistRuntimeContext } from './admin-domain-allowlist-runtime-context';
import {
  APPLY_SETTINGS_TO_ALL_DOMAIN_SYNC_CONCURRENCY,
  type AdminActionSource,
  type AdminReadBypassOptions,
} from './admin.service.support';

export class AdminDomainAllowlistRuntime {
  constructor(private readonly context: AdminDomainAllowlistRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private assertChatAdmin(chatId: string, userId: string): Promise<void> {
    return this.context.assertChatAdmin(chatId, userId);
  }

  async getDomainAllowlist(chatId: string, user: AuthUser): Promise<string[]> {
    await this.assertChatAdmin(chatId, user.userId);

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: { domain: 'asc' },
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    const normalizedRows = this.canonicalizeActiveAllowlistRows(rows);

    return normalizedRows.map((row) =>
      row.kind === 'WEB_DOMAIN' ? row.domain : row.normalizedValue,
    );
  }

  async getDomainAllowlistDetails(
    chatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<DomainAllowlistEntry[]> {
    if (!options.skipAdminCheck) {
      await this.assertChatAdmin(chatId, user.userId);
    }

    const rows = await this.prisma.domainAllowlist.findMany({
      where: this.activeDomainWhere(chatId),
      orderBy: [{ removeAfterAt: 'asc' }, { domain: 'asc' }],
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });

    return this.canonicalizeActiveAllowlistRows(rows);
  }

  async addDomain(
    chatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const parsed = addDomainRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const inputKind =
      parsed.data.kind ??
      parsed.data.matchType ??
      inferAllowlistMatchType(parsed.data.domain) ??
      'EXACT';
    const normalized = normalizeStoredAllowlistEntry(parsed.data.domain, inputKind);
    if (!normalized) {
      throw new BadRequestException('Invalid allowlist link');
    }
    const normalizedEntry = parseStoredAllowlistEntry(normalized);
    if (!normalizedEntry) {
      throw new BadRequestException('Invalid allowlist link');
    }

    await this.withAllowlistWrite(chatId, async (tx) => {
      await this.upsertNormalizedAllowlistDomain(tx, chatId, normalizedEntry.normalizedValue);

      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'ADD_DOMAIN',
          payload: {
            domain: normalizedEntry.domain,
            target: normalizedEntry.target,
            kind: normalizedEntry.kind,
            matchType: normalizedEntry.matchType,
            normalizedValue: normalizedEntry.normalizedValue,
            source,
          },
        },
      });
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async removeDomain(
    chatId: string,
    user: AuthUser,
    domain: string,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedEntry = this.parseMutationEntry(domain);
    if (!normalizedEntry) {
      throw new BadRequestException('Invalid allowlist link');
    }

    await this.withAllowlistWrite(chatId, async (tx) => {
      const matchingDomains = await this.findStoredAllowlistDomains(tx, chatId, normalizedEntry);
      if (matchingDomains.length === 0) {
        throw new BadRequestException('Link not found in allowlist');
      }

      await tx.domainAllowlist.deleteMany({
        where: {
          chatId,
          domain: {
            in: matchingDomains,
          },
        },
      });

      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'REMOVE_DOMAIN',
          payload: {
            domain: normalizedEntry.domain,
            target: normalizedEntry.target,
            kind: normalizedEntry.kind,
            matchType: normalizedEntry.matchType,
            normalizedValue: normalizedEntry.normalizedValue,
            source,
          },
        },
      });
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async scheduleDomainRemoval(
    chatId: string,
    user: AuthUser,
    domain: string,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ) {
    await this.assertChatAdmin(chatId, user.userId);
    const normalizedEntry = this.parseMutationEntry(domain);
    if (!normalizedEntry) {
      throw new BadRequestException('Invalid allowlist link');
    }
    const parsed = scheduleDomainRemovalRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    let removeAfterAt: Date | null = null;
    if (parsed.data.removeAfterAt) {
      const scheduledAt = new Date(parsed.data.removeAfterAt);
      if (Number.isNaN(scheduledAt.getTime())) {
        throw new BadRequestException('Invalid removal datetime');
      }

      if (scheduledAt.getTime() <= Date.now()) {
        throw new BadRequestException('Removal datetime must be in the future');
      }

      removeAfterAt = scheduledAt;
    }

    await this.withAllowlistWrite(chatId, async (tx) => {
      if (removeAfterAt && removeAfterAt.getTime() <= Date.now()) {
        throw new BadRequestException('Removal datetime must be in the future');
      }
      const matchingDomains = await this.findStoredAllowlistDomains(
        tx,
        chatId,
        normalizedEntry,
        true,
      );
      if (matchingDomains.length === 0) {
        throw new BadRequestException('Link not found in allowlist');
      }

      const updated = await tx.domainAllowlist.updateMany({
        where: {
          ...this.activeDomainWhere(chatId),
          domain: {
            in: matchingDomains,
          },
        },
        data: {
          removeAfterAt,
        },
      });
      if (updated.count === 0) {
        throw new BadRequestException('Link not found in active allowlist');
      }

      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: removeAfterAt ? 'SCHEDULE_DOMAIN_REMOVE' : 'CLEAR_DOMAIN_REMOVE_SCHEDULE',
          payload: {
            domain: normalizedEntry.domain,
            target: normalizedEntry.target,
            kind: normalizedEntry.kind,
            matchType: normalizedEntry.matchType,
            normalizedValue: normalizedEntry.normalizedValue,
            removeAfterAt: removeAfterAt ? removeAfterAt.toISOString() : null,
            source,
          },
        },
      });
    });
    await this.chatContextCache.invalidate(chatId);

    return { ok: true };
  }

  async syncDomainAllowlistToChatsForSettings(
    sourceChatId: string,
    targetChatIds: readonly string[],
  ): Promise<void> {
    await this.syncDomainAllowlistToChats(sourceChatId, targetChatIds);
  }

  private activeDomainWhere(chatId: string) {
    const now = new Date();
    return {
      chatId,
      OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: now } }],
    };
  }

  private parseMutationEntry(value: string) {
    const trimmed = value.trim();
    // FLAG: Legacy GET emits bare hosts for DOMAIN, but full URLs for WEB_EXACT.
    const domain =
      trimmed.includes('.') && !/[/:?#]/u.test(trimmed)
        ? normalizeStoredAllowlistEntry(trimmed, 'DOMAIN')
        : null;
    return parseStoredAllowlistEntry(domain ?? trimmed);
  }

  private withAllowlistWrite<T>(
    chatId: string,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // FLAG: Serialize every allowlist writer, including legacy aliases and bulk replacement.
      await tx.$queryRaw`SELECT chat.id FROM chats AS chat WHERE chat.id = ${chatId} FOR UPDATE OF chat`;
      await assertLegacyLinkAllowlistWrite(tx, chatId);
      return write(tx);
    });
  }

  private async syncDomainAllowlistToChats(
    sourceChatId: string,
    targetChatIds: readonly string[],
  ): Promise<void> {
    const rows = await this.prisma.domainAllowlist.findMany({
      take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1,
      orderBy: { domain: 'asc' },
      where: this.activeDomainWhere(sourceChatId),
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });
    assertBoundedAllowlistRows(rows);
    const sourceEntries = this.canonicalizeActiveAllowlistRows(rows);

    await mapWithConcurrencyLimit(
      [...new Set(targetChatIds)].filter((chatId) => chatId !== sourceChatId),
      APPLY_SETTINGS_TO_ALL_DOMAIN_SYNC_CONCURRENCY,
      async (chatId) => {
        await this.withAllowlistWrite(chatId, async (tx) => {
          assertBoundedAllowlistRows(
            await tx.domainAllowlist.findMany({
              where: { chatId },
              orderBy: { domain: 'asc' },
              take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1,
              select: { domain: true },
            }),
          );
          await tx.domainAllowlist.deleteMany({
            where: {
              chatId,
            },
          });
          for (const entry of sourceEntries) {
            if (entry.removeAfterAt && Date.parse(entry.removeAfterAt) <= Date.now()) continue;
            await tx.domainAllowlist.upsert({
              where: {
                chatId_domain: {
                  chatId,
                  domain: entry.normalizedValue,
                },
              },
              create: {
                chatId,
                domain: entry.normalizedValue,
                removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
              },
              update: {
                removeAfterAt: entry.removeAfterAt ? new Date(entry.removeAfterAt) : null,
              },
            });
          }
        });

        await this.chatContextCache.invalidate(chatId);
      },
    );
  }

  private async upsertNormalizedAllowlistDomain(
    tx: Prisma.TransactionClient,
    chatId: string,
    normalizedDomain: string,
  ) {
    const rows = await tx.domainAllowlist.findMany({
      take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1,
      orderBy: { domain: 'asc' },
      where: {
        chatId,
      },
      select: {
        domain: true,
        removeAfterAt: true,
      },
    });
    assertBoundedAllowlistRows(rows);

    const obsoleteDomains: string[] = rows
      .map((row: { domain: string }) => row.domain)
      .filter(
        (storedDomain: string) =>
          storedDomain !== normalizedDomain &&
          parseStoredAllowlistEntry(storedDomain)?.normalizedValue === normalizedDomain,
      );

    const activeEntry = this.canonicalizeActiveAllowlistRows(rows).find(
      (entry) => entry.normalizedValue === normalizedDomain,
    );
    const removeAfterAt = activeEntry?.removeAfterAt ? new Date(activeEntry.removeAfterAt) : null;
    await tx.domainAllowlist.upsert({
      where: {
        chatId_domain: {
          chatId,
          domain: normalizedDomain,
        },
      },
      create: {
        chatId,
        domain: normalizedDomain,
        ...(removeAfterAt ? { removeAfterAt } : {}),
      },
      update: {
        removeAfterAt,
      },
    });

    if (obsoleteDomains.length === 0) {
      return;
    }

    await tx.domainAllowlist.deleteMany({
      where: {
        chatId,
        domain: {
          in: obsoleteDomains,
        },
      },
    });
  }

  private async findStoredAllowlistDomains(
    tx: Prisma.TransactionClient,
    chatId: string,
    targetEntry: {
      normalizedValue: string;
      matchType: AllowlistMatchType;
    },
    activeOnly = false,
  ): Promise<string[]> {
    const rows = await tx.domainAllowlist.findMany({
      take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1,
      orderBy: { domain: 'asc' },
      where: activeOnly ? this.activeDomainWhere(chatId) : { chatId },
      select: {
        domain: true,
      },
    });
    assertBoundedAllowlistRows(rows);

    return rows
      .map((row: { domain: string }) => row.domain)
      .filter((storedDomain: string) => {
        const parsed = parseStoredAllowlistEntry(storedDomain);
        return (
          parsed?.normalizedValue === targetEntry.normalizedValue &&
          parsed.matchType === targetEntry.matchType
        );
      });
  }

  private canonicalizeActiveAllowlistRows(
    rows: Array<{ domain: string; removeAfterAt: Date | null }>,
  ): DomainAllowlistEntry[] {
    const byDomain = new Map<
      string,
      {
        domain: string;
        target: string;
        normalizedValue: string;
        matchType: AllowlistMatchType;
        kind: NavigationAllowlistKind;
        removeAfterAt: Date | null;
      }
    >();
    const now = Date.now();

    for (const row of rows) {
      if (row.removeAfterAt && row.removeAfterAt.getTime() <= now) continue;
      const normalizedEntry = parseStoredAllowlistEntry(row.domain);
      if (!normalizedEntry) {
        continue;
      }

      const current = byDomain.get(normalizedEntry.normalizedValue);
      if (current === undefined) {
        byDomain.set(normalizedEntry.normalizedValue, {
          ...normalizedEntry,
          removeAfterAt: row.removeAfterAt ?? null,
        });
        continue;
      }

      if (current.removeAfterAt === null || row.removeAfterAt == null) {
        current.removeAfterAt = null;
        continue;
      }

      if (row.removeAfterAt.getTime() > current.removeAfterAt.getTime()) {
        current.removeAfterAt = row.removeAfterAt;
      }
    }

    return Array.from(byDomain.values())
      .sort((leftEntry, rightEntry) => {
        if (leftEntry.removeAfterAt === null && rightEntry.removeAfterAt !== null) {
          return -1;
        }
        if (leftEntry.removeAfterAt !== null && rightEntry.removeAfterAt === null) {
          return 1;
        }
        if (leftEntry.removeAfterAt !== null && rightEntry.removeAfterAt !== null) {
          const byTime = leftEntry.removeAfterAt.getTime() - rightEntry.removeAfterAt.getTime();
          if (byTime !== 0) {
            return byTime;
          }
        }

        const byDomain = leftEntry.domain.localeCompare(rightEntry.domain);
        if (byDomain !== 0) {
          return byDomain;
        }

        return leftEntry.matchType.localeCompare(rightEntry.matchType);
      })
      .map((entry) => ({
        domain: entry.domain,
        target: entry.target,
        normalizedValue: entry.normalizedValue,
        matchType: entry.matchType,
        kind: entry.kind,
        removeAfterAt: entry.removeAfterAt ? entry.removeAfterAt.toISOString() : null,
      }));
  }
}
