# TypeScript and JavaScript

**Read this when:**
- changing `tsconfig`, lint configuration or module settings;
- coordinating async work (concurrency, cancellation, timeouts);
- validating untrusted data at runtime;
- reaching for a newer language feature, or unsure about a TS/JS pitfall.

The language-agnostic rules live in the other guides; this file maps them to TS/JS. Project rules in `AGENTS.md` override this file. Check the installed versions in the lockfile before you rely on anything version-specific below.

## Version landscape (October 2026 — verify against the project)

- **TypeScript 7.0** (July 2026) is the native Go port: same `tsc`, much faster builds.
  - It has no stable programmatic API yet. typescript-eslint, Volar-based tooling (Vue, Svelte, Astro, MDX) and Angular template checking still need TypeScript 6.0.
  - On TS 7, install TS 6 side by side for type-aware linting. typescript-eslint supports TS < 6.1.
- **TypeScript 6.0** (March 2026) is the last compiler written in JS, and the bridge release: its deprecations are errors in 7.0.
  - Upgrade path: 5.x → 6.0 (fix deprecations) → 7.0.
- **Node.js:**
  - 24 is Active LTS until 2026-10-20, then maintenance; 22 is maintenance LTS until 2027-04-30.
  - 26 becomes Active LTS on 2026-10-28.
  - Native type stripping is stable (24.12+, 25.2+).
- **ECMAScript:**
  - **ES2025:** iterator helpers, `Set` methods, `Promise.try`, `RegExp.escape`, import attributes and JSON modules, `Float16Array`.
  - **ES2026:** `Error.isError`, `Array.fromAsync`, `Math.sumPrecise`, `Uint8Array` base64, `Map#getOrInsert` / `getOrInsertComputed`.
  - **Finished, slated for ES2027:**
    - `using` (explicit resource management): ships in Node 24+.
    - Temporal: Firefox 139+, Chrome/Edge 144+, Node 26. Not in Safari yet, so use a polyfill.

## Compiler settings

- **Strictness:**
  - Keep `"strict": true` explicit, even though TS 6 makes it the default.
  - Add `noUncheckedIndexedAccess` (`arr[i]` becomes `T | undefined`) and `exactOptionalPropertyTypes` (`a?: T` means "absent", not "undefined"). `tsc --init` enables both since TS 5.9. In a large legacy codebase, adopt them one package at a time.
  - Also enable `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch`. Leave unused-variable checks to the linter.
- **Per-file transpilation:** set `verbatimModuleSyntax` (type-only imports must use `import type`) and `isolatedModules` (every file can be transpiled alone by esbuild, swc or Node).
- **`erasableSyntaxOnly`** (TS 5.8): turn it on whenever a type-stripper runs your code (Node, ts-blank-space).
  - It rejects `enum`, namespaces with runtime code, parameter properties and `import =`.
  - Do *not* enable it in decorator-and-parameter-property frameworks such as NestJS or Angular.
- **Module settings by project type:**
  - **Node app:** `module: nodenext` + `"type": "module"`.
  - **Bundled app:** `module: esnext` (or `preserve`) + `moduleResolution: bundler` + `noEmit`.
  - **Published library:** `node18`, `node20` or `nodenext` — never `bundler`, which lets you publish code that only works in bundlers. Also set `declaration`, `declarationMap`, `rootDir` and `outDir`; consider `isolatedDeclarations`.
- **TS 6 defaults:**
  - `strict: true` and `module: esnext`.
  - `target` floats to the latest spec.
  - `types: []`, so add `"types": ["node"]` or globals like `process` disappear.
  - `noUncheckedSideEffectImports: true`.
- **Deprecated in 6.0, errors in 7.0:**
  - `target: es5` and `downlevelIteration`;
  - `moduleResolution: node`/`node10`;
  - `module: amd|umd|systemjs|none`;
  - `baseUrl`;
  - `esModuleInterop: false`;
  - `alwaysStrict: false` and `allowSyntheticDefaultImports: false`;
  - the `module Foo {}` namespace keyword and `/// <reference no-default-lib>`;
  - import `asserts` (use `with`).

  `outFile` and `moduleResolution: classic` are removed outright.
