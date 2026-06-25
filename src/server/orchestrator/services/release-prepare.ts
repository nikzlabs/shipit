/**
 * Release-prepare service (docs/214 Phase 2) — the deterministic, orchestrator-
 * side mechanics behind the `shipit release {plan,prepare}` shim. Centralizing
 * the bump/branch/cherry-pick/PR here (rather than letting the agent hand-edit
 * version files and run `git tag`) is what makes a release un-fumbleable and
 * works for any repo.
 *
 * Two entry points:
 *
 *  - `planRelease` — READ-ONLY. Detect the authoritative version source, compute
 *    the next version (reusing `release-version.ts`), and return the plan. The
 *    route reflects it onto the card as `proposed`.
 *
 *  - `prepareRelease` — the actor. For a FINAL release (the `release-branch`
 *    mechanism): resolve the release (maintenance) branch, build a deterministic
 *    `release/<version>` head branch off `origin/<release-branch>` (force-reset
 *    on a re-run, refusing to clobber a branch carrying foreign commits), apply
 *    the payload (`--pick` cherry-pick for a hotfix, or merge `--from` for a
 *    release-from-main), bump the version source, commit, and open the bump PR
 *    targeting the release branch. The route then drives the poller's
 *    `markPrOpened` — the human-act gate is merging the PR; CI does the publish.
 *
 *    For a PRERELEASE (`--prerelease`): rc's never go through the release branch
 *    (they must not advance the stable channel). They keep a deterministic path
 *    but, lacking a PR-merge gate, the tag push is CONFIRMATION-gated: without
 *    `confirm` we only propose; with it we cut + push the `vX.Y.Z-rc.N` tag
 *    through this broker (never a hand-run `git tag`).
 */

import path from "node:path";
import type { GitManager } from "../../shared/git.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ReleaseBumpType } from "../../shared/types/release-types.js";
import type { ReleaseProposeInput } from "../release-status-poller.js";
import { ServiceError } from "./types.js";
import { agentCreatePr } from "./github.js";
import {
  computeNextVersion,
  detectAllVersionSources,
  parseSemVer,
  parseVersionFromContent,
  readPackageJsonVersion,
  readCargoTomlVersion,
  readPyprojectVersion,
  readVersionFile,
  writeVersionToSource,
  type DetectedVersionSource,
  type VersionSourceType,
} from "../release-version.js";

/** Commit-message trailer stamped on the version-bump commit so a re-run can
 * tell its own tip from a foreign commit pushed onto the open PR. */
const BUMP_TRAILER = "Shipit-Release-Version";

const BUMP_TYPES: ReadonlySet<string> = new Set(["major", "minor", "patch", "prerelease"]);

export interface ReleasePlan {
  /** The current version read from the source. */
  currentVersion: string;
  /** The computed next version (no leading `v`). */
  version: string;
  /** The tag that will be cut, e.g. "v0.3.0". */
  tag: string;
  /** The bump category (or "explicit" when a literal version was given). */
  bumpType: ReleaseBumpType | "explicit";
  /** The version-source ecosystem identifier, e.g. "package.json". */
  versionSource: VersionSourceType;
  /** Absolute path to the version-source file. */
  versionSourcePath: string;
  prerelease: boolean;
  /**
   * docs/214 cold-start guard — set when this is a `release-branch` plan whose
   * maintenance branch can't auto-publish on merge yet (no / legacy workflow).
   * Populated by the route (which has the git handle to read the branch's
   * workflow); the shim surfaces it so a merge never *looks* successful while it
   * will silently no-op. See `release-autopublish-check.ts`.
   */
  warning?: string;
}

