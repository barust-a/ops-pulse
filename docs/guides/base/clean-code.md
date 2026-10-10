# Clean code: principles, functions, data, errors and comments

**Read this when:**
- you choose between two designs for a function or type (error strategy, types vs runtime checks, comments, control-flow shape);
- you need the reasoning behind a rule in `AGENTS.md`.

Related guides:
- Naming → `naming.md`
- Module structure → `architecture.md`
- Restructuring existing code → `refactoring.md`

Project rules in `AGENTS.md` override this file.

## The goal

- **Write for the human reader.** Code is read far more often than it is written.
  - "Programs must be written for people to read, and only incidentally for machines to execute" (Abelson & Sussman, *SICP*).
  - "Any fool can write code that a computer can understand. Good programmers write code that humans can understand." (Fowler, *Refactoring*, 1999)
- **Managing complexity is the most important technical topic in software development** (McConnell).
  - Complexity shows up as change amplification, cognitive load and unknown unknowns (Ousterhout).
  - Judge code by how much a newcomer must hold in mind at once, not by line counts or cleverness.
- **"Easier to change" (ETC) breaks ties** between designs (*The Pragmatic Programmer*).
- **Kent Beck's four rules of simple design**, in priority order:
  1. passes the tests;
  2. reveals intention;
  3. no duplication;
  4. fewest elements.

## Principles and how to apply them

- **DRY is about knowledge, not text.** "Every piece of knowledge must have a single, unambiguous, authoritative representation within a system" (Hunt & Thomas).
  - Deduplicate a business rule immediately.
  - Look-alike code that encodes *different* rules is a coincidence; leave it.
- **Duplication is far cheaper than the wrong abstraction** (Sandi Metz).
  - For look-alike code, wait for the third occurrence and stable requirements (Rule of Three; "Avoid Hasty Abstractions", Dodds).
  - When an abstraction grows a flag or a branch for each caller, inline it back into the callers, then re-extract only what is truly shared.
- **YAGNI covers speculative features** — capabilities built for a presumed future need. It does not cover effort that makes code easier to modify (Fowler).
- **KISS and Gall's law:** a complex system that works evolved from a simple system that worked. Start simple, then grow.
- **Least astonishment:** functions and APIs behave the way their names and types promise.
- **Command–Query Separation** (Meyer):
  - Queries return a result and change no observable state.
  - Commands change state and return nothing, or only what they created (an ID, the new record).
  - Break this only for established idioms (`pop`, `getOrInsert`).
- **Tell, Don't Ask:** let the code that owns the data do the work. In OO domain code it is a nudge, not a ban on getters. Plain data (DTOs, records, pipelines) is meant to be read.
- **Law of Demeter:** code talks to itself, its parameters, the objects it creates and its direct components — not to strangers reached through chains like `a.b().c().d()`.
  - Fluent builders, pipelines over immutable values and navigation of plain data are exempt.
- **Chesterton's fence:** never remove code whose purpose you don't know. Find out why it exists first (tests, `git blame`/`log`, issues).
- **Boy Scout rule, scoped:** tidy only inside the lines you are changing; list other cleanups as follow-ups.
- **Kernighan:** "Everyone knows that debugging is twice as hard as writing a program in the first place. So if you're as clever as you can be when you write it, how will you ever debug it?" Avoid clever code.
- **Conceptual integrity** (Brooks): follow the existing design's vision and conventions, even where you would have chosen differently.
- **Be strict with input by default.** RFC 9413 critiques Postel's robustness principle: improvised tolerance hides faults. Any tolerance must be specified explicitly.

## Functions

- **Keep one level of abstraction per function.** Don't mix orchestration and low-level detail in the same body.
- **Decide size by depth, not by line count.**
  - Extract a block when it can be given a meaningful name and the extraction hides more than it exposes.
  - Don't extract tightly coupled pieces, such as acquiring a lock and running the critical section.
  - Don't split code that readers would then have to flip between to understand ("conjoined" methods).
  - There is no evidence behind "2–4 lines": studies cited in *Code Complete* found no gain below about 32 lines and no rise in errors up to about 200. Split on meaning.
- **Keep parameters few.**
  - At most three positional parameters; beyond that, use an options object.
  - Keep the same parameter order across related functions.
  - Never reuse a parameter as a working variable.
- **No flag arguments that select behavior** (`book(customer, true)`). Use named functions (`bookPremium`) or a union value instead.
  - Acceptable: a private implementation that only the named wrappers call.
  - Acceptable: a boolean passed straight through from data, such as a checkbox value.
- **No hidden side effects.**
  - Never mutate inputs you don't own.
  - Never pass data between methods by setting fields as a side effect.
- **Order the file for reading.** Callers come before callees ("stepdown") when the file has a natural hierarchy. Keep related code close together.

