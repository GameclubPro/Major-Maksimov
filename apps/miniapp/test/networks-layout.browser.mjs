import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
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

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4193/app/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
  throw new Error('Networks layout checks require a local preview server');
}
const output = mkdtempSync(join(tmpdir(), 'maxim-networks-layout-'));

async function pageFits(page, name) {
  await settleVisualFrame(page);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `${name}: horizontal page overflow`,
  );
}

async function textFits(locator, boundarySelector, name) {
  const failures = await locator.evaluateAll(
    (nodes, selector) =>
      nodes.flatMap((node) => {
        const boundary = node.closest(selector)?.getBoundingClientRect();
        if (!boundary) return [`Missing ${selector}`];
        const range = document.createRange();
        range.selectNodeContents(node);
        const outside = [...range.getClientRects()].some(
          (rect) =>
            rect.left < boundary.left - 1 ||
            rect.right > boundary.right + 1 ||
            rect.top < boundary.top - 1 ||
            rect.bottom > boundary.bottom + 1,
        );
        return outside ||
          node.scrollWidth > node.clientWidth + 1 ||
          node.scrollHeight > node.clientHeight + 1
          ? [node.textContent]
          : [];
      }),
    boundarySelector,
  );
  assert.deepEqual(failures, [], `${name}: complete title stays within its control`);
}

async function controlsFit(page, name) {
  const failures = await page
    .locator('.networks-page button, .networks-page input, .networks-page summary')
    .evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        if (!node.checkVisibility({ checkVisibilityCSS: true })) return [];
        const bounds = node.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return [];
        return bounds.height < 43.5 ||
          bounds.left < -1 ||
          bounds.right > innerWidth + 1 ||
          node.scrollWidth > node.clientWidth + 1
          ? [
              {
                label: node.textContent.trim() || node.getAttribute('aria-label'),
                ...bounds.toJSON(),
              },
            ]
          : [];
      }),
    );
  assert.deepEqual(failures, [], `${name}: controls fit and retain 44px touch targets`);
}

async function surfaceAppearance(page, selector) {
  return page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const style = getComputedStyle(node);
      return Object.fromEntries(
        [
          'backgroundColor',
          'backgroundImage',
          'borderRadius',
          'borderColor',
          'boxShadow',
          'color',
          'fontFamily',
          'fontSize',
          'fontWeight',
          'padding',
          'width',
        ].map((property) => [property, style[property]]),
      );
    });
}

