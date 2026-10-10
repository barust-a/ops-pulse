// Claude Code PreToolUse hook for Edit/Write/MultiEdit: refuses changes to a SQL migration that
// git already tracks, since a committed migration may already be applied somewhere. A migration
// is any .sql file below a directory named exactly "migrations" (Prisma, Supabase, plain SQL…).
// Reads the hook JSON on stdin; exit 2 blocks the call and shows stderr to Claude.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMMUTABLE = 'Applied migrations are immutable: create a new migration instead.';
const MIGRATION = /(?:^|\/)migrations\/(?:[^/]+\/)*[^/]+\.sql$/;

/**
 * @param {string} filePath
 * @param {(filePath: string) => boolean} isTracked asked only for a migration file
 * @returns {string | null} why the edit is refused, or null to let it run
 */
export function checkPath(filePath, isTracked) {
  if (!MIGRATION.test(filePath.replaceAll('\\', '/'))) return null;
  return isTracked(filePath) ? IMMUTABLE : null;
}

// Asked from the file's own folder so a worktree answers for itself; a folder that does not
// exist yet holds a new migration.
/** @param {string} filePath */
function isTrackedInGit(filePath) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', basename(filePath)], {
    cwd: dirname(filePath),
    stdio: 'ignore',
  });
  return result.status === 0;
}

function main() {
  let filePath;
  try {
    filePath = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.file_path;
  } catch {
    return 0;
  }
  if (typeof filePath !== 'string' || filePath === '') return 0;
  const absolute = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd(), filePath);
  const reason = checkPath(absolute, isTrackedInGit);
  if (reason === null) return 0;
  process.stderr.write(`${reason}\n`);
  return 2;
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exitCode = main();
