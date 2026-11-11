import '../src/styles.css';
import '../src/styles/moderation-workspace.css';
import '../src/styles/karavan-marketplace.css';
import '../src/styles/karavan-shop.css';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShopShareLink } from '../src/pages/settings/karavan-shop/share-link';
import { syncMaxNativeEnvironment } from '../src/lib/max-bridge';

document.body.dataset.miniappProfile = 'moderation';
syncMaxNativeEnvironment();

const controls = {
  clipboard: [] as string[],
  clipboardMode: 'reject',
  nativeMode: 'reject',
  releaseNative: null as null | (() => void),
  rejectClipboard: null as null | (() => void),
  setUrl: (_value: string | null | undefined) => {},
  setDisabled: (_value: boolean) => {},
  setMounted: (_value: boolean) => {},
};
Object.assign(window, { shareFixture: controls });
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (value: string) => {
      controls.clipboard.push(value);
      if (controls.clipboardMode === 'hold')
        await new Promise<void>((_resolve, reject) => {
          controls.rejectClipboard = () => reject(new Error('Clipboard unavailable'));
        });
      if (controls.clipboardMode === 'reject') throw new Error('Clipboard unavailable');
    },
  },
});
const bridge = window.MAX?.WebApp ?? window.WebApp;
if (bridge)
  bridge.shareMaxContent = async () => {
    if (controls.nativeMode === 'hold')
      await new Promise<void>((resolve) => {
        controls.releaseNative = resolve;
      });
    if (controls.nativeMode !== 'success') throw new Error('Native sharing unavailable');
  };
function Harness() {
  const [url, setUrl] = useState<string | null | undefined>(
    'https://max.ru/synthetic_seller_bot?startapp=private_first',
  );
  const [disabled, setDisabled] = useState(false);
  const [mounted, setMounted] = useState(true);
  Object.assign(controls, { setUrl, setDisabled, setMounted });
  return (
    <main className="karavan-module">
      {mounted ? <ShopShareLink url={url} disabled={disabled} /> : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
