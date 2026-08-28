/**
 * Orchestrator-side ownership handoff to the unprivileged session worker user
 * (docs/150 §7).
 *
 * The session-worker container drops to the `shipit` user — a per-session uid
 * with the shared gid 1000 since docs/270, UID/GID 1000 before it — at
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

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveShipitConfig, DEFAULT_DEP_DIRS } from "../shared/shipit-config.js";
import { identityForPath, sessionDirFor, type SessionIdentity } from "../shared/session-identity.js";
import { resolveGitTreeUid, type GitTreeUidDeps } from "../shared/git-tree-uid.js";
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
 * Compose services ARE reached by this variable too — including contained ones —
 * and the conclusion below is what keeps that safe. *(This paragraph used to say
 * the opposite: that a contained service had to declare its own `user:`, so the
 * fill-in "reaches only Open services, where there is no tier to escape."
 * docs/271 deleted that requirement — github#2374 is the report of what it cost —
 * and the claim survived the fix in four places, which is the drift `CLAUDE.md`
 * warns about: a comment asserting an inherited guarantee is a claim, not a
 * contract. Corrected 2026-08-18 rather than dropped, because the safety argument
 * rests on it.)*
 *
 * The fill-in at {@link identityForSession} → `compose-generator.ts`
 * (`entry.user = ${workerUid}:${workerGid}`) now supplies the session identity to
 * any service that declares no `user:`, contained or not. That cannot emit a
 * reserved uid: every path to it resolves through {@link sessionWorkerUid}, which
 * THROWS {@link ReservedWorkerUidError} for 911/912 rather than returning one, and
 * {@link assertWorkerUidNotReserved} refuses the boot before any session exists.
 * So the tier-escape hazard is closed at this parse site for compose services by
 * the same refusal that closes it for the agent and plugin containers — not by a
 * validation rule demanding a declaration, which is what the old text claimed and
 * what turned out to be unimplementable (`compose-generator.ts`'s
 * `validateServiceSecurity`: a project may not name a uid in the session range,
 * so the uid a service needs is the one it was forbidden to declare).
 *
 * A *declared* `user:` is still checked, and still refused for root, for either
 * reserved uid, and for anything inside the per-session range.
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
 * docs/270 — the group EVERY session shares, still parsed from
 * `SHIPIT_SESSION_WORKER_UID`. Only the **uid** became per-session.
 *
 * The shared group is what keeps the three cross-session surfaces working once
 * uids differ: the per-repo dep cache, the pnpm store, and the overlay
 * dependency base (whose copy-up preserves the lower file's owner AND mode).
 * All three become group-owned and group-writable, which is the only way a
 * session that is *not* their creator can still use them (req 9).
 *
 * The orchestrator's global gitconfig is deliberately NOT in that list, though
 * an earlier draft of this comment said it was. docs/266-orchestrator-git-trust-boundary E3 made it root-owned
 * `0644` in a `0711` directory precisely so the worker can read it and cannot
 * write it, and `restoreRootOwnership` exists to keep it that way. Group-writing
 * it would hand every session the ability to rewrite the config that names the
 * credential helper — do not "restore" it to this list.
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
 * {@link identityForTarget}, so a session that predates docs/270 resolves to
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
 * session that predates docs/270 (the shared global uid). The second is req 8b —
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
 * docs/270 req 9 — make a surface that is SHARED between sessions usable by all
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
 * {@link shareTreeWithAllSessions}, but ONCE per tree per gid — for a shared
 * surface that already has contents from before this deployment carried a shared
 * group, and is far too large to re-walk on a hot path.
 *
 * This exists because the two biggest shared surfaces are populated by the
 * *previous* build and never touched again by the code that shares them:
 *
 *   - The **pnpm store**'s handoff is non-recursive, and its docstring justified
 *     that by saying the entrypoint's `chown -R /workspace` walks the nested
 *     store and repairs the contents. Under docs/270 that stopped being true in
 *     this very branch: `chown_workspace()` now `-prune`s `.pnpm-store`, because
 *     walking a multi-gigabyte content-addressed store on every boot is exactly
 *     the cost the prune avoids. Nothing was left repairing the contents.
 *   - The **overlay base**'s share runs in `finalize`, i.e. only when a NEW
 *     generation is published. A generation published before the upgrade keeps
 *     `1000:1000` with `0644` files, and overlayfs copy-up preserves the lower
 *     file's owner AND mode — so a session at an allocated uid EACCESes on its
 *     first write to any inherited dependency.
 *
 * Both failures are silent, land on an upgraded deployment rather than a fresh
 * one, and cannot happen in any test that never populated the surface under the
 * old identity. The marker is what makes the repair affordable: the walk runs on
 * the first container create after the gid changes and is a single `existsSync`
 * on every one after it. It is named for the gid, so a later gid change rotates
 * it exactly like the entrypoint's uid sentinel.
 *
 * Deliberately NOT gated on the top directory's own group: `shareRecursive`
 * marks the root before it descends, so an interrupted walk would leave the root
 * looking done with its contents unshared. The marker is written only after the
 * walk returns.
 *
 * **The marker names the gid and NOT what the walk does, which is a hazard this
 * shares with the container entrypoint's ownership sentinels** — see
 * `HANDOFF_SCHEME` in `docker/session-worker/entrypoint.sh`, where the same
 * shape latched a half-repaired `/dep-cache` on every deployment that had
 * already claimed one. It is not currently WRONG here, because this function
 * and the group+mode walk it performs shipped together, so there is no tree
 * claimed under a version of the walk that did less. It becomes wrong the
 * moment {@link shareOne} learns to do something new: every already-marked tree
 * keeps the old treatment for good. If you change what the walk does, add a
 * scheme version to this marker name too — and expect the bump to cost one
 * synchronous re-walk of the pnpm store / each overlay base generation at the
 * next container create, which is why it is not carried speculatively.
 *
 * `beside` puts that bookkeeping file NEXT TO the tree rather than inside it,
 * for a tree whose contents are USER-VISIBLE. An overlay base generation is
 * mounted as the lower layer of `/workspace/<depDir>`, so a marker inside it
 * would surface as a mystery dotfile in the user's `node_modules` and ride into
 * every copy-up. The gid stays out of the caller's hands either way — it is this
 * module's business, and a caller that spelled the name itself could rotate on a
 * different value than the walk used.
 */
