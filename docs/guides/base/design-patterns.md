# Design patterns, across paradigms

**Read this when:**
- you are considering an abstraction, interface, factory, class hierarchy or "pattern";
- a conditional keeps repeating;
- logic is tangled with I/O;
- you are adding retries, circuit breakers or other resilience patterns;
- you are reviewing code that feels over-engineered.

Project rules in `AGENTS.md` override this file. Mechanics for reaching a pattern by refactoring are in `refactoring.md`.

## Principles

1. **Start from a problem you have now, not from a pattern.** GoF themselves warn that patterns add indirection and cost, and should be applied only when the flexibility is actually needed. Choose a pattern for the problem, not for the technology (Azure Architecture Center).
2. **Program to an interface, not an implementation** (GoF).
   - In TS, the interface is the narrow structural type the *consumer* declares.
   - Don't mirror every class with an `IFoo`: an interface with one implementation is a smell (Seemann).
   - Extract the interface once a second implementation exists. A real test fake counts.
3. **Favor object composition over class inheritance** (GoF). Inheritance is brittle white-box reuse. Never inherit just to share code.
4. **Use the lightest form the language allows.** Norvig: 16 of the 23 GoF patterns are invisible or simpler in dynamic languages with first-class functions. In TS/JS, try these in order and stop at the first that works:
   1. pass a function;
   2. a `Record`/`Map` lookup;
   3. a closure or factory function;
   4. an object literal;
   5. a class;
   6. a class hierarchy.
5. **A pattern must pay for its indirection.** It must remove more conditionals and duplication than it adds in types, files and call hops. If nobody can name the variation point it protects, inline it.
6. **Move toward a pattern only on evidence**: a second real variant, a repeated conditional, a test that is painful to write. Move back out when the variation disappears (Kerievsky: refactor *to*, *towards* or *away from* patterns).
7. **Use a pattern's name only when the code really is that pattern.**
8. **Keep I/O at the edges and decisions in pure functions.** This removes most of the need for mocks, DI containers and service locators.

## GoF patterns and their idiomatic forms

C = creational, S = structural, B = behavioral. † = invisible or simpler in dynamic languages (Norvig).

| Pattern | Kind | Intent | Use when | Avoid when | Idiomatic TS/JS/FP form |
|---|---|---|---|---|---|
| Abstract Factory† | C | Create families of related objects | Several products must vary together (platform, theme, test vs prod) | One family, or products vary independently | An object of creator functions passed in |
| Builder† | C | Separate step-wise construction from representation | Staged or validated construction; one process, several representations | Merely many optional fields | Options object + defaults `{ ...DEFAULTS, ...opts }`. Fluent builders only for real DSLs |
| Factory Method† | C | Let a creator decide the concrete product | Concrete type depends on input or config, and callers mustn't know | Only one type exists; the factory just wraps `new X()` | Factory function returning an interface type; `Record<Kind, () => T>` |
| Prototype | C | Create objects by copying a configured instance | Copying beats rebuilding | Objects own resources or identity; deep vs shallow copy is unclear | `{ ...base, ...overrides }`, `structuredClone` |
| Singleton | C | One instance, global access | A genuinely one-per-process resource — and even then, inject it | Almost always: hidden dependency, order-dependent tests, per-request leaks | A module-level value created in the composition root and passed as a parameter |
| Adapter | S | Convert an interface into the one clients expect | A third-party or legacy API has the wrong shape for your port | You own both sides (change one) | A wrapper function mapping names and data. At a system boundary this is an Anti-Corruption Layer |
| Bridge | S | Let abstraction and implementation vary independently | Two independent axes would multiply subclasses (N×M) | Only one axis varies | Pass the implementation in as an object of functions |
| Composite | S | Treat single objects and trees uniformly | Recursive part–whole data: UI trees, ASTs, rule groups | Flat data | Recursive discriminated union + recursive function |
| Decorator | S | Add responsibilities by wrapping | Cross-cutting behavior (retry, cache, logging, metrics) around a stable interface | Deep wrapper stacks whose order matters; one-off behavior | A higher-order function `withRetry(fn)`, or middleware |
| Facade† | S | A simple interface to a complex subsystem | Callers repeat the same multi-step orchestration | It becomes a pass-through for everything | A module exporting a few functions |
| Flyweight† | S | Share immutable state across many objects | You have *measured* memory pressure from duplicates | Not measured | Frozen values interned in a `Map` |
| Proxy† | S | Stand-in controlling access to an object | Lazy loading, access control, remote stubs, caching | A plain wrapper would do; hot paths | A wrapper of the same type. Native `Proxy` only for transparent interception |
| Chain of Responsibility† | B | Pass a request along handlers until one handles it | Ordered, pluggable handlers: middleware, validation, fallbacks | Fixed logic; one function with early returns is clearer | An array of `(req, next) =>` handlers; `handlers.find(h => h.canHandle(x))` |
| Command† | B | Wrap a request as an object | Queue, schedule, serialize, retry, audit or undo operations | A callback is enough | A closure; if it must be serializable, `{ type, payload }` + an interpreter function |
| Interpreter† | B | Represent and evaluate a small language | A small, stable DSL (filters, rules) evaluated repeatedly | A large grammar (use a parser library) | Union-typed AST + recursive `evaluate` with an exhaustive `switch` |
| Iterator† | B | Traverse without exposing storage | Custom collections; lazy, infinite or paged sequences | Arrays already suffice | `Symbol.iterator`, `function*`, `for…of`, `for await`, iterator helpers |
| Mediator† | B | Centralize many-to-many interactions | Components tangled by references to each other | It grows into a God object | A coordinating function or store; a parent passing callbacks |
| Memento | B | Capture and restore state | Undo/redo, snapshots, rollback | Large state snapshotted often (store patches instead) | Immutable state: the previous value *is* the memento; keep a history array |
| Observer† | B | Notify dependents of changes | One-to-many change propagation across decoupled parts | One listener (call it directly); untraceable control flow | `EventTarget`, an emitter or signals. `subscribe(fn)` returns an unsubscribe function |
| State† | B | Behavior changes with internal state | A lifecycle with transitions; `status` checks repeated across methods | Two or three trivial states | Discriminated union of states + a `(state, event) => state` reducer |
| Strategy† | B | Interchangeable algorithms | Config or input selects the algorithm | A couple of algorithms that rarely change | Pass a function; a `Record<Key, Fn>` |
| Template Method† | B | A fixed algorithm skeleton with variable steps | A fixed sequence with a few varying steps | Inheritance used only to share code | A higher-order function taking the step functions |
| Visitor† | B | Add operations over a stable set of node types | Many operations, stable node types | Node types change often (every visitor must change) | A union + one exhaustive `switch` per operation (`never` check) |