export interface PlanReleaseArgs {
  dir: string;
  /** A bump keyword (patch|minor|major|prerelease) or an explicit version. */
  bump?: string;
  prerelease?: boolean;
  /** Monorepo override — path (relative to dir, or absolute) to the version file. */
  versionSourcePath?: string;
  /**
   * Release mechanism (from `shipit.yaml` `release.mechanism`). For
   * `release-branch` the current version is anchored to the maintenance branch
   * (`releaseBranch`) rather than the working tree — see `resolveCurrentVersion`.
   */
  mechanism?: string;
  /** The release (maintenance) branch to anchor the current version to. */
  releaseBranch?: string;
}

/**
 * Resolve the version to bump FROM.
 *
 * For the `release-branch` mechanism the authoritative current version lives on
 * the maintenance branch — it's what was last released, and exactly what CI reads
 * off the merged commit to derive the tag. It is NOT the session working tree's
 * version: the bump PR lands only on `<releaseBranch>` and is never merged back
 * to `main`, so the working tree (branched off `main`) lags every release. Reading
 * the next version from the working tree therefore computes a version at or below
 * what's already published (docs/214 bugfix).
 *
 * Reads the version source at `origin/<releaseBranch>`; falls back to the
 * working-tree version when that branch/file is absent (first release / bootstrap)
 * or for any non-`release-branch` mechanism (where `main` IS the release source).
 * The caller must have fetched `origin` first.
 */
async function resolveCurrentVersion(
  git: GitManager,
  detected: DetectedVersionSource,
  dir: string,
  mechanism: string | undefined,
  releaseBranch: string | undefined,
): Promise<string> {
  if (mechanism !== "release-branch" || !releaseBranch) return detected.version;
  const relPath = path.relative(dir, detected.path!);
  const raw = await git.showFileAtRef(`origin/${releaseBranch}`, relPath);
  if (!raw) return detected.version;
  return parseVersionFromContent(detected.source, raw) ?? detected.version;
}

/**
 * Resolve the version source for a workspace, honoring a `version-source-path`
 * override (monorepo). Throws an actionable `ServiceError` for the no-source and
 * ambiguous-source cases — the agent surfaces the options, the user picks
 * (docs/214, "don't guess").
 */
function resolveSource(dir: string, versionSourcePath?: string): DetectedVersionSource {
  if (versionSourcePath) {
    const abs = path.isAbsolute(versionSourcePath) ? versionSourcePath : path.join(dir, versionSourcePath);
    const base = path.basename(abs);
    const fileDir = path.dirname(abs);
    let source: VersionSourceType;
    let version: string | null;
    switch (base) {
      case "package.json": source = "package.json"; version = readPackageJsonVersion(fileDir); break;
      case "Cargo.toml": source = "Cargo.toml"; version = readCargoTomlVersion(fileDir); break;
      case "pyproject.toml": source = "pyproject.toml"; version = readPyprojectVersion(fileDir); break;
      case "VERSION": source = "VERSION"; version = readVersionFile(fileDir); break;
      default:
        throw new ServiceError(
          400,
          `Unsupported version-source-path "${versionSourcePath}" — expected a package.json, Cargo.toml, pyproject.toml, or VERSION file.`,
        );
    }
    if (!version) {
      throw new ServiceError(400, `Could not read a version from "${versionSourcePath}".`);
    }
    return { source, path: abs, version };
  }

  const sources = detectAllVersionSources(dir);
  if (sources.length === 0) {
    throw new ServiceError(
      400,
      "No version source found (package.json / Cargo.toml / pyproject.toml / VERSION). " +
        "The release-branch mechanism needs an authoritative version file.",
    );
  }
  if (sources.length > 1) {
    const list = sources.map((s) => s.source).join(", ");
    throw new ServiceError(
      400,
      `Multiple version sources detected (${list}). Pick one with --version-source-path <file> ` +
        "(or set release.version-source-path in shipit.yaml) so the release isn't ambiguous.",
    );
  }
  return sources[0];
}

/**
 * Compute the next version + tag for a plan. `bump` is either a bump keyword or
 * an explicit version string. For a prerelease, `{n}` auto-increments from the
 * highest existing `v<core>-rc.N` tag (read from git) so re-cutting an rc lane
 * advances the counter rather than colliding.
 */
