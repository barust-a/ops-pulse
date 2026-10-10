# Naming

**Read this when:**
- naming a new public API, module, type or domain concept;
- renaming across files;
- reviewing names.

The codebase's existing vocabulary and the project rules in `AGENTS.md` override this file.

## Rules

1. **Reveal intent.** A reader should know what a thing is, or what it does, from its name at the point of use. If a variable needs a comment to explain it, move the comment's words into the name.
2. **Use the domain's words** (ubiquitous language): the terms users and domain experts use, and the vocabulary the codebase already has. Search before you name. When your understanding of the domain changes, rename.
3. **One word per concept, one concept per word.**
   - Don't mix `fetch`, `retrieve` and `get` for the same operation.
   - Don't use `add` for both "sum" and "append".
   - Record the project's verbs in a glossary.
4. **Never mislead.** A wrong name is worse than a meaningless one. Treat these "linguistic antipatterns" as defects:
   - `get*` that mutates, or returns nothing;
   - `is*` / `has*` that returns a non-boolean;
   - `set*` that returns a value;
   - a singular name on a collection, or a plural on a single value;
   - `validate*` that neither returns a result nor throws;
   - a transformation that doesn't return its result;
   - `accountList` that isn't a list.
5. **Names differ in meaning,** not by one letter (`appleCount`/`appleCounts`), word order, synonym (`input`/`inputValue`) or digit (`employee2`).
6. **Use pronounceable, correctly spelled dictionary words.**
   - No private abbreviations (`cstmr`, `calcAmt`). Whole words are measurably faster to understand than letters or abbreviations.
   - Universal and domain terms (`id`, `url`, `html`, `config`, `db`) are fine. Keep an explicit allow-list.
7. **Scale name length with scope.**
   - Single letters only for conventional roles (`i`, `x`, `e`), in scopes of about 10 lines.
   - The farther from its declaration a name is used, the more descriptive it must be.
   - Exported names are always descriptive.
8. **Don't repeat context the reader already has.**
   - `user.name`, not `user.userName`; in package `http`, `http.Server`, not `HTTPServer`.
   - No app-wide prefixes (`MyAppUser`).
   - No type encodings (`strName`, `mCount`, `IUser`, `userList` when the type already says it).
   - At most about four words.
9. **Choose the grammar by role.**
   - Types are nouns.
   - Functions with side effects are imperative verbs.
   - Side-effect-free functions may read as nouns or questions (`distance(to)`, `isEmpty`).
   - Capabilities read as adjectives (`Serializable`).
   - Parameters are named by their role (`greeting`), not their type (`string`).
10. **Booleans are affirmative predicates:** `isActive`, `hasAccess`, `canRetry`, `shouldNotify`, or a participle (`found`, `done`). Never negated: rename `isNotEmpty` to `isEmpty`, and `disableCache` to `cacheEnabled`.
11. **Collections and maps:**
    - collections are plural (`invoices`) or a collective noun (`calendar`);
    - maps name their key (`userById`, `priceBySku`), with one convention per codebase.
12. **Put units in the name when the type doesn't carry them:** `timeoutMs`, `sizeBytes`, `distanceKm`, `priceCents`.
    - A unit-carrying type (`Duration`, a branded `Millis`) drops the suffix.
    - Pick one qualifier position: `maxRetries`, never mixed with `retriesMax`.
13. **Use the standard opposite pairs, and never mix them:** add/remove, begin/end, create/destroy, first/last, get/set, insert/delete, lock/unlock, min/max, next/previous, old/new, open/close, show/hide, source/target, start/stop.
14. **Encode meaning, not type.** When two values share a type but differ in kind (unsafe vs safe HTML, raw vs parsed, rows vs columns), the name says which: `unsafeHtml` / `safeHtml`. Better still, give them different (branded) types.
15. **A name that is hard to find, or needs "And", signals a unit doing too much.** Split it rather than settle for a vague name.

## Verb vocabulary

This is a sensible default. Fix your own in the project glossary and use it consistently.

