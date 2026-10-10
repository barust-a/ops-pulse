# Shared ESLint base

`base.mjs` holds the ESLint rules that do not depend on a stack, so all TypeScript and JavaScript
in a project follows the same rules. Every stack's `eslint.config.mjs` spreads it, then adds only
its framework preset and its own blocks (architecture layers, framework exemptions).

The repository root has no `package.json` or `node_modules`, so `base.mjs` imports no package:
the stack passes in the plugins it installed. The stack stays independent and can be renamed or
deleted, while this folder stays.

## What's shared

| Files | Rules |
|-------|-------|
| `**/*.{ts,tsx,mts,cts}` | typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` with `projectService`, `switch-exhaustiveness-check`, `consistent-type-assertions` `never` (no `as T` or `<T>x`; `as const` allowed), `@typescript-eslint/no-shadow`, `func-style` declaration (`allowTypeAnnotation`), `prefer-arrow-callback`, `@typescript-eslint/no-use-before-define` (`functions: false`); `non-nullable-type-assertion-style` off (its fix produces `x!`) |
| `**/*.{js,mjs,cjs,jsx}` | The same typescript-eslint presets with `disableTypeChecked` (every rule that needs no type information), `@typescript-eslint/no-shadow`, `func-style` declaration (`allowTypeAnnotation`), `prefer-arrow-callback`, `@typescript-eslint/no-use-before-define` (`functions: false`), `no-undef`, `no-var`, `prefer-const`, `prefer-rest-params`, `prefer-spread` |
| all (`linterOptions`) | `reportUnusedDisableDirectives: 'error'`: a disable comment that no longer silences anything fails the run (ESLint only warns by default) |
| `**/*.config.*`, `**/*.setup.*` (JS) | Node globals: `globals.node` when the `globals` package is passed, else `__dirname`, `__filename`, `require`, `module`, `exports`, `process`, `console` |
| all | sonarjs `recommended` plus `no-inconsistent-returns`, `no-built-in-override`, `strings-comparison`, `expression-complexity`, `no-nested-incdec`; `sonarjs/cognitive-complexity` 10 (Sonar's default is 15) and `complexity` (cyclomatic) 15; `max-depth` 4; no default export (both `export default` and `export { x as default }`); at most three positional parameters (`PARAMETER_CAP`, below) |
| TS and JS, when `unicorn` is passed | the unicorn rules SonarQube runs as its own (`SONAR_UNICORN_RULES`, S7718–S7787) as errors, never unicorn's whole `recommended` set; `no-named-default` off (its fix is `export default x`, which the default-export ban forbids) |
| all but `**/*.{test,spec}.*` | `max-lines` 400 and `max-lines-per-function` 50 (blank lines and comments skipped), `max-nested-callbacks` 3, `sonarjs/no-duplicate-string` |
| `**/*.{tsx,jsx}` (`COMPONENT_FILES`) but tests | `max-lines-per-function` 150: a long JSX return is markup, not logic, and cognitive complexity still catches a component that does too much |
| `**/*.config.{js,mjs,cjs,ts,mts,cts}` | default exports allowed: tools load their config through it; the parameter cap still applies |

## Exports

- `sharedConfig({ tseslint, sonarjs, globals?, unicorn?, tsconfigRootDir })`: the blocks above. Spread
  them into `defineConfig([...])` from `eslint/config` (ESLint ≥ 9.28: `defineConfig` needs 9.22,
  `func-style`'s `allowTypeAnnotation` 9.28), which resolves their
  `extends` key. `tsconfigRootDir` is the folder holding the stack's `tsconfig.json`, usually
  `import.meta.dirname`.
- `restrictedSyntax(...selectors)`: the `no-restricted-syntax` entry with the default-export
  ban and the parameter cap, plus your selectors. A later block's `no-restricted-syntax` **replaces** the earlier
  selectors for the files it matches, so always add selectors through this helper.
- `allowDefaultExport(files)`: a block that lifts the default-export ban for files a framework
  loads through their default export (expo-router `app/**`, Next.js `pages/**`). Put it after
  every block that sets `no-restricted-syntax` for those files.
- `unicornRules(unicorn)`: the `SONAR_UNICORN_RULES` as errors, under the names the installed
  unicorn uses (see [Unicorn versions](#unicorn-versions)). `sharedConfig` calls it when
  `unicorn` is passed.
- `SONAR_UNICORN_RULES`, `UNICORN_RULE_ALIASES`, `UNICORN_RULES_ADDED_AFTER`: the unicorn rule
  list and how its names resolve.
- `TS_FILES`, `JS_FILES`, `TEST_FILES`, `COMPONENT_FILES`, `TOOL_CONFIG_FILES`,
  `NODE_SCRIPT_FILES`, `NODE_GLOBALS`, `NO_DEFAULT_EXPORT`: the globs and values the blocks use.
- `PARAMETER_CAP`: the `no-restricted-syntax` entry reporting a function, method, overload,
  function type or interface method with more than three positional parameters (AGENTS.md §3).
  It is a selector rather than `max-params` so it can exempt a constructor, whose injected
  dependencies arrive positionally, and an `it.each` callback, which receives a table row
  spread; a TypeScript `this` parameter does not count.

## Plugging in a stack

The stack installs `eslint`, `typescript-eslint` and `eslint-plugin-sonarjs` as dev
dependencies, plus `eslint-plugin-unicorn` (recommended; see [Unicorn versions](#unicorn-versions)), and writes its config as `eslint.config.mjs`: ESM can import `base.mjs` on every
Node version ESLint 9 supports, while `require()` of an ES module needs Node ≥ 20.19 / 22.12.
A NestJS stack, for example:

```js
import js from '@eslint/js';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { sharedConfig } from '../../tools/eslint/base.mjs';

export default defineConfig([
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  ...sharedConfig({ tseslint, sonarjs, globals, unicorn, tsconfigRootDir: import.meta.dirname }),
  {
    files: ['src/**/*.ts'],
    // Nest modules are empty classes that only carry a decorator.
    rules: { '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }] },
  },
]);
```

Nest needs no default export, so it exempts nothing. A stack without a framework preset adds
`@eslint/js` `recommended` itself, as above; `stacks/react-native` gets those core rules from
`eslint-config-expo`.

Make the lint script cover the stack's own JS files too and fail on a single warning
(`expo lint . --max-warnings=0`, `eslint . --max-warnings=0`): a warning that passes the gate is
ignored, and the warnings pile up. Pass `--max-warnings=0` to every ESLint run, lint-staged
included, and widen the lint-staged ESLint pattern to `*.{js,mjs,cjs,jsx,ts,tsx}`.

If the stack folder moves to another depth below the repository root, fix the
`../../tools/eslint/base.mjs` import path.

## Unicorn versions

`unicorn` is optional: without it, `sharedConfig` adds no unicorn block. Pin the release that
matches the stack's ESLint major, exactly (`npm install -D -E`):

| ESLint | eslint-plugin-unicorn |
|--------|-----------------------|
| 9 (≥ 9.38) | `65.0.1`, the last release for ESLint 9 (`stacks/react-native`, Expo 57) |
| 10 (≥ 10.4) | 66 or later (77 needs Node ≥ 22) |

Unicorn renames rules between releases, so `unicornRules` resolves each `SONAR_UNICORN_RULES`
name against the rules of the plugin actually passed: it keeps the name when that release has
it as an active (non-deprecated) rule, otherwise it tries the names in `UNICORN_RULE_ALIASES`:

| Name in the list | Other name | Why |
|------------------|------------|-----|
| `no-for-each` | `no-array-for-each` | Renamed in unicorn 76, which dropped the old name outright |

Every other listed name is the same in 65.0.1 and 77.0.0. Deprecated rules are skipped because
unicorn leaves them as no-op stubs. A name that resolves to nothing throws an `Error` naming the
rules and the unicorn version, rather than silently linting less: add the new name to
`UNICORN_RULE_ALIASES` if unicorn renamed the rule, or add the rule to
`UNICORN_RULES_ADDED_AFTER` if it is newer than 65.0.1, so stacks still on 65.0.1 skip it. That
list is empty today.

## Checks

`tools/agent-harness/eslint-base.test.mjs` checks how `sharedConfig` assembles its blocks, how
unicorn rule names resolve,
that every `stacks/*/eslint.config.*` imports `tools/eslint/base.mjs`, and that every ESLint run
in a stack's `package.json` (scripts and lint-staged) passes `--max-warnings=0`. Whether the rules bite is
checked by each stack's `npm run lint`, and in `stacks/react-native` by
`src/lint-rules.test.ts`, which lints fixtures through the stack's config and asserts what each
house rule reports.
