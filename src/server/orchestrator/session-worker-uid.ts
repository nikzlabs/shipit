/**
 * Orchestrator-side ownership handoff to the unprivileged session worker user
 * (docs/150 §7).
 *
 * The session-worker container drops to the `shipit` user (UID/GID 1000) at
 * boot, but the **orchestrator** container stays root and keeps writing into
 * each session's mounted subtrees *after* the container has started —
 * credential refreshes every turn, the per-session gitconfig, user uploads,
 * CI-fix logs, post-boot git operations. Node's copy primitives preserve the
 * source mode and the upstream credential files are `0600 root:root`, so those
 * writes land `root:root` and are unreadable to `shipit`. The container
 * entrypoint's chown runs only once, at boot, so it cannot cover them.
 *
 * The fix is symmetric to the entrypoint: every orchestrator-side writer into a
 * per-session mount chowns its output to the worker UID right after writing.
 * All of it is gated on a single env var, `SHIPIT_SESSION_WORKER_UID`:
 *
 *   - **unset** (today's default) → every helper here is a no-op, preserving
 *     the legacy root-writes-everything behavior. Safe to deploy before the
 *     non-root image exists.
 *   - **set to `1000`** → chowns fire. The session-worker image's entrypoint
 *     reads the *same* env var, so a single deploy flips both sides together
 *     and they can never disagree about which UID owns the mounts (docs/150
 *     Rollout step 3).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig, DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";
import { identityForPath, sessionDirFor, type SessionIdentity } from "../shared/session-identity.js";
import { EGRESS_RESOLVER_UID } from "./egress-dns.js";
import { EGRESS_PROXY_UID } from "./egress-proxy-install.js";

/**
 * UIDs no workload may run as, because the netns firewall exempts them by
 * owner-match (docs/172, docs/263).
 *
 * `init-firewall.sh` writes its Tier B/C rules as `-m owner ! --uid-owner <uid>`:
 * the DNS redirect at `init-firewall.sh:202-205` skips {@link EGRESS_RESOLVER_UID},
 * and the `:443` SNI redirect at `init-firewall.sh:229-230` skips
 * {@link EGRESS_PROXY_UID} — plus the filter rule at `:161` gives 911 raw port-53
 * egress to any address. Those exemptions exist so the resolver's and proxy's own
 * upstream dials are not re-redirected into themselves; they are not identity
 * checks, so ANY process with that uid inherits them. A workload running as 911
 * therefore resolves names past the controlled resolver, and one running as 912
 * dials `:443` past the SNI proxy.
 *
 * `SHIPIT_SESSION_WORKER_UID` is that uid for the TWO contained surfaces that
 * share the arrangement: the agent container (`container-lifecycle.ts:510`
 * forwards the variable, `docker/session-worker/entrypoint.sh:23` gosu's to it)
 * and plugin CLI / install containers (`plugin-cli-run.ts:706`,
 * `plugin-install.ts:470`). They break together, so the refusal lives here at the
 * single parse site rather than on either of them.
 *
 * Compose services are NOT a third such surface, though the fallback at
 * `compose-generator.ts:1164` also reads this variable: a *contained* service
 * must declare its own numeric, non-root, non-reserved `user:` — checked against
 * these same two constants at `compose-generator.ts:850`, which throws during
 * validation (`compose-generator.ts:415`) before any override is generated. So
 * the worker-uid fallback reaches only Open services, where there is no tier to
 * escape.
 */
export const RESERVED_EGRESS_UIDS: readonly number[] = [EGRESS_RESOLVER_UID, EGRESS_PROXY_UID];

/** Thrown by {@link sessionWorkerUid} for a uid in {@link RESERVED_EGRESS_UIDS}. */
export class ReservedWorkerUidError extends Error {
  constructor(readonly uid: number) {
    super(
      `[session-worker-uid] Refusing to start: SHIPIT_SESSION_WORKER_UID=${uid} is a reserved ` +
        `egress-sidecar UID (${EGRESS_RESOLVER_UID}=DNS resolver, ${EGRESS_PROXY_UID}=SNI proxy). ` +
        `The netns firewall exempts those UIDs from the controls that name them, so every agent, ` +
        `and plugin workload would silently escape ${uid === EGRESS_RESOLVER_UID
          ? "the DNS lock"
          : "the :443 SNI redirect"} in contained sessions. Set SHIPIT_SESSION_WORKER_UID to a ` +
        `non-root UID outside ${RESERVED_EGRESS_UIDS.join("/")} (the deployment files use 1000). ` +
        `Ownership follows on its own: the entrypoint's handoff sentinel is UID-stamped ` +
        `(docker/session-worker/entrypoint.sh:75), so each session re-chowns once the next time ` +
        `its container is CREATED. Containers already running under ${uid} are adopted as-is on ` +
        `restart and keep that UID — archive or reset those sessions to retire them.`,
    );
    this.name = "ReservedWorkerUidError";
  }
}

