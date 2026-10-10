# Ops Pulse — web

The supervision SPA of Ops Pulse: KPI dashboard (Dataiku-computed), incidents and changes, in
French for the client, in React 19 + TypeScript strict + Vite + ECharts.

## Run

```bash
npm ci
npm run dev        # http://localhost:5173, proxies /api → http://localhost:3000 (apps/api)
npm run build      # static bundle in dist/, served by Nginx (relative /api, no env vars)
npm run preview    # serves dist/ locally
```

Sign in with a seeded demo account (`admin@`, `analyst@` or `viewer@ops-pulse.test`); the shared
demo password is in the root README / contract (test-only).

## Pages

| Route        | What                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| `/login`     | e-mail/password form, inline validation, rate-limit and credential errors             |
| `/`          | six KPI tiles; daily incident volume per service with z-score anomaly pins; MTTR & SLA breach by priority (dual axis); weekday × hour heatmap; change failure rate per service; skeleton, empty ("lancez le flow Dataiku") and retry states |
| `/incidents` | server-side filtered, sorted and paginated table; detail panel; analysts/admins create (POST) and update state/priority (PATCH), viewers read only |
| `/changes`   | filtered, paginated table and a stacked bar of close codes per service                |

## Design notes

- **State**: React Context + `useReducer` — `AuthContext` (token in memory + `sessionStorage`,
  API client, 401 → logout) and `FiltersContext` (7/30/90-day period, service, priority shared
  across pages). If the shared state grows (caching, optimistic updates, devtools), **Redux
  Toolkit** (or RTK Query) slots in at the same seam: `AppProviders` and the `useAuth` /
  `useFilters` hooks stay the public interface.
- **API layer** (`src/api`): zod schemas mirror the contract and validate every response; the
  fetch client adds the bearer token, a timeout, `AbortSignal` support and maps the contract error
  shape to a typed `ApiError`.
- **Charts**: a small typed `<EChart>` wrapper over tree-shaken `echarts/core` (init, update,
  resize, dispose, dark mode), each with an `aria-label` and a visually hidden data table.
  Pages are lazy-loaded, so the login screen ships without ECharts.
- **Accessibility**: semantic landmarks, skip link, labelled fields with linked errors, focus moved
  on navigation, `aria-sort` on sortable columns, light/dark via `prefers-color-scheme`.

Agent and contributor rules: [`AGENTS.md`](AGENTS.md).
