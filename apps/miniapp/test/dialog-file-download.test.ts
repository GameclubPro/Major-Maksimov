import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadDialogFile } from '../src/lib/dialog-file-download';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const origin = 'https://major-maksimov.ru';

function configureDownloadEnvironment(downloadFile?: (url: string, name: string) => Promise<void>) {
  const assigned: string[] = [];
  const downloads: Array<{ url: string; name: string }> = [];
  const opened: string[] = [];
  Object.assign(globalThis, {
    window: {
      location: {
        origin,
        href: origin + '/app/',
        assign: (url: string) => assigned.push(url),
      },
      MAX: {
        WebApp: {
          initData: 'synthetic',
          openLink: (url: string) => opened.push(url),
          downloadFile,
        },
      },
    },
    document: {
      documentElement: { dataset: {} },
      createElement: (tag: string) => {
        assert.equal(tag, 'a');
        return {
          href: '',
          download: '',
          click() {
            downloads.push({ url: this.href, name: this.download });
          },
        };
      },
    },
  });
  return { assigned, downloads, opened };
}

test.afterEach(() => {
  Object.assign(globalThis, { window: originalWindow, document: originalDocument });
});

test('downloads supported inline data and local blobs as files', async () => {
  const state = configureDownloadEnvironment();
  const dataUrl = 'data:application/pdf;base64,YQ==';
  const blobUrl = 'blob:' + origin + '/local-preview';

  await downloadDialogFile(dataUrl, 'Документ.pdf');
  await downloadDialogFile(blobUrl, 'Снимок.png');

  assert.deepEqual(state, {
    assigned: [],
    opened: [],
    downloads: [
      { url: dataUrl, name: 'Документ.pdf' },
      { url: blobUrl, name: 'Снимок.png' },
    ],
  });
});

test('rejects unsupported or malformed inline attachments', async () => {
  const state = configureDownloadEnvironment();
  for (const url of [
    'data:text/html;base64,YQ==',
    'data:image/svg+xml;base64,YQ==',
    'data:application/pdf;base64,invalid!',
    'blob:https://example.com/foreign-preview',
  ]) {
    await downloadDialogFile(url, 'Подготовленный файл');
  }

  assert.deepEqual(state, { assigned: [], opened: [], downloads: [] });
});

test('uses MAX native HTTPS download and falls back to web only after refusal', async () => {
  const attempted: Array<{ url: string; name: string }> = [];
  const state = configureDownloadEnvironment(async (url, name) => {
    attempted.push({ url, name });
    if (name === 'Отказ.pdf') {
      throw new Error('Native download unavailable');
    }
  });
  const url = 'https://example.com/path';

  await downloadDialogFile(url, 'Сохранить.pdf');
  await downloadDialogFile(url, 'Отказ.pdf');

  assert.deepEqual(attempted, [
    { url, name: 'Сохранить.pdf' },
    { url, name: 'Отказ.pdf' },
  ]);
  assert.deepEqual(state, { assigned: [], opened: [url], downloads: [] });
});
