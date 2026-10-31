import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const state = (page) => page.getByTestId('runtime-state').textContent().then(JSON.parse);
async function waitForState(page, predicate) {
  await page.waitForFunction((source) => {
    const raw = document.querySelector('[data-testid="runtime-state"]')?.textContent;
    return raw && new Function('value', `return (${source})(value)`)(JSON.parse(raw));
  }, predicate.toString());
  return state(page);
}
async function settled(page) {
  await waitForState(page, (value) => !value.loading && !value.busy);
  await settleVisualFrame(page);
}
async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function responseFor(request) {
  const command = request.command;
  if (command.operation === 'image')
    return {
      operation: command.operation,
      data: { url: 'https://assets.test/original-cover.jpg' },
    };
  if (command.operation === 'appearance_apply')
    return {
      operation: command.operation,
      data: {
        draft: command.input.appearance,
        published: command.input.appearance,
        revision: 2,
        hasChanges: false,
      },
    };
  assert.equal(command.operation, 'invitation_create');
  return {
    operation: command.operation,
    data: {
      id: '55555555-5555-4555-8555-555555555555',
      expiresAt: command.input.expiresAt,
      maxUses: command.input.maxUses,
      usedCount: 0,
      code: 'original-secure-invite',
      revoked: false,
      url: 'https://max.ru/seller?startapp=original-secure-invite',
    },
  };
}
async function newHarness(browser, name, base, { storage, hold } = {}) {
  const context = await browser.newContext({
    viewport: { width: 360, height: 780 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  await installMaxBridgeShimInitScript(
    context,
    { platform: name === 'webkit' ? 'ios' : 'android' },
    { acknowledgeIncidentNotice: false },
  );
  await context.addInitScript(
    ({ storage }) => {
      window.__runtimeClipboard = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.__runtimeClipboard.push(value);
          },
        },
      });
      if (storage === 'missing')
        Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      if (storage === 'hung')
        Object.defineProperty(window, 'indexedDB', {
          configurable: true,
          value: { open: () => ({}) },
        });
    },
    { storage },
  );
  const attempts = [];
  const committed = new Map();
  const errors = [];
  let observeFirstAttempt;
  const firstAttempt = new Promise((resolve) => {
    observeFirstAttempt = resolve;
  });
  let releaseHeld;
  const held = hold
    ? new Promise((resolve) => {
        releaseHeld = resolve;
      })
    : null;
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== new URL(base).origin) return route.abort();
    if (!new URL(request.url()).pathname.endsWith('/karavan-marketplace/manage'))
      return route.continue();
    const body = request.postData();
    assert.ok(body);
    const envelope = JSON.parse(body);
    const first = !committed.has(envelope.commandId);
    if (first) committed.set(envelope.commandId, { body, result: responseFor(envelope) });
    attempts.push({ body, envelope });
    observeFirstAttempt();
    assert.equal(
      body,
      committed.get(envelope.commandId).body,
      'a resumed command preserves the exact original envelope',
    );
    if (held && first) await held;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: !hold && first ? { 'X-Simulated-Lost-Response': '1' } : {},
      body: JSON.stringify(committed.get(envelope.commandId).result),
    });
  });
  context.on('page', (page) => {
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => errors.push(error.message));
  });
  return { context, attempts, committed, errors, firstAttempt, release: () => releaseHeld?.() };
}
async function assertAllBlocked(page) {
  const current = await state(page);
  for (const owner of ['image', 'appearance', 'invitation']) {
    assert.equal(current[owner].blocked, true, `${owner} is blocked by the shared command`);
    assert.equal(
      current[owner].editingBlocked,
      true,
      `${owner} cannot edit while outcome is unknown`,
    );
  }
  for (const label of ['Загрузить изображение', 'Сохранить оформление', 'Пригласить продавца'])
    assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true);
}
async function assertNoShare(page) {
  assert.deepEqual(
    await page.evaluate(() => ({
      native: window.__MAXIM_VISUAL_BRIDGE_EVENTS__.filter((event) =>
        ['shareContent', 'shareMaxContent'].includes(event.type),
      ),
      clipboard: window.__runtimeClipboard,
    })),
    {
      native: [],
      clipboard: [],
    },
    'restoring or resuming a saved invitation never shares or copies automatically',
  );
}