**Choosing between unions and classes is the expression problem:**
- Classes make it easy to add *types*.
- Unions with exhaustive switches make it easy to add *operations*.

Choose by which axis changes more often.

## Functional patterns

- **Higher-order functions replace Strategy, Command, Template Method and Visitor.** Pass behavior as arguments.
- **Pipelines of small pure steps** (parse → decide → format).
  - Name the intermediate values.
  - Avoid long point-free chains; they hide types and are hard to debug.
- **Functional Core, Imperative Shell** (Gary Bernhardt).
  - The core is pure business logic that operates only on the data it is given; test it with plain values and no doubles.
  - The thin shell does the I/O: DB, network, clock, email.
- **Dependency rejection** (Seemann):
  1. Gather data from impure sources.
  2. Pass pure data to pure functions.
  3. Act on the pure output.

  Prefer this to injecting impure dependencies deep into logic. Closures and partial application (`makeCheckout(deps)(cart)`) are lightweight DI at the edges.
- **Immutability.** Treat domain values as immutable: `readonly`, `as const`, return new objects. Mutate locally only where profiling demands it.
- **Algebraic data types and exhaustive matching.**
  - Model alternatives as discriminated unions; handle them with `switch` plus a `never` check.
  - Make illegal states unrepresentable (Minsky): one variant per state, each carrying only the fields valid in that state.
- **Absence.** In TS, use `T | undefined` with narrowing. Add an Option type only if the codebase already uses an FP library.
- **Result types and Railway-Oriented Programming** (Wlaschin), for *expected domain errors* that are part of the business process.
  - In TS: `type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`.
  - Wlaschin's own limits apply. Don't use Result:
    - for bugs, or where you need stack traces;
    - to re-implement exceptions;
    - when failing fast is right;
    - for errors nobody will handle;
    - in hot or interop code.
  - Model the minimum, and let the rest be exceptions.
- **Parse, don't validate** (Alexis King).
  - A parser turns less-structured input into more-structured output. Parse once at the boundary into refined types (`Email`, `NonEmptyArray`, branded IDs), then trust them.
  - Treat `validate(): void` with suspicion; return the refined value instead.
  - Avoid "shotgun parsing": validation scattered through processing code.
- **Effects as data** (`{ type: "SendEmail", … }` interpreted by the shell). Useful for testing complex orchestration; overkill for CRUD.

```ts
type Connection =                                   // illegal states unrepresentable
  | { state: "connecting"; initiatedAt: Date }
  | { state: "connected"; sessionId: string; lastPingAt?: Date }
  | { state: "disconnected"; disconnectedAt: Date };
```

## Enterprise and DDD patterns

