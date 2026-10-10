import type { Role } from '../domain/roles.js';

/**
 * The contract's demo accounts. Their shared password is public, test-only and documented in
 * docs/specs/2026-10-10-ops-pulse-contract.md: never seed these into a real environment.
 */
// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- the contract's public demo password.
export const DEMO_PASSWORD = 'OpsPulse!2026';

export const DEMO_USERS: readonly { email: string; role: Role }[] = [
  { email: 'admin@ops-pulse.test', role: 'admin' },
  { email: 'analyst@ops-pulse.test', role: 'analyst' },
  { email: 'viewer@ops-pulse.test', role: 'viewer' },
];
