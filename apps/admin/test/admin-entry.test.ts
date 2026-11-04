import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminApp } from '../src/admin-app';

test('initial entry waits for server data without another credential form or fabricated queue', () => {
  const html = renderToStaticMarkup(createElement(AdminApp));
  assert.match(html, /Safety Desk/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status"[^>]*>Загружаю данные…/);
  assert.doesNotMatch(html, /<input|Код доступа|Введите код|Войти|desk-shell|desk-metrics/);
});
