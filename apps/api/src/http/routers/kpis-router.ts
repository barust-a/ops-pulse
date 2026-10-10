import { Router } from 'express';

import { summarizeDailyKpis } from '../../domain/kpi.js';
import type { Clock } from '../../ports/clock.js';
import type { KpiRepository } from '../../ports/repositories.js';
import { KpiQuerySchema, KpiRangeQuerySchema, requestedRange } from '../schemas.js';
import { validQuery } from '../validate.js';

/** Mounted behind authenticate(): every route needs at least the viewer role. */
export function kpisRouter({ kpis, clock }: { kpis: KpiRepository; clock: Clock }): Router {
  const router = Router();

  // Summary and daily read the Dataiku output; an empty range answers zeros, not an error.
  router.get('/summary', async (req, res) => {
    const { service, ...query } = validQuery(KpiQuerySchema, req);
    const range = requestedRange(query, clock());
    const [rows, openIncidents, p90ResolutionMinutes] = await Promise.all([
      kpis.listDaily(range, service),
      kpis.countOpenIncidents(service),
      kpis.p90ResolutionMinutes(range, service),
    ]);
    res.json(summarizeDailyKpis(rows, { openIncidents, p90ResolutionMinutes }));
  });

  router.get('/daily', async (req, res) => {
    const { service, ...range } = validQuery(KpiQuerySchema, req);
    res.json({ items: await kpis.listDaily(requestedRange(range, clock()), service) });
  });

  router.get('/by-priority', async (req, res) => {
    const now = clock();
    const range = requestedRange(validQuery(KpiRangeQuerySchema, req), now);
    res.json({ items: await kpis.byPriority(range, now) });
  });

  router.get('/heatmap', async (req, res) => {
    const range = requestedRange(validQuery(KpiRangeQuerySchema, req), clock());
    res.json({ items: await kpis.heatmap(range) });
  });

  router.get('/change-outcomes', async (req, res) => {
    const range = requestedRange(validQuery(KpiRangeQuerySchema, req), clock());
    res.json({ items: await kpis.changeOutcomes(range) });
  });

  return router;
}
