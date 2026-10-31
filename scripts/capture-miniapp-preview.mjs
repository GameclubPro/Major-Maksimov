import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  capturePhoneScreenshot,
  captureBrowserLaunchOptions,
  readCaptureGeometry,
  readPhoneMetrics,
  resolveCaptureDevice,
  setPhoneKeyboard,
  settleVisualFrame,
} from './miniapp-smartphone.mjs';
import {
  assertStopWordsEditorFlow,
  assertStopWordsSaveFailure,
  assertStopWordsLargeList,
} from './miniapp-stop-words-flow.mjs';
import previewDevicePresets from '../apps/miniapp/src/lib/preview-device-presets.json' with { type: 'json' };
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  isLocalMiniappBaseUrl,
  stopChildProcess,
  waitForMiniappUrl,
} from './miniapp-local-server.mjs';
import { assertMaxBridgeShim, installMaxBridgeShimInitScript } from './miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from './miniapp-native-visual-mode.mjs';
import {
  resolveMiniappScreenshotBaseUrl,
  resolveMiniappVisualNow,
  resolveScenarioRuntime,
} from './miniapp-visual-config.mjs';
import {
  MINIAPP_VISUAL_BOTTOM_SCENARIO_SOURCES,
  MINIAPP_VISUAL_PRESETS,
  MINIAPP_VISUAL_SCENARIOS,
  selectMiniappVisualScenarios,
} from './miniapp-visual-scenarios.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const OUTPUT_ROOT = path.join(ROOT_DIR, 'artifacts/miniapp-screenshots');
const runLabel = (process.env.MINIAPP_SCREENSHOT_LABEL ?? '').trim();
const timestamp =
  runLabel.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') ||
  new Date().toISOString().replace(/[:.]/g, '-');

const deviceProfiles = previewDevicePresets;
const visualPresetName = (process.env.MINIAPP_SCREENSHOT_PRESET ?? '').trim().toLowerCase();
const visualPreset = MINIAPP_VISUAL_PRESETS[visualPresetName];

const screenshotTarget = (
  process.env.MINIAPP_SCREENSHOT_TARGET ??
  visualPreset?.target ??
  'smartphone'
)
  .trim()
  .toLowerCase();
const colorScheme = (process.env.MINIAPP_SCREENSHOT_COLOR_SCHEME ?? 'light').trim().toLowerCase();
const strictLayout =
  parseOptionalEnvFlag('MINIAPP_SCREENSHOT_STRICT_LAYOUT') ?? visualPreset?.checks?.layout ?? false;
const strictContrast =
  parseOptionalEnvFlag('MINIAPP_SCREENSHOT_STRICT_CONTRAST') ??
  visualPreset?.checks?.contrast ??
  false;
const strictAccessibility =
  parseOptionalEnvFlag('MINIAPP_SCREENSHOT_STRICT_ACCESSIBILITY') ??
  visualPreset?.checks?.accessibility ??
  false;
const envMaxBridgeShim = parseOptionalEnvFlag('MINIAPP_SCREENSHOT_MAX_BRIDGE');
const nativeScreenshot = screenshotTarget === 'native' || screenshotTarget === 'smartphone';
const maxBridgeShimEnabled = envMaxBridgeShim ?? nativeScreenshot;
const continueOnFailure =
  parseOptionalEnvFlag('MINIAPP_SCREENSHOT_CONTINUE_ON_FAILURE') ??
  screenshotTarget === 'smartphone';
const phoneMetrics = await readPhoneMetrics(process.env.MINIAPP_PHONE_METRICS_PATH);
if (!['smartphone', 'native', 'device', 'screen', 'page'].includes(screenshotTarget)) {
  throw new Error('Screenshot target must be smartphone, native, device, screen or page.');
}
const reuseServer = parseEnvFlag('MINIAPP_SCREENSHOT_REUSE_SERVER');
const visualNow = resolveMiniappVisualNow();
const simulateKeyboard = parseEnvFlag('MINIAPP_SCREENSHOT_SIMULATE_KEYBOARD');
const keyboardOverlapPx = Number.parseInt(
  process.env.MINIAPP_SCREENSHOT_KEYBOARD_OVERLAP_PX ?? '320',
  10,
);
const normalizedKeyboardOverlapPx = Number.isFinite(keyboardOverlapPx)
  ? Math.max(160, Math.min(keyboardOverlapPx, 420))
  : 320;
const KEYBOARD_MIN_VISIBLE_HEIGHT_PX = 280;
const KEYBOARD_MIN_REDUCTION_PX = 80;
const PUBLISHER_COMPOSER_KEYBOARD_SCENARIO = 'publications-publisher-compose';
const PUBLISHER_BUTTONS_KEYBOARD_SCENARIO = 'publications-publisher-buttons-keyboard';
const PUBLISHER_AUTO_REPLY_KEYBOARD_SCENARIO = 'publisher-auto-replies-editor-keyboard';
const KEYBOARD_SCENARIO_PROFILES = Object.freeze({
  [PUBLISHER_COMPOSER_KEYBOARD_SCENARIO]: Object.freeze({
    flow: 'publisher-composer',
    focusSelector: '.publication-content-composer .max-rich-text-editor__surface',
    focusReport: 'publisher-rich-text-editor',
    actionBarSelector: '.publications-publish-bar',
    primarySelector: '.broadcast-publish-bar__primary',
    allowActionBelowViewport: false,
    expectPageKeyboardState: true,
    pickerSheetSelector: '.publication-target-picker__editor.is-sheet',
    focusFailure: 'Publisher keyboard scenario did not finish with focus in the rich-text editor.',
    focusLabel: 'Publisher rich-text editor',
    actionBarLabel: 'Publisher publish bar',
    primaryFailure: 'Publisher primary publish action does not contain its label at keyboard size.',
    pickerFailure: 'Publisher recipient picker remained open after keyboard focus-flow checks.',
  }),
  [PUBLISHER_BUTTONS_KEYBOARD_SCENARIO]: Object.freeze({
    flow: 'publisher-buttons',
    focusSelector: ".publication-buttons-sheet input[type='url']",
    focusReport: 'publisher-button-url',
    actionBarSelector: '.publication-buttons-sheet__footer',
    primarySelector: '.publication-buttons-sheet__done',
    expectPageKeyboardState: true,
    pickerSheetSelector: null,
    focusFailure: 'Publisher button URL did not keep keyboard focus.',
    focusLabel: 'Publisher button URL',
    actionBarLabel: 'Publisher button actions',
    primaryFailure: 'Publisher button Done action does not contain its label at keyboard size.',
    pickerFailure: null,
  }),
  [PUBLISHER_AUTO_REPLY_KEYBOARD_SCENARIO]: Object.freeze({
    flow: 'publisher-auto-reply-editor',
    focusSelector: '.publisher-auto-reply-editor [aria-label="Текст автоответа"]',
    focusReport: 'publisher-auto-reply-text-editor',
    actionBarSelector: '.publisher-auto-reply-editor__save-bar',
    primarySelector: 'button',
    pickerSheetSelector: null,
    focusFailure: 'Auto-reply keyboard scenario did not finish with focus in the text editor.',
    focusLabel: 'Auto-reply text editor',
    actionBarLabel: 'Auto-reply save bar',
    primaryFailure: 'Auto-reply primary save action does not contain its label at keyboard size.',
    pickerFailure: null,
  }),
});

function resolveKeyboardScenarioProfile(scenario) {
  return KEYBOARD_SCENARIO_PROFILES[scenario.name] ?? null;
}

function shouldSimulateKeyboardScenario(scenario) {
  return scenario.keyboard === false ? false : simulateKeyboard || scenario.keyboard === true;
}

function parseEnvFlag(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function parseOptionalEnvFlag(name) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  return null;
}

async function openSettingsSection(page, name, panelSelector) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.locator(panelSelector).first().waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
}

async function assertBirzhikModule(page) {
  const entry = page.getByRole('button', { name: 'Рекламная биржа', exact: true });
  await entry.waitFor({ state: 'visible' });
  await page.getByRole('searchbox', { name: 'Найти настройку', exact: true }).fill('Биржик');
  await page.waitForFunction(
    () => document.querySelectorAll('.settings-home-entry:not([hidden])').length === 1,
  );
  if (!(await entry.isVisible())) throw new Error('Settings search must find Birzhik.');
  await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
  await entry.scrollIntoViewIfNeeded();
  if (await entry.isDisabled()) throw new Error('Birzhik entry must be available to all users.');
  if (await page.getByRole('button', { name: 'Рекламная площадка', exact: true }).count())
    throw new Error('Birzhik must replace the duplicate advertising placeholder.');
  if (await page.evaluate(() => innerWidth <= 600))
    await assertSettingsOverviewNavigation(page, { name: 'birzhik' });
}

async function assertBirzhikProfileModule(page) {
  await assertBirzhikModule(page);
  await page.getByRole('button', { name: 'Рекламная биржа', exact: true }).click();
  await page.locator('.marketplace-entry').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).waitFor();
  if (await page.locator('.marketplace-entry').getByRole('checkbox').count())
    throw new Error('Marketplace overview must keep button controls inside their own screen.');
}

async function assertHintDismissal(page, panel, trigger) {
  const hintId = await trigger.getAttribute('aria-controls');
  if (!hintId) throw new Error('The explanation button does not identify its text.');
  const hint = page.locator(`[id=${JSON.stringify(hintId)}]`);
  const inputs = panel.locator('input[type="checkbox"]');
  const initialValues = await inputs.evaluateAll((elements) =>
    elements.map((input) => input.checked),
  );
  const openHint = async () => {
    await trigger.click();
    await hint.waitFor({ state: 'visible' });
  };
  const assertPanelStillOpen = async () => {
    await hint.waitFor({ state: 'hidden' });
    if (!(await panel.isVisible())) {
      throw new Error('Dismissing an explanation also closed its settings sheet.');
    }
    const values = await inputs.evaluateAll((elements) => elements.map((input) => input.checked));
    if (JSON.stringify(values) !== JSON.stringify(initialValues)) {
      throw new Error('Opening or dismissing an explanation changed a setting.');
    }
  };

  await openHint();
  await page.keyboard.press('Escape');
  await assertPanelStillOpen();
  await openHint();
  await panel.locator('.settings-drilldown__title').click();
  await assertPanelStillOpen();
  if (await page.evaluate(() => typeof window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__ === 'function')) {
    await openHint();
    await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
    await assertPanelStillOpen();
  }
  await openHint();
}

async function assertModerationScopeBusy(page, choice) {
  const sheet = page.locator('.action-confirm-sheet');
  const initialFeedCount = await page.locator('.event-feed-item').count();
  await sheet.getByRole('button', { name: choice, exact: true }).click();
  await sheet.getByRole('button', { name: 'Применяем...', exact: true }).waitFor();
  const busy = await sheet.evaluate((element) => {
    const buttons = [...element.querySelectorAll('button')];
    const state = {
      allDisabled: buttons.every((button) => button.disabled),
      busyLabels: buttons.filter((button) => button.textContent?.trim() === 'Применяем...').length,
    };
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__?.();
    buttons.forEach((button) => button.click());
    return state;
  });
  if (!busy.allDisabled || busy.busyLabels !== 1 || !(await sheet.isVisible())) {
    throw new Error('A pending moderation action can be dismissed or submitted again.');
  }
  await sheet.waitFor({ state: 'hidden', timeout: 10_000 });
  if (initialFeedCount > 0) {
    await waitForModerationEventsReady(page);
    await page.waitForFunction(
      (count) => document.querySelectorAll('.event-feed-item').length === count + 1,
      initialFeedCount,
    );
  }
}

async function waitForModerationEventsReady(page) {
  const historyMode = page.getByRole('radio', { name: 'Журнал', exact: true });
  await historyMode.waitFor({ state: 'visible' });
  await historyMode.click();
  await page
    .locator('.events-dashboard__body--moderation:not(.events-dashboard__body--loading)')
    .waitFor({ state: 'visible' });
  await page
    .locator('.event-feed-item, .events-inline-state')
    .first()
    .waitFor({ state: 'visible' });
}

async function waitForActivityEventsReady(page) {
  await page
    .locator('.events-dashboard__activity:not(.events-dashboard__activity--loading)')
    .waitFor({ state: 'visible' });
}

async function waitForChannelStatsReady(page) {
  await page
    .locator('.channel-insights__summary[aria-label="Сводка по каналу"]')
    .waitFor({ state: 'visible' });
}

async function waitForChannelEventsReady(page) {
  await page.locator('.channel-events-section').waitFor({ state: 'visible' });
  await page
    .locator('.channel-events-section__metrics[aria-busy="false"]')
    .waitFor({ state: 'visible' });
  await page
    .locator(
      '.channel-events-section .membership-feed__card, .channel-events-section .membership-feed__status',
    )
    .first()
    .waitFor({ state: 'visible' });
}

async function openPreviewGiveawayEditor(page) {
  const giveaway = page.locator('.managed-giveaway');
  await giveaway.waitFor({ state: 'visible' });
  const editButton = giveaway.getByRole('button', {
    name: /(?:Редактировать|Продолжить сценарий|Продолжить)/u,
  });
  await editButton.first().waitFor({ state: 'visible' });
  await editButton.first().click();
  await page.locator('.managed-giveaway--step-basics').waitFor({ state: 'visible' });
}

async function openPreviewPollEditor(page, { openSection = false } = {}) {
  if (openSection) {
    await openSettingsSection(page, 'Опросы', '.managed-poll-workspace');
  } else {
    await page.locator('.managed-poll-workspace').waitFor({ state: 'visible' });
  }

  const workspace = page.locator('.managed-poll-workspace');
  await workspace.getByRole('button', { name: 'Новый', exact: true }).click();
  await page.locator('.managed-poll-editor').waitFor({ state: 'visible' });
}

async function openPublisherAutoReplyCreateSheet(page) {
  await page.getByRole('button', { name: 'Добавить автоответ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый автоответ' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Создать здесь', exact: true }).waitFor({
    state: 'visible',
  });
  return dialog;
}

async function openPublisherAutoReplyEditor(page) {
  const dialog = await openPublisherAutoReplyCreateSheet(page);
  await dialog.getByRole('button', { name: 'Создать здесь', exact: true }).click();
  const editor = page.locator('.publisher-auto-reply-editor');
  await editor.waitFor({ state: 'visible' });
  const phraseInput = editor.getByRole('textbox', { name: 'Фразы', exact: true });
  await phraseInput.fill('Каталог');
  await phraseInput.press('Enter');
  await editor
    .getByRole('textbox', { name: 'Текст автоответа', exact: true })
    .fill('Каталог готов. Выберите нужный раздел.');
  await page.waitForTimeout(250);
  return editor;
}

async function openPublisherButtonsSheet(page) {
  const editor = page.locator('.publications-editor');
  await editor.waitFor({ state: 'visible' });
  const composer = editor.locator('.publication-content-composer');
  const trigger = composer.getByRole('button', { name: /кнопк/iu }).first();
  await trigger.waitFor({ state: 'visible' });
  await trigger.getByText('Кнопка', { exact: true }).waitFor({ state: 'visible' });
  await trigger.click();

  const sheet = page.locator('.publication-buttons-sheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByRole('dialog', { name: 'Кнопки', exact: true }).waitFor({ state: 'visible' });
  return { sheet, trigger };
}

async function openPublisherAutoReplyButtonsSheet(page) {
  const editor = await openPublisherAutoReplyEditor(page);
  const trigger = editor.getByRole('button', { name: 'Добавить кнопки', exact: true });
  await trigger.waitFor({ state: 'visible' });
  await trigger.click();

  const sheet = page.locator('.publication-buttons-sheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByRole('dialog', { name: 'Кнопки', exact: true }).waitFor({ state: 'visible' });
  await sheet.getByLabel('Название', { exact: true }).first().fill('Открыть каталог');
  await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/catalog');
  return sheet;
}

async function assertPublisherButtonsSheetIsDirect(sheet) {
  if ((await sheet.getByRole('checkbox').count()) !== 0) {
    throw new Error('Publisher buttons sheet restored the obsolete enable toggle.');
  }
  if ((await sheet.getByText(/^(?:Включены|Выключены)$/u).count()) !== 0) {
    throw new Error('Publisher buttons sheet restored obsolete enable-state copy.');
  }
  await sheet.getByLabel('Название', { exact: true }).first().waitFor({ state: 'visible' });
  await sheet.getByLabel('Ссылка', { exact: true }).first().waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: 'Ещё', exact: true }).waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: 'Готово', exact: true }).waitFor({ state: 'visible' });
  const crowdedField = await sheet
    .locator('.publication-buttons-sheet__field')
    .evaluateAll((labels) =>
      labels
        .map((label, index) => {
          const caption = label.querySelector('span');
          const input = label.querySelector('input');
          if (!(caption instanceof HTMLElement) || !(input instanceof HTMLInputElement)) {
            return null;
          }
          return {
            index,
            gap: input.getBoundingClientRect().top - caption.getBoundingClientRect().bottom,
          };
        })
        .find((field) => field && field.gap < 4),
    );
  if (crowdedField) {
    throw new Error(
      `Publisher button field ${crowdedField.index + 1} label touches its input ` +
        `(gap=${crowdedField.gap.toFixed(1)}px).`,
    );
  }
}

async function assertPublisherButtonsSheetHasDefaultButton(sheet, stage = 'open') {
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();
  const values = { name: await name.inputValue(), url: await url.inputValue() };
  if (values.name !== 'Открыть' || values.url !== '') {
    throw new Error(
      `Publisher buttons sheet did not restore its default first button at ${stage}: ` +
        JSON.stringify(values),
    );
  }
}

async function assertPublisherButtonTriggerIsEmpty(page, trigger) {
  await trigger.getByText('Кнопка', { exact: true }).waitFor({ state: 'visible' });
  if (
    (await page
      .locator('.publication-content-composer .broadcast-message-card__button')
      .count()) !== 0
  ) {
    throw new Error('Discarded publisher button leaked into the publication preview.');
  }
}

async function waitForPublisherButtonsSheetClosed(page, sheet) {
  await sheet.waitFor({ state: 'detached' });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
}

