/**
 * The ops finding of 2026-08-20 — a base-generation rotation and the docs/271
 * `agent.install` trust gate, exercised TOGETHER.
 *
 * Each half already had thorough coverage of its own (`container-lifecycle.test.ts`
 * for the rotation reset, `agent-install-gate.test.ts` for the withhold) and each
 * half was individually correct. What shipped was the seam: the rotation deletes
 * the install marker *because* `agent.install` must run again, the gate refuses to
 * run it, and nothing reconciled the two. A production session was left serving
 * `sh: 1: vite: not found` with a freshly written marker suppressing every later
 * repair.
 *
 * These tests are deliberately whole-seam rather than per-function. A per-function
 * test of either half passes today and passed on the day of the incident.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { prepareOverlayDirs } from "./container-lifecycle.js";
import { preStampInstallMarker, type DepDirOverlaySpec } from "./overlay-session.js";
import {
  INSTALL_RESET_FILE,
  acceptedInstallCommands,
  clearInstallReset,
  evaluateInstallGate,
  readInstallReset,
} from "./agent-install-gate.js";
import { dependencyGapAgentPrefix, dependencyGapNotice } from "./dependency-staleness.js";
import { reclaimBlockedSessionCaches, reclaimRegenerableSessionDirs } from "./disk-utils.js";
import { INSTALL_MARKER_VERSION, type InstallMarker } from "../shared/install-marker.js";

const SESSION_ID = "sess-1";
const SCOPE = "aaaa1111";
const WORKER_RT = "img|x64|glibc-2.36|node24";

/** The list the session genuinely ran, and the changed one a plugin wrote. */
const ACCEPTED = ["npm ci"];
const CHANGED = ["npm ci && node ./node_modules/tools/postinstall.js"];

let root: string;
let sessionRoot: string;
let workspaceDir: string;
let markerFile: string;
let resetFile: string;
let head: string;

