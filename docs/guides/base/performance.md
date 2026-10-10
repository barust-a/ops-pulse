# Performance and optimization

**Read this when:**
- a task mentions speed, latency, memory, cost or scale;
- you change database queries, caches, hot loops over large data, bundle size or rendering performance.

Project rules in `AGENTS.md` override this file.

## Rules that always apply

1. Write clear, correct code first. Optimize only a **measured** hot spot, against a **stated target**. No target, no optimization.
2. "Premature optimization" refers to small efficiencies in non-critical code. It never excuses accidental O(n²), N+1 queries, unbounded concurrency, caches or queues, or remote calls without timeouts. Avoid those by default.
3. Measure before and after, with production-like data, builds and hardware. Put the numbers in the PR.
4. Keep the interface unchanged and put the clever code in one place:
   - a comment saying why, which metric, and the before/after numbers;
   - a guard: a benchmark, a query-count assertion, or a size or latency budget.

## When to optimize

- **Knuth (1974):** "We should forget about small efficiencies, say about 97% of the time: premature optimization is the root of all evil. Yet we should not pass up our opportunities in that critical 3%."
  - The same paper says the critical code must be identified by measurement first, because programmers' "intuitive guesses fail".
  - It also says an easily obtained 12% gain is never marginal.
- **Pike's rules (1989):**
  - You can't tell where a program will spend its time, so measure.
  - Don't tune unless one part overwhelms the rest.
  - Fancy algorithms are slow when n is small, and buggier than simple ones.
  - Data dominates: choose the right data structures and the algorithms become self-evident.
- **Jackson:** "Rule 1: Don't do it. Rule 2 (for experts only). Don't do it yet". That means not until you have a perfectly clear, unoptimized solution.
- **Bound the payoff with Amdahl's law:** speedup = 1 / ((1 − p) + p/s), where p is the share of time the code takes and s is how much faster it becomes.
  - Making code that takes 10% of the time infinitely fast gains at most 1.11×.
  - Get p from a profile, not from reading the code.
- **Targets are percentiles, never averages:** p95/p99 latency SLOs; Core Web Vitals at p75 on the web.
- **Performance-aware design is not premature.** Decide early on the things that are expensive to change later:
  - the data model and access paths;
  - the number of round trips;
  - complexity on unbounded inputs;
  - the data layout of known hot loops.

  Micro-tuning waits for a profile.
- **Genuine hot loops can justify data-oriented code** (tables, flat arrays, fewer indirections), as long as it sits behind a clean interface. Examples: render or game loops, codecs, parsers, data pipelines, middleware running at high request rates.

**Fix in this order:** remove work → fewer round trips → better algorithm or data structure → cache → bounded parallelism → micro-tuning.

## Algorithms and data structures

- `includes`, `indexOf`, `find`, `some` and `filter` are O(n). Inside a loop or `map` they make the whole thing O(n·m). Build a `Set` (membership) or a `Map` (lookup, grouping) once, outside the loop.
- Hoist invariants out of loops, renders and handlers: compiled `RegExp`s, `Intl.*` formatters, parsed config, lookup tables.
- Memoize only pure functions. Bound every memo with a maximum size (LRU) and a TTL if inputs can change, and key it with a cheap primitive.
- Precompute (lookup tables, denormalized counters) when reads vastly outnumber writes. Every precomputed copy is a cache you must invalidate.
- Stream unbounded data (files, HTTP bodies, DB cursors, async iterators) instead of loading it all.
- For small, bounded n, a linear scan is fine and often faster. Don't hand-roll exotic structures without a measured need.

```ts
const blocked = new Set(blockedIds);                          // O(n + m), not O(n·m)
const kept = orders.filter((o) => !blocked.has(o.customerId));
```

## I/O and databases

- **Count round trips before counting instructions.** A same-datacenter round trip costs about 0.3–0.5 ms; a memory reference costs about 50–100 ns. One network hop equals thousands of memory accesses.
- **N+1 queries.**
  - *Detect:* count queries per request (assert the count in tests); look for `await` on a repository inside a loop or resolver.
  - *Fix:* use a JOIN or eager load; or run one `WHERE id = ANY($1)` / `IN (…)` query and join the results in memory with a `Map`; or use a per-request DataLoader. Never share a DataLoader's cache across users.