async function observeRefreshRequests(page) {
  await page.evaluate(async () => {
    const findModule = (name) =>
      performance
        .getEntriesByType('resource')
        .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${name}`))?.name;
    const transportUrl = findModule('preview-transport.ts');
    const { PREVIEW_REQUEST_HANDLERS } = await import(transportUrl);
    const { PREVIEW_NOT_HANDLED } = await import(findModule('preview-transport-runtime.ts'));
    const { handleNetworksPreviewRequest } = await import(
      new URL('preview-transport-networks.ts', transportUrl).href
    );
    window.__networkLayoutRequests = [];
    window.__networkLayoutHoldNextChat = false;
    window.__networkLayoutChatRejected = false;
    PREVIEW_REQUEST_HANDLERS.unshift(async (context) => {
      const match = context.url.pathname.match(
        /^\/managed-entities\/networks\/(chat|channel)(\/stats)?$/u,
      );
      if (context.method !== 'GET' || !match) return PREVIEW_NOT_HANDLED;
      const request = {
        type: match[1],
        kind: match[2] ? 'stats' : 'catalogue',
        category: context.url.searchParams.get('favoriteType'),
        range: context.url.searchParams.get('range'),
        complete: false,
        compositionVersion: null,
      };
      window.__networkLayoutRequests.push(request);
      if (
        request.kind === 'catalogue' &&
        request.type === 'chat' &&
        window.__networkLayoutHoldNextChat
      ) {
        window.__networkLayoutHoldNextChat = false;
        await new Promise((_, reject) => {
          window.__networkLayoutRejectChat = () => {
            window.__networkLayoutChatRejected = true;
            window.__networkLayoutRejectChat = null;
            reject(new Error('Delayed chat catalogue refresh failed'));
          };
        });
      }
      const response = await handleNetworksPreviewRequest(context);
      request.compositionVersion = response.compositionVersion;
      request.complete = !response.nextCursor;
      return response;
    });
  });
}

async function refreshScopesStayIndependent(page) {
  const refresh = page.getByRole('button', { name: 'Обновить сетки', exact: true });
  await page.evaluate(() => {
    window.__networkLayoutHoldNextChat = true;
  });
  await refresh.click();
  await page.waitForFunction(() => typeof window.__networkLayoutRejectChat === 'function');
  assert.equal(await refresh.getAttribute('aria-busy'), 'true', 'delayed Chat refresh is pending');
  await page.getByRole('radio', { name: 'Каналы', exact: true }).click();
  await page.waitForFunction(() => {
    const button = document.querySelector('.networks-heading__refresh');
    return button && !button.disabled && button.getAttribute('aria-busy') !== 'true';
  });
  assert.equal(
    await page.locator('.networks-page [role="alert"]').count(),
    0,
    'pending Chat refresh does not affect Channels',
  );
  await page.evaluate(() => window.__networkLayoutRejectChat());
  await settleVisualFrame(page);
  assert.equal(
    await page.evaluate(() => window.__networkLayoutChatRejected),
    true,
    'delayed Chat failure was exercised',
  );
  assert.equal(await refresh.isEnabled(), true, 'Channels refresh stays enabled after Chat fails');
  assert.notEqual(
    await refresh.getAttribute('aria-busy'),
    'true',
    'Channels does not inherit Chat pending state',
  );
  assert.equal(
    await page.locator('.networks-page [role="alert"]').count(),
    0,
    'Channels does not inherit Chat errors',
  );
  await page.getByRole('radio', { name: 'Чаты', exact: true }).click();
  await page.waitForFunction(() => {
    const button = document.querySelector('.networks-heading__refresh');
    return button && !button.disabled && button.getAttribute('aria-busy') !== 'true';
  });
  await refresh.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('.networks-heading__refresh');
    return button && !button.disabled && button.getAttribute('aria-busy') !== 'true';
  });
  assert.equal(
    await page.locator('.networks-page [role="alert"]').count(),
    0,
    'Chat refresh recovers after the delayed failure',
  );
}

const profiles = [
  {
    name: 'iphone-se-dark',
    engine: webkit,
    width: 320,
    height: 504,
    theme: 'dark',
    platform: 'ios',
  },
  {
    name: 'android-light',
    engine: chromium,
    width: 393,
    height: 747,
    theme: 'light',
    platform: 'android',
  },
  {
    name: 'tablet-light',
    engine: webkit,
    width: 768,
    height: 960,
    theme: 'light',
    platform: 'ios',
  },
  {
    name: 'tablet-dark',
    engine: chromium,
    width: 768,
    height: 960,
    theme: 'dark',
    platform: 'android',
  },
].filter(
  (profile) =>
    !process.env.MINIAPP_TEST_PROFILE || profile.name === process.env.MINIAPP_TEST_PROFILE,
);

for (const profile of profiles) {
  const browser = await profile.engine.launch(
    captureBrowserLaunchOptions(profile.engine.name(), base.href),
  );
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    colorScheme: profile.theme,
    reducedMotion: 'reduce',
    isMobile: true,
    hasTouch: true,
  });
  await installNativeVisualModeInitScript(context);
  await installMaxBridgeShimInitScript(
    context,
    { platform: profile.platform },
    { colorScheme: profile.theme },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  const open = async (path, selector) => {
    const url = new URL(path, base);
    url.searchParams.set('preview', '1');
    url.searchParams.set('networks', '1');
    await page.goto(url.href);
    await page.locator(selector).first().waitFor();
    await applyNativeVisualMode(page, {
      safeTop: 0,
      safeBottom: profile.platform === 'ios' && profile.width > 320 ? 34 : 0,
    });
    await settleVisualFrame(page);
  };
  try {
    await open('?view=chat', '.chat-card');
    if (profile.name === 'android-light') await observeRefreshRequests(page);
    const homeNavigation = await surfaceAppearance(page, '.bottom-nav');
    const homeTitle = await surfaceAppearance(page, '.chat-card__title-wrap h3');
    await page.locator('.bottom-nav').getByRole('link', { name: 'Сетки', exact: true }).click();
    await page.locator('.network-summary-card').first().waitFor();
    await pageFits(page, `${profile.name} catalogue`);
    assert.deepEqual(
      await surfaceAppearance(page, '.bottom-nav'),
      homeNavigation,
      'catalogue shares home navigation',
    );
    let initialStatistics = null;
    if (profile.name === 'android-light') {
      await page.waitForFunction(() =>
        window.__networkLayoutRequests.some(
          (row) =>
            row.type === 'chat' &&
            row.kind === 'stats' &&
            row.category === 'important' &&
            row.complete,
        ),
      );
      initialStatistics = await page.evaluate(() => {
        const stats = window.__networkLayoutRequests.filter(
          (row) =>
            row.type === 'chat' &&
            row.kind === 'stats' &&
            row.category === 'important' &&
            row.complete,
        );
        return { count: stats.length, compositionVersion: stats.at(-1).compositionVersion };
      });
    }
    await page.getByRole('button', { name: 'Обновить сетки', exact: true }).click();
    await page.waitForFunction(() => {
      const refresh = document.querySelector('.networks-heading__refresh');
      return refresh && !refresh.disabled && refresh.getAttribute('aria-busy') !== 'true';
    });
    assert.equal(
      await page.locator('.networks-page [role="alert"]').count(),
      0,
      'catalogue refresh settles without an error',
    );
    if (initialStatistics) {
      await page.waitForFunction(
        (before) =>
          window.__networkLayoutRequests.filter(
            (row) =>
              row.type === 'chat' &&
              row.kind === 'stats' &&
              row.category === 'important' &&
              row.complete,
          ).length > before,
        initialStatistics.count,
      );
      const refreshedVersion = await page.evaluate(
        () =>
          window.__networkLayoutRequests.findLast(
            (row) =>
              row.type === 'chat' &&
              row.kind === 'stats' &&
              row.category === 'important' &&
              row.complete,
          ).compositionVersion,
      );
      assert.equal(
        refreshedVersion,
        initialStatistics.compositionVersion,
        'header refresh requests fresh statistics even when composition is unchanged',
      );
      await refreshScopesStayIndependent(page);
    }
    for (const name of ['Тип сообществ', 'Период статистики']) {
      const group = page.getByRole('radiogroup', { name, exact: true });
      assert.equal(await group.count(), 1, `${name}: one named selector`);
      assert.equal(await group.getByRole('radio').count(), 2, `${name}: two options`);
    }

    const category = page.locator('.network-summary-card__identity strong').first();
    await category.evaluate((node) => {
      node.textContent = 'ДлинноеНазваниеКатегорииБезПробелов'.slice(0, 32);
    });
    await settleVisualFrame(page);
    await textFits(category, '.network-card-title-button', `${profile.name} long category`);
    await controlsFit(page, `${profile.name} catalogue`);
    const focusTarget = page.getByRole('radio', { name: '30 дней', exact: true });
    await page.keyboard.press('Tab');
    await focusTarget.focus();
    assert.equal(
      await focusTarget.evaluate((node) => {
        const style = getComputedStyle(node);
        return (
          node.matches(':focus-visible') &&
          style.outlineStyle !== 'none' &&
          Number.parseFloat(style.outlineWidth) >= 2
        );
      }),
      true,
      'keyboard focus has a visible outline',
    );
    await page.screenshot({
      path: join(output, `${profile.name}-catalogue.png`),
      animations: 'disabled',
    });

    await page.locator('.network-card-title-button').first().click();
    if (profile.width === 320) {
      await page.locator('.network-workspace-menu > summary').click();
      await page.getByRole('button', { name: 'Переименовать', exact: true }).click();
      const name = page.getByRole('textbox', { name: 'Название сетки', exact: true });
      await name.focus();
      await setPhoneKeyboard(page, { mode: 'resize', height: 230 });
      for (const control of [
        name,
        page.getByRole('button', { name: 'Сохранить название', exact: true }),
      ]) {
        await control.scrollIntoViewIfNeeded();
        const bounds = await control.boundingBox();
        assert.ok(
          bounds && bounds.y >= -1 && bounds.y + bounds.height <= page.viewportSize().height + 1,
          'rename controls can scroll fully above the keyboard',
        );
      }
      await page.screenshot({
        path: join(output, `${profile.name}-rename-keyboard.png`),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      assert.equal(await page.locator('.network-rename').count(), 0, 'rename can be cancelled');
      await setPhoneKeyboard(page, { mode: 'resize', open: false });
    }
    await page
      .getByRole('navigation', { name: 'Раздел сетки', exact: true })
      .getByRole('button', { name: 'Состав', exact: true })
      .click();
    const title = page.locator('.network-community-row__text strong').first();
    await title.waitFor();
    await title.evaluate((node) => {
      node.textContent = 'Ж'.repeat(90);
    });
    await settleVisualFrame(page);
    await textFits(title, '.network-community-row', `${profile.name} continuous community title`);
    assert.equal(
      await title.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1;
      }),
      true,
      'continuous title wraps instead of clipping',
    );
    await controlsFit(page, `${profile.name} communities`);
    await pageFits(page, `${profile.name} communities`);
    await page.screenshot({
      path: join(output, `${profile.name}-communities.png`),
      animations: 'disabled',
    });

    await open('networks?type=chat&category=service', '.network-empty-start');
    assert.equal(
      await page.locator('.network-detail-metrics').count(),
      0,
      'empty networks have no meaningless metrics',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Настройки', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('button', { name: 'Добавить чаты', exact: true }).click();
    await page.locator('.chats-home.is-category-editing').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('view'), 'chat');
    assert.equal(new URL(page.url()).searchParams.get('editCategory'), 'service');
    await page.getByRole('button', { name: 'Готово', exact: true }).click();
    await page.locator('.chats-home:not(.is-category-editing)').waitFor();
    assert.equal(
      await page.locator('.home-category-chip.is-service').getAttribute('aria-pressed'),
      'true',
    );
    await page.goBack();
    await page.locator('.network-empty-start').waitFor();
    await page.screenshot({
      path: join(output, `${profile.name}-empty.png`),
      animations: 'disabled',
    });

    const actionsMenu = page.locator('.network-workspace-menu');
    const actionsTrigger = actionsMenu.locator('summary');
    await actionsTrigger.click();
    await actionsMenu.getByRole('button', { name: 'Переименовать', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await actionsMenu
      .getByRole('button', { name: 'Переименовать', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await actionsTrigger.evaluate((node) => node === document.activeElement),
      true,
      'Escape restores menu focus',
    );
    await actionsTrigger.click();
    await page.locator('.network-workspace-icon').click();
    await actionsMenu
      .getByRole('button', { name: 'Переименовать', exact: true })
      .waitFor({ state: 'hidden' });
    await actionsTrigger.click();
    await actionsMenu.getByRole('button', { name: 'Переименовать', exact: true }).click();
    const renameField = page.getByRole('textbox', { name: 'Название сетки', exact: true });
    await renameField.waitFor();
    assert.equal(
      await renameField.evaluate((node) => node === document.activeElement),
      true,
      'rename focuses its input',
    );
    await renameField.fill('');
    await renameField.pressSequentially('Длинное название новой сетки для чатов');
    const enteredName = await renameField.inputValue();
    assert.equal(
      enteredName.length,
      24,
      'input uses the same length bound as favorite persistence',
    );
    await page.getByRole('button', { name: 'Сохранить название', exact: true }).click();
    await renameField.waitFor({ state: 'hidden' });
    assert.equal(
      await page.locator('.network-workspace-heading h1').innerText(),
      enteredName,
      'saving never silently truncates the displayed name',
    );

    await open('networks?type=chat&category=important&tab=communities', '.network-community-row');
    const memberSearch = page.getByRole('searchbox', { name: 'Поиск в составе', exact: true });
    await memberSearch.fill('я'.repeat(101));
    assert.equal(
      (await memberSearch.inputValue()).length,
      100,
      'member search respects the API bound',
    );
    await page.getByText('Ничего не найдено', { exact: true }).waitFor();
    assert.equal(
      await page.locator('.network-community-list [role="alert"]').count(),
      0,
      'long search is not a failed request',
    );
    await page.getByRole('button', { name: 'Очистить: Поиск в составе', exact: true }).click();
    await page.locator('.network-community-row').first().waitFor();
    assert.equal(
      await memberSearch.evaluate((node) => node === document.activeElement),
      true,
      'clearing search retains focus',
    );
    await page.evaluate(async () => {
      const find = (name) =>
        performance
          .getEntriesByType('resource')
          .findLast((entry) => new URL(entry.name).pathname.endsWith('/' + name))?.name;
      const { PREVIEW_REQUEST_HANDLERS } = await import(find('preview-transport.ts'));
      const { PREVIEW_NOT_HANDLED } = await import(find('preview-transport-runtime.ts'));
      const { ApiRequestError } = await import('/app/src/lib/api-request-error.ts');
      window.__networkUxPageStatus = 500;
      PREVIEW_REQUEST_HANDLERS.unshift(async (context) => {
        if (
          context.method === 'GET' &&
          context.url.pathname.endsWith('/entities') &&
          context.url.searchParams.get('cursor')
        )
          throw new ApiRequestError(window.__networkUxPageStatus, '{}', 'Fixture page failure');
        return PREVIEW_NOT_HANDLED;
      });
    });
    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
    await page.locator('.network-community-list [role="alert"]').waitFor();
    assert.equal(
      await page.locator('.network-community-row').count(),
      50,
      'transient pagination failure preserves loaded communities',
    );
    await page.getByRole('button', { name: 'Обновить список', exact: true }).click();
    await page.locator('.network-community-row').first().waitFor();
    await page.evaluate(() => {
      window.__networkUxPageStatus = 403;
    });
    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
    await page
      .getByText('Доступ к сообществам изменился. Обновите список.', { exact: true })
      .waitFor();
    assert.equal(
      await page.locator('.network-community-row').count(),
      0,
      'access denial clears obsolete rows',
    );
    await pageFits(page, `${profile.name} access error`);

    if (profile.name === 'android-light') {
      for (const [type, title, addLabel, countLabel] of [
        ['chat', 'Районный чат 104', 'Добавить чаты', '1 чат'],
        ['channel', 'Городской канал 104', 'Добавить каналы', '1 канал'],
      ]) {
        await open(`networks?type=${type}&category=test`, '.network-empty-start');
        await page.getByRole('button', { name: addLabel, exact: true }).click();
        await page.locator('.chats-home.is-category-editing').waitFor();
        assert.equal(new URL(page.url()).searchParams.get('view'), type);
        await page.locator('#chat-search').fill(title);
        await page.locator('.chat-card__category-editor').first().click();
        const sheet = page.locator('.home-sheet--favorite');
        await sheet.locator('.favorite-picker__option.is-test').click();
        await sheet.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: 'Готово', exact: true }).click();
        await page.locator('.chats-home:not(.is-category-editing)').waitFor();
        assert.equal(
          await page.locator('.home-category-chip.is-test').getAttribute('aria-pressed'),
          'true',
        );
        await page.goBack();
        await page
          .locator('.network-workspace-heading')
          .getByText(countLabel, { exact: true })
          .waitFor();
        await page.locator('.network-detail-metrics').waitFor();
        assert.equal(await page.locator('.network-empty-start').count(), 0);
        await page.getByRole('button', { name: 'Состав', exact: true }).click();
        await page.locator('.network-community-list').getByText(title, { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Добавить', exact: true }).count(), 0);
        await page.getByRole('button', { name: 'Изменить состав', exact: true }).click();
        await page.locator('.chats-home.is-category-editing').waitFor();
        assert.equal(await page.locator('#chat-search').inputValue(), '');
        await page.locator('#chat-search').fill(title);
        await page.locator('.chat-card__category-editor').first().click();
        await sheet.getByRole('button', { name: 'Убрать из избранного', exact: true }).click();
        await sheet.waitFor({ state: 'hidden' });
        await page.keyboard.press('Escape');
        await page.locator('.chats-home:not(.is-category-editing)').waitFor();
        await page.goBack();
        await page.getByText('В сетке пока пусто', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Статистика', exact: true }).click();
        await page.locator('.network-empty-start').waitFor();
        assert.equal(
          await page.getByRole('button', { name: 'Настройки', exact: true }).isDisabled(),
          true,
        );
      }
    }

    const networkStyles = await page.locator('style[data-vite-dev-id]').evaluateAll((nodes) =>
      nodes
        .filter((node) =>
          /(?:networks-page|network-workspace|moderation-catalogue-(?:palette|steel)|managed-entity-(?:settings-header|workspace-tokens))\.css$/u.test(
            node.dataset.viteDevId ?? '',
          ),
        )
        .map((node) => node.textContent)
        .join('\n'),
    );
    assert.ok(
      networkStyles.length > 0,
      'capture the actual lazy route styles for the profile scope check',
    );
    await page.locator('.bottom-nav').getByRole('link', { name: 'Чаты', exact: true }).click();
    await page.locator('.chat-card').first().waitFor();
    await settleVisualFrame(page);
    assert.deepEqual(
      await surfaceAppearance(page, '.bottom-nav'),
      homeNavigation,
      'home navigation stays stable after Networks',
    );
    assert.deepEqual(
      await surfaceAppearance(page, '.chat-card__title-wrap h3'),
      homeTitle,
      'home rows stay stable after Networks',
    );
    await pageFits(page, `${profile.name} returned home`);

    // Publisher uses a separate authenticated launch. Reapply the actual lazy styles to
    // model CSS remaining in the document and verify their profile selectors stay scoped.
    await open('?profile=publisher', '.publisher-entity-row');
    const publisherNavigation = await surfaceAppearance(page, '.bottom-nav');
    const publisherRow = await surfaceAppearance(page, '.publisher-entity-row');
    await page.addStyleTag({ content: networkStyles });
    await settleVisualFrame(page);
    assert.deepEqual(
      await surfaceAppearance(page, '.bottom-nav'),
      publisherNavigation,
      'Networks styles do not alter Publisher navigation',
    );
    assert.deepEqual(
      await surfaceAppearance(page, '.publisher-entity-row'),
      publisherRow,
      'Networks styles do not alter Publisher rows',
    );
    assert.equal(
      await page.locator('.bottom-nav__item').count(),
      3,
      'Publisher keeps its own navigation',
    );
    await pageFits(page, `${profile.name} Publisher with route styles`);
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log(
      `PASS ${profile.name}: catalogue controls, long titles, keyboard focus, home return and Publisher scoping${profile.width === 320 ? ', rename with keyboard' : ''}${initialStatistics ? ', fresh statistics and scoped refresh failures' : ''}`,
    );
  } catch (error) {
    await page.screenshot({
      path: join(output, `${profile.name}-failure.png`),
      animations: 'disabled',
    });
    console.error(`FAILED ${profile.name}: ${page.url()}; screenshots: ${output}`);
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}
console.log(`Networks layout screenshots: ${output}`);
