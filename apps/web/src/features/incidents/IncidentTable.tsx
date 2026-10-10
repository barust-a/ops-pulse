import type { IncidentSort, IncidentSortField } from '../../api/endpoints';
import type { Incident } from '../../api/schemas';
import { formatDateTime } from '../../i18n/format';
import { fr } from '../../i18n/fr';
import { IncidentStateBadge, PriorityBadge, SlaBadge } from '../shared/Badges';

const { columns } = fr.incidents;

interface SortHeaderProps {
  readonly field: IncidentSortField;
  readonly label: string;
  readonly sort: IncidentSort;
  readonly onSort: (field: IncidentSortField) => void;
}

function ariaSort(sort: IncidentSort, field: IncidentSortField): 'ascending' | 'descending' | 'none' {
  if (sort === field) return 'ascending';
  if (sort === `-${field}`) return 'descending';
  return 'none';
}

/** A column header that sorts the list server-side, with its direction announced. */
function SortHeader({ field, label, sort, onSort }: SortHeaderProps) {
  const direction = ariaSort(sort, field);
  const arrows = { ascending: '↑', descending: '↓', none: '↕' } as const;
  return (
    <th scope="col" aria-sort={direction}>
      <button
        type="button"
        className="sort-button"
        aria-label={fr.incidents.sortBy(label)}
        onClick={() => {
          onSort(field);
        }}
      >
        {label}
        <span className="sort-button__arrow" aria-hidden="true">
          {arrows[direction]}
        </span>
      </button>
    </th>
  );
}

interface IncidentTableProps {
  readonly incidents: readonly Incident[];
  readonly sort: IncidentSort;
  readonly selectedNumber: string | null;
  readonly onSort: (field: IncidentSortField) => void;
  readonly onSelect: (incident: Incident) => void;
}

/** "Liste des incidents": one row per incident; a click (or the number button) opens it. */
export function IncidentTable({ incidents, sort, selectedNumber, onSort, onSelect }: IncidentTableProps) {
  if (incidents.length === 0) return <p className="table-empty">{fr.incidents.empty}</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="visually-hidden">{fr.incidents.tableCaption}</caption>
        <thead>
          <tr>
            <SortHeader field="number" label={columns.number} sort={sort} onSort={onSort} />
            <th scope="col">{columns.shortDescription}</th>
            <SortHeader field="priority" label={columns.priority} sort={sort} onSort={onSort} />
            <th scope="col">{columns.state}</th>
            <th scope="col">{columns.service}</th>
            <SortHeader field="openedAt" label={columns.openedAt} sort={sort} onSort={onSort} />
            <th scope="col">{columns.sla}</th>
          </tr>
        </thead>
        <tbody>
          {incidents.map((incident) => (
            <tr
              key={incident.number}
              className={incident.number === selectedNumber ? 'is-selected' : undefined}
              onClick={() => {
                onSelect(incident);
              }}
            >
              <td>
                <button
                  type="button"
                  className="link-button mono"
                  aria-pressed={incident.number === selectedNumber}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(incident);
                  }}
                >
                  {incident.number}
                </button>
              </td>
              <td className="cell-description">{incident.shortDescription}</td>
              <td>
                <PriorityBadge priority={incident.priority} />
              </td>
              <td>
                <IncidentStateBadge state={incident.state} />
              </td>
              <td>{incident.service}</td>
              <td className="nowrap">{formatDateTime(incident.openedAt)}</td>
              <td>
                <SlaBadge breached={incident.slaBreached} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
