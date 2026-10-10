import { describe, expect, it } from 'vitest';

import { changeOutcomes } from '../../test/fixtures';
import { closeCodeCounts, closeCodeOption } from './closeCodeOption';

describe('closeCodeCounts', () => {
  it('aligns the counts of each close code on the sorted services, missing pairs counting 0', () => {
    const counts = closeCodeCounts([
      { service: 'network', closeCode: 'successful', count: 7 },
      { service: 'network', closeCode: 'unsuccessful', count: 2 },
      { service: 'crm', closeCode: 'backed_out', count: 1 },
    ]);

    expect(counts).toEqual({
      services: ['crm', 'network'],
      counts: { successful: [0, 7], unsuccessful: [0, 2], backed_out: [1, 0] },
    });
  });

  it('has no service when no change was closed', () => {
    expect(closeCodeCounts([]).services).toEqual([]);
  });
});

describe('closeCodeOption', () => {
  it('stacks one series per close code, with French names', () => {
    const option = closeCodeOption(closeCodeCounts(changeOutcomes));
    const series = Array.isArray(option.series) ? option.series : [];

    expect(series.map((item) => item.name)).toEqual(['Réussi', 'Échec', 'Retour arrière']);
    expect(series.every((item) => item.type === 'bar' && item.stack === 'closeCodes')).toBe(true);
  });
});
