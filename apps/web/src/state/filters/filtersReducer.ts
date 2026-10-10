import type { Priority } from '../../api/schemas';
import type { RangePreset } from './dateRange';

/** Filters shared by every page: changing them on one page keeps them on the next. */
export interface FiltersState {
  readonly rangeDays: RangePreset;
  readonly service: string | null;
  readonly priority: Priority | null;
}

export type FiltersAction =
  | { readonly type: 'rangeChanged'; readonly rangeDays: RangePreset }
  | { readonly type: 'serviceChanged'; readonly service: string | null }
  | { readonly type: 'priorityChanged'; readonly priority: Priority | null }
  | { readonly type: 'reset' };

export const initialFilters: FiltersState = { rangeDays: 30, service: null, priority: null };

export function filtersReducer(state: FiltersState, action: FiltersAction): FiltersState {
  switch (action.type) {
    case 'rangeChanged': {
      return { ...state, rangeDays: action.rangeDays };
    }
    case 'serviceChanged': {
      return { ...state, service: action.service };
    }
    case 'priorityChanged': {
      return { ...state, priority: action.priority };
    }
    case 'reset': {
      return initialFilters;
    }
  }
}
