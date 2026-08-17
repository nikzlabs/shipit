/**
 * Session fork / merge operations.
 *
 * Extracted from `session.ts` to isolate the cross-session git plumbing
 * (clone-from-cache, branch creation, push/fetch/merge between sibling
 * clones) from the simpler per-session mutations.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { safeSimpleGit } from "../../shared/git-hooks-guard.js";
import {
  type GitRemoteCredentialResolver,
  credentialledGit,
  resolveTreeRemoteCredential,
} from "../../shared/git-remote-credential.js";
import type { SessionManager } from "../sessions.js";
import type { GitManager } from "../../shared/git.js";
import type { RepoGit } from "../repo-git.js";
import type { SessionInfo } from "../../shared/types.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
import { ServiceError } from "./types.js";
import { chownTreeToSessionWorker, handWorkspaceBackToWorker } from "../session-worker-uid.js";
import { allocateAndSealSessionDir } from "../session-uid-allocator.js";
import {
  buildLfsUnresolvedAgentNotice,
  materializeLfsWithWarning,
  restoreLfsAfterTreeRewrite,
} from "../git-lfs.js";
import { stripRemoteUrlCredentials } from "../git-utils.js";
import { resolveGitTreeUid } from "../../shared/git-tree-uid.js";

/**
 * Read a clone's `refs/remotes/origin/HEAD` as a full ref
 * (`refs/remotes/origin/main`), or null when it isn't set.
 */
