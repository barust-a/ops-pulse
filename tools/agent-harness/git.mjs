import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// git hands its hooks GIT_DIR, GIT_INDEX_FILE and the other variables this command lists, as
// absolute paths in a linked worktree. A child git that inherits them acts on the repository
// being committed, whatever its cwd: `rev-parse --show-toplevel` answers with the cwd, `git add`
// in a fixture writes to the real index, and `git init` in a fixture guesses that repository is
// bare and sets core.bare = true in its shared config. git asks for the list itself, so it stays
// right for the installed version.
const LOCAL_GIT_VARIABLES = new Set(
  execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean),
);

/**
 * The environment minus git's repository-local variables, for a child process that must find
 * its repository from its own working directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function withoutLocalGitVariables(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !LOCAL_GIT_VARIABLES.has(name)));
}

/**
 * Runs git on the repository found from `cwd`, never on one a parent git exported. `env` is the
 * environment to start from; tests pass a hook's to reproduce it.
 * @param {string[]} args
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} options
 * @returns {string} what git printed on stdout
 */
export function git(args, { cwd, env = process.env }) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: withoutLocalGitVariables(env) });
}

/**
 * The top of the repository holding `from`.
 * @param {string} from
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function repoRootOf(from, env = process.env) {
  return git(['rev-parse', '--show-toplevel'], { cwd: from, env }).trim();
}

/** The repository this harness checks. */
export const repoRoot = repoRootOf(dirname(fileURLToPath(import.meta.url)));

/**
 * Every file of the repository, tracked or not yet, minus what .gitignore excludes.
 * @returns {string[]} paths relative to `repoRoot`
 */
export function repoFiles() {
  return git(['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot })
    .split('\n')
    .filter(Boolean);
}
