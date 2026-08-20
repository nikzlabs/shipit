/**
 * planning#400 / docs/271 — re-gate `agent.install` so a contained plugin
 * container cannot move its own code into the **agent's** container.
 *
 * ## The route this closes
 *
 * A plugin CLI run and a plugin service each get the session's workspace
 * bind-mounted read-write at `/project` — by design (docs/262 req 19), verified
 * at `plugin-cli-run.ts:444` and `plugin-compose.ts:1131`. Those containers are
 * contained: capabilities dropped, no credential store, restricted egress.
 * `shipit.yaml` is a file on that mount, so a plugin can write `agent.install`,
 * and `agent.install` is executed with `shell: true` in the **session worker**
 * (`install-controller.ts:558-566`), which mounts the credential store at
 * `/credentials` (`session-container.ts:166`). That is the escalation.
 *
 * Note what is NOT the escalation, because it decides the shape of the fix:
 * an `npm postinstall`, a project compose service, and the agent itself all
 * write the workspace at an authority they already hold, so the route gives
 * them nothing (docs/271-agent-install-trust-boundary req 4). Only a plugin container is *below* the
 * executor. And a plugin causing the AGENT to run something is settled and in
 * scope of what declaring a plugin grants — docs/262 req 22 says instructions
 * the agent follows are "the sharpest form of the trust a declaration grants".
 * What is different about `agent.install` is that it is **unattended**: no
 * agent, no transcript, nobody asked.
 *
 * ## What it does NOT do
 *
 * It does not stop a plugin *writing* `shipit.yaml`. docs/262 req 29 settles
 * that a plugin may write the consuming project — "plugins should be able to
 * write to the user repo, that is their purpose" — and that the project's own
 * files are not a containment boundary. Reaffirmed for this feature on
 * 2026-08-17 (docs/271-agent-install-trust-boundary req 6). What changes is only that ShipIt stops
 * *executing* a changed command list unattended.
 *
 * ## Why the marker is the anchor
 *
 * The question "did the user accept THIS command list?" has no direct record,
 * so the gate uses the closest one that exists and that a plugin cannot reach:
 * the install marker's `installCommands` — the list that last ran to completion
 * in this session. It survives a container recreate, and it lives in
 * `<sessionDir>/state/shared/`, which docs/246 moved out of the clone and which
 * no plugin container mounts.
 *
 * Two directions of error were checked. A **missing** marker allows the install:
 * a first-time session has no prior list to contradict, and its `agent.install`
 * is the one the docs/178 repo-trust decision covered. A marker that cannot be
 * parsed is treated as missing for the *gate* decision and so also allows —
 * which is the same direction the existing skip gate errs in, and cannot be
 * worse than today's unconditional re-run.
 *
 * `preStampInstallMarker` cannot launder a plugin's list into the marker: it
 * returns `false` when a marker already exists (`overlay-session.ts:549-550`),
 * so it only ever writes the FIRST one — at container create on a fresh
 * session, before any plugin container has run.
 *
 * **That last paragraph was wrong, and {@link INSTALL_RESET_FILE} is what makes
 * it true again** (the ops finding of 2026-08-20). Two paths delete the marker
 * on an ESTABLISHED session — `prepareOverlayDirs` when the shared dep base
 * rotates under it, and `reclaimBlockedSessionCaches` when disk pressure takes
 * the upper layer — and each one re-opens the pre-stamp's "no marker yet"
 * window on a session a plugin container has already run in. Observed on the
 * prod host: the gate withheld a changed list at 17:11:13 and a fresh marker
 * recorded that same changed list as accepted six seconds later. The list in a
 * base pointer can only come from an install that genuinely ran, so a plugin
 * cannot inject an ARBITRARY command this way — but a list that ran on a fresh
 * session (which docs/271 allows by design, the repo-trust decision covering
 * it) does reach the pointer, and from there the pre-stamp would promote it
 * into an established session's accepted list without anyone accepting it.
 * That is the escalation this gate exists to stop, so both deleters now record
 * the outgoing list here first and the gate reads it in preference to the
 * marker.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { parseMarker, sameCommands } from "../shared/install-marker.js";
import { pluginDataRoot, sessionRootForWorkspace } from "./plugin-state.js";
import {
  INSTALL_MARKER_FILE,
  sessionSharedStateDir,
  sessionStateDirForWorkspace,
} from "./session-state-dir.js";

/**
 * Records the command list most recently withheld, so the transcript notice is
 * emitted once per distinct list rather than once per container.
 *
 * Without it the notice re-fires on every recreate: an idle session resumes,
 * `setupServiceManager` calls `runInstall`, the config still disagrees with the
 * marker, and the same sentence lands in the transcript again. A user who has
 * not acted would collect one per resume.
 *
 * Beside the install marker deliberately — same directory, same "outside the
 * clone, outside every plugin mount" property, and it is meaningless without it.
 */
