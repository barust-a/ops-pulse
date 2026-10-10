import type pg from 'pg';
import { z } from 'zod';

import type { ChangeRecord } from '../../domain/change.js';
import { ChangeRecordSchema } from '../../domain/change.js';
import type { ChangeQuery, ChangeRepository, PageSlice } from '../../ports/repositories.js';
import { SqlWhere } from './sql-where.js';

const CountSchema = z.object({ total: z.number().int() });

export class PgChangeRepository implements ChangeRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(query: ChangeQuery): Promise<PageSlice<ChangeRecord>> {
    const where = new SqlWhere()
      .addDayRange('c.planned_start', query.range)
      .addIfDefined((p) => `c.service = ${p}`, query.service)
      .addIfDefined((p) => `c.state = ${p}`, query.state)
      .addIfDefined((p) => `c.type = ${p}`, query.type);
    const countValues = [...where.values];
    const countSql = `select count(*)::int as total from ops.changes c ${where.toSql()}`;
    const limit = where.param(query.pageSize);
    const offset = where.param((query.page - 1) * query.pageSize);
    const [rows, count] = await Promise.all([
      this.pool.query(
        `select c.number, c.short_description as "shortDescription", c.type, c.risk, c.state,
                c.close_code as "closeCode", c.service, c.planned_start as "plannedStart",
                c.planned_end as "plannedEnd", c.closed_at as "closedAt"
           from ops.changes c ${where.toSql()}
          order by c.planned_start desc, c.id desc
          limit ${limit} offset ${offset}`,
        where.values,
      ),
      this.pool.query(countSql, countValues),
    ]);
    return {
      items: rows.rows.map((row) => ChangeRecordSchema.parse(row)),
      total: CountSchema.parse(count.rows[0]).total,
    };
  }
}
