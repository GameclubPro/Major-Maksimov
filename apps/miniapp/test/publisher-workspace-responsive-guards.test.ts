import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');
const headerSource = readFileSync(
  new URL('../src/features/publications/publication-hub-header.tsx', import.meta.url),
  'utf8',
);
const headerCss = readFileSync(
  new URL('../src/features/publications/publication-hub-header.css', import.meta.url),
  'utf8',
);
const pickerSource = readFileSync(
  new URL('../src/features/publications/publication-target-picker.tsx', import.meta.url),
  'utf8',
);
const pickerCss = readFileSync(
  new URL('../src/features/publications/publication-target-picker.css', import.meta.url),
  'utf8',
);
const targetNoticesSource = readFileSync(
  new URL('../src/features/publications/publication-target-notices.tsx', import.meta.url),
  'utf8',
);
const targetSourcesSource = readFileSync(
  new URL('../src/features/publications/use-publication-target-sources.ts', import.meta.url),
  'utf8',
);
const publicationsSource = readFileSync(
  new URL('../src/pages/publications-page.tsx', import.meta.url),
  'utf8',
);
const initialTargetSource = readFileSync(
  new URL('../src/features/publications/use-initial-publication-target-route.ts', import.meta.url),
  'utf8',
);
const editorAutofocusSource = readFileSync(
  new URL('../src/features/publications/use-publication-editor-autofocus.ts', import.meta.url),
  'utf8',
);