async function computePlan(
  git: GitManager,
  current: string,
  bump: string | undefined,
  prerelease: boolean,
): Promise<{ version: string; bumpType: ReleaseBumpType | "explicit" }> {
  // Explicit version literal (contains a dot and parses as semver).
  if (bump && bump.includes(".") && parseSemVer(bump)) {
    return { version: bump.replace(/^v/, ""), bumpType: "explicit" };
  }

  if (prerelease) {
    // Derive the rc core (MAJOR.MINOR.PATCH) the candidate targets, then take
    // the next rc number above the highest existing tag for that core.
    const candidate = computeNextVersion(current, "prerelease");
    if (!candidate) throw new ServiceError(400, `Could not parse the current version "${current}".`);
    const parsed = parseSemVer(candidate)!;
    const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    const existing = await git.listTags(`v${core}-rc.*`);
    let maxN = 0;
    for (const tag of existing) {
      const m = /-rc\.(\d+)$/.exec(tag);
      if (m) maxN = Math.max(maxN, Number(m[1]));
    }
    return { version: `${core}-rc.${maxN + 1}`, bumpType: "prerelease" };
  }

  const bumpType = (bump && BUMP_TYPES.has(bump) ? bump : "patch") as ReleaseBumpType;
  const next = computeNextVersion(current, bumpType);
  if (!next) throw new ServiceError(400, `Could not parse the current version "${current}".`);
  return { version: next, bumpType };
}

/** Read-only release plan: detect source + compute next version (docs/214). */
export async function planRelease(git: GitManager, args: PlanReleaseArgs): Promise<ReleasePlan> {
  const detected = resolveSource(args.dir, args.versionSourcePath);
  // For the release-branch mechanism, anchor the current version to the
  // maintenance branch (what's released) rather than the lagging working tree.
  // Requires a fetch so `origin/<releaseBranch>` is fresh.
  let current = detected.version;
  if (args.mechanism === "release-branch" && args.releaseBranch) {
    await git.fetch("origin");
    current = await resolveCurrentVersion(git, detected, args.dir, args.mechanism, args.releaseBranch);
  }
  const { version, bumpType } = await computePlan(git, current, args.bump, args.prerelease ?? false);
  return {
    currentVersion: current,
    version,
    tag: `v${version}`,
    bumpType,
    versionSource: detected.source,
    versionSourcePath: detected.path!,
    prerelease: args.prerelease ?? false,
  };
}

/**
 * Build the `proposed`-card input from a computed plan + the repo's mechanism.
 * Pulled out of the `POST /release/plan` route so the conditional fields — most
 * importantly `mechanism`, which drives the card's "Confirm & publish" wording
 * (release-branch opens/merges a bump PR; tag-triggered pushes the tag) — are
 * unit-testable without spinning a git remote. Mirrors the marker path in
 * `release-flow.ts`: omit `mechanism` when absent (card defaults to
 * tag-triggered), and omit `bumpType` for an explicit version. (docs/214)
 */
export function buildPlanProposeInput(
  plan: ReleasePlan,
  mechanism: string | undefined,
): ReleaseProposeInput {
  return {
    version: plan.version,
    tag: plan.tag,
    prerelease: plan.prerelease,
    ...(plan.bumpType !== "explicit" ? { bumpType: plan.bumpType } : {}),
    versionSource: plan.versionSource,
    ...(mechanism ? { mechanism: mechanism as ReleaseProposeInput["mechanism"] } : {}),
  };
}