export const INSTALL_WITHHELD_FILE = ".install-withheld";

/**
 * Records that ShipIt deleted this session's install marker on purpose, and
 * what the marker said when it went. Written by the two deleters that expect
 * `agent.install` to run again afterwards — `prepareOverlayDirs` on a base
 * rotation, `reclaimBlockedSessionCaches` on disk pressure — and cleared by the
 * next install that completes with positive evidence.
 *
 * It carries the two halves the deleted marker was carrying, which are not the
 * same fact and had been conflated:
 *
 *  - the **trust** half (`accepted`) — the list the user's session last ran to
 *    completion, which is the gate's whole anchor. Deleting the marker deleted
 *    it, so the gate lost its memory at exactly the moment a stale-deps session
 *    was most exposed. Preserving it here is what keeps the withhold decision
 *    correct across a rotation, and what stops `preStampInstallMarker` writing a
 *    new one in the window (see the module docstring).
 *  - the **dependency** half (`depsDiscarded`) — whether the delete actually
 *    threw away installed packages. Only then is a withheld reinstall a
 *    dependency gap worth reporting.
 *
 * Beside the install marker, for the same reason {@link INSTALL_WITHHELD_FILE}
 * is: outside the clone and outside every plugin container's mount set.
 */
export const INSTALL_RESET_FILE = ".install-reset";

/** @see INSTALL_RESET_FILE */
export interface InstallResetRecord {
  /**
   * The deleted marker's `installCommands`, or `null` when there was no marker
   * to read or it could not be parsed. `null` means "no anchor was lost", which
   * is the same input the gate already treats as ALLOW — an unreadable marker is
   * a miss in both directions, exactly as before.
   */
  accepted: string[] | null;
  /**
   * Did the delete discard installed packages? `false` is a proof, not a guess:
   * a superseded overlay upper layer with nothing in it held no install delta,
   * so the session's dependencies are whatever the shared base carries either
   * way and a withheld reinstall costs it nothing. Distinguishes the incident
   * session from the control session that took the same rotation, the same
   * withhold, and came up serving (ops sweep, 2026-08-20).
   */
  depsDiscarded: boolean;
}

export interface InstallGateVerdict {
  /** True when the requested commands must NOT be handed to the worker. */
  withheld: boolean;
  /** The command list that IS in force — the marker's. Empty when none. */
  accepted: string[];
  /** True when this exact list was already reported; suppresses a repeat. */
  alreadyReported: boolean;
  /**
   * True when this withhold lands on a session whose installed packages ShipIt
   * itself discarded and has not rebuilt — a {@link INSTALL_RESET_FILE} record
   * with `depsDiscarded`. Only meaningful when `withheld` is true; the allow
   * path does not pay the read.
   *
   * This is the combination that produced the incident: two subsystems each
   * behaving correctly (delete the marker so the install re-runs / refuse to run
   * a changed install) and nothing reconciling them. Withholding stays right —
   * requirement 4 is that a plugin's command never runs unattended — so what the
   * flag buys is the ability to say so instead of leaving the user with
   * `sh: 1: vite: not found`.
   */
  afterDepsDiscarded: boolean;
}

const ALLOW: InstallGateVerdict = {
  withheld: false,
  accepted: [],
  alreadyReported: false,
  afterDepsDiscarded: false,
};

