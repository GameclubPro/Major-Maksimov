import { restoredMediaPosition } from './publication-import-review-model';
import type { PublicationContentInput } from '@maxim/contracts/publication';
import type { BroadcastImage } from '@maxim/contracts/broadcast';
import type { PublicationDraft, PublicationRetainedAsset } from './publication-model';

type AlbumItem = {
  key: string;
  name: string;
  type: 'image' | 'video';
  input: PublicationContentInput['media'][number];
  preview?: string;
  assetId?: string;
  localIndex?: number;
};

export function publicationAlbum(draft: PublicationDraft): AlbumItem[] {
  const items: AlbumItem[] = draft.retainedAssets.map((asset) => {
    const sourcePublicationId = asset.sourcePublicationId ?? draft.cloudDraft?.id;
    return {
      key: 'asset:' + asset.id,
      name: asset.fileName,
      type: asset.type,
      assetId: asset.id,
      input: {
        type: asset.type === 'video' ? 'video-ref' : 'image-ref',
        assetId: asset.id,
        ...(sourcePublicationId ? { sourcePublicationId } : {}),
      },
    };
  });
  draft.images.forEach((image, index) =>
    items.push({
      key: 'image:' + index,
      name: image.fileName,
      type: 'image',
      localIndex: index,
      input: { type: 'image', ...image },
      preview: 'data:' + image.mimeType + ';base64,' + image.base64,
    }),
  );
  if (draft.mediaType === 'video' && (draft.mediaPayload || draft.mediaBase64)) {
    items.push({
      key: 'legacy-video',
      type: 'video',
      name: draft.mediaFileName,
      input: {
        type: 'video',
        payload: draft.mediaPayload,
        base64: draft.mediaBase64,
        mimeType: draft.mediaMimeType,
        fileName: draft.mediaFileName,
      },
      ...(draft.mediaBase64
        ? { preview: 'data:' + draft.mediaMimeType + ';base64,' + draft.mediaBase64 }
        : {}),
    });
  }
  const order = new Map((draft.mediaOrder ?? []).map((key, index) => [key, index]));
  return items.sort(
    (left, right) => (order.get(left.key) ?? Infinity) - (order.get(right.key) ?? Infinity),
  );
}

export function withAlbumPhotos(
  draft: PublicationDraft,
  images: BroadcastImage[],
): PublicationDraft {
  const byContent = new Map(images.map((image, index) => [image.base64, index]));
  const ordered = publicationAlbum(draft).flatMap((item) => {
    if (item.localIndex === undefined) return [item.key];
    const newIndex = byContent.get(draft.images[item.localIndex]!.base64);
    return newIndex === undefined ? [] : ['image:' + newIndex];
  });
  const next = { ...draft, images, mediaOrder: ordered };
  return { ...next, mediaOrder: publicationAlbum(next).map((item) => item.key) };
}

export function addAlbumAsset(
  draft: PublicationDraft,
  asset: PublicationRetainedAsset,
): PublicationDraft {
  return {
    ...draft,
    retainedAssets: [...draft.retainedAssets, asset],
    mediaOrder: [...publicationAlbum(draft).map((item) => item.key), 'asset:' + asset.id],
  };
}

export function removeAlbumItem(draft: PublicationDraft, key: string): PublicationDraft {
  const item = publicationAlbum(draft).find((item) => item.key === key);
  if (!item) return draft;
  if (item.localIndex !== undefined)
    return withAlbumPhotos(
      draft,
      draft.images.filter((_, i) => i !== item.localIndex),
    );
  if (item.assetId)
    return {
      ...draft,
      retainedAssets: draft.retainedAssets.filter((asset) => asset.id !== item.assetId),
      mediaOrder: draft.mediaOrder?.filter((value) => value !== key),
    };
  return {
    ...draft,
    mediaType: null,
    mediaPayload: null,
    mediaBase64: '',
    mediaMimeType: '',
    mediaFileName: '',
    mediaOrder: draft.mediaOrder?.filter((value) => value !== key),
  };
}

export function moveAlbumItem(
  draft: PublicationDraft,
  key: string,
  direction: number,
): PublicationDraft {
  const order = publicationAlbum(draft).map((item) => item.key);
  const index = order.indexOf(key);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= order.length) return draft;
  order.splice(index, 1);
  order.splice(target, 0, key);
  return { ...draft, mediaOrder: order };
}

export function replaceAlbumItem(
  draft: PublicationDraft,
  key: string,
  replacement: { asset: PublicationRetainedAsset } | { photo: BroadcastImage },
): PublicationDraft {
  const index = publicationAlbum(draft).findIndex((item) => item.key === key);
  if (index === -1) return draft;
  const without = removeAlbumItem(draft, key);
  const next =
    'asset' in replacement
      ? addAlbumAsset(without, replacement.asset)
      : withAlbumPhotos(without, [...without.images, replacement.photo]);
  const order = publicationAlbum(next).map((item) => item.key);
  const inserted = order.pop();
  if (!inserted) return draft;
  order.splice(index, 0, inserted);
  return { ...next, mediaOrder: order };
}

export function restoreImportAsset(
  draft: PublicationDraft,
  index: number,
  replacement: { asset: PublicationRetainedAsset } | { photo: BroadcastImage },
): PublicationDraft {
  const review = draft.importReview;
  if (!review || !review.warnings[index] || review.resolved.includes(index)) return draft;
  const next =
    'asset' in replacement
      ? addAlbumAsset(draft, replacement.asset)
      : withAlbumPhotos(draft, [...draft.images, replacement.photo]);
  const order = publicationAlbum(next).map((item) => item.key);
  const inserted = order.pop();
  if (!inserted) return draft;
  order.splice(restoredMediaPosition(review, index, order.length), 0, inserted);
  return {
    ...next,
    mediaOrder: order,
    importReview: {
      ...review,
      resolved: [...review.resolved, index],
      restored: [...(review.restored ?? []), index],
    },
  };
}

export function acceptUploadedVideo(
  draft: PublicationDraft,
  asset: PublicationRetainedAsset,
  replaceKey?: string,
  warningIndex?: number,
) {
  if (warningIndex !== undefined) return restoreImportAsset(draft, warningIndex, { asset });
  if (replaceKey) return replaceAlbumItem(draft, replaceKey, { asset });
  return addAlbumAsset(draft, asset);
}
