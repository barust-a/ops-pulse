import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Fix this path if the app folder moves to another depth below the repository root.
import { sharedConfig } from '../../tools/eslint/base.mjs';

const FRAMEWORKS = ['express', 'express-*', 'pg', 'pino', 'pino-*', 'helmet', 'cors', 'swagger-*'];
const SECURITY_LIBS = ['bcrypt', 'jsonwebtoken'];
const PORTS = '**/ports/**';
const ADAPTERS = '**/adapters/**';
const HTTP = '**/http/**';
const SEED = '**/seed/**';
const APP = '**/app.js';

/**
 * Architecture as lint: each layer imports only the layers inside it.
 * domain ← ports ← adapters / http ← app.ts (composition root) ← server.ts / scripts.
 * @param {string} message
 * @param {string[]} group
 */
function layerBan(message, group) {
  return { 'no-restricted-imports': ['error', { patterns: [{ group, message }] }] };
}

export default defineConfig([
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...sharedConfig({ tseslint, sonarjs, globals, unicorn, tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/domain/**/*.ts'],
    rules: layerBan('src/domain is pure: no framework, database, HTTP or outer layer.', [
      ...FRAMEWORKS,
      ...SECURITY_LIBS,
      PORTS,
      ADAPTERS,
      HTTP,
      SEED,
      APP,
    ]),
  },
  {
    files: ['src/ports/**/*.ts'],
    rules: layerBan('src/ports declares interfaces over the domain only.', [
      ...FRAMEWORKS,
      ...SECURITY_LIBS,
      ADAPTERS,
      HTTP,
      APP,
    ]),
  },
  {
    files: ['src/adapters/**/*.ts'],
    rules: layerBan('Adapters implement ports; they never reach into the HTTP layer.', [
      'express',
      'express-*',
      HTTP,
      APP,
    ]),
  },
  {
    files: ['src/http/**/*.ts'],
    ignores: ['src/http/**/*.test.ts'],
    rules: layerBan('The HTTP layer talks to ports; app.ts wires the adapters in.', [
      'pg',
      ...SECURITY_LIBS,
      ADAPTERS,
      SEED,
    ]),
  },
  {
    files: ['src/seed/**/*.ts'],
    rules: layerBan('The seed generator is pure: scripts/seed.ts writes it to the database.', [
      ...FRAMEWORKS,
      ...SECURITY_LIBS,
      HTTP,
      ADAPTERS,
    ]),
  },
]);
