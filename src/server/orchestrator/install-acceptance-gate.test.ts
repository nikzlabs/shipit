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
  copyAcceptedInstall,
  evaluateInstallGate,
  readAcceptedInstall,
  recordAcceptedInstall,
  sessionHasPlugin,
} from "./agent-install-gate.js";
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

  /**
   * A fork clones the parent's WORKSPACE, so it inherits every plugin-authored
   * change to `shipit.yaml` the parent was refusing to run. Inheriting the
   * mutation without the acceptance is the dangerous half: the gate finds no
   * accepted list, reads "first install", and runs exactly what the parent
   * withheld.
   */
  it("is carried into a fork, which inherits the parent's mutated workspace", () => {
    installSucceeded(ACCEPTED);
    const forkWorkspace = path.join(root, "sessions", "fork-1", "workspace");
    fs.mkdirSync(forkWorkspace, { recursive: true });
    // The fork's clone carries the plugin's rewritten config, and its own
    // plugin-data does not exist — a fork copies neither durable sibling.
    fs.copyFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      path.join(forkWorkspace, "shipit.yaml"),
    );

    copyAcceptedInstall(workspaceDir, forkWorkspace);

    expect(readAcceptedInstall(forkWorkspace)).toMatchObject({ commands: ACCEPTED });
    expect(evaluateInstallGate({ workspaceDir: forkWorkspace, requested: CHANGED }).withheld).toBe(true);
  });

  /**
   * The case the flag exists for. Requirement 12's on-disk evidence
   * (`plugin-data/`) is what stops a plugin deleting its own `plugins.use` entry
   * in the same write that changes `agent.install`. A fork defeats that by
   * construction — it clones the workspace and nothing else — so a hidden
   * plugin's list would otherwise escape the gate entirely in the fork.
   */
  it("keeps a fork gated even when the plugin deleted its own declaration", () => {
    installSucceeded(ACCEPTED);
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ pluginBearing: true });

    const forkWorkspace = path.join(root, "sessions", "fork-hidden", "workspace");
    fs.mkdirSync(forkWorkspace, { recursive: true });
    // The plugin removed itself from the config in the same write. The fork
    // therefore has no declaration AND no plugin-data — both halves of
    // `sessionHasPlugin` answer false.
    fs.writeFileSync(
      path.join(forkWorkspace, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(CHANGED[0])}\n`,
    );
    expect(sessionHasPlugin(forkWorkspace)).toBe(false);

    copyAcceptedInstall(workspaceDir, forkWorkspace);

    expect(evaluateInstallGate({ workspaceDir: forkWorkspace, requested: CHANGED })).toMatchObject({
      withheld: true,
      accepted: ACCEPTED,
    });
  });

  /**
   * Found by review, and the reason the copy re-reads the parent's LIVE
   * evidence rather than trusting the record alone.
   *
   * The flag is refreshed only when an install completes. A session that
   * accepted its list while plugin-free carries `false` until the next
   * successful install — and a plugin arriving in that window is withheld on the
   * parent (its `plugin-data/` is live evidence) but never causes an accept, so
   * nothing updates the record. A fork taken then inherited `false`, found no
   * evidence of its own, and ran exactly what the parent was refusing.
   */
  it("gates a fork taken after a plugin arrived but before the next install", () => {
    // The session accepted its list while genuinely plugin-free.
    fs.rmSync(path.join(sessionRoot, "plugin-data"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(ACCEPTED[0])}\n`,
    );
    installSucceeded(ACCEPTED);
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ pluginBearing: false });

    // A plugin then arrives, changes `agent.install`, and hides its declaration.
    // No install completes, so the stale `false` is never refreshed.
    fs.mkdirSync(path.join(sessionRoot, "plugin-data", "probe"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(CHANGED[0])}\n`,
    );
    // The parent is protected by its live on-disk evidence.
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(true);

    const forkWorkspace = path.join(root, "sessions", "fork-window", "workspace");
    fs.mkdirSync(forkWorkspace, { recursive: true });
    fs.copyFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      path.join(forkWorkspace, "shipit.yaml"),
    );
    copyAcceptedInstall(workspaceDir, forkWorkspace);

    // The fork has neither declaration nor plugin-data of its own.
    expect(sessionHasPlugin(forkWorkspace)).toBe(false);
    expect(evaluateInstallGate({ workspaceDir: forkWorkspace, requested: CHANGED })).toMatchObject({
      withheld: true,
      accepted: ACCEPTED,
    });
  });

  /**
   * Found by review. Fail-closed on the parent must not become fail-open on the
   * child. An unreadable parent record resolves to an EMPTY command list, and
   * the copy used to treat that the same as "nothing to carry" — so the fork
   * inherited the plugin-mutated workspace and no record at all, read as a first
   * install, and ran the changed list.
   */
  it("carries the gated-unknown state when the parent's record is unreadable", () => {
    installSucceeded(ACCEPTED);
    fs.writeFileSync(acceptedFile, "{tru");
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ commands: [], pluginBearing: true });

    const forkWorkspace = path.join(root, "sessions", "fork-corrupt", "workspace");
    fs.mkdirSync(forkWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(forkWorkspace, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(CHANGED[0])}\n`,
    );
    copyAcceptedInstall(workspaceDir, forkWorkspace);

    expect(sessionHasPlugin(forkWorkspace)).toBe(false);
    expect(evaluateInstallGate({ workspaceDir: forkWorkspace, requested: CHANGED }).withheld).toBe(true);
  });

  it("does not gate a fork whose parent never had a plugin", () => {
    // The flag is the ONLY thing that can gate a plugin-free session, so it must
    // not be set by a session that never had one.
    fs.rmSync(path.join(sessionRoot, "plugin-data"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(ACCEPTED[0])}\n`,
    );
    recordAcceptedInstall(workspaceDir, ACCEPTED);
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ pluginBearing: false });

    const forkWorkspace = path.join(root, "sessions", "fork-plain", "workspace");
    fs.mkdirSync(forkWorkspace, { recursive: true });
    copyAcceptedInstall(workspaceDir, forkWorkspace);
    expect(evaluateInstallGate({ workspaceDir: forkWorkspace, requested: CHANGED }).withheld).toBe(false);
  });

  // Once true it stays true, the same one-way property `plugin-data/` has: a
  // plugin must not be able to clear the evidence that it ran by arranging for
  // one later install to complete while it looks absent.
  it("never loses the flag once set", () => {
    installSucceeded(ACCEPTED);
    fs.rmSync(path.join(sessionRoot, "plugin-data"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(ACCEPTED[0])}\n`,
    );
    recordAcceptedInstall(workspaceDir, ACCEPTED);
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ pluginBearing: true });
  });

  it("carries nothing from a parent that never completed an install", () => {
    const forkWorkspace = path.join(root, "sessions", "fork-2", "workspace");
    fs.mkdirSync(forkWorkspace, { recursive: true });
    copyAcceptedInstall(workspaceDir, forkWorkspace);
    // A first-install session for real — nothing to inherit, nothing invented.
    expect(readAcceptedInstall(forkWorkspace)).toBeNull();
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
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({
      commands: [],
      // Fails closed on both fields: the file's existence is evidence that
      // something was accepted here, so it must still gate.
      pluginBearing: true,
    });
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
    // Plugin-free from the START. Removing `plugin-data` from a session that
    // once had a plugin does NOT make it plugin-free — the recorded flag is
    // sticky precisely so a plugin cannot erase the evidence that it ran, which
    // the sibling test below pins.
    fs.rmSync(path.join(sessionRoot, "plugin-data"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(ACCEPTED[0])}\n`,
    );
    installSucceeded(ACCEPTED);
    expect(readAcceptedInstall(workspaceDir)).toMatchObject({ pluginBearing: false });

    fs.writeFileSync(
      path.join(workspaceDir, "shipit.yaml"),
      `agent:\n  install:\n    - ${JSON.stringify(CHANGED[0])}\n`,
    );
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

/**
 * `preStampInstallMarker` writes a marker asserting the mounted base already
 * satisfies this checkout. An earlier revision gated it on the trust verdict,
 * because a marker written there used to BE the accepted list — so the base
 * pointer could walk a command list into a session that never accepted it.
 *
 * With acceptance in its own record, that gate is redundant and was removed: the
 * pre-stamp is a dependency-correctness mechanism again, and nothing it writes
 * can move what this session has accepted.
 */
describe("the pre-stamp cannot move the accepted list", () => {
  it("stamping a base pointer's list does not make that list accepted", async () => {
    rotateUnderSession();
    // The pointer matches on every axis the pre-stamp checks — commit,
    // generation, runtime key, and the command list — for the CHANGED list.
    const stamped = await preStampInstallMarker({
      stateDir: path.join(root, "state"),
      workspaceDir,
      specs: [makeSpec(2)],
      readPointer: () => pointerFor(CHANGED, 2),
    });
    expect(stamped).toBe(true);
    // ...and the gate is unmoved: the record still says ACCEPTED.
    expect(acceptedInstallCommands(workspaceDir)).toEqual(ACCEPTED);
    expect(evaluateInstallGate({ workspaceDir, requested: CHANGED }).withheld).toBe(true);
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