async function publishPreviewPoll(page) {
  const editor = page.locator('.managed-poll-editor');
  const question = 'Когда проведём следующую встречу?';
  await editor.getByRole('textbox', { name: 'Вопрос опроса' }).fill(question);
  await editor.getByRole('textbox', { name: 'Вариант ответа 1' }).fill('В пятницу');
  await editor.getByRole('textbox', { name: 'Вариант ответа 2' }).fill('В субботу');
  await editor.getByRole('button', { name: 'Опубликовать', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Опубликовать опрос?' });
  await confirm.waitFor({ state: 'visible' });
  await confirm.getByRole('button', { name: 'Опубликовать', exact: true }).click();

  const publishedToast = page.locator('.toast').filter({ hasText: 'Опрос опубликован' });
  await publishedToast.waitFor({ state: 'visible' });
  await page
    .locator('.managed-poll-item')
    .filter({ hasText: question })
    .waitFor({ state: 'visible' });
}

async function savePreviewPollDraft(page) {
  const editor = page.locator('.managed-poll-editor');
  const question = 'Когда проведём следующую встречу?';
  await editor.getByRole('textbox', { name: 'Вопрос опроса' }).fill(question);
  await editor.getByRole('textbox', { name: 'Вариант ответа 1' }).fill('В пятницу');
  await editor.getByRole('textbox', { name: 'Вариант ответа 2' }).fill('В субботу');
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();

  const savedToast = page.locator('.toast').filter({ hasText: 'Черновик сохранён' });
  await savedToast.waitFor({ state: 'visible' });
  await savedToast.getByRole('button', { name: 'Закрыть уведомление' }).click();
  await savedToast.waitFor({ state: 'detached' });
  await editor.getByRole('button', { name: 'Назад к списку', exact: true }).click();

  const draft = page.locator('.managed-poll-item').filter({ hasText: question });
  await draft.locator('.managed-poll-item__status.is-draft').waitFor({ state: 'visible' });
}

async function assertBotMessagePlaceholderRoundTrip(page) {
  const expectedKeys = ['user', 'message_status', 'reason'];
  const editor = page.locator('.max-rich-text-editor__surface');
  const readEditorState = () =>
    editor.evaluate((element) => ({
      keys: Array.from(element.querySelectorAll('[data-max-placeholder]')).map(
        (token) => token.getAttribute('data-max-placeholder') ?? '',
      ),
      text: element.textContent ?? '',
    }));

  const initialState = await readEditorState();
  if (JSON.stringify(initialState.keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Bot message placeholders are incomplete: ${JSON.stringify(initialState)}.`);
  }

  await editor.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.insertText(' Проверка');
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.locator('.bot-message-editor-sheet__panel').waitFor({ state: 'detached' });

  await page
    .getByRole('button', { name: 'Редактировать текст сообщения о ссылках', exact: true })
    .click();
  await page.locator('.bot-message-editor-sheet__panel').waitFor({ state: 'visible' });
  const reopenedState = await readEditorState();
  if (
    JSON.stringify(reopenedState.keys) !== JSON.stringify(expectedKeys) ||
    !reopenedState.text.includes('Проверка')
  ) {
    throw new Error(`Bot message placeholder round-trip failed: ${JSON.stringify(reopenedState)}.`);
  }

  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await page.getByRole('button', { name: 'Сбросить', exact: true }).waitFor({ state: 'detached' });
  const resetState = await readEditorState();
  if (
    JSON.stringify(resetState.keys) !== JSON.stringify(expectedKeys) ||
    resetState.text.includes('Проверка')
  ) {
    throw new Error(`Bot message reset lost placeholders: ${JSON.stringify(resetState)}.`);
  }
}

async function setScrollPosition(scrollBody, top, label) {
  await scrollBody.waitFor({ state: 'visible' });
  const metrics = await scrollBody.evaluate((element, requestedTop) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextTop = requestedTop === 'bottom' ? maxScrollTop : Math.min(requestedTop, maxScrollTop);
    element.scrollTo({ top: nextTop, behavior: 'instant' });
    return {
      clientHeight: element.clientHeight,
      maxScrollTop,
      requestedTop: nextTop,
    };
  }, top);
  await scrollBody.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const scrollTop = await scrollBody.evaluate((element) => element.scrollTop);
  if (Math.abs(scrollTop - metrics.requestedTop) > 1) {
    throw new Error(
      `${label} did not reach scroll position ${metrics.requestedTop} (actual ${scrollTop}).`,
    );
  }
  return { ...metrics, scrollTop };
}

async function setSettingsDrilldownScroll(page, top) {
  const scrollBody = page.locator('.settings-drilldown:visible .settings-drilldown__body').first();
  return setScrollPosition(scrollBody, top, 'Settings drilldown');
}

async function scrollSettingsDrilldownToBottom(page) {
  await setSettingsDrilldownScroll(page, 'bottom');
  const nestedScrollSelectors = [
    '.bot-message-editor-sheet:visible .bot-message-editor-sheet__body',
    '.broadcast-audience-sheet:visible .broadcast-audience-sheet__scroll',
    '.managed-giveaway-modal:visible .managed-giveaway-modal__sheet',
  ];
  for (const selector of nestedScrollSelectors) {
    const scrollBody = page.locator(selector).first();
    if ((await scrollBody.count()) > 0) {
      await setScrollPosition(scrollBody, 'bottom', selector);
    }
  }
}

async function scrollCaptureList(page, list) {
  if (page.context().browser()?.browserType().name() === 'webkit') {
    await list.evaluate((element) => {
      let scroller = element;
      while (
        scroller.parentElement &&
        (scroller.scrollHeight <= scroller.clientHeight ||
          !/(auto|scroll)/u.test(getComputedStyle(scroller).overflowY))
      ) {
        scroller = scroller.parentElement;
      }
      scroller.scrollBy({ top: 1_200, behavior: 'instant' });
    });
  } else {
    await page.mouse.wheel(0, 1_200);
  }
}

async function scrollPaginatedListToStatus(page, options) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const status = page.locator(options.statusSelector).last();
  await options.list.hover();

  let statusText = (await status.textContent())?.trim() ?? '';
  while (statusText !== options.expectedStatus && Date.now() < deadline) {
    const previousStatus = statusText;
    await scrollCaptureList(page, options.list);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }

    await page
      .waitForFunction(
        ({ loadMoreSelector, statusSelector, previous }) => {
          const statuses = Array.from(document.querySelectorAll(statusSelector));
          const current = statuses.at(-1)?.textContent?.trim() ?? '';
          const loadMore = document.querySelector(loadMoreSelector);
          return (
            current !== previous || (loadMore instanceof HTMLButtonElement && !loadMore.disabled)
          );
        },
        {
          loadMoreSelector: options.loadMoreSelector,
          statusSelector: options.statusSelector,
          previous: previousStatus,
        },
        { timeout: Math.min(2_000, remainingMs) },
      )
      .catch(() => undefined);
    statusText = (await status.textContent())?.trim() ?? '';
  }

  if (statusText !== options.expectedStatus) {
    throw new Error(
      `${options.label} stopped before the final page: ${statusText || 'missing status'}`,
    );
  }
}

const scenarioBehaviors = [
  {
    name: 'home',
  },
  {
    name: 'home-channels',
  },
  {
    name: 'home-filter',
    beforeShot: async (page) => {
      const trigger = page.locator('.favorite-filter__trigger');
      const panel = page.locator('.home-filter__panel');
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
      await page.locator('.favorite-picker__backdrop').click({ position: { x: 2, y: 2 } });
      await panel.waitFor({ state: 'detached' });
      await page.waitForTimeout(50);
      if (!(await trigger.evaluate((element) => element === document.activeElement))) {
        throw new Error('Home filter sheet did not restore focus after outside click.');
      }
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      await page.waitForTimeout(50);
      if (!(await trigger.evaluate((element) => element === document.activeElement))) {
        throw new Error('Home filter sheet did not restore focus after Escape.');
      }
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
    },
  },
  {
    name: 'home-filter-active',
    beforeShot: async (page) => {
      const trigger = page.locator('.favorite-filter__trigger');
      const panel = page.locator('.home-filter__panel');
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
      await panel.locator('.home-filter__item.is-important').click();
      await panel.waitFor({ state: 'detached' });
      await page.waitForTimeout(50);
      if ((await trigger.getAttribute('aria-label')) !== 'Фильтр: Важные') {
        throw new Error('Home filter trigger did not expose the selected category.');
      }
      if (!(await trigger.evaluate((element) => element === document.activeElement))) {
        throw new Error('Home filter trigger did not regain focus after category selection.');
      }
      if ((await page.locator('.chat-card').count()) !== 1) {
        throw new Error('Home category filter did not reduce the preview list to one entity.');
      }
    },
  },
  {
    name: 'home-category-edit',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: 'Фильтр категорий' }).click();
      await page.getByRole('button', { name: 'Распределить по категориям' }).click();
      await page.getByRole('button', { name: 'Готово' }).waitFor({ state: 'visible' });
      if ((await page.locator('.chat-card__action--statistics').count()) !== 0) {
        throw new Error('Home category edit mode still exposes statistics actions.');
      }
    },
  },
  {
    name: 'home-favorite-picker',
    beforeShot: async (page) => {
      await page.locator('.chat-card__action--favorite').first().click();
      await page.locator('.favorite-picker__panel').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'home-favorite-categories',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: 'Фильтр категорий' }).click();
      await page.getByRole('button', { name: 'Настроить названия' }).click();
      await page.locator('.favorite-label-editor__panel').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities',
    beforeShot: async (page) => {
      await page.locator('.publisher-entities-page__list').waitFor({ state: 'visible' });
      await page.locator('.publisher-entity-row').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities-channels',
    beforeShot: async (page) => {
      await page.getByRole('list', { name: 'Каналы Публика' }).waitFor({ state: 'visible' });
      await page.locator('.publisher-entity-row').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities-stale',
    beforeShot: async (page) => {
      await page.getByText('Проверяем права Публика', { exact: true }).waitFor();
    },
  },
  {
    name: 'publisher-entities-channel-only',
    beforeShot: async (page) => {
      await page.waitForURL((url) => url.searchParams.get('view') === 'channel');
      await page.getByRole('list', { name: 'Каналы Публика' }).waitFor({ state: 'visible' });
      await page.locator('.publisher-entity-row').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entity-modules',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /разделы/iu })
        .first()
        .click();
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Посты', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-modules',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /разделы/iu })
        .first()
        .click();
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Предложения', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entity-modules-vk',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /разделы/iu })
        .first()
        .click();
      await page.getByRole('button', { name: /^(?:Открыть посты|Посты) из VK$/u }).click();
      await page.locator('.vk-parsing-workspace').waitFor({
        state: 'visible',
      });
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'publisher-channel-modules-vk-editor',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /разделы/iu })
        .first()
        .click();
      await page.getByRole('button', { name: /^(?:Открыть посты|Посты) из VK$/u }).click();
      const card = page.locator('.vk-parsing-workspace');
      await card.waitFor({ state: 'visible' });
      await card.getByRole('button', { name: 'Редактировать', exact: true }).first().click();
      const editor = page.locator('.vk-editor-dialog');
      await editor.locator('.vk-parsing-editor__composer').waitFor({ state: 'visible' });
      await editor.getByRole('button', { name: 'Форматирование', exact: true }).click();
      await editor.locator('.vk-parsing-editor__format-tools').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'publisher-channel-vk-bot-review',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /разделы/iu })
        .first()
        .click();
      await page.getByRole('button', { name: /^(?:Открыть посты|Посты) из VK$/u }).click();
      await page.getByRole('tab', { name: 'Автоматизация', exact: true }).click();
      const panel = page.locator('.vk-bot-review-panel');
      await panel.getByRole('button', { name: 'Получать посты мне', exact: true }).click();
      await panel.getByText('Получатель: вы', { exact: true }).waitFor();
      await page.getByRole('tab', { name: /Группы/u }).click();
      const source = page.locator('.vk-source-card').first();
      await source.getByRole('button', { name: /Настройки группы/u }).click();
      await page
        .getByRole('combobox', { name: 'Способ доставки постов группы' })
        .selectOption('BOT_REVIEW');
      await page.getByText('Круглосуточно', { exact: true }).waitFor();
      await page.waitForTimeout(350);
    },
  },
  ...['publication', 'time', 'safety', 'preset', 'queue'].map((section) => ({
    name: `publisher-entity-modules-vk-scheduler-${section}`,
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /разделы/iu })
        .first()
        .click();
      await page.getByRole('button', { name: /^(?:Открыть посты|Посты) из VK$/u }).click();
      const panel = page.locator('.vk-autopost-panel');
      if (section === 'queue') {
        await page.getByRole('button', { name: 'Очередь', exact: true }).click();
        const queue = page.locator('.vk-queue-timeline');
        await queue.locator('input[type="date"]').first().fill('');
        await queue
          .getByText('Нужны будущая дата и время', { exact: true })
          .first()
          .waitFor({ state: 'visible' });
        await queue.evaluate((element) => element.scrollIntoView({ block: 'start' }));
      } else if (section === 'preset') {
        await page.getByRole('tab', { name: /Группы/u }).click();
        await page.locator('.vk-source-card').first().getByRole('checkbox').check();
        await page
          .getByRole('combobox', { name: 'Применить настройки к выбранным группам' })
          .selectOption('CLEAN');
        await page.getByRole('dialog', { name: 'Изменить настройки групп?' }).waitFor();
      } else {
        await page.getByRole('tab', { name: 'Автоматизация', exact: true }).click();
        await panel.waitFor({ state: 'visible' });
        await panel.locator('summary').click();
        if (section === 'time' || section === 'safety') {
          await panel
            .getByRole('button', { name: section === 'time' ? 'Время' : 'Фильтры', exact: true })
            .click();
        }
        await panel.evaluate((element) => element.scrollIntoView({ block: 'start' }));
      }
      await page.waitForTimeout(150);
    },
  })),
  {
    name: 'publisher-entities-empty',
    beforeShot: async (page) => {
      await page.locator('.publisher-entities-page__state').waitFor({ state: 'visible' });
      await page
        .getByRole('button', { name: 'Открыть диалог Публика', exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entity-modules-blocked',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page
        .getByRole('button', { name: 'Проверить', exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entity-modules-stale',
    beforeShot: async (page) => {
      await page.getByText('Проверяем права Публика', { exact: true }).waitFor();
      await page.getByText(/Права Публика перепроверяются автоматически/u).waitFor();
      await page.getByRole('link', { name: /^(?:Посты|Создать пост для .+)$/u }).waitFor();
    },
  },
  {
    name: 'publisher-entities-error',
    beforeShot: async (page) => {
      await page.locator('.publisher-entities-page__state.has-error').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities-large',
    beforeShot: async (page) => {
      const list = page.locator('.publisher-entities-page__list');
      await list.waitFor({ state: 'visible' });
      await page.waitForFunction(
        () =>
          document.querySelector('.publisher-entities-page__filter-row > span')?.textContent ===
          '30 из 200',
      );
      await scrollPaginatedListToStatus(page, {
        list,
        statusSelector: '.publisher-entities-page__filter-row > span',
        expectedStatus: '200 получателей',
        loadMoreSelector: '.publisher-entities-page__load-more',
        label: 'Publisher catalog scroll',
      });
      await page.locator('.publisher-entities-page__list.is-virtual').waitFor({ state: 'visible' });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await scrollCaptureList(page, list);
        await page.waitForTimeout(50);
      }
      await page.waitForFunction(() => {
        const list = document.querySelector('.publisher-entities-page__list.is-virtual');
        const lastRow = list?.querySelector('.publisher-entity-row[aria-posinset="200"]');
        const bottomNav = document.querySelector('.bottom-nav');
        if (
          !(list instanceof HTMLElement) ||
          !(lastRow instanceof HTMLElement) ||
          !(bottomNav instanceof HTMLElement)
        ) {
          return false;
        }
        const listRect = list.getBoundingClientRect();
        const rowRect = lastRow.getBoundingClientRect();
        const navRect = bottomNav.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          rowRect.left + rowRect.width / 2,
          rowRect.top + rowRect.height / 2,
        );
        return (
          list.scrollTop > 0 &&
          rowRect.top >= listRect.top &&
          rowRect.bottom <= Math.min(listRect.bottom, navRect.top) &&
          hitTarget !== null &&
          lastRow.contains(hitTarget)
        );
      });
      await page.waitForTimeout(120);
    },
  },
  {
    name: 'publisher-auto-replies-cold',
    beforeShot: async (page) => {
      await page.locator('.publisher-auto-replies-page').waitFor({ state: 'visible' });
      await page.locator('.publisher-auto-reply-row').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'publisher-auto-replies-create-sheet',
    beforeShot: async (page) => {
      await openPublisherAutoReplyCreateSheet(page);
      await page.waitForTimeout(150);
    },
  },
  {
    name: 'publisher-auto-replies-editor',
    beforeShot: async (page) => {
      await openPublisherAutoReplyEditor(page);
    },
  },
  {
    name: 'publisher-auto-replies-editor-buttons',
    beforeShot: async (page) => {
      await openPublisherAutoReplyButtonsSheet(page);
      await page.waitForTimeout(120);
    },
  },
  {
    name: 'publisher-auto-replies-editor-bottom',
    beforeShot: async (page) => {
      const editor = await openPublisherAutoReplyEditor(page);
      const settings = editor.locator('.publisher-auto-reply-editor__section').last();
      await settings.waitFor({ state: 'visible' });
      await settings.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      await page.waitForTimeout(120);
      await assertLocatorWithinViewport(settings, 'Auto-reply settings section');
      await assertLocatorWithinViewport(
        editor.locator('.publisher-auto-reply-editor__save-bar button'),
        'Auto-reply save action',
      );
    },
  },
  {
    name: PUBLISHER_AUTO_REPLY_KEYBOARD_SCENARIO,
    beforeShot: async (page) => {
      await openPublisherAutoReplyEditor(page);
    },
  },
  {
    name: 'publications',
    beforeShot: async (page) => {
      await page.locator('.publik-handoff').waitFor({ state: 'visible' });
      if ((await page.locator('.publications-page').count()) !== 0) {
        throw new Error('Publisher controls leaked into Major.');
      }
    },
  },
  {
    name: 'publications-publisher',
    beforeShot: async (page) => {
      await page.locator('.publication-publisher-status').waitFor({ state: 'visible' });
      await page.getByText(/2 готовы/u).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-create',
    beforeShot: async (page) => {
      const dialog = page.getByRole('dialog', { name: 'Новый пост' });
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'Написать' }).waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'Переслать' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-schedules',
    beforeShot: async (page) => {
      await page.locator('.publications-tabs button.is-active').getByText('Расписания').waitFor();
    },
  },
  {
    name: 'publications-publisher-history',
    beforeShot: async (page) => {
      await page.locator('.publications-tabs button.is-active').getByText('История').waitFor();
    },
  },
  {
    name: 'publications-publisher-empty',
    beforeShot: async (page) => {
      await page
        .getByText('Нет подключённых получателей', { exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-large',
    beforeShot: async (page) => {
      await page.locator('.publication-publisher-status').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-error',
    beforeShot: async (page) => {
      await page
        .getByText('Получатели временно недоступны', { exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      const summary = page.locator('.publication-target-picker__summary');
      const sheet = page.locator('.publication-target-picker__editor.is-sheet');
      await summary.click();
      await sheet.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
      if (!(await summary.evaluate((element) => element === document.activeElement))) {
        throw new Error('Publisher recipient summary did not regain focus after Escape.');
      }
      await summary.click();
      await page.locator('.publication-target-picker__list').waitFor({ state: 'visible' });
      if (simulateKeyboard) {
        await page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'detached' });
      }
    },
  },
  {
    name: 'publications-publisher-post-actions',
    beforeShot: async (page) => {
      const section = page.locator('.publication-post-publish');
      await section.waitFor({ state: 'visible' });
      await section.getByRole('button', { name: /После публикации/u }).click();
      await section.getByRole('switch', { name: 'Закрепить пост', exact: true }).check();
      const notify = section.getByRole('switch', { name: 'С уведомлением', exact: true });
      if (!(await notify.isChecked())) throw new Error('New pins must notify by default.');
      await notify.uncheck();
      await section.getByRole('switch', { name: 'Закрепить пост', exact: true }).uncheck();
      await section.getByRole('switch', { name: 'Закрепить пост', exact: true }).check();
      if (await notify.isChecked()) throw new Error('Pin toggle lost the silent preference.');
      await notify.check();
      const autoDelete = section.getByRole('switch', {
        name: 'Удалить автоматически',
        exact: true,
      });
      await autoDelete.check();
      await section.getByLabel('Срок автоудаления', { exact: true }).selectOption('custom');
      await section.getByLabel('Единица срока удаления', { exact: true }).selectOption('1');
      const duration = section.getByRole('spinbutton', { name: 'Период до удаления', exact: true });
      await duration.fill('90');
      await duration.blur();
      await autoDelete.uncheck();
      await autoDelete.check();
      if ((await duration.inputValue()) !== '90')
        throw new Error('Auto-delete toggle lost its custom delay.');
      await section.scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'publications-publisher-cloud-drafts',
    beforeShot: async (page) => {
      const editor = page.locator('.publication-content-composer .max-rich-text-editor__surface');
      await editor.fill('Черновик для осеннего анонса');
      await page.getByText('Сохранено', { exact: true }).waitFor();
      if (nativeScreenshot) await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      else
        await page
          .locator('.publications-editor-header')
          .getByRole('button', { name: 'Назад', exact: true })
          .click();
      await page.getByRole('button', { name: 'Черновики', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Черновики', exact: true });
      await sheet.getByText('Черновик для осеннего анонса', { exact: true }).waitFor();
      await sheet
        .locator('.publication-drafts-sheet__row')
        .filter({ hasText: 'Черновик для осеннего анонса' })
        .locator('.publication-drafts-sheet__open')
        .click();
      await editor.waitFor();
      if (!(await editor.textContent())?.includes('Черновик для осеннего анонса'))
        throw new Error('Cloud draft text was not restored.');
      if (nativeScreenshot) await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      else
        await page
          .locator('.publications-editor-header')
          .getByRole('button', { name: 'Назад', exact: true })
          .click();
      await page.getByRole('button', { name: 'Черновики', exact: true }).click();
      await sheet.getByText('Черновик для осеннего анонса', { exact: true }).waitFor();
    },
  },
  {
    name: 'publications-publisher-full-review',
    beforeShot: async (page) => {
      await page.locator('.publication-target-picker__summary').click();
      await page
        .locator('.publication-target-row')
        .filter({ hasText: 'Новости Южного' })
        .first()
        .click();
      await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
      await page
        .locator('.publication-content-composer input[type="file"][accept="image/*"]')
        .first()
        .setInputFiles({
          name: 'afisha.png',
          mimeType: 'image/png',
          buffer: await readFile(path.join(ROOT_DIR, 'apps/miniapp/public/apple-touch-icon.png')),
        });
      await page
        .locator('.publication-content-composer .max-rich-text-editor__surface')
        .fill(
          Array.from(
            { length: 8 },
            (_, index) => `Абзац ${index + 1}. Осенний анонс для подписчиков.`,
          ).join('\n\n'),
        );
      await page.getByText('Сохранено', { exact: true }).waitFor();
      await page
        .locator('.publications-publish-bar')
        .getByRole('button', { name: 'Проверить пост', exact: true })
        .click();
      const sheet = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
      await sheet.waitFor();
      await sheet.locator('.publication-preview__media img').waitFor();
      if (!(await sheet.locator('.publication-preview__text').textContent())?.includes('Абзац 8'))
        throw new Error('Publication review truncated the post.');
      if (!(await sheet.locator('img').evaluate((image) => image.naturalWidth > 0)))
        throw new Error('Publication preview image did not load.');
    },
  },
  {
    name: 'publications-publisher-buttons-empty',
    beforeShot: async (page) => {
      const { sheet, trigger } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'initial open');
      await sheet.getByLabel('Название', { exact: true }).first().fill('Не сохранять');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/discard');
      await page.keyboard.press('Escape');
      await page
        .getByRole('alertdialog', { name: 'Закрыть без сохранения?' })
        .getByRole('button', { name: 'Не сохранять', exact: true })
        .click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await assertPublisherButtonTriggerIsEmpty(page, trigger);

      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'reopen after Escape');
      await sheet.getByLabel('Название', { exact: true }).first().fill('Тоже не сохранять');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/discard-2');
      await sheet
        .locator('.publication-buttons-sheet__backdrop')
        .click({ position: { x: 2, y: 2 } });
      await page
        .getByRole('alertdialog', { name: 'Закрыть без сохранения?' })
        .getByRole('button', { name: 'Не сохранять', exact: true })
        .click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await assertPublisherButtonTriggerIsEmpty(page, trigger);

      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'reopen after backdrop');
    },
  },
  {
    name: 'publications-publisher-delivery-actions',
    beforeShot: async (page) => {
      await page
        .locator('[data-publication-id="publication-completed"] .publication-feed-card__surface')
        .click();
      await page.getByRole('button', { name: /Изменить время удаления:/u }).click();
      let dialog = page.getByRole('dialog', { name: 'Изменить время удаления?' });
      await dialog.getByLabel('Новый срок удаления').selectOption('60');
      await dialog.getByRole('button', { name: 'Изменить время удаления', exact: true }).click();
      await page.getByRole('button', { name: /Отменить автоудаление:/u }).click();
      dialog = page.getByRole('dialog', { name: 'Отменить автоудаление?' });
      await dialog.getByRole('button', { name: 'Отменить автоудаление', exact: true }).click();
      await page.getByText('Автоудаление отменено', { exact: true }).first().waitFor();
      await page.locator('.publication-deliveries').scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'publications-publisher-compose-recurrence',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Расписание', exact: true }).click();
      await page.getByRole('button', { name: 'Повтор', exact: true }).click();
      await page.getByRole('button', { name: 'По неделям', exact: true }).click();
      const interval = page.getByRole('spinbutton', { name: 'Интервал повтора' });
      await interval.fill('');
      await interval.pressSequentially('12');
      await interval.blur();
      if ((await interval.inputValue()) !== '12')
        throw new Error('Recurrence interval lost multi-digit input.');
      await page.getByRole('button', { name: 'Добавить время', exact: true }).click();
      await page.getByRole('button', { name: 'Добавить время', exact: true }).click();
      await page
        .locator('.publication-editor-section--timing')
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      const recovery = page.locator('.publication-late-policy-options');
      await recovery.locator('summary').click();
      await recovery.getByLabel('Действие при задержке', { exact: true }).selectOption('strict');
      await recovery
        .getByLabel('Пост актуален после назначенного времени', { exact: true })
        .selectOption('30');
      if (
        (await recovery
          .getByLabel('Пост актуален после назначенного времени', { exact: true })
          .inputValue()) !== '30'
      )
        throw new Error('Authored publication delay did not persist in the editor.');
      await recovery.locator('summary').click();
      await page.waitForTimeout(150);
    },
  },
  {
    name: 'publications-publisher-buttons-filled',
    beforeShot: async (page) => {
      const { sheet, trigger } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      await sheet.getByLabel('Название', { exact: true }).first().fill('Подробнее');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/publik');
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await trigger.getByText('Кнопки · 1', { exact: true }).waitFor({ state: 'visible' });
      const previewButton = page
        .locator('.publication-content-composer .broadcast-message-card__button')
        .filter({ hasText: 'Подробнее' });
      await previewButton.waitFor({ state: 'visible' });
      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      if (
        (await sheet.getByLabel('Название', { exact: true }).first().inputValue()) !==
          'Подробнее' ||
        (await sheet.getByLabel('Ссылка', { exact: true }).first().inputValue()) !==
          'https://max.ru/publik'
      ) {
        throw new Error('Publisher button values did not survive Done and reopening.');
      }
      await sheet.getByRole('button', { name: 'Убрать кнопку 1', exact: true }).click();
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await assertPublisherButtonTriggerIsEmpty(page, trigger);

      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'reopen after removing last');
      await sheet.getByLabel('Название', { exact: true }).first().fill('Подробнее');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/publik');
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await trigger.getByText('Кнопки · 1', { exact: true }).waitFor({ state: 'visible' });
      await previewButton.waitFor({ state: 'visible' });
      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      if (
        (await sheet.getByLabel('Название', { exact: true }).first().inputValue()) !==
          'Подробнее' ||
        (await sheet.getByLabel('Ссылка', { exact: true }).first().inputValue()) !==
          'https://max.ru/publik'
      ) {
        throw new Error('Restored publisher button values did not survive reopening.');
      }
      await page.keyboard.press('Escape');
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await trigger.getByText('Кнопки · 1', { exact: true }).waitFor({ state: 'visible' });
      await previewButton.waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-buttons-error',
    beforeShot: async (page) => {
      const { sheet } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      const url = sheet.locator('input[type="url"]').first();
      await url.fill('max.ru/publik');
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await sheet.waitFor({ state: 'visible' });
      if ((await url.getAttribute('aria-invalid')) !== 'true') {
        throw new Error('Publisher button URL error is not exposed through aria-invalid.');
      }
      if (
        (await sheet
          .getByLabel('Название', { exact: true })
          .first()
          .getAttribute('aria-invalid')) === 'true'
      ) {
        throw new Error('Publisher button URL error incorrectly marks the name field invalid.');
      }
      const describedBy = (await url.getAttribute('aria-describedby'))?.trim();
      if (!describedBy) {
        throw new Error('Publisher button URL error is not associated through aria-describedby.');
      }
      const associatedAlertVisible = await sheet.locator('[role="alert"]').evaluateAll(
        (alerts, ids) =>
          alerts.some((alert) => {
            const style = getComputedStyle(alert);
            const rect = alert.getBoundingClientRect();
            return (
              ids.includes(alert.id) &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0
            );
          }),
        describedBy.split(/\s+/u),
      );
      if (!associatedAlertVisible) {
        throw new Error('Publisher button URL error does not point to a visible alert.');
      }
    },
  },
  {
    name: PUBLISHER_BUTTONS_KEYBOARD_SCENARIO,
    beforeShot: async (page) => {
      const { sheet } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      await sheet.getByLabel('Название', { exact: true }).first().fill('Подробнее');
    },
  },
  {
    name: 'publications-publisher-import-buttons-omitted',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      const notice = page.locator('.publication-import-buttons-notice');
      await notice.waitFor({ state: 'visible' });
      await notice.getByText('Кнопки не перенесены', { exact: true }).waitFor({ state: 'visible' });
      await notice.getByRole('button', { name: 'Добавить', exact: true }).click();
      const sheet = page.locator('.publication-buttons-sheet');
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'import recovery open');
      await page.keyboard.press('Escape');
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await notice.waitFor({ state: 'visible' });
      await notice.getByText('Кнопки не перенесены', { exact: true }).waitFor({ state: 'visible' });
      await notice.getByRole('button', { name: 'Добавить', exact: true }).waitFor({
        state: 'visible',
      });
    },
  },
  {
    name: 'publications-publisher-compose-large',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page.locator('.publication-target-picker__summary').click();
      const list = page.locator('.publication-target-picker__list');
      await list.waitFor({ state: 'visible' });
      const loaded = page.locator('.publication-target-picker__loaded');
      await loaded.filter({ hasText: /^Показано 30 из \d+$/u }).waitFor();
      const total = Number((await loaded.innerText()).match(/из (\d+)$/u)?.[1]);
      if (total <= 30) throw new Error('Large recipient fixture must span multiple pages.');
      await scrollPaginatedListToStatus(page, {
        list,
        statusSelector: '.publication-target-picker__loaded',
        expectedStatus: `Показано ${total} из ${total}`,
        loadMoreSelector: '.publication-target-picker__load-more',
        label: 'Publisher recipient scroll',
      });
      await page
        .locator('.publication-target-picker__list.is-virtual')
        .waitFor({ state: 'visible' });
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await scrollCaptureList(page, list);
        await page.waitForTimeout(50);
      }
      await page.waitForFunction((total) => {
        const list = document.querySelector('.publication-target-picker__list.is-virtual');
        const lastRow = list?.querySelector(
          `.publication-target-row[data-target-position="${total}"]`,
        );
        if (!(list instanceof HTMLElement) || !(lastRow instanceof HTMLElement)) {
          return false;
        }
        const listRect = list.getBoundingClientRect();
        const rowRect = lastRow.getBoundingClientRect();
        const hitTarget = document.elementFromPoint(
          rowRect.left + rowRect.width / 2,
          rowRect.top + rowRect.height / 2,
        );
        return (
          list.scrollTop > 0 &&
          rowRect.top >= listRect.top &&
          rowRect.bottom <= listRect.bottom &&
          hitTarget !== null &&
          lastRow.contains(hitTarget)
        );
      }, total);
    },
  },
  {
    name: 'publications-publisher-compose-selected',
    beforeShot: async (page) => {
      const summary = page.locator('.publication-target-picker__summary');
      await summary.click();
      await page
        .locator('.publication-target-row')
        .filter({ hasText: 'Новости Южного' })
        .first()
        .click();
      await page
        .locator('.publication-target-row')
        .filter({ hasText: 'Садоводы Южного' })
        .first()
        .click();
      await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
      const previewTarget = page.getByLabel('Получатель в предпросмотре', { exact: true });
      await previewTarget.waitFor({ state: 'visible' });
      await previewTarget.selectOption({ label: 'Новости Южного' });
      await page
        .locator('.publication-content-composer .max-rich-text-editor__surface')
        .fill('Анонс события для жителей района.');
      const systemButtonLabels = await page
        .locator('.publication-content-composer .broadcast-message-card__button')
        .allTextContents();
      const expectedLabels = ['💬 Комментарии', '📞 Заказать рекламу'];
      if (JSON.stringify(systemButtonLabels) !== JSON.stringify(expectedLabels)) {
        throw new Error(`Publisher system buttons differ: ${JSON.stringify(systemButtonLabels)}`);
      }
      await previewTarget.selectOption({ label: 'Садоводы Южного' });
      const chatButtonLabels = await page
        .locator('.publication-content-composer .broadcast-message-card__button')
        .allTextContents();
      if (chatButtonLabels.length !== 0) {
        throw new Error(`Chat preview leaked channel buttons: ${JSON.stringify(chatButtonLabels)}`);
      }
      await previewTarget.selectOption({ label: 'Новости Южного' });
      const restoredChannelLabels = await page
        .locator('.publication-content-composer .broadcast-message-card__button')
        .allTextContents();
      if (JSON.stringify(restoredChannelLabels) !== JSON.stringify(expectedLabels)) {
        throw new Error(
          `Channel preview did not restore exact buttons: ${JSON.stringify(restoredChannelLabels)}`,
        );
      }
    },
  },
  {
    name: 'publications-publisher-compose-media-first',
    beforeShot: async (page) => {
      const summary = page.locator('.publication-target-picker__summary');
      await summary.click();
      await page
        .locator('.publication-target-row')
        .filter({ hasText: 'Новости Южного' })
        .first()
        .click();
      await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();

      const imageInput = page
        .locator('.publication-content-composer input[type="file"][accept="image/*"]')
        .first();
      await imageInput.setInputFiles({
        name: 'afisha.png',
        mimeType: 'image/png',
        buffer: await readFile(path.join(ROOT_DIR, 'apps/miniapp/public/apple-touch-icon.png')),
      });
      const image = page.locator('.publication-content-composer .broadcast-message-card__image');
      await image.waitFor({ state: 'visible' });

      const editor = page.locator('.publication-content-composer .max-rich-text-editor__surface');
      await editor.fill('Афиша добавлена после фотографии.');
      if ((await editor.textContent())?.trim() !== 'Афиша добавлена после фотографии.') {
        throw new Error('Publisher composer did not accept text after selecting a photo.');
      }
      if (!(await image.isVisible())) {
        throw new Error('Publisher composer lost the selected photo after entering text.');
      }
    },
  },
  ...[false, true].map((failUpload) => ({
    name: failUpload
      ? 'publications-publisher-video-upload-failed'
      : 'publications-publisher-video-upload',
    beforeShot: async (page) => {
      const fileName = 'synthetic-upload.mp4';
      const bytes = Buffer.from('00000018667479706d703432000000006d70343269736f6d', 'hex');
      let uploads = 0;
      await page.evaluate(() => {
        window.__publikVideoUploadEvidence = [];
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.send = function (body) {
          if (body instanceof FormData) {
            const file = body.get('data');
            if (file instanceof File) {
              window.__publikVideoUploadEvidence.push(
                file.arrayBuffer().then((buffer) => ({
                  name: file.name,
                  mimeType: file.type,
                  bytes: Array.from(new Uint8Array(buffer)),
                })),
              );
            }
          }
          return originalSend.call(this, body);
        };
      });
      await page.route('https://preview.okcdn.ru/video/**', async (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          uploads += 1;
        }
        await route.fulfill({
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
          },
          contentType: 'application/json',
          body: '{}',
        });
      });
      await page.locator('.publication-target-picker__summary').click();
      await page.locator('.publication-target-row').first().click();
      await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
      const editor = page.locator('.publication-content-composer .max-rich-text-editor__surface');
      const text = 'Текст сохранён при загрузке видео.';
      await editor.fill(text);
      await page.locator('.publication-video-tool input[type="file"]').setInputFiles({
        name: fileName,
        mimeType: 'video/mp4',
        buffer: bytes,
      });
      if (failUpload) {
        await page
          .getByText('MAX не подтвердил видео. Повторите выбор файла.', { exact: true })
          .waitFor();
      } else {
        await page.locator('.publication-retained-media').filter({ hasText: fileName }).waitFor();
      }
      if ((await editor.textContent())?.trim() !== text || uploads !== 1) {
        throw new Error(
          'Publisher video upload lost the draft text or repeated its binary request.',
        );
      }
      const evidence = await page.evaluate(() => Promise.all(window.__publikVideoUploadEvidence));
      if (
        evidence.length !== 1 ||
        evidence[0].name !== fileName ||
        evidence[0].mimeType !== 'video/mp4' ||
        !Buffer.from(evidence[0].bytes).equals(bytes)
      ) {
        throw new Error('Publisher video multipart upload changed its file bytes, MIME, or name.');
      }
    },
  })),
  {
    name: 'publications-publisher-compose-long',
    beforeShot: async (page) => {
      const summary = page.locator('.publication-target-picker__summary');
      await summary.click();
      await page.locator('.publication-target-row').first().click();
      await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
      const editor = page.locator('.publication-content-composer .max-rich-text-editor__surface');
      await editor.fill(
        Array.from(
          { length: 14 },
          (_, index) => `Абзац ${index + 1}. Текст длинной публикации для проверки прокрутки.`,
        ).join('\n\n'),
      );
      const viewport = page.locator('.publications-editor');
      await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
      await page.locator('.publications-publish-bar').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose-unready-target',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page
        .getByText('Получатель из ссылки пока не готов к публикации через Публик', {
          exact: true,
        })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose-missing-target',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page
        .getByText('Получатель из ссылки недоступен.', { exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-publisher-policy-setup',
    beforeShot: async (page) => {
      await page.locator('.settings-sections--chat-home').waitFor({ state: 'visible' });
      if ((await page.locator('.publisher-policy-card').count()) !== 0) {
        throw new Error('Publisher controls leaked into Major.');
      }
    },
  },
  {
    name: 'chat-settings-publisher-policy-error',
    beforeShot: async (page) => {
      await page.locator('.settings-sections--chat-home').waitFor({ state: 'visible' });
      if ((await page.locator('.publisher-policy-card').count()) !== 0) {
        throw new Error('Publisher controls leaked into Major.');
      }
    },
  },
  {
    name: 'channel-settings-publisher-policy',
    beforeShot: async (page) => {
      await page.locator('.channel-settings-screen').waitFor({ state: 'visible' });
      if ((await page.locator('.publisher-policy-card').count()) !== 0) {
        throw new Error('Publisher controls leaked into Major.');
      }
    },
  },
  {
    name: 'channel-settings-publisher-policy-permission',
    beforeShot: async (page) => {
      await page.locator('.channel-settings-screen').waitFor({ state: 'visible' });
      if ((await page.locator('.publisher-policy-card').count()) !== 0) {
        throw new Error('Publisher controls leaked into Major.');
      }
    },
  },
  {
    name: 'publications-publisher-capacity-wait',
    beforeShot: async (page) => {
      await page
        .locator(
          '[data-publication-id="publication-access-required"] .publication-feed-card__surface',
        )
        .click();
      const details = page.getByRole('dialog', { name: 'Объявление для канала' });
      await details
        .getByText('MAX ограничил частоту. Пост остаётся в очереди.')
        .waitFor({ state: 'visible' });
      await details.getByText(/Следующая попытка не раньше/).waitFor({ state: 'visible' });
      await details.getByText(/При задержке пост актуален до/).waitFor({ state: 'visible' });
      await details.locator('.publication-deliveries').scrollIntoViewIfNeeded();
    },
  },
  ...[
    ['pending', 'Отправка остановлена'],
    ['sending', 'Результат начатой попытки уточняется'],
    ['ambiguous', 'Нужно проверить'],
  ].map(([status, label]) => ({
    name: `publications-publisher-stopped-${status}`,
    beforeShot: async (page) => {
      await page
        .locator(
          '[data-publication-id="publication-access-required"] .publication-feed-card__surface',
        )
        .click();
      const details = page.getByRole('dialog', { name: 'Объявление для канала' });
      const deliveries = details.locator('.publication-deliveries');
      await deliveries.getByText(label, { exact: true }).waitFor({ state: 'visible' });
      const text = await deliveries.innerText();
      if (/Пост остаётся в очереди|Следующая попытка не раньше|пост актуален до/.test(text)) {
        throw new Error('Stopped publication still promises a future dispatch.');
      }
      if (status !== 'pending') {
        await deliveries
          .getByText('Дальнейшая отправка остановлена', { exact: true })
          .waitFor({ state: 'visible' });
      }
      if (status === 'ambiguous') {
        await details
          .getByRole('button', { name: /Подтвердить публикацию в/u })
          .waitFor({ state: 'visible' });
        await details
          .getByRole('button', { name: /Отметить неотправленной для/u })
          .waitFor({ state: 'visible' });
      }
      await deliveries.scrollIntoViewIfNeeded();
    },
  })),
  {
    name: 'publications-publisher-access-required',
    beforeShot: async (page) => {
      const card = page.locator(
        '.publication-feed-card[data-publication-id="publication-access-required"]',
      );
      await card.waitFor({ state: 'visible' });
      await card.getByText('Ожидает доступа', { exact: true }).waitFor({ state: 'visible' });
      await card.locator('.publication-feed-card__surface').click();

      const details = page.getByRole('dialog', { name: 'Объявление для канала' });
      await details.waitFor({ state: 'visible' });
      const notice = details.locator('.publication-details-dispatch-notice');
      await notice.getByText('Нужен доступ', { exact: true }).waitFor({
        state: 'visible',
      });
      await notice.getByRole('button', { name: 'Проверить подключения' }).waitFor({
        state: 'visible',
      });
      const detailsText = (await details.textContent()) ?? '';
      if (detailsText.includes('PUBLISHER_')) {
        throw new Error('Publication details exposed an internal Publisher blocker code.');
      }
      if (detailsText.includes('Отправлено 0/0')) {
        throw new Error('Publication details exposed an empty delivery counter.');
      }
    },
  },
  ...[
    'publications-publisher-missed-window',
    'publications-publisher-missed-window-card',
    'publications-publisher-missed-window-future',
    'publications-publisher-missed-window-future-card',
  ].map((name) => ({
    name,
    beforeShot: async (page) => {
      const future = name.includes('-future');
      const card = page.locator('[data-publication-id="publication-access-required"]');
      await card
        .getByText(future ? 'Есть пропущенные отправки' : 'Пропущено время', { exact: true })
        .waitFor({ state: 'visible' });
      if (future) {
        await card
          .locator('.publication-feed-card__schedule')
          .filter({ hasText: /^Следующая · /u })
          .waitFor();
      }
      if (name.endsWith('-card')) return;
      await card.getByRole('button', { name: /^Действия:/u }).click();
      await page
        .getByRole('button', { name: 'Разобрать пропущенные отправки', exact: true })
        .click();
      const details = page.getByRole('dialog', { name: 'Объявление для канала' });
      await details
        .getByText(future ? 'Есть пропущенные отправки' : 'Запуск пропущен', { exact: true })
        .first()
        .waitFor({ state: 'visible' });
      await details.getByText(/^Причина отмечена /u).waitFor({ state: 'visible' });
      await details.getByText(/^Проверено /u).waitFor({ state: 'visible' });
      const retry = details.getByRole('button', { name: /^Отправить пропущенный запуск: /u });
      await retry.waitFor({ state: 'visible' });
      const occurrence = retry.locator('xpath=ancestor::*[@data-occurrence-id]');
      const scheduledAt = (await occurrence.locator('strong').textContent())?.trim();
      if (
        !scheduledAt ||
        !(await retry.getAttribute('aria-label'))?.endsWith(scheduledAt) ||
        !(await occurrence.getAttribute('class'))?.includes('is-failed')
      ) {
        throw new Error('Missed-run review sent the post or lost its exact occurrence date.');
      }
      if (
        await details.getByRole('button', { name: 'Проверить подключения', exact: true }).count()
      ) {
        throw new Error('Missed-run review was confused with a permission recheck.');
      }
      await occurrence.scrollIntoViewIfNeeded();
    },
  })),
  ...[
    'publications-publisher-schedule-error',
    'publications-publisher-schedule-error-card',
    'publications-publisher-schedule-error-edit',
  ].map((name) => ({
    name,
    beforeShot: async (page) => {
      const card = page.locator('[data-publication-id="publication-access-required"]');
      await card.getByText('Ошибка расписания', { exact: true }).waitFor({ state: 'visible' });
      if (!(await card.getAttribute('class'))?.includes('is-danger')) {
        throw new Error('An errored schedule was presented as an active publication.');
      }
      await card
        .locator('.publication-feed-card__schedule')
        .filter({ hasText: /^По плану · /u })
        .waitFor();
      if (name.endsWith('-card')) return;
      await card.getByRole('button', { name: /^Действия:/u }).click();
      await page.getByRole('button', { name: 'Разобрать расписание', exact: true }).click();
      const details = page.getByRole('dialog', { name: 'Объявление для канала' });
      const notice = details.locator('.publication-details-dispatch-notice');
      await notice
        .getByText('Расписание остановлено', { exact: true })
        .waitFor({ state: 'visible' });
      await notice
        .getByText('Отправки по этому расписанию остановлены.', { exact: true })
        .waitFor({ state: 'visible' });
      await details.locator('[data-occurrence-id].is-scheduled').waitFor({ state: 'visible' });
      if (
        (await details
          .getByRole('button', { name: /Повторить запуск|Отправить пропущенный запуск/u })
          .count()) ||
        (await notice.getByRole('button').count())
      ) {
        throw new Error('An untouched scheduled occurrence offered a retry or permission recheck.');
      }
      if (/PUBLISHER_|token=|preview-only/u.test((await details.textContent()) ?? '')) {
        throw new Error('A schedule failure exposed a technical or sensitive diagnostic.');
      }
      const edit = details.getByRole('button', { name: 'Изменить расписание', exact: true });
      await edit.waitFor({ state: 'visible' });
      if (name.endsWith('-edit')) {
        await edit.click();
        await page.locator('.publication-content-composer').waitFor({ state: 'visible' });
      }
    },
  })),
  ...['publications-publisher-retry-once-edit', 'publications-publisher-retry-once-review'].map(
    (name) => ({
      name,
      beforeShot: async (page) => {
        const card = page.locator('[data-publication-id="publication-access-required"]');
        await card.locator('.publication-feed-card__surface').click();
        const details = page.getByRole('dialog', { name: 'Объявление для канала' });
        await details
          .getByRole('button', { name: 'Изменить версию для повтора', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Версия для повтора', exact: true })
          .waitFor({ state: 'visible' });
        await page.locator('.publication-content-composer').waitFor({ state: 'visible' });
        if (
          !(await page.locator('.publication-target-picker__summary').isDisabled()) ||
          (await page.locator('.publication-editor-section--timing').count())
        ) {
          throw new Error('A retry-version editor exposed audience or timing changes.');
        }
        if (name.endsWith('-review')) {
          await page
            .locator('.publications-publish-bar')
            .getByRole('button', { name: 'Проверить пост', exact: true })
            .click();
          const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
          await review
            .getByText('Отправка · после ручного повтора', { exact: true })
            .waitFor({ state: 'visible' });
          await review.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
        }
      },
    }),
  ),
  {
    name: 'publications-publisher-recheck',
    beforeShot: async (page) => {
      await page
        .locator(
          '[data-publication-id="publication-access-required"] .publication-feed-card__surface',
        )
        .click();
      const details = page.getByRole('dialog', { name: 'Объявление для канала' });
      await details.getByRole('button', { name: 'Проверить подключения' }).click();
      await details.locator('.publication-details-dispatch-notice').waitFor({ state: 'hidden' });
    },
  },
  {
    name: 'publications-actions',
    beforeShot: async (page) => {
      await page.locator('.publications-page').waitFor({ state: 'visible' });
      await page.locator('.publication-feed-card__menu-trigger').first().click();
      await page.locator('.publication-action-menu__panel').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-edit-discard',
    beforeShot: async (page) => {
      await page
        .locator(
          '[data-publication-id="publication-delivery-review"] .publication-feed-card__surface',
        )
        .click();
      await page.locator('.publication-details-sheet__panel').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Отметить неотправленной/u }).click();
      await page
        .getByRole('dialog', { name: 'Сообщение не отправлено?' })
        .getByRole('button', { name: 'Подтвердить' })
        .click();
      await page.getByRole('button', { name: 'Повторить запуск' }).waitFor({ state: 'visible' });
      await page.locator('.publication-details-sheet__header > button').click();
      await page.getByText('Есть недоставленные сообщения').waitFor({ state: 'visible' });
      await page
        .locator(
          '[data-publication-id="publication-delivery-review"] .publication-feed-card__menu-trigger',
        )
        .click();
      await page.getByRole('button', { name: 'Изменить версию для повтора' }).click();
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page
        .locator('.broadcast-publish-bar__primary:not(:disabled)')
        .waitFor({ state: 'visible' });
      await page
        .locator('.publication-content-composer .max-rich-text-editor__surface')
        .fill('Несохранённый текст публикации');
      if (nativeScreenshot) await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      else
        await page
          .locator('.publications-editor-header')
          .getByRole('button', { name: 'Назад', exact: true })
          .click();
      await page
        .getByRole('dialog', { name: 'Закрыть без сохранения?' })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-retry-choice',
    beforeShot: async (page) => {
      await page
        .locator(
          '[data-publication-id="publication-delivery-review"] .publication-feed-card__surface',
        )
        .click();
      await page.locator('.publication-details-sheet__panel').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Отметить неотправленной/u }).click();
      await page
        .getByRole('dialog', { name: 'Сообщение не отправлено?' })
        .getByRole('button', { name: 'Подтвердить' })
        .click();
      await page.getByRole('button', { name: 'Повторить запуск' }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Повторить запуск' }).click();
      await page.getByRole('dialog', { name: 'Повторить отправку' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-legacy',
    beforeShot: async (page) => {
      await page.locator('.publik-handoff').waitFor({ state: 'visible' });
      if ((await page.locator('.publications-page').count()) !== 0) {
        throw new Error('Publisher controls leaked into Major.');
      }
    },
  },
  {
    name: 'publications-compose',
    beforeShot: async (page) => {
      await page.locator('.publik-handoff').waitFor({ state: 'visible' });
      if ((await page.locator('.publications-page').count()) !== 0) {
        throw new Error('Publisher controls leaked into Major.');
      }
    },
  },
  {
    name: 'events-moderation',
    beforeShot: async (page) => {
      await page.getByRole('radio', { name: 'Ограничения', exact: true }).click();
      await page.locator('.sanctions-workspace__details-trigger').first().click();
      await page.locator('.sanction-details .button--accent').click({ trial: true });
      await page
        .locator('.sanction-details')
        .getByRole('button', { name: 'Закрыть панель', exact: true })
        .click();
      await waitForModerationEventsReady(page);
      const sections = page.getByRole('group', { name: 'Раздел статистики' });
      await sections.getByRole('button', { name: 'Участники', exact: true }).click();
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
      await page
        .getByRole('searchbox', { name: 'Поиск участника' })
        .fill('несуществующий участник');
      await page.getByText('Участники не найдены', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
      await sections.getByRole('button', { name: 'События', exact: true }).click();
      await page.locator('.membership-feed__item').first().waitFor();
      await assertCompactTextContained(page, { name: 'events-moderation/activity' });
      await sections.getByRole('button', { name: 'Модерация', exact: true }).click();
      await waitForModerationEventsReady(page);
    },
  },
  {
    name: 'events-sanctions',
    beforeShot: async (page) => {
      await page
        .locator('.sanctions-workspace__row')
        .filter({ hasText: 'Александр Кузнецов' })
        .waitFor();
      await page
        .locator('.sanctions-workspace__row')
        .filter({ hasText: 'Екатерина Михайлова' })
        .waitFor();
    },
  },
  {
    name: 'events-sanction-details',
    beforeShot: async (page) => {
      await page
        .locator('.sanctions-workspace__row')
        .filter({ hasText: 'Сергей Маркет' })
        .locator('.sanctions-workspace__details-trigger')
        .click();
      await page.locator('.sanction-details__status progress').waitFor();
      await page.locator('.sanction-details .button--accent').click({ trial: true });
    },
  },
  {
    name: 'events-sanction-release',
    beforeShot: async (page) => {
      await page
        .locator('.sanctions-workspace__row')
        .filter({ hasText: 'Екатерина Михайлова' })
        .locator('.sanctions-workspace__details-trigger')
        .click();
      await page.getByRole('button', { name: 'Разрешить писать', exact: true }).click();
      await page.getByRole('dialog', { name: 'Разрешить писать?' }).waitFor();
      await page
        .getByRole('dialog', { name: 'Разрешить писать?' })
        .getByRole('button', { name: 'Снять ограничение', exact: true })
        .click({ trial: true });
    },
  },
  {
    name: 'events-participants-inactive',
    beforeShot: async (page) => {
      await page.getByLabel('Активность в MAX', { exact: true }).selectOption('30d');
      await page.locator('.participants-roster__activity--long').first().waitFor();
    },
  },
  {
    name: 'events-moderation-scrolled',
    beforeShot: async (page) => {
      await waitForModerationEventsReady(page);
      await page.evaluate(() => window.scrollTo({ top: 360, behavior: 'instant' }));
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'events-moderation-expanded',
    beforeShot: async (page) => {
      await waitForModerationEventsReady(page);
      const event = page.locator('.event-feed-item').first();
      await event.locator('.event-feed-item__expand').click();
      await event.locator('.event-feed-item__details').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'events-moderation-scope',
    beforeShot: async (page) => {
      await waitForModerationEventsReady(page);
      const event = page.locator('.event-feed-item').filter({ hasText: 'Мария Ссылкина' });
      await event
        .getByRole('button', { name: 'Показать детали нарушения: Мария Ссылкина', exact: true })
        .click();
      await event.locator('.event-feed-item__details').waitFor({ state: 'visible' });
      await event.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      await page.getByRole('dialog', { name: 'Блокировка участника' }).waitFor();
    },
    afterShot: (page) => assertModerationScopeBusy(page, 'В этом чате'),
  },
  {
    name: 'events-activity',
    beforeShot: waitForActivityEventsReady,
  },
  {
    name: 'events-participants',
    beforeShot: async (page) => {
      await page.locator('.participants-roster').waitFor({ state: 'visible' });
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
    },
  },
  {
    name: 'events-participants-search',
    beforeShot: async (page) => {
      await page.getByRole('searchbox', { name: 'Поиск участника' }).fill('sergey-market');
      await page
        .locator('.participants-roster__results')
        .filter({ hasText: 'Найдено: 1' })
        .waitFor();
      if ((await page.locator('.participants-roster__item').count()) !== 1) {
        throw new Error('Participant search retained rows from a previous query.');
      }
    },
  },
  {
    name: 'events-participants-empty',
    beforeShot: async (page) => {
      await page
        .getByRole('searchbox', { name: 'Поиск участника' })
        .fill('несуществующий участник');
      await page.getByText('Участники не найдены', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
      await page
        .getByRole('searchbox', { name: 'Поиск участника' })
        .fill('несуществующий участник');
      await page.getByText('Участники не найдены', { exact: true }).waitFor();
    },
  },
  {
    name: 'events-participants-bots',
    beforeShot: async (page) => {
      await page.getByLabel('Роль участника', { exact: true }).selectOption('bots');
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
      const rows = page.locator('.participants-roster__item');
      if (
        (await rows.count()) === 0 ||
        (await rows.count()) !==
          (await rows.filter({ has: page.locator('.participants-roster__pill--bot') }).count())
      ) {
        throw new Error('Bot filter displayed non-bot participants.');
      }
    },
  },
  {
    name: 'events-participants-menu',
    beforeShot: async (page) => {
      const menu = page.locator('.participants-roster__manage');
      await menu.locator('summary').click();
      await page.keyboard.press('Escape');
      if ((await menu.getAttribute('open')) !== null)
        throw new Error('Participant menu did not close on Escape.');
      await menu.locator('summary').click();
      await page.getByRole('button', { name: 'Удалить заблокированных', exact: true }).waitFor();
    },
  },
  {
    name: 'events-participant-sheet',
    beforeShot: async (page) => {
      const firstParticipant = page.locator('.participants-roster__item--interactive').first();
      await firstParticipant.waitFor({ state: 'visible' });
      await firstParticipant.click();
      await page.locator('.participant-sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'events-participant-controls',
    beforeShot: async (page) => {
      const manageableParticipant = page
        .locator('.participants-roster__item--interactive')
        .filter({ hasText: '@sergey-market' })
        .first();
      await manageableParticipant.waitFor({ state: 'visible' });
      await manageableParticipant.click();
      await page.locator('.participant-sheet').waitFor({ state: 'visible' });
      await page.locator('.participant-sheet__action--immunity').click();
      await page.locator('#participant-sheet-immunity-composer').waitFor({ state: 'visible' });
      await scrollSettingsDrilldownToBottom(page);
    },
  },
  {
    name: 'events-participant-scope',
    beforeShot: async (page) => {
      const participant = page
        .locator('.participants-roster__item--interactive')
        .filter({ hasText: '@sergey-market' });
      await participant.click();
      const sheet = page.locator('.participant-sheet');
      await sheet.waitFor({ state: 'visible' });
      await sheet.getByRole('button', { name: 'Заблокировать', exact: true }).click();
      await page.getByRole('dialog', { name: 'Блокировка участника' }).waitFor();
    },
    afterShot: (page) => assertModerationScopeBusy(page, 'Во всех чатах'),
  },
  {
    name: 'events-spam-review',
    beforeShot: async (page) => {
      await page.locator('.spammer-review__entry').click();
      await page.locator('.spammer-review-sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'events-spam-diagnostics',
    beforeShot: async (page) => {
      await page.locator('.spammer-review__entry').click();
      const firstCandidate = page.locator('.spammer-review-sheet__row').first();
      await firstCandidate.waitFor({ state: 'visible' });
      await firstCandidate.click();
      await page.locator('.spammer-diagnostics-sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'events-spam-help',
    beforeShot: async (page) => {
      await page.locator('.spammer-review__entry').click();
      await page.locator('.spammer-review-sheet__row').first().click();
      const panel = page.locator('.spammer-diagnostics-sheet');
      await panel.waitFor({ state: 'visible' });
      await assertHintDismissal(page, panel, panel.locator('[data-hint-key="spammerReview"]'));
    },
  },
  {
    name: 'chat-settings',
  },
  {
    name: 'chat-settings-access-lost',
    beforeShot: async (page) => {
      await page.locator('.managed-access-alert').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-rules',
    beforeShot: async (page) => {
      // FLAG: These publication clicks must stay on the in-memory preview transport.
      if (new URL(page.url()).searchParams.get('preview') !== '1') {
        throw new Error('Rules publication interaction smoke requires preview mode.');
      }
      await openSettingsSection(page, 'Правила', '.settings-drilldown__panel--rules');
      await page.locator('.rules-studio-screen').waitFor({ state: 'visible' });
      await page
        .getByRole('textbox', { name: 'Текст правил', exact: true })
        .waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Опубликовать в чат', exact: true }).click();
      await page.getByText('Новый пост правил опубликован', { exact: true }).waitFor();
      await page.getByRole('radio', { name: 'Обновить пост', exact: true }).click();
      await page.getByRole('button', { name: 'Обновить пост', exact: true }).click();
      await page.getByText('Прежний пост правил обновлён', { exact: true }).waitFor();
      await page
        .locator('.toast__close')
        .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
      await page.getByRole('radio', { name: 'Новый пост', exact: true }).click();
    },
  },
  {
    name: 'chat-settings-greeting',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Приветствие', '.settings-drilldown__panel--greeting');
    },
  },
  {
    name: 'chat-settings-profanity',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Мат и оскорбления', '.settings-drilldown__panel--profanity');
    },
  },
  {
    name: 'chat-settings-commercial',
    beforeShot: async (page) => {
      await openSettingsSection(
        page,
        'Коммерческая реклама',
        '.settings-drilldown__panel--commercial',
      );
    },
  },
  {
    name: 'chat-settings-duplicates',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
    },
  },
  {
    name: 'chat-settings-help',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await panel.locator('.duplicate-photo-toggle').waitFor({ state: 'visible' });
      await assertHintDismissal(
        page,
        panel,
        panel.getByRole('button', { name: 'Пояснение для антидубля', exact: true }),
      );
    },
  },
  {
    name: 'chat-settings-duplicates-flow',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      const hours = panel.getByRole('spinbutton', { name: 'Период проверки дублей, часы' });
      await hours.fill('');
      if ((await hours.inputValue()) !== '') throw new Error('Duplicate window cannot be cleared');
      await hours.fill('24');
      await hours.blur();
      if ((await hours.inputValue()) !== '24')
        throw new Error('Duplicate window lost the edited value');
      await panel.getByRole('radio', { name: '2 дня', exact: true }).click();
      if ((await hours.inputValue()) !== '48')
        throw new Error('Duplicate window preset was not applied');
      await hours.fill('168');
      await hours.blur();
      const hoursError = panel.locator('#duplicate-window-hours-error');
      await hoursError.waitFor({ state: 'visible' });
      if (
        (await hours.inputValue()) !== '168' ||
        (await hours.getAttribute('aria-invalid')) !== 'true' ||
        (await hoursError.innerText()) !== 'Укажите период от 1 до 48 часов.'
      )
        throw new Error('Invalid duplicate window lost its value or validation state');
      await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
      if (!(await panel.isVisible()) || !(await hoursError.isVisible()))
        throw new Error('Invalid duplicate window was accepted');
      await panel.getByRole('radio', { name: '2 дня', exact: true }).click();
      if (
        (await hours.inputValue()) !== '48' ||
        (await hours.getAttribute('aria-invalid')) === 'true'
      )
        throw new Error('Correcting the duplicate window did not clear its validation state');
      await hoursError.waitFor({ state: 'hidden' });
      await page
        .locator('.toast__close')
        .evaluateAll((buttons) => buttons.forEach((button) => button.click()));
      const countControlsOverlap = await panel
        .locator('.duplicate-count-stepper')
        .evaluate((element) => {
          const boxes = [...element.children].map((child) => child.getBoundingClientRect());
          return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1].right - 1);
        });
      if (countControlsOverlap) throw new Error('Duplicate allowance controls overlap');
      await panel.getByLabel('Сообщение о дублях', { exact: true }).check();
      await panel.getByLabel('Включить предупреждение за повторы', { exact: true }).check();
      await panel.getByLabel('Включить ограничение сообщений за повторы', { exact: true }).check();
      await panel.getByLabel('Включить блокировку за повторы', { exact: true }).check();
      const preview = panel.locator('.duplicate-action-preview');
      await preview.getByText('Сообщение №1', { exact: true }).waitFor();
      await preview.getByText('Удаление и блокировка навсегда', { exact: true }).waitFor();
      await preview.evaluate((element) => element.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'chat-settings-duplicates-daily',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await panel.getByRole('radio', { name: '2 дня', exact: true }).click();
      await panel.getByRole('radio', { name: 'По времени', exact: true }).click();
      const setTime = async (label, hour) => {
        await panel.getByRole('button', { name: new RegExp(`^${label}:`) }).click();
        const sheet = page.locator('.time-field-sheet__panel');
        const option = sheet.locator(`[data-time-part="hour"][data-time-value="${hour}"]`);
        await option.scrollIntoViewIfNeeded();
        await option.click();
        await sheet.getByRole('button', { name: 'Применить', exact: true }).click();
      };
      await setTime('С', 18);
      await panel.getByText('Начало и конец должны отличаться.', { exact: true }).waitFor();
      await setTime('С', 22);
      await setTime('По', 8);
      await panel
        .getByRole('combobox', { name: 'Часовой пояс', exact: true })
        .selectOption('Asia/Yekaterinburg');
      const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
      await save.click();
      await save.waitFor({ state: 'hidden' });
      if (await panel.isVisible())
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      await panel.getByRole('button', { name: 'С: 22:00', exact: true }).waitFor();
      await panel.getByRole('button', { name: 'По: 08:00', exact: true }).waitFor();
      if (
        (await panel.getByRole('combobox', { name: 'Часовой пояс', exact: true }).inputValue()) !==
        'Asia/Yekaterinburg'
      )
        throw new Error('Duplicate timezone was not saved');
      await panel.getByRole('radio', { name: 'Интервал', exact: true }).click();
      if (
        (await panel
          .getByRole('spinbutton', { name: 'Период проверки дублей, часы' })
          .inputValue()) !== '48'
      )
        throw new Error('Switching duplicate modes lost the interval');
      await panel.getByRole('radio', { name: 'По времени', exact: true }).click();
      await panel
        .locator('.duplicate-stage')
        .first()
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await page.getByRole('button', { name: 'Закрыть уведомление' }).evaluateAll((buttons) => {
        for (const button of buttons) button.click();
      });
      const overflow = await panel
        .locator('.duplicate-window, .duplicate-window__times, .duplicate-trigger-count')
        .evaluateAll((elements) =>
          elements.some((element) => element.scrollWidth > element.clientWidth + 1),
        );
      if (overflow) throw new Error('Duplicate schedule controls overflow');
      const countOverlap = await panel.locator('.duplicate-count-stepper').evaluate((element) => {
        const boxes = [...element.children].map((child) => child.getBoundingClientRect());
        return boxes.some((box, index) => index > 0 && box.left < boxes[index - 1].right - 1);
      });
      if (countOverlap) throw new Error('Duplicate count controls overlap in daily mode');
    },
  },
  {
    name: 'chat-settings-duplicates-time-picker',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await panel.getByRole('radio', { name: 'По времени', exact: true }).click();
      await panel.getByRole('button', { name: /^С:/u }).click();
      await page.locator('.time-field-sheet__panel').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-duplicates-threshold',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      const earlier = panel.getByRole('button', { name: 'Начинать удаление раньше', exact: true });
      for (let index = 0; index < 20 && (await earlier.isEnabled()); index += 1)
        await earlier.click();
      if ((await panel.locator('.duplicate-count-stepper__value').innerText()).trim() !== '2-го')
        throw new Error('Strict duplicate threshold must display the second message');
      const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
      await save.click();
      await save.waitFor({ state: 'hidden' });
      if (await panel.isVisible())
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      if ((await panel.locator('.duplicate-count-stepper__value').innerText()).trim() !== '2-го')
        throw new Error('Saved duplicate threshold changed after reopening');
      await panel
        .locator('.duplicate-stage')
        .first()
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    },
  },
  {
    name: 'chat-settings-duplicate-saved-state',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await panel.getByText('Права удаления подтверждены', { exact: true }).waitFor();
      await panel.getByLabel('Включить антидубль', { exact: true }).uncheck();
      const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
      await save.click();
      await save.waitFor({ state: 'hidden' });
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      await panel.getByText('Проверка и история', { exact: true }).click();
      await panel
        .locator('.duplicate-diagnostics__facts > div')
        .filter({ has: page.getByText('Сохранённая настройка', { exact: true }) })
        .getByText('Выключен', { exact: true })
        .waitFor();
    },
  },
  {
    name: 'chat-settings-duplicate-diagnostics',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await panel.getByText('Права удаления подтверждены', { exact: true }).waitFor();
      await panel.getByText('Проверка и история', { exact: true }).click();
      await panel.getByText('Ожидает повторной попытки', { exact: true }).waitFor();
      await panel.getByRole('button', { name: 'Проверить права', exact: true }).click();
      await panel.getByText('Права удаления подтверждены', { exact: true }).waitFor();
      await panel.locator('.duplicate-diagnostics').scrollIntoViewIfNeeded();
    },
  },
  {
    name: 'chat-settings-duplicates-photos',
    beforeShot: async (page) => {
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      const scope = panel.getByRole('radiogroup', { name: 'Чьи картинки сравнивать' });
      await scope.waitFor({ state: 'visible' });
      await scope.getByRole('radio', { name: 'Всех участников', exact: true }).click();
      const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
      await save.click();
      await save.waitFor({ state: 'hidden' });
      if (await panel.isVisible())
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      if (!(await scope.getByRole('radio', { name: 'Всех участников', exact: true }).isChecked())) {
        throw new Error('Image author scope did not persist');
      }
      await panel.getByLabel('Сравнение сообщений', { exact: true }).selectOption('TEXT');
      await scope.waitFor({ state: 'hidden' });
      await panel.getByLabel('Сравнение сообщений', { exact: true }).selectOption('MESSAGE');
      await scope.waitFor({ state: 'visible' });
      if (await panel.getByText(/С изменениями|дополнительной санкции/).count()) {
        throw new Error('Retired image filter controls are still visible');
      }
      await scope.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'chat-settings-duplicates-duration',
    beforeShot: async (page) => {
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      await panel.locator('.settings-duration-editor__preset--trigger').click();
      await panel.locator('.settings-duration-editor').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-limits',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Ограничения', '.settings-drilldown__panel--limits');
    },
  },
  {
    name: 'chat-settings-limits-active',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Ограничения', '.settings-drilldown__panel--limits');
      const panel = page.locator('.settings-drilldown__panel--limits');
      for (const name of [
        'Включить лимит сообщений',
        'Включить ограничение длины сообщения',
        'Ограничить отправку фото по времени',
        'Ограничить отправку стикеров по времени',
      ]) {
        await panel.getByRole('checkbox', { name, exact: true }).check();
      }
      const slider = panel.getByRole('slider', { name: 'Лимит длины сообщения', exact: true });
      await slider.focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      const expected =
        Number(await slider.getAttribute('min')) + Number(await slider.getAttribute('step'));
      if (Number(await slider.inputValue()) !== expected) {
        throw new Error('The message length slider did not respond to keyboard input.');
      }
      await panel.locator('.settings-drilldown__body').evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'chat-settings-night',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Ночной режим', '.settings-drilldown__panel--night');
      await page.getByText('Сейчас группа открыта', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-night-time-picker',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Ночной режим', '.settings-drilldown__panel--night');
      const timeField = page
        .locator('.settings-drilldown__panel--night .time-field__button')
        .first();
      await timeField.scrollIntoViewIfNeeded();
      await timeField.click();
      await page.locator('.time-field-sheet__panel').waitFor({ state: 'visible' });
      const lastMinute = page.locator(
        '.time-field-sheet__option[data-time-part="minute"][data-time-value="59"]',
      );
      await lastMinute.scrollIntoViewIfNeeded();
      await lastMinute.click();
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'chat-settings-commands',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Команды', '.settings-drilldown__panel--commands');
    },
  },
  {
    name: 'chat-settings-storefront',
    beforeShot: async (page) => {
      await page.getByRole('checkbox', { name: 'Включить кнопку витрины Караван' }).waitFor({
        state: 'visible',
      });
    },
  },
  {
    name: 'chat-settings-birzhik',
    beforeShot: assertBirzhikModule,
  },
  {
    name: 'chat-settings-birzhik-profile',
    beforeShot: assertBirzhikProfileModule,
  },
  {
    name: 'chat-settings',
    beforeShot: async (page, profile) => {
      await assertBirzhikModule(page);
      await applyNativeScreenshotMode(page, profile);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    },
  },
  {
    name: 'chat-settings-extra',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Сообщения и боты', '.settings-drilldown__panel--extra');
    },
  },
  {
    name: 'chat-settings-speech-style',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: 'Стиль речи', exact: true }).click();
      await page.locator('.settings-drilldown__panel--speech').waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'chat-settings-stop-words',
    beforeShot: async (page) => {
      await page.getByLabel('Список слов и фраз', { exact: true }).waitFor({ state: 'visible' });
      await page.getByRole('checkbox', { name: 'Стоп-слова включены' }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
    },
  },
  { name: 'chat-settings-stop-words-flow', beforeShot: assertStopWordsEditorFlow },
  { name: 'chat-settings-stop-words-large', beforeShot: assertStopWordsLargeList },
  {
    name: 'chat-settings-stop-words-retry',
    beforeShot: (page) => assertStopWordsSaveFailure(page, 'network'),
  },
  {
    name: 'chat-settings-stop-words-conflict',
    beforeShot: (page) => assertStopWordsSaveFailure(page, 'conflict'),
  },
  {
    name: 'chat-settings-links',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-bot-message-editor',
    beforeShot: async (page) => {
      await page.locator('.settings-drilldown__panel--links').waitFor({ state: 'visible' });
      const explanationToggle = page.getByLabel('Включить объяснение для модерации ссылок');
      if (!(await explanationToggle.isChecked())) {
        await explanationToggle.check();
      }
      await page
        .getByRole('button', { name: 'Редактировать текст сообщения о ссылках', exact: true })
        .click();
      await page.locator('.bot-message-editor-sheet__panel').waitFor({ state: 'visible' });
      await assertBotMessagePlaceholderRoundTrip(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-admin-contact',
    beforeShot: async (page) => {
      if (!(await page.locator('.settings-drilldown__panel--links').isVisible())) {
        await openSettingsSection(page, 'Ссылки', '.settings-drilldown__panel--links');
      }
      await page.getByLabel('Включить объяснение для модерации ссылок').check();
      const toggle = page.getByLabel('Добавить связь с админом в сообщения о ссылках');
      if (await toggle.isChecked()) await toggle.uncheck();
      await toggle.click();
      const picker = page.getByRole('dialog', { name: 'Администраторы чата' });
      await picker.waitFor({ state: 'visible' });
      await picker.locator('.admin-contact-picker__option').first().waitFor({ state: 'visible' });
      const selectedName = await picker
        .locator('.admin-contact-picker__copy > span')
        .first()
        .innerText();
      await picker.locator('.admin-contact-picker__option').first().click();
      if (!(await toggle.isChecked()))
        throw new Error('Admin contact selection did not enable contact');
      await page
        .getByRole('button', { name: `Выбрать администратора: ${selectedName}`, exact: true })
        .click();
      await picker.locator('[aria-pressed="true"]').waitFor({ state: 'visible' });
      await picker.getByRole('searchbox').fill('нет-такого-администратора');
      await picker
        .getByText('Администраторы не найдены.', { exact: true })
        .waitFor({ state: 'visible' });
      await picker.getByRole('searchbox').fill('');
      await picker.locator('[aria-pressed="true"]').waitFor({ state: 'visible' });
      await picker.getByRole('searchbox').blur();
    },
  },
  {
    name: 'chat-settings-links-timer',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.locator('.allowlist-item__action--schedule').first().click();
      const fields = page.locator('.allowlist-item__schedule-fields').first();
      await fields.locator('.date-field__control').waitFor({ state: 'visible' });
      await fields.locator('.time-field__button').waitFor({ state: 'visible' });
      await fields.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'chat-settings-links-button-picker',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.getByLabel('Включить объяснение для модерации ссылок').check();
      await page.waitForTimeout(250);
      const buttonToggle = page.getByLabel('Добавить кнопку в сообщение бота для модерации ссылок');
      await buttonToggle.scrollIntoViewIfNeeded();
      await buttonToggle.check();
      await page.waitForTimeout(450);
      const editor = page.locator('.broadcast-link-editor').first();
      await editor.waitFor({ state: 'visible' });
      await page.evaluate(() => {
        document.querySelector('.broadcast-link-editor')?.scrollIntoView({
          block: 'start',
          behavior: 'instant',
        });
        window.scrollBy({ top: -84, behavior: 'instant' });
      });
      await page
        .locator('.broadcast-link-editor input[type="url"]')
        .first()
        .fill('https://max.ru/');
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-links-button-sheet',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.getByLabel('Включить объяснение для модерации ссылок').check();
      await page.waitForTimeout(250);
      const buttonToggle = page.getByLabel('Добавить кнопку в сообщение бота для модерации ссылок');
      await buttonToggle.scrollIntoViewIfNeeded();
      await buttonToggle.check();
      await page.waitForTimeout(450);
      const editor = page.locator('.broadcast-link-editor').first();
      await editor.waitFor({ state: 'visible' });
      await editor.scrollIntoViewIfNeeded();
      await page.locator('.broadcast-link-editor input[type="text"]').first().fill('Открыть канал');
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-polls',
    beforeShot: async (page) => {
      await page.locator('.managed-poll-workspace').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-poll-editor',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-poll-published',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page);
      await publishPreviewPoll(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-poll-draft',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page);
      await savePreviewPollDraft(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-giveaway',
    beforeShot: async (page) => {
      await page.locator('.managed-giveaway--dashboard').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-giveaway-editor',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
    },
  },
  {
    name: 'chat-settings-giveaway-conditions-step',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.locator('.managed-giveaway--step-conditions').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-giveaway-channels-modal',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.locator('.managed-giveaway--step-conditions').waitFor({ state: 'visible' });
      await page
        .getByRole('button', {
          name: /(?:Открыть список|Добавить свой канал|Выбрано)/u,
        })
        .click();
      await page.locator('.managed-giveaway-modal__sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-giveaway-publish-step',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.locator('.managed-giveaway--step-conditions').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /(?:Далее: призы|К призам)/u }).click();
      await page.locator('.managed-giveaway--step-prizes').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-dialog-comments',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-dialog-comments-short-thread',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await assertCommentsComposerPinned(page);
    },
  },
  {
    name: 'chat-dialog-comments-empty-thread',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'channel-dialog-comments',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'channel-dialog-suggest',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      const composeTab = page.locator('#suggest-tab-compose');
      await composeTab.focus();
      for (const [key, selected] of [
        ['ArrowRight', 'preview'],
        ['End', 'history'],
        ['Home', 'compose'],
        ['ArrowLeft', 'history'],
        ['ArrowRight', 'compose'],
      ]) {
        await page.keyboard.press(key);
        const tab = page.locator(`#suggest-tab-${selected}`);
        if (
          (await tab.getAttribute('aria-selected')) !== 'true' ||
          (await tab.getAttribute('tabindex')) !== '0'
        ) {
          throw new Error(
            `Suggestion tabs failed ${key}: expected ${selected} to be selected and focusable.`,
          );
        }
        if (!(await tab.evaluate((element) => element === document.activeElement))) {
          throw new Error(`Suggestion tab focus did not follow ${key}.`);
        }
        await page.locator(`#suggest-${selected}`).waitFor({ state: 'visible' });
      }
      if ((await page.locator('.channel-suggest-tabs [role="tab"][tabindex="0"]').count()) !== 1) {
        throw new Error('Suggestion tabs must have one keyboard entry point.');
      }
      await composeTab.evaluate((element) => element.blur());
      await page.getByText('Требования канала', { exact: true }).click();
      await page
        .getByText('Только события нашего города с датой, адресом и контактами.', {
          exact: true,
        })
        .waitFor({ state: 'visible' });
      await page.getByText('Требования канала', { exact: true }).click();
    },
  },
  {
    name: 'channel-dialog-suggest-publisher',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.getByRole('textbox', { name: 'Текст объявления' }).waitFor({ state: 'visible' });
      if ((await page.getByText('Требования канала', { exact: true }).count()) !== 0) {
        throw new Error('Publisher suggestion dialog rendered synthetic requirements.');
      }

      await page.locator('#suggest-tab-history').click();
      const imageOnlyCard = page.locator('.channel-suggest-card').filter({
        has: page.getByText('Фото · market-evening.webp', { exact: true }),
      });
      await imageOnlyCard.waitFor({ state: 'visible' });
      if ((await imageOnlyCard.count()) !== 1) {
        throw new Error('Public image-only suggestion fixture is missing or ambiguous.');
      }
      if (
        (await imageOnlyCard
          .locator(':scope > p:not(.channel-suggest-card__status-detail)')
          .count()) !== 0
      ) {
        throw new Error('Public image-only suggestion unexpectedly rendered a text block.');
      }
      if (((await page.locator('body').textContent()) ?? '').includes('Предложение отправлено')) {
        throw new Error('Public suggestion history rendered generated media fallback copy.');
      }
      await page.locator('#suggest-tab-compose').click();
    },
  },
  {
    name: 'publisher-entity-modules-cold',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Посты', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-modules-cold',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Предложения', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-suggestions-toggle',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      const suggestions = page.getByRole('button', { name: 'Предложения', exact: true });
      if (await suggestions.count()) await suggestions.click();
      const toggle = page.getByRole('checkbox', { name: 'Включить предложения', exact: true });
      await toggle.click();
      const enabledToggle = page.getByRole('checkbox', {
        name: 'Выключить предложения',
        exact: true,
      });
      await enabledToggle.waitFor({
        state: 'visible',
      });
      if (!(await enabledToggle.isChecked())) {
        throw new Error('Publisher suggestion switch did not persist its enabled state.');
      }
      for (const label of ['Требовать подписку', 'Удалять посты после отписки']) {
        const policyToggle = page.getByRole('checkbox', { name: label, exact: true });
        await policyToggle.click();
        await page.waitForFunction((name) => {
          const checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find(
            (input) => input.getAttribute('aria-label') === name,
          );
          return checkbox?.checked && !checkbox.disabled;
        }, label);
      }
    },
  },
  {
    name: 'chat-settings-required-subscription',
    beforeShot: async (page) => {
      const panel = page.locator('.settings-drilldown__panel--required-subscription');
      await panel.waitFor({ state: 'visible' });
      const help = panel.getByRole('button', { name: 'Как работает обязательная подписка' });
      const note = panel.getByRole('note');
      if (await note.count()) throw new Error('Subscription help must start closed.');
      await help.click();
      await note.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await note.waitFor({ state: 'detached' });
      await panel.waitFor({ state: 'visible' });
      await help.click();
      await note.waitFor({ state: 'visible' });
      const hasNativeBack = await page.evaluate(
        () => typeof window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__ === 'function',
      );
      if (hasNativeBack) {
        await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      } else {
        await help.click();
      }
      await note.waitFor({ state: 'detached' });
      await panel.waitFor({ state: 'visible' });
      if (await panel.getByRole('searchbox', { name: 'Найти чат или канал' }).count()) {
        throw new Error('Configured subscription should defer the source picker.');
      }
    },
  },
  {
    name: 'chat-settings-required-subscription-help',
    beforeShot: async (page) => {
      const panel = page.locator('.settings-drilldown__panel--required-subscription');
      await panel.getByRole('button', { name: 'Как работает обязательная подписка' }).click();
      await panel.getByRole('note').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-required-subscription-sources',
    beforeShot: async (page) => {
      const panel = page.locator('.settings-drilldown__panel--required-subscription');
      await panel.getByRole('button', { name: 'Добавить источник' }).click();
      const search = panel.getByRole('searchbox', { name: 'Найти чат или канал' });
      await search.fill('Садоводы');
      await panel.getByRole('option', { name: 'Добавить чат Садоводы Южного' }).click();
      await panel.getByRole('button', { name: 'Удалить чат Садоводы Южного' }).click();
      await search.fill('');
      const filter = panel.getByRole('radio', { name: /Каналы/u });
      await filter.click();
      if (await panel.getByRole('option', { name: 'Добавить чат Садоводы Южного' }).count()) {
        throw new Error('Channel filter must not include chats.');
      }
      await panel.getByRole('radio', { name: /Все/u }).click();
      await panel.getByRole('option', { name: 'Добавить чат Садоводы Южного' }).waitFor();
      await panel.locator('.required-subscription__external-source input').fill('https://max.ru/');
      await panel.locator('.required-subscription__external-source input').fill('');
      await panel.locator('.required-subscription__external-source input').press('Enter');
      if (await panel.locator('.required-subscription__external-source [role="alert"]').count()) {
        throw new Error('Empty subscription URLs must not be submitted.');
      }
      await panel.locator('.settings-drilldown__body').evaluate((element) => {
        element.scrollTop = 0;
      });
    },
  },
  {
    name: 'chat-settings-apply-target',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      const explanationToggle = page.getByLabel('Включить объяснение для модерации ссылок');
      if (!(await explanationToggle.isChecked())) {
        await explanationToggle.check();
      }
      await page.getByRole('button', { name: /Применить к другим чатам/u }).click();
      await page.locator('.settings-apply-target__panel').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Категории', exact: true }).click();
      const categories = page.getByRole('group', { name: 'Категории избранного' });
      await categories.waitFor({ state: 'visible' });
      const categoryGrid = await categories.evaluate((element) => {
        const buttons = Array.from(element.querySelectorAll('button'));
        return {
          buttonCount: buttons.length,
          selectedCount: buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')
            .length,
          columnCount: getComputedStyle(element).gridTemplateColumns.split(/\s+/u).filter(Boolean)
            .length,
        };
      });
      if (
        categoryGrid.buttonCount !== 6 ||
        categoryGrid.selectedCount !== 6 ||
        categoryGrid.columnCount !== 2
      ) {
        throw new Error(
          `Apply-target category grid is incomplete: ${JSON.stringify(categoryGrid)}.`,
        );
      }
    },
  },
  {
    name: 'chat-settings-broadcast',
    beforeShot: async (page) => {
      await page.locator('.managed-autopost-rule-card').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-broadcast-handoff',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-broadcast-audience',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
      await page.locator('.broadcast-audience-card__mode-tabs').getByRole('radio').nth(1).click();
      await page.locator('.broadcast-audience-sheet__panel').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-broadcast-history',
    beforeShot: async (page) => {
      await openBroadcastHistoryTab(page);
    },
  },
  {
    name: 'chat-settings-broadcast-editor',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings',
  },
  {
    name: 'channel-settings-post-signature',
    beforeShot: async (page) => {
      const signatureEntry = page.getByRole('button', {
        name: 'Действие под публикацией',
        exact: true,
      });
      if ((await signatureEntry.getAttribute('aria-expanded')) !== 'false') {
        throw new Error('Channel post signature editor is expanded on the overview.');
      }
      if ((await page.getByRole('textbox', { name: 'Текст ссылки' }).count()) !== 0) {
        throw new Error('Channel post signature fields leaked into the overview.');
      }
      await openSettingsSection(
        page,
        'Действие под публикацией',
        '.settings-drilldown__panel--signature',
      );
      if ((await signatureEntry.getAttribute('aria-expanded')) !== 'true') {
        throw new Error('Channel post signature entry did not expose its open state.');
      }
      const signatureToggle = page.getByRole('checkbox', { name: 'Действие под публикацией' });
      await signatureToggle.check();
      const signatureText = page.getByRole('textbox', { name: 'Текст ссылки' });
      await signatureText.fill('Читать канал');
      await signatureText.blur();
      const signatureUrl = page.getByRole('textbox', { name: 'Адрес ссылки' });
      await signatureUrl.fill('https://max.ru/advertising-manager');
      await signatureUrl.blur();
      await page.getByText('Сохранено', { exact: true }).waitFor({ state: 'visible' });
      const previewHref = await page
        .locator('.channel-post-signature__preview a')
        .getAttribute('href');
      if (previewHref !== 'https://max.ru/advertising-manager') {
        throw new Error(`Channel post signature preview kept an outdated URL: ${previewHref}.`);
      }
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'channel-settings-quick-buttons',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: 'Быстрые кнопки', exact: true }).click();
      const toggle = page.getByRole('checkbox', { name: 'Быстрые кнопки', exact: true });
      const help = page.locator('#channel-quick-buttons-help');
      const example = page.locator('.channel-quick-buttons-example');
      await help.waitFor({ state: 'visible' });
      await example.waitFor({ state: 'visible' });
      const helpText = await help.innerText();
      if (
        (await toggle.getAttribute('aria-describedby')) !== 'channel-quick-buttons-help' ||
        !helpText.includes('Название = ссылка') ||
        !helpText.includes('Бот уберёт эту строку и добавит кнопку под постом.') ||
        (await example.locator('code').innerText()) !== 'Подробнее = https://example.com' ||
        (await example.locator('button, a, input, textarea, [role="button"]').count()) > 0
      ) {
        throw new Error(
          'Quick buttons must explain the syntax with a visible static example below the toggle.',
        );
      }
      if (await toggle.isChecked()) {
        throw new Error('Quick buttons must default off.');
      }
      await toggle.check();
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.getByRole('button', { name: 'Быстрые кнопки', exact: true }).click();
      if (!(await toggle.isChecked())) {
        throw new Error('Quick button setting was not saved.');
      }
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'channel-settings-access-degraded',
    beforeShot: async (page) => {
      await page.locator('.managed-access-alert').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings-comments',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /(?:Комментарии|Обсуждение)/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-post-suggestions',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /Предложения/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-post-suggestions-off',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /Предложения/u }).click();
      const toggle = page.getByRole('checkbox', { name: 'Принимать предложения', exact: true });
      if (await toggle.isChecked()) {
        await toggle.uncheck();
      }
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-polls',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /Опросы/u }).click();
      await page.locator('.managed-poll-workspace').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-settings-poll-editor',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page, { openSection: true });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-settings-giveaway',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Розыгрыши', '.settings-drilldown__panel--channel-giveaway');
    },
  },
  {
    name: 'channel-settings-broadcast',
    beforeShot: async (page) => {
      await page.locator('.managed-autopost-rule-card').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings-broadcast-handoff',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings-broadcast-history',
    beforeShot: async (page) => {
      await openBroadcastHistoryTab(page);
    },
  },
  {
    name: 'channel-settings-broadcast-editor',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-stats',
    beforeShot: waitForChannelStatsReady,
  },
  {
    name: 'channel-stats-24h',
    beforeShot: async (page) => {
      await page
        .getByRole('radiogroup', { name: 'Период статистики канала' })
        .getByRole('radio', { name: '24ч', exact: true })
        .click();
      await page.locator('.channel-stats-graph--continuous').first().waitFor({ state: 'visible' });
      await assertChannelStatsContinuousChart(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-stats-top-posts',
    beforeShot: async (page) => {
      const detailTarget = page.locator('.channel-top-posts-panel');
      await detailTarget.waitFor({ state: 'visible' });
      await detailTarget.evaluate((element) => {
        element.scrollIntoView({ block: 'start', behavior: 'instant' });
        const stickyBottom = Math.max(
          ...['.managed-entity-workspace-header', '.channel-insights__section-tabs'].map(
            (selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0,
          ),
        );
        window.scrollBy({ top: -stickyBottom - 12, behavior: 'instant' });
      });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-stats-publishing-windows',
    beforeShot: async (page) => {
      await page.locator('.channel-best-windows__row').first().waitFor({ state: 'visible' });
      await page
        .locator('.channel-best-windows-panel')
        .evaluate((element) => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForTimeout(150);
    },
  },
  {
    name: 'channel-events',
    beforeShot: waitForChannelEventsReady,
  },
  {
    name: 'legal-agreement',
    beforeShot: async (page) => {
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'legal-privacy',
    beforeShot: async (page) => {
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'init-missing',
    beforeShot: async (page) => {
      await page.locator('.init-missing-card').waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'giveaway-default',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'giveaway-blocked',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      try {
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 2_500 });
      } catch {
        await page.getByRole('button', { name: /Участвовать/u }).click();
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 3_000 });
      }
    },
  },
  {
    name: 'giveaway-joined',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      try {
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 2_500 });
      } catch {
        await page.getByRole('button', { name: /Участвовать/u }).click();
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 3_000 });
      }
    },
  },
  {
    name: 'giveaway-winner',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'giveaway-completed',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
];