async function lostResponseCheck(browser, name, base, url, operation) {
  const harness = await newHarness(browser, name, base);
  try {
    const page = await harness.context.newPage();
    await page.goto(url);
    await settled(page);
    const label =
      operation === 'image'
        ? 'Загрузить изображение'
        : operation === 'appearance_apply'
          ? 'Сохранить оформление'
          : 'Пригласить продавца';
    await page.getByRole('button', { name: label, exact: true }).click();
    await page
      .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
      .waitFor();
    await settled(page);
    assert.equal(harness.attempts.length, 1);
    const original = harness.attempts[0];
    assert.equal(original.envelope.command.operation, operation);
    assert.equal(harness.committed.size, 1, 'the simulated server committed the first attempt');
    const pending = (await state(page)).journal.pending;
    assert.equal(pending.dispatchCount, 1);
    await assertAllBlocked(page);
    await page.evaluate(() => window.__shopCommandRuntimeHarness.changeOriginalInputs());
    const blockedAttempt = await page.evaluate(() =>
      window.__shopCommandRuntimeHarness.tryAppearance(),
    );
    assert.ok(blockedAttempt, 'a second hook owner is rejected even when called directly');
    assert.equal(harness.attempts.length, 1);

    await page.reload();
    await settled(page);
    await page
      .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
      .waitFor();
    assert.equal(
      harness.attempts.length,
      1,
      'reload hydrates the pending command without dispatch',
    );
    assert.equal((await state(page)).journal.pending.id, pending.id);
    await assertAllBlocked(page);
    await assertNoShare(page);

    const second = await harness.context.newPage();
    await second.goto(url);
    await settled(second);
    await assertAllBlocked(second);
    assert.equal(harness.attempts.length, 1, 'a new document causes zero automatic writes');
    await assertNoShare(second);
    await second.close();

    await page
      .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
      .click();
    await waitForState(
      page,
      (value) => !value.loading && !value.busy && value.journal?.pending === null,
    );
    await settleVisualFrame(page);
    assert.equal(harness.attempts.length, 2);
    assert.equal(harness.committed.size, 1, 'manual resume returns the saved server receipt');
    assert.equal(harness.attempts[1].body, original.body);
    const owner =
      operation === 'image'
        ? 'image'
        : operation === 'appearance_apply'
          ? 'appearance'
          : 'invitation';
    const confirmed = await state(page);
    assert.equal(confirmed[owner].receipt.request.commandId, original.envelope.commandId);
    assert.deepEqual(
      confirmed[owner].receipt.response,
      harness.committed.get(original.envelope.commandId).result,
    );
    for (const hookOwner of ['image', 'appearance', 'invitation'])
      assert.equal(
        confirmed[hookOwner].blocked,
        false,
        `${hookOwner} is released after manual confirmation`,
      );
    assert.deepEqual(
      confirmed.callbacks,
      operation === 'invitation_create'
        ? []
        : [
            {
              owner: operation === 'image' ? 'runtime-image' : 'runtime-appearance',
              commandId: original.envelope.commandId,
              chatId: '-123',
            },
          ],
      'the mounted owner receives the saved original success exactly once',
    );
    if (operation === 'image')
      assert.equal(
        confirmed.journal.appearanceDraft.coverImageUrl,
        'https://assets.test/original-cover.jpg',
      );
    if (operation === 'appearance_apply') {
      assert.equal(confirmed.appearance.data.published.name, 'Магазин соседей');
      assert.equal(confirmed.journal.appearanceDraft, null);
    }
    if (operation === 'invitation_create')
      assert.equal(
        await page.getByRole('textbox', { name: 'Ссылка для продавцов', exact: true }).inputValue(),
        'https://max.ru/seller?startapp=original-secure-invite',
      );
    await assertNoShare(page);

    await page.reload();
    await settled(page);
    const restored = await state(page);
    assert.deepEqual(
      restored[owner].receipt,
      confirmed[owner].receipt,
      'a confirmed result survives another document',
    );
    assert.equal(harness.attempts.length, 2, 'confirmed receipt hydration does not dispatch');
    await assertNoShare(page);
    assert.deepEqual(harness.errors, []);
    console.log(
      `Shop runtime ${name}/${operation}: original request, shared blockers, reload, manual resume and saved receipt passed.`,
    );
  } finally {
    await harness.context.close();
  }
}

