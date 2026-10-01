import { DEFAULT_DATA_RETENTION, type DataRetentionConfig } from "../shared/session-retention.js";

// docs/323-archived-session-data-retention req 6. Number(), not parseFloat(): "1_000"
// must fall back to the default and not become a period of 1 day.
function nonNegative(raw: string | undefined, fallback: number): number {
  const text = raw?.trim();
  if (!text) return fallback;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function dataRetentionConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DataRetentionConfig {
  return {
    days: nonNegative(env.SESSION_DATA_RETENTION_DAYS, DEFAULT_DATA_RETENTION.days),
    largeDays: nonNegative(env.SESSION_DATA_RETENTION_LARGE_DAYS, DEFAULT_DATA_RETENTION.largeDays),
    largeBytes: nonNegative(
      env.SESSION_DATA_RETENTION_LARGE_MB,
      DEFAULT_DATA_RETENTION.largeBytes / (1024 * 1024),
    ) * 1024 * 1024,
  };
}
