/**
 * The ops finding of 2026-08-20 — the docs/271 `agent.install` trust gate and
 * every path that discards dependency state, exercised TOGETHER.
 *
 * Each half already had thorough coverage of its own (`container-lifecycle.test.ts`
 * for the rotation reset, `agent-install-gate.test.ts` for the withhold) and each
 * half was individually correct. What shipped was the seam: the rotation deletes
 * the install marker *because* `agent.install` must run again, the gate refuses to
 * run it, and nothing reconciled the two. A production session was left serving
 * `sh: 1: vite: not found` with a freshly written marker suppressing every later
 * repair.
 *
 * The tests are whole-seam rather than per-function, because a per-function test
 * of either half passed on the day of the incident. They are also written against
 * the STATES the gate can find a session in — no marker, no record, a record but
 * no marker — rather than against the operations that produce them, because the
 * defect this design replaced was an attempt to enumerate those operations, and
 * an enumeration is exactly what a test can accidentally share with the code.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { prepareOverlayDirs } from "./container-lifecycle.js";
import { preStampInstallMarker, type DepDirOverlaySpec } from "./overlay-session.js";
import {
  INSTALL_ACCEPTED_FILE,
  acceptedInstallCommands,
  clearAcceptedInstall,
  evaluateInstallGate,
  readAcceptedInstall,
  recordAcceptedInstall,
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
let acceptedFile: string;
let head: string;

beforeEach(async () => {
  delete process.env.SHIPIT_SESSION_WORKER_UID; // legacy root runtime — chowns no-op
  root = fs.mkdtempSync(path.join(os.tmpdir(), "install-accept-"));
  sessionRoot = path.join(root, "sessions", SESSION_ID);
  workspaceDir = path.join(sessionRoot, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  markerFile = path.join(sessionRoot, "state", "shared", ".install-done");
  // Deliberately NOT under `state/` — that whole subtree is regenerable and disk
  // eviction deletes it. See the constant's docstring.
  acceptedFile = path.join(sessionRoot, INSTALL_ACCEPTED_FILE);

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

/** The marker a completed install leaves — the "these deps are installed" claim. */
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

