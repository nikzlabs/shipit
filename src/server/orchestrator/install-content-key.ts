/**
 * Say at session **setup** when the content-keyed install skip is off, instead
 * of leaving the user to discover it from a failure (follow-up to
 * nikzlabs/shipit#2429 and PR #2491).
 *
 * When `agent.install` is not a recognized pure dependency install and
 * `agent.install-inputs` is not declared, `resolveDepsHashInputs`
 * (`shared/deps-hash.ts`) yields no input set, and ShipIt silently:
 *
 *   - disables the content key, so every resume on a new commit re-runs the
 *     whole install even when the manifest and lockfile never moved; and
 *   - disables the post-rewrite dependency re-check —
 *     `notifyWorkspaceRewritten` takes its `not-content-keyed` branch and
 *     records a `DependencyGap` (`dependency-staleness.ts`) rather than
 *     reinstalling.
 *
 * Both defaults are right (a `null` deps hash can never match the marker, so an
 * auto-reinstall would mean a full rebuild after every rewrite). What was wrong
 * is *when* the user found out: only after a failure, via the #2429 gap notice,
 * by which point they are usually mid-debug on a `Failed to resolve import`
 * that reads like a code fault.
 *
 * So this is the same fact, told at a different moment and with a different
 * weight. The gap notice fires **after** a rewrite and says the installed
 * dependencies may no longer match the tree — an incident. This fires at
 * **setup** and says content-keying is off — a configuration observation, and
 * therefore the diagnostics panel (docs/124), which is already where "your
 * `shipit.yaml` says something ShipIt could not honour" lives. No transcript
 * notice and no agent prompt prefix: #2491 owns the agent-facing channel for
 * the failure case, and duplicating it here would have a session that hits both
 * read two paragraphs that sound the same.
 *
 * **Detection and reporting only.** Nothing here changes what installs run,
 * whether they re-run, or `notifyWorkspaceRewritten`'s decision.
 *
 * ## Why a file rather than runner state
 *
 * The record is what the diagnostics endpoint reads, and it is also what keeps
 * the operator log line to once per *distinct* command list rather than once
 * per container recreate or activation — `setupServiceManager` runs on every
 * one of those, and a user who has not acted would otherwise collect a line per
 * resume. Keying on the command list means a repository that changes its
 * `agent.install` is told again, and one that does not stays quiet.
 *
 * That is exactly the shape of docs/271's `INSTALL_WITHHELD_FILE`, and it lives
 * beside it for the same reasons: `<sessionDir>/state/shared/` survives a
 * container recreate, sits outside the clone, and is mounted by no plugin
 * container.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveDepsHashInputs } from "../shared/deps-hash.js";
import { sameCommands } from "../shared/install-marker.js";
import type { AgentConfig } from "../shared/shipit-config.js";
import { sessionSharedStateDir, sessionStateDirForWorkspace } from "./session-state-dir.js";

/**
 * Records the command list this session was last told about, beside the install
 * marker. Present exactly while the condition holds — cleared as soon as the
 * config resolves an input set again, so the diagnostics panel cannot keep
 * reporting a state the repo has since fixed.
 */
export const CONTENT_KEY_OFF_FILE = ".install-not-content-keyed";

/** What the diagnostics payload carries when content-keying is off. */
export interface InstallContentKeyOff {
  /** `agent.install` as declared — the list that produced no input set. */
  commands: string[];
  /** The rendered explanation + remedy, ready for the panel. */
  notice: string;
}

/** The `agent` fields this module reads. */
export type ContentKeyConfig = Pick<AgentConfig, "install" | "installInputs">;

/**
 * Is the content-keyed install skip off for this config?
 *
 * Three guards, all required. A repository with **no install** has nothing to
 * warn about. One that declares **`install-inputs`** has made the choice
 * deliberately — including an explicit empty list, which opts out on purpose.
 * Otherwise the answer is whatever the runner itself resolves: a `null` input
 * set is what `setDepReinstallInputs` turns into the empty watch set, so this
 * predicate is true in exactly the cases where both halves above are disabled.
 * (That includes the input-free installs — `uv venv`, `python3 -m venv` — which
 * are *recognized* yet still hash to nothing.)
 */
export function contentKeyingIsOff(agent: ContentKeyConfig): boolean {
  if (agent.install.length === 0) return false;
  if (agent.installInputs !== null) return false;
  return resolveDepsHashInputs(agent.install, agent.installInputs) === null;
}

