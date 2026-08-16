/**
 * docs/266 reqs 1–4, 9, 10 — `shipit plugin status`, the session's answer to
 * "is what is live usable, and if not, why".
 *
 * **A read.** It fetches nothing, activates nothing and changes nothing that is
 * live (req 9). That is why it is a verb of its own rather than a flag on
 * `refresh`: the question "why is this broken" must be answerable without
 * running the thing that might change it, and a consumer diagnosing a bad
 * version should not have to move the version to see it.
 *
 * **It projects the Plugins tab's own snapshot** (req 10). Every reason a live
 * version is degraded — a withheld command, a rejected service fragment, a
 * settings mismatch, a manifest warning — is computed by
 * `assemblePluginSnapshot`, the same call the browser route makes. A second
 * implementation would drift, and it would drift precisely on the side that
 * cannot see the card: nikzlabs/shipit#2323's author had a version whose whole
 * problem was already written on a card they could not read from the session.
 *
 * What this file adds to that snapshot is the one fact no card holds: the
 * outcome of the last install (`plugin-install-record.ts`), because an install
 * that FAILED publishes no generation and therefore cannot be described by any
 * live one.
 */

import {
  describeInstallRecord,
  readInstallRecord,
  type PluginInstallRecord,
} from "../plugin-install-record.js";
import { pluginsRoot } from "../plugin-generations.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import type { PluginRepoStatus } from "../../shared/plugin-repos.js";

/** One declared repository, as the agent reads it. */
export interface PluginStatusRepo {
  /** The declaration's local name — what `--tracker`, `refresh` and `from:` use. */
  repo: string;
  /** `owner/repo`, or `self`. */
  source: string;
  /** The ref being executed, or the declared one when nothing is live. */
  ref: string | null;
  /** The exact commit being executed; null for `self` and when nothing is live. */
  commit: string | null;
  status: PluginRepoStatus;
  /**
   * Every reason this repository is not fully usable, in the card's own words.
   * Empty is the answer that means "nothing is wrong that ShipIt can see".
   */
  issues: string[];
  /** The last install attempt for this repository, or null if none has run. */
  install: PluginInstallRecord | null;
  /** One line rendering of {@link install}, so every reader says it the same way. */
  installSummary: string;
  /**
   * Whether a session should expect this plugin's surfaces to work. False for
   * anything the card would not call `active`, and false when the last install
   * did not complete — the combination that reported healthy and was not.
   */
  usable: boolean;
}

export interface PluginStatusResult {
  repos: PluginStatusRepo[];
  /** Declaration-level parse warnings, as the tab shows them. */
  warnings: string[];
  /** Set when the caller named a repository the declaration does not have. */
  error?: string;
}

/**
 * The live version's install problem, in one line, or null when there is none.
 *
 * Takes the record rather than reading it (planning#416): `plugin-refresh.ts`
 * now needs the whole record for its `--json` row, and one read answering both
 * questions is what keeps the row's `install` and its `degraded` line from
 * describing two different attempts if one lands between them.
 *
 * Shared with `plugin-refresh.ts` so the two surfaces cannot disagree about
 * whether the version that is live is usable. Refresh had read only the
 * generation's `manifestWarnings`, which carries the "active but not installed"
 * sentence and nothing else — so after a FAILED install for the live commit the
 * next plain refresh printed `already at <sha>` and said nothing (review
 * finding), which is precisely the silence docs/266 req 7 exists to end.
 */
export function liveInstallProblem(
  record: PluginInstallRecord | null,
  liveCommit: string | null,
): string | null {
  if (!describesLive(record, liveCommit) || !record) return null;
  if (record.outcome !== "failed" && record.outcome !== "not-run") return null;
  return describeInstallRecord(record);
}

/** The snapshot shape this projection needs, kept to what it reads. */
export interface PluginStatusSnapshot {
  repos: {
    name: string;
    source: string;
    ref: string | null;
    commit: string | null;
    status: PluginRepoStatus;
    issues: string[];
  }[];
  warnings: string[];
}

/**
 * Project one session's snapshot into the agent's answer.
 *
 * Pure apart from reading the install record off disk, so the route stays a
 * route and this stays testable without a container runtime.
 */
