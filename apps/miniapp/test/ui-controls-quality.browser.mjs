import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const output = await mkdtemp('/tmp/maxim-ui-controls-');
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
const evidence = [];
const luminance = (rgb) =>
  rgb
    .map((value) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
const rgb = (value) =>
  value
    .match(/[\d.]+/g)
    .slice(0, 3)
    .map(Number);
console.log(`UI control artifacts: ${output}`);
try {
  for (const engine of [webkit, chromium]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
    try {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width: 320, height: 568 },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          locale: 'ru-RU',
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await installMaxBridgeShimInitScript(
            context,
            { platform: engine === webkit ? 'ios' : 'android' },
            { colorScheme: theme },
          );
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          page.setDefaultTimeout(12000);
          await page.goto(`${base}?preview=1`);
          const active = page.locator('.bottom-nav__item.is-active');
          await active.waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 34 });
          const colors = await active.evaluate((node) => ({
            foreground: getComputedStyle(node).color,
            background: getComputedStyle(node).backgroundImage,
          }));
          const stops = colors.background.match(/rgba?\([^)]+\)/g).map(rgb);
          assert.equal(stops.length, 2, 'review all stops if the navigation gradient changes');
          // Both ends and all interpolation steps must pass; this also covers the actual glyph position.
          const ratios = Array.from({ length: 101 }, (_, i) =>
            contrast(
              rgb(colors.foreground),
              stops[0].map((value, channel) => value + ((stops[1][channel] - value) * i) / 100),
            ),
          );
          assert.ok(
            Math.min(...ratios) >= 4.5,
            JSON.stringify({ theme, colors, minimum: Math.min(...ratios) }),
          );
          evidence.push({
            engine: engine.name(),
            theme,
            colors,
            minimumContrast: Math.min(...ratios),
          });
          await page.screenshot({ path: `${output}/${engine.name()}-${theme}-navigation.png` });
          await page.goto(`${base}chat/preview-chat/events?section=participants&preview=1`);
          const search = page.getByRole('searchbox', { name: 'Поиск участника', exact: true });
          await search.waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          await search.fill('Алексей');
          const clear = page
            .locator('.participants-roster__search')
            .getByRole('button', { name: 'Очистить поиск', exact: true });
          await clear.waitFor();
          assert.equal(
            await search.getAttribute('type'),
            'text',
            'native WebKit search cancel must not duplicate our clear action',
          );
          const box = await clear.boundingBox();
          assert.ok(box.width >= 44 && box.height >= 44);
          await page.screenshot({ path: `${output}/${engine.name()}-${theme}-search.png` });
          await clear.click();
          assert.equal(await search.inputValue(), '');
          assert.equal(await search.evaluate((node) => document.activeElement === node), true);
          assert.equal(await clear.count(), 0);
          await page.goto(`${base}publications?preview=1&profile=publisher&compose=1`);
          const timing = page.getByRole('group', { name: 'Время публикации', exact: true });
          await timing.waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          const sizes = await timing
            .getByRole('button')
            .evaluateAll((nodes) =>
              nodes.map((node) => ({
                height: node.getBoundingClientRect().height,
                fontSize: parseFloat(getComputedStyle(node).fontSize),
              })),
            );
          assert.ok(
            sizes.every((size) => size.height >= 44 && size.fontSize >= 13),
            JSON.stringify(sizes),
          );
          console.log(
            `${engine.name()}/${theme}: contrast ${Math.min(...ratios).toFixed(2)}:1, single accessible clear, timing controls passed`,
          );
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await writeFile(`${output}/contrast.json`, JSON.stringify(evidence, null, 2));
  await stopChildProcess(server);
}
