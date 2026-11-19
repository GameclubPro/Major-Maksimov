import { publicationAdminAccessWhere, publicationAdminScope } from './publication-admin-access';
import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  isPublicationDeliveryDispatchStopped,
  PublicationPresenterService,
  type PublicationActionableDeliveryStatsRow,
} from './publication-presenter.service';

const EMPTY_DELIVERY = {
  total: 0,
  pending: 0,
  sent: 0,
  failed: 0,
  ambiguous: 0,
  canceled: 0,
};

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return (Array.isArray(strings) ? strings.join('?') : String(query)).replace(/\s+/gu, ' ').trim();
}

function extractSqlValues(query: unknown): readonly unknown[] {
  return (query as { values?: readonly unknown[] } | null)?.values ?? [];
}

describe('PublicationPresenterService', () => {
  it.each([
    [PublicationOccurrenceStatus.CANCELED, ManagedBroadcastStatus.ACTIVE, true],
    [PublicationOccurrenceStatus.SENT, ManagedBroadcastStatus.CANCELED, true],
    [PublicationOccurrenceStatus.IN_PROGRESS, ManagedBroadcastStatus.CANCELED, true],
    [PublicationOccurrenceStatus.CANCELED, ManagedBroadcastStatus.CANCELED, true],
    [PublicationOccurrenceStatus.SCHEDULED, ManagedBroadcastStatus.ACTIVE, false],
    [PublicationOccurrenceStatus.SENT, ManagedBroadcastStatus.COMPLETED, false],
    [PublicationOccurrenceStatus.FAILED, ManagedBroadcastStatus.FAILED, false],
    [null, ManagedBroadcastStatus.CANCELED, true],
    [null, ManagedBroadcastStatus.ACTIVE, false],
  ] as const)(
    'derives stopped dispatch from exact occurrence %s and envelope %s',
    (occurrenceStatus, broadcastStatus, expected) => {
      expect(
        isPublicationDeliveryDispatchStopped({
          publicationOccurrence: occurrenceStatus === null ? null : { status: occurrenceStatus },
          broadcast: { status: broadcastStatus },
        }),
      ).toBe(expected);
    },
  );

  it('counts actionable dispatch separately while preserving raw pending history and admin scope', async () => {
    const grouped = [
      {
        publicationId: 'publication-current',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        count: 5n,
        dispatchPending: 2n,
      },
      {
        publicationId: 'publication-current',
        status: ManagedBroadcastDeliveryStatus.SENDING,
        count: 3n,
        dispatchPending: 1n,
      },
      {
        publicationId: 'publication-current',
        status: ManagedBroadcastDeliveryStatus.SENT,
        count: 2n,
        dispatchPending: 0n,
      },
    ] satisfies PublicationActionableDeliveryStatsRow[];
    const queryRaw: jest.MockedFunction<PrismaService['$queryRaw']> = jest.fn();
    queryRaw
      .mockResolvedValueOnce(grouped)
      .mockResolvedValueOnce(grouped.map(({ status, count }) => ({ status, count })));
    const presenter = new PublicationPresenterService({ $queryRaw: queryRaw } as never);
    const scope = publicationAdminScope('admin-1', 'publisher-1');

    const actionable = await presenter.loadActionableDeliveryStatsByPublicationIds(
      ['publication-current', 'publication-empty', 'publication-current'],
      scope,
    );
    expect(actionable.get('publication-current')).toEqual({
      ...EMPTY_DELIVERY,
      total: 10,
      pending: 8,
      sent: 2,
      dispatchPending: 3,
    });
    expect(actionable.get('publication-empty')).toEqual({ ...EMPTY_DELIVERY, dispatchPending: 0 });
    const history = await presenter.loadDeliveryStats('publication-current', scope);
    expect(history).toEqual({ ...EMPTY_DELIVERY, total: 10, pending: 8, sent: 2 });
    expect(history).not.toHaveProperty('dispatchPending');
    expect(
      presenter.buildDeliveryStats([{ status: ManagedBroadcastDeliveryStatus.PENDING }]),
    ).not.toHaveProperty('dispatchPending');
    expect(queryRaw).toHaveBeenCalledTimes(2);
    const sql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('INNER JOIN "managed_broadcasts" AS broadcast');
    expect(sql).toContain('broadcast."id" = delivery."broadcast_id"');
    expect(sql).toContain('COUNT(*) FILTER (');
    expect(sql).toContain('occurrence."status" <> \'CANCELED\'::"PublicationOccurrenceStatus"');
    expect(sql).toContain('broadcast."status" <> \'CANCELED\'::"ManagedBroadcastStatus"');
    expect(sql).toContain('schedule."revision" = occurrence."schedule_revision"');
    expect(sql).toContain('target."target_chat_id" = delivery."target_chat_id"');
    expect(sql).toContain('access_edge."bot_id" = ?');
    expect(extractSqlValues(queryRaw.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining([
        'publication-current',
        'publication-empty',
        'admin-1',
        'publisher-1',
      ]),
    );
    expect(extractSqlText(queryRaw.mock.calls[1]?.[0])).not.toContain('"dispatchPending"');
  });

  it('uses only the exact active Publisher catalog for PUBLIK_V1 target presentation', async () => {
    const catalogFindMany = jest.fn().mockResolvedValue([
      {
        chatId: 'chat-publisher',
        entityType: ChatEntityType.CHAT,
        title: 'Название Публика',
        avatarUrl: 'https://cdn.max/publisher.png',
        link: 'https://max.ru/publisher-chat',
      },
      {
        chatId: 'channel-fallback',
        entityType: ChatEntityType.CHANNEL,
        title: '   ',
        avatarUrl: null,
        link: 'https://example.com/not-max',
      },
    ]);
    const presenter = new PublicationPresenterService({
      managedBotChatCatalog: { findMany: catalogFindMany },
    } as never);
    const targets = [
      {
        targetChatId: 'chat-publisher',
        entityType: ChatEntityType.CHAT,
        chat: { title: 'Устаревшее название Майора' },
      },
      {
        targetChatId: 'channel-fallback',
        entityType: ChatEntityType.CHANNEL,
        chat: { title: 'Название канала из Майора' },
      },
    ];
    const presentations = await presenter.loadPublisherTargetPresentations(
      targets,
      'publisher-bot',
    );
    const details = await presenter.mapPublicationDetails(
      {
        id: 'publication-publisher',
        title: 'Публикация',
        lifecycle: PublicationLifecycle.ACTIVE,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        version: 1,
        canonicalContentRevisionId: 'content-1',
        canonicalContentRevision: {
          id: 'content-1',
          revision: 1,
          text: 'Текст',
          textFormat: 'PLAIN',
          buttons: [],
          assets: [],
        },
        targets,
        audienceSelection: 'SELECTED',
        audienceMode: 'SNAPSHOT',
        schedule: null,
        occurrences: [],
        deliveryStats: EMPTY_DELIVERY,
        actionableDeliveryStats: EMPTY_DELIVERY,
        createdAt: new Date('2026-08-27T10:00:00.000Z'),
        updatedAt: new Date('2026-08-27T10:00:00.000Z'),
      },
      presentations,
    );

    expect(details.targets).toEqual([
      expect.objectContaining({
        chatId: 'chat-publisher',
        title: 'Название Публика',
        avatarUrl: 'https://cdn.max/publisher.png',
        link: 'https://max.ru/publisher-chat',
      }),
      expect.objectContaining({
        chatId: 'channel-fallback',
        title: 'channel-fallback',
        link: null,
      }),
    ]);
    expect(details.targetPreviews.map((target) => target.title)).toEqual([
      'Название Публика',
      'channel-fallback',
    ]);
    expect(details.contentPreviewFormat).toBe('plain');
    expect(JSON.stringify(details)).not.toContain('Майора');
    expect(catalogFindMany).toHaveBeenCalledWith({
      where: {
        botId: 'publisher-bot',
        chatId: { in: ['chat-publisher', 'channel-fallback'] },
        status: 'ACTIVE',
      },
      select: {
        chatId: true,
        entityType: true,
        title: true,
        avatarUrl: true,
        link: true,
      },
    });
  });

  it('builds bounded plain summary previews without cutting markdown delimiters', async () => {
    const presenter = new PublicationPresenterService({} as never);

    const summary = await presenter.mapPublicationSummary({
      id: 'publication-markdown-preview',
      title: 'Публикация',
      lifecycle: PublicationLifecycle.ACTIVE,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      version: 1,
      canonicalContentRevision: {
        text: `**${'Текст'.repeat(50)}** [Ссылка](https://example.com/path)`,
        textFormat: 'MARKDOWN',
        assets: [
          { asset: { mimeType: 'video/mp4', durablePayload: null } },
          { asset: { mimeType: 'image/jpeg' } },
          {
            asset: { mimeType: 'application/octet-stream', durablePayload: { token: 'retained' } },
          },
        ],
      },
      targets: [],
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      schedule: null,
      occurrences: [],
      deliveryStats: EMPTY_DELIVERY,
      actionableDeliveryStats: EMPTY_DELIVERY,
      createdAt: new Date('2026-08-27T10:00:00.000Z'),
      updatedAt: new Date('2026-08-27T10:00:00.000Z'),
    });

    expect(summary).toMatchObject({ mediaCount: 3, videoCount: 2, hasVideo: true });
    expect(summary.contentPreview).toBe('Текст'.repeat(32));
    expect(summary.contentPreviewFormat).toBe('plain');
    expect(summary.contentPreview).not.toMatch(/\*\*|\[[^\]]*$/u);
  });

  it('preserves complete legacy draft schedules and hides partial editor state from publishing DTOs', async () => {
    const presenter = new PublicationPresenterService({} as never);
    const row = {
      id: 'draft',
      title: '',
      lifecycle: PublicationLifecycle.DRAFT,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      version: 1,
      canonicalContentRevision: { text: '', textFormat: 'PLAIN', assets: [] },
      targets: [],
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      occurrences: [],
      deliveryStats: EMPTY_DELIVERY,
      actionableDeliveryStats: EMPTY_DELIVERY,
      createdAt: new Date('2026-09-10T00:00:00Z'),
      updatedAt: new Date('2026-09-10T00:00:00Z'),
    };
    const complete = await presenter.mapPublicationSummary({
      ...row,
      schedule: {
        status: 'DRAFT',
        revision: 1,
        lastError: null,
        rule: { mode: 'once', timezone: 'Europe/Moscow', at: '2026-09-11T10:00:00Z' },
      },
    });
    expect(complete.schedule).toMatchObject({ mode: 'once', at: '2026-09-11T10:00:00Z' });
    const partial = await presenter.mapPublicationSummary({
      ...row,
      schedule: {
        status: 'DRAFT',
        revision: 1,
        rule: { formatVersion: 1, timingMode: 'once', onceDate: '', onceTime: '' },
      },
    });
    expect(partial.schedule).toBeNull();
  });

  it('batches Publisher catalog presentation reads', async () => {
    const catalogFindMany = jest.fn().mockResolvedValue([]);
    const presenter = new PublicationPresenterService({
      managedBotChatCatalog: { findMany: catalogFindMany },
    } as never);
    const targets = Array.from({ length: 201 }, (_, index) => ({
      targetChatId: `chat-${index}`,
      entityType: ChatEntityType.CHAT,
    }));

    await presenter.loadPublisherTargetPresentations(targets, 'publisher-bot');
    expect(catalogFindMany).toHaveBeenCalledTimes(2);
    expect(catalogFindMany.mock.calls[0]?.[0].where.chatId.in).toHaveLength(200);
    expect(catalogFindMany.mock.calls[1]?.[0].where.chatId.in).toEqual(['chat-200']);
  });

  it('maps current and historical delivery content revisions without guessing legacy rows', () => {
    const presenter = new PublicationPresenterService({} as never);
    const publicationOccurrence = {
      publication: { canonicalContentRevisionId: 'content-current' },
    };

    expect(
      presenter.mapDeliveryContentRevision({
        contentRevision: { id: 'content-current', revision: 4 },
        publicationOccurrence,
      }),
    ).toEqual({ contentRevision: 4, usesLatestContent: true });
    expect(
      presenter.mapDeliveryContentRevision({
        contentRevision: { id: 'content-old', revision: 2 },
        publicationOccurrence,
      }),
    ).toEqual({ contentRevision: 2, usesLatestContent: false });
    expect(
      presenter.mapDeliveryContentRevision({
        contentRevision: null,
        publicationOccurrence,
      }),
    ).toEqual({});
  });

  it('makes only failed occurrences from the current schedule revision retryable', async () => {
    const presenter = new PublicationPresenterService({} as never);
    const details = await presenter.mapPublicationDetails({
      id: 'publication-1',
      title: 'Публикация',
      lifecycle: PublicationLifecycle.ACTIVE,
      version: 3,
      canonicalContentRevisionId: 'content-2',
      canonicalContentRevision: {
        id: 'content-2',
        revision: 2,
        text: 'Новая версия',
        textFormat: 'PLAIN',
        buttons: [
          {
            text: 'Broken',
            url: 'https://max.ru/chat/example/https://nested.example.test',
          },
          { text: 'Open', url: 'https://example.test/post' },
        ],
        assets: [],
      },
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      targets: [],
      schedule: {
        id: 'schedule-1',
        mode: PublicationScheduleMode.NOW,
        status: PublicationScheduleStatus.ACTIVE,
        revision: 2,
        rule: { mode: 'now', timezone: 'Europe/Moscow' },
        lastError: null,
      },
      occurrences: [
        {
          id: 'occurrence-current',
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-2',
          contentRevision: { revision: 2 },
          scheduledAt: new Date('2026-07-18T10:00:00.000Z'),
          status: PublicationOccurrenceStatus.FAILED,
          deliveryStats: { ...EMPTY_DELIVERY, total: 1, failed: 1 },
        },
        {
          id: 'occurrence-old',
          scheduleId: 'schedule-1',
          scheduleRevision: 1,
          contentRevisionId: 'content-1',
          contentRevision: { revision: 1 },
          scheduledAt: new Date('2026-07-17T10:00:00.000Z'),
          status: PublicationOccurrenceStatus.FAILED,
          deliveryStats: { ...EMPTY_DELIVERY, total: 1, failed: 1 },
        },
        {
          id: 'occurrence-missing-envelope',
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-2',
          contentRevision: { revision: 2 },
          scheduledAt: new Date('2026-07-16T10:00:00.000Z'),
          status: PublicationOccurrenceStatus.FAILED,
          legacyBroadcastId: null,
          deliveryStats: EMPTY_DELIVERY,
          _count: { legacyBroadcasts: 0 },
        },
        {
          id: 'occurrence-ambiguous',
          scheduleId: 'schedule-1',
          scheduleRevision: 2,
          contentRevisionId: 'content-2',
          contentRevision: { revision: 2 },
          scheduledAt: new Date('2026-07-15T10:00:00.000Z'),
          status: PublicationOccurrenceStatus.AMBIGUOUS,
          deliveryStats: { ...EMPTY_DELIVERY, total: 1, ambiguous: 1 },
        },
      ],
      deliveryStats: { ...EMPTY_DELIVERY, total: 2, failed: 2 },
      actionableDeliveryStats: { ...EMPTY_DELIVERY, total: 1, failed: 1 },
      createdAt: new Date('2026-07-17T09:00:00.000Z'),
      updatedAt: new Date('2026-07-18T09:00:00.000Z'),
    });

    expect(details.actionableDelivery).toEqual({ ...EMPTY_DELIVERY, total: 1, failed: 1 });
    expect(details.content.buttons).toEqual([
      { text: 'Open', url: 'https://example.test/post', row: 0 },
    ]);
    expect(details.occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'occurrence-current',
          canRetry: true,
          contentRevision: 2,
          usesLatestContent: true,
        }),
        expect.objectContaining({
          id: 'occurrence-old',
          canRetry: false,
          contentRevision: 1,
          usesLatestContent: false,
        }),
        expect.objectContaining({
          id: 'occurrence-missing-envelope',
          canRetry: true,
          contentRevision: 2,
          usesLatestContent: true,
        }),
        expect.objectContaining({
          id: 'occurrence-ambiguous',
          canRetry: false,
          contentRevision: 2,
          usesLatestContent: true,
        }),
      ]),
    );
  });

  it('uses occurrence blockers until deliveries exist and then trusts pending deliveries', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        publicationId: 'publication-pre-envelope',
        occurrenceId: 'occurrence-pre-envelope',
        blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      },
      {
        publicationId: 'publication-post-envelope',
        occurrenceId: 'occurrence-post-envelope',
        blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      },
    ]);
    const presenter = new PublicationPresenterService({ $queryRaw: queryRaw } as never);

    const issues = await presenter.loadPublicationDispatchIssues(
      ['publication-pre-envelope', 'publication-post-envelope'],
      'actor-1',
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(issues.byPublicationId).toEqual(
      new Map([
        ['publication-pre-envelope', 'actor_access_required'],
        ['publication-post-envelope', 'actor_access_required'],
      ]),
    );
    const sql = extractSqlText(queryRaw.mock.calls[0]?.[0]);
    const values = extractSqlValues(queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('schedule."revision" = occurrence."schedule_revision"');
    expect(sql).toContain('FROM "managed_broadcast_deliveries" AS delivery');
    expect(sql).toContain('current_occurrence."hasExecutionDeliveries" = FALSE');
    expect(sql).toContain(
      'current_occurrence."occurrenceStatus" = \'FAILED\'::"PublicationOccurrenceStatus"',
    );
    expect(sql).toContain(
      'current_occurrence."occurrenceBlockerCode" = \'PUBLISHER_MISSED_WINDOW_REVIEW\'',
    );
    expect(sql).toContain('current_occurrence."occurrenceBlockerCode" AS "blockerCode"');
    expect(sql).toContain('current_occurrence."hasExecutionDeliveries" = TRUE');
    expect(sql).toContain('publication."lifecycle" IN (');
    expect(sql).toContain('schedule."status" IN (');
    expect(sql).toContain('delivery."status" IN (');
    expect(sql).toContain('\'PENDING\'::"ManagedBroadcastDeliveryStatus"');
    expect(sql).toContain('\'SENDING\'::"ManagedBroadcastDeliveryStatus"');
    expect(values).toEqual([
      'publication-pre-envelope',
      'publication-post-envelope',
      'actor-1',
      PublicationDispatchProfile.PUBLIK_V1,
    ]);
  });

  it('attaches sanitized dispatch issues to authorized Publisher details', async () => {
    const occurrence = {
      id: 'occurrence-publik',
      scheduleId: 'schedule-publik',
      scheduleRevision: 1,
      contentRevisionId: 'content-publik',
      legacyBroadcastId: 'broadcast-publik',
      scheduledAt: new Date('2026-08-27T10:00:00.000Z'),
      status: PublicationOccurrenceStatus.IN_PROGRESS,
      contentRevision: { revision: 1 },
      _count: { legacyBroadcasts: 1 },
    };
    const publicationFindFirst = jest.fn().mockResolvedValue({
      id: 'publication-publik',
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      occurrences: [occurrence],
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          publicationId: 'publication-publik',
          occurrenceId: occurrence.id,
          blockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
        },
      ])
      .mockResolvedValueOnce([]);
    const presenter = new PublicationPresenterService({
      publication: { findFirst: publicationFindFirst },
      publicationOccurrence: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: queryRaw,
    } as never);

    const row = await presenter.loadPublicationDetailsRow(
      'publication-publik',
      'actor-1',
      PublicationDispatchProfile.PUBLIK_V1,
    );

    expect(row?.dispatchIssue).toBe('actor_access_required');
    expect(row?.occurrences[0]?.dispatchIssue).toBe('actor_access_required');
    expect(publicationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'publication-publik',
          ...publicationAdminAccessWhere(
            publicationAdminScope('actor-1'),
            PublicationDispatchProfile.PUBLIK_V1,
          ),
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        },
      }),
    );
    expect(JSON.stringify(row)).not.toContain('PUBLISHER_ACTOR_ACCESS_REQUIRED');
  });

  it('does not query or expose Publisher blockers for Major publications', async () => {
    const queryRaw = jest.fn();
    const presenter = new PublicationPresenterService({ $queryRaw: queryRaw } as never);

    const issues = await presenter.loadPublicationDispatchIssues(
      ['publication-major'],
      'actor-1',
      PublicationDispatchProfile.LEGACY_ROUTED,
    );
    const summary = await presenter.mapPublicationSummary(
      {
        id: 'publication-major',
        title: 'Major',
        lifecycle: PublicationLifecycle.ACTIVE,
        dispatchProfile: PublicationDispatchProfile.LEGACY_ROUTED,
        dispatchIssue: 'actor_access_required',
        version: 1,
        canonicalContentRevision: { text: 'Текст', textFormat: 'PLAIN', assets: [] },
        targets: [],
        audienceSelection: 'SELECTED',
        audienceMode: 'SNAPSHOT',
        schedule: null,
        occurrences: [],
        deliveryStats: EMPTY_DELIVERY,
        actionableDeliveryStats: EMPTY_DELIVERY,
        createdAt: new Date('2026-08-27T10:00:00.000Z'),
        updatedAt: new Date('2026-08-27T10:00:00.000Z'),
      },
      undefined,
      undefined,
      undefined,
      'actor_access_required',
    );

    expect(issues.byPublicationId).toEqual(new Map());
    expect(summary.dispatchIssue).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    ['actor_access_required', 'actor_access_required', false],
    ['decision_required', 'target_setup_required', true],
  ])(
    'serializes %s with a backwards-compatible public issue',
    async (issue, publicIssue, requiresDecision) => {
      const presenter = new PublicationPresenterService({} as never);
      const details = await presenter.mapPublicationDetails({
        id: 'publication-publik-blocked',
        title: 'Публикация',
        lifecycle: PublicationLifecycle.ACTIVE,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot-internal',
        dispatchIssue: issue,
        version: 1,
        canonicalContentRevisionId: 'content-1',
        canonicalContentRevision: {
          id: 'content-1',
          revision: 1,
          text: 'Текст',
          textFormat: 'PLAIN',
          buttons: [],
          assets: [],
        },
        targets: [],
        audienceSelection: 'SELECTED',
        audienceMode: 'SNAPSHOT',
        schedule: {
          id: 'schedule-1',
          mode: PublicationScheduleMode.NOW,
          status: PublicationScheduleStatus.ACTIVE,
          revision: 1,
          rule: { mode: 'now', timezone: 'Europe/Moscow' },
          lastError: null,
        },
        occurrences: [
          {
            id: 'occurrence-1',
            scheduleId: 'schedule-1',
            scheduleRevision: 1,
            contentRevisionId: 'content-1',
            contentRevision: { revision: 1 },
            scheduledAt: new Date('2026-08-27T10:00:00.000Z'),
            status: PublicationOccurrenceStatus.IN_PROGRESS,
            dispatchIssue: issue,
            dispatchBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
            dispatchFirstBlockedAt: new Date('2026-08-27T08:00:00.000Z'),
            dispatchBlockedAt: new Date('2026-08-27T09:00:00.000Z'),
            deliveryStats: EMPTY_DELIVERY,
          },
        ],
        deliveryStats: EMPTY_DELIVERY,
        actionableDeliveryStats: EMPTY_DELIVERY,
        createdAt: new Date('2026-08-27T09:00:00.000Z'),
        updatedAt: new Date('2026-08-27T10:00:00.000Z'),
      });

      expect(details.dispatchIssue).toBe(publicIssue);
      expect(details.requiresScheduleDecision).toBe(requiresDecision);
      expect(details.occurrences[0]).toMatchObject({
        dispatchIssue: publicIssue,
        requiresScheduleDecision: requiresDecision,
        dispatchBlockedSince: '2026-08-27T08:00:00.000Z',
        dispatchCheckedAt: '2026-08-27T09:00:00.000Z',
      });
      expect(JSON.stringify(details)).not.toContain('PUBLISHER_ACTOR_ACCESS_REQUIRED');
      expect(JSON.stringify(details)).not.toContain('publisher-bot-internal');
    },
  );
});
