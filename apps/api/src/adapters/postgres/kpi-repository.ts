import type pg from 'pg';
import { z } from 'zod';

import type { DateRange } from '../../domain/date-range.js';
import type { ChangeOutcome, DailyKpi, HeatmapCell, PriorityKpi } from '../../domain/kpi.js';
import {
  ChangeOutcomeSchema,
  DailyKpiSchema,
  HeatmapCellSchema,
  PriorityKpiSchema,
} from '../../domain/kpi.js';
import type { Service } from '../../domain/service.js';
import type { KpiRepository } from '../../ports/repositories.js';
import { SqlWhere } from './sql-where.js';

const CountSchema = z.object({ total: z.number().int() });
const P90Schema = z.object({ p90: z.number().nullable() });

export class PgKpiRepository implements KpiRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listDaily(range: DateRange, service?: Service): Promise<DailyKpi[]> {
    const where = new SqlWhere()
      .add((p) => `day >= ${p}::date`, range.from)
      .add((p) => `day <= ${p}::date`, range.to)
      .addIfDefined((p) => `service = ${p}`, service);
    // float8 makes pg return numbers rather than numeric strings.
    const result = await this.pool.query(
      `select to_char(day, 'YYYY-MM-DD') as day, service,
              incident_count as "incidentCount",
              resolved_count as "resolvedCount",
              mttr_minutes::float8 as "mttrMinutes",
              p90_resolution_minutes::float8 as "p90ResolutionMinutes",
              sla_breach_rate::float8 as "slaBreachRate",
              change_count as "changeCount",
              change_failure_rate::float8 as "changeFailureRate",
              incident_zscore::float8 as "incidentZscore",
              is_anomaly as "isAnomaly"
         from ops.daily_service_kpis ${where.toSql()}
        order by day, service`,
      where.values,
    );
    return result.rows.map((row) => DailyKpiSchema.parse(row));
  }

  async countOpenIncidents(service: Service | null = null): Promise<number> {
    const result = await this.pool.query(
      `select count(*)::int as total
         from ops.incidents
        where resolved_at is null and ($1::text is null or service = $1)`,
      [service],
    );
    return CountSchema.parse(result.rows[0]).total;
  }

  async p90ResolutionMinutes(range: DateRange, service: Service | null = null): Promise<number | null> {
    // Incidents resolved in the range, as the Dataiku daily p90 counts them per resolution day.
    const result = await this.pool.query(
      `select (percentile_cont(0.9) within group (
                 order by extract(epoch from resolved_at - opened_at) / 60))::float8 as p90
         from ops.incidents
        where resolved_at >= $1::date and resolved_at < $2::date + 1
          and ($3::text is null or service = $3)`,
      [range.from, range.to, service],
    );
    return P90Schema.parse(result.rows[0]).p90;
  }

  async byPriority(range: DateRange, now: Date): Promise<PriorityKpi[]> {
    // Breach rule as in domain/sla.ts: resolved, or still open now, after the due time.
    const result = await this.pool.query(
      `select p.priority::int as priority,
              count(i.id)::int as count,
              round((avg(extract(epoch from i.resolved_at - i.opened_at) / 60)
                       filter (where i.resolved_at is not null))::numeric, 2)::float8 as "mttrMinutes",
              coalesce(round((count(i.id) filter (where coalesce(i.resolved_at, $3) > i.sla_due_at))::numeric
                              / nullif(count(i.id), 0), 4), 0)::float8 as "slaBreachRate"
         from generate_series(1, 4) as p(priority)
         left join ops.incidents i
                on i.priority = p.priority
               and i.opened_at >= $1::date and i.opened_at < $2::date + 1
        group by p.priority
        order by p.priority`,
      [range.from, range.to, now],
    );
    return result.rows.map((row) => PriorityKpiSchema.parse(row));
  }

  async heatmap(range: DateRange): Promise<HeatmapCell[]> {
    // isodow is 1 (Monday) to 7 (Sunday); the contract counts Monday as 0. The session is in UTC.
    const result = await this.pool.query(
      `with counts as (
         select extract(isodow from opened_at)::int - 1 as weekday,
                extract(hour from opened_at)::int as hour,
                count(*)::int as count
           from ops.incidents
          where opened_at >= $1::date and opened_at < $2::date + 1
          group by 1, 2)
       select d.weekday, h.hour, coalesce(c.count, 0) as count
         from generate_series(0, 6) as d(weekday)
        cross join generate_series(0, 23) as h(hour)
         left join counts c on c.weekday = d.weekday and c.hour = h.hour
        order by d.weekday, h.hour`,
      [range.from, range.to],
    );
    return result.rows.map((row) => HeatmapCellSchema.parse(row));
  }

  async changeOutcomes(range: DateRange): Promise<ChangeOutcome[]> {
    const result = await this.pool.query(
      `select service, close_code as "closeCode", count(*)::int as count
         from ops.changes
        where state = 'closed' and closed_at >= $1::date and closed_at < $2::date + 1
        group by service, close_code
        order by service, close_code`,
      [range.from, range.to],
    );
    return result.rows.map((row) => ChangeOutcomeSchema.parse(row));
  }
}
