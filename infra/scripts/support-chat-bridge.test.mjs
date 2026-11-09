import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import bridge from './support-chat-bridge.cjs';
import { supportChatRemote, verifySupportContainer } from './support-chat-remote.mjs';
import { answerSupport, knowledge, SUPPORT_ANSWER_FOOTER } from './support-llm-client.mjs';
import { SUPPORT_MODEL } from './support-llm-profile.mjs';
const {
  CHAT_ID,
  sourceMessage,
  supportInteraction,
  PilotFence,
  PilotHistory,
  deliverAnswer,
  validateSupportBotCatalog,
  renderSupportMessage,
} = bridge;
const row = (text = 'Как подключить бота?') => ({
  recipient: { chat_id: CHAT_ID },
  sender: { user_id: 42, is_bot: false },
  timestamp: Date.now(),
  body: { mid: 'question-1', text },
});

test('PC profile and injected host bridge require the same pinned support model', () => {
  assert.equal(bridge.MODEL_SHA, SUPPORT_MODEL.sha256);
});

test('only the two owner-approved chats can select a bridge before any remote access', async () => {
  assert.deepEqual(bridge.CHAT_IDS, ['-78271094414679', '-79143082792210']);
  await assert.rejects(supportChatRemote('preview', '-123'), /support_chat_refused/u);
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          '-e',
          `require(${JSON.stringify(fileURLToPath(new URL('./support-chat-bridge.cjs', import.meta.url)))})`,
        ],
        {
          env: { ...process.env, SUPPORT_CHAT_ID: '-123' },
          stdio: 'pipe',
        },
      ),
    (error) => /support_chat_refused/u.test(error.stderr.toString()),
  );
});

test('stdin and eval imports stay inert while the injected eval entrypoint still runs', async () => {
  const remoteUrl = new URL('./support-chat-remote.mjs', import.meta.url).href;
  const script = `await import(${JSON.stringify(remoteUrl)}); console.log('import-only');`;
  for (const args of [
    ['--input-type=module', '-'],
    ['--input-type=module', '-e', script],
  ])
    assert.equal(
      execFileSync(process.execPath, args, { input: script, encoding: 'utf8' }).trim(),
      'import-only',
    );
  const code = await readFile(new URL('./support-chat-bridge.cjs', import.meta.url), 'utf8');
  assert.throws(
    () =>
      execFileSync(process.execPath, ['-e', code], {
        env: { ...process.env, SUPPORT_BOT_CATALOG: 'null' },
        stdio: 'pipe',
      }),
    (error) => error.stderr.toString().trim() === 'support_bot_catalog_refused',
  );
});

test('all eight public bot names become exact catalog links without linking the AI footer', () => {
  const text = `${knowledge.botCatalog.map((bot) => bot.name).join('\n')}\n\n${SUPPORT_ANSWER_FOOTER}`;
  const presented = renderSupportMessage(text, knowledge.botCatalog);
  assert.equal(presented.textFormat, 'html');
  assert.equal((presented.text.match(/<a href=/gu) ?? []).length, 8);
  for (const bot of knowledge.botCatalog)
    assert.ok(presented.text.includes(`<a href="${bot.url}">${bot.name}</a>`), bot.name);
  assert.ok(presented.text.endsWith(SUPPORT_ANSWER_FOOTER));
});

test('the screenshot catalog retains eight item lines and eight links in the final MAX payload', async () => {
  const answer = await answerSupport({
    text: 'Какие боты есть?',
    key: 'unused',
    endpoint: 'http://127.0.0.1:1',
  });
  const presented = renderSupportMessage(answer.text, knowledge.botCatalog);
  assert.equal(presented.textFormat, 'html');
  assert.equal((presented.text.match(/<a href=/gu) ?? []).length, 8);
  assert.equal(
    presented.text.split('\n').filter((line) => line.startsWith('• <a href=')).length,
    8,
  );
  for (const bot of knowledge.botCatalog)
    assert.ok(presented.text.includes(`<a href="${bot.url}">${bot.name}</a>`), bot.name);
  assert.ok(presented.text.includes('\n\nРезервные модераторы:\n'));
  assert.ok(presented.text.endsWith(`\n\n${SUPPORT_ANSWER_FOOTER}`));
  assert.doesNotMatch(presented.text, /MAXIM/iu);
});

