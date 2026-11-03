import type { WebhookEvent } from '../prisma/prisma-client';
import {
  inspectLegacyPostSealTextSource,
  inspectLegacyRecoverySource,
  inspectPristineOperatorDiscardSource,
  inspectSourceAbandonmentPostSealSource,
  inspectSourceAbandonmentSource,
} from './webhook-legacy-source';
import {
  inspectLegacyForwardText,
  inspectSourceAbandonmentForwardText,
  type SourceAbandonmentForwardShapeRefusal,
} from './webhook-legacy-forward-source';
import { WebhookParser } from './webhook.parser';
import {
  inspectSourceAbandonmentLinkedMediaRefusal,
  type SourceAbandonmentLinkedMediaRefusal,
} from './webhook-source-abandonment-media';
import {
  SOURCE_ABANDONMENT_SOURCE_CLOSURE,
  sourceAbandonmentSourceClosureDigest,
} from '../scripts/source-abandonment-source-closure';
import { sourceAbandonmentDigest } from '../scripts/source-abandonment-live-protocol';

type Shape = 'plain' | 'share' | 'reply' | 'forward';
type Source = Pick<WebhookEvent, 'botId' | 'createdAt' | 'normalizedPayload' | 'rawPayload'>;

function fixture(shape: Shape) {
  const at = Date.parse('2026-10-06T12:00:00.000Z');
  const body: Record<string, unknown> = { mid: 'outer-mid', text: '  Ordinary   source text  ' };
  const share: Record<string, unknown> = {
    type: 'share',
    payload: { url: 'https://example.com/article', token: 'opaque-share-token' },
    title: 'A preview title',
    description: null,
    image_url: 'https://example.com/preview.jpg',
  };
  const linkedBody: Record<string, unknown> = {
    mid: 'quoted-mid',
    text: '',
    attachments: [
      { type: 'image', payload: { photo_id: 'photo', url: 'https://example.com/a.jpg' } },
    ],
  };
  const link: Record<string, unknown> = {
    type: shape === 'forward' ? 'forward' : 'reply',
    chat_id: '-222',
    sender: { user_id: 'quoted-user', is_bot: false },
    message: linkedBody,
  };
  const message: Record<string, unknown> = {
    sender: { user_id: 'outer-user', is_bot: false },
    recipient: { chat_id: '-111', chat_type: 'chat' },
    timestamp: at,
    body,
  };
  if (shape === 'share') {
    body.attachments = [share];
    body.markup = [
      { type: 'heading', from: 2, length: 8 },
      { type: 'strong', from: 2, length: 8 },
      { type: 'link', from: 2, length: 8, url: 'https://example.com/article' },
    ];
  }
  if (shape === 'reply' || shape === 'forward') message.link = link;
  const raw = { update_type: 'message_created', timestamp: at, message };
  const owner = (): Source => ({
    botId: 'major',
    createdAt: new Date(at + 1000),
    rawPayload: structuredClone(raw) as never,
    normalizedPayload: new WebhookParser().parse(structuredClone(raw), { botId: 'major' }) as never,
  });
  return { at, raw, message, body, share, link, linkedBody, owner };
}

function forwardRefusalFixture() {
  const owner = fixture('forward').owner();
  const update = owner.normalizedPayload as unknown as Record<string, unknown>;
  const raw = update.raw as Record<string, unknown>;
  const message = raw.message as Record<string, unknown>;
  const body = message.body as Record<string, unknown>;
  const link = message.link as Record<string, unknown>;
  const linkedBody = link.message as Record<string, unknown>;
  const sender = link.sender as Record<string, unknown>;
  const normalized = update.message as Record<string, unknown>;
  return {
    owner,
    update,
    raw,
    message,
    body,
    link,
    linkedBody,
    sender,
    normalized,
  };
}

type ForwardRefusalCase = readonly [
  SourceAbandonmentForwardShapeRefusal,
  (f: ReturnType<typeof forwardRefusalFixture>) => void,
];
const forwardShapeRefusalCases: readonly ForwardRefusalCase[] = [
  [
    'source_forward_objects',
    (f) => {
      f.update.raw = null;
    },
  ],
  [
    'source_forward_direct_object',
    (f) => {
      f.message.body = null;
    },
  ],
  [
    'source_forward_direct_keys',
    (f) => {
      f.body.private_unexpected_key = 'private-value';
    },
  ],
  [
    'source_forward_direct_mid',
    (f) => {
      f.body.mid = [];
    },
  ],
  [
    'source_forward_direct_seq',
    (f) => {
      f.body.seq = [];
    },
  ],
  [
    'source_forward_direct_text_absent',
    (f) => {
      delete f.body.text;
    },
  ],
  [
    'source_forward_direct_text_null',
    (f) => {
      f.body.text = null;
    },
  ],
  [
    'source_forward_direct_text_invalid',
    (f) => {
      f.body.text = { private: 'value' };
    },
  ],
  [
    'source_forward_direct_markup',
    (f) => {
      f.body.markup = [{ type: 'private-markup' }];
    },
  ],
  [
    'source_forward_direct_media',
    (f) => {
      f.body.attachments = [{ type: 'private-media' }];
    },
  ],
  [
    'source_forward_link_object',
    (f) => {
      f.message.link = null;
    },
  ],
  [
    'source_forward_linked_object',
    (f) => {
      f.link.message = null;
    },
  ],
  [
    'source_forward_linked_keys',
    (f) => {
      f.linkedBody.private_unexpected_key = 'private-value';
    },
  ],
  [
    'source_forward_linked_mid',
    (f) => {
      f.linkedBody.mid = [];
    },
  ],
  [
    'source_forward_linked_seq',
    (f) => {
      f.linkedBody.seq = [];
    },
  ],
  [
    'source_forward_linked_text_absent',
    (f) => {
      delete f.linkedBody.text;
    },
  ],
  [
    'source_forward_linked_text_null',
    (f) => {
      f.linkedBody.text = null;
    },
  ],
  [
    'source_forward_linked_text_invalid',
    (f) => {
      f.linkedBody.text = { private: 'value' };
    },
  ],
  [
    'source_forward_linked_markup',
    (f) => {
      f.linkedBody.markup = [{ type: 'private-markup' }];
    },
  ],
  [
    'source_forward_linked_media_other',
    (f) => {
      f.linkedBody.attachments = [{ type: 'private-media' }];
    },
  ],
  [
    'source_forward_sender_null',
    (f) => {
      f.link.sender = null;
    },
  ],
  [
    'source_forward_sender_shape',
    (f) => {
      f.link.sender = ['private-sender'];
    },
  ],
  [
    'source_forward_message_keys',
    (f) => {
      f.message.private_unexpected_key = 'private-value';
    },
  ],
  [
    'source_forward_link_keys',
    (f) => {
      f.link.private_unexpected_key = 'private-value';
    },
  ],
  [
    'source_forward_link_type',
    (f) => {
      f.link.type = 'private-link';
    },
  ],
  [
    'source_forward_chat_absent',
    (f) => {
      delete f.link.chat_id;
    },
  ],
  [
    'source_forward_chat_null',
    (f) => {
      f.link.chat_id = null;
    },
  ],
  [
    'source_forward_chat_identity',
    (f) => {
      f.link.chat_id = { private: 'chat' };
    },
  ],
  [
    'source_forward_sender_identity',
    (f) => {
      f.sender.user_id = [];
    },
  ],
  [
    'source_forward_sender_keys',
    (f) => {
      f.sender.private_unexpected_key = 'private-value';
    },
  ],
  [
    'source_forward_sender_bot',
    (f) => {
      f.sender.is_bot = 'private-value';
    },
  ],
  [
    'source_forward_sender_metadata',
    (f) => {
      f.sender.name = ['private-name'];
    },
  ],
  [
    'source_forward_sender_activity',
    (f) => {
      f.sender.last_activity_time = 'private-time';
    },
  ],
  [
    'source_forward_normalized_text',
    (f) => {
      f.normalized.text = null;
    },
  ],
  [
    'source_forward_bot_type',
    (f) => {
      f.update.botId = null;
    },
  ],
];

