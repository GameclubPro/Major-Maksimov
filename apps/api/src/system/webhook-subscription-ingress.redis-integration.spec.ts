import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
const native = redisUrl ? describe : describe.skip;

native('webhook subscription ingress on Redis', () => {
  it('preserves each bot maximum across independent clients and stale reconciliation writes', async () => {
    const url = new URL(redisUrl!);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Disposable localhost Redis is required');
    }
    url.searchParams.set('keyPrefix', `test:subscription:${randomUUID()}:`);
    const config = new ConfigService({ REDIS_URL: url.toString() });
    const [first, second] = [
      new WebhookSubscriptionStatusService(config),
      new WebhookSubscriptionStatusService(config),
    ];
    const cleanup = new Redis(url.toString());
    const at = (ms: number) => new Date(Date.UTC(2026, 10, 18) + ms).toISOString();
    try {
      const writes = Array.from({ length: 80 }, (_, i) =>
        (i % 3 ? first : second).markIncomingWebhook(i % 2 ? 'bot-a' : 'bot-b', at((i * 73) % 80)),
      );
      writes.push(
        first.writeSyncState({
          bots: {},
          lastGlobalIncomingWebhookAt: at(999),
          lastGlobalAutoRecreateAt: null,
        }),
      );
      await Promise.all(writes);
      await expect(second.getSyncState()).resolves.toMatchObject({
        bots: {
          'bot-a': { lastIncomingWebhookAt: at(79) },
          'bot-b': { lastIncomingWebhookAt: at(78) },
        },
        lastGlobalIncomingWebhookAt: at(79),
      });
    } finally {
      try {
        await cleanup.del(
          'system:webhook-subscription:sync-state:v1',
          'system:webhook-subscription:ingress:v1',
        );
      } finally {
        await Promise.all([first.onModuleDestroy(), second.onModuleDestroy(), cleanup.quit()]);
      }
    }
  });
});
