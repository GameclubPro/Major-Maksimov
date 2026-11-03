import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { config, type Config } from '../src/config.js';
import { MaxClient, MaxError } from '../src/max.js';
import { updateInput, protectionInput } from '../src/http.js';
import { parseMessage } from '../src/types.js';
import { protectionGap } from '../src/store.js';

const settings: Config = {
  databaseUrl: 'postgres://localhost/test',
  redisUrl: 'redis://localhost',
  controlToken: 'a'.repeat(32),
  webhookSecret: 'b'.repeat(32),
  botToken: 'private',
  botId: '123',
  apiBaseUrl: 'https://platform-api2.max.ru',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'unit',
  webhookUrl: null,
};
const baseEnv = {
  ERASER_DATABASE_URL: settings.databaseUrl,
  ERASER_REDIS_URL: settings.redisUrl,
  ERASER_CONTROL_TOKEN: settings.controlToken,
};
const raw = (time: number) => ({
  timestamp: time,
  sender: { user_id: 5, is_bot: false },
  recipient: { chat_id: -1, chat_type: 'chat' },
  body: { mid: 'message' },
});

test('a received DELETE 429 remains a known rejection when cooldown persistence fails', async () => {
  let issued = false;
  const max = new MaxClient(
    settings,
    {
      acquire: async () => {},
      cooldown: async () => {
        throw new Error('store unavailable');
      },
    },
    async () =>
      Response.json({ code: 'rate.limit' }, { status: 429, headers: { 'Retry-After': '3' } }),
  );
  await assert.rejects(
    max.remove('-1', 'message', async () => {
      issued = true;
    }),
    (error) =>
      error instanceof MaxError &&
      error.status === 429 &&
      error.code === 'rate.limit' &&
      error.attempted === false &&
      error.retryAfterMs === 3000,
  );
  assert.equal(issued, true);
});

test('defaults are disabled and fail closed for malformed identity/retired API and excessive RPS', () => {
  assert.equal(config(baseEnv).enabled, false);
  assert.equal(config(baseEnv).maxRps, 20);
  assert.throws(() => config({ ...baseEnv, ERASER_ENABLED: 'true' }));
  assert.throws(() => config({ ...baseEnv, MAX_API_BASE_URL: 'https://platform-api.max.ru' }));
  assert.throws(() =>
    config({ ...baseEnv, MAX_API_BASE_URL: 'https://platform-api2.max.ru/?token=x' }),
  );
  assert.throws(() => config({ ...baseEnv, ERASER_MAX_RPS: '31' }));
});

test('policy supports all three periods and requires a UUID operation identity', () => {
  for (const hours of [24, 48, 168])
    assert.equal(
      updateInput({
        enabled: true,
        hours,
        expectedRevision: 0,
        operationId: randomUUID(),
        actorUserId: '5',
      }).hours,
      hours,
    );
  assert.throws(() =>
    updateInput({
      enabled: true,
      hours: 12,
      expectedRevision: 0,
      operationId: randomUUID(),
      actorUserId: '5',
    }),
  );
  assert.throws(() =>
    updateInput({
      enabled: true,
      hours: 24,
      expectedRevision: 0,
      operationId: 'retry',
      actorUserId: '5',
    }),
  );
  assert.equal(
    protectionInput({
      sourceRevision: 1,
      protectedMessageIds: [],
      protectedBotIds: [],
      holdMessageIds: [],
      completeThrough: null,
      complete: false,
    }).complete,
    false,
  );
});

test('message age uses original authenticated creation timestamp and exact group identity', () => {
  const time = Date.now() - 30 * 86_400_000;
  assert.equal(parseMessage(raw(time), '-1')?.sourceMs, time);
  assert.equal(parseMessage(raw(time), '-2'), null);
  assert.equal(parseMessage({ ...raw(time), timestamp: Date.now() + 120_000 }, '-1'), null);
  assert.equal(
    parseMessage({ ...raw(time), recipient: { chat_id: -1, chat_type: 'channel' } }, '-1'),
    null,
  );
});

