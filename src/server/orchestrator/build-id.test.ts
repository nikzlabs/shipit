import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { composeVersion, normalizeBuildId, resolveBuildId, resolveVersion } from "./build-id.js";

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

describe("composeVersion", () => {
  const noTag = () => undefined;
  const baked = "1111111111111111111111111111111111111111";
  const head = "2222222222222222222222222222222222222222";

  it("names the running (baked) commit, not the checkout HEAD", () => {
    // The whole #1047 fix: identity follows the running image, not HEAD.
    const v = composeVersion("edge", baked, head, noTag);
    expect(v.commit).toBe(baked);
    expect(v.version).toBe("main @ 1111111");
  });

  it("flags a mismatch when checkout HEAD is ahead of the running image", () => {
    const v = composeVersion("edge", baked, head, noTag);
    expect(v.mismatch).toBe(true);
  });

  it("does not flag a mismatch when checkout and running image agree", () => {
    const v = composeVersion("edge", baked, baked, noTag);
    expect(v.mismatch).toBeUndefined();
  });

  it("uses the exact tag of the running commit on stable", () => {
    const v = composeVersion("stable", baked, baked, (c) => (c === baked ? "v1.4.0" : undefined));
    expect(v.version).toBe("v1.4.0");
    expect(v.mismatch).toBeUndefined();
  });

  it("ignores a tag on edge (always sha form)", () => {
    const v = composeVersion("edge", baked, baked, () => "v1.4.0");
    expect(v.version).toBe("main @ 1111111");
  });

  it("degrades to edge + short sha when the host repo is absent", () => {
    const v = composeVersion("stable", baked, undefined, noTag);
    expect(v.channel).toBe("edge");
    expect(v.version).toBe("main @ 1111111");
    expect(v.mismatch).toBeUndefined();
  });

  it("falls back to checkout HEAD when there is no baked id", () => {
    const v = composeVersion("edge", undefined, head, noTag);
    expect(v.commit).toBe(head);
    expect(v.mismatch).toBeUndefined();
  });

  it("reports unknown when neither commit is resolvable", () => {
    const v = composeVersion("stable", undefined, undefined, noTag);
    expect(v.version).toBe("unknown");
    expect(v.commit).toBeUndefined();
  });
});