| Verb | Contract |
|---|---|
| property / `getX` | Cheap, local, no side effects; the value exists (throws, or is typed non-optional, if it's missing) |
| `findX` / `queryX` | A lookup that may find nothing → `T \| undefined` or an empty list |
| `tryX` | Returns a result value instead of throwing |
| `fetchX` | Remote call (network) |
| `loadX` / `saveX` | Move between storage and memory |
| `computeX` / `calculateX` | Noticeable CPU work; pure |
| `createX` / `makeX` | Factory: returns a new instance. `build()` finishes a builder; `X.of(...)` / `X.from(...)` are static factories |
| `toX` / `asX` / `fromX` | `toX` returns a new representation; `asX` returns a view; `fromX` builds a value from another type. Reuse platform names (`toString`, `toJSON`) |
| `parseX` / `formatX` / `serializeX` | Text → value (can fail) / value → text or bytes |
| `isX` / `hasX` / `canX` | Boolean, no side effects |
| `validateX` / `assertX` / `ensureX` | Returns a result / throws / makes it true (idempotent) |
| `setX` | Assigns; returns nothing (except in fluent builders) |
| `handle` / `process` / `do` / `manage` | Avoid as bare verbs: say what actually happens (`reconcile`, `render`, `charge`) |
| Events vs commands | Events are past-tense facts (`orderPlaced`, `OrderShipped`; `Closing`/`Closed`, not before/after prefixes); commands are imperative (`placeOrder`, `CreateOrder`) |
| React | Props `onX`, implementations `handleX`, hooks `useX` |
| Async | No `Async` suffix in TS/JS — the `Promise` type says it — unless a sync twin exists (`readFile` / `readFileSync`) |

## Cheat-sheet

| Role | Pattern | Good | Bad |
|---|---|---|---|
| Type / class | noun phrase | `Invoice`, `PaymentGateway` | `InvoiceData`, `InvoiceManager`, `Calculate` |
| TS interface | role or capability | `TodoItemStorage`, `Serializable` | `ITodoItem`, `TodoItemInterface` |
| Side-effecting function | verb + object | `sendInvoice()`, `items.sort()` | `invoice()`, `doIt()`, `process()` |
| Cheap accessor | noun / property | `user.name`, `total` | `getTotal()` that queries a DB |
| Remote or heavy work | `fetch` / `load` / `compute` | `fetchUser(id)`, `computeChecksum()` | `getUser()` that hides HTTP |
| May find nothing | `find` / `tryX` | `findUser(): User \| undefined` | `getUser()` returning `null` |
| Boolean | affirmative predicate | `isEmpty`, `hasAccess`, `canRetry` | `notActive`, `disableCache`, `isValid(): number` |
| Collection | plural | `invoices` | `invoiceList` (it's a Set), `invoice` (it's an array) |
| Map | `valueByKey` | `userById`, `priceBySku` | `map`, `userMap`, `data` |
| Quantity | noun + unit | `timeoutMs`, `sizeBytes` | `timeout`, `size` |
| Factory | `create` / `make` / `of` / `from` | `createClient()`, `Money.of(5, "EUR")` | `getNewClient()`, `clientHelper()` |
| Conversion | `toX` / `fromX` / `parseX` / `formatX` | `toJson()`, `parseIsoDate(s)` | `convert(x)`, `dateUtil(s)` |
| Validation | `validate` / `assert` | `assertValidEmail(e)` | `checkState(): void` that only logs |
| Event | past tense | `orderPlaced` | `placeOrderEvent`, `beforeClose` |
| Constant | the meaning | `MAX_UPLOAD_BYTES` | `FIVE`, `ONE_HUNDRED` |
| Test | the behavior | `rejects a withdrawal exceeding the balance` | `test1`, `testTransfer` |

## Suspicious words

Flag these in review. Rename to what the thing *is* or *does*.

- **Manager** → `Pool`, `Registry`, `Scheduler`, `Cache`, `Builder`.
- **Helper, Util(s), Common, Misc, Shared** → split by theme (`dates.ts`, `retry.ts`). Business logic never goes in "utils".
- **Data, Info, Object, Item, Thing, Value, Stuff** → the domain noun (`Invoice`, `InvoiceSummary`).
- **Processor, Handler, Service, Controller** (when vague) → `InvoiceRenderer`, `PaymentAuthorizer`. Keep `Handler` for event handlers.
- **Impl, Base, Wrapper** → name the difference (`InMemoryUserStore`, `RetryingHttpClient`).
- **The `I` prefix and `List`/`Map`/`String` suffixes** → drop them; the type already says it.
- **temp, foo, flag, `2`, new, old, Ex** → name the role. Never number versions.
- **check** → `isX` (boolean), `assertX` (throws) or `validateX` (returns a result).
- **get** on remote, heavy or mutating work → `fetch`, `load`, `compute`, `build`.

## How to find a name

- **Feitelson's three steps.** Developers rarely pick the same name: the median chance that two of them do is 6.9%. A deliberate process gives better names:
  1. Choose the concepts: object, qualifier, operation, time, unit.
  2. Choose one word per concept from the project lexicon.
  3. Build the name using the codebase's existing patterns (`maxX`, `xByY`, `xPerMonth`).
- **Belshee's "naming as a process":** Missing → Obvious Nonsense → Honest → Honest and Complete → Does the Right Thing → Intent → Domain Abstraction.
  - Replace a misleading name with obvious nonsense rather than keep a lie.
  - An honest name tells one true thing (`probablyChargesCardAndStuff`).
  - Let the name guide how you split the code.
  - Iterate privately; publish only names that state intent.
- **Names act as beacons that trigger recognition** (Hermans): `left`/`right` signal a tree, for example. Teams should agree on and document their naming patterns.

## Renaming

- **Use semantic tooling, never text find-and-replace:** the language server's "Rename Symbol", or a graph-aware rename tool.
  - Afterwards, search for references the compiler can't see: string keys, reflection and DI tokens, serialized fields, routes, i18n keys, environment variables, mocks by path, docs.
- **Rename as your understanding improves.** Names don't have to be right the first time.
- **Exported names are API:**
  - add the new name and keep the old one as a `@deprecated` alias;
  - remove the old name only in a major version;
  - name new versions descriptively, never `Ex` or `2`.
- **In the same change, rename everything that refers to the name:** tests, comments, docs, log and metric names, and the file name (it matches the main export).
  - Case-only file renames break on case-insensitive file systems; keep `forceConsistentCasingInFileNames` on.

## Language conventions

Follow the language's main style guide. Never mix conventions within one codebase.

| Language | Types | Functions / variables | Constants | Acronyms | Notable rules |
|---|---|---|---|---|---|
| TS/JS (Google) | `UpperCamelCase` | `lowerCamelCase` | `CONSTANT_CASE` for module-level and static values | as words: `loadHttpUrl`, `HttpClient` | No `I` prefix; no `_` prefix/suffix; type parameters `T` or `UpperCamelCase` |
| Python (PEP 8) | `CapWords`; exceptions end in `Error` | `snake_case` | `UPPER_SNAKE` | `HTTPServerError` | `_internal`; short lowercase module names |
| Go | `MixedCaps`; capitalized = exported | short `mixedCaps` | `MixedCaps` | `ServeHTTP`, `appID` | No `Get` prefix; 1–2-letter receivers; single-word lowercase packages; `-er` interfaces; no stutter (`http.Server`) |
| Rust | `UpperCamelCase` | `snake_case` | `SCREAMING_SNAKE_CASE` | `Uuid`, `Stdin` | `as_` (free view), `to_` (costly copy), `into_` (consumes); no `get_`; `iter` / `iter_mut` / `into_iter` |
| Java | `UpperCamelCase` | `lowerCamelCase`; methods are verbs | `UPPER_SNAKE` for deeply immutable static finals | `XmlHttpRequest` | Lowercase packages; no `mName`/`kName` |
| Kotlin | `UpperCamelCase` | `lowerCamelCase` | `SCREAMING_SNAKE` for `const` | `XmlFormatter`, `IOStream` | `sort` (mutates) / `sorted` (copies); backtick test names |
| C# | `PascalCase`; interfaces `IThing` | `PascalCase` members, `camelCase` parameters | `PascalCase` | `HtmlTag`, `IOStream` | `Async` suffix; `TryX` paired with a throwing twin; `Closing`/`Closed` events |
| Swift | `UpperCamelCase` | `lowerCamelCase` | `lowerCamelCase` | `utf8Bytes` | Clarity at the point of use; argument labels read as phrases (`insert(x, at: i)`); `make` factories; `-ed`/`-ing` for non-mutating forms |

**File names in TS/JS projects:**
- Follow the framework's convention (Angular: `user-profile.ts`).
- Otherwise use kebab-case: all-lowercase names avoid case-only rename bugs.
- The file name matches its main export.
- One style per repository.

## Defaults where conventions disagree

- **Acronym casing:** follow the language's main guide. In TS, treat acronyms as words (`HttpUrl`).
- **`is` prefix:**
  - use `is`/`has`/`can` for predicates in code;
  - follow the schema's own convention for wire and DB fields (e.g., `disabled`).
- **`get` prefix:**
  - in TS, use a property or getter for cheap state;
  - use `getX()` only if it is cheap and side-effect-free;
  - otherwise use `fetch`, `load` or `compute`.
- **Qualifier position:** put the qualifier first (`maxPoints`). Above all, use one pattern consistently.
- **Abbreviations:** use a documented allow-list.
- **Hungarian notation:**
  - never encode types;
  - do encode meaning ("kind") when types can't express it;
  - prefer branded types.
