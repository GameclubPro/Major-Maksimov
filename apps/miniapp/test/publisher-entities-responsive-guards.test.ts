import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../src/pages/publisher-entities-page.tsx', import.meta.url),
  'utf8',
);
const pageCss = readFileSync(
  new URL('../src/pages/publisher-entities-page.css', import.meta.url),
  'utf8',
);
const workspaceCss = ['publisher-workspace.css', 'publisher-catalog-workspace.css']
  .map((file) => readFileSync(new URL(`../src/styles/${file}`, import.meta.url), 'utf8'))
  .join('\n');
const pickerSource = readFileSync(
  new URL('../src/features/publications/publication-target-picker.tsx', import.meta.url),
  'utf8',
);
const targetSourcesSource = readFileSync(
  new URL('../src/features/publications/use-publication-target-sources.ts', import.meta.url),
  'utf8',
);
const pickerCss = readFileSync(
  new URL('../src/features/publications/publication-target-picker.css', import.meta.url),
  'utf8',
);

test('publisher virtual list shares its text-scaled row height with CSS', () => {
  const sourceHeight = Number(pageSource.match(/PUBLISHER_ENTITY_ROW_HEIGHT = (\d+);/u)?.[1]);
  assert.equal(sourceHeight, 120);
  assert.match(pageCss, /height: var\(--publisher-entity-row-height, 120px\);/u);
  assert.match(pageSource, /rowHeight: entityRowHeight/u);
  assert.match(pageSource, /startIndex \* entityRowHeight/u);
  assert.match(pageSource, /rootFontSize \* PUBLISHER_ENTITY_ROW_REM/u);
  assert.match(pageSource, /observer.observe\(document.documentElement\)/u);
  assert.match(pageCss, /-webkit-line-clamp: 2;/u);
  assert.match(pageCss, /overflow-y: auto;[\s\S]*?touch-action: pan-y;/u);
  const listBlock = pageCss.match(/\.publisher-entities-page__list \{[\s\S]*?\n {2}\}/u)?.[0] ?? '';
  assert.match(listBlock, /flex: 1 1 0;/u);
  assert.match(listBlock, /min-height: 144px;/u);
  assert.match(listBlock, /scroll-padding-block: 8px 12px;/u);
  assert.doesNotMatch(listBlock, /bottom-nav|max-height: clamp/u);
  assert.doesNotMatch(listBlock, /(?:^|\n)\s*height:/u);
  assert.doesNotMatch(workspaceCss, /publisher-entities-page__list:not\(\.is-virtual\)/u);
});

test('publisher catalog reserves a layout track for navigation, including keyboard transitions', () => {
  assert.match(
    workspaceCss,
    /\.app-shell--publisher-catalog \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\) auto;/u,
  );
  assert.match(
    workspaceCss,
    /\.app-shell--publisher-catalog \.bottom-nav \{[\s\S]*?position: static;[\s\S]*?transform: none;/u,
  );
  assert.match(workspaceCss, /\.bottom-nav\.is-keyboard-open,[\s\S]*?display: none;/u);
  assert.match(pageSource, /new ResizeObserver\(measure\)/u);
  assert.match(pageSource, /observer\.disconnect\(\)/u);
});

test('catalog headings and search remain legible while filters load', () => {
  assert.match(pageSource, /currentSummary \?\? lastSummary \?\? EMPTY_PUBLISHER_SUMMARY/u);
  assert.match(pageSource, /<h1 id="publisher-catalog-title">Публик<\/h1>/u);
  assert.match(pageSource, /<strong title=\{entity.title\}>/u);
  assert.doesNotMatch(pageSource, /<label className="publisher-entities-page__search"/u);
  assert.match(
    pageCss,
    /\.publisher-entity-row__title strong \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?-webkit-line-clamp: 2;/u,
  );
});

