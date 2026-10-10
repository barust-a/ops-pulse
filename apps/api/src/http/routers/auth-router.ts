import type { RequestHandler } from 'express';
import { Router } from 'express';

import type { SamlConfig } from '../../config.js';
import type { UserRepository } from '../../ports/repositories.js';
import type { PasswordVerifier, TokenService } from '../../ports/security.js';
import { HttpError } from '../errors.js';
import { authenticate, claimsOf } from '../middlewares/auth.js';
import { loginRateLimit } from '../middlewares/login-rate-limit.js';
import { serviceProviderMetadata } from '../saml-metadata.js';
import { LoginBodySchema } from '../schemas.js';
import { validBody } from '../validate.js';

export interface AuthRouterDeps {
  users: UserRepository;
  passwords: PasswordVerifier;
  tokens: TokenService;
  saml: SamlConfig;
}

function login({ users, passwords, tokens }: AuthRouterDeps): RequestHandler {
  return async (req, res) => {
    const { email, password } = validBody(LoginBodySchema, req);
    const credentials = await users.findByEmail(email);
    // Verify even for an unknown email, and answer both failures alike: neither the message nor
    // the response time tells which accounts exist.
    const valid = await passwords.verify(password, credentials?.passwordHash ?? null);
    if (credentials === null || !valid) {
      throw new HttpError('UNAUTHENTICATED', 'Invalid email or password');
    }
    const { user } = credentials;
    res.json({ token: tokens.issue({ userId: user.id, role: user.role }), user });
  };
}

function me({ users }: AuthRouterDeps): RequestHandler {
  return async (_req, res) => {
    const user = await users.findById(claimsOf(res).userId);
    if (user === null) throw new HttpError('UNAUTHENTICATED', 'This account no longer exists');
    res.json(user);
  };
}

function samlMetadata({ saml }: AuthRouterDeps): RequestHandler {
  return (_req, res) => {
    if (!saml.enabled) throw new HttpError('NOT_FOUND', 'SAML single sign-on is not enabled');
    res.type('application/samlmetadata+xml').send(serviceProviderMetadata(saml));
  };
}

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  router.post('/login', loginRateLimit(), login(deps));
  router.get('/me', authenticate(deps.tokens), me(deps));
  router.get('/saml/metadata', samlMetadata(deps));
  return router;
}
