import { z } from 'zod';

import { RoleSchema } from '../domain/roles.js';

/** What a verified access token proves about its bearer. */
export const AccessClaimsSchema = z.object({
  userId: z.number().int().positive(),
  role: RoleSchema,
});
export type AccessClaims = z.infer<typeof AccessClaimsSchema>;

export interface TokenService {
  issue(claims: AccessClaims): string;
  /** Null for a token that is malformed, forged, expired or meant for another audience. */
  verify(token: string): AccessClaims | null;
}

export interface PasswordVerifier {
  /**
   * Null stands for an unknown account: the check still costs a full hash comparison, so response
   * time does not reveal which emails exist.
   */
  verify(password: string, passwordHash: string | null): Promise<boolean>;
}
