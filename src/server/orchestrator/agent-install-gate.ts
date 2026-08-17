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
 * them nothing (docs/271 req 4). Only a plugin container is *below* the
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
 * 2026-08-17 (docs/271 req 6). What changes is only that ShipIt stops
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
 */
import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { parseMarker, sameCommands } from "../shared/install-marker.js";
import { pluginDataRoot } from "./plugin-state.js";
import {
  INSTALL_MARKER_FILE,
  SESSION_WORKSPACE_SUBDIR,
  sessionSharedStateDir,
  sessionStateDir,
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

export interface InstallGateVerdict {
  /** True when the requested commands must NOT be handed to the worker. */
  withheld: boolean;
  /** The command list that IS in force — the marker's. Empty when none. */
  accepted: string[];
  /** True when this exact list was already reported; suppresses a repeat. */
  alreadyReported: boolean;
}

const ALLOW: InstallGateVerdict = { withheld: false, accepted: [], alreadyReported: false };

/** `<sessionDir>/workspace` — the session's clone. */
function workspaceDirFor(sessionDir: string): string {
  return path.join(sessionDir, SESSION_WORKSPACE_SUBDIR);
}

function sharedStateDirFor(sessionDir: string): string {
  return sessionSharedStateDir(sessionStateDir(sessionDir));
}

/**
 * Does this session have a plugin (docs/271 reqs 11, 12)?
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
 * nothing to withhold.
 */
export function sessionHasPlugin(sessionDir: string): boolean {
  try {
    if (resolveShipitConfig(workspaceDirFor(sessionDir)).plugins.uses.length > 0) return true;
  } catch {
    // Fall through to the on-disk evidence.
  }
  try {
    return fs.existsSync(pluginDataRoot(sessionDir));
  } catch {
    return false;
  }
}

/**
 * The command list that last ran to completion in this session, or `null` when
 * there is none to compare against (no marker, unreadable, or not a current
 * stamped marker). `null` always means "allow" at the call site.
 */
export function acceptedInstallCommands(sessionDir: string): string[] | null {
  try {
    const raw = fs.readFileSync(
      path.join(sharedStateDirFor(sessionDir), INSTALL_MARKER_FILE),
      "utf8",
    );
    return parseMarker(raw)?.installCommands ?? null;
  } catch {
    return null;
  }
}

/** The command list most recently withheld and reported, if any. */
export function reportedWithheldCommands(sessionDir: string): string[] | null {
  try {
    const raw = fs.readFileSync(
      path.join(sharedStateDirFor(sessionDir), INSTALL_WITHHELD_FILE),
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
export function recordWithheldCommands(sessionDir: string, commands: string[]): void {
  try {
    const dir = sharedStateDirFor(sessionDir);
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
 * a session with no plugin — the overwhelming majority (docs/271 req 11) — pays
 * one `existsSync` and nothing else.
 */
export function evaluateInstallGate(args: {
  sessionDir: string;
  requested: string[];
}): InstallGateVerdict {
  const { sessionDir, requested } = args;
  if (requested.length === 0) return ALLOW;
  if (!sessionHasPlugin(sessionDir)) return ALLOW;

  const accepted = acceptedInstallCommands(sessionDir);
  if (accepted === null) return ALLOW; // First install — the repo-trust decision covers it.
  if (sameCommands(accepted, requested)) return ALLOW;

  const reported = reportedWithheldCommands(sessionDir);
  return {
    withheld: true,
    accepted,
    alreadyReported: reported !== null && sameCommands(reported, requested),
  };
}

/** Render a command list for the notice, one per line, or a dash when empty. */
function renderCommands(commands: string[]): string {
  return commands.length === 0 ? "—" : commands.map((c) => `    ${c}`).join("\n");
}

/**
 * The transcript notice (docs/271 req 7). It names BOTH lists because the
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
