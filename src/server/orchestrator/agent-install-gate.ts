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
 * The command list this session has **accepted** — the durable answer to the one
 * question the gate asks, kept independently of the install marker.
 *
 * ## Why this is not the marker, and not a tombstone beside it
 *
 * The marker was being asked to carry two facts that are not the same claim:
 * "these dependencies are installed" and "the user accepted this command list".
 * The first is a property of a `node_modules` tree and is *correctly* discarded
 * whenever that tree stops being trustworthy. The second is a property of the
 * SESSION and must survive everything short of the session changing hands.
 *
 * An earlier revision preserved it by writing a tombstone at each place that
 * deletes the marker. That enumeration cannot be completed, which is the whole
 * problem with it: four deleters exist (a base rotation, a blocked-session cache
 * reclaim, disk-tier eviction of `state/`, and a claim handing the clone on), and
 * the fifth is **in another process** — the session worker whiteouts the marker
 * before every real reinstall and deliberately writes none if that reinstall
 * fails (`install-controller.ts`). So a stale-marker reinstall that failed left
 * an established, plugin-bearing session with no marker and no tombstone, where
 * `null` reads as "first install" and ALLOWS. Enumerating deleters can only ever
 * be a race against the next one somebody adds.
 *
 * So acceptance is recorded at the moment acceptance actually happens — when an
 * install completes with positive evidence ({@link recordAcceptedInstall}, from
 * `runInstall`). One writer, no enumeration, and no deletion of dependency state
 * can move it. `null` here now means what it always claimed to: no install has
 * ever completed in this session, which is exactly the first-time case the
 * docs/178 repo-trust decision covers.
 *
 * ## Why it is NOT under `state/`
 *
 * That subtree is in `REGENERABLE_SESSION_SUBDIRS` (`disk-utils.ts`) — disk-tier
 * eviction and archive delete all of it, correctly, because every artifact in it
 * can be rebuilt. An acceptance record cannot. Worse, `plugin-data/` is a
 * deliberately DURABLE sibling (`plugin-state.ts`), so an evicted-and-restored
 * session comes back still plugin-bearing; if its anchor went with `state/`, the
 * restore alone would hand the credential-bearing container a command list nobody
 * accepted.
 *
 * So it goes where the other durable, non-git session data goes: a sibling of
 * `workspace/`, the `uploads/` convention (docs/217) that the reclaim allowlist
 * leaves alone. `claim-session.ts` clears it when a clone changes hands — a new
 * occupant inherits no acceptance. No plugin container mounts the session root,
 * so the containment property is unchanged.
 */
export const INSTALL_ACCEPTED_FILE = ".install-accepted";

/** @see INSTALL_ACCEPTED_FILE */
export interface AcceptedInstallRecord {
  /**
   * The list that last completed. An EMPTY array is the deliberate answer for a
   * record that exists but cannot be read: something was accepted and we no
   * longer know what, which withholds. See {@link readAcceptedInstall}.
   */
  commands: string[];
  /** ISO timestamp — diagnostics only, never compared. */
  at: string;
}

export interface InstallGateVerdict {
  /** True when the requested commands must NOT be handed to the worker. */
  withheld: boolean;
  /** The command list that IS in force — the marker's. Empty when none. */
  accepted: string[];
  /** True when this exact list was already reported; suppresses a repeat. */
  alreadyReported: boolean;
  /**
   * True when this withhold lands on a session whose install marker ShipIt
   * deleted and has not replaced — an outstanding {@link INSTALL_RESET_FILE}.
   *
   * This is the combination that produced the incident: two subsystems each
   * behaving correctly (delete the marker so the install re-runs / refuse to run
   * a changed install) and nothing reconciling them. Withholding stays right —
   * requirement 4 is that a plugin's command never runs unattended — so what the
   * flag buys is the ability to say so instead of leaving the user with
   * `sh: 1: vite: not found`.
   *
   * Note what it deliberately does NOT claim: that the dependencies ARE broken.
   * An earlier revision tried to prove the harmless case by checking whether the
   * reaped overlay upper layer had held anything, and that check is unsound — an
   * empty upper says the OLD lower satisfied this checkout, and says nothing at
   * all about the NEW one the session is about to mount. ShipIt cannot tell.
   * Saying "unverified" is the honest signal, and it is the one the
   * `DependencyGap` surfaces are built to carry.
   */
  afterDependencyReset: boolean;
}

const ALLOW: InstallGateVerdict = {
  withheld: false,
  accepted: [],
  alreadyReported: false,
  afterDependencyReset: false,
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
  const record = readAcceptedInstall(workspaceDir);
  if (record) return record.commands;
  // Migration only. A session that accepted a list BEFORE this record existed has
  // no record and may still have the marker that list wrote; reading it keeps
  // that session's anchor rather than silently promoting it to "never accepted
  // anything". It is a strictly weaker source — the marker is deleted by five
  // different paths — so it is the fallback and never the answer when a record
  // exists. `evaluateInstallGate` backfills a record from it on the first
  // withhold, after which this branch is dead for that session.
  return markerInstallCommands(workspaceDir);
}

/**
 * The `installCommands` of the marker on disk, or `null` when there is none to
 * read (absent, unreadable, or not a current stamped marker).
 */
