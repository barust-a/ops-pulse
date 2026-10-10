import type { Priority } from './incident.js';

const MINUTE_MS = 60_000;

/** Resolution targets per priority (1 = critical), in minutes. */
const SLA_TARGET_MINUTES: Readonly<Record<Priority, number>> = {
  1: 4 * 60,
  2: 8 * 60,
  3: 24 * 60,
  4: 72 * 60,
};

export function slaDueAt(openedAt: Date, priority: Priority): Date {
  return new Date(openedAt.getTime() + SLA_TARGET_MINUTES[priority] * MINUTE_MS);
}

/**
 * An incident breaches its SLA when it was resolved after its due time, or is still open past it.
 * The SQL aggregates in adapters/postgres/kpi-repository.ts apply the same rule.
 */
export function isSlaBreached(
  incident: { slaDueAt: Date; resolvedAt: Date | null },
  now: Date,
): boolean {
  const end = incident.resolvedAt ?? now;
  return end.getTime() > incident.slaDueAt.getTime();
}
