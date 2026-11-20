import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  PUBLISHER_POST_IMPORT_COLLECT_PREFIX,
  PUBLISHER_POST_IMPORT_FINISH_PREFIX,
} from './publisher-post-import-input';
import {
  PublisherPostImportQueueService,
  type PublisherPostImportJob,
} from './publisher-post-import.queue';
import { PublisherPostImportService } from './publisher-post-import.service';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;

native('Publisher private import collection on PostgreSQL and Redis', () => {
  const suffix = randomUUID().slice(0, 8);
  const botId = 'publik_bot';
  const actor: AuthUser = { userId: '427105813510', username: null, displayName: null };
  const chatId = Number(actor.userId);
  const parser = new WebhookParser();
  let prisma: PrismaClient;
  let queue: Queue<PublisherPostImportJob>;
  let service: PublisherPostImportService;

  const parse = (raw: Record<string, unknown>, sentAt = new Date()) =>
    parser.parse({ timestamp: sentAt.toISOString(), update_id: randomUUID(), ...raw }, { botId });

  const callback = (payload: string, actorUserId: string = actor.userId) =>
    parse({
      update_type: 'message_callback',
      callback: { callback_id: randomUUID(), user: { user_id: actorUserId }, payload },
    });

  function direct(mid: string, text: string, sentAt?: Date): MaxUpdate {
    return parse(
      {
        update_type: 'message_created',
        message: {
          sender: { user_id: chatId },
          recipient: { chat_id: chatId, chat_type: 'dialog' },
          body: { mid, text },
        },
      },
      sentAt,
    );
  }

  beforeAll(async () => {
    const url = new URL(redisUrl);
    prisma = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl, { max: 4 }) });
    await prisma.$connect();
    queue = new Queue(`publisher-import-native-${suffix}`, {
      connection: {
        host: url.hostname,
        port: Number(url.port),
        db: Number(url.pathname.slice(1)),
      },
    });
    await queue.waitUntilReady();
    const store = prisma as unknown as PrismaService;
    service = new PublisherPostImportService(
      store,
      new PublisherPostImportQueueService(queue),
      new ConfigService({ MAX_PUBLISHER_BOT_ID: botId, PUBLISHER_POST_IMPORT_ENABLED: true }),
      new PublisherPrivateFlowLeaseService(store),
    );
  });

  afterAll(async () => {
    if (queue) {
      await queue.obliterate();
      await queue.close();
    }
    if (prisma) {
      await prisma.publisherPrivateFlowLease.deleteMany({
        where: { publisherBotId: botId, actorUserId: actor.userId },
      });
      await prisma.publisherPostImportSession.deleteMany({
        where: { publisherBotId: botId, actorUserId: actor.userId },
      });
      await prisma.$disconnect();
    }
  });

  it('starts only after handoff and freezes a deduplicated collection at explicit Finish', async () => {
    const session = await service.create(
      actor,
      { requestId: `collect_${suffix}`, inputMode: 'message' },
      true,
    );
    const token = new URL(session.botUrl!).searchParams.get('start')!.slice(3);
    const start = (payload: string) =>
      parse({
        update_type: 'bot_started',
        chat_id: chatId,
        user: { user_id: chatId },
        payload,
      });
    const early = direct(
      `before-${suffix}`,
      'Сообщение из старого сеанса',
      new Date(Date.now() - 60_000),
    );
    expect(await service.observeWebhook(early)).toBe(false);
    expect(await service.observeWebhook(start(`pi_${token}`))).toBe(true);
    const switchToCollection = `${PUBLISHER_POST_IMPORT_COLLECT_PREFIX}${token}`;
    const finish = `${PUBLISHER_POST_IMPORT_FINISH_PREFIX}${token}`;
    expect(await service.observeWebhook(callback(switchToCollection, '1234'))).toBe(true);
    expect((await service.getCurrent(actor, true)).session?.inputMode).toBe('message');

    await service.observeWebhook(callback(switchToCollection));
    await service.observeWebhook(callback(finish));
    await service.observeWebhook(early);
    expect((await service.getCurrent(actor, true)).session).toMatchObject({
      status: 'waiting',
      inputMode: 'collection',
      collectedCount: 0,
    });
    const first = direct(`first-${suffix}`, 'Подпись');
    const second = direct(`second-${suffix}`, 'Ссылка');
    await service.observeWebhook(first, 'receipt-first');
    await Promise.all([
      service.observeWebhook(first, 'receipt-first'),
      service.observeWebhook(second, 'receipt-second'),
      service.observeWebhook(second, 'receipt-second'),
    ]);
    expect((await service.getCurrent(actor, true)).session?.collectedCount).toBe(2);
    expect(
      await queue
        .getJobs(['prioritized'])
        .then((jobs) => jobs.filter((job) => job.data.kind === 'process')),
    ).toEqual([]);

    await Promise.all([
      service.observeWebhook(callback(finish)),
      service.observeWebhook(callback(finish)),
    ]);
    await service.observeWebhook(direct(`late-${suffix}`, 'После нажатия'));
    const stored = await prisma.publisherPostImportSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(stored.status).toBe('PROCESSING');
    expect(stored.inputMessages).toEqual([
      { messageId: first.message?.messageId, webhookEventId: 'receipt-first' },
      { messageId: second.message?.messageId, webhookEventId: 'receipt-second' },
    ]);
    expect(
      await queue
        .getJobs(['prioritized'])
        .then((jobs) =>
          jobs.filter((job) => job.data.kind === 'process').map((job) => job.data.sessionId),
        ),
    ).toEqual([session.id]);
  });
});
