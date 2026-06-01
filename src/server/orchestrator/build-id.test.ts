import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { normalizeBuildId, resolveBuildId, resolveVersion } from "./build-id.js";

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

describe("resolveVersion", () => {
  // resolveVersion shells out against the host repo (/opt/shipit). When that
  // mount is absent — local/dogfood mode, CI — it must degrade gracefully to
  // the baked build id with the edge channel. These assertions only hold when
  // /opt/shipit is not a git repo, which is the case everywhere but a prod box.
  const hostRepoPresent = existsSync("/opt/shipit/.git");

  it.skipIf(hostRepoPresent)("falls back to edge + short sha when host repo is absent", () => {
    const v = resolveVersion("stable", { SHIPIT_BUILD_ID: "abcdef1234567890" });
    expect(v.channel).toBe("edge");
    expect(v.version).toBe("main @ abcdef1");
    expect(v.commit).toBe("abcdef1234567890");
  });
});
