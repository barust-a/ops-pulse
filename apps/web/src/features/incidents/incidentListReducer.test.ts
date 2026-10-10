import { describe, expect, it } from 'vitest';

import { incidentListReducer, initialIncidentList } from './incidentListReducer';

describe('incidentListReducer', () => {
  it('starts unfiltered, most recent first', () => {
    expect(initialIncidentList).toEqual({ state: null, q: '', sort: '-openedAt' });
  });

  it('flips the direction of the sorted column, and starts another column descending', () => {
    const ascending = incidentListReducer(initialIncidentList, { type: 'sortToggled', field: 'openedAt' });
    const byPriority = incidentListReducer(ascending, { type: 'sortToggled', field: 'priority' });

    expect(ascending.sort).toBe('openedAt');
    expect(byPriority.sort).toBe('-priority');
  });

  it('sets the state filter and the trimmed search text', () => {
    const filtered = incidentListReducer(initialIncidentList, { type: 'stateChanged', state: 'new' });
    const searched = incidentListReducer(filtered, { type: 'searched', q: '  vpn ' });

    expect(searched).toEqual({ state: 'new', q: 'vpn', sort: '-openedAt' });
  });
});
