import { isDate } from 'node:util/types';
import type { ChatSettings } from '../prisma/prisma-client';
import type { ChatSettingsTemplate } from './chat-context-source';
import { ChatSettingsTemplateCache } from './chat-settings-template-cache';

function template(
  chatId: string,
  media = '',
  revision: string | null = null,
): ChatSettingsTemplate {
  const settings: Partial<ChatSettings> & Pick<ChatSettings, 'id' | 'chatId'> = {
    id: `settings-${chatId}`,
    chatId,
    reportsAliases: ['report'],
    botSpeechMedia: { nested: { imageBase64: media }, tags: ['original'] },
    linkRulesPolicy: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    linkPolicyEffectiveAt: new Date('2026-10-03T00:00:00.000Z'),
    trafficPolicyEffectiveAt: new Date('2026-10-04T00:00:00.000Z'),
  };
  return {
    proof: { settingsId: settings.id, revision },
    settings: settings as ChatSettings,
  };
}

describe('ChatSettingsTemplateCache', () => {
  it('retains ordinary settings when a single exceptional media template arrives', () => {
    const cache = new ChatSettingsTemplateCache();
    for (let index = 0; index < 200; index++) {
      cache.set(`ordinary-${index}`, template(`ordinary-${index}`, 's'.repeat(10_000)));
    }
    cache.set('exceptional', template('exceptional', 'x'.repeat(7_000_000)));
    expect(cache.get('exceptional')).toBeNull();
    for (let index = 0; index < 200; index++) {
      expect(cache.get(`ordinary-${index}`)?.settings.chatId).toBe(`ordinary-${index}`);
    }
    expect(cache.snapshot()).toMatchObject({ oversizedSkips: 1, capacityEvictions: 0 });
  });

  it('retains many chats sharing the same configured media without paying for each copy', () => {
    const cache = new ChatSettingsTemplateCache();
    for (let index = 0; index < 120; index++) {
      cache.set(`shared-${index}`, template(`shared-${index}`, 'm'.repeat(100_000)));
    }
    for (let index = 0; index < 120; index++) {
      expect(cache.get(`shared-${index}`)?.settings.botSpeechMedia).toEqual(
        template('expected', 'm'.repeat(100_000)).settings.botSpeechMedia,
      );
    }
    expect(cache.snapshot().estimatedBytes).toBeLessThan(2 * 1024 * 1024);
    expect(cache.snapshot().entries).toBe(120);
  });

  it('confines churn from distinct media to media-bearing templates', () => {
    const cache = new ChatSettingsTemplateCache();
    for (let index = 0; index < 200; index++) {
      cache.set(`ordinary-${index}`, template(`ordinary-${index}`, 's'.repeat(10_000)));
    }
    for (let index = 0; index < 30; index++) {
      cache.set(`media-${index}`, template(`media-${index}`, `${index}:` + 'm'.repeat(400_000)));
      expect(cache.snapshot().estimatedBytes).toBeLessThanOrEqual(cache.snapshot().maxBytes);
    }
    for (let index = 0; index < 200; index++) {
      expect(cache.get(`ordinary-${index}`)?.settings.chatId).toBe(`ordinary-${index}`);
    }
    expect(cache.get('media-29')?.settings.botSpeechMedia).toEqual(
      template('expected', '29:' + 'm'.repeat(400_000)).settings.botSpeechMedia,
    );
  });

  it.each([null, 'b29d39bf-7241-482e-8a92-bd32c9cba102'])(
    'isolates stored settings and proof from input and output mutations for revision %s',
    (revision) => {
      const cache = new ChatSettingsTemplateCache();
      const original = template('chat', 'media', revision);
      const expected = structuredClone(original);
      cache.set('chat', original);
      original.proof.settingsId = 'replaced-id';
      original.proof.revision = 'replaced-revision';
      original.settings.reportsAliases.push('input mutation');
      original.settings.botSpeechMedia = {};
      original.settings.createdAt.setTime(0);

      const first = cache.get('chat')!;
      expect(first).toEqual(expected);
      first.proof.revision = 'output mutation';
      first.settings.reportsAliases.push('output mutation');
      (first.settings.botSpeechMedia as { nested: { imageBase64: string } }).nested.imageBase64 =
        'changed';
      first.settings.updatedAt.setTime(0);

      const second = cache.get('chat')!;
      expect(second).toEqual(expected);
      expect(second).not.toBe(first);
      expect(second.settings).not.toBe(first.settings);
      expect(isDate(second.settings.createdAt)).toBe(true);
      expect(isDate(second.settings.updatedAt)).toBe(true);
      expect(isDate(second.settings.linkPolicyEffectiveAt)).toBe(true);
      expect(isDate(second.settings.trafficPolicyEffectiveAt)).toBe(true);
      expect(cache.snapshot()).toMatchObject({ hits: 2, misses: 0, writes: 1 });
    },
  );

  it('evicts the least recently used template at the entry limit', () => {
    const cache = new ChatSettingsTemplateCache({ maxEntries: 2 });
    cache.set('a', template('a'));
    cache.set('b', template('b'));
    expect(cache.get('a')?.settings.chatId).toBe('a');
    cache.set('c', template('c'));
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')?.settings.chatId).toBe('a');
    expect(cache.get('c')?.settings.chatId).toBe('c');
    expect(cache.snapshot()).toMatchObject({ entries: 2, capacityEvictions: 1, misses: 1 });
  });

  it('bounds compact bytes independently of the number of entries', () => {
    const oneEntry = new ChatSettingsTemplateCache();
    oneEntry.set('a', template('a', 'x'.repeat(20_000)));
    const weight = oneEntry.snapshot().estimatedBytes;
    const cache = new ChatSettingsTemplateCache({ maxBytes: weight * 2, maxEntries: 100 });
    for (const chatId of ['a', 'b', 'c']) {
      cache.set(chatId, template(chatId, 'x'.repeat(20_000)));
      expect(cache.snapshot().estimatedBytes).toBeLessThanOrEqual(weight * 2);
    }
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')?.settings.chatId).toBe('b');
    expect(cache.get('c')?.settings.chatId).toBe('c');
    expect(cache.snapshot()).toMatchObject({ entries: 2, capacityEvictions: 1 });
  });

  it('releases shared media only after the last owner, including repeated fields and replacement', () => {
    const cache = new ChatSettingsTemplateCache();
    const a = template('a', 'x'.repeat(100_000));
    a.settings.stopWordsMedia = a.settings.botSpeechMedia;
    cache.set('a', a);
    cache.set('b', template('b', 'x'.repeat(100_000)));
    expect(cache.snapshot().segments).toMatchObject({ mediaEntries: 1, sharedMediaReuses: 1 });
    (a.settings.botSpeechMedia as { tags: string[] }).tags.push('input mutation');
    const b = cache.get('b')!.settings;
    (b.botSpeechMedia as { tags: string[] }).tags.push('output mutation');
    expect(cache.get('a')!.settings.stopWordsMedia).toEqual(
      template('expected', 'x'.repeat(100_000)).settings.botSpeechMedia,
    );
    cache.set('a', template('a', 'replacement'));
    expect(cache.snapshot().segments.mediaEntries).toBe(1);
    cache.delete('b');
    expect(cache.snapshot().segments).toMatchObject({ mediaEntries: 0, mediaBytes: 0 });
    cache.delete('a');
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0 });
  });

  it('preserves a complete in-flight candidate after shared media eviction and cache clear', () => {
    const cache = new ChatSettingsTemplateCache({ maxBytes: 1024 * 1024 });
    cache.set('ordinary', template('ordinary'));
    cache.set('a', template('a', 'x'.repeat(100_000)));
    cache.set('b', template('b', 'x'.repeat(100_000)));
    const captured = cache.get('a')!;
    cache.set('c', template('c', 'y'.repeat(200_000)));
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
    expect(cache.get('ordinary')).not.toBeNull();
    expect(cache.snapshot().segments.mediaCapacityEvictions).toBe(1);
    cache.clear();
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0 });
    expect(captured).toEqual(template('a', 'x'.repeat(100_000)));
    expect(isDate(captured.settings.createdAt)).toBe(true);
  });

  it('rejects an oversized template without evicting unrelated entries or cloning its media', () => {
    const cache = new ChatSettingsTemplateCache({ maxEntryBytes: 2000 });
    cache.set('hot', template('hot'));
    const clone = jest.spyOn(globalThis, 'structuredClone');
    try {
      cache.set('huge', template('huge', 'x'.repeat(1_000_000)));
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    expect(cache.get('hot')?.settings.chatId).toBe('hot');
    expect(cache.get('huge')).toBeNull();
    expect(cache.snapshot()).toMatchObject({ entries: 1, oversizedSkips: 1, capacityEvictions: 0 });
  });

  it('removes the previous template when its replacement is oversized', () => {
    const cache = new ChatSettingsTemplateCache({ maxBytes: 2000 });
    cache.set('chat', template('chat'));
    cache.set('chat', template('chat', 'x'.repeat(2000)));
    expect(cache.get('chat')).toBeNull();
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0, oversizedSkips: 1 });
  });

  it('accounts for replacement, repeated deletion and clear without resetting cumulative counters', () => {
    const cache = new ChatSettingsTemplateCache();
    const small = template('chat');
    cache.set('chat', small);
    const smallWeight = cache.snapshot().estimatedBytes;
    cache.set('chat', template('chat', 'x'.repeat(1000)));
    expect(cache.snapshot().estimatedBytes).toBeGreaterThan(smallWeight);
    cache.set('chat', small);
    expect(cache.snapshot()).toMatchObject({ entries: 1, estimatedBytes: smallWeight, writes: 3 });
    cache.delete('chat');
    cache.delete('chat');
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0 });
    cache.set('second', template('second'));
    cache.clear();
    cache.clear();
    expect(cache.snapshot()).toMatchObject({ entries: 0, estimatedBytes: 0, writes: 4 });
  });

  it('keeps snapshots independent and free of identifiers or media content', () => {
    const cache = new ChatSettingsTemplateCache();
    cache.set('private-chat', template('private-chat', 'private-media'));
    const snapshot = cache.snapshot();
    snapshot.estimatedBytes = 0;
    expect(cache.snapshot().estimatedBytes).toBeGreaterThan(0);
    const { segments, ...counters } = snapshot;
    expect(
      [...Object.values(counters), ...Object.values(segments)].every(
        (value) => typeof value === 'number',
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/private-chat|private-media/u);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
    'falls back to bounded defaults for invalid limits %s',
    (limit) => {
      const cache = new ChatSettingsTemplateCache({
        maxBytes: limit,
        maxEntries: limit,
        maxEntryBytes: limit,
      });
      expect(cache.snapshot()).toMatchObject({
        maxBytes: 16 * 1024 * 1024,
        maxEntries: 2048,
        maxEntryBytes: 2 * 1024 * 1024,
      });
    },
  );

  it('truncates positive limits and caps the entry budget at the total byte budget', () => {
    const cache = new ChatSettingsTemplateCache({
      maxBytes: 5000.9,
      maxEntries: 2.9,
      maxEntryBytes: 10_000.9,
    });
    expect(cache.snapshot()).toMatchObject({ maxBytes: 5000, maxEntries: 2, maxEntryBytes: 5000 });
  });
});
