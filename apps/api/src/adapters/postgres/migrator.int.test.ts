import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  DATABASE_URL,
  describeWithDatabase,
  MIGRATIONS_DIR,
  silentLogger,
} from '../../testing/database.js';
import { migrate, readMigrations } from './migrator.js';
import { createPool } from './pool.js';

describeWithDatabase('migrate (PostgreSQL)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL);
    await migrate({ pool, dir: MIGRATIONS_DIR, logger: silentLogger });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('records every migration with its checksum', async () => {
    const files = await readMigrations(MIGRATIONS_DIR);
    const result = await pool.query('select version, checksum from ops.schema_migrations order by version');
    expect(result.rows).toEqual(files.map(({ version, checksum }) => ({ version, checksum })));
  });

  it('applies nothing the second time', async () => {
    await expect(migrate({ pool, dir: MIGRATIONS_DIR, logger: silentLogger })).resolves.toEqual([]);
  });

  it('refuses an applied migration whose file changed, and applies nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ops-pulse-migrations-'));
    await copyFile(join(MIGRATIONS_DIR, '0002_indexes.sql'), join(dir, '0002_indexes.sql'));
    await writeFile(join(dir, '0001_init.sql'), '-- edited after it was applied\n');
    await writeFile(join(dir, '0003_extra.sql'), 'create table ops.must_not_exist (id int);');
    await expect(migrate({ pool, dir, logger: silentLogger })).rejects.toThrow(/nothing was applied/);
    const leftover = await pool.query("select to_regclass('ops.must_not_exist') as name");
    expect(leftover.rows[0]).toEqual({ name: null });
  });
});
