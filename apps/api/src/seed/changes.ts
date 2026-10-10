import type { ChangeRecord } from '../domain/change.js';
import type { Service } from '../domain/service.js';
import { SERVICES } from '../domain/service.js';
import { SERVICE_PROFILES } from './catalog.js';
import { DAY_MS, startOfUtcDay } from './incidents.js';
import type { Random } from './random.js';

const HOUR_MS = 3_600_000;
const WEEKDAY_CHANGES = 4.4;
const WEEKEND_CHANGES = 1.5;
/** Changes are also planned a week ahead, as a change calendar is. */
const FUTURE_DAYS = 7;
/** A change stays in review this long after its window before it is closed. */
const REVIEW_HOURS = 12;
const CANCELLED_SHARE = 0.06;

export type DraftChange = Omit<ChangeRecord, 'number'>;

type ChangeType = ChangeRecord['type'];

function riskOf(random: Random, type: ChangeType): ChangeRecord['risk'] {
  switch (type) {
    case 'standard':
      return random.weighted([['low', 85], ['moderate', 15]] as const);
    case 'normal':
      return random.weighted([['low', 30], ['moderate', 50], ['high', 20]] as const);
    case 'emergency':
      return random.weighted([['moderate', 40], ['high', 60]] as const);
  }
}

function failureChance(type: ChangeType, risk: ChangeRecord['risk']): number {
  if (type === 'emergency') return 0.2;
  return risk === 'high' ? 0.15 : 0.05;
}

function outcome(
  random: Random,
  change: Pick<DraftChange, 'type' | 'risk' | 'plannedStart' | 'plannedEnd'>,
  now: Date,
): Pick<DraftChange, 'state' | 'closeCode' | 'closedAt'> {
  if (change.plannedStart > now) return { state: 'scheduled', closeCode: null, closedAt: null };
  if (change.plannedEnd > now) return { state: 'implement', closeCode: null, closedAt: null };
  if (random.chance(CANCELLED_SHARE)) {
    return { state: 'cancelled', closeCode: null, closedAt: new Date(change.plannedStart.getTime() - 2 * HOUR_MS) };
  }
  const closedAt = new Date(change.plannedEnd.getTime() + random.int(10, 120) * 60_000);
  if (closedAt.getTime() > now.getTime() - REVIEW_HOURS * HOUR_MS) {
    return { state: 'review', closeCode: null, closedAt: null };
  }
  const failed = random.chance(failureChance(change.type, change.risk));
  const closeCode = failed ? random.pick(['unsuccessful', 'backed_out'] as const) : 'successful';
  return { state: 'closed', closeCode, closedAt };
}

function draftChange(
  random: Random,
  { service, dayStart, now }: { service: Service; dayStart: number; now: Date },
): DraftChange {
  const type = random.weighted([['standard', 55], ['normal', 38], ['emergency', 7]] as const);
  // Planned work goes in the evening maintenance window; an emergency happens when it must.
  const hour =
    type === 'emergency' ? random.int(0, 23) : random.weighted([[19, 3], [20, 3], [21, 2], [22, 1], [6, 1]] as const);
  const plannedStart = new Date(dayStart + hour * HOUR_MS + random.pick([0, 15, 30, 45]) * 60_000);
  const plannedEnd = new Date(plannedStart.getTime() + random.int(2, 16) * 15 * 60_000);
  const base = { type, risk: riskOf(random, type), plannedStart, plannedEnd };
  return {
    shortDescription: random.pick(SERVICE_PROFILES[service].changes),
    service,
    ...base,
    ...outcome(random, base, now),
  };
}

/** About 350 changes from `days` days back to a week ahead, heavier on weekdays. */
export function generateChanges(random: Random, window: { now: Date; days: number }): DraftChange[] {
  const today = startOfUtcDay(window.now);
  const shares = SERVICES.map((service) => [service, SERVICE_PROFILES[service].share] as const);
  const drafts: DraftChange[] = [];
  for (let daysAgo = window.days - 1; daysAgo >= -FUTURE_DAYS; daysAgo--) {
    const dayStart = today - daysAgo * DAY_MS;
    const weekday = new Date(dayStart).getUTCDay();
    const mean = weekday === 0 || weekday === 6 ? WEEKEND_CHANGES : WEEKDAY_CHANGES;
    const count = random.poisson(mean);
    for (let index = 0; index < count; index++) {
      const service = random.weighted(shares);
      drafts.push(draftChange(random, { service, dayStart, now: window.now }));
    }
  }
  return drafts;
}