const scenarioBehaviorByName = new Map(
  scenarioBehaviors.map((behavior) => [behavior.name, behavior]),
);

for (const name of [
  'networks',
  'networks-channels',
  'networks-statistics',
  'networks-communities',
  'networks-settings',
]) {
  scenarioBehaviorByName.set(name, {
    name,
    beforeShot: async (page) => {
      if (name === 'networks-statistics') {
        await page.locator('.network-detail-metric').first().waitFor();
      } else if (name === 'networks-communities') {
        await page.locator('.network-community-row').first().waitFor();
      } else {
        await page.locator('.network-summary-card').first().waitFor();
        if (name === 'networks-settings') {
          await page
            .locator('.network-summary-card')
            .first()
            .getByRole('button', { name: 'Настройки', exact: true })
            .click();
          await page.locator('[data-network-settings-overview]').waitFor();
        }
      }
    },
  });
}
for (const name of [
  'chat-settings-reports',
  'chat-settings-reports-journal',
  'chat-settings-retention',
]) {
  scenarioBehaviorByName.set(name, {
    name,
    beforeShot: async (page) => {
      const reports = name.includes('reports');
      await openSettingsSection(
        page,
        reports ? 'Система жалоб' : 'Удаление старых сообщений',
        reports ? '.reports-settings' : '.message-retention-settings',
      );
      if (name.endsWith('-journal')) {
        await page.getByRole('tab', { name: 'Журнал', exact: true }).click();
        await page.locator('.reports-journal__item').first().waitFor();
      }
    },
  });
}

