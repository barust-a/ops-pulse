import type { ApiClient } from './client';
import {
  ChangeOutcomeListSchema,
  ChangePageSchema,
  DailyKpiListSchema,
  HeatmapSchema,
  IncidentPageSchema,
  IncidentSchema,
  KpiSummarySchema,
  LoginResponseSchema,
  PriorityKpiListSchema,
  type ChangeOutcome,
  type ChangePage,
  type ChangeState,
  type ChangeType,
  type CreateIncidentBody,
  type DailyKpi,
  type HeatmapCell,
  type Incident,
  type IncidentPage,
  type IncidentState,
  type KpiSummary,
  type LoginBody,
  type LoginResponse,
  type Priority,
  type PriorityKpi,
  type UpdateIncidentBody,
} from './schemas';

/** `YYYY-MM-DD` bounds every KPI and list endpoint accepts. */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export interface KpiQuery extends DateRange {
  readonly service?: string | null;
}

export type IncidentSortField = 'openedAt' | 'priority' | 'number';
export type IncidentSort = IncidentSortField | `-${IncidentSortField}`;

export interface IncidentQuery extends DateRange {
  readonly service?: string | null;
  readonly priority?: Priority | null;
  readonly state?: IncidentState | null;
  readonly q?: string;
  readonly page: number;
  readonly pageSize: number;
  readonly sort: IncidentSort;
}

export interface ChangeQuery extends DateRange {
  readonly service?: string | null;
  readonly state?: ChangeState | null;
  readonly type?: ChangeType | null;
  readonly page: number;
  readonly pageSize: number;
}

export function login(client: ApiClient, body: LoginBody): Promise<LoginResponse> {
  return client.request({ method: 'POST', path: '/auth/login', body, schema: LoginResponseSchema });
}

export function fetchIncidents(
  client: ApiClient,
  query: IncidentQuery,
  signal?: AbortSignal,
): Promise<IncidentPage> {
  return client.request({
    path: '/incidents',
    query: { ...query },
    schema: IncidentPageSchema,
    signal,
  });
}

export function createIncident(client: ApiClient, body: CreateIncidentBody): Promise<Incident> {
  return client.request({ method: 'POST', path: '/incidents', body, schema: IncidentSchema });
}

export function updateIncident(
  client: ApiClient,
  number: string,
  body: UpdateIncidentBody,
): Promise<Incident> {
  return client.request({
    method: 'PATCH',
    path: `/incidents/${encodeURIComponent(number)}`,
    body,
    schema: IncidentSchema,
  });
}

export function fetchChanges(
  client: ApiClient,
  query: ChangeQuery,
  signal?: AbortSignal,
): Promise<ChangePage> {
  return client.request({
    path: '/changes',
    query: { ...query },
    schema: ChangePageSchema,
    signal,
  });
}

export function fetchKpiSummary(
  client: ApiClient,
  query: KpiQuery,
  signal?: AbortSignal,
): Promise<KpiSummary> {
  return client.request({
    path: '/kpis/summary',
    query: { ...query },
    schema: KpiSummarySchema,
    signal,
  });
}

export async function fetchDailyKpis(
  client: ApiClient,
  query: KpiQuery,
  signal?: AbortSignal,
): Promise<DailyKpi[]> {
  const list = await client.request({
    path: '/kpis/daily',
    query: { ...query },
    schema: DailyKpiListSchema,
    signal,
  });
  return list.items;
}

export async function fetchPriorityKpis(
  client: ApiClient,
  range: DateRange,
  signal?: AbortSignal,
): Promise<PriorityKpi[]> {
  const list = await client.request({
    path: '/kpis/by-priority',
    query: { from: range.from, to: range.to },
    schema: PriorityKpiListSchema,
    signal,
  });
  return list.items;
}

export async function fetchHeatmap(
  client: ApiClient,
  range: DateRange,
  signal?: AbortSignal,
): Promise<HeatmapCell[]> {
  const list = await client.request({
    path: '/kpis/heatmap',
    query: { from: range.from, to: range.to },
    schema: HeatmapSchema,
    signal,
  });
  return list.items;
}

/** Changes closed in the range, counted per service and close code. */
export async function fetchChangeOutcomes(
  client: ApiClient,
  range: DateRange,
  signal?: AbortSignal,
): Promise<ChangeOutcome[]> {
  const list = await client.request({
    path: '/kpis/change-outcomes',
    query: { from: range.from, to: range.to },
    schema: ChangeOutcomeListSchema,
    signal,
  });
  return list.items;
}
