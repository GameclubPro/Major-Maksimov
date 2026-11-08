import { MarketplaceProfileAccessService } from './marketplace-profile-access.service';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  type ExchangeGrantInput,
  type ExchangeMeasurement,
  type ExchangeStatisticsPage,
  exchangeMeasurementSchema,
  exchangeManifestSchema,
} from '@maxim/contracts';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import { type PrismaService } from '../../prisma/prisma.service';
import { MarketplaceStateService } from './marketplace-state.service';
import { MarketplaceStatisticsService } from './marketplace-statistics.service';
import { MarketplaceAccessService } from './marketplace-access.service';
import type { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import type { MaxClientService } from '../../max/max-client.service';
import { exchangeRetentionFrom } from './statistics-exchange-values';
import {
  StatisticsExchangeGrantsService,
  type StatisticsExchangeGrantRow,
} from './statistics-exchange-grants.service';
import { StatisticsExchangeStatisticsService } from './statistics-exchange-statistics.service';
import { StatisticsExchangeAudienceService } from './statistics-exchange-audience.service';
import { StatisticsExchangeDownloadsService } from './statistics-exchange-downloads.service';
import { StatisticsExchangeRuntimeService } from './statistics-exchange-runtime.service';
import { MarketplaceIntegrationController } from './marketplace.controller';
import {
  canonicalExchangeMeasurements,
  exchangeMeasurementsHash,
} from './statistics-exchange-values';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);
postgres('statistics exchange PostgreSQL consent and immutable observations', () => {
  let db: PrismaClient,
    state: MarketplaceStateService,
    grants: StatisticsExchangeGrantsService,
    statistics: StatisticsExchangeStatisticsService;
  let grantId: string, bindingId: string, entityId: string, actor: string;
  let attest: jest.MockedFunction<MarketplaceAccessService['attest']>;
  const config = new ConfigService({
    SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
    SVYAZKA_PROFILE_TOKEN: 'b'.repeat(64),
    SVYAZKA_STATISTICS_EXPORT_TOKEN: 'c'.repeat(64),
    SVYAZKA_STATISTICS_V2_USERS: '*',
  });
  const input = (
    revision = 1,
    stateInput: 'ACTIVE' | 'REVOKED' = 'ACTIVE',
  ): ExchangeGrantInput => ({
    grantId,
    actorUserId: actor,
    revision,
    state: stateInput,
    entities: stateInput === 'ACTIVE' ? [{ entityId, kind: 'CHANNEL', profile: 'moderation' }] : [],
  });
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
    state = new MarketplaceStateService(db as PrismaService, config);
    attest = jest.fn<
      ReturnType<MarketplaceAccessService['attest']>,
      Parameters<MarketplaceAccessService['attest']>
    >(async () => {
      const binding = await state.read(bindingId);
      if (!binding) throw new Error('Synthetic binding absent');
      return binding;
    });
    grants = new StatisticsExchangeGrantsService(
      db as PrismaService,
      config,
      { attest } as unknown as MarketplaceAccessService,
      state,
    );
    statistics = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      new MarketplaceStatisticsService(db as PrismaService, state),
    );
  });
  beforeEach(async () => {
    attest.mockClear();
    await db.$executeRaw`DELETE FROM statistics_exchange_peer_limits`;
    grantId = randomUUID();
    bindingId = randomUUID();
    actor = String(Date.now()) + String(Math.floor(Math.random() * 1000));
    entityId = '-' + actor;
    await db.chat.create({
      data: { id: entityId, title: 'Synthetic statistics channel', entityType: 'CHANNEL' },
    });
    await db.chatBotMembership.create({
      data: {
        chatId: entityId,
        botId: 'synthetic-v2-bot',
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
      },
    });
    const now = new Date(),
      from = new Date(now);
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - 89);
    const metadata = {
      title: 'Synthetic statistics channel',
      description: '',
      imageUrl: null,
      publicUrl: null,
      audience: 100,
      isPublic: true,
    };
    await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,history_complete,history_from,history_to)
      VALUES(${bindingId}::uuid,${actor},${entityId},'CHANNEL','moderation','synthetic-v2-bot','ACTIVE',${now},${new Date(now.getTime() + 300_000)},${JSON.stringify(metadata)}::jsonb,true,${from},${now})`;
    const published = new Date(now.getTime() - 3 * 86400_000);
    published.setUTCHours(8, 0, 0, 0);
    await db.channelPost.create({
      data: {
        chatId: entityId,
        messageId: 'synthetic-post',
        publishedAt: published,
        latestViews: 10,
        latestSnapshotAt: now,
        viewsAt24h: 5,
        viewsAt24hCapturedAt: new Date(published.getTime() + 86400_000 + 300_000),
      },
    });
    await db.$executeRaw`INSERT INTO marketplace_audience_observations(binding_id,bucket,audience,observed_at) VALUES(${bindingId}::uuid,date_trunc('hour',now()),100,now())`;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.$executeRaw`DELETE FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE id=${grantId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_statistics_generations WHERE binding_id=${bindingId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_audience_observations WHERE binding_id=${bindingId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_policy_requests WHERE binding_id=${bindingId}::uuid`;
    await db.$executeRaw`DELETE FROM marketplace_bindings WHERE id=${bindingId}::uuid`;
    await db.chat.delete({ where: { id: entityId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function nativeAll() {
    let page = await statistics.page(grantId, { entityId, kind: 'CHANNEL' });
    const rows = [...page.rows],
      manifest = page.manifest;
    while (page.nextCursor) {
      page = await statistics.page(grantId, {
        entityId,
        kind: 'CHANNEL',
        generationId: manifest.generationId,
        cursor: page.nextCursor,
      });
      rows.push(...page.rows);
    }
    return { manifest, rows };
  }
  async function remoteFixture(): Promise<ExchangeStatisticsPage> {
    const asOf = new Date();
    const from = new Date(asOf);
    from.setUTCHours(0, 0, 0, 0);
    // FLAG: Peer fixtures retain a full day of margin when latency advances through UTC midnight.
    // Native export expiry is tested separately; fixture creation must not page an expiring export.
    from.setUTCDate(from.getUTCDate() - 88);
    const rows: ExchangeMeasurement[] = canonicalExchangeMeasurements([
      {
        origin: 'EXCHANGE',
        method: 'utc-buckets-v1',
        revision: 1,
        data: {
          metric: 'AUDIENCE',
          bucket: asOf.toISOString().slice(0, 10) + 'T00:00:00.000Z',
          observedAt: asOf.toISOString(),
          value: 777,
        },
      },
    ]);
    const manifest = exchangeManifestSchema.parse({
      version: 2,
      grantId,
      grantRevision: 1,
      generationId: randomUUID(),
      bindingId,
      entityId,
      kind: 'CHANNEL',
      origin: 'EXCHANGE',
      producerRevision: 1,
      method: 'utc-buckets-v1',
      from: from.toISOString(),
      to: asOf.toISOString(),
      asOf: asOf.toISOString(),
      rowCount: rows.length,
      sha256: exchangeMeasurementsHash(rows),
      complete: true,
      horizonToleranceSeconds: 900,
      metrics: [
        {
          metric: 'AUDIENCE',
          complete: true,
          checkedAt: asOf.toISOString(),
          nextExpectedAt: new Date(asOf.getTime() + 300_000).toISOString(),
          error: false,
        },
      ],
    });
    return { manifest, rows, nextCursor: null };
  }
  function mockRemote(page: ExchangeStatisticsPage) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
      const url = String(raw);
      return new Response(
        JSON.stringify(url.includes('/statistics?') ? page : await grants.read(grantId)),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
  }
  async function useNestedRescanPlanner(tx: Pick<PrismaService, '$executeRaw'>) {
    // FLAG: Claim cardinality must survive rescans of the locking candidate subplan.
    await tx.$executeRaw`SET LOCAL enable_hashjoin=off`;
    await tx.$executeRaw`SET LOCAL enable_mergejoin=off`;
    await tx.$executeRaw`SET LOCAL enable_material=off`;
    await tx.$executeRaw`SET LOCAL enable_nestloop=on`;
    await tx.$executeRaw`SET LOCAL enable_hashagg=off`;
    await tx.$executeRaw`SET LOCAL enable_sort=off`;
    await tx.$executeRaw`SET LOCAL enable_memoize=off`;
  }
  it('mirrors monotonic consent idempotently and fences revocation without resurrecting a prior revision', async () => {
    expect((await grants.put(grantId, input())).entities[0]?.status).toBe('ACTIVE');
    const revision = (await state.read(bindingId))!.revision;
    await grants.put(grantId, input());
    expect((await state.read(bindingId))!.revision).toBe(revision);
    await expect(grants.put(grantId, { ...input(), entities: [] })).rejects.toThrow(
      'Версия согласия уже использована',
    );
    expect((await grants.put(grantId, input(2, 'REVOKED'))).entities).toEqual([]);
    expect((await state.read(bindingId))!.statistics_consent).toBe(false);
    await expect(grants.put(grantId, input())).rejects.toThrow('Версия согласия устарела');
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow(
      'Обмен отключён',
    );
  });
  it('preserves independent v1 consent when v2 is revoked', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true WHERE id=${bindingId}::uuid`;
    await grants.put(grantId, input());
    await grants.put(grantId, input(2, 'REVOKED'));
    expect((await state.read(bindingId))!.statistics_consent).toBe(true);
  });
  it('does not reenable an explicit legacy revoke through new selections, attestation, or unavailable recovery', async () => {
    await grants.put(grantId, input());
    const controller = new MarketplaceIntegrationController(
      {} as MarketplaceAccessService,
      state,
      {} as MarketplaceStatisticsService,
      db as PrismaService,
      {} as MarketplaceProfileAccessService,
    );
    await controller.revoke(bindingId, {
      requestId: randomUUID(),
      expectedRevision: (await state.read(bindingId))!.revision,
    });
    const denied = (await state.read(bindingId))!.statistics_revoked_at;
    expect(denied).toBeInstanceOf(Date);
    await db.$executeRaw`UPDATE marketplace_bindings SET state='ACTIVE',checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${bindingId}::uuid`;
    expect(await state.hasActiveAccess(bindingId)).toBe(true);
    expect((await grants.put(grantId, input(2))).entities[0]?.status).toBe('UNAVAILABLE');
    expect((await state.read(bindingId))!).toMatchObject({
      statistics_consent: false,
      statistics_revoked_at: denied,
    });
    await db.$executeRaw`UPDATE statistics_exchange_entities SET binding_id=NULL,next_check_at=now() WHERE grant_id=${grantId}::uuid`;
    expect(await grants.recoverUnavailable(grantId)).toBe(true);
    expect((await grants.read(grantId)).entities[0]?.binding).toBeNull();
    expect((await state.read(bindingId))!).toMatchObject({
      statistics_consent: false,
      statistics_revoked_at: denied,
    });
    expect(await state.hasActiveGrant(bindingId)).toBe(false);
    await expect(nativeAll()).rejects.toThrow('Доступ');
  });
  it('bounds initial handshake, isolates peer expiry from native access and invalidates proven remote loss', async () => {
    await grants.put(grantId, input());
    expect((await nativeAll()).rows.length).toBeGreaterThan(0);
    const fixture = await remoteFixture(),
      remote = mockRemote(fixture);
    await statistics.pull(grantId, 1);
    const audience = new StatisticsExchangeAudienceService(db as PrismaService, config, state);
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toHaveLength(1);
    const expire = async () => {
      await db.$executeRaw`UPDATE statistics_exchange_entities SET remote_valid_until=now()-interval '1 second' WHERE grant_id=${grantId}::uuid`;
      await db.$executeRaw`UPDATE statistics_exchange_imports SET remote_valid_until=now()-interval '1 second' WHERE grant_id=${grantId}::uuid`;
      await db.$executeRaw`UPDATE marketplace_bindings SET checked_at=now(),valid_until=now()+interval '5 minutes' WHERE id=${bindingId}::uuid`;
    };
    await expire();
    await grants.put(grantId, input()); // An idempotent retry cannot extend the initial peer proof.
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    expect((await grants.read(grantId)).entities[0]?.status).toBe('ACTIVE'); // Own rights stay readable for mutual expiry recovery.
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
    await expect(statistics.selected(grantId, entityId, 'CHANNEL')).rejects.toThrow('Доступ');
    expect(await state.hasActiveGrant(bindingId)).toBe(true);
    expect(
      await new MarketplaceStatisticsService(db as PrismaService, state).createGeneration(
        (await state.read(bindingId))!,
      ),
    ).toEqual(expect.any(String));
    await statistics.refreshRemoteAccess(grantId, 1); // Recovery requires a fresh peer GET, with no new PUT revision.
    expect((await grants.row(grantId))!.revision).toBe(1n);
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toHaveLength(1);
    expect((await nativeAll()).rows.length).toBeGreaterThan(0);
    await expire();
    remote.mockRejectedValueOnce(new Error('synthetic peer outage'));
    await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow(
      'synthetic peer outage',
    );
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
    await statistics.refreshRemoteAccess(grantId, 1);
    remote.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ ...(await grants.read(grantId)), state: 'REVOKED' })),
    );
    await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow('второй стороны');
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
    expect(await state.hasActiveGrant(bindingId)).toBe(true);
  });

  it('keeps partial peer permission and revision/binding proof scoped to one selected entity', async () => {
    const otherId = '-' + (BigInt(actor) + 1n).toString();
    await grants.put(grantId, {
      ...input(),
      entities: [
        { entityId, kind: 'CHANNEL', profile: 'moderation' },
        { entityId: otherId, kind: 'CHANNEL', profile: 'moderation' },
      ],
    });
    const fixture = await remoteFixture();
    mockRemote(fixture);
    await statistics.refreshRemoteAccess(grantId, 1);
    const proof = await db.$queryRaw<
      Array<{ entity_id: string; valid: boolean }>
    >`SELECT entity_id,remote_valid_until>now() AS valid FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid ORDER BY entity_id`;
    expect(proof.find((row) => row.entity_id === entityId)?.valid).toBe(true);
    expect(proof.find((row) => row.entity_id === otherId)?.valid).toBe(false);
    const remote = jest.mocked(globalThis.fetch);
    remote.mockImplementationOnce(
      async () => new Response(JSON.stringify({ ...(await grants.read(grantId)), revision: 2 })),
    );
    await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow('второй стороны');
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow('Доступ');
  });
  it('rejects an older active peer response after a newer denial at the same grant revision', async () => {
    await grants.put(grantId, input());
    const active = await grants.read(grantId);
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = jest.spyOn(globalThis, 'fetch');
    remote.mockImplementationOnce(async () => {
      started();
      await held;
      return new Response(JSON.stringify(active));
    });
    const delayed = statistics.refreshRemoteAccess(grantId, 1);
    await waiting;
    remote.mockImplementationOnce(
      async () => new Response(JSON.stringify({ ...active, state: 'REVOKED' })),
    );
    try {
      await expect(statistics.refreshRemoteAccess(grantId, 1)).rejects.toThrow('второй стороны');
      release();
      await expect(delayed).rejects.toThrow('EXCHANGE_AUTHORITY_CHECK_SUPERSEDED');
      await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow(
        'Доступ',
      );
      const proof = await db.$queryRaw<
        Array<{ valid: boolean }>
      >`SELECT remote_valid_until>now() AS valid FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
      expect(proof[0]!.valid).toBe(false);
    } finally {
      release();
      await delayed.catch(() => undefined);
    }
  });
  it('never transfers imported authority to a changed peer binding and honors its shorter expiry', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture(),
      remote = mockRemote(fixture);
    await statistics.pull(grantId, 1);
    const active = await grants.read(grantId),
      changedId = randomUUID(),
      until = new Date(Date.now() + 30_000).toISOString();
    active.entities[0]!.binding = {
      ...active.entities[0]!.binding!,
      id: changedId,
      validUntil: until,
    };
    remote.mockImplementationOnce(async () => new Response(JSON.stringify(active)));
    await statistics.refreshRemoteAccess(grantId, 1);
    const audience = new StatisticsExchangeAudienceService(db as PrismaService, config, state);
    expect(await audience.importedAudience(actor, entityId, 'CHANNEL')).toEqual([]);
    expect((await nativeAll()).rows.length).toBeGreaterThan(0);
    const proof = await db.$queryRaw<
      Array<{ remote_binding_id: string; remote_valid_until: Date }>
    >`SELECT remote_binding_id,remote_valid_until FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
    expect(proof[0]!.remote_binding_id).toBe(changedId);
    expect(proof[0]!.remote_valid_until.toISOString()).toBe(until);
  });
  it('rechecks the complete grant at final selected read even when independent native consent survives', async () => {
    await db.$executeRaw`UPDATE marketplace_bindings SET statistics_consent=true WHERE id=${bindingId}::uuid`;
    await grants.put(grantId, input());
    const binding = grants.binding.bind(grants);
    let calls = 0;
    jest.spyOn(grants, 'binding').mockImplementation(async (...args) => {
      const result = await binding(...args);
      calls++;
      if (calls === 3) await grants.put(grantId, input(2, 'REVOKED'));
      return result;
    });
    await expect(statistics.selected(grantId, entityId, 'CHANNEL')).rejects.toThrow(
      'Доступ изменился',
    );
    expect(await state.hasActiveGrant(bindingId)).toBe(true);
  });
  it('exports immutable complete generations with native origin and bound cursors', async () => {
    await grants.put(grantId, input());
    const first = await nativeAll();
    expect(first.rows.length).toBe(first.manifest.rowCount);
    expect(exchangeMeasurementsHash(first.rows)).toBe(first.manifest.sha256);
    expect(first.rows.every((row) => row.origin === 'MAXIM')).toBe(true);
    await db.channelPost.updateMany({ where: { chatId: entityId }, data: { latestViews: 900 } });
    const second = await nativeAll();
    expect(second.manifest.generationId).not.toBe(first.manifest.generationId);
    const frozen = await statistics.page(grantId, {
      entityId,
      kind: 'CHANNEL',
      generationId: first.manifest.generationId,
    });
    expect(frozen.manifest.sha256).toBe(first.manifest.sha256);
  });
  it('imports only original EXCHANGE generations without native overwrite or export echo', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    await statistics.pull(grantId, 1);
    const imported = await db.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND origin='EXCHANGE'`;
    expect(imported[0]!.count).toBe(1n);
    expect((await nativeAll()).rows.some((row) => row.origin !== 'MAXIM')).toBe(false);
    expect((await db.channelPost.findFirst({ where: { chatId: entityId } }))!.latestViews).toBe(10);
    const own = await state.read(bindingId);
    expect(own!.collection_owner).toBe('SHADOW');
    const projection = await db.$queryRaw<
      Array<{ rows: ExchangeMeasurement[] }>
    >`SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    expect(projection[0]!.rows).toEqual(page.rows);
  });
  it('omits post capabilities for private channels and refuses old public generations after visibility changes', async () => {
    await grants.put(grantId, input());
    const publicPage = await nativeAll();
    expect(publicPage.rows.some((row) => row.data.metric === 'REACH')).toBe(true);
    await db.$executeRaw`UPDATE marketplace_bindings SET metadata=jsonb_set(metadata,'{isPublic}','false') WHERE id=${bindingId}::uuid`;
    const privatePage = await nativeAll();
    expect(
      privatePage.rows.every(
        (row) => row.data.metric === 'AUDIENCE' || row.data.metric === 'MEMBERSHIP',
      ),
    ).toBe(true);
    expect(privatePage.manifest.metrics.map((row) => row.metric)).toEqual([
      'AUDIENCE',
      'MEMBERSHIP',
    ]);
    await expect(
      statistics.page(grantId, {
        entityId,
        kind: 'CHANNEL',
        generationId: publicPage.manifest.generationId,
      }),
    ).rejects.toThrow('Показатели недоступны');
  });

  it('does not hide a recorded collector failure behind an unchanged export generation', async () => {
    await grants.put(grantId, input());
    const success = await nativeAll();
    expect(success.manifest.metrics.every((metric) => !metric.error)).toBe(true);
    await db.$executeRaw`UPDATE marketplace_bindings SET collection_error='COLLECTION_UNAVAILABLE' WHERE id=${bindingId}::uuid`;
    const failed = await nativeAll();
    expect(failed.manifest.generationId).not.toBe(success.manifest.generationId);
    expect(
      failed.manifest.metrics.filter((metric) => metric.error).map((metric) => metric.metric),
    ).toEqual(['AUDIENCE', 'REACH', 'PUBLICATION_HOUR']);
    expect(failed.manifest.metrics.map((metric) => metric.checkedAt)).toEqual(
      success.manifest.metrics.map((metric) => metric.checkedAt),
    );
    await db.$executeRaw`UPDATE marketplace_bindings SET collection_error='POST_STATISTICS_UNAVAILABLE' WHERE id=${bindingId}::uuid`;
    const partial = await nativeAll();
    expect(
      partial.manifest.metrics.filter((metric) => metric.error).map((metric) => metric.metric),
    ).toEqual(['REACH', 'PUBLICATION_HOUR']);
    expect(partial.manifest.metrics.find((metric) => metric.metric === 'AUDIENCE')?.checkedAt).toBe(
      success.manifest.metrics.find((metric) => metric.metric === 'AUDIENCE')?.checkedAt,
    );
  });
  it('rejects checksum corruption and prevents import after revoke during an external read', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    const mock = mockRemote({ ...page, manifest: { ...page.manifest, sha256: '0'.repeat(64) } });
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('EXCHANGE_CHECKSUM_MISMATCH');
    mock.mockImplementation(async (raw) => {
      if (String(raw).includes('/statistics?')) {
        await grants.put(grantId, input(2, 'REVOKED'));
        return new Response(JSON.stringify(page));
      }
      return new Response(JSON.stringify(await grants.read(grantId)));
    });
    await expect(statistics.pull(grantId, 1)).rejects.toThrow(
      'EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED',
    );
    const imported = await db.$queryRaw<
      Array<{ count: bigint }>
    >`SELECT count(*) AS count FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND origin='EXCHANGE'`;
    expect(imported[0]!.count).toBe(0n);
  });
  it('rejects semantic bucket duplicates across pages and preserves the verified projection', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    const remote = mockRemote(page);
    await statistics.pull(grantId, 1);
    const rows = [
      { ...page.rows[0]!, revision: 2 },
      {
        ...page.rows[0]!,
        revision: 2,
        data: { ...page.rows[0]!.data, bucket: page.rows[0]!.data.bucket.replace('.000Z', 'Z') },
      },
    ];
    const manifest = {
      ...page.manifest,
      generationId: randomUUID(),
      producerRevision: 2,
      rowCount: rows.length,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    };
    let pages = 0;
    remote.mockImplementation(async (raw) => {
      if (!String(raw).includes('/statistics?'))
        return new Response(JSON.stringify(await grants.read(grantId)));
      const second = new URL(String(raw)).searchParams.has('cursor');
      pages++;
      return new Response(
        JSON.stringify({
          manifest,
          rows: [rows[second ? 1 : 0]],
          nextCursor: second ? null : 'next',
        }),
      );
    });
    await statistics.pull(grantId, 1);
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('EXCHANGE_DUPLICATE_ROW');
    expect(pages).toBe(2);
    const imported = await db.$queryRaw<Array<{ rows: ExchangeMeasurement[] }>>`
      SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    expect(imported[0]!.rows).toEqual(page.rows);
    const generations = await db.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND origin='EXCHANGE'`;
    expect(generations[0]!.count).toBe(1n);
  });
  function remoteGeneration(
    page: ExchangeStatisticsPage,
    rows: ExchangeMeasurement[],
    revision: number,
    from = page.manifest.from,
  ): ExchangeStatisticsPage {
    const canonical = canonicalExchangeMeasurements(rows.map((row) => ({ ...row, revision })));
    return {
      manifest: exchangeManifestSchema.parse({
        ...page.manifest,
        generationId: randomUUID(),
        producerRevision: revision,
        from,
        rowCount: canonical.length,
        sha256: exchangeMeasurementsHash(canonical),
      }),
      rows: canonical,
      nextCursor: null,
    };
  }
  it('verifies and retains the exact parsed wire order before building the read projection', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86400_000).toISOString();
    const first = fixture.rows[0]!;
    const rows: ExchangeMeasurement[] = [
      { ...first, data: { ...first.data, bucket: today.toISOString().replace('.000Z', 'Z') } },
      { ...first, data: { ...first.data, bucket: yesterday, observedAt: yesterday } },
    ];
    const page: ExchangeStatisticsPage = {
      ...fixture,
      manifest: {
        ...fixture.manifest,
        from: yesterday,
        rowCount: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      },
      rows,
    };
    expect(page.manifest.sha256).not.toBe(exchangeMeasurementsHash(rows));
    mockRemote(page);
    await statistics.pull(grantId, 1);
    const immutable = await db.$queryRaw<Array<{ rows: ExchangeMeasurement[] }>>`
      SELECT rows FROM statistics_exchange_generations WHERE id=${page.manifest.generationId}::uuid`;
    const stored = immutable[0]!.rows.map((row) => exchangeMeasurementSchema.parse(row));
    expect(stored).toEqual(rows);
    expect(createHash('sha256').update(JSON.stringify(stored)).digest('hex')).toBe(
      page.manifest.sha256,
    );
  });
  it('replaces an equivalent timestamp boundary without retaining the old bucket spelling', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const bucket = today.toISOString();
    const remote = mockRemote(fixture);
    await statistics.pull(grantId, 1);
    const alias = bucket.replace('.000Z', 'Z');
    const corrected = remoteGeneration(
      fixture,
      [
        {
          ...fixture.rows[0]!,
          data: { metric: 'AUDIENCE', bucket: alias, observedAt: alias, value: 999 },
        },
      ],
      2,
      alias,
    );
    remote.mockImplementation(
      async (raw) =>
        new Response(
          JSON.stringify(
            String(raw).includes('/statistics?') ? corrected : await grants.read(grantId),
          ),
        ),
    );
    await statistics.pull(grantId, 1);
    const imported = await db.$queryRaw<Array<{ rows: ExchangeMeasurement[] }>>`
      SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    expect(imported[0]!.rows).toEqual(corrected.rows);
  });
  it('replaces only the declared interval, preserves prior buckets and ignores delayed lower producer versions', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture(),
      today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86400_000).toISOString(),
      bucket = today.toISOString();
    const observation = (at: string, value: number): ExchangeMeasurement => ({
      origin: 'EXCHANGE',
      method: 'utc-buckets-v1',
      revision: 1,
      data: { metric: 'AUDIENCE', bucket: at, observedAt: at, value },
    });
    const first = remoteGeneration(
      fixture,
      [
        observation(yesterday, 701),
        observation(bucket, 702),
        {
          origin: 'EXCHANGE',
          method: 'utc-buckets-v1',
          revision: 1,
          data: {
            metric: 'MEMBERSHIP',
            bucket,
            observedAt: bucket,
            joined: 3,
            left: 1,
            complete: false,
          },
        },
      ],
      1,
      yesterday,
    );
    first.manifest.metrics.push({
      metric: 'MEMBERSHIP',
      checkedAt: bucket,
      nextExpectedAt: bucket,
      complete: false,
      error: false,
    });
    const remote = mockRemote(first);
    await statistics.pull(grantId, 1);
    const corrected = remoteGeneration(fixture, [observation(bucket, 999)], 2, bucket);
    remote.mockImplementation(
      async (raw) =>
        new Response(
          JSON.stringify(
            String(raw).includes('/statistics?') ? corrected : await grants.read(grantId),
          ),
        ),
    );
    await statistics.pull(grantId, 1);
    const readProjection = async () =>
      (
        await db.$queryRaw<
          Array<{ rows: ExchangeMeasurement[] }>
        >`SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
      )[0]!.rows;
    expect(
      (await readProjection()).map((row) =>
        row.data.metric === 'AUDIENCE' ? [row.data.bucket, row.data.value, row.revision] : null,
      ),
    ).toEqual([
      [yesterday, 701, 1],
      [bucket, 999, 2],
    ]);
    remote.mockImplementation(
      async (raw) =>
        new Response(
          JSON.stringify(String(raw).includes('/statistics?') ? first : await grants.read(grantId)),
        ),
    );
    await statistics.pull(grantId, 1);
    expect(
      (await readProjection()).map((row) =>
        row.data.metric === 'AUDIENCE' ? row.data.value : null,
      ),
    ).toEqual([701, 999]);
    const immutable = await db.$queryRaw<
      Array<{ manifest: ExchangeStatisticsPage['manifest']; rows: ExchangeMeasurement[] }>
    >`SELECT manifest,rows FROM statistics_exchange_generations WHERE id=${corrected.manifest.generationId}::uuid`;
    expect(immutable[0]!.rows).toEqual(corrected.rows);
    expect(exchangeMeasurementsHash(immutable[0]!.rows)).toBe(immutable[0]!.manifest.sha256);
    // Transport expiry must not let an old original overwrite the materialized producer fence.
    await db.$executeRaw`DELETE FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND origin='EXCHANGE'`;
    await statistics.pull(grantId, 1);
    expect(
      (await readProjection()).map((row) =>
        row.data.metric === 'AUDIENCE' ? row.data.value : null,
      ),
    ).toEqual([701, 999]);
  });

  it('does not sweep idle central grants or renew their MAX proofs', async () => {
    await grants.put(grantId, input());
    await db.$executeRaw`UPDATE marketplace_bindings SET valid_until=now()-interval '1 second',next_access_at=now()-interval '1 minute' WHERE id=${bindingId}::uuid`;
    const central = new ConfigService({
      STATISTICS_CENTRAL_ENABLED: true,
      STATISTICS_CENTRAL_MODE: 'CENTRAL',
      SVYAZKA_ANALYTICS_TOKEN: 'a'.repeat(64),
    });
    const refreshRequestedAccess = jest
      .fn<
        ReturnType<StatisticsExchangeGrantsService['refreshRequestedAccess']>,
        Parameters<StatisticsExchangeGrantsService['refreshRequestedAccess']>
      >()
      .mockResolvedValue(false);
    const recoverUnavailable = jest.fn<
      ReturnType<StatisticsExchangeGrantsService['recoverUnavailable']>,
      Parameters<StatisticsExchangeGrantsService['recoverUnavailable']>
    >();
    const refresh = jest.fn<
      ReturnType<MarketplaceAccessService['refresh']>,
      Parameters<MarketplaceAccessService['refresh']>
    >();
    const pull = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['pull']>,
      Parameters<StatisticsExchangeStatisticsService['pull']>
    >();
    const refreshRemoteAccess = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['refreshRemoteAccess']>,
      Parameters<StatisticsExchangeStatisticsService['refreshRemoteAccess']>
    >();
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      central,
      { pull, refreshRemoteAccess } as unknown as StatisticsExchangeStatisticsService,
      { refreshRequestedAccess, recoverUnavailable } as unknown as StatisticsExchangeGrantsService,
      { refresh } as unknown as MarketplaceAccessService,
    );
    const before = await state.read(bindingId);
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    try {
      await runtime.refreshAccessBatch();
      await runtime.tick();
      await runtime.refreshRemoteAccessBatch();
      expect(refreshRequestedAccess).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      expect(recoverUnavailable).not.toHaveBeenCalled();
      expect(pull).not.toHaveBeenCalled();
      expect(refreshRemoteAccess).not.toHaveBeenCalled();
      expect((await state.read(bindingId))?.checked_at).toEqual(before?.checked_at);
    } finally {
      await runtime.onModuleDestroy();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
  });

  it('does not renew an expired consumer lease when background MAX admission is paused', async () => {
    await grants.put(grantId, input());
    await db.$executeRaw`UPDATE marketplace_bindings SET valid_until=now()-interval '1 second',next_access_at=now()-interval '1 minute' WHERE id=${bindingId}::uuid`;
    const before = await state.read(bindingId);
    const governor = {
      decide: jest
        .fn<
          ReturnType<BackgroundRuntimeGovernorService['decide']>,
          Parameters<BackgroundRuntimeGovernorService['decide']>
        >()
        .mockResolvedValue({ action: 'pause', retryAfterMs: 60_000, reason: 'max_api' }),
    } satisfies Pick<BackgroundRuntimeGovernorService, 'decide'>;
    const snapshot = jest.fn<
      ReturnType<MaxClientService['getChatSnapshot']>,
      Parameters<MaxClientService['getChatSnapshot']>
    >();
    const access = new MarketplaceAccessService(
      db as PrismaService,
      {} as never,
      { getChatSnapshot: snapshot } as unknown as MaxClientService,
      state,
      undefined,
      undefined,
      config,
      governor,
    );
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      statistics,
      grants,
      access,
    );
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    try {
      await runtime.refreshAccessBatch();
      const after = await state.read(bindingId);
      expect(governor.decide).toHaveBeenCalledTimes(1);
      expect(snapshot).not.toHaveBeenCalled();
      expect(after?.valid_until).toEqual(before?.valid_until);
      expect(after?.checked_at).toEqual(before?.checked_at);
      expect(after?.state).toBe(before?.state);
      expect((await grants.read(grantId)).entities[0]!.status).toBe('UNAVAILABLE');
    } finally {
      await runtime.onModuleDestroy();
      await access.onModuleDestroy();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
  });

  it.each(
    (['deadline', 'shutdown', 'failure'] as const).flatMap((interruption) =>
      (['default', 'nested-rescan'] as const).map((planner) => ({ interruption, planner })),
    ),
  )(
    'does not postpone unstarted access checks after $interruption with $planner planner',
    async ({ interruption, planner }) => {
      const seed = randomUUID(),
        prefix = actor + 'admission';
      const previousRole = process.env.APP_ROLE;
      process.env.APP_ROLE = 'action';
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      let runtime!: StatisticsExchangeRuntimeService;
      const refresh = jest.fn<
        ReturnType<MarketplaceAccessService['refresh']>,
        Parameters<MarketplaceAccessService['refresh']>
      >(async () => {
        if (interruption === 'deadline') clock.mockReturnValue(now + 10_001);
        else if (interruption === 'shutdown') await runtime.onModuleDestroy();
        else throw new Error('Synthetic access failure');
      });
      try {
        await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent,next_access_at)
          SELECT md5(${seed}||'binding'||n)::uuid,${prefix}||n,'-'||n,'CHANNEL','moderation','synthetic-v2-bot','ACTIVE',now(),now()+interval '5 minutes','{}'::jsonb,true,now()-interval '1 minute' + n*interval '1 millisecond' FROM generate_series(1,4)n`;
        await db.$executeRaw`INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,input_hash)
          SELECT md5(${seed}||'grant'||n)::uuid,${prefix}||n,1,'ACTIVE','synthetic' FROM generate_series(1,4)n`;
        await db.$executeRaw`INSERT INTO statistics_exchange_entities(grant_id,entity_id,kind,profile,binding_id)
          SELECT md5(${seed}||'grant'||n)::uuid,'-'||n,'CHANNEL','moderation',md5(${seed}||'binding'||n)::uuid FROM generate_series(1,4)n`;
        const before = await db.$queryRaw<Array<{ id: string; next_access_at: Date }>>`
          SELECT id,next_access_at FROM marketplace_bindings WHERE actor_user_id LIKE ${prefix + '%'} ORDER BY next_access_at,id`;
        await db.$transaction(async (tx) => {
          if (planner === 'nested-rescan') await useNestedRescanPlanner(tx);
          const transactionPrisma = {
            $queryRaw: tx.$queryRaw.bind(tx),
          } satisfies Pick<PrismaService, '$queryRaw'>;
          runtime = new StatisticsExchangeRuntimeService(
            transactionPrisma as PrismaService,
            config,
            statistics,
            grants,
            { refresh } as unknown as MarketplaceAccessService,
          );
          if (interruption === 'failure')
            await expect(runtime.refreshAccessBatch()).rejects.toThrow('Synthetic access failure');
          else await runtime.refreshAccessBatch();
          expect(refresh).toHaveBeenCalledTimes(1);
          const attempted = refresh.mock.calls[0]![0].id;
          expect(attempted).toBe(before[0]!.id);
          const untouched = await tx.$queryRaw<Array<{ id: string; next_access_at: Date }>>`
            SELECT id,next_access_at FROM marketplace_bindings WHERE actor_user_id LIKE ${prefix + '%'} AND id<>${attempted}::uuid ORDER BY next_access_at,id`;
          expect(untouched).toEqual(before.slice(1));
          expect(untouched.every((row) => row.next_access_at.getTime() < now)).toBe(true);
        });
      } finally {
        clock.mockRestore();
        await runtime?.onModuleDestroy();
        if (previousRole === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previousRole;
        await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id IN(SELECT id FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'})`;
        await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'}`;
        await db.$executeRaw`DELETE FROM marketplace_bindings WHERE actor_user_id LIKE ${prefix + '%'}`;
      }
    },
  );

  it.each(
    (['tick', 'refreshRemoteAccessBatch'] as const).flatMap((method) =>
      (['default', 'nested-rescan'] as const).map((planner) => ({ method, planner })),
    ),
  )('admits only four grants in $method with $planner planner', async ({ method, planner }) => {
    const seed = randomUUID(),
      prefix = actor + 'batch';
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    let release!: () => void, admitted!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const pull = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['pull']>,
      Parameters<StatisticsExchangeStatisticsService['pull']>
    >(async () => {
      admitted();
      await pending;
      return {
        failures: 0,
        nextCursor: null,
        pending: false,
        completedEntities: 0,
        nextDelayMs: 300000,
        lastError: null,
      };
    });
    const refreshRemoteAccess = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['refreshRemoteAccess']>,
      Parameters<StatisticsExchangeStatisticsService['refreshRemoteAccess']>
    >(async () => {
      admitted();
      await pending;
    });
    const statisticsMock = { pull, refreshRemoteAccess } satisfies Pick<
      StatisticsExchangeStatisticsService,
      'pull' | 'refreshRemoteAccess'
    >;
    const grantsMock = {
      recoverUnavailable: jest
        .fn<
          ReturnType<StatisticsExchangeGrantsService['recoverUnavailable']>,
          Parameters<StatisticsExchangeGrantsService['recoverUnavailable']>
        >()
        .mockResolvedValue(false),
    } satisfies Pick<StatisticsExchangeGrantsService, 'recoverUnavailable'>;
    type Schedule = {
      id: string;
      next_pull_at: Date;
      next_remote_access_at: Date;
      lease_id: string | null;
      lease_until: Date | null;
      last_attempt_at: Date | null;
    };
    let runtime: StatisticsExchangeRuntimeService | undefined;
    try {
      await db.$executeRaw`INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,input_hash,next_pull_at,next_remote_access_at)
          SELECT (${seed.slice(0, 24)}||lpad(n::text,12,'0'))::uuid,${prefix}||n,1,'ACTIVE','synthetic',
            now()-interval '1 minute'+n*interval '1 millisecond',now()-interval '1 minute'+n*interval '1 millisecond' FROM generate_series(1,8)n`;
      const before = await db.$queryRaw<Schedule[]>`
          SELECT id,next_pull_at,next_remote_access_at,lease_id,lease_until,last_attempt_at
          FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'} ORDER BY next_pull_at,id`;
      await db.$transaction(async (tx) => {
        if (planner === 'nested-rescan') await useNestedRescanPlanner(tx);
        const transactionPrisma = {
          $queryRaw: tx.$queryRaw.bind(tx),
          $executeRaw: tx.$executeRaw.bind(tx),
        } satisfies Pick<PrismaService, '$queryRaw' | '$executeRaw'>;
        runtime = new StatisticsExchangeRuntimeService(
          transactionPrisma as PrismaService,
          config,
          statisticsMock as unknown as StatisticsExchangeStatisticsService,
          grantsMock as unknown as StatisticsExchangeGrantsService,
        );
        jest.spyOn(runtime, 'prune').mockResolvedValue(undefined);
        const work = runtime[method]();
        try {
          await Promise.race([started, work]);
          const calls = method === 'tick' ? pull.mock.calls : refreshRemoteAccess.mock.calls;
          expect(calls).toHaveLength(4);
          expect(new Set(calls.map(([id]) => id))).toEqual(
            new Set(before.slice(0, 4).map(({ id }) => id)),
          );
          const after = await tx.$queryRaw<Schedule[]>`
              SELECT id,next_pull_at,next_remote_access_at,lease_id,lease_until,last_attempt_at
              FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'} ORDER BY next_pull_at,id`;
          expect(after.slice(4)).toEqual(before.slice(4));
          for (const [index, row] of after.slice(0, 4).entries()) {
            const prior = before[index]!;
            expect(row.next_pull_at).toEqual(prior.next_pull_at);
            if (method === 'tick') {
              expect(row.next_remote_access_at).toEqual(prior.next_remote_access_at);
              expect(row.lease_id).toBe(pull.mock.calls[0]![2]!.leaseId);
              expect(row.lease_until!.getTime()).toBeGreaterThan(now);
              expect(row.last_attempt_at).toBeInstanceOf(Date);
            } else {
              expect(row.next_remote_access_at.getTime()).toBeGreaterThan(now);
              expect(row.lease_id).toEqual(prior.lease_id);
              expect(row.lease_until).toEqual(prior.lease_until);
              expect(row.last_attempt_at).toEqual(prior.last_attempt_at);
            }
          }
        } finally {
          release();
          await work;
        }
      });
    } finally {
      release();
      await runtime?.onModuleDestroy();
      clock.mockRestore();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'}`;
    }
  });

  it('keeps100actor rights and reverse work bounded and independent under archive latency', async () => {
    const seed = randomUUID(),
      previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    const prefix = actor + 'x';
    let releaseReverse!: () => void;
    const slowReverse = new Promise<void>((resolve) => {
      releaseReverse = resolve;
    });
    const refreshed = new Set<string>(),
      pulled = new Set<string>(),
      remoteChecked = new Set<string>();
    let remoteInFlight = 0,
      remoteMaximum = 0;
    const refreshRemoteAccess = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['refreshRemoteAccess']>,
      Parameters<StatisticsExchangeStatisticsService['refreshRemoteAccess']>
    >(async (id) => {
      remoteInFlight++;
      remoteMaximum = Math.max(remoteMaximum, remoteInFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      remoteChecked.add(id);
      remoteInFlight--;
    });
    let inFlight = 0,
      maximum = 0;
    const refresh = jest.fn<
      ReturnType<MarketplaceAccessService['refresh']>,
      Parameters<MarketplaceAccessService['refresh']>
    >(async (row) => {
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      refreshed.add(row.id);
      inFlight--;
    });
    const pull = jest.fn<
      ReturnType<StatisticsExchangeStatisticsService['pull']>,
      Parameters<StatisticsExchangeStatisticsService['pull']>
    >(async (id) => {
      pulled.add(id);
      if (pulled.size <= 4) await slowReverse;
      return {
        failures: 0,
        nextCursor: null,
        pending: false,
        completedEntities: 0,
        nextDelayMs: 300000,
        lastError: null,
      };
    });
    const recoverUnavailable = jest
      .fn<
        ReturnType<StatisticsExchangeGrantsService['recoverUnavailable']>,
        Parameters<StatisticsExchangeGrantsService['recoverUnavailable']>
      >()
      .mockResolvedValue(false);
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      { pull, refreshRemoteAccess } as unknown as StatisticsExchangeStatisticsService,
      { recoverUnavailable } as unknown as StatisticsExchangeGrantsService,
      { refresh } as unknown as MarketplaceAccessService,
    );
    try {
      await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,statistics_consent,next_access_at)
        SELECT md5(${seed}||'binding'||n)::uuid,${prefix}||n,'-'||n,'CHANNEL','moderation','synthetic-v2-bot','ACTIVE',now(),now()+interval '5 minutes','{}'::jsonb,true,now()-interval '1 minute' FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,input_hash)
        SELECT md5(${seed}||'grant'||n)::uuid,${prefix}||n,1,'ACTIVE','synthetic' FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO statistics_exchange_entities(grant_id,entity_id,kind,profile,binding_id)
        SELECT md5(${seed}||'grant'||n)::uuid,'-'||n,'CHANNEL','moderation',md5(${seed}||'binding'||n)::uuid FROM generate_series(1,100)n`;
      const stalled = runtime.tick();
      const start = Date.now();
      for (let batch = 0; batch < 5; batch++) await runtime.refreshAccessBatch();
      for (let batch = 0; batch < 25; batch++) await runtime.refreshRemoteAccessBatch();
      expect(remoteChecked.size).toBe(100);
      expect(remoteMaximum).toBe(4);
      expect(pulled.size).toBe(4);
      expect(refreshed.size).toBe(100);
      expect(maximum).toBe(1);
      expect(Date.now() - start).toBeLessThan(10_000);
      releaseReverse();
      await stalled;
      for (let batch = 0; batch < 24; batch++) await runtime.tick();
      expect(pulled.size).toBe(100);
      expect(refresh.mock.calls.every(([, exchangeV2]) => exchangeV2 === true)).toBe(true);
    } finally {
      releaseReverse();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id IN(SELECT id FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'})`;
      await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'}`;
      await db.$executeRaw`DELETE FROM marketplace_bindings WHERE actor_user_id LIKE ${prefix + '%'}`;
    }
  });

  it('serves100entity discovery and grant acknowledgement without synchronous MAX probes', async () => {
    const prefix = entityId + '9';
    try {
      await db.$executeRaw`INSERT INTO chats(id,title,entity_type,updated_at) SELECT ${prefix}||lpad(n::text,3,'0'),'Synthetic entity','CHANNEL',now() FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO chat_bot_memberships(id,chat_id,bot_id,status,updated_at) SELECT ${prefix}||lpad(n::text,3,'0'),${prefix}||lpad(n::text,3,'0'),'synthetic-v2-bot','ACTIVE',now() FROM generate_series(1,100)n`;
      await db.$executeRaw`INSERT INTO managed_entity_access_edges(chat_id,user_id,bot_id,state,user_role,bot_role,updated_at) SELECT ${prefix}||lpad(n::text,3,'0'),${actor},'synthetic-v2-bot','GRANTED','ADMIN','ADMIN',now() FROM generate_series(1,100)n`;
      const start = Date.now();
      const discovered = await grants.discover({ actorUserId: actor });
      expect(discovered.entities).toHaveLength(100);
      const result = await grants.put(grantId, {
        ...input(),
        entities: discovered.entities.map(({ entityId, kind, profile }) => ({
          entityId,
          kind,
          profile,
        })),
      });
      expect(result.entities).toHaveLength(100);
      expect(result.entities.every((entity) => entity.status === 'UNAVAILABLE')).toBe(true);
      expect(attest).not.toHaveBeenCalled();
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
      await db.chat.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });

  it('filters and prunes expired imported observations while retaining the producer fence', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    const expired = {
      ...page.rows[0]!,
      data: {
        ...page.rows[0]!.data,
        bucket: '2020-01-01T00:00:00.000Z',
        observedAt: '2020-01-01T00:00:00.000Z',
      },
    };
    await db.$executeRaw`UPDATE statistics_exchange_imports SET retention_checked_from='1970-01-01T00:00:00Z',rows=${JSON.stringify([expired, ...page.rows])}::jsonb WHERE grant_id=${grantId}::uuid`;
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience(actor, entityId, 'CHANNEL'),
    ).toHaveLength(1);
    const lease = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      statistics,
      grants,
    );
    await runtime.prune(grantId, lease);
    const current = await db.$queryRaw<
      Array<{ rows: ExchangeMeasurement[]; producer_revision: bigint }>
    >`SELECT rows,producer_revision FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
    expect(current[0]!.rows.every((row) => row.data.bucket >= exchangeRetentionFrom())).toBe(true);
    expect(current[0]!.producer_revision).toBe(1n);
  });

  it.each(['default', 'nested-rescan'] as const)(
    'does not let one denied recovery head starve another selected entity with %s planner',
    async (planner) => {
      const secondId = '-' + (BigInt(actor) + 1n).toString();
      await grants.put(grantId, {
        ...input(),
        entities: [
          { entityId, kind: 'CHANNEL', profile: 'moderation' },
          { entityId: secondId, kind: 'CHANNEL', profile: 'moderation' },
        ],
      });
      await db.$executeRaw`UPDATE statistics_exchange_entities SET binding_id=NULL WHERE grant_id=${grantId}::uuid`;
      attest.mockClear();
      attest
        .mockRejectedValueOnce(new Error('synthetic unavailable'))
        .mockRejectedValueOnce(new Error('synthetic unavailable'));
      type RecoverySchedule = { entity_id: string; kind: string; next_check_at: Date };
      await db.$transaction(async (tx) => {
        if (planner === 'nested-rescan') await useNestedRescanPlanner(tx);
        const transactionPrisma = {
          $queryRaw: tx.$queryRaw.bind(tx),
        } satisfies Pick<PrismaService, '$queryRaw'>;
        const recovering = new StatisticsExchangeGrantsService(
          transactionPrisma as PrismaService,
          config,
          { attest } as unknown as MarketplaceAccessService,
          state,
        );
        const before = await tx.$queryRaw<RecoverySchedule[]>`
          SELECT entity_id,kind,next_check_at FROM statistics_exchange_entities
          WHERE grant_id=${grantId}::uuid ORDER BY entity_id,kind`;
        expect(before).toHaveLength(2);
        await expect(recovering.recoverUnavailable(grantId)).rejects.toThrow(
          'synthetic unavailable',
        );
        expect(attest).toHaveBeenCalledTimes(1);
        const afterFirst = await tx.$queryRaw<RecoverySchedule[]>`
          SELECT entity_id,kind,next_check_at FROM statistics_exchange_entities
          WHERE grant_id=${grantId}::uuid ORDER BY entity_id,kind`;
        const changed = afterFirst.filter(
          (row, index) => row.next_check_at.getTime() !== before[index]!.next_check_at.getTime(),
        );
        expect(changed).toHaveLength(1);
        const attempted = (attest.mock.calls[0]![0] as { entityId: string }).entityId;
        expect(changed[0]!.entity_id).toBe(attempted);
        expect(afterFirst.filter((row) => row.entity_id !== attempted)).toEqual(
          before.filter((row) => row.entity_id !== attempted),
        );
        await expect(recovering.recoverUnavailable(grantId)).rejects.toThrow(
          'synthetic unavailable',
        );
        expect(attest).toHaveBeenCalledTimes(2);
        expect(
          new Set(attest.mock.calls.map(([raw]) => (raw as { entityId: string }).entityId)),
        ).toEqual(new Set(before.map((row) => row.entity_id)));
        const afterSecond = await tx.$queryRaw<RecoverySchedule[]>`
          SELECT entity_id,kind,next_check_at FROM statistics_exchange_entities
          WHERE grant_id=${grantId}::uuid ORDER BY entity_id,kind`;
        expect(
          afterSecond.filter(
            (row, index) => row.next_check_at.getTime() !== before[index]!.next_check_at.getTime(),
          ),
        ).toHaveLength(2);
      });
    },
  );
  it('refuses mismatched remote binding identity and generation publication after lease loss', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture();
    const remote = mockRemote({
      ...fixture,
      manifest: { ...fixture.manifest, bindingId: randomUUID() },
    });
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('EXCHANGE_IDENTITY_MISMATCH');
    const lease = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
    await forceDue();
    remote.mockImplementation(async (raw) => {
      if (String(raw).includes('/statistics?')) {
        await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=NULL,lease_until=NULL WHERE id=${grantId}::uuid`;
        return new Response(JSON.stringify(fixture));
      }
      return new Response(JSON.stringify(await grants.read(grantId)));
    });
    expect(
      await statistics.pull(grantId, 1, {
        leaseId: lease,
        afterEntityKey: null,
        maxEntities: 3,
        deadline: Date.now() + 10_000,
      }),
    ).toMatchObject({ failures: 1, nextCursor: null, completedEntities: 0 });
    expect(
      await db.$queryRaw`SELECT 1 FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
  });
  it('advances bounded cleanup past retained generations before deleting a superseded generation', async () => {
    const foreignGrantId = randomUUID();
    try {
      await grants.put(grantId, input());
      const lease = randomUUID();
      await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
      await db.$executeRaw`INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,input_hash)
        VALUES(${foreignGrantId}::uuid,${actor + '-cleanup-foreign'},1,'ACTIVE','synthetic')`;
      // FLAG: Older foreign history must not become an unbounded post-filter before LIMIT.
      await db.$executeRaw`INSERT INTO statistics_exchange_generations(id,grant_id,grant_revision,entity_id,kind,origin,producer_revision,manifest,rows,created_at)
        SELECT md5(${foreignGrantId}||n::text)::uuid,${foreignGrantId}::uuid,1,'-foreign-'||n::text,'CHANNEL','MAXIM',1,'{}'::jsonb,'[]'::jsonb,now()-interval '4 days'+n*interval '1 second' FROM generate_series(1,10000)n`;
      await db.$executeRaw`INSERT INTO statistics_exchange_generations(id,grant_id,grant_revision,entity_id,kind,origin,producer_revision,manifest,rows,created_at)
        SELECT md5(${grantId}||n::text)::uuid,${grantId}::uuid,1,'-'||n::text,'CHANNEL','MAXIM',1,'{}'::jsonb,'[]'::jsonb,now()-interval '2 days'+n*interval '1 second' FROM generate_series(1,1001)n`;
      const supersededId = (
        await db.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid AND entity_id='-1001'`
      )[0]!.id;
      await db.$executeRaw`INSERT INTO statistics_exchange_generations(id,grant_id,grant_revision,entity_id,kind,origin,producer_revision,manifest,rows)
        VALUES(${randomUUID()}::uuid,${grantId}::uuid,1,'-1001','CHANNEL','MAXIM',2,'{}'::jsonb,'[]'::jsonb)`;
      const visibilityBefore = await db.$queryRaw<
        Array<{ relpages: number; relallvisible: number }>
      >`
        SELECT relpages,relallvisible FROM pg_class WHERE oid='statistics_exchange_generations'::regclass`;
      // FLAG: Model aged immutable history; normalize visibility/dead entries left by other native fixtures.
      // The unvacuumed plan is a separate coverage limit, not a universally bounded optimizer guarantee.
      await db.$executeRaw`VACUUM (ANALYZE) statistics_exchange_generations`;
      const visibilityAfter = await db.$queryRaw<
        Array<{ relpages: number; relallvisible: number }>
      >`
        SELECT relpages,relallvisible FROM pg_class WHERE oid='statistics_exchange_generations'::regclass`;
      process.stdout.write(
        'statistics-cleanup-visibility ' +
          JSON.stringify({
            before: visibilityBefore[0],
            after: visibilityAfter[0],
          }) +
          '\n',
      );
      type PlanNode = {
        'Node Type': string;
        'Index Name'?: string;
        'Index Cond'?: string;
        'Actual Rows': number;
        'Actual Loops': number;
        'Rows Removed by Filter'?: number;
        'Heap Fetches'?: number;
        'Shared Hit Blocks': number;
        'Shared Read Blocks': number;
        Plans?: PlanNode[];
      };
      type QueryPlan = Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>;
      function assertBoundedPage(page: string, result: QueryPlan, cursorId?: string) {
        const root = result[0]!['QUERY PLAN'][0]!.Plan;
        const flatten = (node: PlanNode): PlanNode[] => [
          node,
          ...(node.Plans ?? []).flatMap(flatten),
        ];
        const nodes = flatten(root);
        const scans = nodes.filter((node) => /^Index (Only )?Scan$/.test(node['Node Type']));
        process.stdout.write(
          'statistics-cleanup-page-plan ' +
            JSON.stringify({
              page,
              scans: scans.map((node) => ({
                type: node['Node Type'],
                index: node['Index Name'],
                rows: node['Actual Rows'],
                loops: node['Actual Loops'],
                filtered: node['Rows Removed by Filter'] ?? 0,
                heapFetches: node['Heap Fetches'] ?? null,
              })),
              buffers: root['Shared Hit Blocks'] + root['Shared Read Blocks'],
            }) +
            '\n',
        );
        expect({
          page,
          unboundedNodes: nodes.filter((node) =>
            ['Seq Scan', 'Sort', 'Incremental Sort'].includes(node['Node Type']),
          ),
          scans: scans.map((node) => ({
            index: node['Index Name'],
            condition: node['Index Cond'],
            grantBound:
              node['Index Cond']?.includes('grant_id') && node['Index Cond'].includes(grantId),
            timeBound: node['Index Cond']?.includes('created_at'),
            cursorBound:
              !cursorId ||
              (node['Index Cond']?.includes('>') && node['Index Cond'].includes(cursorId)),
            rows: node['Actual Rows'],
            loops: node['Actual Loops'],
            filtered: node['Rows Removed by Filter'] ?? 0,
          })),
          buffers: root['Shared Hit Blocks'] + root['Shared Read Blocks'],
        }).toEqual({
          page,
          unboundedNodes: [],
          scans: [
            {
              index: expect.any(String),
              condition: expect.any(String),
              grantBound: true,
              timeBound: true,
              cursorBound: true,
              rows: 100,
              loops: 1,
              filtered: 0,
            },
          ],
          buffers: expect.any(Number),
        });
        expect({
          page,
          buffersBounded: root['Shared Hit Blocks'] + root['Shared Read Blocks'] <= 256,
        }).toEqual({ page, buffersBounded: true });
      }
      const firstPlan = await db.$queryRaw<QueryPlan>`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT id,created_at::text AS created_at FROM statistics_exchange_generations
        WHERE grant_id=${grantId}::uuid AND created_at<now()-interval '1 day'
        ORDER BY statistics_exchange_generations.created_at,statistics_exchange_generations.id LIMIT 100`;
      assertBoundedPage('first', firstPlan);
      const runtime = new StatisticsExchangeRuntimeService(
        db as PrismaService,
        config,
        statistics,
        grants,
      );
      await runtime.prune(grantId, lease);
      const cursor = (
        await db.$queryRaw<
          Array<{ created_at: string | null; id: string | null }>
        >`SELECT prune_after_created_at::text AS created_at,prune_after_id AS id
          FROM statistics_exchange_grants WHERE id=${grantId}::uuid`
      )[0]!;
      expect(cursor.created_at).not.toBeNull();
      expect(cursor.id).not.toBeNull();
      const cursorPlan = await db.$queryRaw<QueryPlan>`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT id,created_at::text AS created_at FROM statistics_exchange_generations
        WHERE grant_id=${grantId}::uuid AND created_at<now()-interval '1 day'
          AND (created_at,id)>(${cursor.created_at}::timestamptz,${cursor.id}::uuid)
        ORDER BY statistics_exchange_generations.created_at,statistics_exchange_generations.id LIMIT 100`;
      assertBoundedPage('cursor', cursorPlan, cursor.id!);
      for (let page = 0; page < 10; page++) await runtime.prune(grantId, lease);
      expect(
        await db.$queryRaw`SELECT 1 FROM statistics_exchange_generations WHERE id=${supersededId}::uuid`,
      ).toEqual([]);
      expect(
        (
          await db.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) AS count FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid`
        )[0]!.count,
      ).toBe(1001n);
    } finally {
      await db.$executeRaw`DELETE FROM statistics_exchange_generations WHERE grant_id=${foreignGrantId}::uuid`;
      await db.$executeRaw`DELETE FROM statistics_exchange_grants WHERE id=${foreignGrantId}::uuid`;
    }
  });
  it('reads only exact-actor imported audience without native generation writes and fences revocation', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    const generationsBefore = await db.statisticsExchangeGeneration.count();
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience('999999999', entityId, 'CHANNEL'),
    ).toEqual([]);
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience(actor, '-999999999', 'CHANNEL'),
    ).toEqual([]);
    expect(
      await new StatisticsExchangeAudienceService(
        db as PrismaService,
        config,
        state,
      ).importedAudience(actor, entityId, 'CHANNEL'),
    ).toEqual([{ capturedAt: expect.any(Date), participantsCount: 777 }]);
    expect(await db.statisticsExchangeGeneration.count()).toBe(generationsBefore);
    const original = state.hasActiveGrant.bind(state);
    jest.spyOn(state, 'hasActiveGrant').mockImplementationOnce(async (...args) => {
      await grants.put(grantId, input(2, 'REVOKED'));
      return original(...args);
    });
    await expect(
      new StatisticsExchangeAudienceService(db as PrismaService, config, state).importedAudience(
        actor,
        entityId,
        'CHANNEL',
      ),
    ).rejects.toThrow('Доступ изменился');
  });

  it('limits owner reads to the exact actor/entity and refuses a changed consent revision before returning a page', async () => {
    await grants.put(grantId, input());
    expect(await statistics.owner('999999999', entityId, 'CHANNEL')).toBeNull();
    expect(await statistics.owner(actor, '-999999999', 'CHANNEL')).toBeNull();
    expect((await statistics.owner(actor, entityId, 'CHANNEL'))!.entityId).toBe(entityId);
    const original = grants.binding.bind(grants);
    let calls = 0;
    jest.spyOn(grants, 'binding').mockImplementation(async (...args) => {
      calls++;
      if (calls === 2) await grants.put(grantId, input(2));
      return original(...args);
    });
    await expect(statistics.page(grantId, { entityId, kind: 'CHANNEL' })).rejects.toThrow(
      'Согласие изменилось',
    );
  });
  async function pagedFixture(count = 1600) {
    const own = await remoteFixture();
    const from = Date.parse(own.manifest.from);
    const rows: ExchangeMeasurement[] = Array.from({ length: count }, (_, i) =>
      exchangeMeasurementSchema.parse({
        origin: 'EXCHANGE',
        method: 'utc-buckets-v1',
        revision: 1,
        data: {
          metric: 'PUBLICATION_HOUR',
          bucket: new Date(from + i * 3600000).toISOString(),
          observedAt: new Date(from + i * 3600000).toISOString(),
          posts: 1,
          complete: true,
        },
      }),
    );
    return {
      rows,
      manifest: exchangeManifestSchema.parse({
        ...own.manifest,
        generationId: randomUUID(),
        bindingId,
        origin: 'EXCHANGE',
        producerRevision: 1,
        rowCount: rows.length,
        sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        metrics: own.manifest.metrics.map((m) => ({ ...m, metric: 'PUBLICATION_HOUR' })),
      }),
    };
  }
  async function grantLease() {
    const leaseId = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${leaseId}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
    return leaseId;
  }
  async function forceDue() {
    await db.$executeRaw`UPDATE statistics_exchange_entities SET next_stats_at=now()-interval '1 second' WHERE grant_id=${grantId}::uuid`;
  }
  function pageRemote(
    fixture: Awaited<ReturnType<typeof pagedFixture>>,
    onPage?: (offset: number) => Promise<void>,
  ) {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
      const url = new URL(String(raw));
      if (!url.pathname.endsWith('/statistics'))
        return new Response(JSON.stringify(await grants.read(grantId)));
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      if (offset > 0)
        expect(url.searchParams.get('generationId')).toBe(fixture.manifest.generationId);
      await onPage?.(offset);
      return new Response(
        JSON.stringify({
          manifest: fixture.manifest,
          rows: fixture.rows.slice(offset, offset + 200),
          nextCursor: offset + 200 < fixture.rows.length ? String(offset + 200) : null,
        }),
      );
    });
  }
  it.each([700, 1500])(
    'persists original page order through bounded visits with %sms latency and a fresh service instance',
    async (latency) => {
      await grants.put(grantId, input());
      const fixture = await pagedFixture(2000);
      const own = fixture;
      const days = Array.from({ length: 89 }, (_, i) =>
        new Date(Date.parse(own.manifest.from) + i * 86400000).toISOString(),
      );
      for (const day of days) {
        fixture.rows.push(
          exchangeMeasurementSchema.parse({
            origin: 'EXCHANGE',
            method: 'utc-buckets-v1',
            revision: 1,
            data: { metric: 'AUDIENCE', bucket: day, observedAt: day, value: 100 },
          }),
        );
        fixture.rows.push(
          exchangeMeasurementSchema.parse({
            origin: 'EXCHANGE',
            method: 'utc-buckets-v1',
            revision: 1,
            data: {
              metric: 'MEMBERSHIP',
              bucket: day,
              observedAt: day,
              joined: 0,
              left: 0,
              complete: true,
            },
          }),
        );
        for (const horizon of [0, 24, 48])
          fixture.rows.push(
            exchangeMeasurementSchema.parse({
              origin: 'EXCHANGE',
              method: 'utc-buckets-v1',
              revision: 1,
              data: {
                metric: 'REACH',
                bucket: day,
                observedAt: day,
                horizon,
                posts: 0,
                samples: 0,
                views: 0,
                incomplete: false,
                maxDelaySeconds: null,
              },
            }),
          );
      }
      // 2445 distinct rows span 89 retained days and still require thirteen pages.
      fixture.rows.reverse();
      fixture.manifest = exchangeManifestSchema.parse({
        ...fixture.manifest,
        metrics: (['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR'] as const).map(
          (metric) => ({ ...own.manifest.metrics[0]!, metric }),
        ),
        rowCount: fixture.rows.length,
        sha256: createHash('sha256').update(JSON.stringify(fixture.rows)).digest('hex'),
      });
      let clock = Date.now(),
        requests = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      pageRemote(fixture, async () => {
        requests++;
        clock += latency;
      });
      const leaseId = await grantLease();
      const options = () => ({
        leaseId,
        afterEntityKey: null,
        maxEntities: 3,
        deadline: clock + 10000,
      });
      for (let page = 0; page < 13; page++) {
        await forceDue();
        const instance = new StatisticsExchangeStatisticsService(
          db as PrismaService,
          config,
          grants,
          new MarketplaceStatisticsService(db as PrismaService, state),
        );
        const result = await instance.pull(grantId, 1, options());
        expect(requests).toBe(page + 1);
        expect(result.completedEntities).toBe(page === 12 ? 1 : 0);
        const imported = await db.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) AS count FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
        expect(imported[0]!.count).toBe(page === 12 ? 1n : 0n);
        const health = await db.$queryRaw<
          Array<{
            last_stats_at: Date | null;
            stats_phase_health: Record<string, { successAt?: string }>;
          }>
        >`
        SELECT last_stats_at,stats_phase_health FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
        expect(health[0]!.last_stats_at === null).toBe(page !== 12);
        expect(health[0]!.stats_phase_health.PAGE?.successAt).toBeTruthy();
        clock += 1500;
      }
      expect(
        await db.$queryRaw`SELECT id FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`,
      ).toEqual([]);
      const saved = await db.$queryRaw<
        Array<{ rows: ExchangeMeasurement[] }>
      >`SELECT rows FROM statistics_exchange_generations WHERE id=${fixture.manifest.generationId}::uuid`;
      expect(saved[0]!.rows.map((row) => exchangeMeasurementSchema.parse(row))).toEqual(
        fixture.rows,
      );
    },
  );
  it('resumes page eight after interruption without exposing the first seven pages', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture();
    let blocked = true;
    const requests: number[] = [];
    pageRemote(fixture, async (offset) => {
      requests.push(offset);
      if (offset === 1400 && blocked) throw new TypeError('synthetic transport failure');
    });
    for (let i = 0; i < 7; i++) await statistics.pull(grantId, 1);
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('synthetic transport failure');
    const staged = await db.$queryRaw<
      Array<{ page_count: number; next_cursor: string }>
    >`SELECT page_count,next_cursor FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`;
    expect(staged[0]).toMatchObject({ page_count: 7, next_cursor: '1400' });
    expect(
      await db.$queryRaw`SELECT grant_id FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
    blocked = false;
    const replacement = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      new MarketplaceStatisticsService(db as PrismaService, state),
    );
    expect((await replacement.pull(grantId, 1)).completedEntities).toBe(1);
    expect(requests).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1400]);
  });
  it('rejects an expired immutable export while peer fixtures retain midnight headroom', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture();
    const cutoff = Date.parse(exchangeRetentionFrom());
    expect(Date.parse(fixture.manifest.from)).toBeGreaterThan(cutoff);
    const native = await nativeAll();
    const expiredFrom = new Date(cutoff - 86400_000).toISOString();
    await db.$executeRaw`UPDATE statistics_exchange_generations
      SET manifest=jsonb_set(manifest,'{from}',to_jsonb(${expiredFrom}::text))
      WHERE id=${native.manifest.generationId}::uuid`;
    await expect(
      statistics.page(grantId, {
        entityId,
        kind: 'CHANNEL',
        generationId: native.manifest.generationId,
      }),
    ).rejects.toThrow('Выгрузка вышла за срок хранения');
  });
  it('keeps READY durable across a deadline yield and finalizes with zero additional page reads', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture(1);
    let clock = Date.now(),
      pages = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    pageRemote(fixture, async () => {
      pages++;
      clock += 9500;
    });
    const leaseId = await grantLease();
    expect(
      (
        await statistics.pull(grantId, 1, {
          leaseId,
          afterEntityKey: null,
          maxEntities: 3,
          deadline: clock + 10000,
        })
      ).completedEntities,
    ).toBe(0);
    expect(
      (
        await db.$queryRaw<
          Array<{ state: string }>
        >`SELECT state FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`
      )[0]!.state,
    ).toBe('READY');
    await forceDue();
    expect(
      (
        await statistics.pull(grantId, 1, {
          leaseId,
          afterEntityKey: null,
          maxEntities: 3,
          deadline: clock + 10000,
        })
      ).completedEntities,
    ).toBe(1);
    expect(pages).toBe(1);
  });
  it('makes page replay idempotent, supports the v2 Unicode cursor and rejects an obsolete session lease', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture(2);
    mockRemote({ manifest: fixture.manifest, rows: fixture.rows, nextCursor: null });
    await statistics.refreshRemoteAccess(grantId, 1);
    const downloads = new StatisticsExchangeDownloadsService(db as PrismaService),
      owner = randomUUID();
    const scope = {
      grantId,
      grantRevision: 1,
      entityId,
      kind: 'CHANNEL' as const,
      localBindingId: bindingId,
      remoteBindingId: bindingId,
    };
    expect(await downloads.claim(scope, owner)).toBeNull();
    const page = {
      manifest: fixture.manifest,
      rows: fixture.rows.slice(0, 1),
      nextCursor: 'я'.repeat(1500),
    };
    const first = await downloads.append(scope, owner, null, page);
    const replay = await downloads.append(scope, owner, null, page);
    expect(replay.page_count).toBe(1);
    expect(replay.received_rows).toBe(1);
    await expect(
      downloads.append(scope, owner, null, { ...page, nextCursor: 'different' }),
    ).rejects.toThrow('EXCHANGE_PAGE_CONFLICT');
    await db.$executeRaw`UPDATE statistics_exchange_downloads SET lease_until=now()-interval '1 second' WHERE id=${first.id}::uuid`;
    const nextOwner = randomUUID(),
      claimed = (await downloads.claim(scope, nextOwner))!;
    await expect(
      downloads.append(scope, owner, first, {
        manifest: fixture.manifest,
        rows: fixture.rows.slice(1),
        nextCursor: null,
      }),
    ).rejects.toThrow('EXCHANGE_DOWNLOAD_CHANGED');
    const ready = await downloads.append(scope, nextOwner, claimed, {
      manifest: fixture.manifest,
      rows: fixture.rows.slice(1),
      nextCursor: null,
    });
    expect((await downloads.assemble(ready)).rows).toEqual(fixture.rows);
    expect(
      (
        await db.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) AS count FROM statistics_exchange_download_pages WHERE download_id=${first.id}::uuid`
      )[0]!.count,
    ).toBe(2n);
  });
  it('refuses the final READY activation when revocation races the final peer proof', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture(1);
    let grantsRead = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
      if (String(raw).includes('/statistics?'))
        return new Response(
          JSON.stringify({ manifest: fixture.manifest, rows: fixture.rows, nextCursor: null }),
        );
      grantsRead++;
      const proof = await grants.read(grantId);
      if (grantsRead === 2) await grants.put(grantId, input(2, 'REVOKED'));
      return new Response(JSON.stringify(proof));
    });
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('Согласие');
    expect(
      await db.$queryRaw`SELECT grant_id FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
    expect(
      await db.$queryRaw`SELECT id FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
  });
  it('preserves VERIFIED phase failures through page-only progress and keeps import success unchanged', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture(400);
    pageRemote(fixture);
    await db.$executeRaw`UPDATE statistics_exchange_entities SET stats_error='CHECKSUM_MISMATCH',stats_error_phase='VERIFY',
      stats_phase_health='{"VERIFY":{"failureAt":"2026-10-01T00:00:00.000Z","error":"CHECKSUM_MISMATCH"}}'::jsonb WHERE grant_id=${grantId}::uuid`;
    const result = await statistics.pull(grantId, 1);
    expect(result.lastError).toMatchObject({ code: 'CHECKSUM_MISMATCH', phase: 'VERIFY' });
    const row = (
      await db.$queryRaw<
        Array<{
          last_stats_at: Date | null;
          stats_error: string;
          stats_phase_health: Record<string, unknown>;
        }>
      >`
      SELECT last_stats_at,stats_error,stats_phase_health FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`
    )[0]!;
    expect(row.last_stats_at).toBeNull();
    expect(row.stats_error).toBe('CHECKSUM_MISMATCH');
    expect(row.stats_phase_health).toHaveProperty('PAGE.successAt');
    expect(row.stats_phase_health).toHaveProperty('VERIFY.failureAt');
  });
  it('continues an active import when unavailable binding recovery throws and records the separate recovery phase', async () => {
    await grants.put(grantId, input());
    const fixture = await remoteFixture();
    mockRemote(fixture);
    const leaseId = await grantLease();
    const grant = (await grants.row(grantId))!;
    const recoverUnavailable = jest
      .fn<
        ReturnType<StatisticsExchangeGrantsService['recoverUnavailable']>,
        Parameters<StatisticsExchangeGrantsService['recoverUnavailable']>
      >()
      .mockRejectedValue(new TypeError('private synthetic network body'));
    const runtime = new StatisticsExchangeRuntimeService(db as PrismaService, config, statistics, {
      recoverUnavailable,
    } as unknown as StatisticsExchangeGrantsService);
    await (
      runtime as unknown as {
        pullGrant(
          value: StatisticsExchangeGrantRow,
          lease: string,
          deadline: number,
        ): Promise<void>;
      }
    ).pullGrant(grant, leaseId, Date.now() + 10000);
    const saved = (
      await db.$queryRaw<
        Array<{ last_pull_at: Date | null; last_error: string; last_error_phase: string }>
      >`
      SELECT last_pull_at,last_error,last_error_phase FROM statistics_exchange_grants WHERE id=${grantId}::uuid`
    )[0]!;
    expect(saved.last_pull_at).toBeInstanceOf(Date);
    expect(saved.last_error).toBe('TRANSPORT');
    expect(saved.last_error_phase).toBe('RECOVERY');
    expect(
      await db.$queryRaw`SELECT grant_id FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`,
    ).toHaveLength(1);
  });
  it('preserves seven committed pages when the parent lease expires during page eight, then resumes under a new lease', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture();
    let expire = true;
    const requests: number[] = [];
    pageRemote(fixture, async (offset) => {
      requests.push(offset);
      if (offset === 1400 && expire)
        await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_until=now()-interval '1 second' WHERE id=${grantId}::uuid`;
    });
    for (let i = 0; i < 7; i++) await statistics.pull(grantId, 1);
    let leaseId = await grantLease();
    await forceDue();
    const failed = await statistics.pull(grantId, 1, {
      leaseId,
      afterEntityKey: null,
      maxEntities: 3,
      deadline: Date.now() + 10000,
    });
    expect(failed).toMatchObject({ failures: 1, completedEntities: 0 });
    expect(
      (
        await db.$queryRaw<
          Array<{ page_count: number }>
        >`SELECT page_count FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`
      )[0]!.page_count,
    ).toBe(7);
    expire = false;
    leaseId = await grantLease();
    await forceDue();
    expect(
      (
        await statistics.pull(grantId, 1, {
          leaseId,
          afterEntityKey: null,
          maxEntities: 3,
          deadline: Date.now() + 10000,
        })
      ).completedEntities,
    ).toBe(1);
    expect(requests).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1400]);
  });
  it('rejects checksum corruption on page eight and retains the previously verified import', async () => {
    await grants.put(grantId, input());
    const previous = await remoteFixture(),
      remote = mockRemote(previous);
    await statistics.pull(grantId, 1);
    const fixture = await pagedFixture();
    fixture.rows = fixture.rows.map((row) => ({ ...row, revision: 2 }));
    fixture.manifest = { ...fixture.manifest, producerRevision: 2, sha256: '0'.repeat(64) };
    remote.mockRestore();
    pageRemote(fixture);
    for (let i = 0; i < 7; i++) await statistics.pull(grantId, 1);
    await expect(statistics.pull(grantId, 1)).rejects.toThrow('EXCHANGE_CHECKSUM_MISMATCH');
    const saved = (
      await db.$queryRaw<
        Array<{ rows: ExchangeMeasurement[] }>
      >`SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
    )[0]!;
    expect(saved.rows).toEqual(previous.rows);
    expect(
      await db.$queryRaw`SELECT id FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
  });
  it('rejects revocation in page eight without publishing a partial generation', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture();
    pageRemote(fixture, async (offset) => {
      if (offset === 1400) await grants.put(grantId, input(2, 'REVOKED'));
    });
    for (let i = 0; i < 7; i++) await statistics.pull(grantId, 1);
    await expect(statistics.pull(grantId, 1)).rejects.toThrow(
      'EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED',
    );
    expect(
      await db.$queryRaw`SELECT id FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
    expect(
      await db.$queryRaw`SELECT grant_id FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`,
    ).toEqual([]);
  });
  it('honors a shared credential cooldown across service instances and authority/page lanes without renewing permission', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    const remote = mockRemote(page);
    await statistics.refreshRemoteAccess(grantId, 1);
    const before = (
      await db.$queryRaw<
        Array<{ remote_valid_until: Date }>
      >`SELECT remote_valid_until FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`
    )[0]!.remote_valid_until;
    remote.mockImplementation(
      async () =>
        new Response('private remote body', { status: 429, headers: { 'retry-after': '120' } }),
    );
    const first = statistics as unknown as { remote(path: string): Promise<unknown> };
    await expect(
      first.remote(`/grants/${grantId}/statistics?entityId=${entityId}&kind=CHANNEL`),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
    const calls = remote.mock.calls.length;
    const replacement = new StatisticsExchangeStatisticsService(
      db as PrismaService,
      config,
      grants,
      new MarketplaceStatisticsService(db as PrismaService, state),
    );
    await expect(replacement.refreshRemoteAccess(grantId, 1)).rejects.toMatchObject({
      status: 429,
    });
    await expect(
      first.remote(`/grants/${grantId}/statistics?entityId=${entityId}&kind=CHANNEL`),
    ).rejects.toMatchObject({ status: 429 });
    expect(remote.mock.calls).toHaveLength(calls);
    const after = (
      await db.$queryRaw<
        Array<{ remote_valid_until: Date }>
      >`SELECT remote_valid_until FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`
    )[0]!.remote_valid_until;
    expect(after).toEqual(before);
    const limit = (
      await db.$queryRaw<
        Array<{ peer_key: string; next_request_at: Date }>
      >`SELECT peer_key,next_request_at FROM statistics_exchange_peer_limits`
    )[0]!;
    expect(limit.peer_key).toMatch(/^EXCHANGE:[a-f0-9]{64}$/u);
    expect(limit.peer_key).not.toContain('c'.repeat(64));
    await db.$executeRaw`UPDATE statistics_exchange_peer_limits SET next_request_at=now()-interval '1 second'`;
    remote.mockImplementation(async () => new Response(JSON.stringify(await grants.read(grantId))));
    await replacement.refreshRemoteAccess(grantId, 1);
  });
  it('rotates one slow two-page entity fairly among one hundred entities and eventually returns to its durable cursor', async () => {
    const others = Array.from({ length: 99 }, (_, i) => ({
      id: '-' + (BigInt(actor) + BigInt(i) + 1n).toString(),
      bindingId: randomUUID(),
    }));
    const bindingFor = new Map([
      [entityId, bindingId],
      ...others.map((v) => [v.id, v.bindingId] as [string, string]),
    ]);
    try {
      await db.chat.createMany({
        data: others.map((v) => ({
          id: v.id,
          title: 'Synthetic fair statistics channel',
          entityType: 'CHANNEL' as const,
        })),
      });
      await db.chatBotMembership.createMany({
        data: others.map((v) => ({
          chatId: v.id,
          botId: 'synthetic-v2-bot',
          status: 'ACTIVE' as const,
          botAccessState: 'CONFIRMED_ADMIN' as const,
        })),
      });
      for (const other of others)
        await db.$executeRaw`INSERT INTO marketplace_bindings(id,actor_user_id,entity_id,kind,profile,bot_id,state,checked_at,valid_until,metadata,history_complete,history_from,history_to)
        SELECT ${other.bindingId}::uuid,actor_user_id,${other.id},kind,profile,bot_id,state,checked_at,valid_until,metadata,history_complete,history_from,history_to FROM marketplace_bindings WHERE id=${bindingId}::uuid`;
      attest.mockImplementation(async (raw) => {
        const id = bindingFor.get((raw as { entityId: string }).entityId);
        const binding = id ? await state.read(id) : null;
        if (!binding) throw new Error('Synthetic fair binding absent');
        return binding;
      });
      await grants.put(grantId, {
        ...input(),
        entities: [...bindingFor.keys()].map((id) => ({
          entityId: id,
          kind: 'CHANNEL',
          profile: 'moderation',
        })),
      });
      const proof = await grants.read(grantId),
        fixture = await pagedFixture(400),
        single = await remoteFixture();
      const generations = new Map([...bindingFor.keys()].map((id) => [id, randomUUID()]));
      const counts = new Map<string, number>();
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
        const url = new URL(String(raw));
        if (!url.pathname.endsWith('/statistics')) return new Response(JSON.stringify(proof));
        const id = url.searchParams.get('entityId')!,
          offset = Number(url.searchParams.get('cursor') ?? 0);
        counts.set(id, (counts.get(id) ?? 0) + 1);
        const rows = id === entityId ? fixture.rows : single.rows;
        const base = id === entityId ? fixture.manifest : single.manifest;
        const manifest = {
          ...base,
          entityId: id,
          bindingId: bindingFor.get(id),
          generationId: generations.get(id),
        };
        return new Response(
          JSON.stringify({
            manifest,
            rows: rows.slice(offset, offset + 200),
            nextCursor: offset + 200 < rows.length ? String(offset + 200) : null,
          }),
        );
      });
      const leaseId = await grantLease();
      let cursor: string | null = null,
        total = 0;
      for (let visit = 0; visit < 40 && total < 100; visit++) {
        await db.$executeRaw`UPDATE statistics_exchange_entities SET next_stats_at=now()-interval '1 second' WHERE grant_id=${grantId}::uuid AND last_stats_at IS NULL`;
        const result = await statistics.pull(grantId, 1, {
          leaseId,
          afterEntityKey: cursor,
          maxEntities: 3,
          deadline: Date.now() + 10000,
        });
        cursor = result.nextCursor;
        total += result.completedEntities;
        if (visit === 0) expect(counts.size).toBe(3);
      }
      expect(total).toBe(100);
      expect(counts.size).toBe(100);
      expect(counts.get(entityId)).toBe(2);
      expect([...counts].filter(([id]) => id !== entityId).every(([, count]) => count === 1)).toBe(
        true,
      );
      expect(
        (
          await db.$queryRaw<
            Array<{ count: bigint }>
          >`SELECT count(*) AS count FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
        )[0]!.count,
      ).toBe(100n);
    } finally {
      await db.$executeRaw`DELETE FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`;
      await db.$executeRaw`DELETE FROM statistics_exchange_generations WHERE grant_id=${grantId}::uuid`;
      await db.$executeRaw`DELETE FROM statistics_exchange_entities WHERE grant_id=${grantId}::uuid`;
      for (const other of others) {
        await db.$executeRaw`DELETE FROM marketplace_statistics_generations WHERE binding_id=${other.bindingId}::uuid`;
        await db.$executeRaw`DELETE FROM marketplace_bindings WHERE id=${other.bindingId}::uuid`;
      }
      await db.chat.deleteMany({ where: { id: { in: others.map((v) => v.id) } } });
    }
  }, 120000);
  it('records page-only runtime progress without advancing the completed-import timestamp', async () => {
    await grants.put(grantId, input());
    pageRemote(await pagedFixture(400));
    const leaseId = await grantLease(),
      grant = (await grants.row(grantId))!;
    const recoverUnavailable = jest
      .fn<
        ReturnType<StatisticsExchangeGrantsService['recoverUnavailable']>,
        Parameters<StatisticsExchangeGrantsService['recoverUnavailable']>
      >()
      .mockResolvedValue(false);
    const runtime = new StatisticsExchangeRuntimeService(db as PrismaService, config, statistics, {
      recoverUnavailable,
    } as unknown as StatisticsExchangeGrantsService);
    await (
      runtime as unknown as {
        pullGrant(
          value: StatisticsExchangeGrantRow,
          lease: string,
          deadline: number,
        ): Promise<void>;
      }
    ).pullGrant(grant, leaseId, Date.now() + 10000);
    const saved = (
      await db.$queryRaw<
        Array<{ last_pull_at: Date | null; last_error: string | null }>
      >`SELECT last_pull_at,last_error FROM statistics_exchange_grants WHERE id=${grantId}::uuid`
    )[0]!;
    expect(saved.last_pull_at).toBeNull();
    expect(saved.last_error).toBeNull();
    const page = (
      await db.$queryRaw<
        Array<{ page_count: number; last_page_at: Date }>
      >`SELECT page_count,last_page_at FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`
    )[0]!;
    expect(page.page_count).toBe(1);
    expect(page.last_page_at).toBeInstanceOf(Date);
  });
  it('preserves an empty opaque cursor in the next request', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture(2),
      offsets: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (raw) => {
      const url = new URL(String(raw));
      if (!url.pathname.endsWith('/statistics'))
        return new Response(JSON.stringify(await grants.read(grantId)));
      const second = url.searchParams.has('cursor');
      offsets.push(second ? url.searchParams.get('cursor')! : 'INITIAL');
      return new Response(
        JSON.stringify({
          manifest: fixture.manifest,
          rows: fixture.rows.slice(second ? 1 : 0, second ? 2 : 1),
          nextCursor: second ? null : '',
        }),
      );
    });
    expect((await statistics.pull(grantId, 1)).completedEntities).toBe(0);
    expect((await statistics.pull(grantId, 1)).completedEntities).toBe(1);
    expect(offsets).toEqual(['INITIAL', '']);
  });
  it('serializes racing initial page commits and never extends a staged generation hard expiry', async () => {
    await grants.put(grantId, input());
    const fixture = await pagedFixture(400);
    pageRemote(fixture);
    await statistics.refreshRemoteAccess(grantId, 1);
    const downloads = new StatisticsExchangeDownloadsService(db as PrismaService);
    const scope = {
      grantId,
      grantRevision: 1,
      entityId,
      kind: 'CHANNEL' as const,
      localBindingId: bindingId,
      remoteBindingId: bindingId,
    };
    const page = {
      manifest: fixture.manifest,
      rows: fixture.rows.slice(0, 200),
      nextCursor: '200',
    };
    const owner = randomUUID(),
      otherOwner = randomUUID();
    const race = await Promise.allSettled([
      downloads.append(scope, owner, null, page),
      downloads.append(scope, otherOwner, null, page),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const first = (
      await db.$queryRaw<
        Array<{ id: string; expires_at: Date; lease_id: string }>
      >`SELECT id,expires_at,lease_id FROM statistics_exchange_downloads WHERE grant_id=${grantId}::uuid`
    )[0]!;
    await downloads.release(scope, first.id, first.lease_id);
    const claimed = (await downloads.claim(scope, randomUUID()))!;
    expect(claimed.expires_at).toEqual(first.expires_at);
    await db.$executeRaw`UPDATE statistics_exchange_downloads SET expires_at=now()-interval '1 second' WHERE id=${first.id}::uuid`;
    expect(await downloads.claim(scope, randomUUID())).toBeNull();
    expect(
      await db.$queryRaw`SELECT download_id FROM statistics_exchange_download_pages WHERE download_id=${first.id}::uuid`,
    ).toEqual([]);
  });
  it('bounds the expiry selector on a skewed retained staging history with a real PostgreSQL plan', async () => {
    const prefix = 'stats-staging-plan-' + randomUUID();
    const fixtureRollback = new Error('Discard local statistics staging plan fixture');
    try {
      // FLAG: Keep all 10,000 real plan rows local to this transaction. Parent cleanup
      // can exhaust its SQL budget and leak retained history into unrelated native suites.
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO statistics_exchange_grants(id,actor_user_id,revision,state,input_hash)
            SELECT md5(${prefix}||n::text)::uuid,${prefix}||n::text,1,'ACTIVE','synthetic' FROM generate_series(1,10000)n`;
          await tx.$executeRaw`INSERT INTO statistics_exchange_entities(grant_id,entity_id,kind,profile)
            SELECT md5(${prefix}||n::text)::uuid,'-'||n::text,'CHANNEL','moderation' FROM generate_series(1,10000)n`;
          await tx.$executeRaw`INSERT INTO statistics_exchange_downloads(id,grant_id,grant_revision,entity_id,kind,local_binding_id,remote_binding_id,generation_id,producer_revision,manifest,expires_at)
            SELECT md5(${prefix}||'download'||n)::uuid,md5(${prefix}||n::text)::uuid,1,'-'||n::text,'CHANNEL',${bindingId}::uuid,${bindingId}::uuid,
              md5(${prefix}||'generation'||n)::uuid,1,'{}'::jsonb,now()+CASE WHEN n<=150 THEN -interval '1 minute' ELSE interval '1 day' END
            FROM generate_series(1,10000)n`;
          await tx.$executeRaw`ANALYZE statistics_exchange_downloads`;
          const plan = await tx.$queryRaw<
            Array<{ 'QUERY PLAN': unknown }>
          >`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
            SELECT id FROM statistics_exchange_downloads WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 100`;
          const evidence = JSON.stringify(plan);
          expect(evidence).toContain('statistics_exchange_downloads_expiry_idx');
          expect(evidence).not.toContain('"Node Type":"Sort"');
          expect(
            await tx.$queryRaw<
              Array<{ id: string }>
            >`SELECT id FROM statistics_exchange_downloads WHERE expires_at<=now() ORDER BY expires_at,id LIMIT 100`,
          ).toHaveLength(100);
          throw fixtureRollback;
        },
        { timeout: 20_000 },
      );
    } catch (error) {
      if (error !== fixtureRollback) throw error;
    } finally {
      await db.$executeRaw`ANALYZE statistics_exchange_downloads`;
    }
    expect(
      await db.$queryRaw`SELECT id FROM statistics_exchange_grants WHERE actor_user_id LIKE ${prefix + '%'}`,
    ).toEqual([]);
  });
  it('retains the measurement payload across repeated same-day retention visits', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    const lease = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes' WHERE id=${grantId}::uuid`;
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      statistics,
      grants,
    );
    await runtime.prune(grantId, lease);
    const before = (
      await db.$queryRaw<
        Array<{ xmin: string; rows: unknown }>
      >`SELECT xmin::text AS xmin,rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
    )[0]!;
    await runtime.prune(grantId, lease);
    const after = (
      await db.$queryRaw<
        Array<{ xmin: string; rows: unknown }>
      >`SELECT xmin::text AS xmin,rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid`
    )[0]!;
    process.stderr.write(
      'retention-rewrite-measurement ' +
        JSON.stringify({
          rewritten: after.xmin !== before.xmin,
          equalPayload: JSON.stringify(after.rows) === JSON.stringify(before.rows),
        }) +
        '\n',
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.xmin).toBe(before.xmin);
  });

  it('bounds indexed retention work to fifty stale projections and resumes without changing producer proof', async () => {
    await grants.put(grantId, input());
    const page = await remoteFixture();
    mockRemote(page);
    await statistics.pull(grantId, 1);
    const expired: ExchangeMeasurement = {
      ...page.rows[0]!,
      data: {
        ...page.rows[0]!.data,
        metric: 'AUDIENCE',
        value: 55,
        bucket: '2020-01-01T00:00:00.000Z',
        observedAt: '2020-01-01T00:00:00.000Z',
      },
    };
    const payload = JSON.stringify([expired, ...page.rows]);
    await db.$executeRaw`INSERT INTO statistics_exchange_imports(grant_id,grant_revision,entity_id,kind,producer_revision,manifest,rows,remote_valid_until)
      SELECT ${grantId}::uuid,1,'-7000000000'||n::text,'CHANNEL',1,jsonb_set(${JSON.stringify(page.manifest)}::jsonb,'{entityId}',to_jsonb('-7000000000'||n::text)),${payload}::jsonb,now()+interval '5 minutes' FROM generate_series(1,10000) n`;
    await db.$executeRaw`ANALYZE statistics_exchange_imports`;
    const cutoff = new Date(exchangeRetentionFrom());
    const plan = await db.$queryRaw<
      Array<{ 'QUERY PLAN': unknown }>
    >`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT entity_id,kind FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid AND grant_revision=1 AND retention_checked_from<${cutoff} ORDER BY retention_checked_from,entity_id,kind LIMIT 50 FOR UPDATE SKIP LOCKED`;
    expect(JSON.stringify(plan)).toContain('statistics_exchange_imports_retention_idx');
    expect(JSON.stringify(plan)).not.toContain('"Node Type":"Sort"');
    const lease = randomUUID();
    await db.$executeRaw`UPDATE statistics_exchange_grants SET lease_id=${lease}::uuid,lease_until=now()+interval '2 minutes',next_import_prune_at=now() WHERE id=${grantId}::uuid`;
    const runtime = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      statistics,
      grants,
    );
    await runtime.prune(grantId, lease);
    const progress = async () =>
      (
        await db.$queryRaw<
          Array<{ n: bigint; invalid: bigint }>
        >`SELECT count(*) FILTER(WHERE retention_checked_from>=${cutoff}) AS n,count(*) FILTER(WHERE producer_revision<>1 OR manifest->>'sha256'<>${page.manifest.sha256}) AS invalid FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid AND entity_id<>${entityId}`
      )[0]!;
    expect(await progress()).toEqual({ n: 50n, invalid: 0n });
    await db.$executeRaw`UPDATE statistics_exchange_grants SET next_import_prune_at=now() WHERE id=${grantId}::uuid`;
    const restarted = new StatisticsExchangeRuntimeService(
      db as PrismaService,
      config,
      statistics,
      grants,
    );
    await restarted.prune(grantId, lease);
    expect(await progress()).toEqual({ n: 100n, invalid: 0n });
    const changed = await db.$queryRaw<
      Array<{ rows: ExchangeMeasurement[] }>
    >`SELECT rows FROM statistics_exchange_imports WHERE grant_id=${grantId}::uuid AND entity_id<>${entityId} AND retention_checked_from>=${cutoff} LIMIT 1`;
    expect(changed[0]!.rows).toEqual(page.rows);
  });
});
