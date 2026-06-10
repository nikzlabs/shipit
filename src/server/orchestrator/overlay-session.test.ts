/**
 * docs/183 — overlay-session gating/scope/GC tests.
 *
 * Covers the design-agnostic reusable foundation: the feature gate + eligibility,
 * the orchestrator runtime fingerprint, and the GC live-source set. The per-session
 * mount-spec construction, snapshot pull, and publish-after-install flow were
 * whole-workspace-shaped and removed in the dep-dir pivot (they will be rebuilt
 * per declared dep dir); the publish CAS itself remains covered by
 * `overlay-base.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  isOverlayEligible,
  isOverlayEnabled,
  liveOverlayScopeHashes,
  overlayRuntimeKey,
  resolveOverlayScope,
} from "./overlay-session.js";
import { overlayScopeHash } from "./overlay-volume.js";
import type { SessionInfo } from "../shared/types.js";

const ON = { OVERLAY_DEP_STORE: "1" } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "11112222333344445555666677778888",
    title: "t",
    createdAt: "0",
    lastUsedAt: "0",
    remoteUrl: "https://github.com/acme/repo.git",
    ...over,
  } as SessionInfo;
}

describe("overlay feature gate + eligibility", () => {
  it("is off by default and on for 1/true", () => {
    expect(isOverlayEnabled(OFF)).toBe(false);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isOverlayEnabled({ OVERLAY_DEP_STORE: "yes" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("requires the flag, a remote, and a non-ops kind", () => {
    expect(isOverlayEligible(session(), OFF)).toBe(false); // flag off
    expect(isOverlayEligible(session(), ON)).toBe(true);
    expect(isOverlayEligible(session({ remoteUrl: "" }), ON)).toBe(false);
    expect(isOverlayEligible(session({ kind: "ops" }), ON)).toBe(false);
  });

  it("resolveOverlayScope returns null when ineligible, scope when eligible", () => {
    expect(resolveOverlayScope(session(), OFF)).toBeNull();
    const scope = resolveOverlayScope(session(), ON);
    expect(scope).toEqual({
      repoUrl: "https://github.com/acme/repo.git",
      runtimeKey: overlayRuntimeKey(ON),
    });
  });
});

describe("overlayRuntimeKey", () => {
  it("uses image id + arch, falling back to unknown", () => {
    expect(overlayRuntimeKey({ SESSION_WORKER_IMAGE_ID: "sha256:abc" } as NodeJS.ProcessEnv))
      .toBe(`sha256:abc|${process.arch}`);
    expect(overlayRuntimeKey({ IMAGE_DIGEST: "sha256:def" } as NodeJS.ProcessEnv))
      .toBe(`sha256:def|${process.arch}`);
    expect(overlayRuntimeKey({} as NodeJS.ProcessEnv)).toBe(`unknown|${process.arch}`);
  });
});

describe("liveOverlayScopeHashes", () => {
  it("is empty when the feature is off", () => {
    expect(liveOverlayScopeHashes([session()], OFF).size).toBe(0);
  });

  it("includes non-evicted repo-backed non-ops sessions for the current runtime", () => {
    const rt = overlayRuntimeKey(ON);
    const sessions = [
      session({ id: "a", remoteUrl: "https://github.com/acme/one.git" }),
      session({ id: "b", remoteUrl: "https://github.com/acme/two.git" }),
      session({ id: "c", remoteUrl: "", }), // no remote → skipped
      session({ id: "d", remoteUrl: "https://github.com/acme/three.git", kind: "ops" }), // ops → skipped
      session({ id: "e", remoteUrl: "https://github.com/acme/four.git", diskTier: "evicted" }), // evicted → skipped
    ];
    const live = liveOverlayScopeHashes(sessions, ON);
    expect(live).toEqual(
      new Set([
        overlayScopeHash("https://github.com/acme/one.git", rt),
        overlayScopeHash("https://github.com/acme/two.git", rt),
      ]),
    );
  });
});