- **Bulk writes:** multi-row `INSERT`/upsert, `COPY`, or batch APIs. Chunk very large batches to bound memory and lock time.
- **Keyset (cursor) pagination for large or deep lists.** `OFFSET` scans and discards rows, and it duplicates or skips rows when data changes between pages. `OFFSET` is fine for small admin lists.
- **Index the queries you actually run.** Check them with `EXPLAIN (ANALYZE, BUFFERS)` on realistic volumes. `ANALYZE` executes the statement, so wrap writes in `BEGIN … ROLLBACK`. Every index slows writes.
- **Push work into the database:** select only the columns you need, and filter and aggregate there.
- **Keep connection pools small.** Start near `cores × 2 + effective spindles`, then load-test.
- **Keep transactions short.** Never hold a transaction or pooled connection across a network call or a user wait.
- **Avoid chatty APIs:** use batch or aggregate endpoints, and paginate and compress large payloads.
- **HTTP caching:**
  - hashed static assets: `Cache-Control: public, max-age=31536000, immutable`;
  - HTML and other unversioned URLs: `no-cache` plus `ETag` (the client revalidates);
  - personalized responses: `private`;
  - `no-store` forbids storage altogether.

## Caching

- Fix the slow thing first: a missing index, an N+1 query. A cache adds an invalidation problem: "There are only two hard things in Computer Science: cache invalidation and naming things" (Phil Karlton).
- **For every cache, decide:**
  - *what* to cache: expensive, read-heavy, deterministic results;
  - *where*: request-scoped loader, in-process LRU, shared Redis, or HTTP/CDN;
  - the *TTL*, from the staleness the business accepts;
  - the *full key*: tenant, user, locale, version and every other input;
  - the *invalidation path*.
- **Strategies:**
  - cache-aside: load on a miss; update the store, then delete the cache entry;
  - write-through;
  - TTL-only, when staleness is acceptable;
  - versioned keys, for bulk invalidation.
- **Protect hot keys from stampedes:** single-flight or a lock (one process recomputes), background refresh, or probabilistic early expiration. Add jitter to TTLs.
- **Pitfalls:**
  - an unbounded module-level `Map` (a leak);
  - stale results when inputs are mutable;
  - identity-based keys that never hit;
  - `JSON.stringify` keys (slow, and order-sensitive);
  - caching rejected promises forever;
  - user data held in a shared scope.
- Don't cache strongly consistent data (balances, permissions) unless invalidation is exact.

## Concurrency and latency

- Run independent I/O concurrently (`Promise.all` or `allSettled`); keep dependent steps sequential. Always bound the concurrency with a limiter, a pool or chunks. Unbounded fan-out exhausts sockets, DB pools and rate limits.
- Respect back-pressure: use `stream.pipeline()` and bounded queues, and shed load rather than buffering without limit.
- Put a timeout on every remote call (`AbortSignal.timeout(ms)`) and propagate cancellation. For retries and circuit breakers, see `design-patterns.md`.
- **Watch tail latency.** Fan-out amplifies it: if 1 in 100 responses is slow, 63% of requests that touch 100 servers are slow (Dean & Barroso, *The Tail at Scale*). Reduce fan-out first.

## Memory

- Bound every long-lived collection: caches, maps keyed by user or session, queues. Evict entries when the session or connection ends. Use `WeakMap` for metadata attached to objects you don't own.
- Pair every listener, subscription, interval and timer with cleanup. Prefer passing `{ signal }` from an `AbortController`.
- `MaxListenersExceededWarning` means a leak: fix it rather than raising the limit.
- Reduce allocations in hot loops (chained `map`/`filter`, spread copies, string building) only when GC time shows up in a profile.
- **To diagnose a leak:** look for a steadily growing `heapUsed`, and compare heap snapshots taken after repeating the same workload. Raising `--max-old-space-size` does not fix a leak.

## JavaScript and Node.js

