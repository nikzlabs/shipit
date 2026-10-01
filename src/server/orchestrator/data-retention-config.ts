import { DEFAULT_DATA_RETENTION, type DataRetentionConfig } from "../shared/session-retention.js";

// docs/323-archived-session-data-retention req 6. A negative or unreadable value falls
// back to the default, so a typing error cannot shorten a period to nothing.
function nonNegative(raw: string | undefined, fallback: number): number {
  const value = parseFloat(raw ?? "");
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
