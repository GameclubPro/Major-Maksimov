import { isAmbiguousMaxMutationError, isAmbiguousMaxSendError } from './max-send-ambiguity.util';

describe('MAX send ambiguity classification', () => {
  it.each([500, 501, 502, 503, 505, 599])('treats HTTP %s as ambiguous for sends', (status) => {
    expect(isAmbiguousMaxSendError({ response: { status } })).toBe(true);
  });

  it.each([408, 500, 502, 503, 504, 599])(
    'preserves HTTP %s uncertainty through a wrapped transport error',
    (status) => {
      const error = new Error('MAX operation failed', { cause: { response: { status } } });
      expect(isAmbiguousMaxSendError(error)).toBe(true);
      expect(isAmbiguousMaxMutationError(error)).toBe(status === 408 || status === 504);
    },
  );

  it.each(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE'])(
    'preserves wrapped %s uncertainty without relying on the wrapper text',
    (code) => {
      const error = new Error('MAX operation failed', { cause: { code } });
      expect(isAmbiguousMaxMutationError(error)).toBe(true);
      expect(isAmbiguousMaxSendError(error)).toBe(true);
    },
  );

  it.each([400, 403, 404, 429])('keeps an explicit HTTP %s rejection definitive', (status) => {
    const error = new Error('network request failed', {
      cause: { response: { status }, message: 'timeout-shaped remote description' },
    });
    expect(isAmbiguousMaxMutationError(error)).toBe(false);
    expect(isAmbiguousMaxSendError(error)).toBe(false);
  });

  it('bounds cyclic and deeply nested causes', () => {
    const cyclic = Object.assign(new Error('operation failed'), { cause: null as unknown });
    cyclic.cause = cyclic;
    expect(isAmbiguousMaxSendError(cyclic)).toBe(false);
    const timeout = { code: 'ETIMEDOUT' };
    expect(isAmbiguousMaxSendError({ cause: { cause: { cause: timeout } } })).toBe(true);
    expect(isAmbiguousMaxSendError({ cause: { cause: { cause: { cause: timeout } } } })).toBe(
      false,
    );
  });

  it('keeps ordinary idempotent mutations retryable on HTTP 500', () => {
    expect(isAmbiguousMaxMutationError({ response: { status: 500 } })).toBe(false);
  });

  it.each([408, 504])('keeps HTTP %s ambiguous for every mutation', (status) => {
    expect(isAmbiguousMaxMutationError({ response: { status } })).toBe(true);
    expect(isAmbiguousMaxSendError({ response: { status } })).toBe(true);
  });
});
