import { z } from 'zod';

export const PUBLISHER_POST_IMPORT_COLLECTION_LIMIT = 10;
export const PUBLISHER_POST_IMPORT_COLLECT_PREFIX = 'pi_collect_';
export const PUBLISHER_POST_IMPORT_FINISH_PREFIX = 'pi_finish_';

const inputMessageSchema = z
  .object({
    messageId: z.string().trim().min(1).max(512),
    webhookEventId: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

export type PublisherPostImportInputMessage = z.infer<typeof inputMessageSchema>;

const inputMessagesSchema = z.array(inputMessageSchema).max(PUBLISHER_POST_IMPORT_COLLECTION_LIMIT);

export function readPublisherPostImportInputMessages(
  value: unknown,
): PublisherPostImportInputMessage[] {
  const result = inputMessagesSchema.safeParse(value);
  return result.success ? result.data : [];
}