/** What `runInstall` does when an install completes with positive evidence. */
function installSucceeded(commands: string[]): void {
  writeMarker(commands);
  recordAcceptedInstall(workspaceDir, commands);
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

/** The incident: the session ran ACCEPTED over g1, then the base rotated to g2. */
function rotateUnderSession(): void {
  const before = makeSpec(1);
  prepareOverlayDirs([before], { workspaceDir });
  fs.mkdirSync(path.join(before.orchDirs!.upperdir, ".bin"), { recursive: true });
  fs.writeFileSync(path.join(before.orchDirs!.upperdir, ".bin", "vite"), "#!/bin/sh\n");
  installSucceeded(ACCEPTED);
  prepareOverlayDirs([makeSpec(2)], { workspaceDir });
}

/**
 * Every way a session can end up with no install marker, as data.
 *
 * The design this replaced tried to preserve the acceptance anchor by writing a
 * tombstone at each of these. That enumeration cannot be completed — the last
 * entry runs in ANOTHER PROCESS, and it is the one that broke the assumption:
 * the worker whiteouts the marker before every real reinstall and deliberately
 * writes none back if that reinstall fails, so an established plugin-bearing
 * session reaches the gate with no marker and no tombstone, where `null` reads
 * as "first install" and ALLOWS.
 *
 * Acceptance is therefore recorded when an install SUCCEEDS, and these are the
 * cases that must not disturb it. Table-driven on purpose: adding a sixth way to
 * lose the marker should not require a sixth test.
 */
const MARKER_DESTROYERS: { name: string; run: () => Promise<void> | void }[] = [
  {
    name: "a base-generation rotation",
    run: () => { prepareOverlayDirs([makeSpec(2)], { workspaceDir }); },
  },
  {
    name: "a blocked-session cache reclaim",
    run: async () => { await reclaimBlockedSessionCaches(workspaceDir); },
  },
  {
    name: "disk-tier eviction of the whole state dir",
    run: async () => { await reclaimRegenerableSessionDirs(workspaceDir); },
  },
  {
    name: "the worker's own whiteout before a reinstall that then failed",
    // `install-controller.ts` removes the marker before running the commands and
    // writes no marker back on failure. Nothing orchestrator-side observes it.
    run: () => { fs.rmSync(markerFile, { force: true }); },
  },
];

describe("acceptance survives every way the marker can be destroyed", () => {
  for (const { name, run } of MARKER_DESTROYERS) {
    it(`still withholds a changed list after ${name}`, async () => {
      prepareOverlayDirs([makeSpec(1)], { workspaceDir });
      installSucceeded(ACCEPTED);
      await run();

      // The tree is no longer vouched for...
      expect(fs.existsSync(markerFile)).toBe(false);
      // ...but what this session accepted is unchanged.
      expect(acceptedInstallCommands(workspaceDir)).toEqual(ACCEPTED);
      expect(evaluateInstallGate({ workspaceDir, requested: CHANGED })).toMatchObject({
        withheld: true,
        accepted: ACCEPTED,
        afterDependencyReset: true,
      });
    });
  }

  /**
   * The eviction case in full, because it is the one where the record's LOCATION
   * is what saves it. `REGENERABLE_SESSION_SUBDIRS` includes the whole `state/`
   * subtree, while `plugin-data/` is deliberately durable — so a restored session
   * is still plugin-bearing, and an anchor stored beside the marker would be gone.
   * Eviction alone would have handed the credential-bearing container a command
   * list nobody accepted.
   */
  it("survives eviction and restore end to end", async () => {
    prepareOverlayDirs([makeSpec(1)], { workspaceDir });
    installSucceeded(ACCEPTED);
    await reclaimRegenerableSessionDirs(workspaceDir);

    expect(fs.existsSync(path.join(sessionRoot, "state"))).toBe(false);
    expect(fs.existsSync(path.join(sessionRoot, "plugin-data"))).toBe(true);
    expect(fs.existsSync(acceptedFile)).toBe(true);

    // Restore re-clones the same branch, which still carries the plugin's write.
    fs.mkdirSync(workspaceDir, { recursive: true });
    writeConfig(CHANGED);
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(true);
  });

  it("is cleared when the clone changes hands", () => {
    installSucceeded(ACCEPTED);
    // Exactly what `claim-session.ts` does on a HEAD change: unlink the marker
    // AND drop the acceptance record. Both, because the migration fallback reads
    // the marker — clearing only the record would leave the previous occupant's
    // list still answering for the new one.
    fs.rmSync(markerFile, { force: true });
    clearAcceptedInstall(workspaceDir);

    expect(readAcceptedInstall(workspaceDir)).toBeNull();
    // A new occupant starts with no acceptance at all, so its first install is
    // covered by the docs/178 repo-trust decision exactly as a fresh session is.
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(false);
  });
});

describe("the gate", () => {
  it("allows a genuinely first-time session", () => {
    expect(readAcceptedInstall(workspaceDir)).toBeNull();
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(false);
  });

  it("allows the accepted list itself — a lost marker is not a blanket refusal", () => {
    rotateUnderSession();
    expect(evaluateInstallGate({ workspaceDir, requested: ACCEPTED }).withheld).toBe(false);
  });

  it("adopts a new list once an install of it completes", () => {
    installSucceeded(ACCEPTED);
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(true);
    installSucceeded(CHANGED); // the user asked for it and it ran
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(false);
  });

  it("reports afterDependencyReset=false while the tree is still vouched for", () => {
    installSucceeded(ACCEPTED);
    // Marker intact: the ordinary docs/271 withhold, on a session that still has
    // the dependencies it accepted.
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED })).toMatchObject({
      withheld: true,
      afterDependencyReset: false,
    });
  });

  /**
   * A record that exists but cannot be read is NOT the same as no record. Absent
   * means "nothing was ever accepted", which allows — right for a first-time
   * session, catastrophic here, where the file's existence is itself the evidence
   * that something WAS accepted and we have lost track of what.
   */
  it("fails CLOSED on a record it cannot parse", () => {
    installSucceeded(ACCEPTED);
    fs.writeFileSync(acceptedFile, "{tru");
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ commands: [] });
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED })).toMatchObject({
      withheld: true,
      accepted: [],
    });
  });

  /**
   * Migration. A session that accepted a list before this record existed answers
   * from its marker — and must persist that answer, or it keeps depending on a
   * marker five paths delete.
   */
  it("backfills a record from the marker for a pre-existing session", () => {
    writeMarker(ACCEPTED); // marker only — as if accepted before the record existed
    expect(readAcceptedInstall(workspaceDir)).toBeNull();

    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(true);

    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ commands: ACCEPTED });
    // And now it no longer needs the marker.
    fs.rmSync(markerFile, { force: true });
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(true);
  });

  // The overwhelming majority of sessions. A lost marker is not a reason to start
  // gating a session with no plugin in it — the boundary exists because a plugin
  // container can write `shipit.yaml`, and there isn't one.
  it("leaves a session with no plugin entirely alone", () => {
    installSucceeded(ACCEPTED);
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(CHANGED[0])}\n`,
    );
    fs.rmSync(path.join(sessionRoot, "plugin-data"), { recursive: true, force: true });
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(false);
  });

  /**
   * `sessionStateDirForWorkspace` THROWS for a clone that does not sit at
   * `<sessionDir>/workspace` (planning#288, deliberately). The gate is called from
   * the top of `runInstall`, whose caller maps a throw to a FAILED install —
   * latching every `dependsOnInstall` service to `error` under "agent.install
   * failed". An unserviceable layout must degrade, not take the stack down naming
   * the wrong cause.
   */
  it("does not throw for a session layout it cannot resolve", () => {
    const flat = path.join(root, "sessions", "flat-layout");
    fs.mkdirSync(flat, { recursive: true });
    // Plugin-bearing by DECLARATION, so `sessionHasPlugin` answers true without
    // touching the session root — the gate then reaches the record read.
    fs.writeFileSync(
      path.join(flat, "shipit.yaml"),
      [
        "agent:",
        `  install:\n    - ${JSON.stringify(CHANGED[0])}`,
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
    expect(() => evaluateInstallGate({ workspaceDir: flat, requested: CHANGED })).not.toThrow();
    expect(() => readAcceptedInstall(flat)).not.toThrow();
    expect(readAcceptedInstall(flat)).toBeNull();
  });
});

describe("the pre-stamp cannot assert a tree the gate is refusing to build", () => {
  it("declines while the gate is withholding, even on a perfect base hit", async () => {
    rotateUnderSession();
    // The pointer matches this checkout on every axis the pre-stamp checks —
    // commit, generation, runtime key, and the command list. On the incident host
    // that produced a marker six seconds after the gate had refused the install,
    // which then suppressed every later attempt to repair the tree.
    const stamped = await preStampInstallMarker({
      stateDir: path.join(root, "state"),
      workspaceDir,
      specs: [makeSpec(2)],
      readPointer: () => pointerFor(CHANGED, 2),
    });
    expect(stamped).toBe(false);
    expect(fs.existsSync(markerFile)).toBe(false);
    // Which is what keeps the diagnosis alive: a marker here would say the tree
    // is fine, and the gate reads its absence as "the reinstall never ran".
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).afterDependencyReset).toBe(true);
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
    expect(acceptedInstallCommands(workspaceDir)).toEqual(ACCEPTED);
  });

  it("still stamps on a fresh session with no history at all", async () => {
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
    // The symptom the incident's user was handed, so the notice is findable from
    // the thing they searched for.
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
   * Four different routes reach this state and only one of them replaces the
   * shared base, so no surface may name that as the cause. The earlier wording
   * did, which made it simply false for a disk reclaim or a failed reinstall.
   */
  it("does not claim a cause that is only true for one of the routes", () => {
    for (const text of [
      dependencyGapNotice(gap),
      dependencyGapAgentPrefix(gap),
    ]) {
      expect(text).toContain("stopped vouching");
      expect(text).not.toMatch(/^ShipIt replaced the shared dependency base/m);
    }
  });

  /**
   * ShipIt genuinely cannot tell a broken session from a healthy one here, so the
   * wording must not order an unconditional reinstall every turn — `npm ci`
   * deletes `node_modules` and rebuilds from scratch, which is not free to do to
   * a session that is working.
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
