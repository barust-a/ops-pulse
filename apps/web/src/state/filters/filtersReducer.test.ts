import { describe, expect, it } from 'vitest';

import { filtersReducer, initialFilters } from './filtersReducer';

describe('filtersReducer', () => {
  it('defaults to the last 30 days, every service and priority', () => {
    expect(initialFilters).toEqual({ rangeDays: 30, service: null, priority: null });
  });

  it('changes one filter and keeps the others', () => {
    const withService = filtersReducer(initialFilters, { type: 'serviceChanged', service: 'crm' });
    const withRange = filtersReducer(withService, { type: 'rangeChanged', rangeDays: 7 });

    expect(withRange).toEqual({ rangeDays: 7, service: 'crm', priority: null });
  });

  it('sets and clears the priority', () => {
    const set = filtersReducer(initialFilters, { type: 'priorityChanged', priority: 1 });
    expect(set.priority).toBe(1);
    expect(filtersReducer(set, { type: 'priorityChanged', priority: null }).priority).toBeNull();
  });

  it('resets to the defaults without mutating the previous state', () => {
    const state = { rangeDays: 90, service: 'crm', priority: 2 } as const;

    expect(filtersReducer(state, { type: 'reset' })).toEqual(initialFilters);
    expect(state).toEqual({ rangeDays: 90, service: 'crm', priority: 2 });
  });
});