export interface PrepareReleaseArgs extends PlanReleaseArgs {
  remoteUrl?: string;
  /** Final release: the release (maintenance) branch the bump PR targets. */
  releaseBranch: string;
  /** Hotfix payload — commits to cherry-pick onto the release head branch. */
  pick?: string[];
  /** Release-from payload — merge this branch into the release head branch. */
  from?: string;
  /** Bootstrap the release branch off the default base when it's absent. */
  bootstrap?: boolean;
  /**
   * Opt out of the content-free guard — cut a bump-only release on purpose even
   * when the payload brings no new commits over the release branch. Off by
   * default so a bare `prepare` can't silently ship a version-number-only release.
   */
  allowEmpty?: boolean;
  /** Prerelease only: push the rc tag (the confirmation gate). */
  confirm?: boolean;
  /** Notes preview / PR body fragment. */
  notes?: string;
  /** Session id + runner registry — threaded into agentCreatePr's commit flush. */
  sessionId?: string;
  runnerRegistry?: SessionRunnerRegistry;
  chatHistory?: ChatHistoryManager;
}

export type PrepareReleaseResult =
  | {
      kind: "pr-opened";
      version: string;
      tag: string;
      bumpType: ReleaseBumpType | "explicit";
      versionSource: VersionSourceType;
      prerelease: false;
      releaseBranch: string;
      prNumber: number;
      prUrl: string;
      alreadyExisted: boolean;
      /**
       * docs/214 cold-start guard — set when merging this PR into the
       * maintenance branch will NOT auto-publish (the branch lacks the
       * merge-triggered workflow). Populated by the route after `prepare`'s fetch
       * so the post-bootstrap branch state is reflected. See
       * `release-autopublish-check.ts`.
       */
      warning?: string;
    }
  | {
      kind: "prerelease-proposed";
      version: string;
      tag: string;
      versionSource: VersionSourceType;
      prerelease: true;
    }
  | {
      kind: "prerelease-tagged";
      version: string;
      tag: string;
      versionSource: VersionSourceType;
      prerelease: true;
      sha: string;
    };

/**
 * Prepare a release (docs/214). See the module docstring for the two shapes.
 * Returns a discriminated result the route maps onto the poller + shim output.
 */
export async function prepareRelease(
  git: GitManager,
  githubAuth: GitHubAuthManager,
  args: PrepareReleaseArgs,
): Promise<PrepareReleaseResult> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const detected = resolveSource(args.dir, args.versionSourcePath);
  // Fetch up front so `resolveCurrentVersion` reads a fresh `origin/<releaseBranch>`
  // (the release-branch anchor) and the downstream branch resolution sees current
  // refs. `prepareFinalRelease` relies on this fetch too.
  await git.fetch("origin");
  const current = await resolveCurrentVersion(git, detected, args.dir, args.mechanism, args.releaseBranch);
  const { version, bumpType } = await computePlan(git, current, args.bump, args.prerelease ?? false);
  const tag = `v${version}`;

  if (args.prerelease) {
    return preparePrerelease(git, { version, tag, detected, from: args.from, confirm: args.confirm ?? false });
  }

  return prepareFinalRelease(git, githubAuth, args, detected, version, tag, bumpType);
}

/**
 * Prerelease (rc) path — no PR-merge gate, so the tag push is confirmation-gated.
 * Without `confirm`, we return a proposed result (the route shows the card);
 * with it, we cut + push the rc tag at the chosen ref and return it.
 */
async function preparePrerelease(
  git: GitManager,
  opts: { version: string; tag: string; detected: DetectedVersionSource; from?: string; confirm: boolean },
): Promise<PrepareReleaseResult> {
  if (!opts.confirm) {
    return {
      kind: "prerelease-proposed",
      version: opts.version,
      tag: opts.tag,
      versionSource: opts.detected.source,
      prerelease: true,
    };
  }

  // Resolve the ref to tag: the tip of `--from` (after a fetch) or current HEAD.
  let ref: string | undefined;
  if (opts.from) {
    await git.fetch("origin");
    ref = `origin/${opts.from}`;
  }
  await git.createAndPushTag(opts.tag, `Release ${opts.tag}`, "origin", ref);
  const sha = (await git.getHeadHash()) ?? "";
  return {
    kind: "prerelease-tagged",
    version: opts.version,
    tag: opts.tag,
    versionSource: opts.detected.source,
    prerelease: true,
    sha,
  };
}

