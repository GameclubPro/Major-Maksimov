import { useEffect, useRef, useState } from 'react';
import { useStorefrontDirty } from '../storefront-workspace';
import type { MarketplaceApplication } from '@maxim/contracts/karavan-marketplace-management';
import { ListingContentDisclosure } from './listing-content-disclosure';
import {
  MutationFailure,
  ShopFailure,
  ShopLoading,
  useShop,
  useShopMutation,
  useShopPages,
  useShopQuery,
} from './runtime';
import { uniqueShopItems } from './shop-journey';
import { publicationReasons } from './listing-status';
import { AddOwnOfferAction } from './seller-access';
import { useShopCommands } from './command-runtime';

function ApplicationExamples({ listingId }: { listingId: string }) {
  const products = useShopQuery<'content'>({
    operation: 'content',
    listingId,
    input: { kind: 'product', cursor: null, limit: 3 },
  });
  const properties = useShopQuery<'content'>({
    operation: 'content',
    listingId,
    input: { kind: 'property', cursor: null, limit: 3 },
  });
  const items = [...(products.data?.items ?? []), ...(properties.data?.items ?? [])].slice(0, 3);
  if (products.isPending || properties.isPending) return <ShopLoading />;
  return (
    <div className="karavan-shop__examples">
      {items.map((item) => (
        <div key={`${item.kind}:${item.id}`} className="karavan-shop__example">
          {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : null}
          <span>
            <strong>{item.title}</strong>
            {item.categoryLabel ? <small>{item.categoryLabel}</small> : null}
            {item.priceLabel ? <span>{item.priceLabel}</span> : null}
          </span>
          {!item.allowedCategory ? <small>Категория отключена</small> : null}
        </div>
      ))}
      {products.isError ? (
        <ShopFailure error={products.error} retry={() => void products.refetch()} />
      ) : null}
      {properties.isError ? (
        <ShopFailure error={properties.error} retry={() => void properties.refetch()} />
      ) : null}
      {!items.length && !products.isError && !properties.isError ? (
        <p>Объявлений пока нет</p>
      ) : null}
    </div>
  );
}

