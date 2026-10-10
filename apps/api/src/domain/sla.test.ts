import { describe, expect, it } from 'vitest';

import { isSlaBreached, slaDueAt } from './sla.js';

const OPENED = new Date('2026-10-01T08:00:00.000Z');

describe('slaDueAt', () => {
  it.each([
    [1, '2026-10-01T12:00:00.000Z'],
    [2, '2026-10-01T16:00:00.000Z'],
    [3, '2026-10-02T08:00:00.000Z'],
    [4, '2026-10-04T08:00:00.000Z'],
  ] as const)('gives a P%i incident its resolution target', (priority, expected) => {
    expect(slaDueAt(OPENED, priority).toISOString()).toBe(expected);
  });
});

describe('isSlaBreached', () => {
  const due = new Date('2026-10-01T12:00:00.000Z');

  it('is breached when the incident was resolved after its due time', () => {
    const resolvedAt = new Date('2026-10-01T12:00:01.000Z');
    expect(isSlaBreached({ slaDueAt: due, resolvedAt }, new Date('2026-10-05'))).toBe(true);
  });

  it('is met when the incident was resolved exactly at its due time', () => {
    expect(isSlaBreached({ slaDueAt: due, resolvedAt: due }, new Date('2026-10-05'))).toBe(false);
  });

  it('is breached when an open incident is past its due time now', () => {
    const now = new Date('2026-10-01T13:00:00.000Z');
    expect(isSlaBreached({ slaDueAt: due, resolvedAt: null }, now)).toBe(true);
  });

  it('is not breached while an open incident is still within its target', () => {
    const now = new Date('2026-10-01T11:00:00.000Z');
    expect(isSlaBreached({ slaDueAt: due, resolvedAt: null }, now)).toBe(false);
  });
});