function linkedAttachment(kind: 'video' | 'share' | 'sticker' | 'audio'): Record<string, unknown> {
  if (kind === 'audio')
    return {
      type: 'audio',
      payload: { url: 'https://example.com/audio', token: 'opaque-audio', id: 2 ** 60 },
    };
  if (kind === 'video')
    return {
      type: 'video',
      payload: { id: 2 ** 60, url: 'https://example.com/video', token: 'opaque-video' },
      thumbnail: { url: 'https://example.com/thumbnail' },
      width: 1920,
      height: 1080,
      duration: 30,
    };
  if (kind === 'share')
    return {
      type: 'share',
      payload: { url: 'https://example.com/article', token: null },
      title: 'Preview title',
      description: 'Preview description',
      image_url: 'https://example.com/preview',
    };
  return {
    type: 'sticker',
    payload: { url: 'https://example.com/sticker', code: 'sticker-code' },
    width: 256,
    height: 256,
  };
}

const linkedMediaCases = [
  ['forward', 'video'],
  ['reply', 'video'],
  ['forward', 'share'],
  ['reply', 'sticker'],
  ['reply', 'audio'],
] as const;

const forwardMediaRefusalCases: ReadonlyArray<
  readonly [SourceAbandonmentLinkedMediaRefusal, () => unknown]
> = [
  ['array', () => null],
  ['count', () => Array.from({ length: 11 }, () => linkedAttachment('audio'))],
  ['count', () => [linkedAttachment('audio'), linkedAttachment('audio')]],
  ['item', () => [null]],
  ['mixed', () => [linkedAttachment('video'), linkedAttachment('audio')]],
  ['other', () => [{ type: 'private-media-99900012345678', private_key: 'private-value' }]],
  ['other', () => [{ type: 'file', payload: { url: 'https://example.com/file' } }]],
  ['image_unproved', () => [{ type: 'image', payload: { photo_id: {} } }]],
  ['photo_unproved', () => [{ type: 'photo', payload: { photo_id: {} } }]],
  ['video_unproved', () => [{ type: 'video', payload: { url: 'http://example.com/video' } }]],
  ['audio_strict', () => [linkedAttachment('audio')]],
  ['audio_unproved', () => [{ type: 'audio', payload: { url: 'https://example.com/audio' } }]],
  ['share_unproved', () => [{ type: 'share', payload: { url: 'https://user:pass@example.com' } }]],
  ['sticker_strict', () => [linkedAttachment('sticker')]],
  [
    'sticker_unproved',
    () => [{ type: 'sticker', payload: { url: 'https://example.com/sticker' } }],
  ],
];

