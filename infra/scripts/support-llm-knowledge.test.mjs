import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { knowledge, validateSupportAnswer } from './support-llm-client.mjs';

const entries = new Map(knowledge.entries.map((entry) => [entry.id, entry]));
const fact = (id) => {
  assert.ok(entries.has(id), id);
  return entries.get(id).answer;
};
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('VK publication options distinguish new MAX timers, retained schedules and the original source', () => {
  const ui = source('apps/miniapp/src/components/vk-parsing/publication-options.tsx');
  for (const label of ['Первоисточник', 'Пост ВК', 'Своя ссылка', 'Автоудаление', 'Свой срок'])
    assert.ok(ui.includes(label), label);
  const sourceLink = fact('publisher-vk-source-link');
  assert.match(sourceLink, /HTTPS.*без логина и пароля/u);
  assert.match(sourceLink, /сохраняется.*удаление обычных ссылок/u);
  const deletion = fact('publisher-vk-auto-delete');
  assert.match(deletion, /от публикации в MAX.*новым постам/u);
  assert.match(deletion, /Оригиналы в VK остаются/u);
  assert.match(deletion, /не меняет уже назначенное время/u);
  assert.match(deletion, /от 1 до 43200 минут/u);
  assert.match(
    source('packages/contracts/src/vk-parsing-common.ts'),
    /MAX_DELETE_AFTER_MINUTES = 43_200/u,
  );
});

test('participant facts retain current controls and the mute deadline across leaving and returning', () => {
  const ui = source('apps/miniapp/src/components/dashboard/chat-participant-sheet.tsx');
  for (const label of ['Мут', 'Назначить мут', 'Срок идёт с момента назначения'])
    assert.ok(ui.includes(label), label);
  assert.match(fact('participant-mute'), /«Мут».*«Назначить мут»/u);
  assert.match(fact('participant-mute'), /после его возвращения.*с момента назначения/u);
  assert.doesNotMatch(
    fact('participants') + fact('participant-mute'),
    /«Без сообщений»|«Ограничить сообщения»/u,
  );
  assert.match(fact('sanction-history'), /«Мут» и «Бан»/u);
});

test('unified duplicate and commercial preview facts preserve independent evidence boundaries', () => {
  assert.match(fact('duplicates'), /Одинаковый текст.*независимо от результата проверки картинки/u);
  assert.match(fact('duplicates-photo'), /изменённой подписью/u);
  assert.match(fact('duplicates-photo'), /Период, допустимые повторы и действия общие/u);
  assert.doesNotMatch(fact('duplicates-photo'), /у «Одинаковых картинок»/u);
  const preview = fact('commercial-message-preview');
  assert.match(preview, /несохранённый черновик/u);
  assert.match(preview, /не сохраняет и не удаляет сообщения/u);
  assert.match(preview, /«Недостаточно данных» и «Не удалось проверить» не подтверждают/u);
});

test('storefront caller access includes the verified user handoff and its chat scope', () => {
  const ui = source('apps/miniapp/src/pages/settings/settings-storefront-section.tsx');
  for (const label of ['Разрешённые пользователи', 'Добавить пользователя', 'Отозвать доступ'])
    assert.ok(ui.includes(label), label);
  assert.match(fact('karavan-storefront'), /«Добавить пользователя».*перешлите.*сообщение.*срок/iu);
  assert.match(fact('karavan-storefront'), /только в этом чате/iu);
});

test('customer knowledge uses the public project name without renaming the MAX platform', () => {
  for (const entry of entries.values()) assert.doesNotMatch(entry.answer, /\bMAXIM\b/iu, entry.id);
  assert.match(fact('support-room'), /«Майор Максимов»/u);
  assert.match(fact('bots'), /«Майор Максимов»/u);
  assert.match(fact('max-platform-default-commands'), /ботов MAX/u);
});

