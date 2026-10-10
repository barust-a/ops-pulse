import { fr } from '../../i18n/fr';
import { describeError } from '../../state/describeError';
import { useFilters } from '../../state/filters/FiltersContext';
import { EmptyState, ErrorState, Skeleton } from '../../ui/StatusViews';
import { KpiTiles } from './KpiTiles';
import { OverviewCharts } from './OverviewCharts';
import { useOverviewData } from './useOverviewData';

/** Placeholders shaped like the tiles and charts while the KPIs load. */
function OverviewSkeleton() {
  return (
    <div className="overview-skeleton" aria-busy="true">
      <Skeleton label={fr.status.loading} heightPx={112} />
      <div className="chart-grid">
        <Skeleton label={fr.status.loading} heightPx={360} />
        <Skeleton label={fr.status.loading} heightPx={360} />
      </div>
    </div>
  );
}

/** KPI tiles and charts for the selected period and service, or the matching status panel. */
export function OverviewDashboard() {
  const { filters, range } = useFilters();
  const query = useOverviewData(range, filters.service);

  if (query.status === 'loading') return <OverviewSkeleton />;
  if (query.status === 'error') {
    return (
      <ErrorState
        title={fr.status.errorTitle}
        message={describeError(query.error)}
        retryLabel={fr.status.retry}
        onRetry={query.reload}
      />
    );
  }
  if (query.data.daily.length === 0) {
    return <EmptyState title={fr.overview.emptyTitle} body={fr.overview.emptyBody} />;
  }
  return (
    <>
      <KpiTiles summary={query.data.summary} />
      <OverviewCharts data={query.data} />
    </>
  );
}
