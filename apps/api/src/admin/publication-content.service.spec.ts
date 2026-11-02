import {
  publicationAssetReferenceWhere,
  publicationAssetSourceWhere,
} from './publication-asset-access';
import { PublicationContentService } from './publication-content.service';
import { PUBLICATION_UPLOADED_VIDEO_FIELD } from './publication-video-media';
import { DEFAULT_MAX_PUBLISHER_BOT_ID } from '../publisher/publisher-bot-descriptor';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';
import { validateMaxMediaUploadPayload } from '../max/max-media-upload-validation';
import {
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
  PUBLICATION_ASSET_METADATA_SELECT,
} from './publication-media-limits';

const TINY_JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z',
  'base64',
);
function createTransaction() {
  let revision = 0;
  return {
    publicationContentRevision: {
      create: jest.fn().mockImplementation(async () => ({ id: `content-${++revision}` })),
    },
    publicationAsset: {
      findFirst: jest.fn(),
      upsert: jest
        .fn()
        .mockImplementation(
          async ({
            where,
          }: {
            where: { actorUserId_sha256: { actorUserId: string; sha256: string } };
          }) => ({
            id: `asset-${where.actorUserId_sha256.actorUserId}`,
          }),
        ),
    },
    publicationContentAsset: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

function createService(prisma: unknown = {}) {
  return new PublicationContentService(
    prisma as never,
    {
      validateMediaUploadPayload: validateMaxMediaUploadPayload,
    } as never,
  );
}

describe('PublicationContentService', () => {
  it('prepares imported image and video bytes with the same assets as public base64', async () => {
    const service = createService();
    for (const [type, bytes, fileName, mimeType] of [
      ['image', TINY_JPEG, 'picture.wrong', 'image/jpeg'],
      ['video', TINY_VALID_MP4, 'clip.wrong', 'video/mp4'],
    ] as const) {
      const shared = { text: 'caption', textFormat: 'plain' as const, buttons: [] };
      const binary = await service.prepareBinaryContentRevision({
        ...shared,
        media: [{ type, bytes, fileName, mimeType: 'ignored/untrusted' }],
      });
      const publicContent = await service.prepareContentRevision({
        ...shared,
        media: [
          type === 'image'
            ? { type: 'image', base64: bytes.toString('base64'), fileName, mimeType }
            : {
                type: 'video',
                base64: bytes.toString('base64'),
                fileName,
                mimeType,
                payload: null,
              },
        ],
      });
      expect(binary).toEqual(publicContent);
      const asset = binary.assets[0]!;
      expect(asset.kind).toBe('prepared');
      if (asset.kind === 'prepared') expect(asset.bytes).toBe(bytes);
    }
  });

  it('rejects a binary album at its cumulative limit before validating more images', async () => {
    const validate = jest.fn().mockResolvedValue({ mimeType: 'image/jpeg', extension: 'jpg' });
    const service = new PublicationContentService(
      {} as never,
      { validateMediaUploadPayload: validate } as never,
    );
    const bytes = Buffer.alloc(8_000_000);
    await expect(
      service.prepareBinaryContentRevision({
        text: '',
        textFormat: 'plain',
        buttons: [],
        media: [1, 2, 3, 4, 5].map((index) => ({
          type: 'image' as const,
          bytes,
          fileName: `image-${index}.jpg`,
        })),
      }),
    ).rejects.toThrow('Суммарный размер фото превышает 24 МБ.');
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it('accepts a confirmed owned direct upload before its first draft link without copying bytes', async () => {
    const asset = {
      id: 'uploaded',
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
      sizeBytes: 36_000_000,
      sha256: 'digest',
      durablePayload: {
        [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
          version: 1,
          botId: DEFAULT_MAX_PUBLISHER_BOT_ID,
          token: 'token',
        },
      },
    };
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(asset)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(asset);
    const service = createService({ publicationAsset: { findFirst } });
    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [{ type: 'video-ref', assetId: 'uploaded' }],
    });
    await expect(
      service.assertPublisherCompatibleContent(prepared, 'owner'),
    ).resolves.toBeUndefined();
    await expect(service.assertPublisherCompatibleContent(prepared, 'other')).rejects.toThrow(
      'недоступно',
    );
    const privateTest = await service.buildLegacyTestPayload(
      {
        requestId: 'direct-upload-test',
        content: {
          text: '',
          textFormat: 'plain',
          buttons: [],
          media: [{ type: 'video-ref', assetId: 'uploaded' }],
        },
        sourceTarget: { chatId: 'chat', entityType: 'chat' },
      },
      'owner',
    );
    expect(privateTest.mediaPayload).toEqual({ __publicationVideoAssetId: 'uploaded' });
    const tx = createTransaction();
    tx.publicationAsset.findFirst = findFirst;
    await service.persistPreparedContentRevision(tx, 'publication', 1, prepared, 'owner');
    expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
    expect(tx.publicationContentAsset.create).toHaveBeenCalledWith({
      data: { contentRevisionId: 'content-1', assetId: 'uploaded', position: 0 },
    });
  });

  it('never trusts a direct-upload marker supplied through public video payloads', async () => {
    await expect(
      createService().prepareContentRevision({
        text: '',
        textFormat: 'plain',
        buttons: [],
        media: [
          {
            type: 'video',
            base64: '',
            mimeType: 'video/mp4',
            fileName: 'clip.mp4',
            payload: {
              [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
                version: 1,
                botId: DEFAULT_MAX_PUBLISHER_BOT_ID,
                token: 'forged',
              },
            },
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it('rejects saved remote uploads from another Publisher bot', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      mimeType: 'video/mp4',
      durablePayload: {
        [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
          version: 1,
          botId: 'another-bot',
          token: 'token',
        },
      },
    });
    const service = createService({ publicationAsset: { findFirst } });
    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [{ type: 'video-ref', assetId: 'uploaded' }],
    });
    await expect(service.assertPublisherCompatibleContent(prepared, 'owner')).rejects.toThrow(
      'недоступно',
    );
  });

  it('serves bytes only from an authorized exact Publisher publication link', async () => {
    const prisma = {
      publicationAsset: {
        findFirst: jest.fn().mockResolvedValue({ bytes: TINY_JPEG, mimeType: 'image/jpeg' }),
      },
    };
    const result = await createService(prisma).getOwnedAsset('publication', 'asset', 'owner');
    expect(result.bytes.equals(TINY_JPEG)).toBe(true);
    expect(prisma.publicationAsset.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset',
        ...publicationAssetSourceWhere('owner', 'publication', 'read'),
      },
      select: { bytes: true, mimeType: true },
    });
  });

  it.each([
    null,
    { bytes: TINY_JPEG, mimeType: 'image/svg+xml' },
    { bytes: TINY_JPEG, mimeType: 'text/html' },
    { bytes: Buffer.alloc(0), mimeType: 'image/jpeg' },
  ])('rejects missing or unsafe preview media', async (asset) => {
    await expect(
      createService({
        publicationAsset: { findFirst: jest.fn().mockResolvedValue(asset) },
      }).getOwnedAsset('publication', 'asset', 'owner'),
    ).rejects.toThrow('Медиа недоступно');
  });

  it('uses the injected MAX client validation boundary for inline media ingestion', async () => {
    const validateMediaUploadPayload = jest.fn(validateMaxMediaUploadPayload);
    const service = new PublicationContentService(
      {} as never,
      {
        validateMediaUploadPayload,
      } as never,
    );

    await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        {
          type: 'image',
          base64: TINY_JPEG.toString('base64'),
          mimeType: 'image/png',
          fileName: 'photo.png',
        },
      ],
    });

    expect(validateMediaUploadPayload).toHaveBeenCalledWith('image', TINY_JPEG);
  });

  it('scopes identical asset hashes to the actor that owns the publication', async () => {
    const tx = createTransaction();
    const service = createService();
    const content = {
      text: '',
      textFormat: 'plain' as const,
      buttons: [],
      media: [
        {
          type: 'image' as const,
          base64: TINY_JPEG.toString('base64'),
          mimeType: 'image/png',
          fileName: '../photo\u0000.png',
        },
      ],
    };

    const prepared = await service.prepareContentRevision(content);
    await service.persistPreparedContentRevision(tx, 'publication-a', 1, prepared, 'actor-a');
    await service.persistPreparedContentRevision(tx, 'publication-b', 1, prepared, 'actor-b');

    const firstUpsert = tx.publicationAsset.upsert.mock.calls[0][0];
    const secondUpsert = tx.publicationAsset.upsert.mock.calls[1][0];
    expect(firstUpsert.where).toEqual({
      actorUserId_sha256: {
        actorUserId: 'actor-a',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(secondUpsert.where).toEqual({
      actorUserId_sha256: {
        actorUserId: 'actor-b',
        sha256: firstUpsert.where.actorUserId_sha256.sha256,
      },
    });
    expect(firstUpsert.create).toEqual(expect.objectContaining({ actorUserId: 'actor-a' }));
    expect(secondUpsert.create).toEqual(expect.objectContaining({ actorUserId: 'actor-b' }));
    expect(firstUpsert.create).toEqual(
      expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'photo_.jpg' }),
    );
    expect(secondUpsert.create).toEqual(
      expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'photo_.jpg' }),
    );
  });

  it('canonicalizes an inline video from its bytes before persisting it', async () => {
    const tx = createTransaction();
    const service = createService();

    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        {
          type: 'video',
          payload: null,
          base64: TINY_VALID_MP4.toString('base64'),
          mimeType: 'application/octet-stream',
          fileName: 'clip.webm',
        },
      ],
    });
    await service.persistPreparedContentRevision(tx, 'publication-video', 1, prepared, 'actor-a');

    expect(tx.publicationAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          mimeType: 'video/mp4',
          fileName: 'clip.mp4',
          bytes: TINY_VALID_MP4,
        }),
      }),
    );
  });

  it('rejects a token-scoped video payload for a Publik publication', async () => {
    const service = createService();
    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        {
          type: 'video',
          payload: { token: 'upload-token-owned-by-another-bot' },
          base64: '',
          mimeType: 'video/mp4',
          fileName: 'saved.mp4',
        },
      ],
    });

    await expect(service.assertPublisherCompatibleContent(prepared, 'actor-a')).rejects.toThrow(
      'Выберите видеофайл снова',
    );
  });

  it('allows a saved video reference for Publik only when durable bytes are present', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ mimeType: 'video/mp4' });
    const service = createService({ publicationAsset: { findFirst } });
    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [{ type: 'video-ref', assetId: 'saved-video' }],
    });

    await expect(service.assertPublisherCompatibleContent(prepared, 'actor-a')).rejects.toThrow(
      'Выберите видеофайл снова',
    );
    await expect(
      service.assertPublisherCompatibleContent(prepared, 'actor-a'),
    ).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          publicationAssetReferenceWhere('actor-a', {
            assetId: 'saved-video',
            expectedType: 'video',
          }),
        ]),
      }),
      select: PUBLICATION_ASSET_METADATA_SELECT,
    });
  });

  it('rejects malformed inline media before creating a content revision or asset', async () => {
    const tx = createTransaction();
    const service = createService();

    await expect(
      service.prepareContentRevision({
        text: '',
        textFormat: 'plain',
        buttons: [],
        media: [
          {
            type: 'image',
            base64: Buffer.from('not-an-image').toString('base64'),
            mimeType: 'image/png',
            fileName: 'broken.png',
          },
        ],
      }),
    ).rejects.toThrow(
      'Не удалось распознать файл. Выберите исправный файл поддерживаемого формата.',
    );
    expect(tx.publicationContentRevision.create).not.toHaveBeenCalled();
    expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
  });

  it('requires direct actor ownership when reusing a saved asset', async () => {
    const tx = createTransaction();
    tx.publicationAsset.findFirst.mockResolvedValue({
      id: 'asset-owned',
      actorUserId: 'actor-a',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      fileName: 'saved.png',
      sizeBytes: 5,
      bytes: Buffer.from('image'),
      durablePayload: null,
    });
    const service = createService();

    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [{ type: 'image-ref', assetId: 'asset-owned' }],
    });
    expect(tx.publicationAsset.findFirst).not.toHaveBeenCalled();
    await service.persistPreparedContentRevision(tx, 'publication-a', 2, prepared, 'actor-a');

    expect(tx.publicationAsset.findFirst).toHaveBeenCalledWith({
      select: PUBLICATION_ASSET_METADATA_SELECT,
      where: publicationAssetReferenceWhere(
        'actor-a',
        { assetId: 'asset-owned', expectedType: 'image' },
        'publication-a',
      ),
    });
    expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
  });

  it('rechecks the total image byte limit after resolving saved assets in the transaction', async () => {
    const tx = createTransaction();
    tx.publicationAsset.findFirst.mockResolvedValue({
      id: 'asset-large',
      actorUserId: 'actor-a',
      sha256: 'b'.repeat(64),
      mimeType: 'image/png',
      fileName: 'saved.png',
      sizeBytes: PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
      bytes: Buffer.from('saved-image'),
      durablePayload: null,
    });
    const service = createService();
    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        { type: 'image-ref', assetId: 'asset-large' },
        {
          type: 'image',
          base64: TINY_JPEG.toString('base64'),
          mimeType: 'image/jpeg',
          fileName: 'inline.jpg',
        },
      ],
    });

    await expect(
      service.persistPreparedContentRevision(tx, 'publication-a', 2, prepared, 'actor-a'),
    ).rejects.toThrow('Суммарный размер фото превышает 24 МБ.');
    expect(tx.publicationContentRevision.create).not.toHaveBeenCalled();
    expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
  });

  it('keeps test-send asset lookup scoped to the requesting actor', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'asset-owned',
      actorUserId: 'actor-a',
      mimeType: 'image/png',
      fileName: 'saved.png',
      bytes: Buffer.from('image'),
      durablePayload: null,
    });
    const service = createService({
      publicationAsset: { findFirst },
    });

    await service.buildLegacyTestPayload(
      {
        requestId: 'test-send-a',
        content: {
          text: '',
          textFormat: 'plain',
          buttons: [],
          media: [{ type: 'image-ref', assetId: 'asset-owned' }],
        },
        sourceTarget: { chatId: 'chat-a', entityType: 'chat' },
      },
      'actor-a',
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-owned',
        actorUserId: 'actor-a',
        contentLinks: {
          some: { contentRevision: { publication: { actorUserId: 'actor-a' } } },
        },
      },
    });
  });

  it('validates and canonicalizes inline video before building a legacy test payload', async () => {
    const service = createService();
    const request = {
      requestId: 'test-video',
      content: {
        text: '',
        textFormat: 'plain' as const,
        buttons: [],
        media: [
          {
            type: 'video' as const,
            payload: null,
            base64: TINY_VALID_MP4.toString('base64'),
            mimeType: 'video/webm',
            fileName: '../clip.webm',
          },
        ],
      },
      sourceTarget: { chatId: 'chat-a', entityType: 'chat' as const },
    };

    await expect(service.buildLegacyTestPayload(request, 'actor-a')).resolves.toMatchObject({
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
      mediaPayload: {
        __publicationVideoInlineBase64: TINY_VALID_MP4.toString('base64'),
      },
    });

    await expect(
      service.buildLegacyTestPayload(
        {
          ...request,
          requestId: 'test-invalid-video',
          content: {
            ...request.content,
            media: [
              {
                ...request.content.media[0],
                base64: Buffer.from(
                  '000000186674797069736f6d0000020069736f6d69736f32',
                  'hex',
                ).toString('base64'),
              },
            ],
          },
        },
        'actor-a',
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Не удалось распознать файл. Выберите исправный файл поддерживаемого формата.',
    });
  });
  it.each(['image', 'video'] as const)(
    'retains the exact shared %s source and creates only a content link',
    async (type) => {
      const asset = {
        id: 'shared-asset',
        actorUserId: 'original-owner',
        sha256: 'f'.repeat(64),
        mimeType: type === 'video' ? 'video/mp4' : 'image/png',
        fileName: 'shared',
        sizeBytes: 8,
        durablePayload: null,
      };
      const service = createService();
      const prepared = await service.prepareContentRevision({
        text: 'Copy',
        textFormat: 'plain',
        buttons: [],
        media: [
          {
            type: type === 'video' ? 'video-ref' : 'image-ref',
            assetId: asset.id,
            sourcePublicationId: 'source-post',
          },
        ],
      });
      expect(prepared.assets).toEqual([
        {
          kind: 'reference',
          assetId: asset.id,
          expectedType: type,
          sourcePublicationId: 'source-post',
        },
      ]);
      const tx = createTransaction();
      tx.publicationAsset.findFirst.mockResolvedValue(asset);
      await service.persistPreparedContentRevision(tx, 'new-copy', 1, prepared, 'second-admin');
      expect(tx.publicationAsset.findFirst).toHaveBeenCalledTimes(1);
      expect(tx.publicationAsset.findFirst).toHaveBeenCalledWith({
        where: publicationAssetReferenceWhere(
          'second-admin',
          { assetId: asset.id, expectedType: type, sourcePublicationId: 'source-post' },
          'new-copy',
        ),
        select: PUBLICATION_ASSET_METADATA_SELECT,
      });
      expect(tx.publicationContentAsset.create).toHaveBeenCalledWith({
        data: { contentRevisionId: 'content-1', assetId: asset.id, position: 0 },
      });
      expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
    },
  );

  it('rejects a denied shared source before writing its revision or link', async () => {
    const service = createService();
    const prepared = await service.prepareContentRevision({
      text: 'copy',
      textFormat: 'plain',
      buttons: [],
      media: [
        { type: 'image-ref', assetId: 'private-asset', sourcePublicationId: 'guessed-source' },
      ],
    });
    const tx = createTransaction();
    tx.publicationAsset.findFirst.mockResolvedValue(null);
    await expect(
      service.persistPreparedContentRevision(tx, 'new-copy', 1, prepared, 'second-admin'),
    ).rejects.toThrow('недоступно');
    expect(tx.publicationContentRevision.create).not.toHaveBeenCalled();
    expect(tx.publicationContentAsset.create).not.toHaveBeenCalled();
  });
});