test('reviewed answers and link examples pass the public response boundary', () => {
  for (const entry of entries.values()) {
    assert.doesNotMatch(entry.answer, /https?:\/\/\S*[<>]|<botName>/iu, entry.id);
    for (const field of [
      'answer',
      'setupAnswer',
      'waitingAnswer',
      'manualAnswer',
      'conflictSavedAnswer',
      'conflictMineAnswer',
      'incidentAnswer',
    ]) {
      if (entry[field] === undefined) continue;
      assert.doesNotThrow(
        () =>
          validateSupportAnswer({ action: 'reply', text: entry[field], sourceIds: [entry.id] }, [
            entry,
          ]),
        `${entry.id}.${field}`,
      );
    }
  }
});

test('reviewed conflict and manual controls preserve the UI action direction', () => {
  const editor = source(
    'apps/miniapp/src/pages/settings/settings-message-retention-editor.tsx',
  ).replace(/\s+/gu, ' ');
  for (const label of ['Загрузить сохранённые', 'Сохранить мой вариант'])
    assert.ok(editor.includes(label), label);
  const recovery = entries.get('lastik-save-recovery');
  assert.match(recovery.conflictSavedAnswer, /^При.*нажмите «Загрузить сохранённые»/u);
  assert.match(recovery.conflictSavedAnswer, /черновые изменения будут сброшены/u);
  assert.match(recovery.conflictMineAnswer, /«Сохранить мой вариант» применяет.*поверх/u);
  assert.doesNotMatch(recovery.conflictSavedAnswer + recovery.conflictMineAnswer, /«Отмена»/u);
  const night = source('apps/miniapp/src/pages/settings/settings-night-section.tsx');
  for (const label of ['Закрыть вручную', 'Без срока']) assert.ok(night.includes(label), label);
  const manual = entries.get('night-manual').manualAnswer;
  assert.match(manual, /Включите «Закрыть вручную»/u);
  assert.match(manual, /выключите «Закрыть вручную»/u);
  assert.match(manual, /включённое расписание продолжает действовать/u);
  assert.doesNotMatch(manual, /[Вв]ключите «Закрывать по расписанию»/u);
});

test('reviewed Lastik setup preserves rights, presets and the request-based waiting window', () => {
  const entry = entries.get('lastik-connect');
  const text = entry.setupAnswer;
  assert.doesNotThrow(() =>
    validateSupportAnswer({ action: 'reply', text, sourceIds: [entry.id] }, [entry]),
  );
  for (const label of ['24 часа', '48 часов', '1 неделя', 'Подключить и включить'])
    assert.ok(text.includes(`«${label}»`), label);
  assert.match(text, /до 1 часа после запроса на подключение/u);
  assert.match(text, /только после подтверждения/u);
  assert.match(text, /чтения всех сообщений и удаления/u);
  assert.match(text, /запросивший подключение пользователь — администратор/u);
  assert.match(text, /Ластик не пишет в чат/u);
  assert.match(text, /Возвращаться.*не нужно/u);
});

test('customer facts contain no instructions addressed to the model', () => {
  for (const entry of entries.values())
    assert.doesNotMatch(
      entry.answer,
      /не обещ(?:ай|ать)|не выдум(?:ывай|ывать)|не запрашивай|вежливо объясни|помоги по инструкции|не смешивать|не путайте|не переносите|надо подтверждать|технические детали давать|никогда не просить|\bsourceIds\b/iu,
      entry.id,
    );
  assert.match(fact('prices-and-free-claims'), /нет подтвержд[её]нной информации/iu);
  assert.match(fact('operator'), /у помощника нет подтвержд[её]нных текущих тарифов/iu);
  assert.match(fact('payment-contact-verification'), /нельзя установить.*мошенником/iu);
});

test('ordinary channel eligibility counts the business and A+ routes together', () => {
  const answer = fact('max-create-public-channel');
  for (const required of [
    /все три условия/iu,
    /российский номер/iu,
    /Цифровой ID/u,
    /менее пяти/iu,
    /в общее число.*через платформу.*для бизнеса.*А\+/iu,
  ])
    assert.match(answer, required);
  assert.doesNotMatch(answer, /бизнес.канал.{0,20}не учитыва/iu);
  assert.ok(
    entries
      .get('max-create-public-channel')
      .sources.some((source) => source === 'https://dev.max.ru/docs/channels/create'),
  );
});

