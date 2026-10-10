import {
  ChangeSchema,
  DailyKpiSchema,
  IncidentSchema,
  KpiSummarySchema,
  type Change,
  type ChangeOutcome,
  type DailyKpi,
  type HeatmapCell,
  type Incident,
  type KpiSummary,
  type PriorityKpi,
  type User,
} from '../api/schemas';

// Fixtures go through the production schemas, so a fixture can never drift from the contract.

export const TODAY = new Date('2026-10-10T09:00:00Z');
const YESTERDAY = '2026-10-09';
const TWO_DAYS_AGO = '2026-10-08';

export const analystUser: User = { id: 2, email: 'analyst@ops-pulse.test', role: 'analyst' };
export const viewerUser: User = { id: 3, email: 'viewer@ops-pulse.test', role: 'viewer' };

export const kpiSummary: KpiSummary = KpiSummarySchema.parse({
  openIncidents: 42,
  mttrMinutes: 205,
  p90ResolutionMinutes: 610,
  slaBreachRate: 0.125,
  changeFailureRate: 0.08,
  anomalies: 3,
});

export function dailyKpi(overrides: Partial<DailyKpi> = {}): DailyKpi {
  return DailyKpiSchema.parse({
    day: YESTERDAY,
    service: 'payments',
    incidentCount: 12,
    resolvedCount: 10,
    mttrMinutes: 180,
    p90ResolutionMinutes: 420,
    slaBreachRate: 0.1,
    changeCount: 4,
    changeFailureRate: 0.25,
    incidentZscore: 0.4,
    isAnomaly: false,
    ...overrides,
  });
}

export const dailyKpis: DailyKpi[] = [
  dailyKpi({ day: TWO_DAYS_AGO, service: 'payments', incidentCount: 9 }),
  dailyKpi({
    day: YESTERDAY,
    service: 'payments',
    incidentCount: 31,
    incidentZscore: 3.4,
    isAnomaly: true,
  }),
  dailyKpi({
    day: TWO_DAYS_AGO,
    service: 'crm',
    incidentCount: 4,
    changeCount: 0,
    changeFailureRate: 0,
  }),
  dailyKpi({
    day: YESTERDAY,
    service: 'crm',
    incidentCount: 5,
    changeCount: 2,
    changeFailureRate: 0.5,
  }),
];

export const priorityKpis: PriorityKpi[] = [
  { priority: 1, count: 6, mttrMinutes: 95, slaBreachRate: 0.33 },
  { priority: 2, count: 18, mttrMinutes: 160, slaBreachRate: 0.17 },
  { priority: 3, count: 60, mttrMinutes: 300, slaBreachRate: 0.1 },
  { priority: 4, count: 40, mttrMinutes: null, slaBreachRate: 0.05 },
];

export const heatmap: HeatmapCell[] = [
  { weekday: 0, hour: 9, count: 14 },
  { weekday: 4, hour: 17, count: 9 },
];

export function incident(overrides: Partial<Incident> = {}): Incident {
  return IncidentSchema.parse({
    number: 'INC0010001',
    shortDescription: 'Paiements refusés sur le TPE virtuel',
    priority: 2,
    state: 'in_progress',
    category: 'software',
    service: 'payments',
    assignmentGroup: 'Payments L2',
    openedAt: '2026-10-09T08:15:00Z',
    resolvedAt: null,
    slaDueAt: '2026-10-09T16:15:00Z',
    slaBreached: true,
    causedByChange: 'CHG0030007',
    ...overrides,
  });
}

export function change(overrides: Partial<Change> = {}): Change {
  return ChangeSchema.parse({
    number: 'CHG0030007',
    shortDescription: 'Montée de version du load balancer',
    type: 'normal',
    risk: 'moderate',
    state: 'closed',
    closeCode: 'unsuccessful',
    service: 'network',
    plannedStart: '2026-10-08T20:00:00Z',
    plannedEnd: '2026-10-08T22:00:00Z',
    closedAt: '2026-10-08T22:30:00Z',
    ...overrides,
  });
}

export const changeOutcomes: ChangeOutcome[] = [
  { service: 'crm', closeCode: 'successful', count: 4 },
  { service: 'crm', closeCode: 'backed_out', count: 1 },
  { service: 'network', closeCode: 'successful', count: 7 },
  { service: 'network', closeCode: 'unsuccessful', count: 3 },
];
