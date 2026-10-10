import { Router } from 'express';

import { toChange } from '../../domain/change.js';
import type { Clock } from '../../ports/clock.js';
import type { ChangeRepository } from '../../ports/repositories.js';
import { ChangeListQuerySchema, requestedRange } from '../schemas.js';
import { validQuery } from '../validate.js';

/** Mounted behind authenticate(): every route needs at least the viewer role. */
export function changesRouter(deps: { changes: ChangeRepository; clock: Clock }): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    const { from, to, ...query } = validQuery(ChangeListQuerySchema, req);
    const page = await deps.changes.list({
      ...query,
      range: requestedRange({ from, to }, deps.clock()),
    });
    res.json({
      items: page.items.map((record) => toChange(record)),
      page: query.page,
      pageSize: query.pageSize,
      total: page.total,
    });
  });
  return router;
}
