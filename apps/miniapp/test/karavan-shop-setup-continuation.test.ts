import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type {
  KaravanMarketplaceOperation,
  KaravanMarketplaceSetup,
} from '@maxim/contracts/karavan-marketplace';
import { continueShopSetup } from '../src/pages/settings/karavan-shop/setup-continuation';

const marketId = randomUUID();
const request = (): KaravanMarketplaceSetup => ({
  operationId: randomUUID(),
  chatIds: ['-1', '-2'],
  expectedConnectionRevision: 1,
  create: {
    name: 'Соседи',
    format: 'community',
    admissionPolicy: 'applications',
    setupVersion: 2,
    rules: { text: '', allowedCategoryIds: [], allowedSubcategoryIds: [], categoryOrder: [] },
  },
});
function receipt(
  input: KaravanMarketplaceSetup,
  connected: number,
  state: KaravanMarketplaceOperation['state'] = 'pending',
): KaravanMarketplaceOperation {
  return {
    operationId: input.operationId,
    request: input,
    state,
    checkpoints: {
      marketplaceId: marketId,
      bindings: input.chatIds.map((chatId, index) =>
        index < connected
          ? { chatId, state: 'connected', bindingId: randomUUID(), generation: 1 }
          : { chatId, state: 'pending', bindingId: null, generation: null },
      ),
    },
  };
}
test('one explicit setup continues confirmed create and each binding with the identical operation', async () => {
  const input = request();
  const sent: KaravanMarketplaceSetup[] = [];
  const result = await continueShopSetup(
    input,
    async (value) => {
      sent.push(value);
      return receipt(value, sent.length - 1, sent.length === 3 ? 'complete' : 'pending');
    },
    () => true,
  );
  assert.equal(result.state, 'complete');
  assert.equal(sent.length, 3);
  for (const item of sent) assert.deepEqual(item, input);
});
test('unknown, partial, rejected and cancelled outcomes stop without another dispatch', async () => {
  for (const state of ['unknown', 'partial', 'rejected', 'cancelled'] as const) {
    let sent = 0;
    const input = request();
    await continueShopSetup(
      input,
      async (value) => {
        sent++;
        return receipt(value, 0, state);
      },
      () => true,
    );
    assert.equal(sent, 1, state);
  }
});
test('an uncertain binding, foreign receipt or actor change cannot continue', async () => {
  for (const kind of ['binding', 'identity', 'actor']) {
    let sent = 0;
    const input = request();
    await continueShopSetup(
      input,
      async (value) => {
        sent++;
        const result = receipt(value, 0);
        if (kind === 'binding') result.checkpoints.bindings[0].state = 'unknown';
        if (kind === 'identity') result.operationId = randomUUID();
        return result;
      },
      () => kind !== 'actor',
    );
    assert.equal(sent, 1, kind);
  }
});
test('no-progress response and transport failure retain recovery without a retry loop', async () => {
  let sent = 0;
  const input = request();
  await continueShopSetup(
    input,
    async (value) => {
      sent++;
      return receipt(value, 0);
    },
    () => true,
  );
  assert.equal(sent, 2);
  sent = 0;
  await assert.rejects(
    continueShopSetup(
      input,
      async () => {
        sent++;
        throw new Error('timeout');
      },
      () => true,
    ),
    /timeout/,
  );
  assert.equal(sent, 1);
});
