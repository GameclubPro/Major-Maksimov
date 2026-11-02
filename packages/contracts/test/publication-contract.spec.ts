import { describe, expect, it } from 'vitest';

import {
  createPublicationRequestSchema,
  decodeLegacyPublicationListCursor,
  decodePublicationListCursor,
  encodeLegacyPublicationListCursor,
  encodePublicationListCursor,
  listLegacyPublicationsQuerySchema,
  listPublicationDeliveriesQuerySchema,
  listPublicationsQuerySchema,
  MAX_PUBLICATION_EXPLICIT_SLOTS,
  MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH,
  MAX_PUBLICATION_TEXT_LENGTH,
  publicationContentInputSchema,
  publicationDraftContentInputSchema,
  publicationScheduleInputSchema,
  DEFAULT_PUBLICATION_LATE_POLICY,
  publicationDeliverySchema,
  publicationDeliveryStatsSchema,
  publicationDispatchIssueSchema,
  publicationOccurrenceSummarySchema,
  publicationSlotsScheduleSchema,
  publicationSummarySchema,
  publicationTargetsRefreshResponseSchema,
  retryPublicationOccurrenceRequestSchema,
  updatePublicationRequestSchema,
  testPublicationRequestSchema,
} from '@maxim/contracts/publication';

describe('publication contracts', () => {
  it.each(['image-ref', 'video-ref'] as const)(
    'preserves a bounded %s source across publication requests',
    (type) => {
      const media = [{ type, assetId: 'shared-asset', sourcePublicationId: 'source-post' }];
      const content = { text: 'copy', media };
      const audience = { targets: [{ chatId: 'chat', entityType: 'chat' }] };
      const create = createPublicationRequestSchema.parse({
        requestId: 'copy-request',
        content,
        audience,
        schedule: { mode: 'now', timezone: 'UTC' },
      });
      const update = updatePublicationRequestSchema.parse({
        requestId: 'edit-request',
        expectedRevision: 1,
        content,
      });
      const test = testPublicationRequestSchema.parse({
        requestId: 'test-request',
        content,
        sourceTarget: audience.targets[0],
      });
      for (const parsed of [create, update, test]) expect(parsed.content?.media).toEqual(media);
      expect(publicationDraftContentInputSchema.parse(content).media).toEqual(media);
      expect(
        publicationContentInputSchema.parse({
          text: 'old client',
          media: [{ type, assetId: 'owned' }],
        }).media,
      ).toEqual([{ type, assetId: 'owned' }]);
      for (const sourcePublicationId of ['', 'x'.repeat(257)])
        expect(
          publicationContentInputSchema.safeParse({
            ...content,
            media: [{ type, assetId: 'shared', sourcePublicationId }],
          }).success,
        ).toBe(false);
    },
  );

  it('preserves omitted top-level fields in a minimal publication update', () => {
    const request = { expectedRevision: 2, requestId: 'update_request_1' };
    expect(updatePublicationRequestSchema.parse(request)).toEqual(request);
  });

  it('keeps a content-only update limited to content while retaining its nested defaults', () => {
    expect(
      updatePublicationRequestSchema.parse({
        expectedRevision: 2,
        requestId: 'update_content_1',
        content: { text: 'Edited post' },
      }),
    ).toEqual({
      expectedRevision: 2,
      requestId: 'update_content_1',
      content: { text: 'Edited post', textFormat: 'plain', buttons: [], media: [] },
    });
  });

  it('does not materialize defaults for explicitly undefined update fields', () => {
    const request = {
      expectedRevision: 2,
      requestId: 'update_undefined_1',
      title: undefined,
      content: undefined,
      audience: undefined,
      schedule: undefined,
      intent: undefined,
    };
    expect(updatePublicationRequestSchema.parse(request)).toEqual(request);
  });

  it('retains an explicit null schedule without adding title or intent mutations', () => {
    const request = {
      expectedRevision: 2,
      requestId: 'update_schedule_1',
      schedule: null,
    };
    expect(updatePublicationRequestSchema.parse(request)).toEqual(request);
  });

  it('validates explicit update fields and retains defaults inside supplied audience and schedule', () => {
    expect(
      updatePublicationRequestSchema.parse({
        expectedRevision: 2,
        requestId: 'update_fields_1',
        title: '  Edited title  ',
        intent: 'draft',
        audience: { targets: [{ chatId: 'channel-1', entityType: 'channel' }] },
        schedule: { mode: 'once', at: '2026-10-01T12:00:00Z' },
      }),
    ).toEqual({
      expectedRevision: 2,
      requestId: 'update_fields_1',
      title: 'Edited title',
      intent: 'draft',
      audience: {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [{ chatId: 'channel-1', entityType: 'channel' }],
      },
      schedule: {
        mode: 'once',
        at: '2026-10-01T12:00:00Z',
        timezone: 'Europe/Moscow',
        replaceConflicts: false,
      },
    });
  });

  it.each([
    { title: 'A'.repeat(121) },
    { title: null },
    { intent: 'resume' },
    { intent: null },
    { content: { text: 'A'.repeat(MAX_PUBLICATION_TEXT_LENGTH + 1) } },
    { audience: { targets: [] } },
    { schedule: { mode: 'once', at: 'invalid-time' } },
  ])('rejects invalid explicitly supplied update fields: %j', (fields) => {
    expect(
      updatePublicationRequestSchema.safeParse({
        expectedRevision: 2,
        requestId: 'update_invalid_1',
        ...fields,
      }).success,
    ).toBe(false);
  });

  it('preserves create defaults and still requires a schedule for the default publish intent', () => {
    const request = {
      requestId: 'create_defaults_1',
      content: { text: 'New post' },
      audience: { targets: [{ chatId: 'chat-1', entityType: 'chat' }] },
    };
    expect(createPublicationRequestSchema.safeParse(request).success).toBe(false);
    expect(createPublicationRequestSchema.parse({ ...request, intent: 'draft' })).toEqual({
      ...request,
      title: '',
      intent: 'draft',
      schedule: null,
      content: { text: 'New post', textFormat: 'plain', buttons: [], media: [] },
      audience: {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [{ chatId: 'chat-1', entityType: 'chat' }],
      },
    });
    expect(
      createPublicationRequestSchema.parse({ ...request, schedule: { mode: 'now' } }),
    ).toMatchObject({
      title: '',
      intent: 'publish',
      schedule: { mode: 'now', timezone: 'Europe/Moscow' },
    });
  });

  it('defaults additive dispatch issues to null and rejects internal blocker codes', () => {
    expect(publicationSummarySchema.shape.dispatchIssue.parse(undefined)).toBeNull();
    expect(publicationOccurrenceSummarySchema.shape.dispatchIssue.parse(undefined)).toBeNull();
    expect(publicationDispatchIssueSchema.options).toEqual([
      'actor_access_required',
      'target_setup_required',
      'temporarily_unavailable',
    ]);
    expect(
      publicationDispatchIssueSchema.safeParse('PUBLISHER_ACTOR_ACCESS_REQUIRED').success,
    ).toBe(false);
  });

  it('accepts publication-scoped refresh counts without a recipient ceiling or target ids', () => {
    expect(
      publicationTargetsRefreshResponseSchema.parse({ accepted: true, queuedCount: 500 }),
    ).toEqual({ accepted: true, queuedCount: 500 });
    expect(
      publicationTargetsRefreshResponseSchema.safeParse({ accepted: true, queuedCount: 501 })
        .success,
    ).toBe(true);
    expect(
      publicationTargetsRefreshResponseSchema.safeParse({
        accepted: true,
        queuedCount: 1,
        targetIds: ['channel-internal'],
      }).success,
    ).toBe(false);
  });

  it('defaults legacy summary previews to plain and preserves explicit markdown', () => {
    expect(publicationSummarySchema.shape.contentPreviewFormat.parse(undefined)).toBe('plain');
    expect(publicationSummarySchema.shape.contentPreviewFormat.parse('markdown')).toBe('markdown');
  });

  it('accepts mixed chat/channel targets and a byte-backed video', () => {
    const parsed = createPublicationRequestSchema.parse({
      requestId: 'publication_request_1',
      title: 'Анонс',
      content: {
        text: 'Новый выпуск',
        textFormat: 'markdown',
        buttons: [{ text: 'Открыть', url: 'https://max.ru/example', row: 0 }],
        media: [
          {
            type: 'video',
            payload: null,
            base64: Buffer.from('video').toString('base64'),
            mimeType: 'video/mp4',
            fileName: 'clip.mp4',
          },
        ],
      },
      audience: {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [
          { chatId: 'chat-1', entityType: 'chat' },
          { chatId: 'channel-1', entityType: 'channel' },
        ],
      },
      schedule: { mode: 'now', timezone: 'Europe/Moscow' },
      intent: 'publish',
    });

    expect(parsed.audience.targets).toHaveLength(2);
    expect(parsed.content.media[0]).toEqual(
      expect.objectContaining({ type: 'video', mimeType: 'video/mp4' }),
    );
  });

  it('rejects image/video mixes and video inputs with two sources', () => {
    expect(
      publicationContentInputSchema.safeParse({
        text: '',
        media: [
          {
            type: 'image',
            base64: Buffer.from('image').toString('base64'),
            mimeType: 'image/png',
            fileName: 'image.png',
          },
          {
            type: 'video',
            payload: { token: 'video-token' },
            base64: '',
            mimeType: 'video/mp4',
            fileName: 'video.mp4',
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      publicationContentInputSchema.safeParse({
        text: '',
        media: [
          {
            type: 'video',
            payload: { token: 'video-token' },
            base64: Buffer.from('video').toString('base64'),
            mimeType: 'video/mp4',
            fileName: 'video.mp4',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects inline images whose combined request body exceeds the total limit', () => {
    const imageBase64 = 'A'.repeat(Math.floor(MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH / 3) + 1);

    expect(
      publicationContentInputSchema.safeParse({
        text: '',
        media: Array.from({ length: 3 }, (_, index) => ({
          type: 'image',
          base64: imageBase64,
          mimeType: 'image/png',
          fileName: `image-${index}.png`,
        })),
      }).success,
    ).toBe(false);
  });

  it('accepts only ordinary http/https publication button links', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///tmp/post',
      'https://max.ru/bot?start=pm2_private',
      'https://example.test/path https://nested.example.test',
      'https://max.ru/chat/example/https://nested.example.test',
      'https://max.ru/chat/example/https%3A%2F%2Fnested.example.test',
      `https://example.test/${'a/../'.repeat(500)}open`,
    ]) {
      expect(
        publicationContentInputSchema.safeParse({
          text: 'Пост',
          buttons: [{ text: 'Открыть', url, row: 0 }],
          media: [],
        }).success,
      ).toBe(false);
    }

    expect(
      publicationContentInputSchema.safeParse({
        text: 'Пост',
        buttons: [{ text: 'Открыть', url: ' https://example.com/post ', row: 0 }],
        media: [],
      }).success,
    ).toBe(true);
  });

  it('accepts the documented MAX text limit and rejects longer publication text', () => {
    expect(
      publicationContentInputSchema.safeParse({
        text: 'A'.repeat(MAX_PUBLICATION_TEXT_LENGTH),
        media: [],
      }).success,
    ).toBe(true);
    expect(
      publicationContentInputSchema.safeParse({
        text: 'A'.repeat(MAX_PUBLICATION_TEXT_LENGTH + 1),
        media: [],
      }).success,
    ).toBe(false);
  });

  it('accepts 300 explicit schedule slots and reports the shared limit at 301', () => {
    expect(MAX_PUBLICATION_EXPLICIT_SLOTS).toBe(300);

    const slots = Array.from({ length: MAX_PUBLICATION_EXPLICIT_SLOTS + 1 }, (_, index) =>
      new Date(Date.UTC(2026, 7, 28, 18, index)).toISOString(),
    );

    expect(
      publicationSlotsScheduleSchema.safeParse({
        mode: 'slots',
        timezone: 'Europe/Moscow',
        slots: slots.slice(0, MAX_PUBLICATION_EXPLICIT_SLOTS),
      }).success,
    ).toBe(true);

    const overLimit = publicationSlotsScheduleSchema.safeParse({
      mode: 'slots',
      timezone: 'Europe/Moscow',
      slots,
    });

    expect(overLimit.success).toBe(false);
    if (!overLimit.success) {
      expect(overLimit.error.issues).toContainEqual(
        expect.objectContaining({
          code: 'too_big',
          maximum: MAX_PUBLICATION_EXPLICIT_SLOTS,
          path: ['slots'],
          message: `Можно запланировать не более ${MAX_PUBLICATION_EXPLICIT_SLOTS} отправок.`,
        }),
      );
    }
  });

  it('requires optimistic revisions only when retrying the latest content', () => {
    expect(
      retryPublicationOccurrenceRequestSchema.safeParse({ requestId: 'retry-original-1' }).success,
    ).toBe(true);
    expect(
      retryPublicationOccurrenceRequestSchema.safeParse({
        requestId: 'retry-latest-1',
        contentMode: 'latest',
      }).success,
    ).toBe(false);
    expect(
      retryPublicationOccurrenceRequestSchema.safeParse({
        requestId: 'retry-latest-2',
        contentMode: 'latest',
        expectedPublicationVersion: 3,
        expectedContentRevision: 2,
      }).success,
    ).toBe(true);
  });

  it('parses server-side list filters and binds them into opaque cursors', () => {
    const query = listPublicationsQuerySchema.parse({
      view: 'schedules',
      query: 'Анонс',
      entityType: 'channel',
      status: 'failed',
      limit: '25',
    });
    expect(query).toEqual({
      view: 'schedules',
      query: 'Анонс',
      entityType: 'channel',
      status: 'failed',
      limit: 25,
    });

    const cursor = encodePublicationListCursor({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'publication-1',
      view: query.view,
      query: query.query,
      entityType: query.entityType,
      status: query.status,
    });
    expect(decodePublicationListCursor(cursor)).toEqual({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'publication-1',
      view: 'schedules',
      query: 'Анонс',
      entityType: 'channel',
      status: 'failed',
    });
  });

  it('binds the non-overlapping current view into its cursor', () => {
    const query = listPublicationsQuerySchema.parse({ view: 'current' });
    const cursor = encodePublicationListCursor({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'publication-current',
      view: query.view,
      query: query.query,
    });

    expect(decodePublicationListCursor(cursor)?.view).toBe('current');
  });

  it('binds legacy pagination cursors to view, kind, entity, and search filters', () => {
    const query = listLegacyPublicationsQuerySchema.parse({
      view: 'history',
      kind: 'broadcast',
      entityType: 'channel',
      query: 'Анонс',
      limit: '25',
    });
    expect(query).toEqual({
      view: 'history',
      kind: 'broadcast',
      entityType: 'channel',
      query: 'Анонс',
      limit: 25,
    });

    const cursor = encodeLegacyPublicationListCursor({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'broadcast-1',
      itemKind: 'broadcast',
      view: query.view,
      kind: query.kind,
      entityType: query.entityType,
      query: query.query,
    });
    expect(decodeLegacyPublicationListCursor(cursor)).toEqual({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'broadcast-1',
      itemKind: 'broadcast',
      view: 'history',
      kind: 'broadcast',
      entityType: 'channel',
      query: 'Анонс',
    });
    expect(listLegacyPublicationsQuerySchema.safeParse({ limit: 31 }).success).toBe(false);
  });

  it('accepts delivery pagination that excludes a reviewed status', () => {
    expect(
      listPublicationDeliveriesQuerySchema.parse({
        excludeStatus: 'AMBIGUOUS',
        cursor: 'delivery-50',
        limit: '50',
      }),
    ).toEqual({
      excludeStatus: 'AMBIGUOUS',
      cursor: 'delivery-50',
      limit: 50,
    });
  });

  it('keeps delivery content revisions additive for mixed retry history', () => {
    expect(
      publicationDeliverySchema.parse({
        id: 'delivery-1',
        occurrenceId: 'occurrence-1',
        target: { chatId: 'chat-1', entityType: 'chat', title: 'Чат' },
        status: 'SENT',
        contentRevision: 3,
        usesLatestContent: false,
        attemptCount: 1,
        remoteMessageId: 'message-1',
        lastError: null,
        sentAt: '2026-07-18T09:00:00.000Z',
      }),
    ).toEqual(expect.objectContaining({ contentRevision: 3, usesLatestContent: false }));
    expect(
      publicationDeliverySchema.safeParse({
        id: 'delivery-legacy',
        occurrenceId: 'occurrence-1',
        target: { chatId: 'chat-1', entityType: 'chat', title: 'Чат' },
        status: 'SENT',
        attemptCount: 1,
        remoteMessageId: null,
        lastError: null,
        sentAt: null,
      }).success,
    ).toBe(true);
  });

  it('preserves unknown dispatch context and explicit stopped values', () => {
    const legacy = {
      id: 'delivery-legacy',
      occurrenceId: 'occurrence-1',
      target: { chatId: 'chat-1', entityType: 'chat', title: 'Чат' },
      status: 'PENDING',
      attemptCount: 0,
      remoteMessageId: null,
      lastError: null,
      sentAt: null,
    };
    expect(publicationDeliverySchema.parse(legacy)).not.toHaveProperty('dispatchStopped');
    for (const dispatchStopped of [true, false]) {
      expect(publicationDeliverySchema.parse({ ...legacy, dispatchStopped })).toHaveProperty(
        'dispatchStopped',
        dispatchStopped,
      );
    }
    for (const dispatchStopped of [null, 0, 'true']) {
      expect(publicationDeliverySchema.safeParse({ ...legacy, dispatchStopped }).success).toBe(
        false,
      );
    }
  });

  it('keeps active dispatch counts additive and accepts authoritative zero', () => {
    const legacy = { total: 2, pending: 2, sent: 0, failed: 0, ambiguous: 0, canceled: 0 };
    expect(publicationDeliveryStatsSchema.parse(legacy)).not.toHaveProperty('dispatchPending');
    for (const dispatchPending of [0, 2]) {
      expect(publicationDeliveryStatsSchema.parse({ ...legacy, dispatchPending })).toEqual({
        ...legacy,
        dispatchPending,
      });
    }
    for (const dispatchPending of [-1, 1.5, '0', null]) {
      expect(publicationDeliveryStatsSchema.safeParse({ ...legacy, dispatchPending }).success).toBe(
        false,
      );
    }
  });
});

describe('authored publication recovery policy', () => {
  const once = { mode: 'once', at: '2026-10-14T10:00:00Z' };
  it('keeps legacy omission distinct from the default for new drafts', () => {
    expect(publicationScheduleInputSchema.parse(once)).not.toHaveProperty('latePolicy');
    expect(
      publicationScheduleInputSchema.parse({
        ...once,
        latePolicy: DEFAULT_PUBLICATION_LATE_POLICY,
      }),
    ).toMatchObject({ latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'latest' } });
  });
  it.each([0, -1, 10081, 1.5, '60', null])(
    'rejects an invalid recovery horizon %s',
    (maxDelayMinutes) => {
      expect(
        publicationScheduleInputSchema.safeParse({
          ...once,
          latePolicy: { ...DEFAULT_PUBLICATION_LATE_POLICY, maxDelayMinutes },
        }).success,
      ).toBe(false);
    },
  );
  it('rejects unknown recovery and catch-up modes', () => {
    for (const latePolicy of [
      { ...DEFAULT_PUBLICATION_LATE_POLICY, mode: 'forever' },
      { ...DEFAULT_PUBLICATION_LATE_POLICY, catchUp: 'retry_unknown' },
    ])
      expect(publicationScheduleInputSchema.safeParse({ ...once, latePolicy }).success).toBe(false);
  });
});
