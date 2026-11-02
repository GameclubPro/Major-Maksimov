import { publicationAdminAccessWhere, publicationAdminScope } from './publication-admin-access';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { MINIAPP_PROFILES_METADATA } from '../auth/miniapp-profile';
import { publicationAssetReferenceWhere } from './publication-asset-access';
import { PublicationDraftsService } from './publication-drafts.service';
import { PublicationDraftsController } from './publication-drafts.controller';
import { PublicationAssetsController } from './publication-assets.controller';
import { PublicationVideoUploadsController } from './publication-video-uploads.controller';
import { MAX_PUBLICATION_DRAFT_STORAGE_BYTES } from '@maxim/contracts/publication-draft';

const actor = { userId: 'owner', username: null, displayName: null };
const request = {
  requestId: 'draft-request',
  title: '',
  content: { text: '', textFormat: 'plain', media: [], buttons: [] },
  targets: [],
  state: {
    formatVersion: 1,
    timingMode: 'once',
    scheduleKind: 'slots',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    onceDate: '',
    onceTime: '',
    recurrence: {
      frequency: 'weekly',
      interval: 1,
      weekdays: [],
      times: [''],
      startsAt: null,
      endsAt: null,
      maxOccurrences: null,
    },
  },
};

const draftPresentation = {
  id: 'draft',
  title: '',
  lifecycle: 'DRAFT',
  version: 1,
  contentPreview: '',
  targetCount: 0,
  targetPreviews: [],
  targetOverflowCount: 0,
  audienceSelection: 'SELECTED',
  audienceMode: 'SNAPSHOT',
  mediaCount: 0,
  hasVideo: false,
  schedule: null,
  delivery: { total: 0, sent: 0, pending: 0, failed: 0, ambiguous: 0, canceled: 0 },
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  content: { revision: 1, text: '', textFormat: 'plain', media: [], buttons: [] },
  targets: [],
  occurrences: [],
};

function setup() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    publication: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'draft', version: 1 }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    publicationTarget: { deleteMany: jest.fn(), createMany: jest.fn() },
    publicationSchedule: { upsert: jest.fn() },
    publicationMutationRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    publicationContentRevision: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
    },
    publicationContentAsset: { findMany: jest.fn().mockResolvedValue([]) },
    publicationAsset: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn() },
    publisherPostImportSession: { updateMany: jest.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(tx)),
  };
  const content = {
    prepareContentRevision: jest.fn().mockResolvedValue({ text: '', buttons: [], assets: [] }),
    assertPublisherCompatibleContent: jest.fn(),
    persistPreparedContentRevision: jest.fn().mockResolvedValue({ id: 'revision' }),
  };
  const routing = {
    requireNewRoute: jest
      .fn()
      .mockReturnValue({ dispatchProfile: 'PUBLIK_V1', requiredBotId: 'publik' }),
  };
  const policy = { resolveDraftTargets: jest.fn().mockResolvedValue([]) };
  const presenter = {
    loadPublisherTargetPresentations: jest.fn().mockResolvedValue([]),
    mapPublicationDetails: jest.fn().mockResolvedValue(draftPresentation),
  };
  const service = new PublicationDraftsService(
    prisma as never,
    content as never,
    presenter as never,
    routing as never,
    policy as never,
  );
  const get = jest
    .spyOn(service, 'get')
    .mockResolvedValue({ publication: { id: 'draft', version: 1 }, state: null } as never);
  return { tx, prisma, content, routing, policy, service, get };
}

