// Typed access to supertest response bodies: parsing them with the API's own schemas also asserts
// that every response matches the contract.
import { z } from 'zod';

import { ChangeSchema } from '../domain/change.js';
import { IncidentSchema } from '../domain/incident.js';
import {
  ChangeOutcomeSchema,
  DailyKpiSchema,
  HeatmapCellSchema,
  KpiSummarySchema,
  PriorityKpiSchema,
} from '../domain/kpi.js';
import { UserSchema } from '../domain/user.js';
import type { ErrorResponse } from '../http/errors.js';
import { ErrorResponseSchema } from '../http/errors.js';

function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  });
}

function itemsOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

export const Bodies = {
  incidentPage: pageOf(IncidentSchema),
  incident: IncidentSchema,
  changePage: pageOf(ChangeSchema),
  user: UserSchema,
  login: z.object({ token: z.string(), user: UserSchema }),
  kpiSummary: KpiSummarySchema,
  dailyKpis: itemsOf(DailyKpiSchema),
  priorityKpis: itemsOf(PriorityKpiSchema),
  heatmap: itemsOf(HeatmapCellSchema),
  changeOutcomes: itemsOf(ChangeOutcomeSchema),
  health: z.object({ status: z.literal('ok'), db: z.enum(['up', 'down']), version: z.string() }),
} as const;

export function bodyAs<T>(schema: z.ZodType<T>, response: { body: unknown }): T {
  return schema.parse(response.body);
}

export function errorOf(response: { body: unknown }): ErrorResponse['error'] {
  return ErrorResponseSchema.parse(response.body).error;
}
