import { useEffect } from 'react';
import { useHomeEntityFavorites } from '../../lib/home-entity-favorites-context';
import { resolveSettingsSaveFavoriteType } from './settings-save-folder';

export function useSettingsSaveFolder(chatId: string | undefined, routeState: unknown) {
  const { snapshot, actions } = useHomeEntityFavorites();
  const complete = snapshot.byType.chat.assignmentsComplete;
  useEffect(() => {
    if (!chatId || complete) return;
    const controller = new AbortController();
    void actions.refreshAssignments('chat', controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [actions, chatId, complete]);

  if (
    !chatId ||
    !complete ||
    snapshot.byType.chat.status !== 'ready' ||
    snapshot.labels.status !== 'ready' ||
    !snapshot.labels.serverConfirmed
  )
    return null;
  const type = resolveSettingsSaveFavoriteType(chatId, routeState, snapshot.assignments);
  return type ? { type, label: snapshot.labels.resolved[type] } : null;
}