test('directory bot items retain all eight links after introductory project aliases', () => {
  for (const introduction of [
    'Я — ИИ-помощник «Майор Максимов». Вот боты проекта:',
    'В проекте «Майор Максимов» доступны восемь ботов:',
    'Каталог ботов «Майор Максимов»:',
  ]) {
    const items = knowledge.botCatalog.map((bot) => `• ${bot.name} — ${bot.kind}`).join('\n');
    const presented = renderSupportMessage(
      `${introduction}\n\n${items}\n\n${SUPPORT_ANSWER_FOOTER}`,
      knowledge.botCatalog,
    ).text;
    assert.ok(presented.startsWith(`${introduction}\n\n`));
    assert.equal((presented.match(/<a href=/gu) ?? []).length, 8);
    for (const bot of knowledge.botCatalog)
      assert.ok(presented.includes(`• <a href="${bot.url}">${bot.name}</a> —`), bot.name);
    assert.ok(presented.endsWith(`\n\n${SUPPORT_ANSWER_FOOTER}`));
  }
});

test('canonical names and directory items take precedence over earlier prose aliases', () => {
  const canonical = renderSupportMessage(
    'Профиль Ластика; Ластик удаляет старые сообщения.\n\nЛастик\n\nРэкс2 — резервный бот, его точное имя Рэкс 2.',
    knowledge.botCatalog,
  ).text;
  assert.ok(canonical.startsWith('Профиль Ластика; Ластик удаляет старые сообщения.\n\n'));
  assert.ok(canonical.includes('\n<a href="https://max.ru/id613000037577_5_bot">Ластик</a>\n'));
  assert.ok(canonical.includes('Рэкс2 — резервный бот, его точное имя '));
  assert.ok(canonical.endsWith('<a href="https://max.ru/id613070470872_6_bot">Рэкс 2</a>.'));
  for (const marker of ['•', '-', '1.']) {
    const item = renderSupportMessage(
      `Рэкс 2 упомянут во введении.\n${marker} Рэкс2 — резервный модератор.`,
      knowledge.botCatalog,
    ).text;
    assert.ok(item.startsWith('Рэкс 2 упомянут во введении.\n'));
    assert.ok(item.includes(`${marker} <a href="https://max.ru/id613070470872_6_bot">Рэкс2</a>`));
    assert.equal((item.match(/<a href=/gu) ?? []).length, 1);
  }
});

