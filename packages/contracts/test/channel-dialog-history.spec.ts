import { describe, expect, it } from 'vitest';
import { channelDialogResponseSchema } from '../src/channel-dialog';

describe('comment history coverage', () => {
  const legacy = { chatId: 'channel-1', type: 'comments', messages: [] };
  it('keeps old responses readable without inventing a completeness claim', () => {
    expect(channelDialogResponseSchema.parse(legacy).hasMoreMessages).toBeUndefined();
  });
  it.each([true, false])('preserves the explicit lookahead result %s', (hasMoreMessages) => {
    expect(channelDialogResponseSchema.parse({ ...legacy, hasMoreMessages }).hasMoreMessages).toBe(
      hasMoreMessages,
    );
  });
  it('rejects non-boolean completeness flags', () => {
    expect(
      channelDialogResponseSchema.safeParse({ ...legacy, hasMoreMessages: 'false' }).success,
    ).toBe(false);
  });
});

describe('dialog destination identity', () => {
  const response = { chatId: 'channel-1', type: 'suggest', messages: [] };
  it('keeps older servers compatible without inventing a title', () => {
    expect(channelDialogResponseSchema.parse(response).entityTitle).toBeUndefined();
  });
  it('preserves the server title and explicit absence', () => {
    expect(
      channelDialogResponseSchema.parse({ ...response, entityTitle: ' Новости ' }).entityTitle,
    ).toBe('Новости');
    expect(
      channelDialogResponseSchema.parse({ ...response, entityTitle: null }).entityTitle,
    ).toBeNull();
    expect(channelDialogResponseSchema.safeParse({ ...response, entityTitle: 123 }).success).toBe(
      false,
    );
  });
});
