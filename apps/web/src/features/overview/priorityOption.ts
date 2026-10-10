import type { PriorityKpi } from '../../api/schemas';
import { formatDecimal, formatPercent } from '../../i18n/format';
import { fr } from '../../i18n/fr';
import type { ChartOption } from '../../ui/chart/echartsCore';
import { BASE_OPTION, STATUS_COLORS } from '../shared/chartStyle';

function toHours(minutes: number | null): number | null {
  return minutes === null ? null : Math.round((minutes / 60) * 10) / 10;
}

function hoursLabel(value: unknown): string {
  return typeof value === 'number' ? `${formatDecimal(value)} h` : '—';
}

function percentLabel(value: unknown): string {
  return typeof value === 'number' ? formatPercent(value / 100) : '—';
}

/** MTTR as bars on the left axis, SLA breach rate as a line on the right axis, P1 → P4. */
export function priorityOption(items: readonly PriorityKpi[]): ChartOption {
  const sorted = items.toSorted((left, right) => left.priority - right.priority);
  const { charts } = fr.overview;
  return {
    ...BASE_OPTION,
    grid: { left: 48, right: 56, top: 48, bottom: 32 },
    legend: { top: 0 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: sorted.map((item) => fr.priority.short(item.priority)) },
    yAxis: [
      { type: 'value', name: charts.mttrHours, axisLabel: { formatter: '{value} h' } },
      {
        type: 'value',
        name: charts.slaBreach,
        min: 0,
        max: 100,
        axisLabel: { formatter: '{value} %' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        type: 'bar',
        name: charts.mttrHours,
        barMaxWidth: 36,
        color: STATUS_COLORS.accent,
        itemStyle: { borderRadius: [6, 6, 0, 0] },
        tooltip: { valueFormatter: hoursLabel },
        data: sorted.map((item) => toHours(item.mttrMinutes)),
      },
      {
        type: 'line',
        name: charts.slaBreach,
        yAxisIndex: 1,
        smooth: true,
        symbolSize: 8,
        color: STATUS_COLORS.critical,
        tooltip: { valueFormatter: percentLabel },
        data: sorted.map((item) => Math.round(item.slaBreachRate * 1000) / 10),
      },
    ],
  };
}
