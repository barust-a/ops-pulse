import { fr } from '../../i18n/fr';
import { describeError } from '../../state/describeError';
import type { QueryResult } from '../../state/useApiQuery';
import { ErrorState, Skeleton } from '../../ui/StatusViews';

interface QueryFallbackProps {
  readonly result: QueryResult<unknown>;
  readonly heightPx: number;
}

/** What a panel shows until its data is there: a skeleton, or the error with "Réessayer". */
export function QueryFallback({ result, heightPx }: QueryFallbackProps) {
  if (result.status === 'loading') return <Skeleton label={fr.status.loading} heightPx={heightPx} />;
  if (result.status === 'error') {
    return (
      <ErrorState
        title={fr.status.errorTitle}
        message={describeError(result.error)}
        retryLabel={fr.status.retry}
        onRetry={result.reload}
      />
    );
  }
  return null;
}