for (const sourceName of MINIAPP_VISUAL_BOTTOM_SCENARIO_SOURCES) {
  const source = scenarioBehaviorByName.get(sourceName);
  if (!source) {
    throw new Error(`Missing source scenario behavior for bottom screenshot: ${sourceName}`);
  }
  scenarioBehaviorByName.set(`${sourceName}-bottom`, {
    name: `${sourceName}-bottom`,
    beforeShot: async (page) => {
      if (source.beforeShot) {
        await source.beforeShot(page);
      }
      if (sourceName === 'publisher-entity-modules-vk') {
        await setScrollPosition(page.locator('html'), 'bottom', 'Publisher module page');
      } else {
        await scrollSettingsDrilldownToBottom(page);
      }
    },
  });
}

const favoriteCategoriesBehavior = scenarioBehaviorByName.get('home-favorite-categories');
if (!favoriteCategoriesBehavior) {
  throw new Error('Missing source scenario behavior: home-favorite-categories');
}
scenarioBehaviorByName.set('home-favorite-categories-bottom', {
  name: 'home-favorite-categories-bottom',
  beforeShot: async (page) => {
    await favoriteCategoriesBehavior.beforeShot?.(page);
    await setScrollPosition(
      page.locator('.favorite-picker:visible .favorite-picker__panel').first(),
      'bottom',
      'Favorite categories',
    );
  },
});

