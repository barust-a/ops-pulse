import { readFileSync } from 'node:fs';

import { z } from 'zod';

const PackageSchema = z.object({ version: z.string() });

/**
 * The API version from package.json, read once at startup. The file sits one level above both
 * src/ (tsx) and dist/ (compiled), so the same relative URL works in both.
 */
export function readVersion(): string {
  const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return PackageSchema.parse(raw).version;
}
