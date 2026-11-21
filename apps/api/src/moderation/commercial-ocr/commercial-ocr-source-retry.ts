import { isMaxApiCircuitOpenError } from '../../max/max-client.service';
import { isMaxExactMessageLookupMissingIdError } from '../../max/max-exact-message-lookup.error';
import type { CommercialOcrSourceFailureKind } from './commercial-ocr-metrics.service';

const TIMEOUT_CODES = new Set([
  'ECONNABORTED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

type SourceReadError = {
  code?: unknown;
  response?: { status?: unknown; headers?: Record<string, unknown> };
  retryAfterMs?: unknown;
};

type SourceReadFailure = Readonly<{
  kind: CommercialOcrSourceFailureKind;
  retry: { retryAfterMs?: number } | null;
}>;

/** FLAG: Diagnostics classify only fixed facts. A read retries only explicitly temporary failures. */
export function classifyCommercialOcrSourceFailure(
  error: unknown,
  nowMs = Date.now(),
): SourceReadFailure {
  if (!error || typeof error !== 'object') return { kind: 'unknown', retry: null };
  const row = error as SourceReadError;
  const status = row.response?.status;
  // Explicit access/missing errors take precedence even if a timeout code is present.
  if (status === 401 || status === 403) return { kind: 'access_denied', retry: null };
  if (status === 404 || status === 410) return { kind: 'access_or_missing', retry: null };

  if (status === 429) return { kind: 'remote_rate_limit', retry: readRetryAfter(row, nowMs) };
  if (isMaxApiCircuitOpenError(error))
    return { kind: 'circuit_open', retry: readRetryAfter(row, nowMs) };
  if (row.code === 'MAX_API_INTERNAL_RATE_LIMIT')
    return { kind: 'local_rate_limit', retry: readRetryAfter(row, nowMs) };
  if (
    status === 408 ||
    TIMEOUT_CODES.has(typeof row.code === 'string' ? row.code.toUpperCase() : '')
  )
    return { kind: 'timeout', retry: readRetryAfter(row, nowMs) };
  if (typeof status === 'number' && status >= 500 && status <= 599)
    return { kind: 'remote_server', retry: readRetryAfter(row, nowMs) };
  if (typeof status === 'number' && status >= 400 && status <= 499)
    return { kind: 'remote_client', retry: null };
  if (isMaxExactMessageLookupMissingIdError(error))
    return { kind: 'response_missing_id', retry: null };
  return { kind: 'unknown', retry: null };
}

function readRetryAfter(row: SourceReadError, nowMs: number): { retryAfterMs?: number } {
  const header = row.response?.headers?.['retry-after'];
  const seconds = typeof header === 'number' || typeof header === 'string' ? Number(header) : NaN;
  const headerMs =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : typeof header === 'string'
        ? Date.parse(header) - nowMs
        : NaN;
  const localMs = typeof row.retryAfterMs === 'number' ? row.retryAfterMs : NaN;
  const delay = Math.max(
    Number.isFinite(headerMs) ? headerMs : 0,
    Number.isFinite(localMs) ? localMs : 0,
  );
  return delay > 0 ? { retryAfterMs: Math.min(600_000, Math.ceil(delay)) } : {};
}
