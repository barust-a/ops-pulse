# Base agent guide

Language-agnostic engineering rules for AI coding agents, and for the people who review their work. Examples are in TypeScript/JavaScript.

The rules were distilled in October 2026 from:
- Fowler's *Refactoring*;
- Beck, Feathers, Ousterhout, Martin, McConnell, Hunt & Thomas, the Gang of Four and Evans;
- Google's engineering practices, OWASP and the TypeScript team's documentation;
- research from 2025–2026 on agent instruction files.

Every source is listed in `sources.md`.

## What's here

| File | Role |
|---|---|
| `agents-base.md` | The full, unpruned base rule set: workflow, change discipline, hard limits, verification, and the core rules per topic. The template's root `AGENTS.md` is a merged, pruned version of it; keep this copy as the upstream source when you prune or re-derive rules |
| `naming.md` · `clean-code.md` · `architecture.md` · `refactoring.md` · `design-patterns.md` · `testing.md` · `performance.md` · `security.md` · `interfaces-and-data.md` · `typescript.md` · `frontend.md` · `collaboration.md` · `code-hygiene.md` | Companion guides that agents open on demand. The map in the root `AGENTS.md` §11 says when |
| `sources.md` | Bibliography |

### Why two layers

An instruction file is loaded into every session. Long files cost tokens, and agents follow them less reliably:
- Anthropic recommends keeping each file under 200 lines.
- Codex reads at most 32 KiB of combined `AGENTS.md`.
- An ETH Zurich study (2026) found that context files add about 20% inference cost, with no reliable gain in success.

So `AGENTS.md` holds only short, checkable rules, and the depth lives in the guides.

## Adopting it in a project

A project bootstrapped from the template already has this folder and a root `AGENTS.md` derived from `agents-base.md`. To fit it to the project:

1. **Prune the root `AGENTS.md` further against the project's own tooling.** Delete every line a linter, compiler or hook in the project enforces, and every line that wouldn't change what an agent does there. Fill its project-specific parts with:
   - stack and versions;
   - exact commands: install, typecheck, lint, test one file, test all, build;
   - any non-obvious layout;
   - files that must never be edited by hand;
   - the ask-first list;
   - deliberate departures from the base.
2. **Keep the guides at `docs/guides/base/`.** `agents-base.md` and the map in the root `AGENTS.md` §11 refer to that path; if you move them, update both.
3. **Wire it into Claude Code.** Claude Code reads `AGENTS.md` only when no `CLAUDE.md` exists. If the project has a `CLAUDE.md`, put the line `@AGENTS.md` in it; a sentence like "follow AGENTS.md" does not load the file.
4. **Keep the root `AGENTS.md` under 200 lines and 32 KiB** in total.
5. **Add language-specific rules where that language lives**, as a nested `AGENTS.md` with a sibling `CLAUDE.md` containing `@AGENTS.md`, and keep the depth in `docs/guides/<language>/README.md` (for example `docs/guides/python/README.md`).
6. **Keep the tooling that backs the hard limits.** It lives in `tools/agent-harness/` and `.claude/hooks/`; extend it rather than restating a limit in prose.

## Maintaining it

- **Keep the rule list honest.** When agents repeat a mistake, add one checkable line. When a linter, hook or CI check starts enforcing a rule, delete that line.
- **Back the hard limits with hooks or CI where you can,** because instruction files are only advisory (the template ships them in `tools/agent-harness/` and `.claude/hooks/`). The hard limits are: no weakened tests, no secrets, no `--no-verify`.
- **Re-check the version facts about once a year.** They are in `typescript.md` and `security.md`: TypeScript 6/7, Node LTS, ECMAScript 2025–2027, OWASP Top 10:2025.
- **Send improvements upstream.** When a change proves useful in one project, contribute it back to the template.