- **Choose domain-logic organization by complexity** (Fowler, PoEAA):
  - Transaction Script (one procedure per request) for simple logic.
  - Domain Model (objects with data *and* behavior) when rules interact.
  - Avoid the Anemic Domain Model between them: getter/setter bags whose rules all live in services. It pays the costs of a domain model with none of the benefits.
- **Active Record vs Data Mapper.**
  - Active Record (a row wrapper plus domain logic) is fine when objects match tables.
  - Data Mapper keeps objects and schema independent.
- **Repository:** a collection-like interface per aggregate that needs global access. Use domain-named queries (`findOverdue()`), not generic pass-throughs.
- **Unit of Work:** prefer the one your ORM or transaction API already provides.
- **Service Layer:** a thin application boundary that coordinates and delegates. It holds no business rules.
- **Gateway:** wrap every SDK or external HTTP API in one. This enables a service stub in tests.
- **Data Transfer Object:** DTOs live only at process and API edges. Parse them into domain types; never let them into the domain.
- **Value Object:** equality by value, immutable, side-effect-free operations. In TS: a readonly type plus a smart constructor.
- **Entity:** defined by identity, not by attributes.
- **Aggregate:**
  - Outsiders reference only the root, and the root enforces the invariants.
  - Keep aggregates small.
  - Reference other aggregates by identity (`productId: ProductId`, not `product: Product`).
  - Modify one aggregate per transaction (a rule of thumb), with eventual consistency outside the boundary.
- **Domain Event:** a past-tense fact (`OrderShipped`). Publish via a transactional outbox.
- **Domain Service:** an operation that belongs to no entity or value object. Usually just a function in the domain module.
- **Factory (DDD):** create a whole aggregate with its invariants enforced. In TS: a smart constructor returning a `Result`.
- **Bounded Context:** explicitly scope where a model applies, and translate at the seams. No giant shared model.
- **Anti-Corruption Layer:** an isolating layer that speaks your model to an upstream system.
- **Special Case / Null Object:** a constant default object (`NO_DISCOUNT`) instead of repeated null checks — but only where "absent" really has a neutral behavior. Otherwise make absence explicit.
- **Skip the tactical DDD patterns in CRUD and reporting contexts.** Reserve aggregates for contexts with real invariants.

## Resilience and integration patterns

- **Timeouts** on every remote and cross-process call: connection timeout and request timeout.
- **Retries:** transient faults only.
  - Capped exponential backoff with full jitter: `delay = random(0, min(cap, base × 2 ** attempt))`.
  - At a single layer of the stack, within a retry budget (token bucket).
  - Never for 4xx or business errors, and never as a fix for capacity problems.
  - Add jitter to timers and periodic jobs too.
- **Idempotency:** side-effecting APIs aren't safe to retry without it.
  - Clients send an idempotency key; the server stores and replays the result.
  - Message consumers deduplicate, because delivery is at-least-once.
- **Circuit Breaker** (closed / open / half-open).
  - Use it only for long outages where failing fast enables a meaningful fallback.
  - Wrap retries *around* the breaker.
  - Test the open state.
  - Some teams prefer retry budgets to breakers, because breakers add hard-to-test modal behavior.
- **Bulkhead:** isolate pools or concurrency limits per dependency, so one failure can't sink the rest.
- **Transactional Outbox:** write the business change and the outgoing message in one DB transaction; a relay publishes the message. Never save, then publish, as two writes.
- **Saga:** a sequence of local transactions with compensations.
  - It has no automatic rollback and no isolation.
  - First check whether moving the boundary lets one service own the invariant.
- **Cache-Aside:**
  - read: cache → store on a miss → fill the cache;
  - write: update the store, then delete the cache entry;
  - always set an expiry.
- **Queue-Based Load Leveling** (with Competing Consumers) to absorb spikes.
- **Strangler Fig** for incremental replacement → `refactoring.md`.

## Symptom → pattern

