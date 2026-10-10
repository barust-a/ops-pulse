import { describe, expect, it } from 'vitest';

import { dailyKpi, heatmap, priorityKpis } from '../../test/fixtures';
import { changeFailureByService } from './changeFailureOption';
import { busiestSlots, heatmapOption } from './heatmapOption';
import { priorityOption } from './priorityOption';

describe('changeFailureByService', () => {
  it('weights each day by its change count, worst service first', () => {
    const rates = changeFailureByService([
      dailyKpi({ service: 'crm', day: '2026-10-08', changeCount: 1, changeFailureRate: 1 }),
      dailyKpi({ service: 'crm', day: '2026-10-09', changeCount: 9, changeFailureRate: 0 }),
      dailyKpi({ service: 'network', day: '2026-10-09', changeCount: 4, changeFailureRate: 0.5 }),
    ]);

    expect(rates).toEqual([
      { service: 'network', changeCount: 4, failureRate: 0.5 },
      { service: 'crm', changeCount: 10, failureRate: 0.1 },
    ]);
  });

  it('reports 0 % for a service without changes', () => {
    const [rate] = changeFailureByService([dailyKpi({ changeCount: 0, changeFailureRate: 0 })]);

    expect(rate?.failureRate).toBe(0);
  });
});

describe('priorityOption', () => {
  it('plots MTTR in hours and the SLA breach rate in percent on the second axis', () => {
    const option = priorityOption(priorityKpis.toReversed());
    const series = Array.isArray(option.series) ? option.series : [];

    expect(series[0]).toMatchObject({ type: 'bar', data: [1.6, 2.7, 5, null] });
    expect(series[1]).toMatchObject({ type: 'line', yAxisIndex: 1, data: [33, 17, 10, 5] });
  });
});

describe('heatmapOption', () => {
  it('maps cells to [hour, weekday, count] and scales the colour to the busiest slot', () => {
    const option = heatmapOption(heatmap);
    const series = Array.isArray(option.series) ? option.series : [];
    const visualMap = Array.isArray(option.visualMap) ? option.visualMap[0] : option.visualMap;

    expect(series[0]).toMatchObject({ type: 'heatmap', data: [[9, 0, 14], [17, 4, 9]] });
    expect(visualMap).toMatchObject({ max: 14 });
  });

  it('lists the busiest slots first', () => {
    expect(busiestSlots(heatmap, 1)).toEqual([{ weekday: 0, hour: 9, count: 14 }]);
  });
});