- **Never block the event loop in a server.** On request paths, that means:
  - no `fs.*Sync`, `crypto.*Sync`, `zlib.*Sync` or `child_process.*Sync`;
  - no huge `JSON.parse`/`stringify` (Node's docs measure 0.7 s to stringify and 1.3 s to parse 50 MB). Paginate, stream, or move the work off the loop;
  - no ReDoS-prone regexes on untrusted input.
- **CPU-bound work:** split it into chunks with `setImmediate`, or offload it to `node:worker_threads`.
- **Engine-level advice is for profiled hot code only:** initialize objects consistently so they share a shape, keep call sites monomorphic, avoid repeated `delete`, avoid holey arrays. Don't bend normal code around engine internals.
- **Profile** with `node --cpu-prof`, or `--inspect` plus Chrome DevTools, and read flame graphs. Clinic.js is no longer maintained.
- **Benchmark** with mitata or tinybench, which handle warm-up and report percentiles.
  - Make results observable, so the JIT can't delete the work.
  - Use production builds, realistic inputs and the same runtime version.
  - Prefer end-to-end measurements to micro-benchmarks.

## Web front-ends

- **Core Web Vitals,** at the 75th percentile:
  - LCP ≤ 2.5 s;
  - INP ≤ 200 ms;
  - CLS ≤ 0.1.
- **Enforce budgets in CI** for page weight and JavaScript. JavaScript costs more per byte than images.
- **Ship less JavaScript:**
  - split code by route and interaction;
  - lazy-load what isn't critical;
  - use tree-shakeable ESM;
  - audit dependencies.
- **Images:**
  - serve them at the right size, in modern formats;
  - always set `width` and `height` (prevents CLS);
  - lazy-load below the fold, but never the LCP image.
- **DOM:**
  - batch reads, then writes, to avoid layout thrashing;
  - animate `transform` and `opacity`;
  - debounce input-driven work and throttle scroll and resize (or use `requestAnimationFrame` / `IntersectionObserver`);
  - virtualize long lists.
- **React:**
  - Fix re-renders through structure first: pass children as JSX, keep state local, keep rendering pure.
  - React Compiler (stable since October 2025) memoizes automatically. Use `useMemo`/`useCallback` as escape hatches, after measuring.

## Checklist

**Before**

1. Name the target (SLO percentile, throughput, memory, Web Vitals, bundle budget) and the problem users see.
2. Reproduce with production-like data, a production build, and realistic hardware and network.
3. Measure a baseline: p50/p95/p99, query counts, EXPLAIN plans. Profile to find the hot spot.
4. Estimate the ceiling with Amdahl's law.
5. Make sure tests pin the current behavior, so the optimization is a behavior-preserving refactoring.

**While**

6. Follow the fix order above. Make one change at a time and re-measure after each. Revert changes that don't move the metric.
7. Bound everything you add: cache size and TTL, concurrency, queue length, timeouts. Cache keys include tenant and user; the invalidation path is defined.

**After**

8. Re-measure under the same conditions, and put before/after numbers and the environment in the PR.
9. Add a regression guard: a benchmark, a query-count assertion, a bundle-size check or a performance budget.
10. Comment why the optimized code exists. Delete it when the reason goes away.

## Performance smells → fix

| Smell | Why it hurts | Fix |
|---|---|---|
| `includes`/`find` on an array inside a loop or `map` | O(n·m) | Build a `Set`/`Map` once |
| DB or HTTP call awaited inside a loop (N+1) | Latency × N; pool pressure | JOIN, batch `IN`/`ANY`, DataLoader |
| Sequential `await` of independent calls | Latencies add up | Bounded `Promise.all` |
| Unbounded `Promise.all` over user-sized input | Exhausts sockets, pools, rate limits | Limiter or chunking |
| Deep `OFFSET` pagination | Scans and discards rows; duplicates or skips rows | Keyset on a unique ordered key |
| `SELECT *`; filtering in application code | Extra I/O and memory | Select columns; filter in SQL |
| Unindexed filter or sort columns | Full scans that grow with the table | Index; check with EXPLAIN on real volumes |
| Transaction held across a remote call | Lock contention, pool starvation | Short transactions |
| Sync `fs`/`crypto`/`zlib` in a server | Blocks every client | Async APIs or a worker |
| Multi-MB `JSON.parse` on the request path | Blocks the event loop | Paginate, stream, worker |
| Nested-quantifier regex on user input | ReDoS | Rewrite it; cap input length |
| Unbounded module-level cache or memo | Leak; stale data | LRU + TTL; `WeakMap` |
| Listeners or intervals never removed | Leak | `AbortSignal`; cleanup |
| DOM read after write in a loop | Forced layout on each iteration | Batch reads, then writes |
| Remote call with no timeout | Pile-ups; long tail | `AbortSignal.timeout`, deadlines |
| `useMemo`/`memo` everywhere | Noise, dependency bugs | Structural fixes; React Compiler |
| Benchmark result never used | Dead-code elimination fakes the numbers | mitata/tinybench; observable results |
| Thousands of list rows rendered | DOM cost; poor INP | Virtualize |