test('schedule timezone facts match the displayed device timezone implementation', () => {
  assert.match(
    source('apps/miniapp/src/lib/broadcast-schedule.ts'),
    /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone \|\| 'Europe\/Moscow'/u,
  );
  assert.match(
    source('apps/miniapp/src/pages/publications-page.tsx'),
    /publication-schedule-timezone/u,
  );
  const answer = fact('publisher-schedule-timezone');
  assert.match(answer, /устройства или браузера/iu);
  assert.match(answer, /показанн.{0,10} пояс/iu);
  assert.match(answer, /отдельного меню.*нет/iu);
  const dates = fact('publisher-schedule-dates');
  assert.match(dates, /одного и того же содержимого/iu);
  assert.match(dates, /Сохранить расписание/u);
  assert.match(dates, /разных текстов.*отдельные публикации/iu);
});

test('network operation outcomes and audience coverage have separate facts', () => {
  const operation = fact('networks-settings-statistics');
  assert.match(operation, /Проверить изменения.*Применить/u);
  assert.match(operation, /результат отдельно по целям/iu);
  assert.match(operation, /ошибка отдельной цели не означает откат/iu);
  assert.doesNotMatch(operation, /7 или 30|неполной истории прироста/iu);
  const audience = fact('networks-audience-statistics');
  assert.match(audience, /7 или 30 дней/u);
  assert.match(audience, /покрытие только указанной части/iu);
  assert.doesNotMatch(audience, /нажмите.*Применить|ошибк.{0,20}из.за/iu);
});

test('the eight public bot identities match their verified product sources', () => {
  const catalog = knowledge.botCatalog;
  assert.equal(catalog.length, 8);
  for (const field of ['id', 'name', 'url'])
    assert.equal(new Set(catalog.map((bot) => bot[field])).size, 8, field);
  assert.deepEqual(
    Object.fromEntries(
      ['primary-moderator', 'reserve-moderator', 'publisher', 'eraser'].map((kind) => [
        kind,
        catalog.filter((bot) => bot.kind === kind).length,
      ]),
    ),
    { 'primary-moderator': 3, 'reserve-moderator': 3, publisher: 1, eraser: 1 },
  );
  const moderators = source('apps/api/src/max/max-public-moderator.ts');
  const aliases = new Map();
  for (const bot of catalog) {
    const url = new URL(bot.url);
    assert.equal(url.origin, 'https://max.ru', bot.name);
    assert.equal(url.search + url.hash + url.username + url.password, '', bot.name);
    if (bot.kind.endsWith('-moderator')) {
      assert.ok(moderators.includes(`${url.pathname.slice(1)}: { name: '${bot.name}'`), bot.name);
      assert.equal(bot.kind === 'reserve-moderator', bot.name.endsWith(' 2'), bot.name);
    } else {
      const path = bot.kind === 'publisher' ? 'publik-bot.ts' : 'lastik-bot.ts';
      assert.ok(source(`apps/miniapp/src/lib/${path}`).includes(`'${bot.url}'`), bot.name);
    }
    assert.ok(Array.isArray(bot.aliases) && bot.aliases.length > 0, bot.name);
    for (const alias of [bot.name, ...bot.aliases]) {
      assert.ok(typeof alias === 'string' && alias.trim(), bot.name);
      assert.notEqual(alias.toLocaleLowerCase('ru'), 'майор');
      const normalized = alias.toLocaleLowerCase('ru');
      assert.ok(!aliases.has(normalized) || aliases.get(normalized) === bot.id, alias);
      aliases.set(normalized, bot.id);
    }
  }
  assert.match(fact('bots'), /восемь ботов/u);
  assert.match(fact('bots'), /не означает автоматического переключения/u);
});

