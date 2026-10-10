# Agent harness

Tests that keep the agent setup honest. Instruction files are only advice. These tests and the
guard hooks in `.claude/hooks/` turn that advice into checks that fail. They use only Node ≥ 22
built-ins (`node:test`), so you install nothing, and they import nothing from the apps. In Ops
Pulse the stack checks (shared ESLint base, hygiene gates) apply to the Node apps in `apps/*`.

## What it checks

| File | Checks |
|------|--------|
| `agent-harness.test.mjs` | Every `AGENTS.md` has a sibling `CLAUDE.md` with a line that is exactly `@AGENTS.md`. The root `AGENTS.md` has at most 200 lines and nested ones at most 150. Each root→folder `AGENTS.md` chain fits in Codex's 32 KiB `project_doc_max_bytes`. Relative links and `@path` imports in `AGENTS.md`/`CLAUDE.md` point to files that exist. `.claude/settings.json` registers both guard hooks. |
| `guard-bash.test.mjs` | `.claude/hooks/guard-bash.mjs` blocks hook bypasses (the no-verify flag, `-n`, `core.hooksPath`, `HUSKY=0`) and force-pushes. Commit messages and heredocs that only mention them pass. |
| `eslint-base.test.mjs` | `tools/eslint/base.mjs` lints TS type-aware and JS with the same non-type-aware rules, rejects every TS type assertion but `as const`, keeps the default-export ban when a stack adds selectors, exempts tool config files last, and enables the SonarQube unicorn rules under the names the passed plugin uses, throwing on a name it cannot resolve. It caps cognitive complexity at 10 and cyclomatic complexity at 15 on every file, positional parameters at 3 (a `no-restricted-syntax` selector that exempts constructors and `it.each` callbacks, kept where default exports are allowed), functions at 50 lines (150 in components) and nested callbacks at 3, the last two outside tests, makes named functions declarations (`func-style`, `prefer-arrow-callback`), and reports a const, class or enum read before its definition but not a call to a hoisted function (`no-use-before-define`). Unused disable directives are errors. Every `apps/*/eslint.config.*` imports it, and every ESLint run in an `apps/*/package.json` (scripts and lint-staged) passes `--max-warnings=0`. |
| `guard-migrations.test.mjs` | `.claude/hooks/guard-migrations.mjs` blocks edits to any git-tracked `.sql` file below a directory named `migrations`. New, untracked migrations and `.sql` files outside such a directory are allowed. |
| `hygiene.test.mjs` | Every `apps/*` Node app pins knip and jscpd exactly; has the `hygiene`, `hygiene:knip`, `hygiene:dup` and `hygiene:dup:update` scripts, none with `--fix` and only the last re-recording the baseline; runs jscpd with the shared thresholds against a committed `.jscpd-baseline.json`, generated `*.generated.*` files out; and runs knip with `treatConfigHintsAsErrors` and without `ignoreExportsUsedInFile` (`docs/guides/base/code-hygiene.md`). |
| `git.test.mjs` | `git.mjs` drops the variables git lists as repository-local (`git rev-parse --local-env-vars`). Under the environment of a hook in a linked worktree, a child git still finds this repository, and a fixture's `git init` and `git add` stay in the fixture. |

The checks find files with `git ls-files --cached --others --exclude-standard` and skip `docs/`,
whose guides hold reference copies of instruction files. Each failure message says how to fix it.

Every child `git` runs through `git.mjs`. git exports `GIT_DIR`, `GIT_INDEX_FILE` and their
kin to its hooks, as absolute paths in a linked worktree, and a child git that inherits them acts
on the repository being committed: the root comes out wrong, a fixture `git add` lands in the
real index, and a fixture `git init` sets `core.bare = true` in its shared config.

## Run

```sh
node --test "tools/agent-harness/*.test.mjs"
```

Run it from the repository root. Keep the quotes so that Node expands the glob: Node ≥ 22 does
not accept a bare directory as the argument. The pre-commit hook and the `agent-harness` CI job
run the same command.

## Extend

- **New rule for instruction files:** add an `it(...)` to `agent-harness.test.mjs` that builds a
  list of violations, each written as the fix to apply, and ends with
  `assert.deepEqual(violations, [])`.
- **New guard hook:** add `.claude/hooks/<name>.mjs`. It reads the hook JSON on stdin, exits 2
  with the reason on stderr to block, and exits 0 otherwise, including on input it cannot parse.
  Export its pure check function and test it in `<name>.test.mjs`, plus one end-to-end run
  through `spawnSync`. Register it in `.claude/settings.json` and add it to the `guards` list in
  `agent-harness.test.mjs`.
- **A check that runs git, or a process that does:** call `git()` from `git.mjs`, or pass
  `withoutLocalGitVariables()` as the child environment.
- Use plain `.mjs` with JSDoc types and Node built-ins only. Add no dependencies.
