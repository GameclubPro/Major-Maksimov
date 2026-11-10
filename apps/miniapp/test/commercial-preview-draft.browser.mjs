import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}?preview=1`);
  await page.locator('.bottom-nav').waitFor();
  await page.evaluate(async () => {
    const moduleUrl = (name) =>
      performance
        .getEntriesByType('resource')
        .findLast((entry) => new URL(entry.name).pathname.endsWith('/' + name))?.name;
    const ReactModule = await import(moduleUrl('react.js'));
    const React = ReactModule.default ?? ReactModule;
    const ReactDOM = await import(moduleUrl('react-dom_client.js'));
    const { CommercialPreviewSheet } =
      await import('/app/src/pages/settings/commercial-policy-preview.tsx');
    const host = document.createElement('div');
    document.body.replaceChildren(host);
    const root = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(host);
    window.__previewRequests = [];
    const api = {
      async request(_path, init) {
        window.__previewRequests.push(JSON.parse(init.body));
        if (window.__delayPreview)
          await new Promise((resolve) => {
            window.__resolvePreview = resolve;
          });
        return { decision: 'KEEP', categories: ['BUSINESS'], reason: 'CATEGORY_ALLOWED' };
      },
      requestKeepalive() {},
    };
    function Fixture() {
      const [classification, setClassification] = React.useState({
        commercialAdsSensitivity: 'BALANCED',
        commercialAdsWarnThreshold: 60,
        commercialAdsDeleteThreshold: 82,
      });
      const [dirty, setDirty] = React.useState(false);
      window.__setPreviewProfile = (value) => {
        setClassification(value);
        setDirty(true);
      };
      return React.createElement(CommercialPreviewSheet, {
        scope: { api, chatId: 'draft-fixture', onOpenJournal() {} },
        policy: null,
        enabled: true,
        classification,
        dirty,
        onClose() {},
      });
    }
    root.render(React.createElement(Fixture));
  });
  const sheet = page.getByRole('dialog', { name: 'Проверить сообщение', exact: true });
  await sheet.getByRole('textbox', { name: 'Сообщение для проверки' }).fill('Текст проверки');
  await sheet.getByRole('button', { name: 'Проверить', exact: true }).click();
  await sheet.locator('.commercial-policy__result').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__previewRequests[0].classification), {
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 60,
    commercialAdsDeleteThreshold: 82,
  });
  const strict = {
    commercialAdsSensitivity: 'STRICT',
    commercialAdsWarnThreshold: 38,
    commercialAdsDeleteThreshold: 55,
  };
  await page.evaluate((profile) => window.__setPreviewProfile(profile), strict);
  await sheet.locator('.commercial-policy__result').waitFor({ state: 'detached' });
  await sheet.getByText('Проверка с несохранёнными настройками', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__delayPreview = true;
  });
  await sheet.getByRole('button', { name: 'Проверить', exact: true }).click();
  await page.waitForFunction(() => window.__previewRequests.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__previewRequests[1].classification), strict);
  await page.evaluate(() =>
    window.__setPreviewProfile({
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 45,
      commercialAdsDeleteThreshold: 65,
    }),
  );
  await page.waitForFunction(() => !document.querySelector('.commercial-policy__submit').disabled);
  await page.evaluate(() => {
    window.__delayPreview = false;
    window.__resolvePreview();
  });
  // A late transport response ignores cancellation deliberately; the component must still reject it.
  await sheet.getByRole('button', { name: 'Проверить', exact: true }).click();
  await sheet.locator('.commercial-policy__result').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__previewRequests[2].classification), {
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
  });
  assert.equal(await sheet.locator('.commercial-policy__result').count(), 1);
  console.log(
    'PASS complete unsaved profile transport, dirty notice, result invalidation and superseded async response',
  );
} finally {
  await browser.close();
  await stopChildProcess(server);
}
