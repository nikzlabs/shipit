/**
 * Extract a human-readable message from an unknown error value.
 * Use this instead of inline `err instanceof Error ? err.message : String(err)`.
 */
export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a timestamp that may be EITHER an ISO-8601 string with an explicit
 * timezone (e.g. `toISOString()` → `"2026-06-02T14:30:00.000Z"`, used by
 * `last_used_at`) OR a SQLite `datetime('now')` string
 * (`"2026-06-02 14:30:00"`, used by `merged_at`) — which is UTC but carries NO
 * timezone designator and uses a space instead of `T`.
 *
 * `Date.parse` reads the suffix-less SQLite form as *local* time, while the ISO
 * form is read as UTC. On any non-UTC runtime — most importantly the browser,
 * where the sidebar's `reopenedAfterResolve` sort runs — that lands two values
 * that are both UTC on different absolute instants, so comparing them is wrong
 * (in a UTC+ zone a `merged_at` ends up *earlier* than a `last_used_at` from
 * just before the merge, falsely flagging the session as reopened). CI runs in
 * UTC, which is why the suite never caught this.
 *
 * Normalize the SQLite form to UTC before parsing so both inputs map to the
 * same wall clock regardless of the host timezone. Returns NaN on unparseable
 * input — callers guard with `Number.isNaN`.
 */
export function parseTimestampMs(value: string): number {
  // Already carries an explicit timezone (`…Z` or `…±HH:MM`)? Parse as-is.
  if (/[zZ]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    return Date.parse(value);
  }
  // SQLite `datetime('now')` shape: "YYYY-MM-DD[ T]HH:MM:SS[.fff]" with no tz.
  // It's UTC — convert the separator to `T` and append `Z` so it parses as UTC.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
  if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
  // Anything else (date-only, unexpected shapes) — defer to the engine, which
  // already treats a bare date as UTC.
  return Date.parse(value);
}
