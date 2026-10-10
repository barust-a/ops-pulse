# Python guide

The Python rules an agent needs on every task belong in a short nested `AGENTS.md` next to the
Python code, which the agent loads automatically there (see §13). The language-agnostic rules
(workflow, scope, hard limits, verification, naming, errors, tests) are in the root
[`AGENTS.md`](../../../AGENTS.md) and [`../base/`](../base/). This file is the reference by topic
behind both: open the section you need, not the whole file. A more specific instruction wins over
this file: the user's request, a closer AGENTS.md, a project's tool settings, a convention the code
already follows consistently. When one disagrees with this file, follow it and say so.

## 1. Commands

Inside one project, with [uv](https://docs.astral.sh/uv/):

```sh
uv run ruff check .     # lint
uv run ruff format .    # format (--check in CI)
uv run mypy             # type-check
uv run lint-imports     # import-linter contracts (§12)
uv run pytest -q        # tests
uv run pytest -q -n 4   # the whole suite on four pytest-xdist workers (§9)
```

The gate is format, lint, type-check, import contracts and tests, all green. `uv sync --locked`
rebuilds a project's `.venv` from its `uv.lock`; add or remove dependencies with `uv add` /
`uv remove`, never by editing the lock. A version pinned to reproduce a measurement (a
`constraint-dependencies` entry, a dedicated group) is not bumped without measuring again.

## 2. Naming

- Spell words out. Abbreviate only what every newcomer knows (`id`, `url`, `db`), never by dropping
  letters (`cnt`, `usr`, `mgr`): readers find bugs about 19% faster in code named with words.
- Detail grows with scope: `x` inside a two-line comprehension, a full phrase for a public or
  module-level name. Don't repeat what the scope says (`Order.total`, not `Order.order_total`);
  four words is plenty.
- No names that say nothing: `data`, `info`, `obj`, `tmp`, `val`, numbered siblings (`user2`), role
  nouns such as `Manager`, `Helper`, `Util`. Name the domain concept; if you can't, the boundary
  is probably in the wrong place.
- Keep data out of names: one dict keyed by the value, not `box1, box2` or a variable per key.
- No types in names (`user_list`, `name_dict`): plurals for collections (`users`),
  `<value>_by_<key>` for mappings (`user_by_id`).
- Booleans read as statements and are never negated: `is_ready`, `has_children`, `cache_enabled`,
  not `not_found` or `disable_cache`.
- A number's unit is in its name (`timeout_s`, `size_bytes`) or in its type (`timedelta`).
- Functions are verb phrases, classes and values noun phrases, and names don't lie: `get_*`,
  `is_*` and `has_*` change nothing; `is_*`/`has_*` return `bool`; `to_*` returns the result.
- One word per concept, taken from the domain's own vocabulary: pick one of `fetch`/`get`/`load`
  for an operation and keep it; use fixed pairs (`start`/`stop`, `open`/`close`).
- Don't shadow builtins or stdlib modules (`list`, `type`, a module called `logging.py`).
- Tests are named for behaviour and outcome: `test_refund_over_balance_is_refused`.

## 3. Functions

- One job at one level of abstraction. If describing it takes "and", or it mixes deciding with
  doing I/O, split it.
- Size by complexity, not line count. Past about 40 lines or a lint limit, look for a real seam;
  never split into helpers that share mutable state or only forward their arguments. Split only
  where each piece can be understood without reading the other.
- Guard clauses first, so the main path stays at the left margin; nesting past two levels is a
  signal to restructure. Name compound conditions: `is_overdue = due < today and not paid`.
- At most three positional parameters (PLR0917 with `pylint.max-positional-args = 3` in
  [`ruff.toml`](ruff.toml); it defaults to five); options are keyword-only, after `*`; values that
  always travel together become one frozen dataclass. A boolean flag is keyword-only, or the
  function splits in two (`render_page`, `render_suite`).
- Return one type. `X | None` only when absence is a normal outcome and the name says so
  (`find_user`); otherwise raise (`get_user` raises `UserNotFoundError`). Never signal errors with
  `-1`, `""` or `False`. More than three return values become a dataclass.
- A function answers a question or changes something, not both.
- Pass in what varies (the clock, randomness, clients, settings) instead of reaching for globals.
- Order a module for its reader: docstring, imports, constants, public API, then `_helpers` in the
  order they are first called.

## 4. Classes and data

- Start with functions and plain data. Write a class when state and the behaviour that keeps it
  valid belong together; a class with `__init__` and one other method is a function.
- Records and value objects: `@dataclass(frozen=True, slots=True, kw_only=True)` with immutable
  fields. Check invariants in `__post_init__`, so every instance is valid from construction;
  "change" one with `dataclasses.replace()`.
- A dict with a fixed set of keys never crosses a function boundary: make it a dataclass. Keep
  `TypedDict` for data that must stay a dict (JSON passed through, `**kwargs`).
- Make illegal states unrepresentable. Closed sets are a `StrEnum` or a `Literal`, not bare strings;
  variants are a union of small classes, not one class with optional fields and a `kind` string.
  Branch on them with `match` ending in `assert_never()`, so a new case becomes a type error;
  `kw_only` fields are not in `__match_args__`, so match records by keyword
  (`case Pages(pages=p)`). IDs that must not be swapped get a `NewType`; values with rules (`Email`, `Money`) a value object.
- Inherit only to implement an interface, never to share code (no mixins, no template methods):
  compose instead. Keep concrete hierarchies one level deep and mark overrides `@override`.
- No trivial getters or setters; `@property` only for cheap, side-effect-free values. A module-level
  function instead of a `@staticmethod`; `@classmethod` for named constructors (`Order.from_row`).
- No metaclasses, `__getattr__` tricks, dynamic classes or monkeypatching unless a framework
  demands them.

## 5. Architecture and modules

- Start with the simplest structure that works, often a module of functions, in one deployable (a
  modular monolith, not microservices). Add a layer, interface or pattern only for a problem you
  can name: every indirection is one more place a reader must look.
- **Functional core, imperative shell.** Decisions are pure functions from values to values, with
  no I/O, `datetime.now()` or `uuid4()` inside; a thin shell (CLI command, HTTP handler, job)
  gathers input, calls the core and applies the effects. The core is tested with plain data, the
  shell with a few integration tests.
- **Dependencies point inward:** entry points → services (one function per use case) → domain.
  The domain imports no framework, ORM, HTTP client, pydantic model or settings; adapters (database,
  HTTP, files, queues) depend on the domain, never the reverse. Enforce it with import-linter (§12).
- Entry points only parse input, call one service function and map domain errors to transport
  errors (HTTP status, exit code). Every entry point reuses the same services.
- **Parse, don't validate.** Turn raw input into precise types once, at the boundary (pydantic or
  msgspec there, dataclasses inside); a check returns the refined value (`parse_port(raw) -> Port`),
  not `None` or a `bool`. Core functions never take a `dict` or `Any` for structured data. When the
  API, storage and domain shapes differ, keep separate classes and map between them at the edge.
  Wire models share one base (`ConfigDict(frozen=True, extra="forbid")` plus the project's alias
  convention); pydantic parses only what enters from outside (HTTP bodies, LLM or library output),
  and past that edge the code uses plain frozen dataclasses.
