/**
 * docs/266 reqs 3, 4 — what happened the last time ShipIt tried to install a
 * plugin repository, written where a session can still read it afterwards.
 *
 * **Why this is not on the generation record.** A failed install publishes no
 * generation (req 15 keeps the prior one live), so the one artifact that says
 * *why* is returned to the round that failed and then exists nowhere. A session
 * that opens onto an already-broken version has no round of its own, which is
 * exactly the wall nikzlabs/shipit#2321's author hit: the install's output was
 * captured, shown on a browser card, and unreachable from the session that had
 * to diagnose it.
 *
 * **Why the install runner writes it and not the activation round.** Two of the
 * five outcomes are decisions the runner alone makes, and both look like success
 * from outside: an install skipped because this generation's own layer is
 * already stamped, and one skipped because the shared dependency store had a
 * tree for these inputs. Telling those apart from a real run is precisely the
 * question that could not be answered — "the install succeeded" and "the install
 * never ran" point at opposite fixes.
 *
 * **Per repository, last-writer-wins.** The question is "what happened the last
 * time", so a record keyed by a generation that was never published could not
 * answer it. It sits beside `generations/`, not inside one.
 *
 * Every write is best-effort: this is a diagnostic, and an install that
 * succeeded must never be reported as failed because a log file could not be
 * written.
 */

import fs from "node:fs";
import path from "node:path";

/** What the last attempt did. All five are reachable; none is inferred. */
export type PluginInstallOutcome =
  /** The install container ran every command and all of them exited 0. */
  | "succeeded"
  /** A command failed, timed out, or the run could not start. `detail` says which. */
  | "failed"
  /** This generation's layer was already installed for these inputs (the stamp). */
  | "skipped-stamp"
  /** req 28 — the shared dependency store had a tree for these inputs. */
  | "skipped-store"
  /** The manifest declares an install and this runtime has no way to run one. */
  | "not-run";

export interface PluginInstallRecord {
  /** The commit the attempt was for — not necessarily the one that is live. */
  commit: string;
  /** ISO timestamp of the attempt. */
  at: string;
  outcome: PluginInstallOutcome;
  /**
   * The failure text the round would have reported, already bounded by
   * `plugin-install.ts` (`exited 1` plus the tail of the command's output), or a
   * one-line explanation for the skipped and not-run outcomes.
   */
  detail?: string;
}

const RECORD_FILE = "last-install.json";

/**
 * Beside `generations/`, so it survives a generation that is never published.
 *
 * Takes the plugins ROOT rather than the session state dir, so this module
 * imports nothing from `plugin-generations.ts` — which imports this one. Every
 * caller already holds `pluginsRoot(stateDir)` or can say it in one call, and a
 * one-way dependency is worth more than the argument it saves.
 */
export function installRecordPath(pluginsDir: string, repoName: string): string {
  return path.join(pluginsDir, repoName, RECORD_FILE);
}

/**
 * Record an attempt. Never throws: a diagnostic that can fail an install is
 * worse than no diagnostic.
 */
export function writeInstallRecord(
  pluginsDir: string,
  repoName: string,
  record: PluginInstallRecord,
): void {
  const file = installRecordPath(pluginsDir, repoName);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  } catch (err) {
    console.warn(`[plugins] ${repoName}: could not record the install outcome:`, message(err));
  }
}

/**
 * The last attempt, or null when there has never been one — which is itself an
 * answer a reader needs: a repository whose manifest declares no install at all
 * never writes here, and neither does one that has not activated yet.
 */
export function readInstallRecord(pluginsDir: string, repoName: string): PluginInstallRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(installRecordPath(pluginsDir, repoName), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.commit !== "string" || typeof obj.at !== "string") return null;
    if (!isOutcome(obj.outcome)) return null;
    return {
      commit: obj.commit,
      at: obj.at,
      outcome: obj.outcome,
      ...(typeof obj.detail === "string" ? { detail: obj.detail } : {}),
    };
  } catch {
    return null;
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<PluginInstallOutcome>([
  "succeeded", "failed", "skipped-stamp", "skipped-store", "not-run",
]);

function isOutcome(value: unknown): value is PluginInstallOutcome {
  return typeof value === "string" && OUTCOMES.has(value);
}

/** One line for a human reader, used by `shipit plugin status` and the card. */
export function describeInstallRecord(record: PluginInstallRecord | null): string {
  // Deliberately not reassuring (review finding): the absence has two causes and
  // this module cannot tell them apart — a repository that declares no install
  // writes nothing here, and so does one whose record was lost or predates the
  // feature. Saying "no install has run" alone would read as "nothing to worry
  // about" for the second.
  if (!record) {
    return "no install record in this session — either this repository declares no install, "
      + "or none has run since ShipIt began recording";
  }
  const commit = record.commit.slice(0, 9);
  const detail = record.detail ? ` — ${record.detail}` : "";
  switch (record.outcome) {
    case "succeeded":
      return `install succeeded for ${commit} at ${record.at}`;
    case "failed":
      return `install FAILED for ${commit} at ${record.at}${detail}`;
    case "skipped-stamp":
      return `install skipped for ${commit} (this version's layer was already installed)${detail}`;
    case "skipped-store":
      return `install skipped for ${commit} (shared dependency store hit — nothing was run)${detail}`;
    case "not-run":
      return `install NOT RUN for ${commit} (this runtime cannot run plugin installs)${detail}`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
