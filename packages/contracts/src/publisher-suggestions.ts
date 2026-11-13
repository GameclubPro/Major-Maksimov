import { suggestionReviewWriteSchema } from './suggestion-review.js';
import { z } from 'zod';
import { broadcastTextFormatSchema } from './broadcast-common.js';

export const publisherSuggestionReviewStatusSchema = z.enum([
  'pending',
  'publishing',
  'published',
  'drafted',
  'cancelled',
]);
export type PublisherSuggestionReviewStatus = z.infer<typeof publisherSuggestionReviewStatusSchema>;

export const publisherSuggestionSchema = z
  .object({
    id: z.string().trim().min(1),
    text: z.string(),
    textFormat: broadcastTextFormatSchema,
    authorDisplayName: z.string().nullable(),
    createdAt: z.string().datetime(),
    reviewStatus: publisherSuggestionReviewStatusSchema,
    publicationId: z.string().trim().min(1).nullable(),
    imageCount: z.number().int().min(0).max(10).default(0),
    reviewError: z.string().trim().min(1).max(300).nullable().optional(),
  })
  .strict();
export type PublisherSuggestion = z.infer<typeof publisherSuggestionSchema>;

export const MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH = 1_024;

export const publisherSuggestionsViewSchema = z.enum(['pending', 'history']);
export type PublisherSuggestionsView = z.infer<typeof publisherSuggestionsViewSchema>;

export const publisherSuggestionsQuerySchema = z
  .object({
    view: publisherSuggestionsViewSchema.default('pending'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().trim().min(1).max(MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH).optional(),
  })
  .strict();
export type PublisherSuggestionsQuery = z.infer<typeof publisherSuggestionsQuerySchema>;

export const publisherSuggestionsResponseSchema = z
  .object({
    items: z.array(publisherSuggestionSchema).max(100),
    total: z.number().int().min(0),
    nextCursor: z.string().trim().min(1).max(MAX_PUBLISHER_SUGGESTIONS_CURSOR_LENGTH).nullable(),
  })
  .strict();
export type PublisherSuggestionsResponse = z.infer<typeof publisherSuggestionsResponseSchema>;

export const reviewPublisherSuggestionRequestSchema = z
  .object({
    action: z.enum(['publish', 'draft', 'cancel']),
    responseVersion: z.literal(2).optional(),
    editor: suggestionReviewWriteSchema.optional(),
  })
  .strict();
export type ReviewPublisherSuggestionRequest = z.infer<
  typeof reviewPublisherSuggestionRequestSchema
>;

export const reviewPublisherSuggestionResponseSchema = z
  .object({ suggestion: publisherSuggestionSchema })
  .strict();
export type ReviewPublisherSuggestionResponse = z.infer<
  typeof reviewPublisherSuggestionResponseSchema
>;
