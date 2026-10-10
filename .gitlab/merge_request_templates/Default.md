## What and why

<!-- One paragraph: the problem, the change, the user-visible effect. Link the story: Closes #… -->

## How to review

<!-- Where to start reading, what to look at closely, what is mechanical. -->

## How it was tested

<!-- Commands run and their result; screenshots for UI changes (French labels as shown). -->

## Checklist

### Tests

- [ ] New behaviour has tests written first (red → green → refactor); every bug fix starts with a failing test
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run hygiene` green in each touched app
- [ ] API integration tests (`npm run test:integration`) green when SQL, migrations or routes changed
- [ ] Dataiku: `uv run ruff check .`, `uv run mypy`, `uv run pytest` green when `dataiku/` changed

### Database and migrations

- [ ] No applied migration edited — changes go in a new `db/migrations/NNNN_name.sql`
- [ ] Expand → migrate → contract respected: this release still runs on the previous schema and the previous release runs on this one (rollback)
- [ ] New queries checked with `EXPLAIN (ANALYZE, BUFFERS)` on seed volume; indexes added where a filter or sort needs one
- [ ] `ops.daily_service_kpis` contract unchanged, or the API, Dataiku flow and contract spec changed together

### Security

- [ ] Every new body, query and path parameter validated with zod; SQL parameterised
- [ ] Authorisation checked per route (viewer / analyst / admin); a test proves the forbidden case
- [ ] No secret, token or personal data in code, fixtures, logs or this MR
- [ ] New dependency justified, exact name checked, licence acceptable

### Documentation and release

- [ ] Docs updated in the same MR (API: OpenAPI; ops: `docs/ops/`; users: `docs/handbook/user-guide.md`)
- [ ] ADR added for a structural decision (`docs/adr/`)
- [ ] `CHANGELOG.md` entry under "Unreleased"
- [ ] Deployment impact stated (new env var, migration duration, manual step) — or "none"

/label ~"needs-review"
