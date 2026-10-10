import { fileURLToPath } from 'node:url';

/**
 * MIGRATIONS_DIR, or <repo>/db/migrations. This file is three levels below apps/api in both
 * src/scripts (tsx) and dist/scripts (compiled), so the default resolves the same in both.
 */
export function migrationsDir(env: Record<string, string | undefined>): string {
  const configured = env.MIGRATIONS_DIR?.trim();
  if (configured) return configured;
  return fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
}