function Application({
  application,
  onResult,
  simple = false,
}: {
  application: MarketplaceApplication;
  onResult: (message: string) => void;
  simple?: boolean;
}) {
  const [decision, setDecision] = useState<'reject' | 'changes_requested' | null>(null);
  const [reason, setReason] = useState('');
  const mutation = useShopMutation(
    { owner: `application:${application.id}`, page: 'applications' },
    (command, result) => {
      if (command.operation !== 'decide') return;
      const value = command.input.decision;
      const label =
        value === 'approve'
          ? 'Продавец одобрен'
          : value === 'reject'
            ? 'Заявка отклонена'
            : 'Заявка отправлена на доработку';
      onResult(
        value === 'approve' &&
          'listing' in result &&
          result.listing.publicationReason !== 'published'
          ? `${label}. ${publicationReasons[result.listing.publicationReason]}.`
          : label,
      );
      setDecision(null);
      setReason('');
    },
  );
  const locked = mutation.blocked;
  useEffect(() => {
    const saved = mutation.pendingCommand;
    if (saved?.operation !== 'decide' || saved.applicationId !== application.id) return;
    setDecision(saved.input.decision === 'approve' ? null : saved.input.decision);
    setReason(saved.input.reason ?? '');
  }, [application.id, mutation.pendingCommand]);
  useStorefrontDirty(
    `application:${application.id}`,
    (!!decision && !!reason.trim()) || mutation.uncertain,
  );
  const decide = async (value: 'approve' | 'reject' | 'changes_requested') => {
    await mutation.mutateAsync({
      operation: 'decide',
      applicationId: application.id,
      input: {
        commandId: crypto.randomUUID(),
        expectedRevision: application.revision,
        decision: value,
        reason: value === 'approve' ? null : reason.trim(),
      },
    });
  };
  return (
    <article className="karavan-shop__row">
      <div className="karavan-shop__identity">
        {application.profile.logoImageUrl ? (
          <img src={application.profile.logoImageUrl} alt="" />
        ) : null}
        <strong>{application.profile.name}</strong>
      </div>
      {simple && application.sellerName ? <p>{application.sellerName}</p> : null}
      {simple && application.categoryLabel ? (
        <span className="karavan-shop__category-label">{application.categoryLabel}</span>
      ) : null}
      {application.profile.description ? <p>{application.profile.description}</p> : null}
      {application.publishedProfile &&
      application.publishedProfile.name !== application.profile.name ? (
        <p>Сейчас: {application.publishedProfile.name}</p>
      ) : null}
      {simple ? <ApplicationExamples listingId={application.listingId} /> : null}
      <ListingContentDisclosure listingId={application.listingId} />
      {application.canReview && !decision ? (
        <div className="karavan-module__entry-actions">
          <button
            type="button"
            className="karavan-module__primary"
            disabled={locked}
            onClick={() => void decide('approve').catch(() => {})}
          >
            {mutation.isPending &&
            mutation.variables?.operation === 'decide' &&
            mutation.variables.input.decision === 'approve'
              ? 'Одобряем…'
              : simple
                ? 'Добавить в магазин'
                : 'Одобрить'}
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setDecision('changes_requested');
            }}
          >
            На доработку
          </button>
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              setDecision('reject');
            }}
          >
            Отклонить
          </button>
        </div>
      ) : !application.canReview ? (
        application.canPublishOwn ? (
          <AddOwnOfferAction storeId={application.storeId} />
        ) : (
          <p>Заявку проверяет другой администратор.</p>
        )
      ) : null}
      {decision && application.canReview ? (
        <div className="karavan-module__actions">
          <label className="karavan-module__field">
            {decision === 'reject' ? 'Причина отказа' : 'Что нужно исправить'}
            <textarea
              value={reason}
              maxLength={2000}
              disabled={mutation.editingBlocked}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={mutation.editingBlocked}
            onClick={() => setDecision(decision === 'reject' ? 'changes_requested' : 'reject')}
          >
            {decision === 'reject' ? 'На доработку' : 'Отклонить'}
          </button>
          <button
            type="button"
            disabled={locked || !reason.trim()}
            onClick={() => void decide(decision).catch(() => {})}
          >
            {mutation.isPending
              ? 'Сохраняем решение…'
              : decision === 'reject'
                ? 'Отклонить заявку'
                : simple
                  ? 'Отправить'
                  : 'Отправить на доработку'}
          </button>
          <button type="button" disabled={mutation.uncertain} onClick={() => setDecision(null)}>
            Отмена
          </button>
        </div>
      ) : null}
      <MutationFailure mutation={mutation} />
    </article>
  );
}

