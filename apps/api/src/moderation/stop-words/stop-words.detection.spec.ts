import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { WebhookParser } from '../../webhook/webhook.parser';
import {
  detectLegacyStopWordsViolations,
  detectStopWordsViolations,
  extractStopWordsTextSegments,
  fingerprintStopWordsSource,
} from './stop-words.detection';

function rawMessage(content: Record<string, unknown>) {
  return {
    update_type: 'message_created',
    message: {
      sender: { user_id: 'user-1' },
      recipient: { chat_id: 'chat-1', chat_type: 'chat' },
      timestamp: Date.now(),
      ...content,
      body: { mid: 'message-1', ...(content.body as Record<string, unknown> | undefined) },
    },
  };
}

function detect(content: Record<string, unknown>, value = 'casino') {
  const raw = rawMessage(content);
  const text = new WebhookParser().parse(raw).message!.text;
  const textSegments = extractStopWordsTextSegments(raw, text);
  const settings = {
    stopWordsPolicy: stopWordsPolicySchema.parse({
      enabled: true,
      rules: [{ id: 'rule-1', kind: value.includes(' ') ? 'PHRASE' : 'WORD', value }],
    }),
    stopWordsRevision: 1,
  };
  return { text, textSegments, hits: detectStopWordsViolations({ text, textSegments, settings }) };
}

describe('stop-word visible source text', () => {
  it('retains one source identity and separate first word/domain evidence', () => {
    const source = {
      text: 'casino https://blocked.example/path',
      textSegments: ['casino', 'https://blocked.example/path'],
      navigationTargets: [
        {
          kind: 'external_url' as const,
          target: 'https://blocked.example/path',
          normalizedTarget: 'https://blocked.example/path',
          enforceable: true,
          origins: [],
        },
      ],
    };
    const settings = {
      stopWordsPolicy: stopWordsPolicySchema.parse({
        enabled: true,
        rules: [{ id: 'word', kind: 'WORD', value: 'casino' }],
        domains: ['blocked.example'],
      }),
      stopWordsRevision: 7,
    };
    const hits = detectStopWordsViolations({ ...source, settings });
    expect(hits.map((hit) => hit.ruleCode)).toEqual([
      'MESSAGE_BLOCKED_WORD',
      'MESSAGE_BLOCKED_DOMAIN',
    ]);
    for (const hit of hits)
      expect(hit.metadata).toMatchObject({
        stopWordsSourceSha256: fingerprintStopWordsSource(source),
        stopWordsRevision: 7,
      });
    const edited = { ...source, textSegments: ['casino changed', source.textSegments[1]] };
    const editedHits = detectStopWordsViolations({ ...edited, settings });
    expect(editedHits[0].metadata?.stopWordsSourceSha256).not.toBe(
      hits[0].metadata?.stopWordsSourceSha256,
    );
  });

  it.each([
    { text: 'доход\n\nбез вложений' },
    { text: 'доход\r\rбез вложений' },
    { text: 'доход\r\n\r\nбез вложений' },
    { text: 'доход\u2028\u2028без вложений' },
    { text: 'доход\u2029без вложений' },
    { text: 'доход\fбез вложений' },
    { text: 'доход', body: { caption: 'без вложений' } },
    { text: 'доход', link: { type: 'forward', message: { text: 'без вложений' } } },
  ])('does not let legacy masking join source or paragraph boundaries %j', (content) => {
    const raw = rawMessage(content);
    const text = new WebhookParser().parse(raw).message!.text;
    const textSegments = extractStopWordsTextSegments(raw, text);
    expect(
      detectLegacyStopWordsViolations({
        text,
        textSegments,
        settings: {
          messageLimitsBlockedWords: ['доходбезвложений'],
          messageLimitsBlockedDomains: [],
        },
      }),
    ).toEqual([]);
  });
  it.each([
    { text: 'casino' },
    { caption: 'casino' },
    { plain: 'casino' },
    { message_text: 'casino' },
    { messageText: 'casino' },
    { body: { mid: 'message-1', text: 'casino' } },
    { body: { mid: 'message-1', caption: 'casino' } },
    { body: { mid: 'message-1', plain: 'casino' } },
    { content: { caption: 'casino' } },
    { payload: { caption: 'casino' } },
    { message: { caption: 'casino' } },
  ])('checks supported parser content %j', (content) => {
    const result = detect(content);
    expect(result.text).toBe('casino');
    expect(result.textSegments).toEqual(['casino']);
    expect(result.hits).toHaveLength(1);
  });

  it('checks supplemental text even when a body is present and deduplicates identical aliases', () => {
    const result = detect({ caption: 'casino', body: { mid: 'message-1', text: 'Safe' } });
    expect(result.hits).toHaveLength(1);
    expect(
      detect({ text: 'casino', body: { mid: 'message-1', text: 'CASINO' } }).textSegments,
    ).toEqual(['casino']);
  });

  it('preserves original paragraphs rather than using the flattened parser text', () => {
    const result = detect(
      { body: { mid: 'message-1', text: 'доход\n\nбез вложений' } },
      'доход без вложений',
    );
    expect(result.text).toBe('доход без вложений');
    expect(result.textSegments).toEqual(['доход\n\nбез вложений']);
    expect(result.hits).toEqual([]);
  });

  it.each(['\n\n', '\r\n\r\n', '\r\r', '\u2028\u2028', '\u2029', '\f'])(
    'retains paragraph %j from an equivalent alias without changing presented text',
    (barrier) => {
      const result = detect(
        {
          text: 'ДОХОД без вложений',
          body: { mid: 'message-1', text: `доход${barrier}без вложений` },
        },
        'доход без вложений',
      );
      expect(result.text).toBe('ДОХОД без вложений');
      expect(result.textSegments).toEqual([`доход${barrier}без вложений`]);
      expect(result.hits).toEqual([]);
    },
  );

  it('checks visible forward aliases but never quoted reply content', () => {
    const linked = { payload: { caption: 'casino' } };
    expect(detect({ link: { type: 'forward', message: linked } }).hits).toHaveLength(1);
    expect(detect({ link: { type: 'reply', message: linked } }).hits).toEqual([]);
  });

  it('does not create a phrase across aliases or direct and forwarded content', () => {
    expect(
      detect(
        { text: 'доход', body: { mid: 'message-1', caption: 'без вложений' } },
        'доход без вложений',
      ).hits,
    ).toEqual([]);
    expect(
      detect(
        {
          text: 'доход',
          link: { type: 'forward', body: { caption: 'без вложений' } },
        },
        'доход без вложений',
      ).hits,
    ).toEqual([]);
  });
});
