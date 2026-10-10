// npm run db:seed (tsx) or node dist/scripts/seed.js: replaces the demo data in DATABASE_URL.
import { z } from 'zod';

import { createPool } from '../adapters/postgres/pool.js';
import { writeSeed } from '../adapters/postgres/seed-writer.js';
import { hashPassword } from '../adapters/security/bcrypt-passwords.js';
import { createLogger } from '../logger.js';
import { generateDataset } from '../seed/dataset.js';
import { DEMO_PASSWORD, DEMO_USERS } from '../seed/demo-users.js';

/** Fixed, so the same anchor date always produces the same data set. */
const SEED = 20_261_010;

const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  // The anchor "now" of the 90 generated days: an ISO date (noon UTC) or date-time.
  SEED_NOW: z
    .union([z.iso.datetime({ offset: true }), z.iso.date().transform((day) => `${day}T12:00:00Z`)])
    .optional()
    .or(z.literal('').transform(() => undefined)),
});

const env = EnvSchema.parse(process.env);
const logger = createLogger('info');
const now = env.SEED_NOW === undefined ? new Date() : new Date(env.SEED_NOW);
const dataset = generateDataset({ now, seed: SEED });
const users = await Promise.all(
  DEMO_USERS.map(async (user) => ({ ...user, passwordHash: await hashPassword(DEMO_PASSWORD) })),
);
const pool = createPool(env.DATABASE_URL);

try {
  await writeSeed(pool, { dataset, users });
  logger.info(
    {
      now: now.toISOString(),
      incidents: dataset.incidents.length,
      changes: dataset.changes.length,
      users: users.length,
    },
    'seeded',
  );
} catch (error) {
  logger.error({ err: error }, 'seed failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