/**
 * Every entry point takes the session's **clone** — `workspaceDir`, e.g.
 * `/workspace/sessions/{uuid}/workspace` — and derives the state dir from it,
 * exactly as `agent-install-gate.ts` does and for the reason documented there:
 * `ContainerSessionRunner.sessionDir` *is* the clone, and reading one level too
 * deep fails silently rather than loudly.
 */
function sharedStateDirFor(workspaceDir: string): string {
  return sessionSharedStateDir(sessionStateDirForWorkspace(workspaceDir));
}

/** The command list this session was last told about, if any. */
export function reportedContentKeyOff(workspaceDir: string): string[] | null {
  try {
    const raw = fs.readFileSync(path.join(sharedStateDirFor(workspaceDir), CONTENT_KEY_OFF_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((c) => typeof c === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Remember that this list was reported. Best-effort on purpose: a failed write
 * costs a repeated log line and a missing panel row, never a wrong install, so
 * it must not throw into the setup path.
 */
function recordContentKeyOff(workspaceDir: string, commands: string[]): void {
  try {
    const dir = sharedStateDirFor(workspaceDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONTENT_KEY_OFF_FILE), JSON.stringify(commands));
  } catch {
    /* A repeated line is the whole cost. */
  }
}

/** Drop the record — the config now resolves an input set. */
function clearContentKeyOff(workspaceDir: string): void {
  try {
    fs.rmSync(path.join(sharedStateDirFor(workspaceDir), CONTENT_KEY_OFF_FILE), { force: true });
  } catch {
    /* Same: reporting only. */
  }
}

/**
 * Evaluate the condition for a session and bring its record up to date.
 *
 * Returns `true` only when the state is **newly** reportable — the condition
 * holds for a command list this session has not been told about — which is the
 * caller's cue to log. Every other outcome (already reported, or no longer
 * applicable) returns `false`, so calling this on every setup and every
 * `shipit.yaml` change is quiet by construction.
 */
export function evaluateContentKeyReport(workspaceDir: string, agent: ContentKeyConfig): boolean {
  if (!contentKeyingIsOff(agent)) {
    if (reportedContentKeyOff(workspaceDir) !== null) clearContentKeyOff(workspaceDir);
    return false;
  }
  const reported = reportedContentKeyOff(workspaceDir);
  if (reported !== null && sameCommands(reported, agent.install)) return false;
  recordContentKeyOff(workspaceDir, agent.install);
  return true;
}

/** The diagnostics field for a session — `null` when there is nothing to say. */
export function installContentKeyDiagnostic(workspaceDir: string): InstallContentKeyOff | null {
  const commands = reportedContentKeyOff(workspaceDir);
  return commands === null ? null : { commands, notice: contentKeyOffNotice(commands) };
}

/** Render the declared install commands, one indented line each. */
function renderCommands(commands: string[]): string {
  return commands.length === 0 ? "    —" : commands.map((c) => `    ${c}`).join("\n");
}

/**
 * What the panel says.
 *
 * It names the consequence in both halves — the repeated full install, and the
 * re-check ShipIt cannot perform after it rewrites the tree — and then points
 * at the decision rule rather than restating it, because the remedy is not one
 * answer: `install-inputs` is right for an enumerable step and a **trap** for a
 * whole-source-tree build, and only the shipped doc carries the whole rule.
 *
 * It also opens by saying nothing is broken. The #2429 notice this could
 * otherwise be mistaken for reports a tree that has already moved; this one
 * reports a configuration, before anything has happened.
 */
export function contentKeyOffNotice(commands: string[]): string {
  return [
    "`agent.install` declares a step ShipIt does not recognize as a dependency install, and " +
      "`agent.install-inputs` is not declared — so ShipIt cannot tell which files this install " +
      "consumes, and the content-keyed install skip is **off** for this session.",
    "",
    "Declared install:",
    renderCommands(commands),
    "",
    "Nothing is broken by this. Two things become slower or manual:",
    "• every resume on a new commit re-runs the whole install, even when the manifest and " +
      "lockfile never moved; and",
    "• after ShipIt rewrites this session's working tree from outside the container (a sync onto " +
      "the base, a rollback, a post-merge reset) it cannot re-check the dependencies, so " +
      "re-running the install is left to you.",
    "",
    "There are two remedies and the right one depends on the extra step: declare " +
      "`agent.install-inputs` when the step's inputs are enumerable, or move the step into the " +
      "service `command:` when it consumes the whole source tree — where `install-inputs` is a " +
      "trap. The rule is in `/shipit-docs/shipit-yaml.md` under “When `install-inputs` is the " +
      "answer, and when it is a trap”.",
  ].join("\n");
}
