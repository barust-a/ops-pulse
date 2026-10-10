import { once } from 'node:events';

import { PgChangeRepository } from './adapters/postgres/change-repository.js';
import { PgDatabaseHealth } from './adapters/postgres/database-health.js';
import { PgIncidentRepository } from './adapters/postgres/incident-repository.js';
import { PgKpiRepository } from './adapters/postgres/kpi-repository.js';
import { createPool } from './adapters/postgres/pool.js';
import { PgUserRepository } from './adapters/postgres/user-repository.js';
import { bcryptPasswords } from './adapters/security/bcrypt-passwords.js';
import { createJwtTokenService } from './adapters/security/jwt-token-service.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { readVersion } from './version.js';

// Composition root: the only place that builds adapters and hands them to the app.
const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);
pool.on('error', (error) => {
  // An idle client lost its connection; the pool replaces it on the next checkout.
  logger.error({ err: error }, 'idle database client error');
});

function clock(): Date {
  return new Date();
}

const app = createApp({
  settings: { corsOrigins: config.corsOrigins, saml: config.saml, version: readVersion() },
  logger,
  clock,
  users: new PgUserRepository(pool),
  incidents: new PgIncidentRepository(pool),
  changes: new PgChangeRepository(pool),
  kpis: new PgKpiRepository(pool),
  database: new PgDatabaseHealth(pool, logger),
  passwords: bcryptPasswords,
  tokens: createJwtTokenService({ secret: config.jwtSecret, ttlSeconds: config.jwtTtlSeconds, clock }),
});

const server = app.listen(config.port);
await once(server, 'listening');
logger.info({ port: config.port }, 'ops-pulse api listening');

/** Stops accepting connections, lets in-flight requests finish, then closes the pool. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  const forced = setTimeout(() => {
    logger.error('graceful shutdown timed out after 10 s');
    process.exit(1);
  }, 10_000);
  forced.unref();
  server.close();
  server.closeIdleConnections();
  await once(server, 'close');
  await pool.end();
  logger.info('shutdown complete');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    shutdown(signal).catch((error: unknown) => {
      logger.error({ err: error }, 'shutdown failed');
      process.exitCode = 1;
    });
  });
}
