import type pg from 'pg';

import type { Role } from '../../domain/roles.js';
import type { SeedDataset } from '../../seed/dataset.js';

export interface SeedUser {
  email: string;
  role: Role;
  passwordHash: string;
}

/** Same column order as the insert in writeIncidents. */
function incidentColumns(incidents: SeedDataset['incidents']): unknown[] {
  return [
    incidents.map((incident) => incident.number),
    incidents.map((incident) => incident.shortDescription),
    incidents.map((incident) => incident.priority),
    incidents.map((incident) => incident.state),
    incidents.map((incident) => incident.category),
    incidents.map((incident) => incident.service),
    incidents.map((incident) => incident.assignmentGroup),
    incidents.map((incident) => incident.openedAt),
    incidents.map((incident) => incident.resolvedAt),
    incidents.map((incident) => incident.slaDueAt),
    incidents.map((incident) => incident.causedByChange),
  ];
}

// Each table is written in one statement: unnest() turns parallel arrays into rows, so 2,500
// incidents cost one round trip instead of 2,500.
async function writeIncidents(client: pg.PoolClient, incidents: SeedDataset['incidents']): Promise<void> {
  await client.query(
    `insert into ops.incidents (number, short_description, priority, state, category, service,
                                assignment_group_id, opened_at, resolved_at, sla_due_at, caused_by_change)
     select t.number, t.short_description, t.priority, t.state, t.category, t.service, g.id,
            t.opened_at, t.resolved_at, t.sla_due_at, t.caused_by_change
       from unnest($1::text[], $2::text[], $3::smallint[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::timestamptz[], $9::timestamptz[], $10::timestamptz[], $11::text[])
            as t(number, short_description, priority, state, category, service, group_name,
                 opened_at, resolved_at, sla_due_at, caused_by_change)
       join ops.assignment_groups g on g.name = t.group_name`,
    incidentColumns(incidents),
  );
  // POST /incidents continues numbering after the seeded incidents.
  await client.query(
    `select setval('ops.incident_number_seq',
                   coalesce((select max(substring(number from 4)::int) from ops.incidents), 10000))`,
  );
}

async function writeChanges(client: pg.PoolClient, changes: SeedDataset['changes']): Promise<void> {
  await client.query(
    `insert into ops.changes (number, short_description, type, risk, state, close_code, service,
                              planned_start, planned_end, closed_at)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                          $7::text[], $8::timestamptz[], $9::timestamptz[], $10::timestamptz[])`,
    [
      changes.map((change) => change.number),
      changes.map((change) => change.shortDescription),
      changes.map((change) => change.type),
      changes.map((change) => change.risk),
      changes.map((change) => change.state),
      changes.map((change) => change.closeCode),
      changes.map((change) => change.service),
      changes.map((change) => change.plannedStart),
      changes.map((change) => change.plannedEnd),
      changes.map((change) => change.closedAt),
    ],
  );
}

/**
 * Replaces the seeded tables with the data set, in one transaction: a failure leaves the previous
 * data untouched. ops.daily_service_kpis belongs to the Dataiku flow and is left alone.
 */
export async function writeSeed(pool: pg.Pool, seed: { dataset: SeedDataset; users: SeedUser[] }): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'truncate ops.incidents, ops.changes, ops.users, ops.assignment_groups restart identity',
    );
    await client.query('insert into ops.assignment_groups (name) select unnest($1::text[])', [
      seed.dataset.assignmentGroups,
    ]);
    await client.query(
      `insert into ops.users (email, role, password_hash)
       select * from unnest($1::text[], $2::text[], $3::text[])`,
      [seed.users.map((user) => user.email), seed.users.map((user) => user.role), seed.users.map((user) => user.passwordHash)],
    );
    await writeChanges(client, seed.dataset.changes);
    await writeIncidents(client, seed.dataset.incidents);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw new Error('Seeding failed, the previous data is unchanged', { cause: error });
  } finally {
    client.release();
  }
}
