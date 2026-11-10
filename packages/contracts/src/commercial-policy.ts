import { z } from 'zod';

export const COMMERCIAL_AD_CATEGORIES = [
  'PERSONAL_SALE',
  'SERVICES',
  'BUSINESS',
  'COMMUNITIES',
] as const;
export const COMMERCIAL_ADS_EXCEPTIONS_MAX = 100;
export const COMMERCIAL_ADS_PREVIEW_TEXT_MAX = 2500;

export const commercialAdCategorySchema = z.enum(COMMERCIAL_AD_CATEGORIES);
export type CommercialAdCategory = z.infer<typeof commercialAdCategorySchema>;
export const commercialAdsCategoryRuleSchema = z.enum(['ALLOW', 'BLOCK']);
export const commercialAdsUserIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);

const categoryListSchema = z
  .array(commercialAdCategorySchema)
  .max(COMMERCIAL_AD_CATEGORIES.length)
  .refine((categories) => new Set(categories).size === categories.length, {
    message: 'Категории не должны повторяться.',
  });

export const commercialAdsExceptionSchema = z
  .object({
    id: z.uuid(),
    userId: commercialAdsUserIdSchema,
    userName: z.string().trim().min(1).max(128),
    categories: categoryListSchema.refine((categories) => categories.length > 0, {
      message: 'Выберите категорию.',
    }),
    expiresAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type CommercialAdsException = z.infer<typeof commercialAdsExceptionSchema>;

export const commercialAdsPolicySchema = z
  .object({
    version: z.literal(1),
    categories: z
      .object({
        PERSONAL_SALE: commercialAdsCategoryRuleSchema,
        SERVICES: commercialAdsCategoryRuleSchema,
        BUSINESS: commercialAdsCategoryRuleSchema,
        COMMUNITIES: commercialAdsCategoryRuleSchema,
      })
      .strict(),
    exceptions: z
      .array(commercialAdsExceptionSchema)
      .max(COMMERCIAL_ADS_EXCEPTIONS_MAX)
      .refine(
        (exceptions) => new Set(exceptions.map((entry) => entry.id)).size === exceptions.length,
        {
          message: 'Идентификаторы исключений не должны повторяться.',
        },
      ),
  })
  .strict();
export type CommercialAdsPolicy = z.infer<typeof commercialAdsPolicySchema>;

export function createDefaultCommercialAdsPolicy(): CommercialAdsPolicy {
  return {
    version: 1,
    categories: {
      PERSONAL_SALE: 'ALLOW',
      SERVICES: 'BLOCK',
      BUSINESS: 'BLOCK',
      COMMUNITIES: 'BLOCK',
    },
    exceptions: [],
  };
}

export const commercialAdsPolicyReasonSchema = z.enum([
  'LEGACY_POLICY',
  'INVALID_POLICY',
  'CATEGORY_ALLOWED',
  'PARTICIPANT_EXCEPTION',
  'BLOCKED_CATEGORY',
  'INSUFFICIENT_CONTEXT',
]);
export type CommercialAdsPolicyReason = z.infer<typeof commercialAdsPolicyReasonSchema>;
export type CommercialAdsPolicyResolution = {
  decision: 'LEGACY' | 'KEEP' | 'BLOCK' | 'UNSURE';
  reason: CommercialAdsPolicyReason;
  categories: CommercialAdCategory[];
  blockedCategories: CommercialAdCategory[];
  matchedExceptionIds: string[];
};

// FLAG: This resolver only narrows an independently proven advertisement decision. A policy
// result never grants classifier, author, source, sanction or transport authority of its own.
export function resolveCommercialAdsPolicy({
  policy,
  categories,
  userId,
  nowMs = Date.now(),
}: {
  policy: unknown;
  categories: readonly unknown[];
  userId?: string | null;
  nowMs?: number;
}): CommercialAdsPolicyResolution {
  const knownCategories = COMMERCIAL_AD_CATEGORIES.filter(
    (category) => Array.isArray(categories) && categories.includes(category),
  );
  const result = (
    decision: CommercialAdsPolicyResolution['decision'],
    reason: CommercialAdsPolicyReason,
    blockedCategories: CommercialAdCategory[] = [],
    matchedExceptionIds: string[] = [],
  ): CommercialAdsPolicyResolution => ({
    decision,
    reason,
    categories: knownCategories,
    blockedCategories,
    matchedExceptionIds,
  });

  // FLAG: Null is the historical policy, not an implicit opt-in to new enforcement.
  if (policy === null || policy === undefined) return result('LEGACY', 'LEGACY_POLICY');
  const parsed = commercialAdsPolicySchema.safeParse(policy);
  if (!parsed.success) return result('UNSURE', 'INVALID_POLICY');
  if (
    !Array.isArray(categories) ||
    !knownCategories.length ||
    categories.some((category) => !commercialAdCategorySchema.safeParse(category).success) ||
    !Number.isFinite(nowMs)
  )
    return result('UNSURE', 'INSUFFICIENT_CONTEXT');

  const blocked = knownCategories.filter(
    (category) => parsed.data.categories[category] === 'BLOCK',
  );
  if (!blocked.length) return result('KEEP', 'CATEGORY_ALLOWED');
  const activeExceptions = parsed.data.exceptions.filter(
    (entry) =>
      entry.userId === userId && (entry.expiresAt === null || Date.parse(entry.expiresAt) > nowMs),
  );
  const matchedIds = new Set<string>();
  const remainingBlocked = blocked.filter((category) => {
    const matching = activeExceptions.filter((entry) => entry.categories.includes(category));
    for (const entry of matching) matchedIds.add(entry.id);
    return !matching.length;
  });
  return remainingBlocked.length
    ? result('BLOCK', 'BLOCKED_CATEGORY', remainingBlocked, [...matchedIds])
    : result('KEEP', 'PARTICIPANT_EXCEPTION', [], [...matchedIds]);
}

export const commercialAdsPreviewResponseSchema = z
  .object({
    decision: z.enum(['DELETE', 'KEEP', 'UNSURE', 'UNAVAILABLE']),
    categories: categoryListSchema,
    reason: z.enum([
      ...commercialAdsPolicyReasonSchema.options,
      'FILTER_DISABLED',
      'NOT_ADVERTISING',
      'CLASSIFIER_UNAVAILABLE',
    ]),
    matchedExceptionId: z.uuid().optional(),
  })
  .strict();
export type CommercialAdsPreviewResponse = z.infer<typeof commercialAdsPreviewResponseSchema>;
