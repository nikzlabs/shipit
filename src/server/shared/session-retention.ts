import type { SessionInfo } from "./types.js";
import { resolvedAt } from "./session-resolution.js";
import { parseTimestampMs } from "./utils.js";

export interface DataRetentionConfig {
  /** 0 keeps the files of every session with no time limit. */
  days: number;
  /** 0 gives a large session the normal period. */
  largeDays: number;
  largeBytes: number;
}

export const DEFAULT_DATA_RETENTION: DataRetentionConfig = {
  days: 60,
  largeDays: 14,
  largeBytes: 100 * 1024 * 1024,
};

const DAY_MS = 86_400_000;

function ms(value: string | undefined): number {
  if (!value) return NaN;
  return parseTimestampMs(value);
}

// docs/323-archived-session-data-retention req 4, req 12. Without the floor,
// this is also the time a stored size must not be older than.
function retentionBaseMs(session: SessionInfo, isDone: boolean): number | undefined {
  if (session.userArchived) {
    const archived = ms(session.archivedAt);
    return Number.isNaN(archived) ? undefined : archived;
  }
  if (!isDone) return undefined;
  const times = [ms(resolvedAt(session)), ms(session.lastUsedAt), ms(session.lastViewedAt)]
    .filter((t) => !Number.isNaN(t));
  return times.length > 0 ? Math.max(...times) : undefined;
}

export function isUnderDataRetention(session: SessionInfo, isDone: boolean): boolean {
  return retentionBaseMs(session, isDone) !== undefined;
}

export function retainedDataSizeIsStale(session: SessionInfo, isDone: boolean): boolean {
  const base = retentionBaseMs(session, isDone);
  if (base === undefined) return false;
  if (session.retainedDataBytes === undefined) return true;
  const measured = ms(session.retainedDataMeasuredAt);
  return Number.isNaN(measured) || measured < base;
}

export function retentionPeriodDays(bytes: number, config: DataRetentionConfig): number {
  if (config.days <= 0) return 0;
  if (config.largeDays > 0 && bytes >= config.largeBytes) return config.largeDays;
  return config.days;
}

/** The time ShipIt deletes the session's kept files, or undefined when it never does. */
export function dataDeletionTimeMs(
  session: SessionInfo,
  isDone: boolean,
  config: DataRetentionConfig,
): number | undefined {
  const base = retentionBaseMs(session, isDone);
  if (base === undefined) return undefined;
  const bytes = session.retainedDataBytes;
  if (bytes === undefined || bytes <= 0 || retainedDataSizeIsStale(session, isDone)) return undefined;
  const days = retentionPeriodDays(bytes, config);
  if (days <= 0) return undefined;
  const floor = ms(session.retentionFloorAt);
  const start = Number.isNaN(floor) ? base : Math.max(base, floor);
  return start + days * DAY_MS;
}
