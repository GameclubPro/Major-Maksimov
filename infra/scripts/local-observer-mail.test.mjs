import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:tls';
import { after, before } from 'node:test';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { sendObserverMail } from './local-observer-mail.mjs';

const ADDRESS = '73budchenko@mail.ru';
const EVENT_ID = '00000000-0000-4000-8000-000000000001';
const MESSAGE_ID = `<maxim-observer.${EVENT_ID}@mail.ru>`;
const password = 'fixture-app-password-only';
let certificates;

function input(kind = 'PROBLEM') {
  return {
    smtp: { username: ADDRESS, password, from: ADDRESS, to: ADDRESS },
    event: {
      id: EVENT_ID,
      kind,
      startedAt: '2026-11-04T05:00:00.000Z',
      observedAt: '2026-11-04T05:02:00.000Z',
      reasonCodes: ['RECEIPT_DELAY', 'WORKER_OBSERVATION_MISSING'],
      counts: {
        affectedBots: 1,
        totalBots: 3,
        pending: 25,
        oldestPendingAgeMs: 35_000,
      },
    },
  };
}

before(() => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'maxim-observer-smtp-tls-'));
  const invoke = (args) => {
    const result = spawnSync('/usr/bin/openssl', args, {
      cwd: directory,
      stdio: 'ignore',
      timeout: 10_000,
    });
    assert.equal(result.status, 0, 'ephemeral TLS fixture generation failed');
  };
  try {
    invoke([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.crt',
      '-subj',
      '/CN=MAXIM ephemeral SMTP test CA',
      '-days',
      '1',
      '-sha256',
    ]);
    invoke([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'server.key',
      '-out',
      'server.csr',
      '-subj',
      '/CN=smtp.mail.ru',
    ]);
    fs.writeFileSync(
      join(directory, 'server.ext'),
      [
        'basicConstraints=CA:FALSE',
        'keyUsage=digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
        'subjectAltName=DNS:smtp.mail.ru',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    invoke([
      'x509',
      '-req',
      '-in',
      'server.csr',
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      'server.crt',
      '-days',
      '1',
      '-sha256',
      '-extfile',
      'server.ext',
    ]);
    for (const name of ['ca.key', 'server.key']) fs.chmodSync(join(directory, name), 0o600);
    certificates = {
      directory,
      ca: fs.readFileSync(join(directory, 'ca.crt')),
      key: fs.readFileSync(join(directory, 'server.key')),
      cert: fs.readFileSync(join(directory, 'server.crt')),
    };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
});

after(() => {
  if (certificates) fs.rmSync(certificates.directory, { recursive: true, force: true });
});

async function smtpFixture(scenario = 'accepted') {
  const sockets = new Set();
  const evidence = { attempts: 0, dataCommands: 0, payloads: [], commands: [] };
  const server = createServer(
    { key: certificates.key, cert: certificates.cert, minVersion: 'TLSv1.2' },
    (socket) => {
      sockets.add(socket);
      evidence.attempts += 1;
      let bytes = Buffer.alloc(0);
      let data = false;
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      socket.write('220 local fixture ESMTP\r\n');
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 16_384) {
          socket.destroy();
          return;
        }
        if (data) {
          if (scenario === 'disconnect-body') {
            socket.destroy();
            return;
          }
          const end = bytes.indexOf('\r\n.\r\n');
          if (end < 0) return;
          evidence.payloads.push(bytes.subarray(0, end).toString('utf8'));
          bytes = bytes.subarray(end + 5);
          data = false;
          if (scenario === 'disconnect-after-dot') {
            socket.destroy();
            return;
          }
          if (scenario === 'hang-after-dot') return;
          if (scenario === 'reject-after-dot') socket.write('550 5.7.1 fixture rejection\r\n');
          else if (scenario === 'late-quit-refusal')
            socket.write('250 2.0.0 accepted\r\n550 5.5.1 late QUIT refusal\r\n');
          else socket.write('250 2.0.0 accepted\r\n');
        }
        while (bytes.includes('\r\n') && !data) {
          const newline = bytes.indexOf('\r\n');
          const line = bytes.subarray(0, newline).toString('ascii');
          bytes = bytes.subarray(newline + 2);
          const command = line.split(' ', 1)[0];
          evidence.commands.push(command);
          if (line.startsWith('EHLO '))
            socket.write('250-fixture\r\n250-AUTH PLAIN\r\n250 SIZE 16384\r\n');
          else if (line.startsWith('AUTH PLAIN '))
            socket.write(
              scenario === 'auth-refused'
                ? '535 5.7.8 invalid login\r\n'
                : '235 2.7.0 authenticated\r\n',
            );
          else if (line === `MAIL FROM:<${ADDRESS}>`) socket.write('250 2.1.0 sender accepted\r\n');
          else if (line === `RCPT TO:<${ADDRESS}>`) {
            if (scenario === 'disconnect-before-data') {
              socket.destroy();
              return;
            }
            socket.write(
              scenario === 'recipient-refused'
                ? '550 5.1.1 recipient refused\r\n'
                : '250 2.1.5 recipient accepted\r\n',
            );
          } else if (line === 'DATA') {
            evidence.dataCommands += 1;
            if (scenario === 'data-refused') socket.write('554 5.7.1 DATA refused\r\n');
            else {
              data = true;
              socket.write('354 send message\r\n');
            }
          } else if (line === 'QUIT') socket.end('221 closing\r\n');
          else {
            socket.write('500 unexpected fixture command\r\n');
          }
        }
      });
    },
  );
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    evidence,
    transportFactory(options) {
      assert.equal(options.host, 'smtp.mail.ru');
      assert.equal(options.port, 465);
      assert.equal(options.secure, true);
      assert.equal(options.pool, false);
      assert.equal(options.ignoreTLS, false);
      assert.equal(options.opportunisticTLS, false);
      assert.deepEqual(options.tls, {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        servername: 'smtp.mail.ru',
      });
      assert.equal(options.auth.user, ADDRESS);
      assert.equal(options.auth.pass, password);
      assert.equal(options.maxResponseSize, 16_384);
      assert.equal(options.connectionTimeout, 10_000);
      assert.equal(options.socketTimeout, 10_000);
      assert.equal(options.greetingTimeout, 10_000);
      assert.equal(options.dnsTimeout, 5000);
      assert.equal(options.disableFileAccess, true);
      assert.equal(options.disableUrlAccess, true);
      return nodemailer.createTransport({
        ...options,
        host: '127.0.0.1',
        port,
        connectionTimeout: 1000,
        greetingTimeout: 1000,
        socketTimeout: 500,
        tls: { ...options.tls, ...(scenario === 'untrusted-ca' ? {} : { ca: certificates.ca }) },
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('invalid config, header injection and unapproved event content never create a transport', async () => {
  const mutations = [
    (value) => {
      value.smtp.host = 'attacker.invalid';
    },
    (value) => {
      value.smtp.port = 25;
    },
    (value) => {
      value.smtp.tls = { rejectUnauthorized: false };
    },
    (value) => {
      value.smtp.username = 'other@mail.ru';
    },
    (value) => {
      value.smtp.from += '\r\nBcc: other@mail.ru';
    },
    (value) => {
      value.smtp.to = ['other@mail.ru'];
    },
    (value) => {
      value.smtp.password = '';
    },
    (value) => {
      value.smtp.password = 'x'.repeat(1025);
    },
    (value) => {
      value.event.id += '\n';
    },
    (value) => {
      value.event.reasonCodes = ['private-message-text'];
    },
    (value) => {
      value.event.reasonCodes = ['RECEIPT_DELAY', 'RECEIPT_DELAY'];
    },
    (value) => {
      value.event.message = 'private source message';
    },
    (value) => {
      value.event.observedAt = 'invalid date';
    },
    (value) => {
      value.event.startedAt = '2026-11-04T05:03:00.000Z';
    },
    (value) => {
      value.event.counts.affectedBots = 4;
    },
    (value) => {
      value.event.counts.pending = -1;
    },
    (value) => {
      value.event.counts.pending = Number.MAX_SAFE_INTEGER + 1;
    },
    (value) => {
      delete value.event.counts.totalBots;
    },
    (value) => {
      value.event.counts.extra = 1;
    },
    (value) => {
      value.event.pending = 25;
    },
  ];
  let created = 0;
  for (const mutate of mutations) {
    const value = input();
    mutate(value);
    assert.deepEqual(
      await sendObserverMail(value, {
        transportFactory() {
          created += 1;
          throw new Error('not called');
        },
      }),
      { outcome: 'REJECTED_BEFORE_SEND', reasonCode: 'INVALID_INPUT' },
    );
  }
  assert.equal(created, 0);
});

test('verified local TLS SMTP accepts fixed Russian content and stable event Message-ID once', async () => {
  const fixture = await smtpFixture();
  try {
    assert.deepEqual(await sendObserverMail(input(), fixture), {
      outcome: 'SENT',
      reasonCode: 'SMTP_ACCEPTED',
      messageId: MESSAGE_ID,
    });
    assert.equal(fixture.evidence.attempts, 1);
    assert.equal(fixture.evidence.dataCommands, 1);
    assert.equal(fixture.evidence.payloads.length, 1);
    const [payload] = fixture.evidence.payloads;
    assert.match(payload, new RegExp(`Message-ID: <maxim-observer\\.${EVENT_ID}@mail\\.ru>`));
    assert.match(payload, /Content-Type: text\/plain; charset=utf-8/iu);
    assert.ok(Buffer.byteLength(payload) <= 16_384);
    const body = Buffer.from(
      payload.slice(payload.indexOf('\r\n\r\n') + 4).replaceAll('\r\n', ''),
      'base64',
    ).toString('utf8');
    assert.match(body, /В работе ботов требуется внимание/u);
    assert.match(body, /Обработка входящих событий задерживается/u);
    assert.match(body, /Ботов, требующих внимания: 1/u);
    assert.equal(payload.includes(password), false);
    assert.equal(body.includes('WORKER_OBSERVATION_MISSING'), false);
  } finally {
    await fixture.close();
  }
});

test('recovery uses fixed recovery text and retains the given notification identity', async () => {
  const fixture = await smtpFixture();
  try {
    const notification = input('RECOVERY');
    delete notification.event.counts;
    assert.equal((await sendObserverMail(notification, fixture)).outcome, 'SENT');
    const [payload] = fixture.evidence.payloads;
    const body = Buffer.from(
      payload.slice(payload.indexOf('\r\n\r\n') + 4).replaceAll('\r\n', ''),
      'base64',
    ).toString('utf8');
    assert.match(body, /критическое состояние завершилось/u);
    assert.match(body, /Причины предыдущего уведомления/u);
    assert.match(payload, /Message-ID: <maxim-observer\./u);
  } finally {
    await fixture.close();
  }
});

test('definite authentication, recipient and DATA refusals never retry and expose only a fixed reason', async () => {
  for (const [scenario, reasonCode] of [
    ['auth-refused', 'SMTP_AUTH_REJECTED'],
    ['recipient-refused', 'SMTP_REJECTED'],
    ['data-refused', 'SMTP_REJECTED'],
    ['reject-after-dot', 'SMTP_REJECTED'],
    ['disconnect-before-data', 'SMTP_UNAVAILABLE'],
    ['untrusted-ca', 'SMTP_UNAVAILABLE'],
  ]) {
    const fixture = await smtpFixture(scenario);
    try {
      assert.deepEqual(
        await sendObserverMail(input(), fixture),
        { outcome: 'REJECTED_BEFORE_SEND', reasonCode, messageId: MESSAGE_ID },
        scenario,
      );
      assert.ok(fixture.evidence.attempts <= 1, scenario);
      assert.ok(fixture.evidence.dataCommands <= 1, scenario);
      if (scenario === 'auth-refused' || scenario === 'untrusted-ca')
        assert.equal(fixture.evidence.dataCommands, 0);
    } finally {
      await fixture.close();
    }
  }
});

test('disconnects and timeout during DATA or after its terminator stay uncertain without another attempt', async () => {
  for (const scenario of ['disconnect-body', 'disconnect-after-dot', 'hang-after-dot']) {
    const fixture = await smtpFixture(scenario);
    try {
      assert.deepEqual(
        await sendObserverMail(input(), fixture),
        { outcome: 'UNCERTAIN', reasonCode: 'SMTP_OUTCOME_UNKNOWN', messageId: MESSAGE_ID },
        scenario,
      );
      assert.equal(fixture.evidence.attempts, 1);
      assert.equal(fixture.evidence.dataCommands, 1);
    } finally {
      await fixture.close();
    }
  }
});

test('a late QUIT failure cannot overturn a proved 250 DATA acceptance', async () => {
  const fixture = await smtpFixture('late-quit-refusal');
  try {
    assert.equal((await sendObserverMail(input(), fixture)).outcome, 'SENT');
    assert.equal(fixture.evidence.payloads.length, 1);
  } finally {
    await fixture.close();
  }
});

test('absolute deadline destroys only the adapter socket and records uncertainty after DATA', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let socket;
  let closed = 0;
  const promise = sendObserverMail(input(), {
    transportFactory(options) {
      socket = options.socket;
      return {
        sendMail() {
          options.logger.debug({ tnx: 'client' }, 'DATA');
          return new Promise(() => {});
        },
        close() {
          closed += 1;
        },
      };
    },
  });
  await Promise.resolve();
  t.mock.timers.tick(30_001);
  assert.deepEqual(await promise, {
    outcome: 'UNCERTAIN',
    reasonCode: 'SMTP_OUTCOME_UNKNOWN',
    messageId: MESSAGE_ID,
  });
  assert.equal(socket.destroyed, true);
  assert.equal(closed, 1);
});

test('transport setup and unknown send failures are sanitized and never retried', async () => {
  assert.deepEqual(
    await sendObserverMail(input(), {
      transportFactory() {
        throw new Error(password);
      },
    }),
    { outcome: 'REJECTED_BEFORE_SEND', reasonCode: 'SMTP_UNAVAILABLE', messageId: MESSAGE_ID },
  );
  let attempts = 0;
  assert.deepEqual(
    await sendObserverMail(input(), {
      transportFactory() {
        return {
          sendMail() {
            attempts += 1;
            throw new Error(password);
          },
        };
      },
    }),
    { outcome: 'UNCERTAIN', reasonCode: 'SMTP_OUTCOME_UNKNOWN', messageId: MESSAGE_ID },
  );
  assert.equal(attempts, 1);
});
