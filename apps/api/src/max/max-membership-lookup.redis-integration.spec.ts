import { randomUUID } from 'node:crypto';
import type { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { AxiosRequestConfig } from 'axios';
import { of } from 'rxjs';
import type { ActionHealthService } from '../system/action-health.service';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxClientService } from './max-client.service';
import { MaxMembershipLookupService } from './max-membership-lookup.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
const native = redisUrl ? describe : describe.skip;

native('fresh giveaway eligibility with the MAX transport cache', () => {
  it('observes a member leaving and another joining at entry, draw and claim', async () => {
    const botId = `giveaway-fresh-${randomUUID()}`;
    const chatId = `giveaway-${randomUUID()}`;
    const config = new ConfigService({
      REDIS_URL: redisUrl!,
      MAX_API_BASE_URL: 'https://giveaway.invalid',
      MAX_BOT_ID: botId,
      MAX_BOT_TOKEN: `local-only-${botId}`,
      MAX_WEBHOOK_SECRET_PATH: 'local-only-path',
      MAX_WEBHOOK_HEADER_SECRET: 'local-only-header',
      MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 0,
    });
    let members = new Set(['21']);
    const probes: string[][] = [];
    const request = jest.fn((params: AxiosRequestConfig) => {
      const url = new URL(params.url!, 'https://giveaway.invalid');
      expect(url.pathname).toBe(`/chats/${chatId}/members`);
      const ids = url.searchParams.get('user_ids')!.split(',');
      probes.push(ids);
      return of({
        status: 200,
        data: { members: ids.filter((id) => members.has(id)).map((user_id) => ({ user_id })) },
      });
    });
    const health = {
      recordSuccessForLane: jest.fn(),
      recordFailureForLane: jest.fn(),
    } satisfies Pick<ActionHealthService, 'recordSuccessForLane' | 'recordFailureForLane'>;
    const client = new MaxClientService(
      { request } as unknown as HttpService,
      config,
      health as unknown as ActionHealthService,
      new MaxBotRegistryService(config),
      new MaxBotContextService(),
    );
    const lookup = new MaxMembershipLookupService(client, config);
    const both = ['21', '22'];
    const fresh = { botId, forceRefresh: true, allowStaleOnError: false };
    try {
      const initial = await lookup.getMemberships(chatId, both, 'giveaway_interactive', { botId });
      expect([...initial.values()]).toEqual([true, false]);
      members = new Set(['22']);
      expect((await client.getChatMembersAccess(chatId, ['21'], { botId })).has('21')).toBe(true);
      expect(probes).toEqual([both]);

      await expect(lookup.getMembership(chatId, '21', 'giveaway_interactive', fresh)).resolves.toBe(
        false,
      );
      await expect(lookup.getMembership(chatId, '22', 'giveaway_interactive', fresh)).resolves.toBe(
        true,
      );
      for (const policy of ['giveaway_draw_interactive', 'giveaway_draw_background'] as const) {
        const result = await lookup.getMemberships(chatId, both, policy, fresh);
        expect([...result.values()]).toEqual([false, true]);
      }
      await expect(lookup.getMembership(chatId, '21', 'giveaway_strict', fresh)).resolves.toBe(
        false,
      );
      expect(probes).toEqual([both, ['21'], ['22'], both, both, ['21']]);
    } finally {
      await lookup.onModuleDestroy();
      await client.onModuleDestroy();
    }
  });
});
