import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
const browser = await chromium.launch();
const now = new Date('2030-01-01T10:00:00Z');
const delivery = { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 };

function publication(schedule) {
  return {
    id: 'saved-publication',
    title: 'Сохраненный пост',
    lifecycle: 'ACTIVE',
    version: 4,
    contentPreview: 'Исходный текст',
    targetCount: 1,
    targetPreviews: [{ chatId: 'preview-channel', entityType: 'channel', title: 'Новости Южного' }],
    targetOverflowCount: 0,
    audienceSelection: 'SELECTED',
    audienceMode: 'SNAPSHOT',
    mediaCount: 0,
    hasVideo: false,
    schedule: {
      ...schedule,
      timezone: schedule.timezone ?? 'Europe/Moscow',
      status: 'ACTIVE',
      revision: 2,
      nextOccurrenceAt: schedule.mode === 'once' ? schedule.at : '2030-01-01T10:01:00Z',
      lastError: null,
    },
    delivery,
    createdAt: '2029-12-01T10:00:00Z',
    updatedAt: '2029-12-01T10:00:00Z',
    content: { revision: 4, text: 'Исходный текст', textFormat: 'plain', buttons: [], media: [] },
    targets: [{ chatId: 'preview-channel', entityType: 'channel', title: 'Новости Южного' }],
    occurrences: [],
  };
}

async function chooseCalendarTime(page, time) {
  await page.locator('.broadcast-planner__custom-time .time-field__button').click();
  const dialog = page.locator('.time-field-sheet__panel');
  const [hour, minute] = time.split(':');
  await dialog.getByRole('textbox', { name: 'Часы', exact: true }).fill(hour);
  await dialog.getByRole('textbox', { name: 'Минуты', exact: true }).fill(minute);
  await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
}

