type CursorPage<T> = {
  items: readonly T[];
};

export function isAmbiguousDeliveryPhaseComplete(state: {
  hasAmbiguous: boolean;
  hasData: boolean;
  hasNextPage: boolean;
  isError: boolean;
  isFetchingNextPage: boolean;
  isSuccess: boolean;
}): boolean {
  if (!state.hasAmbiguous) {
    return true;
  }
  if (state.isError) {
    return state.hasData;
  }
  return state.isSuccess && !state.hasNextPage && !state.isFetchingNextPage;
}

export function mergePublicationPages<T extends { id: string }>(
  pages: readonly CursorPage<T>[] | undefined,
): T[] {
  const items = new Map<string, T>();
  for (const page of pages ?? []) {
    for (const item of page.items) {
      items.set(item.id, item);
    }
  }
  return Array.from(items.values());
}

export function shouldPollPublicationDeliveryPages<
  T extends { status: string; dispatchStopped?: boolean },
>(aggregatePending: boolean, pages: readonly CursorPage<T>[] | undefined): boolean {
  return (
    aggregatePending ||
    (pages ?? []).some((page) =>
      page.items.some(
        (item) =>
          item.dispatchStopped !== true && (item.status === 'PENDING' || item.status === 'SENDING'),
      ),
    )
  );
}

export function mergeLegacyPublicationPages<T extends { id: string; kind: string }>(
  pages: readonly CursorPage<T>[] | undefined,
): T[] {
  const items = new Map<string, T>();
  for (const page of pages ?? []) {
    for (const item of page.items) {
      items.set(`${item.kind}:${item.id}`, item);
    }
  }
  return Array.from(items.values());
}

export function mergePrioritizedPublicationPages<T extends { id: string }>(
  priorityPages: readonly CursorPage<T>[] | undefined,
  remainingPages: readonly CursorPage<T>[] | undefined,
): T[] {
  const items = new Map<string, T>();
  for (const page of [...(priorityPages ?? []), ...(remainingPages ?? [])]) {
    for (const item of page.items) {
      if (!items.has(item.id)) {
        items.set(item.id, item);
      }
    }
  }
  return Array.from(items.values());
}

export function mergePublicationDeliveryPages<T extends { id: string; status: string }>(
  hasAmbiguous: boolean,
  ambiguousPages: readonly CursorPage<T>[] | undefined,
  remainingPages: readonly CursorPage<T>[] | undefined,
): T[] {
  return mergePrioritizedPublicationPages(
    hasAmbiguous ? ambiguousPages : undefined,
    remainingPages,
  );
}
