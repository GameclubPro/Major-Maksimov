import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export async function smokeRuntimeOverview(page, profile, controls) {
  const panel = page.getByRole('region', { name: 'Боты и очереди', exact: true });
  const selector = page.getByRole('navigation', { name: 'Вид наблюдений' });
  await panel.getByText('Требует внимания', { exact: true }).waitFor();
  await panel.getByRole('article', { name: 'Майор 2', exact: true }).waitFor();
  await panel.getByText('≥ 64', { exact: true }).first().waitFor();
  await panel.getByRole('heading', { name: 'События настроенных ботов', exact: true }).waitFor();
  const unfinishedMeasure = panel
    .locator('article.runtime-measure')
    .filter({ has: page.getByRole('heading', { name: 'Незавершённые действия', exact: true }) });
  if (!(await unfinishedMeasure.getAttribute('class'))?.includes('runtime-tone--neutral'))
    throw new Error('An old action state was presented as proven delivery latency.');
  await unfinishedMeasure
    .getByText('Может включать запланированные действия и повторные попытки', { exact: true })
    .waitFor();
  if (await panel.getByRole('progressbar').count())
    throw new Error('An unbounded queue was rendered as finite completion.');
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1))
    throw new Error(`${profile.name} bot overview has horizontal overflow.`);
  await panel.getByRole('button', { name: 'Сутки', exact: true }).click();
  await panel
    .getByRole('img', { name: 'Ожидающие задания, последние сутки', exact: true })
    .waitFor();
  await panel.getByRole('button', { name: 'Час', exact: true }).click();
  await panel.getByText('Очереди и сохранённые результаты', { exact: true }).first().click();
  await panel.getByText('Ожидание и подтверждения', { exact: true }).first().click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1))
    throw new Error(`${profile.name} expanded bot observations have horizontal overflow.`);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const transition = await panel
    .locator('.runtime-segment')
    .first()
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  if (transition !== '0s') throw new Error('Queue distribution ignores reduced-motion preference.');
  const captureDirectory = process.env.MAXIM_ADMIN_OVERVIEW_CAPTURE_DIR;
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    await page.screenshot({
      path: path.join(captureDirectory, `overview-${profile.name}.png`),
      fullPage: true,
    });
  }

  // FLAG: Earlier fast-forwards put browser time ahead of host time. Keep the pause
  // target and its margin in the browser clock's time domain.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  let before = controls.readCount();
  const poll = page.waitForResponse((response) => response.url().endsWith('/runtime/overview'));
  await page.clock.fastForward(16_000);
  await poll;
  await panel.locator('.runtime-overview').waitFor();
  await page.locator('section[aria-label="Боты и очереди"][aria-busy="false"]').waitFor();
  if (controls.readCount() !== before + 1)
    throw new Error('Visible overview did not poll once at 15 seconds.');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  before = controls.readCount();
  await page.clock.fastForward(60_000);
  if (controls.readCount() !== before) throw new Error('Hidden overview kept polling.');
  const resumed = page.waitForResponse((response) => response.url().endsWith('/runtime/overview'));
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await resumed;
  await page.locator('section[aria-label="Боты и очереди"][aria-busy="false"]').waitFor();
  if (controls.readCount() !== before + 1)
    throw new Error('Visible return did not obtain a fresh overview.');

  controls.setMode('timing-gap');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await panel.getByText('Неполные данные задержки', { exact: true }).first().waitFor();
  await panel.getByText('Задержка измерена для 2 из 7 результатов', { exact: true }).waitFor();
  if (await panel.getByText(/Без превышений/).count())
    throw new Error('Missing action timings were presented as complete health evidence.');

  controls.setMode('invalid');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Показан предыдущий снимок' }).waitFor();
  if (await panel.getByText('Свежее наблюдение', { exact: false }).count())
    throw new Error('A failed refresh presented previous measurements as fresh.');
  await panel.getByText('Данные устарели', { exact: false }).first().waitFor();
  if (await panel.locator('.runtime-measure.runtime-tone--danger, .runtime-text--danger').count())
    throw new Error('Historical measurements retained a current critical indication.');

  controls.setMode('denied');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Нет доступа к наблюдениям.' }).waitFor();
  if (await panel.locator('.runtime-overview').count())
    throw new Error('Denied overview retained private evidence.');
  before = controls.readCount();
  await page.clock.fastForward(60_000);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  if (controls.readCount() !== before) throw new Error('Denied owner scope restarted reads.');
  await page.getByRole('button', { name: 'Публикации', exact: true }).click();
  await page.getByRole('button', { name: 'Наблюдения', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Нет доступа к наблюдениям.' }).waitFor();
  if (controls.readCount() !== before)
    throw new Error('Navigation remount bypassed denied owner scope.');

  controls.setMode('fresh');
  await page.reload();
  await page.getByRole('button', { name: 'Публикации', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Наблюдения', exact: true }).click();
  await panel.getByText('Требует внимания', { exact: true }).waitFor();
  if (controls.readCount() !== before + 1)
    throw new Error('A fresh browser session did not restart observations.');
  if (
    (await selector
      .getByRole('button', { name: 'Боты и очереди', exact: true })
      .getAttribute('aria-pressed')) !== 'true'
  )
    throw new Error('New owner did not open the default overview.');
  await page.clock.resume();
}
