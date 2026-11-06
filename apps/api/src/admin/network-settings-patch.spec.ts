import { chatRulesSchema, chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts';
import {
  buildNetworkSettingsPatch,
  commonNetworkSettingsFields,
  networkSettingsPaths,
  networkSettingsAuthoredKeys,
} from './network-settings-patch';

describe('source-free network settings patches', () => {
  it('omits the retired comparison selector while preserving legacy recipient settings', () => {
    const paths = networkSettingsPaths('chat', 'duplicates');
    expect(paths).not.toContain('duplicateCompareMode');
    expect(paths).toEqual(
      expect.arrayContaining([
        'antiDuplicateEnabled',
        'duplicatePhotoScope',
        'duplicateWarnWindowSec',
        'duplicateWarnMaxCount',
      ]),
    );
    const current = chatSettingsSchema.parse({ duplicateCompareMode: 'TEXT' });
    const next = buildNetworkSettingsPatch(current, 'chat', 'duplicates', [
      { path: 'duplicatePhotoScope', op: 'set', value: 'CHAT' },
    ]);
    expect(next.duplicatePhotoScope).toBe('CHAT');
    expect(next.duplicateCompareMode).toBe('TEXT');
    expect(commonNetworkSettingsFields(paths, [next])).not.toHaveProperty('duplicateCompareMode');
  });

  it('continues retained operations containing the retired selector without exposing it in new drafts', () => {
    const current = chatSettingsSchema.parse({
      duplicateCompareMode: 'MESSAGE',
      duplicatePhotoScope: 'SAME_AUTHOR',
    });
    const next = buildNetworkSettingsPatch(current, 'chat', 'duplicates', [
      { path: 'duplicateCompareMode', op: 'set', value: 'TEXT' },
      { path: 'duplicatePhotoScope', op: 'set', value: 'CHAT' },
    ]);
    expect(next.duplicateCompareMode).toBe('TEXT');
    expect(next.duplicatePhotoScope).toBe('CHAT');
    const paths = networkSettingsPaths('chat', 'duplicates');
    expect(paths).not.toContain('duplicateCompareMode');
    expect(commonNetworkSettingsFields(paths, [next])).not.toHaveProperty('duplicateCompareMode');
  });

  it('changes speech style without copying individual messages or media', () => {
    const current = chatSettingsSchema.parse({
      botSpeechStyle: 'FRIENDLY',
      greetingBotMessageText: 'Own greeting',
    });
    const next = buildNetworkSettingsPatch(current, 'chat', 'speechStyle', [
      { path: 'botSpeechStyle', op: 'set', value: 'IRONIC' },
    ]);
    expect(next.botSpeechStyle).toBe('IRONIC');
    expect(next.greetingBotMessageText).toBe('Own greeting');
  });
  it('retains rules recipient data and rejects publication and accidental list changes', () => {
    const current = {
      ...chatSettingsSchema.parse({}),
      rules: chatRulesSchema.parse({
        text: 'Own rules',
        buttons: [{ text: 'Own', url: 'https://own.example' }],
      }),
    };
    const next = buildNetworkSettingsPatch(current, 'chat', 'rules', [
      { path: 'rulesAttachViolationsEnabled', op: 'set', value: true },
    ]);
    expect(next.rules.text).toBe('Own rules');
    expect(next.rules.buttons).toEqual(current.rules.buttons);
    expect(next.rulesAttachViolationsEnabled).toBe(true);
    expect(() =>
      buildNetworkSettingsPatch(current, 'chat', 'rules', [
        { path: 'rules.publishedMessageId', op: 'set', value: 'foreign' },
      ]),
    ).toThrow();
    expect(() =>
      buildNetworkSettingsPatch(current, 'chat', 'rules', [
        { path: 'rules.buttons', op: 'set', value: [] },
      ]),
    ).toThrow();
    const cleared = buildNetworkSettingsPatch(current, 'chat', 'rules', [
      { path: 'rules.buttons', op: 'replace', value: [] },
    ]);
    expect(cleared.rules.buttons).toEqual([]);
  });
  it('validates retention separately and preserves a recipient duration when toggling', () => {
    const current = { messageRetention: { enabled: false, hours: 24 } };
    expect(
      buildNetworkSettingsPatch(current, 'chat', 'messageRetention', [
        { path: 'messageRetention.enabled', op: 'set', value: true },
      ]),
    ).toEqual({ messageRetention: { enabled: true, hours: 24 } });
    expect(() =>
      buildNetworkSettingsPatch(current, 'chat', 'messageRetention', [
        { path: 'messageRetention.hours', op: 'set', value: 12 },
      ]),
    ).toThrow();
    expect(networkSettingsPaths('chat', 'advertising')).toEqual(['advertising.enabled']);
    expect(() => networkSettingsPaths('channel', 'messageRetention')).toThrow();
  });
  it('retains each target own unrelated values and requires explicit array replacement', () => {
    const first = chatSettingsSchema.parse({
      antiSpamEnabled: false,
      maxMessageLength: 100,
      messageLimitsBotMessageText: 'first',
    });
    const second = chatSettingsSchema.parse({
      antiSpamEnabled: false,
      maxMessageLength: 200,
      messageLimitsBotMessageText: 'second',
    });
    for (const current of [first, second]) {
      const next = buildNetworkSettingsPatch(current, 'chat', 'limits', [
        { path: 'antiSpamEnabled', op: 'set', value: true },
      ]);
      expect(next.antiSpamEnabled).toBe(true);
      expect(next.maxMessageLength).toBe(current.maxMessageLength);
      expect(next.messageLimitsBotMessageText).toBe(current.messageLimitsBotMessageText);
    }
    expect(() =>
      buildNetworkSettingsPatch(first, 'chat', 'reports', [
        { path: 'reportsAliases', op: 'set', value: ['signal'] },
      ]),
    ).toThrow();
  });
  it('does not erase sibling media when one media slot changes', () => {
    const image = { mimeType: 'image/png', base64: 'YQ==', fileName: 'one.png' };
    const current = chatSettingsSchema.parse({
      botSpeechMedia: { profanityBotMessageText: image, textFiltersBotMessageText: image },
    });
    const next = buildNetworkSettingsPatch(current, 'chat', 'commercialFilter', [
      { path: 'botSpeechMedia.textFiltersBotMessageText', op: 'clear' },
    ]);
    expect(next.botSpeechMedia.profanityBotMessageText).toEqual(image);
    expect(next.botSpeechMedia.textFiltersBotMessageText).toBeUndefined();
  });
  it('keeps explicit empty button arrays empty and synchronizes only their compatibility aliases', () => {
    const current = chatSettingsSchema.parse({
      linkBotButtonEnabled: false,
      linkBotButtons: [{ text: 'Own link', url: 'https://own.example' }],
      greetingBotButtons: [{ text: 'Greeting', url: 'https://greeting.example' }],
    });
    const changes = [{ path: 'linkBotButtons', op: 'replace' as const, value: [] }];
    const next = buildNetworkSettingsPatch(current, 'chat', 'links', changes);
    expect(next.linkBotButtons).toEqual([]);
    expect(next.linkBotButtonUrl).toBe('');
    expect(next.linkBotButtonText).toBe('Открыть');
    expect(next.greetingBotButtons).toEqual(current.greetingBotButtons);
    expect(networkSettingsAuthoredKeys(changes)).toEqual(
      expect.arrayContaining(['linkBotButtons', 'linkBotButtonUrl', 'linkBotButtonText']),
    );
    expect(networkSettingsPaths('chat', 'links')).not.toContain('linkBotButtonUrl');
  });
  it('edits subscription membership through its canonical list and includes computed storage flags', () => {
    expect(networkSettingsPaths('chat', 'requiredSubscription')).not.toContain(
      'requiredSubscriptionEnabled',
    );
    const changes = [
      { path: 'requiredSubscriptionChannelIds', op: 'replace' as const, value: ['channel'] },
    ];
    const next = buildNetworkSettingsPatch(
      chatSettingsSchema.parse({}),
      'chat',
      'requiredSubscription',
      changes,
    );
    expect(next.requiredSubscriptionEnabled).toBe(true);
    expect(networkSettingsAuthoredKeys(changes)).toEqual(
      expect.arrayContaining([
        'requiredSubscriptionChannelIds',
        'requiredSubscriptionEnabled',
        'requiredSubscriptionBotMessageEnabled',
      ]),
    );
  });
  it('retains target stop lists while changing a nested sanction field', () => {
    const policy = stopWordsPolicySchema.parse({
      domains: ['one.example'],
      sanctions: { muteDurationHours: 17 },
    });
    const next = buildNetworkSettingsPatch({ stopWordsPolicy: policy }, 'chat', 'stopWords', [
      { path: 'stopWordsPolicy.sanctions.warnEnabled', op: 'set', value: true },
    ]);
    expect(next.stopWordsPolicy.domains).toEqual(['one.example']);
    expect(next.stopWordsPolicy.sanctions.muteDurationHours).toBe(17);
    expect(next.stopWordsPolicy.sanctions.warnEnabled).toBe(true);
  });
  it('separates entity-specific sections and rejects cross-domain/prototype paths', () => {
    expect(() => networkSettingsPaths('channel', 'night')).toThrow();
    expect(() => networkSettingsPaths('chat', 'comments')).toThrow();
    const current = chatSettingsSchema.parse({});
    for (const path of ['commentsEnabled', '__proto__.polluted', 'stopWordsPolicy.enabled'])
      expect(() =>
        buildNetworkSettingsPatch(current, 'chat', 'limits', [{ path, op: 'set', value: true }]),
      ).toThrow();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it('keeps mixed values distinct from common false, null and empty arrays', () => {
    expect(
      commonNetworkSettingsFields(
        ['enabled', 'list', 'missing'],
        [
          { enabled: false, list: [] },
          { enabled: true, list: [] },
        ],
      ),
    ).toEqual({
      enabled: { kind: 'mixed' },
      list: { kind: 'common', value: [] },
      missing: { kind: 'common', value: null },
    });
  });
});
