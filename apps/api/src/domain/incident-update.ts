import type { IncidentRecord, IncidentState, Priority } from './incident.js';
import { isResolvedState } from './incident.js';
import { slaDueAt } from './sla.js';

export interface IncidentPatch {
  state?: IncidentState;
  priority?: Priority;
}

export type IncidentUpdatePlan = Pick<
  IncidentRecord,
  'state' | 'priority' | 'resolvedAt' | 'slaDueAt'
>;

type UpdatableIncident = Pick<
  IncidentRecord,
  'state' | 'priority' | 'openedAt' | 'resolvedAt' | 'slaDueAt'
>;

function nextResolvedAt(current: UpdatableIncident, state: IncidentState, now: Date): Date | null {
  if (!isResolvedState(state)) return null;
  return current.resolvedAt ?? now;
}

/**
 * The stored values after a patch: resolving stamps the resolution time once, reopening clears
 * it, and a priority change moves the SLA due time to the new target from the opening time.
 */
export function planIncidentUpdate(
  current: UpdatableIncident,
  patch: IncidentPatch,
  now: Date,
): IncidentUpdatePlan {
  const state = patch.state ?? current.state;
  const priority = patch.priority ?? current.priority;
  return {
    state,
    priority,
    resolvedAt: nextResolvedAt(current, state, now),
    slaDueAt: priority === current.priority ? current.slaDueAt : slaDueAt(current.openedAt, priority),
  };
}
