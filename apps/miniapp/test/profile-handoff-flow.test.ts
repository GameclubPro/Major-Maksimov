import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const eventsPageSource = readFileSync(
  new URL('../src/pages/events-page.tsx', import.meta.url),
  'utf8',
);
const channelStatsPageSource = readFileSync(
  new URL('../src/pages/channel-stats-page.tsx', import.meta.url),
  'utf8',
);

test('member profile handoffs persist the display name before opening MAX', () => {
  for (const source of [eventsPageSource, channelStatsPageSource]) {
    assert.match(source, /profileHandoffMutation = useMutation/u);
    assert.match(source, /onSuccess:[\s\S]*?openPrivateBotHandoff\(result\.botUrl\)/u);
    assert.match(source, /Persist the name before opening MAX/u);
    assert.doesNotMatch(source, /ProfileKeepalive/u);
  }
});
