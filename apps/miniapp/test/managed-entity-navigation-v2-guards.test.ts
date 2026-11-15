import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);

  assert.ok(startIndex >= 0, `Missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

const appSource = readSource('../src/app.tsx');
const shellSource = readSource('../src/components/shell.tsx');
const homeSource = readSource('../src/pages/chats-page.tsx');
const navigationSource = readSource('../src/lib/managed-entity-navigation.tsx');
const navigationContextSource = readSource('../src/lib/managed-entity-navigation-context.ts');
const directEntrySource = readSource('../src/lib/managed-entity-direct-entry.ts');
const workspaceHeaderSource = readSource(
  '../src/components/ui/managed-entity-workspace-header.tsx',
);
const workspaceHeaderCss = readSource('../src/components/ui/managed-entity-workspace-header.css');
const compactIconsSource = readSource('../src/components/ui/compact-icons.tsx');
const actionConfirmSheetSource = readSource('../src/components/ui/action-confirm-sheet.tsx');
const chatSettingsSource = readSource('../src/pages/settings-page.legacy.tsx');
const chatSettingsWorkspaceSource = readSource('../src/pages/settings/chat-settings-workspace.tsx');
const chatSettingsDraftSource = readSource('../src/pages/settings/use-settings-draft.ts');
const channelSettingsSource = readSource('../src/pages/channel-settings-page.tsx');
const chatStatsSource = readSource('../src/pages/events-page.tsx');
const channelStatsSource = readSource('../src/pages/channel-stats-page.tsx');

test('authenticated app keeps the lightweight router and syncs runtime launch context', () => {
  assert.match(appSource, /const AppRouter = HASH_ROUTER_ENABLED \? HashRouter : Router;/u);
  assert.doesNotMatch(appSource, /createBrowserRouter|createHashRouter|RouterProvider/u);
  assert.match(
    appSource,
    /<AppRouter basename=\{ROUTER_BASENAME\}>[\s\S]*?<PreviewScaffold initialDevice=\{preview\.device\}>/u,
  );
  assert.match(
    appSource,
    /<AppRoutes[\s\S]*?apiClient=\{apiClient\}[\s\S]*?launchInitData=\{initData\}[\s\S]*?launchRouteResolver=\{launchRouteResolver\}[\s\S]*?\/>/u,
  );
  assert.match(appSource, /function LaunchRouteSync[\s\S]*?navigate\(mergedTargetRoute/u);
  assert.match(
    appSource,
    /lazy\(async \(\) => \{[\s\S]*?import\('\.\/lib\/managed-entity-navigation'\)/u,
  );
  assert.match(
    appSource,
    /<AppRouteShell[\s\S]*?launchRouteAppliedRef=\{launchRouteAppliedRef\}[\s\S]*?managedEntityWorkspace/u,
  );
});

test('direct managed routes synthesize an adjacent home history entry before router creation', () => {
  const routerPreparationSource = sourceBetween(
    appSource,
    'if (apiClient && !authenticatedRouterPreparedRef.current)',
    'if (!apiClient && isPublicLegalPathnameFromWindow',
  );

  assert.ok(
    directEntrySource.includes(
      'route.pathname.match(/^\\/(chat|channel)\\/([^/]+)\\/(settings|events|stats)\\/?$/iu)',
    ),
  );
  assert.match(directEntrySource, /createManagedEntityWorkspaceState\(\{/u);
  assert.match(
    directEntrySource,
    /origin: existingHomeWorkspace\?\.origin \?\? \{ locationKey: homeLocationKey, historyIndex \}/u,
  );
  assert.match(
    directEntrySource,
    /mergeManagedEntityWorkspaceRouteState\(baseRouteState, workspaceState\)/u,
  );
  assert.match(
    directEntrySource,
    /existingWorkspace\?\.entityType === managedRoute\.entityType[\s\S]*?existingWorkspace\.entityId === managedRoute\.entityId/u,
  );
  assert.match(
    directEntrySource,
    /matchingWorkspace &&[\s\S]*?decideManagedEntityWorkspaceBack\(\{[\s\S]*?currentLocationKey,[\s\S]*?currentHistoryIndex: historyIndex,[\s\S]*?\}\) === 'history-back'/u,
  );
  assert.match(
    directEntrySource,
    /const matchingOrigin = matchingWorkspace\?\.origin;[\s\S]*?matchingOrigin\.locationKey === currentLocationKey[\s\S]*?matchingOrigin\.historyIndex === historyIndex/u,
  );
  assert.match(
    directEntrySource,
    /const homeRouteState = mergeManagedEntityWorkspaceRouteState\([\s\S]*?existingHomeWorkspace \? legacyRouteState : null,[\s\S]*?workspaceState,[\s\S]*?usr: homeRouteState/u,
  );
  assert.match(
    directEntrySource,
    /const homeRoute = buildManagedEntityHomeRoute\(managedRoute\.entityType, parsedRoute\.search\)/u,
  );
  assert.match(
    directEntrySource,
    /usr: detailRouteState,[\s\S]*?key: detailLocationKey,[\s\S]*?idx: historyIndex \+ 1/u,
  );

  const replaceIndex = directEntrySource.indexOf('window.history.replaceState');
  const pushIndex = directEntrySource.indexOf('window.history.pushState');
  assert.ok(replaceIndex >= 0 && pushIndex > replaceIndex);
  assert.ok(
    routerPreparationSource.indexOf('applyInitialLaunchRoute(initialLaunchRoute)') <
      routerPreparationSource.indexOf('hasManagedEntityDirectEntryFromWindow()'),
  );
  assert.match(
    routerPreparationSource,
    /import\('\.\/lib\/managed-entity-direct-entry'\)[\s\S]*?module\.prepareManagedEntityDirectEntry\(/u,
  );
  assert.match(
    directEntrySource,
    /historyLocationKeySequence = \(historyLocationKeySequence \+ 1\)[\s\S]*?`managed-\$\{Date\.now\(\)\.toString\(36\)\}-\$\{historyLocationKeySequence\.toString\(36\)\}`/u,
  );
  assert.match(
    appSource,
    /location\.pathname === '\/'[\s\S]*?resolveManagedEntityLaunchHomeStep[\s\S]*?homeStep\.kind === 'normalize-home'[\s\S]*?navigate\(homeStep\.route, \{ replace: true \}\)[\s\S]*?buildManagedEntityLaunchRouteState[\s\S]*?navigate\(mergedTargetRoute, routeState \? \{ state: routeState \} : \{ replace: true \}\)/u,
  );
  assert.match(
    appSource,
    /managedEntityType && location\.pathname !== '\/'[\s\S]*?const homeRoute = `\/\?view=\$\{managedEntityType\}`[\s\S]*?canReturnToManagedEntityHome[\s\S]*?navigate\(-1\)[\s\S]*?navigate\(homeRoute, \{ replace: true \}\)/u,
  );
});

test('Shell delegates managed Back without consulting browser history length', () => {
  assert.doesNotMatch(shellSource, /window\.history\.length/u);
  assert.match(shellSource, /useOptionalManagedEntityNavigation\(\)/u);
  assert.match(
    shellSource,
    /if \(isManagedEntityRoute\)[\s\S]*?managedEntityNavigation\.requestBack\(homeRoute\)/u,
  );
});

test('navigation coordinator blocks dirty exits and exposes the exact confirmation actions', () => {
  assert.match(
    navigationSource,
    /<UNSAFE_NavigationContext\.Provider value=\{guardedNavigationContext\}>/u,
  );
  assert.match(
    navigationSource,
    /go: \(delta\)[\s\S]*?runOrQueueNavigation[\s\S]*?push: \(to, state, options\)[\s\S]*?replace: \(to, state, options\)/u,
  );
  assert.match(
    navigationSource,
    /event\.stopImmediatePropagation\(\);[\s\S]*?restorePopDeltaRef\.current = delta;[\s\S]*?window\.history\.go\(-delta\)/u,
  );
  assert.match(
    navigationContextSource,
    /window\.addEventListener\('popstate',[\s\S]*?activeHandler\?\.\(event\)/u,
  );
  assert.match(navigationSource, /return registerManagedEntityPopStateHandler\(handlePopState\)/u);
  assert.match(navigationSource, /window\.addEventListener\('beforeunload', handleBeforeUnload\)/u);
  assert.match(navigationSource, /event\.preventDefault\(\);\s*event\.returnValue = '';/u);
  assert.match(
    navigationSource,
    /window\.removeEventListener\('beforeunload', handleBeforeUnload\)/u,
  );
  assert.match(
    navigationSource,
    /if \(await guard\.save\(\)\)[\s\S]*?pendingNavigation\.run\(\);/u,
  );
  assert.match(navigationSource, /guard\.discard\(\);[\s\S]*?pendingNavigation\.run\(\);/u);
  assert.match(
    navigationSource,
    /const \[, setGuardRevision\] = useState\(0\)[\s\S]*?notifyLeaveGuardChanged[\s\S]*?setGuardRevision/u,
  );
  assert.match(
    navigationSource,
    /useLayoutEffect\(\(\) => \{\s*context\?\.notifyLeaveGuardChanged\(\);\s*\}, \[context, guard\.dirty, guard\.saving, guard\.discardOnly\]\);/u,
  );
  assert.match(navigationContextSource, /notifyLeaveGuardChanged: \(\) => void;/u);
  assert.match(
    navigationSource,
    /lazy\(async \(\) => \{[\s\S]*?import\('\.\.\/components\/ui\/action-confirm-sheet'\)/u,
  );
  assert.match(navigationSource, /title="Сохранить изменения\?"/u);
  assert.match(navigationSource, /confirmLabel="Сохранить и перейти"/u);
  assert.match(navigationSource, /extraActionLabel="Выйти без сохранения"/u);
  assert.match(navigationSource, /cancelLabel="Отмена"/u);
});

test('dirty confirmation restores focus after transient saving state changes', () => {
  assert.match(
    actionConfirmSheetSource,
    /useEffect\(\(\) => \{[\s\S]*?if \(!open\)[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?!panel\.contains\(document\.activeElement\)[\s\S]*?cancelButton && !cancelButton\.disabled \? cancelButton : panel[\s\S]*?focus\(\{\s*preventScroll: true,[\s\S]*?\}, \[isBusy, open\]\);/u,
  );
});

test('shared workspace header replaces counterpart routes and preserves route state', () => {
  assert.match(
    workspaceHeaderSource,
    /preserveManagedEntityRouteContext\(\s*counterpartTo,\s*location\.search,\s*location\.hash,[\s\S]*?requestNavigation\(resolvedCounterpartRoute, \{\s*replace: true,\s*state: counterpartRouteState,\s*flushSync: true,\s*\}\)/u,
  );
  assert.match(
    workspaceHeaderSource,
    /const counterpartRouteState = \{[\s\S]*?routeState[\s\S]*?chatTitle: authoritativeTitle \|\| routeTitle \|\| resolvedTitle,[\s\S]*?avatarUrl: hasAuthoritativeIdentity/u,
  );
  assert.match(
    workspaceHeaderSource,
    /requestNavigation\(\s*\{\s*pathname: location\.pathname,[\s\S]*?replace: true,[\s\S]*?state: \{[\s\S]*?chatTitle: authoritativeTitle[\s\S]*?avatarUrl: authoritativeAvatarUrl/u,
  );
  assert.match(workspaceHeaderSource, /onBack=\{\(\) => requestBack\(backTo\)\}/u);
  assert.match(
    workspaceHeaderSource,
    /const height = Math\.max\(0, header\.getBoundingClientRect\(\)\.height\);[\s\S]*?--managed-entity-workspace-header-bottom/u,
  );
  assert.doesNotMatch(workspaceHeaderSource, /getBoundingClientRect\(\)\.bottom/u);
  assert.match(
    workspaceHeaderCss,
    /\.managed-entity-workspace-header \.compact-page-header__back,\s*\.managed-entity-workspace-header__counterpart \{[\s\S]*?width: 44px;[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;/u,
  );
  assert.match(
    workspaceHeaderCss,
    /\.managed-entity-workspace-header \.compact-page-header__subtitle,[\s\S]*?color: var\(--text-secondary\);/u,
  );
  assert.match(
    workspaceHeaderSource,
    /const CounterpartIcon = screen === 'settings' \? StatisticsGlyph : SettingsGlyph/u,
  );
  assert.match(
    compactIconsSource,
    /export function SettingsGlyph[\s\S]*?<AppIcon icon="Settings"/u,
  );
  assert.match(
    workspaceHeaderCss,
    /\.managed-entity-workspace-header \.compact-page-header__title \{[\s\S]*?white-space: normal;[\s\S]*?-webkit-line-clamp: 2;/u,
  );
  assert.match(
    workspaceHeaderCss,
    /\.managed-entity-workspace-header\.compact-page-header\.is-compact \.compact-page-header__bar \{[\s\S]*?52px/u,
  );
  assert.match(
    workspaceHeaderCss,
    /\.managed-entity-workspace-header\.compact-page-header\.is-compact \{\s*--compact-page-header-height: 52px;/u,
  );
  assert.match(workspaceHeaderCss, /background: var\(--color-surface\);/u);
});

test('home snapshots its entry before pushing detail and restores list context after Back', () => {
  const navigationSource = sourceBetween(
    homeSource,
    'function handleEntityNavigation',
    'function prefetchEntitySettings',
  );

  assert.match(homeSource, /buildManagedEntitySettingsRoute\(activeTab, entity\.id\)/u);
  assert.match(homeSource, /buildManagedEntityStatisticsRoute\(/u);
  assert.match(
    navigationSource,
    /createManagedEntityWorkspaceState\(\{[\s\S]*?origin:[\s\S]*?locationKey: location\.key,[\s\S]*?historyIndex,[\s\S]*?homeSnapshot/u,
  );
  assert.match(navigationSource, /replaceCurrentRouterState\(homeRouteState\)/u);
  assert.match(navigationSource, /saveManagedEntityHomeSnapshot\(/u);
  assert.match(homeSource, /readManagedEntityStatsPreference\(/u);
  assert.match(homeSource, /mergeManagedEntityStatsPreference\(/u);
  assert.match(
    navigationSource,
    /buildManagedEntityStatisticsRoute\(activeTab, entity\.id, statsPreference\)/u,
  );
  assert.match(navigationSource, /navigate\(resolvedTargetRoute, \{ state: detailRouteState \}\)/u);
  assert.match(
    navigationSource,
    /preserveManagedEntityRouteContext\(\s*buildManagedEntityStatisticsRoute\(activeTab, entity\.id, statsPreference\),\s*location\.search,\s*location\.hash,\s*\)/u,
  );
  assert.ok(
    navigationSource.indexOf('replaceCurrentRouterState(homeRouteState)') <
      navigationSource.indexOf('navigate(resolvedTargetRoute'),
  );

  assert.match(homeSource, /resolveManagedEntityHomeAnchor\(/u);
  assert.match(homeSource, /pendingHomeSnapshotRestoreRef\.current\?\.restoreKey/u);
  assert.match(homeSource, /data-entity-id=\{entity\.id\}/u);
  assert.match(homeSource, /data-action="settings"/u);
  assert.match(homeSource, /data-action="statistics"/u);
  assert.match(homeSource, /focus\(\{ preventScroll: true \}\)/u);
  assert.match(
    homeSource,
    /const \[query, setQuery\] = useState\(\(\) => initialHomeSnapshot\?\.query \?\? ''\)/u,
  );
  assert.match(
    homeSource,
    /pendingRestore\?\.restoreKey !== homeSnapshotRestoreKey \|\|\s*isLoading \|\|\s*queryError \|\|\s*!isSyncSettled/u,
  );
  assert.match(homeSource, /getManagedEntitySessionStorage\(\)/u);
  assert.match(
    homeSource,
    /current\.contextKey === virtualizationContextKey && current\.initialized/u,
  );
});

test('statistics pages persist route preferences against their Home origin', () => {
  for (const [source, saveHelper] of [
    [chatStatsSource, 'saveChatStatsPreference'],
    [channelStatsSource, 'saveChannelStatsPreference'],
  ] as const) {
    assert.match(source, /saveManagedEntityStatsPreferenceForWorkspace\(/u);
    assert.match(source, /getManagedEntitySessionStorage\(\)/u);
    assert.match(
      source,
      new RegExp(`${saveHelper}\\(location\\.state, chatId, routeQuery\\)`, 'u'),
    );
  }
  assert.match(
    readSource('../src/lib/managed-entity-workspace.ts'),
    /locationKey: workspace\.origin\.locationKey/u,
  );
});

test('canonical statistics routes sync query preferences into route state before settings', () => {
  for (const [source, entityType, stateBuilder] of [
    [chatStatsSource, 'chat', 'buildChatStatsRouteState'],
    [channelStatsSource, 'channel', 'buildChannelStatsRouteState'],
  ] as const) {
    assert.match(source, /hasManagedEntityStatsPreference\(location\.state/u);
    assert.match(source, new RegExp(`entityType: '${entityType}'`, 'u'));
    assert.match(
      source,
      /if \(nextSearch === location\.search && routeStateHasCurrentStatsPreference\)/u,
    );
    assert.match(
      source,
      new RegExp(
        `state: chatId[\\s\\S]*?${stateBuilder}\\(location\\.state, chatId, routeQuery\\)`,
        'u',
      ),
    );
  }

  assert.match(
    chatSettingsWorkspaceSource,
    /buildManagedEntityStatisticsRoute\([\s\S]*?readManagedEntityWorkspaceState\(location\.state\)\?\.statsPreference/u,
  );
  assert.match(
    channelSettingsSource,
    /buildManagedEntityStatisticsRoute\([\s\S]*?readManagedEntityWorkspaceState\(location\.state\)\?\.statsPreference/u,
  );
});

test('Home prefetch uses the same persisted statistics preference as navigation', () => {
  assert.match(homeSource, /const statsPreference = readEntityStatsPreference\(entity\.id\)/u);
  assert.match(homeSource, /prefetchEntityActivity\(activeTab, entity\.id, statsPreference\)/u);
  assert.match(homeSource, /const range = preference\.range \?\? DEFAULT_DASHBOARD_RANGE/u);
  assert.match(homeSource, /preference\.section === 'participants'/u);
  assert.match(homeSource, /client\.getChatModerationDashboard\(api, chatId, range/u);
  assert.match(homeSource, /channelStatsQueryKey\(chatId, range, 'overview'\)/u);
});

test('all managed detail screens provide authoritative identity to the shared header', () => {
  for (const source of [
    chatSettingsWorkspaceSource,
    channelSettingsSource,
    chatStatsSource,
    channelStatsSource,
  ]) {
    assert.match(source, /<ManagedEntityWorkspaceHeader[\s\S]*?authoritativeIdentity=\{/u);
  }

  assert.match(
    chatSettingsWorkspaceSource,
    /header \? \(header\.avatarUrl \?\? null\) : fallbackAvatarUrl/u,
  );
  assert.match(
    channelSettingsSource,
    /channelHeader \? \(channelHeader\.avatarUrl \?\? null\) : routeAvatarUrl/u,
  );
  assert.match(chatStatsSource, /authoritativeDashboardIdentity[\s\S]*?return null;/u);
  assert.match(
    channelStatsSource,
    /authoritativeStatsIdentity[\s\S]*?\? null[\s\S]*?: routeState\.avatarUrl/u,
  );
});

test('chat and channel settings register save and discard leave guards', () => {
  const chatLeaveGuard = sourceBetween(
    chatSettingsSource,
    '  useChatSettingsWorkspaceLeaveGuard({',
    '  function renderSectionSaveFooter(',
  );
  const workspaceMutation = sourceBetween(
    chatSettingsDraftSource,
    '  const workspaceMutation = useMutation({',
    '  useLayoutEffect(() => {',
  );
  assert.match(
    chatSettingsSource,
    /const isHeaderSaving =\s*isSavingSettings \|\|\s*isSavingRules \|\|\s*isPreparingRulesPublish \|\|\s*isSavingSpeechStyle \|\|\s*updateRulesAttachMutation\.isPending;/u,
  );
  assert.match(
    chatLeaveGuard,
    /settingsDirty:\s*hasChanges \|\| stopWordsReplacementAuthorized \|\| Object\.keys\(sharedFieldErrors\)\.length > 0,[\s\S]*?rulesDirty: hasRulesChanges,[\s\S]*?saving:\s*isHeaderSaving \|\|\s*isApplyingSectionToAll \|\|\s*isPublishingRules \|\|\s*isResettingPublishedRules,[\s\S]*?validateDraft,\s*saveSettings: saveWorkspaceDraft,\s*saveRules: \(\) => saveRulesDraftNow\(\{ forceButtonErrors: true \}\)/u,
  );
  assert.match(
    chatSettingsWorkspaceSource,
    /setMaxClosingConfirmation\(dirty \|\| saving\)[\s\S]*?useManagedEntityLeaveGuard\(\{\s*dirty,\s*saving,[\s\S]*?const payload = validateDraft\(draft\);[\s\S]*?if \(!payload\) \{[\s\S]*?return false;[\s\S]*?await saveSettings\(payload\);[\s\S]*?rulesDirty && !\(await saveRules\(\)\)[\s\S]*?discard: \(\) => \{[\s\S]*?setDraft\(normalizeWorkspaceDraft\(serverSettings\)\)[\s\S]*?setRulesDraft\(serverRules\)/u,
  );
  assert.doesNotMatch(chatSettingsWorkspaceSource, /updateSettings\(/u);
  assert.match(
    workspaceMutation,
    /return saveWorkspaceSettings\(\s*api,\s*\{\s*chatId: request\.identity\.chatId \?\? '',\s*draft: request\.payload,\s*baseline,\s*replacement: request\.replacement,\s*storageStatus: request\.storageStatus,?\s*\},\s*async \(progress\) => \{\s*if \(active\.current !== request\.identity\)/u,
  );
  assert.match(
    chatSettingsDraftSource,
    /async function saveWorkspaceDraft\(payload: ChatSettings\) \{[\s\S]*?await workspaceMutation\.mutateAsync\(\{\s*payload,\s*identity,\s*baseline: normalizeServerDraft\(serverSettings\),\s*replacement: stopWordsReplacement,\s*storageStatus: stopWordsStorageStatus,?\s*\}\);\s*if \(!isCurrentSettingsScope\(\)\) throw/u,
  );
  assert.match(
    chatLeaveGuard,
    /clearValidationErrors: \(\) => \{\s*discardStopWordsEditorState\(\);/u,
  );
  assert.match(
    channelSettingsSource,
    /useManagedEntityLeaveGuard\(\{\s*dirty: isDirty \|\| isPostSignatureDirty \|\| customButtonEditorOpen,\s*saving: autosaveState === 'saving' \|\| postSignatureSaveState === 'saving',\s*save: saveWorkspaceChanges,\s*discard: discardWorkspaceChanges,\s*\}\);/u,
  );
});