/**
 * Final release via the release-branch mechanism: build `release/<version>` off
 * `origin/<release-branch>`, apply the payload, bump + commit, force-push, and
 * open the bump PR targeting the release branch.
 */
async function prepareFinalRelease(
  git: GitManager,
  githubAuth: GitHubAuthManager,
  args: PrepareReleaseArgs,
  detected: DetectedVersionSource,
  version: string,
  tag: string,
  bumpType: ReleaseBumpType | "explicit",
): Promise<PrepareReleaseResult> {
  if ((args.pick?.length ?? 0) > 0 && args.from) {
    throw new ServiceError(400, "Pass either --pick (cherry-pick) or --from (merge), not both.");
  }
  if (!(await git.isClean())) {
    throw new ServiceError(409, "The working tree has uncommitted changes — commit or discard them first.");
  }

  // `origin` was already fetched in `prepareRelease` before the version anchor.

  const releaseBranch = args.releaseBranch;
  const headBranch = `release/${version}`;
  const remoteBranches = await git.listRemoteBranches();

  // Resolve the start point: origin/<release-branch>. When the branch is absent,
  // bootstrap it (first release) off the default base — but only on explicit opt-in.
  let startPoint = `origin/${releaseBranch}`;
  if (!remoteBranches.includes(releaseBranch)) {
    if (!args.bootstrap) {
      throw new ServiceError(
        400,
        `The release branch "${releaseBranch}" doesn't exist on the remote. ` +
          "Re-run with --bootstrap to create it from the current base for the first release.",
      );
    }
    const base = remoteBranches.includes("main") ? "main" : remoteBranches.includes("master") ? "master" : null;
    if (!base) throw new ServiceError(400, "Could not resolve a base branch (main/master) to bootstrap from.");
    // Create the maintenance branch on the remote off the base tip.
    await git.createBranchFrom(releaseBranch, `origin/${base}`);
    await git.push("origin", releaseBranch);
    startPoint = `origin/${releaseBranch}`;
  }

  // Re-run guard (docs/214): if the deterministic head branch already exists on
  // the remote AND its tip wasn't authored by this flow (no bump trailer — e.g.
  // a hand-resolved conflict pushed to the open PR), refuse to clobber it.
  if (remoteBranches.includes(headBranch)) {
    const tipMsg = await git.tipCommitMessage(`origin/${headBranch}`);
    if (tipMsg && !tipMsg.includes(`${BUMP_TRAILER}:`)) {
      throw new ServiceError(
        409,
        `The release branch "${headBranch}" carries commits this release flow didn't author ` +
          "(e.g. a hand-resolved conflict on the PR). Refusing to reset it — resolve the PR manually, " +
          "or delete the branch to start over.",
      );
    }
  }

  // Build the deterministic head branch off the release branch (create or reset).
  await git.createBranchFrom(headBranch, startPoint);

  // Apply the payload.
  if (args.pick?.length) {
    const res = await git.cherryPick(args.pick);
    if (!res.success) {
      throw new ServiceError(
        409,
        `Cherry-pick hit a conflict on ${res.conflictedSha ?? "a commit"} — aborted (nothing committed). ` +
          "Resolve it manually, or pick a different commit.",
      );
    }
  } else if (args.from) {
    const ref = remoteBranches.includes(args.from) ? `origin/${args.from}` : args.from;
    // docs/214 — take the incoming branch's tree WHOLESALE, overriding the release
    // branch's divergence. A `--from main` release should ship exactly main's tree
    // at the new version: stable may carry cherry-picked hotfixes, but for a full
    // release those are forward-ported to main anyway, so the release takes main as
    // the source of truth and ignores stable's divergence. The result is a 2-parent
    // merge commit (release-branch tip + incoming ref) whose tree == the incoming
    // ref's, kept a descendant of `origin/<release-branch>` so the bump PR still
    // merges cleanly. Because the tree is replaced rather than three-way merged,
    // this can NEVER conflict — so a release `--from` never bails to manual conflict
    // resolution (impossible inside the brokered, sandbox-forbidden release branch).
    await git.mergeOverride(ref);
  }

  // Content-free guard (docs/214): a bare `prepare` (no --pick/--from) resets the
  // head branch to `origin/<release-branch>` and adds only a bump commit, so the
  // release would ship the version number with zero code changes — identical to
  // what's already released. Refuse an empty payload unless it's a bootstrap
  // (first release legitimately ships everything on the new branch) or the caller
  // explicitly opted in with --allow-empty.
  //
  // The emptiness test differs by path: `--from` always synthesizes an override
  // commit (so a commit count is meaningless — it's always ≥1), and a release is
  // content-free iff the incoming tree *equals* the release branch's tree, so we
  // measure the two-dot file diff `origin/<release-branch>..HEAD` (HEAD now carries
  // the incoming tree). The `--pick` and bare paths add real commits (or none), so
  // they keep counting commits.
  if (!args.bootstrap && !args.allowEmpty) {
    const empty = args.from
      ? (await git.diffStatTwoDot(startPoint)).files === 0
      : (await git.countCommitsAhead(startPoint, "HEAD")) === 0;
    if (empty) {
      throw new ServiceError(
        400,
        `This release would contain no changes — it would ship only the version bump, ` +
          `identical to what's already released on "${releaseBranch}". ` +
          `Pass --from <branch> (e.g. --from main) to bring content into the release, ` +
          `or --allow-empty to cut a bump-only release on purpose.`,
      );
    }
  }

  // Bump the version source + commit (stamped with the re-run guard trailer).
  writeVersionToSource(detected, version);
  const relPath = path.relative(args.dir, detected.path!);
  const lockRel = detected.source === "package.json" ? path.join(path.dirname(relPath), "package-lock.json") : null;
  const message = `Release ${tag}\n\n${BUMP_TRAILER}: ${version}`;
  const commitHash = await git.commitPaths(lockRel ? [relPath, lockRel] : [relPath], message);
  if (!commitHash) {
    throw new ServiceError(500, "Version bump produced no commit (the version may already be set).");
  }

  // Force-push the head branch with a live lease (ShipIt owns release/<version>),
  // so a re-run updates the same branch + open PR rather than non-fast-forward
  // rejecting. agentCreatePr's own (non-force) push is then a harmless no-op.
  await git.forcePush("origin", headBranch);

  const body = buildPrBody(version, tag, releaseBranch, args.notes);
  const pr = await agentCreatePr(git, githubAuth, {
    title: `Release ${tag}`,
    body,
    base: releaseBranch,
    labels: ["release"],
    remoteUrl: args.remoteUrl,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.runnerRegistry ? { runnerRegistry: args.runnerRegistry } : {}),
    ...(args.chatHistory ? { chatHistory: args.chatHistory } : {}),
  });

  return {
    kind: "pr-opened",
    version,
    tag,
    bumpType,
    versionSource: detected.source,
    prerelease: false,
    releaseBranch,
    prNumber: pr.number,
    prUrl: pr.url,
    alreadyExisted: pr.alreadyExisted,
  };
}

/** Build the bump PR body — a short, stable rationale plus optional notes. */
function buildPrBody(version: string, tag: string, releaseBranch: string, notes?: string): string {
  const lines = [
    "## Summary",
    `Version bump to \`${version}\` for release \`${tag}\`, merging into \`${releaseBranch}\`.`,
    "",
    "Merging this PR triggers CI to tag the merged commit and publish the GitHub Release.",
  ];
  if (notes?.trim()) {
    lines.push("", "## Notes", notes.trim());
  }
  return lines.join("\n");
}
