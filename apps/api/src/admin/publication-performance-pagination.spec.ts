import {
  publicationAdminAccessWhere,
  publicationAdminLifecycleWhere,
  publicationAdminScope,
} from './publication-admin-access';
import {
  decodePublicationListCursor,
  encodePublicationListCursor,
  type PublicationDeliveryStats,
} from '@maxim/contracts/publication';
import { ConfigService } from '@nestjs/config';
import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import {
  PUBLICATION_DELIVERY_PRESENTATION_INCLUDE,
  PublicationPresenterService,
  type PublicationActionableDeliveryStatsRow,
} from './publication-presenter.service';
import { PublicationService } from './publication.service';
import {
  LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
  LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
} from './publication-legacy-automated-absence';

const EMPTY_DELIVERY_STATS: PublicationDeliveryStats = {
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  ambiguous: 0,
  canceled: 0,
};

type PublicationDeliveryPageRow = Pick<
  Prisma.ManagedBroadcastDeliveryGetPayload<{
    include: typeof PUBLICATION_DELIVERY_PRESENTATION_INCLUDE;
  }>,
  | 'id'
  | 'targetChatId'
  | 'status'
  | 'attemptCount'
  | 'remoteMessageId'
  | 'lastError'
  | 'sentAt'
  | 'createdAt'
  | 'nextAttemptAt'
  | 'waitReason'
  | 'firstDeferredAt'
  | 'broadcast'
  | 'contentRevision'
  | 'publicationOccurrence'
>;

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return (Array.isArray(strings) ? strings.join('?') : String(query)).replace(/\s+/gu, ' ').trim();
}

function extractSqlValues(query: unknown): readonly unknown[] {
  return (query as { values?: readonly unknown[] } | null)?.values ?? [];
}

function publicationRow(id: string, updatedAt = new Date('2026-07-10T09:00:00.000Z')) {
  return {
    id,
    title: `Публикация ${id}`,
    lifecycle: PublicationLifecycle.ACTIVE,
    version: 1,
    audienceSelection: 'SELECTED',
    audienceMode: 'SNAPSHOT',
    canonicalContentRevision: { text: `Текст ${id}`, assets: [] },
    targets: [],
    schedule: null,
    occurrences: [],
    createdAt: new Date('2026-07-10T08:00:00.000Z'),
    updatedAt,
  };
}

function createPublicationService(prisma: Record<string, unknown>) {
  const presenter = new PublicationPresenterService(prisma as never);
  const publisherRouting = {
    requireNewRoute: jest.fn().mockReturnValue({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
    }),
  };
  const service = new PublicationService(
    prisma as never,
    {} as never,
    presenter,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    publisherRouting as never,
    { enqueueAfterCommittedMutation: jest.fn().mockResolvedValue(undefined) } as never,
    new ConfigService({ PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: 'off' }),
  );
  return { presenter, publisherRouting, service };
}

