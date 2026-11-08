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

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-night-status-'));
const timestamp = '2026-10-30T19:59:50.000Z';
function observation(scheduledFor, outcome) {
  return {
    enabledNow: true,
    latest: {
      sessionKey: scheduledFor,
      scheduledFor,
      catchUp: {
        state: outcome === 'sent' ? 'expired' : 'within_window',
        endsAt: '2026-10-30T22:00:00.000Z',
      },
      scheduling: 'recorded',
      delivery: {
        outcome,
        reason: outcome === 'sent' ? 'successful_receipt' : 'awaiting_first_attempt',
        sentAt: outcome === 'sent' ? scheduledFor : null,
      },
    },
  };
}
function closure() {
  return {
    observedAt: timestamp,
    scheduleEnabled: true,
    restriction: 'open',
    timezone: 'Europe/Berlin',
    opensAt: null,
    deleteRoute: 'available',
    notice: 'pending',
    recovery: 'idle',
    nextTransitionAt: '2026-10-30T20:00:00.000Z',
    notices: {
      expectationBasis: 'current_schedule',
      boundary: 'daily',
      evidenceScope: 'exact_send_ledger',
      sendRouteNow: 'available',
      close: observation('2026-10-29T20:00:00.000Z', 'pending'),
      open: observation('2026-10-30T06:00:00.000Z', 'sent'),
      recovery: { scope: 'latest_occurrences', observation: 'complete', obligations: [] },
    },
  };
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
      await context.route('**/night-status-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/app/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/app/test/fixtures/settings-night-status-harness.tsx");</script></body></html>',
        }),
      );
      await context.route('**/night-screen-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/app/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/app/test/fixtures/settings-night-screen-harness.tsx");</script></body></html>',
        }),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.clock.install({ time: new Date(timestamp) });
      await page.clock.pauseAt(new Date(timestamp));
      let reads = 0;
      let responseStatus = 200;
      let savedStart = 1260;
      let savedClosure = closure();
      let settingsRevision = timestamp;
      let savedNightFields = {
        nightModeBotMessageEnabled: false,
        nightModeCommentsEnabled: false,
        nightModeOpenMessageEnabled: false,
        nightModeOpenMessageDeleteOnFirstMessageEnabled: false,
      };
      const patches = [];
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await context.route('**/api/chats/*/settings-screen', (route) => {
        reads += 1;
        return route.fulfill({
          status: responseStatus,
          json:
            responseStatus === 200
              ? {
                  settings: {
                    nightModeEnabled: true,
                    nightModeStartTimeMinutes: savedStart,
                    nightModeEndTimeMinutes: 420,
                    nightModeTimezone: 'Europe/Berlin',
                    commentsEnabled: false,
                    ...savedNightFields,
                    settingsRevision,
                  },
                  closure: savedClosure,
                  rules: {},
                  domains: [],
                  header: {
                    id: 'chat-a',
                    title: 'Проверка ночного режима',
                    entityType: 'chat',
                    link: null,
                    participantsCount: null,
                  },
                }
              : { code: 'UPSTREAM_UNAVAILABLE' },
        });
      });
      await context.route('**/api/chats/*/settings/section', async (route) => {
        const body = route.request().postDataJSON();
        patches.push(body);
        savedNightFields = {
          nightModeBotMessageEnabled: body.changes.nightModeBotMessageEnabled,
          nightModeCommentsEnabled: body.changes.nightModeCommentsEnabled,
          nightModeOpenMessageEnabled: body.changes.nightModeOpenMessageEnabled,
          nightModeOpenMessageDeleteOnFirstMessageEnabled:
            body.changes.nightModeOpenMessageDeleteOnFirstMessageEnabled,
        };
        savedStart = body.changes.nightModeStartTimeMinutes;
        settingsRevision = '2026-10-30T20:01:00.000Z';
        await route.fulfill({ json: { ...body.changes, settingsRevision } });
      });
      const settle = async () => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          await page.clock.runFor(10);
          if (await page.getByTestId('fetch-state').evaluate((node) => node.textContent === 'idle'))
            return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('Settings request did not settle');
      };
      const focus = async () => {
        await page.clock.runFor(1000);
        const response = page.waitForResponse('**/api/chats/*/settings-screen');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await response;
        await page.clock.runFor(10);
        await settle();
      };
      const initialResponse = page.waitForResponse('**/api/chats/*/settings-screen');
      await page.goto(`${base}night-status-test`);
      await initialResponse;
      await page.clock.runFor(100);
      await page.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
      }, colorScheme);
      await page.locator('.night-status__heading').waitFor();
      await settle();
      assert.equal(
        await page.getByLabel('Часовой пояс', { exact: true }).inputValue(),
        'Europe/Berlin',
      );
      assert.doesNotMatch(
        await page
          .getByLabel('Часовой пояс', { exact: true })
          .locator('option:checked')
          .innerText(),
        /Москва|Московское/,
      );
      await page.getByLabel('Начало в минутах').fill('1234');
      savedStart = 1320;
      savedClosure.notices.close.latest.delivery = {
        outcome: 'unknown',
        reason: 'ambiguous',
        sentAt: null,
      };
      const beforeFocus = reads;
      await focus();
      assert.ok(reads > beforeFocus, 'Window focus refreshes status');
      assert.equal(
        await page.getByLabel('Начало в минутах').inputValue(),
        '1234',
        'Focus refresh preserves dirty draft',
      );
      assert.doesNotMatch(
        await page.locator('.night-status').innerText(),
        /отправки|восстановлен/iu,
      );
      savedClosure = { ...savedClosure, restriction: 'night' };
      savedClosure.notices.close = observation('2026-10-30T20:00:00.000Z', 'sent');
      const beforeBoundary = reads;
      await page.clock.runFor(10_000);
      await settle();
      assert.ok(reads > beforeBoundary, 'Saved boundary triggers an automatic refresh');
      assert.equal(
        await page.getByLabel('Начало в минутах').inputValue(),
        '1234',
        'Boundary refresh preserves dirty draft',
      );
      assert.match(await page.locator('.night-status__heading').innerText(), /Чат закрыт/);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      const contrast = await page.locator('.night-status').evaluate((card) => {
        const luminance = (color) => {
          const rgb = color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const channel = value / 255;
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
            });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const background = luminance(getComputedStyle(card).backgroundColor);
        return ['.night-status__heading'].map((selector) => {
          const foreground = luminance(getComputedStyle(card.querySelector(selector)).color);
          return (
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
          );
        });
      });
      assert.ok(
        contrast.every((ratio) => ratio >= 4.5),
        `${name}: readable status contrast ${contrast}`,
      );
      await page.getByLabel('Начало в минутах').blur();
      await page.screenshot({
        path: path.join(screenshots, `${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const beforeHidden = reads;
      await page.clock.runFor(61_000);
      assert.equal(reads, beforeHidden, 'Hidden page does not poll');
      const visibleResponse = page.waitForResponse('**/api/chats/*/settings-screen');
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          value: 'visible',
        });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await visibleResponse;
      await page.clock.runFor(10);
      await settle();
      assert.ok(reads > beforeHidden, 'Returning to visible refreshes status');
      const beforePoll = reads;
      await page.clock.runFor(61_000);
      await settle();
      assert.ok(reads > beforePoll, 'Expanded visible section keeps bounded periodic refresh');
      await page.getByRole('button', { name: 'Закрыть раздел', exact: true }).click();
      const beforeCollapsed = reads;
      await page.clock.runFor(61_000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      assert.equal(
        reads,
        beforeCollapsed,
        'Collapsed section neither polls nor refreshes on focus',
      );
      await page.getByRole('button', { name: 'Открыть раздел', exact: true }).click();
      await page.locator('.night-status__heading').waitFor();
      await settle();
      responseStatus = 503;
      await focus();
      await page
        .getByText('Не удалось обновить состояние. Обновите экран.', {
          exact: true,
        })
        .waitFor();
      assert.match(await page.locator('.night-status__heading').innerText(), /Чат закрыт/);
      responseStatus = 200;
      delete savedClosure.notices;
      savedClosure.notice = 'delivered';
      await focus();
      assert.match(await page.locator('.night-status__heading').innerText(), /Чат закрыт/);
      assert.equal(await page.getByLabel('Начало в минутах').inputValue(), '1234');
      assert.equal(
        await page.locator('.night-status__notice').count(),
        0,
        'Old API does not add delivery diagnostics',
      );
      responseStatus = 403;
      await focus();
      const afterDenied = reads;
      await page.clock.runFor(61_000);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      assert.equal(reads, afterDenied, 'Access denial stops repeated status reads');
      assert.deepEqual(errors, [], `${name}: no browser errors`);
      await page.close();

      // Exercise the production settings page, its shared night fields and actual portal.
      responseStatus = 200;
      savedStart = 1260;
      savedClosure = { ...closure(), nextTransitionAt: null };
      const screen = await context.newPage();
      await screen.clock.resume();
      screen.setDefaultTimeout(20_000);
      screen.on('pageerror', (error) => {
        errors.push(error.message);
        console.error(`${name}: ${error.message}`);
      });
      await screen.goto(`${base}night-screen-test`);
      await screen.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
      }, colorScheme);
      await screen.getByRole('button', { name: 'Ночной режим', exact: true }).click();
      const panel = screen.locator('.settings-drilldown__panel--night');
      await panel.waitFor({ state: 'visible' });
      await panel.locator('.night-status__heading').waitFor();
      assert.equal(await panel.locator('.night-status').innerText(), 'Чат открыт');
      assert.doesNotMatch(
        await panel.innerText(),
        /Последние даты|Уведомление о закрытии|Уведомление об открытии|Проверено:|подтвержден|восстановлен|отправки/iu,
      );
      const nightComments = panel.getByRole('checkbox', {
        name: 'Добавить комментарии под сообщением ночного режима',
        exact: true,
      });
      assert.equal(await nightComments.count(), 0, 'Comments wait for the closing notice');
      await panel
        .getByRole('checkbox', {
          name: 'Включить сообщение от бота для ночного режима',
          exact: true,
        })
        .check();
      await nightComments.waitFor();
      assert.equal(
        await nightComments.isEnabled(),
        true,
        'Night comments do not require the retired general comments switch',
      );
      assert.equal(await nightComments.isChecked(), false, 'Night comments are opt-in');
      const commentsHint = panel.getByRole('button', {
        name: 'Как работают комментарии под ночным сообщением',
        exact: true,
      });
      assert.equal(await commentsHint.getAttribute('aria-expanded'), 'false');
      await commentsHint.click();
      const commentsExplanation = panel.getByRole('note', {
        name: 'Как работают комментарии под ночным сообщением',
        exact: true,
      });
      assert.equal(
        await commentsExplanation.innerText(),
        'Кнопка «Комментарии» под сообщением о закрытии группы.',
      );
      assert.doesNotMatch(await commentsExplanation.innerText(), /включён блок|Публик/u);
      await commentsHint.click();
      await nightComments.check();
      const cleanup = panel.getByRole('checkbox', {
        name: 'Удалять сообщение об открытии после первого сообщения участника',
        exact: true,
      });
      assert.equal(await cleanup.count(), 0, 'Cleanup setting waits for opening notice activation');
      const opening = panel.getByRole('checkbox', {
        name: 'Включить сообщение об открытии группы после ночного режима',
        exact: true,
      });
      await opening.check();
      await cleanup.waitFor();
      assert.equal(await cleanup.isChecked(), false, 'Cleanup is opt-in');
      await cleanup.check();
      await opening.uncheck();
      assert.equal(await cleanup.count(), 0);
      await opening.check();
      assert.equal(
        await cleanup.isChecked(),
        true,
        'Temporarily hiding the option keeps its draft',
      );
      const timezone = panel.getByRole('combobox');
      assert.equal(
        await timezone.inputValue(),
        'Europe/Berlin',
        'Real shared select retains saved international timezone',
      );
      assert.doesNotMatch(
        await timezone.locator('option:checked').innerText(),
        /Москва|Московское/,
      );
      await panel.locator('.night-status').screenshot({
        path: path.join(screenshots, `${name}-screen-status.png`),
        animations: 'disabled',
      });
      const start = panel.locator('.time-field__button').first();
      assert.match(await start.innerText(), /21:00/);
      await start.click();
      const picker = screen.locator('.time-field-sheet__panel');
      await picker.waitFor({ state: 'visible' });
      await picker.locator('[data-time-part="minute"][data-time-value="59"]').click();
      await screen.screenshot({
        path: path.join(screenshots, `${name}-screen-time-picker.png`),
        animations: 'disabled',
      });
      await picker.getByRole('button', { name: 'Применить', exact: true }).click();
      await picker.waitFor({ state: 'hidden' });
      assert.match(await start.innerText(), /21:59/);
      savedStart = 1320;
      savedClosure.notices.close.latest.delivery = {
        outcome: 'unknown',
        reason: 'ambiguous',
        sentAt: null,
      };
      const realFocusResponse = screen.waitForResponse('**/api/chats/*/settings-screen');
      await screen.evaluate(() => window.dispatchEvent(new Event('focus')));
      await realFocusResponse;
      assert.doesNotMatch(
        await panel.locator('.night-status').innerText(),
        /отправки|восстановлен/iu,
      );
      assert.match(
        await start.innerText(),
        /21:59/,
        'Actual night time picker draft survives status refresh',
      );
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
      assert.equal(
        await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        false,
        'Actual night panel has no horizontal overflow',
      );
      await screen.screenshot({
        path: path.join(screenshots, `${name}-screen-dirty.png`),
        animations: 'disabled',
      });
      const saved = screen.waitForResponse('**/api/chats/*/settings/section');
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await saved;
      assert.equal(patches.length, 1);
      assert.equal(patches[0].section, 'night');
      assert.equal(patches[0].expectedRevision, timestamp);
      assert.equal(patches[0].changes.nightModeBotMessageEnabled, true);
      assert.equal(patches[0].changes.nightModeCommentsEnabled, true);
      assert.equal(Object.hasOwn(patches[0].changes, 'commentsEnabled'), false);
      assert.equal(patches[0].changes.nightModeOpenMessageDeleteOnFirstMessageEnabled, true);
      assert.equal(patches[0].changes.nightModeOpenMessageEnabled, true);
      assert.equal(patches[0].changes.nightModeStartTimeMinutes, 1319);
      assert.equal(Object.hasOwn(patches[0].changes, 'linkPolicy'), false);
      await screen.reload();
      await screen.getByRole('button', { name: 'Ночной режим', exact: true }).click();
      await cleanup.waitFor();
      assert.equal(await cleanup.isChecked(), true, 'Saved cleanup setting survives a fresh read');
      assert.equal(
        await nightComments.isChecked(),
        true,
        'Night comments stay enabled after reloading with general comments still disabled',
      );
      assert.match(
        await start.innerText(),
        /21:59/,
        'Saved opening schedule survives a fresh read',
      );
      assert.deepEqual(errors, [], `${name}: actual settings page has no browser errors`);
      console.log(`${name}: passed`);
    } catch (error) {
      const failedPage = context.pages().at(-1);
      if (failedPage) {
        console.error(await failedPage.locator('body').innerText());
        await failedPage
          .screenshot({ path: path.join(screenshots, `${name}-failed.png`), fullPage: true })
          .catch(() => {});
      }
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`Night status browser regression passed. Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
