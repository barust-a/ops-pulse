import type { ChangeRecord } from '../domain/change.js';
import type { DateRange } from '../domain/date-range.js';
import type { IncidentRecord, IncidentState, Priority } from '../domain/incident.js';
import type { IncidentUpdatePlan } from '../domain/incident-update.js';
import type { ChangeOutcome, DailyKpi, HeatmapCell, PriorityKpi } from '../domain/kpi.js';
import type { Service } from '../domain/service.js';
import type { User } from '../domain/user.js';

interface PageRequest {
  page: number;
  pageSize: number;
}

export interface PageSlice<T> {
  items: T[];
  total: number;
}

export const INCIDENT_SORTS = [
  'openedAt',
  '-openedAt',
  'priority',
  '-priority',
  'slaDueAt',
  '-slaDueAt',
  'number',
  '-number',
] as const;
export type IncidentSort = (typeof INCIDENT_SORTS)[number];

export interface IncidentQuery extends PageRequest {
  range: DateRange;
  service?: Service;
  priority?: Priority;
  state?: IncidentState;
  /** Free text matched against the number and the short description. */
  q?: string;
  sort: IncidentSort;
}

export interface NewIncident {
  shortDescription: string;
  priority: Priority;
  category: string;
  service: Service;
  assignmentGroup: string;
  openedAt: Date;
  slaDueAt: Date;
}

export type CreateIncidentResult =
  | { status: 'created'; incident: IncidentRecord }
  | { status: 'unknown_assignment_group' };

export interface IncidentRepository {
  list(query: IncidentQuery): Promise<PageSlice<IncidentRecord>>;
  findByNumber(number: string): Promise<IncidentRecord | null>;
  create(incident: NewIncident): Promise<CreateIncidentResult>;
  /** Writes the plan; null when the incident no longer exists. */
  update(number: string, plan: IncidentUpdatePlan): Promise<IncidentRecord | null>;
}

export interface ChangeQuery extends PageRequest {
  range: DateRange;
  service?: Service;
  state?: ChangeRecord['state'];
  type?: ChangeRecord['type'];
}

export interface ChangeRepository {
  list(query: ChangeQuery): Promise<PageSlice<ChangeRecord>>;
}

export interface KpiRepository {
  /** Rows of ops.daily_service_kpis in the range, ordered by day then service. */
  listDaily(range: DateRange, service?: Service): Promise<DailyKpi[]>;
  countOpenIncidents(service?: Service): Promise<number>;
  /** p90 resolution time (minutes) of incidents resolved in the range; null when none was. */
  p90ResolutionMinutes(range: DateRange, service?: Service): Promise<number | null>;
  /** One item per priority 1–4, incidents opened in the range; `now` closes open incidents. */
  byPriority(range: DateRange, now: Date): Promise<PriorityKpi[]>;
  /** The full 7 × 24 grid (Mon = 0, UTC hours) of incidents opened in the range. */
  heatmap(range: DateRange): Promise<HeatmapCell[]>;
  /** Changes closed in the range, counted per service and close code (ordered by both). */
  changeOutcomes(range: DateRange): Promise<ChangeOutcome[]>;
}

export interface UserCredentials {
  user: User;
  passwordHash: string;
}

export interface UserRepository {
  /** Case-insensitive lookup. */
  findByEmail(email: string): Promise<UserCredentials | null>;
  findById(id: number): Promise<User | null>;
}

export interface DatabaseHealth {
  isUp(): Promise<boolean>;
}
