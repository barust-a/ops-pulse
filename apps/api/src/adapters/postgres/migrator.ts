import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Serialises concurrent migrators (two API replicas starting at once): the second waits.
const LOCK_KEY = 'ops-pulse-migrations';

export interface Migration {
  version: string;
  file: string;
  sql: string;
  checksum: string;
}

const AppliedRowSchema = z.object({ version: z.string(), checksum: z.string() });

/** The NNNN_name.sql files of `dir`, in version order, with their SHA-256. */
export async function readMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir);
  const files = entries.filter((file) => file.endsWith('.sql')).toSorted((a, b) => a.localeCompare(b));
  return Promise.all(
    files.map(async (file) => {
      const version = MIGRATION_FILE.exec(file)?.[1];
      if (version === undefined) throw new Error(`Migration ${file} is not named NNNN_name.sql`);
      const sql = await readFile(join(dir, file), 'utf8');
      return { version, file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function appliedChecksums(client: pg.PoolClient): Promise<Map<string, string>> {
  await client.query('create schema if not exists ops');
  await client.query(`create table if not exists ops.schema_migrations (
    version    text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now())`);
  const result = await client.query('select version, checksum from ops.schema_migrations');
  const rows = result.rows.map((row) => AppliedRowSchema.parse(row));
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

async function applyPending(client: pg.PoolClient, migrations: Migration[]): Promise<string[]> {
  const applied = await appliedChecksums(client);
  const newlyApplied: string[] = [];
  for (const migration of migrations) {
    const checksum = applied.get(migration.version);
    if (checksum === migration.checksum) continue;
    if (checksum !== undefined) {
      throw new Error(
        `Migration ${migration.file} changed after it was applied (checksum mismatch): ` +
          'add a new migration instead of editing an applied one',
      );
    }
    await client.query(migration.sql);
    await client.query('insert into ops.schema_migrations (version, checksum) values ($1, $2)', [
      migration.version,
      migration.checksum,
    ]);
    newlyApplied.push(migration.file);
  }
  return newlyApplied;
}

/**
 * Applies the pending migrations of `dir` in one transaction: all of them or none. Refuses to run
 * when an applied migration's file has changed since.
 */
export async function migrate(options: { pool: pg.Pool; dir: string; logger: Logger }): Promise<string[]> {
  const migrations = await readMigrations(options.dir);
  const client = await options.pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
    const applied = await applyPending(client, migrations);
    await client.query('commit');
    options.logger.info({ applied, total: migrations.length }, 'migrations up to date');
    return applied;
  } catch (error) {
    await client.query('rollback');
    throw new Error('Migration failed, nothing was applied', { cause: error });
  } finally {
    client.release();
  }
}
