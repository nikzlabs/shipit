/**
 * docs/262 — the copy-on-write layer for a plugin generation. The value here is
 * the DAEMON-HOST path translation: get it wrong and volume creation succeeds
 * while the mount comes up empty, a long way from the cause.
 */

import { describe, it, expect } from "vitest";
import {
  buildPluginOverlaySpec,
  pluginOverlayVolumeName,
  pluginWorkDir,
} from "./plugin-overlay.js";

const base = {
  sessionId: "0123abcd-4567-89ef-0123-456789abcdef",
  repoName: "tools",
  commit: "a".repeat(40),
  stateDir: "/workspace/sessions/sess-1/state",
  checkoutDir: `/workspace/sessions/sess-1/state/plugins/tools/generations/${"a".repeat(40)}`,
};

describe("buildPluginOverlaySpec", () => {
  it("translates every path onto the daemon's view of the state volume", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      stateRoot: "/workspace",
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });

    const root = "/var/lib/docker/volumes/shipit-workspace/_data/sessions/sess-1/state/plugins/tools";
    expect(spec.lowerdir).toBe(`${root}/generations/${"a".repeat(40)}`);
    expect(spec.upperdir).toBe(`${root}/work/${"a".repeat(40)}/upper`);
    expect(spec.workdir).toBe(`${root}/work/${"a".repeat(40)}/work`);
    // Nothing daemon-side may leak the orchestrator's own root.
    for (const p of [spec.lowerdir, spec.upperdir, spec.workdir]) {
      expect(p.startsWith("/var/lib/docker/")).toBe(true);
    }
  });

  it("keeps orchestrator paths separately, because it must mkdir them itself", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      stateRoot: "/workspace",
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });
    expect(spec.orchDirs.upperdir).toBe(`${pluginWorkDir(base.stateDir, "tools", base.commit)}/upper`);
    expect(spec.orchDirs.lowerdir).toBe(base.checkoutDir);
    expect(spec.orchDirs.upperdir).not.toBe(spec.upperdir);
  });

  it("is the identity in dev, where both sides see one path", () => {
    const spec = buildPluginOverlaySpec(base);
    expect(spec.lowerdir).toBe(base.checkoutDir);
    expect(spec.upperdir).toBe(spec.orchDirs.upperdir);
  });

  it("leaves a path outside the state root alone rather than rewriting it", () => {
    const spec = buildPluginOverlaySpec({
      ...base,
      checkoutDir: "/elsewhere/checkout",
      stateRoot: "/workspace",
      volumeMountpoint: "/var/lib/docker/volumes/shipit-workspace/_data",
    });
    expect(spec.lowerdir).toBe("/elsewhere/checkout");
  });

  // Install runs against the STAGING dir, which publish then renames. Both
  // lowerdirs share ONE upper layer — which is why the install volume must be
  // removed before the runtime volume is created (the kernel forbids two
  // independently created mounts over one upperdir).
  it("gives staging and published lowerdirs the same upper layer", () => {
    const staging = buildPluginOverlaySpec({ ...base, checkoutDir: `${base.checkoutDir}.staging-ab12cd34` });
    const published = buildPluginOverlaySpec(base);

    expect(staging.lowerdir).not.toBe(published.lowerdir);
    expect(staging.upperdir).toBe(published.upperdir);
    expect(staging.workdir).toBe(published.workdir);
    expect(staging.volumeName).toBe(published.volumeName);
  });
});

describe("pluginOverlayVolumeName", () => {
  it("is per generation, not per repository", () => {
    const a = pluginOverlayVolumeName(base.sessionId, "tools", "a".repeat(40));
    const b = pluginOverlayVolumeName(base.sessionId, "tools", "b".repeat(40));
    expect(a).not.toBe(b);
  });

  it("keeps the session-prefixed shape orphan collection looks for", () => {
    expect(pluginOverlayVolumeName(base.sessionId, "tools", base.commit))
      .toMatch(/^shipit-0123abcd-456_plugin-tools-[0-9a-f]{8}-a{12}$/);
  });

  // Verified against the sweep itself, not against the convention as described:
  // `sweepOrphanSessionVolumes` matches this exact pattern and compares the
  // capture with `sessionId.slice(0, 12)`. An 8-character prefix — the first
  // version of this name — does not match at all, so an orphaned volume would
  // never be reclaimed.
  it("is reclaimable by the disk janitor's orphan sweep", () => {
    const name = pluginOverlayVolumeName(base.sessionId, "tools", base.commit);
    const match = /^shipit-([a-f0-9-]{12})_/.exec(name);
    expect(match?.[1]).toBe(base.sessionId.slice(0, 12));
  });

  it("renders an awkward repo name into something a volume name can hold", () => {
    expect(pluginOverlayVolumeName(base.sessionId, "My Tools/v2!", base.commit))
      .toMatch(/^shipit-0123abcd-456_plugin-my-tools-v2-[0-9a-f]{8}-a{12}$/);
  });
});
