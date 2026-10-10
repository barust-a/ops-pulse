import type { IncidentRecord, Priority } from '../domain/incident.js';
import { SERVICES } from '../domain/service.js';
import type { Service } from '../domain/service.js';
import { slaDueAt } from '../domain/sla.js';
import {
  HOUR_WEIGHTS,
  PRIORITY_MIX,
  RESOLUTION_MEDIAN_MINUTES,
  RESOLUTION_SIGMA,
  SERVICE_PROFILES,
} from './catalog.js';
import type { Random } from './random.js';

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const BASE_DAILY_INCIDENTS = 27.5;
const WEEKDAY_FACTOR = 1.2;
const WEEKEND_FACTOR = 0.4;
/** Resolved incidents close automatically after this many days. */
const AUTO_CLOSE_DAYS = 3;

/** A few days where one service has an incident storm, for anomaly detection to find. */
const SPIKE: { service: Service; daysAgo: readonly number[]; factor: number } = {
  service: 'data-platform',
  daysAgo: [11, 38, 63],
  factor: 5,
};

/**
 * Chance that an incident is still in the backlog, decaying with its age: low priorities linger,
 * critical ones are always worked. Gives the ~15 % open share of a real queue.
 */
const BACKLOG: Readonly<Record<Priority, { probability: number; decayDays: number }>> = {
  1: { probability: 0.02, decayDays: 1 },
  2: { probability: 0.15, decayDays: 4 },
  3: { probability: 0.55, decayDays: 12 },
  4: { probability: 0.75, decayDays: 30 },
};

export type DraftIncident = Omit<IncidentRecord, 'number'>;

export function startOfUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isWeekend(dayStart: number): boolean {
  const weekday = new Date(dayStart).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function dailyMean(service: Service, dayStart: number, daysAgo: number): number {
  const mean = BASE_DAILY_INCIDENTS * SERVICE_PROFILES[service].share;
  // A storm hits whatever the day of the week: it is sized from a busy weekday.
  if (service === SPIKE.service && SPIKE.daysAgo.includes(daysAgo)) {
    return mean * WEEKDAY_FACTOR * SPIKE.factor;
  }
  return mean * (isWeekend(dayStart) ? WEEKEND_FACTOR : WEEKDAY_FACTOR);
}

function openedAtOn(random: Random, dayStart: number): Date {
  const hour = random.weighted(HOUR_WEIGHTS.map((weight, index) => [index, weight] as const));
  return new Date(dayStart + hour * 3_600_000 + random.int(0, 3599) * 1000);
}

function lifecycle(
  random: Random,
  incident: { openedAt: Date; priority: Priority },
  now: Date,
): Pick<IncidentRecord, 'state' | 'resolvedAt'> {
  const ageMs = now.getTime() - incident.openedAt.getTime();
  const backlog = BACKLOG[incident.priority];
  const stuck = random.chance(backlog.probability * Math.exp(-ageMs / DAY_MS / backlog.decayDays));
  const minutes = random.logNormal(RESOLUTION_MEDIAN_MINUTES[incident.priority], RESOLUTION_SIGMA);
  const resolvedAt = new Date(incident.openedAt.getTime() + Math.round(minutes * MINUTE_MS));
  if (stuck || resolvedAt > now) {
    const state = ageMs < 3_600_000 ? 'new' : random.weighted([['in_progress', 7], ['on_hold', 3]] as const);
    return { state, resolvedAt: null };
  }
  const closed = now.getTime() - resolvedAt.getTime() > AUTO_CLOSE_DAYS * DAY_MS;
  return { state: closed ? 'closed' : 'resolved', resolvedAt };
}

export interface DraftOptions {
  service: Service;
  openedAt: Date;
  now: Date;
  priority?: Priority;
  causedByChange?: string;
}

export function draftIncident(random: Random, options: DraftOptions): DraftIncident {
  const profile = SERVICE_PROFILES[options.service];
  const priority = options.priority ?? random.weighted(PRIORITY_MIX);
  return {
    shortDescription: random.pick(profile.incidents),
    priority,
    category: options.causedByChange === undefined ? random.pick(profile.categories) : 'software',
    service: options.service,
    assignmentGroup: random.weighted([
      [profile.group, 75],
      ['Service Desk', 15],
      ['Database Administration', 10],
    ]),
    openedAt: options.openedAt,
    slaDueAt: slaDueAt(options.openedAt, priority),
    causedByChange: options.causedByChange ?? null,
    ...lifecycle(random, { openedAt: options.openedAt, priority }, options.now),
  };
}

/** Incidents opened over the `days` days up to `now`, by service, weekday and hour of day. */
export function generateIncidents(random: Random, window: { now: Date; days: number }): DraftIncident[] {
  const today = startOfUtcDay(window.now);
  const drafts: DraftIncident[] = [];
  for (let daysAgo = window.days - 1; daysAgo >= 0; daysAgo--) {
    const dayStart = today - daysAgo * DAY_MS;
    for (const service of SERVICES) {
      const count = random.poisson(dailyMean(service, dayStart, daysAgo));
      for (let index = 0; index < count; index++) {
        const openedAt = openedAtOn(random, dayStart);
        if (openedAt <= window.now) drafts.push(draftIncident(random, { service, openedAt, now: window.now }));
      }
    }
  }
  return drafts;
}