test('module-bot history coverage validates its boundary and leaves independent authors eligible', () => {
  const input = {
    sourceRevision: 1,
    protectedMessageIds: [],
    protectedBotIds: ['900'],
    holdMessageIds: [],
    completeThrough: new Date(5000).toISOString(),
  };
  assert.equal(protectionInput(input).botHistoryCompleteFrom, null);
  assert.equal(
    protectionInput({ ...input, botHistoryCompleteFrom: new Date(2000).toISOString() })
      .botHistoryCompleteFrom,
    new Date(2000).toISOString(),
  );
  for (const floor of ['invalid', 1000, new Date(Date.now() + 120_000).toISOString()])
    assert.throws(() => protectionInput({ ...input, botHistoryCompleteFrom: floor }));
  const coverage = {
    ready: true,
    complete_through: new Date(5000),
    bot_history_complete_from: new Date(2000),
  };
  for (const isBot of [true, null]) {
    assert.equal(protectionGap({ isBot, sourceMs: 1999 }, true, coverage), 'history');
    assert.equal(protectionGap({ isBot, sourceMs: 2000 }, true, coverage), null);
    assert.equal(protectionGap({ isBot, sourceMs: 1999 }, false, coverage), null);
    assert.equal(protectionGap({ isBot, sourceMs: 5001 }, false, coverage), 'current');
    assert.equal(
      protectionGap({ isBot, sourceMs: 3000 }, true, {
        ...coverage,
        bot_history_complete_from: null,
      }),
      'history',
    );
  }
  assert.equal(protectionGap({ isBot: false, sourceMs: 1999 }, true, coverage), null);
});

test('transport budgets reads and every delete and never leaks a token into URL', async () => {
  const calls: string[] = [],
    admissions: Array<string | undefined> = [];
  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(!url.includes(settings.botToken));
    assert.equal((init?.headers as Record<string, string>).Authorization, settings.botToken);
    calls.push(`${init?.method} ${new URL(url).pathname}`);
    const path = new URL(url).pathname;
    if (path.endsWith('/members/me'))
      return Response.json({
        user_id: 123,
        is_admin: true,
        permissions: ['read_all_messages', 'write'],
      });
    if (path.endsWith('/pin')) return Response.json({ message: null });
    if (init?.method === 'DELETE') return Response.json({ success: true });
    return Response.json({ messages: [raw(Date.now() - 86_400_000)] });
  };
  const max = new MaxClient(
    settings,
    {
      acquire: async (chat) => {
        admissions.push(chat);
      },
      cooldown: async () => {},
    },
    http,
  );
  await max.rights('-1');
  await max.pin('-1');
  await max.page('-1', Date.now());
  let guard = false;
  await max.remove('-1', 'message', async () => {
    guard = true;
  });
  assert.equal(guard, true);
  assert.equal(admissions.length, 4);
  assert.equal(admissions.at(-1), '-1');
  assert.equal(calls.length, 4);
});

test('pin accepts documented empty envelopes and verified same-chat message IDs', async () => {
  const cases = [
    { response: {}, expected: null },
    { response: { message: null }, expected: null },
    { response: { message: raw(Date.now()) }, expected: 'message' },
  ];
  for (const { response, expected } of cases) {
    const max = new MaxClient(
      settings,
      { acquire: async () => {}, cooldown: async () => {} },
      async () => Response.json(response),
    );
    assert.equal(await max.pin('-1'), expected);
  }
});

test('pin rejects nonempty unknown envelopes and malformed or foreign message IDs', async () => {
  for (const response of [
    { success: true },
    { message: {} },
    { message: [] },
    { message: '' },
    { message: { recipient: { chat_id: -1 } } },
    { message: { body: {}, recipient: { chat_id: -1 } } },
    { message: { body: { mid: '' }, recipient: { chat_id: -1 } } },
    { message: { body: { mid: 123 }, recipient: { chat_id: -1 } } },
    { message: { body: { mid: 'message' } } },
    { message: { body: { mid: 'message' }, recipient: { chat_id: -2 } } },
  ]) {
    const max = new MaxClient(
      settings,
      { acquire: async () => {}, cooldown: async () => {} },
      async () => Response.json(response),
    );
    await assert.rejects(
      max.pin('-1'),
      (error) => error instanceof MaxError && error.code === 'pin_unknown' && !error.attempted,
      JSON.stringify(response),
    );
  }
  for (const response of [null, []]) {
    const max = new MaxClient(
      settings,
      { acquire: async () => {}, cooldown: async () => {} },
      async () => Response.json(response),
    );
    await assert.rejects(
      max.pin('-1'),
      (error) =>
        error instanceof MaxError && error.code === 'malformed_response' && !error.attempted,
    );
  }
});

test('pin retains HTTP errors and shared Retry-After cooldown instead of certifying no pin', async () => {
  const cooldowns: number[] = [];
  for (const status of [403, 404, 429]) {
    const max = new MaxClient(
      settings,
      {
        acquire: async () => {},
        cooldown: async (ms) => {
          cooldowns.push(ms);
        },
      },
      async () => Response.json({}, { status, headers: { 'Retry-After': '3' } }),
    );
    await assert.rejects(
      max.pin('-1'),
      (error) =>
        error instanceof MaxError &&
        error.status === status &&
        !error.attempted &&
        (status !== 429 || error.retryAfterMs === 3000),
    );
  }
  assert.deepEqual(cooldowns, [3000]);
});

