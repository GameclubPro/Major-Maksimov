import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash } from 'node:crypto';
import type { SafetyDeskOverviewResponse } from '@maxim/contracts/safety-desk';
import { RuntimeOverviewReaderController } from './runtime-overview-reader.controller';
import { RuntimeOverviewReaderGuard } from './runtime-overview-reader.guard';
import { SafetyDeskOverviewService } from './safety-desk-overview.service';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';
import { SafetyDeskController } from './safety-desk.controller';
import { SafetyDeskService } from './safety-desk.service';
import { SupportRequestsController } from './support-requests.controller';
import { SupportRequestsService } from './support-requests.service';

describe('restricted runtime overview reader HTTP route', () => {
  const originalRole = process.env.APP_ROLE;
  let app: NestFastifyApplication;
  const getObserverSnapshot = jest.fn<
    ReturnType<SafetyDeskOverviewService['getObserverSnapshot']>,
    Parameters<SafetyDeskOverviewService['getObserverSnapshot']>
  >();
  const owner = {
    getQueue: jest.fn<
      ReturnType<SafetyDeskService['getQueue']>,
      Parameters<SafetyDeskService['getQueue']>
    >(),
    approveItem: jest.fn<
      ReturnType<SafetyDeskService['approveItem']>,
      Parameters<SafetyDeskService['approveItem']>
    >(),
  } satisfies Pick<SafetyDeskService, 'getQueue' | 'approveItem'>;
  const support = {
    getQueue: jest.fn<
      ReturnType<SupportRequestsService['getQueue']>,
      Parameters<SupportRequestsService['getQueue']>
    >(),
    closeItem: jest.fn<
      ReturnType<SupportRequestsService['closeItem']>,
      Parameters<SupportRequestsService['closeItem']>
    >(),
  } satisfies Pick<SupportRequestsService, 'getQueue' | 'closeItem'>;
  const token = 'a'.repeat(64);
  const headers = {
    host: 'admin.major-maksimov.ru',
    'x-forwarded-host': 'admin.major-maksimov.ru',
    'x-forwarded-proto': 'https',
    'x-remote-user': 'maxim-observer',
    'x-runtime-overview-reader-token': token,
  };
  const url = '/api/v1/safety-desk/runtime-observer/overview';
  const missing = { availability: 'UNAVAILABLE' as const, observedAt: null, value: null };
  const snapshot: SafetyDeskOverviewResponse = {
    schemaVersion: 1,
    generatedAt: '2026-11-04T12:00:00.000Z',
    collector: { availability: 'UNAVAILABLE', observedAt: null, lastSuccessfulAt: null },
    queues: missing,
    workers: missing,
    receipts: missing,
    unfinishedActions: missing,
    actions: missing,
    bots: [],
    history: {
      availability: 'UNAVAILABLE',
      observedAt: null,
      windowSec: 86400,
      bucketSec: 60,
      retentionPoints: 1440,
      points: [],
    },
  };

  beforeEach(async () => {
    process.env.APP_ROLE = 'admin';
    getObserverSnapshot.mockReset().mockResolvedValue(snapshot);
    for (const method of [...Object.values(owner), ...Object.values(support)]) method.mockReset();
    const module = await Test.createTestingModule({
      controllers: [
        RuntimeOverviewReaderController,
        SafetyDeskController,
        SupportRequestsController,
      ],
      providers: [
        RuntimeOverviewReaderGuard,
        SafetyDeskAdminGuard,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            NODE_ENV: 'production',
            ADMIN_ACCESS_CODE: 'independent-owner-access-code',
            RUNTIME_OVERVIEW_READER_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
          }),
        },
        { provide: SafetyDeskService, useValue: owner },
        { provide: SupportRequestsService, useValue: support },
        {
          provide: SafetyDeskOverviewService,
          useValue: { getObserverSnapshot } satisfies Pick<
            SafetyDeskOverviewService,
            'getObserverSnapshot'
          >,
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.setGlobalPrefix('api');
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app?.close();
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
  });

  it('exposes one GET on the existing protected prefix with an independent guard', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, RuntimeOverviewReaderController)).toBe(
      'v1/safety-desk/runtime-observer',
    );
    const guards = Reflect.getMetadata(GUARDS_METADATA, RuntimeOverviewReaderController);
    expect(guards).toEqual([RuntimeOverviewReaderGuard]);
    expect(guards).not.toContain(SafetyDeskAdminGuard);
    expect(
      Reflect.getMetadata(METHOD_METADATA, RuntimeOverviewReaderController.prototype.getOverview),
    ).toBe(RequestMethod.GET);
    const response = await app.inject({ method: 'GET', url, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(snapshot);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(getObserverSnapshot).toHaveBeenCalledTimes(1);
  });

  it('denies unauthenticated reads and never invokes the snapshot service', async () => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(403);
    expect(getObserverSnapshot).not.toHaveBeenCalled();
  });

  it('denies actual owner and support content reads with machine credentials before service calls', async () => {
    for (const path of ['/api/v1/safety-desk/queue', '/api/v1/support-requests/queue']) {
      const response = await app.inject({ method: 'GET', url: path, headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ statusCode: 403 });
    }
    for (const method of [...Object.values(owner), ...Object.values(support)])
      expect(method).not.toHaveBeenCalled();
    expect(getObserverSnapshot).not.toHaveBeenCalled();
  });

  it('denies actual owner and support mutations with machine credentials before service calls', async () => {
    for (const path of [
      '/api/v1/safety-desk/items/fixture-item/approve',
      '/api/v1/support-requests/items/fixture-item/close',
    ]) {
      const response = await app.inject({ method: 'POST', url: path, headers, payload: {} });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ statusCode: 403 });
    }
    for (const method of [...Object.values(owner), ...Object.values(support)])
      expect(method).not.toHaveBeenCalled();
    expect(getObserverSnapshot).not.toHaveBeenCalled();
  });

  it('does not create action, detail, history or HEAD access', async () => {
    for (const suffix of ['/actions', '/history', '/queues', '/deletes/id/evidence']) {
      expect(
        (await app.inject({ method: 'GET', url: `${url}${suffix}`, headers })).statusCode,
      ).toBe(404);
    }
    for (const method of ['POST', 'PUT', 'DELETE'] as const)
      expect((await app.inject({ method, url, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'HEAD', url, headers })).statusCode).toBe(403);
    expect(getObserverSnapshot).not.toHaveBeenCalled();
  });
});