describe('Publication performance and pagination', () => {
  it('loads delivery aggregates once for the whole publication page', async () => {
    const rows = [publicationRow('publication-2'), publicationRow('publication-1')];
    const groupBy = jest.fn();
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          publicationId: 'publication-2',
          status: ManagedBroadcastDeliveryStatus.SENT,
          count: 3n,
        },
        {
          publicationId: 'publication-1',
          status: ManagedBroadcastDeliveryStatus.FAILED,
          count: 2n,
        },
      ])
      .mockResolvedValueOnce([
        {
          publicationId: 'publication-2',
          status: ManagedBroadcastDeliveryStatus.SENT,
          count: 3n,
          dispatchPending: 0n,
        },
      ] satisfies PublicationActionableDeliveryStatsRow[]);
    const prisma = {
      publication: { findMany: jest.fn().mockResolvedValue(rows) },
      managedBroadcastDelivery: { groupBy },
      $queryRaw: queryRaw,
    };
    const { service } = createPublicationService(prisma);

    const result = await service.list({ userId: 'user-1' } as never, {
      view: 'plan',
      limit: 2,
    });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(groupBy).not.toHaveBeenCalled();
    expect(result.items.map((item) => item.delivery)).toEqual([
      { ...EMPTY_DELIVERY_STATS, total: 3, sent: 3 },
      { ...EMPTY_DELIVERY_STATS, total: 2, failed: 2 },
    ]);
    expect(result.items.map((item) => item.actionableDelivery)).toEqual([
      { ...EMPTY_DELIVERY_STATS, total: 3, sent: 3, dispatchPending: 0 },
      { ...EMPTY_DELIVERY_STATS, dispatchPending: 0 },
    ]);
  });

  it('lists one-time publications with other scheduled publications', async () => {
    const prisma = {
      publication: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const { service } = createPublicationService(prisma);

    await service.list({ userId: 'user-1' } as never, {
      view: 'schedules',
      limit: 30,
    });

    expect(prisma.publication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              schedule: {
                is: {
                  mode: {
                    in: [
                      PublicationScheduleMode.ONCE,
                      PublicationScheduleMode.SLOTS,
                      PublicationScheduleMode.RECURRENCE,
                    ],
                  },
                },
              },
            },
          ],
        }),
      }),
    );
  });

  it('keeps the current view exclusive to immediate publications', async () => {
    const prisma = {
      publication: { findMany: jest.fn().mockResolvedValue([]) },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const { service } = createPublicationService(prisma);

    await service.list({ userId: 'user-1' } as never, {
      view: 'current',
      limit: 30,
    });

    expect(prisma.publication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ schedule: { is: { mode: PublicationScheduleMode.NOW } } }],
        }),
      }),
    );
  });

  it('scopes list reads to the immutable dispatch profile', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service } = createPublicationService({
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    });

    await service.list(
      { userId: 'user-1' } as never,
      { view: 'plan', limit: 30 },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ...publicationAdminAccessWhere(
            publicationAdminScope('user-1', 'publisher-bot'),
            PublicationDispatchProfile.PUBLIK_V1,
          ),
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        }),
      }),
    );
  });

  it('loads sanitized Publisher dispatch issues once for the authorized list page', async () => {
    const rows = ['publication-publik-1', 'publication-publik-2'].map((id) => ({
      ...publicationRow(id),
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
    }));
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          publicationId: rows[0]!.id,
          occurrenceId: 'occurrence-publik-1',
          blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
        },
        {
          publicationId: rows[1]!.id,
          occurrenceId: 'occurrence-publik-2',
          blockerCode: 'PUBLISHER_RUNTIME_UNAVAILABLE',
        },
      ]);
    const findMany = jest.fn().mockResolvedValue(rows);
    const { service } = createPublicationService({
      publication: { findMany },
      $queryRaw: queryRaw,
    });

    const result = await service.list(
      { userId: 'actor-1' } as never,
      { view: 'plan', limit: 30 },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(result.items.map((item) => item.dispatchIssue)).toEqual([
      'actor_access_required',
      'temporarily_unavailable',
    ]);
    expect(JSON.stringify(result)).not.toContain('PUBLISHER_ACTOR_ACCESS_REQUIRED');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ...publicationAdminAccessWhere(
            publicationAdminScope('actor-1', 'publisher-bot'),
            PublicationDispatchProfile.PUBLIK_V1,
          ),
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        }),
      }),
    );
    const issueSql = extractSqlText(queryRaw.mock.calls[2]?.[0]);
    expect(issueSql).toContain('publication."actor_user_id" = ?');
    expect(issueSql).toContain('publication."dispatch_profile" = CAST(');
    expect(issueSql).toContain('FROM "managed_broadcast_deliveries" AS delivery');
    expect(issueSql).toContain('current_occurrence."hasExecutionDeliveries" = FALSE');
    expect(issueSql).toContain('publication."lifecycle" IN (');
    expect(issueSql).toContain('schedule."status" IN (');
    expect(extractSqlValues(queryRaw.mock.calls[2]?.[0])).toEqual(
      expect.arrayContaining([
        'publication-publik-1',
        'publication-publik-2',
        'actor-1',
        'publisher-bot',
        PublicationDispatchProfile.PUBLIK_V1,
      ]),
    );
    expect(issueSql).toContain('access_edge."user_id" = ?');
    expect(issueSql).toContain('access_edge."bot_id" = ?');
  });

  it('searches PUBLIK_V1 targets only through the exact active Publisher catalog', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'publication-match', updatedAt: new Date() }]);
    const publicationFindMany = jest.fn().mockResolvedValue([]);
    const { service } = createPublicationService({
      publication: { findMany: publicationFindMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: queryRaw,
    });

    await service.list(
      { userId: 'user-1' } as never,
      { view: 'plan', query: 'Публика', limit: 30 },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    const catalogSearchSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    const catalogSearchValues = extractSqlValues(queryRaw.mock.calls[0]?.[0]);
    expect(catalogSearchSql).toContain('FROM "publications" AS publication');
    expect(catalogSearchSql).toContain('publication."actor_user_id" = ?');
    expect(catalogSearchSql).toContain('FROM "managed_bot_chat_catalog" AS catalog');
    expect(catalogSearchSql).toContain('INNER JOIN LATERAL');
    expect(catalogSearchSql).toContain('catalog."status" = \'ACTIVE\'');
    expect(catalogSearchSql).toContain('catalog."entity_type" = target."entity_type"');
    expect(catalogSearchSql).toContain('WHERE target."publication_id" = publication."id"');
    expect(catalogSearchSql).toMatch(/LIMIT \?$/u);
    expect(catalogSearchValues).toEqual(
      expect.arrayContaining(['user-1', 'publisher-bot', '%Публика%']),
    );
    expect(catalogSearchValues.at(-1)).toBe(31);
    expect(publicationFindMany.mock.calls[0]?.[0].where).toMatchObject({
      ...publicationAdminAccessWhere(
        publicationAdminScope('user-1', 'publisher-bot'),
        PublicationDispatchProfile.PUBLIK_V1,
      ),
      dispatchProfile: 'PUBLIK_V1',
      id: { in: ['publication-match'] },
    });
    expect(publicationFindMany.mock.calls[0]?.[0].where.AND).toEqual([
      publicationAdminLifecycleWhere(publicationAdminScope('user-1', 'publisher-bot'), [
        PublicationLifecycle.ACTIVE,
        PublicationLifecycle.PAUSED,
        PublicationLifecycle.ERROR,
      ]),
    ]);
  });

  it('hides publication details owned by another dispatch profile', async () => {
    const { presenter, service } = createPublicationService({});
    jest.spyOn(presenter, 'loadPublicationDetailsRow').mockResolvedValue({
      dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
    } as never);
    const mapDetails = jest.spyOn(presenter, 'mapPublicationDetails');

    await expect(
      service.get(
        'publication-legacy',
        { userId: 'user-1' } as never,
        PublicationDispatchProfile.PUBLIK_V1,
      ),
    ).rejects.toThrow('Публикация не найдена.');
    expect(mapDetails).not.toHaveBeenCalled();
  });

  it('scopes Publisher details to the authenticated actor and dispatch profile in Prisma', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const { service } = createPublicationService({ publication: { findFirst } });

    await expect(
      service.get(
        'publication-publik',
        { userId: 'actor-1' } as never,
        PublicationDispatchProfile.PUBLIK_V1,
      ),
    ).rejects.toThrow('Публикация не найдена.');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'publication-publik',
          ...publicationAdminAccessWhere(
            publicationAdminScope('actor-1', 'publisher-bot'),
            PublicationDispatchProfile.PUBLIK_V1,
          ),
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        },
      }),
    );
  });

  it('hydrates PUBLIK_V1 details with the exact Publisher catalog presentation', async () => {
    const { presenter, publisherRouting, service } = createPublicationService({});
    const row = {
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      targets: [{ targetChatId: 'chat-1', entityType: 'CHAT' }],
    };
    const presentations = new Map();
    jest.spyOn(presenter, 'loadPublicationDetailsRow').mockResolvedValue(row as never);
    const loadPresentations = jest
      .spyOn(presenter, 'loadPublisherTargetPresentations')
      .mockResolvedValue(presentations);
    const mapDetails = jest
      .spyOn(presenter, 'mapPublicationDetails')
      .mockResolvedValue({ id: 'publication-publisher' } as never);

    await service.get(
      'publication-publisher',
      { userId: 'user-1' } as never,
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(publisherRouting.requireNewRoute).toHaveBeenCalled();
    expect(loadPresentations).toHaveBeenCalledWith(row.targets, 'publisher-bot');
    expect(mapDetails).toHaveBeenCalledWith(row, presentations);
  });

  it('uses the same current-revision failure selector for immediate publications', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const findMany = jest.fn();
    const { service } = createPublicationService({
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: queryRaw,
    });

    await service.list(
      { userId: 'user-1' } as never,
      {
        view: 'current',
        status: 'failed',
        limit: 30,
      },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    const selectorSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(selectorSql).toContain('schedule."mode" = \'NOW\'::"PublicationScheduleMode"');
    expect(selectorSql).toContain('occurrence."schedule_revision" = schedule."revision"');
    expect(selectorSql).toContain(
      'publication."dispatch_profile" = CAST(? AS "PublicationDispatchProfile")',
    );
    expect(extractSqlValues(queryRaw.mock.calls[0]?.[0])).toContain(
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('uses the exact active Publisher catalog in failed-publication target search', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createPublicationService({
      publication: { findMany: jest.fn() },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: queryRaw,
    });

    await service.list(
      { userId: 'user-1' } as never,
      {
        view: 'current',
        status: 'failed',
        query: 'Публик',
        limit: 30,
      },
      PublicationDispatchProfile.PUBLIK_V1,
    );

    const selectorSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    const selectorValues = extractSqlValues(queryRaw.mock.calls[0]?.[0]);
    expect(selectorSql).toContain('FROM "managed_bot_chat_catalog" AS catalog');
    expect(selectorSql).toContain('catalog."status" = \'ACTIVE\'');
    expect(selectorSql).toContain('catalog."entity_type" = target."entity_type"');
    expect(selectorSql).not.toContain('INNER JOIN "chats" AS chat');
    expect(selectorValues).toContain('publisher-bot');
    expect(selectorValues).toContain('%Публик%');
  });

  it('paginates schedule errors and active current-revision failures without obsolete-only rows', async () => {
    const updatedAt = new Date('2026-07-10T09:00:00.000Z');
    const cursorUpdatedAt = new Date('2026-07-10T10:00:00.000Z');
    const row = {
      ...publicationRow('publication-active-recurrence', updatedAt),
      lifecycle: PublicationLifecycle.ACTIVE,
      schedule: {
        id: 'schedule-1',
        mode: PublicationScheduleMode.RECURRENCE,
        timezone: 'Europe/Moscow',
        rule: {
          mode: 'recurrence',
          timezone: 'Europe/Moscow',
          frequency: 'daily',
          interval: 1,
          weekdays: [],
          times: ['10:00'],
          startsAt: null,
          endsAt: null,
          maxOccurrences: null,
          replaceConflicts: false,
        },
        revision: 4,
        status: PublicationScheduleStatus.ACTIVE,
        lastError: null,
      },
      occurrences: [
        {
          id: 'occurrence-future',
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduledAt: new Date('2026-07-11T10:00:00.000Z'),
        },
      ],
    };
    const scheduleErrorRow = {
      ...publicationRow('publication-schedule-error', new Date('2026-07-10T08:30:00.000Z')),
      lifecycle: PublicationLifecycle.ERROR,
      schedule: {
        ...row.schedule,
        id: 'schedule-error',
        revision: 5,
        status: PublicationScheduleStatus.ERROR,
        lastError: 'Расписание не содержит будущих запусков.',
      },
      occurrences: [],
    };
    const obsoleteOnlyId = 'publication-obsolete-only';
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        { id: row.id, updatedAt },
        { id: scheduleErrorRow.id, updatedAt: scheduleErrorRow.updatedAt },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const findMany = jest.fn().mockResolvedValue([row, scheduleErrorRow]);
    const prisma = {
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: queryRaw,
    };
    const { service } = createPublicationService(prisma);
    const cursor = encodePublicationListCursor({
      v: 1,
      updatedAt: cursorUpdatedAt.toISOString(),
      id: 'publication-z',
      view: 'schedules',
      query: '',
      status: 'failed',
    });

    const result = await service.list({ userId: 'user-1' } as never, {
      view: 'schedules',
      status: 'failed',
      cursor,
      limit: 3,
    });

    expect(result.items.map((item) => item.id)).toEqual([row.id, scheduleErrorRow.id]);
    expect(result.items.map((item) => item.id)).not.toContain(obsoleteOnlyId);
    expect(result.items[0]?.lifecycle).toBe('ACTIVE');
    expect(result.items[0]?.schedule?.nextOccurrenceAt).toBe('2026-07-11T10:00:00.000Z');
    expect(result.items[1]?.lifecycle).toBe('ERROR');
    expect(result.items[1]?.schedule?.lastError).toBe('Расписание не содержит будущих запусков.');
    expect(queryRaw).toHaveBeenCalledTimes(3);
    const aggregateSql = queryRaw.mock.calls.map(([query]) => extractSqlText(query)).join(' ');
    const aggregateValues = queryRaw.mock.calls.flatMap(([query]) => [...extractSqlValues(query)]);
    expect(aggregateSql).toContain('delivery."last_error" = ?');
    expect(aggregateValues).toEqual(
      expect.arrayContaining([
        LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
        LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
      ]),
    );
    const selectorSql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(selectorSql).toContain('occurrence."schedule_revision" = schedule."revision"');
    expect(selectorSql).toContain(
      '(publication."lifecycle" = \'ERROR\'::"PublicationLifecycle" AND TRUE) OR EXISTS',
    );
    expect(selectorSql).toContain(
      '\'FAILED\'::"PublicationOccurrenceStatus", \'PARTIAL\'::"PublicationOccurrenceStatus", \'AMBIGUOUS\'::"PublicationOccurrenceStatus"',
    );
    expect(selectorSql).toContain('publication."updated_at" < ?');
    expect(selectorSql).toContain('publication."id" < ?');
    expect(selectorSql).toMatch(
      /ORDER BY publication\."updated_at" DESC, publication\."id" DESC LIMIT \?$/u,
    );
    expect(extractSqlValues(queryRaw.mock.calls[0]?.[0]).at(-1)).toBe(4);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          lifecycle: {
            in: [
              PublicationLifecycle.ACTIVE,
              PublicationLifecycle.PAUSED,
              PublicationLifecycle.ERROR,
            ],
          },
          id: { in: [row.id, scheduleErrorRow.id] },
        }),
        take: 4,
      }),
    );
  });

  it('binds an opaque cursor to the list filters and applies an explicit keyset predicate', async () => {
    const updatedAt = new Date('2026-07-10T09:00:00.000Z');
    const firstPageRows = [
      publicationRow('publication-z', updatedAt),
      publicationRow('publication-y', updatedAt),
    ];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(firstPageRows)
      .mockResolvedValueOnce([publicationRow('publication-y', updatedAt)]);
    const prisma = {
      publication: { findMany },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const { service } = createPublicationService(prisma);

    const firstPage = await service.list({ userId: 'user-1' } as never, {
      view: 'plan',
      query: 'Текст',
      limit: 1,
    });
    const cursor = firstPage.nextCursor;
    expect(cursor).not.toBe('publication-z');
    expect(cursor && decodePublicationListCursor(cursor)).toEqual({
      v: 1,
      updatedAt: updatedAt.toISOString(),
      id: 'publication-z',
      view: 'plan',
      query: 'Текст',
    });

    await service.list({ userId: 'user-1' } as never, {
      view: 'plan',
      query: 'Текст',
      cursor: cursor ?? undefined,
      limit: 1,
    });

    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            {
              OR: [
                { title: { contains: 'Текст', mode: 'insensitive' } },
                {
                  canonicalContentRevision: {
                    is: { text: { contains: 'Текст', mode: 'insensitive' } },
                  },
                },
                {
                  targets: {
                    some: { chat: { title: { contains: 'Текст', mode: 'insensitive' } } },
                  },
                },
              ],
            },
            {
              OR: [{ updatedAt: { lt: updatedAt } }, { updatedAt, id: { lt: 'publication-z' } }],
            },
          ],
        }),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );
    expect(findMany.mock.calls[1]?.[0]).not.toHaveProperty('cursor');
    expect(findMany.mock.calls[1]?.[0]).not.toHaveProperty('skip');

    await expect(
      service.list({ userId: 'user-1' } as never, {
        view: 'history',
        query: 'Текст',
        cursor: cursor ?? undefined,
        limit: 1,
      }),
    ).rejects.toThrow('Курсор списка публикаций недействителен.');
  });

  it('paginates deliveries with a limit-plus-one query and a Prisma cursor', async () => {
    const deliveryRow = (
      id: string,
      targetChatId: string,
      contentRevisionId = 'content-current',
      contentRevision = 2,
    ): PublicationDeliveryPageRow => ({
      id,
      targetChatId,
      status: ManagedBroadcastDeliveryStatus.PENDING,
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-07-10T09:00:00.000Z'),
      nextAttemptAt: null,
      waitReason: null,
      firstDeferredAt: null,
      broadcast: { entityType: ChatEntityType.CHAT, status: ManagedBroadcastStatus.ACTIVE },
      contentRevision: { id: contentRevisionId, revision: contentRevision, postPublish: null },
      publicationOccurrence: {
        id: 'occurrence-1',
        status: PublicationOccurrenceStatus.IN_PROGRESS,
        deliveryDeadlineAt: null,
        retryExpiresAt: null,
        publication: { canonicalContentRevisionId: 'content-current' },
      },
    });
    const legacyAbsenceRow = {
      ...deliveryRow('delivery-legacy-absence', 'chat-1'),
      status: ManagedBroadcastDeliveryStatus.FAILED,
      remoteMessageId: 'remote-message',
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptCount: 3,
      remoteMessageVerificationAbsentCount: 3,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationAttemptedAt: new Date('2026-07-10T09:05:00.000Z'),
      remoteMessageVerificationNextAt: null,
      remoteMessageVerificationLastError: LEGACY_PUBLICATION_EXACT_ABSENCE_ERROR,
      remoteMessageVerificationSource: null,
      legacySentWithoutRemoteId: false,
      lastErrorCode: null,
      lastError: LEGACY_PUBLICATION_DISAPPEARANCE_LAST_ERROR,
      sentAt: new Date('2026-07-10T09:00:00.000Z'),
      lockedAt: null,
      lockToken: null,
      publicationOccurrenceId: 'occurrence-1',
    };
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([
        deliveryRow('delivery-3', 'chat-3'),
        deliveryRow('delivery-2', 'chat-2', 'content-old', 1),
        deliveryRow('delivery-1', 'chat-1'),
      ])
      .mockResolvedValueOnce([deliveryRow('delivery-1', 'chat-1')])
      .mockResolvedValueOnce([legacyAbsenceRow]);
    const prisma = {
      publication: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'publication-1',
          version: 1,
          lifecycle: PublicationLifecycle.ACTIVE,
        }),
      },
      managedBroadcastDelivery: { findMany },
      chat: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'chat-1', title: 'Чат 1' },
          { id: 'chat-2', title: 'Чат 2' },
          { id: 'chat-3', title: 'Чат 3' },
        ]),
      },
    };
    const { service } = createPublicationService(prisma);
    const user = { userId: 'user-1' } as never;
    const query = {
      occurrenceId: 'occurrence-1',
      excludeStatus: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      limit: 2,
    };

    const firstPage = await service.listDeliveries('publication-1', user, query);

    expect(firstPage.items.map((item) => item.id)).toEqual(['delivery-3', 'delivery-2']);
    expect(firstPage.items.map((item) => item.dispatchStopped)).toEqual([false, false]);
    expect(
      firstPage.items.map(({ contentRevision, usesLatestContent }) => ({
        contentRevision,
        usesLatestContent,
      })),
    ).toEqual([
      { contentRevision: 2, usesLatestContent: true },
      { contentRevision: 1, usesLatestContent: false },
    ]);
    expect(firstPage.nextCursor).toBe('delivery-2');
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          publicationOccurrence: {
            is: { publicationId: 'publication-1', id: 'occurrence-1' },
          },
          OR: expect.any(Array),
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
        include: {
          broadcast: { select: { entityType: true, status: true } },
          contentRevision: { select: { id: true, revision: true, postPublish: true } },
          publicationOccurrence: {
            select: {
              id: true,
              status: true,
              deliveryDeadlineAt: true,
              retryExpiresAt: true,
              publication: { select: { canonicalContentRevisionId: true } },
            },
          },
        },
      }),
    );
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('cursor');
    expect(findMany.mock.calls[0]?.[0]).not.toHaveProperty('skip');

    const secondPage = await service.listDeliveries('publication-1', user, {
      ...query,
      cursor: firstPage.nextCursor ?? undefined,
    });

    expect(secondPage.items.map((item) => item.id)).toEqual(['delivery-1']);
    expect(secondPage.nextCursor).toBeNull();
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3,
        cursor: { id: 'delivery-2' },
        skip: 1,
      }),
    );

    const ambiguousPage = await service.listDeliveries('publication-1', user, {
      occurrenceId: 'occurrence-1',
      status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      limit: 2,
    });
    expect(ambiguousPage.items).toEqual([
      expect.objectContaining({
        id: 'delivery-legacy-absence',
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
      }),
    ]);
    expect(findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
            expect.objectContaining({
              status: ManagedBroadcastDeliveryStatus.FAILED,
              remoteMessageVerificationAbsentCount: { gte: 3 },
            }),
          ]),
        }),
      }),
    );
  });

  it('loads occurrence delivery counts as grouped aggregates without nested delivery rows', async () => {
    const occurrence = {
      id: 'occurrence-1',
      publicationId: 'publication-1',
      scheduledAt: new Date('2026-07-10T09:00:00.000Z'),
      status: PublicationOccurrenceStatus.FAILED,
    };
    const publicationFindFirst = jest.fn().mockResolvedValue({
      ...publicationRow('publication-1'),
      occurrences: [occurrence],
    });
    const occurrenceFindMany = jest.fn().mockResolvedValue([occurrence]);
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ status: ManagedBroadcastDeliveryStatus.AMBIGUOUS, count: 2n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          publicationOccurrenceId: 'occurrence-1',
          status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          count: 2n,
        },
      ]);
    const prisma = {
      publication: { findFirst: publicationFindFirst },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: occurrenceFindMany,
      },
      managedBroadcastDelivery: { groupBy: jest.fn() },
      $queryRaw: queryRaw,
    };
    const presenter = new PublicationPresenterService(prisma as never);

    const row = await presenter.loadPublicationDetailsRow('publication-1', 'user-1');

    expect(publicationFindFirst.mock.calls[0]?.[0].include.occurrences.select).toEqual({
      dispatchFirstBlockedAt: true,
      dispatchBlockedAt: true,
      dispatchBlockerCode: true,
      id: true,
      scheduleId: true,
      scheduleRevision: true,
      contentRevisionId: true,
      legacyBroadcastId: true,
      scheduledAt: true,
      status: true,
      contentRevision: { select: { revision: true } },
      _count: { select: { legacyBroadcasts: true } },
    });
    expect(occurrenceFindMany.mock.calls[0]?.[0].select).toEqual({
      dispatchFirstBlockedAt: true,
      dispatchBlockedAt: true,
      dispatchBlockerCode: true,
      id: true,
      scheduleId: true,
      scheduleRevision: true,
      contentRevisionId: true,
      legacyBroadcastId: true,
      scheduledAt: true,
      status: true,
      contentRevision: { select: { revision: true } },
      _count: { select: { legacyBroadcasts: true } },
    });
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(row?.deliveryStats).toEqual({ ...EMPTY_DELIVERY_STATS, total: 2, ambiguous: 2 });
    expect(row?.occurrences[0]?.deliveryStats).toEqual({
      ...EMPTY_DELIVERY_STATS,
      total: 2,
      ambiguous: 2,
    });
    expect(row?.occurrences[0]?.status).toBe(PublicationOccurrenceStatus.AMBIGUOUS);
  });
});
