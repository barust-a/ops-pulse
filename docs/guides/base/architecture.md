# Architecture and code segmentation

Read when you are:
- creating a new module or package, or splitting, merging or moving modules;
- choosing folders or layers;
- adding a dependency between modules;
- making a change that touches many places at once;
- reviewing structure.

Project rules and the existing structure override this file. Propose reorganizations separately, never as a side effect of another task.

A "module" here means any unit with an interface: a function, file, class, package or service. The rules apply in every paradigm.

## Rules that always apply

1. **Split around decisions likely to change, not around processing steps.** Each volatile decision has exactly one owner module that hides it (Parnas). Examples: storage, wire format, vendor API, a pricing rule.
2. **Make modules deep:** a small, simple interface over substantial functionality. A shallow module, whose interface is nearly as complex as its implementation, adds cost and hides nothing.
3. **Organize by feature or domain, not by technical type.** What changes together lives together (Common Closure Principle).
4. **Dependencies point toward stable, abstract, domain code.**
   - Domain code imports no framework, database or HTTP code.
   - There are no dependency cycles between modules.
5. **Each module has one public surface.** Other modules import only from it, never from its internals.
6. **Follow the existing structure.** Where the project has boundary tools, use them to enforce the boundaries.

## Foundations

- **Parnas (1972).** Begin with a list of difficult design decisions, or decisions likely to change. Design each module to hide one of them. Modules then stop corresponding to processing steps.
- **High cohesion inside a module, low coupling between modules.** The two usually go together.
- **Grade coupling with connascence** (Page-Jones; Weirich). Two pieces of code are connascent when changing one forces a change in the other.
  - **Static forms, from weaker to stronger:** name, type, meaning (magic values), position, algorithm.
  - **Dynamic forms, stronger still:** execution order, timing, value, identity.
  - **Rules:**
    - Convert strong forms into weaker ones.
    - The farther apart two pieces of code are, the weaker their connascence must be.
    - Strong connascence inside one small function is fine.
  - **Examples:**
    - Positional parameters across a module boundary → an options object (position becomes name).
    - Shared magic strings → an exported union type (meaning becomes type).

## Ousterhout: complexity and deep modules

From *A Philosophy of Software Design*, 2nd ed.

- **Where complexity comes from.** It comes from dependencies and obscurity. It shows up as change amplification, cognitive load and unknown unknowns. It builds up incrementally, so sweat the small stuff.
- **Make modules deep.**
  - Simple interfaces for the common case, with significant functionality behind them.
  - A simple interface matters more than a simple implementation.
- **Encapsulate knowledge, not time.** Structuring code by the order in which operations run ("temporal decomposition") leaks information. Example: `readConfig`, `parseConfig` and `writeConfig` all knowing the file format. Give each piece of knowledge one home.
- **Somewhat general-purpose interfaces are deeper.**
  - Generalize the interface, not the feature set.
  - Keep special-purpose code apart from general-purpose code.
- **Different layer, different abstraction.** Adjacent layers with similar interfaces are a red flag.
  - Delete pass-through methods (e.g. controller → service → repository forwarding the same arguments), or give each layer a distinct job.
  - Replace pass-through variables with a context object.
- **Pull complexity downward.** Most modules have more users than developers. Handle defaults and errors inside the module rather than pushing them onto every caller or adding configuration knobs.
- **Together or apart?** Join code that shares information, that gets a simpler interface when joined, or that would otherwise be duplicated. Every new interface adds complexity.
- **Design it twice.** For a new module or public API, sketch two radically different interfaces and compare them before choosing.
- **Be strategic, not tactical.** Make continual small investments in the design; working code isn't enough.

| Red flag | Meaning |
|---|---|
| Shallow Module | The interface isn't much simpler than the implementation |
| Information Leakage | One design decision is reflected in several modules |
| Temporal Decomposition | Structure follows the order of execution, not information hiding |
| Overexposure | Common uses force callers to know about rarely used features |
| Pass-Through Method | A method does little except forward to one with a similar signature |
| Repetition | A nontrivial piece of code is repeated |
| Special-General Mixture | Special-purpose code isn't separated from general-purpose code |
| Conjoined Methods | You can't understand one method without reading the other |
| Comment Repeats Code | Everything in the comment is obvious from the code next to it |
| Implementation Documentation Contaminates Interface | The interface comment describes implementation details users don't need |
| Vague Name | The name conveys little useful information |
| Hard to Pick Name | No precise, intuitive name comes to mind — often a design problem |
| Hard to Describe | Complete documentation must be long |
| Nonobvious Code | Behavior or meaning can't be understood quickly |

## SOLID, read carefully, and the alternatives

- **SRP (Single Responsibility Principle):** a module is responsible to one actor. Gather together things that change for the same reasons; separate things that change for different reasons.
  - It does not mean "do one thing".
  - It never justifies one-function files.