beforeEach(async () => {
  delete process.env.SHIPIT_SESSION_WORKER_UID; // legacy root runtime — chowns no-op
  root = fs.mkdtempSync(path.join(os.tmpdir(), "install-reset-"));
  sessionRoot = path.join(root, "sessions", SESSION_ID);
  workspaceDir = path.join(sessionRoot, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  markerFile = path.join(sessionRoot, "state", "shared", ".install-done");
  // Deliberately NOT under `state/` — that whole subtree is regenerable and is
  // deleted by disk-tier eviction. See the constant's docstring.
  resetFile = path.join(sessionRoot, INSTALL_RESET_FILE);

  // A real clone: `preStampInstallMarker` resolves HEAD off it, and the gate
  // resolves the session root and state dir from it (never the other way round).
  const git = simpleGit(workspaceDir);
  await git.init();
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  writeConfig(CHANGED);
  await git.add(".");
  await git.commit("plugin rewrote shipit.yaml");
  head = (await git.revparse(["HEAD"])).trim();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A plugin-bearing session whose `agent.install` is `install`. Both halves of
 * `sessionHasPlugin` are satisfied — the declaration AND the on-disk plugin-data
 * evidence — so the fixture cannot pass by accident if one is later dropped.
 */
function writeConfig(install: string[]): void {
  fs.writeFileSync(
    path.join(workspaceDir, "shipit.yaml"),
    [
      "agent:",
      "  install:",
      ...install.map((c) => `    - ${JSON.stringify(c)}`),
      "plugins:",
      "  repos:",
      "    - repo: nikzlabs/tools",
      "      name: tools",
      "  use:",
      "    - plugin: probe",
      "      from: tools",
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(sessionRoot, "plugin-data", "probe"), { recursive: true });
}

/** The marker recording the list that last ran to completion. */
function writeMarker(installCommands: string[]): void {
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  const marker: InstallMarker = {
    version: INSTALL_MARKER_VERSION,
    sourceCommit: head,
    runtimeKey: WORKER_RT,
    installCommands,
    depsHash: null,
    completedAt: "2026-08-20T17:00:00.000Z",
  };
  fs.writeFileSync(markerFile, JSON.stringify(marker));
}

function makeSpec(generation: number): DepDirOverlaySpec {
  const scopeDir = path.join(sessionRoot, "overlay", SCOPE);
  const genDir = path.join(scopeDir, `g${generation}`);
  return {
    volumeName: `shipit-${SESSION_ID}_overlay-${SCOPE}`,
    lowerdir: `/daemon/overlay-base/${SCOPE}/g${generation}`,
    upperdir: `/daemon${path.join(genDir, "upper")}`,
    workdir: `/daemon${path.join(genDir, "work")}`,
    depDir: "node_modules",
    mountPath: "/workspace/node_modules",
    scope: { repoUrl: "https://x/y.git", runtimeKey: WORKER_RT, depDir: "node_modules" },
    scopeHash: SCOPE,
    generation,
    orchDirs: {
      lowerdir: path.join(root, "overlay-base", SCOPE, `g${generation}`),
      upperdir: path.join(genDir, "upper"),
      workdir: path.join(genDir, "work"),
      sessionScopeDir: scopeDir,
    },
  };
}

/** A base pointer whose recorded install matches this workspace exactly. */
function pointerFor(installCommands: string[], generation: number) {
  return {
    scopeHash: SCOPE,
    commit: head,
    depth: 1,
    generation,
    baseDir: `/state/overlay-base/${SCOPE}/g${generation}`,
    updatedAt: "2026-08-20T17:00:00Z",
    marker: { runtimeKey: WORKER_RT, installCommands, depsHash: null },
  };
}

/**
 * Drive the incident: the session ran `ACCEPTED` over generation 1 and installed
 * packages of its own on top of the base, a plugin then rewrote `agent.install`
 * to `CHANGED`, and a publish rotated the base to generation 2 under it.
 */
function rotateUnderSession(): void {
  const before = makeSpec(1);
  prepareOverlayDirs([before], { workspaceDir });
  fs.mkdirSync(path.join(before.orchDirs!.upperdir, ".bin"), { recursive: true });
  fs.writeFileSync(path.join(before.orchDirs!.upperdir, ".bin", "vite"), "#!/bin/sh\n");
  writeMarker(ACCEPTED);
  prepareOverlayDirs([makeSpec(2)], { workspaceDir });
}

describe("a marker deleted on purpose leaves the acceptance record behind", () => {
  it("records the list that was in force when the rotation dropped the marker", () => {
    rotateUnderSession();
    expect(fs.existsSync(markerFile)).toBe(false); // unchanged: the marker still goes
    expect(readInstallReset(workspaceDir)).toEqual({ accepted: ACCEPTED });
  });

  it("writes nothing when there was no rotation", () => {
    writeMarker(ACCEPTED);
    prepareOverlayDirs([makeSpec(1)], { workspaceDir });
    prepareOverlayDirs([makeSpec(1)], { workspaceDir }); // same generation — not a rotation
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(readInstallReset(workspaceDir)).toBeNull();
  });

  it("keeps the list that last RAN across a second rotation", () => {
    rotateUnderSession();
    // A second publish rotates again before any install has completed. There is
    // no marker to read now, so an implementation that re-derived the anchor
    // from the marker alone would overwrite it with nothing.
    prepareOverlayDirs([makeSpec(3)], { workspaceDir });
    expect(readInstallReset(workspaceDir)).toEqual({ accepted: ACCEPTED });
  });

  /**
   * Found by review, and the reason the record is a session-root sibling rather
   * than living beside the marker in `state/`.
   *
   * `REGENERABLE_SESSION_SUBDIRS` includes the whole state dir, so disk-tier
   * eviction deletes the marker, the withheld record and — if it lived there —
   * the anchor. `plugin-data/` is deliberately DURABLE and survives. An evicted
   * and restored session therefore comes back still plugin-bearing with no
   * anchor, and a null anchor reads as "first install", which ALLOWS: eviction
   * alone would have handed the credential-bearing container a command list
   * nobody accepted.
   */
  it("survives the disk eviction that deletes the entire state dir", async () => {
    rotateUnderSession();
    await reclaimRegenerableSessionDirs(workspaceDir);

    expect(fs.existsSync(path.join(sessionRoot, "state"))).toBe(false);
    // Still plugin-bearing: plugin-data is durable by design.
    expect(fs.existsSync(path.join(sessionRoot, "plugin-data"))).toBe(true);
    expect(readInstallReset(workspaceDir)).toEqual({ accepted: ACCEPTED });

    // The restored session re-clones the same branch, which still carries the
    // plugin's rewritten `shipit.yaml`.
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeConfig(CHANGED);
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(true);
  });
});

/**
 * `reclaimBlockedSessionCaches` is the SECOND deleter and is not reachable
 * through `prepareOverlayDirs`. It has the same defect for the same reason, plus
 * one of its own: it runs on sessions a rotation may already have touched.
 */
describe("the disk reclaim is the same deleter", () => {
  it("records the reset with the accepted list", async () => {
    prepareOverlayDirs([makeSpec(1)], { workspaceDir });
    writeMarker(ACCEPTED);
    await reclaimBlockedSessionCaches(workspaceDir);
    expect(fs.existsSync(markerFile)).toBe(false);
    expect(readInstallReset(workspaceDir)).toEqual({ accepted: ACCEPTED });
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED })).toMatchObject({
      withheld: true,
      accepted: ACCEPTED,
      afterDependencyReset: true,
    });
  });

  // Found by review. The reclaim's destructive act is the overlay removal, which
  // happens whether or not a marker is there to delete — so gating the record on
  // the marker skipped it entirely for a session a rotation had already reset.
  it("still records when a rotation already took the marker", async () => {
    rotateUnderSession();
    fs.rmSync(resetFile, { force: true }); // as if the rotation's write had failed
    expect(fs.existsSync(markerFile)).toBe(false);

    await reclaimBlockedSessionCaches(workspaceDir);
    expect(readInstallReset(workspaceDir)).not.toBeNull();
  });
});

describe("the trust gate keeps its anchor across the reset", () => {
  it("still withholds the changed list once the marker is gone", () => {
    rotateUnderSession();
    // Before this fix the marker was the ONLY anchor, so its deletion made
    // `accepted` null and the gate ALLOWED — handing a plugin's rewritten
    // command list straight to the credential-holding agent container on the
    // next recreate.
    expect(acceptedInstallCommands(workspaceDir)).toEqual(ACCEPTED);
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED })).toMatchObject({
      withheld: true,
      accepted: ACCEPTED,
      afterDependencyReset: true,
    });
  });

  it("still allows the accepted list itself — the reset is not a blanket refusal", () => {
    rotateUnderSession();
    expect(evaluateInstallGate({ workspaceDir, requested: ACCEPTED }).withheld).toBe(false);
  });

  it("allows again once an install has answered the reset", () => {
    rotateUnderSession();
    clearInstallReset(workspaceDir);
    writeMarker(CHANGED); // the install ran, so this list IS now accepted
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(false);
  });

  /**
   * A record that exists but cannot be read is NOT the same as no record. Absent
   * means "nothing was ever accepted", which allows — right for a first-time
   * session, catastrophic here, where the file's existence is itself the evidence
   * that something WAS accepted and we have lost track of what. It costs a
   * plugin-bearing session one "ask the agent"; reading it as absent would cost
   * it an unaccepted execution.
   */
  it("fails CLOSED on a record it cannot parse", () => {
    rotateUnderSession();
    fs.writeFileSync(resetFile, "{tru");
    expect(readInstallReset(workspaceDir)).toEqual({ accepted: [] });
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED })).toMatchObject({
      withheld: true,
      accepted: [],
    });
  });

  // The overwhelming majority of sessions. A reset record is not a reason to
  // start gating a session that has no plugin in it — the whole boundary exists
  // because a plugin container can write `shipit.yaml`, and there isn't one.
  it("leaves a session with no plugin entirely alone", () => {
    rotateUnderSession();
    expect(readInstallReset(workspaceDir)).not.toBeNull();
    // Neither half of `sessionHasPlugin`: no declaration, no plugin-data.
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(CHANGED[0])}\n`,
    );
    fs.rmSync(path.join(sessionRoot, "plugin-data"), { recursive: true, force: true });
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(false);
  });
});

describe("the pre-stamp cannot re-open the accepted list", () => {
  it("declines when the gate is withholding, even on a perfect base hit", async () => {
    rotateUnderSession();
    // The pointer matches this checkout on every axis the pre-stamp checks —
    // commit, generation, runtime key, and the command list. On the incident host
    // that produced a marker recording the plugin's list as accepted six seconds
    // after the gate had refused it.
    const stamped = await preStampInstallMarker({
      stateDir: path.join(root, "state"),
      workspaceDir,
      specs: [makeSpec(2)],
      readPointer: () => pointerFor(CHANGED, 2),
    });
    expect(stamped).toBe(false);
    expect(fs.existsSync(markerFile)).toBe(false);
    // The anchor is untouched, so a later recreate withholds too.
    expect(acceptedInstallCommands(workspaceDir)).toEqual(ACCEPTED);
  });

  it("still stamps the base hit when the list is one this session accepted", async () => {
    writeConfig(ACCEPTED); // no plugin rewrite — the ordinary docs/183 fast path
    rotateUnderSession();
    const stamped = await preStampInstallMarker({
      stateDir: path.join(root, "state"),
      workspaceDir,
      specs: [makeSpec(2)],
      readPointer: () => pointerFor(ACCEPTED, 2),
    });
    expect(stamped).toBe(true);
    // The record outlives the stamp — only a completed install answers it — and
    // both sources agree, so the gate's answer is the same from either.
    expect(readInstallReset(workspaceDir)).not.toBeNull();
    expect(acceptedInstallCommands(workspaceDir)).toEqual(ACCEPTED);
  });

  it("still stamps on a fresh session with no history at all", async () => {
    // docs/271 by design: a first-time session has no prior list to contradict,
    // and the docs/178 repo-trust decision covers its `agent.install`.
    const stamped = await preStampInstallMarker({
      stateDir: path.join(root, "state"),
      workspaceDir,
      specs: [makeSpec(1)],
      readPointer: () => pointerFor(CHANGED, 1),
    });
    expect(stamped).toBe(true);
  });
});

describe("what the withheld-after-reset gap says", () => {
  const gap = {
    reason: "install-withheld" as const,
    commands: ACCEPTED,
    withheld: CHANGED,
  };

  it("names the in-force list as the remedy and the withheld one as not run", () => {
    const notice = dependencyGapNotice(gap);
    const remedyAt = notice.indexOf(`    ${ACCEPTED[0]}`);
    const withheldAt = notice.indexOf("Not run:");
    expect(remedyAt).toBeGreaterThan(-1);
    expect(withheldAt).toBeGreaterThan(remedyAt);
    expect(notice).toContain(CHANGED[0]);
    // The symptom the incident's user was actually handed, so the notice is
    // findable from the thing they searched for.
    expect(notice).toContain("exit 127");
  });

  it("tells the agent to run the in-force list and not the withheld one", () => {
    const prefix = dependencyGapAgentPrefix(gap);
    expect(prefix.startsWith("[System]")).toBe(true);
    expect(prefix).toContain("Do NOT run the changed `agent.install`");
    // Requirement 4 — the remedy is agent-mediated, and it restores the packages
    // without adopting the plugin's change.
    expect(prefix).toContain(ACCEPTED[0]);
  });

  /**
   * ShipIt genuinely cannot tell a broken session from the healthy control one:
   * an empty reaped upper proves the OLD lower satisfied this checkout and says
   * nothing about the NEW one. So the wording must not order an unconditional
   * reinstall every turn — `npm ci` deletes `node_modules` and rebuilds from
   * scratch, which is not a free thing to do to a session that is working.
   */
  it("frames the remedy as diagnostic ordering, not an unconditional instruction", () => {
    for (const text of [dependencyGapNotice(gap), dependencyGapAgentPrefix(gap)]) {
      expect(text).toMatch(/unverified|may be/i);
      expect(text).not.toMatch(/Dependencies are incomplete/);
    }
    expect(dependencyGapAgentPrefix(gap)).toContain("Before you treat any");
  });

  it("says nothing at all for a healthy session", () => {
    expect(dependencyGapAgentPrefix(null)).toBe("");
  });
});
