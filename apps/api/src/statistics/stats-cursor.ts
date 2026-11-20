import { createHmac, timingSafeEqual } from 'node:crypto';
import { StatsFailure } from './stats-common';
export function encodeCursor(value: unknown, secret: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function decodeCursor<T>(cursor: string, secret: string): T {
  if (typeof cursor !== 'string' || cursor.length > 8192)
    throw new StatsFailure('INVALID_REQUEST', 400);
  const [body, signature, ...rest] = cursor.split('.');
  const expected = createHmac('sha256', secret)
    .update(body ?? '')
    .digest('base64url');
  if (
    !body ||
    !signature ||
    rest.length ||
    signature.length !== expected.length ||
    !/^[A-Za-z0-9_-]+$/u.test(signature) ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
    throw new StatsFailure('INVALID_REQUEST', 400);
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as T;
  } catch {
    throw new StatsFailure('INVALID_REQUEST', 400);
  }
}
