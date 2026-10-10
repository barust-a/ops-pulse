import { useState } from 'react';

/**
 * The current page of a server-paginated list. `scope` identifies every filter and sort the list
 * depends on: when it changes, the list restarts at page 1 without an effect or a reset action.
 */
export function useScopedPage(scope: string): readonly [number, (page: number) => void] {
  const [selection, setSelection] = useState({ page: 1, scope });
  const page = selection.scope === scope ? selection.page : 1;
  function setPage(next: number): void {
    setSelection({ page: next, scope });
  }
  return [page, setPage];
}
