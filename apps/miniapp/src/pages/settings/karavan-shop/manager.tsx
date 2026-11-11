import '../../../styles/karavan-shop.css';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import type { ApiTransport } from '../../../lib/api/transport';
import { StorefrontScreen, useStorefrontWorkspace } from '../storefront-workspace';
import { SettingsSectionToggle } from '../../../components/ui/settings-section-toggle';
import { openKaravanStorefront } from '../../../lib/karavan-storefront-navigation';
import { karavanShopManagementUrl } from '../../../lib/karavan-shop-management-link';
import { type ShopModule } from './runtime';
import { ShopCommandProvider, ShopCommandRecovery, useShopCommands } from './command-runtime';

type Props = {
  api: ApiTransport;
  chatId: string;
  module: ShopModule;
  busy: boolean;
  readOnly?: boolean;
  open: () => void;
  chats: ReactNode;
  publications?: ReactNode;
};

function ConnectionWorkspace({ module, busy, readOnly, open, chats, publications }: Props) {
  const workspace = useStorefrontWorkspace();
  const commands = useShopCommands();
  const [error, setError] = useState<string | null>(null);
  const market = module.marketplace!;
  const manageUrl = karavanShopManagementUrl(module.buyerUrl, market.publicSlug);
  useLayoutEffect(() => {
    if (workspace && !['home', 'chats', 'publications'].includes(workspace.page)) workspace.navigate('home');
  }, [workspace?.page, workspace?.navigate]);
  const openManagement = () => {
    if (!manageUrl || busy || readOnly || commands.blocked) return;
    setError(openKaravanStorefront(manageUrl) ? null : 'Не удалось открыть управление. Повторите переход.');
  };
  return <>
    <ShopCommandRecovery showNavigation={false} />
    <StorefrontScreen page="home">
      <header className="karavan-shop-home__header"><div><h3>{market.name}</h3><p>{market.status === 'active' ? 'Магазин подключён' : market.status === 'archived' ? 'Магазин в архиве' : 'Магазин выключен'}</p></div></header>
      <div className="karavan-module__actions">
        {market.status === 'active' && module.buyerUrl ? <button type="button" disabled={busy} onClick={open}>Открыть магазин</button> : null}
        <button type="button" className="karavan-module__primary" disabled={busy || readOnly || commands.blocked || !manageUrl} onClick={openManagement}>Управлять магазином</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {publications ? <SettingsSectionToggle title="Кнопки в чате" icon="send" tone="sky" open={false} controls="karavan-shop-publications" onClick={() => workspace?.navigate('publications')} /> : null}
      <SettingsSectionToggle title="Подключение" icon="tools" tone="sky" open={false} controls="karavan-shop-chats" onClick={() => workspace?.navigate('chats')} />
    </StorefrontScreen>
    <StorefrontScreen page="chats"><div id="karavan-shop-chats">{chats}</div></StorefrontScreen>
    {publications ? <StorefrontScreen page="publications"><div id="karavan-shop-publications">{publications}</div></StorefrontScreen> : null}
  </>;
}

export default function KaravanShopManager(props: Props) {
  if (!props.module.marketplace || props.module.binding?.chatId !== props.chatId || props.module.binding.state !== 'verified' || (props.module.access && props.module.access.reason !== 'allowed')) return null;
  return <ShopCommandProvider api={props.api} readOnly={props.readOnly} scope={{ actorMaxUserId: props.module.actorMaxUserId, chatId: props.chatId, marketplaceId: props.module.marketplace.id, expectedBindingGeneration: props.module.binding.generation }}>
    <ConnectionWorkspace {...props} />
  </ShopCommandProvider>;
}
