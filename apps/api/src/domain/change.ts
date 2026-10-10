import { z } from 'zod';

import { ServiceSchema } from './service.js';

export const ChangeTypeSchema = z.enum(['standard', 'normal', 'emergency']);
const ChangeRiskSchema = z.enum(['low', 'moderate', 'high']);
export const ChangeStateSchema = z.enum(['scheduled', 'implement', 'review', 'closed', 'cancelled']);
export const CloseCodeSchema = z.enum(['successful', 'unsuccessful', 'backed_out']);

export const ChangeRecordSchema = z.object({
  number: z.string().regex(/^CHG\d{7}$/),
  shortDescription: z.string(),
  type: ChangeTypeSchema,
  risk: ChangeRiskSchema,
  state: ChangeStateSchema,
  closeCode: CloseCodeSchema.nullable(),
  service: ServiceSchema,
  plannedStart: z.date(),
  plannedEnd: z.date(),
  closedAt: z.date().nullable(),
});
export type ChangeRecord = z.infer<typeof ChangeRecordSchema>;

/** The API representation (contract `Change`). */
export const ChangeSchema = ChangeRecordSchema.extend({
  plannedStart: z.iso.datetime(),
  plannedEnd: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
export type Change = z.infer<typeof ChangeSchema>;

export function toChange(record: ChangeRecord): Change {
  return {
    ...record,
    plannedStart: record.plannedStart.toISOString(),
    plannedEnd: record.plannedEnd.toISOString(),
    closedAt: record.closedAt?.toISOString() ?? null,
  };
}