const metadataNames = new Set(MINIAPP_VISUAL_SCENARIOS.map((scenario) => scenario.name));
const missingScenarioMetadata = [...scenarioBehaviorByName.keys()].filter(
  (name) => !metadataNames.has(name),
);
if (missingScenarioMetadata.length > 0) {
  throw new Error(`Missing visual scenario metadata: ${missingScenarioMetadata.join(', ')}`);
}

const scenarios = MINIAPP_VISUAL_SCENARIOS.map((metadata) => ({
  ...metadata,
  ...scenarioBehaviorByName.get(metadata.name),
}));
const scenarioByName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));

const changedFiles = resolveChangedVisualFiles();
const scenarioSelection = selectMiniappVisualScenarios({
  scenarioNames: process.env.MINIAPP_SCREENSHOT_SCENARIOS,
  changedFiles,
  preset: visualPresetName,
});
const activeScenarios = scenarioSelection.scenarios.map((scenario) =>
  scenarioByName.get(scenario.name),
);

if (activeScenarios.length === 0) {
  const detail =
    scenarioSelection.reason === 'changed-files'
      ? ` for changed files: ${scenarioSelection.changedFiles.join(', ')}`
      : '';
  throw new Error(`Visual scenario selection is empty${detail}.`);
}

function resolveChangedVisualFiles() {
  const explicitFiles = (process.env.MINIAPP_SCREENSHOT_CHANGED_FILES ?? '')
    .split(/[\n,]/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicitFiles.length > 0 || !parseEnvFlag('MINIAPP_SCREENSHOT_CHANGED')) {
    return explicitFiles;
  }

  try {
    const tracked = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMRD', 'HEAD', '--'],
      { cwd: ROOT_DIR, encoding: 'utf8' },
    );
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    return [...new Set(`${tracked}\n${untracked}`.split('\n').map((value) => value.trim()))].filter(
      Boolean,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to resolve changed files for visual selection: ${message}`);
  }
}

async function assertCommentsComposerPinned(page) {
  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.channel-dialog-shell');
    const compose = document.querySelector('.channel-dialog-compose');

    if (!(shell instanceof HTMLElement) || !(compose instanceof HTMLElement)) {
      return null;
    }

    const shellRect = shell.getBoundingClientRect();
    const composeRect = compose.getBoundingClientRect();

    return {
      shellBottom: shellRect.bottom,
      composeBottom: composeRect.bottom,
      delta: Math.abs(shellRect.bottom - composeRect.bottom),
    };
  });

  if (!layout) {
    throw new Error('Comments dialog layout nodes were not found for anchor check.');
  }

  if (layout.delta > 2) {
    throw new Error(
      `Comments composer is not pinned to the viewport bottom (delta=${layout.delta.toFixed(2)}).`,
    );
  }
}

async function assertCommentsTopEdgeCovered(page) {
  if (!nativeScreenshot) {
    return;
  }

  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell--comments-dialog');
    const screen = document.querySelector('.channel-dialog-screen--comments');
    const backdrop = document.querySelector('.channel-dialog-screen__backdrop');

    if (
      !(shell instanceof HTMLElement) ||
      !(screen instanceof HTMLElement) ||
      !(backdrop instanceof HTMLElement)
    ) {
      return null;
    }

    const shellRect = shell.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    const shellStyle = getComputedStyle(shell);
    const screenStyle = getComputedStyle(screen);

    return {
      shellTop: shellRect.top,
      screenTop: screenRect.top,
      backdropTop: backdropRect.top,
      shellPaddingTop: Number.parseFloat(shellStyle.paddingTop) || 0,
      screenPaddingTop: Number.parseFloat(screenStyle.paddingTop) || 0,
    };
  });

  if (!layout) {
    throw new Error('Comments dialog layout nodes were not found for top edge check.');
  }

  const topGap = Math.max(layout.shellTop, layout.screenTop, layout.backdropTop);
  if (topGap > 0.5 || layout.shellPaddingTop > 0.5 || layout.screenPaddingTop > 0.5) {
    throw new Error(
      [
        'Comments dialog top edge is not covered',
        `(shellTop=${layout.shellTop.toFixed(2)},`,
        `screenTop=${layout.screenTop.toFixed(2)},`,
        `backdropTop=${layout.backdropTop.toFixed(2)},`,
        `shellPaddingTop=${layout.shellPaddingTop.toFixed(2)},`,
        `screenPaddingTop=${layout.screenPaddingTop.toFixed(2)})`,
      ].join(' '),
    );
  }
}

async function assertCommentsContentTopInset(page) {
  if (!nativeScreenshot) {
    return;
  }

  const layout = await page.evaluate(() => {
    const list = document.querySelector('.channel-dialog-message-list');
    const firstContent =
      list?.querySelector('.channel-dialog-message, .channel-dialog-empty') ?? null;

    if (!(list instanceof HTMLElement) || !(firstContent instanceof HTMLElement)) {
      return null;
    }

    const listRect = list.getBoundingClientRect();
    const firstContentRect = firstContent.getBoundingClientRect();
    const listStyle = getComputedStyle(list);

    return {
      inset: firstContentRect.top - listRect.top,
      listPaddingTop: Number.parseFloat(listStyle.paddingTop) || 0,
    };
  });

  if (!layout) {
    throw new Error('Comments content nodes were not found for top inset check.');
  }

  if (layout.inset < 6 || layout.listPaddingTop < 6) {
    throw new Error(
      [
        'Comments content is too close to the top edge',
        `(inset=${layout.inset.toFixed(2)},`,
        `listPaddingTop=${layout.listPaddingTop.toFixed(2)})`,
      ].join(' '),
    );
  }
}

async function openBroadcastHistoryTab(page) {
  await page.waitForTimeout(900);
  const historyTab = page
    .locator('.broadcast-studio-shell__tabs')
    .getByRole('radio', { name: /^История/u })
    .first();
  await historyTab.waitFor({ state: 'visible', timeout: 10_000 });
  await historyTab.click();
  await historyTab.waitFor({ state: 'visible' });
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'true',
    '.broadcast-studio-shell__tabs [data-segmented-value="history"]',
  );
  await page.locator('.broadcast-history-filters').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
}

function buildPreviewUrl(baseUrl, routePath, queryDevice, scenarioSearchParams = {}, options = {}) {
  const base = new URL(baseUrl);
  const normalizedBasePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname;
  const normalizedRoutePath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  const url = new URL(base.toString());

  url.pathname = `${normalizedBasePath}${normalizedRoutePath}`;
  if (options.preview !== false) {
    url.searchParams.set('preview', '1');
    url.searchParams.set('device', queryDevice);
  }
  for (const [key, value] of Object.entries(scenarioSearchParams)) {
    if (value != null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function waitForApp(page, scenario) {
  if (scenario.preview === false) {
    await page.waitForSelector(scenario.readySelector ?? '.app-shell', { timeout: 20_000 });
    await page.waitForTimeout(500);
    return;
  }

  await page.waitForSelector('.design-preview__device', { timeout: 20_000 });
  await page.waitForSelector('.app-shell', { timeout: 20_000 });
  if (scenario.readySelector) {
    await page.waitForSelector(scenario.readySelector, { timeout: 20_000 });
  }
  await page.waitForTimeout(500);
}

async function runScenarioNavigation(page, scenario, baseUrl, profile, runtime) {
  const visited = [scenario.path];
  for (const [index, step] of (scenario.navigation ?? []).entries()) {
    const url = new URL(
      buildPreviewUrl(baseUrl, step.path, profile.queryDevice, step.searchParams, {
        preview: runtime.previewEnabled,
      }),
    );
    await page.evaluate(
      ({ pathname, search, hash, stateKey }) => {
        const previousState = window.history.state;
        const previousIndex =
          previousState && typeof previousState.idx === 'number' ? previousState.idx : 0;
        const state = {
          ...(previousState && typeof previousState === 'object' ? previousState : {}),
          idx: previousIndex + 1,
          key: stateKey,
        };
        window.history.pushState(state, '', `${pathname}${search}${hash}`);
        window.dispatchEvent(new PopStateEvent('popstate', { state }));
      },
      {
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
        stateKey: `visual-${scenario.name}-${index}`,
      },
    );
    await page.waitForFunction(
      ({ pathname, search }) =>
        window.location.pathname === pathname && window.location.search === search,
      { pathname: url.pathname, search: url.search },
    );
    await page.waitForSelector(step.readySelector, { state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(350);
    visited.push(step.path);
  }
  return visited;
}

async function applyNativeScreenshotMode(page, profile) {
  if (!nativeScreenshot) {
    return;
  }

  const state = await applyNativeVisualMode(page, profile);
  if (state?.hadPreviewScaffold && !state.previewScaffoldDetached) {
    throw new Error('Native screenshot mode did not detach the design-preview geometry.');
  }
}

async function assertMaxBridgeAbsent(page, scenario) {
  const hasBridge = await page.evaluate(() => Boolean(window.MAX?.WebApp ?? window.WebApp));
  if (hasBridge) {
    throw new Error(`Scenario ${scenario.name} must run without a MAX Bridge.`);
  }
}

async function assertFocusedLocator(locator, label) {
  const focused = await locator.evaluate((element) => element === document.activeElement);
  if (!focused) {
    throw new Error(`${label} did not receive keyboard focus.`);
  }
}

async function readLocatorViewportMetrics(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

function assertViewportMetrics(metrics, label) {
  if (
    metrics.left < -2 ||
    metrics.right > metrics.viewportWidth + 2 ||
    metrics.top < -2 ||
    metrics.bottom > metrics.viewportHeight + 2
  ) {
    throw new Error(
      `${label} is outside the simulated keyboard viewport: ` +
        `left=${metrics.left.toFixed(1)} right=${metrics.right.toFixed(1)} ` +
        `top=${metrics.top.toFixed(1)} bottom=${metrics.bottom.toFixed(1)} ` +
        `viewport=${metrics.viewportWidth}x${metrics.viewportHeight}.`,
    );
  }
}

async function assertLocatorWithinViewport(locator, label) {
  const metrics = await readLocatorViewportMetrics(locator);
  assertViewportMetrics(metrics, label);
  return metrics;
}

async function exercisePublisherComposerKeyboardFlow(page) {
  const picker = page.locator('.publication-target-picker');
  const summary = picker.locator('.publication-target-picker__summary');
  const sheet = page.locator('.publication-target-picker__editor.is-sheet');
  const search = sheet.locator('input[type="search"]');
  const done = sheet.getByRole('button', { name: 'Завершить выбор получателей' });

  if (!(await sheet.isVisible())) await summary.click();
  await sheet.waitFor({ state: 'visible' });
  await settleVisualFrame(page);
  await search.focus();
  await assertFocusedLocator(search, 'Publisher recipient search');
  await assertLocatorWithinViewport(search, 'Publisher recipient search');
  await assertLocatorWithinViewport(done, 'Publisher recipient Done button');

  await done.click();
  await sheet.waitFor({ state: 'detached' });
  await page.waitForTimeout(50);
  await assertFocusedLocator(summary, 'Publisher recipient summary after closing');

  await summary.click();
  await sheet.waitFor({ state: 'visible' });
  await settleVisualFrame(page);
  await search.focus();
  await assertFocusedLocator(search, 'Publisher recipient search after reopening');
  await assertLocatorWithinViewport(search, 'Publisher recipient search after reopening');

  await done.click();
  await sheet.waitFor({ state: 'detached' });
  await page.waitForTimeout(50);
  await assertFocusedLocator(summary, 'Publisher recipient summary after second close');

  const editor = page
    .locator('.publication-content-composer .max-rich-text-editor__surface')
    .first();
  await editor.waitFor({ state: 'visible' });
  await editor.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await editor.focus();
  await assertFocusedLocator(editor, 'Publisher rich-text editor');
  await assertLocatorWithinViewport(editor, 'Publisher rich-text editor');
}

async function exercisePublisherAutoReplyEditorKeyboardFlow(page) {
  const editor = page.locator('.publisher-auto-reply-editor');
  await editor.waitFor({ state: 'visible' });
  const textEditor = editor.getByRole('textbox', {
    name: 'Текст автоответа',
    exact: true,
  });
  await textEditor.waitFor({ state: 'visible' });
  await textEditor.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await textEditor.focus();
  await assertFocusedLocator(textEditor, 'Auto-reply text editor');
  await assertLocatorWithinViewport(textEditor, 'Auto-reply text editor');
}

async function exercisePublisherButtonsKeyboardFlow(page) {
  const sheet = page.locator('.publication-buttons-sheet');
  await sheet.waitFor({ state: 'visible' });
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();
  const done = sheet.getByRole('button', { name: 'Готово', exact: true });
  await name.waitFor({ state: 'visible' });
  await url.waitFor({ state: 'visible' });
  await name.evaluate((element) =>
    element.scrollIntoView({ block: 'nearest', behavior: 'instant' }),
  );
  await name.focus();
  await assertFocusedLocator(name, 'Publisher button name');
  await assertLocatorWithinViewport(name, 'Publisher button name');
  await assertLocatorWithinViewport(url, 'Publisher button URL');
  await assertLocatorWithinViewport(done, 'Publisher button Done action');
}

async function exercisePublisherButtonsReducedKeyboardFlow(page) {
  const sheet = page.locator('.publication-buttons-sheet');
  const trigger = page
    .locator('.publication-content-composer')
    .getByRole('button', { name: /кнопк/iu })
    .first();
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();

  await name.focus();
  await assertFocusedLocator(name, 'Publisher button name before focus handoff');
  await url.focus();
  await assertFocusedLocator(url, 'Publisher button URL after focus handoff');
  await page.waitForFunction(() =>
    document.querySelector('.publications-page.is-editor')?.classList.contains('is-keyboard-open'),
  );

  await page.keyboard.press('Escape');
  await waitForPublisherButtonsSheetClosed(page, sheet);
  await assertFocusedLocator(trigger, 'Publisher button trigger after keyboard close');
  await page.waitForFunction(() =>
    document.querySelector('.publications-page.is-editor')?.classList.contains('is-keyboard-open'),
  );

  await trigger.click();
  await sheet.waitFor({ state: 'visible' });
  const reopenedName = sheet.getByLabel('Название', { exact: true }).first();
  const reopenedUrl = sheet.getByLabel('Ссылка', { exact: true }).first();
  await reopenedName.waitFor({ state: 'visible' });
  await reopenedUrl.waitFor({ state: 'visible' });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  await reopenedName.focus();
  await assertFocusedLocator(reopenedName, 'Publisher button name after keyboard reopening');
  await reopenedUrl.focus();
  await assertFocusedLocator(reopenedUrl, 'Publisher button URL after keyboard reopening');
}

async function assertPublisherButtonsKeyboardFinalLayout(page) {
  const sheet = page.locator('.publication-buttons-sheet');
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();
  const done = sheet.getByRole('button', { name: 'Готово', exact: true });
  const nameMetrics = await assertLocatorWithinViewport(name, 'Publisher button name after reflow');
  const urlMetrics = await assertLocatorWithinViewport(url, 'Publisher button URL after reflow');
  const doneMetrics = await readLocatorViewportMetrics(done);
  const frame = await sheet.evaluate((element) => {
    const panel = element.querySelector('.publication-buttons-sheet__panel');
    const footer = element.querySelector('.publication-buttons-sheet__footer');
    const toRect = (target) => {
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      const rect = target.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const sheetStyle = getComputedStyle(element);
    const panelStyle = panel instanceof HTMLElement ? getComputedStyle(panel) : null;
    return {
      keyboardOpen: document.documentElement.dataset.maxKeyboardOpen === 'true',
      appViewportHeight: rootStyle.getPropertyValue('--app-viewport-height').trim(),
      visualViewportTop: rootStyle.getPropertyValue('--app-visual-viewport-top').trim(),
      sheet: toRect(element),
      panel: toRect(panel),
      footer: toRect(footer),
      sheetHeight: sheetStyle.height,
      sheetPadding: sheetStyle.padding,
      sheetAlignItems: sheetStyle.alignItems,
      panelHeight: panelStyle?.height ?? null,
      panelMarginTop: panelStyle?.marginTop ?? null,
    };
  });
  const bottomClearance = doneMetrics.viewportHeight - doneMetrics.bottom;
  if (bottomClearance < 8) {
    throw new Error(
      'Publisher button Done action is clipped or flush with the keyboard viewport ' +
        `(bottom=${doneMetrics.bottom.toFixed(1)}, viewport=${doneMetrics.viewportHeight}, ` +
        `clearance=${bottomClearance.toFixed(1)}px, frame=${JSON.stringify(frame)}).`,
    );
  }
  assertViewportMetrics(doneMetrics, 'Publisher button Done action after reflow');
  return {
    nameTop: nameMetrics.top,
    urlBottom: urlMetrics.bottom,
    doneBottom: doneMetrics.bottom,
    bottomClearance,
    frame,
  };
}

async function simulateKeyboardViewport(page, scenario) {
  if (!shouldSimulateKeyboardScenario(scenario)) {
    return null;
  }

  if (screenshotTarget === 'smartphone') {
    const keyboardProfile = resolveKeyboardScenarioProfile(scenario);
    const field = page
      .locator(
        keyboardProfile?.focusSelector ??
          'input[type="search"]:visible, textarea:visible, [contenteditable="true"]:visible, input[type="text"]:visible',
      )
      .first();
    if (!(await field.count()))
      throw new Error(`No editable field for keyboard scenario ${scenario.name}`);
    await field.click();
    await page.waitForTimeout(200);
    const platform = await page.evaluate(() => document.documentElement.dataset.maxPlatform);
    const mode =
      process.env.MINIAPP_SCREENSHOT_KEYBOARD_MODE || (platform === 'ios' ? 'visual' : 'resize');
    let geometry;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      geometry = await setPhoneKeyboard(page, { height: normalizedKeyboardOverlapPx, mode });
      await page.waitForTimeout(260);
      if (cycle < 2) {
        await setPhoneKeyboard(page, { mode, open: false });
        await page.waitForTimeout(260);
      }
    }
    return {
      ...geometry,
      cycles: 3,
      focus: keyboardProfile?.focusReport ?? (await field.getAttribute('aria-label')),
      simulated: true,
    };
  }

  const keyboardProfile = resolveKeyboardScenarioProfile(scenario);

  await page.addStyleTag({
    content: `
      html[data-max-keyboard-open='true'] .bottom-nav {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: translate(-50%, calc(100% + var(--space-6, 32px) + var(--app-keyboard-overlap, 0px))) !important;
      }
    `,
  });

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error(`Scenario ${scenario.name} has no viewport geometry for keyboard simulation.`);
  }
  const maximumReducedHeight = viewport.height - KEYBOARD_MIN_REDUCTION_PX;
  const orientationSafeMinimumHeight = Math.max(
    KEYBOARD_MIN_VISIBLE_HEIGHT_PX,
    viewport.height > viewport.width ? viewport.width + 1 : 0,
  );
  if (orientationSafeMinimumHeight > maximumReducedHeight) {
    throw new Error(
      `Scenario ${scenario.name} cannot preserve viewport orientation while simulating a keyboard ` +
        `in ${viewport.width}x${viewport.height}.`,
    );
  }
  const reducedHeight = Math.min(
    maximumReducedHeight,
    Math.max(orientationSafeMinimumHeight, viewport.height - normalizedKeyboardOverlapPx),
  );
  if (reducedHeight <= 0 || reducedHeight >= viewport.height) {
    throw new Error(
      `Scenario ${scenario.name} cannot reduce viewport ${viewport.width}x${viewport.height} ` +
        `for keyboard overlap ${normalizedKeyboardOverlapPx}px.`,
    );
  }

  if (keyboardProfile?.flow === 'publisher-composer') {
    await exercisePublisherComposerKeyboardFlow(page);
  } else if (keyboardProfile?.flow === 'publisher-buttons') {
    await exercisePublisherButtonsKeyboardFlow(page);
  } else if (keyboardProfile?.flow === 'publisher-auto-reply-editor') {
    await exercisePublisherAutoReplyEditorKeyboardFlow(page);
  }

  const cycles = keyboardProfile?.flow === 'publisher-composer' ? 3 : 1;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await page.setViewportSize({ width: viewport.width, height: reducedHeight });
    await page.waitForFunction(
      (expectedHeight) => Math.abs(window.innerHeight - expectedHeight) <= 1,
      reducedHeight,
    );
    await page.waitForTimeout(180);
    if (cycle === 0 && keyboardProfile?.flow === 'publisher-buttons') {
      await exercisePublisherButtonsReducedKeyboardFlow(page);
    }
    if (keyboardProfile?.focusSelector) {
      await page
        .locator(keyboardProfile.focusSelector)
        .first()
        .evaluate((element) => {
          element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        });
    }
    if (cycle < cycles - 1) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForFunction(
        (expectedHeight) => Math.abs(window.innerHeight - expectedHeight) <= 1,
        viewport.height,
      );
      await page.waitForTimeout(180);
      if (keyboardProfile?.focusSelector) {
        await assertFocusedLocator(
          page.locator(keyboardProfile.focusSelector).first(),
          `${keyboardProfile.focusLabel} after keyboard cycle ${cycle + 1}`,
        );
      }
      if (keyboardProfile?.flow === 'publisher-composer') {
        await page.waitForFunction(
          () =>
            !document
              .querySelector('.publications-page.is-editor')
              ?.classList.contains('is-keyboard-open'),
        );
        const actionDisplay = await page
          .locator('.publications-page.is-editor > .publications-publish-bar')
          .evaluate((element) => getComputedStyle(element).display);
        if (actionDisplay === 'none') {
          throw new Error(`Publisher action did not return after keyboard cycle ${cycle + 1}.`);
        }
      }
    }
  }

  await page.evaluate(
    ({ forceKeyboardFlag, originalHeight, viewportHeight }) => {
      const root = document.documentElement;
      if (forceKeyboardFlag) {
        root.setAttribute('data-max-keyboard-open', 'true');
      } else {
        root.removeAttribute('data-max-keyboard-open');
      }
      root.dataset.visualKeyboardOriginalHeight = String(originalHeight);
      root.dataset.visualKeyboardViewportHeight = String(viewportHeight);
    },
    {
      forceKeyboardFlag:
        keyboardProfile === null || keyboardProfile.flow === 'publisher-auto-reply-editor',
      originalHeight: viewport.height,
      viewportHeight: reducedHeight,
    },
  );
  await page.waitForTimeout(260);

  const controls =
    keyboardProfile?.flow === 'publisher-buttons'
      ? await assertPublisherButtonsKeyboardFinalLayout(page)
      : null;

  return {
    originalHeight: viewport.height,
    viewportHeight: reducedHeight,
    coveredHeight: viewport.height - reducedHeight,
    cycles,
    focus: keyboardProfile?.focusReport ?? null,
    ...(controls ? { controls } : {}),
  };
}

async function assertConfiguredChecks(page, scenario) {
  if (strictLayout) {
    await assertAppHasVisibleContent(page, scenario);
    await assertViewportBounds(page, scenario);
    await assertNoUnexpectedHorizontalOverflow(page, scenario);
    await assertPublisherEditorFullBleed(page, scenario);
    await assertPublisherComposerViewportAction(page, scenario);
    await assertVkSourceSummariesSeparated(page, scenario);
    await assertFavoriteCategoryIndicatorsContained(page, scenario);
    await assertCompactTextContained(page, scenario);
    await assertSettingsOverviewNavigation(page, scenario);
    await assertPrimaryControlsReachable(page, scenario);
    await assertTimeFieldOptionsReachable(page, scenario);
    await assertChartsPainted(page, scenario);
    await assertKeyboardState(page, scenario);
  }

  if (strictContrast) {
    await assertCriticalContrast(page, scenario);
    await assertSettingsDrilldownScrollContrast(page, scenario);
  }

  if (strictAccessibility) {
    await assertCriticalAccessibility(page, scenario);
    await assertModerationTouchTargets(page, scenario);
    await assertPublicationTouchTargets(page, scenario);
  }
}

async function assertCompactTextContained(page, scenario) {
  const clipped = await page.evaluate(() => {
    for (const label of document.querySelectorAll(
      '.settings-mode-segments .segmented-control__item > span, .channel-summary-card--compact > strong, .channel-summary-table th, .channel-summary-table td, .channel-audience-metric b, .channel-audience-metric small, .channel-audience-metric em',
    )) {
      const control = label.closest('button') ?? label;
      if (!control || !label.getClientRects().length) continue;
      const bounds = control.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      const range = document.createRange();
      range.selectNodeContents(label);
      if (
        [...range.getClientRects()].some(
          (rect) =>
            rect.left < bounds.left - 2 ||
            rect.right > bounds.right + 2 ||
            rect.top < bounds.top - 2 ||
            rect.bottom > bounds.bottom + 2,
        )
      ) {
        return label.textContent?.trim() || 'unnamed option';
      }
    }
    if (document.body.dataset.miniappProfile === 'moderation') {
      for (const header of document.querySelectorAll(
        '.managed-entity-workspace-header:not(.managed-entity-workspace-header--settings)',
      )) {
        const title = header.querySelector('.compact-page-header__title')?.getBoundingClientRect();
        const actions = header
          .querySelector('.compact-page-header__aside')
          ?.getBoundingClientRect();
        if (title?.width && actions?.width && title.right > actions.left - 2) {
          return 'statistics title overlaps its header actions';
        }
      }
      for (const card of document.querySelectorAll('.events-screen .membership-feed__card')) {
        const avatar = card.querySelector('.membership-feed__avatar')?.getBoundingClientRect();
        const name = card.querySelector('.membership-feed__name-link')?.getBoundingClientRect();
        if (avatar?.width && name?.width && name.left < avatar.right + 3)
          return 'event avatar overlaps its participant name';
      }
      for (const label of document.querySelectorAll('.channel-stats-graph__axis-text')) {
        const canvas = label.closest('.channel-stats-graph__canvas');
        if (!canvas || getComputedStyle(canvas).overflowX === 'visible') continue;
        const bounds = canvas.getBoundingClientRect();
        const text = label.getBoundingClientRect();
        if (text.left < bounds.left - 1 || text.right > bounds.right + 1) {
          return `chart axis label "${label.textContent?.trim()}" is clipped by its canvas`;
        }
      }
    }
    return null;
  });
  if (clipped) throw new Error(`Scenario ${scenario.name} clips compact UI text: ${clipped}`);
}

async function assertSettingsOverviewNavigation(page, scenario) {
  if (await page.evaluate(() => innerWidth > 600)) return;
  const violations = await page
    .locator(
      '.settings-section__toggle, .publisher-module-entry, .publisher-comments-toggle, [data-settings-navigation-entry="true"]',
    )
    .evaluateAll((entries) =>
      entries.flatMap((entry) => {
        const title = entry.querySelector(
          '.settings-section__title, .publisher-entity-module__copy > strong, :scope > strong',
        );
        const text = (value) => value?.replace(/\s+/gu, ' ').trim() ?? '';
        const expected = text(title?.textContent);
        const action = entry.matches('button, a') ? entry : entry.querySelector('button, a');
        if (entry.getAttribute('data-settings-navigation-entry') !== 'true')
          return [
            { title: expected, reason: 'the catalog entry is missing its navigation contract' },
          ];
        if (!expected || text(entry.textContent) !== expected)
          return [
            { title: expected, reason: 'the navigation entry contains text besides its title' },
          ];
        if (
          entry.querySelector(
            '.settings-section__summary, .settings-section__status-chip, .settings-section__state, .settings-section__state-label, .settings-advertising-soon__badge, small, [role="status"]',
          )
        )
          return [
            {
              title: expected,
              reason: 'the navigation entry retains summary, count or state markup',
            },
          ];
        if (
          !action ||
          (action.getAttribute('aria-label') && action.getAttribute('aria-label') !== expected) ||
          action.hasAttribute('aria-describedby')
        )
          return [
            { title: expected, reason: 'the accessible navigation name contains extra context' },
          ];
        if (
          [...entry.querySelectorAll('svg')].some((icon) => !icon.closest('[aria-hidden="true"]'))
        )
          return [{ title: expected, reason: 'navigation icons must be decorative' }];
        return [];
      }),
    );
  if (violations.length) {
    throw new Error(
      `Scenario ${scenario.name} has noisy settings navigation: ${JSON.stringify(violations)}`,
    );
  }
}

async function assertPublisherEditorFullBleed(page, scenario) {
  if (!scenario.name.startsWith('publications-publisher-compose')) {
    return;
  }

  const result = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell:has(.publications-page.is-editor)');
    const pageRoot = document.querySelector('.publications-page.is-publisher.is-editor');
    const header = pageRoot?.querySelector('.publications-editor-header');
    if (
      !(shell instanceof HTMLElement) ||
      !(pageRoot instanceof HTMLElement) ||
      !(header instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'publisher editor shell is missing' };
    }

    const shellStyle = getComputedStyle(shell);
    const pageRect = pageRoot.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const tolerance = 2;
    const expectedInset = window.innerWidth >= 768 ? Math.max(0, (window.innerWidth - 800) / 2) : 0;
    if (
      Math.abs(pageRect.left - expectedInset) > tolerance ||
      Math.abs(pageRect.right - (window.innerWidth - expectedInset)) > tolerance ||
      Math.abs(pageRect.top) > tolerance ||
      Math.abs(headerRect.top) > tolerance
    ) {
      return {
        ok: false,
        reason:
          `editor is inset (page=${pageRect.left.toFixed(1)},${pageRect.top.toFixed(1)},` +
          `${pageRect.right.toFixed(1)} headerTop=${headerRect.top.toFixed(1)} ` +
          `viewport=${window.innerWidth}x${window.innerHeight})`,
      };
    }
    if (
      Number.parseFloat(shellStyle.paddingTop) > tolerance ||
      Number.parseFloat(shellStyle.paddingLeft) > tolerance ||
      Number.parseFloat(shellStyle.paddingRight) > tolerance
    ) {
      return {
        ok: false,
        reason: `shell keeps padding ${shellStyle.padding}`,
      };
    }
    return { ok: true, reason: '' };
  });

  if (!result.ok) {
    throw new Error(`Publisher editor full-bleed layout failed: ${result.reason}.`);
  }
}

async function assertPublisherComposerViewportAction(page, scenario) {
  if (
    !scenario.name.startsWith('publications-publisher-compose') ||
    shouldSimulateKeyboardScenario(scenario)
  ) {
    return;
  }

  const result = await page.evaluate(
    (requireNoScroll) => {
      const editor = document.querySelector('.publications-page.is-editor > .publications-editor');
      const dock = document.querySelector(
        '.publications-page.is-editor > .publications-publish-bar',
      );
      if (!(editor instanceof HTMLElement) || !(dock instanceof HTMLElement)) {
        return { ok: false, reason: 'editor or viewport action is missing' };
      }

      const dockRect = dock.getBoundingClientRect();
      const dockStyle = getComputedStyle(dock);
      const previous = dock.previousElementSibling;
      const previousRect =
        previous instanceof HTMLElement ? previous.getBoundingClientRect() : null;
      const previewScreen = document.querySelector('.design-preview__device-screen');
      const viewportBottom =
        previewScreen instanceof HTMLElement
          ? previewScreen.getBoundingClientRect().bottom
          : window.innerHeight;
      if (dockStyle.position !== 'static') {
        return { ok: false, reason: `action uses overlay position ${dockStyle.position}` };
      }
      if (previousRect && previousRect.bottom > dockRect.top + 1) {
        return {
          ok: false,
          reason: `content bottom ${previousRect.bottom.toFixed(1)} crosses action top ${dockRect.top.toFixed(1)}`,
        };
      }
      if (dockRect.bottom > viewportBottom + 2) {
        return {
          ok: false,
          reason: `viewport action bottom ${dockRect.bottom.toFixed(1)} leaves viewport ${viewportBottom.toFixed(1)}`,
        };
      }
      if (requireNoScroll && editor.scrollHeight > editor.clientHeight + 2) {
        return {
          ok: false,
          reason:
            `default editor scrolls despite a tall viewport ` +
            `(scroll=${editor.scrollHeight}, client=${editor.clientHeight})`,
        };
      }
      if (requireNoScroll && viewportBottom - dockRect.bottom > 16) {
        return {
          ok: false,
          reason: `default editor leaves ${Math.round(viewportBottom - dockRect.bottom)}px unused below action`,
        };
      }
      return { ok: true, reason: '' };
    },
    scenario.name === 'publications-publisher-compose-selected' &&
      (page.viewportSize()?.height ?? 0) >= 800,
  );

  if (!result.ok) {
    throw new Error(`Publisher composer action layout failed: ${result.reason}.`);
  }
}

async function assertVkSourceSummariesSeparated(page, scenario) {
  if (!scenario.name.startsWith('publisher-entity-modules-vk')) {
    return;
  }

  const issues = await page.evaluate(() => {
    const tolerance = 0.5;
    const overlaps = (left, right) =>
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > tolerance &&
      Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > tolerance;
    const isContained = (inner, outer) =>
      inner.left >= outer.left - tolerance &&
      inner.top >= outer.top - tolerance &&
      inner.right <= outer.right + tolerance &&
      inner.bottom <= outer.bottom + tolerance;

    return Array.from(document.querySelectorAll('.vk-parsing-workspace .vk-source-card')).flatMap(
      (card, cardIndex) => {
        if (!(card instanceof HTMLElement)) {
          return [];
        }

        const summary = card.querySelector('.vk-source-card__summary-row');
        if (summary instanceof HTMLElement && summary.querySelector('.vk-workflow-status')) {
          const parts = [...summary.children].filter((element) => element instanceof HTMLElement);
          for (let index = 0; index < parts.length; index += 1) {
            const part = parts[index];
            if (
              !isContained(part.getBoundingClientRect(), summary.getBoundingClientRect()) ||
              part.scrollWidth > part.clientWidth + 1
            )
              return [{ cardIndex, reason: 'source summary text is clipped' }];
            if (
              parts
                .slice(index + 1)
                .some((other) =>
                  overlaps(part.getBoundingClientRect(), other.getBoundingClientRect()),
                )
            )
              return [{ cardIndex, reason: 'summary controls overlap' }];
          }
          return [];
        }
        const mode = summary?.querySelector('.vk-source-mode-control');
        const metrics = summary?.querySelector('.vk-source-card__metrics');
        if (
          !(summary instanceof HTMLElement) ||
          !(mode instanceof HTMLElement) ||
          !(metrics instanceof HTMLElement)
        ) {
          return [{ cardIndex, reason: 'summary controls are missing' }];
        }

        const summaryRect = summary.getBoundingClientRect();
        const modeRect = mode.getBoundingClientRect();
        const metricsRect = metrics.getBoundingClientRect();
        const controls = [...mode.children, ...metrics.children].filter(
          (element) => element instanceof HTMLElement,
        );
        const textNodes = [
          ...mode.querySelectorAll('button'),
          ...metrics.querySelectorAll('b, small'),
        ];
        const title =
          card.querySelector('.vk-source-card__title strong')?.textContent?.trim() ?? '';

        if (!isContained(modeRect, summaryRect) || !isContained(metricsRect, summaryRect)) {
          return [{ cardIndex, title, reason: 'summary group leaves its row' }];
        }

        if (overlaps(modeRect, metricsRect)) {
          return [{ cardIndex, title, reason: 'mode and metrics overlap' }];
        }

        for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
          const left = controls[leftIndex];
          if (!(left instanceof HTMLElement)) {
            continue;
          }
          for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
            const right = controls[rightIndex];
            if (
              right instanceof HTMLElement &&
              overlaps(left.getBoundingClientRect(), right.getBoundingClientRect())
            ) {
              return [{ cardIndex, title, reason: 'summary controls overlap' }];
            }
          }
        }

        const clippedText = textNodes.find(
          (element) =>
            element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1,
        );
        if (clippedText instanceof HTMLElement) {
          return [
            {
              cardIndex,
              title,
              reason: `summary text is clipped: ${clippedText.textContent?.trim() ?? ''}`,
            },
          ];
        }

        if (card.clientWidth <= 432 && modeRect.bottom > metricsRect.top + tolerance) {
          return [{ cardIndex, title, reason: 'narrow summary is not vertically separated' }];
        }

        return [];
      },
    );
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has an invalid VK source summary at card ${first.cardIndex}` +
        `${first.title ? ` (${first.title})` : ''}: ${first.reason}.`,
    );
  }
}

