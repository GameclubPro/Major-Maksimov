import { setTimeout as delay } from 'node:timers/promises';
import { MaxError } from './max.js';

export async function startService(
  steps: {
    prepare: () => Promise<void>;
    listen: () => Promise<void>;
    subscribe: () => Promise<void>;
    start: () => Promise<void>;
  },
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  await steps.prepare();
  if (signal.aborted) return false;
  await steps.listen();
  return startAfterSubscription(steps.subscribe, steps.start, signal);
}

export async function startAfterSubscription(
  subscribe: () => Promise<void>,
  start: () => Promise<void>,
  signal: AbortSignal,
): Promise<boolean> {
  while (!signal.aborted) {
    try {
      await subscribe();
    } catch (error) {
      if (signal.aborted) return false;
      // FLAG: Keep webhook ingress open during a known no-effect rejection. Other
      // prerequisite failures still stop startup; identity checks are never bypassed.
      if (!(error instanceof MaxError) || error.status !== 429 || error.attempted) throw error;
      const until = error.retryAtMs;
      try {
        while (Date.now() < until)
          await delay(Math.min(60_000, until - Date.now()), undefined, { signal });
      } catch (error) {
        if (signal.aborted) return false;
        throw error;
      }
      continue;
    }
    if (signal.aborted) return false;
    await start();
    return !signal.aborted;
  }
  return false;
}