describe('modern source content profile', () => {
  it.each(forwardMediaRefusalCases)(
    'refines rejected forward media as %s without admitting or mutating the source',
    (reason, attachments) => {
      const f = forwardRefusalFixture();
      f.linkedBody.attachments = attachments();
      const before = structuredClone(f.owner);
      const code = `source_forward_linked_media_${reason}`;
      expect(inspectSourceAbandonmentForwardText(f.update)).toBe(code);
      expect(inspectLegacyForwardText(f.update)).toBe('source_forward_shape');
      const reasons: string[] = [];
      expect(inspectSourceAbandonmentSource(f.owner, (value) => reasons.push(value))).toBeNull();
      expect(reasons).toEqual([code]);
      expect(inspectSourceAbandonmentPostSealSource(f.owner)).toBeNull();
      expect(inspectPristineOperatorDiscardSource(f.owner)).toBeNull();
      expect(f.owner).toEqual(before);
      expect(JSON.stringify(reasons)).not.toMatch(/private|99900012345678|example|user:pass/u);
    },
  );

  it.each(['image', 'photo', 'video', 'audio', 'share', 'sticker'] as const)(
    'uses the existing strict %s shape without granting new forward eligibility',
    (kind) => {
      const f = fixture('forward');
      f.linkedBody.attachments = [
        kind === 'image' || kind === 'photo'
          ? { type: kind, payload: { photo_id: 'photo', url: 'https://example.com/image' } }
          : linkedAttachment(kind),
      ];
      expect(inspectSourceAbandonmentLinkedMediaRefusal(f.linkedBody.attachments)).toBe(
        `${kind}_strict`,
      );
      const owner = f.owner();
      const update = owner.normalizedPayload as unknown as Record<string, unknown>;
      const rejected = kind === 'audio' || kind === 'sticker';
      expect(inspectSourceAbandonmentForwardText(update)).toBe(
        rejected ? `source_forward_linked_media_${kind}_strict` : null,
      );
      expect(inspectSourceAbandonmentSource(owner) === null).toBe(rejected);
      expect(inspectPristineOperatorDiscardSource(owner) === null).toBe(rejected);
    },
  );

  it('does not inspect oversized media or replace an earlier deciding refusal', () => {
    const f = forwardRefusalFixture();
    const oversized = Array.from({ length: 11 }, () => ({
      get type(): string {
        throw new Error('Oversized media inspected');
      },
    }));
    f.linkedBody.attachments = oversized;
    expect(inspectSourceAbandonmentForwardText(f.update)).toBe('source_forward_linked_media_count');
    f.linkedBody.attachments = [linkedAttachment('audio')];
    f.body.text = null;
    expect(inspectSourceAbandonmentForwardText(f.update)).toBe('source_forward_direct_text_null');
    f.body.text = 'Ordinary text';
    f.linkedBody.text = null;
    expect(inspectSourceAbandonmentForwardText(f.update)).toBe('source_forward_linked_text_null');
  });

  it.each(linkedMediaCases)(
    'accepts one %s %s while retaining only the original outer human source',
    (shape, kind) => {
      const f = fixture(shape);
      f.body.text = shape === 'forward' ? '' : 'An ordinary reply';
      f.linkedBody.text = 'Quoted content';
      f.linkedBody.attachments = [linkedAttachment(kind)];
      f.linkedBody.markup = [{ type: 'strong', from: 0, length: 6 }];
      if (shape === 'forward') delete f.link.sender;
      const owner = f.owner();
      const before = structuredClone(owner);
      const expected = {
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      };
      expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
      expect(inspectPristineOperatorDiscardSource(owner)).toEqual(
        kind === 'audio' ? null : expected,
      );
      expect(inspectLegacyRecoverySource(owner)).toBeNull();
      expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
      expect(owner).toEqual(before);
      delete f.message.sender;
      expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    },
  );

  it.each(linkedMediaCases)(
    'rejects default and configured commands in both texts of a %s %s',
    (shape, kind) => {
      const f = fixture(shape);
      f.linkedBody.attachments = [linkedAttachment(kind)];
      for (const target of [f.body, f.linkedBody]) {
        f.body.text = 'Ordinary outer text';
        f.linkedBody.text = 'Ordinary linked text';
        for (const text of ['/ban', '$command', 'Старт', 'бан']) {
          target.text = text;
          expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
          expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
        }
        target.text = 'особое';
        expect(
          inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
        ).toBeNull();
        expect(
          inspectSourceAbandonmentPostSealSource(f.owner(), { adminBanCommandName: 'особое' }),
        ).toBeNull();
      }
    },
  );

  it.each(linkedMediaCases)(
    'refuses nested, mixed, unsafe or unproved %s %s content',
    (shape, kind) => {
      for (const fault of [
        'nested',
        'mixed',
        'two',
        'credentials',
        'raw-mismatch',
        'text-mismatch',
      ]) {
        const f = fixture(shape);
        const media = linkedAttachment(kind);
        const payload = media.payload as Record<string, unknown>;
        f.linkedBody.attachments = [media];
        if (fault === 'nested') payload.message = { mid: 'unproved-nested-source' };
        if (fault === 'mixed') (f.linkedBody.attachments as unknown[]).push(f.share);
        if (fault === 'two') (f.linkedBody.attachments as unknown[]).push(media);
        if (fault === 'credentials') payload.url = 'https://user:password@example.com/media';
        const owner = f.owner();
        if (fault === 'raw-mismatch') owner.rawPayload = { update_type: 'message_created' };
        if (fault === 'text-mismatch')
          (owner.normalizedPayload as unknown as { message: { text: string } }).message.text =
            'Forged composed text';
        expect(inspectSourceAbandonmentSource(owner)).toBeNull();
        expect(inspectSourceAbandonmentPostSealSource(owner)).toBeNull();
      }
    },
  );

  it.each<Shape>(['plain', 'share', 'reply', 'forward'])(
    'retains the v6 pristine human profile for %s without changing source evidence',
    (shape) => {
      const f = fixture(shape);
      const owner = f.owner();
      const before = structuredClone(owner);
      expect(inspectPristineOperatorDiscardSource(owner)).toEqual(
        inspectSourceAbandonmentSource(owner),
      );
      expect(owner).toEqual(before);
      f.raw.update_type = 'message_edited';
      expect(inspectPristineOperatorDiscardSource(f.owner())).toEqual(
        inspectSourceAbandonmentSource(f.owner()),
      );
      f.body.text = 'особое';
      delete f.body.markup;
      expect(
        inspectPristineOperatorDiscardSource(f.owner(), { adminBanCommandName: 'особое' }),
      ).toBeNull();
    },
  );

  it('keeps direct audio in the v6 pristine profile but refuses the new linked reply audio', () => {
    const f = fixture('plain');
    f.body.attachments = [linkedAttachment('audio')];
    expect(inspectPristineOperatorDiscardSource(f.owner())).not.toBeNull();
    expect(inspectPristineOperatorDiscardSource(f.owner())).toEqual(
      inspectSourceAbandonmentSource(f.owner()),
    );
    delete f.body.attachments;
    f.message.link = f.link;
    f.linkedBody.attachments = [linkedAttachment('audio')];
    const owner = f.owner();
    expect(inspectSourceAbandonmentSource(owner)).not.toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(owner)).not.toBeNull();
    expect(inspectPristineOperatorDiscardSource(owner)).toBeNull();
  });

  it.each([
    'missing-token',
    'null-token',
    'long-token',
    'bad-id',
    'credentials',
    'transcription',
    'unknown-payload',
    'null-text',
    'missing-sender',
    'missing-chat',
  ])('refuses unproved linked reply audio metadata: %s', (fault) => {
    const f = fixture('reply');
    const audio = linkedAttachment('audio');
    const payload = audio.payload as Record<string, unknown>;
    f.linkedBody.attachments = [audio];
    if (fault === 'missing-token') delete payload.token;
    if (fault === 'null-token') payload.token = null;
    if (fault === 'long-token') payload.token = 'x'.repeat(32769);
    if (fault === 'bad-id') payload.id = 'inferred-source';
    if (fault === 'credentials') payload.url = 'https://user:pass@example.com/audio';
    if (fault === 'transcription') audio.transcription = 'ordinary text';
    if (fault === 'unknown-payload') payload.duration = 1;
    if (fault === 'null-text') f.linkedBody.text = null;
    if (fault === 'missing-sender') delete f.link.sender;
    if (fault === 'missing-chat') delete f.link.chat_id;
    const owner = f.owner();
    expect(inspectSourceAbandonmentSource(owner)).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(owner)).toBeNull();
    expect(inspectPristineOperatorDiscardSource(owner)).toBeNull();
  });

  it.each([
    'code-missing',
    'code-object',
    'code-long',
    'width-missing',
    'width-zero',
    'height-fraction',
    'extra-field',
  ])('rejects an unproved reply sticker: %s', (fault) => {
    const f = fixture('reply');
    const sticker = linkedAttachment('sticker');
    const payload = sticker.payload as Record<string, unknown>;
    if (fault === 'code-missing') delete payload.code;
    if (fault === 'code-object') payload.code = { id: 'other-source' };
    if (fault === 'code-long') payload.code = 'x'.repeat(32769);
    if (fault === 'width-missing') delete sticker.width;
    if (fault === 'width-zero') sticker.width = 0;
    if (fault === 'height-fraction') sticker.height = 1.5;
    if (fault === 'extra-field') sticker.user_id = 42;
    f.linkedBody.attachments = [sticker];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each([
    ['forward', 'sticker'],
    ['reply', 'share'],
    ['forward', 'audio'],
  ] as const)('keeps unreviewed %s %s shapes outside this finite profile', (shape, kind) => {
    const f = fixture(shape);
    f.linkedBody.attachments = [
      kind === 'audio'
        ? { type: 'audio', payload: { url: 'https://example.com/audio', token: 'opaque' } }
        : linkedAttachment(kind),
    ];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it('accepts a bounded numeric mention on a forwarded photo without holding that user', () => {
    const f = fixture('forward');
    f.body.text = '';
    f.linkedBody.text = '😀Quoted user';
    f.linkedBody.markup = [{ type: 'user_mention', from: 2, length: 6, user_id: 42 }];
    delete f.link.sender;
    const owner = f.owner();
    const before = structuredClone(owner);
    const expected = {
      chatId: '-111',
      messageId: 'outer-mid',
      userId: 'outer-user',
      sourceAt: new Date(f.at),
    };
    expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
    expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
    expect(inspectLegacyRecoverySource(owner)).toBeNull();
    expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
    expect(owner).toEqual(before);
    f.body.markup = structuredClone(f.linkedBody.markup);
    expect(inspectSourceAbandonmentSource(f.owner())).toEqual(expected);
    delete f.message.sender;
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each([
    { user_id: '42' },
    { user_id: 0 },
    { user_id: -42 },
    { user_id: 1.5 },
    { user_id: Number.MAX_SAFE_INTEGER + 1 },
    { user_id: null },
    { user_id: undefined },
    { user_link: 'https://max.ru/another-user' },
    { user: { user_id: 42 } },
    { from: -1 },
    { from: 0.5 },
    { length: 0 },
    { length: 100 },
  ])('refuses ambiguous mention metadata or invalid bounds: %j', (change) => {
    const f = fixture('forward');
    f.linkedBody.text = 'Quoted user';
    f.linkedBody.markup = [{ type: 'user_mention', from: 0, length: 6, user_id: 42, ...change }];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });

  it.each<Shape>(['plain', 'share', 'reply', 'forward'])(
    'accepts an initial %s human edit only in the modern profile with a proven receipt clock',
    (shape) => {
      const f = fixture(shape);
      f.raw.update_type = 'message_edited';
      f.raw.timestamp = f.at + 500;
      const owner = f.owner();
      expect(inspectSourceAbandonmentSource(owner)).toEqual({
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      });
      expect(inspectLegacyRecoverySource(owner)).toBeNull();
      owner.createdAt = new Date(f.at + 499);
      expect(inspectSourceAbandonmentSource(owner)).toBeNull();
    },
  );

  it('accepts one passive audio attachment without granting download or linked-source authority', () => {
    const f = fixture('plain');
    f.body.text = '';
    f.body.attachments = [
      {
        type: 'audio',
        payload: {
          url: 'https://example.com/audio',
          token: 'opaque-audio',
          id: 9223372036854776000,
        },
      },
    ];
    const owner = f.owner();
    expect(inspectSourceAbandonmentSource(owner)).toMatchObject({
      chatId: '-111',
      messageId: 'outer-mid',
      userId: 'outer-user',
    });
    expect(inspectSourceAbandonmentPostSealSource(owner)).not.toBeNull();
    expect(inspectLegacyRecoverySource(owner)).toBeNull();
    f.message.link = f.link;
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each(['credentials', 'transcription', 'nested', 'mixed', 'two', 'bad-id', 'long-token'])(
    'refuses unsupported audio content %s',
    (fault) => {
      const f = fixture('plain');
      const payload: Record<string, unknown> = {
        url: 'https://example.com/audio',
        token: 'opaque',
      };
      const audio: Record<string, unknown> = { type: 'audio', payload };
      f.body.attachments = [audio];
      if (fault === 'credentials') payload.url = 'https://user:pass@example.com/audio';
      if (fault === 'transcription') audio.transcription = '/ban';
      if (fault === 'nested') payload.message = { mid: 'secondary' };
      if (fault === 'mixed') f.body.attachments = [audio, f.share];
      if (fault === 'two') f.body.attachments = [audio, audio];
      if (fault === 'bad-id') payload.id = 'another-source';
      if (fault === 'long-token') payload.token = 'x'.repeat(32769);
      expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    },
  );

  it.each(['forward', 'reply'] as const)(
    'accepts bounded formatting on the flat linked %s body',
    (shape) => {
      const f = fixture(shape);
      f.linkedBody.text = 'Quoted source';
      f.linkedBody.markup = [{ type: 'strong', from: 0, length: 6 }];
      expect(inspectSourceAbandonmentSource(f.owner())).not.toBeNull();
      expect(inspectLegacyRecoverySource(f.owner())).toBeNull();
      f.linkedBody.markup = [{ type: 'strong', from: 0, length: 100 }];
      expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    },
  );

  it.each([false, true])(
    'admits passive formatted forwards only for post-seal legacy projection (copied=%s)',
    (copied) => {
      const f = fixture('forward');
      f.body.text = copied ? '' : 'Outer caption';
      f.linkedBody.text = 'Quoted caption';
      f.linkedBody.markup = [{ type: 'emphasized', from: 0, length: 6 }];
      f.body.markup = structuredClone(f.linkedBody.markup);
      const source = f.owner();
      const before = structuredClone(source);
      expect(inspectLegacyPostSealTextSource(source)).toEqual({
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      });
      expect(inspectLegacyRecoverySource(source)).toBeNull();
      expect(source).toEqual(before);
    },
  );

  it.each([
    'copied mismatch',
    'outer bounds',
    'linked bounds',
    'unsafe link',
    'mention',
    'extra key',
    'missing sender',
    'unsupported media',
    'reply',
    'outer command',
    'linked command',
    'normalized mismatch',
    'too many spans',
    'negative offset',
    'zero length',
  ])('rejects unsafe post-seal formatted forwards: %s', (fault) => {
    const f = fixture('forward');
    f.body.text = '';
    f.linkedBody.text = 'Quoted caption';
    f.linkedBody.markup = [{ type: 'emphasized', from: 0, length: 6 }];
    f.body.markup = structuredClone(f.linkedBody.markup);
    if (fault === 'copied mismatch') f.body.markup = [{ type: 'strong', from: 0, length: 6 }];
    if (fault === 'outer bounds') f.body.text = 'x';
    if (fault === 'linked bounds') f.linkedBody.text = 'x';
    if (fault === 'unsafe link')
      f.linkedBody.markup = [{ type: 'link', from: 0, length: 6, url: 'http://example.com' }];
    if (fault === 'mention')
      f.linkedBody.markup = [{ type: 'user_mention', from: 0, length: 6, user_id: 7 }];
    if (fault === 'extra key')
      f.linkedBody.markup = [{ type: 'emphasized', from: 0, length: 6, target: 7 }];
    if (fault === 'too many spans')
      f.linkedBody.markup = Array.from({ length: 65 }, () => ({
        type: 'emphasized',
        from: 0,
        length: 6,
      }));
    if (fault === 'negative offset')
      f.linkedBody.markup = [{ type: 'emphasized', from: -1, length: 6 }];
    if (fault === 'zero length') f.linkedBody.markup = [{ type: 'emphasized', from: 0, length: 0 }];
    if (
      [
        'unsafe link',
        'mention',
        'extra key',
        'too many spans',
        'negative offset',
        'zero length',
      ].includes(fault)
    )
      f.body.markup = structuredClone(f.linkedBody.markup);
    if (fault === 'missing sender') delete f.link.sender;
    if (fault === 'unsupported media') f.linkedBody.attachments = [{ type: 'file', payload: {} }];
    if (fault === 'reply') f.link.type = 'reply';
    if (fault === 'outer command') f.body.text = '/ban user';
    if (fault === 'linked command') f.linkedBody.text = '/ban user';
    const source = f.owner();
    if (fault === 'normalized mismatch') {
      const normalized = source.normalizedPayload as unknown as { message: { text: string } };
      normalized.message.text = 'Different text';
    }
    expect(inspectLegacyPostSealTextSource(source)).toBeNull();
  });

  it('accepts only identical linked formatting copied onto an empty forward body', () => {
    const f = fixture('forward');
    f.body.text = '';
    f.linkedBody.text = 'Quoted source';
    f.linkedBody.markup = [{ type: 'link', from: 0, length: 6, url: 'https://example.com' }];
    f.body.markup = structuredClone(f.linkedBody.markup);
    expect(inspectSourceAbandonmentSource(f.owner())).not.toBeNull();
    expect(inspectLegacyRecoverySource(f.owner())).toBeNull();
    f.body.markup = [{ type: 'strong', from: 0, length: 6 }];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    f.body.markup = structuredClone(f.linkedBody.markup);
    f.body.text = 'Different text';
    // The markup is in-bounds for actual outer text, which has independent authority.
    expect(inspectSourceAbandonmentSource(f.owner())).not.toBeNull();
    f.body.text = 'x';
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    f.body.text = '';
    f.link.type = 'reply';
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each(forwardShapeRefusalCases)(
    'reports only the modern deciding fixed code %s while retaining the legacy refusal',
    (code, change) => {
      const f = forwardRefusalFixture();
      change(f);
      const before = structuredClone(f.update);
      expect(inspectSourceAbandonmentForwardText(f.update)).toBe(code);
      expect(inspectLegacyForwardText(f.update)).toBe('source_forward_shape');
      expect(f.update).toEqual(before);
      expect(code).not.toMatch(/private|value|unexpected/u);
    },
  );

  it('retains the original forward guard priority when multiple fields fail', () => {
    const f = forwardRefusalFixture();
    f.body.text = null;
    f.link.sender = null;
    delete f.link.chat_id;
    expect(inspectSourceAbandonmentForwardText(f.update)).toBe('source_forward_direct_text_null');
    f.body.text = 'Ordinary text';
    expect(inspectSourceAbandonmentForwardText(f.update)).toBe('source_forward_sender_null');
    delete f.link.sender;
    expect(inspectSourceAbandonmentForwardText(f.update)).toBe('source_forward_chat_absent');
    f.linkedBody.attachments = [{ type: 'private-media' }];
    expect(inspectSourceAbandonmentForwardText(f.update)).toBe('source_forward_linked_media_other');
  });

  it('keeps an omitted modern linked sender eligible without inventing an absent-sender refusal', () => {
    const f = forwardRefusalFixture();
    expect(inspectSourceAbandonmentForwardText(f.update)).toBeNull();
    expect(inspectLegacyForwardText(f.update)).toBeNull();
    delete f.link.sender;
    expect(inspectSourceAbandonmentForwardText(f.update)).toBeNull();
    expect(inspectLegacyForwardText(f.update)).toBe('source_forward_shape');
  });

  it('propagates only one fixed deciding code through the existing source callback', () => {
    const f = forwardRefusalFixture();
    f.link.sender = 'private-refusal-payload-99900012345678';
    const before = structuredClone(f.owner);
    const reasons: string[] = [];
    expect(inspectSourceAbandonmentSource(f.owner, (code) => reasons.push(code))).toBeNull();
    expect(reasons).toEqual(['source_forward_sender_shape']);
    expect(JSON.stringify(reasons)).not.toMatch(/private|99900012345678|raw|value/u);
    expect(f.owner).toEqual(before);
  });

  it.each([0, 1, 10])(
    'accepts a modern flat forward with %i photos and no linked sender, holding only its outer human source',
    (photos) => {
      const f = fixture('forward');
      delete f.link.sender;
      f.linkedBody.text = 'Ordinary forwarded caption';
      f.linkedBody.attachments = Array.from({ length: photos }, (_, i) => ({
        type: 'image',
        payload: { photo_id: i + 1, token: 'opaque', url: `https://example.com/${i}` },
      }));
      const owner = f.owner();
      const before = structuredClone(owner);
      const expected = {
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      };
      expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
      expect(inspectLegacyRecoverySource(owner)).toBeNull();
      expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
      expect(owner).toEqual(before);
      delete f.message.sender;
      expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    },
  );

  it.each([
    null,
    [],
    'sender',
    {},
    { user_id: 'other', is_bot: 'false' },
    { user_id: 'other', is_bot: false, nested: {} },
  ])('does not treat a malformed supplied linked sender as omitted: %j', (sender) => {
    const f = fixture('forward');
    f.link.sender = sender;
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });

  it.each(['outer', 'linked'] as const)(
    'retains command checks in %s text when a forwarded sender is omitted',
    (source) => {
      const f = fixture('forward');
      delete f.link.sender;
      const body = source === 'outer' ? f.body : f.linkedBody;
      for (const text of ['/ban', 'Старт', 'бан']) {
        body.text = text;
        expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
      }
      body.text = 'особое';
      expect(
        inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
      ).toBeNull();
    },
  );

  it('keeps a channel forward without an outer sender outside the human source profile', () => {
    const f = fixture('forward');
    delete f.message.sender;
    f.message.recipient = { chat_id: '-111', chat_type: 'channel' };
    f.message.url = 'https://max.ru/example/outer-mid';
    const owner = f.owner();
    expect((owner.normalizedPayload as Record<string, unknown>).message).toMatchObject({
      entityType: 'channel',
      senderId: '',
    });
    const reasons: string[] = [];
    expect(inspectSourceAbandonmentSource(owner, (reason) => reasons.push(reason))).toBeNull();
    expect(reasons).toEqual(['source_objects_missing']);
    expect(inspectSourceAbandonmentPostSealSource(owner)).toBeNull();
  });

  it.each<Shape>(['plain', 'share', 'reply'])(
    'proves %s against its unchanged raw payload and returns only the outer source',
    (shape) => {
      const f = fixture(shape);
      const owner = f.owner();
      const original = structuredClone(owner);
      const expected = {
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      };
      expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
      expect(owner).toEqual(original);
      if (shape !== 'plain') {
        expect(inspectLegacyRecoverySource(owner)).toBeNull();
        expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
      }
    },
  );

  it.each<Shape>(['share', 'reply'])(
    'requires both original and normalized representations for %s',
    (shape) => {
      const f = fixture(shape);
      const owner = f.owner();
      const normalized = owner.normalizedPayload as unknown as {
        message: { text: string };
      };
      normalized.message.text = 'Forged normalized content';
      expect(inspectSourceAbandonmentSource(owner)).toBeNull();
      const mismatch = f.owner();
      mismatch.rawPayload = { different: 'raw' };
      expect(inspectSourceAbandonmentSource(mismatch)).toBeNull();
    },
  );

  it.each<Shape>(['share', 'reply'])(
    'permits edited/future-clock provenance only in the already-held %s path',
    (shape) => {
      const f = fixture(shape);
      f.raw.update_type = 'message_edited';
      const owner = f.owner();
      owner.createdAt = new Date(f.at - 1);
      expect(inspectSourceAbandonmentSource(owner)).toBeNull();
      expect(inspectSourceAbandonmentPostSealSource(owner)).not.toBeNull();
      expect(inspectLegacyPostSealTextSource(owner)).toBeNull();
    },
  );

  it.each([
    'unknown-item',
    'unknown-payload',
    'nested-metadata',
    'http',
    'credentials',
    'bad-preview',
    'long-token',
    'two-shares',
    'mixed-media',
    'share-and-link',
    'active-markup',
  ])('refuses unsupported share content: %s', (fault) => {
    const f = fixture('share');
    const payload = f.share.payload as Record<string, unknown>;
    if (fault === 'unknown-item') f.share.hidden = {};
    if (fault === 'unknown-payload') payload.hidden = {};
    if (fault === 'nested-metadata') f.share.title = { text: 'nested' };
    if (fault === 'http') payload.url = 'http://example.com';
    if (fault === 'credentials') payload.url = 'https://user:pass@example.com';
    if (fault === 'bad-preview') f.share.image_url = 'javascript:alert(1)';
    if (fault === 'long-token') payload.token = 'x'.repeat(32769);
    if (fault === 'two-shares') f.body.attachments = [f.share, f.share];
    if (fault === 'mixed-media') f.body.attachments = [f.share, { type: 'image', payload: {} }];
    if (fault === 'share-and-link') f.message.link = f.link;
    if (fault === 'active-markup')
      f.body.markup = [{ type: 'user_mention', from: 2, length: 3, user_id: 'other-user' }];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each([
    'nested-link',
    'unknown-link',
    'missing-sender',
    'sender-kind',
    'unknown-image',
    'image-extra-field',
    'eleven-images',
    'direct-image',
  ])('refuses unsupported reply content: %s', (fault) => {
    const f = fixture('reply');
    if (fault === 'nested-link') f.linkedBody.link = { type: 'forward' };
    if (fault === 'unknown-link') f.link.hidden = {};
    if (fault === 'missing-sender') delete f.link.sender;
    if (fault === 'sender-kind') f.link.sender = { user_id: 'quoted-user', is_bot: 'false' };
    if (fault === 'unknown-image') f.linkedBody.attachments = [{ type: 'video', payload: {} }];
    if (fault === 'image-extra-field')
      f.linkedBody.attachments = [{ type: 'image', payload: { photo_id: 'photo', hidden: {} } }];
    if (fault === 'eleven-images')
      f.linkedBody.attachments = Array.from({ length: 11 }, () => ({
        type: 'image',
        payload: { photo_id: 'photo' },
      }));
    if (fault === 'direct-image') f.body.attachments = f.linkedBody.attachments;
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
  });

  it.each<Shape>(['share', 'reply'])(
    'rejects default and configured outer commands in %s',
    (shape) => {
      const f = fixture(shape);
      for (const text of [' /command ', 'Старт', 'бан']) {
        f.body.text = text;
        delete f.body.markup;
        expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
      }
      f.body.text = 'особое';
      expect(
        inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
      ).toBeNull();
    },
  );

  it('refuses commands in quoted reply text even though the parser excludes it', () => {
    const f = fixture('reply');
    f.linkedBody.text = 'бан';
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    f.linkedBody.text = 'особое';
    expect(
      inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
    ).toBeNull();
  });

  it.each(['image', 'photo', 'video', 'ten-mixed'] as const)(
    'admits finite direct %s metadata with only the unchanged outer source authority',
    (kind) => {
      const f = fixture('plain');
      f.body.text = '';
      const photo = {
        type: kind === 'photo' ? 'photo' : 'image',
        payload: { photo_id: 42, token: 'opaque-photo', url: 'https://example.com/photo' },
      };
      const video = {
        type: 'video',
        payload: { id: 2 ** 60, token: 'opaque-video', url: 'https://example.com/video' },
        thumbnail: { url: 'https://example.com/thumbnail' },
        width: 1920,
        height: 1080,
        duration: 30,
      };
      f.body.attachments =
        kind === 'ten-mixed'
          ? Array.from({ length: 10 }, (_, i) => (i % 2 ? photo : video))
          : [kind === 'video' ? video : photo];
      const owner = f.owner();
      const before = structuredClone(owner);
      const expected = {
        chatId: '-111',
        messageId: 'outer-mid',
        userId: 'outer-user',
        sourceAt: new Date(f.at),
      };
      expect(inspectLegacyRecoverySource(owner)).toEqual(expected);
      expect(inspectLegacyPostSealTextSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentSource(owner)).toEqual(expected);
      expect(inspectSourceAbandonmentPostSealSource(owner)).toEqual(expected);
      expect(owner).toEqual(before);
      for (const text of ['/ban', 'Старт', 'бан']) {
        f.body.text = text;
        expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
      }
      f.body.text = 'особое';
      expect(
        inspectSourceAbandonmentSource(f.owner(), undefined, { adminBanCommandName: 'особое' }),
      ).toBeNull();
    },
  );

  it.each([
    'eleven',
    'unknown-type',
    'nested-payload',
    'unknown-field',
    'unsafe-url',
    'credentials',
    'missing-token',
    'negative-size',
    'nested-thumbnail',
    'linked-message',
    'share-mix',
  ])('refuses unsupported direct media: %s', (fault) => {
    const f = fixture('plain');
    const payload: Record<string, unknown> = {
      id: 42,
      token: 'opaque-video',
      url: 'https://example.com/video',
    };
    const video: Record<string, unknown> = { type: 'video', payload };
    f.body.attachments = [video];
    if (fault === 'eleven') f.body.attachments = Array.from({ length: 11 }, () => video);
    if (fault === 'unknown-type') video.type = 'file';
    if (fault === 'nested-payload') payload.nested = { message_id: 'another' };
    if (fault === 'unknown-field') video.user_id = 'another';
    if (fault === 'unsafe-url') payload.url = 'http://example.com/video';
    if (fault === 'credentials') payload.url = 'https://user:password@example.com/video';
    if (fault === 'missing-token') delete payload.token;
    if (fault === 'negative-size') video.width = -1;
    if (fault === 'nested-thumbnail') video.thumbnail = { url: 'https://example.com', hidden: {} };
    if (fault === 'linked-message') f.message.link = f.link;
    if (fault === 'share-mix') f.body.attachments = [video, f.share];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });

  it('binds reply audio to closure7 while preserving the separate v6 pristine policy', () => {
    const sourceSha = 'a'.repeat(40);
    const imageId = `sha256:${'b'.repeat(64)}`;
    const { pristineOperatorDiscard, ...withoutPristine } = SOURCE_ABANDONMENT_SOURCE_CLOSURE;
    const oldClosure = {
      ...withoutPristine,
      version: 6,
      reply: {
        ...withoutPristine.reply,
        content:
          'parser-proved-nonempty-outer-text-and-flat-quoted-text-with-zero-through-ten-images-or-one-video-or-one-official-sticker',
      },
    };
    expect(SOURCE_ABANDONMENT_SOURCE_CLOSURE.version).toBe(7);
    expect(pristineOperatorDiscard.purpose).toBe('PRISTINE_OPERATOR_DISCARD_V1');
    expect(pristineOperatorDiscard.content).toBe(
      'unchanged-v6-human-profile-with-linked-reply-audio-refused',
    );
    expect(sourceAbandonmentSourceClosureDigest(sourceSha, imageId)).not.toBe(
      sourceAbandonmentDigest({ sourceSha, imageId, closure: oldClosure }),
    );
  });

  it('binds the added direct media profile to a new source closure digest', () => {
    const sourceSha = 'a'.repeat(40);
    const imageId = `sha256:${'b'.repeat(64)}`;
    const { directMedia: _media, ...withoutMedia } = SOURCE_ABANDONMENT_SOURCE_CLOSURE;
    const oldClosure = {
      ...withoutMedia,
      version: 3,
      source:
        'outer-human-text-with-strict-share-preview-or-flat-forward-or-reply-major-group-message',
      excluded: withoutMedia.excluded.map((value) =>
        value ===
        'non-image-or-video-direct-media-mixed-share-media-nested-links-and-unknown-content-shapes'
          ? 'direct-images-video-mixed-share-media-nested-links-and-unknown-content-shapes'
          : value,
      ),
    };
    expect(_media.scope).toBe('outer-recipient-chat-body-mid-sender-user-only');
    expect(sourceAbandonmentSourceClosureDigest(sourceSha, imageId)).not.toBe(
      sourceAbandonmentDigest({ sourceSha, imageId, closure: oldClosure }),
    );
  });

  it('validates link bounds against original UTF-16 text only in the modern profile', () => {
    const f = fixture('plain');
    f.body.text = '😀A';
    f.body.markup = [{ type: 'link', from: 2, length: 1, url: 'https://example.com' }];
    expect(inspectSourceAbandonmentSource(f.owner())).not.toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).not.toBeNull();
    expect(inspectLegacyRecoverySource(f.owner())).toBeNull();
    expect(inspectLegacyPostSealTextSource(f.owner())).toBeNull();
  });

  it.each([
    { url: 'http://example.com' },
    { url: 'javascript:alert(1)' },
    { url: 'https://user:pass@example.com' },
    { url: 'https://exa\nmple.com' },
    { url: `https://example.com/${'x'.repeat(2048)}` },
    { from: -1 },
    { from: 1.5 },
    { from: Number.MAX_SAFE_INTEGER + 1 },
    { length: 0 },
    { length: 1000 },
    { user_id: 'secondary-user' },
  ])('refuses invalid modern link formatting %#', (patch) => {
    const f = fixture('share');
    f.body.markup = [{ type: 'link', from: 2, length: 8, url: 'https://example.com', ...patch }];
    expect(inspectSourceAbandonmentSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).toBeNull();
  });
});

describe('legacy held forward link/share projection', () => {
  const shapes = [
    'outer link',
    'linked link',
    'both links',
    'copied link',
    'share without markup',
    'share with links',
    'share with copied link',
  ] as const;
  type ProjectionShape = (typeof shapes)[number];

  function projectionFixture(shape: ProjectionShape) {
    const f = fixture('forward');
    f.body.text = shape.includes('copied') ? '' : 'Outer caption';
    f.linkedBody.text = 'Quoted caption';
    const span = { type: 'link', from: 0, length: 6, url: 'https://example.com/article' };
    if (shape.startsWith('share')) f.linkedBody.attachments = [f.share];
    if (shape !== 'share without markup') {
      if (shape !== 'outer link') f.linkedBody.markup = [structuredClone(span)];
      if (shape !== 'linked link') f.body.markup = [structuredClone(span)];
    }
    return f;
  }

  it.each(shapes)('projects only the original outer message for %s', (shape) => {
    const f = projectionFixture(shape);
    const source = f.owner();
    const before = structuredClone(source);
    const expected = {
      chatId: '-111',
      messageId: 'outer-mid',
      userId: 'outer-user',
      sourceAt: new Date(f.at),
    };
    expect(inspectLegacyPostSealTextSource(source)).toEqual(expected);
    expect(inspectLegacyRecoverySource(source)).toBeNull();
    expect(inspectSourceAbandonmentSource(source)).toEqual(expected);
    expect(inspectSourceAbandonmentPostSealSource(source)).toEqual(expected);
    expect(inspectPristineOperatorDiscardSource(source)).toEqual(expected);
    expect(source).toEqual(before);
  });

  it.each(shapes)('does not extend legacy edited sources to %s', (shape) => {
    const f = projectionFixture(shape);
    f.raw.update_type = 'message_edited';
    const source = f.owner();
    expect(inspectLegacyPostSealTextSource(source)).toBeNull();
    expect(inspectLegacyRecoverySource(source)).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(source)).not.toBeNull();
  });

  it.each([false, true])('preserves passive formatted legacy edits (copied=%s)', (copied) => {
    const f = fixture('forward');
    f.raw.update_type = 'message_edited';
    f.body.text = copied ? '' : 'Outer caption';
    f.linkedBody.text = 'Quoted caption';
    f.linkedBody.markup = [{ type: 'emphasized', from: 0, length: 6 }];
    f.body.markup = structuredClone(f.linkedBody.markup);
    expect(inspectLegacyPostSealTextSource(f.owner())).not.toBeNull();
  });

  it.each(['plain', 'reply'] as const)('keeps %s link markup outside the allowance', (shape) => {
    const f = fixture(shape);
    f.body.markup = [{ type: 'link', from: 2, length: 8, url: 'https://example.com' }];
    expect(inspectLegacyPostSealTextSource(f.owner())).toBeNull();
    expect(inspectSourceAbandonmentPostSealSource(f.owner())).not.toBeNull();
  });

  it.each([
    'copy mismatch',
    'outer bounds',
    'linked bounds',
    'negative offset',
    'zero length',
    'fractional offset',
    'too many spans',
    'http',
    'credentials',
    'url whitespace',
    'url control',
    'long url',
    'mention',
    'extra field',
  ])('refuses unsupported link markup: %s', (fault) => {
    const f = projectionFixture('copied link');
    const span = (f.linkedBody.markup as Record<string, unknown>[])[0]!;
    if (fault === 'copy mismatch') span.url = 'https://example.com/different';
    if (fault === 'outer bounds') f.body.text = 'x';
    if (fault === 'linked bounds') f.linkedBody.text = 'x';
    if (fault === 'negative offset') span.from = -1;
    if (fault === 'zero length') span.length = 0;
    if (fault === 'fractional offset') span.from = 0.5;
    if (fault === 'too many spans') f.linkedBody.markup = Array.from({ length: 65 }, () => span);
    if (fault === 'http') span.url = 'http://example.com';
    if (fault === 'credentials') span.url = 'https://user:pass@example.com';
    if (fault === 'url whitespace') span.url = ' https://example.com';
    if (fault === 'url control') span.url = 'https://example.com/\npath';
    if (fault === 'long url') span.url = `https://example.com/${'a'.repeat(2049)}`;
    if (fault === 'mention') {
      delete span.url;
      Object.assign(span, { type: 'user_mention', user_id: 7 });
    }
    if (fault === 'extra field') span.target = 'another-message';
    if (fault !== 'copy mismatch') f.body.markup = structuredClone(f.linkedBody.markup);
    expect(inspectLegacyPostSealTextSource(f.owner())).toBeNull();
  });

  it('validates link bounds against original UTF-16 text', () => {
    const f = projectionFixture('linked link');
    f.linkedBody.text = '😀x';
    f.linkedBody.markup = [{ type: 'link', from: 2, length: 1, url: 'https://example.com' }];
    expect(inspectLegacyPostSealTextSource(f.owner())).not.toBeNull();
    (f.linkedBody.markup as Record<string, unknown>[])[0]!.length = 2;
    expect(inspectLegacyPostSealTextSource(f.owner())).toBeNull();
  });

  it.each([
    'unknown item',
    'unknown payload',
    'nested title',
    'nested source',
    'http',
    'credentials',
    'url control',
    'bad preview',
    'long token',
    'long title',
    'two shares',
    'mixed images',
    'direct share',
  ])('refuses unsupported linked share: %s', (fault) => {
    const f = projectionFixture('share without markup');
    const payload = f.share.payload as Record<string, unknown>;
    if (fault === 'unknown item') f.share.target = 'another-message';
    if (fault === 'unknown payload') payload.hidden = {};
    if (fault === 'nested title') f.share.title = { text: 'Nested title' };
    if (fault === 'nested source') payload.message = { mid: 'another-message' };
    if (fault === 'http') payload.url = 'http://example.com';
    if (fault === 'credentials') payload.url = 'https://user:pass@example.com';
    if (fault === 'url control') payload.url = 'https://example.com/\npath';
    if (fault === 'bad preview') f.share.image_url = 'javascript:alert(1)';
    if (fault === 'long token') payload.token = 'x'.repeat(32769);
    if (fault === 'long title') f.share.title = 'x'.repeat(32769);
    if (fault === 'two shares') f.linkedBody.attachments = [f.share, f.share];
    if (fault === 'mixed images')
      f.linkedBody.attachments = [f.share, { type: 'image', payload: { photo_id: 'photo' } }];
    if (fault === 'direct share') {
      delete f.message.link;
      f.body.attachments = [f.share];
    }
    expect(inspectLegacyPostSealTextSource(f.owner())).toBeNull();
  });

  it.each([
    'missing sender',
    'null sender',
    'sender metadata',
    'missing chat',
    'nested link',
    'reply',
    'unknown relation',
    'missing outer text',
    'null linked text',
    'linked video',
    'linked audio',
    'linked sticker',
    'direct image',
    'normalized mismatch',
    'sampled raw mismatch',
  ])('retains the original forward boundary: %s', (fault) => {
    const f = projectionFixture('share with links');
    if (fault === 'missing sender') delete f.link.sender;
    if (fault === 'null sender') f.link.sender = null;
    if (fault === 'sender metadata') (f.link.sender as Record<string, unknown>).target = {};
    if (fault === 'missing chat') delete f.link.chat_id;
    if (fault === 'nested link') f.linkedBody.link = { type: 'forward' };
    if (fault === 'reply') f.link.type = 'reply';
    if (fault === 'unknown relation') f.link.type = 'unknown';
    if (fault === 'missing outer text') delete f.body.text;
    if (fault === 'null linked text') f.linkedBody.text = null;
    if (fault.startsWith('linked ')) {
      const type = fault.slice('linked '.length);
      f.linkedBody.attachments = [
        type === 'sticker'
          ? {
              type,
              payload: { url: 'https://example.com/sticker', code: 'sticker' },
              width: 10,
              height: 10,
            }
          : { type, payload: { url: 'https://example.com/media', token: 'token', id: 42 } },
      ];
    }
    if (fault === 'direct image')
      f.body.attachments = [{ type: 'image', payload: { photo_id: 'photo' } }];
    const source = f.owner();
    if (fault === 'normalized mismatch')
      (source.normalizedPayload as unknown as { message: { text: string } }).message.text =
        'Forged text';
    if (fault === 'sampled raw mismatch') source.rawPayload = { changed: true } as never;
    expect(inspectLegacyPostSealTextSource(source)).toBeNull();
  });

  it.each(['outer', 'linked'] as const)(
    'refuses default and configured commands in %s text',
    (part) => {
      for (const command of ['/ban', '$command', 'Старт', 'бан', 'особое', 'бан 999']) {
        const f = projectionFixture('share without markup');
        (part === 'outer' ? f.body : f.linkedBody).text = command;
        expect(
          inspectLegacyPostSealTextSource(f.owner(), { adminBanCommandName: 'особое' }),
        ).toBeNull();
      }
    },
  );

  it('refuses a command formed by composing the original forward texts', () => {
    const f = projectionFixture('share without markup');
    f.body.text = 'super';
    f.linkedBody.text = 'ban';
    expect(inspectLegacyPostSealTextSource(f.owner())).toBeNull();
  });
});

describe('captionless direct media under an existing post-seal legacy hold', () => {
  it.each(
    ['image', 'video'].flatMap((type) => [undefined, null].map((caption) => ({ type, caption }))),
  )(
    'accepts $type caption=$caption without changing other admission profiles or the original',
    ({ type, caption }) => {
      const f = fixture('plain');
      if (caption === undefined) delete f.body.text;
      else f.body.text = caption;
      f.body.attachments = [
        type === 'image'
          ? { type, payload: { photo_id: 42, url: 'https://i.oneme.ru/fixture' } }
          : {
              type,
              payload: { id: 42, url: 'https://vd.mycdn.me/fixture', token: 'fixture-token' },
            },
      ];
      const source = f.owner();
      const before = structuredClone(source);
      expect(inspectLegacyPostSealTextSource(source)).not.toBeNull();
      expect(inspectLegacyRecoverySource(source)).toBeNull();
      expect(inspectSourceAbandonmentSource(source)).toBeNull();
      expect(inspectSourceAbandonmentPostSealSource(source)).toBeNull();
      expect(inspectPristineOperatorDiscardSource(source)).toBeNull();
      expect(source).toEqual(before);
    },
  );

  it.each([
    'no media',
    'unknown media',
    'markup',
    'number caption',
    'normalized text',
    'forward',
    'command',
  ])('refuses captionless admission with %s', (fault) => {
    const f = fixture(fault === 'forward' ? 'forward' : 'plain');
    delete f.body.text;
    f.body.attachments = [
      { type: 'image', payload: { photo_id: 42, url: 'https://i.oneme.ru/fixture' } },
    ];
    if (fault === 'no media') f.body.attachments = [];
    if (fault === 'unknown media') f.body.attachments = [{ type: 'unknown', payload: {} }];
    if (fault === 'markup')
      f.body.markup = [{ type: 'link', from: 0, length: 0, url: 'https://example.com' }];
    if (fault === 'number caption') f.body.text = 42;
    if (fault === 'command') f.body.text = '/ban';
    const source = f.owner();
    if (fault === 'normalized text')
      (source.normalizedPayload as unknown as { message: { text: string } }).message.text =
        'different';
    expect(inspectLegacyPostSealTextSource(source)).toBeNull();
  });
});
