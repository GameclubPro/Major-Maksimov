import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BroadcastLinkButton } from '@maxim/contracts';
import { PublicationButtonsSheet } from '../../src/features/publications/publication-buttons-sheet';
import { PublicationTargetPicker } from '../../src/features/publications/publication-target-picker';
import { runNativeBackHandlers } from '../../src/lib/native-back';
import type { PublicationTarget } from '../../src/features/publications/publication-model';
import '../../src/styles.css';
import '../../src/styles/publications-page.css';
import '../../src/styles/publisher-workspace.css';
import '../../src/styles/publisher-publications-workspace.css';

const choices: PublicationTarget[] = Array.from({ length: 200 }, (_, index) => ({
  id: `target-${index}`,
  entityType: 'channel',
  title: `Канал ${index + 1} · Длинное название районного сообщества и ежедневных новостей`,
  avatarUrl: null,
  channelOverview: null,
}));

function Harness() {
  const [open, setOpen] = useState(false);
  const [buttons, setButtons] = useState<BroadcastLinkButton[]>([]);
  const [applied, setApplied] = useState(0);
  const [targets, setTargets] = useState<PublicationTarget[]>([]);
  const [query, setQuery] = useState('');
  return (
    <main className="publications-page is-publisher">
      <button type="button" onClick={() => setOpen(true)}>
        Редактировать кнопки
      </button>
      <button type="button" onClick={() => runNativeBackHandlers()}>
        Native Back
      </button>
      <output aria-label="Применённые кнопки">{JSON.stringify(buttons)}</output>
      <output aria-label="Количество сохранений">{applied}</output>
      <PublicationButtonsSheet
        open={open}
        buttons={buttons}
        onClose={() => setOpen(false)}
        onApply={(value) => {
          setButtons(value);
          setApplied((current) => current + 1);
          setOpen(false);
        }}
      />
      <PublicationTargetPicker
        choices={choices.filter((choice) => choice.title.includes(query))}
        value={targets}
        onChange={setTargets}
        remoteSource={{
          query,
          entityFilter: 'all',
          settling: false,
          loading: false,
          failed: false,
          refreshFailed: false,
          retrying: false,
          onRetry() {},
          filteredTotal: 200,
          hasNextPage: false,
          fetchingNextPage: false,
          fetchNextPageError: false,
          onQueryChange: setQuery,
          onEntityFilterChange() {},
          onLoadMore() {},
        }}
      />
    </main>
  );
}

document.body.dataset.miniappProfile = 'publisher';
createRoot(document.getElementById('root')!).render(<Harness />);
