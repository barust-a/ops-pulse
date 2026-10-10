import type { Role } from '../../api/schemas';

/** Mirrors the API's `analyst+` guard on POST/PATCH /incidents; the API stays the authority. */
export function canEditIncidents(role: Role): boolean {
  return role === 'analyst' || role === 'admin';
}