test('bot links escape untrusted markup, prefer full aliases and preserve unrelated words', () => {
  const text =
    'Майор Максимов 2 и Максимов; Рэкс2. Ластика & <img src=x onerror="bad()">. Ластик повторно. _Ластик и Ластиковый.';
  const value = renderSupportMessage(text, knowledge.botCatalog).text;
  assert.ok(value.includes('<a href="https://max.ru/id613070470872_9_bot">Майор Максимов 2</a>'));
  assert.ok(value.includes('<a href="https://max.ru/id613070470872_6_bot">Рэкс2</a>'));
  assert.ok(value.includes('Ластика &amp;'));
  assert.ok(value.includes('<a href="https://max.ru/id613000037577_5_bot">Ластик</a> повторно.'));
  assert.ok(value.includes('&amp; &lt;img src=x onerror=&quot;bad()&quot;&gt;'));
  assert.equal((value.match(/href="https:\/\/max.ru\/id613000037577_5_bot"/gu) ?? []).length, 1);
  assert.ok(value.includes('_Ластик и Ластиковый.'));
  assert.doesNotMatch(value, /<img|<script/iu);
  const inflected = renderSupportMessage('Профиль Ластика.', knowledge.botCatalog).text;
  assert.equal(inflected, 'Профиль <a href="https://max.ru/id613000037577_5_bot">Ластика</a>.');
  const dashed = renderSupportMessage(
    'Рэкс-2 и Максимов-2, Максимова-2; laſtik.',
    knowledge.botCatalog,
  ).text;
  assert.ok(dashed.includes('<a href="https://max.ru/id613070470872_6_bot">Рэкс-2</a>'));
  assert.ok(dashed.includes('<a href="https://max.ru/id613070470872_9_bot">Максимов-2</a>'));
  assert.ok(dashed.includes('<a href="https://max.ru/id613070470872_5_bot">Максимова-2</a>'));
  assert.doesNotMatch(dashed, /href="undefined"/u);
  const numbered = renderSupportMessage('Рэкс №2 и Рэкс 3, Максимов 7.', knowledge.botCatalog).text;
  assert.ok(numbered.includes('<a href="https://max.ru/id613070470872_6_bot">Рэкс №2</a>'));
  assert.ok(numbered.includes('Рэкс 3, Максимов 7.'));
  assert.equal((numbered.match(/<a href=/gu) ?? []).length, 1);
});

test('catalog readiness rejects foreign targets, duplicate identities and ambiguous aliases', () => {
  assert.equal(validateSupportBotCatalog(knowledge.botCatalog), knowledge.botCatalog);
  for (const url of [
    'https://max.ru.evil/bot',
    'https://max.ru/bot?next=bad',
    'https://user@max.ru/bot',
    'javascript:bad',
    'https://max.ru:443/bot',
  ]) {
    const catalog = structuredClone(knowledge.botCatalog);
    catalog[0].url = url;
    assert.throws(() => validateSupportBotCatalog(catalog), /catalog_refused/u, url);
  }
  const ambiguous = structuredClone(knowledge.botCatalog);
  ambiguous[1].aliases.push('максимов');
  assert.throws(() => validateSupportBotCatalog(ambiguous), /catalog_ambiguous/u);
  assert.throws(() => validateSupportBotCatalog(knowledge.botCatalog.slice(1)), /catalog_refused/u);
});

test('expanded HTML budget fails before any client call or SEND fence transition', async () => {
  let calls = 0;
  const runtime = {
    supportBotCatalog: knowledge.botCatalog,
    client: {
      sendMessageImmediateWithId: async () => {
        calls++;
      },
    },
  };
  const settled = [];
  const fence = {
    settle: async (...args) => settled.push(args),
    begin: async () => {
      calls++;
    },
  };
  const result = await deliverAnswer(runtime, fence, { id: 'budget' }, '&'.repeat(1700), {});
  assert.equal(result, 'refused');
  assert.equal(calls, 0);
  assert.deepEqual(settled, [['budget', 'REFUSED', 'PREPARED']]);
});

test('source boundary requires exact test chat, explicit human and fresh creation', () => {
  assert.ok(sourceMessage(row()));
  assert.equal(sourceMessage({ ...row(), recipient: { chat_id: 'another-chat' } }), null);
  assert.equal(sourceMessage({ ...row(), sender: { user_id: 42, is_bot: true } }), null);
  assert.equal(sourceMessage({ ...row(), sender: { user_id: 42 } }), null);
  assert.equal(sourceMessage({ ...row(), timestamp: Date.now() - 181000 }), null);
});

const replyRow = (senderId = 84, isBot = false, text = 'Синтетическая цитата') => ({
  ...row('Привет'),
  link: {
    type: 'reply',
    chat_id: CHAT_ID,
    sender: { user_id: senderId, is_bot: isBot },
    message: { mid: 'earlier-answer', text },
  },
});