async function assertFavoriteCategoryIndicatorsContained(page, scenario) {
  const issues = await page.evaluate(() => {
    const tolerance = 0.5;
    const isContained = (inner, outer) =>
      inner.left >= outer.left - tolerance &&
      inner.top >= outer.top - tolerance &&
      inner.right <= outer.right + tolerance &&
      inner.bottom <= outer.bottom + tolerance;
    const overlaps = (first, second) =>
      Math.min(first.right, second.right) - Math.max(first.left, second.left) > tolerance &&
      Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > tolerance;
    const size = (rect) => `${rect.width.toFixed(1)}x${rect.height.toFixed(1)}`;

    return Array.from(document.querySelectorAll('.chat-card__action--favorite')).flatMap(
      (action, index) => {
        if (!(action instanceof HTMLElement)) {
          return [{ index, reason: 'favorite action is missing' }];
        }

        const card = action.closest('.chat-card');
        const marks = action.querySelectorAll('.chat-card__favorite-mark');
        const symbols = action.querySelectorAll('svg');
        const mark = marks[0];
        const symbol = symbols[0];
        if (
          !(card instanceof HTMLElement) ||
          marks.length !== 1 ||
          !(mark instanceof HTMLElement) ||
          symbols.length !== 1 ||
          !(symbol instanceof SVGElement) ||
          !symbol.classList.contains('chat-card__favorite-symbol') ||
          !mark.contains(symbol)
        ) {
          return [
            { index, reason: 'favorite must contain exactly one visible symbol in its mark' },
          ];
        }

        const identity = card.querySelector('.chat-card__primary-link');
        const row = card.querySelector('.chat-card__row-actions');
        const settings = row?.querySelector('.chat-card__action--settings');
        const statistics = row?.querySelector('.chat-card__action--statistics');
        const identityUrl =
          identity instanceof HTMLAnchorElement ? new URL(identity.href) : null;
        const settingsUrl =
          settings instanceof HTMLAnchorElement ? new URL(settings.href) : null;
        const entityType = identityUrl?.pathname.match(/\/(chat|channel)\/[^/]+\/settings$/u)?.[1];
        if (
          !(identity instanceof HTMLAnchorElement) ||
          !(row instanceof HTMLElement) ||
          !(settings instanceof HTMLAnchorElement) ||
          !(statistics instanceof HTMLAnchorElement) ||
          identity.contains(row) ||
          identity.contains(action) ||
          settings.contains(statistics) ||
          statistics.contains(settings) ||
          identity.dataset.action !== 'settings' ||
          settings.dataset.action !== 'settings' ||
          statistics.dataset.action !== 'statistics' ||
          !entityType ||
          settingsUrl?.origin !== identityUrl?.origin ||
          settingsUrl?.pathname !== identityUrl?.pathname ||
          settingsUrl?.searchParams.get('focus') === 'storefront' ||
          settings.textContent?.trim() !== 'Настройки' ||
          !settings
            .getAttribute('aria-label')
            ?.startsWith('Открыть настройки: ') ||
          !statistics.textContent?.includes('Статистика')
        ) {
          return [
            { index, reason: 'card needs separate identity, favorite and labeled action links' },
          ];
        }

        const cardRect = card.getBoundingClientRect();
        const actionRect = action.getBoundingClientRect();
        const markRect = mark.getBoundingClientRect();
        const symbolRect = symbol.getBoundingClientRect();
        const identityRect = identity.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const settingsRect = settings.getBoundingClientRect();
        const statisticsRect = statistics.getBoundingClientRect();
        const symbolStyle = getComputedStyle(symbol);
        const touchTargets = [identityRect, actionRect, settingsRect, statisticsRect];
        const favoriteGap = actionRect.left - identityRect.right;
        const rowGap = rowRect.top - Math.max(identityRect.bottom, actionRect.bottom);
        const failures = [];
        if (
          touchTargets.some((rect) => rect.width < 44 - tolerance || rect.height < 44 - tolerance)
        ) {
          failures.push('touch target is smaller than 44px');
        }
        if (
          symbolRect.width <= 0 ||
          symbolRect.height <= 0 ||
          symbolStyle.visibility === 'hidden' ||
          Number.parseFloat(symbolStyle.opacity) === 0 ||
          !isContained(markRect, actionRect) ||
          !isContained(symbolRect, markRect) ||
          ![...touchTargets, rowRect].every((rect) => isContained(rect, cardRect))
        ) {
          failures.push('symbol or control is clipped outside its container');
        }
        if (
          favoriteGap < 5.5 ||
          rowGap < -tolerance ||
          overlaps(settingsRect, statisticsRect) ||
          overlaps(actionRect, rowRect)
        ) {
          failures.push('favorite overlaps the identity or actions are not separated below it');
        }
        if (
          identity.scrollWidth > identity.clientWidth + 1 ||
          row.scrollWidth > row.clientWidth + 1
        ) {
          failures.push('identity or action row overflows horizontally');
        }
        if (failures.length === 0) {
          return [];
        }
        return [
          {
            index,
            reason: failures.join('; '),
            sizes: {
              card: size(cardRect),
              identity: size(identityRect),
              favorite: size(actionRect),
              mark: size(markRect),
              symbol: size(symbolRect),
              settings: size(settingsRect),
              statistics: size(statisticsRect),
            },
            favoriteGap: favoriteGap.toFixed(1),
            rowGap: rowGap.toFixed(1),
          },
        ];
      },
    );
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has an invalid home card at index ${first.index}: ` +
        `${first.reason}` +
        (first.sizes
          ? ` (${JSON.stringify(first.sizes)}, favoriteGap=${first.favoriteGap}, rowGap=${first.rowGap})`
          : ''),
    );
  }
}

async function assertTimeFieldOptionsReachable(page, scenario) {
  const issues = await page.evaluate(async () => {
    const optionLists = Array.from(document.querySelectorAll('.time-field-sheet__options')).filter(
      (element) => element instanceof HTMLElement,
    );

    if (optionLists.length === 0) {
      return [];
    }

    for (const optionList of optionLists) {
      optionList.scrollTop = optionList.scrollHeight;
    }

    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const actionsRect = document
      .querySelector('.time-field-sheet__actions')
      ?.getBoundingClientRect();

    return optionLists.flatMap((optionList) => {
      const lastOption = optionList.lastElementChild;
      if (!(lastOption instanceof HTMLElement)) {
        return [{ reason: 'missing-last-option' }];
      }

      const listRect = optionList.getBoundingClientRect();
      const optionRect = lastOption.getBoundingClientRect();
      const reachesScrollEnd =
        Math.abs(optionList.scrollTop - (optionList.scrollHeight - optionList.clientHeight)) <= 1;
      const insideList = optionRect.bottom <= listRect.bottom + 1;
      const clearOfActions = !actionsRect || optionRect.bottom <= actionsRect.top + 1;

      return reachesScrollEnd && insideList && clearOfActions
        ? []
        : [
            {
              reason: 'last-option-obscured',
              scrollTop: optionList.scrollTop,
              maxScrollTop: optionList.scrollHeight - optionList.clientHeight,
              optionBottom: optionRect.bottom,
              listBottom: listRect.bottom,
              actionsTop: actionsRect?.top ?? null,
            },
          ];
    });
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has an unreachable final time option: ${JSON.stringify(first)}.`,
    );
  }
}

