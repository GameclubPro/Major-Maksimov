import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from '../max/max-media-upload-validation';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import {
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
  PUBLICATION_UPLOADED_VIDEO_FIELD,
} from './publication-video-media';

const TINY_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z';

function createRuntime() {
  const findUnique = jest.fn();
  const assetFindFirst = jest.fn();
  const uploadImage = jest.fn().mockResolvedValue({ token: 'uploaded-image-token' });
  const uploadVideo = jest.fn().mockResolvedValue({ token: 'uploaded-video-token' });
  const warn = jest.fn();
  const runtime = new AdminManagedBroadcastRuntime({
    prisma: {
      publicationContentRevision: { findUnique },
      publicationAsset: { findFirst: assetFindFirst },
    },
    maxClient: { uploadImage, uploadVideo },
    logger: { warn },
  } as never);

  return { runtime, findUnique, assetFindFirst, uploadImage, uploadVideo, warn };
}

function createBroadcastRow(overrides: Record<string, unknown> = {}) {
  return {
    publicationContentRevisionId: 'revision-1',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    ...overrides,
  };
}

function createVideoRequestPayload(mediaPayload: Record<string, unknown>) {
  return {
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    images: [],
    mediaType: 'video',
    mediaPayload,
    mediaMimeType: 'video/mp4',
    mediaFileName: 'clip.mp4',
  };
}

