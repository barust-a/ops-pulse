// In-memory doubles of the ports, for HTTP tests against createApp. Deliberately simple: the SQL
// semantics are covered by the *.int.test.ts suites against PostgreSQL.
import type { ChangeRecord } from '../domain/change.js';
import type { DateRange } from '../domain/date-range.js';
import type { IncidentRecord } from '../domain/incident.js';
import { isResolvedState } from '../domain/incident.js';
import type { ChangeOutcome, DailyKpi, HeatmapCell, PriorityKpi } from '../domain/kpi.js';
import type { Service } from '../domain/service.js';
import type {
  ChangeQuery,
  ChangeRepository,
  CreateIncidentResult,
  DatabaseHealth,
  IncidentQuery,
  IncidentRepository,
  KpiRepository,
  NewIncident,
  PageSlice,
  UserCredentials,
  UserRepository,
} from '../ports/repositories.js';

function dayStart(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`);
}

function inRange(date: Date, range: DateRange): boolean {
  const time = date.getTime();
  return time >= dayStart(range.from) && time < dayStart(range.to) + 86_400_000;
}

function slice<T>(items: T[], query: { page: number; pageSize: number }): PageSlice<T> {
  const start = (query.page - 1) * query.pageSize;
  return { items: items.slice(start, start + query.pageSize), total: items.length };
}

export class InMemoryUsers implements UserRepository {
  constructor(private readonly credentials: UserCredentials[]) {}

  findByEmail(email: string): Promise<UserCredentials | null> {
    const wanted = email.toLowerCase();
    const found = this.credentials.find(({ user }) => user.email.toLowerCase() === wanted);
    return Promise.resolve(found ?? null);
  }

  findById(id: number) {
    return Promise.resolve(this.credentials.find(({ user }) => user.id === id)?.user ?? null);
  }
}

export class InMemoryIncidents implements IncidentRepository {
  private nextNumber = 20_001;

  constructor(
    readonly records: IncidentRecord[],
    private readonly groups: readonly string[],
  ) {}

  list(query: IncidentQuery): Promise<PageSlice<IncidentRecord>> {
    const matching = this.records
      .filter((record) => inRange(record.openedAt, query.range))
      .filter((record) => query.service === undefined || record.service === query.service)
      .filter((record) => query.priority === undefined || record.priority === query.priority)
      .filter((record) => query.state === undefined || record.state === query.state)
      .filter((record) => query.q === undefined || record.shortDescription.includes(query.q))
      .toSorted((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
    return Promise.resolve(slice(matching, query));
  }

  findByNumber(number: string): Promise<IncidentRecord | null> {
    return Promise.resolve(this.records.find((record) => record.number === number) ?? null);
  }

  create(incident: NewIncident): Promise<CreateIncidentResult> {
    if (!this.groups.includes(incident.assignmentGroup)) {
      return Promise.resolve({ status: 'unknown_assignment_group' });
    }
    const record: IncidentRecord = {
      ...incident,
      number: `INC${String(this.nextNumber).padStart(7, '0')}`,
      state: 'new',
      resolvedAt: null,
      causedByChange: null,
    };
    this.nextNumber += 1;
    this.records.push(record);
    return Promise.resolve({ status: 'created', incident: record });
  }

  update(number: string, plan: Parameters<IncidentRepository['update']>[1]) {
    const index = this.records.findIndex((record) => record.number === number);
    const current = this.records[index];
    if (current === undefined) return Promise.resolve(null);
    const updated = { ...current, ...plan };
    this.records[index] = updated;
    return Promise.resolve(updated);
  }
}

export class InMemoryChanges implements ChangeRepository {
  constructor(readonly records: ChangeRecord[]) {}

  list(query: ChangeQuery): Promise<PageSlice<ChangeRecord>> {
    const matching = this.records
      .filter((record) => inRange(record.plannedStart, query.range))
      .filter((record) => query.service === undefined || record.service === query.service)
      .filter((record) => query.state === undefined || record.state === query.state)
      .filter((record) => query.type === undefined || record.type === query.type);
    return Promise.resolve(slice(matching, query));
  }
}

export class InMemoryKpis implements KpiRepository {
  constructor(
    private readonly daily: DailyKpi[],
    private readonly incidents: InMemoryIncidents,
    private readonly changes: InMemoryChanges,
  ) {}

  listDaily(range: DateRange, service?: Service): Promise<DailyKpi[]> {
    return Promise.resolve(
      this.daily.filter(
        (row) =>
          inRange(new Date(dayStart(row.day)), range) &&
          (service === undefined || row.service === service),
      ),
    );
  }

  countOpenIncidents(service?: Service): Promise<number> {
    const open = this.incidents.records.filter(
      (record) =>
        !isResolvedState(record.state) && (service === undefined || record.service === service),
    );
    return Promise.resolve(open.length);
  }

  /** Nearest-rank p90 over the resolved incidents of the range. */
  p90ResolutionMinutes(range: DateRange): Promise<number | null> {
    const minutes = this.incidents.records
      .filter((record) => record.resolvedAt !== null && inRange(record.resolvedAt, range))
      .map((record) => ((record.resolvedAt?.getTime() ?? 0) - record.openedAt.getTime()) / 60_000)
      .toSorted((a, b) => a - b);
    return Promise.resolve(minutes[Math.ceil(minutes.length * 0.9) - 1] ?? null);
  }

  byPriority(range: DateRange): Promise<PriorityKpi[]> {
    const items = ([1, 2, 3, 4] as const).map((priority) => ({
      priority,
      count: this.incidents.records.filter(
        (record) => record.priority === priority && inRange(record.openedAt, range),
      ).length,
      mttrMinutes: null,
      slaBreachRate: 0,
    }));
    return Promise.resolve(items);
  }

  changeOutcomes(range: DateRange): Promise<ChangeOutcome[]> {
    const counts = new Map<string, ChangeOutcome>();
    for (const change of this.changes.records) {
      if (change.closeCode === null || change.closedAt === null || !inRange(change.closedAt, range)) continue;
      const key = `${change.service}|${change.closeCode}`;
      const current = counts.get(key) ?? { service: change.service, closeCode: change.closeCode, count: 0 };
      counts.set(key, { ...current, count: current.count + 1 });
    }
    return Promise.resolve(
      [...counts.entries()].toSorted(([a], [b]) => a.localeCompare(b)).map(([, outcome]) => outcome),
    );
  }

  heatmap(): Promise<HeatmapCell[]> {
    const cells: HeatmapCell[] = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      for (let hour = 0; hour < 24; hour++) cells.push({ weekday, hour, count: 0 });
    }
    return Promise.resolve(cells);
  }
}

export class SwitchableDatabase implements DatabaseHealth {
  up = true;

  isUp(): Promise<boolean> {
    return Promise.resolve(this.up);
  }
}