/**
 * The UID the session worker runs as, parsed from `SHIPIT_SESSION_WORKER_UID`,
 * or `null` when unset/invalid. `null` means "do not chown" — the orchestrator
 * and worker are both still on root.
 *
 * **Throws** {@link ReservedWorkerUidError} for a reserved egress uid, rather
 * than degrading it to `null`. Degrading would be worse than accepting it: the
 * container entrypoint reads the SAME raw variable (`entrypoint.sh:23`) and would
 * still `gosu` to 911, so the orchestrator would behave as legacy-root while the
 * workload ran exempt from containment — the split-brain the shared gate exists
 * to make impossible. There is deliberately no override env var: unlike the
 * downgrade `worker-uid-guard.ts` allows, no deployment legitimately wants its
 * workloads to hold the uid that disables the tier.
 */
export function sessionWorkerUid(): number | null {
  const raw = process.env.SHIPIT_SESSION_WORKER_UID;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0) return null;
  if (RESERVED_EGRESS_UIDS.includes(n)) throw new ReservedWorkerUidError(n);
  return n;
}

/**
 * Boot-time fail-fast for the reserved-UID refusal above, so a misconfigured
 * deployment dies at startup with one clear message instead of at the first
 * chown/container-create that happens to parse the variable.
 *
 * Deliberately UNCONDITIONAL, unlike `assertWorkerUidConsistency` (which needs
 * the containerized state dir and so runs in prod only): the range is a property
 * of the variable's value, not of the runtime mode, and a refusal that fires only
 * where containers exist would let a local/dogfood orchestrator carry the bad
 * value until an unrelated code path threw.
 */
export function assertWorkerUidNotReserved(): void {
  sessionWorkerUid();
}

/**
 * docs/268 — the group EVERY session shares, still parsed from
 * `SHIPIT_SESSION_WORKER_UID`. Only the **uid** became per-session.
 *
 * The shared group is what keeps the four cross-session surfaces working once
 * uids differ: the per-repo dep cache, the pnpm store, the overlay dependency
 * base (whose copy-up preserves the lower file's owner) and the orchestrator's
 * global gitconfig. All four become group-owned and group-writable, which is the
 * only way a session that is *not* their creator can still use them (req 9).
 *
 * It does not weaken the isolation the per-session uid buys, because the
 * isolation is the **0700 session directory**, not the group: a file inside
 * another session's tree is unreachable regardless of its group bits, since the
 * directory above it denies traversal.
 *
 * It must be the PRIMARY gid rather than a supplementary one. Node's
 * `spawn({uid, gid})` maps to libuv's `setgid`/`setuid` with no
 * `setgroups`/`initgroups`, so a dropped orchestrator-side git carries whatever
 * supplementary set the root parent had — never one we chose. A design that
 * reached the shared surfaces through a supplementary group would work inside
 * the container and fail silently in the orchestrator.
 */
export function sessionWorkerGid(): number | null {
  return sessionWorkerUid();
}

/**
 * The uid/gid a per-session path should be owned by: the owning session's own
 * identity when the path is inside a session, and the shared global value
 * otherwise (the dep cache, the bare cache, anything unconfigured).
 *
 * Returning the global value for a non-session path is what keeps every existing
 * caller correct without a signature change: a helper that used to chown to the
 * one worker uid still does, unless the path it was given belongs to a session
 * that has an identity of its own.
 */
/**
 * The identity of a session named by id rather than by a path — for the callers
 * that have a session id and no filesystem path into it (compose generation,
 * plugin container launch). Falls back to the shared global value exactly like
 * {@link identityForTarget}, so a session that predates docs/268 resolves to
 * what it has always been.
 */
export function identityForSession(sessionId: string): SessionIdentity | null {
  const dir = sessionDirFor(sessionId);
  return dir === null ? identityForTarget("") : identityForTarget(dir);
}

