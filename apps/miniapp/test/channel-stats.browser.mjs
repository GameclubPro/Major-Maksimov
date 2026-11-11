import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Local server required');
const output = mkdtempSync(join(tmpdir(), 'maxim-channel-stats-'));
const browser = await chromium.launch();

async function checkBanErrors(page, targetName, width, theme) {
  await page.evaluate(async () => {
    const transportUrl = performance
      .getEntriesByType('resource')
      .findLast((entry) => new URL(entry.name).pathname.endsWith('/preview-transport.ts')).name;
    const { PREVIEW_REQUEST_HANDLERS } = await import(transportUrl);
    const { PREVIEW_NOT_HANDLED } = await import(
      new URL('preview-transport-runtime.ts', transportUrl).href
    );
    const { createApiRequestError } = await import(
      new URL('../api-request-error.ts', transportUrl).href
    );
    const { buildApiErrorMessage } = await import(new URL('../api-error.ts', transportUrl).href);
    const fixture = {
      scenario: null,
      attempts: 0,
      reads: 0,
      release: null,
      paginated: false,
      cursors: [],
    };
    const handler = async (context) => {
      if (
        context.method === 'GET' &&
        context.url.pathname === '/channels/preview-channel/activity-feed'
      ) {
        fixture.reads += 1;
        fixture.cursors.push(context.url.searchParams.get('cursor'));
        if (fixture.paginated) {
          const more = context.url.searchParams.has('cursor');
          return {
            items: context.state.channelActivity.slice(more ? 2 : 0, more ? 3 : 2),
            hasMore: !more,
            nextCursor: more ? null : 'ban-error-page-2',
          };
        }
      }
      if (
        !fixture.scenario ||
        context.method !== 'POST' ||
        !/^\/channels\/preview-channel\/members\/[^/]+\/ban$/u.test(context.url.pathname)
      )
        return PREVIEW_NOT_HANDLED;
      fixture.attempts += 1;
      fixture.retryMutationOnTransportError = context.init.retryMutationOnTransportError;
      const scenario = fixture.scenario;
      await new Promise((resolve) => {
        fixture.release = resolve;
      });
      fixture.release = null;
      if (scenario.network) throw new TypeError('Failed to fetch');
      const body = JSON.stringify(scenario.payload);
      throw createApiRequestError(
        scenario.status,
        body,
        buildApiErrorMessage(scenario.status, body, 'application/json'),
      );
    };
    PREVIEW_REQUEST_HANDLERS.unshift(handler);
    window.channelBanErrorFixture = fixture;
    window.removeChannelBanErrorFixture = () => {
      fixture.release?.();
      const index = PREVIEW_REQUEST_HANDLERS.indexOf(handler);
      if (index >= 0) PREVIEW_REQUEST_HANDLERS.splice(index, 1);
    };
  });

  const unknownMessage =
    'Результат блокировки пока не подтверждён. Обновите события перед повтором.';
  const scenarios = [
    {
      name: 'member-right',
      status: 409,
      payload: {
        code: 'BOT_CAPABILITY_REQUIRED',
        missingPermissions: ['add_remove_members'],
        message: 'MAXIM SQL add_remove_members exception',
        botId: 'internal-bot-id',
      },
      message: 'Боту нужно право «Управлять участниками» в этом канале.',
      allowRetry: true,
    },
    {
      name: 'administrator',
      status: 409,
      payload: {
        code: 'BOT_CAPABILITY_REQUIRED',
        missingPermissions: ['administrator'],
        canRecheck: false,
      },
      message: 'Назначьте бота администратором канала.',
      allowRetry: false,
    },
    {
      name: 'actor-denied',
      status: 403,
      payload: { code: 'ACCESS_DENIED', message: 'Секретная диагностика сервера' },
      message: 'Недостаточно прав для этого действия.',
      allowRetry: false,
    },
    {
      name: 'check-unavailable',
      status: 503,
      payload: { code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE' },
      message: 'Не удалось проверить права бота. Попробуйте позже.',
      allowRetry: true,
    },
    {
      name: 'target-left',
      status: 400,
      payload: { message: 'Участник уже вышел из канала или был удалён.' },
      message: 'Участник уже вышел из канала или был удалён.',
      allowRetry: true,
    },
    {
      name: 'uncertain',
      status: 503,
      payload: { code: 'MODERATION_ACTION_STATUS_UNCERTAIN' },
      message: unknownMessage,
      allowRetry: false,
    },
    {
      name: 'network',
      network: true,
      message: unknownMessage,
      allowRetry: false,
    },
    {
      name: 'server-error',
      status: 500,
      payload: { code: 'BOT_CAPABILITY_REQUIRED', missingPermissions: ['add_remove_members'] },
      message: unknownMessage,
      allowRetry: false,
    },
    {
      name: 'in-progress',
      status: 409,
      payload: { code: 'MODERATION_ACTION_IN_PROGRESS' },
      message: 'Действие для этого участника уже выполняется. Обновите события.',
      allowRetry: false,
    },
    {
      name: 'state-changed',
      status: 409,
      payload: { code: 'MODERATION_ACTION_STATE_CHANGED' },
      message: 'Состояние участника изменилось. Обновите события.',
      allowRetry: false,
    },
  ];

  try {
    for (const scenario of scenarios) {
      const context = `${width}px ${theme}: ${scenario.name}`;
      const before = await page.evaluate((value) => {
        window.channelBanErrorFixture.scenario = value;
        return window.channelBanErrorFixture.attempts;
      }, scenario);
      const dialog = page.getByRole('alertdialog');
      const confirm = dialog.getByRole('button', { name: 'Заблокировать', exact: true });
      await confirm.evaluate((button) => {
        button.click();
        button.click();
      });
      await page.waitForFunction(() => window.channelBanErrorFixture.release !== null);
      await dialog.getByRole('button', { name: 'Блокируем...', exact: true }).waitFor();
      assert.equal(
        await dialog.getByRole('button', { name: 'Отмена', exact: true }).isDisabled(),
        true,
        `${context}: cancellation stays disabled while the command is pending`,
      );
      await page.evaluate(() => window.channelBanErrorFixture.release());
      await dialog.getByRole('alert').waitFor();
      assert.equal(await dialog.getByRole('alert').textContent(), scenario.message, context);
      assert.equal(await confirm.isEnabled(), scenario.allowRetry, context);
      assert.doesNotMatch(
        await dialog.innerText(),
        /add_remove_members|MAXIM|SQL|internal-bot-id/u,
        context,
      );
      const state = await page.evaluate(() => ({
        attempts: window.channelBanErrorFixture.attempts,
        retry: window.channelBanErrorFixture.retryMutationOnTransportError,
      }));
      assert.deepEqual(state, { attempts: before + 1, retry: false }, context);
      if (scenario.name === 'member-right' || scenario.name === 'uncertain') {
        await page
          .waitForFunction(
            () => {
              const panel = document.querySelector(
                '.action-confirm-sheet__panel[role="alertdialog"]',
              );
              const backdrop = panel?.parentElement?.querySelector(
                '.action-confirm-sheet__backdrop',
              );
              return [panel, backdrop].every(
                (surface) =>
                  surface &&
                  Number.parseFloat(getComputedStyle(surface).opacity) === 1 &&
                  surface
                    .getAnimations()
                    .every((animation) => ['finished', 'idle'].includes(animation.playState)),
              );
            },
            null,
            { timeout: 3_000 },
          )
          .catch((error) => {
            throw new Error(`${context}: error dialog did not finish appearing`, { cause: error });
          });
        await page.screenshot({
          path: join(output, `${width}-${theme}-ban-${scenario.name}.png`),
          animations: 'disabled',
        });
      }
      if (scenario.allowRetry) {
        await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
      } else {
        await confirm.evaluate((button) => button.click());
        assert.equal(
          await page.evaluate(() => window.channelBanErrorFixture.attempts),
          before + 1,
          `${context}: a disabled confirmation never sends another command`,
        );
        const readsBefore = await page.evaluate(() => window.channelBanErrorFixture.reads);
        await dialog.getByRole('button', { name: 'Обновить события', exact: true }).click();
        await page.waitForFunction(
          (count) => window.channelBanErrorFixture.reads > count,
          readsBefore,
        );
        assert.equal(
          await page.evaluate(() => window.channelBanErrorFixture.attempts),
          before + 1,
          `${context}: refreshing events never sends another command`,
        );
      }
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: targetName, exact: true }).first().click();
      await page.getByRole('alertdialog').waitFor();
    }

    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Отмена', exact: true })
      .click();
    await page.evaluate(() => {
      window.channelBanErrorFixture.paginated = true;
      window.channelBanErrorFixture.cursors = [];
    });
    await page.getByRole('button', { name: 'Обновить события', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.membership-feed__item').length === 2,
    );
    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.membership-feed__item').length === 3,
    );
    assert.deepEqual(await page.evaluate(() => window.channelBanErrorFixture.cursors), [
      null,
      'ban-error-page-2',
    ]);
    await page.getByRole('button', { name: targetName, exact: true }).first().click();
    const dialog = page.getByRole('alertdialog');
    const attemptsBefore = await page.evaluate(
      (scenario) => {
        window.channelBanErrorFixture.scenario = scenario;
        return window.channelBanErrorFixture.attempts;
      },
      scenarios.find((scenario) => scenario.name === 'uncertain'),
    );
    await dialog.getByRole('button', { name: 'Заблокировать', exact: true }).click();
    await page.waitForFunction(() => window.channelBanErrorFixture.release !== null);
    await page.evaluate(() => window.channelBanErrorFixture.release());
    await dialog.getByRole('alert').waitFor();
    await dialog.getByRole('button', { name: 'Обновить события', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      () => document.querySelectorAll('.membership-feed__item').length === 2,
    );
    assert.deepEqual(await page.evaluate(() => window.channelBanErrorFixture.cursors), [
      null,
      'ban-error-page-2',
      null,
    ]);
    assert.equal(
      await page.evaluate(() => window.channelBanErrorFixture.attempts),
      attemptsBefore + 1,
    );
    await page.evaluate(() => {
      window.channelBanErrorFixture.paginated = false;
    });
    await page.getByRole('button', { name: 'Обновить события', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('.membership-feed__item').length > 3,
    );
    await page.getByRole('button', { name: targetName, exact: true }).first().click();
    await page.getByRole('alertdialog').waitFor();
  } finally {
    await page.evaluate(() => window.removeChannelBanErrorFixture());
  }
}

try {
  for (const [width, height] of process.argv.includes('--state-only')
    ? []
    : [
        [320, 568],
        [393, 851],
        [1280, 900],
      ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        { platform: width === 393 ? 'android' : 'ios' },
        { colorScheme: theme },
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        new URL(
          'channel/preview-channel/stats?preview=1&device=iphone-se&moderationState=slow',
          base,
        ).href,
      );
      await page.locator('.channel-summary-table tbody tr').first().waitFor();
      await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 0 });
      await page.evaluate(() => document.fonts.ready);
      for (const range of ['24ч', '30д', '7д']) {
        await page
          .getByRole('radiogroup', { name: 'Период статистики канала', exact: true })
          .getByRole('radio', { name: range, exact: true })
          .click();
        await page.locator('.channel-summary-table tbody tr').first().waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
      }
      await page.getByRole('button', { name: 'Обновить статистику', exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Обновить статистику"]').disabled,
      );
      await page.screenshot({
        path: join(output, `${width}-${theme}-overview.png`),
        fullPage: true,
        animations: 'disabled',
      });

      await page.getByRole('radio', { name: 'События', exact: true }).click();
      await page.locator('.membership-feed__item').first().waitFor();
      await page.getByRole('button', { name: 'Обновить события', exact: true }).click();
      await page.waitForFunction(
        () => !document.querySelector('[aria-label="Обновить события"]').disabled,
      );
      for (const filter of ['Вошли', 'Вышли', 'Все']) {
        await page
          .getByRole('radiogroup', { name: 'Фильтр событий входа и выхода' })
          .getByRole('radio', { name: filter, exact: true })
          .click();
        await page.waitForFunction(
          (label) =>
            document.querySelector('.membership-feed__filters [aria-checked="true"]')
              ?.textContent === label,
          filter,
        );
        await page.locator('.membership-feed__item').first().waitFor();
        if (filter !== 'Все')
          assert.equal(
            await page
              .locator(
                filter === 'Вошли'
                  ? '.membership-feed__item--left'
                  : '.membership-feed__item--joined',
              )
              .count(),
            0,
          );
      }
      const trigger = page.locator('.membership-feed__item--joined .channel-member-ban').first();
      const targetName = await trigger.getAttribute('aria-label');
      await trigger.click();
      let dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /Только в канале/);
      await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: targetName, exact: true }).first().click();
      dialog = page.getByRole('alertdialog');
      await dialog.waitFor();
      await page.screenshot({
        path: join(output, `${width}-${theme}-confirm.png`),
        animations: 'disabled',
      });
      if (width <= 393) await checkBanErrors(page, targetName, width, theme);
      const before = await page.locator('.membership-feed__item').count();
      await dialog
        .getByRole('button', { name: 'Заблокировать', exact: true })
        .evaluate((button) => {
          button.click();
          button.click();
        });
      await dialog.getByRole('button', { name: 'Блокируем...', exact: true }).waitFor();
      assert.equal(
        await dialog.getByRole('button', { name: 'Отмена', exact: true }).isDisabled(),
        true,
      );
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(
        (count) => document.querySelectorAll('.membership-feed__item').length === count + 1,
        before,
      );
      await page.getByRole('button', { name: targetName, exact: true }).first().click();
      dialog = page.getByRole('alertdialog');
      await dialog.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.match(await dialog.innerText(), /Результат блокировки пока не подтверждён/u);
      assert.equal(
        await dialog.getByRole('button', { name: 'Заблокировать', exact: true }).isDisabled(),
        true,
      );
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });

      await page
        .locator('.membership-feed__name-link')
        .first()
        .evaluate((node) => {
          node.textContent = 'ОченьДлинноеИмяПользователяБезПробелов И Длинная Фамилия';
        });
      await page.locator('.membership-feed__item').first().scrollIntoViewIfNeeded();
      const layout = await page
        .locator('.membership-feed__card')
        .first()
        .evaluate((card) => {
          const avatar = card.querySelector('.membership-feed__avatar').getBoundingClientRect();
          const name = card.querySelector('.membership-feed__name-link').getBoundingClientRect();
          const button = card.querySelector('.channel-member-ban').getBoundingClientRect();
          const row = card.getBoundingClientRect();
          return {
            separated: avatar.right <= name.left + 1 && name.right <= button.left + 1,
            bounded: button.right <= row.right + 1,
            buttonWidth: button.width,
            buttonHeight: button.height,
          };
        });
      assert.equal(layout.separated, true, JSON.stringify(layout));
      assert.equal(layout.bounded, true);
      assert.ok(layout.buttonWidth >= 44 && layout.buttonHeight >= 44);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: join(output, `${width}-${theme}-events.png`),
        fullPage: true,
        animations: 'disabled',
      });
      assert.deepEqual(errors, []);
      console.log(
        `PASS channels ${width}px ${theme}: ranges, refresh, filters, confirmation, single ban, errors, layout`,
      );
      await context.close();
    }
  }

  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error(error.message));
  await page.goto(base.href);
  await page.waitForFunction(() =>
    performance
      .getEntriesByType('resource')
      .some((entry) => entry.name.includes('/react-dom_client.js')),
  );
  await page.evaluate(() => {
    window.channelTestReactUrl = performance
      .getEntriesByType('resource')
      .find((entry) => new URL(entry.name).pathname.endsWith('/react.js')).name;
    window.channelTestReactDomUrl = performance
      .getEntriesByType('resource')
      .find((entry) => new URL(entry.name).pathname.endsWith('/react-dom_client.js')).name;
  });
  await page.evaluate(async () => {
    const {
      default: { createElement, useState },
    } = await import(window.channelTestReactUrl);
    const {
      default: { createRoot },
    } = await import(window.channelTestReactDomUrl);
    const { useEventFeed } = await import('/app/src/lib/use-event-feed.ts');
    const host = document.createElement('div');
    document.body.append(host);
    window.channelFeedCalls = [];
    function Harness() {
      const [scope, setScope] = useState('one');
      const feed = useEventFeed({
        scopeKey: scope,
        enabled: true,
        query: {},
        loadPage: async (query) => {
          window.channelFeedCalls.push({ scope, cursor: query.cursor });
          if (scope === 'empty') return { items: [], hasMore: false, nextCursor: null };
          if (query.cursor) return { items: [{ id: 'second' }], hasMore: false, nextCursor: null };
          return { items: [{ id: 'first' }], hasMore: true, nextCursor: 'first-cursor' };
        },
      });
      window.channelFeed = feed;
      window.channelFeedInitialLoading ??= feed.isReloading;
      window.changeChannelFeedScope = setScope;
      return createElement(
        'div',
        { id: 'channel-feed-harness' },
        feed.items.map((item) => item.id).join(','),
      );
    }
    createRoot(host).render(createElement(Harness));
  });
  await page.waitForFunction(() => window.channelFeed?.firstPage?.nextCursor === 'first-cursor');
  assert.equal(await page.evaluate(() => window.channelFeedInitialLoading), true);
  await page.evaluate(() => window.channelFeed.loadMore());
  await page.waitForFunction(() => window.channelFeed.items.length === 2);
  assert.deepEqual(await page.evaluate(() => window.channelFeed.firstPage), {
    items: [{ id: 'first' }],
    hasMore: true,
    nextCursor: 'first-cursor',
  });
  assert.equal(await page.evaluate(() => window.channelFeed.canAutoRefresh), false);
  await page.evaluate(() => {
    window.previousChannelFeedRetry = window.channelFeed.retry;
    window.changeChannelFeedScope('empty');
  });
  await page.waitForFunction(() => window.channelFeed.firstPage?.items.length === 0);
  assert.deepEqual(await page.evaluate(() => window.channelFeed.firstPage), {
    items: [],
    hasMore: false,
    nextCursor: null,
  });
  const callsBeforeStaleRetry = await page.evaluate(() => window.channelFeedCalls.length);
  await page.evaluate(() => window.previousChannelFeedRetry());
  assert.equal(await page.evaluate(() => window.channelFeedCalls.length), callsBeforeStaleRetry);
  console.log(
    'PASS feed snapshot: first-page cursor survives pagination, empty page replaces stale snapshot',
  );
  await page.evaluate(async () => {
    const {
      default: { createElement },
    } = await import(window.channelTestReactUrl);
    const {
      default: { createRoot },
    } = await import(window.channelTestReactDomUrl);
    const { ChannelStatsOverview } =
      await import('/app/src/components/dashboard/channel-stats-overview.tsx');
    const { createPreviewApiTransport } = await import('/app/src/lib/api/preview-transport.ts');
    const stats = await createPreviewApiTransport().request(
      '/channels/preview-channel/stats?range=7d',
    );
    stats.summary.daily = [{ ...stats.summary.daily[0], joined: null, left: 4 }];
    const host = document.createElement('div');
    document.body.append(host);
    createRoot(host).render(
      createElement(ChannelStatsOverview, { stats, range: '7d', onRangeChange() {} }),
    );
  });
  await page.locator('.channel-summary-table__movement-pill.is-neutral em').waitFor();
  assert.equal(
    await page.locator('.channel-summary-table__movement-pill.is-neutral em').textContent(),
    '—',
  );
  console.log('PASS overview: missing membership count is not displayed as zero');
  await page.close();
  console.log(`Channel screenshots: ${output}`);
} finally {
  await browser.close();
}
