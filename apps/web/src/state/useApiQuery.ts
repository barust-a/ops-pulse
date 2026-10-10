import { useEffect, useEffectEvent, useState } from 'react';

import { toApiError, type ApiError } from '../api/apiError';

type QueryState<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly error: ApiError }
  | { readonly status: 'success'; readonly data: T };

export type QueryResult<T> = QueryState<T> & { readonly reload: () => void };

interface Settled<T> {
  readonly requestKey: string;
  readonly state: QueryState<T>;
}

/**
 * Loads `load` whenever `key` changes, cancelling the previous request so a slow answer for old
 * filters never overwrites a newer one. `key` must change exactly when the request does (build it
 * from the query parameters). Loading is derived, not stored: the state is "loading" until a
 * result for the current key has settled.
 */
export function useApiQuery<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
): QueryResult<T> {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const runLoad = useEffectEvent(load);
  const requestKey = `${key}#${String(attempt)}`;

  useEffect(() => {
    const controller = new AbortController();
    runLoad(controller.signal).then(
      (data) => {
        setSettled({ requestKey, state: { status: 'success', data } });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ requestKey, state: { status: 'error', error: toApiError(error) } });
      },
    );
    return () => {
      controller.abort();
    };
  }, [requestKey]);

  function reload(): void {
    setAttempt((previous) => previous + 1);
  }

  if (settled?.requestKey !== requestKey) return { status: 'loading', reload };
  return { ...settled.state, reload };
}
