# apps/web — Ops Pulse SPA

React 19 + TypeScript strict + Vite + ECharts. Loaded on top of the root `AGENTS.md`; the API
contract is `docs/specs/2026-10-10-ops-pulse-contract.md` (change it first, then `src/api/schemas.ts`).

## Gates (run all before claiming done)

```bash
npm run lint        # eslint . --max-warnings=0 (shared rules: ../../tools/eslint/base.mjs)
npm run typecheck   # tsc -b --noEmit
npm test            # vitest run (jsdom + Testing Library + MSW)
npm run build       # tsc -b && vite build → dist/
npm run hygiene     # knip (dead code) + jscpd (duplication, baseline .jscpd-baseline.json)
```

`npm run dev` starts Vite on :5173 and proxies `/api` to the API on :3000. No owner-launched runs.

## Layers (enforced by `eslint.config.mjs`)

```
pages → features → api / state → ui        (i18n is a leaf every layer may import)
```

| Folder          | Holds                                                                  | May import            |
| --------------- | ---------------------------------------------------------------------- | --------------------- |
| `src/app/`      | composition: routes, providers, layout, route guard                     | everything            |
| `src/pages/`    | one thin component per route, composes features                          | features, state, ui   |
| `src/features/` | screens' zones: data hooks, tables, forms, chart option builders         | api, state, ui        |
| `src/state/`    | `AuthContext`, `FiltersContext` (Context + useReducer), `useApiQuery`    | api                   |
| `src/api/`      | zod schemas (contract mirror), typed fetch client, one function per endpoint | zod only (no React) |
| `src/ui/`       | presentational parts: `EChart`, fields, cards, status views              | i18n only             |
| `src/i18n/`     | `fr.ts` (every user-facing string) and `format.ts` (`Intl` formatting)   | nothing               |
| `src/test/`     | MSW server + handlers, fixtures (parsed by the production schemas), fakes | anything (tests only) |
| `src/styles/`   | plain CSS with custom properties (`tokens.css`), light/dark via media query | —                  |

`main.tsx` is the composition root: the only file that touches `sessionStorage` and creates the router.

## Rules specific to this app

- **Every API response goes through a zod schema** (`client.request({ schema })` uses `safeParse`);
  a mismatch is logged once and surfaces as `ApiError('INVALID_RESPONSE')`. Types are `z.infer`.
- **Errors**: the client maps everything to `ApiError` (`code` = contract code or
  `NETWORK`/`TIMEOUT`/`ABORTED`/`INVALID_RESPONSE`). A 401 calls `onUnauthorized` → logout.
  UI text for a code comes from `describeError` (`fr.status.errors`).
- **Data fetching**: `useApiQuery(key, load)` only. The key must change exactly when the request does
  (build it from the query, e.g. `JSON.stringify(query)`); it aborts stale requests and derives the
  loading state. Mutations run in event handlers, then call `reload()`.
- **Pagination** resets through `useScopedPage(scope)`, not an effect.
- **Strings**: no French literal outside `src/i18n/fr.ts`; numbers/dates via `src/i18n/format.ts`.
- **Charts**: build options with pure functions (`*Option.ts`, unit-tested), render with
  `<EChart option ariaLabel summary>`; always pass a `DataSummaryTable` as the text alternative.
  Register new ECharts modules in `src/ui/chart/echartsCore.ts` (tree-shaken `echarts/core`).
- **Roles**: UI hides write controls via `canEditIncidents(role)`; the API remains the authority.
- **a11y**: label every control (`TextField`/`SelectField`), conditional markup is `cond ? <X/> : null`,
  role-based queries in tests (`getByRole`, `getByLabelText`).

## Tests

- Tests sit next to the code (`foo.ts` / `foo.test.ts`). Page tests render the real app through
  `renderApp({ path, user })` (`src/test/renderApp.tsx`) with MSW answering `*/api/v1/...`.
- Override a handler per test with `server.use(...)`; unhandled requests fail the test.
- ECharts is replaced by `src/test/fakeEcharts.ts` in `src/test/setup.ts` (jsdom has no canvas);
  assert on `fakeEcharts.charts[n].options`.
- The clock is injected: `FiltersProvider clock` (tests pin `TODAY` = 2026-10-10).
