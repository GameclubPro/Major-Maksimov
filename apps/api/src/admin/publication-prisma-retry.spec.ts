import { Prisma } from '../prisma/prisma-client';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';

describe('publication database failure classification', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034', 'P2037'])(
    'retains the existing %s infrastructure classification',
    (code) => {
      expect(isTransientPublicationPrismaError({ code })).toBe(true);
    },
  );

  it('retains initialization failure handling', () => {
    expect(
      isTransientPublicationPrismaError(
        new Prisma.PrismaClientInitializationError('unavailable', 'test-client'),
      ),
    ).toBe(true);
  });

  it.each(['40001', '40P01', '55P03', '57014'])(
    'recognizes SQLSTATE %s only through known raw-query wrappers',
    (code) => {
      expect(isTransientPublicationPrismaError({ code: 'P2010', meta: { code } })).toBe(true);
      expect(
        isTransientPublicationPrismaError({
          code: 'P2010',
          meta: { driverAdapterError: { cause: { originalCode: code, code } } },
        }),
      ).toBe(true);
      expect(isTransientPublicationPrismaError({ code })).toBe(false);
      expect(isTransientPublicationPrismaError({ code: 'P2002', meta: { code } })).toBe(false);
    },
  );

  it.each(['42601', '23505', '23503', '22003', 'XXXXX'])(
    'does not retry permanent or unknown raw SQLSTATE %s',
    (code) => {
      expect(
        isTransientPublicationPrismaError({
          code: 'P2010',
          meta: { driverAdapterError: { cause: { originalCode: code } } },
        }),
      ).toBe(false);
    },
  );

  it.each([
    null,
    undefined,
    {},
    { code: 'P2010' },
    { code: 'P2010', message: 'Raw query failed. Code: 57014' },
    { code: 'P2010', meta: { code: 57014 } },
    { code: 'P2010', meta: { driverAdapterError: { message: '40P01' } } },
    { code: 'P2010', cause: { code: '57014' } },
    { code: 'P2010', meta: { driverAdapterError: [{ cause: { code: '57014' } }] } },
  ])('leaves malformed or unverified metadata nontransient: %j', (error) => {
    expect(isTransientPublicationPrismaError(error)).toBe(false);
  });

  it('does not recurse through cyclic metadata', () => {
    const error: Record<string, unknown> = { code: 'P2010' };
    error.meta = { driverAdapterError: { cause: error } };
    expect(isTransientPublicationPrismaError(error)).toBe(false);
  });
});