export function identityForTarget(targetPath: string): SessionIdentity | null {
  const owner = identityForPath(targetPath);
  if (owner !== null) return owner;
  const uid = sessionWorkerUid();
  return uid === null ? null : { uid, gid: uid };
}

/**
 * Own and SEAL a session directory: the identity's own uid, the shared gid, and
 * mode 0700.
 *
 * The mode is the whole cross-session boundary (req 1). 0700 denies traversal to
 * every other uid, so nothing inside the session — workspace, `.git`, state dir,
 * scratch, uploads — needs a restrictive mode of its own, and none of the many
 * writers that create files in there has to remember one. `sessionsRoot` itself
 * stays root-owned 0755 so each session can still traverse to its own directory.
 *
 * Used for both populations: a new session (its allocated uid) and, at boot, a
 * session that predates docs/268 (the shared global uid). The second is req 8b —
 * NOT a migration, which req 8a rules out, but the permission change without
 * which "new sessions only" would leave every new session readable by every old
 * one, and every old one readable by the new.
 */
export function sealSessionDir(sessionDir: string, identity: SessionIdentity): boolean {
  try {
    fs.chownSync(sessionDir, identity.uid, identity.gid);
    fs.chmodSync(sessionDir, 0o700);
    return true;
  } catch (err) {
    console.warn(`[session-worker-uid] could not seal session dir ${sessionDir}:`, err);
    return false;
  }
}

/**
 * The mode half of {@link sealSessionDir}, for a per-session directory whose
 * OWNER some other helper has already set — currently the per-session
 * credentials subtree, which `chownSessionCredentialsTree` hands over by path.
 *
 * No-op when the non-root runtime is off. Best-effort: a directory we cannot
 * chmod must not stop a credential sync, which is the thing that keeps a session
 * able to authenticate.
 */
export function sealDirMode(dir: string): void {
  if (sessionWorkerGid() === null) return;
  try {
    fs.chmodSync(dir, 0o700);
  } catch (err) {
    console.warn(`[session-worker-uid] could not seal mode on ${dir}:`, err);
  }
}

/**
 * docs/268 req 9 — make a surface that is SHARED between sessions usable by all
 * of them, now that they no longer share a uid.
 *
 * The three surfaces this exists for are the per-repo dependency cache, the
 * shared pnpm store, and the overlay dependency base. Each is written by
 * whichever session gets there first and read — and written — by every other,
 * which "chown it to the worker uid" expressed perfectly while there was one
 * worker uid and cannot express at all now.
 *
 * So: leave the owner alone, set the shared GROUP, and add group write. On
 * directories the setgid bit goes on too, so an entry a later session creates
 * inherits the group instead of that session's own. For the overlay base the
 * group write is not a convenience — overlayfs copy-up preserves the LOWER
 * file's owner and mode, so a base file without it copies up unwritable and the
 * agent EACCESes on its first edit of a dependency, which is the bug docs/183's
 * chown was added to fix.
 *
 * `X` (capital) in the chmod sense: execute is added only where it is already
 * set on some class, or on a directory. Files do not become executable.
 *
 * No-op when the non-root runtime is off. Best-effort per node, like every other
 * helper here: the walk must not throw on a path that vanished mid-flight.
 */
export function shareTreeWithAllSessions(targetPath: string): void {
  const gid = sessionWorkerGid();
  if (gid === null) return;
  shareRecursive(targetPath, gid);
}

/**
 * {@link shareTreeWithAllSessions} for a single node — no walk.
 *
 * The pnpm store needs exactly this and must NOT get the recursive form: it runs
 * on the container-create hot path and the store is a multi-gigabyte
 * content-addressed tree, which is why its handoff has always been
 * non-recursive. Its contents can only carry the wrong group if a root worker
 * populated them, and the entrypoint's sentinel rotation already repairs that on
 * the first boot after the value changes.
 */
export function shareWithAllSessions(targetPath: string): void {
  const gid = sessionWorkerGid();
  if (gid === null) return;
  shareOne(targetPath, gid);
}

