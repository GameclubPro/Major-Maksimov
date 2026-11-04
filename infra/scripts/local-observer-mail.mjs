import { Socket } from 'node:net';
import nodemailer from 'nodemailer';

const ADDRESS = '73budchenko@mail.ru';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DEADLINE_MS = 30_000;
const MAX_MESSAGE_BYTES = 8192;
const REASONS = Object.freeze({
  RECEIPT_DELAY: 'Обработка входящих событий задерживается.',
  ACTION_LATENCY: 'Действия ботов выполняются с повышенной задержкой.',
  BOT_DISCONNECTED: 'Есть боты без подтверждённого подключения.',
  OBSERVATION_LOST: 'Не удаётся получить наблюдения за работой ботов.',
  STALE_OBSERVATION: 'Данные наблюдения устарели.',
  PARTIAL_OBSERVATION: 'Получена неполная сводка наблюдений.',
  WORKER_OBSERVATION_MISSING: 'Не получено подтверждение работы одной или нескольких ролей.',
  CRITICAL_RUNTIME: 'Сводка сообщает о критическом состоянии.',
});
const COUNTS = Object.freeze({
  affectedBots: 'Ботов, требующих внимания',
  totalBots: 'Ботов в сводке',
  pending: 'Ожидающих задач',
  oldestPendingAgeMs: 'Возраст самой старой ожидающей задачи, мс',
});

