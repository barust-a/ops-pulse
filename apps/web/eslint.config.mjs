import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Fix this path if the app folder moves to another depth below the repository root.
import { TEST_FILES, sharedConfig } from '../../tools/eslint/base.mjs';

/**
 * Architecture as lint: pages → features → api/state → ui. A layer imports only the layers to
 * its right; `i18n` is a leaf every layer may read.
 * @param {string[]} layers the folders the files must not import
 * @param {string} message why
 */
function forbidLayers(layers, message) {
  return [
    'error',
    { patterns: [{ group: layers.flatMap((layer) => [`**/${layer}/**`, `**/${layer}`]), message }] },
  ];
}

export default defineConfig([
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...sharedConfig({ tseslint, sonarjs, globals, unicorn, tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-imports': forbidLayers(
        ['api', 'state', 'features', 'pages', 'app'],
        'src/ui holds presentational building blocks only (AGENTS.md: pages → features → api/state → ui).',
      ),
    },
  },
  {
    files: ['src/api/**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'react', message: 'src/api is plain TypeScript: no React.' }],
          patterns: [
            {
              group: ['**/state/**', '**/features/**', '**/pages/**', '**/app/**', '**/ui/**'],
              message: 'src/api depends on nothing but zod and the platform.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/state/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-imports': forbidLayers(
        ['features', 'pages', 'app', 'ui'],
        'src/state may use src/api only (AGENTS.md: pages → features → api/state → ui).',
      ),
    },
  },
  {
    files: ['src/features/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-imports': forbidLayers(
        ['pages', 'app', 'test'],
        'Features are composed by pages, never the reverse.',
      ),
    },
  },
  {
    files: ['src/pages/**/*.{ts,tsx}'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-imports': forbidLayers(['app', 'test'], 'Pages are composed by src/app.'),
    },
  },
]);
