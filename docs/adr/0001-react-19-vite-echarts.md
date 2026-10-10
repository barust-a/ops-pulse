# ADR-0001: React 19, TypeScript and Vite for the SPA, ECharts for visualisations

**Date**: 2026-10-10
**Status**: accepted
**Deciders**: Alexandre Barusta (lead developer), operations product owner, architecture review

## Context

SupervIT v1 runs on AngularJS 1.5 (end of life since 2021) with jQuery and Highcharts 4, whose
licence has expired. Each new chart costs days because charts are hard-coded per page. The mission
asks for "nouvelles visualisations" (trends, heatmaps, anomaly markers) and a maintainable,
testable front end that the client's teams can staff. The UI is French; dashboards must stay
accessible (text alternatives for charts).

## Decision

Rebuild the front end as a React 19 single-page application in TypeScript (strict), built with
Vite, tested with Vitest and Testing Library, and draw every chart with Apache ECharts through
pure option-builder functions and one thin chart component.

## Alternatives Considered

### Alternative 1: Angular 18 (migrate within the Angular family)
- **Pros**: batteries included (router, forms, DI); familiar name for the client.
- **Cons**: no code reuse from AngularJS anyway (different framework); heavier learning curve
  for a small team; smaller pool of freelance profiles on the client's market.
- **Why not**: the "migration" would still be a rewrite, without React's ecosystem advantage.

### Alternative 2: Keep Highcharts, renew the licence
- **Pros**: the team knows it; rich chart catalogue.
- **Cons**: commercial licence per developer/site; still imperative per-page code.
- **Why not**: ECharts (Apache-2.0) covers heatmaps, mark points and large series with canvas
  rendering, at no licence cost.

### Alternative 3: Next.js (server rendering)
- **Pros**: SSR, file routing.
- **Cons**: needs a Node server for the front end; SEO and first paint are not requirements for
  an authenticated internal dashboard.
- **Why not**: a static bundle behind Nginx is simpler to secure and to run on RHEL.

## Consequences

### Positive
- Static files only: served by Nginx with immutable caching, no front-end server to operate.
- Charts are unit-tested as data (option objects), not screenshots.
- Strict TypeScript + zod parsing of API responses catch contract drift at the boundary.

### Negative
- ECharts adds ~350 kB gzipped unless tree-shaken (import only the charts and components used).
- The team must learn React hooks rules (enforced by `eslint-plugin-react-hooks`).

### Risks
- React 19 APIs changed (e.g. `ref` as a prop, actions): documentation must match the installed
  version (`AGENTS.md` §7).
