import type { HeatmapCell } from '../../api/schemas';
import { fr } from '../../i18n/fr';
import type { ChartOption } from '../../ui/chart/echartsCore';
import { BASE_OPTION } from '../shared/chartStyle';

const HOURS = Array.from({ length: 24 }, (_unused, hour) => hour);

/** Hours across, weekdays down (Monday on top), colour by incidents opened in that slot. */
export function heatmapOption(cells: readonly HeatmapCell[]): ChartOption {
  const { charts } = fr.overview;
  const maxCount = Math.max(1, ...cells.map((cell) => cell.count));
  return {
    ...BASE_OPTION,
    grid: { left: 48, right: 16, top: 8, bottom: 96 },
    tooltip: { position: 'top' },
    xAxis: {
      type: 'category',
      data: HOURS.map((hour) => charts.hour(hour)),
      splitArea: { show: true },
    },
    yAxis: { type: 'category', data: [...charts.weekdays], inverse: true, splitArea: { show: true } },
    visualMap: {
      type: 'continuous',
      min: 0,
      max: maxCount,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 240,
      inRange: { color: ['rgba(79, 124, 255, 0.08)', '#7d9cff', '#4f7cff', '#e5484d'] },
    },
    series: [
      {
        type: 'heatmap',
        name: charts.incidentCount,
        data: cells.map((cell) => [cell.hour, cell.weekday, cell.count]),
        itemStyle: { borderRadius: 3, borderWidth: 2, borderColor: 'transparent' },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0, 0, 0, 0.3)' } },
      },
    ],
  };
}

/** The busiest slots first, for the text summary of the heatmap. */
export function busiestSlots(cells: readonly HeatmapCell[], limit: number): HeatmapCell[] {
  return cells.toSorted((left, right) => right.count - left.count).slice(0, limit);
}
