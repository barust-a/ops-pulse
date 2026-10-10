import bcrypt from 'bcrypt';
import type { Express } from 'express';
import { pino } from 'pino';

import { createJwtTokenService } from '../adapters/security/jwt-token-service.js';
import { bcryptPasswords } from '../adapters/security/bcrypt-passwords.js';
import type { AppDependencies } from '../app.js';
import { createApp } from '../app.js';
import type { SamlConfig } from '../config.js';
import type { ChangeRecord } from '../domain/change.js';
import type { IncidentRecord } from '../domain/incident.js';
import type { DailyKpi } from '../domain/kpi.js';
import type { Role } from '../domain/roles.js';
import type { TokenService } from '../ports/security.js';
import {
  InMemoryChanges,
  InMemoryIncidents,
  InMemoryKpis,
  InMemoryUsers,
  SwitchableDatabase,
} from './fakes.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
export const TEST_PASSWORD = 'test-only-password';
export const ALLOWED_ORIGIN = 'http://localhost:5173';
const GROUPS = ['Service Desk', 'Payments Ops'] as const;

// Cost 4 keeps the suite fast; verification reads the cost from the hash itself.
const PASSWORD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);

const USERS = [
  { id: 1, email: 'admin@ops-pulse.test', role: 'admin' },
  { id: 2, email: 'analyst@ops-pulse.test', role: 'analyst' },
  { id: 3, email: 'viewer@ops-pulse.test', role: 'viewer' },
] as const;

export function incidentRecord(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    number: 'INC0010001',
    shortDescription: 'Checkout latency above 2 s',
    priority: 2,
    state: 'in_progress',
    category: 'software',
    service: 'payments',
    assignmentGroup: 'Payments Ops',
    openedAt: new Date('2026-10-09T08:00:00.000Z'),
    resolvedAt: null,
    slaDueAt: new Date('2026-10-09T16:00:00.000Z'),
    causedByChange: null,
    ...overrides,
  };
}

export function changeRecord(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  return {
    number: 'CHG0030001',
    shortDescription: 'Rotate TLS certificates on the payment gateway',
    type: 'normal',
    risk: 'moderate',
    state: 'closed',
    closeCode: 'successful',
    service: 'payments',
    plannedStart: new Date('2026-10-08T20:00:00.000Z'),
    plannedEnd: new Date('2026-10-08T22:00:00.000Z'),
    closedAt: new Date('2026-10-08T22:10:00.000Z'),
    ...overrides,
  };
}

export interface TestAppOptions {
  incidents?: IncidentRecord[];
  changes?: ChangeRecord[];
  daily?: DailyKpi[];
  saml?: SamlConfig;
  overrides?: Partial<AppDependencies>;
}

export interface TestApp {
  app: Express;
  deps: AppDependencies;
  database: SwitchableDatabase;
  incidents: InMemoryIncidents;
  tokens: TokenService;
  bearer: (role: Role) => string;
}

function clock(): Date {
  return NOW;
}

export function buildTestApp(options: TestAppOptions = {}): TestApp {
  const tokens = createJwtTokenService({
    secret: 'test-only-secret-with-at-least-32-characters',
    ttlSeconds: 3600,
    clock,
  });
  const incidents = new InMemoryIncidents(options.incidents ?? [incidentRecord()], GROUPS);
  const database = new SwitchableDatabase();
  const changes = new InMemoryChanges(options.changes ?? [changeRecord()]);
  const deps: AppDependencies = {
    settings: {
      corsOrigins: [ALLOWED_ORIGIN],
      saml: options.saml ?? { enabled: false },
      version: '0.0.0-test',
    },
    logger: pino({ level: 'silent' }),
    clock,
    users: new InMemoryUsers(USERS.map((user) => ({ user, passwordHash: PASSWORD_HASH }))),
    incidents,
    changes,
    kpis: new InMemoryKpis(options.daily ?? [], incidents, changes),
    database,
    passwords: bcryptPasswords,
    tokens,
    ...options.overrides,
  };
  function bearer(role: Role): string {
    const user = USERS.find((candidate) => candidate.role === role);
    if (user === undefined) throw new Error(`no test user with role ${role}`);
    return `Bearer ${tokens.issue({ userId: user.id, role })}`;
  }
  return { app: createApp(deps), deps, database, incidents, tokens, bearer };
}