## Control flow

- **Guard clauses:** handle preconditions and edge cases first with early returns, so the main path stays flat.
- **Limit nesting to 3–4 levels.** Invert conditions, use `continue`, or extract the nested block.
- **Decompose conditionals.** Name complex predicates even if they're used once (`const isEligibleForRefund = …`). Mixed `&&`/`||` chains are the hardest to read.
- **Complexity metrics are review triggers, not targets:**
  - Cognitive complexity penalizes nesting and breaks in linear flow, but not early returns. Sonar's default threshold is 15.
  - Cyclomatic complexity counts paths, roughly the number of tests needed. ESLint's default threshold is 20.
  - `tools/eslint/base.mjs` caps them stricter, at 10 cognitive and 15 cyclomatic. Cognitive complexity is the one that measures reading effort. ESLint's cyclomatic count also adds a point for each `?.`, `??` and default value, which is why its cap stays at 15. Over a cap, extract a loop body or a phase into a named function; don't hide branches to beat the metric.
- **Choose between a table, a switch and polymorphism by the axis of change:**
  - closed set of keys mapping to values or functions → a lookup table (`Record<Kind, …>`);
  - closed set of types, with operations still being added → an exhaustive `switch`/match;
  - open set of types, with stable operations → polymorphism, or a registry.
- **Pipelines vs loops:** use pipelines (`map`/`filter`/`reduce`) for data transformations. Use a loop when you need early exit, several accumulators, or a measured hot path.

## State and side effects

- **Functional core, imperative shell.** Decisions are pure functions of their inputs. I/O, clock, randomness and environment live in a thin shell that passes values in.
- **Immutable by default**, with the narrowest possible mutable scope.
  - No global or module-level mutable state: it is a hidden extra parameter to every function.
- **Avoid temporal coupling.** If calls must happen in a certain order, make the order impossible to get wrong:
  - each step returns what the next step needs; or
  - a factory returns a ready-to-use object.
- **Prefer idempotent "ensure X" operations**, so retries and repeats are harmless.
- **Balance resources.** Whoever acquires a resource releases it, on every path (`finally`, `using`, `defer`).

## Data and types

- **Make illegal states unrepresentable.**
  - Use one variant per state, each carrying only that state's fields, instead of flags plus optional fields.
  - Handle the variants exhaustively.
