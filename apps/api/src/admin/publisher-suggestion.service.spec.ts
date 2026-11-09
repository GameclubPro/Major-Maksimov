import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PublicationDispatchProfile, type Prisma } from '../prisma/prisma-client';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import type { SuggestionSubscriptionService } from '../suggestions/suggestion-subscription.service';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';
import {
  buildLegacyPublisherSuggestionPublicationRequestId,
  buildPublisherSuggestionPublicationRequestId,
  PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
  PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
} from './publisher-suggestion-review-protocol';

const user = {
  userId: 'admin-1',
  username: 'admin',
  displayName: 'Админ',
  avatarUrl: 'https://cdn.example/admin.png',
  profileUrl: 'https://max.ru/admin',
};

const otherUser = {
  userId: 'admin-2',
  username: 'editor',
  displayName: 'Редактор',
  avatarUrl: null,
  profileUrl: null,
};

function sqlText(query: { strings?: readonly string[] }): string {
  return query.strings?.join('?').replace(/\s+/gu, ' ').trim() ?? '';
}

function createClaimedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: 'suggest',
    text: '**Идея для поста\n\nПродолжение**',
    textFormat: 'markdown',
    authorDisplayName: 'Читатель',
    reviewStatus: 'publishing',
    reviewAction: 'publish',
    reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
    reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
    reviewPublicationRequestId: buildPublisherSuggestionPublicationRequestId(
      'suggestion-1',
      'claim-1',
    ),
    reviewClaimToken: 'claim-1',
    reviewClaimedAt: '2026-08-27T10:05:00.000Z',
    reviewClaimedByUserId: user.userId,
    reviewClaimedByUsername: user.username,
    reviewClaimedByDisplayName: user.displayName,
    reviewClaimedByAvatarUrl: user.avatarUrl,
    reviewClaimedByProfileUrl: user.profileUrl,
    ...overrides,
  };
}

function createFixture(payloadOverrides: Record<string, unknown> = {}) {
  let payload: Record<string, unknown> = {
    type: 'suggest',
    text: '**Идея для поста\n\nПродолжение**',
    textFormat: 'markdown',
    authorDisplayName: 'Читатель',
    reviewStatus: 'pending',
    ...payloadOverrides,
  };
  const row = () => ({
    id: 'suggestion-1',
    chatId: 'channel-1',
    actorUserId: '42',
    payload,
    createdAt: new Date('2026-08-27T10:00:00.000Z'),
  });
  const auditLog = {
    findMany: jest.fn().mockImplementation(async () => [row()]),
    findFirst: jest.fn().mockImplementation(async () => row()),
    findFirstOrThrow: jest.fn().mockImplementation(async () => row()),
  };
  const prisma = {
    auditLog,
    channelSuggestionImageAsset: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn<Promise<void>, [(tx: Prisma.TransactionClient) => Promise<void>]>(),
  };
  prisma.$transaction.mockImplementation(async (operation) =>
    operation(prisma as unknown as Prisma.TransactionClient),
  );
  const policy = { getEntity: jest.fn().mockResolvedValue({ id: 'channel-1' }) };
  const publications = {
    create: jest
      .fn<Promise<{ id: string }>, [unknown, any, PublicationDispatchProfile]>()
      .mockResolvedValue({ id: 'publication-1' }),
  };
  const publicationQueue = { enqueue: jest.fn().mockResolvedValue(undefined) };
  const adminQueue = { enqueueSync: jest.fn().mockResolvedValue(undefined) };
  const suggestionSubscriptions = {
    assertCanSubmit: jest
      .fn<
        ReturnType<SuggestionSubscriptionService['assertCanSubmit']>,
        Parameters<SuggestionSubscriptionService['assertCanSubmit']>
      >()
      .mockResolvedValue(undefined),
    track: jest
      .fn<
        ReturnType<SuggestionSubscriptionService['track']>,
        Parameters<SuggestionSubscriptionService['track']>
      >()
      .mockResolvedValue(undefined),
  };
  const service = new PublisherSuggestionService(
    prisma as never,
    policy as never,
    publications as never,
    publicationQueue as never,
    adminQueue as never,
    { getBotId: () => 'publisher-bot' } as never,
    suggestionSubscriptions as never,
  );
  return {
    service,
    policy,
    prisma,
    publications,
    publicationQueue,
    adminQueue,
    suggestionSubscriptions,
    row,
    setPayload(next: Record<string, unknown>) {
      payload = next;
    },
  };
}

