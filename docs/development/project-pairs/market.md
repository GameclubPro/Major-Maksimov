# Майор + Биржа

Майор или Публик открывает рекламную карточку выбранного сообщества в Биржике. Второй администратор видит существующую карточку при наличии доступа. Право менять цены, карточку и сделки остаётся у владельца. [Права и навигация](../marketplace-integration.md#authority-and-navigation)

## Владельцы и код

- Майор и Публик выбирают сообщество, проверяют права и управляют рекламной кнопкой для конкретного модуля. [Экран карточки](../../../apps/miniapp/src/components/marketplace-profile-workspace.tsx), [переход в Биржик](../../../apps/api/src/integrations/marketplace/marketplace-navigation.service.ts), [доступ к профилю](../../../apps/api/src/integrations/marketplace/marketplace-profile-access.service.ts) и [общие схемы](../../../packages/contracts/src/marketplace-integration.ts).
- Биржик хранит рекламные карточки, цены и сделки, проверяет владельца при редактировании и разбирает вход из Майора. Обработчик карточки находится в `server/maxim-profile.ts`, подтверждение доступа — в `server/maxim-profile-access.ts`. Начните с `docs/README.md` в репозитории Биржика.

## Проверка перехода

В локальных фикстурах создайте карточку с одним владельцем. Откройте её из Майора под вторым администратором того же сообщества и проверьте ID карточки, отсутствие дубля и отказ изменения цены. Затем проверьте изменение цены владельцем. У Майора проверьте право доступа на PostgreSQL и открытие карточки в браузере. [Права](../../../apps/api/src/integrations/marketplace/marketplace-profile-access-postgres.spec.ts) · [Карточка](../../../apps/miniapp/test/marketplace-profile.browser.mjs)

У Биржика используйте `tests/maxim-launch.test.ts` для адреса перехода, `tests/maxim-profile-access.test.ts` для доказательства доступа и `tests/maxim-profile.spec.ts` для интерфейса карточки.

## Статистика

Подтверждение доступа к рекламной карточке и допуск к данным статистики имеют отдельные контракты. Майор хранит каноническую статистику чатов и каналов. Биржик отправляет свои наблюдения через внутренний API и сохраняет собственное хранилище продукта. На стороне Майора проверьте затронутый HTTP маршрут или запись и права на PostgreSQL. [Контроллер](../../../apps/api/src/statistics/stats.controller.ts) · [Схемы](../../../packages/contracts/src/statistics-central.ts) · [HTTP проверка](../../../apps/api/src/statistics/stats-controller-http.spec.ts) · [Тест PostgreSQL](../../../apps/api/src/statistics/stats-central-postgres.spec.ts)

У Биржика начните с `server/central-statistics-client.ts`, `docs/statistics-central-cutover.md` и `tests/statistics-central-cutover.test.ts`. Границы прежнего протокола и условия совместимости описаны отдельно. [Обмен статистикой v3](../../maxim-svyazka-statistics-v3.md)

## Совместимость и выпуск

Выбирайте `birzhik-core@1` для карточки и кнопки, `statistics-central@1` для статистики. Сверяйте наличие требуемых помощников на выбранной ревизии Биржика. При отсутствии помощника работайте в отдельных деревьях и используйте проверки соответствующих репозиториев. Для задачи работающего Биржика начните с его `npm run project:status` по `AGENTS.md`.

Для карточки и кнопок сохраняйте работающий контракт на переходной паре версий. Сначала выпустите читатель, поддерживающий прежний и новый формат, если именно формат меняется. Затем переключите отправителя после проверки. Для статистики порядок зависит от совместимого сервера Майора, миграций и отдельного перехода Биржика. Следуйте процедурам обоих владельцев. [Совместимость кнопок](../marketplace-integration.md#button-policy-and-compatibility) · [Порядок выпуска статистики](../../operations/runbooks/central-statistics-rollout.md#installation-order)