describe('AdminManagedBroadcastRuntime publication media', () => {
  it('rechecks the exact shared source before resolving private-test video bytes', async () => {
    const { runtime, assetFindFirst, uploadVideo } = createRuntime();
    const bytes = Buffer.from('shared-video');
    assetFindFirst.mockResolvedValue({
      bytes,
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
      durablePayload: null,
    });
    const result = await (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
      createVideoRequestPayload({
        [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'shared-video',
        [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'source-publication',
      }),
      'chat',
      'source-chat',
      'second-admin',
      'publisher-bot',
      undefined,
      undefined,
      { trustedPublicationVideoMarkers: true },
    );
    expect(result).toEqual({
      attachments: [{ type: 'video', payload: { token: 'uploaded-video-token' } }],
    });
    expect(assetFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'shared-video',
          OR: expect.arrayContaining([
            expect.objectContaining({
              contentLinks: {
                some: {
                  contentRevision: {
                    publication: expect.objectContaining({
                      id: 'source-publication',
                      dispatchProfile: 'PUBLIK_V1',
                    }),
                  },
                },
              },
            }),
          ]),
        }),
      }),
    );
    expect(uploadVideo).toHaveBeenCalledWith(
      bytes,
      'clip.mp4',
      'video/mp4',
      expect.objectContaining({ botId: 'publisher-bot' }),
    );
  });

  it('rejects a shared source revoked after private-test payload validation without uploading', async () => {
    const { runtime, assetFindFirst, uploadVideo } = createRuntime();
    assetFindFirst.mockResolvedValue(null);
    await expect(
      (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
        createVideoRequestPayload({
          [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'shared-video',
          [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'revoked-publication',
        }),
        'chat',
        'source-chat',
        'second-admin',
        'publisher-bot',
        undefined,
        undefined,
        { trustedPublicationVideoMarkers: true },
      ),
    ).rejects.toThrow('больше недоступно');
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('reuses a directly uploaded MAX video without a local file or reupload and fences its bot', async () => {
    const { runtime, findUnique, assetFindFirst, uploadVideo } = createRuntime();
    const asset = {
      id: 'direct-video',
      bytes: null,
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
      durablePayload: {
        [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
          version: 1,
          botId: 'publisher-bot',
          token: 'remote-token',
        },
      },
    };
    findUnique.mockResolvedValue({ assets: [{ asset }] });
    assetFindFirst.mockResolvedValue(asset);
    const mediaRuntime = (runtime as any).mediaRuntime;
    const request = await mediaRuntime.loadManagedBroadcastRequestMedia(createBroadcastRow());
    expect(request.mediaPayload).toEqual({ [PUBLICATION_VIDEO_ASSET_ID_FIELD]: asset.id });
    const result = await mediaRuntime.resolveManagedBroadcastMedia(
      request,
      'channel',
      'channel-1',
      'owner',
      'publisher-bot',
      undefined,
      undefined,
      { trustedPublicationVideoMarkers: true },
    );
    expect(result).toEqual({
      attachments: [{ type: 'video', payload: { token: 'remote-token' } }],
    });
    expect(uploadVideo).not.toHaveBeenCalled();
    await expect(
      mediaRuntime.resolveManagedBroadcastMedia(
        request,
        'channel',
        'channel-1',
        'owner',
        'other-bot',
        undefined,
        undefined,
        { trustedPublicationVideoMarkers: true },
      ),
    ).rejects.toThrow('больше недоступно');
  });

  it('canonicalizes a valid image even when its declared MIME type is not media', async () => {
    const { runtime } = createRuntime();
    const payload = {
      imageEnabled: true,
      imageBase64: TINY_JPEG_BASE64,
      imageMimeType: 'application/octet-stream',
      imageFileName: '../photo.bin',
      images: [
        {
          base64: TINY_JPEG_BASE64,
          mimeType: 'application/octet-stream',
          fileName: '../photo.bin',
        },
      ],
      mediaType: null,
      mediaPayload: null,
    };

    await (runtime as any).mediaRuntime.validateManagedBroadcastMediaPayload(payload);

    expect(payload).toEqual(
      expect.objectContaining({
        imageMimeType: 'image/jpeg',
        imageFileName: 'photo.jpg',
        images: [expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'photo.jpg' })],
      }),
    );
  });

  it('revalidates an image at send time before delegating upload to MaxClient', async () => {
    const { runtime, uploadImage } = createRuntime();
    const mediaRuntime = (runtime as any).mediaRuntime;
    const validateImage = jest.spyOn(mediaRuntime as any, 'validateManagedBroadcastImagePayload');
    const payload = {
      imageEnabled: true,
      imageBase64: TINY_JPEG_BASE64,
      imageMimeType: 'application/octet-stream',
      imageFileName: 'photo.bin',
      images: [
        {
          base64: TINY_JPEG_BASE64,
          mimeType: 'application/octet-stream',
          fileName: 'photo.bin',
        },
      ],
      mediaType: null,
      mediaPayload: null,
    };

    await mediaRuntime.validateManagedBroadcastMediaPayload(payload);
    expect(validateImage).toHaveBeenCalledTimes(1);
    validateImage.mockClear();

    await mediaRuntime.resolveManagedBroadcastMedia(payload, 'chat', 'chat-1', 'user-1');

    expect(validateImage).toHaveBeenCalledTimes(1);
    expect(uploadImage).toHaveBeenCalledWith(
      Buffer.from(TINY_JPEG_BASE64, 'base64'),
      'photo.jpg',
      'image/jpeg',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
  });

  it('does not reclassify deterministic image upload validation as transient', async () => {
    const { runtime, uploadImage, warn } = createRuntime();
    const validationError = new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
    );
    uploadImage.mockRejectedValue(validationError);

    await expect(
      (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
        {
          imageEnabled: true,
          imageBase64: TINY_JPEG_BASE64,
          imageMimeType: 'image/jpeg',
          imageFileName: 'photo.jpg',
          images: [
            {
              base64: TINY_JPEG_BASE64,
              mimeType: 'image/jpeg',
              fileName: 'photo.jpg',
            },
          ],
          mediaType: null,
          mediaPayload: null,
        },
        'chat',
        'chat-1',
        'user-1',
      ),
    ).rejects.toBe(validationError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not reclassify deterministic video upload validation as transient', async () => {
    const { runtime, uploadVideo, warn } = createRuntime();
    const validationError = new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT,
      'video',
    );
    uploadVideo.mockRejectedValue(validationError);

    await expect(
      (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
        createVideoRequestPayload({
          [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: Buffer.from('legacy-video').toString('base64'),
        }),
        'chat',
        'chat-1',
        'user-1',
        undefined,
        undefined,
        undefined,
        { trustedPublicationVideoMarkers: true },
      ),
    ).rejects.toBe(validationError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads publication images in revision order and converts stored bytes to base64', async () => {
    const { runtime, findUnique } = createRuntime();
    findUnique.mockResolvedValue({
      assets: [
        {
          asset: {
            bytes: Buffer.from('first-image'),
            durablePayload: null,
            mimeType: 'image/png',
            fileName: 'first.png',
          },
        },
        {
          asset: {
            bytes: Buffer.from('second-image'),
            durablePayload: null,
            mimeType: 'image/jpeg',
            fileName: 'second.jpg',
          },
        },
      ],
    });

    const media = await (runtime as any).mediaRuntime.loadManagedBroadcastRequestMedia(
      createBroadcastRow({
        imageEnabled: true,
        imageBase64: Buffer.from('legacy-image').toString('base64'),
      }),
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'revision-1' },
      select: {
        assets: {
          orderBy: [{ position: 'asc' }],
          select: {
            asset: {
              select: {
                id: true,
                bytes: true,
                durablePayload: true,
                mimeType: true,
                fileName: true,
              },
            },
          },
        },
      },
    });
    expect(media).toEqual({
      imageEnabled: true,
      imageBase64: Buffer.from('first-image').toString('base64'),
      imageMimeType: 'image/png',
      imageFileName: 'first.png',
      images: [
        {
          base64: Buffer.from('first-image').toString('base64'),
          mimeType: 'image/png',
          fileName: 'first.png',
        },
        {
          base64: Buffer.from('second-image').toString('base64'),
          mimeType: 'image/jpeg',
          fileName: 'second.jpg',
        },
      ],
      mediaType: 'image',
      mediaPayload: {
        images: [
          {
            base64: Buffer.from('first-image').toString('base64'),
            mimeType: 'image/png',
            fileName: 'first.png',
          },
          {
            base64: Buffer.from('second-image').toString('base64'),
            mimeType: 'image/jpeg',
            fileName: 'second.jpg',
          },
        ],
      },
      mediaMimeType: '',
      mediaFileName: '',
    });
  });

  it('loads assets from the content revision rebound by latest retry instead of stale row media', async () => {
    const { runtime, findUnique } = createRuntime();
    findUnique.mockResolvedValue({
      assets: [
        {
          asset: {
            id: 'asset-video-token',
            bytes: null,
            durablePayload: { token: 'video-token-1' },
            mimeType: 'video/mp4',
            fileName: 'announcement.mp4',
          },
        },
      ],
    });

    const media = await (runtime as any).mediaRuntime.loadManagedBroadcastRequestMedia(
      createBroadcastRow({
        publicationContentRevisionId: 'content-latest',
        imageEnabled: true,
        imageBase64: Buffer.from('old-image').toString('base64'),
        imageMimeType: 'image/png',
        imageFileName: 'old.png',
      }),
    );

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'content-latest' } }),
    );
    expect(media).toEqual({
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      images: [],
      mediaType: 'video',
      mediaPayload: { token: 'video-token-1' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'announcement.mp4',
    });
  });

  it('keeps a byte-backed publication video as an internal upload reference', async () => {
    const { runtime, findUnique } = createRuntime();
    findUnique.mockResolvedValue({
      assets: [
        {
          asset: {
            id: 'asset-video-bytes',
            bytes: Buffer.from('video-bytes'),
            durablePayload: null,
            mimeType: 'video/mp4',
            fileName: 'clip.mp4',
          },
        },
      ],
    });

    const media = await (runtime as any).mediaRuntime.loadManagedBroadcastRequestMedia(
      createBroadcastRow(),
    );

    expect(media).toEqual({
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      images: [],
      mediaType: 'video',
      mediaPayload: { __publicationVideoAssetId: 'asset-video-bytes' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
    });
  });

  it('uploads trusted inline test video bytes and does not expose them as a MAX payload', async () => {
    const { runtime, uploadVideo } = createRuntime();
    const bytes = Buffer.from('inline-video');

    const media = await (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
      createVideoRequestPayload({
        [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: bytes.toString('base64'),
      }),
      'chat',
      'chat-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      { trustedPublicationVideoMarkers: true },
    );

    expect(uploadVideo).toHaveBeenCalledWith(
      bytes,
      'clip.mp4',
      'video/mp4',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
    expect(media).toEqual({
      attachments: [{ type: 'video', payload: { token: 'uploaded-video-token' } }],
    });
  });

  it('does not resolve publication asset markers from ordinary public broadcast requests', async () => {
    const { runtime, assetFindFirst, uploadVideo } = createRuntime();

    await expect(
      (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
        createVideoRequestPayload({
          [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-from-another-user',
        }),
        'chat',
        'chat-1',
        'user-1',
      ),
    ).rejects.toThrow('Внутренняя ссылка на видео недоступна.');
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('rechecks actor ownership before uploading a trusted saved video reference', async () => {
    const { runtime, assetFindFirst, uploadVideo } = createRuntime();
    assetFindFirst.mockResolvedValue({
      bytes: Buffer.from('owned-video'),
      mimeType: 'video/mp4',
      fileName: 'owned.mp4',
    });

    await (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
      createVideoRequestPayload({
        [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-owned',
      }),
      'channel',
      'channel-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      { trustedPublicationVideoMarkers: true },
    );

    expect(assetFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-owned',
        OR: expect.arrayContaining([
          {
            actorUserId: 'user-1',
            contentLinks: {
              some: { contentRevision: { publication: { actorUserId: 'user-1' } } },
            },
          },
        ]),
      },
      select: { bytes: true, mimeType: true, fileName: true, durablePayload: true },
    });
    expect(uploadVideo).toHaveBeenCalledWith(
      Buffer.from('owned-video'),
      'owned.mp4',
      'video/mp4',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
  });

  it('keeps legacy persisted media unchanged when no publication revision is linked', async () => {
    const { runtime, findUnique } = createRuntime();
    const legacyImage = {
      base64: Buffer.from('legacy-image').toString('base64'),
      mimeType: 'image/png',
      fileName: 'legacy.png',
    };

    const media = await (runtime as any).mediaRuntime.loadManagedBroadcastRequestMedia(
      createBroadcastRow({
        publicationContentRevisionId: null,
        imageEnabled: true,
        imageBase64: legacyImage.base64,
        imageMimeType: legacyImage.mimeType,
        imageFileName: legacyImage.fileName,
        mediaType: 'image',
        mediaPayload: { images: [legacyImage] },
      }),
    );

    expect(findUnique).not.toHaveBeenCalled();
    expect(media).toEqual({
      imageEnabled: true,
      imageBase64: legacyImage.base64,
      imageMimeType: legacyImage.mimeType,
      imageFileName: legacyImage.fileName,
      images: [legacyImage],
      mediaType: 'image',
      mediaPayload: { images: [legacyImage] },
      mediaMimeType: '',
      mediaFileName: '',
    });
  });
});
