import { z } from 'zod';

export const SERVICES = [
  'payments',
  'crm',
  'data-platform',
  'identity',
  'network',
  'reporting',
] as const;

export const ServiceSchema = z.enum(SERVICES);
export type Service = z.infer<typeof ServiceSchema>;
