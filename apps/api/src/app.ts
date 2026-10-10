import cors from 'cors';
import type { Express } from 'express';
import express, { Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import type { SamlConfig } from './config.js';
import { errorHandler, notFound } from './http/middlewares/error-handler.js';
import { authenticate } from './http/middlewares/auth.js';
import { resolveRequestId } from './http/middlewares/request-id.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { authRouter } from './http/routers/auth-router.js';
import { changesRouter } from './http/routers/changes-router.js';
import { healthRouter } from './http/routers/health-router.js';
import { incidentsRouter } from './http/routers/incidents-router.js';
import { kpisRouter } from './http/routers/kpis-router.js';
import type { Clock } from './ports/clock.js';
import type {
  ChangeRepository,
  DatabaseHealth,
  IncidentRepository,
  KpiRepository,
  UserRepository,
} from './ports/repositories.js';
import type { PasswordVerifier, TokenService } from './ports/security.js';

interface AppSettings {
  corsOrigins: string[];
  saml: SamlConfig;
  version: string;
}

/** Everything the HTTP app needs, built by the caller (server.ts, or a test with fakes). */
export interface AppDependencies {
  settings: AppSettings;
  logger: Logger;
  clock: Clock;
  users: UserRepository;
  incidents: IncidentRepository;
  changes: ChangeRepository;
  kpis: KpiRepository;
  database: DatabaseHealth;
  passwords: PasswordVerifier;
  tokens: TokenService;
}

function apiRouter(deps: AppDependencies): Router {
  const router = Router();
  const signedIn = authenticate(deps.tokens);
  const openApiDocument = buildOpenApiDocument(deps.settings.version);

  router.use(healthRouter({ database: deps.database, version: deps.settings.version }));
  router.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  router.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
  router.use('/auth', authRouter({ ...deps, saml: deps.settings.saml }));
  router.use('/incidents', signedIn, incidentsRouter(deps));
  router.use('/changes', signedIn, changesRouter(deps));
  router.use('/kpis', signedIn, kpisRouter(deps));
  return router;
}

/** Builds the Express app without listening, so tests drive it in-process with supertest. */
export function createApp(deps: AppDependencies): Express {
  const app = express();
  // Behind nginx or a container network: trust X-Forwarded-For only from private addresses, so
  // the login rate limit keys on the real client IP and a client cannot spoof it.
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(pinoHttp({ logger: deps.logger, genReqId: resolveRequestId }));
  // TLS ends at the reverse proxy, which owns HSTS; upgrade-insecure-requests would break the
  // Swagger UI assets on a plain-HTTP local stack (nginx :8080).
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } } }));
  app.use(cors({ origin: deps.settings.corsOrigins }));
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/v1', apiRouter(deps));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
