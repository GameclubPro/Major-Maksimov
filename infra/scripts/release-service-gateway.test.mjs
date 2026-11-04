import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import {
  exchangeControlFrame,
  MAX_CONTROL_WIRE_BYTES,
  MAX_SUBMIT_BYTES,
  parseReleaseSshCommand,
  productionGatewayInvocation,
  readSubmitInput,
  RELEASE_CONTROL_SOCKET,
  runReleaseGateway,
  validateControlResponse,
} from './release-service-gateway.mjs';

const id = '01234567-89ab-4cde-8fab-0123456789ab';
const request = {
  schemaVersion: 1,
  id,
  sourceSha: 'a'.repeat(40),
  expectedManifestSha256: null,
  trigger: 'operator',
  images: [],
};
const success = { schemaVersion: 1, ok: true, result: { state: 'QUEUED' } };
const encoded = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const hasCode = (code) => (error) => error.code === code;

async function withSocket(callback, handle) {
  const directory = await mkdtemp(join(tmpdir(), 'maxim-gw-'));
  const socketPath = join(directory, 'control.sock');
  const sockets = new Set();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    handle(socket);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await callback(socketPath);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

function onFrame(socket, handle) {
  const chunks = [];
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(10)) handle(bytes);
  });
}

test('forced command admits only three exact protocol forms', () => {
  assert.deepEqual(parseReleaseSshCommand('inventory'), { operation: 'inventory' });
  assert.deepEqual(parseReleaseSshCommand('submit'), { operation: 'submit' });
  assert.deepEqual(parseReleaseSshCommand(`status ${id}`), { operation: 'status', id });
  for (const command of [
    undefined,
    null,
    '',
    ' inventory',
    'inventory ',
    'inventory\n',
    'inventory\r',
    'inventory\0',
    'Inventory',
    'submit x',
    'status',
    `status  ${id}`,
    `status\t${id}`,
    `status ${id.toUpperCase()}`,
    `status ${id}\n`,
    `status ${randomUUID()} x`,
    'status 01234567-89ab-1cde-8fab-0123456789ab',
    'sh',
    'scp -t /tmp/file',
    'internal-sftp',
    'exit',
    'inventory;id',
    'inventory && id',
    '$(id)',
    '`id`',
    'inventory | cat',
    '-N',
    '-L 22:localhost:22',
  ])
    assert.throws(() => parseReleaseSshCommand(command), hasCode('COMMAND_NOT_ALLOWED'));
});

test('production invocation rejects arguments and never accepts a socket environment override', () => {
  assert.deepEqual(
    productionGatewayInvocation([], {
      SSH_ORIGINAL_COMMAND: 'inventory',
      MAXIM_RELEASE_SOCKET: '/tmp/evil.sock',
      RELEASE_CONTROL_SOCKET: '/tmp/evil.sock',
      PATH: '/evil',
    }),
    { command: 'inventory', socketPath: '/run/maxim-release/control.sock' },
  );
  assert.equal(RELEASE_CONTROL_SOCKET, '/run/maxim-release/control.sock');
  assert.throws(
    () => productionGatewayInvocation(['inventory'], {}),
    hasCode('ARGUMENTS_NOT_ALLOWED'),
  );
});

test('stdin accepts complete raw byte stream at the exact limit before JSON validation', async () => {
  const wire = Buffer.from(JSON.stringify(request));
  const padded = Buffer.concat([wire, Buffer.alloc(MAX_SUBMIT_BYTES - wire.length, 32)]);
  assert.deepEqual(
    await readSubmitInput(Readable.from([padded.subarray(0, 31), padded.subarray(31)])),
    request,
  );
  await assert.rejects(
    readSubmitInput(Readable.from([padded, Buffer.from(' ')])),
    hasCode('INPUT_TOO_LARGE'),
  );
});

test('stdin rejects malformed UTF-8, JSON, extra JSON and unvalidated fields', async () => {
  for (const bytes of [
    Buffer.from('{'),
    Buffer.from(`${JSON.stringify(request)}{}`),
    Buffer.from(JSON.stringify({ ...request, extra: 'private input' })),
    Buffer.from(JSON.stringify({ ...request, id: id.toUpperCase() })),
    Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xc3]), Buffer.from('"}')]),
    Buffer.from([0xff]),
    Buffer.from(''),
  ])
    await assert.rejects(readSubmitInput(Readable.from([bytes])), hasCode('INPUT_INVALID'));
  const textStream = new PassThrough();
  textStream.setEncoding('utf8');
  const result = readSubmitInput(textStream);
  textStream.end(JSON.stringify(request));
  await assert.rejects(result, hasCode('INPUT_INVALID'));
});

test('stdin has bounded EOF wait and reports error or close without disclosing input', async () => {
  const pending = new PassThrough();
  await assert.rejects(readSubmitInput(pending, { timeoutMs: 10 }), hasCode('INPUT_TIMEOUT'));
  assert.equal(pending.destroyed, true);
  const failed = new PassThrough();
  const failure = readSubmitInput(failed);
  failed.destroy(new Error('secret stdin failure'));
  await assert.rejects(failure, hasCode('INPUT_FAILED'));
  const closed = new PassThrough();
  const close = readSubmitInput(closed);
  closed.destroy();
  await assert.rejects(close, hasCode('INPUT_CLOSED'));
});

