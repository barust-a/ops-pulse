import { describe, expect, it } from 'vitest';

import { isResolvedState } from '../domain/incident.js';
import { isSlaBreached } from '../domain/sla.js';
import { SERVICES } from '../domain/service.js';
import { ASSIGNMENT_GROUPS } from './catalog.js';
import { generateDataset } from './dataset.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const dataset = generateDataset({ now: NOW, seed: 20_261_010 });
const { incidents, changes } = dataset;

function share(count: number): number {
  return count / incidents.length;
}

function withPriority(priority: number): number {
  return incidents.filter((incident) => incident.priority === priority).length;
}

function utcHour(incident: (typeof incidents)[number]): number {
  return incident.openedAt.getUTCHours();
}

describe('generateDataset', () => {
  it('is deterministic for a seed and an anchor date', () => {
    expect(generateDataset({ now: NOW, seed: 20_261_010 })).toEqual(dataset);
  });

  it('generates about 2500 incidents over 90 days, all in the past', () => {
    expect(incidents.length).toBeGreaterThan(2300);
    expect(incidents.length).toBeLessThan(2700);
    const earliest = Math.min(...incidents.map((incident) => incident.openedAt.getTime()));
    expect(NOW.getTime() - earliest).toBeLessThanOrEqual(90 * 86_400_000);
    expect(incidents.every((incident) => incident.openedAt <= NOW)).toBe(true);
  });

  it('numbers incidents uniquely, in opening order', () => {
    expect(incidents[0]?.number).toBe('INC0010001');
    expect(new Set(incidents.map((incident) => incident.number)).size).toBe(incidents.length);
    const opened = incidents.map((incident) => incident.openedAt.getTime());
    expect(opened).toEqual(opened.toSorted((a, b) => a - b));
  });

  it('covers the six services and the eight assignment groups', () => {
    expect(new Set(incidents.map((incident) => incident.service))).toEqual(new Set(SERVICES));
    expect(dataset.assignmentGroups).toEqual(ASSIGNMENT_GROUPS);
    expect(ASSIGNMENT_GROUPS).toHaveLength(8);
  });

  it('mixes priorities about 5/15/40/40 %', () => {
    expect(share(withPriority(1))).toBeGreaterThan(0.03);
    expect(share(withPriority(1))).toBeLessThan(0.08);
    expect(share(withPriority(2))).toBeGreaterThan(0.11);
    expect(share(withPriority(2))).toBeLessThan(0.2);
    expect(share(withPriority(3))).toBeGreaterThan(0.35);
    expect(share(withPriority(4))).toBeGreaterThan(0.33);
  });

  it('leaves about 15 % of incidents open, with no resolution time', () => {
    const open = incidents.filter((incident) => incident.resolvedAt === null);
    expect(share(open.length)).toBeGreaterThan(0.11);
    expect(share(open.length)).toBeLessThan(0.19);
    expect(open.every((incident) => !isResolvedState(incident.state))).toBe(true);
  });

  it('breaches the SLA of about 10 % of resolved incidents', () => {
    const resolved = incidents.filter((incident) => incident.resolvedAt !== null);
    const breached = resolved.filter((incident) => isSlaBreached(incident, NOW));
    expect(breached.length / resolved.length).toBeGreaterThan(0.06);
    expect(breached.length / resolved.length).toBeLessThan(0.14);
  });

  it('opens more incidents in business hours and on weekdays', () => {
    const business = incidents.filter((incident) => utcHour(incident) >= 8 && utcHour(incident) < 18);
    expect(share(business.length)).toBeGreaterThan(0.6);
    const weekend = incidents.filter((incident) => [0, 6].includes(incident.openedAt.getUTCDay()));
    expect(share(weekend.length)).toBeLessThan(0.15);
  });

  it('injects incident spikes on a few days for data-platform', () => {
    const perDay = new Map<string, number>();
    for (const incident of incidents.filter((candidate) => candidate.service === 'data-platform')) {
      const day = incident.openedAt.toISOString().slice(0, 10);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    const counts = [...perDay.values()].toSorted((a, b) => b - a);
    const median = counts[Math.floor(counts.length / 2)] ?? 0;
    expect(counts.slice(0, 3).every((count) => count >= 3 * median)).toBe(true);
  });

  it('generates about 350 changes, some failed and linked to the incidents they caused', () => {
    expect(changes.length).toBeGreaterThan(300);
    expect(changes.length).toBeLessThan(400);
    const failed = changes.filter((change) => change.closeCode === 'unsuccessful' || change.closeCode === 'backed_out');
    expect(failed.length).toBeGreaterThan(10);
    const numbers = new Set(changes.map((change) => change.number));
    const linked = incidents.filter((incident) => incident.causedByChange !== null);
    expect(linked.length).toBeGreaterThan(10);
    expect(linked.every((incident) => numbers.has(incident.causedByChange ?? ''))).toBe(true);
  });

  it('keeps every change consistent with the database checks', () => {
    for (const change of changes) {
      expect(change.plannedEnd.getTime()).toBeGreaterThanOrEqual(change.plannedStart.getTime());
      if (change.closeCode !== null) expect(change.state).toBe('closed');
    }
  });
});