describe('PublisherSuggestionService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('paginates pending work independently from newer history', async () => {
    const fixture = createFixture();
    const pendingRows = Array.from({ length: 26 }, (_, index) => ({
      ...fixture.row(),
      id: `pending-${String(index).padStart(3, '0')}`,
      createdAt: new Date(Date.UTC(2026, 7, 27, 10, 0, 25 - index)),
    }));
    fixture.prisma.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) =>
      sqlText(query).includes('COUNT(*)') ? [{ total: 126 }] : pendingRows,
    );

    const result = await fixture.service.list('channel-1', user, {
      view: 'pending',
      limit: 25,
    });
    if (!('total' in result)) throw new Error('Expected paginated response');

    expect(fixture.policy.getEntity).toHaveBeenCalledWith('channel', 'channel-1', user);
    expect(result.items).toHaveLength(25);
    expect(result.total).toBe(126);
    expect(result.nextCursor).toEqual(expect.any(String));
    const pageSql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(pageSql).toContain("NOT IN ('published', 'drafted', 'cancelled')");
    expect(pageSql).toContain('ORDER BY created_at DESC, id DESC');
    expect(pageSql).toContain('LIMIT ?');
  });

  it('binds list cursors to the exact channel and view', async () => {
    const fixture = createFixture();
    const page = Array.from({ length: 26 }, (_, index) => ({
      ...fixture.row(),
      id: `pending-${index}`,
      createdAt: new Date(Date.UTC(2026, 7, 27, 10, 0, 25 - index)),
    }));
    fixture.prisma.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) =>
      sqlText(query).includes('COUNT(*)') ? [{ total: 26 }] : page,
    );
    const first = await fixture.service.list('channel-1', user, {
      view: 'pending',
      limit: 25,
    });
    if (!('nextCursor' in first)) throw new Error('Expected paginated response');

    await expect(
      fixture.service.list('channel-1', user, {
        view: 'history',
        limit: 25,
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('falls back to plain text for legacy suggestions without a supported format', async () => {
    const fixture = createFixture({ textFormat: 'html' });
    fixture.prisma.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) =>
      sqlText(query).includes('COUNT(*)') ? [{ total: 1 }] : [fixture.row()],
    );

    const result = await fixture.service.list('channel-1', user, { view: 'pending' });

    expect(result.items[0]).toHaveProperty('textFormat', 'plain');
  });

  it('returns a bounded media summary without returning filenames or image bytes', async () => {
    const fixture = createFixture({
      imageCount: 2,
      imageStorageVersion: 1,
      images: [{ base64: 'must-not-leak', fileName: 'private-name.png' }],
    });
    fixture.prisma.$queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) =>
      sqlText(query).includes('COUNT(*)') ? [{ total: 1 }] : [fixture.row()],
    );

    const result = await fixture.service.list('channel-1', user, { view: 'pending' });

    expect(result.items[0]).toEqual(expect.objectContaining({ imageCount: 2 }));
    expect(result.items[0]).not.toHaveProperty('images');
    expect(result.items[0]).not.toHaveProperty('imageFileNames');
  });

  it('keeps the old strict response shape for cached pre-pagination miniapps', async () => {
    const fixture = createFixture();

    const result = await fixture.service.list('channel-1', user, {});

    expect(result).toEqual({
      items: [
        {
          id: 'suggestion-1',
          text: '**Идея для поста\n\nПродолжение**',
          authorDisplayName: 'Читатель',
          createdAt: '2026-08-27T10:00:00.000Z',
          reviewStatus: 'pending',
          publicationId: null,
        },
      ],
    });
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('atomically claims a publish request and only enqueues it from the HTTP path', async () => {
    const fixture = createFixture();
    const claimedPayload = createClaimedPayload();
    const claimPending = jest
      .spyOn(fixture.service as any, 'claimPending')
      .mockImplementation(async () => {
        fixture.setPayload(claimedPayload);
        return fixture.row();
      });

    const result = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
      responseVersion: 2,
    });

    expect(result.suggestion.reviewStatus).toBe('publishing');
    expect(result.suggestion).toEqual(
      expect.objectContaining({ textFormat: 'markdown', reviewError: null }),
    );
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledWith('suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });
    expect(fixture.publications.create).not.toHaveBeenCalled();
    expect(fixture.suggestionSubscriptions.assertCanSubmit).toHaveBeenCalledWith(
      'channel-1',
      '42',
      'publisher',
    );
    expect(
      fixture.suggestionSubscriptions.assertCanSubmit.mock.invocationCallOrder[0],
    ).toBeLessThan(claimPending.mock.invocationCallOrder[0]!);
  });

  it.each(['publish', 'draft'] as const)(
    'checks the original author before admitting a new %s claim',
    async (action) => {
      const fixture = createFixture();
      const failure = new ForbiddenException({ code: 'SUGGESTION_SUBSCRIPTION_REQUIRED' });
      fixture.suggestionSubscriptions.assertCanSubmit.mockRejectedValue(failure);

      await expect(
        fixture.service.review('channel-1', 'suggestion-1', user, { action }),
      ).rejects.toBe(failure);

      expect(fixture.suggestionSubscriptions.assertCanSubmit).toHaveBeenCalledWith(
        'channel-1',
        '42',
        'publisher',
      );
      expect(fixture.row().payload.reviewStatus).toBe('pending');
      expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
      expect(fixture.prisma.$executeRaw).not.toHaveBeenCalled();
      expect(fixture.publications.create).not.toHaveBeenCalled();
      expect(fixture.publicationQueue.enqueue).not.toHaveBeenCalled();
      expect(fixture.adminQueue.enqueueSync).not.toHaveBeenCalled();
    },
  );

  it('keeps an unknown author subscription retryable without creating a publication claim', async () => {
    const fixture = createFixture();
    const failure = new ServiceUnavailableException('Subscription verification unavailable');
    fixture.suggestionSubscriptions.assertCanSubmit.mockRejectedValue(failure);

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).rejects.toBe(failure);

    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(fixture.publicationQueue.enqueue).not.toHaveBeenCalled();
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });

  it('does not recheck author membership for an already accepted durable publication claim', async () => {
    const fixture = createFixture(createClaimedPayload());

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({ suggestion: expect.objectContaining({ reviewStatus: 'publishing' }) });

    expect(fixture.suggestionSubscriptions.assertCanSubmit).not.toHaveBeenCalled();
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledWith('suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });
  });

  it('creates a recoverable Publication draft and returns its id from the review action', async () => {
    const fixture = createFixture();
    const claimedPayload = createClaimedPayload({ reviewAction: 'draft' });
    const claimPending = jest
      .spyOn(fixture.service as any, 'claimPending')
      .mockImplementation(async () => {
        fixture.setPayload(claimedPayload);
        return fixture.row();
      });
    const process = jest
      .spyOn(fixture.service, 'processPublicationJob')
      .mockImplementation(async () => {
        fixture.setPayload({
          ...claimedPayload,
          reviewStatus: 'drafted',
          publicationId: 'publication-draft-1',
        });
        return true;
      });

    const result = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'draft',
      responseVersion: 2,
    });

    expect(result.suggestion).toEqual(
      expect.objectContaining({
        reviewStatus: 'drafted',
        publicationId: 'publication-draft-1',
      }),
    );
    expect(claimPending).toHaveBeenCalledWith(
      'suggestion-1',
      'channel-1',
      user,
      'draft',
      expect.objectContaining({ actorUserId: '42' }),
    );
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledWith('suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });
    expect(process).toHaveBeenCalledWith('suggestion-1', 'claim-1');
    expect(fixture.adminQueue.enqueueSync).toHaveBeenCalledWith({
      suggestionId: 'suggestion-1',
      requiredBotId: 'publisher-bot',
      reviewStatus: 'drafted',
      recoverExisting: true,
    });
  });

  it('allows an image-only suggestion to enter the same durable publication claim flow', async () => {
    const fixture = createFixture({ text: '', imageCount: 1, imageStorageVersion: 1 });
    const claimedPayload = createClaimedPayload({
      text: '',
      imageCount: 1,
      imageStorageVersion: 1,
    });
    jest.spyOn(fixture.service as any, 'claimPending').mockImplementation(async () => {
      fixture.setPayload(claimedPayload);
      return fixture.row();
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, {
        action: 'publish',
        responseVersion: 2,
      }),
    ).resolves.toEqual({ suggestion: expect.objectContaining({ reviewStatus: 'publishing' }) });
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledWith('suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });
  });

  it('does not lose a durable claim when immediate queue enqueue fails', async () => {
    const fixture = createFixture();
    const claimedPayload = createClaimedPayload();
    jest.spyOn(fixture.service as any, 'claimPending').mockImplementation(async () => {
      fixture.setPayload(claimedPayload);
      return fixture.row();
    });
    fixture.publicationQueue.enqueue.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({ suggestion: expect.objectContaining({ reviewStatus: 'publishing' }) });
  });

  it('rejects cancel once a publication claim exists', async () => {
    const fixture = createFixture(createClaimedPayload());

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', otherUser, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns a conflict when publish wins while a concurrent cancel is persisting', async () => {
    const fixture = createFixture();
    jest.spyOn(fixture.service as any, 'cancelPending').mockImplementation(async () => {
      fixture.setPayload(createClaimedPayload());
      return null;
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', otherUser, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects cancel for a pending row that still owns an exact durable claim', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewStatus: 'pending' }));
    const cancel = jest.spyOn(fixture.service as any, 'cancelPending');

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cleans stored photos only after cancellation becomes terminal', async () => {
    const fixture = createFixture({ imageCount: 1, imageStorageVersion: 1 });
    const cancelled = {
      ...fixture.row(),
      payload: { ...fixture.row().payload, reviewStatus: 'cancelled' },
    };
    jest.spyOn(fixture.service as any, 'cancelPending').mockResolvedValue(cancelled as never);

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'cancel' }),
    ).resolves.toEqual({ suggestion: expect.objectContaining({ reviewStatus: 'cancelled' }) });

    expect(fixture.prisma.channelSuggestionImageAsset.deleteMany).toHaveBeenCalledWith({
      where: { auditLogId: 'suggestion-1' },
    });
    expect(fixture.suggestionSubscriptions.assertCanSubmit).not.toHaveBeenCalled();
    expect(fixture.publications.create).not.toHaveBeenCalled();
    expect(fixture.adminQueue.enqueueSync).toHaveBeenCalledWith({
      suggestionId: 'suggestion-1',
      requiredBotId: 'publisher-bot',
      reviewStatus: 'cancelled',
      recoverExisting: true,
    });
  });

  it('persists the cancelling editor for terminal admin-card attribution', async () => {
    const fixture = createFixture();
    fixture.prisma.$queryRaw.mockResolvedValue([fixture.row()]);

    await (fixture.service as any).cancelPending('suggestion-1', 'channel-1', otherUser);

    const query = fixture.prisma.$queryRaw.mock.calls[0]?.[0] as { values?: unknown[] };
    const patchValue = query.values?.find(
      (value): value is string =>
        typeof value === 'string' && value.includes('"reviewStatus":"cancelled"'),
    );
    expect(JSON.parse(patchValue ?? '{}')).toEqual(
      expect.objectContaining({
        reviewedByUserId: otherUser.userId,
        reviewedByDisplayName: otherUser.displayName,
      }),
    );
  });

  it('surfaces terminal card-sync enqueue failure so an idempotent review can retry it', async () => {
    const fixture = createFixture({ reviewStatus: 'cancelled' });
    const failure = new Error('Redis unavailable');
    fixture.adminQueue.enqueueSync.mockRejectedValue(failure);

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'cancel' }),
    ).rejects.toBe(failure);

    expect(fixture.adminQueue.enqueueSync).toHaveBeenCalledWith({
      suggestionId: 'suggestion-1',
      requiredBotId: 'publisher-bot',
      reviewStatus: 'cancelled',
      recoverExisting: true,
    });
  });

  it('returns a conflict when cancel wins while a concurrent publish is claiming', async () => {
    const fixture = createFixture();
    jest.spyOn(fixture.service as any, 'claimPending').mockImplementation(async () => {
      fixture.setPayload({ ...fixture.row().payload, reviewStatus: 'cancelled' });
      return null;
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.publicationQueue.enqueue).not.toHaveBeenCalled();
  });

  it('is idempotent only for the same terminal review action', async () => {
    const published = createFixture({ reviewStatus: 'published', publicationId: 'publication-1' });

    await expect(
      published.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({
      suggestion: expect.objectContaining({ reviewStatus: 'published' }),
    });
    await expect(
      published.service.review('channel-1', 'suggestion-1', user, { action: 'cancel' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(published.suggestionSubscriptions.assertCanSubmit).not.toHaveBeenCalled();

    const drafted = createFixture({
      reviewStatus: 'drafted',
      publicationId: 'publication-draft-1',
    });
    await expect(
      drafted.service.review('channel-1', 'suggestion-1', user, { action: 'draft' }),
    ).resolves.toEqual({
      suggestion: expect.objectContaining({
        reviewStatus: 'drafted',
        publicationId: 'publication-draft-1',
      }),
    });
    await expect(
      drafted.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not change an in-flight draft claim into an immediate publish', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewAction: 'draft' }));

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });

  it('keeps cached review clients on the legacy strict suggestion shape', async () => {
    const fixture = createFixture({
      reviewStatus: 'published',
      publicationId: 'publication-1',
    });

    const legacy = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
    });
    const current = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
      responseVersion: 2,
    });

    expect(legacy.suggestion).not.toHaveProperty('textFormat');
    expect(legacy.suggestion).not.toHaveProperty('reviewError');
    expect(current.suggestion).toEqual(
      expect.objectContaining({ textFormat: 'markdown', reviewError: null }),
    );
  });

  it('allows exactly one claim across two concurrent reviewers', async () => {
    const fixture = createFixture();
    const claimedPayload = createClaimedPayload();
    const claim = jest
      .spyOn(fixture.service as any, 'claimPending')
      .mockImplementation(async () => {
        fixture.setPayload(claimedPayload);
        return fixture.row();
      });

    const first = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'publish',
    });
    const second = await fixture.service.review('channel-1', 'suggestion-1', otherUser, {
      action: 'publish',
    });

    expect(first.suggestion.reviewStatus).toBe('publishing');
    expect(second.suggestion.reviewStatus).toBe('publishing');
    expect(claim).toHaveBeenCalledTimes(1);
    expect(fixture.publicationQueue.enqueue).toHaveBeenNthCalledWith(2, 'suggestion-1', 'claim-1', {
      recycleCompleted: true,
    });
  });

  it('uses a SQL compare-and-set that claims only pending suggestions', async () => {
    const fixture = createFixture();
    fixture.prisma.$queryRaw.mockResolvedValue([]);

    await (fixture.service as any).claimPending(
      'suggestion-1',
      'channel-1',
      user,
      'publish',
      fixture.row(),
    );

    const sql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain(
      "COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') = 'pending'",
    );
    expect(sql).toContain("payload->>'reviewClaimToken' IS NULL");
    expect(sql).toContain('action = ?::text');
    expect(sql).toContain('RETURNING id');
  });

  it.each(['publish', 'draft'] as const)(
    'freezes the subscriber link and native contact markup for a new %s claim',
    async (action) => {
      const fixture = createFixture({
        actorUserId: '999',
        authorDisplayName: 'Анна [QA] & Редактор',
        text: 'Связь: Иван',
        textFormat: 'plain',
        textMarkup: [{ type: 'user_mention', from: 7, length: 4, user_id: 123 }],
      });
      let claimPatch: Record<string, unknown> = {};
      fixture.prisma.$queryRaw.mockImplementation(async (query: { values: unknown[] }) => {
        claimPatch = JSON.parse(
          query.values.find(
            (value) => typeof value === 'string' && value.startsWith('{"reviewStatus"'),
          ) as string,
        );
        fixture.setPayload({ ...fixture.row().payload, ...claimPatch });
        return [fixture.row()];
      });
      jest.spyOn(fixture.service as any, 'finalizeClaim').mockImplementation(async () => {
        fixture.setPayload({
          ...fixture.row().payload,
          reviewStatus: action === 'draft' ? 'drafted' : 'published',
          publicationId: 'publication-1',
        });
        return fixture.row();
      });

      await fixture.service.review('channel-1', 'suggestion-1', user, { action });
      expect(claimPatch.reviewPublicationText).toBe(
        'От подписчика [Анна \\[QA\\] & Редактор](max://user/42)\n\nСвязь: [Иван](max://user/123)',
      );
      if (action === 'publish') {
        await fixture.service.processPublicationJob(
          'suggestion-1',
          claimPatch.reviewClaimToken as string,
        );
      }
      const firstRequest = fixture.publications.create.mock.calls[0]![1];
      expect(firstRequest.content).toMatchObject({
        text: claimPatch.reviewPublicationText,
        textFormat: 'markdown',
      });
      fixture.setPayload({
        ...fixture.row().payload,
        reviewStatus: 'publishing',
        authorDisplayName: 'Другое имя',
        text: 'Изменено',
      });
      await fixture.service.processPublicationJob(
        'suggestion-1',
        claimPatch.reviewClaimToken as string,
      );
      expect(fixture.publications.create.mock.calls[1]![1]).toEqual(firstRequest);
    },
  );

  it('keeps pre-upgrade claims byte-compatible instead of changing an existing request hash', async () => {
    const fixture = createFixture(createClaimedPayload());
    jest.spyOn(fixture.service as any, 'finalizeClaim').mockResolvedValue(fixture.row() as never);
    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');
    expect(fixture.publications.create.mock.calls[0]![1].content).toMatchObject({
      text: createClaimedPayload().text,
      textFormat: 'markdown',
    });
  });

  it('publishes in the worker with the stored actor, stable request id and markdown format', async () => {
    const fixture = createFixture(createClaimedPayload());
    const finalize = jest
      .spyOn(fixture.service as any, 'finalizeClaim')
      .mockResolvedValue(fixture.row() as never);

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(fixture.publications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.userId, username: user.username }),
      expect.objectContaining({
        requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
        intent: 'publish',
        content: expect.objectContaining({
          text: '**Идея для поста\n\nПродолжение**',
          textFormat: 'markdown',
        }),
        audience: expect.objectContaining({
          targets: [{ chatId: 'channel-1', entityType: 'channel' }],
        }),
      }),
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'suggestion-1' }),
      expect.objectContaining({ claimToken: 'claim-1' }),
      'publication-1',
    );
  });

  it('moves compact ordered suggestion photos into the idempotent Publication request', async () => {
    const fixture = createFixture(
      createClaimedPayload({ text: '', imageCount: 2, imageStorageVersion: 1 }),
    );
    const first = Buffer.from('first-image');
    const second = Buffer.from('second-image');
    fixture.prisma.channelSuggestionImageAsset.findMany.mockResolvedValue([
      {
        position: 0,
        bytes: first,
        durablePayload: null,
        mimeType: 'image/png',
        fileName: 'first.png',
        sizeBytes: first.length,
      },
      {
        position: 1,
        bytes: second,
        durablePayload: null,
        mimeType: 'image/jpeg',
        fileName: 'second.jpg',
        sizeBytes: second.length,
      },
    ]);
    jest.spyOn(fixture.service as any, 'finalizeClaim').mockResolvedValue(fixture.row() as never);

    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');

    expect(fixture.publications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.userId }),
      expect.objectContaining({
        requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
        content: {
          text: '',
          textFormat: 'markdown',
          buttons: [],
          media: [
            {
              type: 'image',
              base64: first.toString('base64'),
              mimeType: 'image/png',
              fileName: 'first.png',
            },
            {
              type: 'image',
              base64: second.toString('base64'),
              mimeType: 'image/jpeg',
              fileName: 'second.jpg',
            },
          ],
        },
      }),
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(fixture.prisma.channelSuggestionImageAsset.deleteMany).toHaveBeenCalledWith({
      where: { auditLogId: 'suggestion-1' },
    });
  });

  it('moves the Publisher-owned video bytes into Publication without dropping or retyping them', async () => {
    const fixture = createFixture(
      createClaimedPayload({
        text: '',
        imageCount: 0,
        hasVideo: true,
        videoStorageVersion: 1,
        imageStorageVersion: 2,
      }),
    );
    fixture.prisma.channelSuggestionImageAsset.findMany.mockResolvedValue([
      {
        position: 0,
        bytes: TINY_VALID_MP4,
        durablePayload: null,
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
        sizeBytes: TINY_VALID_MP4.length,
      },
    ]);
    jest.spyOn(fixture.service as any, 'finalizeClaim').mockResolvedValue(fixture.row() as never);
    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');
    expect(fixture.publications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.userId }),
      expect.objectContaining({
        content: expect.objectContaining({
          media: [
            {
              type: 'video',
              payload: null,
              base64: TINY_VALID_MP4.toString('base64'),
              mimeType: 'video/mp4',
              fileName: 'clip.mp4',
            },
          ],
        }),
      }),
      PublicationDispatchProfile.PUBLIK_V1,
    );
  });

  it('creates an unscheduled draft with the exact ordered stored photos', async () => {
    const fixture = createFixture(
      createClaimedPayload({
        reviewAction: 'draft',
        text: '',
        imageCount: 2,
        imageStorageVersion: 1,
      }),
    );
    const first = Buffer.from('draft-first-image');
    const second = Buffer.from('draft-second-image');
    fixture.prisma.channelSuggestionImageAsset.findMany.mockResolvedValue([
      {
        position: 0,
        bytes: first,
        durablePayload: null,
        mimeType: 'image/png',
        fileName: 'first.png',
        sizeBytes: first.length,
      },
      {
        position: 1,
        bytes: second,
        durablePayload: null,
        mimeType: 'image/jpeg',
        fileName: 'second.jpg',
        sizeBytes: second.length,
      },
    ]);
    const finalize = jest
      .spyOn(fixture.service as any, 'finalizeClaim')
      .mockResolvedValue(fixture.row() as never);

    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');

    expect(fixture.publications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.userId }),
      expect.objectContaining({
        requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
        intent: 'draft',
        schedule: null,
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'channel-1', entityType: 'channel' }],
        },
        content: expect.objectContaining({
          text: '',
          media: [
            expect.objectContaining({
              base64: first.toString('base64'),
              fileName: 'first.png',
            }),
            expect.objectContaining({
              base64: second.toString('base64'),
              fileName: 'second.jpg',
            }),
          ],
        }),
      }),
      PublicationDispatchProfile.PUBLIK_V1,
    );
    expect(finalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'draft', claimToken: 'claim-1' }),
      'publication-1',
    );
    expect(fixture.prisma.channelSuggestionImageAsset.deleteMany).toHaveBeenCalledWith({
      where: { auditLogId: 'suggestion-1' },
    });
  });

  it('finalizes only the exact draft claim into the drafted terminal status', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewAction: 'draft' }));
    fixture.prisma.$queryRaw.mockResolvedValue([fixture.row()]);
    const claim = {
      action: 'draft' as const,
      claimToken: 'claim-1',
      claimedAt: '2026-08-27T10:05:00.000Z',
      requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
      user,
    };

    await (fixture.service as any).finalizeClaim(fixture.row(), claim, 'publication-draft-1');

    const query = fixture.prisma.$queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
      values?: unknown[];
    };
    const patchValue = query.values?.find(
      (value): value is string =>
        typeof value === 'string' && value.includes('"reviewStatus":"drafted"'),
    );
    expect(JSON.parse(patchValue ?? '{}')).toEqual(
      expect.objectContaining({
        reviewStatus: 'drafted',
        publicationId: 'publication-draft-1',
        draftedAt: expect.any(String),
        reviewedByDisplayName: user.displayName,
      }),
    );
    expect(sqlText(query)).toContain("payload->>'reviewAction' = ?::text");
    expect(query.values).toContain('draft');
  });

  it('recovers an ambiguous draft response with the same Publication request', async () => {
    const claimedPayload = createClaimedPayload({ reviewAction: 'draft' });
    const fixture = createFixture(claimedPayload);
    fixture.publications.create.mockResolvedValue({ id: 'publication-draft-existing' });
    fixture.prisma.publicationMutationRecord.findUnique.mockResolvedValue({
      publicationId: 'publication-draft-existing',
    });
    let finalizeAttempt = 0;
    jest.spyOn(fixture.service as any, 'finalizeClaim').mockImplementation(async () => {
      finalizeAttempt += 1;
      if (finalizeAttempt === 1) {
        return null;
      }
      fixture.setPayload({
        ...claimedPayload,
        reviewStatus: 'drafted',
        publicationId: 'publication-draft-existing',
      });
      return fixture.row();
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'draft' }),
    ).rejects.toBeInstanceOf(ConflictException);
    const recovered = await fixture.service.review('channel-1', 'suggestion-1', user, {
      action: 'draft',
      responseVersion: 2,
    });

    expect(recovered.suggestion).toEqual(
      expect.objectContaining({
        reviewStatus: 'drafted',
        publicationId: 'publication-draft-existing',
      }),
    );
    expect(fixture.publications.create).toHaveBeenCalledTimes(2);
    expect(fixture.publications.create.mock.calls[1]).toEqual(
      fixture.publications.create.mock.calls[0],
    );
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it('rebuilds the exact same photo request when a worker retries after publication creation', async () => {
    const fixture = createFixture(createClaimedPayload({ imageCount: 1, imageStorageVersion: 1 }));
    const image = Buffer.from('stable-image');
    fixture.prisma.channelSuggestionImageAsset.findMany.mockResolvedValue([
      {
        position: 0,
        bytes: image,
        durablePayload: null,
        mimeType: 'image/png',
        fileName: 'stable.png',
        sizeBytes: image.length,
      },
    ]);
    fixture.publications.create.mockResolvedValue({ id: 'publication-existing' });
    jest.spyOn(fixture.service as any, 'finalizeClaim').mockResolvedValue(fixture.row() as never);

    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');
    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');

    expect(fixture.publications.create).toHaveBeenCalledTimes(2);
    expect(fixture.publications.create.mock.calls[1]).toEqual(
      fixture.publications.create.mock.calls[0],
    );
    expect(fixture.publications.create.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
        content: expect.objectContaining({
          media: [
            {
              type: 'image',
              base64: image.toString('base64'),
              mimeType: 'image/png',
              fileName: 'stable.png',
            },
          ],
        }),
      }),
    );
  });

  it('keeps the exact claim retryable when compact photo rows are unavailable', async () => {
    const fixture = createFixture(
      createClaimedPayload({ text: '', imageCount: 1, imageStorageVersion: 1 }),
    );
    const release = jest.spyOn(fixture.service as any, 'releaseTerminalClaim');

    await expect(
      fixture.service.processPublicationJob('suggestion-1', 'claim-1'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fixture.publications.create).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('accepts a concurrent terminal finalize that cleaned source photos first', async () => {
    const claimedPayload = createClaimedPayload({
      text: '',
      imageCount: 1,
      imageStorageVersion: 1,
    });
    const fixture = createFixture(claimedPayload);
    fixture.prisma.channelSuggestionImageAsset.findMany.mockImplementation(async () => {
      fixture.setPayload({
        ...claimedPayload,
        reviewStatus: 'published',
        publicationId: 'publication-existing',
      });
      return [];
    });

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(fixture.publications.create).not.toHaveBeenCalled();
    expect(fixture.prisma.channelSuggestionImageAsset.deleteMany).toHaveBeenCalledWith({
      where: { auditLogId: 'suggestion-1' },
    });
  });

  it('recovers a crash after publication creation without creating a duplicate', async () => {
    const fixture = createFixture(createClaimedPayload());
    fixture.publications.create.mockResolvedValue({ id: 'publication-existing' });
    const finalize = jest
      .spyOn(fixture.service as any, 'finalizeClaim')
      .mockResolvedValue(fixture.row() as never);

    await fixture.service.processPublicationJob('suggestion-1', 'claim-1');

    expect(fixture.publications.create).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requestId: buildPublisherSuggestionPublicationRequestId('suggestion-1', 'claim-1'),
      }),
      'publication-existing',
    );
  });

  it('ignores a superseded worker token before idempotent publication creation', async () => {
    const fixture = createFixture(createClaimedPayload());

    await expect(
      fixture.service.processPublicationJob('suggestion-1', 'stale-token'),
    ).resolves.toBe(true);

    expect(fixture.prisma.publicationMutationRecord.findUnique).not.toHaveBeenCalled();
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });

  it('reconciles a pending row that still owns the exact migrated claim token', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewStatus: 'pending' }));
    const finalize = jest
      .spyOn(fixture.service as any, 'finalizeClaim')
      .mockResolvedValue(fixture.row() as never);

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(fixture.publications.create).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claimToken: 'claim-1' }),
      'publication-1',
    );
  });

  it('releases an exact claim after a terminal create failure', async () => {
    const fixture = createFixture(createClaimedPayload());
    fixture.publications.create.mockRejectedValue(new BadRequestException('invalid content'));
    const release = jest
      .spyOn(fixture.service as any, 'releaseTerminalClaim')
      .mockResolvedValue(undefined as never);

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(release).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ claimToken: 'claim-1' }),
      'invalid content',
    );
    expect(fixture.prisma.channelSuggestionImageAsset.deleteMany).not.toHaveBeenCalled();
  });

  it('clears a terminal exact claim from the pending recovery state', async () => {
    const fixture = createFixture(createClaimedPayload({ reviewStatus: 'pending' }));
    fixture.publications.create.mockRejectedValue(new BadRequestException('invalid content'));

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      true,
    );

    expect(sqlText(fixture.prisma.$executeRaw.mock.calls[0]?.[0])).toContain(
      "payload->>'reviewStatus' IN ('publishing', 'pending')",
    );
  });

  it('keeps the exact claim for a retryable create failure', async () => {
    const fixture = createFixture(createClaimedPayload());
    const transient = new Error('database unavailable');
    fixture.publications.create.mockRejectedValue(transient);
    const release = jest.spyOn(fixture.service as any, 'releaseTerminalClaim');

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).rejects.toBe(
      transient,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('does not bind a colliding actor/request publication without request-hash validation', async () => {
    const fixture = createFixture(createClaimedPayload());
    const collision = new BadRequestException(
      'Ключ повтора уже использован для другого изменения.',
    );
    fixture.publications.create.mockRejectedValue(collision);
    fixture.prisma.publicationMutationRecord.findUnique.mockResolvedValue({
      publicationId: 'unrelated-publication',
    });
    const finalize = jest.spyOn(fixture.service as any, 'finalizeClaim');
    const release = jest.spyOn(fixture.service as any, 'releaseTerminalClaim');

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).rejects.toBe(
      collision,
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('does not release a terminal claim when publication absence cannot be proven', async () => {
    const fixture = createFixture(createClaimedPayload());
    const lookupFailure = new Error('publication lookup unavailable');
    fixture.prisma.publicationMutationRecord.findUnique.mockRejectedValueOnce(lookupFailure);
    fixture.publications.create.mockRejectedValue(new BadRequestException('invalid content'));
    const release = jest.spyOn(fixture.service as any, 'releaseTerminalClaim');

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).rejects.toBe(
      lookupFailure,
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('leaves legacy queue claims to the existing channel-dialog processor', async () => {
    const fixture = createFixture({
      ...createClaimedPayload(),
      reviewPublicationProtocol: 'max_action_ledger_v1',
    });

    await expect(fixture.service.processPublicationJob('suggestion-1', 'claim-1')).resolves.toBe(
      false,
    );
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });

  it('upgrades a pre-deploy inline publishing claim to the durable queue protocol', async () => {
    const legacyPayload = {
      type: 'suggest',
      text: 'Старая предложка',
      reviewStatus: 'publishing',
      reviewedAt: '2026-08-27T10:05:00.000Z',
      reviewedByUserId: user.userId,
    };
    const fixture = createFixture(legacyPayload);
    const migratedPayload = {
      ...legacyPayload,
      reviewAction: 'publish',
      reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
      reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
      reviewPublicationRequestId:
        buildLegacyPublisherSuggestionPublicationRequestId('suggestion-1'),
      reviewClaimToken: 'migrated-claim-1',
      reviewClaimedAt: legacyPayload.reviewedAt,
      reviewClaimedByUserId: user.userId,
      reviewClaimMigratedFrom: 'inline_v0',
    };
    jest.spyOn(fixture.service as any, 'migrateLegacyInlineClaim').mockImplementation(async () => {
      fixture.setPayload(migratedPayload);
      return fixture.row();
    });

    await expect(
      fixture.service.review('channel-1', 'suggestion-1', user, { action: 'publish' }),
    ).resolves.toEqual({ suggestion: expect.objectContaining({ reviewStatus: 'publishing' }) });
    expect(fixture.publicationQueue.enqueue).toHaveBeenCalledWith(
      'suggestion-1',
      'migrated-claim-1',
      { recycleCompleted: true },
    );
  });

  it('migrates only the exact legacy inline reviewer and timestamp claim', async () => {
    const fixture = createFixture();
    fixture.prisma.$queryRaw.mockResolvedValue([]);
    const row = {
      ...fixture.row(),
      payload: {
        ...fixture.row().payload,
        reviewStatus: 'publishing',
        reviewedAt: '2026-08-27T10:05:00.000Z',
        reviewedByUserId: user.userId,
      },
    };

    await (fixture.service as any).migrateLegacyInlineClaim(row, row.payload, user);

    const sql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain("payload->>'reviewPublicationProtocol' IS NULL");
    expect(sql).toContain("payload->>'reviewedByUserId' = ?::text");
    expect(sql).toContain("payload->>'reviewedAt' = ?::text");
  });

  it('does not migrate a recent inline claim that an old HTTP worker can still own', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-27T12:00:00.000Z'));
    const fixture = createFixture();
    const row = {
      ...fixture.row(),
      payload: {
        ...fixture.row().payload,
        reviewStatus: 'publishing',
        reviewedAt: '2026-08-27T11:55:00.000Z',
        reviewedByUserId: user.userId,
      },
    };

    await expect(
      (fixture.service as any).migrateLegacyInlineClaim(row, row.payload, user),
    ).resolves.toBeNull();
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('falls through when the job belongs to the legacy audit-log action', async () => {
    const fixture = createFixture();
    fixture.prisma.auditLog.findFirst.mockResolvedValue(null);

    await expect(
      fixture.service.processPublicationJob('legacy-suggestion', 'claim-1'),
    ).resolves.toBe(false);
    expect(fixture.publications.create).not.toHaveBeenCalled();
  });
});
