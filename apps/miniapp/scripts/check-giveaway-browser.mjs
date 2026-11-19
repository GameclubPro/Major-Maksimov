import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const existingBase = process.env.MINIAPP_GIVEAWAY_TEST_BASE;
const base = existingBase || (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const server = await ensureMiniappDevServer(base, { reuseServer: Boolean(existingBase) });
let browser;
const viewports = [
  { width: 320, height: 568 },
  { width: 393, height: 852 },
  { width: 412, height: 915 },
  { width: 1440, height: 900 },
];

async function assertParticipationLayout(page) {
  const layout = await page.locator('.giveaway-page').evaluate((element) => {
    const content = element.querySelector('.giveaway-page__content');
    const footer = element.querySelector('footer');
    const primary = element.querySelector('.giveaway-page__primary');
    return {
      horizontalOverflow: [...element.querySelectorAll('*'), element].some(
        (child) => child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1,
      ),
      contentBottom: content.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
      primaryBottom: primary.getBoundingClientRect().bottom,
      primaryTop: primary.getBoundingClientRect().top,
      height: window.innerHeight,
    };
  });
  assert.equal(layout.horizontalOverflow, false, JSON.stringify(layout));
  assert.ok(layout.contentBottom <= layout.footerTop + 1, 'Footer must not cover content');
  assert.ok(layout.primaryTop >= 0 && layout.primaryBottom <= layout.height);
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const avatarImage = await readFile(new URL('../../../bot.webp', import.meta.url));
  await page.route('https://images.example.test/**', (route) =>
    route.request().url().endsWith('/broken.webp')
      ? route.fulfill({ status: 404 })
      : route.fulfill({ contentType: 'image/webp', body: avatarImage }),
  );
  await page.goto(new URL('test/browser/giveaway.html', base).href);
  const main = page.locator('.giveaway-page');
  const primary = main.locator('.giveaway-page__primary');
  await main.getByRole('button', { name: 'Проверить и участвовать' }).waitFor();
  const avatar = main.locator('.giveaway-page__avatar');
  for (const entityType of ['chat', 'channel']) {
    const sourceAvatarUrl = `https://images.example.test/${entityType}.webp`;
    await page.evaluate(
      ({ sourceAvatarUrl, entityType }) => {
        window.giveawayTest.setAvatar(sourceAvatarUrl, entityType);
      },
      { sourceAvatarUrl, entityType },
    );
    await page.waitForFunction((url) => {
      const image = document.querySelector('.giveaway-page__avatar img');
      return image?.getAttribute('src') === url && image.complete && image.naturalWidth > 0;
    }, sourceAvatarUrl);
    assert.equal(await avatar.locator('img').getAttribute('referrerpolicy'), 'no-referrer');
  }
  for (const sourceAvatarUrl of [null, 'https://images.example.test/broken.webp']) {
    await page.evaluate((url) => window.giveawayTest.setAvatar(url), sourceAvatarUrl);
    await page.waitForFunction(() => {
      const avatar = document.querySelector('.giveaway-page__avatar');
      return avatar && !avatar.querySelector('img') && avatar.textContent === 'КО';
    });
  }
  await page.evaluate(() =>
    window.giveawayTest.setAvatar('https://images.example.test/restored.webp'),
  );
  await page.waitForFunction(() => {
    const image = document.querySelector('.giveaway-page__avatar img');
    return image?.complete && image.naturalWidth > 0;
  });
  assert.equal(await main.locator('img[src*="favicon"]').count(), 0);
  assert.equal(await main.getByText('Не проверено', { exact: true }).count(), 2);
  await main.getByRole('heading', { name: 'Подарки для подписчиков', exact: true }).waitFor();
  assert.equal(await main.getByText('Сертификат на 5 000 ₽', { exact: true }).count(), 1);
  assert.equal(await main.locator('.giveaway-page__cover').count(), 0);
  assert.equal(
    await main.evaluate((element) =>
      Boolean(
        element
          .querySelector('.giveaway-page__promotion')
          .compareDocumentPosition(element.querySelector('.giveaway-page__participation-status')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
    true,
    'New participants see the offer before their participation status',
  );
  await page.evaluate(() => window.giveawayTest.setPromotion(null, 12));
  await main.getByText('Все призовые места · 12', { exact: true }).click();
  await main
    .getByText('Подарок 12 с длинным описанием для проверки переноса', { exact: true })
    .waitFor({ state: 'visible' });
  await assertParticipationLayout(page);
  assert.equal(await main.locator('.giveaway-page__cover').count(), 0);
  await page.evaluate(
    (base64) => window.giveawayTest.setPromotion(base64),
    avatarImage.toString('base64'),
  );
  await main.locator('.giveaway-page__cover').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.giveaway-page__cover')?.naturalWidth > 0,
  );
  await page.evaluate(() => window.giveawayTest.setPromotion('broken-image'));
  await main.locator('.giveaway-page__cover').waitFor({ state: 'detached' });
  await page.evaluate(() => window.giveawayTest.setPromotion(null));
  await primary.evaluate((element) => {
    element.click();
    element.click();
  });
  await main.locator('.giveaway-page__verification.is-checking').waitFor();
  await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
  assert.equal(
    await main.evaluate((element) =>
      Boolean(
        element
          .querySelector('.giveaway-page__participation-status')
          .compareDocumentPosition(element.querySelector('.giveaway-page__promotion')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
    true,
    'Registered participants see their personal status first',
  );
  assert.equal(await page.evaluate(() => window.giveawayTest.enters), 1);
  await page.evaluate(() => {
    window.giveawayTest.mode = 'missing';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Осталось подписаться' }).waitFor();
  assert.equal(await main.getByRole('progressbar').getAttribute('aria-valuenow'), '1');
  await page.evaluate(() => {
    window.giveawayTest.mode = 'verified';
  });
  await main.getByRole('button', { name: 'Открыть Партнёр' }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.giveawayTest.enters), 3);
  assert.equal(await page.evaluate(() => window.giveawayTest.opened), true);
  await page.evaluate(() => {
    window.giveawayTest.mode = 'pending';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Заявка ожидает проверки' }).waitFor();
  assert.equal(await main.getByRole('progressbar').getAttribute('aria-valuenow'), '0');
  await page.evaluate(() => {
    window.giveawayTest.mode = 'error';
  });
  await primary.click();
  await main.getByRole('alert').waitFor();
  assert.equal(await main.getByRole('progressbar').getAttribute('aria-valuenow'), '0');
  await page.evaluate(() => window.giveawayTest.longConditions());
  await main.getByRole('button', { name: /Открыть Дополнительный канал 20 /u }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.maxTheme = value;
    }, theme);
    for (const viewport of [...viewports, { width: 375, height: 320 }]) {
      await page.setViewportSize(viewport);
      await assertParticipationLayout(page);
      const lastCondition = main.locator('.giveaway-page__condition-list li').last();
      await lastCondition.scrollIntoViewIfNeeded();
      const row = await lastCondition.boundingBox();
      const footer = await main.locator('footer').boundingBox();
      assert.ok(row.y + row.height <= footer.y + 1, 'Last condition must remain reachable');
    }
  }
  await page.setViewportSize(viewports[1]);
  await page.evaluate(() => {
    window.giveawayTest.mode = 'verified';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
  for (const mode of ['read-error', 'public-error']) {
    await page.evaluate((value) => {
      window.giveawayTest.mode = value;
      window.giveawayTest.refresh();
    }, mode);
    await main.getByRole('alert').waitFor();
    assert.equal(await main.getAttribute('data-tone'), 'error');
    assert.equal(await main.locator('.giveaway-page__verification.is-verified').count(), 0);
    await page.evaluate(() => {
      window.giveawayTest.mode = 'verified';
    });
    await primary.click();
    await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
    assert.equal(await main.getByRole('alert').count(), 0);
  }
  await page.evaluate(() => window.giveawayTest.setScenario('winner'));
  await main.getByRole('button', { name: 'Подтвердить выигрыш' }).waitFor();
  assert.equal(
    await main.locator('.giveaway-page__personal-prize').textContent(),
    '1 место · Сертификат на 5 000 ₽',
  );
  assert.equal(
    await main.evaluate((element) =>
      Boolean(
        element
          .querySelector('.giveaway-page__timer')
          .compareDocumentPosition(element.querySelector('.giveaway-page__promotion')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ),
    true,
    'The claim deadline stays before promotional content',
  );
  assert.equal(await main.getAttribute('data-tone'), 'winner');
  assert.equal(await main.locator('.giveaway-page__ticket').count(), 0);
  await main.getByRole('button', { name: 'К опубликованным итогам' }).click();
  assert.equal(await page.evaluate(() => window.giveawayTest.openedUrl), 'https://max.ru/results');
  await page.evaluate(() => {
    window.giveawayTest.mode = 'claim-unavailable';
  });
  await primary.click();
  await main.getByRole('button', { name: 'Повторить подтверждение' }).waitFor();
  assert.equal(
    await main.locator('.giveaway-page__condition-list [data-state="missing"]').count(),
    0,
  );
  await page.evaluate(() => {
    window.giveawayTest.mode = 'claim-missing';
  });
  await primary.click();
  const missing = main.locator('.giveaway-page__condition-list li[data-state="missing"]');
  await missing.getByRole('button').click();
  assert.equal(await page.evaluate(() => window.giveawayTest.openedUrl), 'https://max.ru/extra-0');
  await page.evaluate(() => {
    window.giveawayTest.mode = 'verified';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Выигрыш подтверждён' }).waitFor();
  assert.equal(await page.evaluate(() => window.giveawayTest.claims), 3);
  await page.evaluate(() => window.giveawayTest.setScenario('expired'));
  await main.getByRole('heading', { name: 'Срок подтверждения истёк' }).waitFor();
  assert.equal(await main.getByRole('button', { name: 'Подтвердить выигрыш' }).count(), 0);
  assert.equal(await main.getAttribute('data-tone'), 'muted');
  await page.evaluate(() => window.giveawayTest.setScenario('canceled'));
  await main.getByRole('heading', { name: 'Розыгрыш отменён' }).waitFor();
  assert.equal(await main.locator('.giveaway-page__verification.is-verified').count(), 0);

  const editorTest = await browser.newPage({ viewport: { width: 393, height: 852 } });
  await editorTest.goto(new URL('test/browser/giveaway.html?editor', base).href);
  const editor = editorTest.locator('.managed-giveaway');
  await editor.getByRole('button', { name: 'Продолжить настройку' }).click();
  const title = editor.getByPlaceholder('Например: Розыгрыш на выходные');
  await title.fill('Мой текст');
  await editorTest.evaluate(() => window.changeDraftInAnotherSession());
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await editor.getByRole('button', { name: 'Проверить сохранённую версию' }).click();
  await editor.getByRole('button', { name: 'Заменить мои правки сохранённой версией' }).waitFor();
  assert.equal(await title.inputValue(), 'Мой текст');
  await editor.getByRole('button', { name: 'Заменить мои правки сохранённой версией' }).click();
  assert.equal(await title.inputValue(), 'Версия второго организатора');
  await editorTest.clock.setFixedTime(new Date('2030-01-10T09:30:00Z'));
  const date = editor.getByLabel('Дата завершения', { exact: true });
  await editor.getByRole('button', { name: 'Сразу', exact: true }).click();
  await editor.getByRole('button', { name: '24 часа', exact: true }).click();
  const firstDate = await date.inputValue();
  await editor.getByRole('button', { name: '48 часов', exact: true }).click();
  assert.notEqual(await date.inputValue(), firstDate);
  await editor.getByRole('button', { name: '24 часа', exact: true }).click();
  assert.equal(await date.inputValue(), firstDate);
  await editor.getByRole('button', { name: 'К условиям' }).click();
  await editor.getByText('Гостевой канал', { exact: true }).waitFor();
  await editor.getByText('https://max.ru/giveaway-guest', { exact: true }).waitFor();
  await editor.getByRole('button', { name: 'К призам' }).click();
  await editorTest.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (...args) => {
      window.createImageBitmap = decode;
      await new Promise((resolve) => {
        window.finishOldGiveawayPhoto = resolve;
      });
      return decode(...args);
    };
  });
  const fileInput = editor.locator('.managed-giveaway__file-input');
  await fileInput.setInputFiles({
    name: 'first.webp',
    mimeType: 'image/webp',
    buffer: avatarImage,
  });
  await editorTest.waitForFunction(() => typeof window.finishOldGiveawayPhoto === 'function');
  assert.equal(
    await editor.getByRole('button', { name: 'Опубликовать', exact: true }).isDisabled(),
    true,
  );
  await fileInput.setInputFiles({
    name: 'second.webp',
    mimeType: 'image/webp',
    buffer: avatarImage,
  });
  await editor
    .locator('.managed-giveaway__publication-image summary strong')
    .filter({ hasText: /^second[.]/u })
    .waitFor();
  await editorTest.evaluate(() => window.finishOldGiveawayPhoto());
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await editorTest.getByText('Черновик сохранён', { exact: true }).waitFor();
  assert.match(
    await editor.locator('.managed-giveaway__publication-image summary strong').textContent(),
    /^second[.]/u,
  );
  await editorTest.reload();
  await editor.getByRole('button', { name: 'Продолжить настройку' }).waitFor();
  await editorTest.evaluate(() => window.finishEmptyGiveaway());
  const refreshResults = editor.getByRole('button', { name: 'Обновить итоги в MAX' });
  await editorTest.evaluate(() => window.queueNextGiveawayRefresh());
  await refreshResults.click();
  await editorTest.getByText('Итоги ожидают обновления в MAX', { exact: true }).waitFor();
  await refreshResults.click();
  await editorTest.getByText('Итоги обновлены в MAX', { exact: true }).waitFor();
  await editor.getByRole('button', { name: 'В архив', exact: true }).click();
  const confirmation = editorTest.getByRole('dialog', { name: 'Убрать розыгрыш в архив?' });
  await confirmation.getByText(/останутся в MAX/u).waitFor();
  await confirmation.getByRole('button', { name: 'В архив', exact: true }).click();
  await editorTest.getByText('Розыгрыш в архиве', { exact: true }).waitFor();
  assert.equal(await editor.getByRole('button', { name: 'В архив', exact: true }).count(), 0);
  await editorTest.close();

  for (const theme of ['light', 'dark']) {
    for (const viewport of viewports.slice(0, 3)) {
      const context = await browser.newContext({ viewport, colorScheme: theme });
      await installNativeVisualModeInitScript(context);
      const profile = {
        safeTop: 0,
        safeBottom: 34,
        platform: viewport.width === 412 ? 'android' : 'ios',
      };
      await installMaxBridgeShimInitScript(context, profile, { colorScheme: theme });
      const editorPage = await context.newPage();
      editorPage.on('pageerror', (error) => errors.push(error.message));
      await editorPage.goto(
        new URL('chat/preview-chat/settings?preview=1&device=iphone&focus=giveaway', base).href,
      );
      const card = editorPage.locator('.managed-giveaway');
      await card.waitFor();
      await applyNativeVisualMode(editorPage, profile);
      await card
        .getByRole('button', { name: /^(Редактировать|Продолжить)/u })
        .first()
        .click();
      for (const step of ['basics', 'conditions', 'prizes']) {
        await editorPage.locator(`.managed-giveaway--step-${step}`).waitFor();
        const heading = card.locator('.managed-giveaway__hero-title-row h2');
        await heading.waitFor();
        const headingBounds = await heading.boundingBox();
        const panelHeader = await editorPage.locator('.settings-drilldown__header').boundingBox();
        assert.ok(
          headingBounds.y >= panelHeader.y + panelHeader.height - 1,
          'New step must start below the panel header',
        );
        const dock = card.locator('.managed-giveaway__action-dock');
        await dock.scrollIntoViewIfNeeded();
        const geometry = await card.evaluate((element) => {
          const dock = element.querySelector('.managed-giveaway__action-dock');
          const dockBounds = dock.getBoundingClientRect();
          const contentBounds = element
            .querySelector('.managed-giveaway__step-stage')
            .getBoundingClientRect();
          return {
            dockTop: dockBounds.top,
            contentBottom: contentBounds.bottom,
            position: getComputedStyle(dock).position,
            overflow: element.scrollWidth > element.clientWidth + 1,
          };
        });
        assert.equal(geometry.position, 'static');
        assert.equal(geometry.overflow, false);
        assert.ok(
          geometry.dockTop >= geometry.contentBottom - 1,
          'Step navigation must not overlap fields',
        );
        if (step === 'prizes') {
          await card.locator('.managed-giveaway__file-input').setInputFiles({
            name: 'giveaway-photo.webp',
            mimeType: 'image/webp',
            buffer: avatarImage,
          });
          const preview = card.locator('.managed-giveaway__publication-image');
          await preview.waitFor();
          await editorPage.waitForFunction(
            () =>
              document.querySelector('.managed-giveaway__publication-image summary img')
                ?.naturalWidth > 0,
          );
          await preview.locator('summary').click();
          await preview
            .locator('.managed-giveaway__publication-image-full')
            .waitFor({ state: 'visible' });
          await preview.locator('summary').click();
          await card.getByRole('button', { name: 'Убрать фото', exact: true }).click();
          await preview.waitFor({ state: 'detached' });
        }
        if (step !== 'prizes') {
          await dock
            .getByRole('button', { name: step === 'basics' ? 'К условиям' : 'К призам' })
            .click();
        }
      }
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Giveaway browser checks passed: participation and claim recovery, concurrent draft edits, deadline presets, photo replacement, five viewport sizes, light/dark, editor navigation.',
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await stopChildProcess(server);
  }
}