test('message presence treats every 404 as inaccessible or missing, never certified absence', async () => {
  let response = Response.json({});
  const max = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () => response.clone(),
  );
  for (const body of [
    { message: 'missing' },
    { code: 'not.found', message: 'Message message was not found' },
    { code: 'message.not.found' },
    { code: 'chat.not.found' },
  ]) {
    response = Response.json(body, { status: 404 });
    assert.equal(await max.presence('-1', 'message'), 'unknown');
  }
  response = new Response('not JSON', { status: 404 });
  assert.equal(await max.presence('-1', 'message'), 'unknown');
  response = Response.json(raw(Date.now()));
  assert.equal(await max.presence('-1', 'message'), 'present');
  assert.equal(await max.presence('-2', 'message'), 'unknown');
  assert.equal(await max.presence('-1', 'another-message'), 'unknown');
});

test('presence preserves non-404 failures and the MAX rate-limit cooldown', async () => {
  let status = 401;
  const cooldowns: number[] = [];
  const max = new MaxClient(
    settings,
    {
      acquire: async () => {},
      cooldown: async (ms) => {
        cooldowns.push(ms);
      },
    },
    async () =>
      Response.json(
        { code: 'lookup.failed' },
        {
          status,
          headers: { 'Retry-After': '3' },
        },
      ),
  );
  for (status of [401, 403, 429, 503])
    await assert.rejects(
      max.presence('-1', 'message'),
      (e) => e instanceof MaxError && e.status === status && !e.attempted,
    );
  assert.deepEqual(cooldowns, [3000]);
  const unavailable = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () => {
      throw new Error('transport');
    },
  );
  await assert.rejects(
    unavailable.presence('-1', 'message'),
    (e) => e instanceof MaxError && e.status === 0 && !e.attempted,
  );
});

test('only a positive acknowledgement certifies a delete request', async () => {
  let response = Response.json({ success: false });
  const max = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () => response,
  );
  await assert.rejects(
    max.remove('-1', 'message', async () => {}),
    (e) => e instanceof MaxError && e.attempted && e.code === 'delete_unconfirmed',
  );
  for (const body of [{}, { code: 'not.found' }, { code: 'message.not.found' }]) {
    response = Response.json(body, { status: 404 });
    await assert.rejects(
      max.remove('-1', 'message', async () => {}),
      (e) => e instanceof MaxError && e.status === 404 && e.attempted,
    );
  }
});

test('429 honors Retry-After and leaves the delete safe for a later guarded attempt', async () => {
  const cooldowns: number[] = [];
  const max = new MaxClient(
    settings,
    {
      acquire: async () => {},
      cooldown: async (ms) => {
        cooldowns.push(ms);
      },
    },
    async () =>
      Response.json({ code: 'rate.limit' }, { status: 429, headers: { 'Retry-After': '3' } }),
  );
  await assert.rejects(
    max.remove('-1', 'message', async () => {}),
    (e) => e instanceof MaxError && e.retryAfterMs === 3000 && !e.attempted,
  );
  assert.deepEqual(cooldowns, [3000]);
});

test('malformed/foreign history pages stop instead of manufacturing coverage', async () => {
  const max = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () =>
      Response.json({
        messages: [
          { ...raw(Date.now() - 86_400_000), recipient: { chat_id: -2, chat_type: 'chat' } },
        ],
      }),
  );
  await assert.rejects(
    max.page('-1', Date.now()),
    (e) => e instanceof MaxError && e.code === 'history_unknown',
  );
});

test('webhook registration verifies exact bot, rejects conflicting subscriptions and reads back success', async () => {
  const url = 'https://major-maksimov.ru/eraser/webhook';
  const calls: string[] = [];
  let registered = false;
  const max = new MaxClient(
    { ...settings, webhookUrl: url },
    { acquire: async () => {}, cooldown: async () => {} },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(`${init?.method} ${path}`);
      if (path === '/me') return Response.json({ user_id: 123, is_bot: true });
      if (init?.method === 'POST') {
        registered = true;
        return Response.json({ success: true });
      }
      return Response.json({ subscriptions: registered ? [{ url }] : [] });
    },
  );
  assert.deepEqual(await max.subscribe(), { updateTypes: 'unknown' });
  assert.deepEqual(calls, [
    'GET /me',
    'GET /subscriptions',
    'POST /subscriptions',
    'GET /subscriptions',
  ]);
  const conflict = new MaxClient(
    { ...settings, webhookUrl: url },
    { acquire: async () => {}, cooldown: async () => {} },
    async (input) =>
      new URL(String(input)).pathname === '/me'
        ? Response.json({ user_id: 123, is_bot: true })
        : Response.json({ subscriptions: [{ url: 'https://other.invalid/webhook' }] }),
  );
  await assert.rejects(conflict.subscribe(), /Conflicting Eraser webhook subscription/);
});

