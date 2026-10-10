import { z } from 'zod';

import { CloseCodeSchema } from './change.js';
import { PrioritySchema } from './incident.js';
import { ServiceSchema } from './service.js';

/** One row of `ops.daily_service_kpis`, computed by the Dataiku flow (contract `DailyKpi`). */
export const DailyKpiSchema = z.object({
  day: z.iso.date(),
  service: ServiceSchema,
  incidentCount: z.number().int().nonnegative(),
  resolvedCount: z.number().int().nonnegative(),
  mttrMinutes: z.number().nullable(),
  p90ResolutionMinutes: z.number().nullable(),
  slaBreachRate: z.number().min(0).max(1),
  changeCount: z.number().int().nonnegative(),
  changeFailureRate: z.number().min(0).max(1),
  incidentZscore: z.number().nullable(),
  isAnomaly: z.boolean(),
});
export type DailyKpi = z.infer<typeof DailyKpiSchema>;

export const KpiSummarySchema = z.object({
  openIncidents: z.number().int().nonnegative(),
  mttrMinutes: z.number(),
  p90ResolutionMinutes: z.number(),
  slaBreachRate: z.number(),
  changeFailureRate: z.number(),
  anomalies: z.number().int().nonnegative(),
});
export type KpiSummary = z.infer<typeof KpiSummarySchema>;

export const PriorityKpiSchema = z.object({
  priority: PrioritySchema,
  count: z.number().int().nonnegative(),
  mttrMinutes: z.number().nullable(),
  slaBreachRate: z.number(),
});
export type PriorityKpi = z.infer<typeof PriorityKpiSchema>;

export const HeatmapCellSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  count: z.number().int().nonnegative(),
});
export type HeatmapCell = z.infer<typeof HeatmapCellSchema>;

/** How many changes of a service closed with a close code (contract extension). */
export const ChangeOutcomeSchema = z.object({
  service: ServiceSchema,
  closeCode: CloseCodeSchema,
  count: z.number().int().nonnegative(),
});
export type ChangeOutcome = z.infer<typeof ChangeOutcomeSchema>;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Σ(value × weight) / Σweight over the rows that have a value, 0 when no row weighs anything. */
function weightedMean(pairs: { value: number | null; weight: number }[]): number {
  let total = 0;
  let weights = 0;
  for (const { value, weight } of pairs) {
    if (value === null || weight === 0) continue;
    total += value * weight;
    weights += weight;
  }
  return weights === 0 ? 0 : total / weights;
}

/** Figures computed live from ops.incidents rather than from the daily table. */
export interface LiveKpis {
  openIncidents: number;
  /** p90 of the resolution times of the incidents resolved in the range; null when none was. */
  p90ResolutionMinutes: number | null;
}

/**
 * Aggregates daily service KPIs over a range, each rate weighted by its own denominator (the
 * Dataiku definitions: breaches per resolved incident, failures per closed change) so a quiet day
 * does not count as much as a busy one (never an average of averages). A percentile cannot be
 * recombined from daily percentiles, so the p90 comes in live.
 */
export function summarizeDailyKpis(rows: readonly DailyKpi[], live: LiveKpis): KpiSummary {
  function byResolved(pick: (row: DailyKpi) => number | null): number {
    return weightedMean(rows.map((row) => ({ value: pick(row), weight: row.resolvedCount })));
  }
  return {
    openIncidents: live.openIncidents,
    mttrMinutes: round(byResolved((row) => row.mttrMinutes), 2),
    p90ResolutionMinutes: round(live.p90ResolutionMinutes ?? 0, 2),
    slaBreachRate: round(byResolved((row) => row.slaBreachRate), 4),
    changeFailureRate: round(
      weightedMean(rows.map((row) => ({ value: row.changeFailureRate, weight: row.changeCount }))),
      4,
    ),
    anomalies: rows.filter((row) => row.isAnomaly).length,
  };
}
