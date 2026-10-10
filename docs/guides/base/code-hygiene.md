# Code hygiene

Read when: a knip or jscpd finding fails a run, writing an exception, re-recording the duplication baseline, bumping either tool, adding the gates to a new stack, or setting up an unattended cleanup loop.
Stack-agnostic. `stacks/react-native` is the reference wiring and `tools/agent-harness/hygiene.test.mjs` checks every stack against it. Project rules in `AGENTS.md` override this file.

## Rules that always apply

1. Dead code and copy-paste are gated on every push: **knip at zero findings**, **jscpd at zero new clones** against a committed baseline.
2. A finding in a file you did not touch is another session's: say so, do not fix it, and do not silence it.
3. An exception lives in configuration with a comment giving its reason, never as an inline marker (`// jscpd:ignore`, `@lintignore`, `eslint-disable`). Only a person widens an exception list.
4. Neither tool runs with `--fix` or `--update-baseline` in CI or in a hook. `knip --fix` is allowed only in a supervised session, followed by a read of the whole diff.
5. Both tools are pinned exactly. A bump re-records the baseline in the same commit.

## The gates

| Script | Runs | Fails when |
|---|---|---|
| `hygiene:knip` | `knip --no-progress` | any unused file, dependency, devDependency, binary, export or exported type; any unlisted dependency; a stale entry in the knip config |
| `hygiene:dup` | `jscpd <source folders> --no-tips` | a clone whose fingerprint is not in `.jscpd-baseline.json` |
| `hygiene` | both | either fails |
| `hygiene:dup:update` | jscpd with `--update-baseline` | never: it rewrites the baseline, by hand only |

CI runs `hygiene`, then re-records the baseline and fails on any difference (`git diff --exit-code -- .jscpd-baseline.json`): a stale fingerprint would let a removed clone come back unnoticed.

Shared settings, the same in every stack:

- knip without `ignoreExportsUsedInFile`: an export that only its own file uses is reported, and the fix is to drop the `export` keyword. Hiding those findings made every module's public surface look larger than it was (in one measured project, over 200 exports nothing imported), and a new one was never caught.
- knip `treatConfigHintsAsErrors: true`: an ignore entry that no longer matches anything fails the run, so an exception cannot outlive its reason.
- jscpd `minTokens: 70`, `minLines: 8`, tests and test helpers out: below that it is mostly boilerplate that blocks commits without teaching anything, and in a test repetition reads better.
- jscpd ignores generated code (`**/*.generated.*`): a generator repeats itself by design, its output changes only through the generator, and its clones would fill the baseline with fingerprints nobody can act on.
- jscpd `failOnNewClones: 0` against `baseline: ".jscpd-baseline.json"`, and `failOnEmpty: true` so a wrong path cannot pass as "no clones".

Why a baseline of content hashes and not a count budget: a count drifts when several sessions merge at once, and a hash survives line shifts, renames and CRLF. Why a committed baseline and not `--baseline-from-ref`: that builds the baseline in a temporary git worktree, which runs your checkout hooks, and sessions committing straight to `main` leave no merge base to compare with.

There is no git hook: a pre-commit or pre-push run analyses a working tree other sessions may leave dirty, so a commit could fail on someone else's unfinished export. CI analyses exact commits; locally, `npm run hygiene` is part of the stack's gate set.

## Reading a finding

`npm run hygiene` runs both. knip prints the symbol, file, line and column; jscpd's `ai` reporter prints each new clone as `a.ts:12-30 ~ b.ts:40-58`.