test('response enforces one bounded JSON line and raw trailing whitespace', () => {
  assert.deepEqual(
    validateControlResponse(Buffer.concat([encoded(success), Buffer.from(' \t\r\n')])),
    success,
  );
  const base = encoded(success);
  const boundary = Buffer.concat([base, Buffer.alloc(MAX_CONTROL_WIRE_BYTES - base.length, 32)]);
  assert.deepEqual(validateControlResponse(boundary), success);
  assert.throws(
    () => validateControlResponse(Buffer.concat([boundary, Buffer.from(' ')])),
    hasCode('RESPONSE_TOO_LARGE'),
  );
  assert.throws(
    () => validateControlResponse(Buffer.from(JSON.stringify(success))),
    hasCode('RESPONSE_INCOMPLETE'),
  );
  for (const bytes of [
    Buffer.concat([base, encoded(success)]),
    Buffer.concat([base, Buffer.from([0xa0])]),
    Buffer.concat([base, Buffer.from('x')]),
    Buffer.from([0xff, 10]),
    encoded({ schemaVersion: 1, ok: true }),
    encoded({ ...success, extra: 'private' }),
    encoded({ schemaVersion: 1, ok: false, error: { code: 'FAILED', message: 'private' } }),
    encoded({ schemaVersion: 1, ok: false, error: { code: 'private message' } }),
    encoded({ schemaVersion: 2, ok: false, error: { code: 'FAILED' } }),
  ])
    assert.throws(() => validateControlResponse(bytes), hasCode('RESPONSE_INVALID'));
  const safeError = { schemaVersion: 1, ok: false, error: { code: 'UNRESOLVED_REVIEW' } };
  assert.deepEqual(validateControlResponse(encoded(safeError)), safeError);
});

test('real Unix peer receives inventory frame without waiting for stdin or client EOF', async () => {
  const input = new PassThrough();
  await withSocket(
    async (socketPath) => {
      assert.deepEqual(
        await runReleaseGateway({ command: 'inventory', input, socketPath }),
        success,
      );
      assert.equal(input.readableEnded, false);
    },
    (socket) =>
      onFrame(socket, (bytes) => {
        assert.deepEqual(bytes, encoded({ operation: 'inventory' }));
        socket.end(encoded(success));
      }),
  );
  input.destroy();
});

test('real Unix peer receives validated submit and status identities', async () => {
  let index = 0;
  await withSocket(
    async (socketPath) => {
      assert.deepEqual(
        await runReleaseGateway({
          command: 'submit',
          input: Readable.from([Buffer.from(JSON.stringify(request))]),
          socketPath,
        }),
        success,
      );
      assert.deepEqual(await runReleaseGateway({ command: `status ${id}`, socketPath }), success);
    },
    (socket) =>
      onFrame(socket, (bytes) => {
        assert.deepEqual(
          JSON.parse(bytes.toString('utf8')),
          index++ === 0 ? { operation: 'submit', request } : { operation: 'status', id },
        );
        socket.end(encoded(success));
      }),
  );
});

test('fragmented multibyte response is decoded after peer EOF', async () => {
  const value = { schemaVersion: 1, ok: true, result: { note: 'Готово' } };
  const wire = encoded(value);
  const split = wire.indexOf(Buffer.from('Г')) + 1;
  await withSocket(
    async (socketPath) => {
      assert.deepEqual(
        await exchangeControlFrame({ operation: 'inventory' }, { socketPath }),
        value,
      );
    },
    (socket) =>
      onFrame(socket, () => {
        socket.write(wire.subarray(0, split));
        setImmediate(() => socket.end(wire.subarray(split)));
      }),
  );
});

test('real socket cannot hide extra frame or a response that never ends', async () => {
  await withSocket(
    async (socketPath) => {
      await assert.rejects(
        exchangeControlFrame({ operation: 'inventory' }, { socketPath }),
        hasCode('RESPONSE_INVALID'),
      );
    },
    (socket) =>
      onFrame(socket, () => socket.end(Buffer.concat([encoded(success), encoded(success)]))),
  );
  await withSocket(
    async (socketPath) => {
      await assert.rejects(
        exchangeControlFrame({ operation: 'inventory' }, { socketPath, timeoutMs: 20 }),
        hasCode('RESPONSE_TIMEOUT'),
      );
    },
    (socket) => onFrame(socket, () => socket.write(encoded(success))),
  );
  await withSocket(
    async (socketPath) => {
      await assert.rejects(
        exchangeControlFrame({ operation: 'inventory' }, { socketPath }),
        hasCode('RESPONSE_TOO_LARGE'),
      );
    },
    (socket) => onFrame(socket, () => socket.end(Buffer.alloc(MAX_CONTROL_WIRE_BYTES + 1, 32))),
  );
});

test('missing or incomplete socket produces fixed failure code', async () => {
  await assert.rejects(
    exchangeControlFrame(
      { operation: 'inventory' },
      { socketPath: join(tmpdir(), `${randomUUID()}.sock`) },
    ),
    hasCode('SERVICE_UNAVAILABLE'),
  );
  await withSocket(
    async (socketPath) => {
      await assert.rejects(
        exchangeControlFrame({ operation: 'inventory' }, { socketPath }),
        hasCode('RESPONSE_INCOMPLETE'),
      );
    },
    (socket) => onFrame(socket, () => socket.end('{}')),
  );
});

test('CLI refusal prints only bounded safe JSON without echoing command or arguments', () => {
  for (const [args, command, code] of [
    [[], 'inventory; secret-command', 'COMMAND_NOT_ALLOWED'],
    [['private-argument'], 'inventory', 'ARGUMENTS_NOT_ALLOWED'],
  ]) {
    const child = spawnSync(
      process.execPath,
      [new URL('./release-service-gateway.mjs', import.meta.url).pathname, ...args],
      {
        input: 'private stdin',
        encoding: 'utf8',
        timeout: 5000,
        env: { PATH: process.env.PATH, SSH_ORIGINAL_COMMAND: command },
      },
    );
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    assert.deepEqual(JSON.parse(child.stdout), { schemaVersion: 1, ok: false, error: { code } });
  }
});
