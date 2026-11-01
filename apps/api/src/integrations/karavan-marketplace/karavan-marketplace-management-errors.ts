import { HttpException } from '@nestjs/common';
import { z } from 'zod';
const messages: Record<string, string> = {
  MARKETPLACE_REVISION_CONFLICT: 'Магазин изменился. Обновите экран перед сохранением.',
  MARKETPLACE_BINDING_CHANGED: 'Магазин чата изменился. Откройте его заново.',
  MARKETPLACE_IMPACT_CHANGED: 'Состав каталога изменился. Проверьте последствия ещё раз.',
  MARKETPLACE_SELF_REVIEW: 'Вашу витрину должен проверить другой администратор.',
  MARKETPLACE_INDEPENDENT_REVIEW_REQUIRED: 'Решение должен принять другой администратор.',
  MARKETPLACE_APPLICATION_STALE: 'Заявка изменилась. Откройте её заново.',
  MARKETPLACE_APPLICATION_ALREADY_DECIDED: 'Заявка уже рассмотрена. Обновите список.',
  MARKETPLACE_APPLICATION_NOT_FOUND: 'Заявка больше недоступна. Обновите список.',
  MARKETPLACE_RULES_ACCEPTANCE_REQUIRED: 'Нужно запросить у продавцов принятие новых правил.',
  MARKETPLACE_RULES_NOTICE_REQUIRED:
    'Новые ограничения для действующих продавцов можно назначить через 14 дней.',
  MARKETPLACE_RULES_ALREADY_SCHEDULED: 'Сначала отмените запланированные изменения категорий.',
  MARKETPLACE_RULES_DATE_INVALID: 'Обновите проверку изменений перед сохранением.',
  MARKETPLACE_RULES_UNAVAILABLE: 'Правила магазина недоступны. Обновите экран.',
  MARKETPLACE_FORBIDDEN: 'Права администратора изменились. Откройте настройки чата заново.',
  MARKETPLACE_CATEGORIES_INVALID: 'Проверьте выбранные категории и подкатегории.',
  MARKETPLACE_PIN_UNAVAILABLE: 'Объявление сейчас не показывается в магазине.',
  MARKETPLACE_IMAGE_INVALID: 'Загрузите изображение заново.',
  MARKETPLACE_COMMAND_CONFLICT: 'Действие уже выполнено с другими данными. Обновите экран.',
  MARKETPLACE_CONTENT_NOT_FOUND: 'Объявление больше недоступно. Обновите каталог.',
  MARKETPLACE_ORDER_CHANGED: 'Порядок витрин изменился. Обновите каталог.',
  MARKETPLACE_REORDER_INVALID: 'Проверьте порядок витрин и повторите сохранение.',
  MARKETPLACE_NETWORK_LIMIT: 'Достигнут лимит торговых сетей. Выберите существующий магазин.',
  MARKETPLACE_LIMIT: 'Достигнут лимит магазинов. Подключите существующий.',
  MARKETPLACE_STATUS_INVALID: 'Состояние магазина изменилось. Обновите экран.',
  MARKETPLACE_CHAT_REQUIRED: 'Сначала подключите к магазину хотя бы один чат.',
  MARKETPLACE_EMPTY_CONFIRMATION: 'Подтвердите открытие магазина с пустым каталогом.',
  MARKETPLACE_FORMAT_LIMIT: 'Достигнут лимит магазинов этого формата.',
  MARKETPLACE_FORMAT_CHANGED: 'Формат магазина изменился. Обновите экран.',
  MARKETPLACE_ARCHIVED: 'Магазин в архиве.',
  ADMINISTRATION_STORE_OWNER_REQUIRED: 'Для магазина администрации нужна ваша собственная витрина.',
  ADMINISTRATION_STORE_REQUIRED: 'Выберите общую витрину администрации.',
  ADMINISTRATION_STORE_NOT_READY:
    'Общая витрина пока недоступна покупателям. Проверьте её и товары.',
  PLACEMENT_REVIEW_REQUIRED: 'Размещение витрины ещё не одобрено.',
  PLACEMENT_NOT_FOUND: 'Витрина больше не размещена в этом магазине. Обновите каталог.',
  SELLER_STOREFRONT_LIMIT: 'Достигнут лимит витрин. Выберите существующую.',
};
export class KaravanManagementRejected extends HttpException {}

export async function throwKnownKaravanManagementError(response: Response): Promise<void> {
  if (![400, 403, 404, 409, 422].includes(response.status)) return;
  try {
    const parsed = z.object({ error: z.string().max(100) }).safeParse(await response.json());
    if (parsed.success && messages[parsed.data.error])
      throw new KaravanManagementRejected(
        { code: parsed.data.error, message: messages[parsed.data.error] },
        response.status,
      );
  } catch (error) {
    if (error instanceof HttpException) throw error;
  }
}
