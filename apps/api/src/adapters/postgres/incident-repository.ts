import type pg from 'pg';
import { z } from 'zod';

import type { IncidentRecord } from '../../domain/incident.js';
import { IncidentRecordSchema } from '../../domain/incident.js';
import type { IncidentUpdatePlan } from '../../domain/incident-update.js';
import type {
  CreateIncidentResult,
  IncidentQuery,
  IncidentRepository,
  IncidentSort,
  NewIncident,
  PageSlice,
} from '../../ports/repositories.js';
import { containsPattern, SqlWhere } from './sql-where.js';

// Selected from an incident row `i` joined to its assignment group `g`.
const INCIDENT_COLUMNS = `
  i.number, i.short_description as "shortDescription", i.priority, i.state, i.category,
  i.service, g.name as "assignmentGroup", i.opened_at as "openedAt",
  i.resolved_at as "resolvedAt", i.sla_due_at as "slaDueAt",
  i.caused_by_change as "causedByChange"`;

const OPENED_AT = 'i.opened_at';

const SORT_COLUMNS: Readonly<Record<string, string>> = {
  openedAt: OPENED_AT,
  priority: 'i.priority',
  slaDueAt: 'i.sla_due_at',
  number: 'i.number',
};

const CountSchema = z.object({ total: z.number().int() });

function orderBy(sort: IncidentSort): string {
  const descending = sort.startsWith('-');
  const column = SORT_COLUMNS[descending ? sort.slice(1) : sort] ?? OPENED_AT;
  // The id breaks ties so pages never overlap or skip a row.
  return `order by ${column} ${descending ? 'desc' : 'asc'}, i.id desc`;
}

function filters(query: IncidentQuery): SqlWhere {
  return new SqlWhere()
    .addDayRange(OPENED_AT, query.range)
    .addIfDefined((p) => `i.service = ${p}`, query.service)
    .addIfDefined((p) => `i.priority = ${p}`, query.priority)
    .addIfDefined((p) => `i.state = ${p}`, query.state)
    .addIfDefined(
      (p) => `(i.number ilike ${p} or i.short_description ilike ${p})`,
      query.q === undefined ? undefined : containsPattern(query.q),
    );
}

function toRecords(rows: unknown[]): IncidentRecord[] {
  return rows.map((row) => IncidentRecordSchema.parse(row));
}

export class PgIncidentRepository implements IncidentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(query: IncidentQuery): Promise<PageSlice<IncidentRecord>> {
    const where = filters(query);
    const countSql = `select count(*)::int as total from ops.incidents i ${where.toSql()}`;
    const countValues = [...where.values];
    const limit = where.param(query.pageSize);
    const offset = where.param((query.page - 1) * query.pageSize);
    const [rows, count] = await Promise.all([
      this.pool.query(
        `select ${INCIDENT_COLUMNS}
           from ops.incidents i join ops.assignment_groups g on g.id = i.assignment_group_id
           ${where.toSql()} ${orderBy(query.sort)} limit ${limit} offset ${offset}`,
        where.values,
      ),
      this.pool.query(countSql, countValues),
    ]);
    return { items: toRecords(rows.rows), total: CountSchema.parse(count.rows[0]).total };
  }

  async findByNumber(number: string): Promise<IncidentRecord | null> {
    const result = await this.pool.query(
      `select ${INCIDENT_COLUMNS}
         from ops.incidents i join ops.assignment_groups g on g.id = i.assignment_group_id
        where i.number = $1`,
      [number],
    );
    return toRecords(result.rows)[0] ?? null;
  }

  async create(incident: NewIncident): Promise<CreateIncidentResult> {
    // Selecting from the group makes an unknown group insert nothing (and draw no number).
    const result = await this.pool.query(
      `with inserted as (
         insert into ops.incidents (number, short_description, priority, state, category, service,
                                    assignment_group_id, opened_at, sla_due_at)
         select 'INC' || lpad(nextval('ops.incident_number_seq')::text, 7, '0'), $1, $2, 'new', $3,
                $4, g.id, $6, $7
           from ops.assignment_groups g
          where g.name = $5
         returning *)
       select ${INCIDENT_COLUMNS}
         from inserted i join ops.assignment_groups g on g.id = i.assignment_group_id`,
      [
        incident.shortDescription,
        incident.priority,
        incident.category,
        incident.service,
        incident.assignmentGroup,
        incident.openedAt,
        incident.slaDueAt,
      ],
    );
    const created = toRecords(result.rows)[0];
    return created === undefined
      ? { status: 'unknown_assignment_group' }
      : { status: 'created', incident: created };
  }

  async update(number: string, plan: IncidentUpdatePlan): Promise<IncidentRecord | null> {
    const result = await this.pool.query(
      `with updated as (
         update ops.incidents
            set state = $2, priority = $3, resolved_at = $4, sla_due_at = $5
          where number = $1
         returning *)
       select ${INCIDENT_COLUMNS}
         from updated i join ops.assignment_groups g on g.id = i.assignment_group_id`,
      [number, plan.state, plan.priority, plan.resolvedAt, plan.slaDueAt],
    );
    return toRecords(result.rows)[0] ?? null;
  }
}
