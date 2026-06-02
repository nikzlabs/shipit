import { describe, it, expect } from "vitest";
import { parseTimestampMs } from "./utils.js";

describe("parseTimestampMs", () => {
  // These assertions compare against an ISO string with an explicit `Z`, so the
  // expected value is the same UTC instant in ANY host timezone — including the
  // UTC that CI runs under. A plain `Date.parse` of the SQLite form would only
  // satisfy these in UTC, which is the bug this helper fixes.
  it("parses a SQLite datetime('now') string as UTC, matching the ISO equivalent", () => {
    expect(parseTimestampMs("2026-06-02 14:30:00")).toBe(Date.parse("2026-06-02T14:30:00.000Z"));
  });

  it("parses a SQLite datetime with fractional seconds as UTC", () => {
    expect(parseTimestampMs("2026-06-02 14:30:00.500")).toBe(Date.parse("2026-06-02T14:30:00.500Z"));
  });

  it("leaves an ISO string with a trailing Z unchanged", () => {
    expect(parseTimestampMs("2026-06-02T14:30:00.000Z")).toBe(Date.parse("2026-06-02T14:30:00.000Z"));
  });

  it("leaves an ISO string with a numeric offset unchanged", () => {
    expect(parseTimestampMs("2026-06-02T17:30:00+03:00")).toBe(Date.parse("2026-06-02T14:30:00.000Z"));
  });

  it("orders a SQLite merged_at and an ISO last_used_at by their true UTC instants", () => {
    // The merge happened one second AFTER the last turn. Both are UTC. A naive
    // Date.parse mis-orders these in a UTC+ zone (merged_at read as local →
    // earlier), which is exactly what falsely promotes a merged session.
    const used = parseTimestampMs("2026-06-02T14:29:59.000Z");
    const merged = parseTimestampMs("2026-06-02 14:30:00");
    expect(used > merged).toBe(false);
  });

  it("returns NaN for unparseable input", () => {
    expect(Number.isNaN(parseTimestampMs("not a date"))).toBe(true);
  });
});