export function buildPluginStatus(
  workspaceDir: string,
  snapshot: PluginStatusSnapshot,
  repoName?: string,
): PluginStatusResult {
  let pluginsDir: string | null;
  try {
    pluginsDir = pluginsRoot(sessionStateDirForWorkspace(workspaceDir));
  } catch {
    // No resolvable state dir (planning#288). The declaration still describes
    // itself; only the install history is unknowable.
    pluginsDir = null;
  }

  const wanted = repoName?.toLowerCase();
  const matched = wanted
    ? snapshot.repos.filter((r) => r.name.toLowerCase() === wanted)
    : snapshot.repos;
  if (wanted && matched.length === 0) {
    const known = snapshot.repos.map((r) => `\`${r.name}\``).join(", ");
    return {
      repos: [],
      warnings: snapshot.warnings,
      error: snapshot.repos.length > 0
        ? `\`${repoName}\` is not a declared plugin repository. This project declares ${known}.`
        : `\`${repoName}\` is not a declared plugin repository. This project declares none.`,
    };
  }

  return {
    warnings: snapshot.warnings,
    repos: matched.map((repo) => {
      // A `repo: self` import runs the working tree and never installs (req 27),
      // so an install record for it would be a record of something that cannot
      // happen. Reading one anyway would report a stale answer from whatever the
      // name meant before.
      const install = pluginsDir && repo.status !== "self"
        ? readInstallRecord(pluginsDir, repo.name)
        : null;
      return {
        repo: repo.name,
        source: repo.source,
        ref: repo.ref,
        commit: repo.commit,
        status: repo.status,
        issues: repo.issues,
        install,
        installSummary: repo.status === "self"
          ? "no install runs under `repo: self` — `agent.install` prepares the working tree"
          : summarize(install, repo.commit),
        usable: isUsable(repo.status, install, repo.commit),
      };
    }),
  };
}

/**
 * Does this record describe the version that is LIVE?
 *
 * The record is the last attempt for the repository, and the last attempt is
 * routinely for a commit that never became live — a refresh to B fails, B is
 * never published, and A keeps serving (req 15). Reading that record as a
 * verdict on A produces a fabricated diagnosis: "running A / install FAILED for
 * B", which is the exact class of error this feature exists to prevent (review
 * finding). So the record answers for the live version only when it is about it.
 */
function describesLive(install: PluginInstallRecord | null, liveCommit: string | null): boolean {
  return install !== null && liveCommit !== null && install.commit === liveCommit;
}

/**
 * The install line, always honest about WHICH commit the attempt was for.
 *
 * A record for another commit is still worth printing — a consumer chasing a
 * failed refresh wants to see it — but it is labelled as the last attempt
 * rather than as a statement about what is running.
 */
function summarize(install: PluginInstallRecord | null, liveCommit: string | null): string {
  const line = describeInstallRecord(install);
  if (!install || describesLive(install, liveCommit)) return line;
  return `${line} (the last attempt was for a different version than the one live)`;
}

/**
 * "Should the agent expect this to work?"
 *
 * `self` and `active` are the two states that mean yes — and `active` is
 * qualified by the install, because the failure this feature exists for is
 * exactly an `active` card over a version whose install did not put anything
 * there. Two qualifications on that qualification:
 *
 * - the record must describe the LIVE commit ({@link describesLive}), or a
 *   failed refresh to a version that never shipped would condemn the version
 *   that is serving perfectly well;
 * - a skipped install is NOT a no. Skipping is the normal, correct outcome when
 *   the layer or the shared store already holds the tree, and reporting it as
 *   broken would train a reader to ignore this field.
 *
 * **Known limit** (review finding): no record reads as usable. This projection
 * has no manifest, so it cannot tell "declares no install" from "declared one,
 * and the record predates this feature or its write failed" — a generation
 * activated before docs/266 shipped is `active` with no record. The summary line
 * says which of the two it is not, rather than reassuring; closing it properly
 * needs the live manifest, which is a bigger read than this verdict is worth.
 */
function isUsable(
  status: PluginRepoStatus,
  install: PluginInstallRecord | null,
  liveCommit: string | null,
): boolean {
  if (status === "self") return true;
  if (status !== "active") return false;
  if (!install || !describesLive(install, liveCommit)) return true;
  return install.outcome !== "failed" && install.outcome !== "not-run";
}
