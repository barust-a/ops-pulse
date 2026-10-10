# ADR-0002: Express 5 with zod validation and a layered TypeScript REST API

**Date**: 2026-10-10
**Status**: accepted
**Deciders**: Alexandre Barusta (lead developer), architecture review, security officer

## Context

The PHP 5.6 monolith mixes SQL, HTML and business rules in one file per page, with SQL built by
string concatenation (injection confirmed). The mission asks for "APIs REST sécurisées" in
Node.js/Express/TypeScript, with middlewares, documented and tested. The API must be easy to read
for developers who know Express, and its rules (SLA, roles) must be testable without a database.

## Decision

Build the API on Express 5 and TypeScript (strict) with a layered structure `domain → ports →
adapters → http`; validate every body, query and path parameter with zod; access PostgreSQL with
`pg` and hand-written parameterised SQL; document it with OpenAPI 3.1 served by the API.

## Alternatives Considered

### Alternative 1: NestJS
- **Pros**: modules, DI and validation pipes out of the box; opinionated structure.
- **Cons**: decorators and class-validator duplicate the types; more framework to learn and to
  upgrade; the mission explicitly names Express.
- **Why not**: the layering is achievable with plain modules and a composition root.

### Alternative 2: Fastify
- **Pros**: faster, JSON-schema validation built in.
- **Cons**: less known by the client's teams; Express 5 now handles async errors natively.
- **Why not**: performance is bounded by SQL, not by the HTTP framework, at this scale.

### Alternative 3: An ORM (Prisma, TypeORM)
- **Pros**: generated types, migrations tooling.
- **Cons**: hides the SQL the mission wants optimised (indexes, `percentile_cont`, partial
  indexes); a second schema language; heavier runtime.
- **Why not**: plain SQL migrations + `pg` keep queries explicit and explainable.

## Consequences

### Positive
- Express 5 forwards rejected promises to the error middleware: no `try/catch` boilerplate.
- One zod schema per boundary gives both runtime validation and the TypeScript type (`z.infer`).
- Domain rules are tested in milliseconds without I/O; repositories are tested against a real
  PostgreSQL in the integration suite.

### Negative
- Row-to-object mapping is hand-written in each repository.
- OpenAPI must be kept in sync with the zod schemas (reviewed in every MR).

### Risks
- Hand-written SQL can regress silently in performance: every new query gets an `EXPLAIN` in its MR.