async function assertSettingsDrilldownScrollContrast(page, scenario) {
  if (!strictContrast) {
    return;
  }

  const scrollTargets = [
    {
      label: 'favorite picker',
      locator: page.locator('.favorite-picker:visible .favorite-picker__panel').first(),
    },
    {
      label: 'settings drilldown',
      locator: page.locator('.settings-drilldown:visible .settings-drilldown__body').first(),
    },
    {
      label: 'bot message editor',
      locator: page
        .locator('.bot-message-editor-sheet:visible .bot-message-editor-sheet__body')
        .first(),
    },
    {
      label: 'broadcast audience',
      locator: page
        .locator('.broadcast-audience-sheet:visible .broadcast-audience-sheet__scroll')
        .first(),
    },
    {
      label: 'giveaway modal',
      locator: page
        .locator('.managed-giveaway-modal:visible .managed-giveaway-modal__sheet')
        .first(),
    },
    {
      label: 'publication actions',
      locator: page.locator('.publication-action-menu:visible .publication-action-menu__actions'),
    },
    {
      label: 'publication details',
      locator: page.locator('.publication-details-sheet:visible .publication-details-sheet__body'),
    },
    {
      label: 'publication retry',
      locator: page.locator('.publication-retry-sheet:visible .publication-retry-sheet__panel'),
    },
  ];

  for (const target of scrollTargets) {
    if ((await target.locator.count()) === 0) {
      continue;
    }
    const initial = await target.locator.evaluate((element) => ({
      clientHeight: element.clientHeight,
      maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
      scrollTop: element.scrollTop,
    }));
    if (initial.maxScrollTop <= 1 || initial.clientHeight <= 1) {
      continue;
    }

    const step = Math.max(1, Math.floor(initial.clientHeight * 0.72));
    const positions = [];
    for (let top = 0; top < initial.maxScrollTop; top += step) {
      positions.push(top);
    }
    positions.push(initial.maxScrollTop);

    try {
      for (const top of positions) {
        await setScrollPosition(target.locator, top, target.label);
        await assertCriticalContrast(page, {
          ...scenario,
          name: `${scenario.name} at ${target.label} scroll ${top}/${initial.maxScrollTop}`,
        });
      }
    } finally {
      await setScrollPosition(target.locator, initial.scrollTop, target.label);
    }
  }
}

async function assertCriticalContrast(page, scenario) {
  if (!strictContrast) {
    return;
  }

  const issues = await page.evaluate(() => {
    const scopeSelectors = [
      '.publisher-entities-page',
      '.publisher-entity-modules-page',
      '.publisher-auto-replies-page',
      '.publisher-auto-reply-editor',
      '.publication-target-picker__editor',
      '.publication-buttons-sheet',
      '.publications-page',
      '.publication-details-sheet',
      '.publication-action-menu',
      '.publication-retry-sheet',
      '.chats-page',
      '.chats-home',
      '.favorite-picker',
      '.settings-sections',
      '.channel-settings-screen',
      '.channel-settings-card',
      '.settings-drilldown',
      '.settings-apply-target',
      'body[data-miniapp-profile="moderation"] .action-confirm-sheet',
      '.bot-message-editor-sheet',
      '.broadcast-audience-sheet',
      '.managed-poll-workspace',
      '.events-screen',
      '.membership-activity-feed',
      '.chat-participants-roster',
      '.participant-sheet',
      '.spammer-review-sheet',
      '.spammer-diagnostics-sheet',
      '.channel-stats-page',
      'body[data-miniapp-profile="moderation"] .channel-insights',
    ];

    const colorCanvas = document.createElement('canvas');
    colorCanvas.width = 1;
    colorCanvas.height = 1;
    const colorContext = colorCanvas.getContext('2d', { willReadFrequently: true });
    const colorCache = new Map();
    const parseColor = (value) => {
      const match = value
        .trim()
        .match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/iu);
      if (!match) {
        if (!colorContext || !CSS.supports('color', value)) return null;
        if (colorCache.has(value)) return colorCache.get(value);
        colorContext.clearRect(0, 0, 1, 1);
        colorContext.fillStyle = value;
        colorContext.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = colorContext.getImageData(0, 0, 1, 1).data;
        const color = { red, green, blue, alpha: alpha / 255 };
        colorCache.set(value, color);
        return color;
      }
      return {
        red: Number(match[1]),
        green: Number(match[2]),
        blue: Number(match[3]),
        alpha: match[4] == null ? 1 : Number(match[4]),
      };
    };
    const composite = (foreground, background) => {
      const alpha = Math.max(0, Math.min(1, foreground.alpha));
      return {
        red: foreground.red * alpha + background.red * (1 - alpha),
        green: foreground.green * alpha + background.green * (1 - alpha),
        blue: foreground.blue * alpha + background.blue * (1 - alpha),
        alpha: 1,
      };
    };
    const luminance = (color) => {
      const linearize = (channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return (
        0.2126 * linearize(color.red) +
        0.7152 * linearize(color.green) +
        0.0722 * linearize(color.blue)
      );
    };
    const contrast = (foreground, background) => {
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      const light = Math.max(foregroundLuminance, backgroundLuminance);
      const dark = Math.min(foregroundLuminance, backgroundLuminance);
      return (light + 0.05) / (dark + 0.05);
    };
    const firstBackgroundImageColor = (value) => {
      if (!value || value === 'none') {
        return null;
      }
      const match = value.match(/(?:rgba?|color|oklch|oklab|lch|lab)\([^)]*\)/iu);
      return match ? parseColor(match[0]) : null;
    };
    const effectiveBackground = (element) => {
      const lineage = [];
      let current = element;
      while (current instanceof HTMLElement) {
        lineage.unshift(current);
        current = current.parentElement;
      }
      let result = { red: 255, green: 255, blue: 255, alpha: 1 };
      for (const node of lineage) {
        const style = getComputedStyle(node);
        const backgroundColor = parseColor(style.backgroundColor);
        if (backgroundColor && backgroundColor.alpha > 0.01) {
          result = composite(backgroundColor, result);
        }
        const imageColor = firstBackgroundImageColor(style.backgroundImage);
        if (imageColor && imageColor.alpha > 0.01) {
          result = composite(imageColor, result);
        }
      }
      return result;
    };
    const hasDirectText = (element) =>
      Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05
      );
    };

    const roots = scopeSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    const candidates = Array.from(
      new Set(roots.flatMap((root) => [root, ...root.querySelectorAll('*')])),
    ).filter(
      (element) =>
        element instanceof HTMLElement &&
        hasDirectText(element) &&
        isVisible(element) &&
        !element.closest('[disabled], [aria-disabled="true"], [aria-hidden="true"]'),
    );

    return candidates
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const foreground = parseColor(style.color);
        if (!foreground || foreground.alpha <= 0.05) {
          return [];
        }
        const background = effectiveBackground(element);
        const renderedForeground = composite(foreground, background);
        const ratio = contrast(renderedForeground, background);
        const fontSize = Number.parseFloat(style.fontSize) || 16;
        const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
        const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
        const requiredRatio = isLarge ? 3 : 4.5;
        if (ratio + 0.05 >= requiredRatio) {
          return [];
        }
        return [
          {
            tagName: element.tagName,
            className: element.className?.toString() ?? '',
            text: element.innerText.replace(/\s+/gu, ' ').trim().slice(0, 80),
            ratio,
            requiredRatio,
          },
        ];
      })
      .slice(0, 5);
  });

  if (issues.length > 0) {
    const summary = issues
      .map(
        (issue) =>
          `${issue.tagName}.${issue.className}: ${issue.ratio.toFixed(2)} < ` +
          `${issue.requiredRatio.toFixed(1)} ("${issue.text}")`,
      )
      .join('; ');
    throw new Error(`Scenario ${scenario.name} has insufficient text contrast at ${summary}.`);
  }
}

async function assertCriticalAccessibility(page, scenario) {
  if (!strictAccessibility) {
    return;
  }

  const issues = await page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05
      );
    };
    const accessibleName = (element) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (label) {
          return label;
        }
      }
      const ariaLabel = element.getAttribute('aria-label')?.trim();
      if (ariaLabel) {
        return ariaLabel;
      }
      if (element instanceof HTMLInputElement && element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label?.textContent?.trim()) {
          return label.textContent.trim();
        }
      }
      if (element.closest('label')?.textContent?.trim()) {
        return element.closest('label').textContent.trim();
      }
      if (
        element instanceof HTMLElement &&
        element.matches('button, summary, a[href], [role="button"], [role="tab"], [role="switch"]')
      ) {
        return element.textContent?.trim() ?? '';
      }
      return '';
    };
    const problems = [];

    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (dialog instanceof HTMLElement && isVisible(dialog) && !accessibleName(dialog)) {
        problems.push({ type: 'unnamed dialog', target: dialog.className || dialog.id });
      }
    }

    for (const control of document.querySelectorAll(
      'button, summary, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"]',
    )) {
      if (!(control instanceof HTMLElement) || !isVisible(control)) {
        continue;
      }
      if (!accessibleName(control)) {
        problems.push({ type: 'unnamed control', target: control.className || control.id });
      }
    }

    return problems.slice(0, 5);
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has accessibility issue: ${first.type} (${first.target}).`,
    );
  }
}

async function assertModerationTouchTargets(page, scenario) {
  const issues = await page.evaluate(() => {
    if (document.body.dataset.miniappProfile !== 'moderation') return [];
    const selectors = [
      '.settings-info-button',
      '.settings-native-switch',
      '.settings-mode-segments button',
      '.settings-word-banlist__segments button',
      '.participant-sheet__action',
      '.participant-sheet__actions button',
      '.action-confirm-sheet__button',
      '.settings-drilldown__close',
    ];
    return selectors
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          rect.width <= 1 ||
          rect.height <= 1 ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0.05 ||
          (rect.width + 0.5 >= 44 && rect.height + 0.5 >= 44)
        )
          return [];
        return [{ target: element.className, width: rect.width, height: rect.height }];
      })
      .slice(0, 5);
  });
  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has a moderation touch target below 44px: ` +
        `${first.target} (${first.width.toFixed(1)}x${first.height.toFixed(1)}).`,
    );
  }
}

async function assertPublicationTouchTargets(page, scenario) {
  if (!strictAccessibility) {
    return;
  }

  const issues = await page.evaluate(() => {
    if (!document.querySelector('.publications-page')) {
      return [];
    }

    const selectors = [
      '.publications-page .publications-tabs button',
      '.publications-page .publications-filterbar button',
      '.publications-page .publications-filterbar select',
      '.publications-page .publications-load-more',
      '.publications-page .publication-retained-media button',
      '.publications-page .publications-inline-notice button',
      '.publications-page .publications-calendar-error button',
      '.publications-page .publication-target-chip button',
      '.publications-page .publication-weekdays button',
      '.publications-page .publication-recurrence__times > div > button',
      '.publications-page .publication-content-composer .broadcast-content-composer__tool',
      '.publications-page .publication-content-composer .broadcast-content-composer__button-label',
      '.publications-page .publication-content-composer .broadcast-content-composer__modifier',
      '.publications-page .publication-content-composer .broadcast-message-card__media-remove',
      '.publications-page .broadcast-publish-bar__issue',
      '.legacy-publications-tabs button',
      '.legacy-publications-filterbar button',
      '.legacy-publications-filterbar select',
      '.publication-action-menu button',
      '.publication-details-sheet button',
      '.publication-retry-sheet button',
      '.action-confirm-sheet button',
      '.toast__close',
      '.broadcast-buttons-sheet__close',
      '.broadcast-buttons-sheet__empty-action',
      '.publication-buttons-sheet button',
      '.publication-buttons-sheet input',
    ];
    const controls = Array.from(
      new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))),
    );
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05
      );
    };

    return controls
      .flatMap((element) => {
        if (!(element instanceof HTMLElement) || !isVisible(element)) {
          return [];
        }
        const rect = element.getBoundingClientRect();
        if (rect.width + 0.5 >= 44 && rect.height + 0.5 >= 44) {
          return [];
        }
        return [
          {
            target: element.className?.toString() || element.tagName,
            width: rect.width,
            height: rect.height,
          },
        ];
      })
      .slice(0, 5);
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has a publication touch target below 44px: ` +
        `${first.target} (${first.width.toFixed(1)}x${first.height.toFixed(1)}).`,
    );
  }
}

async function assertAppHasVisibleContent(page, scenario) {
  const content = await page.evaluate(() => {
    const root =
      document.querySelector('.design-preview__device-screen') ??
      document.querySelector('.app-shell') ??
      document.body;
    if (!(root instanceof HTMLElement)) {
      return null;
    }

    const visibleText = root.innerText.replace(/\s+/gu, ' ').trim();
    const visibleElements = Array.from(
      root.querySelectorAll('button, a, input, textarea, canvas, svg, img, [role="button"]'),
    ).filter((element) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number.parseFloat(style.opacity || '1') > 0.01
      );
    }).length;

    return {
      textLength: visibleText.length,
      visibleElements,
    };
  });

  if (!content || (content.textLength < 20 && content.visibleElements < 3)) {
    throw new Error(
      `Scenario ${scenario.name} looks blank (text=${content?.textLength ?? 0}, elements=${
        content?.visibleElements ?? 0
      }).`,
    );
  }
}

async function assertViewportBounds(page, scenario) {
  const issues = await page.evaluate((keyboardMode) => {
    const previewScreen = document.querySelector('.design-preview__device-screen');
    const previewRect =
      previewScreen instanceof HTMLElement ? previewScreen.getBoundingClientRect() : null;
    const hasPreviewBounds = Boolean(
      previewRect && previewRect.width > 1 && previewRect.height > 1,
    );
    const viewportLeft = hasPreviewBounds ? previewRect.left : 0;
    const viewportTop = hasPreviewBounds ? previewRect.top : 0;
    const viewportRight = hasPreviewBounds ? previewRect.right : window.innerWidth;
    const viewportBottom = hasPreviewBounds ? previewRect.bottom : window.innerHeight;
    const viewportWidth = viewportRight - viewportLeft;
    const viewportHeight = viewportBottom - viewportTop;
    const selectors = [
      '.app-shell:not(.app-shell--immersive)',
      keyboardMode ? null : '.bottom-nav:not(.is-keyboard-open)',
      '.shell-topbar',
      '.settings-drilldown',
      '.broadcast-buttons-sheet__panel',
      '.broadcast-planner-sheet__panel',
      '.time-field-sheet',
      '.channel-dialog-screen',
      '.channel-dialog-compose__surface',
      '.giveaway-page__overlay-card',
      '.init-missing-card',
    ];

    return selectors.filter(Boolean).flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).flatMap((element) => {
        if (!(element instanceof HTMLElement)) {
          return [];
        }
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0.01
        ) {
          return [];
        }

        const rect = element.getBoundingClientRect();
        const allowScrolledTop =
          selector === '.app-shell:not(.app-shell--immersive)' ||
          (style.position !== 'fixed' && style.position !== 'sticky');
        const topTolerance = selector === '.channel-dialog-screen' ? 12 : 2;
        const problem =
          rect.left < viewportLeft - 2 ||
          rect.right > viewportRight + 2 ||
          (!allowScrolledTop && rect.top < viewportTop - topTolerance) ||
          rect.top > viewportBottom + 2;
        return problem
          ? [
              {
                selector,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                viewportWidth,
                viewportHeight,
              },
            ]
          : [];
      }),
    );
  }, shouldSimulateKeyboardScenario(scenario));

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has viewport-bound issue at ${first.selector}: ` +
        `left=${first.left.toFixed(1)} right=${first.right.toFixed(1)} top=${first.top.toFixed(
          1,
        )} viewport=${first.viewportWidth}x${first.viewportHeight}.`,
    );
  }
}