function LegacyApplications() {
  const [notice, setNotice] = useState('');
  const query = useShopPages<'applications'>({
    operation: 'applications',
    input: { cursor: null, limit: 24, state: 'pending' },
  });
  if (query.isPending) return <ShopLoading />;
  if (!query.data) return <ShopFailure error={query.error} retry={() => void query.refetch()} />;
  const applications = uniqueShopItems(query.data.pages.map((page) => page.applications));
  return (
    <>
      {notice ? <p role="status">{notice}</p> : null}
      {!applications.length ? <p>Новых заявок нет</p> : null}
      {applications.map((application) => (
        <Application key={application.id} application={application} onResult={setNotice} />
      ))}
      {query.hasNextPage ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
      {query.isFetchNextPageError ? (
        <ShopFailure error={query.error} retry={() => void query.fetchNextPage()} />
      ) : null}
    </>
  );
}

const historyLabels = {
  pending: 'Ожидает решения',
  approved: 'Одобрено',
  changes_requested: 'На доработке',
  rejected: 'Отклонено',
  superseded: 'Заменено новой заявкой',
  withdrawn: 'Отозвано продавцом',
} satisfies Record<MarketplaceApplication['state'], string>;

function SimpleApplications() {
  const { module } = useShop();
  const commands = useShopCommands();
  const [history, setHistory] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [notice, setNotice] = useState('');
  const seen = useRef(new Set<string>());
  const queue = useRef<HTMLDivElement>(null);
  const query = useShopPages<'applications'>({
    operation: 'applications',
    input: { cursor: null, limit: 24, state: history ? 'completed' : 'pending' },
  });
  const applications = uniqueShopItems(query.data?.pages.map((page) => page.applications) ?? []);
  const pending = applications.filter((application) => application.state === 'pending');
  const index = Math.min(selectedIndex, Math.max(0, pending.length - 1));
  const current = pending[index];
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (commands.busy || commands.loading || commands.stale || commands.journal?.pending) return;
    for (const receipt of Object.values(commands.journal?.results ?? {})) {
      if (receipt.response.operation !== 'decide' || seen.current.has(receipt.request.commandId))
        continue;
      seen.current.add(receipt.request.commandId);
      const listing = receipt.response.data.listing;
      setNotice(
        listing.reviewState === 'approved'
          ? listing.publicationReason === 'published'
            ? 'Витрина добавлена в магазин'
            : `Витрина одобрена. ${publicationReasons[listing.publicationReason]}.`
          : listing.reviewState === 'rejected'
            ? 'Заявка отклонена'
            : 'Заявка отправлена на доработку',
      );
    }
  }, [commands.busy, commands.loading, commands.stale, commands.journal]);
  useEffect(() => {
    if (previous.current && previous.current !== current?.id && !history)
      queue.current?.focus({ preventScroll: true });
    previous.current = current?.id;
  }, [current?.id, history]);
  return (
    <>
      <div className="karavan-shop__filters">
        <button type="button" aria-pressed={!history} onClick={() => setHistory(false)}>
          Ожидают решения
        </button>
        <button type="button" aria-pressed={history} onClick={() => setHistory(true)}>
          История
        </button>
      </div>
      {notice ? <p role="status">{notice}</p> : null}
      {query.isPending ? (
        <ShopLoading />
      ) : !query.data ? (
        <ShopFailure error={query.error} retry={() => void query.refetch()} />
      ) : history ? (
        <>
          {applications
            .filter((application) => application.state !== 'pending')
            .map((application) => (
              <article className="karavan-shop__row" key={application.id}>
                <strong>{application.profile.name}</strong>
                {application.sellerName ? <p>{application.sellerName}</p> : null}
                <p>{historyLabels[application.state]}</p>
                {application.reason ? <p>{application.reason}</p> : null}
                <small>
                  {new Date(application.decidedAt ?? application.submittedAt).toLocaleDateString(
                    'ru-RU',
                  )}
                </small>
              </article>
            ))}
          {!applications.some((application) => application.state !== 'pending') ? (
            <p>
              {query.hasNextPage ? 'На этой странице только ожидающие заявки.' : 'Решений пока нет'}
            </p>
          ) : null}
        </>
      ) : (
        <div
          ref={queue}
          tabIndex={-1}
          className="karavan-shop__application-queue"
          aria-label="Ожидающие заявки"
        >
          {current ? (
            <>
              <p>Ожидают решения: {module.counts.pendingApplications}</p>
              <Application key={current.id} application={current} simple onResult={setNotice} />
              {pending.length > 1 ? (
                <button
                  type="button"
                  disabled={commands.blocked}
                  onClick={() => setSelectedIndex((index + 1) % pending.length)}
                >
                  Следующая заявка
                </button>
              ) : null}
            </>
          ) : (
            <p>Новых заявок нет</p>
          )}
        </div>
      )}
      {query.hasNextPage && (history || !current || index === pending.length - 1) ? (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Показать ещё
        </button>
      ) : null}
      {query.isFetchNextPageError ? (
        <ShopFailure error={query.error} retry={() => void query.fetchNextPage()} />
      ) : null}
    </>
  );
}

export default function ShopApplications() {
  const { module } = useShop();
  return module.chatShopFlowVersion === 2 ? <SimpleApplications /> : <LegacyApplications />;
}