/**
 * Every entry point here takes the session's **clone** — `workspaceDir`, e.g.
 * `/workspace/sessions/{uuid}/workspace` — and derives the session root and the
 * state dir from it, never the other way round.
 *
 * This is not a stylistic choice. `ContainerSessionRunner.sessionDir` *is* the
 * clone: `route-registry.ts:501` builds runners with `session.workspaceDir`,
 * and `app-lifecycle.ts:685` says so in a comment before taking `path.dirname`
 * of it for the container config. An earlier revision of this module read
 * `<sessionDir>/workspace`, `<sessionDir>/state/shared` and
 * `<sessionDir>/plugin-data` off that value, which lands one level too deep
 * every time — and because `resolveShipitConfig` returns *defaults* for a
 * missing file rather than throwing (`shipit-config.ts:916-930`), the effect was
 * not an error but a permanent, silent `ALLOW`. The gate looked shipped and
 * withheld nothing. Hence the canonical helpers below, and the production-shaped
 * runner test in `container-session-runner.test.ts`.
 */
function sharedStateDirFor(workspaceDir: string): string {
  return sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir));
}

/**
 * Does this session have a plugin (docs/271-agent-install-trust-boundary reqs 11, 12)?
 *
 * Two halves, and the second is the load-bearing one. A declaration in the
 * live config is the obvious reading — but a plugin can delete its own
 * `plugins.use` entry in the SAME write that changes `agent.install`, which
 * makes the session look plugin-free at exactly the moment this runs. So the
 * on-disk evidence is asked for too: `<sessionDir>/plugin-data/` is created
 * when a plugin container is prepared (`plugin-cli-run.ts:433-437`,
 * `plugin-state.ts:407`) and sits outside every mount a plugin container gets —
 * the mount list at `plugin-cli-run.ts:444-453` is the workspace, the plugin's
 * own state dir, and its settings file. A plugin cannot erase the evidence that
 * it exists.
 *
 * An unreadable `shipit.yaml` falls back to the directory check alone, which is
 * safe: an unreadable config resolves no install commands either, so there is
 * nothing to withhold. (A *missing* file does not reach that branch at all —
 * `resolveShipitConfig` returns defaults, with no plugins, which is the same
 * answer by a different route.)
 */
export function sessionHasPlugin(workspaceDir: string): boolean {
  try {
    if (resolveShipitConfig(workspaceDir).plugins.uses.length > 0) return true;
  } catch {
    // Fall through to the on-disk evidence.
  }
  try {
    return fs.existsSync(pluginDataRoot(sessionRootForWorkspace(workspaceDir)));
  } catch {
    return false;
  }
}

/**
 * The command list that last ran to completion in this session, or `null` when
 * there is none to compare against (no marker, unreadable, or not a current
 * stamped marker). `null` always means "allow" at the call site.
 *
 * The reset record OUTRANKS the marker while it exists, which is the whole
 * point of it: between a deliberate marker delete and the next completed
 * install, any marker on disk was written by `preStampInstallMarker` rather than
 * by an install this session ran, so reading it would let the base pointer
 * decide what this session has accepted. Preferring the record needs no
 * agreement from the pre-stamp and survives any future path that writes a
 * marker without running anything.
 *
 * A record that outlives the install that should have cleared it (the clear is
 * best-effort) can only hold an OLDER accepted list, so it errs toward
 * withholding a list the user did in fact accept — a repeated notice, never a
 * wrong execution. That is the same direction every other error case here
 * takes.
 */
export function acceptedInstallCommands(workspaceDir: string): string[] | null {
  const reset = readInstallReset(workspaceDir);
  if (reset) return reset.accepted;
  try {
    const raw = fs.readFileSync(
      path.join(sharedStateDirFor(workspaceDir), INSTALL_MARKER_FILE),
      "utf8",
    );
    return parseMarker(raw)?.installCommands ?? null;
  } catch {
    return null;
  }
}

/**
 * Note that ShipIt deleted this session's install marker and expects
 * `agent.install` to run again. Best-effort, and never throws into a container
 * create or a disk sweep: a record we failed to write costs the protections it
 * carries, but a throw costs the session its container.
 *
 * Written BEFORE the marker is removed at both call sites, so a half-failure
 * lands on "record present, marker present" — the gate withholds against a list
 * that is still the live one, which changes nothing — rather than on "marker
 * gone, no record", which is today's defect.
 */
