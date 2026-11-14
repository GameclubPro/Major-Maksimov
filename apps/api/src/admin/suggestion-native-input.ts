import { z } from 'zod';
import type { PrismaService } from '../prisma/prisma.service';
import type { SuggestionNativeJob } from '../publisher/suggestion-native.queue';
import { nativeContentSchema } from './suggestion-native-content';

const pendingInputSchema = z.object({
  eventId: z.string(),
  messageId: z.string(),
  requestedAt: z.string().datetime(),
  openedAt: z.string().datetime(),
  edited: z.boolean().optional(),
  input: nativeContentSchema.optional(),
  inputError: z.string().optional(),
});

export function readPendingSuggestionInput(draft: unknown) {
  if (!draft || typeof draft !== 'object' || !('pendingInput' in draft)) return null;
  return pendingInputSchema.parse(draft.pendingInput);
}

export async function retainSuggestionNativeInput(
  prisma: PrismaService,
  job: SuggestionNativeJob,
): Promise<void> {
  if (job.callback || !job.deliveryId || !job.openedAt) return;
  const requestedAt = new Date(job.requestedAt);
  if (
    !Number.isFinite(requestedAt.getTime()) ||
    requestedAt.getTime() > Date.now() + 60_000 ||
    Date.now() - requestedAt.getTime() > 5 * 60_000
  )
    return;
  const dialog = await prisma.suggestionReviewDialog.findUnique({
    where: { deliveryId: job.deliveryId },
  });
  if (!dialog || requestedAt < dialog.openedAt) return;
  const contact = ['contact', 'contact_confirm'].includes(dialog.mode);
  const pendingInput = pendingInputSchema.parse({
    eventId: job.eventId,
    messageId: job.messageId,
    requestedAt: job.requestedAt,
    openedAt: job.openedAt,
    ...(job.edited !== undefined ? { edited: job.edited } : {}),
    ...(job.input ? { input: job.input } : {}),
    ...(job.inputError ? { inputError: job.inputError } : {}),
  });
  // FLAG: Persist before Redis handoff, bind quick edits, and revoke the old preview in one CAS.
  // The existing edit/contact modes fail closed for older readers; only a validated preview can publish.
  await prisma.suggestionReviewDialog.updateMany({
    where: {
      deliveryId: job.deliveryId,
      botId: job.requiredBotId,
      actorId: job.actorId,
      privateChatId: job.privateChatId,
      profile: job.profile,
      openedAt: new Date(job.openedAt),
      expiresAt: { gt: new Date() },
      mode: { in: contact ? ['contact', 'contact_confirm'] : ['edit', 'preview', 'format'] },
      ...(job.edited ? { inputMessageId: job.messageId } : {}),
      OR: [{ inputAt: null }, { inputAt: { lt: requestedAt } }],
    },
    data: {
      mode: contact ? 'contact' : 'edit',
      draft: { pendingInput },
      inputMessageId: job.messageId,
      inputAt: requestedAt,
      version: { increment: 1 },
    },
  });
}
