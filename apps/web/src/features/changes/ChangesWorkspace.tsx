import { useState } from 'react';

import { fetchChanges, type ChangeQuery } from '../../api/endpoints';
import {
  CHANGE_STATES,
  CHANGE_TYPES,
  ChangeStateSchema,
  ChangeTypeSchema,
  type ChangePage,
  type ChangeState,
  type ChangeType,
} from '../../api/schemas';
import { fr } from '../../i18n/fr';
import { useApiClient } from '../../state/auth/AuthContext';
import { useFilters } from '../../state/filters/FiltersContext';
import { useApiQuery, type QueryResult } from '../../state/useApiQuery';
import { PageHeader } from '../../ui/PageHeader';
import { Pagination } from '../../ui/Pagination';
import { SelectField } from '../../ui/SelectField';
import { GlobalFilters } from '../shared/GlobalFilters';
import { QueryFallback } from '../shared/QueryFallback';
import { useScopedPage } from '../shared/useScopedPage';
import { ChangeTable } from './ChangeTable';
import { CloseCodeCard } from './CloseCodeCard';

const PAGE_SIZE = 25;
const STATE_OPTIONS = CHANGE_STATES.map((state) => ({ value: state, label: fr.changeState[state] }));
const TYPE_OPTIONS = CHANGE_TYPES.map((type) => ({ value: type, label: fr.changeType[type] }));

function useChangePage(query: ChangeQuery) {
  const client = useApiClient();
  return useApiQuery(JSON.stringify(query), (signal) => fetchChanges(client, query, signal));
}

interface ChangeListBodyProps {
  readonly result: QueryResult<ChangePage>;
  readonly onPageChange: (page: number) => void;
}

/** The list card: a skeleton, the error panel, or the table and its pagination. */
function ChangeListBody({ result, onPageChange }: ChangeListBodyProps) {
  if (result.status !== 'success') return <QueryFallback result={result} heightPx={420} />;
  return (
    <>
      <ChangeTable changes={result.data.items} />
      <Pagination
        page={result.data.page}
        pageSize={result.data.pageSize}
        total={result.data.total}
        onPageChange={onPageChange}
      />
    </>
  );
}

/** The "Changements" page body: filters, close-code chart and the paginated table. */
export function ChangesWorkspace() {
  const { filters, range } = useFilters();
  const [state, setState] = useState<ChangeState | null>(null);
  const [type, setType] = useState<ChangeType | null>(null);
  const listQuery = { ...range, service: filters.service, state, type };
  const [page, setPage] = useScopedPage(JSON.stringify(listQuery));
  const result = useChangePage({ ...listQuery, page, pageSize: PAGE_SIZE });

  return (
    <>
      <PageHeader title={fr.changes.title} subtitle={fr.changes.subtitle} />
      <section className="filter-bar" aria-label={fr.filters.label}>
        <GlobalFilters />
        <SelectField
          label={fr.filters.state}
          value={state ?? ''}
          emptyLabel={fr.filters.all}
          options={STATE_OPTIONS}
          onChange={(value) => {
            const parsed = ChangeStateSchema.safeParse(value);
            setState(parsed.success ? parsed.data : null);
          }}
        />
        <SelectField
          label={fr.filters.type}
          value={type ?? ''}
          emptyLabel={fr.filters.all}
          options={TYPE_OPTIONS}
          onChange={(value) => {
            const parsed = ChangeTypeSchema.safeParse(value);
            setType(parsed.success ? parsed.data : null);
          }}
        />
      </section>
      <CloseCodeCard range={range} service={filters.service} />
      <div className="card workspace__list">
        <ChangeListBody result={result} onPageChange={setPage} />
      </div>
    </>
  );
}
