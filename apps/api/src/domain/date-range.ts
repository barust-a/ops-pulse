const DAY_MS = 86_400_000;
const DEFAULT_SPAN_DAYS = 30;

/** An inclusive range of calendar days, as `YYYY-MM-DD` (UTC). */
export interface DateRange {
  from: string;
  to: string;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDays(isoDate: string, days: number): string {
  return toIsoDate(new Date(Date.parse(`${isoDate}T00:00:00.000Z`) + days * DAY_MS));
}

/** Fills the missing bounds: the last 30 days by default, today included. */
export function resolveDateRange(query: { from?: string; to?: string }, now: Date): DateRange {
  const to = query.to ?? toIsoDate(now);
  const from = query.from ?? shiftDays(to, 1 - DEFAULT_SPAN_DAYS);
  return { from, to };
}