- **OCP, ISP and DIP are useful as questions and harmful as rules.** Wrap each third-party or I/O dependency in a thin adapter you own; add an interface or port only once a second implementation exists (a test fake counts). Not for every class.
- **LSP:** subtypes must honor the contract of the type they replace. This is the uncontroversial one.
- **CUPID** (Dan North): properties to move toward, not rules to obey.
  - Composable
  - Unix philosophy: does one thing well
  - Predictable
  - Idiomatic
  - Domain-based
- **GRASP** (Larman): start with *Information Expert* — give a responsibility to the module that has the information to fulfil it.
- **Package principles** (Martin), for workspace packages:
  - **Common Closure:** things that change together are packaged together. This drives folder structure.
  - **Common Reuse:** things used together are packaged together. This keeps packages lean.
  - **Acyclic Dependencies:** no cycles.
  - **Stable Dependencies:** depend in the direction of stability.
  - **Stable Abstractions:** the more stable a package, the more abstract it should be.

  Volatile feature code depends on stable shared code, never the reverse.

## Organizing styles, and when they are overkill

- **Feature folders / vertical slices** (Bogard). This is the default for applications.
  - Minimize coupling between slices; maximize it within a slice.
  - Each slice decides how to fulfil its request.
- **Package by component** (Simon Brown). A coarse-grained component bundles its logic and persistence behind one interface, enforced by visibility. If everything is public, packages are just folders.
  - Layering is fine at small granularity.
  - Large systems split their top level into domain modules, each layered internally (Fowler).
- **Ports and Adapters / hexagonal** (Cockburn). The application can be driven by users, programs, tests or scripts, and developed and tested without its runtime devices and databases. Keep ports few: two to four.
  - Onion and Clean Architecture apply the same rule: source dependencies point inward only.
  - Pass simple data structures across boundaries, not ORM rows.
- **Screaming architecture.** Top-level folders name the domain (`billing`, `orders`), not the framework (`controllers`, `services`).
- **Modular monolith.** One deployment unit, divided into modules with explicit contracts.
  - Default to it.
  - Extract a service only for a concrete need: independent scaling, deployment or ownership.
- **Conway's law.** System structure mirrors the organization's communication structure. Align module boundaries with ownership.
- **When these are overkill:** scripts, spikes, prototypes and small CRUD apps.
  - Use plain feature files, with no ports or layers beyond what the tests need.
  - Don't split speculatively: real use reveals the right seams (tef).
- **Record structural decisions as ADRs:** boundaries, layering rules, new modules. See `collaboration.md`.
- **Keep an area map** once code for one real-world area is spread over several apps, packages or languages: one page (`docs/area-map.md`), one row per area, one column per app or package, naming the folder that holds it. It answers "where does X live" without a search, and a split that differs from the plan is explained under the table.

## Segmentation heuristics

- **Co-locate what changes together** (change locality). Place code as close as possible to where it is used.
  - *Locality of behavior:* a unit's behavior should be obvious from the unit itself.
  - This trades off against DRY. Prefer locality for code and DRY for knowledge.
- **Write code that is easy to delete, not easy to extend** (tef):
  - Repeat yourself to avoid creating dependencies, but don't repeat yourself to manage them.
  - Isolate the hard-to-write and likely-to-change parts from the rest, and from each other.
  - One awful component with a simple interface beats two that need careful coordination.
- **Simple is not the same as split** (Rich Hickey, *Simple Made Easy*). Simplicity means no interleaving ("complecting"), not more files. Untangle first; moving tangled code into more files makes it worse.
- **Size is a heuristic, not a law.**
  - Studies cited in *Code Complete* found:
    - no cost or defect advantage for very short routines (≤ 32 lines);
    - the worst error rates in very long ones (over 500 lines).
  - Be careful above roughly 200 lines.
  - There is no evidence base for file-length limits; split on cohesion instead.
  - Fowler extracts whenever understanding a fragment takes effort, to separate intention from implementation.

| Signal | Action |
|---|---|
| Different actors drive changes to one unit (divergent change) | Split along the actor line |
| A volatile decision (vendor, format, algorithm) is visible to many callers | Hide it in one deep module |
| A general mechanism is tangled with special cases | Push the general part down; separate the special cases |
| A block takes effort to understand, or mixes abstraction levels | Extract it and name the intent — only if the piece stands alone |
| A routine over ~200 lines, hard to describe or hard to name | Look for hidden modules |
| Feature A imports feature B's internals | Move the shared piece to `shared/`, or put it behind B's contract |
| One change touches many modules (shotgun surgery) | Co-locate or merge |
| The same knowledge lives in several modules | Give it one owner |
| Pass-through methods or layers; forwarding wrappers | Collapse the layer |
| Units that must be read together (conjoined) | Merge or inline |
| A dependency cycle between modules | Merge them, or extract the shared concept downward |
| Strong connascence across a boundary | Move the parties together, or weaken the form |