test('bot selection knowledge quotes exact interface headings without inflection', () => {
  const views = [
    source('apps/miniapp/src/components/managed-entity-bots-sheet.tsx'),
    source('apps/miniapp/src/components/managed-entity-bots-control.tsx'),
  ];
  for (const id of ['bots', 'choose-moderator']) {
    const answer = fact(id);
    for (const label of ['Боты чата', 'Боты канала']) {
      assert.ok(
        views.every((view) => view.includes(`'${label}'`)),
        label,
      );
      assert.ok(answer.includes(`«${label}»`), `${id}: ${label}`);
    }
    assert.doesNotMatch(answer, /«Бот(?:ах|ами|ов) (?:чата|канала)»/u);
  }
});

test('Lastik connection is separate from a moderator and limited to group chats', () => {
  const answer = fact('lastik-connect');
  const ui =
    source('apps/miniapp/src/pages/settings/shared-message-retention-fields.tsx') +
    source('apps/miniapp/src/pages/settings/settings-message-retention-editor.tsx');
  const access = source('apps/api/src/admin/admin-message-retention.service.ts');
  assert.match(answer, /отдельный бот.*групповых чатах/u);
  assert.match(answer, /администратором с правами чтения всех сообщений и удаления/u);
  assert.match(answer, /После подтверждения запроса откроется профиль бота/u);
  assert.match(answer, /До 1 часа после запроса на подключение/u);
  assert.match(answer, /запросивший подключение пользователь — администратор чата/u);
  assert.match(answer, /после подтверждения обоих условий/u);
  assert.match(answer, /возвращаться в мини-приложение не нужно/u);
  assert.match(answer, /В сетке сначала добавьте бота с правами в каждый чат/u);
  assert.match(fact('operator'), /не видит текущие права, настройки/u);
  assert.ok(answer.includes(knowledge.botCatalog.find((bot) => bot.id === 'lastik').url));
  for (const label of ['Удаление старых сообщений', 'Подключить и включить', 'Открыть Ластика'])
    assert.ok(answer.includes(label) && ui.includes(label), label);
  assert.match(access, /Модуль доступен только в групповых чатах/u);
  assert.doesNotMatch(
    answer,
    /перешлите|автоматически заменит модератора|Вернитесь|проверяется при сохранении|Открыть профиль/u,
  );
});

test('Lastik periods and history coverage remain separate from connection and recovery', () => {
  const answer = fact('message-retention');
  const ui = source('apps/miniapp/src/pages/settings/shared-message-retention-fields.tsx');
  for (const label of ['Удаление по сроку', '24 часа', '48 часов', '1 неделя']) {
    assert.ok(ui.includes(label), label);
    assert.ok(answer.includes(label), label);
  }
  assert.match(answer, /всей доступной истории, включая сообщения до включения/u);
  assert.match(answer, /сообщения любых авторов/u);
  assert.match(answer, /редактирование его не продлевает/u);
  assert.match(answer, /При изменении срока он применяется ко всей доступной истории/u);
  assert.match(answer, /Для первого запуска нажмите «Подключить и включить»/u);
  assert.match(answer, /У подключённого бота.*кнопкой «Сохранить»/u);
  assert.match(answer, /постепенно/u);
  assert.match(ui, /сообщения любых авторов из всей доступной истории/u);
  assert.doesNotMatch(answer, /историю не очищает|учёт начинается заново|ждёт низкой нагрузки/u);
  assert.doesNotMatch(answer, /Проверить права|Проверить сохранение/u);
});

test('Lastik preserves protected messages and works in a chat without a pin', () => {
  const answer = fact('lastik-exclusions');
  assert.match(answer, /все закреплённые сообщения/u);
  assert.match(answer, /правила, объявления розыгрышей и их итоги из наших модулей/u);
  assert.match(answer, /включая администраторов/u);
  assert.match(answer, /Отсутствие закрепа не мешает очистке/u);
  assert.match(
    source('apps/eraser/src/max.ts'),
    /result\.message === null \|\| Object\.keys\(result\)\.length === 0/u,
  );
  assert.match(source('apps/eraser/src/runtime.ts'), /pin === candidate\.message_id/u);
});

