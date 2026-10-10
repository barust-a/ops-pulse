import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { git, repoRoot, repoRootOf, withoutLocalGitVariables } from './git.mjs';

const harness = dirname(fileURLToPath(import.meta.url));

describe('withoutLocalGitVariables', () => {
  it('drops the variables git lists as local to a repository and keeps the rest', () => {
    const env = {
      GIT_DIR: '/repo/.git/worktrees/wt',
      GIT_INDEX_FILE: '/repo/.git/worktrees/wt/index',
      GIT_WORK_TREE: '/repo-wt',
      GIT_AUTHOR_NAME: 'Ada',
      PATH: '/usr/bin',
    };

    assert.deepEqual(withoutLocalGitVariables(env), { GIT_AUTHOR_NAME: 'Ada', PATH: '/usr/bin' });
  });
});

// A pre-commit hook in a linked worktree inherits absolute GIT_DIR and GIT_INDEX_FILE. Every
// child git the harness starts used to act on that repository instead of the one in its cwd.
describe('git, under the environment of a hook in a linked worktree', () => {
  /** @type {string} */
  let scratch;
  /** @type {string} */
  let main;
  /** @type {string} */
  let worktree;
  /** @type {NodeJS.ProcessEnv} */
  let hookEnv;

  before(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'harness-git-')));
    main = join(scratch, 'main');
    worktree = join(scratch, 'wt');
    git(['init', '--quiet', main], { cwd: scratch });
    const identity = ['-c', 'user.name=harness', '-c', 'user.email=harness@example.invalid'];
    git([...identity, 'commit', '--quiet', '--allow-empty', '--message', 'init'], { cwd: main });
    git(['worktree', 'add', '--quiet', worktree], { cwd: main });
    const gitDir = join(main, '.git', 'worktrees', 'wt');
    hookEnv = { ...process.env, GIT_DIR: gitDir, GIT_INDEX_FILE: join(gitDir, 'index') };
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('finds the repository of its working directory', () => {
    assert.equal(repoRootOf(harness, hookEnv), repoRoot);
  });

  it('initialises a fixture repository without making the committed one bare', () => {
    const fixture = mkdtempSync(join(scratch, 'fixture-'));

    git(['init', '--quiet'], { cwd: fixture, env: hookEnv });

    assert.ok(existsSync(join(fixture, '.git')), 'the fixture got its own repository');
    assert.equal(git(['config', '--get', 'core.bare'], { cwd: main }).trim(), 'false');
  });

  it('stages a fixture file in the fixture repository, not in the index being committed', () => {
    const fixture = mkdtempSync(join(scratch, 'fixture-'));
    git(['init', '--quiet'], { cwd: fixture, env: hookEnv });
    writeFileSync(join(fixture, 'fixture.sql'), 'select 1;\n');

    git(['add', 'fixture.sql'], { cwd: fixture, env: hookEnv });

    assert.equal(git(['ls-files'], { cwd: fixture }).trim(), 'fixture.sql');
    assert.equal(git(['ls-files'], { cwd: worktree }).trim(), '');
  });
});
