# Commits, reviews, documentation and agent files

Read when: committing, writing a PR description, reviewing code, writing or updating docs, or editing an `AGENTS.md`/`CLAUDE.md`.
Project rules in `AGENTS.md` override this file.

## Commits

- **One logical change per commit.** Every commit builds and passes the tests.
- **Keep refactoring and behavior changes in separate commits** (`refactor:` vs `feat:`/`fix:`).
- **Conventional Commits:** `<type>[optional scope]: <description>`.
  - `feat` → MINOR version bump; `fix` → PATCH.
  - Other types: `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `style`, `test`.
  - `!` or a `BREAKING CHANGE:` footer → MAJOR.
- **Subject line:**
  - imperative mood: it completes "If applied, this commit will…";
  - about 50 characters, no trailing period.
- **Body:**
  - separated from the subject by a blank line;
  - wrapped at 72 characters;
  - explains *what* and *why*, not *how*.
- **Never commit** secrets, `.env` files, build output or untracked generated files.
- **Never bypass hooks** (`--no-verify`) without explicit approval. If a hook fails, fix the cause.

## Changes and pull requests

- **Keep each change small and self-contained, doing one thing.** Reviewers handle small changes faster and more thoroughly (Google eng-practices, *Small CLs*).
- **Split large work into a series:** refactor → feature → cleanup.
- **The description covers:**
  - what changed;
  - why;
  - how it was verified (commands and results);
  - what was not verified;
  - risks or rollout notes;
  - links to the issue or spec.
- **Update docs, tests and examples in the same change** as the code they describe.

## Code review

- **Approve once the change definitely improves the overall code health** of the system, even if it isn't perfect. There is no perfect code, only better code. Don't block on personal preference (Google, *The Standard of Code Review*).
- **Look at:**
  - **design:** does this belong here?
  - **functionality:** edge cases, concurrency.
  - **complexity:** can it be understood quickly? Any speculative generality?
  - **tests:** are they correct, and would they fail if the code broke?
  - **naming.**
  - **comments:** do they say *why*?
  - **style-guide conformance** and **documentation.**
  - **what is good:** say so.
- **Ground rules:**
  - Technical facts and data overrule opinions.
  - The style guide is the authority on style.
  - Prefix optional suggestions with "Nit:".
- **Extra checks for agent-written code:**
  - nothing outside the task changed;
  - no test was weakened, skipped or rewritten to pass;
  - no new dependency the user didn't approve;
  - no silenced type or lint check;
  - no leftover stubs, TODOs, debug output or comments that narrate the code.

## Documentation

- **Docs live in the repository, next to the code,** and change in the same PR (docs-as-code).
- **Diátaxis:** each page is exactly one type. Don't mix types on one page.
  - **Tutorial:** learning by doing.
  - **How-to guide:** reaching a goal.
  - **Reference:** facts, generated from code where possible.
  - **Explanation:** understanding the *why*.
- **README:**
  - what the project is and why it is useful;
  - how to install, run and test it;
  - where to get help, and who maintains it;
  - links out for anything deeper.
- **Architecture Decision Records** (Nygard): one numbered file per significant decision.
  - Sections: Title, Status (proposed / accepted / deprecated / superseded), Context, Decision ("We will…"), Consequences.
  - Never rewrite an accepted ADR. Supersede it with a new one.
  - Keep them in `docs/adr/`, indexed by the table in its README; start from `docs/templates/adr-template.md`. A measured value (a timeout, a weight, a model choice) deserves one as much as a structural choice: record the measurement it rests on.
- **Comments vs docs:** comments explain *why* next to the code; docs explain how to use the system and why it is shaped this way.

## Maintaining agent instruction files

- **Write only what an agent cannot infer from the code:**
  - commands with their flags;
  - conventions that differ from defaults;
  - boundaries;
  - gotchas.

  Skip what linters and formatters already enforce, and generic advice the model follows anyway.
- **Make each rule concrete and checkable.** "Run `npm test` before committing", not "test your changes".
  - Explain the *why* in a few words.
  - Emphasize (MUST, IMPORTANT) only a very few lines.
  - Pair every "never" with what to do instead.
- **Keep the always-loaded file short, with critical rules first.**
  - Anthropic recommends under 200 lines per file.
  - Codex reads at most 32 KiB of combined AGENTS.md files by default and silently drops the rest.
  - Move long reference material into linked docs that agents open on demand: "Read `docs/…` when …".
- **Evolve it like code:**
  - Add a rule when agents repeat a mistake.
  - Delete a rule once a tool enforces it.
  - Prune stale lines; agents follow wrong instructions too.
- **Back every hard "never" with a hook or a CI check.** Instruction files are advisory; hooks and CI are enforced.
- **Wiring:**
  - Claude Code loads `AGENTS.md` only when no `CLAUDE.md` exists. Otherwise, put the line `@AGENTS.md` in `CLAUDE.md`; a sentence saying "follow AGENTS.md" is not enough.
  - Codex, Copilot and Cursor read `AGENTS.md`. Gemini CLI reads `GEMINI.md` unless `AGENTS.md` is listed in `context.fileName` in its `settings.json`.
  - Nested `AGENTS.md` files apply to their subtree; the closest one wins.