/** Group + mode for one node. Returns its stat so the walker can descend. */
function shareOne(p: string, gid: number): fs.Stats | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return null; // gone
  }
  // A symlink's own mode is meaningless on Linux and chmod would follow it out
  // of the tree, so it is regrouped in place and never descended.
  try {
    fs.lchownSync(p, stat.uid, gid);
  } catch (err) {
    console.warn(`[session-worker-uid] group share failed for ${p}:`, err);
  }
  if (stat.isSymbolicLink()) return stat;
  const mode = stat.mode & 0o7777;
  // g+rw always; g+x and setgid only for directories, matching `chmod -R g+rwX`
  // plus `find -type d -exec chmod g+s`.
  const next = stat.isDirectory() ? mode | 0o2070 : mode | 0o060;
  if (next !== mode) {
    try {
      fs.chmodSync(p, next);
    } catch (err) {
      console.warn(`[session-worker-uid] group share chmod failed for ${p}:`, err);
    }
  }
  return stat;
}

function shareRecursive(p: string, gid: number): void {
  const stat = shareOne(p, gid);
  if (!stat?.isDirectory()) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(p);
  } catch {
    return;
  }
  for (const entry of entries) shareRecursive(path.join(p, entry), gid);
}

/**
 * docs/268 req 8b — seal the session directories that predate per-session uids.
 *
 * Requirement 8a says existing sessions are NOT migrated: they keep the shared
 * identity. That answer only means what it says once their directories are also
 * closed, because "a different owner" is not isolation on its own — a directory
 * created `root:root` under the default umask is world-traversable and its
 * contents world-readable, so without this a new session's payload would read
 * every old session's workspace and every old session's payload would read the
 * new one's.
 *
 * So: one non-recursive `chown` + `chmod 0700` per session directory that is
 * still root-owned. No tree walk, no first-boot cost, and no identity change —
 * this is a permission change, which is why it is compatible with req 8a rather
 * than a re-litigation of it.
 *
 * Reads the directory rather than the session table on purpose: a session
 * directory whose row has gone (a half-finished delete, a restored volume) is
 * exactly as readable as one whose row is present, so it needs sealing exactly
 * as much. Best-effort per entry — one unsealable directory must not stop the
 * boot, and it is reported so it is diagnosable rather than silently open.
 */
export function sealLegacySessionDirs(sessionsRoot: string): number {
  const gid = sessionWorkerGid();
  if (gid === null) return 0; // legacy root runtime — nothing to seal to
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return 0; // no sessions yet
  }
  let sealed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsRoot, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue; // vanished mid-scan
    }
    // A non-root owner is already a record: either an allocated identity or a
    // directory this pass sealed on an earlier boot. Re-sealing would be a
    // no-op; skipping keeps the pass O(sessions) stats in the steady state.
    if (stat.uid !== 0) continue;
    if (sealSessionDir(dir, { uid: gid, gid })) sealed += 1;
  }
  if (sealed > 0) {
    console.log(`[session-worker-uid] docs/268: sealed ${sealed} pre-existing session director${sealed === 1 ? "y" : "ies"} at the shared uid ${gid}`);
  }
  return sealed;
}

/**
 * Chown a single file/dir (non-recursive) to the session worker UID/GID. No-op
 * when `SHIPIT_SESSION_WORKER_UID` is unset. Best-effort: a chown failure (e.g.
 * the path vanished mid-flight) is logged, never thrown — the caller's write
 * already succeeded and a stale-ownership read surfaces as an auth failure the
 * next sync repairs.
 *
 * "Never thrown" covers the FILESYSTEM operation, not the uid resolution: every
 * helper here resolves the uid first, so a reserved-uid misconfiguration
 * propagates as {@link ReservedWorkerUidError} rather than being swallowed as a
 * chown failure. Swallowing it is what would be unsafe — the container entrypoint
 * would still `gosu` to it. Unreachable in practice: `assertWorkerUidNotReserved`
 * refuses the boot before any of these run.
 */