test('webhook registration distinguishes verified, unknown and incompatible update types', async (t) => {
  const url = 'https://major-maksimov.ru/eraser/webhook';
  const required = [
    'message_created',
    'message_edited',
    'message_removed',
    'bot_added',
    'bot_removed',
  ];
  const cases: Array<{
    name: string;
    updateTypes: unknown;
    expected: 'verified' | 'unknown' | 'rejected';
  }> = [
    { name: 'omitted', updateTypes: undefined, expected: 'unknown' },
    { name: 'nullable', updateTypes: null, expected: 'unknown' },
    { name: 'complete', updateTypes: required, expected: 'verified' },
    {
      name: 'normalized superset',
      updateTypes: [
        ...required.map((value) => ` ${value.toUpperCase()} `),
        'bot_added',
        'user_added',
      ],
      expected: 'verified',
    },
    ...required.map((missing) => ({
      name: `missing ${missing}`,
      updateTypes: required.filter((value) => value !== missing),
      expected: 'rejected' as const,
    })),
    { name: 'empty list', updateTypes: [], expected: 'rejected' },
    { name: 'object', updateTypes: {}, expected: 'rejected' },
    { name: 'string', updateTypes: 'message_created', expected: 'rejected' },
    { name: 'non-string member', updateTypes: [...required, 1], expected: 'rejected' },
    { name: 'blank member', updateTypes: [...required, ' '], expected: 'rejected' },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const calls: string[] = [];
      let registered = false;
      const max = new MaxClient(
        { ...settings, webhookUrl: url },
        { acquire: async () => {}, cooldown: async () => {} },
        async (input, init) => {
          const path = new URL(String(input)).pathname;
          calls.push(`${init?.method} ${path}`);
          if (path === '/me') return Response.json({ user_id: 123, is_bot: true });
          if (init?.method === 'POST') {
            assert.deepEqual(JSON.parse(String(init.body)), {
              url,
              secret: settings.webhookSecret,
              update_types: required,
            });
            registered = true;
            return Response.json({ success: true });
          }
          return Response.json({
            subscriptions: registered ? [{ url, update_types: scenario.updateTypes }] : [],
          });
        },
      );
      if (scenario.expected === 'rejected') {
        await assert.rejects(max.subscribe(), /MAX webhook subscription readback unconfirmed/);
      } else {
        assert.deepEqual(await max.subscribe(), { updateTypes: scenario.expected });
      }
      assert.deepEqual(calls, [
        'GET /me',
        'GET /subscriptions',
        'POST /subscriptions',
        'GET /subscriptions',
      ]);
    });
  }
});

test('standalone runtime image carries both Russian CAs, exact source identity and no API runtime dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const { X509Certificate } = await import('node:crypto');
  const docker = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(
    docker,
    /NODE_EXTRA_CA_CERTS=\/usr\/local\/share\/ca-certificates\/russian-trusted-ca-bundle\.crt/,
  );
  for (const name of ['root', 'sub']) {
    const pem = await readFile(
      new URL(`../../../infra/certs/russian-trusted-${name}-ca.pem`, import.meta.url),
      'utf8',
    );
    assert.equal(new X509Certificate(pem).ca, true);
    assert.match(docker, new RegExp(`COPY infra/certs/russian-trusted-${name}-ca\\.pem`));
  }
  assert.ok(
    docker.includes(
      "printf '\\n' >> /usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt",
    ),
    'PEM files without trailing newlines require an explicit bundle separator',
  );
  assert.match(docker, /com\.maxim\.release-protected="true"/);
  assert.match(docker, /org\.opencontainers\.image\.revision=\$COMMIT_SHA/);
  assert.doesNotMatch(docker, /COPY apps\/api|MAX_BOT_TOKEN|MAX_PUBLISHER_BOT_TOKEN/);
});

test('membership absence or malformed data does not manufacture a permanent access denial', async () => {
  let row: unknown = { user_id: 123 };
  const max = new MaxClient(
    settings,
    { acquire: async () => {}, cooldown: async () => {} },
    async () => Response.json(row),
  );
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'membership_unknown',
  );
  row = { user_id: 999, is_admin: false, permissions: [] };
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'membership_unknown',
  );
  row = { user_id: 123, is_admin: false, permissions: [] };
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'eraser_rights_missing',
  );
  row = { user_id: 123, is_admin: true };
  await assert.rejects(
    max.rights('-1'),
    (error) => error instanceof MaxError && error.code === 'membership_unknown',
  );
});
