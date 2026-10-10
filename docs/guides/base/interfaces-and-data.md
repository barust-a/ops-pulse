# Interfaces, concurrency, data and observability

**Read this when you are:**
- designing or changing a public interface: a library API, HTTP endpoint, event or CLI;
- calling remote services;
- writing async or concurrent code that shares state;
- changing schemas or migrations;
- handling money or time;
- adding logs, metrics or traces.

Project rules in `AGENTS.md` override this file.

## Interface and API design

- **Make interfaces easy to use correctly and hard to use incorrectly** (Scott Meyers, *97 Things Every Programmer Should Know*). Anticipate mistakes and make them impossible with precise types, required parameters and no ambiguous booleans.
- **Write the calling code before the implementation** (Bloch: write to your API early and often).
- **When in doubt, leave it out.**
  - You can always add, but never remove.
  - Keep the public surface minimal.
  - Don't leak implementation details (types, error shapes, ordering) through the interface.
- **Bloch's rules:**
  - Use three or fewer positional parameters; beyond that, use an options object.
  - Return an empty collection, not `null`.
  - Don't make callers parse strings to get data; that turns a display format into a de facto API.
  - Never use binary floats for money.
  - The same word means the same thing everywhere.
  - No surprising side effects.
- **Fail fast:** at compile time where possible (precise types), otherwise at the boundary with a clear error.

## Compatibility and versioning

- **Hyrum's Law:** "With a sufficient number of users of an API, it does not matter what you promise in the contract: all observable behaviors of your system will be depended on by somebody." Treat changes to ordering, timing, error text and defaults as potentially breaking.
- **Evolve published contracts additively:**
  - add fields, endpoints or optional parameters;
  - never change the meaning of an existing field;
  - readers ignore unknown fields.
- **Make breaking changes in three steps: expand → migrate → contract.**
  1. Add the new form next to the old one.
  2. Move every caller to the new form.
  3. Remove the old form.

  Mark the old form `@deprecated` and name its replacement.
- **Semantic Versioning** for anything published:
  - declare the public API;
  - MAJOR for incompatible changes, MINOR for compatible features, PATCH for compatible fixes;
  - deprecate in a minor release, and remove only in a later major one.

## HTTP APIs

- **One error format everywhere: RFC 9457 Problem Details** (`application/problem+json`).
  - Fields: `type`, `status`, `title`, `detail`, `instance`, plus your own extension members.
  - Clients ignore members they don't know.
  - No stack traces.
- **Paginate every list from the start;** adding pagination later breaks clients.
  - Use opaque cursor tokens.
  - Set a default and a maximum page size.
  - Return an empty next token at the end of the list.
  - Offsets are acceptable only for small, stable admin lists.
- **Make retried writes safe.** For POST and PATCH, accept an `Idempotency-Key`. This is an IETF draft, widely used in practice.
  - Store the key, a fingerprint of the request, and the response.
  - Reuse of a key with a different payload → 422.
  - Reuse while the original request is still in flight → 409.

  Otherwise, design writes to be naturally idempotent: PUT, or an upsert keyed by a client-supplied ID.
- **Validate requests at the edge with a schema**, and answer failures in the problem format.

## Calling other services

- **Timeouts:** every remote call needs both a connection timeout and a request timeout.
  - Derive the value from the downstream latency percentile you accept to cut off (for example p99.9).
  - Pass deadlines and `AbortSignal` downstream.
- **Retries:** retry only transient failures.
  - Use capped exponential backoff with full jitter: `delay = random(0, min(cap, base × 2 ** attempt))`.
  - Retry at one layer of the stack only, within a retry budget.
  - Never retry a non-idempotent operation without an idempotency key.
  - Never resend a 4xx request unchanged.
  - Log early attempts as info; log only the final failure as an error.
- **Circuit breakers** are worth it only for long outages where failing fast has a meaningful fallback. Test the open state.
- **Bulkheads:** give each dependency its own concurrency limit or pool, so one slow dependency can't starve the others.
- Pattern details: `design-patterns.md` → Resilience.

