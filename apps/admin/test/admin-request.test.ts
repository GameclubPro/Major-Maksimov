import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAdminApiTransport,
  createAdminRequestHeaders,
  type AdminApiFetch,
} from '../src/admin-request';

test('uses the browser session without an extra access-code header', () => {
  assert.deepEqual(createAdminRequestHeaders(), {
    Accept: 'application/json',
  });
});

test('adds the JSON content type only for requests with JSON bodies', () => {
  assert.deepEqual(createAdminRequestHeaders({ json: true }), {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
});

test('forwards cancellation and disables cached reads while preserving the browser session', async () => {
  const controller = new AbortController();
  let options: RequestInit | undefined;
  await createAdminApiTransport(async (_input, init) => {
    options = init;
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
  }).request(
    '/api/v1/safety-desk/runtime/overview',
    { parse: (value) => value },
    {
      signal: controller.signal,
      cache: 'no-store',
    },
  );
  assert.equal(options?.signal, controller.signal);
  assert.equal(options?.cache, 'no-store');
  assert.equal(options?.credentials, 'same-origin');
  assert.equal(new Headers(options?.headers).has('X-Admin-Access-Code'), false);
});

test('performs owner actions through the browser session without reading credential storage', async () => {
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl: AdminApiFetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const storageTrap = {
    configurable: true,
    get() {
      throw new Error('admin transport must not access browser storage');
    },
  };
  Object.defineProperty(globalThis, 'localStorage', storageTrap);
  Object.defineProperty(globalThis, 'sessionStorage', storageTrap);

  try {
    const result = await createAdminApiTransport(fetchImpl).request(
      '/api/v1/safety-desk/items/item%2F1/approve',
      { parse: (value) => value as { ok: boolean } },
      { method: 'POST', body: {} },
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 1);
    assert.equal(String(requests[0]?.input), '/api/v1/safety-desk/items/item%2F1/approve');
    assert.deepEqual(requests[0]?.init, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } finally {
    restoreGlobalProperty('localStorage', originalLocalStorage);
    restoreGlobalProperty('sessionStorage', originalSessionStorage);
  }
});

function restoreGlobalProperty(
  name: 'localStorage' | 'sessionStorage',
  descriptor?: PropertyDescriptor,
) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
    return;
  }
  Reflect.deleteProperty(globalThis, name);
}