- **Cure primitive obsession.** Give primitives that carry rules a real type: `Email`, `UserId`, `Money` (minor units + currency), `DateRange`, units. Each gets a smart constructor that validates.
- **Parse, don't validate.**
  - Convert untrusted input once, at the boundary (McConnell's "barricade"), into a refined type.
  - Inside the barricade, trust the type. Don't scatter checks.
- **Make absence explicit.**
  - Use `T | undefined` or Option.
  - Return empty collections, not null.
  - No magic sentinel values (`-1` meaning "missing").
- **Variables:**
  - one purpose per variable;
  - declared close to first use, in the narrowest scope;
  - with a short live span.
- **Named constants:** give magic numbers and strings a name that says what they *mean* (`MAX_UPLOAD_BYTES`), not what they *are* (`FIVE`).
- **Objects vs data structures:** decide per type.
  - An object hides its data behind behavior.
  - A record or DTO exposes data and has no behavior.
  - Avoid hybrids.

## Errors

- **Classify every failure first** (Joe Duffy, *The Error Model*):
  - **Bug** (contract violation, impossible state):
    - Fail fast and loudly: throw or assert. Don't catch locally.
    - "A dead program normally does a lot less damage than a crippled one" (*The Pragmatic Programmer*).
    - Keep invariant checks on in production, with one top-level handler per request or job.
  - **Expected failure** (invalid input, not found, conflict, rate limit, timeout):
    - Make it explicit in the signature, as a typed result union or a documented error type.
    - Handle it where a decision can be made.
- **Never swallow an error.**
  - No empty `catch`.
  - No success-shaped fallback, such as returning `[]`, `null` or a default to hide a failure.
  - No silent default for missing config (Shore, *Fail Fast*).
- **Catch only where you can act:** recover, retry, translate or add context. Otherwise let the error propagate.
  - Add context when rethrowing: `new Error(msg, { cause })`.
  - Log once, where the error is handled. Never log and rethrow.
- **Error messages put the failure in context:** what was attempted, with which IDs or values, and why it failed — not just the condition that failed.
- **Define errors out of existence where that is honest** (Ousterhout): idempotent delete, clamping, masking errors low in the stack, handling them in one place. Never hide an error a caller needs to know about.
- **No handling for impossible scenarios** inside trusted code; validate at the boundaries instead.
- **Null:** Tony Hoare called it his "billion-dollar mistake". Use `strictNullChecks` or Option. Use a Null Object only where a real neutral behavior exists.
- **Exceptions vs result values:**
  - Unchecked exceptions are hidden, non-local control flow. Error codes are easy to ignore. Go and Rust make errors explicit values.
  - **TS default:** throw for bugs and broken invariants; return discriminated-union results for expected domain failures; translate between the two at boundaries.

## Comments and documentation

- **Comment the why and the non-obvious:** intent, constraints, trade-offs, rejected alternatives, and links to issues or specs. "Code can only tell you how the program works; comments can tell you why it works" (Atwood).
- **Write an interface comment on every exported API.**
  - Cover what it does, its parameters, return value, errors and side effects — without implementation details. (Ousterhout and Martin agree on this.)
  - Writing the comment first is a design test: if it is hard to describe, the design is suspect.
- **Don't restate the code.**
  - Prefer expressing intent in code (names, constants, extracted predicates) when that is equally clear.
  - Don't use a 60-character name to avoid a comment that is genuinely needed.
- **Keep comments current.**
  - Update them in the same change as the code; a wrong comment is worse than none.
  - Delete commented-out code; version control remembers.
- **`TODO`/`FIXME`** carry an owner or issue, and a condition for removing them.

## Formatting

- **Automate formatting.** Use a formatter (Prettier, gofmt, ruff/Black) and a linter in CI, and never argue style by hand. "Gofmt's style is no one's favorite, yet gofmt is everyone's favorite" (Go proverbs).
- **Consistency beats preference:** match the existing code.
- **Reading order:**
  - public and high-level code first, helpers below;
  - related code together;
  - blank lines between the steps of a function.

## Laws at a glance

| Law | Source | What it means for code |
|---|---|---|
| KISS | US Navy / Kelly Johnson, 1960 | Pick the simplest design that works now |
| YAGNI | XP; Fowler, 2015 | No speculative features; investing in changeability is fine |
| DRY | Hunt & Thomas, 1999 | Deduplicate knowledge, not look-alike text |
| Rule of Three | Don Roberts, via Fowler | Abstract on the third occurrence |
| Wrong abstraction | Metz, 2016 | Inline a bad abstraction, then re-extract |
| Least Astonishment | PL/I era, 1967 | Behave as names and types promise |
| Chesterton's Fence | Chesterton, 1929 | Learn why code exists before removing it |
| Hyrum's Law | Hyrum Wright | Every observable behavior becomes a contract |
| Postel / RFC 9413 | Postel 1980; IAB, 2023 | Be strict on input unless tolerance is specified |
| Kernighan's Law | Kernighan & Plauger, 1978 | Avoid clever code |
| Boy Scout Rule | Martin, 2008 | Tidy inside the lines you change; list the rest |
| Gall's Law | Gall, 1975 | Grow complex systems from working simple ones |
| Conceptual Integrity | Brooks, 1975 | Follow the existing design's vision |
| Beck's 4 rules | Beck; Fowler, 2015 | Tests → intention → no duplication → fewest elements |
| Crash Early | Hunt & Thomas | Stop on impossible states |
| Fail Fast | Shore, 2004 | No silent defaults; fail visibly and immediately |
| Law of Demeter | Lieberherr & Holland, 1989 | Talk only to immediate collaborators |
| Errors are values | Pike, 2015 | Handle errors with ordinary code |
| Primary Technical Imperative | McConnell, 2004 | Managing complexity drives everything else |

## Defaults where good sources disagree

- **Small vs deep functions** (Martin vs Ousterhout).
  - Extract when the result is deep and nameable; merge when readers have to flip between functions.
  - Never cap size by line count.
- **How many comments** (Martin: comments are failures; Ousterhout: missing comments cost far more than wrong ones).
  - Interface docs on every exported API.
  - Why-comments where code can't carry the intent.
  - No restating comments.
- **DRY vs AHA / WET.**
  - Deduplicate *rules* immediately.
  - For *look-alike code*, wait for the third use and stable requirements.
  - Inline abstractions that keep growing flags.
- **Exceptions vs Result.**
  - Exceptions for bugs and infrastructure failures; Result for expected domain outcomes.
  - Never both for the same failure.
- **Polymorphism vs switch vs table.**
  - Choose by the axis of change.
  - In measured hot paths, prefer data-oriented tables.
- **Fail fast vs robustness** (Shore keeps assertions on; McConnell removes hard crashes in shipped code).
  - Keep invariant checks on.
  - Contain failures per request or job with one top-level handler.
  - Never continue silently on a broken invariant.
- **Tell-Don't-Ask / Demeter vs data-oriented style.**
  - In OO domain models, keep behavior with the data.
  - DTOs, records and pipelines are read directly.
