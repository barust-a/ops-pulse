const LOCALE = 'fr-FR';

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });
const dateTime = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'short' });
const shortDay = new Intl.DateTimeFormat(LOCALE, {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});

export function formatInteger(value: number): string {
  return integer.format(value);
}

export function formatDecimal(value: number): string {
  return decimal.format(value);
}

/** A 0–1 ratio as a French percentage: 0.125 → "12,5 %". */
export function formatPercent(ratio: number): string {
  return percent.format(ratio);
}

/** A duration in minutes, the way an on-call engineer reads it: 205 → "3 h 25 min". */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '—';
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${integer.format(rounded)} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0
    ? `${integer.format(hours)} h`
    : `${integer.format(hours)} h ${String(rest).padStart(2, '0')} min`;
}

export function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  return dateTime.format(new Date(iso));
}

/** A `YYYY-MM-DD` day as "09 oct.", read in UTC so the day never shifts. */
export function formatDay(day: string): string {
  return shortDay.format(new Date(`${day}T00:00:00Z`));
}