function markerInstallCommands(workspaceDir: string): string[] | null {
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
 * Where the durable acceptance record lives — a session-root sibling.
 *
 * **This THROWS**, and every caller resolves it inside its own `try` for that
 * reason: `sessionStateDirForWorkspace` refuses a clone that does not sit at
 * `<sessionDir>/workspace` (planning#288 — such a session is deliberately
 * unserviceable rather than silently sharing one state dir with every other
 * flat-layout session on the host).
 *
 * Resolving it outside the `try` is not a style slip, it is a destructive bug.
 * {@link readAcceptedInstall} is reached from {@link evaluateInstallGate}, which
 * is reached from the top of `runInstall`, whose caller maps a throw to
 * `{ ok: false }` — and a failed install latches every `dependsOnInstall` service
 * to `error` with "agent.install failed" on it. A layout ShipIt cannot service
 * would take the compose stack down under a diagnosis naming the wrong cause.
 */
function acceptedRecordPath(workspaceDir: string): string {
  return path.join(sessionRootForWorkspace(workspaceDir), INSTALL_ACCEPTED_FILE);
}

/**
 * Record that this session has accepted `commands` — called when an install
 * completes with positive evidence that it ran (or that the worker's
 * content-keyed marker proved the tree already matched).
 *
 * This is the ONLY writer, which is the design: acceptance is recorded where
 * acceptance happens, so no amount of dependency-state deletion — by this
 * process or the worker's — can move it. See {@link INSTALL_ACCEPTED_FILE}.
 *
 * **Atomic** (temp + rename), so a reader sees the old record or the new one and
 * never half of either; a torn write would otherwise be indistinguishable from a
 * corrupt one, which withholds. Best-effort: a failed write leaves the PREVIOUS
 * accepted list standing, which withholds the new one until an install succeeds
 * again. That is the safe direction — it costs a notice, never an execution.
 */
export function recordAcceptedInstall(workspaceDir: string, commands: string[]): boolean {
  let tmp: string | null = null;
  try {
    const file = acceptedRecordPath(workspaceDir);
    tmp = `${file}.tmp`;
    const record: AcceptedInstallRecord = { commands, at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ } }
    console.warn(
      "[install-gate] could not persist the accepted-install record; the previously " +
      "accepted list stays in force:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * What this session has accepted, or `null` when it has accepted nothing.
 *
 * A record that is PRESENT but unreadable resolves to an EMPTY command list, not
 * to `null`, and the difference is the point. `null` means "nothing was ever
 * accepted", which allows — right for a first-time session and wrong here, where
 * the file's existence is itself the evidence that something WAS accepted and we
 * have lost track of what. An empty list matches no request, so the gate
 * withholds and the notice says the in-force list is unknown.
 */
export function readAcceptedInstall(workspaceDir: string): AcceptedInstallRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(acceptedRecordPath(workspaceDir), "utf8");
  } catch (err) {
    // Absent is the ordinary case. A path that will not resolve at all is the
    // unserviceable-layout throw described on `acceptedRecordPath` — no session
    // root, so no record, and never an exception into the install path.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === undefined) return null;
    // Anything else (EACCES, EIO) is a record we cannot read, not one absent.
    return { commands: [], at: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { commands: [], at: "" };
  }
  if (!parsed || typeof parsed !== "object") return { commands: [], at: "" };
  const r = parsed as Record<string, unknown>;
  if (Array.isArray(r.commands) && r.commands.every((c) => typeof c === "string")) {
    return { commands: r.commands, at: typeof r.at === "string" ? r.at : "" };
  }
  return { commands: [], at: "" };
}

/**
 * Drop the acceptance record. Used only when the session's clone changes hands
 * (`claim-session.ts`) — a new occupant inherits nothing.
 */
export function clearAcceptedInstall(workspaceDir: string): void {
  try {
    fs.rmSync(acceptedRecordPath(workspaceDir), { force: true });
  } catch {
    /* Best-effort; the next completed install overwrites it anyway. */
  }
}

/**
 * Is the install marker absent — i.e. has the dependency tree stopped being
 * vouched for?
 *
 * Derived rather than stored, which is what lets it cover every route to that
 * state without enumerating them: a base rotation, a cache reclaim, disk-tier
 * eviction, and the worker's own whiteout-before-reinstall (which writes no
 * marker back if the install fails). A withhold landing here is the incident —
 * the reinstall that was supposed to rebuild the tree did not run.
 */
function installMarkerAbsent(workspaceDir: string): boolean {
  try {
    return !fs.existsSync(path.join(sharedStateDirFor(workspaceDir), INSTALL_MARKER_FILE));
  } catch {
    return true;
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
  // Migration: a session that accepted a list before the record existed answers
  // from its marker. Persist that answer the first time we need it, so the
  // session stops depending on a marker five different paths delete. Cheap and
  // idempotent — `readAcceptedInstall` short-circuits every later call.
  if (readAcceptedInstall(workspaceDir) === null) recordAcceptedInstall(workspaceDir, accepted);
  if (sameCommands(accepted, requested)) return ALLOW;

  const reported = reportedWithheldCommands(workspaceDir);
  return {
    withheld: true,
    accepted,
    alreadyReported: reported !== null && sameCommands(reported, requested),
    afterDependencyReset: installMarkerAbsent(workspaceDir),
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
