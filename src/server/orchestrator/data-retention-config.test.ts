import { describe, it, expect } from "vitest";
import { dataRetentionConfigFromEnv } from "./data-retention-config.js";
import { DEFAULT_DATA_RETENTION } from "../shared/session-retention.js";

describe("dataRetentionConfigFromEnv (req 6)", () => {
  it("uses 60 days, 14 days and 100 MB when nothing is set", () => {
    expect(dataRetentionConfigFromEnv({})).toEqual(DEFAULT_DATA_RETENTION);
    expect(DEFAULT_DATA_RETENTION).toEqual({ days: 60, largeDays: 14, largeBytes: 100 * 1024 * 1024 });
  });

  it("reads the three variables", () => {
    expect(dataRetentionConfigFromEnv({
      SESSION_DATA_RETENTION_DAYS: "90",
      SESSION_DATA_RETENTION_LARGE_DAYS: "7",
      SESSION_DATA_RETENTION_LARGE_MB: "500",
    })).toEqual({ days: 90, largeDays: 7, largeBytes: 500 * 1024 * 1024 });
  });

  it("accepts 0, which turns a period off", () => {
    expect(dataRetentionConfigFromEnv({ SESSION_DATA_RETENTION_DAYS: "0" }).days).toBe(0);
  });

  it("keeps the default for a value it cannot use", () => {
    expect(dataRetentionConfigFromEnv({
      SESSION_DATA_RETENTION_DAYS: "soon",
      SESSION_DATA_RETENTION_LARGE_DAYS: "-3",
    })).toEqual(DEFAULT_DATA_RETENTION);
  });
});
