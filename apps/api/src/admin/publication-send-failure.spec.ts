import { classifyPublicationSendFailure } from './publication-send-failure';
import { markManagedBroadcastSendPhase } from './admin-managed-broadcast-reconciliation';
import { recoverManagedBroadcastDeliveriesForAutomaticRun } from './admin-managed-broadcast-automatic-recovery';
import type { Prisma, ManagedBroadcastDelivery } from '../prisma/prisma-client';

describe('Publication SEND outcome precedence', () => {
  it.each([
    [false, undefined, undefined, 'timeout', 'failed'],
    [true, undefined, undefined, 'timeout', 'ambiguous'],
    [true, 503, 'chat.denied', 'Chat not accessible', 'ambiguous'],
    [true, 403, undefined, 'Forbidden', 'failed'],
    [true, 404, undefined, 'Chat not found', 'failed'],
    [true, 403, 'chat.denied', 'denied', 'target_denied'],
    [true, 404, 'chat.not.found', 'denied', 'target_denied'],
    [true, 429, undefined, 'Too many requests', 'failed'],
  ] as const)('classifies phase=%s HTTP=%s code=%s', (started, status, code, message, expected) => {
    const error = Object.assign(new Error(message), { response: { status, data: { code } } });
    expect(classifyPublicationSendFailure(markManagedBroadcastSendPhase(error, started))).toBe(
      expected,
    );
  });

  it.each(['Forbidden', 'Chat not found', 'timeout', null])(
    'does not mutate Publication failures from historical text %s',
    async (lastError) => {
      const updateMany = jest.fn<
        Promise<Prisma.BatchPayload>,
        [Prisma.ManagedBroadcastDeliveryUpdateManyArgs]
      >();
      const row = {
        id: 'delivery',
        publicationOccurrenceId: 'occurrence',
        status: 'FAILED',
        attemptCount: 6,
        lastError,
      } as ManagedBroadcastDelivery;
      const rows = [row];
      expect(
        await recoverManagedBroadcastDeliveriesForAutomaticRun({
          context: {
            prisma: { managedBroadcastDelivery: { updateMany } } as never,
            logger: { warn: jest.fn() } as never,
          },
          broadcastId: 'broadcast',
          occurrenceIndex: 1,
          deliveries: rows,
        }),
      ).toBe(rows);
      expect(updateMany).not.toHaveBeenCalled();
    },
  );
});