test('Lastik progress uses the actual details labels without claiming live visibility', () => {
  const answer = fact('lastik-progress');
  const ui = source('apps/miniapp/src/pages/settings/settings-message-retention-editor.tsx');
  const model = source('apps/miniapp/src/pages/settings/settings-message-retention-model.ts');
  assert.match(
    ui,
    /import\s*\{[^}]*\bretentionHistoryLabel\b[^}]*\}\s*from '\.\/settings-message-retention-model'/u,
  );
  assert.match(ui, /<dd>\{retentionHistoryLabel\(state\)\}<\/dd>/u);
  for (const label of ['Ожидает очистки', 'Очищается', 'Проверена', 'Часть истории отложена'])
    assert.ok(answer.includes(label) && model.includes(label), label);
  for (const label of [
    'История чата',
    'Подробности очистки',
    'Ожидают',
    'Больше нет в чате',
    'Пропущены',
    'Обновить состояние',
    'Проверено сообщений',
    'Включено',
    'Ожидают удаления с',
    'Очистка на паузе с',
  ])
    assert.ok(answer.includes(label) && ui.includes(label), label);
  assert.match(answer, /не означает, что чат должен быть пустым/u);
  assert.match(answer, /не видит ваши счётчики/u);
  assert.match(answer, /не может подтвердить завершение/u);
  assert.match(answer, /выбора дат для просмотра истории здесь нет/u);
});

test('Lastik connection expiry needs an explicit miniapp retry and stays silent in chats', () => {
  const permissions = fact('lastik-permissions');
  assert.match(permissions, /уже включённой очистки/u);
  assert.match(permissions, /В течение 1 часа бот проверяет свои права и права администратора/u);
  assert.match(permissions, /очистка включится автоматически/u);
  assert.match(permissions, /выбранный срок сохраняется/iu);
  const ui = source('apps/miniapp/src/pages/settings/shared-message-retention-fields.tsx');
  for (const label of [
    'Подключить и включить',
    'Время ожидания истекло',
    'Проверить и включить',
    'Обновить состояние',
  ]) {
    assert.ok(permissions.includes(label), label);
    assert.ok(
      (
        ui + source('apps/miniapp/src/pages/settings/settings-message-retention-editor.tsx')
      ).includes(label),
      label,
    );
  }
  assert.match(permissions, /открытие профиля и «Обновить состояние» не запускают новый час/u);
  assert.doesNotMatch(permissions, /«Проверить права»|первом подключении.*«Сохранить»/u);
  assert.match(source('apps/eraser/src/store.ts'), /INTERVAL '1 hour'/u);
  for (const answer of [fact('lastik-connect'), source('docs/bot-support-policy.md')])
    assert.match(answer, /Ластик не отправляет сообщения в чаты/u);
  assert.match(permissions, /не требует сообщений или команд в чат/u);
});

test('Lastik uncertain-save recovery preserves the exact operation', () => {
  const recovery = fact('lastik-save-recovery');
  const ui = source('apps/miniapp/src/pages/settings/settings-message-retention-editor.tsx');
  for (const label of [
    'Сохранение пока не подтверждено',
    'Проверить сохранение',
    'Сохранено',
    'Не удалось сохранить изменения',
    'Повторить сохранение',
    'Настройки уже изменились',
    'Сохранить мой вариант',
  ])
    assert.ok(recovery.includes(label) && ui.includes(label), label);
  assert.match(recovery, /Отсутствие ответа ещё не означает, что настройки не применились/u);
  assert.match(recovery, /«Загрузить сохранённые» принимает текущие настройки/u);
  assert.doesNotMatch(recovery, /выключите.*включите|переустановите|удалите бота/u);
  assert.match(ui, /save\.mutateAsync\(input\)/u);
});

