import assert from 'node:assert/strict';
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

const requestedBase = process.env.MINIAPP_TEST_BASE_URL;
const base = requestedBase ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const server = await ensureMiniappDevServer(base, { reuseServer: Boolean(requestedBase) });
const profiles = [
  ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
  ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
  ['android-light', devices['Pixel 7'], 'light', 'android'],
  ['android-dark', devices['Pixel 7'], 'dark', 'android'],
  [
    'android-320-light',
    { ...devices['Pixel 7'], viewport: { width: 320, height: 740 } },
    'light',
    'android',
  ],
  [
    'android-320-dark',
    { ...devices['Pixel 7'], viewport: { width: 320, height: 740 } },
    'dark',
    'android',
  ],
  ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light', 'desktop'],
];
const routes = [
  ['chat', 'chat/preview-chat/settings', 'Антидубль', '.settings-drilldown__panel--duplicates'],
  [
    'channel',
    'channel/preview-channel/settings',
    'Действие под публикацией',
    '.settings-drilldown__panel--signature',
  ],
];

async function settledBox(locator) {
  return locator.evaluate(async (element) => {
    await document.fonts.ready;
    let previous;
    let stable = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise(requestAnimationFrame);
      const { x, y, width, height } = element.getBoundingClientRect();
      const current = { x, y, width, height };
      stable =
        previous &&
        Object.keys(current).every((key) => Math.abs(current[key] - previous[key]) < 0.1)
          ? stable + 1
          : 0;
      if (stable >= 5) return current;
      previous = current;
    }
    throw new Error('Settings geometry did not settle within 120 animation frames');
  });
}

async function assertOverviewState(entry, enabled, label) {
  const mobile = (await entry.page().evaluate(() => window.innerWidth)) <= 600;
  if (mobile) {
    const title = (await entry.locator('.settings-section__title').textContent()).trim();
    assert.equal((await entry.textContent()).trim(), title, `${label} contains only its title`);
    assert.equal(await entry.getAttribute('aria-label'), title);
    assert.equal(await entry.getAttribute('aria-describedby'), null);
    assert.equal(await entry.getAttribute('data-settings-navigation-entry'), 'true');
    assert.equal(
      await entry
        .locator(
          '.settings-section__summary, .settings-section__status-chip, .settings-section__state, .settings-section__state-label',
        )
        .count(),
      0,
      `${label} must remove extra text and state markup from the DOM`,
    );
  } else {
    assert.equal(await entry.locator('.settings-section__state').isVisible(), true);
    const summary = entry.locator('.settings-section__summary');
    const summaryId = await summary.getAttribute('id');
    assert.ok(
      summaryId &&
        ((await entry.getAttribute('aria-describedby')) ?? '').split(/\s+/u).includes(summaryId),
    );
    assert.equal(
      await summary.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width <= 1 && bounds.height <= 1 && element.textContent.trim().length > 0;
      }),
      true,
      'Desktop retains its compact accessible summary',
    );
  }
}

async function readSteelPalette(page) {
  return page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
    document.body.append(probe);
    try {
      return Object.fromEntries(
        ['page', 'panel', 'inset', 'ink', 'line', 'blue'].map((role) => {
          probe.style.color = `var(--steel-${role})`;
          return [role, getComputedStyle(probe).color];
        }),
      );
    } finally {
      probe.remove();
    }
  });
}

function assertBoxWithin(box, bounds, message) {
  assert.ok(
    box.width > 0 &&
      box.height > 0 &&
      box.x >= bounds.x - 0.5 &&
      box.y >= bounds.y - 0.5 &&
      box.x + box.width <= bounds.x + bounds.width + 0.5 &&
      box.y + box.height <= bounds.y + bounds.height + 0.5,
    `${message}: ${JSON.stringify({ box, bounds })}`,
  );
}

async function assertReachableControl(locator, label, { touchTarget = false } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await settledBox(locator);
  const viewport = await locator.page().evaluate(() => ({
    x: 0,
    y: 0,
    width: innerWidth,
    height: innerHeight,
  }));
  assertBoxWithin(box, viewport, `${label} must fit inside the viewport`);
  if (touchTarget) {
    assert.ok(box.width >= 44 && box.height >= 44, `${label} must retain a 44px touch target`);
  }
  assert.equal(
    await locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return hit === element || element.contains(hit);
    }),
    true,
    `${label} must receive pointer input without another surface covering it`,
  );
}

