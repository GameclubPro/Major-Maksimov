import {
  PUBLIC_HANDLE_CHANNEL as channel,
  createHandleLookupMock,
} from './max-handle-navigation.fixture';
import { LinkPolicy } from '../../prisma/prisma-client';
import { detectBlockedLink } from '../rule-engine-link-detector';
import { resolveEnabledNavigationTargetOptions } from './enabled-navigation-targets';
import { adaptMaxMessageNavigationView } from './max-navigation-view.adapter';
import { resolveEnabledNavigationTargets } from './max-handle-navigation';

function harness() {
  const handleLookup = createHandleLookupMock().mockResolvedValue(channel);
  const options = resolveEnabledNavigationTargetOptions();
  return {
    handleLookup,
    options,
    resolve: (message: unknown, enabled = true) =>
      resolveEnabledNavigationTargets(
        adaptMaxMessageNavigationView(message),
        options,
        { resolvePublicChannelHandle: handleLookup },
        enabled,
      ),
  };
}

describe('confirmed MAX handle navigation', () => {
  it.each([
    undefined,
    [{ type: 'user_mention', from: 3, length: 14, user_link: '@azov_overhear' }],
  ])('blocks the confirmed channel behind an @ handle (markup=%j)', async (markup) => {
    const h = harness();
    const targets = await h.resolve({ body: { text: '😀 @azov_overhear подпишись', markup } });
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalizedTarget: channel.url, enforceable: true }),
      ]),
    );
    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets)).not.toBeNull();
    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, [channel.url!], undefined, targets),
    ).toBeNull();
  });

  it.each([
    { type: 'user_mention', user_id: 67123224 },
    { type: 'user_mention', user_id: '67123224', user_link: '@azov_overhear' },
    { type: 'user_mention' },
    { type: 'code' },
    { type: 'pre' },
    { type: 'monospaced' },
    { type: 'link', url: 'https://allowed.example/' },
  ])('never reinterprets a protected range: %j', async (markup) => {
    const h = harness();
    await h.resolve({
      body: { text: '@azov_overhear', markup: [{ ...markup, from: 0, length: 14 }] },
    });
    expect(h.handleLookup).not.toHaveBeenCalled();
  });

  it('rejects a proof for another handle', async () => {
    const h = harness();
    h.handleLookup.mockResolvedValue({ ...channel, url: 'https://max.ru/different' });
    expect(await h.resolve({ body: { text: '@azov_overhear' } })).toEqual([]);
  });

  it.each([403, 404, 429, 500])(
    'preserves an ordinary @person on unavailable chat resolution (%s)',
    async (status) => {
      const h = harness();
      h.handleLookup.mockRejectedValue({ response: { status } });
      for (const markup of [
        undefined,
        [{ type: 'user_mention', from: 0, length: 7, user_link: '@person' }],
      ]) {
        expect(await h.resolve({ body: { text: '@person', markup } })).toEqual([]);
      }
    },
  );

  it.each([
    'mail@azov_overhear.ru',
    'mail+@azov_overhear',
    'https://example.com/@azov_overhear',
    '@azov_overhear.ru',
    'слово@azov_overhear',
    '@@azov_overhear',
  ])('does not resolve a fragment of %s', async (text) => {
    const h = harness();
    await h.resolve({ body: { text } });
    expect(h.handleLookup).not.toHaveBeenCalled();
  });

  it('uses the named target, not a user-mention display label', async () => {
    const h = harness();
    const targets = await h.resolve({
      body: {
        text: '@person',
        markup: [{ type: 'user_mention', from: 0, length: 7, user_link: '@azov_overhear' }],
      },
    });
    expect(targets[0]?.normalizedTarget).toBe(channel.url);
    expect(h.handleLookup).toHaveBeenCalledWith(channel.url, 800);
  });

  it('deduplicates repeated names only within the current message and refreshes the next check', async () => {
    const h = harness();
    const message = { body: { text: '(@AZOV_OVERHEAR), @azov_overhear.' } };
    expect((await h.resolve(message))[0]?.origins).toHaveLength(2);
    expect(h.handleLookup).toHaveBeenCalledTimes(1);
    h.handleLookup.mockRejectedValue(new Error('now a person or unavailable'));
    expect(await h.resolve(message)).toEqual([]);
    expect(h.handleLookup).toHaveBeenCalledTimes(2);
  });

  it('resolves visible forwards, never quoted reply targets', async () => {
    const h = harness();
    expect(
      (await h.resolve({ link: { type: 'forward', message: { text: '@azov_overhear' } } }))[0]
        ?.origins[0]?.provenance,
    ).toBe('visible_forward');
    h.handleLookup.mockClear();
    expect(
      await h.resolve({ link: { type: 'reply', message: { text: '@azov_overhear' } } }),
    ).toEqual([]);
    expect(h.handleLookup).not.toHaveBeenCalled();
  });

  it('preserves rollback switches and inactive policy without lookups', async () => {
    const h = harness();
    const message = { body: { text: '@azov_overhear' } };
    expect(await h.resolve(message, false)).toEqual([]);
    h.options.textClickabilityEnabled = false;
    expect(await h.resolve(message)).toEqual([]);
    h.options.structuredTargetsEnabled = false;
    expect(
      await h.resolve({
        body: {
          text: '@azov_overhear',
          markup: [{ type: 'user_mention', from: 0, length: 14, user_link: '@azov_overhear' }],
        },
      }),
    ).toEqual([]);
    h.options.forwardedTargetsEnabled = false;
    expect(await h.resolve({ link: { type: 'forward', message: message.body } })).toEqual([]);
    expect(h.handleLookup).not.toHaveBeenCalled();
  });

  it('bounds distinct unresolved names and never grants authority to excess candidates', async () => {
    const h = harness();
    h.handleLookup.mockRejectedValue(new Error('unknown'));
    expect(await h.resolve({ body: { text: '@one @two @three @four @five @six' } })).toEqual([]);
    expect(h.handleLookup).toHaveBeenCalledTimes(4);
  });

  it('keeps malformed mention ranges conservative', async () => {
    const h = harness();
    expect(
      await h.resolve({
        body: { text: '@azov_overhear', markup: [{ type: 'user_mention', from: -1, length: 14 }] },
      }),
    ).toEqual([]);
    expect(h.handleLookup).not.toHaveBeenCalled();
  });

  it('preserves a named range overlapped by code or an ID-bound user mention', async () => {
    for (const protectedMarkup of [{ type: 'code' }, { type: 'user_mention', user_id: 67123224 }]) {
      const h = harness();
      expect(
        await h.resolve({
          body: {
            text: '@azov_overhear',
            markup: [
              { type: 'user_mention', from: 0, length: 14, user_link: '@azov_overhear' },
              { ...protectedMarkup, from: 0, length: 14 },
            ],
          },
        }),
      ).toEqual([]);
      expect(h.handleLookup).not.toHaveBeenCalled();
    }
  });

  it('stops new lookups when the message budget expires', async () => {
    const h = harness();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      h.handleLookup.mockImplementation(async () => {
        now.mockReturnValue(3_001);
        return channel;
      });
      await h.resolve({ body: { text: '@azov_overhear @another_channel' } });
      expect(h.handleLookup).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });
});
