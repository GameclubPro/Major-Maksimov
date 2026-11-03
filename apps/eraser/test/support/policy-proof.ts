import type { Store } from '../../src/store.js';
import type { ConnectionProof, UpdatePolicy } from '../../src/types.js';

// Synthetic positive MAX evidence for store-focused cases; HTTP/race tests exercise
// the real proof capture boundary separately with controlled transport responses.
// FLAG: Scheduling tests replace Date.now, while PostgreSQL validates proof expiry
// against its real clock. Synthetic evidence must retain a real 15-second lifetime.
export async function updatePolicy(store: Store, chatId: string, input: UpdatePolicy) {
  const cached = await store.operation(chatId, input);
  if (cached) return cached;
  const proof =
    input.enabled && !input.connectWhenReady
      ? {
          ...(await store.activationGuard(chatId, input)),
          expiresAt: new Date(new Date().getTime() + 15_000),
        }
      : undefined;
  return store.update(chatId, input, proof);
}

export async function connectionProof(
  store: Store,
  chatId: string,
  expiresAt = new Date(new Date().getTime() + 15_000),
): Promise<ConnectionProof> {
  const policy = await store.policy(chatId);
  if (!policy) throw new Error('Synthetic proof requires an existing policy');
  return { chatId, connectionGeneration: policy.connection_generation, expiresAt };
}
