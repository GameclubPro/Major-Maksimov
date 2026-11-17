import assert from 'node:assert/strict';

const PANEL = '.settings-drilldown__panel--stop-words';
async function reopen(page) {
  await page.getByRole('button', { name: 'Стоп-слова', exact: true }).click();
  await page.locator(PANEL).waitFor({ state: 'visible' });
}
async function save(page) {
  await page
    .locator(PANEL)
    .getByRole('button', { name: 'Сохранить в этом чате', exact: true })
    .click();
  await page.locator(PANEL).waitFor({ state: 'hidden' });
}

export async function assertStopWordsEditorFlow(page) {
  const panel = page.locator(PANEL);
  const wordsList = panel.getByLabel('Список слов и фраз', { exact: true });
  const input = panel.getByRole('textbox', { name: 'Добавить слова и фразы', exact: true });
  const phrase = 'доход без вложений';
  await input.fill(phrase);
  await panel
    .locator('.stop-words-editor__preview-values')
    .getByText(phrase, { exact: true })
    .waitFor();
  const pendingTester = panel
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Проверка сообщения' }) });
  await pendingTester.locator('summary').click();
  await pendingTester.getByRole('textbox', { name: 'Сообщение для проверки' }).fill(phrase);
  assert.equal(
    await pendingTester.getByRole('button', { name: 'Проверить', exact: true }).isDisabled(),
    true,
    'Message preview must wait until the input buffer is added to the draft list',
  );
  await panel.getByRole('button', { name: 'Сохранить в этом чате', exact: true }).click();
  assert.equal(await input.inputValue(), phrase);
  assert.equal(await wordsList.getByText(phrase, { exact: true }).count(), 0);
  await panel.getByRole('button', { name: 'Добавить записи', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  await pendingTester.getByRole('button', { name: 'Проверить', exact: true }).click();
  await pendingTester.locator('mark').getByText(phrase, { exact: true }).waitFor();
  await save(page);
  await reopen(page);
  await panel.locator('.stop-words-editor__value').getByText(phrase, { exact: true }).waitFor();
  await input.fill('новыймаркер, и/в');
  assert.equal(
    await panel.getByRole('button', { name: 'Добавить записи', exact: true }).isDisabled(),
    true,
  );
  await panel.getByRole('button', { name: 'Сохранить в этом чате', exact: true }).click();
  assert.equal(await input.inputValue(), 'новыймаркер, и/в');
  assert.equal(
    await panel
      .locator('.stop-words-editor__value')
      .getByText('новыймаркер', { exact: true })
      .count(),
    0,
  );
  await input.fill('');

  await panel.getByRole('button', { name: 'Редактировать казино', exact: true }).click();
  const rule = page.getByRole('dialog', { name: 'Правило', exact: true });
  await rule.getByRole('checkbox', { name: 'Распознавать маскировки', exact: true }).check();
  await rule.getByRole('button', { name: 'Применить', exact: true }).click();
  await rule.waitFor({ state: 'hidden' });
  const tester = panel
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Проверка сообщения' }) });
  await tester.locator('summary').click();
  await tester.getByRole('textbox', { name: 'Сообщение для проверки' }).fill('kазино');
  await tester.getByRole('button', { name: 'Проверить', exact: true }).click();
  await tester.locator('mark').getByText('kазино', { exact: true }).waitFor();

  await panel.getByRole('checkbox', { name: 'Стоп-слова включены', exact: true }).uncheck();
  await save(page);
  await reopen(page);
  assert.equal(
    await panel.getByRole('checkbox', { name: 'Стоп-слова включены', exact: true }).isChecked(),
    false,
  );
  assert.equal(await wordsList.locator('.stop-words-editor__row').count(), 4);
  await panel.getByRole('checkbox', { name: 'Стоп-слова включены', exact: true }).check();
  await panel.getByRole('searchbox', { name: 'Поиск по списку' }).fill('доход');
  await panel.getByRole('checkbox', { name: 'Выбрать ' + phrase, exact: true }).check();
  await panel.getByRole('button', { name: 'Удалить выбранное', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Удалить выбранные записи?', exact: true });
  await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.equal(await wordsList.locator('.stop-words-editor__row').count(), 1);
  await panel.getByRole('button', { name: 'Удалить выбранное', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Удалить', exact: true }).click();
  await save(page);
  await reopen(page);
  assert.equal(await wordsList.locator('.stop-words-editor__row').count(), 3);

  await input.fill('несохранённая фраза');
  const viewport = page.viewportSize();
  if (viewport) {
    await page.setViewportSize({ ...viewport, height: Math.max(320, viewport.height - 240) });
    await input.focus();
    await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1);
    await input.blur();
    await page.setViewportSize(viewport);
  }
  await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
  await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
  await reopen(page);
  assert.equal(await input.inputValue(), '');
  assert.equal(await wordsList.locator('.stop-words-editor__row').count(), 3);
  await panel
    .getByRole('checkbox', { name: 'Стоп-слова включены', exact: true })
    .scrollIntoViewIfNeeded();
}

export async function assertStopWordsSaveFailure(page, failure) {
  const panel = page.locator(PANEL);
  const input = panel.getByRole('textbox', { name: 'Добавить слова и фразы', exact: true });
  const wordsList = panel.getByLabel('Список слов и фраз', { exact: true });
  await input.fill('контрольная фраза');
  await panel.getByRole('button', { name: 'Сохранить в этом чате', exact: true }).click();
  assert.equal(await input.inputValue(), 'контрольная фраза');
  assert.equal(await wordsList.getByText('контрольная фраза', { exact: true }).count(), 0);
  await panel.getByRole('button', { name: 'Добавить записи', exact: true }).click();
  await panel.getByRole('button', { name: 'Сохранить в этом чате', exact: true }).click();
  await page.getByText('Не удалось сохранить блок «Стоп-слова»', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '');
  await wordsList.getByText('контрольная фраза', { exact: true }).waitFor();
  if (failure === 'conflict') {
    await panel.getByRole('button', { name: 'Загрузить сохранённый список', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Загрузить сохранённый список?', exact: true })
      .getByRole('button', { name: 'Загрузить', exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector('.stop-words-editor__input textarea')?.value === '',
    );
    assert.equal(await wordsList.getByText('контрольная фраза', { exact: true }).count(), 0);
    await input.fill('контрольная фраза');
    await panel.getByRole('button', { name: 'Добавить записи', exact: true }).click();
  }
  await save(page);
  await reopen(page);
  await panel
    .locator('.stop-words-editor__value')
    .getByText('контрольная фраза', { exact: true })
    .waitFor();
}

export async function assertStopWordsLargeList(page) {
  const panel = page.locator(PANEL);
  const wordsList = panel.getByLabel('Список слов и фраз', { exact: true });
  await wordsList.locator('.stop-words-editor__row').first().waitFor();
  assert.equal(await wordsList.locator('.stop-words-editor__row').count(), 100);
  const search = panel.getByRole('searchbox', { name: 'Поиск по списку' });
  await search.fill('д'.repeat(20));
  assert.equal(await wordsList.locator('.stop-words-editor__row').count(), 1);
  assert.equal(
    await wordsList.locator('.stop-words-editor__value > span').textContent(),
    'Д'.repeat(160),
  );
  assert.equal(
    await wordsList
      .locator('.stop-words-editor__value')
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
  );
  await search.fill('');
  await panel.getByRole('button', { name: 'Показать ещё', exact: true }).click();
  assert.equal(await wordsList.locator('.stop-words-editor__row').count(), 200);
  await search.fill('д'.repeat(20));
  await panel
    .getByRole('checkbox', { name: 'Стоп-слова включены', exact: true })
    .scrollIntoViewIfNeeded();
}
