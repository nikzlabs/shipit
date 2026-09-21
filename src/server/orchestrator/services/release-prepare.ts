import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { GitManager } from "../../shared/git.js";
import { restoreLfsAfterTreeRewrite } from "../git-lfs.js";
import type { GitHubAuthManager } from "../github-auth.js";
import type { ChatHistoryManager } from "../chat-history.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ReleaseBumpType } from "../../shared/types/release-types.js";
import { ServiceError } from "./types.js";
import { agentCreatePr, findBranchPullRequest } from "./github.js";
import { findSharedBranchRefusal } from "./push-target-guard.js";
import { workflowPublishesAuthoredNotes } from "../release-autopublish-check.js";
import {
  NOTES_DIR,
  NOTES_DRAFT_FILE,
  readDraftNotes,
  repoPublishesAuthoredNotes,
} from "../release-notes-draft.js";
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

const BUMP_TRAILER = "Shipit-Release-Version";

const BUMP_TYPES: ReadonlySet<string> = new Set(["major", "minor", "patch", "prerelease"]);

export interface ReleasePlan {
  currentVersion: string;
  version: string;
  tag: string;
  bumpType: ReleaseBumpType | "explicit";
  versionSource: VersionSourceType;
  versionSourcePath: string;
  prerelease: boolean;
  warning?: string;
}

export interface PlanReleaseArgs {
  dir: string;
  bump?: string;
  prerelease?: boolean;
  versionSourcePath?: string;
  mechanism?: string;
  releaseBranch?: string;
}

// The maintenance branch records the released version; callers must fetch origin first.
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