- **A re-export** (`export { X } from …`) is reported as the specifier. The declaration it points to is alive: delete the specifier, and the statement when it empties. Never delete the declaration.
- **A declaration**: search the whole repository for the name (`git grep -nw <name>`). A hit outside the declaring file, in docs, scripts, infra or another language, means look before you delete. If there is none, delete the declaration and whatever only it used, not just the `export` keyword.
- **A dependency**: check that nothing imports it, no tool loads it by name and no config plugin lists it, then remove it with the package manager.
- **An unlisted dependency**: a config refers to a package that is not installed. It can be a real bug (the template's skeleton set `userInterfaceStyle` in `app.json` without `expo-system-ui`, which Expo needs for it on Android) or a plugin heuristic: read the tool's plugin before deciding.
- **A new clone**: extract the shared part, or, if the duplication is intentional, re-record the baseline (below).

## Exceptions

- A false positive goes in the knip config of its stack (`ignoreDependencies`, `ignoreBinaries`, `ignoreIssues`, `entry`), each entry with a comment saying why. Example: `lint-staged` is run by the repository's `.husky/pre-commit`, outside the package knip analyses.
- A symbol kept on purpose: `/** @public <reason> */` on the declaration, never `@internal` (it hides the finding in production mode). Each tag is a visible, reviewed exception.
- Generated or vendored code (a UI kit added whole, for instance): `ignoreIssues` for its folder, not a list of names.
- Removing an exception needs no permission. Adding one is a person's decision, stated in the commit body.

## Re-recording the jscpd baseline

`npm run hygiene:dup:update` rewrites `.jscpd-baseline.json` from the current tree. It accepts new clones too, so run it only when:

- a clone was removed: the diff only drops fingerprints (or lowers a count), or
- the duplication is intentional, such as two vendor adapters that must stay independent, and the commit body says why.

Commit the baseline in a commit of its own. Never hand-merge a conflict in it: take either side, rebase, and run the update again. The baseline is in `.prettierignore`: jscpd owns its layout.

## Bumping knip or jscpd

Both release often and detection changes between minors.

1. Install the new exact version.
2. `npm run hygiene:knip`: fix or explain every new finding.
3. `npm run hygiene:dup:update` and read the baseline diff: added fingerprints are clones the new version sees.
4. One commit with the bump and the re-recorded baseline, the changes listed in the body.

## Adding the gates to a stack

1. Pin `knip` and `jscpd` exactly in the stack's devDependencies. jscpd is a native binary: check that the lockfile lists the platform packages CI and every developer machine need.
2. Add the four scripts of [The gates](#the-gates), with the stack's source folders on the jscpd command line.
3. Write `knip.jsonc` with the two shared settings and `.jscpd.json` with the shared thresholds, the stack's formats and its test patterns ignored. Add `.jscpd-baseline.json` to `.prettierignore`.
4. `npm run hygiene:dup:update` records the baseline: commit the existing clones as they are, and plan their removal separately.
5. Bring knip to zero, finding by finding (see [Reading a finding](#reading-a-finding)). Each kept exception has its comment.
6. Add `npm run hygiene` and the baseline check to the stack's CI job, and `npm run hygiene` to the gate set in the stack's `AGENTS.md`.

`node --test "tools/agent-harness/*.test.mjs"` then checks the pins, scripts and shared settings.

## An unattended cleanup loop

Optional, once the gates are green. A scheduled agent can prune the baseline and remove provably dead code, but only under these rules. The reference implementation is the janitor of the ragLocal project (`infra/scripts/janitor.sh`, `infra/scripts/src/hygiene/`).

1. **The model proposes, a deterministic verifier decides.** The model gets a worktree of its own, an allowlist of tools and one commit; it never holds `git push`. A wrapper script runs the gates, the verifier and the push.
2. **Start without a model.** Pruning stale fingerprints is mechanical: once `hygiene:dup` passes, the update can only drop entries.
3. **One change per run**, one commit, with a trailer naming the run (`Janitor-Run: <id>`) so `git revert` undoes it.
4. **The verifier rejects**: more than one commit; a protected path (instruction files, CI, hooks, security-relevant code, wire schemas, each package's public entry point, vendored code); an added suppression marker or `@public`; a removed `@public`; any rising metric (knip findings, clones, fingerprints); a job that does not lower its own metric; more than 3 files or 40 changed lines; any line added to an exception file, except a rewrite that narrows it.
5. **Only class A changes** at first: a re-export specifier, or a type alias or data constant with no other reference. Functions, classes, files, dependencies and clone pairs (class B) wait until a person has read the class A commits.
6. **Bounded and stoppable**: a turn limit, a budget, a task time limit, a lock against concurrent runs, and a kill switch that two rejections in a row trip.
7. **Prove the denials first**: before the model may act, run it once with the exact flags and a prompt asking it to push, to delete a file and to write outside its worktree. All three must be denied.
8. **Climb an autonomy ladder**: report only, then prune, then class A, each stage after a week of clean runs.

## Checklist before you finish

- `npm run hygiene` passes in every stack you touched.
- No exception was added without a reason in its comment, and none was added to silence another session's finding.
- The baseline changed only in a commit of its own, with the reason in the body.
