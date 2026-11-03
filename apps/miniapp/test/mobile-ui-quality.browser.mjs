import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
import {
  captureBrowserLaunchOptions,
  setPhoneKeyboard,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const output = await mkdtemp('/tmp/maxim-mobile-quality-');
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
const profiles = [
  [webkit, 320, 504, 'light'],
  [chromium, 360, 780, 'dark'],
  [webkit, 393, 749, 'dark'],
  [chromium, 430, 811, 'light'],
  [chromium, 667, 320, 'dark'],
];
const visible = async (locator) =>
  assert.ok(
    await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const scroll = element.closest('.settings-drilldown__body');
      const bounds = scroll?.getBoundingClientRect();
      return (
        box.top >= Math.max(visualViewport?.offsetTop ?? 0, bounds?.top ?? 0) - 1 &&
        box.bottom <=
          Math.min(
            (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight),
            bounds?.bottom ?? Infinity,
          ) +
            1
      );
    }),
    'feedback must be in the visible scroll area',
  );
console.log(`Mobile quality artifacts: ${output}`);
try {
  for (const [engine, width, height, theme] of profiles.filter(
    ([, width]) =>
      !process.env.MOBILE_QUALITY_WIDTH || width === Number(process.env.MOBILE_QUALITY_WIDTH),
  )) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engine.name(), base));
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
      await installMaxBridgeShimInitScript(
        context,
        { platform: engine === webkit ? 'ios' : 'android' },
        { colorScheme: theme },
      );
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const goto = async (path, ready) => {
        await page.goto(
          `${base}${path}${path.includes('?') ? '&' : '?'}preview=1&profile=publisher`,
        );
        await page.locator(ready).first().waitFor();
        await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 34 });
      };
      const shot = async (name) => {
        await settleVisualFrame(page);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `${name}: horizontal overflow`,
        );
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${theme}-${name}.png` });
      };
      const openReply = async () => {
        await page.getByRole('button', { name: 'Добавить автоответ', exact: true }).click();
        await page
          .getByRole('dialog', { name: 'Новый автоответ' })
          .getByRole('button', { name: 'Создать здесь', exact: true })
          .click();
        await page.locator('.publisher-auto-reply-editor').waitFor();
      };
      await goto('publisher/chat/preview-chat/auto-replies', '.publisher-auto-replies-page');
      await openReply();
      const replyText = page.getByRole('textbox', { name: 'Текст автоответа', exact: true });
      await replyText.fill('Ответ для проверки');
      await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
      const phrase = page.getByRole('textbox', { name: 'Фразы', exact: true });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-invalid') === 'true',
      );
      await visible(phrase);
      await shot('auto-reply-validation');
      await phrase.fill('Каталог');
      await phrase.press('Enter');
      // Fail writes only after hydration; the user's in-memory text must survive.
      await page.evaluate(() => {
        window.__restoreStorage = {
          indexedDB: window.indexedDB,
          setItem: Storage.prototype.setItem,
        };
        Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
        Storage.prototype.setItem = () => {
          throw new Error('Quota exceeded');
        };
        for (const bridge of [window.WebApp, window.MAX?.WebApp]) {
          if (bridge?.DeviceStorage) {
            bridge.DeviceStorage.setItem = async () => {
              throw new Error('Unavailable');
            };
          }
        }
      });
      await replyText.fill('Текст должен пережить ошибку записи');
      await page.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
      const close = page.getByRole('dialog', { name: 'Закрыть редактор?', exact: true });
      await close.getByRole('button', { name: /^(Сохранить и закрыть|Повторить)$/ }).click();
      await close.getByRole('button', { name: 'Повторить', exact: true }).waitFor();
      assert.match(await replyText.innerText(), /Текст должен пережить/);
      await shot('draft-save-failed');
      await page.evaluate(() => {
        Object.defineProperty(window, 'indexedDB', {
          configurable: true,
          value: window.__restoreStorage.indexedDB,
        });
        Storage.prototype.setItem = window.__restoreStorage.setItem;
      });
      await close.getByRole('button', { name: 'Повторить', exact: true }).click();
      await page.locator('.publisher-auto-reply-editor').waitFor({ state: 'detached' });
      await openReply();
      assert.match(await replyText.innerText(), /Текст должен пережить/);
      console.log(
        `${engine.name()}/${width}/${theme}: validation and failed draft save/retry passed`,
      );

      await goto('publications?compose=1', '.publications-page');
      await page.getByRole('button', { name: 'Расписание', exact: true }).click();
      await page.getByRole('button', { name: 'Повтор', exact: true }).click();
      await page.getByRole('button', { name: 'По неделям', exact: true }).click();
      const days = page.locator('.publication-weekdays');
      await days.scrollIntoViewIfNeeded();
      const sizes = await days.locator('button').evaluateAll((buttons) =>
        buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          return { width: rect.width, height: rect.height, top: Math.round(rect.top) };
        }),
      );
      assert.equal(sizes.length, 7);
      assert.ok(sizes.every((size) => size.width >= 43 && size.height >= 43));
      const rows = Object.values(Object.groupBy(sizes, (size) => size.top));
      assert.ok(
        rows.every((row) => row.length > 1),
        'a weekday must not be stranded in its own row',
      );
      await shot('weekdays');
      const interval = page.getByRole('spinbutton', { name: 'Интервал повтора', exact: true });
      await interval.fill('999');
      await interval.blur();
      await page.getByRole('status').filter({ hasText: 'Оставлено:' }).waitFor();
      assert.equal(await interval.inputValue(), '1');
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();

      for (const state of ['compose', 'vk-editor']) {
        if (state === 'vk-editor') {
          await goto('publisher/channel/preview-channel', '.publisher-entity-modules-page');
          await page.getByRole('button', { name: /^(Открыть посты|Посты) из VK$/ }).click();
          const links = page.locator('.vk-parsing-post-card__vk-link');
          assert.ok(
            await links
              .first()
              .evaluate(
                (link) =>
                  link.getBoundingClientRect().width >= 44 &&
                  link.getBoundingClientRect().height >= 44,
              ),
          );
          await page
            .locator('.vk-parsing-workspace')
            .getByRole('button', { name: 'Редактировать', exact: true })
            .first()
            .click();
        }
        const text = page.getByRole('textbox', {
          name: state === 'compose' ? 'Текст публикации' : 'Текст VK-поста',
          exact: true,
        });
        console.log(`${engine.name()}/${width}: keyboard ${state}`);
        await text.fill(
          Array.from({ length: 30 }, (_, i) => `Строка ${i + 1} для проверки клавиатуры`).join(
            '\n',
          ),
        );
        for (const mode of ['visual', 'resize']) {
          await text.evaluate((element) => {
            element.focus({ preventScroll: true });
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            let last;
            while (walker.nextNode()) last = walker.currentNode;
            const range = document.createRange();
            range.setStart(last, last.length);
            range.collapse(true);
            getSelection().removeAllRanges();
            getSelection().addRange(range);
          });
          await setPhoneKeyboard(page, { height: height === 320 ? 140 : 280, mode });
          await settleVisualFrame(page);
          await page
            .waitForFunction(() => {
              const range = getSelection()?.getRangeAt(0);
              const rect = range?.getBoundingClientRect();
              const top = visualViewport?.offsetTop ?? 0;
              return (
                rect?.height > 0 &&
                rect.top >= top - 1 &&
                rect.bottom <= top + (visualViewport?.height ?? innerHeight) + 1
              );
            })
            .catch(async (error) => {
              console.log(
                await text.evaluate((element) => ({
                  caret: getSelection()?.getRangeAt(0)?.getBoundingClientRect().toJSON(),
                  editor: element.getBoundingClientRect().toJSON(),
                  focused: document.activeElement === element,
                  viewport: { height: visualViewport.height, offset: visualViewport.offsetTop },
                  html: document.documentElement.dataset,
                })),
              );
              await shot(`${state}-keyboard-${mode}-failure`);
              throw error;
            });
          await shot(`${state}-keyboard-${mode}`);
          await setPhoneKeyboard(page, { open: false, mode });
        }
      }
      assert.deepEqual(errors, []);
      console.log(`${engine.name()}/${width}/${theme}: layout, controls and keyboard passed`);
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
}
