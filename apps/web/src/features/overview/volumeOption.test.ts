import { describe, expect, it } from 'vitest';

import { dailyKpi, dailyKpis } from '../../test/fixtures';
import { volumeModel, volumeOption } from './volumeOption';

describe('volumeModel', () => {
  it('aligns one series per service on the sorted days, in the contract service order', () => {
    const model = volumeModel(dailyKpis);

    expect(model.days).toEqual(['2026-10-08', '2026-10-09']);
    expect(model.series.map((series) => series.service)).toEqual(['payments', 'crm']);
    expect(model.series[0]?.counts).toEqual([9, 31]);
  });

  it('counts a missing day as zero', () => {
    const model = volumeModel([
      dailyKpi({ day: '2026-10-08', service: 'crm', incidentCount: 3 }),
      dailyKpi({ day: '2026-10-09', service: 'payments', incidentCount: 5 }),
    ]);

    expect(model.series.find((series) => series.service === 'crm')?.counts).toEqual([3, 0]);
  });

  it('keeps the anomalies flagged by Dataiku', () => {
    const model = volumeModel(dailyKpis);

    expect(model.series[0]?.anomalies.map((kpi) => kpi.day)).toEqual(['2026-10-09']);
    expect(model.series[1]?.anomalies).toEqual([]);
  });
});

describe('volumeOption', () => {
  it('marks each anomaly on its day and count', () => {
    const option = volumeOption(volumeModel(dailyKpis));
    const series = Array.isArray(option.series) ? option.series : [];

    expect(series[0]).toMatchObject({
      type: 'line',
      name: 'payments',
      markPoint: { data: [{ name: 'Anomalie', value: 31 }] },
    });
  });

  it('shows the z-score in the tooltip', () => {
    const option = volumeOption(volumeModel(dailyKpis));
    const tooltip = Array.isArray(option.tooltip) ? option.tooltip[0] : option.tooltip;
    const formatter = tooltip?.formatter;
    if (typeof formatter !== 'function') throw new Error('expected a tooltip formatter');

    const hovered = {
      componentType: 'series',
      componentSubType: 'line',
      componentIndex: 0,
      seriesIndex: 0,
      name: '',
      dataIndex: 1,
      data: 31,
      value: 31,
      $vars: [],
    };

    const html = formatter([hovered], '');

    expect(html).toContain('payments : <b>31</b> · z-score 3,4');
  });
});