export function chownToSessionWorker(targetPath: string): void {
  const owner = identityForTarget(targetPath);
  if (owner === null) return;
  try {
    fs.lchownSync(targetPath, owner.uid, owner.gid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${targetPath}:`, err);
  }
}

/**
 * Recursively chown a subtree to the session worker UID/GID. No-op when
 * `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * Mirrors `chown -R` semantics: symlinks are chowned in place (`lchown`) and
 * never traversed, so a credential subtree's legacy-alias symlinks don't drag
 * the walk outside the per-session dir. Missing paths are tolerated (a write
 * may have been torn down concurrently).
 */
export function chownTreeToSessionWorker(targetPath: string): void {
  const owner = identityForTarget(targetPath);
  if (owner === null) return;
  chownRecursive(targetPath, owner);
}

/**
 * Hand a session workspace's `.git` directory back to the worker uid after the
 * root orchestrator ran git operations in it (clone, fetch, branch, reset,
 * commit). No-op when `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * docs/150 §7 addendum (planning#33 activation): the worktree files are written by
 * the agent *as the worker uid* inside the container, but git's own writes —
 * `.git/index`, the reflogs under `.git/logs/` (append-only, so the worker
 * can't even add to a root-owned one), refs — land `root:root` whenever the
 * root orchestrator runs git here post-boot. The entrypoint's boot-time chown
 * can't see these later writes, so the next in-container `git` the agent runs
 * (uid 1000) fails to update them. Chowning after each orchestrator-side git op
 * closes that gap.
 *
 * Runs on the post-turn auto-commit (every turn) plus the one-shot session
 * setup writers, so it MUST stay cheap. The immutable DATA FILES under
 * `.git/objects/` (loose objects + packs) are deliberately skipped: git writes
 * them `0444` and content-addressed, so the worker only ever reads an existing
 * object or creates a NEW one — it never rewrites one in place, and a root-owned
 * `0444` file is world-readable anyway. The object *directories* (the ≤256-way
 * fanout + `pack/`/`info/`) ARE chowned, so the worker can still add new objects
 * into them. This bounds the walk by the fanout instead of the unbounded
 * loose-object count a `gc.auto=0` session clone accumulates — measured ~54 ms →
 * <1 ms on a 7k-loose-object repo (the ShipIt repo itself). Everything outside
 * `objects/` is chowned in full; that's where git's rewritten/appended files
 * (index, reflogs, refs, packed-refs, HEAD) live.
 */
export function chownWorkspaceGitToSessionWorker(workspaceDir: string): void {
  const owner = identityForTarget(workspaceDir);
  if (owner === null) return;
  const gitDir = path.join(workspaceDir, ".git");
  chownGitMetadataRecursive(gitDir, owner, path.join(gitDir, "objects"), path.join(gitDir, "lfs", "objects"));
}

/**
 * Hand a session **worktree** (the files the agent edits) back to the worker
 * uid after the root orchestrator rewrote them. No-op when
 * `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * docs/150 §7 addendum (planning#146): {@link chownWorkspaceGitToSessionWorker} hands
 * back `.git` so the agent's in-container *git* works, but NOT the worktree. A
 * root orchestrator `git rebase` / `checkout` / `rebase --continue` / `--abort`
 * re-materializes worktree files as `root:root` — including the conflicted files
 * the agent must **edit** to resolve. With only `.git` handed back, git status
 * passes but the resolution turn (and any later normal turn) still EACCES on
 * those files, and can't create/replace files in the now root-owned dirs. This
 * walks the worktree and chowns every node to the worker uid, EXCEPT `.git`
 * (handled by the object-aware helper) and the declared dep dirs
 * (`agent.dep-dirs`, e.g. `node_modules`) — passed in via `excludeRelDirs`.
 * Skipping the dep dirs keeps the walk bounded by the source tree instead of the
 * dependency count (those are large caches the entrypoint's one-shot chown / the
 * worker-run install already own; the rebase never touches them — they're
 * gitignored). Symlinks are chowned in place (`lchown`) and never followed.
 */
export function chownWorktreeToSessionWorker(workspaceDir: string, excludeRelDirs: string[] = []): void {
  const owner = identityForTarget(workspaceDir);
  if (owner === null) return;
  const exclude = new Set<string>([".git", ...excludeRelDirs.map((d) => path.normalize(d))]);
  chownWorktreeRecursive(workspaceDir, owner, workspaceDir, exclude);
}

/**
 * Hand a session workspace back to the worker uid in full after the root
 * orchestrator ran git operations that rewrote BOTH the `.git` metadata AND the
 * worktree files — `clone`/`checkout -b`/`reset --hard`/`rebase`/`merge`. No-op
 * when `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * This is the composite of the two narrower handbacks: {@link
 * chownWorkspaceGitToSessionWorker} (object-aware `.git`) +
 * {@link chownWorktreeToSessionWorker} (worktree minus the declared dep dirs,
 * read from the workspace's `shipit.yaml`; falls back to {@link DEFAULT_DEP_DIRS}
 * when the config can't be read). Handing back ONLY `.git` — which the
 * session-setup paths used to do — leaves the worktree the root git op
 * re-materialized owned `root:root`, so the non-root agent (uid 1000) can run
 * git but EACCESes on its first edit of a tracked file (docs/150 §7 / planning#147).
 *
 * Use this from every orchestrator-side path that mutates a per-session
 * workspace's worktree as root: session setup (warm-pool create, claim refresh,
 * claim branch-off), rebase, and fork-merge. The dep-dir skip keeps the walk
 * bounded by the source tree rather than the (potentially populated)
 * `node_modules`, which the worker already owns via its own install / the
 * overlay mount.
 */
export function handWorkspaceBackToWorker(workspaceDir: string): void {
  if (identityForTarget(workspaceDir) === null) return;
  chownWorkspaceGitToSessionWorker(workspaceDir);
  let depDirs: string[];
  try {
    depDirs = resolveShipitConfig(workspaceDir).agent.depDirs;
  } catch {
    depDirs = [...DEFAULT_DEP_DIRS];
  }
  chownWorktreeToSessionWorker(workspaceDir, depDirs);
}

/**
 * Reconcile worker ownership of a per-session **dep-dir** writable layer, cheaply
 * — repairs root-owned tool caches a root process left inside it (e.g.
 * `node_modules/.vite`, written by a Compose dev server before #1646 ran services
 * as the worker uid). No-op when `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * The general {@link chownWorktreeToSessionWorker} self-heal deliberately
 * **excludes** the declared dep dirs: a full recursive chown of a populated
 * `node_modules` (tens of thousands of files) on every boot is too expensive, and
 * in overlay mode it would also rewrite the shared read-only lowerdir (docs/183).
 * So a root-owned cache that slipped *inside* a dep dir was never repaired and
 * wedged the next `npm run build` with EACCES (#1666 — the agent, uid 1000, can't
 * `rmdir` the root-owned `.vite/deps`, and has no `sudo` to recover).
 *
 * This pass is bounded and overlay-safe by construction:
 *  - it only `lstat`s the **direct children** of `depDirPath` (one per installed
 *    package + the dot-cache dirs), so the steady-state cost is a few hundred
 *    `lstat`s and **zero** chowns — the common case (everything already
 *    worker-owned from the worker-run install) is a shallow scan;
 *  - a child NOT owned by the worker uid is a leaked cache tree (a root process
 *    creates the whole `.vite/` subtree fresh), so it gets one wholesale
 *    {@link chownRecursive} — work bounded by the *leak* size, not the dep count;
 *  - `depDirPath` is always a **per-session** writable path — the plain
 *    `workspaceDir/<depDir>` (non-overlay) or the per-session overlay `upperdir`
 *    (where copy-ups/new dirs like `.vite` land) — never the shared overlay
 *    lowerdir, so reconciling it can never rewrite a base generation or trigger a
 *    copy-up storm.
 *
 * Idempotent: an already-worker-owned tree costs only the direct-child `lstat`s.
 * Tolerant: a missing `depDirPath` (no install yet) is a no-op.
 */
export function reconcileDepDirCacheOwnership(depDirPath: string): void {
  const owner = identityForTarget(depDirPath);
  if (owner === null) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(depDirPath);
  } catch {
    return; // dep dir doesn't exist yet (no install) — nothing to reconcile
  }
  for (const entry of entries) {
    const child = path.join(depDirPath, entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(child);
    } catch {
      continue; // vanished mid-scan
    }
    if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
      // Leaked tree (root-owned cache a root process wrote here) — chown it whole.
      chownRecursive(child, owner);
    }
  }
}

/**
 * Recursive worktree chown that skips `.git` + the declared dep dirs (matched by
 * path relative to the worktree root, so a nested `client/node_modules` is
 * skipped too). Mirrors {@link chownRecursive} otherwise: chown every node,
 * descend real directories only (a symlink lstats as a non-directory, so it's
 * chowned in place and never followed out of the tree).
 */
function chownWorktreeRecursive(p: string, owner: SessionIdentity, root: string, exclude: Set<string>): void {
  const rel = path.relative(root, p);
  if (rel !== "" && exclude.has(rel)) return; // skip .git + declared dep dirs
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // gone — nothing to own
  }
  lchownLogged(p, owner);
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownWorktreeRecursive(path.join(p, entry), owner, root, exclude);
    }
  }
}

