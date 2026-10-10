import { z } from 'zod';

export const RoleSchema = z.enum(['viewer', 'analyst', 'admin']);
export type Role = z.infer<typeof RoleSchema>;

// Roles are cumulative: an analyst can do what a viewer can, an admin what an analyst can.
const RANK: Readonly<Record<Role, number>> = { viewer: 1, analyst: 2, admin: 3 };

export function hasRole(actual: Role, required: Role): boolean {
  return RANK[actual] >= RANK[required];
}
