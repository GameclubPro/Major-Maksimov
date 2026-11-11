import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
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
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

export async function checkReportsPeriod({ page, output, name }) {
  const period = page.locator('.reports-period');
  await period.locator('summary').click();
  const apply = period.getByRole('button', { name: 'Применить период', exact: true });
  for (const font of ['16px', '32px']) {
    await page.evaluate((value) => (document.documentElement.style.fontSize = value), font);
    await apply.scrollIntoViewIfNeeded();
    const evidence = await apply.evaluate((node) => {
      const style = getComputedStyle(node),
        box = node.getBoundingClientRect(),
        range = document.createRange();
      range.selectNodeContents(node);
      const channels = (color) => color.match(/[\d.]+/g).map(Number);
      const lum = (rgb) =>
        rgb
          .slice(0, 3)
          .map((value) => {
            const c = value / 255;
            return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          })
          .reduce((total, c, index) => total + c * [0.2126, 0.7152, 0.0722][index], 0);
      const foreground = channels(style.color),
        background = channels(style.backgroundColor),
        a = lum(foreground),
        b = lum(background);
      return {
        color: style.color,
        background: style.backgroundColor,
        image: style.backgroundImage,
        opaque: background.length === 3 || background[3] === 1,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        painted: node.checkVisibility() && node.innerText.trim().length > 0,
        rect: box.toJSON(),
        textFits: [...range.getClientRects()].every(
          (r) => r.left >= box.left - 1 && r.right <= box.right + 1,
        ),
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    assert.ok(
      evidence.painted &&
        evidence.opaque &&
        evidence.image === 'none' &&
        evidence.ratio >= 4.5 &&
        evidence.textFits &&
        evidence.overflow <= 1,
      JSON.stringify(evidence),
    );
    console.log(`Report Period ${name}/${font}: ${JSON.stringify(evidence)}`);
    await page.screenshot({ path: `${output}/${name}-period-${font}.png` });
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = '16px'));
  await period.getByLabel('С даты', { exact: true }).fill('2026-11-10');
  await period.getByLabel('По дату', { exact: true }).fill('2026-11-01');
  await apply.click();
  await period.getByRole('alert').waitFor();
  assert.equal(
    await period.getByLabel('По дату', { exact: true }).getAttribute('aria-invalid'),
    'true',
  );
  await period.getByLabel('По дату', { exact: true }).fill('2026-11-11');
  await apply.click();
  await period.getByRole('alert').waitFor({ state: 'detached' });
  assert.match(await period.locator('summary').innerText(), /выбран/u);
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  await period.locator('summary').click();
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/'),
    output = await mkdtemp('/tmp/maxim-reports-period-'),
    server = await ensureMiniappDevServer(base);
  console.log(`Report Period artifacts: ${output}`);
  try {
    for (const [name, engine, width, height, platform] of [
      ['chromium', chromium, 360, 700, 'android'],
      ['webkit', webkit, 320, 504, 'ios'],
    ]) {
      if (process.env.REPORTS_PERIOD_ENGINE && process.env.REPORTS_PERIOD_ENGINE !== name) continue;
      const browser = await engine.launch(captureBrowserLaunchOptions(name, base));
      try {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height },
            isMobile: true,
            hasTouch: true,
            colorScheme: theme,
            reducedMotion: 'reduce',
          });
          try {
            await context.route('**/*', (route) =>
              new URL(route.request().url()).origin === new URL(base).origin
                ? route.continue()
                : route.abort(),
            );
            await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
            await installNativeVisualModeInitScript(context);
            const page = await context.newPage();
            page.setDefaultTimeout(12000);
            await page.goto(`${base}chat/preview-chat/settings?preview=1`);
            await page.getByRole('button', { name: 'Система жалоб', exact: true }).click();
            await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
            await page.getByRole('tab', { name: 'Журнал', exact: true }).click();
            await page.locator('.reports-journal__item').first().waitFor();
            await checkReportsPeriod({ page, output, name: `${name}-${theme}` });
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await stopChildProcess(server);
  }
}
