import { MaxApiCircuitOpenError } from '../../max/max-client.service';
import { MaxExactMessageLookupMissingIdError } from '../../max/max-exact-message-lookup.error';
import { classifyCommercialOcrSourceFailure } from './commercial-ocr-source-retry';

const retryAfterFailure = (error: unknown, nowMs?: number) =>
  classifyCommercialOcrSourceFailure(error, nowMs).retry;

describe('commercial OCR exact source retry classification', () => {
  it.each(['ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_HEADERS_TIMEOUT'])('retries %s', (code) => {
    expect(retryAfterFailure({ code })).toEqual({});
  });
  it.each([408, 429, 500, 502, 503, 504])('retries temporary HTTP %s', (status) => {
    expect(retryAfterFailure({ response: { status } })).toEqual({});
  });
  it.each([400, 401, 403, 404, 410, 422])('keeps HTTP %s terminal', (status) => {
    expect(retryAfterFailure({ response: { status } })).toBeNull();
  });
  it('keeps an explicit access denial terminal even with a timeout code', () => {
    expect(retryAfterFailure({ code: 'ETIMEDOUT', response: { status: 403 } })).toBeNull();
    expect(retryAfterFailure(new Error('timeout? unknown transport'))).toBeNull();
  });
  it.each([
    [403, 'access_denied', null],
    [404, 'access_or_missing', null],
    [408, 'timeout', {}],
    [422, 'remote_client', null],
    [429, 'remote_rate_limit', {}],
    [503, 'remote_server', {}],
  ])(
    'classifies MAX read HTTP %s by status without logging response details',
    (status, kind, retry) => {
      expect(classifyCommercialOcrSourceFailure({ response: { status, data: 'private' } })).toEqual(
        {
          kind,
          retry,
        },
      );
    },
  );

  it('distinguishes locally validated missing response identifiers from unknown failures', () => {
    const error = new MaxExactMessageLookupMissingIdError();
    expect(classifyCommercialOcrSourceFailure(error)).toEqual({
      kind: 'response_missing_id',
      retry: null,
    });
    expect(classifyCommercialOcrSourceFailure(new Error(error.message))).toEqual({
      kind: 'unknown',
      retry: null,
    });
  });

  it('honors the longest valid Retry-After and the circuit cooldown', () => {
    expect(retryAfterFailure(new MaxApiCircuitOpenError('bot', 12_000))).toEqual({
      retryAfterMs: 12_000,
    });
    expect(
      retryAfterFailure({
        response: { status: 429, headers: { 'retry-after': '30' } },
        retryAfterMs: 12_000,
      }),
    ).toEqual({ retryAfterMs: 30_000 });
    const now = Date.parse('2026-10-05T10:00:00Z');
    expect(
      retryAfterFailure(
        { response: { status: 503, headers: { 'retry-after': 'Mon, 05 Oct 2026 10:00:20 GMT' } } },
        now,
      ),
    ).toEqual({ retryAfterMs: 20_000 });
  });
});