- **Runtime match:** set `target`/`lib` to your oldest runtime. `lib: esnext` types APIs that Node 24 doesn't have (Temporal).

```jsonc
{ "compilerOptions": {                       // baseline: Node app, TS ≥ 5.8
  "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true, "noImplicitReturns": true, "noFallthroughCasesInSwitch": true,
  "module": "nodenext", "target": "es2024", "types": ["node"],
  "verbatimModuleSyntax": true, "isolatedModules": true,
  "erasableSyntaxOnly": true,                // omit for NestJS/Angular-style decorators
  "rewriteRelativeImportExtensions": true,   // import "./x.ts"; rewritten to "./x.js" if you emit
  "noUncheckedSideEffectImports": true, "moduleDetection": "force",
  "forceConsistentCasingInFileNames": true, "skipLibCheck": true, "noEmit": true
} }
```

## Linting

- **Use type-aware linting.**
  - Start from typescript-eslint `recommendedTypeChecked` + `stylisticTypeChecked`, the documented default.
  - For a stricter bar, use `strictTypeChecked` instead, and pin the version (strict configs aren't semver-stable).
  - Document every rule you disable, with a reason.
- **Enable these rules too; they are in no preset:**
  - `switch-exhaustiveness-check`;
  - `strict-boolean-expressions`;
  - `prefer-readonly`;
  - `consistent-type-imports` + `no-import-type-side-effects`;
  - `explicit-module-boundary-types` (libraries).
- **Function style:** core `func-style` (declaration) and `prefer-arrow-callback`; see Functions.
  `@typescript-eslint/no-use-before-define` lets a call reach a function declared further down
  (declarations hoist) but reports a const, class or enum read above its definition.
- **Faster linters:**
  - Oxlint `--type-aware` covers almost all of typescript-eslint's type-aware rules.
  - Biome v2 has partial type-aware coverage.
  - Use them for fast feedback, but keep one complete type-aware gate in CI.

| Rule | Why |
|---|---|
| `no-floating-promises` | Unhandled rejections crash Node or vanish |
| `no-misused-promises` | Promises in conditions, or passed where a `void` callback is expected |
| `await-thenable` | Awaiting a non-promise means the API is misunderstood |
| `switch-exhaustiveness-check` | Adding a union member flags every unhandled `switch` |
| `no-explicit-any` + `no-unsafe-*` | `any` switches checking off and spreads |
| `no-unnecessary-condition` | Checks the types already rule out (dead or confused code) |
| `strict-boolean-expressions` | Truthiness bugs with `0`, `''` and nullable values |
| `prefer-nullish-coalescing` | `\|\|` overwrites legitimate `0`, `''` and `false` |
| `prefer-optional-chain` | Replaces fragile `a && a.b && a.b.c` |
| `only-throw-error` + `prefer-promise-reject-errors` | Keeps stack traces and `cause` chains |
| `restrict-template-expressions` | Stops `[object Object]` and `undefined` from ending up in strings |
| `no-non-null-assertion` | `!` is an unchecked claim |
| `consistent-type-assertions` (`assertionStyle: 'never'`) | `as T` is an unchecked claim too; `as const` stays allowed |
| `return-await` (in try) | `catch`/`finally` see the rejection |
| `no-deprecated` | Tracks remaining uses during expand/contract |
| `no-unnecessary-type-parameters` | Generics that relate nothing |

## Type design

- **`unknown`, never `any`.** Narrow before use with `typeof`, `instanceof`, `in`, `Array.isArray` or a discriminant. The compiler trusts custom guards (`x is T`) and assertion functions (`asserts x is T`) blindly, so keep them tiny and backed by real checks.
- **Make invalid states unrepresentable** with discriminated unions, not objects full of optional fields. Prefer a union of interfaces to an interface of unions (*Effective TypeScript*, items 29 and 34). Check unions exhaustively.
- **Brand IDs and units** (`UserId`, `Cents`) so they can't be mixed. Create branded values only through a schema's `.brand()` or a validating type guard (`raw is UserId`), never with a cast: lint rejects every type assertion.
- **Use `as const satisfies Shape` for lookup tables**: it checks the shape and keeps the literal types. Use `satisfies`, annotations, type guards and throwing `assert()` helpers: `as` and `!` have no runtime check, and lint rejects both (`as const` aside).
- **Accept `readonly T[]` / `Readonly<T>` parameters.** `readonly` is compile-time only, and `Object.freeze` is shallow.
- **No `enum`, no `namespace`.** Use string-literal unions or `as const` objects, and ES modules. Type stripping rejects enums. Never use `const enum`.
- **Generics: the golden rule.** A type parameter that appears only once probably shouldn't exist. A return-only generic, `parse<T>(s): T`, is `any` in disguise: return `unknown` or take a schema.
- **Unions over overloads.** Never use the wrapper types `Number`, `String`, `Boolean` or `Object`. Give callbacks whose result is ignored a `void` return type.
- **Return types:** annotate exported functions (they're contracts, and `isolatedDeclarations` requires it). Let locals and callbacks be inferred.
- **`Record<Union, V>` vs `Map`:** use `Record<Union, V>` for closed key sets (it's exhaustiveness-checked) and JSON-shaped data. Use `Map` for dynamic, untrusted or non-string keys and frequent insert/delete.
- **`type` vs `interface`:** pick one style and enforce it (`consistent-type-definitions`). Use `interface … extends` for object hierarchies (faster than `&`), and `type` for unions, mapped and conditional types.

```ts
type Shape = { kind: "circle"; r: number } | { kind: "rect"; w: number; h: number };
const area = (s: Shape): number => {
  switch (s.kind) {
    case "circle": return Math.PI * s.r ** 2;
    case "rect": return s.w * s.h;
    default: return assertNever(s); // compile error when a variant is added and not handled
  }
};
function assertNever(x: never): never { throw new Error(`Unhandled variant: ${JSON.stringify(x)}`); }

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
type UserId = Brand<string, "UserId">;
function isUserId(raw: string): raw is UserId {
  return UUID_PATTERN.test(raw);
}
function toUserId(raw: string): UserId {
  if (!isUserId(raw)) throw new TypeError(`Invalid UserId: ${raw}`);
  return raw; // narrowed by the guard: no assertion
}
```

## Runtime boundaries

- **Types vanish at runtime.** `JSON.parse` and `Response.json()` return `any`. Assign the result to `unknown` and parse it.
- **Parse everything untrusted with a schema:**
  - request bodies and query strings;
  - env vars;
  - files;
  - DB rows (raw SQL, JSON columns);
  - queue messages;
  - `localStorage` / `postMessage`;
  - third-party responses;
  - LLM output.
- **One schema, derived types.** Write `type X = z.infer<typeof X>` (or `z.input`/`z.output` when the schema transforms). Never hand-write a twin type.
- **Libraries:**
  - Zod 4: `import * as z from "zod"`; formats are top-level, like `z.email()` and `z.url()`.
  - Alternatives: Valibot, ArkType.
  - Library code should accept any Standard Schema v1 implementation rather than one vendor.
- **Parse, don't validate:**
  - The boundary returns a refined type (branded or discriminated) or fails.
  - Core code accepts only parsed types and never re-checks them.
  - Values your own typed code produced need no re-validation.

## Functions

- **Rule: name a function with a `function` declaration.** Use an arrow only where a declaration cannot express the function. Enforced by `func-style: ['error', 'declaration', { allowTypeAnnotation: true }]` and `prefer-arrow-callback`.
- **Why:**
  - A declaration hoists: a module can put its entry point first and its helpers below, and an import cycle cannot hit a `const` in its temporal dead zone.
  - Some TypeScript features exist only on declarations:
    - overloads (the arrow form needs an `as` cast, banned by AGENTS.md §9);
    - generators;
    - `this` parameters;
    - assertion and `never` helpers that narrow without an extra annotation (an arrow `asserts` helper fails with TS2775 at every call site).
  - In `.tsx`, a generic declaration needs no `<T,>` workaround.
  - One form makes functions easy to scan for.
- **Use an arrow for:**
  - inline callbacks: `rows.map((row) => toChunk(row))`, `useEffect(() => …)`, `it('…', () => …)`;
  - closures inside class methods whose own body uses the outer `this`;
  - a const typed by a named function type the code already has: `const onDrop: DropHandler = (event) => …`. Never invent an inline type to dodge the rule;
  - a function returned from a function: `function byKey(key: Key) { return (a: Row, b: Row) => … }`.
- **Nested functions and React handlers** inside a component are declarations too: `function handleClick() { … }`. Hooks keep their arrow callbacks: `useCallback(() => …, deps)`.
- **Wrap after declaring:** `function Row(props: RowProps) { … }`, then `export const MemoRow = memo(Row);`. The component keeps its name.
- **Class members** stay prototype methods. Method decorators (NestJS, Angular) need methods. An arrow field is only for a handler that must be removed later.

```ts
// ✅
export function toChunk(row: RawRow): Chunk {
  return { id: row.id, text: normalize(row.body) };
}

// ❌ func-style: use a function declaration
export const toChunk = (row: RawRow): Chunk => ({ id: row.id, text: normalize(row.body) });
```

## Modules

- **ESM first.**
- **Named exports only**, except where a framework requires a default export (routes, `React.lazy`, config files). Named exports keep imports uniform and make renames trackable.
- **Type-only imports:** use `import type { A }` for type-only symbols. The inline `import { type A }` form leaves a side-effect import behind under `verbatimModuleSyntax`.
- **No top-level side effects** (I/O, globals, registration) outside entry points. No `export let`.
- **No import cycles.** With ESM they surface as TDZ errors or `undefined` during initialization. Break a cycle by extracting the shared piece, or by injecting the dependency.
  - Under a dependency-injection framework (NestJS, Angular), a cycle through entry or barrel files can compile cleanly and fail only at startup or in the feature's tests, with a cryptic injection error (`Invalid guard passed to @UseGuards()`, an `undefined` provider). Run the feature's tests, not only `tsc`.
- **Package boundaries:**
  - Define a package's public API with `package.json` `exports`.
  - For internal aliases, prefer `package.json` `imports` over tsconfig `paths` (Node never reads tsconfig). Use a named prefix (`#app/*`); bare `#/*` needs Node ≥ 24.14 or ≥ 25.4 and TypeScript ≥ 6.0.
  - Barrel files and monorepo boundaries: see `architecture.md`.

## Async

- **No floating promises.** Every promise is awaited, returned, `.catch`-ed or given a two-argument `.then`. Since Node 15, an unhandled rejection crashes the process.
- **No async callbacks where `void` is expected** (`forEach`, emitters, timers).
  - Sequential work: `for…of` with `await`.
  - Parallel work: `Promise.all(xs.map(f))`.
- **Pick the right combinator:**
  - `Promise.all` for independent work. It fails fast, but the others keep running; abort them yourself.
  - `Promise.allSettled` when partial failure is acceptable.
  - `Promise.any` for the first success.
- **Bound concurrency for large sets** with `p-limit` or chunking.
- **Cancellation:**
  - Accept an `AbortSignal` and pass it on.
  - Add a timeout with `AbortSignal.timeout(ms)`.
  - Combine signals with `AbortSignal.any([...])`.
- **Inside `try`, write `return await`,** so `catch`/`finally` see the rejection.
- **Don't mix callbacks and promises.** Use `node:fs/promises`, `node:timers/promises`, `events.once` and `util.promisify`. Use `Promise.withResolvers()` instead of hoisting `resolve` out of an executor.

```ts
const limit = pLimit(8);
const results = await Promise.allSettled(
  ids.map((id) => limit(() => fetchUser(id, { signal: AbortSignal.timeout(5_000) }))));
```

## Errors

- **Throw and reject only `Error` objects.**
- **Use one subclass per error category**, with `name` set, machine-readable fields such as `code`, and the original error wrapped as `cause`.
- **Catch as `unknown` and narrow.**
  - Under `strict`, `useUnknownInCatchVariables` types `catch (e)` as `unknown`.
  - `Error.isError(e)` also works across realms (Node 24+, all current browsers). Otherwise use `instanceof Error`.
- **Never swallow an error.** Handle it, rethrow it with context, or let one central handler log it.
- **Model expected outcomes as discriminated-union results**: not found, validation failure, conflict.
  - neverthrow is a light `Result`.
  - Effect is a full effect system. Adopt it only as a team-wide decision, because it reshapes the codebase.

```ts
class ConfigError extends Error { override name = "ConfigError"; }
try { await loadConfig(path); }
catch (err: unknown) { throw new ConfigError(`Cannot load config ${path}`, { cause: err }); }
```

## Modern features

**Worth using:**
- `??` and `??=` — they keep `0`, `''` and `false`, unlike `||`.
- `?.` and `Object.hasOwn`.
- `.at(-1)`.
- `structuredClone` for plain data. It throws on functions and drops class prototypes.
- Non-mutating array methods: `toSorted`, `toReversed`, `toSpliced`, `with`.
- `Object.groupBy` / `Map.groupBy`.
- `Set` algebra (`union`, `intersection`, …).
- Iterator helpers for lazy pipelines: `map.values().filter(f).take(10).toArray()`.
- `Promise.try`; `Map#getOrInsertComputed` (Node 26+).
- `RegExp.escape` and the RegExp `v` flag.
- `Uint8Array.fromBase64` (Node 25+).
- `Math.sumPrecise` (browsers; no Node release yet).
- `using` / `await using` for locks, handles and connections.
- Temporal, with a polyfill where it's missing.
- `Intl.*` for numbers, dates, plurals, collation and segmentation.

**Avoid:**
- `var` → use `const`/`let`.
- `==` → use `===`.
- `arguments` → use rest parameters.
- `for…in` over arrays → use `for…of` or `.entries()`.
- `delete arr[i]` (it leaves a hole).
- Wrapper objects (`new String()`, `new Number()`).
- Modifying built-ins or prototypes.
- `eval`, `new Function`, `with`.

## Pitfalls

- **Money and numbers:**
  - Never use binary floats (`0.1 + 0.2 !== 0.3`). Use integer minor units, branded as `Cents`, or a decimal library, and round at defined steps.
  - Format with `Intl.NumberFormat`.
  - Keep DB `bigint` IDs as `string`/`bigint`.
- **Dates:**
  - `Date` is mutable and its months are 0-based.
  - A date-only string parses as UTC, but a date-time string without an offset parses as local time.
  - Store instants as UTC ISO-8601 (plus an IANA zone when wall-clock time matters), and prefer Temporal.
- **Shallow copies:** spread and `Object.assign` copy one level only, so nested objects stay shared.
- **`this` binding:** passing `obj.method` as a callback loses `this`. Use arrow-function fields or `.bind` (lint: `unbound-method`).
- **`sort()` with no comparator** compares as strings: `[10, 9, 1].sort()` gives `[1, 10, 9]`. Always pass a comparator: `(a, b) => a - b` for numbers, or `Intl.Collator().compare` for text.
- **`parseInt`:** always pass radix 10. Better, use `Number()` + `Number.isFinite`, because `parseInt("12px", 10)` silently returns 12.
- **`JSON.stringify` silently changes data:**
  - drops `undefined`, functions and symbols;
  - turns `NaN`/`Infinity` into `null`;
  - turns a `Date` into a string (it doesn't come back as a `Date`);
  - throws on `BigInt` and on cycles;
  - turns `Map` and `Set` into `{}`.

  Serialize through explicit DTOs or schema codecs.
- **Numeric enums have reverse mappings**, so `Object.values(E)` returns both names and numbers.

## Node.js

- **Don't block the event loop.** "The Event Loop should orchestrate client requests, not fulfill them itself" (Node docs). More in `performance.md`.
- **Use streams for large data:** `pipeline()` from `node:stream/promises` gives back-pressure and error propagation.
- **Graceful shutdown on `SIGTERM`:**
  1. Stop accepting new work.
  2. Drain in-flight requests.
  3. Close pools within a deadline.
  4. Exit.

  On an uncaught exception or unhandled rejection, log it and exit; let the supervisor restart the process. A bug inside one request or job is contained by its top-level handler (`clean-code.md`).
- **Validate env once at startup** in a config module (`--env-file` is stable).
- **Log structured JSON** with Pino or similar, using levels and correlation IDs.