test('Lastik disabling and longer retention cannot restore deleted messages', () => {
  const answer = fact('lastik-stop-restore');
  assert.match(answer, /выключите «Удаление по сроку» и нажмите «Сохранить»/u);
  assert.match(answer, /остальные правила модерации.*независимо/iu);
  assert.match(answer, /Уже удалённые сообщения восстановить нельзя/u);
  assert.match(answer, /увеличение срока хранения не возвращает/u);
  assert.match(
    source('apps/miniapp/src/pages/settings/shared-message-retention-fields.tsx'),
    /без возможности восстановления/u,
  );
  assert.ok(answer.includes('Отменить подключение'));
  assert.ok(
    source('apps/miniapp/src/pages/settings/shared-message-retention-fields.tsx').includes(
      'Отменить подключение',
    ),
  );
  for (const id of [
    'lastik-connect',
    'message-retention',
    'lastik-exclusions',
    'lastik-progress',
    'lastik-diagnostics',
    'lastik-permissions',
    'lastik-save-recovery',
    'lastik-stop-restore',
  ])
    assert.ok(fact(id).length <= 900, `${id}: ${fact(id).length}`);
});

test('AI intents preserve their own limits instead of an entire mixed FAQ', () => {
  assert.match(fact('commercial-ai-enable'), /Удалять рекламу.*сохраните/u);
  assert.doesNotMatch(fact('commercial-ai-enable'), /Мягко|Двойная проверка|мут/u);
  assert.match(fact('commercial-ai-sensitivity'), /чувствительность ИИ не настраивается/u);
  assert.match(fact('commercial-ai-switch-mode'), /нет пользовательского переключателя/u);
  assert.match(fact('commercial-ai-observation'), /другие фильтры.*могут.*удалять/iu);
  const aiPolicy = fact('commercial-ai-double-check');
  const commercialUi = source(
    'apps/miniapp/src/pages/settings/shared-commercial-settings-fields.tsx',
  );
  for (const [label, file] of [
    ['Что разрешено', 'commercial-policy-fields.tsx'],
    ['Исключения', 'commercial-policy-tools.tsx'],
  ]) {
    assert.ok(source(`apps/miniapp/src/pages/settings/${file}`).includes(label), label);
    assert.ok(fact('commercial-ai-enable').includes(label), label);
  }
  for (const statement of [
    'Подтверждённая реклама удаляется по правилам чата',
    'Другие фильтры работают независимо',
  ])
    assert.ok(commercialUi.includes(statement), statement);
  assert.match(aiPolicy, /разрешённая категория.*действующее исключение.*сохраняют сообщение/u);
  assert.match(aiPolicy, /неоднозначном результате.*сообщение остаётся/u);
  assert.match(aiPolicy, /другие включённые фильтры работают независимо/u);
  for (const id of [
    'commercial-text-filter',
    'commercial-sanctions',
    'commercial-ai-mode',
    'commercial-ai-enable',
    'commercial-ai-sensitivity',
    'commercial-ai-double-check',
  ])
    assert.doesNotMatch(
      fact(id),
      /с подписью «ИИ-модерация текста»|В панели указано|«Реклама подтверждена»|«Результат неоднозначен»/u,
      id,
    );
  assert.doesNotMatch(fact('commercial-ai-model'), /Подпись «Сомнения проверяет/u);
  assert.match(fact('commercial-ai-model'), /нет выбора модели/u);
  assert.match(fact('commercial-ai-evidence'), /не подтверждает проверку или удаление/u);
  assert.match(fact('commercial-sanctions'), /без.*предупреждений.*мутов.*банов/u);
});

test('delivery, readiness and notification instructions keep their distinct meanings', () => {
  assert.match(
    fact('publisher-post-targets'),
    /Новое сообщество через эту карточку не подключается/u,
  );
  assert.match(fact('publisher-post-targets'), /вообще нет в списке.*перешлите пост.*Публика/u);
  assert.match(fact('publisher-readiness'), /«Модуль выключен» и «Публик выключен».*разные/u);
  assert.match(fact('publisher-delivery-status'), /повторная отправка.*может создать дубль/iu);
  assert.match(fact('notifications'), /отдельного списка выбора.*нет/iu);
  assert.match(fact('notifications'), /отключения одного канала.*«Выкл» и «Канал»/iu);
  assert.match(fact('publisher-auto-replies-matching'), /только «прайс».*выключают/u);
  assert.match(fact('vk-review'), /у канала один согласующий/iu);
  assert.match(fact('vk-review'), /копии карточек не распределяются/iu);
  assert.match(fact('vk-review'), /В карточке поста нет выбора другого согласующего/u);
});

