import type { PublicationSummary } from '@maxim/contracts/publication';

export function PublicationDeliveryNote({
  delivery,
  title,
  pending,
  onReview,
}: {
  delivery: PublicationSummary['delivery'];
  title: string;
  pending: boolean;
  onReview: () => void;
}) {
  if (delivery.ambiguous > 0)
    return (
      <button
        type="button"
        className="publication-delivery-note is-danger publication-delivery-note--action"
        disabled={pending}
        aria-label={`Проверить отправку: ${title}`}
        onClick={onReview}
      >
        Проверьте отправку
      </button>
    );
  if (delivery.failed > 0 || delivery.canceled > 0)
    return (
      <span className="publication-delivery-note is-danger">Есть недоставленные сообщения</span>
    );
  if (delivery.sent > 0)
    return (
      <span className="publication-delivery-note">
        Доставлено {delivery.sent} из {delivery.total}
      </span>
    );
  return null;
}
