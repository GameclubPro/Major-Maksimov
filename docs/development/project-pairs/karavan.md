# Майор + Караван

Участник открывает магазин выбранного MAX-чата. Администратор с действующими правами может перейти в админку того же магазина. Публичный вход использует `m_`, административный — `ma_`. После самостоятельного возврата Майор обновляет привязку и права на экране того же чата. [Настройка, управление и переходы](../../operations/runbooks/karavan-chat-marketplaces.md#управление-и-переходы)

## Владельцы и код

- Майор проверяет полномочия пользователя и назначенного бота в точном чате, выбирает привязку и отвечает за кнопки и публикации в чате. [Экран настроек магазина](../../../apps/miniapp/src/pages/settings/karavan-shop/settings-simple.tsx), [клиент](../../../apps/miniapp/src/lib/api/karavan-shop-client.ts), [прокси команд](../../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-proxy.service.ts) и [проверка полномочий](../../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-authority.service.ts).
- Караван хранит магазины, привязки, витрины и заказы. Он обрабатывает команды Майора и владеет админкой своего покупательского приложения. Исходники в Караване находятся в `apps/api/src/routes/marketplace-integration-routes.ts` и `apps/client-miniapp/src/client-marketplace-launch.ts`. Документы владельца находятся в `docs/maxim-storefront-integration.md` и `docs/chat-marketplaces-release.md`.
- Контракт фиксирует точные чат, магазин, бота, пользователя и команду. [Схемы](../../../packages/contracts/src/karavan-marketplace.ts) и [протокол](../../operations/runbooks/karavan-chat-marketplaces.md#доверие-и-протокол)

## Проверка перехода

Подключите разные магазины к двум чатам в локальных фикстурах. Откройте магазин и админку из одного чата, проверьте точное назначение и вернитесь в начальный чат. Затем отзовите права администратора и проверьте, что управление отказано, а привязка и второй магазин сохранены.

Для быстрой проверки в Майоре откройте публичный и административный входы через браузерную
фикстуру. Отдельно проверьте смену пользователя, чата, магазина и поколения привязки.
Запускайте команды из корня Майора в Linux или WSL.

```bash
SHOP_SIMPLE_ONLY=connection SHOP_SIMPLE_ENGINE=chromium SHOP_SIMPLE_THEME=light node apps/miniapp/test/karavan-shop-simple.browser.mjs
SHOP_ROUTE_SCOPE_ONLY=1 node apps/miniapp/test/karavan-shop-route.browser.mjs
```

Выборочная проверка маршрута использует изолированную страницу магазина. Для изменений
в правах добавьте [проверку полномочий на PostgreSQL](../../../apps/api/src/integrations/karavan-marketplace/karavan-marketplace-authority-postgres.spec.ts).

У Каравана проверьте `tests/client-marketplace-launch.test.ts` и `tests/api/marketplace-module-access-database.test.ts`. Эти тесты покрывают отдельные границы сценария. Для совместной приёмки пройдите переход и отказ на выбранной паре ревизий.

## Совместимость и выпуск

В `workspace` выбирайте `major,karavan` и профиль `chat-shop@1`. Сверьте базу и доступность проверок для каждого репозитория. При изменении восстановления привязки сначала нужен совместимый читатель подтверждений в Караване, затем сервер Майора с адаптерами прежних маршрутов, затем клиент. Новый формат публикаций требует читателя Майора до включения записи в Караване. Выберите порядок по изменённому участку и проверьте промежуточную пару. [Порядок выпуска и требования к откату](../../operations/runbooks/karavan-chat-marketplaces.md#подготовка-и-выпуск)
