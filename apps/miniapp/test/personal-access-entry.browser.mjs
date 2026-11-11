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
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import { runPublicMobileChecks } from './public-mobile-actions.browser.mjs';
import { checkStatisticsLaunchNavigation } from './statistics-launch-navigation.browser.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const server = await ensureMiniappDevServer(base);
const output = await mkdtemp(path.join(tmpdir(), 'maxim-personal-access-'));
let browser;
try {
  browser = await chromium.launch();
  await checkStatisticsLaunchNavigation(browser, base);
  await runPublicMobileChecks({ browser, base, output });
  for (const [deviceName, device] of [
    ['iphone', devices['iPhone 15']],
    ['android', devices['Pixel 7']],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      for (const [profile, entityType] of [
        ['moderation', 'chat'],
        ['moderation', 'channel'],
        ['publisher', 'chat'],
        ['publisher', 'channel'],
      ]) {
        const context = await browser.newContext({ ...device, colorScheme });
        try {
          // FLAG: Exercise real components through the local preview transport only.
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
            const response = await route.fetch();
            const source = await response.text();
            const marker = 'const result = await handler(context);';
            assert.ok(source.includes(marker));
            await route.fulfill({
              response,
              body: source.replace(
                marker,
                `${marker}
              if (result !== PREVIEW_NOT_HANDLED && ['/chats', '/channels', '/publisher/entities'].includes(context.url.pathname)) {
                window.__catalogLoads = (window.__catalogLoads ?? 0) + 1;
                const items = Array.isArray(result) ? result : result.items;
                if (items?.length) {
                  const expanded = Array.from({ length: 150 }, (_, i) => ({ ...items[i % items.length],
                    id: i < items.length ? items[i].id : items[i % items.length].id + '-saved-' + i }));
                  if (Array.isArray(result)) return expanded;
                  if (context.url.pathname === '/publisher/entities') return { ...result,
                    items: expanded, nextCursor: null, filteredTotal: 150,
                    summary: { total: 150, chat: context.url.searchParams.get('entityType') === 'channel' ? 0 : 150, channel: context.url.searchParams.get('entityType') === 'channel' ? 150 : 0, ready: 150, attention: 0 }, accessVerificationPending: false };
                  return { ...result, items: expanded, snapshot: null, diff: undefined,
                    refresh: { ...result.refresh, complete: true, userVisibleComplete: true,
                      backoffActive: false, nextPollAfterMs: 0 } };
                }
              }
              if (result !== PREVIEW_NOT_HANDLED && (context.url.pathname.endsWith('/settings-screen') ||
                context.url.pathname.startsWith('/publisher/entities/') && context.url.pathname.split('/').length === 5)) {
                window.__selectedChecks = (window.__selectedChecks ?? 0) + 1;
                while (window.__holdSelectedCheck) await new Promise(resolve => setTimeout(resolve, 50));
              }
            `,
              ),
            });
          });
          await installMaxBridgeShimInitScript(context, {}, { colorScheme });
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          const cards = page.locator(
            profile === 'publisher' ? '.publisher-entity-row' : '.chat-card[data-entity-id]',
          );
          await page.goto(`${base}?preview=1&profile=${profile}&view=${entityType}`);
          await cards.first().waitFor();
          await page.reload();
          await cards.first().waitFor();
          assert.ok(
            (await cards.count()) > 1,
            'Saved catalog must appear without per-chat verification',
          );
          await page.waitForTimeout(1700);
          assert.equal(
            await page.evaluate(() => window.__selectedChecks ?? 0),
            0,
            'Home must not prefetch protected settings for unopened chats',
          );
          await applyNativeVisualMode(page, {
            safeTop: deviceName === 'iphone' ? 59 : 24,
            safeBottom: deviceName === 'iphone' ? 34 : 24,
          });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          await page.screenshot({
            path: path.join(
              output,
              `${profile}-${entityType}-${deviceName}-${colorScheme}-home.png`,
            ),
          });
          const settingsLink =
            profile === 'publisher'
              ? cards.first().locator('a').first()
              : cards.first().locator('.chat-card__action--settings');
          await page.evaluate(() => {
            window.__holdSelectedCheck = true;
          });
          await settingsLink.click();
          await page.waitForFunction(() => (window.__selectedChecks ?? 0) > 0);
          // Navigation itself does not await MAX, even on a first uncached open.
          await page
            .locator(
              profile === 'publisher'
                ? '.publisher-entity-modules-page'
                : `[data-managed-entity-workspace="${entityType}-settings"]`,
            )
            .waitFor();
          await page.evaluate(() => {
            window.__holdSelectedCheck = false;
          });
          await page
            .locator(
              profile === 'publisher'
                ? '.publisher-entity-modules-page__header'
                : entityType === 'chat'
                  ? '[aria-label="Настройки чата"]'
                  : '#channel-settings-overview .channel-settings-card:first-of-type',
            )
            .waitFor();
          await page.goBack();
          await cards.first().waitFor();
          const before = await page.evaluate(() => window.__selectedChecks ?? 0);
          await page.evaluate(() => {
            window.__holdSelectedCheck = true;
          });
          await settingsLink.click();
          await page.waitForFunction((n) => window.__selectedChecks > n, before);
          await page
            .getByText('Проверяем права. Сохранённые настройки уже доступны для просмотра.', {
              exact: true,
            })
            .waitFor();
          if (profile === 'moderation' && entityType === 'chat')
            assert.equal(
              await page.locator('[aria-label="Настройки чата"]').evaluate((el) => el.inert),
              true,
            );
          if (profile === 'moderation' && entityType === 'channel')
            assert.equal(
              await page
                .locator('[aria-label="Настройки канала"]')
                .evaluate((el) => el.matches(':disabled')),
              true,
            );
          await page.screenshot({
            animations: 'disabled',
            path: path.join(
              output,
              `${profile}-${entityType}-${deviceName}-${colorScheme}-settings.png`,
            ),
          });
          await page.evaluate(() => {
            window.__holdSelectedCheck = false;
          });
          await page
            .getByText('Проверяем права. Сохранённые настройки уже доступны для просмотра.', {
              exact: true,
            })
            .waitFor({ state: 'hidden' });
          assert.deepEqual(errors, []);
          console.log(
            `PASS ${profile} ${entityType} ${deviceName} ${colorScheme}: 150 saved cards, no home probes, immediate settings, guarded cached view`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
