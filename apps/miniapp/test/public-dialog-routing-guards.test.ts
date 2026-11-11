import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isManagedEntityWorkspacePath } from '../src/lib/last-chat';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const dialogPageSource = readSource('../src/pages/channel-dialog-page.tsx');
const suggestDialogPageSource = readSource('../src/pages/channel-suggest-dialog-page.tsx');
const appSource = readSource('../src/app.tsx');
const shellSource = readSource('../src/components/shell.tsx');
const unavailableStateSource = readSource('../src/components/public-dialog-unavailable-state.tsx');

test('only managed settings and statistics routes can update last-managed state', () => {
  assert.equal(isManagedEntityWorkspacePath('/chat/chat-a/settings'), true);
  assert.equal(isManagedEntityWorkspacePath('/chat/chat-a/events'), true);
  assert.equal(isManagedEntityWorkspacePath('/channel/channel-a/settings'), true);
  assert.equal(isManagedEntityWorkspacePath('/channel/channel-a/stats'), true);
  assert.equal(isManagedEntityWorkspacePath('/networks/chat/settings'), true);
  assert.equal(isManagedEntityWorkspacePath('/networks/chat/settings/links'), true);
  assert.equal(isManagedEntityWorkspacePath('/networks/channel/settings/'), true);
  assert.equal(isManagedEntityWorkspacePath('/networks/channel/settings/comments'), true);

  assert.equal(isManagedEntityWorkspacePath('/chat/public-b/dialog/comments'), false);
  assert.equal(isManagedEntityWorkspacePath('/channel/public-b/dialog/comments'), false);
  assert.equal(isManagedEntityWorkspacePath('/channel/public-b/dialog/suggest'), false);
  assert.equal(isManagedEntityWorkspacePath('/chat/chat-a/stats'), false);
  assert.equal(isManagedEntityWorkspacePath('/channel/channel-a/events'), false);
  assert.equal(isManagedEntityWorkspacePath('/networks'), false);
  assert.equal(isManagedEntityWorkspacePath('/networks/chat'), false);
  assert.equal(isManagedEntityWorkspacePath('/networks/chat/stats'), false);
  assert.equal(isManagedEntityWorkspacePath('/networks/user/settings'), false);
  assert.equal(isManagedEntityWorkspacePath('/networks/chat/settings/links/extra'), false);
  assert.equal(isManagedEntityWorkspacePath('/networks/channel/dialog/comments'), false);

  assert.match(
    shellSource,
    /const isManagedEntityRoute = isManagedEntityWorkspacePath\(location\.pathname\)/u,
  );
  assert.match(
    shellSource,
    /if \(!chatId \|\| !isManagedEntityRoute\) \{[\s\S]*?saveLastEntityId/u,
  );
});

test('public dialog pages keep terminal failures in the public flow', () => {
  assert.match(dialogPageSource, /setTerminalDialogErrorState\(\{/u);
  assert.match(suggestDialogPageSource, /setTerminalDialogErrorState\(\[/u);

  for (const source of [dialogPageSource, suggestDialogPageSource]) {
    assert.match(source, /<PublicDialogUnavailableState/u);
    assert.match(
      source,
      /title=\{sessionExpired \? 'Нужно открыть приложение заново' : 'Диалог недоступен'\}/u,
    );
    assert.doesNotMatch(source, /buildManagedEntitiesRoute|saveLastEntityId|navigate\(/u);
  }

  assert.match(unavailableStateSource, /onClick=\{\(\) => closeMaxMiniApp\(\)\}/u);
  assert.match(unavailableStateSource, /typeof getMaxBridge\(\)\?\.close === 'function'/u);
  assert.match(unavailableStateSource, /Закрыть приложение/u);
});

test('terminal suggestion submit failures replace the composer with the relaunch flow', () => {
  assert.match(
    suggestDialogPageSource,
    /onError: \(error\) => \{[\s\S]*?isTerminalDialogApiMessage\(message\)[\s\S]*?setTerminalDialogErrorState\(\[chatId, token, message\]\)[\s\S]*?cancelQueries\(\{ queryKey: dialogQueryKey \}\)[\s\S]*?return;/u,
  );
});

test('public suggestion submissions lazy-load the validated client', () => {
  assert.match(
    suggestDialogPageSource,
    /channelDialogClientPromise \?\?= import\('\.\.\/lib\/api\/channel-dialog-client'\)/u,
  );
  assert.match(suggestDialogPageSource, /channelDialogClientPromise = null;[\s\S]*?throw error;/u);
  assert.match(
    suggestDialogPageSource,
    /queryFn: \(\{ signal \}\) => getChannelSuggestDialog\(api, chatId, token, \{ signal \}\)/u,
  );
  assert.match(
    suggestDialogPageSource,
    /loadChannelDialogClient\(\)[\s\S]*?createChannelDialogMessage\(api, chatId, 'suggest', \{[\s\S]*?requestId: payload\.requestId/u,
  );
  assert.doesNotMatch(suggestDialogPageSource, /publisherSuggestions\(chatId\)/u);
  assert.doesNotMatch(
    suggestDialogPageSource,
    /import \{[^}]*createChannelDialogMessage[^}]*\} from '\.\.\/lib\/api\/channel-dialog-client'/u,
  );
  assert.doesNotMatch(suggestDialogPageSource, /response as CreateChannelDialogMessageResponse/u);
});

test('suggestion dialog state is remounted for every user, profile, chat and token pair', () => {
  assert.match(
    appSource,
    /function KeyedChannelSuggestDialogPage[\s\S]*?key=\{JSON\.stringify\(\[userId, profile, location\.pathname, location\.search\]\)\}/u,
  );
  assert.match(
    suggestDialogPageSource,
    /export function ChannelSuggestDialogPage[\s\S]*?const \[draft, setDraft\] = useState\(''\)/u,
  );
  assert.match(
    appSource,
    /path="\/channel\/:chatId\/dialog\/suggest"[\s\S]*?<KeyedChannelSuggestDialogPage[\s\S]*?api=\{apiClient\}[\s\S]*?profile=\{me\.profile\}[\s\S]*?userId=\{me\.userId\}/u,
  );
});

test('channel comments route follows the authenticated Major or Publik profile', () => {
  assert.match(
    appSource,
    /path="\/channel\/:chatId\/dialog\/comments"[\s\S]*?profile=\{me\.profile\}/u,
  );
});

test('both comments routes use the authenticated principal instead of a one-time bridge snapshot', () => {
  for (const entity of ['chat', 'channel']) {
    assert.match(
      appSource,
      new RegExp(`path="/${entity}/:chatId/dialog/comments"[\\s\\S]*?userId=\\{me\\.userId\\}`),
    );
  }
  assert.match(dialogPageSource, /userId: currentUserId/u);
  assert.doesNotMatch(dialogPageSource, /getInitDataUserId/u);
});

test('the app shares one stateful launch resolver between boot and router sync', () => {
  assert.match(
    appSource,
    /const launchRouteResolver = useMemo\(\(\) => createLaunchRouteResolver\(\), \[\]\)/u,
  );
  assert.match(appSource, /const initialLaunchRoute = launchRouteResolver\(initData\)/u);
  assert.match(appSource, /launchRouteResolver=\{launchRouteResolver\}/u);
});
