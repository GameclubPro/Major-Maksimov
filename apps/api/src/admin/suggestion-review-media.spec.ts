import { loadSuggestionPreview, suggestionPreviewUrl } from './suggestion-review-media';

describe('protected suggestion media preview', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    'http://max.ru/photo',
    'https://max.ru.attacker.test/photo',
    'https://user:pass@max.ru/photo',
    'https://max.ru:8443/photo',
    'https://127.0.0.1/photo',
    'javascript:alert(1)',
  ])('rejects an unsafe stored destination %s', (url) =>
    expect(suggestionPreviewUrl({ url })).toBeNull(),
  );
  it('loads a bounded image without forwarding application credentials', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('photo', { headers: { 'content-type': 'image/webp' } }));
    expect(await loadSuggestionPreview('https://img.max.ru/photo')).toEqual({
      bytes: Buffer.from('photo'),
      mimeType: 'image/webp',
    });
    expect(fetcher).toHaveBeenCalledWith('https://img.max.ru/photo', {
      signal: expect.any(AbortSignal),
      redirect: 'manual',
    });
  });
  it('does not follow a redirect outside MAX media hosts', async () => {
    const fetcher = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
      );
    await expect(loadSuggestionPreview('https://img.max.ru/photo')).rejects.toThrow(
      'Не удалось загрузить фото',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each<Record<string, string>>([
    { 'content-type': 'text/html' },
    { 'content-type': 'image/png', 'content-length': '99999999' },
  ])('refuses unsupported or oversized responses', async (headers) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('photo', { headers }));
    await expect(loadSuggestionPreview('https://img.max.ru/photo')).rejects.toThrow(
      'Не удалось загрузить фото',
    );
  });
});
