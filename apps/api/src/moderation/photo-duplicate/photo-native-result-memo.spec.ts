import { PhotoNativeResultMemo } from './photo-native-result-memo';

describe('PhotoNativeResultMemo', () => {
  it('expires five minutes after insertion without renewing expiry on reads', () => {
    let now = 1_000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const memo = new PhotoNativeResultMemo((value: { hash: string }) => ({ ...value }));
    try {
      memo.set('proof', { hash: 'verified' });
      now += 299_999;
      expect(memo.get('proof')).toEqual({ hash: 'verified' });
      now += 1;
      expect(memo.get('proof')).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  it('retains at most 256 entries and evicts the least recently read key', () => {
    const memo = new PhotoNativeResultMemo((value: number) => value);
    for (let index = 0; index < 256; index += 1) memo.set(String(index), index);
    expect(memo.get('0')).toBe(0);
    memo.set('256', 256);
    expect(memo.get('1')).toBeUndefined();
    expect(memo.get('0')).toBe(0);
    expect(memo.get('2')).toBe(2);
    expect(memo.get('256')).toBe(256);
  });

  it('clones on both insertion and retrieval', () => {
    const memo = new PhotoNativeResultMemo((value: { cost: { pixels: number } }) => ({
      cost: { ...value.cost },
    }));
    const source = { cost: { pixels: 100 } };
    memo.set('proof', source);
    source.cost.pixels = 1;
    const first = memo.get('proof')!;
    expect(first.cost.pixels).toBe(100);
    first.cost.pixels = 2;
    expect(memo.get('proof')!.cost.pixels).toBe(100);
  });
});
