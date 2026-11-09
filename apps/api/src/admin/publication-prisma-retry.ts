import { Prisma } from '../prisma/prisma-client';
import { isPrismaKnownError } from './admin-legacy-utils';

const TRANSIENT_PUBLICATION_PRISMA_CODES = [
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
  'P2034',
  'P2037',
] as const;

const TRANSIENT_PUBLICATION_SQL_STATES = new Set(['40001', '40P01', '55P03', '57014']);

function readErrorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTransientPublicationRawQueryError(error: unknown): boolean {
  if (!isPrismaKnownError(error, 'P2010')) return false;
  const meta = readErrorRecord(readErrorRecord(error)?.meta);
  const driverError = readErrorRecord(meta?.driverAdapterError);
  const cause = readErrorRecord(driverError?.cause);
  // FLAG: Prisma 7 nests PostgreSQL SQLSTATE in the adapter cause. Read only these
  // known wrappers; P2010 alone or an error message never proves a transient failure.
  return [meta?.code, cause?.originalCode, cause?.code].some(
    (code) => typeof code === 'string' && TRANSIENT_PUBLICATION_SQL_STATES.has(code),
  );
}

export function isTransientPublicationPrismaError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  return (
    TRANSIENT_PUBLICATION_PRISMA_CODES.some((code) => isPrismaKnownError(error, code)) ||
    isTransientPublicationRawQueryError(error)
  );
}