test('reply context distinguishes a human, another bot and a confirmed support answer', () => {
  const other = { addressedToSupport: false, replyToOther: true };
  assert.deepEqual(supportInteraction(sourceMessage(replyRow()), '900'), other);
  assert.deepEqual(supportInteraction(sourceMessage(replyRow(901, true)), '900'), other);
  const plainBotReply = sourceMessage(replyRow(900, true));
  assert.deepEqual(supportInteraction(plainBotReply, '900'), other);
  assert.deepEqual(supportInteraction(plainBotReply, '900', new Set(['earlier-answer'])), {
    addressedToSupport: true,
    replyToOther: false,
  });
  const marked = replyRow(900, true, `Проверьте настройки.\n\n${SUPPORT_ANSWER_FOOTER}`);
  assert.deepEqual(supportInteraction(sourceMessage(marked), '900'), {
    addressedToSupport: true,
    replyToOther: false,
  });
  assert.deepEqual(supportInteraction(sourceMessage(marked), null), other);
  assert.deepEqual(
    supportInteraction(
      sourceMessage({ ...marked, link: { ...marked.link, chat_id: '-999' } }),
      '900',
    ),
    other,
  );
  assert.deepEqual(
    supportInteraction(sourceMessage(replyRow(901, true, marked.link.message.text)), '900'),
    other,
  );
  assert.deepEqual(
    supportInteraction(
      sourceMessage(replyRow(900, true, `${marked.link.message.text} ещё`)),
      '900',
    ),
    other,
  );
  assert.ok(!JSON.stringify(sourceMessage(marked)).includes('Проверьте настройки.'));
});

test('mentions use exact selected MAX user identity and bounded compatible markup', () => {
  const raw = row('Помощник, проверь настройки');
  const mention = (userId) => ({ type: 'user_mention', from: 0, length: 8, user_id: userId });
  assert.deepEqual(supportInteraction(sourceMessage(raw), '900'), {
    addressedToSupport: false,
    replyToOther: false,
  });
  for (const metadata of [
    { body: { ...raw.body, markup: [mention(84)] } },
    { text_markup: [{ type: 'user_mention', from: 0, length: 8, user_link: 'user/84' }] },
    {
      body: { ...raw.body, textMarkup: [{ type: 'user_mention', from: 0, length: 8, userId: 84 }] },
    },
  ])
    assert.deepEqual(supportInteraction(sourceMessage({ ...raw, ...metadata }), '900'), {
      addressedToSupport: false,
      replyToOther: true,
    });
  assert.deepEqual(
    supportInteraction(
      sourceMessage({ ...raw, body: { ...raw.body, markup: [mention(900), mention(84)] } }),
      '900',
    ),
    { addressedToSupport: true, replyToOther: false },
  );
});

test('source fingerprint binds reply identity, footer marker and mention target and span', () => {
  const original = replyRow();
  const fingerprint = sourceMessage(original).fingerprint;
  for (const link of [
    { ...original.link, message: { ...original.link.message, mid: 'different-target' } },
    { ...original.link, sender: { user_id: 85, is_bot: false } },
    { ...original.link, sender: { user_id: 84, is_bot: true } },
    { ...original.link, chat_id: '-999' },
    {
      ...original.link,
      message: { ...original.link.message, text: `Ответ.\n\n${SUPPORT_ANSWER_FOOTER}` },
    },
  ])
    assert.notEqual(sourceMessage({ ...original, link }).fingerprint, fingerprint);
  const raw = row('Помощник, проверь');
  const withMention = (userId, from = 0) =>
    sourceMessage({
      ...raw,
      body: { ...raw.body, markup: [{ type: 'user_mention', from, length: 8, user_id: userId }] },
    });
  assert.notEqual(withMention(900).fingerprint, withMention(901).fingerprint);
  assert.notEqual(withMention(900).fingerprint, withMention(900, 1).fingerprint);
  const quotedChange = replyRow();
  quotedChange.link.message.text = 'Другая синтетическая цитата';
  assert.equal(sourceMessage(quotedChange).fingerprint, fingerprint);
});

