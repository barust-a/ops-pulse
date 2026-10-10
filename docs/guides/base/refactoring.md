# Refactoring

**Read this when you are:**
- restructuring code or cleaning up a smell;
- preparing code for a change;
- touching legacy code that has no tests;
- planning a large or long-running change.

Project rules in `AGENTS.md` override this file.

**Sources:**
- Fowler, *Refactoring* (2nd ed., 2018) and refactoring.com
- Beck, *Tidy First?*
- Feathers, *Working Effectively with Legacy Code*
- Kerievsky, *Refactoring to Patterns*

## Rules that always apply

1. **Refactoring never changes behavior.** Fowler defines it as "a change made to the internal structure of software to make it easier to understand and cheaper to modify without changing its observable behavior". A change that alters behavior is not a refactoring; call it what it is.
2. **Wear one hat at a time** (Kent Beck).
   - *Refactoring hat:* tests stay green and unchanged; any failure is a mistake.
   - *Adding-behavior hat:* you may add and change tests.
   - A refactoring step that needs an edited test expectation is really a behavior change.
3. **Start from green.** Typecheck, lint, tests and build all pass before the first step. Never refactor on red.
4. **Take small steps.**
   - Do one micro-refactoring, typecheck, run the relevant tests, then commit.
   - If a step goes red, revert to the last green state and take a smaller step. Don't debug forward.
   - "If you are doing refactoring your system should not be broken for more than a few minutes at a time." (Fowler)
5. **Separate structure from behavior.** Use separate commits — and separate PRs when the change is non-trivial. Refactor first, then change behavior: "for each desired change, make the change easy (warning: this may be hard), then make the easy change" (Kent Beck).
6. **Use semantic tools, not text edits.** Use IDE/LSP refactorings and codemods. Then search for references the tools can't see.
7. **Stay in scope.** Refactor what the task touches or needs. List other ideas instead of acting on them.

## When to refactor, and when not to

| Workflow | When |
|---|---|
| TDD refactoring | Right after reaching green |
| Preparatory | Before a change: reshape the code so the change becomes easy |
| Comprehension | Once you've understood some code, move that understanding into it (rename, extract) |
| Litter-pickup | Small improvements inside the lines you're already changing; list the rest as follow-ups |
| Planned | Larger areas. Needing these often is a sign the other workflows were neglected |
| Long-term | Agree a rough end-state and plan, then move toward it during normal work |

- **Refactor only what the task needs** (root `AGENTS.md` §8): make the requested change easier, and tidy only inside lines you already change. List the rest as follow-ups.
- **When to tidy** (Beck, *Tidy First?*):
  - **first**, when it pays off now and you know how;
  - **after**, when waiting costs more or you'll be back soon;
  - **later**, as a batch on a list;
  - **never**, when the code won't change again.
- **Don't refactor:**
  - code you don't need to change or understand;
  - code you're about to delete;
  - when a rewrite is cheaper;
  - when the work won't pay back reasonably soon;
  - without tests (add characterization tests first).
- **Performance:** make the code clear first, then optimize with a profiler and measurements (→ `performance.md`).

## Safe-refactoring protocol for agents

**Before**
1. **Classify the task:** refactor-only, behavior change, or both. If both, make the structure commits first and the behavior commit last.
2. **Limit the scope** to code you must change or understand. Note other improvements rather than making them.
3. **Get a green baseline:** typecheck, lint, tests and build. If anything fails, stop and report.
4. **Check the safety net on the code you'll touch.**
   - If it's thin, add characterization or approval tests in a preceding commit.
   - Probe those tests: a deliberate bug, or an incremental mutation run, should make them fail.
5. **Analyze the impact.**
   - Run a semantic find-references, plus a text search for string, dynamic, config and generated uses.
   - List the exported APIs, persisted formats and observable outputs you could affect.
6. **Pick a strategy:**
   - private code → change it directly;
   - exported, or needs more than one PR → Parallel Change;
   - replacing a dependency → Branch by Abstraction;
   - unknown web of dependencies → Mikado;
   - replacing a system → Strangler Fig;
   - hundreds of files → a codemod, in shards.

**During**

7. **One micro-refactoring per step,** through an IDE/LSP refactoring or a codemod when one exists.
8. **After each step,** typecheck and run the relevant tests.
   - Green → commit `refactor(scope): …`.
   - Red → revert to the last green state and retry with a smaller step.