export function recordInstallReset(workspaceDir: string, record: InstallResetRecord): void {
  try {
    const dir = sharedStateDirFor(workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, INSTALL_RESET_FILE), JSON.stringify(record));
  } catch (err) {
    console.warn(
      "[install-gate] could not record the dependency reset:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** The outstanding reset, or `null` when there is none. */
export function readInstallReset(workspaceDir: string): InstallResetRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(sharedStateDirFor(workspaceDir), INSTALL_RESET_FILE), "utf8"),
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  const accepted =
    Array.isArray(r.accepted) && r.accepted.every((c) => typeof c === "string")
      ? r.accepted
      : null;
  return { accepted, depsDiscarded: r.depsDiscarded === true };
}

/**
 * The reset is answered — an install completed with positive evidence that the
 * tree on disk is installed, so the marker it wrote is once again the honest
 * anchor and the discarded packages are back.
 *
 * Best-effort for the same reason the write is. A leftover record costs a
 * withhold against an older list plus a repeated notice; it cannot cause an
 * install that should not have run.
 */
export function clearInstallReset(workspaceDir: string): void {
  try {
    fs.rmSync(path.join(sharedStateDirFor(workspaceDir), INSTALL_RESET_FILE), { force: true });
  } catch {
    /* A repeated notice is the whole cost. */
  }
}

/** The command list most recently withheld and reported, if any. */
export function reportedWithheldCommands(workspaceDir: string): string[] | null {
  try {
    const raw = fs.readFileSync(
      path.join(sharedStateDirFor(workspaceDir), INSTALL_WITHHELD_FILE),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((c) => typeof c === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Remember that this list was withheld AND reported. Best-effort: a failed write
 * costs a repeated notice, never a wrong execution, so it must not throw into
 * the install path.
 */
export function recordWithheldCommands(workspaceDir: string, commands: string[]): void {
  try {
    const dir = sharedStateDirFor(workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, INSTALL_WITHHELD_FILE), JSON.stringify(commands));
  } catch {
    /* A repeated notice is the whole cost. */
  }
}

/**
 * Decide whether `requested` may be handed to the worker.
 *
 * Order matters for cost as well as correctness: the plugin check runs first so
 * a session with no plugin — the overwhelming majority (docs/271-agent-install-trust-boundary req 11) — pays
 * one `existsSync` and nothing else.
 */
export function evaluateInstallGate(args: {
  /** The session's CLONE — `ContainerSessionRunner.sessionDir`. See above. */
  workspaceDir: string;
  requested: string[];
}): InstallGateVerdict {
  const { workspaceDir, requested } = args;
  if (requested.length === 0) return ALLOW;
  if (!sessionHasPlugin(workspaceDir)) return ALLOW;

  const accepted = acceptedInstallCommands(workspaceDir);
  if (accepted === null) return ALLOW; // First install — the repo-trust decision covers it.
  if (sameCommands(accepted, requested)) return ALLOW;

  const reported = reportedWithheldCommands(workspaceDir);
  return {
    withheld: true,
    accepted,
    alreadyReported: reported !== null && sameCommands(reported, requested),
    afterDepsDiscarded: readInstallReset(workspaceDir)?.depsDiscarded === true,
  };
}

/** Render a command list for the notice, one per line, or a dash when empty. */
function renderCommands(commands: string[]): string {
  return commands.length === 0 ? "—" : commands.map((c) => `    ${c}`).join("\n");
}

/**
 * The transcript notice (docs/271-agent-install-trust-boundary req 7). It names BOTH lists because the
 * user's question on seeing it is "what is my session actually running?", and
 * it names the remedy because requirement 8's answer is "ask the agent" — the
 * agent runs commands in this container already, so that is the same authority
 * exercised where a human can see it, not a weaker one.
 */
export function installWithheldNotice(accepted: string[], requested: string[]): string {
  return [
    "`agent.install` changed and was **not** run.",
    "",
    "This session has a plugin, and plugin containers can write the project — including `shipit.yaml`. " +
      "A changed install command would run in the agent's container, which holds this session's credentials, " +
      "so ShipIt does not run it on its own.",
    "",
    "Still in force:",
    renderCommands(accepted),
    "",
    "Not run:",
    renderCommands(requested),
    "",
    "If you want the new command, ask the agent to run it.",
  ].join("\n");
}
