import type { DailyKpi } from '../../api/schemas';
import { SERVICES } from '../../api/schemas';
import { formatDay, formatDecimal, formatInteger } from '../../i18n/format';
import { fr } from '../../i18n/fr';
import type { ChartOption, TooltipParams } from '../../ui/chart/echartsCore';
import { BASE_OPTION, STATUS_COLORS, escapeHtml, serviceColor } from '../shared/chartStyle';

interface ServiceSeries {
  readonly service: string;
  readonly counts: readonly number[];
  readonly zscores: readonly (number | null)[];
  readonly anomalies: readonly DailyKpi[];
}

export interface VolumeModel {
  readonly days: readonly string[];
  readonly series: readonly ServiceSeries[];
}

const SERVICE_RANK = new Map<string, number>(SERVICES.map((service, index) => [service, index]));

/** Contract services in their documented order, unknown ones after them. */
function serviceRank(service: string): number {
  return SERVICE_RANK.get(service) ?? SERVICES.length;
}

function isAnomaly(kpi: DailyKpi | undefined): kpi is DailyKpi {
  return kpi?.isAnomaly === true;
}

/** Daily KPIs pivoted into one aligned series per service (missing days count 0). */
export function volumeModel(daily: readonly DailyKpi[]): VolumeModel {
  const days = [...new Set(daily.map((kpi) => kpi.day))].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const services = [...new Set(daily.map((kpi) => kpi.service))].toSorted(
    (left, right) => serviceRank(left) - serviceRank(right) || left.localeCompare(right),
  );
  const byKey = new Map(daily.map((kpi) => [`${kpi.service}|${kpi.day}`, kpi]));
  const series = services.map((service) => {
    const points = days.map((day) => byKey.get(`${service}|${day}`));
    return {
      service,
      counts: points.map((kpi) => kpi?.incidentCount ?? 0),
      zscores: points.map((kpi) => kpi?.incidentZscore ?? null),
      anomalies: points.filter((kpi) => isAnomaly(kpi)),
    };
  });
  return { days, series };
}

function tooltipLine(model: VolumeModel, point: TooltipParams): string {
  if (Array.isArray(point)) return '';
  const series = model.series[point.seriesIndex ?? -1];
  if (series === undefined) return '';
  const count = series.counts[point.dataIndex] ?? 0;
  const zscore = series.zscores[point.dataIndex] ?? null;
  const zscoreText = zscore === null ? '—' : formatDecimal(zscore);
  const marker = typeof point.marker === 'string' ? point.marker : '';
  return `${marker}${escapeHtml(series.service)} : <b>${formatInteger(count)}</b> · ${fr.overview.charts.zscore} ${zscoreText}`;
}

function volumeTooltip(model: VolumeModel, params: TooltipParams): string {
  const points = Array.isArray(params) ? params : [params];
  const first = points[0];
  const day = first === undefined ? '' : model.days[first.dataIndex];
  const header = day === undefined || day === '' ? '' : `<b>${formatDay(day)}</b><br/>`;
  return header + points.map((point) => tooltipLine(model, point)).join('<br/>');
}

export function volumeOption(model: VolumeModel): ChartOption {
  const dayLabels = model.days.map((day) => formatDay(day));
  return {
    ...BASE_OPTION,
    grid: { left: 40, right: 16, top: 48, bottom: 32 },
    legend: { type: 'scroll', top: 0 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: TooltipParams) => volumeTooltip(model, params),
    },
    xAxis: { type: 'category', boundaryGap: false, data: dayLabels },
    yAxis: { type: 'value', minInterval: 1 },
    series: model.series.map((series) => ({
      type: 'line',
      name: series.service,
      smooth: true,
      showSymbol: false,
      color: serviceColor(series.service),
      data: [...series.counts],
      markPoint: {
        symbol: 'pin',
        symbolSize: 40,
        itemStyle: { color: STATUS_COLORS.critical },
        label: { color: '#fff', fontWeight: 'bold' },
        data: series.anomalies.map((kpi) => ({
          name: fr.overview.charts.anomaly,
          coord: [formatDay(kpi.day), kpi.incidentCount],
          value: kpi.incidentCount,
        })),
      },
    })),
  };
}