export function shareTreeOnce(targetPath: string, opts: { beside?: boolean } = {}): void {
  const gid = sessionWorkerGid();
  if (gid === null) return;
  const marker = opts.beside
    ? `${targetPath}${SHARED_GID_MARKER_PREFIX}${gid}`
    : path.join(targetPath, `${SHARED_GID_MARKER_PREFIX}${gid}`);
  try {
    if (fs.existsSync(marker)) return;
  } catch {
    return; // unreadable target — nothing safe to do
  }
  shareRecursive(targetPath, gid);
  try {
    fs.writeFileSync(marker, "");
    fs.chmodSync(marker, 0o664);
    fs.lchownSync(marker, fs.lstatSync(marker).uid, gid);
  } catch (err) {
    // A missing marker only costs a repeated walk next time; never fail the
    // caller over bookkeeping.
    console.warn(`[session-worker-uid] shared-gid marker write failed for ${targetPath}:`, err);
  }
}

/** Prefix of the {@link shareTreeOnce} bookkeeping file. Suffixed with the gid. */
export const SHARED_GID_MARKER_PREFIX = ".shipit-shared-gid-";

/**
 * {@link shareTreeWithAllSessions} for a single node — no walk.
 *
 * For a shared CONTAINER directory whose contents are shared by something else:
 * a dep-store scope dir (its generations are shared as they are published) or a
 * generation dir about to get the recursive treatment from `chownBaseDir`. The
 * setgid bit is the point — an entry a later session creates inherits the shared
 * group instead of that session's own.
 *
 * An earlier version of this justified its non-recursiveness by claiming the
 * entrypoint repaired the contents. Do NOT reintroduce that reasoning: the
 * entrypoint prunes the shared mounts precisely so it does not walk them. If a
 * tree's CONTENTS need the group, they need {@link shareTreeWithAllSessions} or
 * {@link shareTreeOnce}, and there is no third party that will do it for you.
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
  addGroupWrite(p, stat);
  return stat;
}

/**
 * The MODE half of a group share, for one node: `g+rw` always, plus `g+x` and
 * the setgid bit on directories — i.e. `chmod g+rwX` plus
 * `find -type d -exec chmod g+s`.
 *
 * Split out of {@link shareOne} because two callers need the mode and disagree
 * about the OWNER. `shareOne` regroups a tree shared BETWEEN sessions and leaves
 * its owner alone; {@link chownWorktreeRecursive} hands a tree to THIS session's
 * uid. Sharing the mode logic is what keeps "group-writable" one definition
 * rather than two that drift.
 *
 * A symlink is skipped: its own mode is meaningless on Linux, and `chmod`
 * follows it, so chmodding one rewrites whatever it points at — possibly outside
 * the tree. Best-effort per node, like every other helper here.
 */