- A FastAPI service's contract is its OpenAPI document: export `openapi.json` in-process, commit
  it, and have a test fail when it is stale. Declare every status a route can send, with one shared
  error model, and any non-JSON `200` body explicitly; run a conformance test (Schemathesis)
  against the app; a breaking change bumps the major of `FastAPI(version=...)`. Clients generated
  from it are never edited by hand.
- In a repository with several Python projects, code they share is a library package, not a
  service: no `app.py`, no `main.py`, no image, and an import-linter contract forbids FastAPI,
  pydantic and HTTP clients in it. Consumers depend on it through an editable
  `[tool.uv.sources]` path, so a change to it runs every consumer's tests. A rule all services
  apply lives there; each service keeps its own policy and its own errors.
- Wrap each third-party client in a thin adapter that speaks your domain (`payments.charge(order)`).
  Declare the port as a `Protocol` next to the code that uses it, and give every port an in-memory
  fake for tests.
- Wire collaborators in one composition root (`main()` or `bootstrap()`) and pass them in as
  parameters; tests call the same bootstrap with fakes. No singletons, service locators or factory
  hierarchies: pass a class or a callable. Reach for a DI framework only when wiring runs several
  levels deep.
- One typed settings object, one environment variable per value, built in the composition root
  and passed in. No `os.environ` reads elsewhere, no `if ENV == "production"`.