function lchownLogged(p: string, owner: SessionIdentity): void {
  try {
    fs.lchownSync(p, owner.uid, owner.gid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${p}:`, err);
  }
}

/**
 * Recursive `.git` chown that treats the object store specially. Everywhere
 * outside `objectsDir` it behaves like {@link chownRecursive} (chown every node,
 * descend real dirs only — a symlink lstats as a non-directory, so it's never
 * followed out of the tree). At `objectsDir` (`.git/objects/`) it chowns the
 * store dir and its immediate subdirectories (the fanout dirs, `pack/`,
 * `info/`) so the worker can add new objects, then STOPS — it never descends to
 * even `lstat` the thousands of immutable `0444` data files. Avoiding that
 * per-file `lstat`/`lchown` is what keeps the walk O(fanout) instead of
 * O(loose objects); the store's growth under `gc.auto=0` otherwise made this
 * dominate (~54 ms → ~0.5 ms on a 7k-object repo). See
 * {@link chownWorkspaceGitToSessionWorker} for why skipping the data files is
 * safe.
 */
function chownGitMetadataRecursive(p: string, owner: SessionIdentity, objectsDir: string, lfsObjectsDir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // gone — nothing to own
  }

  // `.git/lfs/objects/<ab>/<cd>/<oid>` — the Git LFS content store. Directories
  // are chowned (the worker must be able to `mkdir` a new oid's fanout path when
  // it commits a new asset), regular files never are. Skipping the data files is
  // load-bearing for docs/232, not just a saving: a shared-store object is a
  // HARDLINK into `repo-cache/<hash>/lfs/objects`, and an inode has exactly one
  // owner across every link — so chowning it here would hand the *shared cache
  // store* to the session uid and let one session's agent rewrite objects every
  // other session reads. It's also safe on its own terms, by the same argument
  // as `.git/objects` above: LFS objects are content-addressed and immutable, so
  // the worker only ever reads an existing one or creates a new one, and
  // `unlink` (what `git lfs prune` needs) is governed by the *directory's*
  // permissions, which are worker-owned.
  if (p === lfsObjectsDir && stat.isDirectory()) {
    chownDirsOnlyRecursive(p, owner);
    return;
  }

  if (p === objectsDir && stat.isDirectory()) {
    lchownLogged(p, owner);
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    // Shallow: chown only the immediate subdirectories (fanout / pack / info).
    // Object/pack data files are left as-is — immutable, 0444, only ever read
    // or newly created, never rewritten in place.
    for (const entry of entries) {
      const child = path.join(p, entry);
      try {
        if (fs.lstatSync(child).isDirectory()) lchownLogged(child, owner);
      } catch {
        // entry vanished mid-walk — skip
      }
    }
    return;
  }

  lchownLogged(p, owner);
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownGitMetadataRecursive(path.join(p, entry), owner, objectsDir, lfsObjectsDir);
    }
  }
}

/**
 * Chown every *directory* in a subtree, never a regular file — the traversal the
 * Git LFS content store needs. See the `lfsObjectsDir` branch of
 * {@link chownGitMetadataRecursive} for why files must be left alone.
 *
 * Unlike `.git/objects`, this can't stop at the immediate children: LFS uses a
 * TWO-level fanout (`<ab>/<cd>/<oid>`), so a root-owned `<ab>/` would stop the
 * worker from creating a new `<cd>/` inside it when it commits an asset whose oid
 * shares that prefix. The walk is therefore O(fanout dirs), not O(1) — but it
 * still never touches the (large, numerous) object files themselves.
 */
function chownDirsOnlyRecursive(p: string, owner: SessionIdentity): void {
  lchownLogged(p, owner);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // `isDirectory()` on a Dirent is false for a symlink, so we never follow one.
    if (entry.isDirectory()) chownDirsOnlyRecursive(path.join(p, entry.name), owner);
  }
}

function chownRecursive(p: string, owner: SessionIdentity): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // gone — nothing to own
  }
  try {
    fs.lchownSync(p, owner.uid, owner.gid);
  } catch (err) {
    console.warn(`[session-worker-uid] chown failed for ${p}:`, err);
  }
  // Recurse into real directories only. A symlink to a directory has
  // `isDirectory() === false` on the lstat above, so we never follow it.
  if (stat.isDirectory()) {
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownRecursive(path.join(p, entry), owner);
    }
  }
}