| Symptom in code | Candidate pattern | Simpler alternative to try first |
|---|---|---|
| The same `switch` on a kind repeated across functions | Strategy / polymorphism | `Record<Kind, Fn>`, or a union with one exhaustive switch per operation |
| Status flags plus optional fields valid only in some states | State | A discriminated union of states plus a reducer |
| Constructor with many optional parameters | Builder | Options object with defaults |
| `new Concrete()` scattered; tests can't substitute it | Factory / DI container | Pass the dependency or a creator function; wire in the composition root |
| `getInstance()` or mutable module state | Singleton | A value created at startup and passed explicitly |
| SDK or legacy types leaking into the domain | Adapter / Gateway / ACL | Mapping functions in one boundary module |
| Logging, retry or caching repeated around many calls | Decorator / Proxy | A higher-order `withX(fn)` |
| Several parts must react to a change | Observer | A direct call when there's one listener |
| Undo, audit or queueing of actions | Command / Memento | Immutable state + history; action objects |
| Many operations over tree or AST nodes | Visitor / Composite | Recursive union with exhaustive switches |
| Same steps with a few varying ones, spread across classes | Template Method | A higher-order function taking the steps |
| `if (!valid) throw` checks scattered through business code | Parse, don't validate | One parse at the boundary into a refined type |
| Logic tangled with I/O; tests need many mocks | Functional Core / Imperative Shell | Extract a pure `(data) => decision` function |
| Remote call hangs or fails intermittently | Timeout + Retry (+ Circuit Breaker) | A timeout first, then a bounded jittered retry at one layer |
| Duplicate records or charges after retries | Idempotency key / Idempotent Consumer | Upsert keyed by a client-supplied ID |
| Save, then publish (dual write) | Transactional Outbox | — (within one service, a DB transaction) |
| A business transaction spans services | Saga | Redraw boundaries so one service owns the invariant |
| Slow, repeated reads of rarely changing data | Cache-Aside | Fix the query or index; bounded memoization with a TTL |
| Load spikes overwhelm a dependency | Queue-Based Load Leveling / Bulkhead | A concurrency limit per dependency |
| Entities are getter/setter bags; services hold every rule | Domain Model | A deliberate Transaction Script, if the rules are simple |
| Repeated null checks for "none" | Special Case / Null Object | `T \| undefined` with narrowing |

## Anti-patterns

| Anti-pattern | How to spot it | Remedy |
|---|---|---|
| God Object | References many unrelated types; huge, uncategorized method list; `*Manager`, `*Utils` | Split by responsibility into feature modules |
| Singleton overuse | Hidden global state; order-dependent tests; per-request data leaking between requests | Create in the composition root; pass explicitly; request-scoped context |
| Service Locator | `container.get()` inside business code; missing dependencies found at runtime | Constructor or parameter injection; resolve only in the composition root |
| Anemic Domain Model | Getter/setter bags; every rule lives in services | Move invariant-enforcing behavior into entities and value objects, or choose Transaction Script deliberately |
| Golden Hammer | One familiar tool for every problem | State the problem first; compare at least two options |
| Lava Flow | Half-finished experimental code that others built on | Delete it under test coverage; time-box experiments |
| Boat Anchor | Unused code kept "just in case" | Delete it; version control remembers |
| Cargo Cult Programming | Code or structure with no purpose anyone can state | Require a reason for each construct; remove it and run the tests |
| Poltergeist | Short-lived, stateless object that only kicks off another class | Inline it, or make it a function |
| Big Ball of Mud | Haphazard, sprawling, no visible structure | Draw a boundary around the mess, then strangle it piece by piece |
| Copy-and-Paste Programming | Near-identical blocks; one fix needed in many places | Extract only when the copies change for the *same reason* |
| Spaghetti Code | Convoluted control flow | Guard clauses, extracted functions, explicit state machines |
| Speculative Generality | One-implementation interfaces; factories wrapping `new X()`; unused parameters or hooks | Inline the abstraction; reintroduce it when a second variant appears |
| Shotgun Parsing | Validation scattered through processing code | Parse at the boundary |
| Magic Pushbutton | Business logic lives in UI event handlers | Domain functions called from thin handlers |
| Sequential Coupling | Methods must be called in a fixed order (`init`, `begin`, `start`) | A factory that returns ready-to-use objects; a single function |
| Inner-Platform Effect | A configurable system that becomes a poor replica of its platform | Logic in code; only data in configuration |
| Yo-yo Problem | Deep inheritance; readers flip between many class definitions | Flatten; use composition |

## Pragmatic defaults where sources disagree

- **Patterns: language workarounds or shared vocabulary?** Keep the vocabulary; implement in the lightest native form.
- **Circuit breakers vs retry budgets.**
  - Default: timeouts plus bounded, jittered retries at one layer.
  - Add a breaker only when a fail-fast fallback is meaningful, and test the open state.
- **Result vs exceptions.**
  - Result for expected domain outcomes; exceptions for bugs and infrastructure failures.
  - Never both for the same failure.
- **Rich vs anemic models.**
  - Each invariant lives in exactly one place: a type plus a smart constructor, or an entity method.
  - Never scatter an invariant across services.
- **DI containers vs plain functions.**
  - Wire by hand in a composition root.
  - Use a container only when the framework requires one, and never resolve inside the domain.
- **Interfaces up front vs extracted later.** Declare a consumer-side type once a second implementation exists. Structural typing lets fakes work without declared interfaces.
- **Singleton.** Module-level *constants* are fine; mutable module state is the hazard.