test('subscription steps and report subjects match their actual boundaries', () => {
  const subscription = fact('subscription');
  assert.match(subscription, /настройки нужного чата → «Подписка»/u);
  assert.match(subscription, /Добавить источник.*Добавить по ссылке.*Добавить/u);
  const subscriptionUi = source(
    'apps/miniapp/src/pages/settings/settings-required-subscription-ui.tsx',
  );
  for (const label of ['Добавить источник', 'Добавить по ссылке', 'Добавить'])
    assert.ok(subscriptionUi.includes(label), label);

  const reports = fact('community-reports');
  assert.match(reports, /Возраст сообщения.*меньше 24 часов/u);
  assert.match(reports, /24 часа и старше жалобы не принимаются/u);
  assert.match(reports, /Автор жалобы:.*не менее 24 часов/u);
  assert.match(reports, /Автор сообщения.*администраторов и защищённых участников/u);
  assert.match(reports, /не запрещает администраторам подавать жалобы/u);

  const eligibility = source('apps/api/src/moderation/reports/report.util.ts').split(
    'export function isEligibleReporter(',
  )[1];
  assert.ok(eligibility);
  assert.doesNotMatch(eligibility, /isAdmin|isOwner/u);
  assert.match(eligibility, /joinedAtMs <= atMs - REPORT_DAY_MS/u);
  const targetChecks = source('apps/api/src/moderation/reports/report-state.service.ts');
  assert.match(targetChecks, /member\.isAdmin \|\|\s*member\.isOwner/u);
});

test('member subscription help and night permissions stay separate from setup procedures', () => {
  for (const id of ['subscription', 'subscription-membership', 'subscription-participant']) {
    assert.match(fact(id), /Обязательная подписка — участие аккаунта.*чатах и каналах MAX/u, id);
    assert.match(fact(id), /проверяет членство.*не означает оплату услуг бота/u, id);
  }
  const membership = fact('subscription-membership');
  assert.match(membership, /всем источникам.*сообщении бота/u);
  assert.match(membership, /уже подписаны.*администраторам именно этого чата/u);
  assert.match(membership, /не видит ваш аккаунт.*не может подтвердить личную подписку/u);
  assert.doesNotMatch(membership, /Добавить источник|Добавить по ссылке|настройки.*Подписка/u);
  const participant = fact('subscription-participant');
  assert.match(participant, /сам открывает ссылки.*подписывается на все указанные/u);
  assert.match(participant, /не подписывает участника автоматически/u);
  assert.doesNotMatch(participant, /Добавить источник|Добавить по ссылке/u);
  assert.equal(entries.get('subscription-participant').delivery, undefined);

  const night = fact('night');
  assert.match(
    night,
    /включите «Закрывать по расписанию».*Закрывать с.*Открывать в.*Часовой пояс/u,
  );
  assert.doesNotMatch(night, /Закрыть вручную|тишина/u);
  const permissions = fact('night-permissions');
  assert.match(permissions, /администраторы могут продолжать писать/u);
  assert.match(permissions, /не подтверждает.*конкретный пост администратора/u);
  assert.doesNotMatch(permissions, /выключите|Закрывать с|Открывать в/u);

  const nightUi = source('apps/miniapp/src/pages/settings/settings-night-section.tsx');
  assert.match(nightUi, /Администраторы могут продолжать писать/u);
  assert.match(nightUi, /Администраторы смогут продолжать писать/u);
  const manual = fact('night-manual');
  for (const label of ['Закрыть сейчас', 'Закрыть вручную', 'Без срока']) {
    assert.ok(nightUi.includes(label), label);
    assert.ok(manual.includes(label), label);
  }
  assert.match(manual, /ночное расписание продолжает действовать/u);
});

