import type { PublicationRetainedAsset } from './publication-model';
import { useEffect, useMemo, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';

export function usePublicationAssetPreviews(
  api: ApiTransport,
  publicationId: string | null,
  assets: readonly PublicationRetainedAsset[],
) {
  const key = useMemo(
    () =>
      JSON.stringify(
        assets.flatMap((asset) => {
          const source = asset.sourcePublicationId ?? publicationId;
          return source ? [[source, asset.id]] : [];
        }),
      ),
    [assets, publicationId],
  );
  const [previews, setPreviews] = useState<PublisherPostImportAssetPreview[]>([]);
  useEffect(() => {
    setPreviews([]);
    const references = JSON.parse(key) as [string, string][];
    if (references.length === 0) return;
    const abort = new AbortController();
    const urls: string[] = [];
    let next = 0;
    async function load() {
      const { getPublicationAsset } = await import('../../lib/api/publication-drafts-client');
      while (!abort.signal.aborted) {
        const reference = references[next++];
        if (!reference) return;
        const [sourceId, assetId] = reference;
        try {
          const blob = await getPublicationAsset(api, sourceId, assetId, abort.signal);
          if (abort.signal.aborted) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setPreviews((current) => [...current, { assetId, url }]);
        } catch {
          /* Preview failure does not invalidate a retained asset. */
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, references.length) }, load));
    return () => {
      abort.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [api, key]);
  return previews;
}