try {
  for (const [deviceName, device, colorScheme] of [
    ['iphone', devices['iPhone SE'], 'light'],
    ['android', devices['Pixel 7'], 'dark'],
  ]) {
    for (const [name, schedule] of [
      ['once', { mode: 'once', at: '2030-01-01T10:01:00Z' }],
      [
        'strict-custom',
        {
          mode: 'once',
          at: '2030-01-01T10:10:00Z',
          latePolicy: { mode: 'strict', maxDelayMinutes: 17, catchUp: 'all' },
        },
      ],
      [
        'recover-once',
        {
          mode: 'once',
          at: '2030-01-01T10:10:00Z',
          latePolicy: { mode: 'recover', maxDelayMinutes: 30, catchUp: 'all' },
        },
      ],
      [
        'recover-recurring',
        {
          mode: 'recurrence',
          frequency: 'weekly',
          interval: 2,
          weekdays: [1, 4],
          times: ['13:00'],
          startsAt: '2029-12-01T10:00:00Z',
          endsAt: null,
          maxOccurrences: 10,
          latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'all' },
        },
      ],
      [
        'slots',
        {
          mode: 'slots',
          slots: ['2029-12-31T10:00:00Z', '2030-01-01T10:01:00Z', '2030-01-02T10:00:00Z'],
        },
      ],
      [
        'imminent-slots',
        { mode: 'slots', slots: ['2029-12-31T10:00:00Z', '2030-01-01T10:01:00Z'] },
      ],
      ['dst', { mode: 'once', timezone: 'Europe/Berlin', at: '2030-10-27T01:30:00Z' }],
    ]) {
      const context = await browser.newContext({
        ...device,
        colorScheme,
        timezoneId: 'Europe/Moscow',
        reducedMotion: 'reduce',
      });
      try {
        await installMaxBridgeShimInitScript(context, {}, { colorScheme });
        const page = await context.newPage();
        const errors = [],
          patches = [];
        const forecastRequests = [];
        page.on('pageerror', (error) => errors.push(error.message));
        let current = publication(schedule);
        // FLAG: Every API response and mutation is local to this disposable browser fixture.
        await page.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        await page.route('**/publication-schedule-edit-test*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<html lang="ru" data-max-theme="${colorScheme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
            import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
            window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
            await import('/app/test/fixtures/publication-schedule-edit-harness.tsx');</script></body></html>`,
          }),
        );
        await page.route('**/api/publications**', async (route) => {
          const request = route.request(),
            url = new URL(request.url());
          let data;
          if (url.pathname.endsWith('/schedule-preview')) {
            forecastRequests.push(request.postDataJSON());
            if (forecastRequests.length === 2) {
              return route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ message: 'Недоступно' }),
              });
            }
            data = {
              state: 'finite',
              firstOccurrenceAt: '2030-01-03T10:00:00.000Z',
              lastOccurrenceAt: '2030-02-28T10:00:00.000Z',
              timezone: 'Europe/Moscow',
            };
          } else if (url.pathname.endsWith('/calendar-availability')) {
            const body = request.postDataJSON();
            data = { from: body.from, to: body.to, slots: [] };
          } else if (url.pathname.endsWith('/saved-publication')) {
            if (request.method() === 'PUT') {
              const body = request.postDataJSON();
              patches.push(body);
              current = {
                ...current,
                title: body.title,
                content: { ...current.content, ...body.content },
                version: 5,
              };
            }
            data = current;
          } else if (url.pathname.endsWith('/legacy'))
            data = { items: [], nextCursor: null, totalCount: 0 };
          else if (url.pathname.endsWith('/drafts')) data = { items: [], nextCursor: null };
          else data = { items: [current], nextCursor: null };
          await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
        });
        await page.clock.setFixedTime(now);
        await page.goto(`${base}publication-schedule-edit-test`);
        await page.getByRole('button', { name: 'Действия: Сохраненный пост', exact: true }).click();
        await page.getByRole('button', { name: 'Изменить будущие отправки', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
        await editor.waitFor();
        if (name === 'imminent-slots') {
          assert.match(
            await page.locator('.broadcast-planner__compact-summary').innerText(),
            /13:01/u,
          );
          assert.doesNotMatch(
            await page.locator('.publication-editor-section--timing').innerText(),
            /Время не выбрано|Без времени/u,
          );
        }
        if (name === 'dst') {
          const modes = page.getByRole('group', { name: 'Время публикации', exact: true });
          await modes.getByRole('button', { name: 'Сейчас', exact: true }).click();
          await modes.getByRole('button', { name: 'Отложить', exact: true }).click();
          await page.locator('.publication-once-fields .time-field__button').click();
          await page
            .locator('.time-field-sheet__panel')
            .getByRole('button', { name: 'Применить', exact: true })
            .click();
        }
        await editor.fill('Правка без изменения расписания');
        await page
          .getByRole('button', {
            name: schedule.mode === 'once' ? 'Проверить и отложить' : 'Проверить расписание',
            exact: true,
          })
          .click();
        const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
        await review.waitFor();
        const reviewFacts = await review.locator('.publication-preview__facts').innerText();
        const policy = schedule.latePolicy ?? {
          mode: 'strict',
          maxDelayMinutes: 5,
          catchUp: 'all',
        };
        assert.match(
          reviewFacts,
          policy.mode === 'strict'
            ? /При задержке · Пропустить спустя/u
            : /При задержке · Ждать восстановления до/u,
        );
        assert.ok(
          reviewFacts.includes(
            `${policy.maxDelayMinutes % 60 === 0 ? `${policy.maxDelayMinutes / 60} ч.` : `${policy.maxDelayMinutes} мин.`} после назначенного времени`,
          ),
        );
        if (schedule.mode === 'recurrence' && policy.mode === 'recover')
          assert.match(reviewFacts, /Все актуальные повторы/u);
        else assert.doesNotMatch(reviewFacts, /Все актуальные повторы|Только последний повтор/u);

        if (name === 'recover-recurring') {
          const bounds = review.locator('.publication-review-timing');
          await bounds.getByText('Первый выпуск', { exact: false }).waitFor();
          assert.deepEqual(
            await bounds.locator('time').evaluateAll((times) => times.map((time) => time.dateTime)),
            ['2030-01-03T10:00:00.000Z', '2030-02-28T10:00:00.000Z'],
          );
          assert.deepEqual(forecastRequests, [
            { editing: { publicationId: current.id, expectedRevision: current.version } },
          ]);
          if (deviceName === 'android') {
            if (process.env.MINIAPP_SCHEDULE_PREVIEW_SCREENSHOT) {
              await review.screenshot({ path: process.env.MINIAPP_SCHEDULE_PREVIEW_SCREENSHOT });
            }
            await review.getByRole('button', { name: 'Назад', exact: true }).click();
            await page.getByRole('button', { name: 'Проверить расписание', exact: true }).click();
            await bounds.getByText('Даты выпусков не рассчитаны', { exact: true }).waitFor();
            assert.match(await bounds.innerText(), /Каждые 2 нед\./u);
            assert.equal(await bounds.locator('time').count(), 0);
            assert.equal(await review.getByRole('button', { name: 'Сохранить' }).isEnabled(), true);
          }
        }

        await review.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await page.locator('.publications-page:not(.is-editor)').waitFor();
        assert.equal(patches.length, 1);
        assert.equal('schedule' in patches[0], false);
        assert.equal('audience' in patches[0], false);
        assert.equal('intent' in patches[0], false);
        assert.equal(patches[0].content.text, 'Правка без изменения расписания');
        if (name === 'recover-recurring' && deviceName === 'android') {
          await page
            .getByRole('button', { name: 'Действия: Сохраненный пост', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'Изменить будущие отправки', exact: true })
            .click();
          await editor.waitFor();
          await page.locator('.publication-target-picker__summary').click();
          await page
            .getByRole('button', { name: 'Выбрать Садоводы Южного, чат', exact: true })
            .click();
          await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
          await page.getByRole('button', { name: 'Проверить расписание', exact: true }).click();
          await review.locator('.publication-review-timing time').first().waitFor();
          assert.deepEqual(forecastRequests.at(-1).editing, {
            publicationId: current.id,
            expectedRevision: 5,
          });
          await review.getByRole('button', { name: 'Сохранить', exact: true }).click();
          await page.locator('.publications-page:not(.is-editor)').waitFor();
          assert.deepEqual(forecastRequests.at(-1).audience, patches[1].audience);
          assert.deepEqual(forecastRequests.at(-1).schedule, patches[1].schedule);
        }
        assert.deepEqual(
          current.schedule.slots ?? current.schedule.at,
          schedule.slots ?? schedule.at,
        );
        assert.deepEqual(errors, []);
        if (name === 'once') {
          await page
            .getByRole('button', { name: 'Действия: Сохраненный пост', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'Изменить будущие отправки', exact: true })
            .click();
          await editor.waitFor();
          await page.locator('.publication-target-picker__summary').click();
          await page
            .getByRole('button', { name: 'Выбрать Садоводы Южного, чат', exact: true })
            .click();
          await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
          await page.getByRole('button', { name: 'Проверить и отложить', exact: true }).click();
          await page
            .locator('.publication-submit-feedback')
            .getByText('Выберите время минимум на 2 минуты позже текущего.', { exact: true })
            .waitFor();
          assert.equal(await review.count(), 0);
          assert.equal(patches.length, 1);
        }
        if (name === 'slots') {
          await page
            .getByRole('button', { name: 'Действия: Сохраненный пост', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'Изменить будущие отправки', exact: true })
            .click();
          await editor.waitFor();
          await page.locator('.broadcast-planner__compact-summary').click();
          await page
            .locator('.broadcast-planner__dock')
            .getByRole('button', { name: 'Время', exact: true })
            .click();
          await page.locator('.broadcast-planner__day-tab').first().click();
          const imminent = page.getByRole('button', { name: 'Удалить время 13:01', exact: true });
          await imminent.click();
          await chooseCalendarTime(page, '13:01');
          assert.equal(await imminent.count(), 0);
          await chooseCalendarTime(page, '13:02');
          await page.getByRole('button', { name: 'Удалить время 13:02', exact: true }).waitFor();
          assert.equal(patches.length, 1);
        }
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${deviceName}-${colorScheme}-${name}: content-only edit preserves the saved dates`,
        );
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await stopChildProcess(server);
}
