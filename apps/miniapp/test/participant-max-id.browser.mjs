import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const output = await mkdtemp(join(tmpdir(), 'maxim-participant-id-'));
const server = await ensureMiniappDevServer(base);
try {
  for (const [engineName, engine, width, hasHandle, denied] of [
    ['chromium', chromium, 320, true, true],
    ['chromium', chromium, 360, false, false],
    ['webkit', webkit, 390, true, false],
    ['webkit', webkit, 430, false, true],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      const colorScheme = width < 390 ? 'dark' : 'light';
      const context = await browser.newContext({
        viewport: { width, height: 760 },
        isMobile: true,
        hasTouch: true,
        colorScheme,
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        { platform: engineName === 'webkit' ? 'ios' : 'android' },
        { colorScheme },
      );
      const fixture = {
        userId: '987654321098765432109876',
        userDisplayName: 'Анна Лисова',
        username: hasHandle ? 'anna_lisova' : null,
        role: 'admin',
        profileUrl: null,
      };
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      // Seed only the local preview roster; navigation, search and participant details use the real app.
      await context.route(/\/src\/lib\/api\/preview-transport\.ts(?:\?.*)?$/u, async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const marker = 'const state = createPreviewState(options);';
        assert.ok(source.includes(marker));
        await route.fulfill({
          response,
          body: source.replace(
            marker,
            marker + ' Object.assign(state.chatParticipants[0], ' + JSON.stringify(fixture) + ');',
          ),
        });
      });
      await context.addInitScript((reject) => {
        Object.defineProperty(navigator, 'clipboard', {
          value: {
            writeText: async (value) => {
              if (reject) throw new DOMException('denied', 'NotAllowedError');
              window.recordedClipboard = value;
            },
          },
        });
      }, denied);
      const page = await context.newPage();
      await page.goto(new URL('?preview=1', base).href);
      const statistics = page.locator('a[data-action="statistics"][href*="preview-chat/"]');
      await statistics.first().click();
      await page
        .getByRole('group', { name: 'Раздел статистики' })
        .getByRole('button', { name: 'Участники', exact: true })
        .click();
      await page.getByRole('searchbox', { name: 'Поиск участника' }).fill(fixture.userDisplayName);
      const row = page
        .locator('.participants-roster__list')
        .getByRole('button', { name: /Анна Лисова/ });
      await row.click();
      const card = page.locator('.participant-card');
      await card.locator('.participant-card__loading').waitFor({ state: 'hidden' });
      const id = card.getByRole('textbox', { name: 'ID MAX', exact: true });
      assert.equal(await id.inputValue(), fixture.userId);
      assert.equal(
        await card.getByText('@anna_lisova', { exact: true }).count(),
        hasHandle ? 1 : 0,
      );
      await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 16 });
      const copy = card.getByRole('button', { name: 'Скопировать ID MAX' });
      await copy.click();
      await card
        .getByText(denied ? 'Скопируйте выделенные цифры вручную.' : 'ID скопирован', {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.evaluate(() => window.recordedClipboard),
        denied ? undefined : fixture.userId,
      );
      if (denied)
        assert.equal(
          await id.evaluate(
            (el) =>
              el === document.activeElement &&
              el.value.slice(el.selectionStart, el.selectionEnd) === el.value,
          ),
          true,
        );
      const digits = await id.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        row: el.parentElement.parentElement.clientWidth,
        card: el.closest('.participant-card').clientWidth,
      }));
      assert.ok(digits.scroll <= digits.client + 1, JSON.stringify(digits));
      const bounds = await copy.boundingBox();
      assert.ok(
        bounds && bounds.width >= 44 && bounds.height >= 44 && bounds.x + bounds.width <= width,
      );
      await page.screenshot({ path: join(output, width + '.png'), animations: 'disabled' });
      console.log(
        'PASS',
        engineName,
        width,
        hasHandle ? '@username' : 'no username',
        denied ? 'manual' : 'clipboard',
      );
    } finally {
      await browser.close();
    }
  }
  console.log('Screenshots:', output);
} finally {
  await stopChildProcess(server);
}
