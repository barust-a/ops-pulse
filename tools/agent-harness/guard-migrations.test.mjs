import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPath } from '../../.claude/hooks/guard-migrations.mjs';
import { git, withoutLocalGitVariables } from './git.mjs';

const script = fileURLToPath(new URL('../../.claude/hooks/guard-migrations.mjs', import.meta.url));

const immutable = /^Applied migrations are immutable: create a new migration instead\.$/;
const tracked = () => true;
const untracked = () => false;
const mustNotAsk = () => {
  throw new Error('isTracked must not be called');
};

describe('checkPath', () => {
  for (const filePath of [
    'prisma/migrations/20260917120000_init/migration.sql',
    'packages/persistence/prisma/migrations/20260917120000_init/migration.sql',
    '/Users/me/app/prisma/migrations/20260917120000_init/migration.sql',
    String.raw`C:\work\app\prisma\migrations\20260917120000_init\migration.sql`,
    String.raw`prisma\migrations\20260917120000_init\migration.sql`,
    'db/migrations/0001_init.sql',
    'migrations/0001_init.sql',
    '/srv/app/supabase/migrations/20260101000000_users.sql',
    String.raw`D:\app\db\migrations\0001_init.sql`,
  ]) {
    it(`blocks an edit to the tracked migration ${filePath}`, () => {
      assert.match(checkPath(filePath, tracked) ?? '', immutable);
    });
  }

  it('allows a migration that is not committed yet', () => {
    assert.equal(checkPath('db/migrations/0002_new.sql', untracked), null);
    assert.equal(
      checkPath('prisma/migrations/20261005120000_new/migration.sql', untracked),
      null,
    );
  });

  it('passes the path it checks to isTracked', () => {
    /** @type {string[]} */
    const seen = [];
    checkPath('/repo/db/migrations/0001_init.sql', (path) => {
      seen.push(path);
      return false;
    });
    assert.deepEqual(seen, ['/repo/db/migrations/0001_init.sql']);
  });

  for (const filePath of [
    'prisma/schema.prisma',
    'prisma/migrations/migration_lock.toml',
    'prisma/migrations/20260917120000_init/notes.md',
    'db/migrations/README.md',
    'src/migration.sql',
    'db/schema.sql',
    'db/migrations.sql',
    'db/old_migrations/0001_init.sql',
    'db/migrations_backup/0001_init.sql',
    'db/migrations/0001_init.sql.bak',
  ]) {
    it(`allows ${filePath} without asking git`, () => {
      assert.equal(checkPath(filePath, mustNotAsk), null);
    });
  }
});

/**
 * @param {string} projectDir
 * @param {string} filePath
 */
const run = (projectDir, filePath) =>
  spawnSync(process.execPath, [script], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }),
    encoding: 'utf8',
    env: { ...withoutLocalGitVariables(), CLAUDE_PROJECT_DIR: projectDir },
  });

describe('guard-migrations hook, end to end', () => {
  /** @type {string} */
  let repo;

  /**
   * @param {string} relative
   * @param {{ stage: boolean }} options
   */
  const addFile = (relative, { stage }) => {
    const absolute = join(repo, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, 'select 1;\n');
    if (stage) git(['add', relative], { cwd: repo });
  };

  before(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'guard-migrations-')));
    git(['init', '--quiet'], { cwd: repo });
    addFile('prisma/migrations/20260917120000_init/migration.sql', { stage: true });
    addFile('db/migrations/0001_init.sql', { stage: true });
    addFile('db/schema.sql', { stage: true });
    addFile('db/migrations/0002_untracked.sql', { stage: false });
  });

  after(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('exits 2 for a tracked Prisma migration', () => {
    const result = run(repo, join(repo, 'prisma/migrations/20260917120000_init/migration.sql'));
    assert.equal(result.status, 2);
    assert.match(result.stderr.trim(), immutable);
  });

  it('exits 2 for a tracked migration in a non-Prisma migrations folder', () => {
    const result = run(repo, join(repo, 'db/migrations/0001_init.sql'));
    assert.equal(result.status, 2);
    assert.match(result.stderr.trim(), immutable);
  });

  it('exits 2 for a tracked migration given relative to the project', () => {
    assert.equal(run(repo, 'db/migrations/0001_init.sql').status, 2);
  });

  it('exits 0 for an untracked migration file', () => {
    const result = run(repo, join(repo, 'db/migrations/0002_untracked.sql'));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  it('exits 0 for a migration in a folder that does not exist yet', () => {
    const result = run(repo, join(repo, 'prisma/migrations/29991231000000_not_yet/migration.sql'));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
  });

  it('exits 0 for a tracked .sql file outside any migrations folder', () => {
    assert.equal(run(repo, join(repo, 'db/schema.sql')).status, 0);
  });

  it('exits 0 for input it does not understand', () => {
    assert.equal(spawnSync(process.execPath, [script], { input: 'nope' }).status, 0);
    assert.equal(
      spawnSync(process.execPath, [script], {
        input: JSON.stringify({ tool_name: 'Edit', tool_input: {} }),
      }).status,
      0,
    );
  });
});