9. **Never edit test expectations, snapshots or approved files** during a refactoring.
10. **Found a bug?** Pin the current behavior with a test, note the bug, and fix it later in a separate behavior commit.
11. **Keep main releasable.** Use expand/contract, and give every feature toggle an expiry date.
12. **Stop when the work outgrows the plan** (or after roughly an hour of tidying). Revert to a sensible point and report.

**After**

13. **Run the full suite**, typecheck, lint and build. If hot paths were involved, measure before and after.
14. **Open refactor-only PRs of reviewable size,** roughly 100–400 hand-written lines.
    - State "no behavior change intended", with the evidence.
    - Include any codemod script and its tests.
15. **If the commits got tangled,** split them, or redo the work tidying first.
16. **Finish the contract phase.** Delete the old paths, toggles and dead code. Add a lint rule so the old pattern can't come back.
17. **Report** what you verified, any bugs you found but didn't fix, and follow-ups.

**Refactoring a UI screen: prove the rendered HTML is unchanged**

1. Add characterization tests for every visible state still untested, and see them pass on the old code.
2. Have the test setup write the page body at the end of every test to a folder chosen by an environment variable, normalizing what changes between runs (generated ids such as `useId`, object URLs, clock times). Run it into `before/` on the old code, refactor, run it into `after/`, then `diff -r before after`: the two must be identical.
3. A page that differs between two runs of the same code belongs to a test that ends before an async load or navigation settles. Make that test await its end state; never loosen the comparison.

## Large and long-running changes

- **Parallel Change (expand → migrate → contract).** Use it when you change an interface that is used in many places, even if you own every caller.
  1. Add the new form.
  2. Migrate callers in small steps.
  3. Remove the old form.

  Variant: implement the old API in terms of the new one, then inline it.
