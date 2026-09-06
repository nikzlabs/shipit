/**
 * docs/266-plugin-install-diagnosability reqs 3, 4 — what happened the last time ShipIt tried to install a
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
 * **That is also where a successful install's output is retained**
 * (planning#416). The alternative shapes both lose: a file per generation grows
 * with the clock and would need its own pruning, in a subsystem whose rule is to
 * prune where the leak happens; and returning the output only to the invocation
 * that produced it answers only inside the turn that ran the refresh, while the
 * session that has to diagnose a broken plugin characteristically opens onto one
 * and runs no round of its own. One bounded field in one existing file per
 * repository buys the retention with no new file and no new sweep. What it does
 * not buy is history — this is the LAST install, and every reader compares its
 * `commit` with the live one before drawing a verdict (`describesLive` in
 * `services/plugin-status.ts`).
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
  /**
   * planning#511 — the BUILD the attempt was for
   * (docs/273-plugin-generation-rebuild): usually the commit, and
   * `<commit>.<8 hex>` for a rebuild of a commit that is already live.
   *
   * The commit alone does not identify a build, and a rebuild is exactly when
   * that matters: a forced re-install of the live commit under a new id can
   * install differently, fail the pre-publish gate, and leave the previous
   * generation serving — so a reader gating on the commit would describe the
   * rejected build as a property of the one that is running. Absent on records
   * written before this field existed, which is why every reader treats it as
   * fail-closed rather than falling back to the commit.
   */
  generationId?: string;
  /** ISO timestamp of the attempt. */
  at: string;
  outcome: PluginInstallOutcome;
  /**
   * The failure text the round would have reported, already bounded by
   * `plugin-install.ts` (`exited 1` plus the tail of the command's output), or a
   * one-line explanation for the skipped and not-run outcomes.
   */
  detail?: string;
  /**
   * planning#416 — the tail of what the install actually PRINTED, on success as
   * well as on failure, bounded by `plugin-install.ts` to the same 40 lines and
   * 2000 characters a failure reason gets.
   *
   * It is a separate field from `detail` rather than an extension of it because
   * the two answer different questions: `detail` is why the round failed (and is
   * absent when it did not), `output` is what the command said. The failing
   * command's tail therefore appears in both, and that overlap is the price of
   * `output` meaning one thing whatever the outcome — a reader that had to parse
   * it out of a prose reason is a reader that will get it wrong.
   *
   * Absent when nothing ran and nothing before it did either — which is itself
   * part of the answer: no output because no command, not because it was lost.
   *
   * **One exception, and it is the reason `outcome` and `output` must be read
   * together**: a `skipped-stamp` carries forward the output of the install that
   * BUILT the layer it is reusing, for the same commit. Without it the record
   * would erase its own artifact on the re-stage path (a succeeded install whose
   * publish failed, re-staged and skipped). It is never carried across commits,
   * and never onto `skipped-store`, whose tree was built somewhere this output
   * does not describe.
   */
  output?: string;
  /**
   * planning#511 — why this install's tree is NOT in the shared dependency
   * store, or absent when it is (and on every path that did not complete an
   * install). Advisory: sharing nothing is a complete, correct install, so
   * `outcome` is unaffected and no reader may treat this as a failure.
   *
   * **A rendered sentence rather than a typed reason, and only here.** The
   * reason is typed everywhere it is decided (`plugin-dep-store.ts`); what
   * crosses onto disk is the text, because every reader of this file — the
   * Plugins card, `shipit plugin status`, a human reading the JSON — wants the
   * same sentence, and a kind a future version adds would otherwise reach an
   * older reader as an enum it cannot render.
   */
  depStoreReason?: string;
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
      ...(typeof obj.generationId === "string" ? { generationId: obj.generationId } : {}),
      at: obj.at,
      outcome: obj.outcome,
      ...(typeof obj.detail === "string" ? { detail: obj.detail } : {}),
      ...(typeof obj.output === "string" ? { output: obj.output } : {}),
      ...(typeof obj.depStoreReason === "string" ? { depStoreReason: obj.depStoreReason } : {}),
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
      // planning#416 — a succeeded install is exactly the case where the reader
      // still has a question, so the line says where the answer is rather than
      // stopping at "succeeded". Only when there IS output: pointing at an empty
      // field costs a call and answers nothing.
      //
      // "nothing was captured" and not "it printed nothing", because this module
      // cannot tell those apart: `logTail` is best-effort and answers with the
      // empty string when the daemon would not give it the logs at all.
      return `install succeeded for ${commit} at ${record.at}${
        record.output ? " — its output is in `--json`" : " (no output was captured)"}`;
    case "failed":
      return `install FAILED for ${commit} at ${record.at}${detail}`;
    case "skipped-stamp":
      return `install skipped for ${commit} (this version's layer was already installed)${detail}${
        record.output ? " — `--json` has what the install that built that layer printed" : ""}`;
    case "skipped-store":
      return `install skipped for ${commit} (shared dependency store hit — nothing was run)${detail}`;
    case "not-run":
      return `install NOT RUN for ${commit} (this runtime cannot run plugin installs)${detail}`;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
