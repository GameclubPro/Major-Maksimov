import type { Job } from 'bullmq';

import { ModerationDeleteIntentProcessor } from './moderation-delete-intent.processor';
import type { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import type { ModerationDeleteIntentJob } from './moderation-delete-intent.queue';

describe('ModerationDeleteIntentProcessor', () => {
  const previousRole = process.env.APP_ROLE;

  afterEach(() => {
    if (previousRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = previousRole;
    }
  });

  it('lets the worker claim the unleased intent selected by the DB sweeper', async () => {
    process.env.APP_ROLE = 'action';
    const service = {
      executeLeasedIntent: jest.fn().mockResolvedValue(undefined),
      processQueuedIntent: jest
        .fn<
          ReturnType<ModerationDeleteIntentService['processQueuedIntent']>,
          Parameters<ModerationDeleteIntentService['processQueuedIntent']>
        >()
        .mockResolvedValue(undefined),
    } satisfies Pick<ModerationDeleteIntentService, 'processQueuedIntent' | 'executeLeasedIntent'>;
    const processor = new ModerationDeleteIntentProcessor(service as never);

    await processor.process({ data: { intentId: 'intent-1' } } as Job<ModerationDeleteIntentJob>);

    expect(service.processQueuedIntent).toHaveBeenCalledWith('intent-1');
    expect(service.executeLeasedIntent).not.toHaveBeenCalled();
  });
});
