import type { DailyKpi } from '../../api/schemas';
import { formatPercent } from '../../i18n/format';
import type { ChartOption } from '../../ui/chart/echartsCore';
import { BASE_OPTION, STATUS_COLORS } from '../shared/chartStyle';

export interface ServiceFailureRate {
  readonly service: string;
  readonly changeCount: number;
  readonly failureRate: number;
}

/** Change-weighted failure rate per service, worst first (a day with 10 changes weighs 10×). */
export function changeFailureByService(daily: readonly DailyKpi[]): ServiceFailureRate[] {
  const totals = new Map<string, { changes: number; failures: number }>();
  for (const kpi of daily) {
    const total = totals.get(kpi.service) ?? { changes: 0, failures: 0 };
    total.changes += kpi.changeCount;
    total.failures += kpi.changeCount * kpi.changeFailureRate;
    totals.set(kpi.service, total);
  }
  return [...totals]
    .map(([service, total]) => ({
      service,
      changeCount: total.changes,
      failureRate: total.changes === 0 ? 0 : total.failures / total.changes,
    }))
    .toSorted((left, right) => right.failureRate - left.failureRate);
}

function rateColor(rate: number): string {
  if (rate >= 0.15) return STATUS_COLORS.critical;
  if (rate >= 0.05) return STATUS_COLORS.warning;
  return STATUS_COLORS.good;
}

function rateLabel(value: unknown): string {
  return typeof value === 'number' ? formatPercent(value) : '—';
}

/** Horizontal bars, coloured green / amber / red at the 5 % and 15 % thresholds. */
export function changeFailureOption(rates: readonly ServiceFailureRate[]): ChartOption {
  const ascending = rates.toReversed();
  return {
    ...BASE_OPTION,
    grid: { left: 96, right: 56, top: 8, bottom: 24 },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: rateLabel },
    xAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatPercent(value) } },
    yAxis: { type: 'category', data: ascending.map((rate) => rate.service) },
    series: [
      {
        type: 'bar',
        barMaxWidth: 22,
        label: { show: true, position: 'right', formatter: ({ value }) => rateLabel(value) },
        data: ascending.map((rate) => ({
          value: rate.failureRate,
          itemStyle: { color: rateColor(rate.failureRate), borderRadius: [0, 6, 6, 0] },
        })),
      },
    ],
  };
}
