import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { isSlaBreached } from '../../domain/sla.js';
import type { SeedDataset } from '../../seed/dataset.js';
import {
  describeWithDatabase,
  migratedAndSeeded,
  SEED_NOW,
  silentLogger,
} from '../../testing/database.js';
import { PgChangeRepository } from './change-repository.js';
import { PgDatabaseHealth } from './database-health.js';
import { PgIncidentRepository } from './incident-repository.js';
import { PgKpiRepository } from './kpi-repository.js';
import { PgUserRepository } from './user-repository.js';

const ALL_TIME = { from: '2026-01-01', to: '2026-12-31' };
const PAGE = { page: 1, pageSize: 25, sort: '-openedAt' } as const;

describeWithDatabase('PostgreSQL repositories', () => {
  let pool: pg.Pool;
  let dataset: SeedDataset;
  let incidents: PgIncidentRepository;
  let kpis: PgKpiRepository;

  beforeAll(async () => {
    ({ pool, dataset } = await migratedAndSeeded());
    incidents = new PgIncidentRepository(pool);
    kpis = new PgKpiRepository(pool);
  });

  afterAll(async () => {
    await pool.query("delete from ops.daily_service_kpis where day < '2001-01-01'");
    await pool.end();
  });

  it('reports the database up', async () => {
    await expect(new PgDatabaseHealth(pool, silentLogger).isUp()).resolves.toBe(true);
  });

  it('pages all seeded incidents, newest first, with the total', async () => {
    const page = await incidents.list({ ...PAGE, range: ALL_TIME, page: 2 });
    expect(page.total).toBe(dataset.incidents.length);
    expect(page.items).toHaveLength(25);
    const opened = page.items.map((item) => item.openedAt.getTime());
    expect(opened).toEqual(opened.toSorted((a, b) => b - a));
  });

  it('filters by service, priority and state together', async () => {
    const page = await incidents.list({
      ...PAGE,
      range: ALL_TIME,
      service: 'payments',
      priority: 2,
      state: 'closed',
    });
    const expected = dataset.incidents.filter(
      (incident) => incident.service === 'payments' && incident.priority === 2 && incident.state === 'closed',
    );
    expect(page.total).toBe(expected.length);
    expect(page.items.every((item) => item.service === 'payments' && item.priority === 2)).toBe(true);
  });

  it('matches free text literally, wildcards included', async () => {
    const page = await incidents.list({ ...PAGE, range: ALL_TIME, q: 'kafka consumer' });
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.every((item) => item.shortDescription.toLowerCase().includes('kafka consumer'))).toBe(true);
    const wildcard = await incidents.list({ ...PAGE, range: ALL_TIME, q: '%' });
    expect(wildcard.total).toBe(dataset.incidents.filter((i) => i.shortDescription.includes('%')).length);
  });

  it('bounds the range by whole UTC days', async () => {
    const day = { from: '2026-10-01', to: '2026-10-01' };
    const page = await incidents.list({ ...PAGE, range: day, pageSize: 100 });
    const expected = dataset.incidents.filter((i) => i.openedAt.toISOString().startsWith('2026-10-01'));
    expect(page.total).toBe(expected.length);
  });

  it('sorts by priority ascending', async () => {
    const page = await incidents.list({ ...PAGE, range: ALL_TIME, sort: 'priority' });
    expect(page.items.every((item) => item.priority === 1)).toBe(true);
  });

  it('round-trips one incident', async () => {
    const seeded = dataset.incidents[42];
    expect(await incidents.findByNumber(seeded?.number ?? '')).toEqual(seeded);
    expect(await incidents.findByNumber('INC9999999')).toBeNull();
  });

  it('creates an incident numbered after the seed, and refuses an unknown group', async () => {
    const draft = {
      shortDescription: 'Integration test incident',
      priority: 3,
      category: 'software',
      service: 'crm',
      openedAt: SEED_NOW,
      slaDueAt: new Date(SEED_NOW.getTime() + 86_400_000),
    } as const;
    const created = await incidents.create({ ...draft, assignmentGroup: 'CRM Support' });
    expect(created).toMatchObject({ status: 'created', incident: { state: 'new', assignmentGroup: 'CRM Support' } });
    const last = dataset.incidents.at(-1)?.number ?? '';
    expect(created.status === 'created' && created.incident.number.localeCompare(last) > 0).toBe(true);
    await expect(incidents.create({ ...draft, assignmentGroup: 'Nobody' })).resolves.toEqual({
      status: 'unknown_assignment_group',
    });
  });

  it('writes an update plan', async () => {
    const open = dataset.incidents.find((incident) => incident.resolvedAt === null);
    const number = open?.number ?? '';
    const updated = await incidents.update(number, {
      state: 'resolved',
      priority: 1,
      resolvedAt: SEED_NOW,
      slaDueAt: SEED_NOW,
    });
    expect(updated).toMatchObject({ number, state: 'resolved', priority: 1, resolvedAt: SEED_NOW });
    await expect(incidents.update('INC9999999', { state: 'new', priority: 1, resolvedAt: null, slaDueAt: SEED_NOW })).resolves.toBeNull();
  });

  it('pages changes by planned start with filters', async () => {
    const changes = new PgChangeRepository(pool);
    const page = await changes.list({ range: ALL_TIME, page: 1, pageSize: 100, type: 'emergency' });
    expect(page.total).toBe(dataset.changes.filter((change) => change.type === 'emergency').length);
    expect(page.items.every((change) => change.type === 'emergency')).toBe(true);
  });

  it('finds demo users by email, ignoring case', async () => {
    const users = new PgUserRepository(pool);
    const found = await users.findByEmail('Admin@Ops-Pulse.TEST');
    expect(found?.user).toMatchObject({ email: 'admin@ops-pulse.test', role: 'admin' });
    expect(found?.passwordHash).toMatch(/^\$2b\$/);
    expect(await users.findById(found?.user.id ?? 0)).toEqual(found?.user);
    expect(await users.findByEmail('nobody@ops-pulse.test')).toBeNull();
  });

  it('counts open incidents live', async () => {
    const open = await kpis.countOpenIncidents('network');
    expect(typeof open).toBe('number');
    expect(open).toBeGreaterThan(0);
  });

  it('aggregates incidents per priority, all four always present', async () => {
    const items = await kpis.byPriority(ALL_TIME, SEED_NOW);
    expect(items.map((item) => item.priority)).toEqual([1, 2, 3, 4]);
    expect(items.reduce((sum, item) => sum + item.count, 0)).toBeGreaterThanOrEqual(dataset.incidents.length);
    for (const item of items) {
      expect(typeof item.mttrMinutes).toBe('number');
      expect(item.slaBreachRate).toBeGreaterThanOrEqual(0);
      expect(item.slaBreachRate).toBeLessThanOrEqual(1);
    }
    const empty = await kpis.byPriority({ from: '2001-01-01', to: '2001-01-31' }, SEED_NOW);
    expect(empty[0]).toEqual({ priority: 1, count: 0, mttrMinutes: null, slaBreachRate: 0 });
  });

  it('applies the domain SLA rule in SQL', async () => {
    const range = { from: '2026-09-01', to: '2026-09-30' };
    const inRange = dataset.incidents.filter((i) => i.openedAt.toISOString().startsWith('2026-09'));
    const p4 = inRange.filter((i) => i.priority === 4);
    const expected = p4.filter((i) => isSlaBreached(i, SEED_NOW)).length / p4.length;
    const items = await kpis.byPriority(range, SEED_NOW);
    expect(items[3]?.slaBreachRate).toBeCloseTo(expected, 3);
  });

  it('fills the 7 × 24 heatmap, Monday first', async () => {
    const cells = await kpis.heatmap(ALL_TIME);
    expect(cells).toHaveLength(168);
    expect(cells[0]).toMatchObject({ weekday: 0, hour: 0 });
    const mondayAt10 = dataset.incidents.filter(
      (i) => i.openedAt.getUTCDay() === 1 && i.openedAt.getUTCHours() === 10,
    ).length;
    expect(cells.find((cell) => cell.weekday === 0 && cell.hour === 10)?.count).toBeGreaterThanOrEqual(mondayAt10);
  });

  it('computes the p90 resolution time live, null when nothing was resolved', async () => {
    const p90 = await kpis.p90ResolutionMinutes({ from: '2026-09-01', to: '2026-09-30' });
    expect(p90).toBeGreaterThan(0);
    await expect(kpis.p90ResolutionMinutes({ from: '2001-01-01', to: '2001-01-31' })).resolves.toBeNull();
  });

  it('counts closed change outcomes per service', async () => {
    const outcomes = await kpis.changeOutcomes(ALL_TIME);
    const closed = dataset.changes.filter((change) => change.state === 'closed').length;
    expect(outcomes.reduce((sum, outcome) => sum + outcome.count, 0)).toBe(closed);
  });

  it('reads the Dataiku daily table as numbers, by day then service', async () => {
    await pool.query(
      `insert into ops.daily_service_kpis
         (day, service, incident_count, resolved_count, mttr_minutes, p90_resolution_minutes,
          sla_breach_rate, change_count, change_failure_rate, incident_zscore, is_anomaly)
       values ('2000-01-02', 'crm', 5, 4, 120.5, 300.25, 0.25, 2, 0.5, 3.2, true),
              ('2000-01-01', 'payments', 3, 0, null, null, 0, 0, 0, null, false)
       on conflict do nothing`,
    );
    const rows = await kpis.listDaily({ from: '2000-01-01', to: '2000-01-31' });
    expect(rows).toEqual([
      expect.objectContaining({ day: '2000-01-01', service: 'payments', mttrMinutes: null }),
      {
        day: '2000-01-02',
        service: 'crm',
        incidentCount: 5,
        resolvedCount: 4,
        mttrMinutes: 120.5,
        p90ResolutionMinutes: 300.25,
        slaBreachRate: 0.25,
        changeCount: 2,
        changeFailureRate: 0.5,
        incidentZscore: 3.2,
        isAnomaly: true,
      },
    ]);
    expect(await kpis.listDaily({ from: '2000-01-01', to: '2000-01-31' }, 'crm')).toHaveLength(1);
  });
});