async function assertModulePresentation(page, name, entity, title, panelSelector, palette) {
  const label = `${name}/${entity}`;
  const panel = page.locator(panelSelector);
  if (entity === 'channel') {
    await panel.locator('.channel-post-actions__signature-settings > summary').click();
  }
  await (
    entity === 'chat'
      ? panel.getByRole('checkbox', { name: 'Включить антидубль', exact: true })
      : panel.getByRole('checkbox', { name: 'Добавлять подпись', exact: true })
  ).waitFor({ state: 'attached' });
  await settledBox(panel);
  assert.equal(await page.getByRole('dialog', { name: title, exact: true }).count(), 1);
  assert.equal(
    await panel.locator('.settings-drilldown__symbol[aria-hidden="true"] svg').count(),
    1,
  );
  const header = panel.locator('.settings-drilldown__header');
  const heading = panel.locator('.settings-drilldown__title');
  const symbol = panel.locator('.settings-drilldown__symbol');
  const close = header.getByRole('button', { name: 'Закрыть панель', exact: true });
  const [headerBox, titleBox, symbolBox, closeBox] = await Promise.all(
    [header, heading, symbol, close].map(settledBox),
  );
  for (const [part, box] of [
    ['title', titleBox],
    ['icon', symbolBox],
    ['close', closeBox],
  ]) {
    assertBoxWithin(box, headerBox, `${label} header ${part} must remain inside the header`);
  }
  assert.ok(symbolBox.x + symbolBox.width <= titleBox.x + 0.5, `${label} icon overlaps the title`);
  assert.ok(titleBox.x + titleBox.width <= closeBox.x + 0.5, `${label} title overlaps close`);
  await assertReachableControl(close, `${label} close`, { touchTarget: true });
  const headerAction = header.locator('.settings-drilldown__header-action');
  if (await headerAction.count()) {
    assertBoxWithin(await settledBox(headerAction), headerBox, `${label} header action is clipped`);
    await assertReachableControl(headerAction, `${label} header action`, { touchTarget: true });
  }
  const body = panel.locator('.settings-drilldown__body');
  const bodyBox = await settledBox(body);
  assert.ok(bodyBox.y >= headerBox.y + headerBox.height - 0.5, `${label} body overlaps its header`);
  const actual = await panel.evaluate((element) => {
    const color = (target, property) => getComputedStyle(target).getPropertyValue(property);
    const probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
    element.append(probe);
    const role = (name) => {
      probe.style.color = `var(${name})`;
      return getComputedStyle(probe).color;
    };
    try {
      const card = element.querySelector(
        '.settings-native-toggle, .channel-post-actions__signature-settings',
      );
      const field = element.querySelector(
        '.field input, .field select, .field textarea, .network-settings-field input:not([type="checkbox"]):not([type="file"]), .network-settings-field select, .network-settings-field textarea',
      );
      return {
        panel: color(element, 'background-color'),
        body: color(element.querySelector('.settings-drilldown__body'), 'background-color'),
        title: color(element.querySelector('.settings-drilldown__title'), 'color'),
        card: color(card, 'background-color'),
        border: color(card, 'border-top-color'),
        field: field ? color(field, 'background-color') : null,
        majorSurface: role('--major-surface'),
        surfaceCard: role('--surface-card'),
        surfaceInset: role('--surface-card-muted'),
      };
    } finally {
      probe.remove();
    }
  });
  if (entity === 'channel') {
    assert.notEqual(
      actual.field,
      null,
      `${label} the signature fixture must expose a real editable field for palette coverage`,
    );
  }
  assert.deepEqual(
    actual,
    {
      panel: palette.page,
      body: palette.page,
      title: palette.ink,
      card: palette.panel,
      border: palette.line,
      field: actual.field === null ? null : palette.inset,
      majorSurface: palette.panel,
      surfaceCard: palette.panel,
      surfaceInset: palette.inset,
    },
    `${label} module surfaces and local roles must match the steel overview palette`,
  );
  if (entity === 'chat') {
    const longTitle = panel.locator('.settings-native-toggle__title', {
      hasText: 'Включить антидубль',
    });
    assert.equal(await longTitle.count(), 1, 'The real duplicate action label must be covered');
    assert.equal(
      await longTitle.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.whiteSpace !== 'nowrap' && element.scrollWidth <= element.clientWidth + 1;
      }),
      true,
      `${label} duplicate activation title must wrap completely beside its switch`,
    );
  }
  const lastControl = body
    .locator(
      '.settings-native-switch:visible, .field input:visible, .field select:visible, .field textarea:visible, .network-settings-field input:not([type="checkbox"]):not([type="file"]):visible, .network-settings-field select:visible, .network-settings-field textarea:visible, .settings-duration-editor__preset:visible, .segmented-control__item:visible',
    )
    .last();
  await assertReachableControl(lastControl, `${label} final module control`);
  assertBoxWithin(
    await settledBox(lastControl),
    await settledBox(body),
    `${label} the final control must scroll into the body without the header or footer covering it`,
  );
  assert.equal(
    await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    `${label} the module must not overflow horizontally`,
  );
}