test('malformed or oversized addressing metadata fails closed', () => {
  const raw = row('Помощник, проверь');
  for (const metadata of [
    { link: null },
    { link: [] },
    { link: { type: 'reply' } },
    { link: { ...replyRow().link, chat_id: null } },
    { link: { ...replyRow().link, sender: { user_id: 84 } } },
    { link: { ...replyRow().link, message: { mid: 'x', text: 'x'.repeat(4097) } } },
    { markup: {} },
    { markup: Array(65).fill({ type: 'bold', from: 0, length: 1 }) },
    { markup: [null] },
    { markup: [{ type: 'user_mention', from: 0, length: 999, user_id: 900 }] },
    { markup: [{ type: 'user_mention', from: 0, length: 1, user_id: 900, user_link: 'user/901' }] },
    { markup: [{ type: 'user_mention', from: 0, length: 1, user_id: 9007199254740992 }] },
    { markup: [{ type: 'user_mention', from: 0, length: 1, user_id: '9'.repeat(31) }] },
  ])
    assert.equal(
      sourceMessage({ ...raw, ...metadata }),
      null,
      JSON.stringify(metadata).slice(0, 180),
    );
});

test('final exact source check refuses addressing edits before SEND and records only confirmed receipts', async () => {
  for (const outcome of ['sent', 'refused', 'unknown', 'receipt-lost']) {
    const raw = replyRow();
    const source = sourceMessage(raw);
    let begun = 0;
    const receipts = [];
    const runtime = {
      options: () => ({}),
      assertSourceAllowed: async () => {},
      assertAccess: async () => {},
      client: {
        getExactMessageRow: async () =>
          outcome === 'refused'
            ? {
                ...raw,
                link: { ...raw.link, message: { ...raw.link.message, mid: 'changed-target' } },
              }
            : raw,
        sendMessageImmediateWithId: async (_chatId, _text, options) => {
          await options.beforeSend();
          if (outcome === 'unknown') throw new Error('synthetic lost acknowledgement');
          return { messageId: 'confirmed-ai-answer' };
        },
      },
    };
    const fence = {
      begin: async () => {
        begun++;
        return true;
      },
      settle: async () => (outcome === 'receipt-lost' ? 0 : 1),
    };
    const result = await deliverAnswer(runtime, fence, source, 'Откройте настройки.', {
      signal: new AbortController().signal,
      sessionEnd: Date.now() + 180000,
      heartbeatAt: () => Date.now(),
      onSent: (id) => receipts.push(id),
    });
    assert.equal(result, outcome === 'receipt-lost' ? 'unknown' : outcome);
    assert.equal(begun, outcome === 'refused' ? 0 : 1);
    assert.deepEqual(receipts, outcome === 'sent' ? ['confirmed-ai-answer'] : []);
  }
});

