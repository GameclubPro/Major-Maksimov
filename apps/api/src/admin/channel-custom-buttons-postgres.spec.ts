import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { ChannelPostSignatureService } from './channel-post-signature.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;
integration('persistent channel buttons with PostgreSQL', () => {
  let db: PrismaClient;
  let service: ChannelPostSignatureService;
  const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 13)}`)}`;
  const button = { id: randomUUID(), text: 'Каталог', url: 'https://example.com/catalog#new' };
  const max = {
    getCurrentChatMemberAccess: jest
      .fn<
        ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
        Parameters<MaxClientService['getCurrentChatMemberAccess']>
      >()
      .mockResolvedValue({
        userId: 'bot',
        isAdmin: true,
        isOwner: false,
        permissions: ['edit_message'],
      }),
  } satisfies Pick<MaxClientService, 'getCurrentChatMemberAccess'>;
  const links = {
    resolveBotIdsForModerationAction: jest.fn().mockResolvedValue(['bot']),
    getExecutableBotById: jest.fn().mockReturnValue({ id: 'bot' }),
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({ adapter: createPrismaAdapter(databaseUrl, { max: 5 }) });
    await db.chat.create({
      data: { id: chatId, title: 'Custom buttons test', entityType: 'CHANNEL' },
    });
    service = new ChannelPostSignatureService(
      db as PrismaService,
      max as unknown as MaxClientService,
      links as unknown as MaxBotLinkService,
    );
  });
  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { chatId } });
    await db.chat.delete({ where: { id: chatId } });
    await db.$disconnect();
  });
  it('round-trips buttons independently of signature and protects old posts', async () => {
    const saved = await service.updateSettings(chatId, 'admin', {
      expectedRevision: 0,
      customButtonsEnabled: true,
      customButtons: [button],
    });
    expect(saved).toMatchObject({
      enabled: false,
      customButtonsEnabled: true,
      customButtons: [button],
      revision: 1,
    });
    expect(await service.buildCustomPostButtons(chatId)).toEqual([
      [{ type: 'link', text: button.text, url: button.url }],
    ]);
    expect(
      await service.buildCustomPostButtons(chatId, { sourceAt: '2000-01-01T00:00:00Z' }),
    ).toEqual([]);
    expect(await service.buildCustomPostButtons(chatId, { sourceAt: null })).toEqual([]);
    expect(
      await service.buildCustomPostButtons(chatId, {
        sourceAt: new Date(Date.now() + 1000).toISOString(),
      }),
    ).toHaveLength(1);
    expect(await service.buildCustomPostButtons(chatId, { entityType: 'chat' })).toEqual([]);
    const cutoff = (await db.channelSettings.findUniqueOrThrow({ where: { chatId } }))
      .customPostButtonsSince;
    await service.updateSettings(chatId, 'admin', { expectedRevision: 1, customButtons: [button] });
    expect(
      (await db.channelSettings.findUniqueOrThrow({ where: { chatId } })).customPostButtonsSince,
    ).toEqual(cutoff);
    const legacy = await service.updateSettings(chatId, 'admin', {
      expectedRevision: 1,
      text: 'Новая подпись',
    });
    expect(legacy.customButtons).toEqual([button]);
    expect(
      (await db.channelSettings.findUniqueOrThrow({ where: { chatId } })).customPostButtonsSince,
    ).toEqual(cutoff);
  });
  it('serializes competing administrators and retains the list when disabled', async () => {
    const current = await service.getSettings(chatId);
    const results = await Promise.allSettled([
      service.updateSettings(chatId, 'admin-a', {
        expectedRevision: current.revision,
        customButtonsEnabled: false,
      }),
      service.updateSettings(chatId, 'admin-b', {
        expectedRevision: current.revision,
        customButtons: [{ ...button, text: 'Другой каталог' }],
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ConflictException);
    const winner = await service.getSettings(chatId);
    const disabled = await service.updateSettings(chatId, 'admin', {
      expectedRevision: winner.revision,
      customButtonsEnabled: false,
    });
    expect(disabled.customButtons).toHaveLength(1);
    expect(await service.buildCustomPostButtons(chatId)).toEqual([]);
    const row = await db.channelSettings.findUniqueOrThrow({ where: { chatId } });
    expect(row.customPostButtonsSince).toBeNull();
  });
});
