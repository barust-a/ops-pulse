import { describe, expect, it } from 'vitest';

import { planIncidentUpdate } from './incident-update.js';

const OPENED = new Date('2026-10-01T08:00:00.000Z');
const NOW = new Date('2026-10-01T10:00:00.000Z');

const open = {
  state: 'in_progress',
  priority: 3,
  openedAt: OPENED,
  resolvedAt: null,
  slaDueAt: new Date('2026-10-02T08:00:00.000Z'),
} as const;

describe('planIncidentUpdate', () => {
  it('stamps the resolution time when an open incident is resolved', () => {
    expect(planIncidentUpdate(open, { state: 'resolved' }, NOW)).toMatchObject({
      state: 'resolved',
      resolvedAt: NOW,
    });
  });

  it('keeps the first resolution time when a resolved incident is closed', () => {
    const resolved = { ...open, state: 'resolved', resolvedAt: OPENED } as const;
    expect(planIncidentUpdate(resolved, { state: 'closed' }, NOW).resolvedAt).toBe(OPENED);
  });

  it('clears the resolution time when an incident is reopened', () => {
    const resolved = { ...open, state: 'resolved', resolvedAt: OPENED } as const;
    expect(planIncidentUpdate(resolved, { state: 'in_progress' }, NOW).resolvedAt).toBeNull();
  });

  it('moves the SLA due time to the new priority target', () => {
    const plan = planIncidentUpdate(open, { priority: 1 }, NOW);
    expect(plan.priority).toBe(1);
    expect(plan.slaDueAt.toISOString()).toBe('2026-10-01T12:00:00.000Z');
  });

  it('keeps the SLA due time when the priority does not change', () => {
    expect(planIncidentUpdate(open, { state: 'on_hold' }, NOW).slaDueAt).toBe(open.slaDueAt);
  });
});
