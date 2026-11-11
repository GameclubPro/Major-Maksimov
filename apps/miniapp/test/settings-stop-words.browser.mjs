import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const allDevices = [
  ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
  ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
  ['android-light', devices['Pixel 7'], 'light', 'android'],
  ['android-dark', devices['Pixel 7'], 'dark', 'android'],
];
const selectedDeviceNames = process.env.MAXIM_STOP_WORDS_TEST_DEVICES?.split(',');
if (selectedDeviceNames) {
  assert.ok(!process.env.CI, 'Device selection is available only for local regression reruns');
  assert.equal(new Set(selectedDeviceNames).size, selectedDeviceNames.length);
  for (const name of selectedDeviceNames)
    assert.ok(
      allDevices.some(([known]) => known === name),
      `Unknown device ${name}`,
    );
}
const selectedDevices = selectedDeviceNames
  ? allDevices.filter(([name]) => selectedDeviceNames.includes(name))
  : allDevices;

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-stop-words-'));
const PANEL = '.settings-drilldown__panel--stop-words';
const originalRevision = '2026-10-29T08:00:00.000Z';
const nextRevision = (sequence) =>
  new Date(Date.parse(originalRevision) + sequence * 60_000).toISOString();
const waitUntil = async (predicate, message) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function assertReachable(locator) {
  await locator.scrollIntoViewIfNeeded();
  const measured = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      withinViewport:
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= (viewport?.offsetTop ?? 0) - 1 &&
        rect.bottom <= (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) + 1,
      unobscured: element.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    };
  });
  assert.deepEqual(measured, { withinViewport: true, unobscured: true });
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of selectedDevices) {
    const context = await browser.newContext({ ...device, colorScheme });
    let page;
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      await installNativeVisualModeInitScript(context);
      await context.route('**/stop-words-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
          import RefreshRuntime from '/app/@react-refresh';
          RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
          window.__vite_plugin_react_preamble_installed__=true;
          await import('/app/test/fixtures/settings-stop-words-harness.tsx');
        </script></body></html>`,
        }),
      );
      page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let state;
      let seedSnapshot;
      const panel = page.locator(PANEL);
      const words = (includeHidden = false) =>
        panel.getByRole('textbox', { name: 'Добавить слова и фразы', exact: true, includeHidden });
      const save = () => panel.getByRole('button', { name: /^(?:Сохранить|Сохраняем\.\.\.)$/u });
      const stopState = (chatId, requestState = state) => ({
        policy:
          requestState.storage[chatId] === 'invalid'
            ? {
                ...requestState.seed.settings.stopWordsPolicy,
                enabled: false,
                rules: [],
                domains: [],
              }
            : requestState.saved[chatId].stopWordsPolicy,
        revision: requestState.saved[chatId].stopWordsRevision,
        settingsRevision: requestState.saved[chatId].settingsRevision,
        imageScanStatus: 'shadow',
        storageStatus: requestState.storage[chatId],
      });
      const fulfillStop = async (route, override, requestState = state) => {
        const chatId = new URL(route.request().url()).pathname.split('/')[3];
        const body = route.request().postDataJSON();
        const reply = override ?? requestState.nextStop;
        requestState.nextStop = null;
        if (reply) {
          if (reply.code === 'STOP_WORDS_POLICY_REVIEW_REQUIRED')
            requestState.storage[chatId] = 'invalid';
          await route.fulfill({
            status: reply.status,
            json: reply.body ?? {
              code: reply.code,
              revision: requestState.saved[chatId].stopWordsRevision,
            },
          });
          return;
        }
        assert.equal(
          body.expectedRevision,
          requestState.saved[chatId].stopWordsRevision,
          'stop CAS must use original source revision',
        );
        if (requestState.storage[chatId] === 'invalid')
          assert.equal(body.replaceInvalidStorage, true);
        requestState.saved[chatId] = {
          ...requestState.saved[chatId],
          stopWordsPolicy: body.policy,
          stopWordsRevision: body.expectedRevision + 1,
          settingsRevision: nextRevision(++requestState.sequence),
        };
        requestState.storage[chatId] = 'valid';
        await route.fulfill({ json: stopState(chatId, requestState) });
      };
      const routeApi = async (route) => {
        const requestState = state;
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith('/api/')) return route.continue();
        const match = pathname.match(/^\/api\/chats\/(chat-[ab])\/(.*)$/u);
        assert.ok(match, `Unexpected local API path ${pathname}`);
        const [, chatId, tail] = match;
        if (!requestState.seed) {
          seedSnapshot ??= await page.evaluate(() => window.__STOP_WORDS_SCREEN__);
          requestState.seed = seedSnapshot;
          for (const id of ['chat-a', 'chat-b']) {
            requestState.saved[id] = structuredClone(requestState.seed.settings);
            requestState.saved[id].stopWordsRevision = id === 'chat-a' ? 7 : 21;
          }
          if (requestState.links) {
            requestState.saved['chat-a'].linkRulesPolicy = {
              version: 1,
              mode: 'DENY_SELECTED',
              rules: [],
            };
            requestState.saved['chat-a'].linkRulesStorageStatus = 'valid';
          }
          if (requestState.large)
            requestState.saved['chat-a'].stopWordsPolicy.rules = Array.from(
              { length: 125 },
              (_, index) => ({
                id: `rule-${index}`,
                value: `маркер${index}`,
                kind: 'WORD',
                enabled: true,
                matchMode: index % 2 ? 'MASKED' : 'EXACT',
              }),
            );
          if (requestState.buttons)
            requestState.saved['chat-a'].stopWordsPolicy.sanctions.botButtons = [
              { text: 'Первая', url: 'https://first.example' },
              { text: 'Вторая', url: 'https://second.example' },
            ];
          if (requestState.storage['chat-a'] === 'invalid')
            requestState.saved['chat-a'].stopWordsPolicy = {
              ...requestState.saved['chat-a'].stopWordsPolicy,
              enabled: false,
              rules: [],
              domains: [],
            };
        }
        requestState.requests.push({ pathname, method: request.method() });
        if (tail === 'settings-screen' && request.method() === 'GET') {
          if (requestState.holdScreen) {
            requestState.pendingScreen.push(route);
            return;
          }
          if (requestState.failScreen) {
            await route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } });
            return;
          }
          requestState.lastScreenChat = chatId;
          await route.fulfill({
            json: {
              ...requestState.seed,
              settings: requestState.saved[chatId],
              stopWordsStorageStatus: requestState.storage[chatId],
              header: {
                ...requestState.seed.header,
                id: chatId,
                title: chatId === 'chat-a' ? 'Чат A' : 'Чат B',
              },
            },
          });
          return;
        }
        if (tail === 'stop-words/status' && request.method() === 'GET') {
          await route.fulfill({
            json: {
              revision: requestState.saved[chatId].stopWordsRevision,
              imageScanStatus: 'shadow',
            },
          });
          return;
        }
        if (tail === 'stop-words' && request.method() === 'GET') {
          if (requestState.failReload) {
            await route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } });
            return;
          }
          await route.fulfill({ json: stopState(chatId, requestState) });
          return;
        }
        if (tail === 'stop-words' && request.method() === 'PUT') {
          requestState.writes.push({
            pathname,
            method: request.method(),
            body: request.postDataJSON(),
          });
          if (requestState.holdStop) {
            requestState.pendingStop.push(route);
            return;
          }
          await fulfillStop(route, undefined, requestState);
          return;
        }
        if (
          (tail === 'settings' && request.method() === 'PUT') ||
          (tail === 'settings/section' && request.method() === 'PATCH')
        ) {
          const body = request.postDataJSON();
          requestState.writes.push({ pathname, method: request.method(), body });
          assert.equal(
            body.settingsRevision ?? body.expectedRevision,
            requestState.expectedGeneralRevision ?? requestState.saved[chatId].settingsRevision,
          );
          const changes = tail === 'settings' ? body : body.changes;
          for (const key of [
            'stopWordsPolicy',
            'stopWordsRevision',
            'messageLimitsBlockedWords',
            'messageLimitsBlockedDomains',
            'messageLimitsImageTextScanEnabled',
          ])
            assert.equal(Object.hasOwn(changes, key), false, key);
          requestState.saved[chatId] = {
            ...requestState.saved[chatId],
            ...changes,
            settingsRevision: nextRevision(++requestState.sequence),
          };
          await route.fulfill({ json: requestState.saved[chatId] });
          return;
        }
        if (tail === 'settings/apply-section-preview') {
          await route.fulfill({
            json: {
              sourceChatId: chatId,
              targetMode: 'current',
              updatedChats: 1,
              appliedChatIds: [chatId],
              sampleChats: [],
            },
          });
          return;
        }
        assert.fail(`Unexpected mutation ${request.method()} ${pathname}`);
      };
      await page.route('**/api/**', async (route) => {
        try {
          await routeApi(route);
        } catch (error) {
          errors.push(`Local API harness: ${error.message}`);
          await route.abort().catch(() => {});
        }
      });
      const fresh = async (options = {}) => {
        state = {
          seed: null,
          saved: {},
          storage: { 'chat-a': options.invalid ? 'invalid' : 'valid', 'chat-b': 'valid' },
          sequence: 0,
          requests: [],
          writes: [],
          pendingStop: [],
          pendingScreen: [],
          ...options,
        };
        await page.goto(`${base}stop-words-test`);
        await page.getByRole('button', { name: 'Стоп-слова', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Стоп-слова', exact: true }).click();
        await panel.waitFor({ state: 'visible' });
        await applyNativeVisualMode(page, {
          theme: colorScheme,
          safeTop: platform === 'ios' ? 44 : 24,
          safeBottom: platform === 'ios' ? 34 : 0,
          backButtonVisible: true,
        });
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.maxTheme),
          colorScheme,
        );
      };
      const addWord = async (value) => {
        await words().fill(value);
        await panel.getByRole('button', { name: 'Добавить записи', exact: true }).click();
        await panel
          .getByLabel('Список слов и фраз', { exact: true })
          .getByText(value, { exact: true })
          .waitFor();
      };
      const reloadButton = () =>
        panel.getByRole('button', { name: 'Загрузить сохранённый список', exact: true });
      const dismissToasts = async () => {
        const close = page.getByRole('button', { name: 'Закрыть уведомление', exact: true });
        while (await close.count()) await close.first().click();
      };
      const waitForFailedSave = async () => {
        await page.waitForFunction(
          (selector) => !document.querySelector(`${selector} button[aria-busy="true"]`),
          PANEL,
        );
        await page
          .getByRole('alert')
          .filter({ hasText: 'Не удалось сохранить блок «Стоп-слова»' })
          .waitFor();
        await dismissToasts();
      };
      const confirmReload = () =>
        page.getByRole('dialog', { name: 'Загрузить сохранённый список?', exact: true });

      await fresh();
      await words().fill('каталог');
      assert.notEqual(
        await words().getAttribute('aria-invalid'),
        'true',
        'valid pending input is a draft, not a validation error',
      );
      await panel.getByRole('status').filter({ hasText: 'Добавьте введённые записи' }).waitFor();
      assert.equal(
        await panel.getByRole('alert').filter({ hasText: 'Добавьте введённые записи' }).count(),
        0,
      );
      await save().click();
      assert.equal(state.writes.length, 0, 'pending entries cannot be silently omitted by Save');
      assert.equal(await words().inputValue(), 'каталог');
      assert.equal(await panel.isVisible(), true);
      await words().fill('');
      assert.equal(
        await panel
          .getByRole('radiogroup', { name: 'Запрещённые слова и сайты', exact: true })
          .count(),
        0,
        'single Stop Words has no obsolete site tab after relocation to Links',
      );
      assert.equal(
        await panel
          .getByRole('textbox', { name: 'Добавить запрещённые сайты', exact: true })
          .count(),
        0,
        'the independent site editor belongs to Links',
      );
      await addWord('контрольная фраза');
      const savePresentation = await save().evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          text: element.textContent,
          color: style.color,
          textFillColor: style.webkitTextFillColor,
          background: style.backgroundColor,
          surface: style.getPropertyValue('--color-surface'),
          textPrimary: style.getPropertyValue('--text-primary'),
        };
      });
      if (savePresentation.color === savePresentation.background) console.error(savePresentation);
      assert.equal(savePresentation.text, 'Сохранить');
      assert.notEqual(savePresentation.color, savePresentation.background);
      await save().click();
      await panel.waitFor({ state: 'hidden' });
      assert.deepEqual(
        state.writes.map(({ pathname, method }) => `${method} ${pathname}`),
        ['PUT /api/chats/chat-a/stop-words'],
      );
      assert.equal(state.writes[0].body.expectedRevision, 7);
      assert.deepEqual(
        state.writes[0].body.policy.domains,
        ['blocked.example'],
        'editing words preserves saved sites managed from Links',
      );
      assert.deepEqual(
        state.writes[0].body.policy.rules.slice(0, 2).map((rule) => rule.matchMode),
        ['EXACT', 'MASKED'],
      );
      await page.getByRole('button', { name: 'Стоп-слова', exact: true }).click();
      await panel.getByText('контрольная фраза', { exact: true }).waitFor();
      await words().fill('несохранённая фраза');
      await save().click();
      assert.equal(state.writes.length, 1);
      await words().waitFor();
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'Добавить слова и фразы',
      );
      assert.equal(await words().evaluate((element) => element === document.activeElement), true);
      assert.equal(await words().inputValue(), 'несохранённая фраза');
      await page.getByRole('link', { name: 'Чат B', exact: true }).click();
      const leave = page.getByRole('dialog', { name: 'Сохранить изменения?', exact: true });
      await leave.waitFor();
      await leave.getByRole('button', { name: 'Отмена', exact: true }).click();
      console.log(
        `PASS ${name}: words use stop CAS, preserve saved sites, and retain the unadded word buffer after blocked save`,
      );

      const viewport = page.viewportSize();
      await dismissToasts();
      await words().focus();
      await page.setViewportSize({
        width: viewport.width,
        height: Math.max(320, viewport.height - 260),
      });
      await assertReachable(words());
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: path.join(screenshots, `${name}-keyboard.png`),
        fullPage: false,
      });
      await words().blur();
      await page.setViewportSize(viewport);
      console.log(
        `PASS ${name}: safe areas, scroll and keyboard-sized viewport keep stop input reachable`,
      );

      await fresh();
      await addWord('сохранить при переходе');
      await page.getByRole('link', { name: 'Чат B', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Сохранить изменения?', exact: true })
        .getByRole('button', { name: 'Сохранить и перейти', exact: true })
        .click();
      await waitUntil(
        () => state.lastScreenChat === 'chat-b',
        'stop-only leave must navigate after acknowledgement',
      );
      assert.deepEqual(
        state.writes.map(({ pathname, method }) => `${method} ${pathname}`),
        ['PUT /api/chats/chat-a/stop-words'],
      );
      console.log(`PASS ${name}: real guarded leave uses the same stop CAS path`);

      await fresh({ holdStop: true });
      await addWord('ожидающий список');
      await save().click();
      await waitUntil(() => state.pendingStop.length === 1, 'held stop request');
      assert.equal(await save().isDisabled(), true);
      assert.equal(
        await words().isDisabled(),
        true,
        'busy form prevents modifying an in-flight submission',
      );
      assert.equal(state.writes.length, 1);
      state.holdStop = false;
      await fulfillStop(state.pendingStop.shift());
      await panel.waitFor({ state: 'hidden' });
      console.log(
        'PASS real page: busy save prevents duplicate requests and edits; hook fixture covers retained edits during async save',
      );

      await fresh({ invalid: true });
      await panel.getByRole('alert').first().waitFor();
      await page.screenshot({
        path: path.join(screenshots, `${name}-invalid.png`),
        fullPage: false,
      });
      assert.equal(await words(true).isDisabled(), true);
      const copy = panel.getByRole('button', { name: 'Применить к другим чатам', exact: true });
      if (await copy.count()) assert.equal(await copy.isDisabled(), true);
      const create = panel.getByRole('button', { name: 'Создать новый список', exact: true });
      await create.click();
      let replacement = page.getByRole('dialog', { name: 'Создать новый список?', exact: true });
      await replacement.getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal(state.writes.length, 0);
      assert.equal(await words(true).isDisabled(), true);
      await create.click();
      replacement = page.getByRole('dialog', { name: 'Создать новый список?', exact: true });
      await replacement.getByRole('button', { name: 'Создать', exact: true }).click();
      await page.getByRole('link', { name: 'Чат B', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Сохранить изменения?', exact: true })
        .getByRole('button', { name: 'Отмена', exact: true })
        .click();
      await save().click();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 1);
      assert.equal(state.writes[0].body.expectedRevision, 7);
      assert.equal(state.writes[0].body.replaceInvalidStorage, true);
      console.log(
        'PASS real page: first-open invalid status gates editing/copy; confirmed replacement alone is dirty and sends explicit intent',
      );

      await fresh();
      await addWord('черновик после проверки');
      state.nextStop = { status: 409, code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED' };
      await save().click();
      await panel.getByRole('button', { name: 'Создать новый список', exact: true }).waitFor();
      assert.equal(
        await panel
          .getByLabel('Список слов и фраз', { exact: true })
          .getByText('черновик после проверки', { exact: true })
          .count(),
        1,
      );
      assert.equal(state.writes.length, 1);
      assert.equal(Object.hasOwn(state.writes[0].body, 'replaceInvalidStorage'), false);
      assert.equal(await words(true).isDisabled(), true);
      assert.ok(
        state.requests.some(
          ({ pathname, method }) => pathname.endsWith('/stop-words') && method === 'GET',
        ),
      );
      await waitForFailedSave();
      assert.equal(await save().textContent(), 'Сохранить');
      assert.equal(await save().isDisabled(), true);
      await panel.getByRole('button', { name: 'Создать новый список', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Создать новый список?', exact: true })
        .getByRole('button', { name: 'Создать', exact: true })
        .click();
      await save().click();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 2);
      assert.equal(state.writes[1].body.replaceInvalidStorage, true);
      assert.deepEqual(state.writes[1].body.policy, state.writes[0].body.policy);
      console.log(
        'PASS real page: cached-valid review-required keeps draft and refreshes status without silently authorizing replacement',
      );

      await fresh();
      await addWord('конфликтный черновик');
      state.nextStop = { status: 409, code: 'STOP_WORDS_REVISION_CONFLICT' };
      await save().click();
      await panel.getByText('Список изменён другим администратором.', { exact: true }).waitFor();
      await waitForFailedSave();
      await page.screenshot({
        path: path.join(screenshots, `${name}-conflict.png`),
        fullPage: false,
      });
      assert.equal(
        await panel.getByRole('button', { name: 'Сохранить мой вариант', exact: true }).count(),
        0,
      );
      await words().fill('буфер слов');
      await reloadButton().click();
      await confirmReload().getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal(await words().inputValue(), 'буфер слов');
      state.failReload = true;
      await reloadButton().click();
      const failedReload = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname.endsWith('/stop-words') &&
          response.status() === 503,
      );
      await confirmReload().getByRole('button', { name: 'Загрузить', exact: true }).click();
      await failedReload;
      await panel.getByRole('alert').filter({ hasText: 'Не удалось сохранить' }).waitFor();
      await dismissToasts();
      await confirmReload().getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal(await words().inputValue(), 'буфер слов');
      state.failReload = false;
      await reloadButton().click();
      await confirmReload().getByRole('button', { name: 'Загрузить', exact: true }).click();
      await confirmReload().waitFor({ state: 'hidden' });
      assert.equal(await words().inputValue(), '');
      assert.equal(await panel.getByText('конфликтный черновик', { exact: true }).count(), 0);
      console.log(
        'PASS real page: stop conflict retains the word buffer through cancellation and failure until a confirmed reload succeeds',
      );

      for (const scenario of [
        {
          options: { large: true },
          issue: ['policy', 'rules', 123, 'value'],
          target: 'Слово или фраза',
          message: 'Проверьте правило 124',
          value: 'маркер123',
        },
        {
          options: { buttons: true },
          issue: ['policy', 'sanctions', 'botButtons', 1, 'url'],
          target: 'Ссылка кнопки 2',
          message: 'Проверьте вторую ссылку',
        },
        {
          options: {},
          issue: ['policy', 'sanctions', 'muteDurationHours'],
          target: 'Длительность ограничения, часов',
          message: 'Проверьте срок',
        },
        {
          options: {},
          issue: ['policy', 'sanctions', 'botMessageText'],
          target: 'Объяснение',
          message: 'Проверьте объяснение',
        },
      ]) {
        await fresh(scenario.options);
        await panel.getByRole('checkbox', { name: 'Стоп-слова включены', exact: true }).uncheck();
        state.nextStop = {
          status: 400,
          body: { issues: [{ path: scenario.issue, message: scenario.message }] },
        };
        await save().click();
        const target = page
          .getByRole('textbox', { name: scenario.target, exact: true })
          .or(page.getByRole('spinbutton', { name: scenario.target, exact: true }));
        await target.waitFor();
        await page.waitForFunction(
          (label) =>
            document.activeElement?.getAttribute('aria-label') === label ||
            document.activeElement?.getAttribute('aria-labelledby')?.includes('speech'),
          scenario.target,
        );
        if (scenario.value) assert.equal(await target.inputValue(), scenario.value);
        assert.equal(await target.getAttribute('aria-invalid'), 'true');
        const describedBy = await target.getAttribute('aria-describedby');
        assert.ok(describedBy, `${scenario.target} must expose its error to accessibility`);
        await page.getByText(scenario.message, { exact: true }).first().waitFor();
        await waitForFailedSave();
        await assertReachable(target);
        await page.screenshot({
          path: path.join(screenshots, `${name}-validation-${scenario.issue.join('-')}.png`),
          fullPage: false,
        });
        if (scenario.value) {
          await target.fill('исправленная запись');
          await page
            .getByRole('dialog', { name: 'Правило', exact: true })
            .getByRole('button', { name: 'Применить', exact: true })
            .click();
        } else if (scenario.target === 'Ссылка кнопки 2') {
          await target.fill('https://fixed.example');
        } else if (scenario.target === 'Длительность ограничения, часов') {
          await target.fill('13');
        } else {
          await target.fill('Исправленное объяснение');
          await page
            .getByRole('dialog', { name: 'Объяснение', exact: true })
            .getByRole('button', { name: 'Закрыть редактор', exact: true })
            .click();
        }
        const correctedRequest = page.waitForRequest('**/api/chats/*/stop-words');
        await save().click();
        await correctedRequest;
        await panel.waitFor({ state: 'hidden' });
      }
      console.log(
        'PASS real page: indexed validation opens rule124, sanctions and speech portal, then focuses the actual invalid control',
      );

      await fresh({ invalid: true });
      await panel.getByRole('button', { name: 'Создать новый список', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Создать новый список?', exact: true })
        .getByRole('button', { name: 'Создать', exact: true })
        .click();
      await page.getByRole('link', { name: 'Чат B', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Сохранить изменения?', exact: true })
        .getByRole('button', { name: 'Выйти без сохранения', exact: true })
        .click();
      await waitUntil(
        () => state.lastScreenChat === 'chat-b',
        'navigate B after discarding approval',
      );
      await page.getByRole('link', { name: 'Чат A', exact: true }).click();
      await waitUntil(
        () => state.lastScreenChat === 'chat-a',
        'return A after discarding approval',
      );
      if (!(await panel.isVisible()))
        await page.getByRole('button', { name: 'Стоп-слова', exact: true }).click();
      await panel.getByRole('button', { name: 'Создать новый список', exact: true }).waitFor();
      assert.equal(await words(true).isDisabled(), true);
      assert.equal(state.writes.length, 0);
      console.log('PASS real page: replacement approval cannot survive A→B→A');

      await fresh({ links: true });
      await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await page.getByRole('button', { name: 'Ссылки', exact: true }).click();
      const links = page.locator('.links-panel');
      const sites = links
        .locator('details')
        .filter({ has: page.getByText('Сайты из стоп-слов', { exact: true }) });
      await sites.locator(':scope > summary').click();
      await sites
        .getByRole('textbox', { name: 'Добавить запрещённые сайты', exact: true })
        .fill('new.example');
      await sites.getByRole('button', { name: 'Добавить записи', exact: true }).click();
      await links.getByRole('button', { name: 'Добавить', exact: true }).click();
      const pendingLink = links.getByRole('textbox', { name: 'Ссылка или сайт', exact: true });
      await pendingLink.fill('https://example.com/pending');
      await sites.getByRole('button', { name: 'Сохранить сайты', exact: true }).click();
      await waitUntil(
        () => state.writes.length === 1 && state.saved['chat-a'].stopWordsRevision === 8,
        'sites save independently of pending link',
      );
      assert.equal(state.writes[0].pathname, '/api/chats/chat-a/stop-words');
      assert.equal(state.writes[0].body.expectedRevision, 7);
      assert.deepEqual(state.writes[0].body.policy.domains, ['blocked.example', 'new.example']);
      assert.equal(await pendingLink.inputValue(), 'https://example.com/pending');
      await page.getByRole('link', { name: 'Чат B', exact: true }).click();
      const leaveLink = page.getByRole('dialog', { name: 'Сохранить изменения?', exact: true });
      await leaveLink.getByRole('button', { name: 'Сохранить и перейти', exact: true }).click();
      await leaveLink.getByRole('button', { name: 'Сохранить и перейти', exact: true }).waitFor();
      await leaveLink.getByRole('button', { name: 'Отмена', exact: true }).click();
      await leaveLink.waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 1, 'global Save retains the pending-rule barrier');
      assert.equal(await links.isVisible(), true, 'global Save returns to Links');
      assert.equal(await pendingLink.inputValue(), 'https://example.com/pending');
      await links
        .getByRole('region', { name: 'Добавление правила', exact: true })
        .getByRole('button', { name: 'Добавить', exact: true })
        .click();
      await page
        .locator('.settings-drilldown__panel--links')
        .getByRole('button', { name: 'Сохранить', exact: true })
        .click();
      await links.waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 2);
      assert.equal(state.writes[1].pathname, '/api/chats/chat-a/settings/section');
      assert.equal(
        state.writes[1].body.changes.linkRulesPolicy.rules[0].target,
        'https://example.com/pending',
      );
      console.log(
        `PASS ${name}: sites revision saves with pending link; global Save returns to Links; explicit Add then saves link policy`,
      );
      assert.deepEqual(errors, []);
    } catch (error) {
      if (page) {
        console.error(
          `Stop-word failure screenshot: ${path.join(screenshots, `${name}-failure.png`)}`,
        );
        console.error(
          await page
            .evaluate(() => ({
              active: document.activeElement?.outerHTML.slice(0, 600),
              textareas: [...document.querySelectorAll('textarea')].map((element) => ({
                label: element.getAttribute('aria-label'),
                hidden: Boolean(element.closest('[hidden]')),
                disabled: element.matches(':disabled'),
                rectangles: element.getClientRects().length,
              })),
              rules: [...document.querySelectorAll('input[aria-label="Слово или фраза"]')].map(
                (element) => ({
                  value: element.value,
                  disabled: element.matches(':disabled'),
                  rectangles: element.getClientRects().length,
                }),
              ),
              alerts: [...document.querySelectorAll('[role="alert"]')]
                .filter((element) => element.getClientRects().length)
                .map((element) => element.textContent),
            }))
            .catch(() => 'Page already unavailable'),
        );
        await page
          .screenshot({ path: path.join(screenshots, `${name}-failure.png`), fullPage: false })
          .catch(() => {});
      }
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`Stop-word mobile screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