async function assertOverviewLayout(page, name, entity) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const header = await settledBox(page.locator('.managed-entity-workspace-header--settings'));
  const search = await settledBox(page.locator('.settings-overview-search-wrap'));
  assert.ok(
    search.y >= header.y + header.height - 0.5,
    `${name}/${entity} search overlaps the header: ${search.y} < ${header.y + header.height}`,
  );

  const pair =
    entity === 'chat' ? ['Ссылки', 'Ограничения'] : ['Быстрые кнопки', 'Комментарии в приложении'];
  const [left, right] = await Promise.all(
    pair.map((title) => settledBox(page.getByRole('button', { name: title, exact: true }))),
  );
  const viewportWidth = await page.evaluate(() => innerWidth);
  if (viewportWidth <= 600) {
    assert.ok(
      left.y + left.height <= right.y + 0.5 && Math.abs(left.x - right.x) <= 0.5,
      `${name}/${entity} modules must form readable rows without overlap on smartphones`,
    );
  } else {
    assert.ok(
      Math.abs(left.y - right.y) <= 0.5 && left.x + left.width <= right.x + 0.5,
      `${name}/${entity} ${pair.join(' / ')} must share a row in separate desktop columns`,
    );
  }
  assert.ok(
    Math.abs(left.width - right.width) <= 0.5,
    `${name}/${entity} module columns must have equal widths`,
  );
  for (const [index, box] of [left, right].entries()) {
    assert.ok(
      box.width >= 44 &&
        box.height >= 44 &&
        box.x >= -0.5 &&
        box.x + box.width <= viewportWidth + 0.5,
      `${name}/${entity} ${pair[index]} must remain a complete touch target within the viewport`,
    );
  }
}

