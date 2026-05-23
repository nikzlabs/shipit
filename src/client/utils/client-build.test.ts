import { describe, expect, it } from "vitest";
import { normalizeBuildId, shouldReloadForServerBuild } from "./client-build.js";

describe("client build utilities", () => {
  it("normalizes empty build ids", () => {
    expect(normalizeBuildId("  abc123  ")).toBe("abc123");
    expect(normalizeBuildId("   ")).toBeUndefined();
    expect(normalizeBuildId(undefined)).toBeUndefined();
  });

  it("reloads only when both build ids exist and differ", () => {
    expect(shouldReloadForServerBuild("/assets/old.js", "/assets/new.js")).toBe(true);
    expect(shouldReloadForServerBuild("/assets/new.js", "/assets/new.js")).toBe(false);
    expect(shouldReloadForServerBuild(undefined, "/assets/new.js")).toBe(false);
    expect(shouldReloadForServerBuild("/assets/old.js", undefined)).toBe(false);
  });
});
