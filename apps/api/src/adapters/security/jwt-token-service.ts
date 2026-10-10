import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { RoleSchema } from '../../domain/roles.js';
import type { Clock } from '../../ports/clock.js';
import type { AccessClaims, TokenService } from '../../ports/security.js';

const ISSUER = 'ops-pulse';
const AUDIENCE = 'ops-pulse-web';
const ALGORITHM = 'HS256';

const PayloadSchema = z.object({
  sub: z.string().regex(/^\d+$/),
  role: RoleSchema,
});

export interface JwtOptions {
  secret: string;
  ttlSeconds: number;
  clock: Clock;
}

function epochSeconds(clock: Clock): number {
  return Math.floor(clock().getTime() / 1000);
}

export function createJwtTokenService({ secret, ttlSeconds, clock }: JwtOptions): TokenService {
  return {
    issue(claims: AccessClaims): string {
      return jwt.sign({ role: claims.role, iat: epochSeconds(clock) }, secret, {
        algorithm: ALGORITHM,
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: String(claims.userId),
        expiresIn: ttlSeconds,
      });
    },
    verify(token: string): AccessClaims | null {
      try {
        const payload = jwt.verify(token, secret, {
          algorithms: [ALGORITHM],
          issuer: ISSUER,
          audience: AUDIENCE,
          clockTimestamp: epochSeconds(clock),
        });
        const parsed = PayloadSchema.safeParse(payload);
        if (!parsed.success) return null;
        return { userId: Number(parsed.data.sub), role: parsed.data.role };
      } catch (error) {
        // An invalid token is an expected outcome, translated to "not authenticated".
        if (error instanceof jwt.JsonWebTokenError) return null;
        throw error;
      }
    },
  };
}