- Each design decision (a file format, a retry policy, a schema) is known by one module. Prefer deep
  modules, a small interface over real behaviour; delete pass-through layers and wrappers that copy
  the signature they wrap.
- A new abstraction (Protocol, base class, factory, layer) needs two users today, such as a real
  implementation and the fake the tests need; otherwise inline it. Repository, unit of work and a
  service layer pay off around real domain logic, not around CRUD.
- `src/<package>/` layout, tests in `tests/`, every setting in `pyproject.toml`. Group by feature
  (`billing/`, `ingest/`), and by layer only inside a feature that has grown; one module, one
  concept, named for it. No catch-all `utils.py`, `helpers.py` or `common.py`.
- `__init__.py` is empty or re-exports the public API with `__all__`; internals live under `_` names.
- Nothing runs at import: no I/O, settings, logging setup or registries at module level, and no
  mutable module state. Break an import cycle by fixing the dependency direction (move the shared
  concept down, or invert it with a Protocol), not with an import inside a function.
- A heavy or optional dependency (a GPU or ML stack) sits in its own dependency group, not in
  `dev`, and is imported inside the function that needs it, so the default environment, the
  tests and CI stay light. This is the one import inside a function the previous rule allows.
- Experiments and hand-run checks live beside `src/`, labelled by folder and file suffix
  (`experiments/`, `*_experiment.py`; `manual-checks/`, `*_manual.py`), with their lint
  relaxations as per-file ignores on those globs (`../base/testing.md`, "Where non-production code
  lives").

## 6. Types

- Annotate every parameter and return value of public functions and methods (`-> None` too). Gate
  on one checker at its strictest preset, version pinned (mypy `strict`, pyright `strict` or
  Pyrefly); Astral's `ty` is still beta, an editor aid rather than the gate.
- Never `Any`: `object` for "anything" (it forces narrowing), a `Protocol` for "anything with these
  methods", a type parameter for "the same type in and out". A suppression names its code and
  reason: `# type: ignore[arg-type]  # upstream stub is wrong`. A library that ships no `py.typed`
  gets one wrapper module and one `[[tool.mypy.overrides]]` entry, never a suppression at each
  call site.
- Parameters take the most abstract type the body needs (`Iterable`, `Mapping` from
  `collections.abc`); return types are concrete (`list[str]`); never return unrelated unions
  (`int | str`).
- On 3.12+, write `type Vector = list[float]` and `def first[T](items: Sequence[T]) -> T`. Use
  `Self`, `@override`, `TypeIs`, `Final`, and `-> Never` for functions that always raise.
  Exception: a `type` alias used in a pydantic model becomes a `$defs` entry and changes the wire
  schema; give those a plain alias (`ErrorCode = Literal[...]`).
- `if TYPE_CHECKING:` imports only to break a cycle or skip a costly import, never for names that
  pydantic or FastAPI resolve at runtime. For the same reason, no `from __future__ import
  annotations` in code that pydantic or FastAPI read.

## 7. Errors and logging

- One base exception per package, subclassed by what callers need to tell apart. Each deliberate
  error also keeps its built-in base (`ValueError` for a refused input, `RuntimeError` for a
  failed run); a test walks the classes to enforce both, and the `errors` module imports nothing
  else from the package. Exceptions carry the facts as attributes (the bad value, the limit);
  handlers read the attributes, never parse the message.
- A message says what failed, with the offending value, what was expected and how to fix it:
  `f"chunk_size={size} exceeds the model limit {limit}; lower it in config.toml"`. When the value
  could be a secret or personal data (a path, a user name, request content), the message is a fixed
  sentence and the facts travel only as attributes.
- An exception that crosses a process boundary is pickled: its `__init__` passes exactly its own
  arguments to `super().__init__()`, or unpickling fails. Test the round trip.
- Catch the narrowest exception around the fewest lines. `except Exception` only at an isolation
  point (one request, job or worker iteration) that logs with `logger.exception()`.
- Never swallow. To ignore one specific error on purpose: `with contextlib.suppress(KeyError):`.
- Translate with `raise StoreError(...) from err`; add context with `err.add_note(...)` and `raise`.
- Define errors out of existence where the meaning allows (`mkdir(exist_ok=True)`,
  `unlink(missing_ok=True)`); prefer `try`/`except FileNotFoundError` to checking first, which races.
- `assert` states internal invariants only; `python -O` strips it, so it never checks input.
- `logger = logging.getLogger(__name__)` in each module. Only the application's entry point
  configures logging, never a library. Log an error where it is handled, not at every layer it
  crosses. No secrets or personal data in logs.

## 8. Comments and docstrings

- Every module starts with a docstring saying what it is for. A public function or class gets one
  when its name and types don't tell a caller everything: units, valid ranges, what `None` means,
  side effects, the errors it raises. A library's public API always does. One style per project
  (Google or NumPy); don't restate the type hints.
- Comments explain why (a constraint, a trade-off, a workaround and its issue), never what the next
  line does: `wages *= 1.5  # overtime is paid at time and a half`.
- Before commenting confusing code, try a better name or an extracted function.
- A wrong comment is worse than none: update or delete comments in the same change as the code.
- A TODO points to an issue: `# TODO: https://tracker/1234 - drop once v1 is retired.`

## 9. Tests

- Test behaviour through the public API. A refactoring must never force a test change; tests never
  import `_private` names.
- One behaviour per test, named for it; arrange, act, assert, separated by blank lines.
- No logic in tests. Expected values are literals that come from the requirement, never from
  running the code under test (characterisation tests, §10, are the exception). Some duplication
  is fine.
- Tables of cases use `@pytest.mark.parametrize` with readable `id`s. `pytest.raises(Error,
  match=...)` wraps exactly one statement.
- Fixtures are function-scoped by default, live in the nearest `conftest.py`, and return a factory
  when a test needs several objects; `autouse` only for global safety nets. Use `tmp_path`,
  `monkeypatch`, `caplog` and `capsys` rather than hand-made setup.
- Unit tests are hermetic and fast: no network, sleeping, wall clock or unseeded randomness (inject
  the clock and the random generator). Fix or quarantine a flaky test the day it flakes.
- A test that needs Docker, a GPU or another external tool skips with a reason where it is missing
  (`pytestmark = pytest.mark.skipif(..., reason=...)`, or a custom marker); report it "not run",
  never as passing.
- Committed measurement results are never edited by hand: a new measurement is a new timestamped
  folder. Generated text (answers, reports) is as sensitive as the data it came from: keep it
  git-ignored and commit only ids, numbers and verdicts.
- Test doubles, best first: the real object if it is fast and deterministic, then a fake (a working
  in-memory version), a stub, a mock. Assert on resulting state; assert on calls only for side
  effects you cannot observe otherwise (an email sent).
- Don't mock what you don't own: never `patch("requests.get")` under business logic; fake your own
  adapter (§5) and cover the adapter with a few integration tests against the real thing. Needing
  `patch` is a design signal: pass the collaborator in. If you must, use `autospec=True` and patch
  where the name is looked up.
- Use Hypothesis property tests for parsers, serializers and calculations; pin each counterexample
  it finds with `@example`.
- Coverage, with branches on, shows untested behaviour; it is not a target.

**Speed and parallel runs.** The general rules are in `../base/testing.md` ("Speed and parallel
runs"); in Python:

- Run a whole suite on [pytest-xdist](https://pytest-xdist.readthedocs.io/) workers
  (`uv run pytest -q -n 4`, with `pytest-xdist` in the dev group). Leave `-n` out of `addopts`: a
  single test, `-s` and `--pdb` need a run without workers.
- Set the scheduling in `addopts`; without `-n` it changes nothing.
  - `--dist worksteal` by default: an idle worker takes tests queued on a busy one, so a few slow
    tests don't pile up on one worker. The default `load` let seven 4-second tests land together,
    and a 25-second suite took 63 s.
  - `--dist loadgroup` where a module starts something expensive (a container, a server): mark the
    module `pytest.mark.xdist_group("<name>")` so one worker runs it. Session and module fixtures
    run once per worker, not once per run.
- A monorepo runs its uv projects at once, each on a fixed few workers (`-n 4`). Several `-n auto`
  runs at once oversubscribe the CPU: a 0.1-second suite took 16 s just starting workers.
- Tests are safe in any worker: `tmp_path` rather than a fixed path, `monkeypatch` for the
  environment, port 0, and container names unique per process (`os.getpid()`).
- Measure with `--durations=10`, and after a warm run: the first run after `uv sync` compiles
  bytecode and looks slower than it is.

## 10. Refactoring

- Refactor to make the current change easy ("make the change easy, then make the easy change"), in
  code the task touches; leave stable code alone.
- Start green. Untested code first gets characterisation tests that pin today's behaviour, oddities
  included; report the oddities rather than fixing them inside the refactoring.
- One named refactoring at a time (Extract Function, Split Phase…); run tests, type checker and
  linter after each step; on red, revert to the last green state rather than debugging forward.
- Commit structure separately from behaviour, structure first, and name the refactoring in the
  message. A refactoring commit changes no test assertion.
- Remove duplicated knowledge (a rule that would change in both places for the same reason), not
  code that only looks alike. Extract at the third occurrence. When shared code grows a flag or a
  branch for one caller, inline it back and start over: duplication is far cheaper than the wrong
  abstraction.
- Replace big parts slice by slice behind a seam (Strangler Fig), never with a big-bang rewrite.

| Smell | Fix |
|---|---|
| Long function, deep nesting | Guard clauses, Decompose Conditional, Split Phase, Extract Function |
| Long parameter list, data clump | Introduce Parameter Object (a frozen dataclass); keyword-only options |
| Boolean flag argument | Remove Flag Argument: two functions |
| Strings or numbers with rules, magic numbers | Value object, `StrEnum`, `NewType`, named constant |
| Dict used as an object | Encapsulate Record: a dataclass |
| One change edits many modules | Move Function; combine what changes together |
| One module changes for many reasons | Split Phase; Extract Module |
| Unused parameter, one-implementation base class, dead option | Inline, Collapse Hierarchy, Remove Dead Code |
| The same `if`/`elif` on a type code in several places | One `match` with `assert_never`, or polymorphism |
| Inheritance used to share code | Replace Superclass or Subclass with Delegate |
| Calls that must happen in a set order | Pass values explicitly; objects valid at construction; context managers |

## 11. Security and performance

- Never trust data you did not produce: no `pickle`, `yaml.load`, `eval` or `exec` on it; SQL only
  with bound parameters; `subprocess.run([...], check=True, timeout=...)` with an argument list,
  never a shell string.
- A user-supplied path is resolved and must stay under its base directory
  (`path.resolve().is_relative_to(base)`); unpack tar files with `filter="data"`.
- Secrets come from the environment or a secret store, typed `SecretStr`; never in code, logs or
  the repository (`.env` ignored, `.env.example` committed). Tokens come from `secrets` and are
  compared with `hmac.compare_digest`. Every outbound HTTP call has a timeout.
- Measure before optimising (cProfile, py-spy, Scalene) and show before/after numbers. Fix the
  algorithm or data structure before micro-tuning; stream large data with generators;
  `functools.cache` only on pure functions, never on methods.
- asyncio: start tasks inside `async with asyncio.TaskGroup()`, bound waits with
  `asyncio.timeout()`, and never block the loop with sync I/O, `time.sleep` or CPU-heavy work;
  use `await asyncio.to_thread(...)` instead.

## 12. What the tools check, and what they do not

The tools enforce the mechanical rules: naming shapes, mutable defaults, `is None`, bare and blind
`except`, `raise ... from`, f-strings in logging calls, `print`, positional boolean flags, unused
arguments, magic numbers, complexity limits, `Any`, outdated syntax, `os.path`, naive datetimes,
shell injection, unsafe deserialization, imports that break the layering. Their settings live in
`pyproject.toml`. For Ruff, start from [`ruff.toml`](ruff.toml) in this folder: copy it, or `extend`
it from each project (its header says how the settings merge). The rest of a starting point for a
project that has none:

```toml
[tool.mypy]
strict = true
enable_error_code = ["explicit-override", "ignore-without-code", "possibly-undefined", "deprecated"]

[tool.pytest.ini_options]
addopts = ["--import-mode=importlib", "--strict-markers", "--strict-config"]
xfail_strict = true

[tool.coverage.run]
branch = true

[tool.importlinter]
root_package = "shop"
include_external_packages = true  # needed to forbid third-party packages

[[tool.importlinter.contracts]]
name = "Dependencies point inward"
type = "layers"
layers = ["shop.entrypoints", "shop.services", "shop.adapters", "shop.domain"]

[[tool.importlinter.contracts]]
name = "The domain stays pure"
type = "forbidden"
source_modules = ["shop.domain"]
forbidden_modules = ["sqlalchemy", "fastapi", "httpx", "pydantic"]
```

In a codebase that already breaks a contract, list today's violations in `ignore_imports` and
shrink the list. Never raise a threshold or add a bare `noqa` to get green: refactor, or suppress
one rule on one line with a reason. The tools cannot tell whether a name says what it means, a
function does one job, an abstraction earns its place, a test checks the right behaviour, a comment
is still true, or the change does what was asked and nothing more. That is the author's and the
reviewer's job: ask of every diff whether a newcomer can understand it quickly, and whether the
next person to change it is likely to break something.

## 13. Adopting it in a project

- Put the Python rules an agent needs on every task in a nested `AGENTS.md` (at most about 100
  lines) in the directory that holds the Python code, with a sibling `CLAUDE.md` containing the
  single line `@AGENTS.md` so Claude Code loads it too. Start it with the exact commands (§1).
- Pick from this guide only the rules your ruff, mypy and import-linter configuration does not
  already enforce (§12); a rule a tool checks costs tokens and adds nothing. Link back here for
  the depth.
- Back the architecture (§5) with import-linter contracts rather than prose, and name each
  contract so it reads as the fix instruction an agent sees on failure ("Dependencies point
  inward", "The domain stays pure").
- Record how the project already does something (its settings object, its exception naming, its
  test layout) in that nested `AGENTS.md`, not here.

## 14. Keeping this file useful

State each rule once, as something a reviewer can check. When agents keep making the same mistake,
add a line; when a tool starts enforcing a rule, delete it here. A rule that changes what an agent
does on most Python tasks belongs in the nested `AGENTS.md` beside the Python code, which is loaded
automatically; this file holds the depth. Keep every AGENTS.md on the path from the repository root
down under 32 KiB combined: Codex silently drops what comes after.

## Sources

Style and naming:
[PEP 8](https://peps.python.org/pep-0008/) ·
[PEP 257](https://peps.python.org/pep-0257/) ·
[Google Python Style Guide](https://google.github.io/styleguide/pyguide.html) ·
[Effective Python, 3rd ed.](https://effectivepython.com/) ·
[Sweigart, naming](https://inventwithpython.com/beyond/chapter4.html) ·
[Hilton & Hermans, naming guidelines](https://hilton.org.uk/presentations/naming-guidelines.html) ·
[Hofmeister et al. 2017](https://brains-on-code.github.io/shorter-identifier-names.pdf) ·
[Arnaoudova, linguistic antipatterns](https://veneraarnaoudova.com/linguistic-anti-pattern-detector-lapd/LAs/) ·
[Batchelder, data out of names](https://nedbatchelder.com/blog/201112/keep_data_out_of_your_variable_names.html) ·
[Beck, reading order](https://newsletter.kentbeck.com/p/reading-order)

Readability and design:
[Zakirullin, cognitive load](https://github.com/zakirullin/cognitive-load) ·
[Ousterhout vs Martin](https://github.com/johnousterhout/aposd-vs-clean-code) ·
[qntm on Clean Code](https://qntm.org/clean) ·
[Google, reduce nesting](https://testing.googleblog.com/2017/06/code-health-reduce-nesting-reduce.html) ·
[Google, what reviewers look for](https://google.github.io/eng-practices/review/reviewer/looking-for.html)

Architecture:
[Architecture Patterns with Python](https://www.cosmicpython.com/book/preface.html) ·
[King, parse don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/) ·
[Bernhardt, Boundaries](https://www.destroyallsoftware.com/talks/boundaries) ·
[Rhodes, Python design patterns](https://python-patterns.guide/) ·
[Schlawack, design pressure](https://hynek.me/talks/design-pressure/) ·
[Schlawack, subclassing](https://hynek.me/articles/python-subclassing-redux/) ·
[tef, code easy to delete](https://programmingisterrible.com/post/139222674273/how-to-write-disposable-code-in-large-systems) ·
[Fowler, Monolith First](https://martinfowler.com/bliki/MonolithFirst.html) ·
[Kraken's Python monolith](https://blog.europython.eu/kraken-technologies-how-we-organize-our-very-large-pythonmonolith/) ·
[import-linter contracts](https://import-linter.readthedocs.io/en/stable/contract_types/) ·
[src layout](https://packaging.python.org/en/latest/discussions/src-layout-vs-flat-layout/)

Types and errors:
[typing best practices](https://typing.python.org/en/latest/reference/best_practices.html) ·
[attrs, why not dicts](https://www.attrs.org/en/stable/why.html) ·
[Python tutorial, errors](https://docs.python.org/3/tutorial/errors.html) ·
[Google, error messages](https://developers.google.com/tech-writing/error-messages)

Refactoring:
[Fowler, refactoring catalog](https://refactoring.com/catalog/) ·
[Feathers, characterization tests](https://michaelfeathers.silvrback.com/characterization-testing) ·
[Metz, the wrong abstraction](https://sandimetz.com/blog/2016/1/20/the-wrong-abstraction) ·
[Google, don't DRY prematurely](https://testing.googleblog.com/2024/05/dont-dry-your-code-prematurely.html) ·
[Beck, augmented coding](https://newsletter.kentbeck.com/p/augmented-coding-beyond-the-vibes) ·
[Fowler, Strangler Fig](https://martinfowler.com/bliki/StranglerFigApplication.html)

Tests, tools and operations:
[Software Engineering at Google, unit testing](https://abseil.io/resources/swe-book/html/ch12.html) ·
[pytest good practices](https://docs.pytest.org/en/stable/explanation/goodpractices.html) ·
[pytest-xdist, distribution modes](https://pytest-xdist.readthedocs.io/en/stable/distribution.html) ·
[Schlawack, what to mock](https://hynek.me/articles/what-to-mock-in-5-mins/) ·
[Fowler, test coverage](https://martinfowler.com/bliki/TestCoverage.html) ·
[logging HOWTO](https://docs.python.org/3/howto/logging.html) ·
[security considerations](https://docs.python.org/3/library/security_warnings.html) ·
[asyncio development](https://docs.python.org/3/library/asyncio-dev.html) ·
[Ruff rules](https://docs.astral.sh/ruff/rules/) ·
[twelve-factor config](https://12factor.net/config)

Instructions for agents:
[agents.md](https://agents.md/) ·
[Claude Code memory](https://code.claude.com/docs/en/memory) ·
[Anthropic prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) ·
[GitHub, lessons from 2,500 agents.md files](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/) ·
[Gloaguen et al. 2026, evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) ·
[Codex 32 KiB truncation](https://github.com/openai/codex/issues/7138)
