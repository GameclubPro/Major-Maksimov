import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import Redis from 'ioredis';
import { randomInt, randomUUID } from 'node:crypto';
import type { AdminService } from '../admin/admin.service';
import type { KaravanStorefrontAllowlistService } from '../integrations/karavan-storefront/karavan-storefront-allowlist.service';
import type { MaxClientService } from '../max/max-client.service';
import { SESSION_KEY_PREFIX } from './private-control.constants';
import { createDefaultPrivateControlSession } from './private-control-session-normalizer';
import { PrivateControlService } from './private-control.service';
import type { PrivateSession } from './private-control.types';
import { RedisCounterService } from './redis-counter.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
const integration = redisUrl ? describe : describe.skip;
const botId = '777000_bot';
const chatId = '-70000000000001';

function worker(counter: RedisCounterService, config: ConfigService) {
  const sendMessage = jest
    .fn<ReturnType<MaxClientService['sendMessage']>, Parameters<MaxClientService['sendMessage']>>()
    .mockResolvedValue(undefined);
  const max: Pick<MaxClientService, 'sendMessage'> = { sendMessage };
  const admin: Pick<AdminService, 'assertManagedEntityAdminAccess' | 'getChatHeader'> = {
    assertManagedEntityAdminAccess: async () => {},
    getChatHeader: async () => {
      throw new Error('No cached header');
    },
  };
  const upsert = jest.fn<
    ReturnType<KaravanStorefrontAllowlistService['upsert']>,
    Parameters<KaravanStorefrontAllowlistService['upsert']>
  >();
  const allowlist: Pick<KaravanStorefrontAllowlistService, 'upsert'> = { upsert };
  const service = new PrivateControlService(
    max as MaxClientService,
    admin as AdminService,
    {} as never,
    {} as never,
    {} as never,
    counter,
    config,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    allowlist as KaravanStorefrontAllowlistService,
  );
  return { service, sendMessage, upsert };
}

function privateUpdate(actor: string, start?: string): MaxUpdate {
  const dialog = 152517912;
  const type = start ? 'bot_started' : 'message_created';
  return {
    type,
    botId,
    updateId: randomUUID(),
    message: {
      chatId: String(dialog),
      senderId: actor,
      messageId: randomUUID(),
      senderName: 'Администратор',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: start
      ? {
          update_type: type,
          chat_id: dialog,
          start_payload: start,
          user: { user_id: actor },
          chat: { chat_id: dialog, type: 'dialog' },
        }
      : {
          update_type: type,
          message: {
            recipient: { chat_id: dialog, chat_type: 'dialog' },
            sender: { user_id: actor },
            body: {
              text: '',
              forwarded_message: {
                sender: { user_id: '7788', name: 'Продавец' },
                recipient: { chat_id: -90000000000001, title: 'Объявления' },
                body: { text: 'Товар в наличии' },
              },
            },
          },
        },
  };
}

integration('Karavan allowlist handoff across private-control instances', () => {
  it.each([false, true])(
    'keeps one grant flow and its deadline (existing session: %s)',
    async (seed) => {
      if (!redisUrl || !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname))
        throw new Error('Isolated Redis required');
      const userId = String(randomInt(100000000, 999999999));
      const actor = {
        userId,
        launchBotId: botId,
        username: null,
        displayName: 'Администратор',
        chatId,
        chatTitle: 'Магазин',
      };
      const config = new ConfigService({ REDIS_URL: redisUrl, MAX_BOT_ID: botId });
      const observer = new Redis(redisUrl);
      const counters = [new RedisCounterService(config), new RedisCounterService(config)] as const;
      const [first, second] = [worker(counters[0], config), worker(counters[1], config)] as const;
      const key = `${SESSION_KEY_PREFIX}:${botId}:${userId}`;
      const read = async (): Promise<PrivateSession> => JSON.parse((await observer.get(key))!);
      const open = (instance: typeof first) =>
        instance.service.handoffKaravanStorefrontAllowlistFromMiniapp(chatId, actor);
      try {
        if (seed)
          await observer.set(
            key,
            JSON.stringify({ ...createDefaultPrivateControlSession(), lastPrivateChatId: '12345' }),
            'EX',
            300,
          );
        const [a, b] = await Promise.all([open(first), open(second)]);
        expect(a.botUrl).toBe(b.botUrl);
        const initial = await read();
        if (seed) expect(initial.lastPrivateChatId).toBe('12345');
        const deadline = initial.pendingKaravanAllowlist?.expiresAt;
        expect(deadline).toBeGreaterThan(Date.now());

        const start = new URL(a.botUrl).searchParams.get('start')!;
        await first.service.handleBotStarted(privateUpdate(userId, start));
        await first.service.handleUpdate(privateUpdate(userId));
        const choosing = (await read()).pendingKaravanAllowlist;
        expect(choosing).toMatchObject({
          stage: 'await_duration',
          targetUserId: '7788',
          targetDisplayName: 'Продавец',
          expiresAt: deadline,
        });
        const originalSessionExpiry = await observer.pexpiretime(key);
        expect(originalSessionExpiry).toBeGreaterThan(Date.now());
        await expect(open(second)).resolves.toEqual(a);
        expect(await observer.pexpiretime(key)).toBe(originalSessionExpiry);
        await second.service.handleBotStarted(privateUpdate(userId, start));
        expect((await read()).pendingKaravanAllowlist).toEqual(choosing);
        expect(second.sendMessage.mock.calls.at(-1)?.[1]).toContain('Срок разрешения');
        expect(first.upsert).not.toHaveBeenCalled();
        expect(second.upsert).not.toHaveBeenCalled();
      } finally {
        await observer.del(key);
        await Promise.all([
          observer.quit(),
          ...counters.map((counter) => counter.onModuleDestroy()),
        ]);
      }
    },
  );
});