test('confirmed followups use bounded pairs of the same participant', () => {
  const history = new PilotHistory();
  history.settle('participant-a', 'Как настроить бота?', 'Откройте настройки.', 'sent');
  assert.deepEqual(history.read('participant-b'), []);
  for (let i = 0; i < 20; i++) history.settle('participant-a', String(i), `Ответ ${i}`, 'sent');
  assert.equal(history.read('participant-a').length, 6);
  assert.deepEqual(
    history.read('participant-a').map((entry) => entry.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
  );
  for (let i = 0; i < 40; i++) history.settle(String(i), 'Вопрос', 'Ответ', 'sent');
  assert.equal(history.users.size, 32);
});

test('failed exchanges cannot append or renew context and skip ends only its participant context', () => {
  const history = new PilotHistory();
  const now = Date.now();
  for (const outcome of ['refused', 'unknown', 'expired'])
    history.settle('participant-a', 'Неотправленный вопрос', 'Неотправленный ответ', outcome, now);
  assert.deepEqual(history.read('participant-a', now), []);
  history.settle('participant-a', 'Вопрос', 'Ответ', 'sent', now);
  history.settle('participant-b', 'Другой вопрос', 'Другой ответ', 'sent', now);
  history.settle('participant-a', 'Посторонняя реплика', '', 'skipped', now + 1000);
  assert.deepEqual(history.read('participant-a', now + 1000), []);
  assert.equal(history.read('participant-b', now + 1000).length, 2);
});

test('context expires five minutes after the last confirmed exchange', () => {
  const history = new PilotHistory();
  const now = Date.now();
  history.settle('participant-a', 'Первый вопрос', 'Первый ответ', 'sent', now);
  assert.equal(history.read('participant-a', now + 299999).length, 2);
  history.settle('participant-a', 'Потерянный вопрос', 'Потерянный ответ', 'unknown', now + 299999);
  assert.deepEqual(history.read('participant-a', now + 300000), []);
  history.settle('participant-a', 'Новый вопрос', 'Новый ответ', 'sent', now + 400000);
  history.settle('participant-a', 'Уточнение', 'Уточняющий ответ', 'sent', now + 500000);
  assert.equal(history.read('participant-a', now + 799999).length, 4);
  assert.deepEqual(history.read('participant-a', now + 800000), []);
});

test('bounded live history preserves the latest clarification and observation without the AI footer', () => {
  const history = new PilotHistory();
  const question = 'Какой результат появился после сохранения: ошибка или прежние настройки?';
  history.settle(
    'participant-a',
    `Я сохранил настройки. ${'Подробность. '.repeat(60)}Ошибка: доступ запрещён.`,
    `Проверьте выбранный чат. ${'Пояснение. '.repeat(70)}${question}\n\n${SUPPORT_ANSWER_FOOTER}`,
    'sent',
  );
  const turns = history.read('participant-a');
  assert.equal(turns.length, 2);
  assert.ok(turns.every((turn) => turn.text.length <= 300));
  assert.ok(turns[1].text.startsWith('Проверьте выбранный чат.'));
  assert.ok(turns[1].text.endsWith(question));
  assert.ok(!turns[1].text.includes(SUPPORT_ANSWER_FOOTER));
  assert.ok(turns[0].text.endsWith('Ошибка: доступ запрещён.'));
  assert.deepEqual(history.read('bob'), []);
});

test('bridge refuses unhealthy, mismatched or foreign containers', () => {
  const value = {
    Id: 'a'.repeat(64),
    Image: 'sha256:fixture',
    State: { Running: true },
    Config: {
      Labels: {
        'com.maxim.release-protected': 'true',
        'com.docker.compose.project': 'infra',
        'com.docker.compose.service': 'api-action',
      },
      Env: ['APP_SERVICE_NAME=api-action', 'APP_ROLE=action'],
    },
  };
  assert.equal(verifySupportContainer([value], value.Image), value.Id);
  assert.throws(() => verifySupportContainer([value], 'wrong'), /refused/u);
  assert.throws(
    () => verifySupportContainer([{ ...value, State: { Running: false } }], value.Image),
    /refused/u,
  );
});

test(
  'real Redis fences duplicate workers, expired sources and uncertain SEND without replay',
  { timeout: 20000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'maxim-support-redis-'));
    const socket = join(directory, 'redis.sock');
    const server = spawn(
      'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        socket,
        '--unixsocketperm',
        '700',
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: 'ignore' },
    );
    const exited = once(server, 'exit');
    const redis = new Redis({
      path: socket,
      lazyConnect: true,
      retryStrategy: null,
      maxRetriesPerRequest: 0,
    });
    redis.on('error', () => {});
    try {
      let connected = false;
      for (let i = 0; i < 100; i++) {
        try {
          await redis.connect();
          connected = true;
          break;
        } catch {
          await pause(20);
        }
      }
      assert.equal(connected, true, 'private Redis must actually start');
      const owner = new PilotFence(redis, 'owner'),
        other = new PilotFence(redis, 'other');
      assert.equal(await owner.acquire(), true);
      assert.equal(await other.acquire(), false);
      assert.equal(await owner.prepare('expired'), true);
      assert.equal(await owner.begin('expired', Date.now() - 1), false);
      const raw = row(),
        source = sourceMessage(raw);
      assert.equal(await owner.prepare(source.id), true);
      let sends = 0;
      const runtime = {
        supportBotCatalog: knowledge.botCatalog,
        options: () => ({ botId: 'assigned-fixture' }),
        assertSourceAllowed: async () => {},
        assertAccess: async () => {},
        client: {
          getExactMessageRow: async () => raw,
          async sendMessageImmediateWithId(chatId, text, options) {
            assert.equal(chatId, CHAT_ID);
            assert.equal(options.textFormat, 'html');
            assert.equal(
              text,
              '<a href="https://max.ru/id613000037577_5_bot">Ластик</a>: &lt;проверка&gt;',
            );
            await options.beforeSend();
            sends++;
            throw new Error('simulated lost acknowledgement');
          },
        },
      };
      const bounds = {
        signal: new AbortController().signal,
        sessionEnd: Date.now() + 180000,
        heartbeatAt: () => Date.now(),
      };
      assert.equal(
        await deliverAnswer(runtime, owner, source, 'Ластик: <проверка>', bounds),
        'unknown',
      );
      assert.equal(sends, 1);
      assert.equal(await redis.get(owner.key(source.id)), 'UNKNOWN');
      assert.equal(await owner.prepare(source.id), false);
      assert.equal(await owner.begin(source.id, Date.now() + 1000), false);
      const second = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '-e',
            `
            const Redis = require(${JSON.stringify(fileURLToPath(import.meta.resolve('ioredis')))});
            const bridge = require(${JSON.stringify(fileURLToPath(new URL('./support-chat-bridge.cjs', import.meta.url)))});
            (async () => {
              const redis = new Redis({path:process.argv[1],retryStrategy:null,maxRetriesPerRequest:0});
              const fence = new bridge.PilotFence(redis, 'second-chat');
              const acquired = await fence.acquire();
              const prepared = await fence.prepare('question-1');
              const begun = await fence.begin('question-1', Date.now()+1000);
              await fence.settle('question-1','UNKNOWN');
              const accepted = bridge.sourceMessage({recipient:{chat_id:bridge.CHAT_ID},sender:{user_id:42,is_bot:false},timestamp:Date.now(),body:{mid:'question-1',text:'Вопрос'}});
              const foreign = bridge.sourceMessage({recipient:{chat_id:'-78271094414679'},sender:{user_id:42,is_bot:false},timestamp:Date.now(),body:{mid:'question-1',text:'Вопрос'}});
              console.log(JSON.stringify({chatId:bridge.CHAT_ID,lease:fence.lease,key:fence.key('question-1'),acquired,prepared,begun,accepted:Boolean(accepted),foreign}));
              await fence.close();
              await redis.quit();
            })().catch(()=>process.exit(1));
          `,
            socket,
          ],
          { env: { ...process.env, SUPPORT_CHAT_ID: '-79143082792210' }, timeout: 5000 },
        ).toString(),
      );
      assert.equal(owner.lease, 'support-cpu-pilot:v1:-78271094414679:lease');
      assert.equal(second.lease, 'support-cpu-pilot:v1:-79143082792210:lease');
      assert.notEqual(second.key, owner.key(source.id));
      assert.equal(second.acquired && second.prepared && second.begun && second.accepted, true);
      assert.equal(second.foreign, null);
      assert.equal(await redis.get(owner.key(source.id)), 'UNKNOWN');
      assert.equal(await redis.get(second.key), 'UNKNOWN');
      await owner.close();
      assert.equal(await other.acquire(), true);
      assert.equal(await other.prepare(source.id), false);
      assert.equal(await owner.begin(source.id, Date.now() + 1000), false);
      const changed = { ...source, id: 'changed-source' };
      assert.equal(await other.prepare(changed.id), true);
      runtime.client.getExactMessageRow = async () => ({
        ...raw,
        body: { mid: changed.id, text: 'Текст изменён' },
      });
      assert.equal(await deliverAnswer(runtime, other, changed, 'Ответ', bounds), 'refused');
      assert.equal(sends, 1);
      await other.close();
      const fixture = join(directory, 'bridge-fixture.cjs');
      await writeFile(
        fixture,
        `
        const Redis = require(${JSON.stringify(fileURLToPath(import.meta.resolve('ioredis')))});
        const {runBridge,CHAT_ID} = require(${JSON.stringify(fileURLToPath(new URL('./support-chat-bridge.cjs', import.meta.url)))});
        const redis = new Redis({path:process.argv[2],retryStrategy:null,maxRetriesPerRequest:0});
        redis.on('error',()=>{});
        const source = {recipient:{chat_id:CHAT_ID},sender:{user_id:42,is_bot:false},timestamp:Date.now()+1000,body:{mid:'clock-source',text:'Как подключить бота?'}};
        runBridge({
          redis,
          assertAccess:async()=>({closedFixture:true,fixtureSourceAt:source.timestamp}),
          options:()=>({}),
          client:{listMessages:async()=>process.argv[3]==='question'?[source]:[]},
          close:()=>redis.quit(),
        }).catch(error=>{
          process.stderr.write(error.message+'\\n');
          process.exitCode=1;
        });
      `,
      );
      for (const [name, input, expectedCode] of [
        ['invalid JSON', 'PRIVATE_INVALID_FRAME\n', 'support_frame_invalid'],
        ['null frame', 'null\n', 'support_frame_refused'],
        ['unsupported frame', '{"type":"unsupported"}\n', 'support_frame_refused'],
        ['clean EOF', null, null],
        ['question', null, null],
      ]) {
        await t.test(`bridge preserves ${name}`, { timeout: 7000 }, async () => {
          const child = spawn(process.execPath, [fixture, socket, name], {
            env: { ...process.env, SUPPORT_KNOWLEDGE_SHA256: 'closed-fixture' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const closed = once(child, 'close');
          const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
          let pending = '',
            stderr = '',
            questionFrame = null,
            helloFrame = null;
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          child.stdout.on('data', (chunk) => {
            pending += chunk;
            let newline;
            while ((newline = pending.indexOf('\n')) >= 0) {
              const value = JSON.parse(pending.slice(0, newline));
              pending = pending.slice(newline + 1);
              if (value.type === 'hello') {
                helloFrame = value;
                if (name !== 'question') {
                  if (input === null) child.stdin.end();
                  else child.stdin.write(input);
                }
              } else if (value.type === 'question') {
                questionFrame = value;
                child.stdin.end();
              }
            }
          });
          child.stdin.write(
            JSON.stringify({
              type: 'hello',
              modelSha256: bridge.MODEL_SHA,
              knowledgeSha256: 'closed-fixture',
            }) + '\n',
          );
          try {
            const [code, signal] = await closed;
            assert.equal(signal, null);
            assert.equal(code, expectedCode === null ? 0 : 1);
            assert.equal(stderr.trim(), expectedCode ?? '');
            if (name === 'question') {
              assert.ok(Number.isSafeInteger(questionFrame?.issuedAt));
              assert.deepEqual(questionFrame.history, []);
              assert.deepEqual(questionFrame.interaction, {
                addressedToSupport: false,
                replyToOther: false,
              });
              assert.equal(
                questionFrame.deadline,
                helloFrame.fixtureSourceAt + bridge.SOURCE_AGE_MS,
              );
              assert.ok(
                questionFrame.deadline <= questionFrame.issuedAt + bridge.SOURCE_AGE_MS + 5000,
              );
            }
          } finally {
            clearTimeout(timeout);
            child.stdin.destroy();
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await closed;
          }
        });
      }
    } finally {
      redis.disconnect();
      server.kill('SIGTERM');
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
