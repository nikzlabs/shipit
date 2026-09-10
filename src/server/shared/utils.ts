export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// SQLite datetime('now') is UTC without a suffix; Date.parse would use local time.
export function parseTimestampMs(value: string): number {
  if (/[zZ]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    return Date.parse(value);
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value);
  if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
  return Date.parse(value);
}
