import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
const output =
  process.env.MINIAPP_TEST_ARTIFACT_DIR ?? mkdtempSync(join(tmpdir(), 'maxim-major-controls-'));
mkdirSync(output, { recursive: true });
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.MINIAPP_TEST_REUSE_SERVER === '1',
});
const observations = [];

async function assertTextFits(labels, description) {
  const issues = await labels.evaluateAll((elements) => {
    const issues = [];
    for (const element of elements) {
      const button = element.closest('button');
      const bounds = (button ?? element).getBoundingClientRect();
      const verticalBounds = (
        button ??
        element.closest('.settings-command-card__row') ??
        element.parentElement
      ).getBoundingClientRect();
      const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (texts.nextNode()) {
        if (!texts.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(texts.currentNode);
        for (const rect of range.getClientRects()) {
          if (
            rect.left < bounds.left - 1 ||
            rect.right > bounds.right + 1 ||
            rect.top < verticalBounds.top - 1 ||
            rect.bottom > verticalBounds.bottom + 1
          ) {
            issues.push(element.textContent.trim());
          }
        }
      }
    }
    return issues;
  });
  assert.deepEqual(issues, [], description);
}

async function setTextSize(page, size) {
  await page.evaluate(async (value) => {
    document.documentElement.style.fontSize = `${value}px`;
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  }, size);
}

async function checkSettings(page, profile, name) {
  for (const module of ['Ссылки', 'Правила', 'Команды']) {
    await page.goto(new URL('chat/preview-chat/settings?preview=1', base).href);
    await page.getByRole('button', { name: module, exact: true }).click();
    const panel = page.getByRole('dialog', { name: module, exact: true });
    await panel.waitFor();
    await applyNativeVisualMode(page, profile);
    for (const size of [16, 32]) {
      await setTextSize(page, size);
      if (module === 'Ссылки') {
        const group = panel.getByRole('radiogroup', { name: 'Режим модерации ссылок' });
        await assertTextFits(group.locator('[role="radio"] > span'), `${name}/${size}: link modes`);
        if (size === 16 && page.viewportSize().width >= 320) {
          const rows = await group
            .getByRole('radio')
            .evaluateAll((buttons) =>
              buttons.map((button) => Math.round(button.getBoundingClientRect().top)),
            );
          assert.equal(new Set(rows).size, 2, 'ordinary text preserves the two-column panel');
        }
      } else if (module === 'Правила') {
        const commands = panel.locator('.rules-publish-bar__commands');
        await assertTextFits(commands.locator('.button > span'), `${name}/${size}: rules actions`);
        const buttons = await commands.locator('.button').evaluateAll((nodes) =>
          nodes.map((node) => {
            const bounds = node.getBoundingClientRect();
            return {
              label: node.getAttribute('aria-label') ?? node.textContent.trim(),
              left: bounds.left,
              top: bounds.top,
              right: bounds.right,
              bottom: bounds.bottom,
              height: bounds.height,
            };
          }),
        );
        for (const [index, button] of buttons.entries()) {
          assert.ok(button.height >= 44, `${button.label} has a touch target`);
          assert.ok(button.left >= 0 && button.right <= page.viewportSize().width + 1);
          assert.ok(button.top >= 0 && button.bottom <= page.viewportSize().height + 1);
          for (const other of buttons.slice(index + 1)) {
            assert.ok(
              Math.min(button.right, other.right) - Math.max(button.left, other.left) <= 1 ||
                Math.min(button.bottom, other.bottom) - Math.max(button.top, other.top) <= 1,
              `${button.label} and ${other.label} must not overlap`,
            );
          }
        }
      } else {
        await assertTextFits(
          panel.locator('.settings-command-card label'),
          `${name}/${size}: command titles`,
        );
        const overlap = await panel.locator('.settings-command-card__title').evaluateAll((rows) =>
          rows.some((row) => {
            const title = row.querySelector('label').getBoundingClientRect();
            const info = row.querySelector('button').getBoundingClientRect();
            return (
              Math.min(title.right, info.right) - Math.max(title.left, info.left) > 1 &&
              Math.min(title.bottom, info.bottom) - Math.max(title.top, info.top) > 1
            );
          }),
        );
        assert.equal(overlap, false, 'command labels reserve room for their info buttons');
        const info = panel.getByRole('button', {
          name: 'Что делает команда «Заблокировать»',
          exact: true,
        });
        const note = panel.getByRole('note', {
          name: 'Что делает команда «Заблокировать»',
          exact: true,
        });
        await info.tap();
        await note.waitFor();
        await panel.getByRole('heading', { name: 'Команды', exact: true }).tap();
        await note.waitFor({ state: 'hidden' });
        if (size === 32) {
          await info.tap();
          await note.waitFor();
          await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
          await note.waitFor({ state: 'hidden' });
          assert.equal(await panel.isVisible(), true, 'native Back dismisses only the hint');
          await info.tap();
          await note.waitFor();
          await page.keyboard.press('Escape');
          await note.waitFor({ state: 'hidden' });
        }
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({ path: join(output, `${name}-${module}-${size}.png`) });
      observations.push({ name, module, size, passed: true });
    }
  }
}

async function checkModeration(page, profile, name) {
  await page.goto(new URL('chat/preview-chat/events?preview=1&moderationView=history', base).href);
  const row = page.locator('.event-feed-item').filter({ hasText: 'Мария Ссылкина' });
  await row.locator('.event-feed-item__expand').click();
  await row.getByRole('button', { name: 'Мут', exact: true }).click();
  await applyNativeVisualMode(page, profile);
  const hours = row.getByRole('spinbutton', { name: /^Часы/u });
  const apply = row.locator('.logs-violation-item__apply-button');
  assert.equal(await hours.inputValue(), '6');
  await hours.fill('');
  assert.equal(await hours.inputValue(), '', 'clearing the input leaves an editable empty buffer');
  assert.equal(await apply.isDisabled(), true, 'an unfinished duration cannot open confirmation');
  await hours.pressSequentially('24');
  assert.equal(await hours.inputValue(), '24', 'typing 24 after clearing must not become 124');
  await apply.click();
  const confirmation = page.getByRole('dialog', { name: 'Мут участника', exact: true });
  await confirmation.waitFor();
  assert.match(await confirmation.innerText(), /Назначить мут на 24 ч\?/u);
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  await hours.fill('');
  await hours.blur();
  assert.equal(
    await hours.inputValue(),
    '24',
    'leaving an empty field restores its last valid duration',
  );
  await hours.fill('500');
  assert.equal(await apply.isDisabled(), true);
  await hours.blur();
  assert.equal(await hours.inputValue(), '336', 'range normalization occurs only after editing');
  await row.getByRole('button', { name: 'Уменьшить срок ограничения', exact: true }).click();
  assert.equal(await hours.inputValue(), '335', 'stepper and input stay synchronized');
  await row.getByRole('button', { name: '1д', exact: true }).click();
  assert.equal(await hours.inputValue(), '24', 'presets and input stay synchronized');
  await page.screenshot({ path: join(output, `${name}-mute.png`) });

  await page.goto(new URL('chat/preview-chat/events?preview=1&section=participants', base).href);
  await page
    .locator('.participants-roster__item--interactive')
    .filter({ hasText: '@sergey-market' })
    .click();
  const card = page.getByRole('dialog', { name: 'Участник', exact: true });
  await card.locator('.participant-card__loading').waitFor({ state: 'hidden' });
  for (const action of ['Защита', 'Мут']) {
    const button = card.getByRole('button', { name: action, exact: true });
    await page.waitForFunction(
      (selector) => {
        const element = document.querySelector(selector);
        const id = element?.getAttribute('aria-describedby');
        return id && document.getElementById(id)?.textContent.trim() !== 'Загружаем';
      },
      action === 'Мут'
        ? '.participant-sheet__action--mute'
        : '.participant-sheet__action--immunity',
    );
    const description = await button.evaluate((element) => {
      const ids = element.getAttribute('aria-describedby')?.split(/\s+/u) ?? [];
      return ids.map((id) => document.getElementById(id)?.textContent).join(' ');
    });
    assert.equal(description, await button.locator('small').innerText());
    assert.match(description, action === 'Мут' ? /^До /u : /д/u);
  }
  assert.equal(await card.getByRole('img', { name: /^Защита:/u }).count(), 1);
  await page.screenshot({ path: join(output, `${name}-participant.png`) });
  observations.push({ name, module: 'moderation and participant accessibility', passed: true });
}

try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({
      env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
    });
    try {
      for (const [width, height, platform] of [
        [320, 568, 'ios'],
        [412, 915, 'android'],
        [667, 320, 'ios'],
      ]) {
        for (const colorScheme of ['light', 'dark']) {
          const name = `${engine.name()}-${width}x${height}-${colorScheme}`;
          const profile = { platform, safeTop: 20, safeBottom: platform === 'ios' ? 12 : 0 };
          const context = await browser.newContext({
            viewport: { width, height },
            isMobile: true,
            hasTouch: true,
            colorScheme,
            reducedMotion: 'reduce',
          });
          try {
            await context.route('**/*', (route) =>
              new URL(route.request().url()).origin === new URL(base).origin
                ? route.continue()
                : route.abort(),
            );
            await installMaxBridgeShimInitScript(context, profile, { colorScheme });
            await installNativeVisualModeInitScript(context);
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await checkSettings(page, profile, name);
            if (width === 320) await checkModeration(page, profile, name);
            assert.deepEqual(errors, []);
            console.log(`PASS ${name}: Major controls, 100%/200% text`);
          } finally {
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  writeFileSync(join(output, 'observations.json'), JSON.stringify(observations, null, 2));
  await stopChildProcess(server);
}
console.log(`Major control evidence: ${output}`);