## TypeScript and JavaScript projects

- **Public surfaces.**
  - Packages declare their API with `package.json` `exports`, and block internals with `"./internal/*": null`.
  - In-app features expose one narrow, hand-written contract file, or nothing.
- **No barrel files** (index files that only re-export) inside applications.
  - They inflate module graphs: one Next.js page dropped from ~11k to ~3.5k modules once they were removed.
  - They slow builds and tests (Atlassian: 75% fewer build minutes) and breed circular imports.
  - Import files directly. A barrel is acceptable as a *library's* single public entry point.
- **No cycles.** Check in CI with `import/no-cycle`, dependency-cruiser or madge. Break a cycle by:
  - moving the shared concept down;
  - merging the modules; or
  - inverting through an interface owned by the more stable side.
- **Enforce boundaries mechanically.** Start with what the compiler checks: workspace packages with `exports`, plus TS project references. Then add lint or CI rules:
  - eslint-plugin-boundaries: element types and allowed dependencies;
  - dependency-cruiser `forbidden` rules;
  - Nx `enforce-module-boundaries`, with tags such as `scope:billing` and `type:ui`;
  - `import/no-restricted-paths` for cross-feature imports.
- **Path aliases.**
  - tsconfig `paths` doesn't rewrite emitted imports. It's fine in bundled apps, but never use it in published libraries.
  - Prefer `package.json` `imports` (`#app/…`; bare `#/…` needs Node ≥ 24.14 and TypeScript ≥ 6.0).
  - Never point `paths` at monorepo packages or at `node_modules`.
- **Colocation.** Keep tests, styles, stories and fixtures next to their code. Promote something to `shared/` only when a second real consumer appears.

## Architecture tests (fitness functions)

- **An architectural fitness function is an objective, automated check** of an architectural property (*Building Evolutionary Architectures*). Encode each structural rule as a test or CI check:
  - ArchUnit (JVM);
  - ArchUnitTS (Jest/Vitest), e.g. `projectFiles().inFolder('src/**').should().haveNoCycles()`;
  - dependency-cruiser rules;
  - import-linter (Python).
- **Add the rule in the same change that creates the boundary.**
  - Never relax a rule silently.
  - In a codebase that already violates a rule, list today's violations as explicit exceptions, then shrink the list. The list only shrinks: never add an entry to make a new import pass; fix the import.

## Default layouts (greenfield only)

Use these only for new code, or in a repository with no convention. Otherwise follow the existing structure and migrate one module at a time.

```
src/                          # backend service — feature-first
  main.ts                     # composition root: config, wiring, server start
  modules/                    # one folder per business capability; names scream the domain
    billing/
      public-api.ts           # the ONLY file other modules import: a narrow, hand-written contract
      billing.routes.ts       # driving adapter: HTTP → use cases
      billing.service.ts      # use cases + domain rules; no framework imports
      billing.repo.ts         # driven adapter: persistence
      billing.service.test.ts
    orders/
  platform/                   # db client, logger, http server, config — no domain logic
  shared/                     # small, stable, domain-agnostic helpers, one concern per file
```

- Modules talk to each other only through `public-api.ts`.
- `platform/` and `shared/` never import from `modules/`.
- No cycles.
- Turn a module into a workspace package with `exports` when it needs its own owner or build.

```
src/                          # frontend — feature-first
  app/                        # routes/pages, providers, router: composes features
  features/
    checkout/
      api/                    # requests + data hooks for this feature
      components/             # Checkout.tsx + .test.tsx + .stories.tsx side by side
      hooks/ stores/ types/ utils/
  components/                 # shared, domain-agnostic UI
  hooks/ lib/ types/ utils/   # shared; lib = preconfigured third-party wrappers
```

- Dependencies flow shared → features → app.
- No cross-feature imports: compose features in `app/`.
- No barrels.

## Defaults where sources disagree

- **Function size** (Martin vs Ousterhout): depth matters more than length. First make functions deep, then make them short enough to read easily.
- **Layers and ports vs vertical slices:** use slices by default. Add ports only around domain-heavy cores, and around systems that tests must fake.
- **SOLID vs its critics:** apply the actor test (SRP) plus Parnas's hide-a-decision test. Skip speculative OCP and DIP abstractions.
- **DRY vs locality and deletability:** duplicate *code* until real uses reveal its shape, but never duplicate *knowledge*.
- **Barrels vs encapsulation:**
  - no barrels inside apps;
  - `exports` for packages;
  - lint rules for boundaries.
- **General-purpose vs "use, not reuse":** a somewhat general interface that covers only today's features.
