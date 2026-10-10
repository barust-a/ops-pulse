import { describe, expect, it } from 'vitest';

import type { DailyKpi } from './kpi.js';
import { summarizeDailyKpis } from './kpi.js';

function day(overrides: Partial<DailyKpi>): DailyKpi {
  return {
    day: '2026-10-01',
    service: 'payments',
    incidentCount: 0,
    resolvedCount: 0,
    mttrMinutes: null,
    p90ResolutionMinutes: null,
    slaBreachRate: 0,
    changeCount: 0,
    changeFailureRate: 0,
    incidentZscore: null,
    isAnomaly: false,
    ...overrides,
  };
}

const LIVE = { openIncidents: 0, p90ResolutionMinutes: null };

describe('summarizeDailyKpis', () => {
  it('returns zeros for an empty range, with the live open-incident count', () => {
    expect(summarizeDailyKpis([], { openIncidents: 7, p90ResolutionMinutes: null })).toEqual({
      openIncidents: 7,
      mttrMinutes: 0,
      p90ResolutionMinutes: 0,
      slaBreachRate: 0,
      changeFailureRate: 0,
      anomalies: 0,
    });
  });

  it('weights MTTR by resolved incidents, not by day', () => {
    const rows = [
      day({ resolvedCount: 1, mttrMinutes: 100 }),
      day({ resolvedCount: 3, mttrMinutes: 20 }),
    ];
    // (1 × 100 + 3 × 20) / 4 = 40, where an average of averages would give 60.
    expect(summarizeDailyKpis(rows, LIVE).mttrMinutes).toBe(40);
  });

  it('weights the SLA breach rate by incidents resolved, its denominator', () => {
    const rows = [
      day({ resolvedCount: 10, incidentCount: 99, slaBreachRate: 0.5 }),
      day({ resolvedCount: 30, incidentCount: 1, slaBreachRate: 0.1 }),
    ];
    expect(summarizeDailyKpis(rows, LIVE).slaBreachRate).toBeCloseTo(0.2, 10);
  });

  it('weights the change failure rate by changes', () => {
    const rows = [
      day({ changeCount: 1, changeFailureRate: 1 }),
      day({ changeCount: 9, changeFailureRate: 0 }),
    ];
    expect(summarizeDailyKpis(rows, LIVE).changeFailureRate).toBeCloseTo(0.1, 10);
  });

  it('takes the p90 computed live over the whole range, never from the daily p90s', () => {
    const rows = [day({ resolvedCount: 1, p90ResolutionMinutes: 400 })];
    const live = { openIncidents: 0, p90ResolutionMinutes: 123.456 };
    expect(summarizeDailyKpis(rows, live).p90ResolutionMinutes).toBeCloseTo(123.46, 10);
  });

  it('skips days without resolutions in the MTTR weights', () => {
    const rows = [
      day({ resolvedCount: 0, mttrMinutes: null }),
      day({ resolvedCount: 2, mttrMinutes: 50 }),
    ];
    expect(summarizeDailyKpis(rows, LIVE).mttrMinutes).toBe(50);
  });

  it('counts the anomalous service-days', () => {
    const rows = [day({ isAnomaly: true }), day({ isAnomaly: false }), day({ isAnomaly: true })];
    expect(summarizeDailyKpis(rows, LIVE).anomalies).toBe(2);
  });

  it('rounds minutes to two decimals and rates to four', () => {
    const rows = [
      day({ resolvedCount: 3, mttrMinutes: 10, slaBreachRate: 0.3333 }),
      day({ resolvedCount: 3, mttrMinutes: 11, slaBreachRate: 0.6667 }),
      day({ resolvedCount: 3, mttrMinutes: 11, slaBreachRate: 0.5 }),
    ];
    const summary = summarizeDailyKpis(rows, LIVE);
    expect(summary.mttrMinutes).toBeCloseTo(10.67, 10);
    expect(summary.slaBreachRate).toBeCloseTo(0.5, 10);
  });
});
