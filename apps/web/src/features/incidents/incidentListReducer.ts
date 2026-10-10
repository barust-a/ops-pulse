import type { IncidentSort, IncidentSortField } from '../../api/endpoints';
import type { IncidentState } from '../../api/schemas';

/** The incident-list controls local to the page (period, service and priority are global). */
export interface IncidentListState {
  readonly state: IncidentState | null;
  readonly q: string;
  readonly sort: IncidentSort;
}

export type IncidentListAction =
  | { readonly type: 'stateChanged'; readonly state: IncidentState | null }
  | { readonly type: 'searched'; readonly q: string }
  | { readonly type: 'sortToggled'; readonly field: IncidentSortField };

export const initialIncidentList: IncidentListState = { state: null, q: '', sort: '-openedAt' };

/** Clicking the sorted column flips its direction; another column starts descending. */
function toggledSort(current: IncidentSort, field: IncidentSortField): IncidentSort {
  if (current === `-${field}`) return field;
  return `-${field}`;
}

export function incidentListReducer(
  list: IncidentListState,
  action: IncidentListAction,
): IncidentListState {
  switch (action.type) {
    case 'stateChanged': {
      return { ...list, state: action.state };
    }
    case 'searched': {
      return { ...list, q: action.q.trim() };
    }
    case 'sortToggled': {
      return { ...list, sort: toggledSort(list.sort, action.field) };
    }
  }
}
