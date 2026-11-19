import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
try {
  for (const [engine, width, height, theme] of [
    [chromium, 320, 568, 'light'],
    [webkit, 393, 749, 'dark'],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
    try {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
      });
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(
        context,
        { platform: engine === webkit ? 'ios' : 'android', safeTop: 0, safeBottom: 20 },
        { colorScheme: theme },
      );
      await installNativeVisualModeInitScript(context);
      await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const marker = 'for (const handler of handlers) {';
        assert(source.includes(marker));
        // Local preview fixture: captures no MAX traffic and fails the first draft read only.
        await route.fulfill({
          response,
          body: source.replace(
            marker,
            `
          if (context.url.pathname === '/publications/drafts/publication-imported-draft' && context.method === 'GET' && !window.__albumReadFailed) {
            window.__albumReadFailed = true; throw new Error('NetworkError');
          }
          const session=context.state.publisherPostImportSession;
          if (session?.status === 'ready' && !window.__albumSeeded) {
            window.__albumSeeded=true;
            session.warnings=[{messageIndex:1,itemIndex:2,kind:'link',reason:'optional_link',value:'https://example.org/afisha'}];
            const post = context.state.publications.find(item=>item.id===session.publicationId);
            post.content.media = ['a.jpg','b.mp4','c.mp4'].map((name,index)=>({id:'asset-'+index,type:index?'video':'image',mimeType:index?'video/mp4':'image/jpeg',sizeBytes:100,fileName:name}));
            post.mediaCount=3;post.hasVideo=true;
          }
          if (context.method === 'PATCH' && context.url.pathname.includes('/drafts/')) window.__albumSave=JSON.parse(context.init.body);
          ` + marker,
          ),
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const goto = (q) => page.goto(base + 'publications?preview=1&profile=publisher&' + q);
      await goto('publisherImport=failed');
      const title = page.locator('.publisher-post-import-status__copy strong');
      await title.waitFor();
      await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 20 });
      for (const px of [16, 32]) {
        await page.evaluate((px) => (document.documentElement.style.fontSize = px + 'px'), px);
        assert(
          await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.clientWidth > 0),
          'The whole import failure must fit',
        );
      }
      await goto('publisherImport=ready&import=preview_import_token_123456');
      await page.getByRole('button', { name: 'Загрузить снова' }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('import'), 'preview_import_token_123456');
      await page.getByRole('button', { name: 'Загрузить снова' }).click();
      await page.locator('.publication-album').waitFor();
      await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 20 });
      const names = () => page.locator('.publication-album__caption small').allTextContents();
      assert.deepEqual(await names(), ['a.jpg', 'b.mp4', 'c.mp4']);
      const text = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
      assert.doesNotMatch(await text.innerText(), /example\.org/u);
      await page.getByRole('button', { name: 'Добавить в текст', exact: true }).click();
      assert.match(await text.innerText(), /example\.org\/afisha/u);
      await page.getByRole('button', { name: 'Переместить раньше: Видео 3', exact: true }).click();
      assert.deepEqual(await names(), ['a.jpg', 'c.mp4', 'b.mp4']);
      assert(
        await page
          .locator('.publication-album')
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      );
      const buttons = await page
        .locator('.publication-album__actions button:enabled,.publication-album__replace')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
      assert(buttons.every((r) => r.width >= 44 && r.height >= 44));
      assert.deepEqual(errors, []);
      console.log(
        engine.name(),
        width,
        theme,
        'passed: full error at 100/200%, exact deep-link retry, optional link, interleaved album reorder.',
      );
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
}
