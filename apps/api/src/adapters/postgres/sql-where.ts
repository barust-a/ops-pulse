import type { DateRange } from '../../domain/date-range.js';

/**
 * Builds a WHERE clause from optional filters with numbered placeholders: values always travel
 * as parameters, never inside the SQL text.
 */
export class SqlWhere {
  readonly values: unknown[] = [];
  private readonly conditions: string[] = [];

  /** `condition` receives the placeholder (`$3`) of `value`. */
  add(condition: (placeholder: string) => string, value: unknown): this {
    this.values.push(value);
    this.conditions.push(condition(`$${String(this.values.length)}`));
    return this;
  }

  /** Adds the condition only when the filter was given. */
  addIfDefined(condition: (placeholder: string) => string, value: unknown): this {
    return value === undefined ? this : this.add(condition, value);
  }

  /** Whole UTC days: from the start of `from` to the end of `to`. */
  addDayRange(column: string, range: DateRange): this {
    return this.add((from) => `${column} >= ${from}::date`, range.from).add(
      (to) => `${column} < ${to}::date + 1`,
      range.to,
    );
  }

  /** The next free placeholder, for LIMIT/OFFSET after the filters. */
  param(value: unknown): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }

  toSql(): string {
    return this.conditions.length === 0 ? '' : `where ${this.conditions.join(' and ')}`;
  }
}

/** Escapes LIKE wildcards so user text matches literally. */
export function containsPattern(text: string): string {
  const escaped = text.replaceAll(/[\\%_]/g, String.raw`\$&`);
  return `%${escaped}%`;
}
