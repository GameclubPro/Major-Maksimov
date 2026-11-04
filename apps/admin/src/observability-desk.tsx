import { PublicationCohortDesk } from './publication-cohort-desk';
import { WebhookCohortDesk } from './webhook-cohort-desk';
import { DeleteCohortDesk } from './delete-cohort-desk';
import { PublicationDeliveryCohortDesk } from './publication-delivery-cohort-desk';
import { CommercialAiDesk } from './commercial-ai-desk';
import { useMemo, useState } from 'react';
import { RuntimeOverviewDesk } from './runtime-overview-desk';
import type { OverviewAccessScope } from './use-runtime-overview';

const families = {
  overview: 'Боты и очереди',
  webhook: 'Входящие события',
  deletion: 'Намерения удаления',
  publication: 'Запуски Публика',
  delivery: 'Доставки Публика',
  commercialAi: 'Рекламный ИИ',
} as const;

export function ObservabilityDesk(props: {
  accessCode: string;
  refreshToken: number;
  accessScope?: OverviewAccessScope;
}) {
  const [family, setFamily] = useState<keyof typeof families>('overview');
  const fallbackScope = useMemo(() => ({ denied: false }), [props.accessCode]);
  return (
    <div className="observation-panels">
      <nav className="observation-selector" aria-label="Вид наблюдений">
        {(Object.keys(families) as Array<keyof typeof families>).map((key) => (
          <button
            key={key}
            className="ghost-action"
            type="button"
            aria-pressed={family === key}
            onClick={() => setFamily(key)}
          >
            {families[key]}
          </button>
        ))}
      </nav>
      {family === 'overview' && (
        <RuntimeOverviewDesk
          {...props}
          accessScope={props.accessScope ?? fallbackScope}
          onEvidence={setFamily}
        />
      )}
      {family === 'webhook' && <WebhookCohortDesk {...props} />}
      {family === 'publication' && <PublicationCohortDesk {...props} />}
      {family === 'deletion' && <DeleteCohortDesk {...props} />}
      {family === 'delivery' && <PublicationDeliveryCohortDesk {...props} />}
      {family === 'commercialAi' && <CommercialAiDesk {...props} />}
    </div>
  );
}