describe('PublicationDraftsService', () => {
  it('saves and restores raw JSON containing legacy minute UTC slots and recurrence values', async () => {
    const { service, tx, get } = setup();
    get.mockRestore();
    const state = {
      ...request.state,
      scheduledSlots: ['2026-10-20T00:00Z', '2026-10-21T00:00:00.123456789Z'],
      recurrence: {
        ...request.state.recurrence,
        startsAt: '2026-10-20T00:00Z',
        endsAt: '2026-10-21T00:00Z',
      },
    };
    let storedRule: unknown;
    tx.publicationSchedule.upsert.mockImplementation(async (input) => {
      storedRule = JSON.parse(JSON.stringify(input.create.rule));
      return {};
    });
    tx.publication.findFirst.mockImplementation(async () => ({
      id: 'draft',
      version: 1,
      targets: [],
      schedule: { rule: storedRule },
    }));
    const saved = await service.save(null, actor, { ...request, state });
    expect(storedRule).toEqual(state);
    expect(saved.state).toEqual(state);
    expect((await service.get('draft', actor)).state).toEqual(state);
  });

  it('restores an existing minute-only draft and still rejects malformed persisted state', async () => {
    const { service, tx, get } = setup();
    get.mockRestore();
    const row = {
      id: 'draft',
      version: 1,
      targets: [],
      schedule: { rule: { ...request.state, scheduledSlots: ['2026-10-20T00:00Z'] } },
    };
    tx.publication.findFirst.mockResolvedValue(row);
    expect((await service.get('draft', actor)).state).toEqual(row.schedule.rule);
    row.schedule.rule.scheduledSlots = ['2026-02-30T00:00Z'];
    expect((await service.get('draft', actor)).state).toBeNull();
  });
  it.each([
    PublicationDraftsController,
    PublicationAssetsController,
    PublicationVideoUploadsController,
  ])('keeps %p Publisher-only', (controller) => {
    expect(Reflect.getMetadata(MINIAPP_PROFILES_METADATA, controller)).toEqual(['publisher']);
  });
  it('saves an empty, recipient-free draft without any dispatchable schedule', async () => {
    const { service, tx, content, policy } = setup();
    await service.save(null, actor, request);
    expect(policy.resolveDraftTargets).toHaveBeenCalledWith(actor, []);
    expect(tx.publication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: 'owner',
        dispatchProfile: 'PUBLIK_V1',
        lifecycle: 'DRAFT',
      }),
    });
    expect(tx.publicationSchedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'DRAFT',
          nextMaterializeAt: null,
          rule: request.state,
        }),
      }),
    );
    expect(content.persistPreparedContentRevision).toHaveBeenCalledWith(
      tx,
      'draft',
      1,
      expect.anything(),
      'owner',
    );
  });
  it('checks ownership, never-dispatched state and expected version inside the transaction', async () => {
    const { service, tx, get } = setup();
    tx.publication.findFirst.mockResolvedValue({
      id: 'draft',
      version: 4,
      canonicalContentRevision: { revision: 7 },
    } as never);
    get.mockResolvedValue({ publication: { id: 'draft', version: 5 }, state: null } as never);
    await service.save('draft', actor, { ...request, expectedRevision: 4 });
    expect(tx.publication.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'draft',
        ...publicationAdminAccessWhere(publicationAdminScope('owner'), 'PUBLIK_V1', 'manage'),
        lifecycle: 'DRAFT',
        dispatchProfile: 'PUBLIK_V1',
        occurrences: { none: {} },
        version: 4,
      }),
      data: { version: { increment: 1 }, title: '' },
    });
    expect(tx.publicationMutationRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ resultingVersion: 5, actorUserId: 'owner' }),
    });
  });
  it('rejects an unknown/foreign draft before content is persisted', async () => {
    const { service, content } = setup();
    await expect(
      service.save('other-draft', actor, { ...request, expectedRevision: 1 }),
    ).rejects.toThrow(NotFoundException);
    expect(content.persistPreparedContentRevision).not.toHaveBeenCalled();
  });
  it('rejects stale versions and lost compare-and-set', async () => {
    const { service, tx, content } = setup();
    tx.publication.findFirst.mockResolvedValue({ id: 'draft', version: 2 } as never);
    await expect(service.save('draft', actor, { ...request, expectedRevision: 1 })).rejects.toThrow(
      ConflictException,
    );
    tx.publication.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.save('draft', actor, { ...request, expectedRevision: 2 })).rejects.toThrow(
      ConflictException,
    );
    expect(content.persistPreparedContentRevision).not.toHaveBeenCalled();
  });
  it('bounds quota reads and never includes media bytes', async () => {
    const { service, tx } = setup();
    tx.publication.findMany.mockResolvedValue(
      Array.from({ length: 50 }, () => ({ canonicalContentRevision: null })) as never,
    );
    await expect(service.save(null, actor, request)).rejects.toThrow(BadRequestException);
    const query = tx.publication.findMany.mock.calls[0][0];
    expect(query.take).toBe(51);
    expect(JSON.stringify(query)).not.toContain('bytes');
    expect(tx.publication.create).not.toHaveBeenCalled();
  });
  it('enforces stored-media quota', async () => {
    const { service, tx, content } = setup();
    tx.publication.findMany.mockResolvedValue([
      {
        canonicalContentRevision: {
          assets: [{ asset: { sizeBytes: MAX_PUBLICATION_DRAFT_STORAGE_BYTES } }],
        },
      },
    ] as never);
    content.prepareContentRevision.mockResolvedValue({
      text: '',
      buttons: [],
      assets: [{ kind: 'prepared', sizeBytes: 1 }],
    } as never);
    await expect(service.save(null, actor, request)).rejects.toThrow('128 МБ');
  });
  it('checks quota with bounded exact asset/source pairs and no media bytes', async () => {
    const { service, tx, content } = setup();
    const assets = [
      {
        kind: 'reference' as const,
        assetId: 'shared-a',
        expectedType: 'image' as const,
        sourcePublicationId: 'source-a',
      },
      {
        kind: 'reference' as const,
        assetId: 'shared-b',
        expectedType: 'image' as const,
        sourcePublicationId: 'source-b',
      },
    ];
    content.prepareContentRevision.mockResolvedValue({ text: '', buttons: [], assets } as never);
    tx.publicationAsset.findMany.mockResolvedValue(
      assets.map((asset) => ({ id: asset.assetId, sizeBytes: 10 })) as never,
    );
    await service.save(null, actor, request);
    expect(tx.publicationAsset.findMany).toHaveBeenCalledTimes(1);
    expect(tx.publicationAsset.findMany).toHaveBeenCalledWith({
      where: { OR: assets.map((asset) => publicationAssetReferenceWhere('owner', asset)) },
      select: { id: true, sizeBytes: true },
    });
  });
  it('rejects duplicate asset IDs with different sources before a batch can authorize either', async () => {
    const { service, tx, content } = setup();
    content.prepareContentRevision.mockResolvedValue({
      text: '',
      buttons: [],
      assets: [
        {
          kind: 'reference',
          assetId: 'same',
          expectedType: 'image',
          sourcePublicationId: 'allowed',
        },
        {
          kind: 'reference',
          assetId: 'same',
          expectedType: 'image',
          sourcePublicationId: 'unrelated',
        },
      ],
    } as never);
    await expect(service.save(null, actor, request)).rejects.toThrow('Один и тот же медиафайл');
    expect(tx.publicationAsset.findMany).not.toHaveBeenCalled();
    expect(content.persistPreparedContentRevision).not.toHaveBeenCalled();
  });
  it('prunes only unreferenced revisions and actor-owned orphan assets', async () => {
    const { service, tx } = setup();
    tx.publicationContentRevision.findMany.mockResolvedValue([
      { id: 'old-revision', assets: [{ assetId: 'old-asset' }] },
    ] as never);
    await service.save(null, actor, request);
    expect(tx.publicationContentRevision.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        canonicalForPublication: { is: null },
        deliveries: { none: {} },
        occurrences: { none: {} },
        executionBroadcasts: { none: {} },
        id: { in: ['old-revision'] },
      }),
    });
    expect(tx.publicationAsset.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['old-asset'] }, actorUserId: 'owner', contentLinks: { none: {} } },
    });
  });
  it('replays an identical write but refuses to acknowledge a later server version', async () => {
    const { service, tx, prisma, get } = setup();
    await service.save(null, actor, request);
    const record = tx.publicationMutationRecord.create.mock.calls[0][0].data;
    tx.publicationMutationRecord.findUnique.mockResolvedValue(record as never);
    tx.publication.findFirst.mockResolvedValue({ id: 'draft' } as never);
    prisma.$transaction.mockClear();
    await service.save(null, actor, request);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    get.mockResolvedValue({ publication: { id: 'draft', version: 2 }, state: null } as never);
    await expect(service.save(null, actor, request)).rejects.toThrow(ConflictException);
    await expect(service.save(null, actor, { ...request, title: 'Changed' })).rejects.toThrow(
      ConflictException,
    );
  });
  it('deletion cannot remove a published or concurrently dispatched post', async () => {
    const { service, tx } = setup();
    const action = { requestId: 'remove-request', expectedRevision: 1 };
    tx.publication.findFirst.mockResolvedValue({ lifecycle: 'ACTIVE', version: 1 } as never);
    await expect(service.remove('draft', actor, action)).rejects.toThrow(ConflictException);
    expect(tx.publication.deleteMany).not.toHaveBeenCalled();
    tx.publication.findFirst.mockResolvedValue({ lifecycle: 'DRAFT', version: 1 } as never);
    tx.publication.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove('draft', actor, action)).rejects.toThrow(ConflictException);
    expect(tx.publication.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        ...publicationAdminAccessWhere(publicationAdminScope('owner'), 'PUBLIK_V1', 'manage'),
        dispatchProfile: 'PUBLIK_V1',
        occurrences: { none: {} },
        version: 1,
      }),
    });
    expect(tx.publicationAsset.deleteMany).not.toHaveBeenCalled();
  });
  it('get and lookup constrain both owner and profile', async () => {
    const { service, tx, get } = setup();
    get.mockRestore();
    await expect(service.get('draft', actor)).rejects.toThrow(NotFoundException);
    expect(tx.publication.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'draft',
          ...publicationAdminAccessWhere(publicationAdminScope('owner'), 'PUBLIK_V1'),
          dispatchProfile: 'PUBLIK_V1',
          lifecycle: 'DRAFT',
          occurrences: { none: {} },
        }),
      }),
    );
    await expect(service.byRequest('draft-request', actor)).rejects.toThrow(NotFoundException);
    expect(tx.publication.findFirst).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        requestId: 'draft-request',
        ...publicationAdminAccessWhere(publicationAdminScope('owner'), 'PUBLIK_V1'),
        dispatchProfile: 'PUBLIK_V1',
      }),
      select: { id: true },
    });
  });
});
