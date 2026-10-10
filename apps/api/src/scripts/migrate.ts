// npm run db:migrate (tsx) or node dist/scripts/migrate.js: applies db/migrations to DATABASE_URL.
import { z } from 'zod';

import { migrate } from '../adapters/postgres/migrator.js';
import { createPool } from '../adapters/postgres/pool.js';
import { createLogger } from '../logger.js';
import { migrationsDir } from './migrations-dir.js';

const env = z.object({ DATABASE_URL: z.url() }).parse(process.env);
const logger = createLogger('info');
const pool = createPool(env.DATABASE_URL);
const dir = migrationsDir(process.env);

try {
  const applied = await migrate({ pool, dir, logger });
  logger.info({ dir, applied }, applied.length === 0 ? 'nothing to migrate' : 'migrated');
} catch (error) {
  logger.error({ err: error, dir }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
