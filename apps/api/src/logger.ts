import type { Logger } from 'pino';
import { pino } from 'pino';

import type { Config } from './config.js';

/** Paths pino replaces with "[Redacted]" wherever they appear in a log line. */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
];

/** Structured JSON logs on stdout, for the container runtime or journald to collect. */
export function createLogger(level: Config['logLevel']): Logger {
  return pino({ level, redact: { paths: REDACTED_PATHS }, base: { service: 'ops-pulse-api' } });
}
