# Testing

Read when: choosing what to test and at which level, choosing test doubles, fixing flaky or slow tests, or building a safety net before a refactoring.
Language-agnostic. Examples use Vitest/Jest, Testing Library, Playwright, MSW, fast-check and Stryker. Project rules in `AGENTS.md` override this file.

## Rules that always apply

1. Tests specify **behavior through public interfaces**. A pure refactoring changes no test expectation (call sites updated by a rename or signature change are fine). If it does, either the test was coupled to the implementation or the behavior changed. Say which.
2. Watch every new test **fail once, for the expected reason**, before you trust it.
3. A bug fix starts with a **regression test that fails** without the fix.
4. Never delete, skip or loosen a test, and never rewrite its expectation, to get green.
   - Never paste actual output over a failing expectation. New characterization tests, which pin current behavior on purpose, are the exception (`refactoring.md`).
   - Never special-case test inputs in production code.
   - If a test looks wrong, stop and report it with evidence. Change a test only for an intended behavior change, and say so.
5. Tests are **deterministic**: inject the clock and randomness, never sleep; small tests also use no real network or disk.
6. Test code is production code: readable, reviewed, maintained.

## Suite shape

- Write many small, fast tests, fewer integration tests and very few end-to-end tests. Push each test as low as it can go. When a high-level test catches a bug that no low-level test caught, add the low-level test. (Cohn's pyramid, via Vocke. By scope, Google aims for about 80% unit, 15% integration and 5% end-to-end tests.)
- Classify tests by the **resources they use**, not by the word "unit" (*Software Engineering at Google*, ch. 11):
  - small: one process, no I/O, no sleeping;
  - medium: one machine, a localhost DB or containers;
  - large: several machines or real services.
- **Let the code decide the mix:**
  - logic-dense modules: many small tests;
  - UI, wiring and service code: mostly in-process integration or component tests (Dodds' "testing trophy");
  - independently deployed services: contract tests;
  - on top: a handful of E2E journeys.
- Avoid the ice-cream cone (mostly E2E) and the hourglass (no middle layer). Don't treat ratios as quotas.
- Beyoncé rule (Google): if you liked it, you should have put a test on it. Untested behavior gets broken by someone else's refactor.

| Level | What belongs there | Doubles allowed | Typical TS/JS tools |
|---|---|---|---|
| Static | Type errors, floating promises, misuse of test APIs | — | `tsc --noEmit`, typescript-eslint, eslint-plugin-testing-library |
| Small / unit | Domain rules, pure functions, parsers, reducers, state machines, edge-case tables, properties | Real collaborators by default; inject clock, RNG and IDs; fakes for I/O | Vitest/Jest, fast-check, Stryker (critical code) |
| Component | One component or screen with its real children, driven like a user | MSW for HTTP; real providers and stores; never mock your own children or hooks | Testing Library + user-event + jest-dom, MSW |
| Integration / medium | DB queries and migrations, HTTP handlers, queues, adapters around SDKs — one integration point per test | Real DB or broker in a container; fakes or MSW for third parties | Vitest/Jest + Testcontainers, supertest |
| Contract | What a consumer needs from a provider's API or messages | Pact mock on the consumer side; the real provider when verifying | Pact |
| E2E / large | A few critical user journeys | None for your own services; stub only third parties you don't control | Playwright + trace viewer |
| Visual | Layout-critical pages | Fixed data, frozen time and animations, masked regions | Playwright `toHaveScreenshot` |

## Writing a good test

- **Arrange–Act–Assert** (or Given–When–Then), with the three parts visibly separated.
- **One behavior per test**, not one test per method. Several assertions about one outcome are fine.
- **The name states the behavior and the expected outcome:** `it('rejects a withdrawal exceeding the balance')`, not `it('withdraw works')`.
- **No logic in tests** (no `if`, no loops). Expected values are literals taken from the spec, never recomputed with logic that mirrors production code.
- **DAMP over DRY.** Each test reads on its own:
  - share *how* data is built, using test-data builders with defaults;
  - set only the values this test depends on;
  - don't hide the inputs a test relies on in shared fixtures.
- **Specific matchers and useful failures:** `toEqual`, `toThrow(/insufficient/)`, not `expect(a === b).toBe(true)`. A failure shows the expected value, the actual value and the relevant inputs.
- Helpers and fakes that contain logic get their own tests.
- **Beck's Test Desiderata**, 12 properties that trade off against each other: isolated, composable, deterministic, fast, writable, readable, behavioral, structure-insensitive, automated, specific, predictive, inspiring. *Behavioral + structure-insensitive* is the pair that makes refactoring safe.
- **FIRST:** Fast, Isolated, Repeatable, Self-validating, Timely.

## Test doubles

- **Vocabulary** (Meszaros):
  - dummy: passed but never used;
  - stub: returns canned answers;
  - spy: a stub that records calls;
  - mock: pre-programmed with expectations;
  - fake: a working shortcut implementation, such as an in-memory repository.
- **Preference order:** real implementation (if fast and deterministic) → fake → stub → interaction mock (Google SWE book, ch. 13).
- **Assert outcomes and state, not interactions.** Verify a call only when the call *is* the behavior: email sent, card charged, event published. Even then, don't over-specify order, counts or irrelevant arguments.
- **Use doubles only at process boundaries and sources of nondeterminism:**
  - network and third-party services;
  - clock, randomness and IDs;
  - filesystem and environment;
  - slow infrastructure in small tests.

  Inside your own process, use real collaborators ("sociable" tests).
- **Don't mock what you don't own** (Freeman & Pryce):
  1. Wrap the third-party API in a thin adapter you own.
  2. Mock or fake the adapter in unit tests.
  3. Test the adapter against the real dependency in a few integration tests.

  Never mock value objects.
- **Many mocks signal a design problem:** too many responsibilities, or dependencies pointing the wrong way. Refactor; don't mock harder.
- Fakes need tests, or contract tests, proving they behave like the real thing.
- **HTTP in JS:** intercept at the network layer with MSW (`onUnhandledRequest: 'error'`) rather than `vi.mock('axios')`.
- **Independently deployed services:** use consumer-driven contract tests (Pact) rather than cross-service E2E.

## Where non-production code lives

A reader tells business code from everything else by its path alone, so each kind of non-production code carries one plain-English label:

| Kind | Label |
|---|---|
| Test support: fakes, builders, test kits, contract suites, setup | a `testing/` folder; a package exposes it as `./testing` |
| Experiment: code run to answer a question or take a measurement, never shipped | an `experiments/` folder beside `src/`, **and** `*.experiment.ts` / `*_experiment.py` |
| Manual check: a script a person runs by hand | a `manual-checks/` folder **and** `*.manual.ts` / `*_manual.py` |
| Benchmark | `*.bench.ts` (Vitest's own) / `*_bench.py` |

- Business code never imports any of them; an architecture guard test that walks the source tree enforces it.
- The file label survives a copy or a move and `grep` finds it; the folder is where a lint relaxation attaches.
- One name per kind: no `fakes/`, `mocks/`, `test/`, `spikes/` or `scratch/` beside `testing/` and `experiments/`.

## Determinism and flakiness

- **Time:**
  - Inject the clock (`now: () => Date`); this is the preferred approach.
  - Use fake timers only for timers inside the code under test, and restore real timers in `afterEach`.
  - In Vitest, `vi.setSystemTime` does not fire timers. Use `advanceTimersByTimeAsync` for timers scheduled from promises.
  - Pin the timezone and locale for test runs.
- **Randomness:** inject the RNG and ID generators, and fix seeds.
- **Waiting:** never sleep. Use auto-waiting assertions (Playwright), `findBy*` (Testing Library) or polling helpers.
- **Hermetic tests:**
  - each test owns its setup and teardown;
  - tests share no DB rows (roll back a transaction per test, or use unique data);
  - restore mocks, globals and env (`vi.restoreAllMocks`, `vi.unstubAllGlobals`, `vi.unstubAllEnvs`);
  - run in random order or in parallel to expose hidden coupling.
- **Flaky tests** pass and fail without any change.
  - Quarantine a flaky test immediately, with an owner and a deadline, and fix it fast.
  - Retries are for triage, not a fix. Never fix a flake with a longer sleep.
  - Ignored flakes train people to ignore real failures.

```ts
const isExpired = (t: Token, now: () => Date = () => new Date()) => t.expiresAt <= now();
expect(isExpired(aToken({ expiresAt: T0 }), () => T0)).toBe(true); // injected clock, no fake timers
```

## Speed and parallel runs

A slow suite gets run less, and a suite that passes only when run serially hides coupling. Make it fast without weakening a single check.

- **Measure first.**
  - Get per-file and per-test durations from the runner (Vitest `--reporter=json`, Jest `--json --outputFile`).
  - See where a file's time goes: environment, setup files, imports or test bodies.
  - A run lasts as long as its slowest project, and a project at least as long as its slowest file. Split that long pole; speeding up anything else changes nothing.
- **Make each file cheap to start.** The runner re-imports a file's whole module graph in a fresh sandbox, once per file. So:
  - Import from the module that defines a name, not from a barrel (`index.ts` re-exports). A barrel loads everything it re-exports, and makes changed-file selection pull in unrelated tests.
  - Keep setup files light: they run once per test file.
  - Default to the `node` environment and opt into a DOM per file.
  - Transpile without type-checking (swc, esbuild), and type-check once with `tsc --noEmit`.
- **One run for the whole repository.**
  - The root config lists every package as a project, so all files share one worker pool. Separate runs per package each start a full pool and oversubscribe the CPU.
  - On CI, set the worker count to the runner's vCPUs: inside a container, the runner may see the host's cores.
- **Expensive infrastructure once per project, isolation per file.**
  - Start the database container in a global setup, and migrate a template database once. Run every setup step the app runs, not only the migrations.
  - Hand the container's URL to the test files: Vitest `provide`/`inject`; Jest, see below.
  - Each file clones its own database from the template (Postgres `CREATE DATABASE … TEMPLATE …`), and drops it `WITH (FORCE)` when it ends. Cloning fails while anything is connected to the template.
  - Size the server for files in flight × connections per file (Postgres `max_connections`).
  - A transaction rolled back per test only isolates code that uses the injected connection. Code with its own pool escapes it.
- **Only the server is shared, so scope server-wide reads.** A test that reads or acts on server-wide state (`pg_stat_activity`, `pg_locks`, `pg_terminate_backend`) filters it to `current_database()`. Otherwise it sees and breaks other files' sessions.
- **Teardown waits until connections have closed.** Some pool libraries resolve `end()` before their sockets close, and dropping the database then makes the closing clients fail (Postgres `57P01`). Wait for every client to close (pg: the pool's `remove` event) before dropping.
- **Servers listen on port 0, on `127.0.0.1`, never on a fixed port.**
  - On macOS, a server bound to every address can share its port with another process's `127.0.0.1` listener, which then gets the requests: a random 404 or empty body.
  - Start test apps with `listen(0, '127.0.0.1')`, and bind fake servers the same way.
  - supertest binds `127.0.0.1` itself from 7.3.1. Older versions bind every address for each request to an app that isn't listening yet.
- **Speed up a slow test without weakening it.**
  - Keep its sample count, thresholds and assertions.
  - Run independent tries in bounded concurrent batches instead, sized by what they share (a hashing thread pool, a lockout counter).
  - Check it alone and under a full run.
- **A flake fix starts with a reproduction.** Prove the cause in a few lines (a bind probe, a race in a loop), then fix that cause. A retry or a longer timeout fixes nothing.

### Jest

Applies to Jest 30 (30.5 in October 2026). Jest runs files in parallel workers and the tests of a file one after another. Every file gets its own `vm` sandbox and a fresh module registry, so the per-file costs above weigh more than under other runners.

- **Transform:**
  - Use `@swc/jest`, or ts-jest with `isolatedModules: true` in tsconfig. The transform never type-checks.
  - Keep `transformIgnorePatterns` exceptions narrow: every package you exempt gets transformed.
- **Environment:** `testEnvironment: 'node'`, plus a `/** @jest-environment jsdom */` docblock in each file that renders. A preset that sets its own environment (`jest-expo`) keeps it.
- **Root-only options:** `maxWorkers`, `workerIdleMemoryLimit`, `randomize`, `testSequencer`, `maxConcurrency` and `coverageThreshold` take effect only in the root config. In a `projects` entry, Jest ignores them with a warning.
- **Workers:**
  - The default is cores − 1.
  - On a runner with 1–2 vCPUs, `--runInBand` is often faster.
  - In containers, pass `--maxWorkers` explicitly.
- **Memory:**
  - A worker whose heap grows file after file slows the run. `workerIdleMemoryLimit: '512MB'` restarts it between files.
  - Fix the `JEST-01` warnings from `globalsCleanup: 'soft'` (the default), then set `testEnvironmentOptions: { globalsCleanup: 'on' }`.
- **Cache:**
  - Never run with `--no-cache`; Jest's docs say it is at least twice as slow.
  - On CI, persist `cacheDirectory`. It also holds the file durations Jest uses to start the slowest files first.
  - Set `haste.forceNodeFilesystemAPI: true`. The system `find` walks all of `node_modules`.
- **Shared infrastructure:** Jest has no `provide`/`inject`.
  - `globalSetup` puts plain strings, such as the container's URL, in `process.env`; the workers start after it.
  - Keep the container handle on `globalThis` for `globalTeardown`. Globals set in `globalSetup` reach only `globalTeardown`, never the tests.
  - Name per-worker resources after `JEST_WORKER_ID`. It starts at 1, and is always 1 under `--runInBand`.
- **Hermetic:**
  - Set `restoreMocks: true`.
  - Run `--randomize` now and then; `--seed=<n>` replays a failing order.
  - `test.concurrent` is experimental, and `beforeEach`/`afterEach` don't wrap each of its tests (jest#7997). Use it only for independent I/O-bound tests that share nothing.
- **Fewer tests:** `--changedSince=origin/main` on pull requests, and `--findRelatedTests <files>` in pre-commit hooks. Barrels make both select too much.
- **Several CI machines:**
  - `--shard=i/n` splits files by path hash, not by duration. To balance by time, override `shard()` in a sequencer that extends `@jest/test-sequencer`, using recorded durations.
  - Jest doesn't merge shard coverage. Merge the `json` coverage reports (`nyc merge`), and check the threshold on the merged one.
- **Diagnose:**
  - `--json --outputFile` gives each file's `perfStats` (environment, setup, runtime).
  - `node --cpu-prof node_modules/.bin/jest --runInBand <file>` profiles one file.
  - `--detectOpenHandles` (it forces `--runInBand`) and `--logHeapUsage` are for debugging only, never a normal run.

```js
// jest.config.js at the root: run-wide options
module.exports = {
  projects: ['<rootDir>/packages/*'],
  maxWorkers: process.env.CI ? 4 : '50%', // CI: the runner's vCPUs
  workerIdleMemoryLimit: '512MB',
  cacheDirectory: '<rootDir>/.jest-cache', // git-ignored, persisted between CI runs
};
// jest.config.js in a package
module.exports = {
  testEnvironment: 'node',
  transform: { '^.+\\.(t|j)sx?$': '@swc/jest' },
  restoreMocks: true,
  haste: { forceNodeFilesystemAPI: true },
  testEnvironmentOptions: { globalsCleanup: 'on' },
};
```

## Techniques

- **TDD** (Beck, *Canon TDD*):
  1. List the test scenarios.
  2. Turn exactly one into a concrete failing test.
  3. Make it, and all earlier tests, pass.
  4. Optionally refactor.
  5. Repeat.

  Don't refactor while making a test pass. Default: test-first for bug fixes and well-specified logic. Spikes are fine, but tests exist before merge.
- **Characterization tests:** pin the current behavior of untested code before changing it (→ `refactoring.md`).
- **Property-based tests** (fast-check, Hypothesis) for parsers, serializers, math and invariants. Typical properties:
  - round-trip: `decode(encode(x))` equals `x`;
  - invariants;
  - idempotence;
  - comparison against a simple oracle.

  They complement example tests; they don't replace them. Keep the failing seed.
- **Table-driven tests** (`it.each`): every row has the same arrange–act–assert shape. If rows need branching, split them into separate tests.
- **Mutation testing** (Stryker): a surviving mutant means an assertion is missing. It is expensive, so run it on critical or changed code. Don't chase a score.
- **Snapshots:**
  - keep them small and intentional: error messages, serializer or codegen output;
  - prefer inline snapshots;
  - read every diff, and never bulk-update with `-u` blindly.
- **Edge cases:**
  - boundaries: 0, 1, −1, max, off-by-one;
  - empty values, `null`, `undefined`, `NaN`;
  - duplicates;
  - hostile keys (`__proto__`);
  - Unicode: combining marks, emoji, RTL;
  - large inputs;
  - error paths: throws, rejections, timeouts, partial failure;
  - time zones and DST;
  - concurrent calls.
- **Async tests:**
  - always `await` or return the promise;
  - use `await expect(p).rejects.toThrow(...)`;
  - add `expect.assertions(n)` when assertions run inside callbacks;
  - enable `no-floating-promises`.

```ts
it.each([{ age: -1, ok: false }, { age: 0, ok: true }, { age: 130, ok: true }, { age: 131, ok: false }])(
  'isValidAge($age) is $ok', ({ age, ok }) => { expect(isValidAge(age)).toBe(ok); });
```

## Frontend and E2E

- **Testing Library's guiding principle:** "The more your tests resemble the way your software is used, the more confidence they can give you." Assert what users perceive. Never assert on component state, instances or hook internals.
- **Query priority:** `getByRole` › `getByLabelText` › `getByPlaceholderText` › `getByText` › `getByDisplayValue` › `getByAltText` › `getByTitle` › `getByTestId` (last resort).
  - `getBy*` throws when nothing matches.
  - Use `queryBy*` only to assert absence.
  - `findBy*` waits.
- Prefer `user-event` to `fireEvent` and query through `screen`. Put one assertion per `waitFor`, with no side effects inside it.
- **Playwright:**
  - role and label locators;
  - web-first assertions: `await expect(locator).toHaveText(...)`, never `expect(await locator.isVisible()).toBe(true)`;
  - an isolated context per test;
  - stub only third parties you don't control;
  - no `waitForTimeout`;
  - the trace viewer for CI failures.
- **Test a screen through what it shows.** Every visible state gets a test: loading, failure, empty, one item, several, each refusal. Render routes through one shared render helper. Never query by component name or CSS class, so splitting a screen into parts doesn't touch its tests.
- **Visual regression tests:** keep them few, run them in a pinned container and mask volatile regions. They detect change, not correctness.

## Coverage

- Coverage finds untested code. It does not measure test quality: it shows that a line ran, not that anything checked the result. When a measure becomes a target, it stops being a good measure (Goodhart).
- **In every PR, review the uncovered *changed* lines.**
  - ~90% coverage of changed code is a common soft floor.
  - Be suspicious of 100% targets (Fowler).
  - Use mutation testing to judge test strength.
- You have enough tests when bugs rarely escape and you are rarely afraid to change code (Fowler, *TestCoverage*).

## Anti-patterns → fix

| Anti-pattern | Fix |
|---|---|
| Testing private methods | Test through the public API; if that's not enough, extract a unit with its own API |
| Mocking everything, third-party types, or your own children/hooks | Real collaborators, fakes, MSW, adapters you own |
| Over-specified interactions (every call, call order, getters) | Assert outcomes; verify only state-changing outbound calls |
| Logic in tests; expected values computed in the test | Literals; `it.each` |
| Sleeps | Auto-waiting assertions, polling, fake timers |
| Order-dependent tests | Data per test; restore doubles; shuffle the order |
| Giant setup | Builders with defaults. Large setup also signals too many dependencies |
| Overly DRY tests that hide their inputs | DAMP: inputs that matter are visible in the test |
| Snapshot overuse | Small, intentional assertions |
| Tests that can't fail (no assertion, floating promise, callback assertions that never run) | Watch it fail; `expect.assertions`; mutation testing |
| Editing a test to make it pass | Diagnose the root cause; edit tests only for intended behavior changes, and say so |

## Checklist before you finish

- [ ] Each new test was seen failing for the right reason.
- [ ] Names state the behavior and outcome. One behavior per test, with Arrange–Act–Assert visible.
- [ ] Tests use only the public API or UI, with no private access.
- [ ] Tests assert outcomes. Interaction checks exist only for state-changing outbound calls.
- [ ] No branches or loops; expected values are literals from the spec.
- [ ] Doubles appear only at boundaries or for interfaces you own. No mocked third-party types or value objects.
- [ ] No real clock, randomness, network or sleeps; seeds are fixed.
- [ ] Every test passes alone, in any order and in parallel. Mocks, timers and env are restored.
- [ ] No new file starts its own container, migration or fixed-port server when the project's setup provides one. Servers listen on `127.0.0.1`, port 0.
- [ ] Every promise and async assertion is awaited.
- [ ] Boundaries, empty and null values, Unicode, large inputs and error paths are covered.
- [ ] Snapshots are small and their diffs were reviewed.
- [ ] Every bug fix has a regression test that failed before the fix.
