import { createContext, use, useReducer, useState, type Dispatch, type ReactNode } from 'react';

import type { DateRange } from '../../api/endpoints';
import { rangeEndingOn } from './dateRange';
import { filtersReducer, initialFilters, type FiltersAction, type FiltersState } from './filtersReducer';

interface FiltersContextValue {
  readonly filters: FiltersState;
  readonly range: DateRange;
  readonly dispatch: Dispatch<FiltersAction>;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

interface FiltersProviderProps {
  readonly children: ReactNode;
  /** Injected so tests pin "today"; the range is anchored on the day the app opened. */
  readonly clock?: () => Date;
}

function systemClock(): Date {
  return new Date();
}

export function FiltersProvider({ children, clock = systemClock }: FiltersProviderProps) {
  const [filters, dispatch] = useReducer(filtersReducer, initialFilters);
  const [today] = useState(clock);
  const range = rangeEndingOn(today, filters.rangeDays);
  return <FiltersContext value={{ filters, range, dispatch }}>{children}</FiltersContext>;
}

export function useFilters(): FiltersContextValue {
  const value = use(FiltersContext);
  if (value === null) throw new Error('useFilters must be used inside <FiltersProvider>');
  return value;
}