async function assertNoUnexpectedHorizontalOverflow(page, scenario) {
  const overflow = await page.evaluate(() => {
    const root =
      document.querySelector('.design-preview__device-screen') ??
      document.querySelector('.app-shell') ??
      document.documentElement;
    if (!(root instanceof HTMLElement)) {
      return null;
    }

    const allowedOverflowSelectors = [
      '.broadcast-planner',
      '.channel-stats-graph',
      '.channel-insights',
      '.channel-dialog-messages',
      '.vk-parsing-feed',
      '.settings-drilldown',
      '[data-allow-horizontal-overflow]',
    ];

    const rootOverflow = root.scrollWidth - root.clientWidth;
    const offenders = Array.from(root.querySelectorAll('*')).flatMap((element) => {
      if (!(element instanceof HTMLElement)) {
        return [];
      }
      if (allowedOverflowSelectors.some((selector) => element.closest(selector))) {
        return [];
      }

      const style = getComputedStyle(element);
      if (
        !element.checkVisibility({ checkVisibilityCSS: true }) ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity || '1') <= 0.01
      ) {
        return [];
      }

      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) {
        return [];
      }

      const rootRect = root.getBoundingClientRect();
      const overflowLeft = rootRect.left - rect.left;
      const overflowRight = rect.right - rootRect.right;
      if (overflowLeft > 3 || overflowRight > 3) {
        return [
          {
            className: element.className?.toString() ?? element.tagName,
            tagName: element.tagName,
            overflowLeft,
            overflowRight,
          },
        ];
      }

      return [];
    });

    return {
      rootOverflow,
      offenders: offenders.slice(0, 3),
    };
  });

  if (!overflow) {
    return;
  }

  if (overflow.rootOverflow > 4 || overflow.offenders.length > 0) {
    const first = overflow.offenders[0];
    throw new Error(
      `Scenario ${scenario.name} has horizontal overflow: root=${overflow.rootOverflow}px` +
        (first
          ? `, first=${first.tagName}.${first.className} left=${first.overflowLeft.toFixed(
              1,
            )} right=${first.overflowRight.toFixed(1)}`
          : ''),
    );
  }
}

async function assertPrimaryControlsReachable(page, scenario) {
  const issues = await page.evaluate((keyboardMode) => {
    const previewScreen = document.querySelector('.design-preview__device-screen');
    const previewRect =
      previewScreen instanceof HTMLElement ? previewScreen.getBoundingClientRect() : null;
    const hasPreviewBounds = Boolean(
      previewRect && previewRect.width > 1 && previewRect.height > 1,
    );
    const viewportBottom = hasPreviewBounds ? previewRect.bottom : window.innerHeight;
    const viewportHeight = hasPreviewBounds ? previewRect.height : window.innerHeight;
    const hasActiveOverlay = Boolean(
      document.querySelector(
        '.broadcast-buttons-sheet__panel, .broadcast-planner-sheet__panel, .time-field-sheet, .giveaway-page__overlay-card, .publication-drafts-sheet__panel, .publication-review-sheet .action-confirm-sheet__panel',
      ),
    );
    const selectors = [
      keyboardMode || hasActiveOverlay ? null : '.bottom-nav:not(.is-keyboard-open)',
      '.channel-dialog-compose__surface',
      hasActiveOverlay ? null : '.settings-drilldown__footer',
      '.broadcast-buttons-sheet__panel',
      '.broadcast-planner-sheet__panel',
      '.time-field-sheet',
      '.publication-drafts-sheet__panel',
      '.publication-review-sheet .action-confirm-sheet__actions',
    ];

    return selectors.filter(Boolean).flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).flatMap((element) => {
        if (!(element instanceof HTMLElement)) {
          return [];
        }
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0.01
        ) {
          return [];
        }

        const rect = element.getBoundingClientRect();
        return rect.bottom > viewportBottom + 2
          ? [
              {
                selector,
                bottom: rect.bottom,
                viewportHeight,
              },
            ]
          : [];
      }),
    );
  }, shouldSimulateKeyboardScenario(scenario));

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has unreachable primary control ${first.selector}: ` +
        `bottom=${first.bottom.toFixed(1)} viewport=${first.viewportHeight}.`,
    );
  }
}

async function assertChartsPainted(page, scenario) {
  if (!scenario.name.includes('stats')) {
    return;
  }

  const painted = await page.evaluate(() => {
    const chart =
      document.querySelector('.channel-stats-graph__bar') ??
      document.querySelector('.channel-stats-graph svg') ??
      document.querySelector('canvas');
    if (
      !(
        chart instanceof HTMLElement ||
        chart instanceof SVGElement ||
        chart instanceof HTMLCanvasElement
      )
    ) {
      return false;
    }

    const rect = chart.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) {
      return false;
    }

    if (chart instanceof HTMLCanvasElement) {
      const context = chart.getContext('2d');
      if (!context) {
        return false;
      }
      const sampleWidth = Math.min(chart.width, 64);
      const sampleHeight = Math.min(chart.height, 64);
      const data = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) {
          return true;
        }
      }
      return false;
    }

    return true;
  });

  if (!painted) {
    throw new Error(`Scenario ${scenario.name} did not render a visible chart/graph element.`);
  }
}

async function assertChannelStatsContinuousChart(page) {
  const result = await page.evaluate(() => {
    const chart = document.querySelector('.channel-stats-graph--continuous');
    if (!chart) {
      return { ok: false, reason: 'continuous chart class is missing' };
    }

    const lineDots = chart.querySelectorAll('.channel-stats-graph__dot').length;
    const eventDots = chart.querySelectorAll('.channel-stats-graph__event-dot').length;
    const flowDots = chart.querySelectorAll('.channel-stats-graph__flow-knot').length;
    const labels = chart.querySelectorAll('.channel-stats-graph__labels small').length;
    if (lineDots > 0 || eventDots > 0 || flowDots > 0 || labels > 0) {
      return {
        ok: false,
        reason: `unexpected hourly markers: line=${lineDots}, event=${eventDots}, flow=${flowDots}, labels=${labels}`,
      };
    }

    return { ok: true, reason: '' };
  });

  if (!result.ok) {
    throw new Error(`24h channel stats chart marker assertion failed: ${result.reason}`);
  }
}

async function assertKeyboardState(page, scenario) {
  if (screenshotTarget === 'smartphone' && shouldSimulateKeyboardScenario(scenario)) {
    const state = await page.evaluate(() => {
      const viewport = visualViewport;
      const focused = document.activeElement;
      const rect = focused?.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const bottom = top + (viewport?.height ?? innerHeight);
      const nav = document.querySelector('.bottom-nav');
      const style = nav ? getComputedStyle(nav) : null;
      const navRect = nav?.getBoundingClientRect();
      return {
        focused: focused?.matches('input, textarea, [contenteditable="true"]'),
        reachable: Boolean(rect && rect.top >= top - 1 && rect.bottom <= bottom + 1),
        navVisible: Boolean(
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0.05 &&
          navRect.bottom > top &&
          navRect.top < bottom,
        ),
        geometry: { top, bottom, focusedTop: rect?.top, focusedBottom: rect?.bottom },
      };
    });
    if (!state.focused || !state.reachable || state.navVisible) {
      throw new Error(
        `Smartphone keyboard layout failed without test CSS overrides: ${JSON.stringify(state)}`,
      );
    }
    return;
  }
  if (
    !shouldSimulateKeyboardScenario(scenario) ||
    scenario.preview === false ||
    scenario.name.includes('dialog')
  ) {
    return;
  }

  const keyboardProfile = resolveKeyboardScenarioProfile(scenario);
  const requiresRootKeyboardFlag =
    !keyboardProfile || keyboardProfile.flow === 'publisher-auto-reply-editor';
  const state = await page.evaluate((profile) => {
    const root = document.documentElement;
    const nav = document.querySelector('.bottom-nav');
    const navStyle = nav instanceof HTMLElement ? getComputedStyle(nav) : null;
    const active = document.activeElement;
    const activeRect = active instanceof HTMLElement ? active.getBoundingClientRect() : null;
    const publishBar = profile?.actionBarSelector
      ? document.querySelector(profile.actionBarSelector)
      : null;
    const publishBarStyle = publishBar instanceof HTMLElement ? getComputedStyle(publishBar) : null;
    const publishBarVisible = Boolean(
      publishBar instanceof HTMLElement &&
      publishBarStyle &&
      publishBarStyle.display !== 'none' &&
      publishBarStyle.visibility !== 'hidden' &&
      Number.parseFloat(publishBarStyle.opacity || '1') > 0.01,
    );
    const publishBarRect =
      publishBarVisible && publishBar instanceof HTMLElement
        ? publishBar.getBoundingClientRect()
        : null;
    const primary =
      publishBar && profile?.primarySelector
        ? publishBar.querySelector(profile.primarySelector)
        : null;

    return {
      keyboardOpen: root.dataset.maxKeyboardOpen === 'true',
      pageKeyboardOpen: Boolean(
        document.querySelector('.publications-page.is-editor.is-keyboard-open'),
      ),
      originalHeight: Number.parseInt(root.dataset.visualKeyboardOriginalHeight ?? '', 10),
      expectedViewportHeight: Number.parseInt(root.dataset.visualKeyboardViewportHeight ?? '', 10),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      nav:
        nav instanceof HTMLElement && navStyle
          ? {
              opacity: Number.parseFloat(navStyle.opacity || '1'),
              pointerEvents: navStyle.pointerEvents,
            }
          : null,
      activeMatchesPublisherEditor:
        active instanceof HTMLElement &&
        Boolean(profile?.focusSelector) &&
        active.matches(profile.focusSelector),
      activeRect: activeRect
        ? {
            top: activeRect.top,
            bottom: activeRect.bottom,
            left: activeRect.left,
            right: activeRect.right,
          }
        : null,
      publishBarRect: publishBarRect
        ? {
            top: publishBarRect.top,
            bottom: publishBarRect.bottom,
          }
        : null,
      primaryFits:
        primary instanceof HTMLElement
          ? primary.scrollWidth <= primary.clientWidth + 2
          : profile === null,
      pickerSheetOpen: Boolean(
        profile?.pickerSheetSelector && document.querySelector(profile.pickerSheetSelector),
      ),
    };
  }, keyboardProfile);

  if (
    (requiresRootKeyboardFlag && !state.keyboardOpen) ||
    !Number.isFinite(state.originalHeight) ||
    !Number.isFinite(state.expectedViewportHeight) ||
    state.expectedViewportHeight >= state.originalHeight ||
    Math.abs(state.viewportHeight - state.expectedViewportHeight) > 1
  ) {
    throw new Error(
      `Scenario ${scenario.name} did not apply reduced keyboard geometry ` +
        `(keyboardOpen=${state.keyboardOpen}, original=${state.originalHeight}, ` +
        `expected=${state.expectedViewportHeight}, actual=${state.viewportHeight}).`,
    );
  }

  if (state.nav && (state.nav.opacity > 0.05 || state.nav.pointerEvents !== 'none')) {
    throw new Error(
      `Scenario ${scenario.name} keyboard simulation did not hide bottom nav ` +
        `(opacity=${state.nav.opacity}, pointerEvents=${state.nav.pointerEvents}).`,
    );
  }

  if (keyboardProfile?.expectPageKeyboardState && !state.pageKeyboardOpen) {
    throw new Error(`${scenario.name} did not expose its real adjustResize keyboard state.`);
  }

  if (!keyboardProfile) {
    return;
  }

  if (!state.activeMatchesPublisherEditor || !state.activeRect) {
    throw new Error(keyboardProfile.focusFailure);
  }
  if (
    state.activeRect.left < -2 ||
    state.activeRect.right > state.viewportWidth + 2 ||
    state.activeRect.top < -2 ||
    state.activeRect.bottom > state.viewportHeight + 2
  ) {
    throw new Error(
      `${keyboardProfile.focusLabel} is unreachable with keyboard open ` +
        `(top=${state.activeRect.top.toFixed(1)}, bottom=${state.activeRect.bottom.toFixed(1)}, ` +
        `viewport=${state.viewportHeight}).`,
    );
  }
  if (
    state.publishBarRect &&
    ((!keyboardProfile.allowActionBelowViewport &&
      state.publishBarRect.bottom > state.viewportHeight + 2) ||
      (state.publishBarRect.top < state.viewportHeight &&
        state.activeRect.bottom > state.publishBarRect.top + 1))
  ) {
    throw new Error(
      `${keyboardProfile.actionBarLabel} overlaps the focused editor or leaves the keyboard viewport ` +
        `(editorBottom=${state.activeRect.bottom.toFixed(1)}, ` +
        `barTop=${state.publishBarRect.top.toFixed(1)}, ` +
        `barBottom=${state.publishBarRect.bottom.toFixed(1)}, viewport=${state.viewportHeight}).`,
    );
  }
  if (!state.primaryFits) {
    throw new Error(keyboardProfile.primaryFailure);
  }
  if (state.pickerSheetOpen) {
    throw new Error(keyboardProfile.pickerFailure ?? 'Keyboard flow left an overlay open.');
  }
}

function resolveScreenshotLocator(page) {
  if (nativeScreenshot) {
    return null;
  }

  if (screenshotTarget === 'page') {
    return null;
  }

  if (screenshotTarget === 'screen') {
    return page.locator('.design-preview__device-screen');
  }

  return page.locator('.design-preview__device');
}

async function installDeterministicExternalScripts(context) {
  await context.route(
    /^https:\/\/major-maksimov\.ru\/app\/(favicon|apple-touch-icon)\.png(?:\?.*)?$/u,
    async (route) => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1);
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: await readFile(path.join(ROOT_DIR, 'apps/miniapp/public', name)),
      });
    },
  );
  await context.route(/https:\/\/st\.max\.ru\/js\/max-web-app\.js(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: '/* MAX Bridge is supplied by the visual harness when the scenario enables it. */',
    });
  });
  await context.route(/\/system\/miniapp-boot-trace(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '{"accepted":true}',
    });
  });
}

function attachPageDiagnostics(page, scenario) {
  const failures = [];

  page.on('pageerror', (error) => {
    failures.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console.error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown network error';
    failures.push(`requestfailed: ${request.method()} ${request.url()} (${failure})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failures.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });

  return {
    assertClean() {
      if (failures.length === 0) {
        return;
      }

      throw new Error(
        `Scenario ${scenario.name} emitted browser/network errors:\n${failures
          .slice(0, 8)
          .map((failure) => `- ${failure}`)
          .join('\n')}`,
      );
    },
  };
}

function assertNavigationResponse(response, scenario, url) {
  if (!response) {
    throw new Error(`Scenario ${scenario.name} did not receive an HTTP response for ${url}.`);
  }
  if (response.status() >= 400) {
    throw new Error(
      `Scenario ${scenario.name} navigation failed with HTTP ${response.status()}: ${url}`,
    );
  }
}

async function captureDeviceScenarios(browser, capture, baseUrl, outputDir, report, reportPath) {
  const { profile } = capture;

  const shotDir = path.join(outputDir, profile.outputDirName);
  await ensureDir(shotDir);

  for (const scenario of activeScenarios) {
    const startedAt = Date.now();
    const reportEntry = {
      name: scenario.name,
      device: profile.outputDirName,
      routeId: scenario.routeId,
      features: scenario.features,
      tags: scenario.tags,
      cold: scenario.cold,
      navigation: [],
      status: 'running',
      browser: capture.browserName,
      browserVersion: browser.version(),
      phone: capture.phone,
    };
    report.scenarios.push(reportEntry);
    const runtime = resolveScenarioRuntime(scenario, maxBridgeShimEnabled);
    let context = null;
    let page = null;

    try {
      context = await browser.newContext({
        ...capture.contextOptions,
        colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
      });
      await installDeterministicExternalScripts(context);
      if (nativeScreenshot) {
        await installNativeVisualModeInitScript(context);
      }
      if (runtime.bridgeEnabled) {
        await installMaxBridgeShimInitScript(context, profile, {
          colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
          startParam: process.env.MINIAPP_SCREENSHOT_START_PARAM?.trim() || '',
          version: process.env.MINIAPP_SCREENSHOT_MAX_VERSION?.trim() || '',
        });
      }

      page = await context.newPage();
      await page.clock.setFixedTime(visualNow);
      const diagnostics = attachPageDiagnostics(page, scenario);
      const url = buildPreviewUrl(
        baseUrl,
        scenario.path,
        profile.queryDevice,
        scenario.searchParams,
        {
          preview: runtime.previewEnabled,
        },
      );
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      assertNavigationResponse(response, scenario, url);
      await waitForApp(page, scenario);
      if (runtime.bridgeEnabled) {
        await assertMaxBridgeShim(page);
      } else if (scenario.maxBridge === false) {
        await assertMaxBridgeAbsent(page, scenario);
      }
      await applyNativeScreenshotMode(page, profile);
      reportEntry.navigation = await runScenarioNavigation(
        page,
        scenario,
        baseUrl,
        profile,
        runtime,
      );

      if (scenario.beforeShot) {
        await scenario.beforeShot(page, profile);
      }

      // Scenario flows can reload the document and restore the preview scaffold.
      await applyNativeScreenshotMode(page, profile);
      await page.evaluate(() => document.fonts.ready.then(() => true));
      const keyboardGeometry = await simulateKeyboardViewport(page, scenario);
      if (keyboardGeometry) {
        reportEntry.keyboard = keyboardGeometry;
      }
      await settleVisualFrame(page);
      // External SVG symbols must be loaded; empty buttons can otherwise pass layout checks.
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('svg.app-icon')].every((icon) => {
            if (!icon.getBoundingClientRect().width) return true;
            const bounds = icon.getBBox();
            return bounds.width > 0 || bounds.height > 0;
          }),
        null,
        { timeout: 10_000 },
      );

      if (scenario.name.includes('dialog-comments')) {
        await assertCommentsTopEdgeCovered(page);
        await assertCommentsContentTopInset(page);
      }

      await assertConfiguredChecks(page, scenario);

      if (resolveKeyboardScenarioProfile(scenario)?.flow === 'publisher-buttons') {
        await page.waitForTimeout(220);
        const controls = await assertPublisherButtonsKeyboardFinalLayout(page);
        if (reportEntry.keyboard) {
          reportEntry.keyboard.controls = controls;
        }
      }

      const screenshotPath = path.join(shotDir, `${scenario.name}.png`);
      if (nativeScreenshot && (await page.locator('.design-preview').count())) {
        throw new Error('Native screenshot cannot include restored design-preview geometry.');
      }
      const locator = resolveScreenshotLocator(page);
      let screenshotImage;

      if (scenario.name === 'publisher-entities-error') {
        await page
          .locator('.publisher-entities-page__state.has-error[role="alert"]')
          .waitFor({ state: 'visible' });
      }

      if (locator) {
        screenshotImage = await locator.screenshot({
          path: screenshotPath,
          animations: 'disabled',
          timeout: 120_000,
        });
      } else {
        screenshotImage = await page.screenshot({
          path: screenshotPath,
          animations: 'disabled',
          timeout: 120_000,
          fullPage: screenshotTarget === 'page',
        });
      }

      reportEntry.screenshot = path.relative(ROOT_DIR, screenshotPath);
      reportEntry.geometry = await readCaptureGeometry(page);
      if (capture.phone) {
        const phonePath = path.join(shotDir, `${scenario.name}-phone.png`);
        await capturePhoneScreenshot(browser, page, capture, phonePath, {
          theme: colorScheme,
          title: scenario.searchParams?.profile === 'publisher' ? 'Публик' : 'Майор Максимов',
          keyboard: reportEntry.keyboard,
          imageBuffer: screenshotImage,
        });
        reportEntry.phoneScreenshot = path.relative(ROOT_DIR, phonePath);
      }
      if (scenario.afterShot) {
        await scenario.afterShot(page);
      }
      diagnostics.assertClean();
      reportEntry.status = 'passed';
    } catch (error) {
      reportEntry.status = 'failed';
      reportEntry.error = error instanceof Error ? error.message : String(error);
      if (page && !page.isClosed()) {
        try {
          const failurePath = path.join(shotDir, `${scenario.name}-failed.png`);
          const failureImage = await page.screenshot({ path: failurePath, timeout: 10_000 });
          reportEntry.screenshot = path.relative(ROOT_DIR, failurePath);
          reportEntry.geometry = await readCaptureGeometry(page);
          if (capture.phone) {
            const phonePath = path.join(shotDir, `${scenario.name}-failed-phone.png`);
            await capturePhoneScreenshot(browser, page, capture, phonePath, {
              theme: colorScheme,
              keyboard: reportEntry.keyboard,
              imageBuffer: failureImage,
            });
            reportEntry.phoneScreenshot = path.relative(ROOT_DIR, phonePath);
          }
        } catch (diagnosticError) {
          reportEntry.diagnosticError = String(diagnosticError);
        }
      }
      console.error(`${profile.outputDirName}/${scenario.name}: ${reportEntry.error}`);
      if (!continueOnFailure) throw error;
    } finally {
      reportEntry.durationMs = Date.now() - startedAt;
      await context?.close();
      report.heartbeatAt = new Date().toISOString();
      if (reportEntry.status === 'passed') report.lastSuccessfulSampleAt = report.heartbeatAt;
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`[visual] ${profile.outputDirName}/${scenario.name}: ${reportEntry.status}`);
    }
  }
}

async function main() {
  const requestedDevice =
    process.env.MINIAPP_SCREENSHOT_DEVICE?.trim().toLowerCase() ?? visualPreset?.device ?? 'all';
  let baseUrl = resolveMiniappScreenshotBaseUrl();
  if (
    isLocalMiniappBaseUrl(baseUrl) &&
    !reuseServer &&
    !process.env.MINIAPP_SCREENSHOT_BASE_URL?.trim()
  ) {
    baseUrl = await allocateMiniappBaseUrl(baseUrl);
  }
  const outputDir = path.join(OUTPUT_ROOT, timestamp);
  const reportPath = process.env.MINIAPP_SCREENSHOT_REPORT_PATH?.trim()
    ? path.resolve(process.cwd(), process.env.MINIAPP_SCREENSHOT_REPORT_PATH.trim())
    : path.join(outputDir, 'report.json');
  const deviceKeys =
    requestedDevice === 'all'
      ? Object.keys(deviceProfiles)
      : Object.keys(deviceProfiles).filter((key) => key === requestedDevice);

  if (deviceKeys.length === 0) {
    throw new Error('MINIAPP_SCREENSHOT_DEVICE must be one of: android, iphone, iphone-se, all');
  }

  await ensureDir(outputDir);
  await ensureDir(path.dirname(reportPath));

  const report = {
    schemaVersion: 2,
    status: 'running',
    baseUrl,
    source: isLocalMiniappBaseUrl(baseUrl) ? 'local' : 'remote',
    target: screenshotTarget,
    colorScheme,
    fixedNow: visualNow.toISOString(),
    simulation:
      screenshotTarget === 'smartphone'
        ? {
            hostChrome:
              'Approximation; calibrate MINIAPP_PHONE_METRICS_PATH against a real device.',
            keyboard: 'Simulated viewport events, not a native OS keyboard.',
            data: 'Deterministic preview fixtures; not production data.',
          }
        : null,
    selection: {
      reason: scenarioSelection.reason,
      preset: visualPresetName || null,
      changedFiles: scenarioSelection.changedFiles,
      scenarios: activeScenarios.map((scenario) => scenario.name),
      devices: deviceKeys,
    },
    checks: {
      layout: strictLayout,
      contrast: strictContrast,
      accessibility: strictAccessibility,
    },
    startedAt: new Date().toISOString(),
    scenarios: [],
  };

  const browsers = new Map();
  let devServerProcess = null;
  let reportWritePromise = null;

  const cleanup = async () => {
    for (const browser of browsers.values()) await browser.close();
    browsers.clear();
    await stopChildProcess(devServerProcess);
    devServerProcess = null;
  };

  const writeReport = () => {
    reportWritePromise ??= (async () => {
      report.finishedAt = new Date().toISOString();
      report.durationMs =
        new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    })();
    return reportWritePromise;
  };

  const handleSignal = (signal) => {
    report.status = 'cancelled';
    report.error = `Received ${signal}`;
    void cleanup()
      .finally(writeReport)
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    if (isLocalMiniappBaseUrl(baseUrl)) {
      if (reuseServer) {
        await waitForMiniappUrl(baseUrl);
      } else {
        devServerProcess = await ensureMiniappDevServer(baseUrl, { log: console.log });
      }
    }

    console.log(
      `Mini app screenshot source: ${baseUrl} (${isLocalMiniappBaseUrl(baseUrl) ? 'local' : 'explicit remote'})`,
    );

    for (const key of deviceKeys) {
      const capture = resolveCaptureDevice(deviceProfiles[key], {
        target: screenshotTarget,
        engine: process.env.MINIAPP_SCREENSHOT_BROWSER,
        metrics: phoneMetrics,
      });
      let browser = browsers.get(capture.browserName);
      if (!browser) {
        try {
          browser = await { chromium, webkit }[capture.browserName].launch(
            captureBrowserLaunchOptions(capture.browserName, baseUrl),
          );
        } catch (error) {
          throw new Error(
            `Cannot launch ${capture.browserName}. Install it with npx playwright install --with-deps ${capture.browserName}. ${error.message}`,
          );
        }
        browsers.set(capture.browserName, browser);
      }
      await captureDeviceScenarios(browser, capture, baseUrl, outputDir, report, reportPath);
    }
    const failures = report.scenarios.filter((scenario) => scenario.status === 'failed');
    if (failures.length)
      throw new Error(`${failures.length} visual scenarios failed. See ${reportPath}`);
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanup();
    await writeReport();
  }

  console.log(`Screenshots saved to ${outputDir}`);
  console.log(`Visual report saved to ${reportPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
