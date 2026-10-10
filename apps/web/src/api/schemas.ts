import { z } from 'zod';

// Mirrors docs/specs/2026-10-10-ops-pulse-contract.md. Change the contract first, then this file.

const isoInstant = z.iso.datetime({ offset: true });
const isoDay = z.iso.date();

export const SERVICES = [
  'payments',
  'crm',
  'data-platform',
  'identity',
  'network',
  'reporting',
] as const;

const ROLES = ['viewer', 'analyst', 'admin'] as const;
const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const PRIORITIES = [1, 2, 3, 4] as const;
export const PrioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Priority = z.infer<typeof PrioritySchema>;

export const INCIDENT_STATES = ['new', 'in_progress', 'on_hold', 'resolved', 'closed'] as const;
export const IncidentStateSchema = z.enum(INCIDENT_STATES);
export type IncidentState = z.infer<typeof IncidentStateSchema>;

export const CHANGE_STATES = ['scheduled', 'implement', 'review', 'closed', 'cancelled'] as const;
export const ChangeStateSchema = z.enum(CHANGE_STATES);
export type ChangeState = z.infer<typeof ChangeStateSchema>;

export const CHANGE_TYPES = ['standard', 'normal', 'emergency'] as const;
export const ChangeTypeSchema = z.enum(CHANGE_TYPES);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

const ChangeRiskSchema = z.enum(['low', 'moderate', 'high']);

export const CLOSE_CODES = ['successful', 'unsuccessful', 'backed_out'] as const;
const CloseCodeSchema = z.enum(CLOSE_CODES);
export type CloseCode = z.infer<typeof CloseCodeSchema>;

const UserSchema = z.object({ id: z.number().int(), email: z.string(), role: RoleSchema });
export type User = z.infer<typeof UserSchema>;

export const LoginResponseSchema = z.object({ token: z.string().min(1), user: UserSchema });
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const LoginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  });
}

export const IncidentSchema = z.object({
  number: z.string(),
  shortDescription: z.string(),
  priority: PrioritySchema,
  state: IncidentStateSchema,
  category: z.string(),
  service: z.string(),
  assignmentGroup: z.string(),
  openedAt: isoInstant,
  resolvedAt: isoInstant.nullable(),
  slaDueAt: isoInstant,
  slaBreached: z.boolean(),
  causedByChange: z.string().nullable(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const IncidentPageSchema = pageOf(IncidentSchema);
export type IncidentPage = z.infer<typeof IncidentPageSchema>;

export const CreateIncidentBodySchema = z.object({
  shortDescription: z.string().trim().min(5).max(160),
  priority: PrioritySchema,
  category: z.string().trim().min(2).max(60),
  service: z.enum(SERVICES),
  assignmentGroup: z.string().trim().min(2).max(80),
});
export type CreateIncidentBody = z.infer<typeof CreateIncidentBodySchema>;

export const UpdateIncidentBodySchema = z
  .object({ state: IncidentStateSchema, priority: PrioritySchema })
  .partial();
export type UpdateIncidentBody = z.infer<typeof UpdateIncidentBodySchema>;

export const ChangeSchema = z.object({
  number: z.string(),
  shortDescription: z.string(),
  type: ChangeTypeSchema,
  risk: ChangeRiskSchema,
  state: ChangeStateSchema,
  closeCode: CloseCodeSchema.nullable(),
  service: z.string(),
  plannedStart: isoInstant,
  plannedEnd: isoInstant,
  closedAt: isoInstant.nullable(),
});
export type Change = z.infer<typeof ChangeSchema>;

export const ChangePageSchema = pageOf(ChangeSchema);
export type ChangePage = z.infer<typeof ChangePageSchema>;

export const KpiSummarySchema = z.object({
  openIncidents: z.number(),
  mttrMinutes: z.number(),
  p90ResolutionMinutes: z.number(),
  slaBreachRate: z.number(),
  changeFailureRate: z.number(),
  anomalies: z.number(),
});
export type KpiSummary = z.infer<typeof KpiSummarySchema>;

export const DailyKpiSchema = z.object({
  day: isoDay,
  service: z.string(),
  incidentCount: z.number(),
  resolvedCount: z.number(),
  mttrMinutes: z.number().nullable(),
  p90ResolutionMinutes: z.number().nullable(),
  slaBreachRate: z.number(),
  changeCount: z.number(),
  changeFailureRate: z.number(),
  incidentZscore: z.number().nullable(),
  isAnomaly: z.boolean(),
});
export type DailyKpi = z.infer<typeof DailyKpiSchema>;

export const DailyKpiListSchema = z.object({ items: z.array(DailyKpiSchema) });

const PriorityKpiSchema = z.object({
  priority: PrioritySchema,
  count: z.number(),
  mttrMinutes: z.number().nullable(),
  slaBreachRate: z.number(),
});
export type PriorityKpi = z.infer<typeof PriorityKpiSchema>;

export const PriorityKpiListSchema = z.object({ items: z.array(PriorityKpiSchema) });

const HeatmapCellSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  hour: z.number().int().min(0).max(23),
  count: z.number(),
});
export type HeatmapCell = z.infer<typeof HeatmapCellSchema>;

export const HeatmapSchema = z.object({ items: z.array(HeatmapCellSchema) });

const ChangeOutcomeSchema = z.object({
  service: z.string(),
  closeCode: CloseCodeSchema,
  count: z.number().int().min(0),
});
export type ChangeOutcome = z.infer<typeof ChangeOutcomeSchema>;

export const ChangeOutcomeListSchema = z.object({ items: z.array(ChangeOutcomeSchema) });

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.array(z.unknown()).optional(),
  }),
});
