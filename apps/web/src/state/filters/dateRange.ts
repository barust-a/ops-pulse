import type { DateRange } from '../../api/endpoints';

export const RANGE_PRESETS = [7, 30, 90] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const MS_PER_DAY = 86_400_000;

function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The last `days` days, today included, as the `YYYY-MM-DD` bounds the API expects (UTC). */
export function rangeEndingOn(today: Date, days: RangePreset): DateRange {
  const from = new Date(today.getTime() - (days - 1) * MS_PER_DAY);
  return { from: toIsoDay(from), to: toIsoDay(today) };
}