async function assertOverviewSearch(page, name, entity, entry, enabled) {
  const containerId = `${entity}-settings-overview`;
  const entrySelector = entity === 'chat' ? '.settings-home-entry' : '.channel-settings-card';
  const overview = page.locator(`#${containerId}`);
  const entries = overview.locator(entrySelector);
  const visibleEntries = overview.locator(`${entrySelector}:visible`);
  const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
  const [alias, expectedTitle] =
    entity === 'chat'
      ? ['токсичность', 'Мат и оскорбления']
      : ['кастомные', 'Комментарии в приложении'];
  const expectedEntry = page.getByRole('button', { name: expectedTitle, exact: true });
  assert.ok(
    !(await expectedEntry.locator('.settings-section__title').innerText())
      .toLocaleLowerCase('ru-RU')
      .includes(alias),
    'The query must exercise a search alias rather than the visible module title',
  );
  assert.ok((await expectedEntry.getAttribute('data-settings-search')).includes(alias));
  await search.fill(alias);
  await page.waitForFunction(
    ({ containerId, entrySelector }) => {
      const entries = [...document.getElementById(containerId).querySelectorAll(entrySelector)];
      return entries.length > 0 && entries.filter((entry) => !entry.hidden).length === 1;
    },
    { containerId, entrySelector },
  );
  assert.equal(await visibleEntries.count(), 1, `${name}/${entity} alias search filters the board`);
  assert.equal(await expectedEntry.isVisible(), true);
  if (entity === 'chat') {
    assert.deepEqual(
      (await overview.locator('.settings-home-group-head:visible').allTextContents()).map((text) =>
        text.trim(),
      ),
      ['Защита'],
      'Only the group containing the matching module remains visible',
    );
  }

  await search.fill('__нет_такой_настройки_9af13__');
  await page.getByText('Ничего не найдено', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await visibleEntries.count(), 0, 'An empty search must leave no visible modules');
  if (entity === 'chat') {
    assert.equal(await overview.locator('.settings-home-group-head:visible').count(), 0);
  }
  await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
  await page.waitForFunction(
    ({ containerId, entrySelector }) => {
      const entries = [...document.getElementById(containerId).querySelectorAll(entrySelector)];
      return entries.length > 0 && entries.every((entry) => !entry.hidden);
    },
    { containerId, entrySelector },
  );
  assert.equal(await search.inputValue(), '');
  assert.equal(await visibleEntries.count(), await entries.count(), 'Clear restores every module');
  assert.equal(await page.getByText('Ничего не найдено', { exact: true }).count(), 0);
  if (entity === 'chat') {
    assert.deepEqual(
      (await overview.locator('.settings-home-group-head:visible').allTextContents()).map((text) =>
        text.trim(),
      ),
      ['Защита', 'Контент'],
    );
  }
  assert.equal(
    await entry.getAttribute('data-enabled'),
    enabled,
    'Search must preserve the actual module state',
  );
  await assertOverviewState(entry, enabled, `${name}/${entity} filtered overview`);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of profiles) {
    for (const [entity, routePath, title, panelSelector] of routes) {
      const context = await browser.newContext({ ...device, colorScheme });
      let releaseModule;
      const held = new Promise((resolve) => {
        releaseModule = resolve;
      });
      let requested = false;
      try {
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        await context.route('**/src/components/ui/settings-overview-search.tsx*', async (route) => {
          requested = true;
          await held;
          await route.continue();
        });
        await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
        await installNativeVisualModeInitScript(context);
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}${routePath}?preview=1`, { waitUntil: 'domcontentloaded' });
        const entry = page.getByRole('button', { name: title, exact: true });
        await entry.waitFor({ state: 'visible' });
        await applyNativeVisualMode(page, {
          safeTop: platform === 'ios' ? 44 : platform === 'android' ? 24 : 0,
          safeBottom: platform === 'ios' ? 34 : platform === 'android' ? 16 : 0,
        });
        assert.equal(requested, true, 'The actual lazy search module must be held');
        const placeholder = page.locator('.settings-overview-search-wrap[aria-hidden="true"]');
        assert.equal(await placeholder.count(), 1);
        await page.evaluate(() => window.scrollTo(0, 0));
        const initialHeaderBox = await settledBox(
          page.locator('.managed-entity-workspace-header--settings'),
        );
        const initialSearchBox = await settledBox(placeholder);
        assert.ok(
          initialSearchBox.y >= initialHeaderBox.y + initialHeaderBox.height - 0.5,
          `${name}/${entity} search fallback overlaps the native header`,
        );
        assert.equal(await page.getByRole('searchbox', { name: 'Найти настройку' }).count(), 0);
        assert.equal(await placeholder.evaluate((element) => element.inert), true);
        assert.equal(
          await placeholder.locator('input').evaluate((input) => {
            input.focus();
            return document.activeElement === input;
          }),
          false,
        );
        await page.keyboard.press('Tab');
        assert.equal(
          await placeholder.evaluate((element) => element.contains(document.activeElement)),
          false,
        );
        await page.evaluate(async () => {
          const { PREVIEW_REQUEST_HANDLERS } =
            await import('/app/src/lib/api/preview-transport.ts');
          const { PREVIEW_NOT_HANDLED } =
            await import('/app/src/lib/api/preview-transport-runtime.ts');
          window.__SEARCH_LAYOUT_WRITES__ = [];
          PREVIEW_REQUEST_HANDLERS.unshift(({ method }) => {
            if (method !== 'GET') window.__SEARCH_LAYOUT_WRITES__.push(method);
            return PREVIEW_NOT_HANDLED;
          });
        });
        await entry.scrollIntoViewIfNeeded();
        const before = await settledBox(entry);
        const placeholderBox = await placeholder.boundingBox();
        assert.ok(placeholderBox?.height > 0, 'Hidden fallback must occupy real space');
        if (platform === 'desktop') {
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
          await page.mouse.down();
        }
        releaseModule();
        const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
        await search.waitFor({ state: 'visible' });
        const after = await settledBox(entry);
        for (const key of ['x', 'y', 'width', 'height']) {
          assert.ok(
            Math.abs(before[key] - after[key]) <= 0.5,
            `${name}/${entity} ${key} shifted: ${before[key]} → ${after[key]}`,
          );
        }
        const readyBox = await page.locator('.settings-overview-search-wrap').boundingBox();
        assert.ok(
          Math.abs(readyBox.height - placeholderBox.height) <= 0.5,
          'Fallback and ready search heights must agree',
        );
        assert.equal(await placeholder.count(), 0);
        const enabled = await entry.getAttribute('data-enabled');
        assert.ok(enabled === 'true' || enabled === 'false');
        assert.equal(await entry.getAttribute('aria-expanded'), 'false');
        await assertOverviewState(entry, enabled, `${name}/${entity} closed overview`);
        assert.ok(
          await entry.evaluate((element) =>
            getComputedStyle(element).fontFamily.includes('Manrope VF'),
          ),
          'The overview must use the bundled Cyrillic variable font',
        );
        assert.equal(
          await page
            .getByRole('button', { name: 'Опросы', exact: true })
            .getAttribute('data-enabled'),
          null,
          'Navigation-only tools must not claim an enabled or disabled state',
        );
        if (platform === 'desktop') await page.mouse.up();
        const palette = await readSteelPalette(page);
        if (platform !== 'desktop') await entry.tap();
        await page.locator(panelSelector).waitFor({ state: 'visible' });
        assert.equal(await page.locator('.settings-drilldown__panel:visible').count(), 1);
        await assertModulePresentation(page, name, entity, title, panelSelector, palette);
        const moduleSwitch =
          entity === 'chat'
            ? page.getByRole('checkbox', { name: 'Включить антидубль', exact: true })
            : page.getByRole('checkbox', { name: 'Добавлять подпись', exact: true });
        assert.equal(
          await moduleSwitch.isChecked(),
          enabled === 'true',
          'Navigation changes must preserve the actual module setting',
        );
        await assertReachableControl(
          moduleSwitch.locator('..'),
          `${name}/${entity} module switch`,
          {
            touchTarget: true,
          },
        );
        assert.equal(
          await moduleSwitch
            .locator('..')
            .locator('.toggle-switch')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
          enabled === 'true' ? palette.blue : palette.inset,
          `${name}/${entity} the real switch must use the module accent and inset roles`,
        );
        await page.locator(`${panelSelector} .settings-drilldown__close`).click();
        await page.locator(panelSelector).waitFor({ state: 'hidden' });
        const pollsEntry = page.getByRole('button', { name: 'Опросы', exact: true });
        await pollsEntry.scrollIntoViewIfNeeded();
        await settledBox(pollsEntry);
        await pollsEntry.click();
        const pollsPanel = page.locator('.settings-drilldown__panel--polls');
        await pollsPanel.waitFor({ state: 'visible' });
        assert.equal(
          await pollsPanel.locator('.settings-drilldown__symbol[aria-hidden="true"] svg').count(),
          1,
          `${name}/${entity} a ReactElement module icon must render once as decorative content`,
        );
        assert.equal(await page.getByRole('dialog', { name: 'Опросы', exact: true }).count(), 1);
        await pollsPanel.locator('.settings-drilldown__close').click();
        await pollsPanel.waitFor({ state: 'hidden' });
        await assertOverviewLayout(page, name, entity);
        await assertOverviewSearch(page, name, entity, entry, enabled);
        assert.deepEqual(await page.evaluate(() => window.__SEARCH_LAYOUT_WRITES__), []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${name}/${entity}: delayed search keeps ${readyBox.height}px geometry, title-only mobile rows, unchanged desktop context, steel palette, reachable controls, alias/empty/clear search and no writes`,
        );
      } finally {
        releaseModule();
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
