import type pg from 'pg';
import type { Logger } from 'pino';

import type { DatabaseHealth } from '../../ports/repositories.js';

export class PgDatabaseHealth implements DatabaseHealth {
  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
  ) {}

  async isUp(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch (error) {
      // Translated into db: 'down' for the health probe; logged here, where it is handled.
      this.logger.warn({ err: error }, 'database health check failed');
      return false;
    }
  }
}
