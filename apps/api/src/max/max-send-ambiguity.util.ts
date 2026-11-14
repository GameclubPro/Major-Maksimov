import { collectMaxRetryErrorChain } from './max-retry-after';

export const MAX_SEND_AMBIGUOUS_ERROR_PREFIX = '[max.send_ambiguous]';
export const MAX_SEND_FENCE_STALE_MS = 10 * 60_000;

export function isAmbiguousMaxMutationError(error: unknown): boolean {
  return isAmbiguousMaxError(error, false);
}

export function isAmbiguousMaxSendError(error: unknown): boolean {
  return isAmbiguousMaxError(error, true);
}

function isAmbiguousMaxError(error: unknown, send: boolean): boolean {
  const chain = collectMaxRetryErrorChain(error);
  // FLAG: Wrappers must preserve uncertain effects. Inspect the bounded cause chain;
  // an actual HTTP response takes precedence over timeout-like descriptive text.
  for (const entry of chain) {
    const status = (entry as { response?: { status?: unknown } })?.response?.status;
    if (typeof status === 'number') {
      return status === 408 || status === 504 || (send && status >= 500 && status <= 599);
    }
  }
  return chain.some(isAmbiguousTransportError);
}

function isAmbiguousTransportError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.trim().length > 0) {
    const normalizedCode = code.trim().toLowerCase();
    if (
      normalizedCode === 'econnreset' ||
      normalizedCode === 'econnaborted' ||
      normalizedCode === 'etimedout' ||
      normalizedCode === 'epipe'
    ) {
      return true;
    }
  }

  const message = error instanceof Error && error.message.trim() ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('ambiguous max') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('terminated') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnaborted') ||
    normalized.includes('socket hang up') ||
    normalized.includes('network')
  );
}
