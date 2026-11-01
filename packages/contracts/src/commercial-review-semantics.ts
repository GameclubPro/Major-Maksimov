import { z } from 'zod';

export const commercialReviewSemanticCohortSchema = z.enum([
  'BUYER_REQUEST',
  'PERSONAL_SALE',
  'QUOTED_DISCUSSION',
  'NEGATED_OFFER',
  'SERVICE_ANNOUNCEMENT',
  'NONCOMMERCIAL_HELP',
  'MIXED_CONTENT',
  'COMMERCIAL_OFFER',
  'INSUFFICIENT_CONTEXT',
]);
export type CommercialReviewSemanticCohort = z.infer<typeof commercialReviewSemanticCohortSchema>;
export const commercialReviewSemanticAnnotationRequestSchema = z
  .object({
    version: z.literal(1),
    cohorts: z.array(commercialReviewSemanticCohortSchema).min(1).max(9),
  })
  .strict()
  .refine((value) => new Set(value.cohorts).size === value.cohorts.length, 'Duplicate categories.');
export type CommercialReviewSemanticAnnotationRequest = z.infer<
  typeof commercialReviewSemanticAnnotationRequestSchema
>;
export const commercialReviewSemanticAnnotationSchema =
  commercialReviewSemanticAnnotationRequestSchema.safeExtend({
    sourceSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    excerptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  });

export function resolveCommercialLabelAuthority<
  T extends {
    kind: string;
    reviewerKey: string;
    label: string;
    expectedDisposition: string | null;
  },
>(ratings: readonly T[]): { finalRating: T | null; labelRatings: readonly T[] } {
  const missing = { finalRating: null, labelRatings: [] };
  const independent = ratings.filter((rating) => rating.kind === 'INDEPENDENT');
  const adjudication = ratings.filter(
    (rating) => rating.kind === 'ADJUDICATION' || rating.kind === 'SEMANTIC_ADJUDICATION',
  );
  if (
    independent.length > 2 ||
    adjudication.length > 1 ||
    (adjudication.length > 0 && independent.length !== 2) ||
    new Set(ratings.map((rating) => rating.reviewerKey)).size !== ratings.length ||
    ratings.some(
      (rating) =>
        !['INDEPENDENT', 'ADJUDICATION', 'SEMANTIC_ADJUDICATION'].includes(rating.kind) ||
        typeof rating.reviewerKey !== 'string' ||
        !rating.reviewerKey.trim() ||
        !['COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE'].includes(rating.label) ||
        ![null, 'KEEP', 'DELETE'].includes(rating.expectedDisposition) ||
        (rating.label === 'UNSURE' && rating.expectedDisposition !== null) ||
        (rating.label === 'NOT_COMMERCIAL' && rating.expectedDisposition === 'DELETE'),
    )
  )
    return missing;
  const first = independent[0] ?? null;
  // FLAG: Exact two-person agreement keeps label authority. A semantic adjudicator's
  // actual blind response remains attributable without replacing those agreed votes.
  if (
    independent.length === 2 &&
    independent.every(
      (rating) =>
        rating.label === first?.label && rating.expectedDisposition === first?.expectedDisposition,
    )
  )
    return { finalRating: first, labelRatings: independent };
  if (adjudication.some((rating) => rating.kind === 'SEMANTIC_ADJUDICATION')) return missing;
  return { finalRating: adjudication[0] ?? first, labelRatings: ratings };
}

// FLAG: These human annotations describe source semantics, never execution policy or authority.
// Missing legacy evidence is not backfilled; source-bound votes remain independently attributable.
export function resolveCommercialSemanticReview(
  ratings: readonly {
    kind: string;
    reviewerKey: string;
    semanticAnnotation?: unknown;
  }[],
  binding: { sourceSnapshotSha256: string; excerptSha256: string },
): { state: 'MISSING' | 'DISAGREEMENT' | 'RESOLVED'; cohorts: CommercialReviewSemanticCohort[] } {
  const missing = { state: 'MISSING' as const, cohorts: [] };
  const independent = ratings.filter((rating) => rating.kind === 'INDEPENDENT');
  const adjudication = ratings.filter(
    (rating) => rating.kind === 'ADJUDICATION' || rating.kind === 'SEMANTIC_ADJUDICATION',
  );
  if (
    ratings.some(
      (rating) => !['INDEPENDENT', 'ADJUDICATION', 'SEMANTIC_ADJUDICATION'].includes(rating.kind),
    ) ||
    independent.length !== 2 ||
    adjudication.length > 1 ||
    new Set(ratings.map((rating) => rating.reviewerKey)).size !== ratings.length
  )
    return missing;
  const annotations = ratings.map((rating) => {
    const parsed = commercialReviewSemanticAnnotationSchema.safeParse(rating.semanticAnnotation);
    return parsed.success &&
      parsed.data.sourceSnapshotSha256 === binding.sourceSnapshotSha256 &&
      parsed.data.excerptSha256 === binding.excerptSha256
      ? [...parsed.data.cohorts].sort()
      : null;
  });
  if (annotations.some((annotation) => annotation === null)) return missing;
  const final = adjudication.length
    ? annotations[ratings.indexOf(adjudication[0]!)]!
    : annotations[ratings.indexOf(independent[0]!)]!;
  if (
    !adjudication.length &&
    JSON.stringify(final) !== JSON.stringify(annotations[ratings.indexOf(independent[1]!)])
  )
    return { state: 'DISAGREEMENT', cohorts: [] };
  return { state: 'RESOLVED', cohorts: final! };
}
