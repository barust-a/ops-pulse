import { formatDay, formatDuration, formatInteger, formatPercent } from '../../i18n/format';
import { fr } from '../../i18n/fr';
import { Card } from '../../ui/Card';
import { DataSummaryTable } from '../../ui/chart/DataSummaryTable';
import { EChart } from '../../ui/chart/EChart';
import { changeFailureByService, changeFailureOption } from './changeFailureOption';
import { busiestSlots, heatmapOption } from './heatmapOption';
import { priorityOption } from './priorityOption';
import type { OverviewData } from './useOverviewData';
import { volumeModel, volumeOption } from './volumeOption';

const { charts } = fr.overview;

/** "Volume quotidien d’incidents par service": one line per service, anomaly pins. */
function VolumeCard({ data }: { readonly data: OverviewData }) {
  const model = volumeModel(data.daily);
  const rows = model.series.map((series) => {
    const peakIndex = series.counts.indexOf(Math.max(...series.counts));
    const peakDay = model.days[peakIndex];
    return [
      series.service,
      formatInteger(series.counts.reduce((sum, count) => sum + count, 0)),
      peakDay === undefined ? '—' : formatDay(peakDay),
      formatInteger(series.anomalies.length),
    ];
  });
  return (
    <Card title={charts.volumeTitle} className="card--wide">
      <EChart
        option={volumeOption(model)}
        ariaLabel={charts.volumeAria}
        heightPx={320}
        summary={
          <DataSummaryTable
            caption={charts.volumeSummary}
            columns={[charts.service, charts.total, charts.day, charts.anomaly]}
            rows={rows}
          />
        }
      />
    </Card>
  );
}

/** "MTTR et dépassement SLA par priorité": bars and a line on two axes. */
function PriorityCard({ data }: { readonly data: OverviewData }) {
  const rows = data.byPriority.map((item) => [
    fr.priority.short(item.priority),
    formatInteger(item.count),
    formatDuration(item.mttrMinutes),
    formatPercent(item.slaBreachRate),
  ]);
  return (
    <Card title={charts.priorityTitle}>
      <EChart
        option={priorityOption(data.byPriority)}
        ariaLabel={charts.priorityAria}
        summary={
          <DataSummaryTable
            caption={charts.prioritySummary}
            columns={[fr.filters.priority, charts.incidentCount, fr.overview.tiles.mttr, charts.slaBreach]}
            rows={rows}
          />
        }
      />
    </Card>
  );
}

/** "Taux d’échec des changements par service": horizontal bars, worst first. */
function ChangeFailureCard({ data }: { readonly data: OverviewData }) {
  const rates = changeFailureByService(data.daily);
  const rows = rates.map((rate) => [
    rate.service,
    formatInteger(rate.changeCount),
    formatPercent(rate.failureRate),
  ]);
  return (
    <Card title={charts.changeFailureTitle}>
      <EChart
        option={changeFailureOption(rates)}
        ariaLabel={charts.changeFailureAria}
        summary={
          <DataSummaryTable
            caption={charts.changeFailureSummary}
            columns={[charts.service, charts.changes, fr.overview.tiles.changeFailureRate]}
            rows={rows}
          />
        }
      />
    </Card>
  );
}

/** "Ouvertures d’incidents par jour et heure": weekday × hour heatmap. */
function HeatmapCard({ data }: { readonly data: OverviewData }) {
  const rows = busiestSlots(data.heatmap, 5).map((cell) => [
    `${charts.weekdays[cell.weekday] ?? ''} ${charts.hour(cell.hour)}`,
    formatInteger(cell.count),
  ]);
  return (
    <Card title={charts.heatmapTitle} className="card--wide">
      <EChart
        option={heatmapOption(data.heatmap)}
        ariaLabel={charts.heatmapAria}
        heightPx={340}
        summary={
          <DataSummaryTable
            caption={charts.heatmapSummary}
            columns={[charts.slot, charts.incidentCount]}
            rows={rows}
          />
        }
      />
    </Card>
  );
}

/** The four overview charts in a responsive grid. */
export function OverviewCharts({ data }: { readonly data: OverviewData }) {
  return (
    <div className="chart-grid">
      <VolumeCard data={data} />
      <PriorityCard data={data} />
      <ChangeFailureCard data={data} />
      <HeatmapCard data={data} />
    </div>
  );
}
