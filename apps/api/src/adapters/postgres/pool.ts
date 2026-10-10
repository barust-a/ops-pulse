import pg from 'pg';

/**
 * One pool per process. Every query has a deadline (statement_timeout server-side, query_timeout
 * client-side) and every session runs in UTC, so date bounds and hour buckets mean the same thing
 * whatever the server's time zone.
 */
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    query_timeout: 15_000,
    application_name: 'ops-pulse-api',
    options: '-c TimeZone=UTC -c statement_timeout=10000',
  });
}
