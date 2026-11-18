import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  managedEntityFavoriteLabelOverridesSchema,
  managedEntityNetworkEntriesQuerySchema,
  managedEntityNetworkEntriesResponseSchema,
  managedEntityNetworksResponseSchema,
  managedEntityTypeSchema,
  updateManagedEntityNetworkCompositionRequestSchema,
  type ManagedEntityFavoriteType,
  type ManagedEntityNetworkCompositionResponse,
  type ManagedEntityNetworkEntriesResponse,
  type ManagedEntityNetworksResponse,
  type ManagedEntityType,
} from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { Prisma, type Prisma as PrismaTypes } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { readNetworkCommunityRows } from './network-community-presentation';
import { MANAGED_ENTITY_FAVORITE_TYPE_ORDER } from './admin.service.support';
import {
  canonicalManagedEntityFavoriteType,
  lockManagedEntityFavorites,
  writeManagedEntityFavorites,
} from './managed-entity-favorites-writer';

const DEFAULT_LABELS: Record<ManagedEntityFavoriteType, string> = {
  important: 'Важные',
  watch: 'На контроле',
  broadcast: 'Автопостинг',
  test: 'Тестовые',
  partner: 'Партнеры',
  service: 'Служебные',
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parseEntityType(value: unknown): ManagedEntityType {
  const parsed = managedEntityTypeSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Допустимы только чаты или каналы.');
  return parsed.data;
}
export type ManagedEntityNetworkSelection = {
  entityIds: string[];
  compositionVersion: string;
  label: string;
};

@Injectable()
export class ManagedEntityNetworksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
  ) {}

  private visibleWhere(userId: string, entityType: ManagedEntityType): PrismaTypes.ChatWhereInput {
    // FLAG: Private favorites/navigation use only already proven moderation grants.
    // No TTL, allowlist fallback, Publisher grant or remote probe creates visibility.
    return {
      entityType: entityType === 'chat' ? 'CHAT' : 'CHANNEL',
      accessEdges: {
        some: {
          userId,
          entityType: entityType === 'chat' ? 'CHAT' : 'CHANNEL',
          state: 'GRANTED',
          userRole: { in: ['ADMIN', 'OWNER'] },
          botId: { in: this.registry.getAllBots().map((bot) => bot.id) },
        },
      },
    };
  }

  private async snapshot(
    tx: PrismaTypes.TransactionClient,
    userId: string,
    entityType: ManagedEntityType,
  ) {
    const [rows, preference] = await Promise.all([
      tx.managedEntityFavorite.findMany({
        where: {
          userId,
          entityType: entityType === 'chat' ? 'CHAT' : 'CHANNEL',
          chat: this.visibleWhere(userId, entityType),
        },
        select: { chatId: true, favoriteType: true },
        orderBy: { chatId: 'asc' },
      }),
      tx.managedEntityFavoritePreference.findUnique({
        where: { userId },
        select: { labelOverrides: true, revision: true },
      }),
    ]);
    const parsedLabels = managedEntityFavoriteLabelOverridesSchema.safeParse(
      preference?.labelOverrides ?? {},
    );
    if (!parsedLabels.success)
      throw new ServiceUnavailableException('Названия сеток временно недоступны.');
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = grouped.get(row.chatId) ?? [];
      group.push(row);
      grouped.set(row.chatId, group);
    }
    const assignments = new Map<string, ManagedEntityFavoriteType>();
    for (const [id, group] of grouped) {
      const favoriteType = canonicalManagedEntityFavoriteType(group);
      if (favoriteType) assignments.set(id, favoriteType);
    }
    const compositionVersion = digest(['networks-v1', userId, entityType, [...assignments]]);
    return {
      assignments,
      compositionVersion,
      labels: { ...DEFAULT_LABELS, ...parsedLabels.data },
      labelsRevision: preference?.revision ?? null,
    };
  }

  private selectionVersion(
    userId: string,
    entityType: ManagedEntityType,
    favoriteType: ManagedEntityFavoriteType,
    entityIds: string[],
  ) {
    return digest(['network-v1', userId, entityType, favoriteType, entityIds]);
  }

  async resolveSelection(
    user: AuthUser,
    entityType: ManagedEntityType,
    favoriteType: ManagedEntityFavoriteType,
  ): Promise<{ entityIds: string[]; compositionVersion: string; label: string }> {
    return this.prisma.$transaction(
      async (tx) => {
        const snapshot = await this.snapshot(tx, user.userId, entityType);
        const entityIds = [...snapshot.assignments]
          .filter(([, type]) => type === favoriteType)
          .map(([id]) => id);
        return {
          entityIds,
          compositionVersion: this.selectionVersion(
            user.userId,
            entityType,
            favoriteType,
            entityIds,
          ),
          label: snapshot.labels[favoriteType],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async withLockedSelection<T>(
    user: AuthUser,
    entityType: ManagedEntityType,
    favoriteType: ManagedEntityFavoriteType,
    work: (tx: Prisma.TransactionClient, selection: ManagedEntityNetworkSelection) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await lockManagedEntityFavorites(tx, user.userId, entityType);
      const snapshot = await this.snapshot(tx, user.userId, entityType);
      const entityIds = [...snapshot.assignments]
        .filter(([, type]) => type === favoriteType)
        .map(([id]) => id);
      return work(tx, {
        entityIds,
        compositionVersion: this.selectionVersion(user.userId, entityType, favoriteType, entityIds),
        label: snapshot.labels[favoriteType],
      });
    });
  }

  async catalogue(user: AuthUser, entityTypeRaw: string): Promise<ManagedEntityNetworksResponse> {
    const entityType = parseEntityType(entityTypeRaw);
    return this.prisma.$transaction(
      async (tx) => {
        const snapshot = await this.snapshot(tx, user.userId, entityType);
        return managedEntityNetworksResponseSchema.parse({
          entityType,
          compositionVersion: snapshot.compositionVersion,
          labelsRevision: snapshot.labelsRevision,
          items: MANAGED_ENTITY_FAVORITE_TYPE_ORDER.map((favoriteType) => {
            const ids = [...snapshot.assignments]
              .filter(([, type]) => type === favoriteType)
              .map(([id]) => id);
            return {
              favoriteType,
              label: snapshot.labels[favoriteType],
              entityCount: ids.length,
              compositionVersion: this.selectionVersion(user.userId, entityType, favoriteType, ids),
            };
          }),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  readCommunityPresentations(
    db: Pick<Prisma.TransactionClient, '$queryRaw'>,
    entityType: ManagedEntityType,
    authorizedIds: string[],
  ) {
    return readNetworkCommunityRows(
      db,
      entityType,
      this.registry.getAllBots().map((bot) => bot.id),
      {
        authorizedIds,
      },
    );
  }

  async entries(
    user: AuthUser,
    entityTypeRaw: string,
    input: unknown,
  ): Promise<ManagedEntityNetworkEntriesResponse> {
    const entityType = parseEntityType(entityTypeRaw);
    const parsed = managedEntityNetworkEntriesQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const query = parsed.data;
    return this.prisma.$transaction(
      async (tx) => {
        const snapshot = await this.snapshot(tx, user.userId, entityType);
        const binding = digest([
          user.userId,
          entityType,
          query.favoriteType ?? null,
          query.favoritesOnly,
          query.search,
        ]);
        const memberIds =
          query.favoriteType || query.favoritesOnly
            ? [...snapshot.assignments]
                .filter(([, type]) => !query.favoriteType || type === query.favoriteType)
                .map(([id]) => id)
            : null;
        const version = query.favoriteType
          ? this.selectionVersion(user.userId, entityType, query.favoriteType, memberIds!)
          : snapshot.compositionVersion;
        let after: string | undefined;
        if (query.cursor) {
          try {
            const cursor: unknown = JSON.parse(
              Buffer.from(query.cursor, 'base64url').toString('utf8'),
            );
            if (
              !cursor ||
              typeof cursor !== 'object' ||
              !('binding' in cursor) ||
              cursor.binding !== binding ||
              !('after' in cursor) ||
              typeof cursor.after !== 'string' ||
              cursor.after.length > 128 ||
              !('version' in cursor)
            )
              throw new Error('Invalid cursor');
            if (cursor.version !== version)
              throw new ConflictException({
                code: 'MANAGED_ENTITY_NETWORK_CURSOR_STALE',
                message: 'Состав сеток изменился. Обновите список.',
              });
            after = cursor.after;
          } catch (error) {
            if (error instanceof ConflictException) throw error;
            throw new BadRequestException('Недействительный курсор списка.');
          }
        }
        const rows = await readNetworkCommunityRows(
          tx,
          entityType,
          this.registry.getAllBots().map((bot) => bot.id),
          { userId: user.userId, memberIds, search: query.search, after, limit: query.limit + 1 },
        );
        const page = rows.slice(0, query.limit);
        return managedEntityNetworkEntriesResponseSchema.parse({
          entityType,
          compositionVersion: version,
          items: page.map((row) => ({
            ...row,
            entityType,
            favoriteType: snapshot.assignments.get(row.id) ?? null,
          })),
          nextCursor:
            rows.length > query.limit && page.length > 0
              ? Buffer.from(
                  JSON.stringify({
                    binding,
                    version: version,
                    after: page[page.length - 1]!.id,
                  }),
                ).toString('base64url')
              : null,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async updateComposition(
    user: AuthUser,
    entityTypeRaw: string,
    input: unknown,
  ): Promise<ManagedEntityNetworkCompositionResponse> {
    const entityType = parseEntityType(entityTypeRaw);
    const parsed = updateManagedEntityNetworkCompositionRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const changes = await writeManagedEntityFavorites(
      this.prisma,
      user.userId,
      entityType,
      parsed.data.changes,
      async (tx) => {
        const rows = await tx.chat.findMany({
          where: {
            AND: [
              this.visibleWhere(user.userId, entityType),
              { id: { in: parsed.data.changes.map((change) => change.entityId) } },
            ],
          },
          select: { id: true },
        });
        if (rows.length !== parsed.data.changes.length)
          throw new ForbiddenException('Нет доступа к одному из выбранных сообществ.');
      },
    );
    return { entityType, changes };
  }
}