- **Branch by Abstraction.** Use it to replace a component in place. The system builds and runs at every step.
  1. Put an abstraction in front of the component.
  2. Route clients through the abstraction.
  3. Build the new implementation behind it.
  4. Switch clients over gradually.
  5. Delete the old implementation.

  On critical paths, run old and new side by side and compare results (e.g., GitHub's Scientist), returning the old result until you're confident.
- **Strangler Fig.** Use it to replace a whole system. Grow the new system around the old one, piece by piece, accepting some transitional architecture. Avoid big-bang rewrites.
- **Feature toggles** (Pete Hodgson). There are four kinds: release, experiment, ops and permissioning.
  - Release toggles should live for a week or two.
  - Treat every toggle as inventory with a carrying cost: give it a removal task, an expiry date, and a test that fails after expiry.
  - Test the production configuration, the fallback (toggles off) and all-on.
- **Mikado Method.** Use it when the dependencies are unknown.
  1. Write down the goal.
  2. Try it naively.
  3. Record each error's fix as a prerequisite.
  4. Revert.
  5. Work leaves-first, committing only green changes.

  Roll back rather than push through.
- **Large-scale changes** (Google):
  - Automate the edit.
  - Shard it into small changes that are tested and reviewed independently.
  - Migrate through aliases and forwarding functions.
  - Block regressions with static analysis.
  - Expect a long tail of hidden dependencies (Hyrum's law).
  - Dynamic code resists automated change, so raise type coverage first.

## Legacy code

- **Definition.** Legacy code is code without tests (Feathers) — or valuable code you're afraid to change. *Cover and modify*; don't *edit and pray*.
- **The Legacy Code Change Algorithm:**
  1. Identify change points.
  2. Find test points.
  3. Break dependencies.
  4. Write tests.
  5. Make changes and refactor.
- **Seams.** A seam is a place where you can change behavior without editing that place. Each seam has an *enabling point*.
  - Prefer object seams: constructor or parameter injection.
  - Use link seams (module mocking, `vi.mock`) and preprocessing seams (bundler defines) only for dependencies that run through everything.
- **Characterization tests** document what the system *actually* does, not what it should do.
  1. Write an assertion you know is wrong.
  2. Run it.
  3. Paste in the actual value.
  4. Name the test after the behavior.

  Keep odd behavior pinned until someone confirms it is a bug.
- **Approval / golden-master tests:**
  - Snapshot the outputs for many input combinations, then confirm they don't change.
  - During a refactoring, any diff means the behavior changed.
  - Keep them focused, deterministic and temporary.
- **No time to get a class under test?**
  - **Sprout Method/Class:** write the new logic as new, tested code and call it from the old code.
  - **Wrap Method/Class:** rename the old code, wrap it under the old name, and add the new behavior in the wrapper.
- **To understand code:** sketch, mark up listings, scratch-refactor (refactor to learn, then throw it away), delete unused code.
- **To edit without tests:**
  - single-goal editing;
  - preserve signatures;
  - lean on the compiler (`tsc --noEmit` after each step). It can't see `any`, casts, `@ts-ignore`, string keys, DI tokens, dynamic imports or JSON.
- **Dependency-breaking techniques (Feathers):** Adapt Parameter · Break Out Method Object · Definition Completion · Encapsulate Global References · Expose Static Method · Extract and Override Call · Extract and Override Factory Method · Extract and Override Getter · Extract Implementer · Extract Interface · Introduce Instance Delegator · Introduce Static Setter · Link Substitution · Parameterize Constructor · Parameterize Method · Primitivize Parameter · Pull Up Feature · Push Down Dependency · Replace Function with Function Pointer · Replace Global Reference with Getter · Subclass and Override Method · Supersede Instance Variable · Template Redefinition · Text Redefinition.

## Tidyings (Beck, *Tidy First?*)

Tidyings are tiny, structure-only changes. Ship one or a few per PR, separate from behavior changes. Structure changes are usually cheap to reverse; behavior changes usually are not.

| Tidying | What it does |
|---|---|
| Guard Clauses | Exit early for special cases (but not seven of them in a row) |
| Dead Code | Delete it; if unsure whether it runs, log it first |
| Normalize Symmetries | Do the same thing the same way everywhere |
| New Interface, Old Implementation | Write the interface you wish you had; implement it by calling the old one |
| Reading Order | Reorder so the file reads top-down |
| Cohesion Order | Put things that change together next to each other |
| Move Declaration and Initialization Together | Declare a variable where it's first given its value |
| Explaining Variables | Name a subexpression |
| Explaining Constants | Name a literal |
| Explicit Parameters | Pass what's used, not maps or ambient state |
| Chunk Statements | Blank lines between steps |
| Extract Helper | Pull out a block with a clear purpose |
| One Pile | Inline over-split pieces, then re-tidy |
| Explaining Comments | Write down what isn't obvious |
| Delete Redundant Comments | Remove comments that repeat the code |

**Coupling and cohesion:**
- Coupling is always relative to a particular change.
- Constantine's equivalence: cost(software) ≈ cost(change) ≈ cost(big changes) ≈ coupling.
- "Coupling can be hard to reduce. Cohesion is almost always easy to increase."

## Code smells → refactorings

Smells are prompts to investigate, not lint errors. Fowler & Beck: "no set of metrics rivals informed human intuition".

| Smell | Symptom | Refactorings that fix it |
|---|---|---|
| Mysterious Name | The name doesn't say what the code does (a hard-to-name thing hints at a design problem) | Change Function Declaration, Rename Variable, Rename Field |
| Duplicated Code | The same structure in several places | Extract Function; Slide Statements to line up near-duplicates; Pull Up Method |
| Long Function | A wide gap between what the code does and how it does it | Extract Function (almost always); Replace Temp with Query; Introduce Parameter Object; Preserve Whole Object; Replace Function with Command; Decompose Conditional; Replace Conditional with Polymorphism; Split Loop |
| Long Parameter List | Confusing parameter lists | Replace Parameter with Query; Preserve Whole Object; Introduce Parameter Object; Remove Flag Argument; Combine Functions into Class |
| Global Data | Can be changed from anywhere (incl. singletons, class variables) | Encapsulate Variable, then narrow its scope |
| Mutable Data | An update in one place breaks code elsewhere | Encapsulate Variable; Split Variable; Slide Statements + Extract Function to isolate pure code; Separate Query from Modifier; Remove Setting Method; Replace Derived Variable with Query; Combine Functions into Class/Transform; Change Reference to Value |
| Divergent Change | One module changes for different reasons | Split Phase; Move Function; Extract Function; Extract Class |
| Shotgun Surgery | One change needs many small edits in many modules | Move Function; Move Field; Combine Functions into Class/Transform; Split Phase; inline everything together, then re-extract |
| Feature Envy | A function talks more to another module than to its own | Move Function; Extract Function and move the piece (Strategy and Visitor are accepted exceptions) |
| Data Clumps | The same 3–4 data items always appear together | Extract Class; Introduce Parameter Object; Preserve Whole Object |
| Primitive Obsession | Money, ranges, IDs or phone numbers as raw primitives ("stringly typed") | Replace Primitive with Object; Replace Type Code with Subclasses; Extract Class; Introduce Parameter Object |
| Repeated Switches | The same switch/if-cascade on a type code in several places | Replace Conditional with Polymorphism (in TS, often a union + lookup table) |
| Loops | A loop where a pipeline would show what is selected and transformed | Replace Loop with Pipeline |
| Lazy Element | A function or class not worth its structure | Inline Function; Inline Class; Collapse Hierarchy |
| Speculative Generality | Hooks for an imagined future; the only users are tests | Collapse Hierarchy; Inline Function; Inline Class; Change Function Declaration; Remove Dead Code |
| Temporary Field | A field set only in some circumstances | Extract Class; Move Function; Introduce Special Case |
| Message Chains | A client navigates a chain of objects | Hide Delegate; Extract Function + Move Function down the chain |
| Middle Man | Half of a class's interface just delegates | Remove Middle Man; Inline Function; Replace Superclass/Subclass with Delegate |
| Insider Trading | Modules swap too much data behind the scenes | Move Function; Move Field; Hide Delegate or a third module; Replace Subclass/Superclass with Delegate |
| Large Class | Too many fields or too much code | Extract Class; Extract Superclass; Replace Type Code with Subclasses |
| Alternative Classes with Different Interfaces | Substitutable classes whose interfaces don't match | Change Function Declaration; Move Function; Extract Superclass |
| Data Class | Only fields and accessors; other code does the work | Encapsulate Record; Remove Setting Method; Move Function. Fine for immutable result records (e.g. after Split Phase) |
| Refused Bequest | A subclass uses little of what it inherits | Push Down Method/Field. If it refuses the *interface*: Replace Subclass/Superclass with Delegate |
| Comments | Comments used as deodorant for unclear code | Extract Function; Change Function Declaration; Introduce Assertion. Why-comments are good, not a smell |

**Other common smells:**
- **Dead Code** (refactoring.guru) → Remove Dead Code.
- **Kerievsky's additions:**
  - Conditional Complexity → Strategy / State / Decorator / Special Case.
  - Indecent Exposure → encapsulate classes behind a factory.
  - Solution Sprawl → move creation knowledge to a factory.
  - Combinatorial Explosion → an interpreter or composition.
  - Oddball Solution → unify the interfaces with an adapter.

## Refactoring catalog (Fowler, 2nd edition)

- **Online catalog:** 66 entries; the book has 61. † marks the 5 web-only entries.
- **Paradigm** column:
  - *any:* works with plain functions, modules and records.
  - *any°:* shown with classes, but closures, modules or unions work.
  - *OO:* needs class inheritance. For composition-first TS, see the mapping below.

| Group | Refactoring | Former name / alias | Intent | Inverse | Paradigm |
|---|---|---|---|---|---|
| Basics | Extract Function | Extract Method | Turn a fragment into a function named for its intent | Inline Function | any |
| | Inline Function | Inline Method | Replace calls with the body when the body is as clear as the name | Extract Function | any |
| | Extract Variable | Introduce Explaining Variable | Name a side-effect-free expression | Inline Variable | any |
| | Inline Variable | Inline Temp | Remove a variable whose name adds nothing | Extract Variable | any |
| | Change Function Declaration | Rename Function, Add/Remove Parameter, Change Signature | Rename a function or change its parameters | — | any |
| | Encapsulate Variable | Encapsulate Field, Self-Encapsulate Field | Route all access to widely scoped data through functions | — | any |
| | Rename Variable | — | Make a name say what it holds | — | any |
| | Introduce Parameter Object | — | Replace parameters that travel together with one structure | — | any |
| | Combine Functions into Class | — | Group functions that share data with that data | — | any° |
| | Combine Functions into Transform | — | One function copies a record and adds all the derived fields | — | any |
| | Split Phase | — | Split code into sequential phases joined by an intermediate structure | — | any |
| Encapsulation | Encapsulate Record | Replace Record with Data Class | Wrap a raw record in an object with accessors | — | any° |
| | Encapsulate Collection | — | Expose add/remove and copies, never the raw collection | — | any |
| | Replace Primitive with Object | Replace Data Value with Object, Replace Type Code with Class | Turn a primitive with behavior into a value type | — | any° |
| | Replace Temp with Query | — | Replace a computed temp with a function call | — | any |
| | Extract Class | — | Split a class that does two jobs | Inline Class | any° |
| | Inline Class | — | Fold a class that does too little into another | Extract Class | any° |
| | Hide Delegate | — | Add a delegating method so clients don't navigate the chain | Remove Middle Man | any° |
| | Remove Middle Man | — | Let clients call the delegate directly | Hide Delegate | any° |
| | Substitute Algorithm | — | Replace an algorithm with a clearer one | — | any |
| Moving features | Move Function | Move Method | Move a function to the module whose data it uses | — | any |
| | Move Field | — | Move a field to the record it belongs with | — | any |
| | Move Statements into Function | — | Fold statements that always accompany a call into the callee | Move Statements to Callers | any |
| | Move Statements to Callers | — | Push behavior that varies out to the callers | Move Statements into Function | any |
| | Replace Inline Code with Function Call | — | Call the existing function instead of duplicating it | — | any |
| | Slide Statements | Consolidate Duplicate Conditional Fragments | Move related statements next to each other | — | any |
| | Split Loop | — | Split a loop that does two things | — | any |
| | Replace Loop with Pipeline | — | Replace a loop with filter/map operations | — | any |
| | Remove Dead Code | — | Delete unused code (version control remembers) | — | any |
| Organizing data | Split Variable | Remove Assignments to Parameters, Split Temp | One variable per responsibility | — | any |
| | Rename Field | — | Make field names match their meaning | — | any |
| | Replace Derived Variable with Query | — | Compute derived data on demand instead of storing it | — | any |
| | Change Reference to Value | — | Make a nested object immutable; replace it whole | Change Value to Reference | any |
| | Change Value to Reference | — | Share one instance of a logical entity | Change Reference to Value | any |
| | Replace Magic Literal † | Replace Magic Number with Symbolic Constant | Name a literal with a constant | — | any |
| Conditional logic | Decompose Conditional | — | Extract the condition and each branch into named functions | — | any |
| | Consolidate Conditional Expression | — | Merge checks with the same result into one named check | — | any |
| | Replace Nested Conditional with Guard Clauses | — | Return early for unusual cases; keep the normal path flat | — | any |
| | Replace Conditional with Polymorphism | — | Move each branch into a variant's own implementation | — | OO (any via union + dispatch map) |
| | Introduce Special Case | Introduce Null Object | Replace repeated special-value checks with a special-case object | — | any° |
| | Introduce Assertion | — | Make an assumed program state explicit | — | any |
| | Replace Control Flag with Break † | Remove Control Flag | Use break/return instead of a loop control flag | — | any |
| APIs | Separate Query from Modifier | — | Split value-returning code from side effects | — | any |
| | Parameterize Function | Parameterize Method | Merge near-duplicate functions that differ only by literals | — | any |
| | Remove Flag Argument | Replace Parameter with Explicit Methods | Replace a behavior-selecting flag with explicit functions | — | any |
| | Preserve Whole Object | — | Pass the record, not values pulled out of it | — | any |
| | Replace Parameter with Query | Replace Parameter with Method | Drop a parameter the callee can derive itself | Replace Query with Parameter | any |
| | Replace Query with Parameter | — | Pass a value in to remove an unwanted dependency or impurity | Replace Parameter with Query | any |
| | Remove Setting Method | — | Make a field settable only at construction | — | any° |
| | Replace Constructor with Factory Function | Replace Constructor with Factory Method | Wrap construction in a named factory | — | any° |
| | Replace Function with Command | Replace Method with Method Object | Turn a complex function into a command object | Replace Command with Function | any° |
| | Replace Command with Function | — | Collapse a simple command back into a function | Replace Function with Command | any° |
| | Return Modified Value † | — | Return the computed value instead of updating outer state | — | any |
| | Replace Error Code with Exception † | — | Signal errors with exceptions, not return codes | — | any (with exceptions) |
| | Replace Exception with Precheck † | Replace Exception with Test | Check the condition first instead of catching | — | any |
| Inheritance | Pull Up Method | — | Move identical subclass methods to the superclass | Push Down Method | OO |
| | Pull Up Field | — | Move duplicated subclass fields up | Push Down Field | OO |
| | Pull Up Constructor Body | — | Move common constructor code up | — | OO |
| | Push Down Method | — | Move a method used by only some subclasses into them | Pull Up Method | OO |
| | Push Down Field | — | Move a field used by only some subclasses into them | Pull Up Field | OO |
| | Replace Type Code with Subclasses | Extract Subclass, Replace Type Code with State/Strategy | Replace a type code with variants | Remove Subclass | OO |
| | Remove Subclass | Replace Subclass with Fields | Replace trivial subclasses with a field | Replace Type Code with Subclasses | OO |
| | Extract Superclass | — | Pull the shared features of two classes into a parent | — | OO |
| | Collapse Hierarchy | — | Merge a parent and child that have converged | — | OO |
| | Replace Subclass with Delegate | — | Replace subclassing with a delegate (composition) | — | OO → composition |
| | Replace Superclass with Delegate | Replace Inheritance with Delegation | Hold the former parent as a field and delegate to it | — | OO → composition |

### Inheritance refactorings in composition-first TypeScript

- Pull Up Method/Field → move the shared logic into a module function or a shared component that both variants use.
- Push Down Method/Field → move it into the specific variant's object or union member.
- Replace Type Code with Subclasses → a discriminated union, or strategy objects.
- Remove Subclass / Collapse Hierarchy → merge the variants into a field with a literal type.
- Extract Superclass → an `interface`, plus Extract Class for the shared behavior.
- Replace Subclass/Superclass with Delegate → the default move in composition-first code.

### Mechanics of the key refactorings

These are condensed. Each step ends with typecheck → test, and you commit when green.

- **Extract Function**
  1. Create a function named for *what* the code does, not how. If you can't name it, don't extract yet.
  2. Copy the fragment into it.
  3. Pass the variables it reads as parameters. If exactly one variable is assigned and used afterwards, return it. If many are assigned, apply Split Variable or Replace Temp with Query first.
  4. Replace the fragment with a call, then test.
  5. Look for similar code elsewhere (Replace Inline Code with Function Call).
- **Change Function Declaration**
  - *Simple:* change the declaration and update every caller. Rename and change parameters in separate steps.
  - *Migration* (many callers, or a published API):
    1. Extract the whole body into a new function with the new signature.
    2. Make the old function delegate to it.
    3. Migrate callers one by one, inlining the old function.
    4. Mark the old function `@deprecated` until clients have moved, then delete it.
- **Encapsulate Variable**
  1. Create getter/setter functions.
  2. Replace each reference with them, testing as you go.
  3. Restrict the variable's visibility.
  4. For records, return copies or freeze them, so callers can't mutate them.
- **Introduce Parameter Object**
  1. Create the structure (preferably a value type).
  2. Add it as a parameter.
  3. Move callers over one element at a time, removing each old parameter.
  4. Then move related behavior onto the new type (e.g., `range.contains(x)`).
- **Combine Functions into Transform**
  1. Write `enrichX(record)`, which returns a deep copy, with a test that the input isn't mutated.
  2. Move each derived-value calculation into it as a new field, and point clients at that field.
  3. Use Combine into Class instead if the source data changes after it has been enriched.
- **Split Phase**
  1. Extract the second phase into its own function.
  2. Introduce an intermediate data structure between the phases.
  3. Move the second phase's inputs into the structure, one at a time.
  4. Extract the first phase as a function that returns the structure.

  Typical result: `parse(input) → record`, then `compute(record, …)`.
- **Replace Primitive with Object**
  1. Encapsulate the variable.
  2. Create a minimal value type: a constructor/factory and an accessor.
  3. Store instances; unwrap them in the accessor.
  4. Move behavior into the type (e.g., `priority.higherThan(other)`).
- **Move Function**
  1. Examine everything the function uses, and move the least-dependent pieces first.
  2. Copy it to the target and adapt it, passing in what it needs from the old context.
  3. Make the source delegate to the copy, and test.
  4. Inline the delegator if it isn't needed.
- **Replace Loop with Pipeline**
  1. Create a variable for the loop's collection.
  2. Replace each part of the loop's behavior with a `filter`/`map` step, top to bottom, testing after each one.
  3. Delete the loop.

  If the pipeline isn't clearer than the loop, revert.
- **Replace Nested Conditional with Guard Clauses**
  1. Turn the outermost special case into an early return or throw, and test.
  2. Repeat for the next one.
  3. Consolidate guards that return the same result.

  Conditions must be side-effect-free.
- **Replace Conditional with Polymorphism**
  1. Create the variants and a factory that returns the right one.
  2. Move the conditional into the base form.
  3. Move one branch into each variant, testing after each.
  4. Leave a default or make it abstract.

  In TS, the variants are often entries in a `Record<Kind, Behavior>` or a discriminated union.
- **Introduce Special Case**
  1. Add a check property (`isUnknown`).
  2. Create the special-case object.
  3. Funnel every special-value comparison through one function.
  4. Return the special case from the source.
  5. Move the shared special-case behavior into the object.

  A frozen literal typed as the real interface is enough when its answers are fixed.

Chapter 1's worked example shows the rhythm. To remove an accumulator variable: Split Loop → Slide Statements → Extract Function → Inline Variable, each followed by test and commit.

## Refactoring to patterns (Kerievsky)

- **Reach patterns by refactoring, not by up-front design.** Refactoring to a pattern beats introducing it early, "whether code is years old or minutes old". Move *to*, *towards* or *away from* a pattern as the code demands.
- **Watch out for over-engineering.** Making code more flexible or sophisticated than it needs to be is over-engineering. Under-engineering is more common still. Small steps fix both.
- **The 27 refactorings:**
  - *Creation:* Replace Constructors with Creation Methods · Move Creation Knowledge to Factory · Encapsulate Classes with Factory · Introduce Polymorphic Creation with Factory Method · Encapsulate Composite with Builder · Inline Singleton.
  - *Simplification:* Compose Method · Replace Conditional Logic with Strategy · Move Embellishment to Decorator · Replace State-Altering Conditionals with State · Replace Implicit Tree with Composite · Replace Conditional Dispatcher with Command.
  - *Generalization:* Form Template Method · Extract Composite · Replace One/Many Distinctions with Composite · Replace Hard-Coded Notifications with Observer · Unify Interfaces with Adapter · Extract Adapter · Replace Implicit Language with Interpreter.
  - *Protection:* Replace Type Code with Class · Limit Instantiation with Singleton · Introduce Null Object.
  - *Accumulation:* Move Accumulation to Collecting Parameter · Move Accumulation to Visitor.
  - *Utilities:* Chain Constructors · Unify Interfaces · Extract Parameter.
- **In TS, prefer the lightest form of each pattern** (→ `design-patterns.md`):
  - strategies are functions;
  - decorators are higher-order functions;
  - commands are closures or action objects;
  - Inline Singleton means passing the value in.

## Tooling

- **IDE / tsserver:** Rename Symbol, Extract function/constant/type, Move to new file, Convert parameters to destructured object, and update imports on file move.
- **ts-morph:** type-aware programmatic refactoring (rename across files, move files). Comments and strings are opt-in, so grep for them afterwards.
- **jscodeshift:** codemods that preserve formatting. Use `--parser=tsx --dry --print` for a dry run; test transforms with `defineInlineTest`.
- **ast-grep:** structural search and rewrite with tree-sitter patterns and YAML rules, in many languages.
- **Comby:** lightweight structural templates for almost any language or format.
- **OpenRewrite:** recipe-based refactoring, mainly for the JVM.
- **Don't trust LLM-proposed refactorings blindly.** A 2024 study found unsafe ones from both ChatGPT and Gemini. Identify the refactoring, re-apply it with a semantic tool where possible, and verify it with tests.
- **Track migrations:**
  - mark the old API `/** @deprecated Use X */`;
  - find remaining uses with `@typescript-eslint/no-deprecated`;
  - block reintroduction with `no-restricted-imports`.

## Defaults where sources disagree

- **Opportunistic vs planned.** Refactor within the task's scope; do long-term restructuring only with an agreed end-state.
- **Separate PRs vs bundling.** Always use separate commits. Use separate PRs when the tidying is non-trivial. Always review agent-made refactorings.
- **Rule of Three vs the wrong abstraction.** Extract once the concept is clear. If an abstraction turns out wrong, inline it — "the fastest way forward is back" (Metz).
- **Leaning on the compiler vs Parallel Change.** For private code, lean on `tsc`. For exported code, use Parallel Change.
- **Snapshot and approval nets** are broad but brittle. Keep them focused, deterministic and temporary.
- **Rewrite vs refactor.** A local rewrite can be cheaper than refactoring. At system scale, use Strangler Fig, never a big-bang rewrite.
