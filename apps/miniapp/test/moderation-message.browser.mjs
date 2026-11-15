import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4327/app/');
assert.ok(['localhost', '127.0.0.1'].includes(base.hostname));
const output = await mkdtemp(join(tmpdir(), 'maxim-moderation-message-'));
const server = await ensureMiniappDevServer(base.href, {
  reuseServer: process.env.MINIAPP_TEST_REUSE_SERVER === '1',
});
const browser = await chromium.launch();
try {
  for (const width of [320, 393, 430]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: width === 320 ? 568 : 851 },
        colorScheme: theme,
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        { platform: width === 393 ? 'android' : 'ios' },
        { colorScheme: theme },
      );
      await context.route('**/src/main.tsx', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `import ${JSON.stringify(new URL('test/moderation-message.fixture.tsx', base).href)};`,
        }),
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const scenario of [
        'saved',
        'partial',
        'not_captured',
        'expired',
        'media',
        'error',
        'long',
      ]) {
        await page.goto(new URL(`?case=${scenario}`, base).href);
        await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 12 });
        const panel = page.getByRole('dialog', { name: 'Сообщение', exact: true });
        await panel.waitFor();
        if (scenario === 'error') {
          await panel.getByRole('button', { name: 'Повторить', exact: true }).click();
          await panel.locator('.moderation-message__text').waitFor();
        } else if (scenario === 'expired' || scenario === 'not_captured') {
          await panel
            .getByText(scenario === 'expired' ? 'Срок хранения истёк' : 'Текст не сохранён', {
              exact: true,
            })
            .waitFor();
        } else if (scenario === 'media') {
          await panel.getByText('Фото · 2', { exact: true }).waitFor();
          await panel.getByText('Копии вложений нет', { exact: true }).waitFor();
        } else {
          await panel.locator('.moderation-message__text').waitFor();
          if (scenario === 'partial') await panel.getByText('Фрагмент', { exact: true }).waitFor();
        }
        assert.match(await panel.locator('.moderation-message__reason').innerText(), /услуги/);
        await panel.evaluate(async (node) => {
          await Promise.all(node.getAnimations().map((animation) => animation.finished));
        });
        await page.screenshot({ path: join(output, 'latest.png'), animations: 'disabled' });
        const layout = await panel.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            bottom: rect.bottom,
            top: rect.top,
            width: innerWidth,
            height: innerHeight,
            overflow: node.scrollWidth - node.clientWidth,
          };
        });
        assert.ok(
          layout.left >= 0 &&
            layout.right <= layout.width + 1 &&
            layout.bottom <= layout.height + 1 &&
            layout.top >= 0 &&
            layout.overflow <= 1,
          JSON.stringify(layout),
        );
        if (scenario === 'long') {
          await panel.locator('.moderation-message__reason').scrollIntoViewIfNeeded();
          await panel
            .getByRole('button', { name: 'Ошибка распознавания', exact: true })
            .scrollIntoViewIfNeeded();
        }
        if (['saved', 'media', 'expired'].includes(scenario))
          await page.screenshot({
            path: join(output, `${width}-${theme}-${scenario}.png`),
            animations: 'disabled',
          });
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached' });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS message details ${width}px ${theme}: saved, partial, absent, expired, media, retry, long text, Back`,
      );
      await context.close();
    }
  }
  console.log(`Screenshots: ${output}`);
} finally {
  console.log(`Visual evidence: ${output}`);
  await browser.close();
  await stopChildProcess(server);
}
