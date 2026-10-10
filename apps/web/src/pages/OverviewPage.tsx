import { OverviewDashboard } from '../features/overview/OverviewDashboard';
import { GlobalFilters } from '../features/shared/GlobalFilters';
import { fr } from '../i18n/fr';
import { PageHeader } from '../ui/PageHeader';

export function OverviewPage() {
  return (
    <>
      <PageHeader title={fr.overview.title} subtitle={fr.overview.subtitle} />
      <section className="filter-bar" aria-label={fr.filters.label}>
        <GlobalFilters />
      </section>
      <OverviewDashboard />
    </>
  );
}
