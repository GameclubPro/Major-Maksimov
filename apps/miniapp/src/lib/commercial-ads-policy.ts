import {
  COMMERCIAL_AD_CATEGORIES,
  commercialAdCategorySchema,
  commercialAdsUserIdSchema,
  type CommercialAdCategory,
  type CommercialAdsException,
} from '@maxim/contracts/settings';

export { COMMERCIAL_CATEGORY_LABELS } from './commercial-ads-category-labels';
export { commercialPreviewExplanation } from './commercial-preview-explanation';

export type CommercialAuthor = { userId: string; userName: string; avatarUrl?: string | null };
export type CommercialExceptionPrefill = CommercialAuthor & { category?: CommercialAdCategory };

export function readCommercialExceptionPrefill(search: string): CommercialExceptionPrefill | null {
  const params = new URLSearchParams(search);
  const user = commercialAdsUserIdSchema.safeParse(params.get('commercialUser'));
  if (!user.success) return null;
  const category = commercialAdCategorySchema.safeParse(params.get('commercialCategory'));
  const userName = params.get('commercialName')?.trim().slice(0, 128) || 'Участник';
  return { userId: user.data, userName, ...(category.success ? { category: category.data } : {}) };
}

export function commercialExceptionSettingsSearch(input: CommercialExceptionPrefill): string {
  const params = new URLSearchParams({
    focus: 'commercialFilter',
    commercialUser: input.userId,
    commercialName: input.userName.slice(0, 128),
  });
  if (input.category) params.set('commercialCategory', input.category);
  return `?${params}`;
}

export function commercialCategoriesFromMetadata(metadata: unknown): CommercialAdCategory[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const record = metadata as Record<string, unknown>;
  const aiDecision = record.commercialAdsDecision;
  const source =
    record.commercialAdsCategories ??
    (aiDecision && typeof aiDecision === 'object' && !Array.isArray(aiDecision)
      ? (aiDecision as Record<string, unknown>).categories
      : undefined) ??
    record.commercialCategories ??
    record.categories;
  return COMMERCIAL_AD_CATEGORIES.filter(
    (category) => Array.isArray(source) && source.includes(category),
  );
}

export function commercialExceptionExpired(entry: CommercialAdsException, nowMs = Date.now()) {
  return entry.expiresAt !== null && Date.parse(entry.expiresAt) <= nowMs;
}

export function formatCommercialExpiry(expiresAt: string | null, nowMs = Date.now()): string {
  if (expiresAt === null) return 'Без срока';
  if (Date.parse(expiresAt) <= nowMs) return 'Срок истёк';
  return `До ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', ...(new Date(expiresAt).getFullYear() !== new Date(nowMs).getFullYear() ? { year: 'numeric' as const } : {}) }).format(new Date(expiresAt))}`;
}