async function computePlan(
  git: GitManager,
  current: string,
  bump: string | undefined,
  prerelease: boolean,
): Promise<{ version: string; bumpType: ReleaseBumpType | "explicit" }> {
  if (bump && bump.includes(".") && parseSemVer(bump)) {
    return { version: bump.replace(/^v/, ""), bumpType: "explicit" };
  }

  if (prerelease) {
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

export async function planRelease(git: GitManager, args: PlanReleaseArgs): Promise<ReleasePlan> {
  const detected = resolveSource(args.dir, args.versionSourcePath);
  let current = detected.version;
  if (args.mechanism === "release-branch" && args.releaseBranch) {
    await git.fetch("origin");
    current = await resolveCurrentVersion(git, detected, args.dir, args.mechanism, args.releaseBranch);
  }
  const { version, bumpType } = await computePlan(git, current, args.bump, args.prerelease ?? false);
  const prerelease = args.prerelease ?? false;
  return {
    currentVersion: current,
    version,
    tag: `v${version}`,
    bumpType,
    versionSource: detected.source,
    versionSourcePath: detected.path!,
    prerelease,
    ...(await missingDraftWarning(args.dir, `v${version}`, prerelease)),
  };
}

/*
  `plan` is read-only and raises no card (docs/309 req 10), so this warning is
  the only place the orchestrator can tell the agent its draft is missing —
  without it, a forgotten draft is a propose marker that silently does nothing.
*/
async function missingDraftWarning(
  dir: string,
  tag: string,
  prerelease: boolean,
): Promise<{ warning?: string }> {
  if (prerelease) return {};
  if (!(await repoPublishesAuthoredNotes(dir))) return {};
  if (await readDraftNotes(dir)) return {};
  return {
    warning:
      `⚠ ${tag} has no release notes yet. This repo publishes authored notes rather than GitHub's ` +
      `generated per-PR list, so write a compact summary of what ${tag} contains to ` +
      `"${NOTES_DRAFT_FILE}" at the repo root BEFORE proposing the release: the confirmation card ` +
      `does not appear without it, and \`shipit release prepare\` refuses the release. ` +
      `(It is gitignored, so it will not dirty the tree that command checks.)`,
  };
}

export interface PrepareReleaseArgs extends PlanReleaseArgs {
  remoteUrl?: string;
  releaseBranch: string;
  pick?: string[];
  from?: string;
  bootstrap?: boolean;
  allowEmpty?: boolean;
  confirm?: boolean;
  notes?: string;
  sessionId?: string;
  runnerRegistry?: SessionRunnerRegistry;
  cancelAutoPush?: (sessionId: string) => void;
  chatHistory?: ChatHistoryManager;
  /** Notify immediately after checkout, even if later release steps fail. */
  onTreeRewrite?: () => void;
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

export async function prepareRelease(
  git: GitManager,
  githubAuth: GitHubAuthManager,
  args: PrepareReleaseArgs,
): Promise<PrepareReleaseResult> {
  if (!githubAuth.authenticated) throw new ServiceError(401, "Not authenticated with GitHub");

  const detected = resolveSource(args.dir, args.versionSourcePath);
  await git.fetch("origin");
  const current = await resolveCurrentVersion(git, detected, args.dir, args.mechanism, args.releaseBranch);
  const { version, bumpType } = await computePlan(git, current, args.bump, args.prerelease ?? false);
  const tag = `v${version}`;

  if (args.prerelease) {
    return preparePrerelease(git, { version, tag, detected, from: args.from, confirm: args.confirm ?? false });
  }

  return prepareFinalRelease(git, githubAuth, args, detected, version, tag, bumpType);
}

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
  const draftNotes = await readDraftNotes(args.dir);
  if (!(await git.isClean())) {
    throw new ServiceError(409, "The working tree has uncommitted changes — commit or discard them first.");
  }

  const releaseBranch = args.releaseBranch;
  const headBranch = `release/${version}`;
  const remoteBranches = await git.listRemoteBranches();

  // Match the base before resetting the head: PR lookup uses the head branch alone.
  const existing = await findBranchPullRequest(git, githubAuth, headBranch, args.remoteUrl);
  if (existing?.state === "open" && existing.base !== releaseBranch) {
    throw new ServiceError(409, wrongBasePrMessage(headBranch, releaseBranch, existing.number, existing.base, false));
  }

  /*
    A release whose workflow publishes authored notes never publishes GitHub's
    generated per-PR list (docs/309 req 6), so notes are a precondition there
    rather than an extra. Gated on the workflow the release will actually run,
    not unconditionally: a repo that never adopted the flow must stay
    releasable (req 9), and a `--pick` hotfix onto a maintenance branch still
    carrying the old workflow would otherwise commit notes nothing publishes.

    Enforced before the branch is touched — refusing after the checkout would
    leave the session on a rewritten tree for a mistake one file fixes.

    Re-running prepare resets this branch to the release branch and rebuilds it,
    and the draft is gone once a previous run consumed it — so with no draft the
    notes already on the pushed branch are what the release keeps.
  */
  const payloadRef = await resolvePayloadRef(git, args.from, releaseBranch, remoteBranches);
  const notesPublished = await workflowPublishesAuthoredNotes(git, payloadRef);
  const notesBody = draftNotes ?? (await git.showFileAtRef(`origin/${headBranch}`, notesRelPath(tag)));
  if (notesPublished && !notesBody?.trim()) {
    throw new ServiceError(
      400,
      `This release has no notes, and its release workflow publishes authored notes rather than ` +
        `GitHub's generated per-PR list — so it would fail to publish. Write a compact summary of ` +
        `what ${tag} contains to "${NOTES_DRAFT_FILE}" at the repo root, then re-run. ` +
        `(It is gitignored, so it will not dirty the tree this command checks.)`,
    );
  }
  const notesWarning =
    !notesPublished && notesBody?.trim()
      ? `⚠ These release notes will NOT be published: the \`.github/workflows/release.yml\` this release ships ` +
        `(from \`${payloadRef}\`) does not read \`.release-notes/<tag>.md\`, so ${tag} publishes GitHub's ` +
        `generated per-PR list instead. Bring the notes-aware workflow into the release (e.g. \`--from main\`) ` +
        `to publish authored notes.`
      : undefined;

  let startPoint = `origin/${releaseBranch}`;
  if (!remoteBranches.includes(releaseBranch)) {
    if (!args.bootstrap) {
      throw new ServiceError(
        400,
        `The release branch "${releaseBranch}" doesn't exist on the remote. ` +
          "Re-run with --bootstrap to create it from the current base for the first release.",
      );
    }
    const detected = await git.getDefaultBranch();
    const base = remoteBranches.includes(detected) ? detected : null;
    if (!base) throw new ServiceError(400, "Could not resolve the repository's default branch to bootstrap from.");
    await git.createBranchFrom(releaseBranch, `origin/${base}`);
    args.onTreeRewrite?.();
    await git.push("origin", releaseBranch);
    startPoint = `origin/${releaseBranch}`;
  }

  // Preserve manual commits added to an existing release PR.
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

  await git.createBranchFrom(headBranch, startPoint);
  args.onTreeRewrite?.();

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
    // Take the incoming tree exactly, retaining maintenance ancestry for the PR.
    await git.mergeOverride(ref);
  }

  // Orchestrator git disables LFS smudging; recover content after checkout and payload changes.
  await restoreLfsAfterTreeRewrite(args.dir, "Release prepare", (message) =>
    console.warn(`[release-prepare] ${message}`),
  );

  // --from always creates a merge commit, so test its tree rather than its commit count.
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

  writeVersionToSource(detected, version);
  const relPath = path.relative(args.dir, detected.path!);
  const lockRel = detected.source === "package.json" ? path.join(path.dirname(relPath), "package-lock.json") : null;
  const notesRel = notesBody?.trim() ? await writeNotesFile(args.dir, tag, notesBody) : null;

  const message = `Release ${tag}\n\n${BUMP_TRAILER}: ${version}`;
  const commitHash = await git.commitPaths(
    [relPath, ...(lockRel ? [lockRel] : []), ...(notesRel ? [notesRel] : [])],
    message,
  );
  if (!commitHash) {
    throw new ServiceError(500, "Version bump produced no commit (the version may already be set).");
  }

  // Check before publishing, not inside `agentCreatePr` below: by then the
  // force-push has already landed.
  const sharedHead = await findSharedBranchRefusal(git, headBranch, releaseBranch);
  if (sharedHead) throw new ServiceError(409, sharedHead.message);

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
    ...(args.cancelAutoPush ? { cancelAutoPush: args.cancelAutoPush } : {}),
    ...(args.chatHistory ? { chatHistory: args.chatHistory } : {}),
  });

  // agentCreatePr can return an old closed PR; only an explicitly open one can publish.
  if (pr.alreadyExisted && pr.alreadyExistedReason !== "open") {
    throw new ServiceError(409, deadReleasePrMessage(headBranch, releaseBranch, pr));
  }

  // The PR may have been retargeted since preflight.
  if (pr.baseBranch !== releaseBranch) {
    throw new ServiceError(409, wrongBasePrMessage(headBranch, releaseBranch, pr.number, pr.baseBranch, true));
  }

  // Last: until the notes are on a pushed branch carrying a live PR, the draft
  // is the only copy, and every path above can still fail.
  if (draftNotes && notesRel) await rm(path.join(args.dir, NOTES_DRAFT_FILE), { force: true });

  return {
    kind: "pr-opened",
    ...(notesWarning ? { warning: notesWarning } : {}),
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

// Valid git refs can contain shell syntax; this value goes into a suggested command.
function safeRefForCommand(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ? value : "<branch>";
}

function wrongBasePrMessage(
  headBranch: string,
  releaseBranch: string,
  prNumber: number,
  prBase: string,
  pushed: boolean,
): string {
  const stale = pushed
    ? ` Note the version bump was already pushed to "${headBranch}", so #${prNumber} now carries it and its previous checks are stale.`
    : "";
  return (
    `The branch "${headBranch}" already has an open pull request (#${prNumber}) into "${prBase}", but ` +
    `this release targets "${releaseBranch}". Merging it would publish through the wrong maintenance ` +
    `branch. ShipIt matches an existing pull request by branch name alone and won't retarget one for ` +
    `you — re-run with --release-branch ${safeRefForCommand(prBase)} to continue that pull request, or ` +
    `release a different version, which starts from a fresh branch. (Retargeting #${prNumber} to ` +
    `"${releaseBranch}" on GitHub also works; closing it does not — a closed pull request still ` +
    `blocks the branch.)${stale}`
  );
}

function deadReleasePrMessage(
  headBranch: string,
  releaseBranch: string,
  pr: {
    number: number;
    baseBranch: string;
    alreadyExistedReason?: "open" | "merged-not-progressed" | "closed-not-progressed";
    notProgressedBecause?: "base-not-contained" | "no-new-work" | "base-unknown" | "fetch-failed";
  },
): string {
  const at = `(#${pr.number} into "${pr.baseBranch}")`;
  let state: string;
  switch (pr.alreadyExistedReason) {
    case "closed-not-progressed":
      state = `a closed pull request ${at}, which ShipIt won't reuse for a new release`;
      break;
    case "merged-not-progressed":
      state = `a merged pull request ${at}, which GitHub cannot reopen`;
      break;
    default:
      state = `a pull request ${at} that is not open, which ShipIt won't reuse for a new release`;
  }

  let remedy: string;
  switch (pr.notProgressedBecause) {
    case "base-not-contained":
      remedy =
        `The branch doesn't contain the tip of "${pr.baseBranch}", because this run targets "${releaseBranch}" ` +
        `instead. Re-run with --release-branch ${pr.baseBranch}, or release a different version.`;
      break;
    case "no-new-work":
      remedy =
        `With the version bump applied the branch is identical to "${pr.baseBranch}", so there is nothing to ` +
        `ship. Bring content in with --from <branch>, or release a different version.`;
      break;
    case "base-unknown":
      remedy =
        `"${pr.baseBranch}" is no longer on the remote (deleted or renamed), so ShipIt can't tell whether this ` +
        `branch has moved past it. Release a different version — that starts from a fresh branch.`;
      break;
    case "fetch-failed":
      remedy =
        `ShipIt could not refresh "${pr.baseBranch}" from the remote, so it declined to decide whether this ` +
        `branch has moved past it. This is a connectivity or credentials problem, not a problem with the ` +
        `release — check the GitHub connection and re-run the same version.`;
      break;
    default:
      remedy = "Release a different version — that starts from a fresh branch.";
  }

  return (
    `The branch "${headBranch}" already has ${state}. The version bump was pushed to "${headBranch}" but has ` +
    `no pull request to carry it, so nothing would publish. ${remedy}`
  );
}

function notesRelPath(tag: string): string {
  return path.join(NOTES_DIR, `${tag}.md`);
}

/** The ref whose tree the release ships — and so whose workflow will run. Mirrors the branch selection below. */
async function resolvePayloadRef(
  git: GitManager,
  from: string | undefined,
  releaseBranch: string,
  remoteBranches: string[],
): Promise<string> {
  if (from) return remoteBranches.includes(from) ? `origin/${from}` : from;
  if (remoteBranches.includes(releaseBranch)) return `origin/${releaseBranch}`;
  return `origin/${await git.getDefaultBranch()}`;
}

async function writeNotesFile(dir: string, tag: string, body: string): Promise<string> {
  const rel = notesRelPath(tag);
  await mkdir(path.join(dir, NOTES_DIR), { recursive: true });
  await writeFile(path.join(dir, rel), `${body.trimEnd()}\n`, "utf-8");
  return rel;
}

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
