import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const chatsPageSource = readFileSync(
  new URL('../src/pages/chats-page.tsx', import.meta.url),
  'utf8',
);
const favoriteLabelSyncSource = readFileSync(
  new URL('../src/lib/home-entity-favorite-label-sync.ts', import.meta.url),
  'utf8',
);
const favoritesRuntimeSource = readFileSync(
  new URL('../src/lib/home-entity-favorites-runtime.ts', import.meta.url),
  'utf8',
);
const chatsPageCss = readFileSync(new URL('../src/pages/chats-page.css', import.meta.url), 'utf8');
const chatsPageNativeCss = readFileSync(
  new URL('../src/pages/chats-page-native.css', import.meta.url),
  'utf8',
);
const chatsPageSignalCss = readFileSync(
  new URL('../src/pages/chats-page-signal.css', import.meta.url),
  'utf8',
);
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');
const sheetsSource = readFileSync(
  new URL('../src/pages/home-entity-sheets.tsx', import.meta.url),
  'utf8',
);
const rootClientSource = readFileSync(
  new URL('../src/lib/api/root-client.ts', import.meta.url),
  'utf8',
);
const onboardingSource = readFileSync(
  new URL('../src/components/chat-onboarding-section.tsx', import.meta.url),
  'utf8',
);

test('home device cache cannot import retired composition or issue blind favorites writes', () => {
  assert.doesNotMatch(
    favoritesRuntimeSource,
    /updateManagedEntityFavorites|migrateLegacyHomeEntityFavorites|Promise\.allSettled/u,
  );
  assert.doesNotMatch(chatsPageSource, /migrateLegacyHomeEntityFavorites/u);
  assert.match(favoritesRuntimeSource, /synchronizeManagedEntityFavoriteLabels/u);
});

