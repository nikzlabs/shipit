import { describe, expect, it } from "vitest";
import { normalizeBuildId, resolveBuildId } from "./build-id.js";

describe("build id", () => {
  it("prefers an explicit SHIPIT_BUILD_ID", () => {
    expect(resolveBuildId({ SHIPIT_BUILD_ID: "  abc123  " })).toBe("abc123");
  });

  it("normalizes empty build ids", () => {
    expect(normalizeBuildId("  abc123  ")).toBe("abc123");
    expect(normalizeBuildId("   ")).toBeUndefined();
    expect(normalizeBuildId(undefined)).toBeUndefined();
  });
});