async function storageFailureCheck(browser, name, base, url, storage) {
  const harness = await newHarness(browser, name, base, { storage });
  try {
    const page = await harness.context.newPage();
    const started = Date.now();
    await page.goto(url);
    await page
      .getByRole('button', { name: 'Повторить загрузку', exact: true })
      .waitFor({ timeout: 12000 });
    await waitForState(page, (value) => value.storageError && !value.loading && !value.busy);
    assert.ok(
      Date.now() - started < 12000,
      `${storage} storage reaches a finite recoverable failure`,
    );
    await assertAllBlocked(page);
    assert.ok(await page.evaluate(() => window.__shopCommandRuntimeHarness.tryImage()));
    assert.equal(
      harness.attempts.length,
      0,
      'unavailable storage never dispatches an unjournaled write',
    );
    await assertNoShare(page);
    assert.deepEqual(harness.errors, []);
    console.log(
      `Shop runtime ${name}/storage-${storage}: finite recovery, all owners blocked and zero writes passed.`,
    );
  } finally {
    await harness.context.close();
  }
}

async function secondOwnerSameDocumentCheck(browser, name, base, url) {
  const harness = await newHarness(browser, name, base);
  try {
    const page = await harness.context.newPage();
    await page.goto(url);
    await settled(page);
    await page.getByRole('button', { name: 'Загрузить изображение', exact: true }).click();
    await page
      .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
      .waitFor();
    await settled(page);
    assert.equal(harness.attempts.length, 1);
    assert.ok(await page.evaluate(() => window.__shopCommandRuntimeHarness.tryAppearance()));
    assert.equal(harness.attempts.length, 1, 'a rejected second owner never dispatches');
    await assertAllBlocked(page);

    await page
      .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
      .click();
    await waitForState(
      page,
      (value) => !value.loading && !value.busy && value.journal?.pending === null,
    );
    await settleVisualFrame(page);
    const confirmed = await state(page);
    for (const owner of ['image', 'appearance', 'invitation']) {
      assert.equal(confirmed[owner].blocked, false, `${owner} is released in the same document`);
      assert.equal(confirmed[owner].editingBlocked, false, `${owner} can edit after confirmation`);
    }
    assert.equal(harness.attempts.length, 2);
    assert.equal(harness.committed.size, 1);
    assert.deepEqual(harness.errors, []);
    console.log(
      `Shop runtime ${name}/second-owner-same-document: pre-reserve refusal leaves every owner usable after manual confirmation.`,
    );
  } finally {
    await harness.context.close();
  }
}

async function readOnlyCheck(browser, name, base, url) {
  const harness = await newHarness(browser, name, base);
  try {
    const page = await harness.context.newPage();
    await page.goto(url);
    await settled(page);
    await page.getByRole('button', { name: 'Заблокировать изменения', exact: true }).click();
    await waitForState(page, (value) => value.readOnly && !value.loading && !value.busy);
    await assertAllBlocked(page);
    for (const action of ['tryImage', 'tryAppearance'])
      assert.ok(await page.evaluate((key) => window.__shopCommandRuntimeHarness[key](), action));
    assert.equal(
      (await state(page)).journal,
      null,
      'a direct blocked hook cannot reserve a command',
    );
    assert.equal(harness.attempts.length, 0, 'read-only entry prevents direct hook dispatch');

    await page.getByRole('button', { name: 'Разрешить изменения', exact: true }).click();
    await waitForState(page, (value) => !value.readOnly && !value.blocked);
    await page.getByRole('button', { name: 'Загрузить изображение', exact: true }).click();
    await waitForState(page, (value) => !value.busy && value.journal?.pending?.dispatchCount === 1);
    const original = harness.attempts[0];
    assert.equal(harness.committed.size, 1, 'the lost response follows a server commit');
    const pending = (await state(page)).journal;

    await page.getByRole('button', { name: 'Заблокировать изменения', exact: true }).click();
    await waitForState(page, (value) => value.readOnly);
    await assertAllBlocked(page);
    assert.equal(
      await page
        .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
        .isDisabled(),
      true,
    );
    await page.evaluate(() => window.__shopCommandRuntimeHarness.resume());
    for (const action of ['tryImage', 'tryAppearance'])
      assert.ok(await page.evaluate((key) => window.__shopCommandRuntimeHarness[key](), action));
    assert.deepEqual(
      await page.evaluate(() => window.__shopCommandRuntimeHarness.readOriginalJournal()),
      pending,
    );
    assert.equal(
      harness.attempts.length,
      1,
      'direct resume and hooks cannot dispatch while read-only',
    );

    await page.getByRole('button', { name: 'Разрешить изменения', exact: true }).click();
    await waitForState(page, (value) => !value.readOnly);
    await settleVisualFrame(page);
    assert.equal(harness.attempts.length, 1, 'restoring access never resumes automatically');
    await page
      .getByRole('button', { name: 'Продолжить сохранённое действие', exact: true })
      .click();
    await waitForState(page, (value) => !value.busy && value.journal?.pending === null);
    await settleVisualFrame(page);
    const confirmed = await state(page);
    assert.equal(harness.attempts.length, 2);
    assert.equal(harness.attempts[1].body, original.body);
    assert.equal(harness.committed.size, 1, 'explicit resume returns the original server receipt');
    assert.equal(confirmed.image.receipt.request.commandId, original.envelope.commandId);
    assert.deepEqual(confirmed.callbacks, [
      {
        owner: 'runtime-image',
        commandId: original.envelope.commandId,
        chatId: '-123',
      },
    ]);
    await assertNoShare(page);
    assert.deepEqual(harness.errors, []);
    console.log(
      `Shop runtime ${name}/read-only: direct writes and resume blocked, original pending command retained and explicitly confirmed after recovery.`,
    );
  } finally {
    await harness.context.close();
  }
}

