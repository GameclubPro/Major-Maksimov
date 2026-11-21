import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { chatSettingsSchema } from '@maxim/contracts/settings';
import {
  NETWORK_ALLOWLIST_PLAN_ROW_LIMIT,
  type NetworkNavigationAllowlistIntent,
} from '@maxim/contracts/network-settings';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { NetworkNavigationAllowlist } from './network-navigation-allowlist';
import { saveChatSettings, sanitizeStoredChatSettings } from './admin-chat-settings';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;
integration('bounded network allowlist transactions with PostgreSQL', () => {
  let db: PrismaClient;
  let allowlist: NetworkNavigationAllowlist;
  let chatId: string;
  let operationId: string;
  const actor = 'network-list-' + randomUUID();
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15000 }),
    });
    allowlist = new NetworkNavigationAllowlist(db as PrismaService);
  });
  beforeEach(async () => {
    chatId = 'network-list-' + randomUUID();
    operationId = randomUUID();
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Список',
        entityType: 'CHAT',
        settings: { create: { linkBotMessageText: 'Own text' } },
      },
    });
  });
  afterEach(async () => {
    await db.networkSettingsOperation.deleteMany({ where: { id: operationId } });
    await db.auditLog.deleteMany({ where: { chatId } });
    await db.chat.deleteMany({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const revision = async () =>
    (
      await db.chat.findUniqueOrThrow({
        where: { id: chatId },
        select: { navigationAllowlistRevision: true },
      })
    ).navigationAllowlistRevision;
  const intent = (value = 'example.org'): NetworkNavigationAllowlistIntent => ({
    mode: 'edit',
    actions: [{ op: 'add', target: { value, kind: 'WEB_DOMAIN' }, removeAfterAt: null }],
  });
  async function settings() {
    const row = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    return {
      ...chatSettingsSchema.parse(sanitizeStoredChatSettings(row)),
      settingsRevision: row.updatedAt.toISOString(),
    };
  }
  async function save(
    body: unknown,
    networkWrite?: Parameters<typeof saveChatSettings>[0]['networkWrite'],
  ) {
    return saveChatSettings({
      prisma: db as PrismaService,
      chatContextCache: { invalidate: async () => undefined },
      chatId,
      actorUserId: actor,
      body,
      source: 'miniapp',
      resolveBotAssignmentData: () => ({}),
      assertRequiredSubscriptionSettings: async () => undefined,
      reportsAvailable: () => false,
      assertBotCapabilities: async () => undefined,
      refreshExecutionReadiness: async () => undefined,
      networkWrite,
    });
  }
  it('versions legacy insert/update/delete statements independently and ignores true no-op updates', async () => {
    const initial = await revision();
    await db.domainAllowlist.createMany({
      data: [
        { chatId, domain: 'domain:one.example' },
        { chatId, domain: 'domain:two.example' },
      ],
    });
    expect(await revision()).toBe(initial + 1);
    await db.domainAllowlist.updateMany({ where: { chatId }, data: { removeAfterAt: null } });
    expect(await revision()).toBe(initial + 1);
    await db.domainAllowlist.updateMany({
      where: { chatId },
      data: { removeAfterAt: new Date(Date.now() + 60000) },
    });
    expect(await revision()).toBe(initial + 2);
    await db.domainAllowlist.deleteMany({ where: { chatId } });
    expect(await revision()).toBe(initial + 3);
  });
  it('canonicalizes an intent idempotently and preserves alias creation times and revision on identical replacement', async () => {
    const createdAt = new Date('2020-01-01T00:00:00Z');
    await db.domainAllowlist.createMany({
      data: [
        { chatId, domain: 'domain:Example.ORG', createdAt, removeAfterAt: null },
        {
          chatId,
          domain: 'domain:example.org',
          createdAt: new Date(+createdAt + 1000),
          removeAfterAt: new Date(Date.now() + 60000),
        },
      ],
    });
    const before = await db.domainAllowlist.findMany({
      where: { chatId },
      orderBy: { domain: 'asc' },
    });
    const observed = await allowlist.read(chatId);
    const version = await revision();
    const replacement: NetworkNavigationAllowlistIntent = {
      mode: 'replace',
      entries: [{ value: 'Example.ORG', kind: 'WEB_DOMAIN', removeAfterAt: null }],
    };
    const impact = await db.$transaction((tx) =>
      allowlist.planInTransaction(tx, chatId, replacement, observed.witness, actor, false),
    );
    expect(impact).toMatchObject({
      before: 1,
      after: 1,
      added: 0,
      removed: 0,
      expiryChanged: 0,
      noops: 1,
    });
    expect(
      await db.domainAllowlist.findMany({ where: { chatId }, orderBy: { domain: 'asc' } }),
    ).toEqual(before);
    expect(await revision()).toBe(version);
    const again = await allowlist.read(chatId);
    expect(again.entries).toEqual([
      { value: 'example.org', kind: 'WEB_DOMAIN', removeAfterAt: null },
    ]);
    await db.$transaction((tx) =>
      allowlist.planInTransaction(tx, chatId, intent('other.example'), again.witness, actor, false),
    );
    expect((await allowlist.read(chatId)).entries.map((row) => row.value)).toEqual([
      'example.org',
      'other.example',
    ]);
  });
  it('rejects stale and expired witnesses without changing rows or audit', async () => {
    const first = await allowlist.read(chatId);
    await db.domainAllowlist.create({ data: { chatId, domain: 'domain:old.example' } });
    await expect(allowlist.validate(chatId, intent(), first.witness, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const now = Date.now();
    const expiresAt = new Date(now + 60_000);
    jest.useFakeTimers({
      now,
      doNotFake: [
        'hrtime',
        'performance',
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });
    try {
      await db.domainAllowlist.create({
        data: { chatId, domain: 'domain:expires.example', removeAfterAt: expiresAt },
      });
      const expiring = await allowlist.read(chatId);
      expect(expiring.witness.nextExpiryAt).toBe(expiresAt.toISOString());
      await expect(
        allowlist.validate(chatId, intent(), expiring.witness, actor),
      ).resolves.toMatchObject({ added: 1 });
      jest.setSystemTime(expiresAt);
      await expect(
        allowlist.validate(chatId, intent(), expiring.witness, actor),
      ).rejects.toBeInstanceOf(ConflictException);
    } finally {
      jest.useRealTimers();
    }
    expect(await db.auditLog.count({ where: { chatId } })).toBe(0);
  });
  it('validateOnly has zero writes and scalar/list/audit/receipt roll back together on lost receipt', async () => {
    const current = await settings();
    const observed = await allowlist.read(chatId);
    const oldVersion = await revision();
    const plan = intent();
    await expect(allowlist.validate(chatId, plan, observed.witness, actor)).resolves.toMatchObject({
      added: 1,
    });
    expect(await revision()).toBe(oldVersion);
    expect(await db.domainAllowlist.count({ where: { chatId } })).toBe(0);
    await db.networkSettingsOperation.create({
      data: {
        id: operationId,
        actorUserId: actor,
        entityType: 'CHAT',
        requestHash: 'a'.repeat(64),
        section: 'links',
        status: 'RUNNING',
        payload: {},
        targets: {
          create: { entityId: chatId, revision: current.settingsRevision, status: 'AUTHORIZED' },
        },
      },
    });
    const body = { ...current, linkBotMessageText: 'New shared text' };
    const write = {
      authoredKeys: ['linkBotMessageText'] as const,
      beforeWrite: async (tx: Parameters<NetworkNavigationAllowlist['planInTransaction']>[0]) => {
        await allowlist.planInTransaction(tx, chatId, plan, observed.witness, actor, false);
      },
      onCommitted: async () => {
        throw new Error('lost receipt');
      },
    };
    await expect(save(body, write)).rejects.toThrow('lost receipt');
    expect((await settings()).linkBotMessageText).toBe('Own text');
    expect(await revision()).toBe(oldVersion);
    expect(await db.domainAllowlist.count({ where: { chatId } })).toBe(0);
    expect(await db.auditLog.count({ where: { chatId } })).toBe(0);
    await save(body, {
      ...write,
      onCommitted: async (tx, committedRevision) => {
        await tx.networkSettingsOperationTarget.update({
          where: { operationId_entityId: { operationId, entityId: chatId } },
          data: { status: 'COMMITTED', committedRevision },
        });
      },
    });
    expect((await settings()).linkBotMessageText).toBe('New shared text');
    expect((await allowlist.read(chatId)).entries).toHaveLength(1);
    expect(
      (
        await db.networkSettingsOperationTarget.findUniqueOrThrow({
          where: { operationId_entityId: { operationId, entityId: chatId } },
        })
      ).status,
    ).toBe('COMMITTED');
    expect(await db.auditLog.count({ where: { chatId } })).toBeGreaterThanOrEqual(2);
  });
  it('serializes a legacy writer against the same parent lock and rejects the next stale plan', async () => {
    const observed = await allowlist.read(chatId);
    let unlock!: () => void;
    let locked!: () => void;
    const lockedPromise = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const own = db.$transaction(
      async (tx) => {
        await allowlist.planInTransaction(tx, chatId, intent(), observed.witness, actor, false);
        locked();
        await releasePromise;
      },
      { timeout: 10000 },
    );
    await lockedPromise;
    let settled = false;
    const legacy = db.domainAllowlist
      .create({ data: { chatId, domain: 'domain:legacy.example' } })
      .then(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    unlock();
    await own;
    await legacy;
    expect((await allowlist.read(chatId)).entries.map((row) => row.value)).toEqual([
      'example.org',
      'legacy.example',
    ]);
    await expect(
      allowlist.validate(chatId, intent('next.example'), observed.witness, actor),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it('bounds physical aliases plus additions before writes and refuses the sentinel while scalar settings remain usable', async () => {
    await db.domainAllowlist.createMany({
      data: Array.from({ length: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT }, (_, i) => ({
        chatId,
        domain: 'https://example.test/' + 'a'.repeat(1900) + '?i=' + i,
      })),
    });
    const started = performance.now();
    const observed = await allowlist.read(chatId, undefined, false);
    const before = await revision();
    await expect(
      allowlist.validate(chatId, intent('new.example'), observed.witness, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await revision()).toBe(before);
    expect(await db.domainAllowlist.count({ where: { chatId } })).toBe(
      NETWORK_ALLOWLIST_PLAN_ROW_LIMIT,
    );
    console.info(
      'network-allowlist native bounded read',
      JSON.stringify({
        rows: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT,
        approxBytes: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT * 1950,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
    await db.domainAllowlist.create({ data: { chatId, domain: 'domain:sentinel.example' } });
    await expect(allowlist.read(chatId)).rejects.toMatchObject({
      response: { code: 'NETWORK_ALLOWLIST_PLAN_TOO_LARGE' },
    });
    const body = await settings();
    await save(
      { ...body, linkBotMessageText: 'Scalar survives large list' },
      { authoredKeys: ['linkBotMessageText'] },
    );
    expect((await settings()).linkBotMessageText).toBe('Scalar survives large list');
    expect(await db.domainAllowlist.count({ where: { chatId } })).toBe(
      NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1,
    );
  });
});
