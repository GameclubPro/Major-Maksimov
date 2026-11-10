import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';

export function shopAvailabilityScope(module: KaravanMarketplaceModule) {
  const chats = (
    module.connectedChats ??
    module.bindings ??
    (module.binding ? [module.binding] : [])
  ).filter((binding) => binding.state === 'verified');
  const network = module.counts.chats > 1;
  return { network, chats, complete: !network || chats.length >= module.counts.chats };
}

export function ShopAvailabilityScope({ module }: { module: KaravanMarketplaceModule }) {
  const { network, chats, complete } = shopAvailabilityScope(module);
  if (!network) return null;
  return (
    <>
      <p>Изменение затронет все подключённые чаты:</p>
      <ul aria-label="Затронутые чаты">
        {chats.map((binding) => (
          <li key={binding.id}>{binding.chatTitle || 'Чат'}</li>
        ))}
      </ul>
      {!complete ? (
        <p role="alert">Не удалось получить все чаты. Обновите подключение магазина.</p>
      ) : null}
    </>
  );
}
