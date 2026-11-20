import { decodeCursor, encodeCursor } from './stats-cursor';
import { StatsFailure } from './stats-common';

describe('signed statistics cursor', () => {
  const secret = 'test-cursor-signing-key';
  const content = { type: 'changes', seq: '12', view: 'view-1', expires: 100 };
  const encoded = encodeCursor(content, secret);

  it('verifies the exact existing cursor format', () => {
    expect(decodeCursor(encoded, secret)).toEqual(content);
  });

  it('handles input of the wrong runtime type or signature encoding as an invalid request', () => {
    const [body, signature] = encoded.split('.');
    for (const input of [null, 1, [encoded], `${body}.é${signature.slice(1)}`]) {
      expect(() => decodeCursor(input as string, secret)).toThrow(StatsFailure);
    }
  });
});
