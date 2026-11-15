import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAntiduplicateReview } from './prepare-antiduplicate-review';
import {
  antiduplicateCorpusLabelSchema,
  corpusDigest,
  hashCorpusFile,
} from './antiduplicate-corpus';

describe('independent blind review preparation', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maxim-blind-review-'));
    await chmod(directory, 0o700);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function fixture() {
    const manifest = {
      type: 'MANIFEST',
      version: 'antiduplicate-corpus/v1',
      sourceSnapshotSha256: 'a'.repeat(64),
      sourceSnapshotAt: '2026-08-27T12:00:00Z',
      warmupFrom: '2026-08-13T00:00:00Z',
      from: '2026-08-20T00:00:00Z',
      until: '2026-08-27T00:00:00Z',
      holdoutFrom: '2026-08-25T00:00:00Z',
      settingsBasis: 'SNAPSHOT_REPLAY',
      cohortComplete: false,
      sourceComplete: true,
      selectedChats: 1,
      eligibleChats: 2,
      settings: { '-123': {} },
    };
    const events = [19, 21, 22, 23, 25, 26].map((day) => ({
      type: 'EVENT',
      id: corpusDigest(day),
      chatId: '-123',
      userId: '123',
      messageId: `message-${day}`,
      eventType: 'message_created',
      eventAt: `2026-08-${day}T12:00:00Z`,
      receivedAt: `2026-08-${day}T12:00:00Z`,
      publishedAt: `2026-08-${day}T12:00:00Z`,
      raw: { text: 'Synthetic review example' },
      historicalAction: 'DELETE_CONFIRMED',
    }));
    const end = {
      type: 'END',
      scanned: events.length,
      exported: events.length,
      rejected: 0,
      saturated: false,
      sourceComplete: true,
    };
    const input = join(directory, 'corpus.jsonl');
    await writeFile(
      input,
      [...[manifest], ...events, end].map((value) => JSON.stringify(value)).join('\n'),
      { mode: 0o600 },
    );
    return { input, digest: await hashCorpusFile(input) };
  }
  it('samples both partitions reproducibly without historical answers or fabricated human labels', async () => {
    const { input, digest } = await fixture();
    const run = async (name: string) => {
      const output = join(directory, name);
      await prepareAntiduplicateReview([
        '--input',
        input,
        '--output',
        output,
        '--corpus-sha256',
        digest,
        '--per-partition',
        '2',
      ]);
      return JSON.parse(await readFile(output, 'utf8')) as {
        items: Array<{ partition: string; label: unknown }>;
      };
    };
    const first = await run('first.json');
    expect(await run('second.json')).toEqual(first);
    expect(first.items.map((item) => item.partition)).toEqual([
      'DEVELOPMENT',
      'DEVELOPMENT',
      'HOLDOUT',
      'HOLDOUT',
    ]);
    expect(
      first.items.every((item) => !antiduplicateCorpusLabelSchema.safeParse(item.label).success),
    ).toBe(true);
    expect(JSON.stringify(first)).not.toContain('DELETE_CONFIRMED');
    await expect(run('first.json')).rejects.toThrow();
  });
  it('refuses a corpus different from the independently frozen digest', async () => {
    const { input } = await fixture();
    await expect(
      prepareAntiduplicateReview([
        '--input',
        input,
        '--output',
        join(directory, 'review.json'),
        '--corpus-sha256',
        'f'.repeat(64),
      ]),
    ).rejects.toThrow('digest mismatch');
  });

  it('refuses repeated event identities before creating a biased review sample', async () => {
    const { input } = await fixture();
    const lines = (await readFile(input, 'utf8')).split('\n');
    const first = JSON.parse(lines[1]!) as { id: string };
    const next = JSON.parse(lines[2]!) as { id: string };
    next.id = first.id;
    lines[2] = JSON.stringify(next);
    await writeFile(input, lines.join('\n'));
    await expect(
      prepareAntiduplicateReview([
        '--input',
        input,
        '--output',
        join(directory, 'review.json'),
        '--corpus-sha256',
        await hashCorpusFile(input),
      ]),
    ).rejects.toThrow('Corpus identity');
  });
});
