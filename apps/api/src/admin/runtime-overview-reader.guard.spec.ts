import { ConfigService } from '@nestjs/config';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  RUNTIME_OVERVIEW_READER_HEADER,
  RuntimeOverviewReaderGuard,
} from './runtime-overview-reader.guard';
import { SafetyDeskAdminGuard } from './safety-desk-admin.guard';

const token = 'a'.repeat(64);
const digest = createHash('sha256').update(token).digest('hex');
const validHeaders = {
  host: 'admin.major-maksimov.ru',
  'x-forwarded-host': 'admin.major-maksimov.ru',
  'x-forwarded-proto': 'https',
  'x-remote-user': 'maxim-observer',
  [RUNTIME_OVERVIEW_READER_HEADER]: token,
};
function context(
  headers: Record<string, string | string[] | undefined> = validHeaders,
  method = 'GET',
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers, method }) }),
  } as unknown as ExecutionContext;
}
function config(overrides: Record<string, unknown> = {}) {
  return new ConfigService({
    NODE_ENV: 'production',
    SAFETY_DESK_ALLOWED_HOSTS: 'admin.major-maksimov.ru',
    RUNTIME_OVERVIEW_READER_TOKEN_SHA256: digest,
    ADMIN_ACCESS_CODE: 'independent-owner-access-code',
    ...overrides,
  });
}

describe('RuntimeOverviewReaderGuard', () => {
  const previousRole = process.env.APP_ROLE;
  beforeEach(() => {
    process.env.APP_ROLE = 'admin';
  });
  afterEach(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
  });

  it('admits only the dedicated machine identity without the owner access code', () => {
    expect(new RuntimeOverviewReaderGuard(config()).canActivate(context())).toBe(true);
    expect(() => new SafetyDeskAdminGuard(config()).canActivate(context())).toThrow(
      ForbiddenException,
    );
  });

  it.each([undefined, '', 'A'.repeat(64), 'a'.repeat(63), `${digest} `, 'not-a-digest'])(
    'fails closed for missing or noncanonical server digest %s',
    (value) => {
      expect(() =>
        new RuntimeOverviewReaderGuard(
          config({ RUNTIME_OVERVIEW_READER_TOKEN_SHA256: value }),
        ).canActivate(context()),
      ).toThrow(ForbiddenException);
    },
  );

  it.each([
    undefined,
    '',
    'b'.repeat(64),
    'A'.repeat(64),
    'a'.repeat(63),
    `${token} `,
    [token],
    [token, token],
  ])('rejects missing, incorrect or ambiguous reader credentials', (value) => {
    expect(() =>
      new RuntimeOverviewReaderGuard(config()).canActivate(
        context({ ...validHeaders, [RUNTIME_OVERVIEW_READER_HEADER]: value }),
      ),
    ).toThrow(ForbiddenException);
  });

  it.each(['all', 'ingress', 'publisher', 'action', 'moderation', 'enqueue', undefined])(
    'rejects role %s even with the correct machine identity',
    (role) => {
      if (role === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = role;
      expect(() => new RuntimeOverviewReaderGuard(config()).canActivate(context())).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])(
    'denies method %s including Fastify automatic HEAD',
    (method) => {
      expect(() =>
        new RuntimeOverviewReaderGuard(config()).canActivate(context(validHeaders, method)),
      ).toThrow(ForbiddenException);
    },
  );

  it.each([
    { host: 'major-maksimov.ru' },
    { host: 'admin.major-maksimov.ru,major-maksimov.ru' },
    { host: 'admin.major-maksimov.ru/ignored' },
    { host: 'owner@admin.major-maksimov.ru' },
    { host: ['admin.major-maksimov.ru'] },
    { 'x-forwarded-host': undefined },
    { 'x-forwarded-host': 'major-maksimov.ru' },
    { 'x-forwarded-host': 'admin.major-maksimov.ru,major-maksimov.ru' },
    { 'x-forwarded-proto': 'http' },
    { 'x-remote-user': undefined },
    { 'x-remote-user': 'owner' },
    { 'x-remote-user': 'maxim-observer ' },
    { origin: 'https://evil.example' },
    { origin: 'http://admin.major-maksimov.ru' },
    { origin: ['https://admin.major-maksimov.ru'] },
    { 'sec-fetch-site': 'cross-site' },
  ])('rejects requests outside the exact protected machine boundary: %j', (overrides) => {
    expect(() =>
      new RuntimeOverviewReaderGuard(config()).canActivate(
        context({ ...validHeaders, ...overrides }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('supports local admin-role fixtures without manufacturing a development token', () => {
    const local = new RuntimeOverviewReaderGuard(
      config({ NODE_ENV: 'test', SAFETY_DESK_ALLOWED_HOSTS: undefined }),
    );
    expect(
      local.canActivate(
        context({ host: 'localhost:3002', [RUNTIME_OVERVIEW_READER_HEADER]: token }),
      ),
    ).toBe(true);
    expect(() => local.canActivate(context({ host: 'localhost:3002' }))).toThrow(
      ForbiddenException,
    );
    expect(
      local.canActivate(context({ host: '[::1]:3002', [RUNTIME_OVERVIEW_READER_HEADER]: token })),
    ).toBe(true);
  });
});
