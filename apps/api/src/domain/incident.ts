import { z } from 'zod';

import { ServiceSchema } from './service.js';
import { isSlaBreached } from './sla.js';

export const PrioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Priority = z.infer<typeof PrioritySchema>;

const INCIDENT_STATES = ['new', 'in_progress', 'on_hold', 'resolved', 'closed'] as const;
export const IncidentStateSchema = z.enum(INCIDENT_STATES);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

const RESOLVED_STATES: ReadonlySet<IncidentState> = new Set(['resolved', 'closed']);

export function isResolvedState(state: IncidentState): boolean {
  return RESOLVED_STATES.has(state);
}

export const IncidentNumberSchema = z.string().regex(/^INC\d{7}$/, 'expected INC followed by 7 digits');

/** An incident as stored: everything but the SLA status, which depends on the current time. */
export const IncidentRecordSchema = z.object({
  number: IncidentNumberSchema,
  shortDescription: z.string(),
  priority: PrioritySchema,
  state: IncidentStateSchema,
  category: z.string(),
  service: ServiceSchema,
  assignmentGroup: z.string(),
  openedAt: z.date(),
  resolvedAt: z.date().nullable(),
  slaDueAt: z.date(),
  causedByChange: z.string().nullable(),
});
export type IncidentRecord = z.infer<typeof IncidentRecordSchema>;

/** The API representation (contract `Incident`). */
export const IncidentSchema = z.object({
  number: z.string(),
  shortDescription: z.string(),
  priority: PrioritySchema,
  state: IncidentStateSchema,
  category: z.string(),
  service: ServiceSchema,
  assignmentGroup: z.string(),
  openedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  slaDueAt: z.iso.datetime(),
  slaBreached: z.boolean(),
  causedByChange: z.string().nullable(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export function toIncident(record: IncidentRecord, now: Date): Incident {
  return {
    ...record,
    openedAt: record.openedAt.toISOString(),
    resolvedAt: record.resolvedAt?.toISOString() ?? null,
    slaDueAt: record.slaDueAt.toISOString(),
    slaBreached: isSlaBreached(record, now),
  };
}
