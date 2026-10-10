import { describe, expect, it } from 'vitest';

import { resolveDateRange } from './date-range.js';

const NOW = new Date('2026-10-10T15:30:00.000Z');

describe('resolveDateRange', () => {
  it('defaults to the last 30 days, today included', () => {
    expect(resolveDateRange({}, NOW)).toEqual({ from: '2026-09-11', to: '2026-10-10' });
  });

  it('keeps both bounds when given', () => {
    expect(resolveDateRange({ from: '2026-01-01', to: '2026-01-31' }, NOW)).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
    });
  });

  it('counts 30 days back from an explicit end date', () => {
    expect(resolveDateRange({ to: '2026-03-31' }, NOW)).toEqual({
      from: '2026-03-02',
      to: '2026-03-31',
    });
  });

  it('runs an explicit start date up to today', () => {
    expect(resolveDateRange({ from: '2026-10-01' }, NOW)).toEqual({
      from: '2026-10-01',
      to: '2026-10-10',
    });
  });
});
