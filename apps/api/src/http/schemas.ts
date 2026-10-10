import { z } from 'zod';

import { ChangeStateSchema, ChangeTypeSchema } from '../domain/change.js';
import type { DateRange } from '../domain/date-range.js';
import { resolveDateRange } from '../domain/date-range.js';
import { IncidentNumberSchema, IncidentStateSchema, PrioritySchema } from '../domain/incident.js';
import { ServiceSchema } from '../domain/service.js';
import { INCIDENT_SORTS } from '../ports/repositories.js';
import { HttpError } from './errors.js';

const MAX_PAGE_SIZE = 100;

const rangeShape = {
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};

const pageShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(25),
};

// Query strings carry text: a priority arrives as "2" and is coerced before the literal check.
const priorityParam = z.coerce.number().pipe(PrioritySchema);

export const LoginBodySchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});

export const IncidentListQuerySchema = z.strictObject({
  ...rangeShape,
  ...pageShape,
  service: ServiceSchema.optional(),
  priority: priorityParam.optional(),
  state: IncidentStateSchema.optional(),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(INCIDENT_SORTS).default('-openedAt'),
});

export const IncidentParamsSchema = z.object({ number: IncidentNumberSchema });

export const CreateIncidentBodySchema = z.strictObject({
  shortDescription: z.string().trim().min(1).max(160),
  priority: PrioritySchema,
  category: z.string().trim().min(1).max(40),
  service: ServiceSchema,
  assignmentGroup: z.string().trim().min(1).max(80),
});

export const PatchIncidentBodySchema = z
  .strictObject({
    state: IncidentStateSchema.optional(),
    priority: PrioritySchema.optional(),
  })
  .refine((patch) => patch.state !== undefined || patch.priority !== undefined, {
    message: 'Provide state, priority or both',
  });

export const ChangeListQuerySchema = z.strictObject({
  ...rangeShape,
  ...pageShape,
  service: ServiceSchema.optional(),
  state: ChangeStateSchema.optional(),
  type: ChangeTypeSchema.optional(),
});

export const KpiQuerySchema = z.strictObject({ ...rangeShape, service: ServiceSchema.optional() });

export const KpiRangeQuerySchema = z.strictObject(rangeShape);

/** The requested range with its defaults filled, rejected when it ends before it starts. */
export function requestedRange(query: { from?: string; to?: string }, now: Date): DateRange {
  const range = resolveDateRange(query, now);
  if (range.from.localeCompare(range.to) > 0) {
    throw new HttpError('VALIDATION_FAILED', 'Request validation failed', [
      { location: 'query', path: 'to', message: `to (${range.to}) is before from (${range.from})` },
    ]);
  }
  return range;
}
