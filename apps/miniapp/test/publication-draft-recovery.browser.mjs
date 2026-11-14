import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const output = await mkdtemp(join(tmpdir(), 'publik-draft-recovery-'));
let browser;
let activePage;
try {
  browser = await chromium.launch({ headless: true });
  for (const deviceName of ['iPhone 13', 'Pixel 5']) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...devices[deviceName], colorScheme });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
        const response = await route.fetch({ maxRetries: 1 });
        const source = await response.text();
        const before = 'for (const handler of handlers) {';
        const after = 'if (result !== PREVIEW_NOT_HANDLED) {';
        assert.ok(source.includes(before) && source.includes(after));
        await route.fulfill({
          response,
          body: source
            .replace(
              before,
              `
          // Local fixture only: model the production quota without contacting MAX.
          window.__draftState = context.state;
          if (!window.__draftSeeded && context.state.publications.length) {
            window.__draftSeeded = true;
            const template = structuredClone(context.state.publications.find(p => p.targets.length));
            const post = { ...template, id: 'quota-source', title: 'Пост для копии',
              lifecycle: 'ACTIVE', version: 1, schedule: { ...template.schedule, mode: 'now' },
              content: { ...template.content, text: 'Текст исходного поста', media: [], buttons: [] },
              contentPreview: 'Текст исходного поста', mediaCount: 0, hasVideo: false };
            context.state.publications = [post, ...Array.from({ length: 50 }, (_, n) => ({
              ...structuredClone(post), id: 'quota-draft-' + n, title: 'Черновик ' + n,
              lifecycle: 'DRAFT', schedule: null, occurrences: [],
              delivery: { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 }
            }))];
          }
          if (context.url.pathname === '/publications/drafts' && context.method === 'POST' &&
              context.state.publications.filter(p => p.lifecycle === 'DRAFT').length >= 50) {
            throw Object.assign(new Error('Можно сохранить до 50 черновиков.'), { status: 400 });
          }
          if (context.method === 'DELETE' && window.__failDraftDelete) {
            window.__failDraftDelete = false;
            throw Object.assign(new Error('Не удалось удалить черновик. Повторите попытку.'), { status: 503 });
          }
          ${before}`,
            )
            .replace(
              after,
              `${after}
            (window.__draftCalls ??= []).push({ path: context.url.pathname, method: context.method,
              body: typeof context.init.body === 'string' ? JSON.parse(context.init.body) : null,
              result: structuredClone(result) });
          `,
            ),
        });
      });
      await installMaxBridgeShimInitScript(
        context,
        {},
        {
          platform: deviceName === 'Pixel 5' ? 'android' : 'ios',
          colorScheme,
        },
      );
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const click = (name) => page.getByRole('button', { name, exact: true }).click();
      const dialog = (name) => page.getByRole('dialog', { name, exact: true });
      const count = () =>
        page.evaluate(
          () => window.__draftState.publications.filter((p) => p.lifecycle === 'DRAFT').length,
        );
      const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
      const header = page.locator('.publications-editor-header');
      const duplicate = async () => {
        const card = page.locator('.publication-feed-card[data-publication-id="quota-source"]');
        await card.locator('.publication-feed-card__menu-trigger').click();
        await click('Дублировать');
        await editor.waitFor();
      };
      await page.goto(`${base}publications?preview=1&profile=publisher`);
      await page.locator('.publication-feed-card').first().waitFor();
      await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 24 });
      await duplicate();
      await page.getByText('Можно сохранить до 50 черновиков.', { exact: true }).waitFor();
      await editor.fill('Копия с моими правками');
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await dialog('Закрыть без сохранения?')
        .getByRole('button', { name: 'Остаться', exact: true })
        .click();
      assert.equal(await editor.innerText(), 'Копия с моими правками');
      await page.screenshot({ path: join(output, `${deviceName}-${colorScheme}-quota.png`) });
      await page
        .locator('.publication-draft-status')
        .getByRole('button', { name: 'Черновики', exact: true })
        .click();
      const sheet = dialog('Черновики');
      await sheet.locator('.publication-drafts-sheet__row').first().waitFor();
      for (const expected of [40, 50]) {
        await sheet.getByRole('button', { name: 'Показать ещё', exact: true }).click();
        await page.waitForFunction(
          (n) => document.querySelectorAll('.publication-drafts-sheet__row').length === n,
          expected,
        );
      }
      assert.equal(await count(), 50);
      await page.evaluate(() => {
        window.__failDraftDelete = true;
      });
      await sheet.getByRole('button', { name: 'Удалить черновик', exact: true }).last().click();
      const removal = dialog('Удалить черновик?');
      await removal.getByRole('button', { name: 'Удалить', exact: true }).click();
      await removal
        .getByText('Не удалось удалить черновик. Повторите попытку.', { exact: true })
        .waitFor();
      assert.equal(await count(), 50, 'failed delete must retain every draft');
      await removal.getByRole('button', { name: 'Удалить', exact: true }).click();
      await removal.waitFor({ state: 'detached' });
      assert.equal(await count(), 49);
      await page.screenshot({ path: join(output, `${deviceName}-${colorScheme}-drafts.png`) });
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await sheet.waitFor({ state: 'detached' });
      assert.equal(await editor.innerText(), 'Копия с моими правками');
      await page
        .locator('.publication-draft-status')
        .getByRole('button', { name: 'Повторить', exact: true })
        .click();
      await page.getByText('Сохранено', { exact: true }).waitFor();
      assert.equal(await count(), 50);
      await click('Сейчас');
      await click('Проверить пост');
      await dialog('Проверка публикации')
        .getByRole('button', { name: 'Опубликовать', exact: true })
        .click();
      await page.locator('.publications-page:not(.is-editor)').waitFor();
      assert.equal(await count(), 49);
      const published = await page.evaluate(() =>
        window.__draftCalls.filter((call) => call.body?.intent === 'publish'),
      );
      assert.equal(published.length, 1);
      assert.equal(published[0].body.content.text, 'Копия с моими правками');
      assert.notEqual(published[0].result.id, 'quota-source');
      assert.equal(
        await page.evaluate(
          () => window.__draftState.publications.find((p) => p.id === 'quota-source').content.text,
        ),
        'Текст исходного поста',
      );

      await click('Черновики');
      await sheet.locator('.publication-drafts-sheet__open').first().click();
      await header.getByRole('button', { name: 'Удалить черновик', exact: true }).click();
      await removal.getByRole('button', { name: 'Удалить', exact: true }).click();
      await page.locator('.publications-page:not(.is-editor)').waitFor();
      assert.equal(await count(), 48, 'header trash must remove the server row');
      await click('Создать публикацию');
      await click('Написать');
      await editor.fill('Новый черновик для удаления');
      await page.getByText('Сохранено', { exact: true }).waitFor();
      assert.equal(await count(), 49);
      await header.getByRole('button', { name: 'Удалить черновик', exact: true }).click();
      await removal.getByRole('button', { name: 'Удалить', exact: true }).click();
      await removal.waitFor({ state: 'detached' });
      assert.equal(await editor.innerText(), '');
      await page.waitForTimeout(1500); // beyond the autosave debounce: no empty recreation
      assert.equal(await count(), 48);
      await editor.fill('Следующий черновик');
      await page.getByText('Сохранено', { exact: true }).waitFor();
      assert.equal(await count(), 49);
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.locator('.publications-page:not(.is-editor)').waitFor();
      await click('Черновики');
      const ownRow = sheet
        .locator('.publication-drafts-sheet__row')
        .filter({ hasText: 'Следующий черновик' });
      await ownRow.getByRole('button', { name: 'Удалить черновик', exact: true }).click();
      await removal.getByRole('button', { name: 'Удалить', exact: true }).click();
      await removal.waitFor({ state: 'detached' });
      await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await click('Создать публикацию');
      await click('Написать');
      assert.equal(await editor.innerText(), '', 'deleted local draft must not be restored');
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.locator('.publications-page:not(.is-editor)').waitFor();
      await page.evaluate(() => {
        const drafts = window.__draftState.publications;
        const template = drafts.find((p) => p.lifecycle === 'DRAFT');
        for (let i = drafts.filter((p) => p.lifecycle === 'DRAFT').length; i < 50; i++)
          drafts.push({ ...structuredClone(template), id: 'quota-refill-' + i });
      });
      await duplicate();
      await page.getByText('Можно сохранить до 50 черновиков.', { exact: true }).waitFor();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await dialog('Закрыть без сохранения?')
        .getByRole('button', { name: 'Закрыть', exact: true })
        .click();
      await page.locator('.publications-page:not(.is-editor)').waitFor();
      assert.equal(await count(), 50);
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${deviceName} ${colorScheme}: quota -> paginated cleanup/retry -> duplicate published once; actual header deletion; no empty/zombie drafts; explicit discard exit`,
      );
      await context.close();
    }
  }
  console.log(`Screenshots: ${output}`);
} catch (error) {
  await activePage?.screenshot({ path: join(output, 'failure.png') }).catch(() => undefined);
  console.error('Failure artifacts:', output);
  throw error;
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
