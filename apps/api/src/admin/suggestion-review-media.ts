import { ServiceUnavailableException } from '@nestjs/common';
import { readBoundedResponseBuffer } from '../common/bounded-response-buffer';
import { PUBLICATION_MAX_IMAGE_BYTES } from './publication-media-limits';

const hosts = ['max.ru', 'oneme.ru', 'mycdn.me', 'okcdn.ru'];

export function suggestionPreviewUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || !('url' in payload)) return null;
  if (typeof payload.url !== 'string' || payload.url.length > 8192) return null;
  try {
    const url = new URL(payload.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

// FLAG: Only an authorized persisted attachment supplies the URL; no credentials or tokens leave the server.
export async function loadSuggestionPreview(
  source: string,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const signal = AbortSignal.timeout(8000);
  let url = suggestionPreviewUrl({ url: source });
  try {
    for (let redirect = 0; url && redirect <= 2; redirect++) {
      const response = await fetch(url, { signal, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        url = location ? suggestionPreviewUrl({ url: new URL(location, url).href }) : null;
        continue;
      }
      const mimeType = (response.headers.get('content-type') ?? '')
        .split(';')[0]!
        .trim()
        .toLowerCase();
      if (!response.ok || !/^image\/(jpeg|png|webp|avif)$/u.test(mimeType)) {
        await response.body?.cancel();
        break;
      }
      const bytes = await readBoundedResponseBuffer(response, PUBLICATION_MAX_IMAGE_BYTES, signal);
      return { bytes, mimeType };
    }
  } catch {
    /* The original media remains intact; a failed preview can be retried. */
  }
  throw new ServiceUnavailableException('Не удалось загрузить фото. Повторите попытку.');
}