test('entity cards expose settings, favorite, statistics and category edit targets', () => {
  assert.match(chatsPageSource, /className="chat-card__primary-link"/u);
  assert.match(chatsPageSource, /'chat-card__action--favorite'/u);
  assert.match(chatsPageSource, /className="chat-card__row-actions"/u);
  assert.match(chatsPageSource, /chat-card__action chat-card__action--settings/u);
  assert.match(chatsPageSource, /chat-card__action chat-card__action--statistics/u);
  assert.match(
    chatsPageSource,
    /chat-card__action--settings[\s\S]*?data-action="settings"[\s\S]*?Настройки[\s\S]*?<\/Link>/u,
  );
  assert.match(
    chatsPageSource,
    /chat-card__action--statistics[\s\S]*?data-action="statistics"[\s\S]*?Статистика[\s\S]*?<\/Link>/u,
  );
  assert.match(chatsPageSource, /chat-card__category-editor/u);
  assert.doesNotMatch(chatsPageSource, /chat-card__category-marker/u);
  assert.match(chatsPageSource, /aria-label=\{`Открыть настройки: \$\{title\}/u);
  assert.match(chatsPageSource, /to=\{settingsRoute\}/u);
  assert.match(chatsPageSource, /to=\{statisticsRoute\}/u);
  assert.match(
    chatsPageSource,
    /const settingsRoute = preserveManagedEntityRouteContext\(\s*buildManagedEntitySettingsRoute\(activeTab, entity\.id\),\s*location\.search,\s*location\.hash,\s*\)/u,
  );
  assert.match(
    chatsPageSource,
    /const statsPreference = readEntityStatsPreference\(entity\.id\);[\s\S]*?const statisticsRoute = preserveManagedEntityRouteContext\(\s*buildManagedEntityStatisticsRoute\(activeTab, entity\.id, statsPreference\),\s*location\.search,\s*location\.hash,\s*\);/u,
  );
  assert.doesNotMatch(chatsPageSource, /function buildEntity(?:Settings|Statistics)Route/u);
  assert.doesNotMatch(chatsPageSource, /<details\b/u);
  assert.match(chatsPageSource, /aria-haspopup="dialog"/u);
  assert.match(
    chatsPageSource,
    /`Добавить в избранное: \$\{title\}`[\s\S]*?aria-controls="home-sheet-favorite"/u,
  );
  assert.match(chatsPageSource, /className="chat-card__favorite-symbol"/u);
  assert.match(
    chatsPageSource,
    /'chat-card__action--favorite'[\s\S]*?chat-card__favorite-mark[\s\S]*?primaryFavoriteType\s*\?[\s\S]*?<CategoryIcon[\s\S]*?:[\s\S]*?<StarGlyph[\s\S]*?<\/button>/u,
  );
  assert.doesNotMatch(
    chatsPageSource,
    /chat-card__favorite-star|chat-card__favorite-category-icon/u,
  );
  assert.match(chatsPageSource, /import\('\.\/home-entity-sheets'\)/u);
  assert.doesNotMatch(chatsPageSource, /from '\.\.\/lib\/dialog-focus'/u);
  assert.doesNotMatch(chatsPageSource, /chat-card__more|MoreGlyph/u);
  assert.doesNotMatch(sheetsSource, /home-actions__panel|<strong>Статистика<\/strong>/u);
});

test('moderation and Publik navigation keep profile-aware publishing labels', () => {
  const labels = shellSource.match(/className="bottom-nav__label"/gu) ?? [];

  assert.equal(labels.length, 5);
  assert.match(shellSource, /buildManagedEntitiesRoute\('chat'\)/u);
  assert.match(shellSource, /buildManagedEntitiesRoute\('channel'\)/u);
  assert.match(shellSource, />Чаты</u);
  assert.match(shellSource, />Каналы</u);
  assert.match(shellSource, /profile === 'moderation' && networksEnabled/u);
  assert.match(shellSource, /to="\/networks"/u);
  assert.match(shellSource, />Сетки</u);
  assert.match(shellSource, /href=\{PUBLIK_BOT_URL\}/u);
  assert.match(shellSource, /onClick=\{openPublikBot\}/u);
  assert.match(shellSource, />Публик</u);
  assert.doesNotMatch(shellSource, /bottom-nav__label[^\n]*Расписания/u);
  assert.match(shellSource, /selectedRootEntityType === 'chat'/u);
  assert.match(shellSource, /selectedRootEntityType === 'channel'/u);
  assert.doesNotMatch(chatsPageSource, /chats-command__tabs/u);
  assert.doesNotMatch(shellSource, /bottom-nav__label">Настройки/u);
  assert.doesNotMatch(shellSource, /bottom-nav__label">\{activityNavLabel\}/u);
  assert.match(
    shellSource,
    /const shouldShowBottomNav =\s*isChatsRoute \|\| isPublicationsRoute \|\| isNetworksRoute \|\| isNetworkSettingsHub;/u,
  );
  assert.match(shellSource, /profile === 'publisher' \? '\/'/u);
  assert.match(shellSource, /const isProfileHomeRoute = isChatsRoute;/u);
  assert.match(shellSource, /if \(!isChatsRoute \|\| profile !== 'moderation'\)/u);
  assert.match(shellSource, /\{shouldShowBottomNav \? \(/u);
});

test('home sheets are named, focus-trapped and leave the shell controls inert', () => {
  assert.match(sheetsSource, /useDialogFocusTrap\(true, panelRef, panelRef\)/u);
  assert.match(sheetsSource, /aria-labelledby=\{titleId\}/u);
  assert.match(sheetsSource, /className="favorite-picker__backdrop"[\s\S]*?onClick=\{onClose\}/u);
  assert.match(chatsPageSource, /homeRoot\.inert = true/u);
  assert.match(chatsPageSource, /bottomNav\.inert = true/u);
  assert.match(chatsPageSource, /event\.key !== 'Escape'/u);
});

test('home controls keep explicit actions, category filters and readable rows', () => {
  assert.match(chatsPageSource, /const searchPlaceholder = 'Поиск';/u);
  assert.match(chatsPageSource, /<h1>\{tabLabel\}<\/h1>/u);
  assert.doesNotMatch(chatsPageSource, /chats-command__avatar|home-active-filter/u);
  assert.match(chatsPageSource, /hasSearchQuery && 'has-query'/u);
  assert.match(
    chatsPageSource,
    /className=\{cn\([\s\S]*?'favorite-filter__trigger'[\s\S]*?aria-controls="home-sheet-filter"/u,
  );
  assert.match(chatsPageSource, /setFavoriteFilter\(FAVORITE_FILTER_ALL\)/u);
  assert.match(chatsPageSource, /HOME_ENTITY_FAVORITE_TYPES\.filter\(/u);
  assert.match(chatsPageSource, /favoriteCounts\[\w+\]/u);
  assert.match(chatsPageSource, /favoriteLabels\[\w+\]/u);
  assert.match(
    chatsPageSource,
    /'chats-command__refresh'[\s\S]*?aria-label=\{refreshButtonLabel\}/u,
  );
  assert.match(chatsPageSignalCss, /\.chat-card__row-actions/u);
  assert.match(chatsPageSignalCss, /overflow-wrap:\s*anywhere/u);
  assert.match(chatsPageSignalCss, /min-height:\s*44px/u);
  assert.match(chatsPageCss, /\.chats-command__icon-button \{[\s\S]*?min-width: 44px/u);
  assert.match(chatsPageNativeCss, /\.favorite-filter__trigger \{[\s\S]*?min-width: 44px/u);
});

test('home sheets preserve accessible categories and authenticated label persistence', () => {
  assert.match(sheetsSource, /sheetKey="filter"[\s\S]*?home-filter__grid/u);
  assert.match(sheetsSource, /Распределить по категориям/u);
  assert.match(sheetsSource, /'Повторить загрузку названий'[\s\S]*?'Настроить названия'/u);
  assert.match(sheetsSource, /'Добавить в избранное'/u);
  assert.match(
    chatsPageNativeCss,
    /\.favorite-picker__header span \{[\s\S]*?color: var\(--home-muted\);/u,
  );
  assert.match(
    chatsPageNativeCss,
    /@media \(max-width: 430px\) \{\s*\.home-sheet--favorite \.favorite-picker__grid \{\s*grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(
    chatsPageNativeCss,
    /\.favorite-picker__panel \{[\s\S]*?background: var\(--color-surface\);/u,
  );
  assert.match(sheetsSource, /title="Названия категорий"/u);
  assert.match(
    sheetsSource,
    /const subtitleId = subtitle \? `home-sheet-\$\{sheetKey\}-subtitle` : undefined;[\s\S]*?aria-describedby=\{subtitleId\}[\s\S]*?<span id=\{subtitleId\}>\{subtitle\}<\/span>/u,
  );
  assert.match(
    sheetsSource,
    /className="favorite-label-editor__field"[\s\S]*?<IconoirSprite variant="iconoir" icon="EditPencil" aria-hidden/u,
  );
  assert.match(
    sheetsSource,
    /className=\{cn\('favorite-label-editor__row', canReset && 'has-reset'\)\}/u,
  );
  assert.match(
    sheetsSource,
    /disabled=\{saving \|\| !canReset\}[\s\S]*?<IconoirSprite variant="iconoir" icon="Undo" aria-hidden \/>/u,
  );
  assert.match(sheetsSource, /useNativeBackHandler\([\s\S]*?if \(!saving\) \{\s*onClose\(\);/u);
  assert.doesNotMatch(sheetsSource, /maxLength=\{HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH\}/u);
  assert.match(sheetsSource, /value\.split\('\\u0000'\)\.join\(''\)/u);
  assert.match(
    favoritesRuntimeSource,
    /getMe\(api, \{ signal \}\)[\s\S]*?onUserId\(userId\)[\s\S]*?initDataUserId !== null[\s\S]*?initDataUserId !== userId[\s\S]*?getPreviewApiPrincipalUserId\(api\) !== userId/u,
  );
  assert.match(chatsPageSource, /useHomeEntityFavorites\(\)/u);
  assert.doesNotMatch(chatsPageSource, /getInitDataUserId|hydrateHomeEntityFavorites/u);
  assert.match(
    favoriteLabelSyncSource,
    /applyLabels\(cachedLabels, false\)[\s\S]*?waitForNativeStorage: true[\s\S]*?applyLabels\(lateLabels, false\)/u,
  );
  assert.match(
    favoriteLabelSyncSource,
    /migrateHomeEntityFavoriteLabelsAfterNativeStorage\([\s\S]*?serverProfileConfirmed \|\| Object\.keys\(labels\)\.length > 0/u,
  );
  assert.match(chatsPageSource, /favoritesActions\.refreshLabels\(\)/u);
  assert.match(sheetsSource, /actions\.saveLabels\(/u);
  assert.match(sheetsSource, /disabled=\{props\.favoriteLabelsStatus === 'loading'\}/u);
  assert.match(sheetsSource, /saveControllerRef\.current\?\.abort\(\)/u);
  assert.match(
    chatsPageNativeCss,
    /\.favorite-label-editor__reset:disabled \{[\s\S]*?display: none;[\s\S]*?opacity: 0;/u,
  );
  assert.match(
    chatsPageNativeCss,
    /\.favorite-label-editor__actions \{[\s\S]*?position: sticky;[\s\S]*?bottom: 0;[\s\S]*?background: var\(--color-surface\);/u,
  );
  assert.match(
    chatsPageNativeCss,
    /\.favorite-label-editor__actions \.button--accent:disabled \{[\s\S]*?background: var\(--home-surface-muted\);[\s\S]*?opacity: 1;/u,
  );
  assert.match(chatsPageNativeCss, /\.home-filter__manage strong \{[\s\S]*?white-space: normal;/u);
  assert.match(
    sheetsSource,
    /className="home-filter__management" aria-labelledby="home-filter-management-title"[\s\S]*?>\s*Управление\s*<[\s\S]*?className="home-filter__commands" role="group"/u,
  );
  assert.match(chatsPageNativeCss, /\.home-filter__manage \{[\s\S]*?border-style: solid;/u);
});

test('home connection flow is always available and opens the signed launch bot dialog', () => {
  assert.match(
    chatsPageSource,
    /className="chats-command__connect"[\s\S]*?aria-controls="home-sheet-connect"[\s\S]*?<PlusCircleGlyph/u,
  );
  assert.doesNotMatch(chatsPageSource, /<span>Подключить<\/span>/u);
  assert.doesNotMatch(chatsPageSource, /botDialogUrl|setBotDialogUrl/u);
  assert.match(chatsPageSource, /useHomeEntityFavorites\(\)/u);
  assert.doesNotMatch(chatsPageSource, /from '\.\.\/lib\/api\/me-client'/u);
  assert.match(favoritesRuntimeSource, /from '\.\/api\/me-client'/u);
  assert.doesNotMatch(rootClientSource, /\bgetMe\b|\bparseMe\b|botDialogUrl/u);
  assert.match(sheetsSource, /from '\.\.\/lib\/api\/me-client'/u);
  assert.match(sheetsSource, /getMe\(api,[\s\S]*?botDialogUrlRef\.current = me\.botDialogUrl/u);
  assert.match(sheetsSource, /coordinator\.run\([\s\S]*?openMaxBotLinkAndClose/u);
  assert.doesNotMatch(chatsPageSource, /createBotDialogHandoffCoordinator|openMaxBotLinkAndClose/u);
  assert.match(chatsPageSource, /if \(showEmptyState\) \{[\s\S]*?preloadHomeEntitySheets\(\)/u);
  assert.match(chatsPageSource, /if \(connectSheetOpen\) \{[\s\S]*?closeHomeEntitySheet\(\)/u);
  assert.match(sheetsSource, /sheetKey="connect"[\s\S]*?title="Подключить чат или канал"/u);
  assert.match(sheetsSource, /Добавьте бота в администраторы/u);
  assert.match(sheetsSource, /Включите доступ ко всем сообщениям/u);
  assert.match(sheetsSource, /Перешлите боту любое сообщение или пост/u);
  assert.match(sheetsSource, /Бот проверит права и добавит чат или канал/u);
  assert.doesNotMatch(sheetsSource, /Три коротких шага|Mini app закроется/u);
  assert.match(sheetsSource, /Открыть диалог с ботом/u);
  assert.match(sheetsSource, /<ol className="home-connect__steps" role="list">/u);
  assert.match(sheetsSource, /aria-label="Шаг 1"/u);
  assert.match(sheetsSource, /aria-label="Шаг 2"/u);
  assert.match(chatsPageNativeCss, /\.chats-command__connect \{[\s\S]*?color: var\(--home-ink\);/u);
  assert.match(
    chatsPageNativeCss,
    /\.home-connect__steps li > span \{[\s\S]*?color: var\(--home-ink\);/u,
  );
  assert.doesNotMatch(chatsPageSource, /closeMaxMiniApp/u);
});

test('home list keeps grouped rows at wide breakpoints', () => {
  assert.match(
    chatsPageNativeCss,
    /\.chats-home \.chat-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(chatsPageSource, /const CHAT_LIST_ROW_HEIGHT = 132;/u);
  assert.match(chatsPageSource, /const CHAT_LIST_VIRTUAL_ROW_PITCH = CHAT_LIST_ROW_HEIGHT \+ 8;/u);
  assert.doesNotMatch(chatsPageSource, /chat-card__moderator|HomeModeratorBadge|moderatorTarget/u);
  assert.doesNotMatch(chatsPageSource, /import ['"]\.\/home-moderator\.css['"]/u);
  assert.match(
    chatsPageSource,
    /top: index \* CHAT_LIST_VIRTUAL_ROW_PITCH,[\s\S]*?height: CHAT_LIST_ROW_HEIGHT/u,
  );
  assert.match(chatsPageSource, /height: filteredEntities\.length \* CHAT_LIST_VIRTUAL_ROW_PITCH/u);
  // Virtual rows receive the shared height inline; CSS must not override that geometry.
  assert.doesNotMatch(
    chatsPageSignalCss,
    /\.chat-card(?:\.glass-card)?(?=\s|,|:|\{)[^{}]*\{[^{}]*\bheight:\s*[^;}]+!important/u,
  );
  assert.match(
    chatsPageSignalCss,
    /\.chat-grid:not\(\.chat-grid--virtual\)[^{}]*h3\s*\{[^{}]*-webkit-line-clamp:\s*unset;/u,
  );
  assert.match(
    chatsPageSignalCss,
    /\.chat-grid--virtual[^{}]*h3\s*\{[^{}]*-webkit-line-clamp:\s*2;/u,
  );
});

test('category assignment is explicit, exclusive and stable while editing', () => {
  assert.match(chatsPageSource, /if \(categoryEditMode\) \{\s*return matchingEntities;/u);
  assert.match(chatsPageSource, /enabled: categoryEditMode && !homeOverlayOpen, priority: 600/u);
  assert.match(chatsPageSource, />\s*Готово\s*<\/button>/u);
  assert.match(chatsPageSource, /handleSetHomeEntityFavoriteType/u);
  assert.match(chatsPageSource, /favoritesActions\.setFavorite/u);
  assert.doesNotMatch(chatsPageSource, /toggleHomeEntityFavoriteType/u);
  assert.match(sheetsSource, /<fieldset className="favorite-picker__fieldset"/u);
  assert.match(sheetsSource, /type="radio"/u);
  assert.match(
    sheetsSource,
    /props\.selectedFavoriteType \? \([\s\S]*?favorite-picker__remove[\s\S]*?<strong>Убрать из избранного<\/strong>/u,
  );
  assert.doesNotMatch(sheetsSource, /<strong>Без категории<\/strong>/u);
  assert.match(
    chatsPageNativeCss,
    /\.favorite-picker__remove \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?color: var\(--danger\);/u,
  );
  assert.doesNotMatch(sheetsSource, /aria-pressed=/u);
});

test('home exposes sync, result and virtual-list state to assistive technology', () => {
  assert.match(
    chatsPageSource,
    /const homeSyncAccessibleLabel = `Статус списка: \$\{homeSyncStatus\.label\}`;/u,
  );
  assert.match(
    chatsPageSource,
    /className="chats-command__sr"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u,
  );
  assert.match(
    chatsPageSource,
    /'chats-command__refresh'[\s\S]*?homeSyncStatus\.tone === 'syncing'[\s\S]*?chats-command__sync-ring[\s\S]*?<RefreshGlyph/u,
  );
  assert.match(chatsPageSource, /\{homeSyncAccessibleLabel\}[\s\S]*?<\/span>/u);
  assert.doesNotMatch(
    chatsPageSource,
    /homeSyncVisualLabel|chats-command__sync-indicator|chats-command__sync-check|MAX на паузе/u,
  );
  assert.match(chatsPageSource, /<output[\s\S]*?aria-live="polite"[\s\S]*?homeResultStatus/u);
  assert.match(
    chatsPageSource,
    /role="listitem"[\s\S]*?aria-posinset=\{index \+ 1\}[\s\S]*?aria-setsize=\{filteredEntities\.length\}/u,
  );
  assert.match(
    chatsPageSource,
    /role="list"[\s\S]*?aria-label=\{`\$\{tabLabel\}: \$\{filteredEntities\.length\}`\}[\s\S]*?aria-busy=/u,
  );
  assert.doesNotMatch(chatsPageSource, /<GlassCard role="alert" aria-live="assertive">/u);
  assert.match(chatsPageSource, /<StatusState[\s\S]*?tone="danger"/u);
});

test('home reports favorite persistence failures through the shared toast', () => {
  assert.match(chatsPageSource, /const \{ pushToast \} = useToast\(\);/u);
  assert.match(
    chatsPageSource,
    /catch(?: \(error: unknown\))? \{[\s\S]*?pushToast\(\{[\s\S]*?tone: 'danger'/u,
  );
});

test('empty onboarding promotes the shared connection flow before refresh', () => {
  const connectIndex = onboardingSource.indexOf('onboarding-connect');
  const refreshIndex = onboardingSource.indexOf('onboarding-refresh');
  const cards = onboardingSource.match(/<GlassCard\b/gu) ?? [];

  assert.ok(connectIndex >= 0);
  assert.ok(refreshIndex >= 0);
  assert.ok(connectIndex < refreshIndex);
  assert.equal(cards.length, 1);
  assert.match(onboardingSource, /aria-controls="home-sheet-connect"/u);
  assert.match(onboardingSource, /Подключить чат или канал/u);
  assert.match(onboardingSource, /onConnect\(event\.currentTarget\)/u);
  assert.match(onboardingSource, /<RefreshGlyph[\s\S]*?Обновить/u);
  assert.doesNotMatch(
    onboardingSource,
    /<details\b|Показать инструкцию|слово «Старт»|onboarding-diagnostics|recentSignals/u,
  );
  assert.match(chatsPageSource, /isRefreshBlocked=\{isManualRefreshBlocked\}/u);
  assert.doesNotMatch(onboardingSource, /refreshLabel|getManagedEntityOnboardingDiagnostics/u);
});