test('publisher entity actions keep native touch targets at least 44px tall', () => {
  assert.match(pageCss, /\.publisher-entity-row__main \{[\s\S]*?min-height: 72px;/u);
  assert.match(
    pageCss,
    /\.publisher-entity-row__refresh \{\s*width: 44px;\s*min-width: 44px;\s*height: 44px;/u,
  );
  assert.match(
    pageSource,
    /className="publisher-entity-row__main"[\s\S]*?<IconoirSprite\b[^>]*icon="NavArrowRight"[^>]*aria-hidden[\s\S]*?<\/Link>[\s\S]*?\{canRecheck \? \(/u,
  );
  assert.doesNotMatch(pageSource, /publisher-entity-row__module-action|<span>Модули<\/span>/u);
});

test('publisher searches hide stale rows and next-page retries preserve loaded pages', () => {
  assert.match(pageSource, /const searchSettling = query\.trim\(\) !== debouncedQuery/u);
  assert.match(pageSource, /searchSettling \? \(/u);
  assert.match(pickerSource, /remoteSource\.settling/u);
  assert.match(targetSourcesSource, /isFetchNextPageError[\s\S]*?resetQueries/u);
  assert.match(
    pageSource,
    /retryPublisherEntitiesNextPage\(\{[\s\S]*?fetchNextPage: \(\) => entitiesQuery\.fetchNextPage\(\)[\s\S]*?resetInvalidCursor:/u,
  );
  assert.doesNotMatch(
    pageSource,
    /entitiesQuery\.isFetchNextPageError\s*\?\s*queryClient\.resetQueries/u,
  );
  assert.doesNotMatch(pageSource, /setQueriesData/u);
});

test('publisher entity pagination stays inside the only list scroll owner', () => {
  const scrollHandlerStart = pageSource.indexOf('function handleEntityListScroll');
  const scrollHandlerEnd = pageSource.indexOf('function renderEntity', scrollHandlerStart);
  const scrollHandlerSource = pageSource.slice(scrollHandlerStart, scrollHandlerEnd);
  const listStart = pageSource.indexOf('ref={listRef}');
  const paginationStart = pageSource.indexOf(
    'className="publisher-entities-page__pagination"',
    listStart,
  );
  const listEnd = pageSource.indexOf('\n        </div>\n      )}', paginationStart);

  assert.ok(scrollHandlerStart >= 0 && scrollHandlerEnd > scrollHandlerStart);
  assert.ok(listStart >= 0 && paginationStart > listStart && listEnd > paginationStart);
  assert.match(scrollHandlerSource, /threshold: entityRowHeight \* 2/u);
  assert.match(pageSource, /shouldLoadPublisherEntitiesNextPage\(\{/u);
  assert.match(pageSource, /onScroll=\{handleEntityListScroll\}/u);
  assert.match(pageSource, /nextPageRequestRef\.current/u);
  assert.match(scrollHandlerSource, /autoLoadArmedRef\.current = true/u);
  assert.match(scrollHandlerSource, /autoLoadArmedRef\.current = false/u);
  assert.match(scrollHandlerSource, /setListScrollTop\(list\.scrollTop\)/u);
  assert.match(scrollHandlerSource, /setListViewportHeight\(list\.clientHeight\)/u);
  assert.doesNotMatch(scrollHandlerSource, /if \(shouldVirtualize\)/u);
  const paginationBlock =
    pageCss.match(/\.publisher-entities-page__pagination \{[\s\S]*?\n {2}\}/u)?.[0] ?? '';
  assert.match(paginationBlock, /padding: 12px;/u);
  assert.doesNotMatch(paginationBlock, /bottom-nav|position:\s*(?:fixed|sticky)/u);
});

test('publisher target picker preserves scroll position across the virtualization transition', () => {
  const scrollHandlerStart = pickerSource.indexOf('function handleTargetListScroll');
  const scrollHandlerEnd = pickerSource.indexOf('function renderChoice', scrollHandlerStart);
  const scrollHandlerSource = pickerSource.slice(scrollHandlerStart, scrollHandlerEnd);

  assert.ok(scrollHandlerStart >= 0 && scrollHandlerEnd > scrollHandlerStart);
  assert.match(scrollHandlerSource, /setListScrollTop\(list\.scrollTop\)/u);
  assert.doesNotMatch(scrollHandlerSource, /if \(shouldVirtualize\)/u);
  assert.match(
    pickerSource,
    /useLayoutEffect\(\(\) => \{[\s\S]*?setListScrollTop\(list\.scrollTop\);[\s\S]*?filteredChoices\.length[\s\S]*?shouldVirtualize/u,
  );
});

test('expanded target picker removes the fixed publish dock from mobile hit testing', () => {
  assert.match(
    pickerCss,
    /\.publications-page\.is-editor:has\(\.publication-target-picker__editor\)[\s\S]*?\.publications-publish-bar \{[\s\S]*?visibility: hidden;[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/u,
  );
});

test('publisher catalog leaves entity switching to bottom navigation and keeps a compact count', () => {
  assert.doesNotMatch(pageSource, /publisher-entities-page__views/u);
  assert.match(pageSource, /buildPublisherEntityViewRoute\(otherView/u);
  assert.match(pageSource, /summary\[view\]/u);
  assert.match(pageSource, /view === 'channel' \? 'Каналы' : 'Чаты'/u);
  assert.match(pageSource, /shouldAutoOpenChannels/u);
  assert.match(pageSource, /buildPublisherEntityModulesRoute\(entity\)/u);
  assert.doesNotMatch(pageSource, /suggestionsViaPublik: enabled/u);
});

test('publisher home runs a real bounded MAX recheck and exposes forwarding onboarding', () => {
  assert.match(pageSource, /await refreshPublisherEntities\(api\)/u);
  assert.match(pageSource, /PUBLISHER_BULK_REFRESH_POLL_DELAYS_MS/u);
  assert.match(pageSource, /await entitiesQuery\.refetch\(\)/u);
  assert.match(pageSource, /openMaxBotLinkAndClose\(botDialogUrl\)/u);
  assert.match(pageSource, /перешлите ему сообщение или пост/u);
  assert.match(pageSource, /const hasCatalogControls =/u);
  assert.match(pageSource, /\{hasCatalogControls \? \(/u);
  assert.match(pageSource, /disabled=\{openingBotDialog\}/u);
  assert.doesNotMatch(pageSource, /disabled=\{openingBotDialog \|\| !botDialogUrl\}/u);
  assert.doesNotMatch(
    pageSource,
    /aria-label="Обновить чаты и каналы"[\s\S]*?resetQueries\(\{ queryKey: entitiesQueryKey/u,
  );
  assert.match(pageSource, /Проверяю подключения ·/u);
  assert.doesNotMatch(
    pageSource,
    /Проверка поставлена в очередь|description: 'Жду новый статус|MAX ещё проверяет/u,
  );
});