function addGroupWrite(p: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) return;
  const mode = stat.mode & 0o7777;
  const next = stat.isDirectory() ? mode | 0o2070 : mode | 0o060;
  if (next === mode) return;
  try {
    fs.chmodSync(p, next);
  } catch (err) {
    console.warn(`[session-worker-uid] group-write chmod failed for ${p}:`, err);
  }
}

/**
 * How many directories go to one `setfacl`. Path lists here are bounded by the
 * source tree, not the dependency count (the walk prunes the dep dirs), so a
 * few hundred per exec keeps a large repo at single-digit spawns and stays two
 * orders of magnitude under `ARG_MAX`.
 */
const DEFAULT_ACL_BATCH = 256;

/** Seam for {@link applyDefaultGroupAcl}'s tests; production spawns `setfacl`. */
export type DefaultAclRunner = (dirs: readonly string[]) => void;

function spawnSetfacl(dirs: readonly string[]): void {
  execFileSync("setfacl", ["-d", "-m", "g::rwx", "--", ...dirs], { stdio: "ignore" });
}

/**
 * docs/271 §3 — give each worktree directory a POSIX **default ACL** granting
 * the group `rwx`, so what a *foreign-uid* Compose service creates inside it is
 * group-writable too.
 *
 * ## Why the mode passes above are not enough, and why this is not more of them
 *
 * {@link addGroupWrite} fixes the nodes that exist when it runs. It cannot fix
 * the ones a service creates afterwards: a service that declares its own `user:`
 * keeps that uid (docs/271 req 4), runs under its own umask — 022 on every
 * ordinary image — and so lands `0644`/`0755` owned by that uid. Setgid
 * propagates the shared GROUP to those nodes and not the group WRITE bit, so the
 * agent could read a file the service wrote and not modify it, and could traverse
 * a directory the service created but not add to or delete from it. That second
 * half is the sharper one and it is what reached production: a plugin service at
 * `1000:1000` created `.assetgen/` cache directories at `0755`, and orchestrator
 * git — dropped to the session uid by docs/266 — could not unlink their contents,
 * so `git rebase origin/main` failed the checkout and then aborted on
 * "untracked working tree files would be overwritten", every time, with no
 * recovery short of a root intervention on the host.
 *
 * A default ACL is the one mechanism that reaches those future nodes. It is a
 * property of the *directory*, applied by the kernel at creation time, and it
 * **replaces the umask** rather than being masked by it — so it works on a
 * writer ShipIt does not own, at a uid ShipIt did not choose, without the image
 * needing a shell, an `entrypoint` ShipIt may rewrite, or anything else. It also
 * inherits: a directory created under one gets the same default, so this walk is
 * a one-time repair of the tree that exists and every later `mkdir` — by git, by
 * the agent, by any service — carries it forward on its own.
 *
 * Measured on the ext4 that backs a session workspace, with a writer at umask
 * 022 and no relation to the tree's owner: a new directory lands `2775` and a
 * new file `664`. That is exactly what {@link addGroupWrite} produces, which is
 * the point — this widens nothing, it makes the existing rule apply to nodes
 * that did not exist yet.
 *
 * ## Why this costs no isolation
 *
 * The same argument as the mode passes, unchanged: the session directory is
 * `0700` ({@link sealSessionDir}), so a group-writable node inside a session is
 * unreachable to every uid outside it, and the entrypoint's `umask 002` already
 * rests on that reasoning for everything created after boot. The default ACL
 * copies the directory's own `other` bits, so nothing becomes world-anything
 * that was not already.
 *
 * ## Best-effort, loudly
 *
 * `setfacl` may be missing (an older session-worker image) and a backing
 * filesystem may refuse ACLs. Either way this warns once for the walk and
 * returns, leaving precisely the pre-docs/271-§3 behaviour: the tree is still
 * chowned and still group-writable, and only what a foreign-uid service creates
 * later is not. It never throws — a handback that fails takes a turn's work
 * with it (`CLAUDE.md` invariant 2), and an ACL is not worth that.
 */
