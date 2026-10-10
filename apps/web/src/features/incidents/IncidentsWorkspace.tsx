import { useReducer, useState } from 'react';

import {
  fetchIncidents,
  type IncidentQuery,
  type IncidentSort,
  type IncidentSortField,
} from '../../api/endpoints';
import type { Incident, IncidentPage } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import { useApiClient, useCurrentUser } from '../../state/auth/AuthContext';
import { canEditIncidents } from '../../state/auth/permissions';
import { useFilters } from '../../state/filters/FiltersContext';
import { useApiQuery, type QueryResult } from '../../state/useApiQuery';
import { PageHeader } from '../../ui/PageHeader';
import { Pagination } from '../../ui/Pagination';
import { QueryFallback } from '../shared/QueryFallback';
import { useScopedPage } from '../shared/useScopedPage';
import { IncidentDetailPanel } from './IncidentDetailPanel';
import { IncidentFilters } from './IncidentFilters';
import { incidentListReducer, initialIncidentList } from './incidentListReducer';
import { IncidentTable } from './IncidentTable';
import { NewIncidentForm } from './NewIncidentForm';

const PAGE_SIZE = 25;

type SidePanelState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'detail'; readonly incident: Incident }
  | { readonly kind: 'create' };

function useIncidentPage(query: IncidentQuery) {
  const client = useApiClient();
  return useApiQuery(JSON.stringify(query), (signal) => fetchIncidents(client, query, signal));
}

interface IncidentListBodyProps {
  readonly result: QueryResult<IncidentPage>;
  readonly sort: IncidentSort;
  readonly selectedNumber: string | null;
  readonly onSort: (field: IncidentSortField) => void;
  readonly onSelect: (incident: Incident) => void;
  readonly onPageChange: (page: number) => void;
}

/** The list card: a skeleton, the error panel with "Réessayer", or the table and its pagination. */
function IncidentListBody({ result, onPageChange, ...table }: IncidentListBodyProps) {
  if (result.status !== 'success') return <QueryFallback result={result} heightPx={420} />;
  return (
    <>
      <IncidentTable incidents={result.data.items} {...table} />
      <Pagination
        page={result.data.page}
        pageSize={result.data.pageSize}
        total={result.data.total}
        onPageChange={onPageChange}
      />
    </>
  );
}

/** The "Incidents" page body: header, filters, server-paginated table and the side panel. */
export function IncidentsWorkspace() {
  const user = useCurrentUser();
  const canEdit = canEditIncidents(user.role);
  const { filters, range } = useFilters();
  const [list, dispatch] = useReducer(incidentListReducer, initialIncidentList);
  const [panel, setPanel] = useState<SidePanelState>({ kind: 'closed' });
  const [notice, setNotice] = useState<string | null>(null);
  const listQuery = { ...range, service: filters.service, priority: filters.priority, ...list };
  const [page, setPage] = useScopedPage(JSON.stringify(listQuery));
  const result = useIncidentPage({ ...listQuery, page, pageSize: PAGE_SIZE });

  function handleCreated(incident: Incident): void {
    setNotice(fr.incidents.form.created(incident.number));
    setPanel({ kind: 'detail', incident });
    result.reload();
  }

  function handleUpdated(incident: Incident): void {
    setNotice(fr.incidents.detail.updated);
    setPanel({ kind: 'detail', incident });
    result.reload();
  }

  function closePanel(): void {
    setPanel({ kind: 'closed' });
  }

  return (
    <>
      <PageHeader
        title={fr.incidents.title}
        subtitle={fr.incidents.subtitle}
        actions={
          canEdit ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                setPanel({ kind: 'create' });
              }}
            >
              {fr.incidents.newIncident}
            </button>
          ) : null
        }
      />
      <IncidentFilters
        state={list.state}
        q={list.q}
        onStateChange={(state) => {
          dispatch({ type: 'stateChanged', state });
        }}
        onSearch={(q) => {
          dispatch({ type: 'searched', q });
        }}
      />
      <p className="notice" role="status">
        {notice}
      </p>
      <div className={panel.kind === 'closed' ? 'workspace' : 'workspace workspace--with-panel'}>
        <div className="card workspace__list">
          <IncidentListBody
            result={result}
            sort={list.sort}
            selectedNumber={panel.kind === 'detail' ? panel.incident.number : null}
            onSort={(field) => {
              dispatch({ type: 'sortToggled', field });
            }}
            onSelect={(incident) => {
              setPanel({ kind: 'detail', incident });
            }}
            onPageChange={setPage}
          />
        </div>
        {panel.kind === 'detail' ? (
          <IncidentDetailPanel
            incident={panel.incident}
            canEdit={canEdit}
            onClose={closePanel}
            onUpdated={handleUpdated}
          />
        ) : null}
        {panel.kind === 'create' ? (
          <NewIncidentForm onCancel={closePanel} onCreated={handleCreated} />
        ) : null}
      </div>
    </>
  );
}
