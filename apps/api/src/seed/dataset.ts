import type { ChangeRecord } from '../domain/change.js';
import type { IncidentRecord } from '../domain/incident.js';
import { ASSIGNMENT_GROUPS } from './catalog.js';
import { generateChanges } from './changes.js';
import type { DraftIncident } from './incidents.js';
import { draftIncident, generateIncidents } from './incidents.js';
import type { Random } from './random.js';
import { createRandom } from './random.js';

const DAYS = 90;
const FIRST_INCIDENT = 10_001;
const FIRST_CHANGE = 30_001;
/** Even a successful change occasionally causes an incident. */
const SUCCESSFUL_CHANGE_INCIDENT_CHANCE = 0.04;

export interface SeedDataset {
  assignmentGroups: string[];
  changes: ChangeRecord[];
  incidents: IncidentRecord[];
}

function numbered(prefix: string, first: number, index: number): string {
  return `${prefix}${String(first + index).padStart(7, '0')}`;
}

function incidentsCausedByChanges(random: Random, changes: ChangeRecord[], now: Date): DraftIncident[] {
  const drafts: DraftIncident[] = [];
  for (const change of changes) {
    if (change.closeCode === null) continue;
    const failed = change.closeCode !== 'successful';
    const count = failed ? random.int(1, 3) : Number(random.chance(SUCCESSFUL_CHANGE_INCIDENT_CHANCE));
    for (let index = 0; index < count; index++) {
      const openedAt = new Date(change.plannedEnd.getTime() + random.int(5, 240) * 60_000);
      if (openedAt > now) continue;
      const priority = random.weighted([[1, 3], [2, 5], [3, 2]] as const);
      drafts.push(
        draftIncident(random, { service: change.service, openedAt, now, priority, causedByChange: change.number }),
      );
    }
  }
  return drafts;
}

/**
 * The demo data set: 90 days up to `now` (plus a week of planned changes), identical for the same
 * seed and anchor date. Numbers follow time order, as a ticketing tool assigns them.
 */
export function generateDataset(options: { now: Date; seed: number }): SeedDataset {
  const random = createRandom(options.seed);
  const window = { now: options.now, days: DAYS };
  const changes = generateChanges(random, window)
    .toSorted((a, b) => a.plannedStart.getTime() - b.plannedStart.getTime())
    .map((change, index) => ({ number: numbered('CHG', FIRST_CHANGE, index), ...change }));
  const incidents = [...generateIncidents(random, window), ...incidentsCausedByChanges(random, changes, options.now)]
    .toSorted((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
    .map((incident, index) => ({ number: numbered('INC', FIRST_INCIDENT, index), ...incident }));
  return { assignmentGroups: [...ASSIGNMENT_GROUPS], changes, incidents };
}