export function applyDefaultGroupAcl(dirs: readonly string[], run: DefaultAclRunner = spawnSetfacl): void {
  for (let i = 0; i < dirs.length; i += DEFAULT_ACL_BATCH) {
    try {
      run(dirs.slice(i, i + DEFAULT_ACL_BATCH));
    } catch (err) {
      console.warn(
        "[session-worker-uid] default-ACL pass skipped — what a foreign-uid Compose service "
        + "creates in this workspace will not be group-writable (docs/271 §3):",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
  }
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
 * docs/270 req 8b — seal the session directories that predate per-session uids.
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
    console.log(`[session-worker-uid] docs/270: sealed ${sealed} pre-existing session director${sealed === 1 ? "y" : "ies"} at the shared uid ${gid}`);
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
 * Hand a session workspace's `.git` directory back to the uid that will next run
 * git in it, after an orchestrator-side git operation wrote there (clone, fetch,
 * branch, reset, commit).
 *
 * **That uid is {@link resolveGitDirOwner}'s answer, not `SHIPIT_SESSION_WORKER_UID`
 * directly** — read it before assuming this is only about the container's uid;
 * the two differ in exactly the cases that used to strand a turn's work. No-op
 * when that resolves to null. `deps` is the same injection seam
 * {@link resolveGitTreeUid} documents, for tests only.
 *
 * docs/150 §7 addendum (planning#33 activation): the worktree files are written
 * by the agent *as the worker uid* inside the container, while git's own writes
 * — `.git/index`, the reflogs under `.git/logs/` (append-only, so the worker
 * cannot add to one it does not own), refs — are written by whoever ran that
 * orchestrator-side git. The entrypoint's boot-time chown can't see these later
 * writes, so without this the next in-container `git` the agent runs fails to
 * update them. Chowning after each orchestrator-side git op closes that gap.
 *
 * **Which owner that is, since planning#412 found the old answer stated as
 * current fact in a dozen comments.** Since docs/266-orchestrator-git-trust-boundary
 * E1, git run in an EXISTING session tree goes through `safeSimpleGit(<dir>)` /
 * `gitSpawnOverridesForTree` and drops to that session's identity, so those
 * writes land owned by the session and not `root:root`. Two cases are NOT that,
 * and they are why this function still exists:
 *
 *   - **A tree the git op CREATES.** The drop resolves from the directory a call
 *     site names, and a `clone` names its destination as an argument — so
 *     `cloneFromCache`'s bare `safeSimpleGit()` runs as root and lands
 *     `root:root` (`git-hooks-guard.ts` states the read-vs-create split).
 *   - **Two answers for one directory.** `resolveGitDirOwner` reconciles the uid
 *     orchestrator git drops to with the identity the container runs as; where
 *     those disagree, `.git` is unwritable to one of them until this runs. That
 *     is the E1 follow-up documented on {@link resolveGitDirOwner}.
 *
 * Everything else — including "no identity resolves at all", which is local
 * mode, dev and every test — leaves this a no-op, and is also the only place an
 * orchestrator-side git in an existing session tree still runs as root.
 *
 * Runs on the post-turn auto-commit (every turn) plus the one-shot session
 * setup writers, so it MUST stay cheap. The immutable DATA FILES under
 * `.git/objects/` (loose objects + packs) are deliberately skipped: git writes
 * them `0444` and content-addressed, so the worker only ever reads an existing
 * object or creates a NEW one — it never rewrites one in place, and a `0444`
 * file it does not own is world-readable anyway. The object *directories* (the ≤256-way
 * fanout + `pack/`/`info/`) ARE chowned, so the worker can still add new objects
 * into them. This bounds the walk by the fanout instead of the unbounded
 * loose-object count a `gc.auto=0` session clone accumulates — measured ~54 ms →
 * <1 ms on a 7k-loose-object repo (the ShipIt repo itself). Everything outside
 * `objects/` is chowned in full; that's where git's rewritten/appended files
 * (index, reflogs, refs, packed-refs, HEAD) live.
 */
export function chownWorkspaceGitToSessionWorker(workspaceDir: string, deps?: GitTreeUidDeps): void {
  const owner = resolveGitDirOwner(workspaceDir, deps);
  if (owner === null) return;
  const gitDir = path.join(workspaceDir, ".git");
  chownGitMetadataRecursive(gitDir, owner, path.join(gitDir, "objects"), path.join(gitDir, "lfs", "objects"));
}

/**
 * Who `.git` must belong to — **the identity that will run git in it**, not the
 * identity ShipIt has recorded for the session.
 *
 * ## The defect this closes
 *
 * `.git` has two consumers, and until this function they were resolved by two
 * different questions:
 *
 *   - The **agent inside the container** runs at {@link identityForTarget} —
 *     the session's own allocated uid (docs/270), or the shared global one.
 *   - **Orchestrator-side git** runs at whatever {@link resolveGitTreeUid}
 *     resolves — "are we root, and who owns this tree" — since docs/266-orchestrator-git-trust-boundary E1.
 *
 * The handback answered only the first, so where the two disagree the post-turn
 * commit dropped to the tree's owner and then EACCESed inside a `.git` handed to
 * someone else. Measured shape, git 2.39.5:
 * `fatal: could not open '.git/COMMIT_EDITMSG': Permission denied`, exit 128,
 * **after** `git add -A` has already succeeded — so the turn's work is staged,
 * uncommitted, and reachable only through `CLAUDE.md` invariant 2's "no reflog
 * entry and no recovery". Reported in production on 2026-08-16, hours after E1
 * landed, through `formatUncommittedTurnNotice`'s unclassified path.
 *
 * Two ways they disagree, neither hypothetical:
 *
 *   - **Nothing is recorded while a drop still applies.** `resolveGitTreeUid`
 *     consults neither the registry nor `SHIPIT_SESSION_WORKER_UID`, so a root
 *     orchestrator over a non-root-owned tree (a host-bind dev setup) dropped
 *     while the handback returned early — leaving any root-owned file inside
 *     `.git` unwritable **forever**, because nothing else repairs it.
 *   - **The recorded identity is not the tree's.** An adopted container keeps
 *     its old uid, so a tree written under one identity can be resolved to
 *     another. Here the handback was actively harmful: it chowned `.git` *away*
 *     from the uid git runs as, on every turn, so the failure could never
 *     converge.
 *
 * docs/270 sharpens this rather than retiring it. Per-session uids mean the
 * recorded answer now varies per session, so "what ShipIt thinks owns this tree"
 * and "what actually owns it" have more ways to differ, not fewer — `.git` is
 * exactly where that costs a turn's work.
 *
 * docs/266 already fixed this same mismatch once, on the fork path
 * (`session-fork-merge.ts` — "One predicate, both halves, no window in which
 * they disagree"). This is the correction on the path that carries a turn's work.
 *
 * ## Why the tree's owner wins, and why the fallback is not a compromise
 *
 * When a drop applies, orchestrator git *must* be able to write `.git` or the
 * turn's work does not land — the highest-stakes consumer, and the one git's own
 * CVE-2022-24765 check already keys on. Taking the drop's pair **whole** (uid and
 * gid) is what makes it exact: `gitSpawnOverridesForTree` spawns git with those
 * same two numbers, so `.git` ends up owned by the very process that must write
 * it. When there is no drop this defers to {@link identityForTarget} — today's
 * behaviour, per-session record and global fallback included.
 *
 * ## Why session setup is unaffected, stated as the invariant rather than a story
 *
 * At every `handWorkspaceBackToWorker` site the tree's owner is already one of
 * exactly two things, and both come out as before:
 *
 *   - **The session's own identity**, because `cloneFromCache` ends with
 *     `handWorkspaceBackToWorker(sessionDir)` (`repo-git.ts`) — a fresh clone is
 *     handed over *before* any handback runs, so the drop resolves to that same
 *     identity. A later root-side `checkout -b` / `reset --hard` rewrites files
 *     *inside* the tree without changing the root directory's owner, so claim
 *     and rebase land here too. *(That call used to be the plain
 *     `chownTreeToSessionWorker` and this docstring still named it after docs/270
 *     replaced it with the object-aware composite. Corrected rather than left,
 *     because the conclusion below rests on it and this comment has already been
 *     corrected once for the same class of drift — verified at `repo-git.ts` on
 *     2026-08-17, docs/272-shared-cache-ownership.)*
 *   - **Root**, when nothing is recorded — that clone-time chown is itself a
 *     no-op then, the drop declines on a root-owned tree, and this returns null:
 *     nothing happens at all.
 *
 * *An earlier version of this comment claimed fresh clones were still root-owned
 * at handback time and that the FALLBACK was what kept setup safe. That is false
 * at the source (`repo-git.ts`'s clone-time chown), and it was the reasoning a
 * future edit would have leaned on — so it is corrected rather than quietly
 * dropped. The fallback is a safety net for "identity recorded, tree still
 * root-owned", not the mechanism.*
 *
 * In the ordinary steady state both answers are the same identity and nothing
 * changes at all. Only the disagreement cases above behave differently — and
 * there the old answer was the bug.
 *
 * ## The objection this has to survive, since the answer is not obvious
 *
 * Where the two disagree this hands `.git` to a uid the *container* is not
 * running as — apparently trading the orchestrator's failure for the agent's. It
 * does not, for two reasons, both verified rather than assumed:
 *
 *   - The agent is **already** broken in that window regardless of `.git`: the
 *     worktree it must edit belongs to the tree's owner too. (True of the
 *     post-turn path, whose caller chowns `.git` and nothing else. The composite
 *     {@link handWorkspaceBackToWorker} *does* move the worktree to the recorded
 *     identity, so there the worktree half is what re-splits the two; that is the
 *     composite's business, not this decision's.)
 *   - The window closes on its own. `docker/session-worker/entrypoint.sh` stamps
 *     its chown sentinel with the uid (`.shipit-uid-${UID_GID}`), so a uid change
 *     rotates the name and the boot chown re-runs under the new owner — the
 *     comment there says so explicitly, and that sentinel is the general
 *     mechanism (`ReservedWorkerUidError`'s docstring describes only the
 *     reserved-uid case of it). The next container create resolves it, and both
 *     answers agree again from that point.
 *
 * So the choice is between an orchestrator that cannot commit and an agent that
 * is temporarily no worse off. `CLAUDE.md` invariant 2 settles which of those is
 * acceptable: uncommitted agent work has no reflog entry and no recovery.
 *
 * Returns `null` for "do not chown", which stays a no-op for every test, local
 * mode, and any deployment with no identity recorded and a root-owned tree.
 */
export function resolveGitDirOwner(
  workspaceDir: string,
  deps?: GitTreeUidDeps,
): SessionIdentity | null {
  const treeUid = deps ? resolveGitTreeUid(workspaceDir, deps) : resolveGitTreeUid(workspaceDir);
  if (treeUid !== null) return treeUid;
  return identityForTarget(workspaceDir);
}

/**
 * Hand a session **worktree** (the files the agent edits) back to the worker
 * uid after an orchestrator-side git op rewrote them. No-op when
 * `SHIPIT_SESSION_WORKER_UID` is unset.
 *
 * docs/150 §7 addendum (planning#146): {@link chownWorkspaceGitToSessionWorker} hands
 * back `.git` so the agent's in-container *git* works, but NOT the worktree. An
 * orchestrator-side `git rebase` / `checkout` / `rebase --continue` / `--abort`
 * re-materializes worktree files — including the conflicted files the agent must
 * **edit** to resolve — owned by whichever uid that git ran as, which
 * {@link resolveGitTreeUid} decides and which is NOT necessarily the identity
 * the container runs as (planning#412: on an existing session tree it is the
 * session's identity, not root; on a tree the op CREATES, and where no identity
 * resolves, it is root). With only `.git` handed back, git status passes but the
 * resolution turn (and any later normal turn) still EACCESes on those files, and
 * can't create/replace files in dirs it does not own. This
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
  // docs/271 §3 — the walk collects the directories it moded so the default-ACL
  // pass can run over exactly the same set, with exactly the same prunes, in one
  // batched sweep rather than a spawn per node. See {@link applyDefaultGroupAcl}.
  const dirs: string[] = [];
  chownWorktreeRecursive(workspaceDir, owner, workspaceDir, exclude, dirs);
  applyDefaultGroupAcl(dirs);
}

/**
 * Hand a session workspace back to the worker uid in full after orchestrator-side
 * git operations that rewrote BOTH the `.git` metadata AND the worktree files —
 * `clone`/`checkout -b`/`reset --hard`/`rebase`/`merge`.
 *
 * **The two halves are gated differently, on purpose, and each gates itself.**
 * The `.git` half runs whenever {@link resolveGitDirOwner} resolves an identity
 * — including where nothing is recorded, because a root orchestrator over a
 * non-root-owned tree still drops and so still needs `.git` writable. The
 * worktree half stays on {@link identityForTarget}, because "who should own the
 * worktree" is genuinely a different question from "who will run git in `.git`":
 * the worktree's target is the identity the *container* runs as, and where there
 * is none the entrypoint leaves the agent as root, so there is no handover to
 * make.
 *
 * An earlier version early-returned for BOTH on one predicate at this level,
 * which meant the composite skipped the `.git` repair on exactly the paths
 * (rebase, pre-turn reset, claim, fork-merge, container re-create) where the
 * post-turn path had just been fixed to do it — the same two-questions mismatch
 * this feature keeps re-making, one level up. The lesson taken is not "pick the
 * better predicate here" but "do not ask at this level at all": each half
 * already knows its own answer, and a composite that re-asks is a third place
 * for the two to drift apart.
 *
 * This is the composite of the two narrower handbacks: {@link
 * chownWorkspaceGitToSessionWorker} (object-aware `.git`) +
 * {@link chownWorktreeToSessionWorker} (worktree minus the declared dep dirs,
 * read from the workspace's `shipit.yaml`; falls back to {@link DEFAULT_DEP_DIRS}
 * when the config can't be read). Handing back ONLY `.git` — which the
 * session-setup paths used to do — leaves the worktree owned by whichever uid
 * the git op ran as, so the non-root agent can run git but EACCESes on its first
 * edit of a tracked file (docs/150 §7 / planning#147).
 *
 * **planning#412 — that uid is not "root".** On an existing session tree, an
 * orchestrator-side git drops to the session's identity since
 * docs/266-orchestrator-git-trust-boundary E1, so the ops named above write
 * files the session already owns; root is left only for a tree a git op CREATES
 * (`cloneFromCache`'s bare `safeSimpleGit()`) and where no identity resolves
 * (local mode, dev, tests, where this whole function is a no-op). The call is
 * still owed on every path below, because the two halves reconcile two
 * *different* consumers of one directory — see {@link resolveGitDirOwner} — but
 * a reader should not carry away "the orchestrator wrote this as root".
 *
 * Use this from every orchestrator-side path that mutates a per-session
 * workspace's worktree: session setup (warm-pool create, claim refresh,
 * claim branch-off), rebase, and fork-merge. The dep-dir skip keeps the walk
 * bounded by the source tree rather than the (potentially populated)
 * `node_modules`, which the worker already owns via its own install / the
 * overlay mount.
 */
export function handWorkspaceBackToWorker(workspaceDir: string): void {
  // No composite-level gate: each half owns its own, per the docstring above.
  // `chownWorktreeToSessionWorker` self-gates on the same `identityForTarget`
  // this used to ask here, so the only thing a gate at this level can still buy
  // is skipping the `resolveShipitConfig` read below — not worth a third place
  // for the predicate to go stale.
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
 * Hand a **plugin generation's checkout** to the identity that will run the
 * install in it — object-aware, so it cannot reach through a hardlink into the
 * shared plugin bare cache (planning#417, docs/272-shared-cache-ownership req 3).
 *
 * ## What this replaces, and why it was wrong
 *
 * `plugin-install.ts` used the plain recursive {@link chownTreeToSessionWorker}
 * here. The tree it names is the one `plugin-generations.ts`'s `checkoutCommit`
 * created with `git clone --local` from the shared plugin bare cache — which
 * lives under the SAME `repo-cache/<hash>` root as every session's bare cache —
 * so `.git/objects` is hardlinked into it and an inode has exactly one owner
 * across every link. The recursive walk therefore handed **the cache's** object
 * files to whichever session installed last, and with them chmod and rewrite
 * rights over content every other generation and every sibling session reads.
 * Observed on disk: object files inside the root-owned production caches owned by
 * uid 1000, and inside one cache by 2000024 — a per-session worker uid.
 *
 * ## Why this is not simply {@link handWorkspaceBackToWorker}
 *
 * It is that composite **minus the dep-dir exclusion**, and the difference is the
 * point:
 *
 *   - The dep-dir skip exists to keep a walk from crossing a populated
 *     `node_modules` the worker already owns. A fresh plugin checkout has no
 *     populated dep dir — and if the repository *commits* one, that directory is
 *     part of the overlay's **lower** dir, so it must be worker-owned or the
 *     install fails at its first copy-up. Excluding it here would reintroduce, by
 *     a different route, the failure the chown at that call site exists to
 *     prevent.
 *   - The object-awareness is what closes planning#417.
 *
 * ## The constraint this preserves rather than narrowing away
 *
 * `plugin-install.ts`'s comment names a real reason for chowning at all:
 * **overlayfs takes the merged directory's permissions from the LOWER dir**, so a
 * root-owned checkout leaves the plugin root unwritable and every install fails
 * at its first file. That is unaffected — the lower dir's root and every worktree
 * file below it are still handed over. The ONLY thing left alone is the immutable
 * `0444` object data files, which the install never writes: an install runs
 * `npm ci` and friends over the worktree, not over `.git/objects`. So the
 * narrowing costs the install nothing and closes the cross-session hole.
 *
 * No-op wherever no identity resolves — the non-root runtime off, every test.
 */
export function handPluginCheckoutToWorker(checkoutDir: string): void {
  // Each half self-gates, for the reason `handWorkspaceBackToWorker`'s docstring
  // gives: asking one predicate at this level is a third place for the two to
  // drift apart.
  chownWorkspaceGitToSessionWorker(checkoutDir);
  chownWorktreeToSessionWorker(checkoutDir);
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
  // docs/272 — the dep dir ROOT must be group-writable too, or a Compose service
  // that is not this session's uid cannot create a cache directory inside it at
  // all. docs/271 made the worktree group-writable and this path was left out of
  // that, because the worktree walk deliberately EXCLUDES the dep dirs (a bounded
  // walk, `chownWorktreeToSessionWorker`'s `excludeRelDirs`) — so `node_modules`
  // was the one place a service still could not write, which is precisely where
  // every dev server puts its cache (`node_modules/.vite`, `.cache`).
  //
  // O(1): one `lstat` and at most one `chmod`, on a directory this function is
  // about to `readdir` anyway.
  const rootStat = lstatOrNull(depDirPath);
  if (rootStat === null) return; // dep dir doesn't exist yet (no install)
  // A SYMLINKED dep dir is not this pass's to walk. `addGroupWrite` would skip
  // the link itself (a symlink's mode is meaningless, and `chmod` follows it),
  // but `readdirSync` DOES follow it — so continuing would chown and now also
  // chmod the children of whatever it points at, possibly outside the session
  // entirely. Refusing the whole path is the only coherent answer, and it tightens
  // the chown below as well: that already followed such a link (review finding A).
  if (rootStat.isSymbolicLink()) return;
  addGroupWrite(depDirPath, rootStat);
  let entries: string[];
  try {
    entries = fs.readdirSync(depDirPath);
  } catch {
    return; // unreadable — nothing to reconcile
  }
  for (const entry of entries) {
    const child = path.join(depDirPath, entry);
    const stat = lstatOrNull(child);
    if (stat === null) continue; // vanished mid-scan
    if (stat.uid !== owner.uid || stat.gid !== owner.gid) {
      // Leaked tree (a cache some other uid wrote here) — chown it whole, and
      // group-write it for the same reason the root above gets it: the next
      // writer may be a service running as a uid that is not this one. Bounded by
      // the LEAK size, not the dependency count, so the recursive mode pass costs
      // nothing in the common case where there is no leak at all.
      chownRecursive(child, owner);
      groupWriteRecursive(child);
    }
  }
}

/** `lstat` or null — the "it vanished mid-scan" case, which is never an error. */
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * {@link addGroupWrite} over a tree, for a leaked cache the reconcile just took
 * ownership of.
 *
 * Deliberately NOT folded into {@link chownRecursive}, which also walks the
 * per-session CREDENTIAL subtree (`chownTreeToSessionWorker`). Credentials are
 * `0600`/`0700` on purpose and must not become group-readable, let alone
 * group-writable — docs/270 makes the same point about the global gitconfig. A
 * mode change belongs to the callers that want one, not to the shared chown.
 */
function groupWriteRecursive(p: string): void {
  const stat = lstatOrNull(p);
  if (stat === null) return;
  addGroupWrite(p, stat);
  if (!stat.isDirectory()) return; // a symlink lstats as a non-directory
  let entries: string[];
  try {
    entries = fs.readdirSync(p);
  } catch {
    return;
  }
  for (const entry of entries) groupWriteRecursive(path.join(p, entry));
}

/**
 * Recursive worktree chown that skips `.git` + the declared dep dirs (matched by
 * path relative to the worktree root, so a nested `client/node_modules` is
 * skipped too). Mirrors {@link chownRecursive} otherwise: chown every node,
 * descend real directories only (a symlink lstats as a non-directory, so it's
 * chowned in place and never followed out of the tree).
 *
 * Appends every real directory it visits to `dirs`, for the default-ACL pass the
 * caller runs afterwards ({@link applyDefaultGroupAcl}). Collected here rather
 * than re-walked because "which directories did this handoff mode" is one
 * question with one answer, and a second walk with its own copy of the prune set
 * is exactly how the two would drift.
 */
function chownWorktreeRecursive(
  p: string,
  owner: SessionIdentity,
  root: string,
  exclude: Set<string>,
  dirs: string[],
): void {
  const rel = path.relative(root, p);
  if (rel !== "" && exclude.has(rel)) return; // skip .git + declared dep dirs
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return; // gone — nothing to own
  }
  lchownLogged(p, owner);
  // docs/271 — and group-writable, so a Compose service that is NOT this
  // session's uid can still write the workspace it shares with the agent.
  //
  // The owner above cannot be that service's uid, and there is no way to make it
  // one: a service's uid is either ShipIt's fill-in (this session's identity) or
  // one the project declared, and a project may not declare an identity in the
  // session range (docs/270 req 4a). So the GROUP is the only channel the two can
  // share — and it is already shared, because every session runs with the same
  // gid. What was missing is the write bit: a root orchestrator materializes the
  // checkout under umask 022, i.e. 0644/0755, and this walk chowned it without
  // ever touching the mode. Every Compose service in every repository therefore
  // got a workspace it could read and not write (github#2374: three Vite dev
  // servers died at once on the config-bundle temp file).
  //
  // This costs no isolation, and it is not a new judgement. The session
  // directory is 0700 ({@link sealSessionDir}), which is the whole cross-session
  // boundary, so a group-writable file inside a session is unreachable to every
  // uid outside it. The entrypoint's `umask 002` already rests on exactly that
  // reasoning for the files the agent creates AFTER boot; this applies the same
  // rule to the ones root created before it.
  addGroupWrite(p, stat);
  if (stat.isDirectory()) {
    dirs.push(p);
    let entries: string[];
    try {
      entries = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const entry of entries) {
      chownWorktreeRecursive(path.join(p, entry), owner, root, exclude, dirs);
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
