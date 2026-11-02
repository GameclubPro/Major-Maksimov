import { createHash } from 'node:crypto';
import {
  MaxMediaUploadValidationError,
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  validateMaxMediaUploadPayload,
} from '../max/max-media-upload-validation';
import {
  AdminManagedBroadcastMediaRuntime,
  ManagedBroadcastTransientUploadError,
  type ManagedBroadcastExecutionMedia,
} from './admin-managed-broadcast-media-runtime';
import { PUBLICATION_ASSET_METADATA_SELECT } from './publication-media-limits';
import { PUBLICATION_UPLOADED_VIDEO_FIELD } from './publication-video-media';
import { AdminManagedBroadcastMessageRuntime } from './admin-managed-broadcast-message-runtime';

const JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z',
  'base64',
);
const row = { publicationContentRevisionId: 'revision-current', actorUserId: 'owner' };
const background = {
  trafficClass: 'background' as const,
  actionHealthLane: 'background' as const,
  sourceTag: 'managed_broadcast' as const,
};

function createAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'image-owned',
    actorUserId: 'owner',
    sha256: createHash('sha256').update(JPEG).digest('hex'),
    sizeBytes: JPEG.length,
    mimeType: 'application/octet-stream',
    fileName: '../notice.bin',
    durablePayload: null,
    ...overrides,
  };
}

function createRuntime(assets = [createAsset()]) {
  const revisionFindFirst = jest
    .fn()
    .mockResolvedValue({ assets: assets.map((asset) => ({ asset })) });
  const assetFindFirst = jest.fn().mockResolvedValue({ bytes: JPEG });
  const validateMedia = jest.fn((type: 'image', bytes: Buffer) =>
    validateMaxMediaUploadPayload(type, bytes),
  );
  const uploadImage = jest.fn().mockResolvedValue({ token: 'image-token' });
  const uploadVideo = jest.fn().mockResolvedValue({ token: 'video-token' });
  const warn = jest.fn();
  const runtime = new AdminManagedBroadcastMediaRuntime({
    prisma: {
      publicationContentRevision: { findFirst: revisionFindFirst },
      publicationAsset: { findFirst: assetFindFirst },
    },
    maxClient: { validateMediaUploadPayload: validateMedia, uploadImage, uploadVideo },
    logger: { warn },
  } as never);
  const progress = jest.fn().mockResolvedValue(undefined);
  const resolve = (source: ManagedBroadcastExecutionMedia, botId = 'publisher') =>
    runtime.resolveManagedBroadcastExecutionMedia(
      source,
      source.requestMedia as never,
      'channel',
      'source-channel',
      'owner',
      botId,
      background,
      progress,
    );
  return {
    runtime,
    revisionFindFirst,
    assetFindFirst,
    validateMedia,
    uploadImage,
    uploadVideo,
    warn,
    progress,
    resolve,
    load: () => runtime.loadManagedBroadcastExecutionMedia(row as never),
  };
}

