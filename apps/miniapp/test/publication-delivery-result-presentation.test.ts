import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicationDeliveryResultPresentation } from '../src/features/publications/publication-delivery-result-presentation';

const delivery = { total: 4, pending: 2, sent: 2, failed: 0, ambiguous: 0, canceled: 0 };

test('historical pending does not promise dispatch after authoritative stop', () => {
  const result = getPublicationDeliveryResultPresentation({
    delivery,
    actionableDelivery: { ...delivery, dispatchPending: 0 },
  });
  assert.equal(result.headline, 'Опубликовано 2 из 4');
  assert.deepEqual(result.currentFacts, []);
  assert.equal(result.needsAttention, false);
});

test('current work uses authoritative pending and preserves unresolved outcomes', () => {
  const result = getPublicationDeliveryResultPresentation({
    delivery: { ...delivery, ambiguous: 1 },
    actionableDelivery: { ...delivery, dispatchPending: 1, failed: 1, ambiguous: 1 },
  });
  assert.deepEqual(result.currentFacts, [
    'В очереди или отправляется: 1',
    'Нужно проверить: 1',
    'С ошибкой: 1',
  ]);
  assert.equal(result.needsAttention, true);
});

test('old schedule uncertainty remains visible without offering dispatch for its old work', () => {
  const result = getPublicationDeliveryResultPresentation({
    delivery: { ...delivery, pending: 0, ambiguous: 1 },
    actionableDelivery: { ...delivery, total: 0, pending: 0, dispatchPending: 0 },
  });
  assert.deepEqual(result.currentFacts, ['Нужно проверить: 1']);
  assert.equal(result.needsAttention, true);
});
