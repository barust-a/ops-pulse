import {
  fetchDailyKpis,
  fetchHeatmap,
  fetchKpiSummary,
  fetchPriorityKpis,
  type DateRange,
} from '../../api/endpoints';
import type { DailyKpi, HeatmapCell, KpiSummary, PriorityKpi } from '../../api/schemas';
import { useApiClient } from '../../state/auth/AuthContext';
import { useApiQuery } from '../../state/useApiQuery';

export interface OverviewData {
  readonly summary: KpiSummary;
  readonly daily: readonly DailyKpi[];
  readonly byPriority: readonly PriorityKpi[];
  readonly heatmap: readonly HeatmapCell[];
}

/** The four overview requests in parallel: the dashboard renders once all have answered. */
export function useOverviewData(range: DateRange, service: string | null) {
  const client = useApiClient();
  const key = `${range.from}|${range.to}|${service ?? ''}`;
  return useApiQuery(key, async (signal): Promise<OverviewData> => {
    const kpiQuery = { ...range, service };
    const [summary, daily, byPriority, heatmap] = await Promise.all([
      fetchKpiSummary(client, kpiQuery, signal),
      fetchDailyKpis(client, kpiQuery, signal),
      fetchPriorityKpis(client, range, signal),
      fetchHeatmap(client, range, signal),
    ]);
    return { summary, daily, byPriority, heatmap };
  });
}
