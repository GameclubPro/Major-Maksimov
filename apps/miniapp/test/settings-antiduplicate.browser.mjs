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

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-antiduplicate-'));

async function assertReachable(locator) {
  const actual = await locator.evaluate((element) => {
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
  assert.deepEqual(actual, { withinViewport: true, unobscured: true });
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of [
    ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
    ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
    ['android-light', devices['Pixel 7'], 'light', 'android'],
    ['android-dark', devices['Pixel 7'], 'dark', 'android'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      await installNativeVisualModeInitScript(context);
      await context.route('**/antiduplicate-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/app/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
        window.__vite_plugin_react_preamble_installed__=true;
        await import('/app/test/fixtures/settings-antiduplicate-harness.tsx');
      </script></body></html>`,
        }),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      const writes = [];
      const previews = [];
      let saved;
      let savedB;
      let rules;
      let nextRevision = '2026-10-04T02:00:00.000Z';
      let holdSectionSave = false;
      let heldSectionSave;
      const orderedMutations = [];
      const bulkSources = [];
      let responseStatus = 500;
      let observationState = 'NO_DATA';
      const diagnosticRequests = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith('/api/')) return route.continue();
        const screen = await page.evaluate(() => window.__ANTIDUPLICATE_SCREEN__);
        saved ??= screen.settings;
        savedB ??= {
          ...screen.settings,
          settingsRevision: '2026-10-04T06:00:00.000Z',
          duplicateWarnWindowSec: 21600,
        };
        rules ??= screen.rules;
        if (/\/duplicate-diagnostics(?:\/recheck)?$/u.test(pathname)) {
          diagnosticRequests.push({ pathname, method: request.method() });
          const time = new Date().toISOString();
          await route.fulfill({
            json: {
              generatedAt: time,
              enabled: true,
              mode: 'FULL',
              capability: { state: 'CONFIRMED', checkedAt: time },
              history: {
                available: true,
                since: time,
                sampledIntents: 0,
                limited: false,
                attempts: [],
              },
              observation: {
                state: observationState,
                since: time,
                until: time,
                basis: 'ATTEMPTS',
                completeness: 'BEST_EFFORT',
                supportedAttempts: observationState === 'AVAILABLE' ? 2 : null,
                verifiedAttempts: observationState === 'AVAILABLE' ? 0 : null,
                coverage: observationState === 'AVAILABLE' ? 0 : null,
                outcomes:
                  observationState === 'AVAILABLE'
                    ? [{ outcome: 'COMPARISON_FAILED', count: 2 }]
                    : [],
              },
            },
          });
          return;
        }
        if (request.method() === 'GET' && /\/chats\/chat-[ab]\/settings-screen$/u.test(pathname)) {
          const secondChat = pathname.includes('/chat-b/');
          await route.fulfill({
            json: {
              ...screen,
              settings: secondChat ? savedB : saved,
              rules: secondChat ? screen.rules : rules,
              header: { ...screen.header, title: secondChat ? 'Чат B' : 'Чат A' },
            },
          });
          return;
        }
        if (request.method() === 'POST' && pathname.endsWith('/settings/apply-section-preview')) {
          const body = request.postDataJSON();
          previews.push(body);
          const all = body.target.mode === 'all';
          await route.fulfill({
            json: {
              sourceChatId: 'chat-a',
              targetMode: body.target.mode,
              updatedChats: all ? 2 : 1,
              appliedChatIds: all ? ['chat-a', 'chat-b'] : ['chat-a'],
              sampleChats: [],
            },
          });
          return;
        }
        writes.push({ pathname, method: request.method(), body: request.postDataJSON() });
        orderedMutations.push(`${request.method()} ${pathname}`);
        if (
          pathname === '/api/chats/chat-a/settings/apply-section-to-all' &&
          request.method() === 'POST'
        ) {
          bulkSources.push(structuredClone(saved));
          await route.fulfill({
            json: {
              section: 'duplicates',
              sourceChatId: 'chat-a',
              sourceSettingsRevision: saved.settingsRevision,
              targetMode: 'all',
              updatedChats: 2,
              appliedChatIds: ['chat-a', 'chat-b'],
            },
          });
          return;
        }
        if (pathname === '/api/chats/chat-a/rules' && request.method() === 'PUT') {
          rules = { ...rules, ...request.postDataJSON() };
          await route.fulfill({ json: rules });
          return;
        }
        if (pathname === '/api/chats/chat-a/rules/publish' && request.method() === 'POST') {
          rules = {
            ...rules,
            publishedMessageId: 'rules-post',
            publishedAt: '2026-10-04T05:00:00.000Z',
          };
          await route.fulfill({
            json: {
              chatId: 'chat-a',
              messageId: 'rules-post',
              url: null,
              publishedAt: rules.publishedAt,
              operation: 'created',
            },
          });
          return;
        }
        if (
          !/\/chats\/chat-[ab]\/settings\/section$/u.test(pathname) ||
          request.method() !== 'PATCH'
        ) {
          await route.fulfill({ status: 500, json: { message: 'Unexpected mutation' } });
          return;
        }
        if (holdSectionSave && pathname.includes('/chat-a/')) {
          heldSectionSave = route;
          return;
        }
        if (pathname.includes('/chat-b/')) {
          savedB = {
            ...savedB,
            ...request.postDataJSON().changes,
            settingsRevision: '2026-10-04T07:00:00.000Z',
          };
          await route.fulfill({ json: savedB });
          return;
        }
        if (responseStatus === 200) {
          saved = {
            ...saved,
            ...request.postDataJSON().changes,
            settingsRevision: nextRevision,
          };
          await route.fulfill({ json: saved });
        } else {
          if (responseStatus === 409)
            saved = {
              ...saved,
              settingsRevision: '2026-10-04T01:00:00.000Z',
              duplicatePhotoScope: 'SAME_AUTHOR',
            };
          await route.fulfill({
            status: responseStatus,
            json: {
              message: 'Не удалось сохранить',
              code: responseStatus === 409 ? 'CHAT_SETTINGS_CONCURRENT_UPDATE' : 'INTERNAL_ERROR',
            },
          });
        }
      });
      await page.goto(`${base}antiduplicate-test`);
      await page.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
      }, colorScheme);
      await page.getByRole('button', { name: 'Антидубль', exact: true }).click();
      const safeAreas = {
        safeTop: platform === 'ios' ? 44 : 24,
        safeBottom: platform === 'ios' ? 34 : 0,
      };
      await applyNativeVisualMode(page, safeAreas);
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      const diagnostics = panel.locator('.duplicate-diagnostics');
      await diagnostics.getByText('Проверка и история', { exact: true }).click();
      await diagnostics.getByText('Данные о проверках ещё не поступили', { exact: true }).waitFor();
      assert.equal(await diagnostics.getByText(/\(0%\)/u).count(), 0);
      await diagnostics.getByText('Проверка и история', { exact: true }).click();
      observationState = 'AVAILABLE';
      const rechecked = page.waitForResponse((response) =>
        response.url().endsWith('/duplicate-diagnostics/recheck'),
      );
      await diagnostics.getByRole('button', { name: 'Проверить права', exact: true }).click();
      await rechecked;
      await diagnostics.getByText('Проверка и история', { exact: true }).click();
      await diagnostics
        .getByText('Сравнение завершено: 0 из 2 поддерживаемых попыток (0%)', { exact: true })
        .waitFor();
      await diagnostics.getByText('Сравнение не завершилось', { exact: true }).waitFor();
      await diagnostics
        .getByText('Результат сравнения не подтверждает удаление сообщения.', { exact: true })
        .waitFor();
      assert.equal(await diagnostics.getByText('Удалено', { exact: true }).count(), 0);
      await diagnostics.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, `${name}-diagnostics.png`) });
      observationState = 'UNAVAILABLE';
      const unavailable = page.waitForResponse((response) =>
        response.url().endsWith('/duplicate-diagnostics/recheck'),
      );
      await diagnostics.getByRole('button', { name: 'Проверить права', exact: true }).click();
      await unavailable;
      await diagnostics
        .getByText('Статистика проверок временно недоступна', { exact: true })
        .waitFor();
      assert.equal(await diagnostics.getByText(/\(0%\)/u).count(), 0);
      assert.ok(
        diagnosticRequests.some(
          (request) =>
            request.method === 'GET' &&
            request.pathname === '/api/chats/chat-a/duplicate-diagnostics',
        ),
      );
      assert.equal(
        diagnosticRequests.filter(
          (request) =>
            request.method === 'POST' &&
            request.pathname === '/api/chats/chat-a/duplicate-diagnostics/recheck',
        ).length,
        2,
      );
      await diagnostics.getByText('Проверка и история', { exact: true }).click();
      const compare = panel.getByRole('combobox', { name: 'Сравнение сообщений' });
      assert.equal(await compare.count(), 0);
      const scope = panel.getByRole('radiogroup', { name: 'Чьи картинки сравнивать' });
      const master = panel.locator('label[aria-label="Включить антидубль"] input');
      await master.uncheck();
      assert.equal(await scope.count(), 0);
      await master.check();
      await panel.getByRole('button', { name: 'Применить к другим чатам', exact: true }).click();
      const currentTarget = page.getByRole('button', { name: 'Этот чат', exact: true });
      assert.equal(await currentTarget.getAttribute('aria-pressed'), 'true');
      assert.equal(
        await page
          .getByRole('button', { name: 'Все чаты', exact: true })
          .getAttribute('aria-pressed'),
        'false',
      );
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await currentTarget.waitFor({ state: 'hidden' });
      assert.equal(await scope.isVisible(), true);
      assert.equal(writes.length, 0);
      const allParticipants = scope.getByRole('radio', { name: 'Всех участников', exact: true });
      const sameAuthor = scope.getByRole('radio', { name: 'Одного участника', exact: true });
      assert.equal(await sameAuthor.getAttribute('aria-checked'), 'true');
      await allParticipants.click();
      assert.equal(await allParticipants.getAttribute('aria-checked'), 'true');
      assert.equal(await panel.getByText('Подпись', { exact: true }).count(), 0);
      assert.equal(await panel.getByText('Как для текста', { exact: true }).count(), 0);
      await scope.scrollIntoViewIfNeeded();
      await assertReachable(scope);
      await page.screenshot({ path: path.join(screenshots, `${name}-all-participants.png`) });
      await sameAuthor.click();
      assert.equal(await sameAuthor.getAttribute('aria-checked'), 'true');
      await allParticipants.click();
      const interval = panel.getByRole('spinbutton', { name: 'Период проверки дублей, часы' });
      // Emulate keyboard viewport shrink; this is a browser check, not a physical device run.
      const fullViewport = page.viewportSize();
      await interval.focus();
      await page.setViewportSize({
        width: fullViewport.width,
        height: Math.max(320, fullViewport.height - 300),
      });
      await applyNativeVisualMode(page, safeAreas);
      await interval.fill('');
      await interval.pressSequentially('13');
      await interval.scrollIntoViewIfNeeded();
      assert.equal(await interval.inputValue(), '13');
      assert.equal(await interval.evaluate((element) => element === document.activeElement), true);
      await assertReachable(interval);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-keyboard-emulated.png`) });
      await page.setViewportSize(fullViewport);
      await applyNativeVisualMode(page, safeAreas);
      await interval.blur();
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
      assert.equal(await interval.inputValue(), '13');

      // Bridge Back asks before abandoning edits; Back on that prompt keeps the draft.
      const beforeNativeBackWrites = writes.length;
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      const discardPrompt = page.getByRole('dialog', {
        name: 'Не сохранять изменения?',
        exact: true,
      });
      await discardPrompt.waitFor();
      await assertReachable(
        discardPrompt.getByRole('button', { name: 'Продолжить настройку', exact: true }),
      );
      assert.equal(await panel.isVisible(), true);
      assert.equal(await interval.inputValue(), '13');
      assert.equal(writes.length, beforeNativeBackWrites);
      await page.screenshot({ path: path.join(screenshots, `${name}-native-back-draft.png`) });
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await discardPrompt.waitFor({ state: 'hidden' });
      assert.equal(await panel.isVisible(), true);
      assert.equal(await interval.inputValue(), '13');
      assert.equal(await compare.count(), 0);
      assert.equal(
        await scope
          .getByRole('radio', { name: 'Всех участников', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      assert.equal(writes.length, beforeNativeBackWrites);
      await panel.getByRole('radio', { name: 'По времени', exact: true }).click();
      const start = panel.getByRole('button', { name: 'С: 09:00', exact: true });
      await start.click();
      await page
        .getByRole('listbox', { name: 'Часы' })
        .getByRole('option', { name: '23', exact: true })
        .click();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.getByRole('listbox', { name: 'Часы' }).waitFor({ state: 'hidden' });
      assert.equal(await start.isVisible(), true, 'Native Back cancels time editing only');
      await start.click();
      await page
        .getByRole('listbox', { name: 'Часы' })
        .getByRole('option', { name: '23', exact: true })
        .click();
      await page.getByRole('button', { name: 'Применить', exact: true }).click();
      await panel.getByRole('combobox', { name: 'Часовой пояс' }).selectOption('Asia/Vladivostok');
      await panel
        .getByText('Ежедневно, с переходом на следующий день.', { exact: false })
        .waitFor();
      const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
      const submit = async () => {
        const received = page.waitForResponse((response) =>
          response.url().endsWith('/settings/section'),
        );
        await save.click();
        await received;
        if (responseStatus === 409) {
          await panel
            .getByRole('button', { name: 'Сравнить с сохранённым', exact: true })
            .waitFor();
        } else {
          await save.waitFor();
        }
      };
      await submit();
      assert.equal(await allParticipants.getAttribute('aria-checked'), 'true');
      assert.equal(
        await scope
          .getByRole('radio', { name: 'Всех участников', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      assert.equal(
        await panel.getByRole('button', { name: 'С: 23:00', exact: true }).isVisible(),
        true,
      );
      responseStatus = 409;
      await submit();
      const closeToast = page.getByRole('button', { name: 'Закрыть уведомление', exact: true });
      while (await closeToast.count()) await closeToast.first().click();
      await page.screenshot({ path: path.join(screenshots, `${name}-conflict.png`) });
      await panel.getByRole('button', { name: 'Сравнить с сохранённым', exact: true }).click();
      assert.equal(await sameAuthor.getAttribute('aria-checked'), 'true');
      await panel.getByRole('button', { name: 'Показать мой черновик', exact: true }).click();
      assert.equal(await allParticipants.getAttribute('aria-checked'), 'true');
      responseStatus = 200;
      const succeeded = page.waitForResponse(
        (response) => response.url().endsWith('/settings/section') && response.status() === 200,
      );
      await panel.getByRole('button', { name: 'Сохранить мой вариант', exact: true }).click();
      await succeeded;
      await panel
        .getByRole('button', { name: 'Сохранить мой вариант', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(writes.length, 3);
      assert.ok(previews.length > 0);
      assert.ok(previews.every((preview) => preview.target.mode === 'current'));
      assert.ok(
        writes.every(
          (write) =>
            write.pathname === '/api/chats/chat-a/settings/section' && write.method === 'PATCH',
        ),
      );
      const final = writes.at(-1).body;
      assert.equal(final.section, 'duplicates');
      assert.equal(final.expectedRevision, '2026-10-04T01:00:00.000Z');
      assert.equal(Object.hasOwn(final.changes, 'duplicateCompareMode'), false);
      assert.equal(final.changes.duplicatePhotoScope, 'CHAT');
      assert.equal(final.changes.duplicateWindowMode, 'DAILY');
      assert.equal(final.changes.duplicateStartTimeMinutes, 1380);
      assert.equal(final.changes.duplicateEndTimeMinutes, 1080);
      assert.equal(final.changes.duplicateTimezone, 'Asia/Vladivostok');
      assert.equal(final.changes.duplicateWarnWindowSec, 46800);
      assert.equal('rules' in final.changes, false);
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await panel.waitFor({ state: 'hidden' });

      await page.getByRole('button', { name: 'Антидубль', exact: true }).click();
      const savedToast = page.locator('.toast--success').last();
      await savedToast.waitFor({ state: 'visible' });
      const toastBox = await savedToast.boundingBox();
      const headerBox = await panel.locator('.settings-drilldown__header').boundingBox();
      assert.ok(toastBox && headerBox);
      assert.ok(
        toastBox.y >= headerBox.y + headerBox.height,
        'Saved toast must leave the header clear',
      );
      const dismissBox = await savedToast
        .getByRole('button', { name: 'Закрыть уведомление' })
        .boundingBox();
      assert.ok(dismissBox && dismissBox.width >= 44 && dismissBox.height >= 44);
      await assertReachable(
        panel.getByRole('button', { name: 'Применить к другим чатам', exact: true }),
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-saved-toast.png`) });

      // Reload from the saved API response, rather than retaining the local draft.
      const readback = page.waitForResponse('**/api/chats/chat-a/settings-screen');
      await page.reload();
      assert.equal((await (await readback).json()).settings.duplicatePhotoScope, 'CHAT');
      await page.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
      }, colorScheme);
      await applyNativeVisualMode(page, safeAreas);

      // Full-page bulk application must save the edited source before copying it.
      await page.getByRole('button', { name: 'Антидубль', exact: true }).click();
      assert.equal(await allParticipants.getAttribute('aria-checked'), 'true');
      await sameAuthor.click();
      await panel.getByRole('button', { name: 'Применить к другим чатам', exact: true }).click();
      const targetSheet = page
        .getByRole('dialog', { name: 'Антидубль', exact: true })
        .and(page.locator('.settings-apply-target__panel'));
      assert.equal(
        await targetSheet
          .getByRole('button', { name: 'Этот чат', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      );
      const allPreview = page.waitForResponse(
        (response) =>
          response.url().endsWith('/settings/apply-section-preview') &&
          response.request().postDataJSON().target.mode === 'all',
      );
      await targetSheet.getByRole('button', { name: 'Все чаты', exact: true }).click();
      await allPreview;
      assert.equal(
        writes.filter((write) => write.pathname.endsWith('/apply-section-to-all')).length,
        0,
      );
      nextRevision = '2026-10-04T03:00:00.000Z';
      const bulkStart = orderedMutations.length;
      const bulkApplied = page.waitForResponse((response) =>
        response.url().endsWith('/settings/apply-section-to-all'),
      );
      await targetSheet.getByRole('button', { name: 'Применить', exact: true }).click();
      await bulkApplied;
      await targetSheet.waitFor({ state: 'hidden' });
      await panel.waitFor({ state: 'hidden' });
      assert.deepEqual(orderedMutations.slice(bulkStart), [
        'PATCH /api/chats/chat-a/settings/section',
        'POST /api/chats/chat-a/settings/apply-section-to-all',
      ]);
      const sourceWrite = writes.at(-2).body;
      assert.equal(sourceWrite.section, 'duplicates');
      assert.equal(sourceWrite.expectedRevision, '2026-10-04T02:00:00.000Z');
      assert.equal(Object.hasOwn(sourceWrite.changes, 'duplicateCompareMode'), false);
      assert.equal(sourceWrite.changes.duplicatePhotoScope, 'SAME_AUTHOR');
      assert.equal(sourceWrite.changes.duplicateWindowMode, 'DAILY');
      assert.deepEqual(writes.at(-1).body, {
        section: 'duplicates',
        target: { mode: 'all', favoriteTypes: [], chatIds: [] },
      });
      assert.equal(bulkSources.length, 1);
      assert.equal(bulkSources[0].settingsRevision, nextRevision);
      assert.equal(bulkSources[0].duplicatePhotoScope, 'SAME_AUTHOR');
      assert.equal(bulkSources[0].duplicateStartTimeMinutes, 1380);
      assert.equal(bulkSources[0].duplicateEndTimeMinutes, 1080);
      assert.equal(bulkSources[0].duplicateTimezone, 'Asia/Vladivostok');

      // Generate from the saved overnight schedule through the real rules editor.
      await page.getByRole('button', { name: 'Правила', exact: true }).click();
      const rulesPanel = page.locator('.settings-drilldown__panel--rules');
      const editor = rulesPanel.getByRole('textbox', { name: 'Текст правил', exact: true });
      await editor.getByText('Авторские правила — сохранить дословно.', { exact: true }).waitFor();
      assert.equal(writes.filter((write) => write.pathname.endsWith('/rules')).length, 0);
      const autoTextToggle = rulesPanel.locator(
        'label[aria-label="Включить автотекст правил из настроек"] input',
      );
      const scheduleText =
        'Антидубль действует ежедневно с 23:00 до 18:00 следующего дня (Asia/Vladivostok). Вне этого периода повторы разрешены.';
      const [generatedResponse] = await Promise.all([
        page.waitForResponse(
          (response) => response.url().endsWith('/rules') && response.request().method() === 'PUT',
        ),
        (async () => {
          // The switch changes after the lazy generator succeeds, preserving drafts on failure.
          await autoTextToggle.click();
          await editor.getByText(scheduleText, { exact: false }).waitFor();
          assert.equal(await autoTextToggle.isChecked(), true);
        })(),
      ]);
      const generatedText = (await editor.innerText()).trim();
      const generatedBody = generatedResponse.request().postDataJSON();
      assert.equal(generatedBody.autoTextEnabled, true);
      assert.equal(generatedBody.textFormat, 'plain');
      assert.equal(generatedBody.text.trim(), generatedText);
      assert.ok(generatedBody.text.includes(scheduleText));
      assert.equal(generatedBody.text.includes('Авторские правила'), false);
      assert.equal(Object.hasOwn(generatedBody, 'publishedMessageId'), false);
      const published = page.waitForResponse((response) =>
        response.url().endsWith('/rules/publish'),
      );
      await rulesPanel.getByRole('button', { name: 'Опубликовать в чат', exact: true }).click();
      assert.deepEqual((await published).request().postDataJSON(), { mode: 'new_message' });
      await page.getByText('Новый пост правил опубликован', { exact: true }).waitFor();
      assert.equal(writes.filter((write) => write.pathname.endsWith('/rules/publish')).length, 1);
      assert.ok(
        orderedMutations.indexOf('PUT /api/chats/chat-a/rules') <
          orderedMutations.indexOf('POST /api/chats/chat-a/rules/publish'),
      );
      assert.equal(rules.text, generatedBody.text);
      while (await closeToast.count()) await closeToast.first().click();
      await editor.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, `${name}-generated-rules.png`) });
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await rulesPanel.waitFor({ state: 'hidden' });

      // A late source-chat receipt cannot replace the next chat's unsaved draft or revision.
      while (await closeToast.count()) await closeToast.first().click();
      await page.getByRole('button', { name: 'Антидубль', exact: true }).click();
      await allParticipants.click();
      holdSectionSave = true;
      const heldRequest = page.waitForRequest('**/api/chats/chat-a/settings/section');
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await heldRequest;
      const secondLoaded = page.waitForResponse('**/api/chats/chat-b/settings-screen');
      await page.getByRole('link', { name: 'Чат B', exact: true }).click();
      await secondLoaded;
      await interval.waitFor();
      assert.equal(await interval.inputValue(), '6');
      await interval.fill('7');
      await interval.press('Tab');
      const lateReceipt = page.waitForResponse('**/api/chats/chat-a/settings/section');
      assert.ok(heldSectionSave);
      await heldSectionSave.fulfill({
        json: {
          ...saved,
          ...heldSectionSave.request().postDataJSON().changes,
          settingsRevision: '2026-10-04T04:00:00.000Z',
        },
      });
      await lateReceipt;
      await page.waitForTimeout(100);
      assert.equal(await interval.inputValue(), '7');
      assert.equal(await compare.count(), 0);
      assert.equal(
        await panel
          .getByRole('radio', { name: 'По времени', exact: true })
          .getAttribute('aria-checked'),
        'false',
      );
      assert.equal(await closeToast.count(), 0);
      const secondSaved = page.waitForResponse('**/api/chats/chat-b/settings/section');
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      const secondBody = (await secondSaved).request().postDataJSON();
      assert.equal(secondBody.expectedRevision, '2026-10-04T06:00:00.000Z');
      assert.equal(secondBody.changes.duplicateWarnWindowSec, 25200);
      assert.equal(Object.hasOwn(secondBody.changes, 'duplicateCompareMode'), false);
      await panel.waitFor({ state: 'hidden' });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name}: unified comparison with no mode selector, author scope and saved API readback, emulated keyboard input visibility, native Back draft protection, 500/409 drafts, current default, explicit all-chat PATCH→POST, overnight generated rules PUT→publish, late-chat draft isolation and truthful coverage`,
      );
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