async function readOriginHead(dir: string): Promise<string | null> {
  try {
    const ref = (await safeSimpleGit(dir).raw(["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
    return ref || null;
  } catch {
    // Not set (a `git init` sandbox, an older clone) — the caller deletes instead.
    return null;
  }
}

/**
 * The `refs/remotes/origin/<name>` a fork's `origin/HEAD` should point at, or
 * null when nothing on disk knows.
 *
 * Sources, most authoritative first:
 *
 *  1. **The shared bare cache's own HEAD.** `git clone --bare` sets it to the
 *     remote's default branch, and it is the very value `repo-default-branch.ts`
 *     persists as `RepoInfo.defaultBranch`. It can never be a `shipit/<slug>`
 *     session branch, and that is what makes it the right source rather than the
 *     parent: a parent that is ITSELF a fork made before this fix has the wrong
 *     `origin/HEAD`, and copying from it would carry the bug down the lineage
 *     forever. Reading the cache instead heals every such fork on its next fork.
 *
 *     Read as a raw `symbolic-ref HEAD` (the same thing `plugin-generations.ts`
 *     does to a cache) rather than through `RepoGit.getDefaultBranch()`, which
 *     hard-codes `"main"` when it cannot tell. That guess is worse than no answer
 *     here: on a `trunk` repo whose cache is missing it would confidently
 *     overwrite a correct value with a wrong one, where a throw falls through to
 *     a source that still knows.
 *
 *  2. **The parent clone's `origin/HEAD`.** The same fact one clone downstream —
 *     the parent got it from the cache. Covers a session whose cache has been
 *     reclaimed, and local/dogfood setups that never built one.
 *
 *  3. **Nothing**, so the caller deletes instead of leaving the inherited ref.
 */
async function resolveForkOriginHead(parentDir: string, bareCacheDir: string | null): Promise<string | null> {
  if (bareCacheDir) {
    try {
      const head = (await safeSimpleGit(bareCacheDir).raw(["symbolic-ref", "HEAD"])).trim();
      const match = /^refs\/heads\/(.+)$/.exec(head);
      if (match) return `refs/remotes/origin/${match[1]}`;
    } catch {
      // No cache on disk, or an unreadable HEAD — fall through to the parent.
    }
  }
  return readOriginHead(parentDir);
}

/**
 * Point the fork's `origin/HEAD` at the repo's real default branch.
 *
 * `git clone --local <src>` derives the new clone's `refs/remotes/origin/HEAD`
 * from whatever branch the SOURCE has checked out. For a fork the source is a
 * session workspace, so that is the parent session's own `shipit/<slug>` branch
 * — and neither the `remote set-url` nor the `fetch --prune` above rewrites it
 * (`origin/HEAD` is a local symbolic ref; only `git remote set-head` repoints
 * one). `--prune` drops stale TRACKING refs, not the symref, so the wrong value
 * survives either way: resolvable when the parent's branch was pushed, dangling
 * but still named when it wasn't.
 *
 * That single ref is what `GitManager.getDefaultBranch()` reads, and it is the
 * repo-wide answer to "what is the base branch?" — so the fork opened its PR
 * against the parent's branch, rendered "Sync with shipit/<parent-slug>" instead
 * of the default branch, and diffed against it too. A fork is a SIBLING of its
 * parent, not a child of it: both target the repo's default branch.
 *
 * Every source here is on local disk. `git remote set-head origin --auto` would
 * ask the remote and be authoritative, but `git-utils.ts` avoids that call by
 * name — a network round trip that can hang.
 *
 * With no source at all, DELETE the fork's inherited ref rather than leave the
 * wrong one: `getDefaultBranch()` then falls through to its `origin/main` /
 * `origin/master` probe, which is the same answer the parent itself gives.
 *
 * A resolved name is written even if the fork has no matching tracking ref yet
 * (a failed fetch): `getDefaultBranch()` reads the NAME out of the symref, and
 * `resolvePrBaseBranch` validates that name against the live remote branch list
 * before opening a PR. Deleting a dangling-but-correctly-named ref would trade a
 * right answer for the probe's `main` guess.
 *
 * Best-effort throughout — a fork must not fail over this.
 */
async function inheritOriginHead(parentDir: string, forkDir: string, bareCacheDir: string | null): Promise<void> {
  const originHead = await resolveForkOriginHead(parentDir, bareCacheDir);
  try {
    await safeSimpleGit(forkDir).raw(
      originHead
        ? ["symbolic-ref", "refs/remotes/origin/HEAD", originHead]
        : ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
    );
  } catch (err) {
    console.warn("[git] fork: could not align origin/HEAD (non-fatal):", String(err));
  }
}

/**
 * What a fork reports when its workspace did not come out complete
 * (planning#426).
 *
 * Two sinks rather than one, because the two readers are different and the issue
 * asks for the one the *user* reads:
 *
 *  - `warn` reaches the user now — a toast, exactly as every other provisioning
 *    path's LFS warning does (`sseBroadcast("error", …)`). A fork is a
 *    user-initiated action, so there is always someone looking.
 *  - `noticeForAgent` reaches the party that would otherwise read the pointer
 *    stubs as if they were content, on the new session's FIRST turn — which may
 *    be tomorrow, long after any toast is gone. That is the half that makes this
 *    more than noise: an LFS stub is a small text file that *looks like* the
 *    tracked asset, so a build, a test or an agent reading it gets plausible
 *    wrong data rather than a missing file.
 *
 * Both default to a log line, so the older positional callers and the tests keep
 * working unchanged.
 */
export interface ForkReportSinks {
  warn?: (message: string) => void;
  noticeForAgent?: (sessionId: string, notice: string) => void;
}

/**
 * The production wiring of {@link ForkReportSinks} — an SSE toast now and a
 * durable `pending_agent_notice` for the fork's first turn.
 *
 * A named factory rather than an object literal at each route, because both fork
 * entry points (`POST /api/sessions/:id/fork` and the chat **rewind**) owe the
 * identical reporting and a divergence between them would be invisible: the
 * failure it reports is one where nothing looks wrong.
 */
export function forkReportSinks(deps: {
  sessionManager: Pick<SessionManager, "setPendingAgentNotice">;
  sseBroadcast: (event: string, data: unknown) => void;
}): ForkReportSinks {
  return {
    warn: (message) => {
      console.warn(`[fork] ${message}`);
      deps.sseBroadcast("error", { message });
    },
    noticeForAgent: (sessionId, notice) => {
      deps.sessionManager.setPendingAgentNotice(sessionId, notice);
    },
  };
}

/** Fork a session into a new clone with its own branch. */
export async function forkSession(
  sessionManager: SessionManager,
  _createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (repoUrl: string) => string,
  sessionsRoot: string,
  githubAuthManager: { authenticated: boolean; configureGitCredentials: (dir: string) => void },
  _threadManager: { init: (sessionId: string) => void },
  activeSessionId: string,
  activeSessionDir: string,
  branchName: string,
  startPoint: string | undefined,
  title: string | undefined,
  graduationDeps: GraduateSessionDeps,
  /**
   * planning#426 — the `fetch origin` and the `git lfs pull` below both run on a
   * SESSION workspace, so since docs/266-orchestrator-git-trust-boundary E1 they
   * have dropped uid and cannot read the orchestrator's PAT. Without this the
   * fetch degrades to anonymous (silently wrong `origin/*` refs, which is the
   * diff inflation the fetch exists to prevent) and the LFS pull fails outright
   * with `could not read Username` — leaving a fork of an LFS repo full of
   * pointer stubs. `mergeSession` below already took this parameter for the
   * identical reason; the fork was the site left behind.
   */
  resolveRemoteCredential?: GitRemoteCredentialResolver,
  report: ForkReportSinks = {},
): Promise<{ session: SessionInfo; parentSessionId: string; sessions: SessionInfo[] }> {
  const trimmed = branchName.trim();
  if (!trimmed) throw new ServiceError(400, "Branch name is required");
  if (/[\s~^:?*[\\]/.test(trimmed) || trimmed.includes("..")) {
    throw new ServiceError(400, "Invalid branch name");
  }

  const activeSession = sessionManager.get(activeSessionId);

  const crypto = await import("node:crypto");
  const newSessionId = crypto.randomUUID();
  const newSessionDir = path.join(sessionsRoot, newSessionId);
  const newWorkspaceDir = path.join(newSessionDir, "workspace");

  // Clone from the active session's own clone (not the bare cache). The chat
  // history's `startPoint` SHA is from an auto-commit in this session — it
  // is guaranteed to exist here, but may be missing from the bare cache
  // (commit not yet auto-pushed, or pruned after the PR branch was deleted).
  // This used to hardlink objects, so its disk cost matched the old cache-clone
  // path. Under docs/270 it no longer can — see the `--no-hardlinks` note below:
  // the source's objects are root-owned and a dropped clone may not link them.
  // A fork now copies the object store.
  //
  // docs/266-orchestrator-git-trust-boundary E2 / planning#407 — this clone READS a session workspace, which is
  // a tree untrusted code can write, so it must run at that tree's uid like
  // every other orchestrator-side git. It was the one path that could not, and
  // the reason is the destination: a bare `safeSimpleGit()` has no `baseDir`, so
  // there is nothing for the ownership predicate to stat, and dropping anyway
  // would leave the clone unable to create its root-owned destination under
  // `sessionsRoot`. So create the destination first and hand it to the worker
  // uid, then clone with the drop resolved from the SOURCE tree. Measured
  // against git 2.39.5 with the ownership check armed: `git clone --local` on a
  // foreign source fails `detected dubious ownership in repository at
  // '<src>/.git'` — so once docs/266-orchestrator-git-trust-boundary E2 removes `safe.directory=*`, the old
  // shape does not merely run as root, it stops working.
  //
  // Hand over `newWorkspaceDir` and NOT its parent `newSessionDir`: removing or
  // renaming a directory ENTRY is governed by the parent directory's
  // permissions, so chowning `newSessionDir` would let the session's uid unlink
  // or substitute the `uploads/` and `logs/` siblings ShipIt keeps beside the
  // workspace. The clone needs only to write *inside* an existing empty
  // destination it owns — verified against git 2.39.5 that `clone --local`
  // accepts one rather than insisting on creating it.
  //
  // The handover reads the SAME predicate the drop does, rather than
  // `chownTreeToSessionWorker`'s configured worker uid. Those two answers are
  // not the same question, and review caught the gap: `resolveGitTreeUid` keys
  // on "are we root, and who owns this tree", NOT on `SHIPIT_SESSION_WORKER_UID`
  // — so a root orchestrator with the flag unset and a non-root-owned source
  // (a host-bind dev setup) would drop to the tree's owner while the chown
  // returned early, and the clone would EACCES on a root-owned destination.
  // A worker-uid migration, where an adopted old tree's owner is not the
  // configured uid, produces the same mismatch. One predicate, both halves, no
  // window in which they disagree.
  //
  // When it resolves to null nothing happens at all — no chown, no drop, root
  // cloning into a root-owned directory exactly as before. That is every test,
  // local mode, and any deployment whose session trees are root-owned.
  // `--no-hardlinks` is REQUIRED here, and its absence was a hard break, not a
  // slow path. Under docs/270 the entrypoint and `chownWorkspaceGitToSessionWorker`
  // both deliberately skip `.git/objects` data files, because a session clone's
  // objects are hardlinks into the ROOT-owned shared bare cache and an inode has
  // exactly one owner across every link — chowning them would hand one session
  // rewrite rights over every sibling's repository content. So the source's
  // objects stay `root:root 0444`, and this clone runs DROPPED to the source
  // session's uid. `/proc/sys/fs/protected_hardlinks` is 1 on the deploy hosts,
  // which permits `link()` only for the file's owner or someone with read+write
  // on it; a non-root uid is neither for a root-owned `0444` object.
  //
  // Measured here against git 2.39.5, cloning a workspace whose 409 cache-linked
  // objects were root-owned: git does NOT fall back to copying on link failure —
  // it aborts with `fatal: failed to create link '<obj>': Operation not
  // permitted`, so every fork of a cache-cloned session failed outright. With
  // `--no-hardlinks` the same clone succeeded in ~1s.
  //
  // The cost this gives up is real and is the price of the isolation boundary:
  // the fork now COPIES the object store (142 MiB for the ShipIt repo) instead of
  // sharing inodes with the bare cache. There is no third option — sharing the
  // inodes is precisely the cross-session write the 0700 seal exists to deny.
  await fs.mkdir(newWorkspaceDir, { recursive: true });
  const cloneUid = resolveGitTreeUid(activeSessionDir);
  if (cloneUid !== null) {
    // docs/270 req 1 — seal the session dir 0700 to the SOURCE identity for the
    // duration of the clone, not just at the end. `mkdir` leaves it root-owned
    // and `0755`, and the clone that follows takes seconds to minutes on a large
    // repo; for that whole window every other session's uid could traverse
    // `sessionsRoot` into a directory holding a fresh copy of this session's
    // workspace — `.env` files, credentials in a checked-out config, the lot.
    // The final seal below re-owns it to the FORK's identity; this one exists so
    // there is no moment in between when it belongs to nobody. The source uid is
    // the right holder here precisely because the clone runs as it.
    await fs.chown(newSessionDir, cloneUid.uid, cloneUid.gid);
    await fs.chmod(newSessionDir, 0o700);
    await fs.chown(newWorkspaceDir, cloneUid.uid, cloneUid.gid);
  }
  await safeSimpleGit(activeSessionDir).raw([
    "clone",
    "--local",
    "--no-hardlinks",
    activeSessionDir,
    newWorkspaceDir,
  ]);

  // docs/270 — the fork builds `<sessionsRoot>/<id>` itself instead of going
  // through `createSessionDirFactory`, so without this it would be the one kind
  // of session with no identity of its own AND no 0700 seal: requirement 1 would
  // hold everywhere except forks, silently.
  //
  // Both calls sit AFTER the clone, and the ordering is forced from both sides:
  //
  //   - **Not before it.** The seal makes `newSessionDir` 0700 owned by the
  //     FORK's new identity, and the clone above runs as the SOURCE session's
  //     uid (planning#407, so it can read a tree untrusted code can write).
  //     Those are different uids, so a seal placed first would deny the clone
  //     traversal into the very directory it is writing into.
  //   - **Not after `newGit`.** Every `safeSimpleGit(dir)` resolves its uid from
  //     the session record, so the config / fetch / `checkout -b` writes below
  //     already run as the fork. They need the tree to belong to it by then.
  //
  // The handback here is the FULL recursive one, and this is the one place that
  // is correct — everywhere else must use the object-aware
  // `handWorkspaceBackToWorker`. The difference is `--no-hardlinks` above: this
  // clone shares no inode with the bare cache or with the source session, so
  // every file under `newWorkspaceDir` is the fork's own and chowning it hands
  // nobody rights over anyone else's content. Without the full walk the object
  // files would keep the SOURCE session's uid (the clone ran as it), leaving
  // another session's uid owning inodes inside this fork's tree — unreachable
  // through the 0700 seal, but pointless residue that defeats defence in depth
  // the moment that seal is the only thing standing.
  allocateAndSealSessionDir(newSessionDir);
  chownTreeToSessionWorker(newWorkspaceDir);

  const newGit = safeSimpleGit(newWorkspaceDir);
  // Disable auto-gc. It was originally here to stop gc breaking the hardlinks
  // this clone used to share with the source; under `--no-hardlinks` there are
  // none left to break, but it stays because a fork still must not repack a
  // freshly copied object store on its first turn.
  await newGit.raw(["config", "gc.auto", "0"]);
  // Reset origin to the real remote (clone --local sets it to activeSessionDir).
  // Stripped on the way in as well as at the source (`SessionManager.setRemoteUrl`),
  // because this writes the fork's `/project/.git/config` (docs/262 req 19) and a
  // fork can inherit a row written by an older build.
  if (activeSession?.remoteUrl) {
    await newGit.raw(["remote", "set-url", "origin", stripRemoteUrlCredentials(activeSession.remoteUrl)]);
  }
  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(newWorkspaceDir);
  }
  // Refresh remote-tracking refs against the real upstream. After clone
  // --local, refs/remotes/origin/* mirror the active session's local
  // branches, so PR-diff bases (e.g. origin/main) start out pointing at
  // the active session's local view rather than real origin — that's
  // what produces the "+1657 -94" diff inflation on a fresh fork until
  // the next auto-push fetch normalizes them.
  const warn = report.warn ?? ((message: string) => console.warn(`[fork] ${message}`));
  if (activeSession?.remoteUrl) {
    try {
      // planning#426 — credentialled, for the reason `resolveRemoteCredential`
      // documents. Resolved here rather than once above because the credential is
      // read per remote op by design (a mint is short-lived), and `null` — every
      // test, local mode, a root-owned tree — hands back the plain `newGit` so
      // this path stays byte-for-byte what it was.
      const credential = await resolveTreeRemoteCredential(newWorkspaceDir, "origin", resolveRemoteCredential);
      const fetchGit = credential ? credentialledGit(newWorkspaceDir, credential) : newGit;
      await fetchGit.raw(["fetch", "origin", "--prune"]);
    } catch (err) {
      // Still non-fatal — a fork with stale `origin/*` refs is usable, it just
      // inflates the first PR diff. But it is no longer SILENT: this is one of the
      // three paths that produced the planning#426 soak's `could not read
      // Username` lines, and a `console.warn` is not a surface anyone reads.
      warn(
        "Could not refresh remote-tracking refs from origin, so this fork's first diff against "
        + `\`origin/<base>\` may look larger than it is — run \`git fetch origin --prune\`. (${String(err)})`,
      );
    }
  }
  // Unconditional, not folded into the `remoteUrl` guard above: a fork of a
  // remote-less session inherits the same wrong `origin/HEAD` (there its origin
  // is the parent's workspace dir), and has neither cache nor parent value to
  // replace it with, so the delete branch is the one that runs. It must also run
  // when the fetch above FAILED — the inherited ref is wrong either way.
  let bareCacheDir: string | null = null;
  try {
    bareCacheDir = activeSession?.remoteUrl ? getBareCacheDir(activeSession.remoteUrl) : null;
  } catch {
    // An unmappable remote URL just means no cache source; the parent still has one.
  }
  await inheritOriginHead(activeSessionDir, newWorkspaceDir, bareCacheDir);

  const branchArgs = ["checkout", "-b", trimmed];
  if (startPoint) branchArgs.push(startPoint);
  await newGit.raw(branchArgs);

  // nikzlabs/shipit#2349 (adjacent gap): a fork is a provisioning path that never
  // materialized LFS content, so forking an LFS repo produced a workspace where
  // EVERY tracked asset was a pointer stub — the docs/231 bug in full, not just
  // the paths a rewrite touched. Two causes, both live here: `git clone --local`
  // does not carry `.git/lfs` (docs/232), so the fork starts with an empty object
  // store, and the `checkout -b` above ran through the orchestrator's
  // smudge-disabled git. This is the same call every other provisioning path
  // makes, at the same point: after the final worktree-materializing checkout and
  // after `configureGitCredentials` (a private repo's LFS endpoint needs it).
  //
  // docs/270 INVERTED the ordering rule this call arrived with. It used to run
  // before the ownership handoff, so that the handoff got the last write over
  // whatever the pull materialized as root. The pull spawns git through
  // `gitSpawnOverridesForTree` (`git-lfs.ts:130`), which now resolves the FORK's
  // identity from its session record — so it already writes as the fork, and the
  // handoff has to come *earlier* rather than later. It does: it is up beside the
  // clone, for the independent reason that every `safeSimpleGit` between here and
  // there also drops to that identity. Nothing is owed afterwards.
  //
  // planning#426 — the pull's credential comes from the same resolver the fetch
  // above uses, registered once at boot (`git-lfs.ts`
  // `configureLfsRemoteCredentialResolver`). Without it a dropped-uid pull on a
  // private repo authenticates with nothing, and *this* is the path where that is
  // worst: the fork's `.git/lfs` starts EMPTY, so a failed pull leaves every
  // tracked asset as a stub rather than just the ones a rewrite touched.
  const lfs = await materializeLfsWithWarning(
    newWorkspaceDir,
    activeSession?.remoteUrl ?? newWorkspaceDir,
    warn,
  );

  // Fork-specific workspace identity: insert the row, pin branch + remote.
  // graduateSession is called after — it needs `remoteUrl` already set so
  // `repoStore.touch` can fire.
  const resolvedTitle = title?.trim() || `${activeSession?.title ?? "Session"} (${trimmed})`;
  sessionManager.track(newSessionId, resolvedTitle, newWorkspaceDir);
  sessionManager.setBranch(newSessionId, trimmed);
  if (activeSession?.remoteUrl) {
    sessionManager.setRemoteUrl(newSessionId, activeSession.remoteUrl);
  }

  // planning#426 — the reporting half, and it is a defect on its own terms even
  // when the cause turns out to be legitimate ("the token has no access to this
  // repository"). A fork whose LFS content did not resolve must not present as
  // complete: the tree IS complete, every file IS present, and the contents are
  // pointers. So tell the party about to read them, on this session's first turn.
  //
  // Written AFTER `track`, because the notice is a column on the session row and
  // the pull runs before that row exists (it has to — it needs the finished
  // worktree). `not-an-lfs-repo` and `materialized` are the two silent outcomes;
  // every other status left stubs behind.
  if (lfs.usesLfs && lfs.status !== "materialized") {
    report.noticeForAgent?.(newSessionId, buildLfsUnresolvedAgentNotice(lfs));
  }

  // graduate-session.ts owns the warm → active transition (docs/156).
  // Do not inline setWarm / setBranchRenamed / scheduleSessionNaming /
  // repoStore.touch / sseBroadcast("session_list") here.
  //
  // Both explicit fields set: AI naming is suppressed (user chose the title
  // and branch). `skipBranchRename: true` is belt-and-braces — the explicit
  // gate already short-circuits naming, but a future change to the naming
  // policy must not be able to silently rewrite a fork branch the user
  // chose.
  graduateSession(graduationDeps, {
    sessionId: newSessionId,
    userText: "",
    agentId: activeSession?.agentId ?? "claude",
    explicitTitle: resolvedTitle,
    explicitBranch: trimmed,
    skipBranchRename: true,
  });

  const newSession = sessionManager.get(newSessionId)!;
  console.log("[server] Forked session:", newSessionId, "branch:", trimmed);
  return {
    session: newSession,
    parentSessionId: activeSessionId,
    sessions: sessionManager.list(),
  };
}

/** Merge a session's branch into the active session. */
export async function mergeSession(
  sessionManager: SessionManager,
  createGitManager: (dir: string) => GitManager,
  activeSessionDir: string,
  sourceSessionId: string,
  // docs/266-orchestrator-git-trust-boundary E3 (planning#404) — the `origin` fetch below runs on a SESSION
  // workspace, so under E1 it has dropped uid and cannot read the
  // orchestrator's PAT. Without this it degrades to an anonymous fetch and
  // silently takes the local-remote fallback on every private repo.
  resolveRemoteCredential?: GitRemoteCredentialResolver,
): Promise<{ success: boolean; message: string; conflicts?: string[] }> {
  const trimmedId = sourceSessionId.trim();
  if (!trimmedId) throw new ServiceError(400, "Source session ID is required");

  const sourceSession = sessionManager.get(trimmedId);
  if (!sourceSession) throw new ServiceError(404, "Source session not found");
  if (!sourceSession.branch) throw new ServiceError(400, "Source session has no branch");

  const git = createGitManager(activeSessionDir);
  const sg = safeSimpleGit(activeSessionDir);

  // With separate clones, we need to get the source branch into this clone.
  // Strategy 1: Push source to origin, then fetch in target (production path).
  // Strategy 2: Add source clone as a local remote and fetch (local/test path).
  let mergeRef = `origin/${sourceSession.branch}`;
  let fetched = false;

  if (sourceSession.workspaceDir) {
    // Try pushing source branch to origin and fetching
    const sourceGit = createGitManager(sourceSession.workspaceDir);
    try {
      await sourceGit.push("origin", sourceSession.branch);
      const credential = await resolveTreeRemoteCredential(activeSessionDir, "origin", resolveRemoteCredential);
      const originGit = credential ? credentialledGit(activeSessionDir, credential) : sg;
      await originGit.fetch("origin", sourceSession.branch);
      fetched = true;
    } catch {
      // Origin push/fetch failed — use local remote instead
    }

    if (!fetched) {
      // Add the source session directory as a temporary local remote
      const remoteName = `merge-source-${trimmedId.slice(0, 8)}`;
      try {
        await sg.addRemote(remoteName, sourceSession.workspaceDir);
      } catch {
        // Remote may already exist from a previous attempt
      }
      try {
        await sg.fetch(remoteName, sourceSession.branch);
        mergeRef = `${remoteName}/${sourceSession.branch}`;
        fetched = true;
      } catch {
        // Fetch from local remote also failed
      }
    }
  }

  let result: Awaited<ReturnType<typeof git.merge>>;
  try {
    result = await git.merge(mergeRef);
  } finally {
    // Clean up temporary merge remotes even if merge throws
    try {
      const remotes = await sg.getRemotes();
      for (const r of remotes) {
        if (r.name.startsWith("merge-source-")) {
          await sg.removeRemote(r.name);
        }
      }
    } catch { /* ignore cleanup errors */ }
    // nikzlabs/shipit#2349: the merge rewrote the worktree through the ORCHESTRATOR's
    // git, whose LFS smudge filter is disabled by design, so every LFS-tracked
    // path it touched holds ~130 bytes of pointer text — in a tree git reports as
    // clean. In the `finally` because a conflicted merge is aborted (`git.merge`
    // does that itself), and the abort checks the pre-merge tree back out through
    // the same filter-less git, so it leaves stubs just as a clean merge does.
    await restoreLfsAfterTreeRewrite(activeSessionDir, "Merge", (message) =>
      console.warn(`[fork-merge] ${message}`),
    );
    // docs/150 §7 addendum (planning#146): the push/fetch/merge git ops above ran as
    // the root orchestrator against the active session's (booted) clone,
    // re-rooting BOTH its `.git` and the worktree files the merge rewrote. Hand
    // both back to the worker uid — same gap/fix as the rebase driver and the
    // session-setup paths: handing only `.git` back would leave the merged
    // worktree files root-owned, so the non-root agent couldn't edit them on its
    // next turn. No-op unless the flag is set.
    handWorkspaceBackToWorker(activeSessionDir);
  }

  if (result.success) {
    return {
      success: true,
      message: `Merged branch '${sourceSession.branch}' successfully`,
    };
  }
  return {
    success: false,
    message: `Merge conflict on branch '${sourceSession.branch}'`,
    conflicts: result.conflicts,
  };
}
