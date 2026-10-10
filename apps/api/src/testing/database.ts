// Shared setup of the *.int.test.ts suites: a real, disposable PostgreSQL from DATABASE_URL,
// migrated and freshly seeded. These suites truncate tables: never point them at real data.
import { fileURLToPath } from 'node:url';

import type pg from 'pg';
import { pino } from 'pino';
import { describe } from 'vitest';

import { migrate } from '../adapters/postgres/migrator.js';
import { createPool } from '../adapters/postgres/pool.js';
import { writeSeed } from '../adapters/postgres/seed-writer.js';
import { hashPassword } from '../adapters/security/bcrypt-passwords.js';
import type { SeedDataset } from '../seed/dataset.js';
import { generateDataset } from '../seed/dataset.js';
import { DEMO_USERS } from '../seed/demo-users.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
const SKIP_REASON = 'DATABASE_URL is not set: skipping the PostgreSQL integration tests';
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
export const SEED_NOW = new Date('2026-10-10T12:00:00.000Z');
export const silentLogger = pino({ level: 'silent' });

/** Runs the suite against PostgreSQL, or skips it with the reason in its name when unset. */
export function describeWithDatabase(name: string, suite: () => void): void {
  const unset = DATABASE_URL === '';
  describe.skipIf(unset)(unset ? `${name} (${SKIP_REASON})` : name, suite);
}

export async function migratedAndSeeded(): Promise<{ pool: pg.Pool; dataset: SeedDataset }> {
  const pool = createPool(DATABASE_URL);
  await migrate({ pool, dir: MIGRATIONS_DIR, logger: silentLogger });
  const dataset = generateDataset({ now: SEED_NOW, seed: 1 });
  const passwordHash = await hashPassword('integration-test-password', 4);
  await writeSeed(pool, { dataset, users: DEMO_USERS.map((user) => ({ ...user, passwordHash })) });
  return { pool, dataset };
}
