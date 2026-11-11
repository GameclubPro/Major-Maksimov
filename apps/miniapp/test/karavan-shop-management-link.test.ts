import assert from 'node:assert/strict';
import { test } from 'node:test';
import { karavanShopManagementUrl } from '../src/lib/karavan-shop-management-link';

test('management uses the configured buyer bot and exact shop without carrying authority', () => {
  assert.equal(karavanShopManagementUrl('https://max.ru/buyer_bot?startapp=m_my-shop&from=chat#old', 'my-shop'), 'https://max.ru/buyer_bot?startapp=ma_my-shop');
  for (const value of [null, 'https://max.ru.evil.test/buyer_bot?startapp=m_my-shop', 'https://user@max.ru/buyer_bot?startapp=m_my-shop', 'http://max.ru/buyer_bot?startapp=m_my-shop', 'https://max.ru/buyer_bot?startapp=m_other-shop', 'https://max.ru/buyer_bot/extra?startapp=m_my-shop', 'https://max.ru/buyer_bot?startapp=store_any']) {
    assert.equal(karavanShopManagementUrl(value, 'my-shop'), null);
  }
  assert.equal(karavanShopManagementUrl('https://max.ru/buyer_bot?startapp=m_x', 'x'), null);
});