## Concurrency correctness

- **Between two `await`s, anything can happen.**
  - Never check, then act, across an `await`; let the database decide atomically.
  - Use a unique constraint with `INSERT … ON CONFLICT`, or a conditional `UPDATE … WHERE`.
- **Servers:** no request-specific mutable state at module level, because concurrent requests share it. Use request-scoped objects or `AsyncLocalStorage`.
- **Read-modify-write: use optimistic locking.**
  - Run `UPDATE … SET …, version = version + 1 WHERE id = $1 AND version = $2`.
  - If 0 rows change, reload and retry, or return 409.
- **Transactions:** keep invariants that span several rows in one short transaction. No network I/O inside it.
- **Clients and UIs: guard against stale responses.**
  - Abort superseded requests with an `AbortController`.
  - Tag each request with an ID or sequence number, so an old response can't overwrite a newer one.
- **Messages:**
  - Assume at-least-once delivery: make handlers idempotent, de-duplicating by key.
  - Never assume ordering across concurrent promises or queue partitions; carry sequence numbers instead.
- **Fan-out:** bound it with `p-limit` or chunking. `Promise.all` rejects on the first failure but doesn't cancel the others, so pass them a shared signal.
- **Events after a DB write:** use a transactional outbox (write the event row in the same transaction; a relay publishes it). Never save and then publish as two separate writes.

```ts
// BAD: two concurrent requests both pass the check and both insert
if (!(await users.findByEmail(email))) await users.insert({ email });
// GOOD: UNIQUE(email) + one atomic, parameterized statement
await sql`INSERT INTO users (email) VALUES (${email}) ON CONFLICT (email) DO NOTHING`;
```

## Data and persistence

- **Never edit a migration that has been applied anywhere.** Add a new one.
- **Migrations must stay compatible with the code that is running.** Use three steps:
  1. **Expand:** add a nullable column or a new table.
  2. **Migrate:** backfill in batches and dual-write.
  3. **Contract:** drop the old column. Actually finish this step.

  Prefer rolling forward. Write down-migrations only when they lose no data.
- **Backfills:** run large ones in batches, separately from schema changes.
- **Constraints:** declare them in the database too — NOT NULL, FOREIGN KEY, UNIQUE, CHECK. Validation done only in the application loses races.
- **Time:**
  - Store instants as `timestamptz` / UTC everywhere.
  - Convert to local time only for display.
  - Query ranges as half-open intervals, `[start, end)`.
- **Money:**
  - Store integer minor units or an exact decimal, always with a currency code.
  - Never use binary floats, and avoid Postgres `money`.
  - In JS, stay within `Number.MAX_SAFE_INTEGER` or use `bigint`.
- **`bigint` IDs:** keep them as `string` or `bigint` in JS. Never convert them with `Number()`.

## Observability

- **Logs are structured (JSON)** with a stable schema:
  - UTC timestamp;
  - level;
  - event name;
  - service;
  - correlation or trace ID;
  - the IDs of the entities involved.
- **Never log:**
  - secrets, tokens or passwords;
  - connection strings;
  - payment data;
  - sensitive personal data.

  Mask, hash or drop these. Pass untrusted values as structured fields, never concatenated into the message, to prevent log injection.
- **Log an error once, where it is handled.** Intermediate layers add context with `cause` and rethrow; they don't log-and-rethrow.
- **Choose the level by the action it requires:**
  - ERROR: someone must act;
  - WARN: degraded but handled;
  - INFO: business events;
  - DEBUG: off in production.
- **Log security events:** authentication success and failure, authorization failures, validation failures.
- **Metrics per endpoint or job:** rate, errors and duration (as percentiles). Never use unbounded label values, such as user IDs or raw URLs.
- **Tracing:** propagate trace context across services (OpenTelemetry), so logs, traces and metrics correlate.
- **Write actionable messages:** what failed, for which ID, and what to do next.