function exact(value, required, optional = []) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((entry) => 'value' in entry) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function timestamp(value) {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function valid(input) {
  if (
    !exact(input, ['smtp', 'event']) ||
    !exact(input.smtp, ['username', 'password', 'from', 'to'])
  )
    return false;
  const { smtp, event } = input;
  if (
    smtp.username !== ADDRESS ||
    smtp.from !== ADDRESS ||
    smtp.to !== ADDRESS ||
    typeof smtp.password !== 'string' ||
    Buffer.byteLength(smtp.password) < 1 ||
    Buffer.byteLength(smtp.password) > 1024 ||
    Array.from(smtp.password).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  )
    return false;
  if (
    !exact(event, ['id', 'kind', 'startedAt', 'observedAt', 'reasonCodes'], ['counts']) ||
    typeof event.id !== 'string' ||
    event.id.length !== 36 ||
    !UUID.test(event.id) ||
    !['PROBLEM', 'RECOVERY'].includes(event.kind) ||
    !timestamp(event.startedAt) ||
    !timestamp(event.observedAt) ||
    Date.parse(event.observedAt) < Date.parse(event.startedAt) ||
    !Array.isArray(event.reasonCodes) ||
    event.reasonCodes.length < 1 ||
    event.reasonCodes.length > Object.keys(REASONS).length ||
    Array.from(event.reasonCodes).some(
      (reason) => typeof reason !== 'string' || !Object.hasOwn(REASONS, reason),
    ) ||
    new Set(event.reasonCodes).size !== event.reasonCodes.length
  )
    return false;
  if (!Object.hasOwn(event, 'counts')) return true;
  if (!exact(event.counts, Object.keys(COUNTS))) return false;
  for (const key of Object.keys(COUNTS)) {
    if (!Number.isSafeInteger(event.counts[key]) || event.counts[key] < 0) return false;
  }
  return event.counts.affectedBots <= event.counts.totalBots;
}

function message(event) {
  const recovery = event.kind === 'RECOVERY';
  const lines = [
    recovery
      ? 'По данным последней сводки критическое состояние завершилось.'
      : 'В работе ботов требуется внимание.',
    '',
    `Начало наблюдаемой проблемы: ${event.startedAt}`,
    `Последнее наблюдение: ${event.observedAt}`,
    '',
    recovery ? 'Причины предыдущего уведомления:' : 'Причины уведомления:',
    ...event.reasonCodes.map((reason) => `• ${REASONS[reason]}`),
  ];
  if (event.counts)
    lines.push(
      '',
      ...Object.entries(COUNTS).map(([key, label]) => `${label}: ${event.counts[key]}`),
    );
  lines.push('', 'Подробности доступны в Safety Desk, раздел «Наблюдения».');
  const text = `${lines.join('\n')}\n`;
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error('MESSAGE_BOUND');
  return {
    from: { name: 'MAXIM', address: ADDRESS },
    to: ADDRESS,
    envelope: { from: ADDRESS, to: [ADDRESS] },
    subject: recovery ? '[MAXIM] Работа восстановлена' : '[MAXIM] Требуется внимание',
    text,
    textEncoding: 'base64',
    messageId: `<maxim-observer.${event.id}@mail.ru>`,
    date: new Date(event.observedAt),
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

function silentLogger(stage) {
  const logger = Object.fromEntries(
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((level) => [level, () => {}]),
  );
  // FLAG: Socket failures can be labelled CONN even after DATA. Retain only this
  // boolean from the pinned library's debug callback; never retain or print SMTP/auth/content logs.
  logger.debug = (data, text) => {
    if (data?.tnx === 'client' && text === 'DATA') stage.dataAttempted = true;
  };
  return logger;
}

function outcome(value, reasonCode, messageId) {
  return { outcome: value, reasonCode, ...(messageId ? { messageId } : {}) };
}

function failed(error, stage, messageId) {
  const command = typeof error?.command === 'string' ? error.command : '';
  const refused =
    Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599;
  if (stage.dataAttempted || command === 'DATA') {
    // FLAG: A final negative DATA reply proves rejection, although payload bytes
    // were sent. This outcome names proved non-acceptance; it never authorizes an adapter retry.
    return refused && command === 'DATA'
      ? outcome('REJECTED_BEFORE_SEND', 'SMTP_REJECTED', messageId)
      : outcome('UNCERTAIN', 'SMTP_OUTCOME_UNKNOWN', messageId);
  }
  if (error?.code === 'EAUTH')
    return outcome('REJECTED_BEFORE_SEND', 'SMTP_AUTH_REJECTED', messageId);
  if (refused && ['CONN', 'EHLO', 'HELO', 'MAIL FROM', 'RCPT TO'].includes(command))
    return outcome('REJECTED_BEFORE_SEND', 'SMTP_REJECTED', messageId);
  if (
    ['CONN', 'EHLO', 'HELO', 'AUTH PLAIN', 'AUTH LOGIN', 'MAIL FROM', 'RCPT TO'].includes(command)
  )
    return outcome('REJECTED_BEFORE_SEND', 'SMTP_UNAVAILABLE', messageId);
  return outcome('UNCERTAIN', 'SMTP_OUTCOME_UNKNOWN', messageId);
}

// FLAG: This adapter owns one attempt only. The observer persists notification identity
// and any uncertain outcome; neither a socket error nor this stable Message-ID permits replay.
export async function sendObserverMail(
  input,
  { transportFactory = (options) => nodemailer.createTransport(options) } = {},
) {
  try {
    if (!valid(input)) return outcome('REJECTED_BEFORE_SEND', 'INVALID_INPUT');
  } catch {
    return outcome('REJECTED_BEFORE_SEND', 'INVALID_INPUT');
  }
  const mail = message(input.event);
  const stage = { dataAttempted: false };
  const socket = new Socket();
  socket.on('error', () => {});
  let transport;
  let timer;
  try {
    transport = transportFactory({
      host: 'smtp.mail.ru',
      port: 465,
      secure: true,
      ignoreTLS: false,
      opportunisticTLS: false,
      name: 'local-observer.maxim.invalid',
      auth: { user: input.smtp.username, pass: input.smtp.password },
      authMethod: 'PLAIN',
      forceAuth: true,
      pool: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      dnsTimeout: 5000,
      maxResponseSize: 16_384,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.mail.ru' },
      socket,
      debug: true,
      logger: silentLogger(stage),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!transport || typeof transport.sendMail !== 'function')
      throw new Error('TRANSPORT_UNAVAILABLE');
  } catch {
    socket.destroy();
    return outcome('REJECTED_BEFORE_SEND', 'SMTP_UNAVAILABLE', mail.messageId);
  }
  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        socket.destroy();
        resolve(
          stage.dataAttempted
            ? outcome('UNCERTAIN', 'SMTP_OUTCOME_UNKNOWN', mail.messageId)
            : outcome('REJECTED_BEFORE_SEND', 'SMTP_UNAVAILABLE', mail.messageId),
        );
      }, DEADLINE_MS);
    });
    const attempt = Promise.resolve()
      .then(() => transport.sendMail(mail))
      .then(
        (info) => {
          const accepted =
            Array.isArray(info?.accepted) &&
            info.accepted.length === 1 &&
            info.accepted[0] === ADDRESS;
          const rejected = Array.isArray(info?.rejected) && info.rejected.length === 0;
          return accepted &&
            rejected &&
            info.messageId === mail.messageId &&
            typeof info.response === 'string' &&
            info.response.length <= 16_384 &&
            /^250(?:[ -]|$)/u.test(info.response)
            ? outcome('SENT', 'SMTP_ACCEPTED', mail.messageId)
            : outcome('UNCERTAIN', 'SMTP_OUTCOME_UNKNOWN', mail.messageId);
        },
        (error) => failed(error, stage, mail.messageId),
      );
    return await Promise.race([attempt, deadline]);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    try {
      transport.close?.();
    } catch {
      /* the recorded send outcome remains authoritative */
    }
  }
}