test('Publik launches into its own entity catalog with Posts as a peer module', () => {
  assert.match(appSource, /LazyPublisherEntitiesPage|publisher-entities-page/u);
  assert.match(appSource, /const profileHomeRoute = me\.homeRoute;/u);
  assert.match(
    appSource,
    /<LazyPublisherEntitiesPage api=\{apiClient\} botDialogUrl=\{me\.botDialogUrl\}/u,
  );
  assert.match(shellSource, /profile === 'publisher' \? '\/'/u);
  assert.match(
    shellSource,
    /const shouldShowBottomNav =\s*isChatsRoute \|\| isPublicationsRoute \|\| isNetworksRoute \|\| isNetworkSettingsHub;/u,
  );
  assert.match(
    shellSource,
    /const isNetworksRoute =\s*profile === 'moderation' && networksEnabled && location\.pathname === '\/networks';/u,
  );
  assert.match(shellSource, /profile === 'moderation' && networksEnabled && 'bottom-nav--four'/u);
  assert.match(
    shellSource,
    /\{profile === 'moderation' && networksEnabled \? \(\s*<Link\s+to="\/networks"/u,
  );
  assert.match(
    shellSource,
    /\{profile === 'publisher' \? \(\s*<NavLink\s+to="\/publications"[\s\S]*?>Посты<\/span>/u,
  );
});

test('Posts uses one compact recipient status instead of a second catalog card', () => {
  assert.match(headerSource, /className=\{cn\('publication-publisher-status'/u);
  assert.match(headerSource, /Нет подключённых получателей/u);
  assert.match(headerSource, /<Link[\s\S]*?to="\/"[\s\S]*?Открыть получателей Публика/u);
  assert.doesNotMatch(
    headerSource,
    /настройк[^']*в Майоре|Настроить в Майоре|setupHandoffUrl|openMaxBotLink/u,
  );
  assert.doesNotMatch(headerSource, /Чаты и каналы|PublisherReadinessOverview/u);
  assert.match(
    headerCss,
    /\.publication-publisher-status \{[\s\S]*?grid-template-columns: 28px minmax\(0, 1fr\) 44px;/u,
  );
  assert.match(
    headerCss,
    /\.publication-publisher-status__copy small \{[\s\S]*?white-space: normal;/u,
  );
});

test('publisher target selection is a full-screen sheet with stable virtual rows', () => {
  const sourceHeight = Number(pickerSource.match(/TARGET_ROW_HEIGHT = (\d+);/u)?.[1]);
  const cssHeight = pickerCss.match(
    /\.publication-target-picker__list\.is-virtual \.publication-target-row \{[\s\S]*?height: max\((\d+)px, ([\d.]+)rem\);/u,
  );

  assert.ok(sourceHeight >= 44);
  assert.equal(Number(cssHeight?.[1]), sourceHeight);
  assert.equal(Number(cssHeight?.[2]) * 16, sourceHeight);
  assert.match(pickerSource, /TARGET_ROW_REM = TARGET_ROW_HEIGHT \/ 16/u);
  assert.match(pickerSource, /rootFontSize \* TARGET_ROW_REM/u);
  assert.match(pickerSource, /remoteSource && 'is-sheet'/u);
  assert.match(pickerSource, /role=\{remoteSource \? 'dialog' : 'region'\}/u);
  assert.match(pickerSource, /useNativeBackHandler/u);
  assert.match(pickerSource, /useVisualViewportOverlayStyle\(sheetOpen\)/u);
  assert.match(pickerSource, /event\.key !== 'Escape'/u);
  assert.match(
    pickerCss,
    /\.publication-target-picker__editor\.is-sheet \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;[\s\S]*?z-index: 140;/u,
  );
  assert.match(
    pickerCss,
    /\.publications-page\.is-editor:has\(\.publication-target-picker__editor\)[\s\S]*?\.publications-publish-bar \{[\s\S]*?visibility: hidden;[\s\S]*?pointer-events: none;/u,
  );
  assert.match(pickerSource, /list\.clientHeight <= targetRowHeight \* 2/u);
  assert.match(pickerSource, /onScroll=\{handleTargetListScroll\}/u);
  assert.match(pickerSource, /loadMoreRequestRef\.current/u);
  assert.match(pickerSource, /remoteSourceRef\.current\?\.onLoadMore\(\)/u);
  assert.match(pickerSource, /remoteSource\.fetchNextPageError \|\|/u);
  assert.match(
    pickerSource,
    /`Показано \$\{filteredChoices\.length\} из \$\{remoteSource\.filteredTotal\}`/u,
  );
  assert.doesNotMatch(pickerSource, /Выберите для публикации/u);
  assert.match(
    pickerSource,
    /className=\{cn\('publication-target-picker__list'[\s\S]*?publication-target-picker__pagination[\s\S]*?publication-target-picker__load-more/u,
  );
  assert.match(
    pickerCss,
    /\.publication-target-picker__editor\.is-sheet \.publication-target-picker__list \{[\s\S]*?overflow-y: auto;[\s\S]*?touch-action: pan-y;[\s\S]*?-webkit-overflow-scrolling: touch;/u,
  );
});

test('publisher editor keeps its header visible and its dock action within 320px', () => {
  assert.match(editorAutofocusSource, /focus\(\{ preventScroll: true \}\)/u);
  assert.match(
    headerCss,
    /\.publications-page\.is-publisher[\s\S]*?\.broadcast-publish-bar__primary \{[\s\S]*?grid-column: 1 \/ -1;/u,
  );
});

test('unavailable targets are truly disabled unless already selected for removal', () => {
  assert.match(pickerSource, /disabled=\{disabled \|\| \(unavailable && !selected\)\}/u);
  assert.doesNotMatch(pickerCss, /publication-target-row\.is-unavailable \{\s*opacity:/u);
});

test('next-page retry preserves pages and expired cursors reseed the query', () => {
  assert.doesNotMatch(targetSourcesSource, /readiness: 'ready'/u);
  assert.match(targetSourcesSource, /const result = await publisher\.fetchNextPage\(\)/u);
  assert.match(targetSourcesSource, /isInvalidPublisherEntitiesCursorError\(result\.error\)/u);
  assert.match(
    targetSourcesSource,
    /resetQueries\(\{ queryKey: publisherQueryKey, exact: true \}\)/u,
  );
  assert.doesNotMatch(
    targetSourcesSource,
    /fetchNextPage:\s*\(\) =>\s*publisher\.isFetchNextPageError/u,
  );
});

test('direct-target errors stay actionable and validation issues persist after submit', () => {
  assert.match(targetNoticesSource, /Получатель из ссылки пока не готов/u);
  assert.match(targetNoticesSource, /initialRoute\.retry/u);
  assert.match(
    publicationsSource,
    /issues=\{validationStarted && !fieldError \? validationIssues : \[\]\}/u,
  );
  assert.match(publicationsSource, /className="publication-submit-feedback" role="alert"/u);
  assert.match(initialTargetSource, /routeFailure\?\.routeKey === routeKey/u);
  assert.match(initialTargetSource, /appliedRouteRef\.current === routeKey/u);
});
