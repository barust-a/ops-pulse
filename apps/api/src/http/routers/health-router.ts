import { Router } from 'express';

import type { DatabaseHealth } from '../../ports/repositories.js';

export function healthRouter(deps: { database: DatabaseHealth; version: string }): Router {
  const router = Router();
  // Liveness answers 200 even with the database down: the body says which dependency failed,
  // and restarting the API would not bring PostgreSQL back.
  router.get('/health', async (_req, res) => {
    const up = await deps.database.isUp();
    res.json({ status: 'ok', db: up ? 'up' : 'down', version: deps.version });
  });
  return router;
}
