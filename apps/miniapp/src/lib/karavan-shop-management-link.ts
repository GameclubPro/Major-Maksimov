/** A launch target carries no authority; Karavan independently verifies the current MAX actor. */
export function karavanShopManagementUrl(buyerUrl: string | null | undefined, slug: string): string | null {
  if (!buyerUrl || !/^[a-z0-9-]{3,100}$/u.test(slug)) return null;
  try {
    const url = new URL(buyerUrl);
    if (url.origin !== 'https://max.ru' || url.username || url.password || !/^\/[A-Za-z0-9_]{3,64}\/?$/u.test(url.pathname) || url.searchParams.get('startapp') !== `m_${slug}`) return null;
    url.search = new URLSearchParams({ startapp: `ma_${slug}` }).toString();
    url.hash = '';
    return url.toString();
  } catch { return null; }
}