async function lateScopeCheck(browser, name, base, url) {
  const harness = await newHarness(browser, name, base, { hold: true });
  try {
    const page = await harness.context.newPage();
    await page.goto(url);
    await settled(page);
    await page.getByRole('button', { name: 'Загрузить изображение', exact: true }).click();
    await waitForState(page, (value) => value.busy && value.journal?.pending?.dispatchCount === 1);
    await bounded(
      harness.firstAttempt,
      'The held original command was not observed within 15 seconds',
    );
    assert.equal(harness.attempts.length, 1);
    await assertAllBlocked(page);
    await page.getByRole('button', { name: 'Открыть другой магазин', exact: true }).click();
    await waitForState(page, (value) => value.scope.chatId === '-456');
    harness.release();
    await page.waitForFunction(async () => {
      const journal = await window.__shopCommandRuntimeHarness.readOriginalJournal();
      return journal?.pending === null && Boolean(journal.results['runtime-image']);
    });
    await waitForState(
      page,
      (value) => value.scope.chatId === '-456' && !value.loading && !value.busy,
    );
    await settleVisualFrame(page);
    const current = await state(page);
    assert.deepEqual(
      current.callbacks,
      [],
      'a late old-scope success never invokes the new owner callback',
    );
    assert.equal(current.image.receipt, null, 'the new scope never receives the old receipt');
    assert.equal(current.image.data, null, 'the new scope never receives old response data');
    assert.equal(current.appearance.receipt, null);
    assert.equal(current.invitation.receipt, null);
    assert.equal(harness.attempts.length, 1, 'switching scopes does not write or retry');
    await assertNoShare(page);
    assert.deepEqual(harness.errors, []);
    console.log(
      `Shop runtime ${name}/late-scope: original receipt persisted, new scope and callbacks ignored late response.`,
    );
  } finally {
    harness.release();
    await harness.context.close();
  }
}

export async function runShopCommandRuntimeChecks({ base, url }) {
  const selected = process.env.KARAVAN_SHOP_RUNTIME_SCENARIOS?.split(',').filter(Boolean);
  const known = [
    'image',
    'appearance_apply',
    'invitation_create',
    'storage-missing',
    'storage-hung',
    'second-owner',
    'read-only',
    'late-scope',
  ];
  if (selected?.some((scenario) => !known.includes(scenario)))
    throw new Error('Unknown shop command runtime scenario');
  const includes = (scenario) => !selected || selected.includes(scenario);
  for (const [name, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
    try {
      for (const operation of ['image', 'appearance_apply', 'invitation_create'])
        if (includes(operation)) await lostResponseCheck(browser, name, base, url, operation);
      for (const storage of ['missing', 'hung'])
        if (includes(`storage-${storage}`))
          await storageFailureCheck(browser, name, base, url, storage);
      if (includes('second-owner')) await secondOwnerSameDocumentCheck(browser, name, base, url);
      if (includes('read-only')) await readOnlyCheck(browser, name, base, url);
      if (includes('late-scope')) await lateScopeCheck(browser, name, base, url);
    } finally {
      await browser.close();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
  await mkdir(fixtures, { recursive: true });
  const fixture = await mkdtemp(`${fixtures}/shop-command-runtime-`);
  await writeFile(
    `${fixture}/index.html`,
    '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-command-runtime-fixture.tsx"></script></body></html>',
  );
  const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
  const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
  let server;
  try {
    server = await ensureMiniappDevServer(base);
    await runShopCommandRuntimeChecks({ base, url });
  } finally {
    if (server) await stopChildProcess(server);
    await rm(fixture, { recursive: true, force: true });
  }
}