describe('canonical Publication execution binary media', () => {
  it('uses the rebound content revision and ignores stale inline envelope images', async () => {
    const { runtime, revisionFindFirst } = createRuntime();
    const execution = await runtime.loadManagedBroadcastExecutionMedia({
      ...row,
      publicationContentRevisionId: 'revision-latest',
      imageEnabled: true,
      imageBase64: 'stale-inline-image',
    } as never);
    expect(revisionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'revision-latest', publication: { actorUserId: 'owner' } },
      }),
    );
    expect(execution.publicationSource?.contentRevisionId).toBe('revision-latest');
    expect(execution.requestMedia.imageBase64).toBe('');
  });

  it.each(['image', 'video'])(
    'renders media-only %s with resolved attachments despite the empty DTO projection',
    async (type) => {
      const { load, resolve } = createRuntime([
        createAsset(
          type === 'video'
            ? {
                mimeType: 'video/mp4',
                durablePayload: {
                  [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
                    version: 1,
                    botId: 'publisher',
                    token: 'remote-video',
                  },
                },
              }
            : {},
        ),
      ]);
      const execution = await load();
      const media = await resolve(execution);
      const messages = new AdminManagedBroadcastMessageRuntime(
        {
          resolveBroadcastButtonContext: jest
            .fn()
            .mockResolvedValue({ buttons: [], commentDialogReference: null }),
        } as never,
        { warn: jest.fn() } as never,
      );
      const message = await messages.buildMessage(
        'target',
        'channel',
        {
          ...execution.requestMedia,
          textFormat: 'plain',
          buttons: [],
          buttonEnabled: false,
          buttonText: '',
          buttonUrl: '',
        } as never,
        '',
        media,
        'publisher',
      );
      expect(message.messageText).toBe(' ');
      expect(message.messageOptions).toMatchObject(media);
    },
  );

  it('loads only ordered metadata for the exact revision and actor before preparation', async () => {
    const { load, revisionFindFirst, assetFindFirst } = createRuntime();
    const execution = await load();
    expect(revisionFindFirst).toHaveBeenCalledWith({
      where: { id: 'revision-current', publication: { actorUserId: 'owner' } },
      select: {
        assets: {
          orderBy: [{ position: 'asc' }],
          select: {
            asset: { select: { ...PUBLICATION_ASSET_METADATA_SELECT, actorUserId: true } },
          },
        },
      },
    });
    expect(execution.publicationSource).toEqual({
      contentRevisionId: row.publicationContentRevisionId,
      actorUserId: row.actorUserId,
      assets: [createAsset()],
    });
    expect(execution.requestMedia).toMatchObject({ imageBase64: '', images: [] });
    expect(assetFindFirst).not.toHaveBeenCalled();
  });

  it('uploads a validated Buffer view without base64 decoding and binds its exact revision link', async () => {
    const fixture = new Uint8Array(JPEG.length + 16);
    fixture.set(JPEG, 8);
    const bytes = fixture.subarray(8, 8 + JPEG.length);
    const { runtime, load, resolve, assetFindFirst, uploadImage, progress } = createRuntime();
    assetFindFirst.mockResolvedValue({ bytes });
    const decode = jest
      .spyOn(runtime as any, 'decodeBroadcastImageBase64')
      .mockImplementation(() => {
        throw new Error('Canonical execution must not decode base64');
      });
    const execution = await load();
    expect(await resolve(execution)).toEqual({ imagePayload: { token: 'image-token' } });
    expect(assetFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'image-owned',
        actorUserId: 'owner',
        sha256: createAsset().sha256,
        sizeBytes: JPEG.length,
        contentLinks: {
          some: {
            contentRevisionId: 'revision-current',
            contentRevision: { publication: { actorUserId: 'owner' } },
          },
        },
      },
      select: { bytes: true },
    });
    const uploaded = uploadImage.mock.calls[0]?.[0] as Buffer;
    expect(uploaded).toEqual(JPEG);
    expect(uploaded.buffer).toBe(bytes.buffer);
    expect(uploaded.byteOffset).toBe(bytes.byteOffset);
    expect(uploadImage).toHaveBeenCalledWith(uploaded, 'notice.jpg', 'image/jpeg', {
      ...background,
      botId: 'publisher',
    });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(decode).not.toHaveBeenCalled();
  });

  it('reads and uploads each image sequentially while preserving attachment order', async () => {
    const assets = [createAsset({ id: 'first' }), createAsset({ id: 'second' })];
    const { load, resolve, assetFindFirst, uploadImage, progress } = createRuntime(assets);
    const events: string[] = [];
    assetFindFirst.mockImplementation(async ({ where }) => {
      events.push(`read:${where.id}`);
      return { bytes: JPEG };
    });
    uploadImage.mockImplementation(async () => {
      const token = `token-${uploadImage.mock.calls.length}`;
      events.push(token);
      return { token };
    });
    progress.mockImplementation(async () => {
      events.push('progress');
    });
    const execution = await load();
    expect(await resolve(execution)).toEqual({
      attachments: [
        { type: 'image', payload: { token: 'token-1' } },
        { type: 'image', payload: { token: 'token-2' } },
      ],
    });
    expect(events).toEqual([
      'read:first',
      'token-1',
      'progress',
      'read:second',
      'token-2',
      'progress',
    ]);
  });

  it('rejects a missing or foreign revision before reading bytes', async () => {
    const { load, revisionFindFirst, assetFindFirst, uploadImage } = createRuntime();
    revisionFindFirst.mockResolvedValue(null);
    await expect(load()).rejects.toThrow('больше недоступно');
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it.each(['image', 'video'])(
    'sends a copied %s through its accepted revision while retaining the original asset owner',
    async (type) => {
      const bytes = type === 'image' ? JPEG : Buffer.from('copied-video');
      const asset = createAsset({
        actorUserId: 'original-author',
        mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
        sizeBytes: bytes.length,
      });
      const { load, resolve, assetFindFirst, uploadImage, uploadVideo } = createRuntime([asset]);
      assetFindFirst.mockResolvedValue({ bytes });
      const result = await resolve(await load());
      expect(result).toEqual(
        type === 'image'
          ? { imagePayload: { token: 'image-token' } }
          : { attachments: [{ type: 'video', payload: { token: 'video-token' } }] },
      );
      expect(assetFindFirst).toHaveBeenCalledWith({
        where: {
          id: asset.id,
          actorUserId: 'original-author',
          sha256: asset.sha256,
          sizeBytes: bytes.length,
          contentLinks: {
            some: {
              contentRevisionId: 'revision-current',
              contentRevision: { publication: { actorUserId: 'owner' } },
            },
          },
        },
        select: { bytes: true },
      });
      expect(type === 'image' ? uploadImage : uploadVideo).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects an execution source passed under another actor', async () => {
    const { runtime, load, assetFindFirst, uploadImage } = createRuntime();
    const execution = await load();
    await expect(
      runtime.resolveManagedBroadcastExecutionMedia(
        execution,
        execution.requestMedia as never,
        'channel',
        'source',
        'other-owner',
        'publisher',
      ),
    ).rejects.toThrow('больше недоступно');
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it.each([null, { bytes: null }, { bytes: JPEG.subarray(1) }])(
    'rejects missing or inconsistent immutable bytes before validation/upload',
    async (asset) => {
      const { load, resolve, assetFindFirst, validateMedia, uploadImage } = createRuntime();
      const execution = await load();
      assetFindFirst.mockResolvedValue(asset);
      await expect(resolve(execution)).rejects.toThrow('больше недоступно');
      expect(validateMedia).not.toHaveBeenCalled();
      expect(uploadImage).not.toHaveBeenCalled();
    },
  );

  it('keeps the current scheduled image cap without reading oversized bytes', async () => {
    const { load, resolve, assetFindFirst, uploadImage } = createRuntime([
      createAsset({ sizeBytes: 6_000_001 }),
    ]);
    await expect(resolve(await load())).rejects.toThrow('Фото слишком большое');
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('preserves deterministic invalid-image classification before dispatch', async () => {
    const invalid = Buffer.from('not-an-image');
    const { load, resolve, assetFindFirst, uploadImage, warn } = createRuntime([
      createAsset({ sizeBytes: invalid.length }),
    ]);
    assetFindFirst.mockResolvedValue({ bytes: invalid });
    await expect(resolve(await load())).rejects.toBeInstanceOf(MaxMediaUploadValidationError);
    expect(uploadImage).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps upload retry options, bytes and progress without rereading the asset', async () => {
    const { runtime, load, resolve, assetFindFirst, uploadImage, progress } = createRuntime();
    const sleep = jest.spyOn(runtime as any, 'sleep').mockResolvedValue(undefined);
    uploadImage.mockRejectedValueOnce({ response: { status: 429 } });
    await expect(resolve(await load())).resolves.toEqual({
      imagePayload: { token: 'image-token' },
    });
    expect(assetFindFirst).toHaveBeenCalledTimes(1);
    expect(uploadImage).toHaveBeenCalledTimes(2);
    expect(uploadImage.mock.calls[0]?.[0]).toBe(uploadImage.mock.calls[1]?.[0]);
    expect(uploadImage.mock.calls[0]?.[3]).toEqual({ ...background, botId: 'publisher' });
    expect(progress).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('preserves transient upload failures and deterministic upload validation errors', async () => {
    const { load, resolve, uploadImage, warn } = createRuntime();
    const execution = await load();
    uploadImage.mockRejectedValue(new Error('transport rejected'));
    await expect(resolve(execution)).rejects.toBeInstanceOf(ManagedBroadcastTransientUploadError);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockClear();
    const invalid = new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
    );
    uploadImage.mockRejectedValue(invalid);
    await expect(resolve(execution)).rejects.toBe(invalid);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reuses exact-bot direct video above the local cap with zero byte reads', async () => {
    const { load, resolve, assetFindFirst, uploadVideo } = createRuntime([
      createAsset({
        id: 'direct-video',
        sizeBytes: 100_000_000,
        mimeType: 'video/mp4',
        durablePayload: {
          [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
            version: 1,
            botId: 'publisher',
            token: 'remote-video',
          },
        },
      }),
    ]);
    expect(await resolve(await load())).toEqual({
      attachments: [{ type: 'video', payload: { token: 'remote-video' } }],
    });
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('never sends a direct video token through another bot', async () => {
    const { load, resolve, assetFindFirst, uploadVideo } = createRuntime([
      createAsset({
        mimeType: 'video/mp4',
        durablePayload: {
          [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
            version: 1,
            botId: 'publisher',
            token: 'private-token',
          },
        },
      }),
    ]);
    assetFindFirst.mockResolvedValue({ bytes: null });
    await expect(resolve(await load(), 'other-bot')).rejects.toThrow('больше недоступно');
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('reads byte-backed video once and keeps exact-bot upload/progress', async () => {
    const bytes = Buffer.from('stored-video');
    const { load, resolve, assetFindFirst, uploadVideo, progress } = createRuntime([
      createAsset({
        id: 'local-video',
        mimeType: 'video/mp4',
        fileName: 'clip.mp4',
        sizeBytes: bytes.length,
      }),
    ]);
    assetFindFirst.mockResolvedValue({ bytes });
    const execution = await load();
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(await resolve(execution)).toEqual({
      attachments: [{ type: 'video', payload: { token: 'video-token' } }],
    });
    expect(assetFindFirst).toHaveBeenCalledTimes(1);
    expect(uploadVideo).toHaveBeenCalledWith(bytes, 'clip.mp4', 'video/mp4', {
      ...background,
      botId: 'publisher',
    });
    expect(uploadVideo.mock.calls[0]?.[0].buffer).toBe(bytes.buffer);
    expect(progress).toHaveBeenCalledTimes(1);
  });

  it('does not fetch a local video larger than 24 MB', async () => {
    const { load, resolve, assetFindFirst, uploadVideo } = createRuntime([
      createAsset({ mimeType: 'video/mp4', sizeBytes: 24_000_001 }),
    ]);
    await expect(resolve(await load())).rejects.toThrow('Максимум 24 МБ');
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('keeps historical untagged durable video payloads unchanged without local bytes', async () => {
    const payload = { token: 'historical-video-token' };
    const { load, resolve, assetFindFirst, uploadVideo } = createRuntime([
      createAsset({ mimeType: 'video/mp4', durablePayload: payload }),
    ]);
    expect(await resolve(await load())).toEqual({ attachments: [{ type: 'video', payload }] });
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('rejects mixed image/video revisions before any upload', async () => {
    const { load, resolve, assetFindFirst, uploadImage, uploadVideo } = createRuntime([
      createAsset(),
      createAsset({ id: 'video', mimeType: 'video/mp4' }),
    ]);
    await expect(resolve(await load())).rejects.toThrow('либо фотографии, либо одно видео');
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('delegates legacy envelopes and public DTOs through the unchanged helpers', async () => {
    const { runtime, revisionFindFirst } = createRuntime();
    const legacyMedia = { imageEnabled: true, imageBase64: 'legacy' };
    const load = jest
      .spyOn(runtime, 'loadManagedBroadcastRequestMedia')
      .mockResolvedValue(legacyMedia as never);
    const resolve = jest
      .spyOn(runtime, 'resolveManagedBroadcastMedia')
      .mockResolvedValue({ imagePayload: { token: 'legacy-token' } });
    const legacyRow = { ...row, publicationContentRevisionId: null };
    const execution = await runtime.loadManagedBroadcastExecutionMedia(legacyRow as never);
    expect(execution).toEqual({ requestMedia: legacyMedia });
    expect(load).toHaveBeenCalledWith(legacyRow);
    const options = { trustedPublicationVideoMarkers: true };
    await runtime.resolveManagedBroadcastExecutionMedia(
      execution,
      legacyMedia as never,
      'chat',
      'source',
      'owner',
      undefined,
      background,
      undefined,
      options,
    );
    expect(resolve).toHaveBeenCalledWith(
      legacyMedia,
      'chat',
      'source',
      'owner',
      undefined,
      background,
      undefined,
      options,
    );
    expect(revisionFindFirst).not.toHaveBeenCalled();
  });
});