test('reviewed delivery is restricted to bounded answers with preserved evidence', () => {
  const reviewedIds = [...entries.values()]
    .filter((entry) => entry.delivery === 'reviewed')
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(reviewedIds, [
    'max-public-channel-eligibility',
    'publisher-delivery-status',
    'subscription-membership',
    'support-incident-evidence',
  ]);
  const eligibility = fact('max-public-channel-eligibility');
  for (const required of [/все три условия/u, /российский номер/u, /Цифровой ID/u, /менее пяти/u])
    assert.match(eligibility, required);
  assert.match(eligibility, /через платформу.*для бизнеса.*А\+/u);
  assert.match(eligibility, /уже пять.*этим способом нельзя/u);
  assert.doesNotMatch(eligibility, /удалите|удалить|смените|другой аккаунт/u);
  const evidence = fact('support-incident-evidence');
  assert.match(evidence, /название вашего сообщества, время проблемы и пример/u);
  assert.match(evidence, /События.*недоступен.*этими данными/u);
  assert.match(evidence, /сам не просматривает журналы и аккаунт/u);
  assert.match(evidence, /Токены, пароли, коды входа.*не нужны/u);
  assert.doesNotMatch(fact('subscription-membership'), /откройте ссылки|подпишитесь|Добавить/u);
});

test('four link modes preserve their actual effects, target scope and save action', () => {
  const links = fact('links-policy');
  assert.match(links, /откройте «Ссылки».*четыре режима/u);
  assert.doesNotMatch(links, /«Ссылки» → «Режим»|три режима/u);
  assert.match(links, /отключить запрет ссылок, выбирают «Разрешать все»/u);
  assert.match(links, /«Разрешать все» — этот фильтр не удаляет ссылки/u);
  assert.match(links, /«Запрещать по списку» — запрещены адреса из списка с учётом исключений/u);
  assert.match(links, /«Удалять все» — запрещены любые ссылки, исключения не действуют/u);
  assert.match(links, /Сообщение с запрещённой ссылкой удаляется целиком/u);
  assert.match(links, /После изменения нажмите «Сохранить»/u);
  assert.match(links, /Пустой список.*«Разрешать по списку» запрещает все ссылки/u);
  assert.match(links, /«Запрещать по списку» запретов по пустому списку нет/u);
  assert.match(links, /конкретного адреса.*«Добавить».*«Только эта ссылка»/u);
  assert.match(links, /«Весь сайт и поддомены» охватывает весь домен/u);
  assert.match(links, /Другие включённые правила.*продолжают работать независимо/u);
  const ui = source('apps/miniapp/src/pages/settings/shared-link-settings-fields.tsx');
  for (const [mode, label] of [
    ['ALLOW_ALL', 'Разрешать все'],
    ['DENY_SELECTED', 'Запрещать по списку'],
    ['ALLOW_SELECTED', 'Разрешать по списку'],
    ['DENY_ALL', 'Удалять все'],
  ]) {
    assert.ok(ui.includes(`value: '${mode}', label: '${label}'`), label);
    assert.ok(links.includes(`«${label}»`), label);
  }
  const targetLabels = source('apps/miniapp/src/pages/settings/link-settings-model.ts');
  assert.match(targetLabels, /WEB_EXACT: 'Только эта ссылка'/u);
  assert.match(targetLabels, /WEB_DOMAIN: 'Весь сайт и поддомены'/u);
  const detector = source('apps/api/src/moderation/rule-engine-link-detector.ts');
  assert.match(detector, /evaluateRuntimeLinkRulesPolicy\(rules\.policy, targets\)/u);
  assert.match(detector, /policy === LinkPolicy\.ALERT_ONLY\) \{\s*return null;/u);
  assert.match(
    source('apps/miniapp/src/pages/settings/settings-section-save-footer.tsx'),
    /options\?\.saveLabel \?\? 'Сохранить'/u,
  );
});
