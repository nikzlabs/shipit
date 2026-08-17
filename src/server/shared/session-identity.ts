/**
 * planning#405 / docs/270 — which session does a path belong to, and what uid is
 * that session?
 *
 * ## Why the session DIRECTORY is the record
 *
 * docs/266-orchestrator-git-trust-boundary E1 made orchestrator-side git run as the uid that owns the tree it is
 * about to touch. That predicate is sound while every session shares one uid,
 * and stops being sound the moment they do not: the workspace is bind-mounted
 * read-write into compose services, and an **Open** session's service may run as
 * root — the numeric-non-root `user:` rule is enforced for *contained* services
 * only (`compose-generator.ts`). So a service can `chown` its own session's
 * workspace to any uid, and under per-session uids that is the session choosing
 * the identity ShipIt's own git process will hold, and therefore the identity a
 * `.git/config` payload executes at (docs/270 req 2).
 *
 * `<sessionsRoot>/<sessionId>` is the fix, because it is the one directory in
 * the chain that no session can write. `buildMounts` mounts
 * `<sessionDir>/workspace`, the per-session credentials subtree, uploads,
 * scratch, session state, the plugin store, the dep cache and the pnpm store —
 * it never mounts the session directory itself. Its owner is therefore a fact
 * only the orchestrator can set, which is exactly what a security predicate
 * needs, and it survives every restart with no cache to go stale (req 5).
 *
 * The same directory carries the seal: it is mode 0700, so no other uid can
 * traverse into the session at all and no inner file's mode matters (req 1).
 *
 * ## Why this module is configured rather than clever
 *
 * It has to answer "is this path inside a session, and which one" without a
 * database, because it is called from `safeSimpleGit` — the choke point every
 * orchestrator git goes through — and from the chown helpers, which run on the
 * post-turn commit path. Two roots are enough to answer it, and both are known
 * at boot: the sessions root, and the credentials root whose
 * `sessions/<sessionId>` subtree is the session's private credential store.
 *
 * When the roots are NOT configured — local/dogfood mode, and every test —
 * every function here returns `null` and callers fall back to exactly the
 * behaviour they had before docs/270. That is what keeps this change inert
 * outside a containerized production orchestrator.
 */

import fs from "node:fs";
import path from "node:path";

/** A session's numeric identity: its own uid, and the SHARED worker gid. */
export interface SessionIdentity {
  uid: number;
  gid: number;
}

interface Roots {
  /** `<workspaceDir>/sessions` — parent of every `<sessionId>` directory. */
  sessionsRoot: string;
  /** Parent of `sessions/<sessionId>` in the credentials tree, or undefined. */
  credentialsSessionsRoot?: string;
  /**
   * The identity to use for a path that IS inside a session whose directory
   * carries no record — the single global worker uid.
   *
   * This exists so the answer for a session path is never "read it off the
   * tree". A session directory with no record means its seal did not run or did
   * not succeed, which is rare and logged; the honest fallback is the value the
   * deployment configured, which is not something any session can choose. The
   * tree, which a root compose service can `chown`, is exactly what must not be
   * consulted here (req 2).
   */
  fallbackIdentity?: SessionIdentity;
}

let roots: Roots | null = null;

/**
 * Point this module at the two roots that contain per-session paths. Called
 * once from orchestrator startup. Idempotent; a later call replaces the
 * previous roots (the tests use that).
 */
export function configureSessionIdentityRoots(next: Roots | null): void {
  roots = next === null
    ? null
    : {
      sessionsRoot: path.resolve(next.sessionsRoot),
      credentialsSessionsRoot: next.credentialsSessionsRoot
        ? path.resolve(next.credentialsSessionsRoot)
        : undefined,
      fallbackIdentity: next.fallbackIdentity,
    };
}

/** The configured sessions root, or null. Exported for diagnostics. */
export function sessionsRootOrNull(): string | null {
  return roots?.sessionsRoot ?? null;
}

/**
 * The first path segment of `p` under `root`, or null when `p` is not inside
 * `root`. Resolves both sides first, so a `..` in the input cannot walk out of
 * the root and then back in under a different session's name.
 */
function firstSegmentUnder(root: string, p: string): string | null {
  const rel = path.relative(root, path.resolve(p));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [first] = rel.split(path.sep);
  return first ? first : null;
}

/**
 * The session id a path belongs to, or null when it belongs to none (the shared
 * bare cache, the dep cache, `/opt/shipit`) or when the roots are unconfigured.
 */
export function sessionIdForPath(p: string | undefined): string | null {
  if (!p || roots === null) return null;
  const fromSessions = firstSegmentUnder(roots.sessionsRoot, p);
  if (fromSessions !== null) return fromSessions;
  if (roots.credentialsSessionsRoot) {
    const fromCreds = firstSegmentUnder(roots.credentialsSessionsRoot, p);
    if (fromCreds !== null) return fromCreds;
  }
  return null;
}

/** `<sessionsRoot>/<sessionId>`, or null when the roots are unconfigured. */
export function sessionDirFor(sessionId: string): string | null {
  return roots === null ? null : path.join(roots.sessionsRoot, sessionId);
}

/**
 * Injection seam — the interesting state (a directory owned by someone else)
 * cannot be produced in a session container: there is no root and `unshare -r`
 * is refused.
 */
export interface SessionIdentityDeps {
  statOwner: (dir: string) => { uid: number; gid: number } | null;
}

export const defaultSessionIdentityDeps: SessionIdentityDeps = {
  statOwner: (dir: string) => {
    try {
      const st = fs.statSync(dir);
      return { uid: st.uid, gid: st.gid };
    } catch {
      return null;
    }
  },
};

/**
 * The identity of the session that owns `p`, read from that session's directory.
 *
 * Returns null when the path belongs to no session or when the roots are
 * unconfigured. When the path DOES belong to a session but its directory carries
 * no record — vanished, or still **root-owned**, where root is the absence of a
 * record rather than a record saying root — the configured
 * {@link Roots.fallbackIdentity} is returned instead.
 *
 * It deliberately never falls back to the tree the caller named. A path inside a
 * session is answered from that session's directory or from the deployment's own
 * configured value, and from nothing a session can write (req 2).
 *
 * Deliberately uncached: one `statSync` is microseconds, and a cache would have
 * to be invalidated by every chown in `session-worker-uid.ts` — a correctness
 * risk for no measurable gain. Revisit only with a profile that names it.
 */
export function identityForPath(
  p: string | undefined,
  deps: SessionIdentityDeps = defaultSessionIdentityDeps,
): SessionIdentity | null {
  const sessionId = sessionIdForPath(p);
  if (sessionId === null) return null;
  const dir = sessionDirFor(sessionId);
  if (dir === null) return null;
  const owner = deps.statOwner(dir);
  if (owner === null || owner.uid === 0) return roots?.fallbackIdentity ?? null;
  return { uid: owner.uid, gid: owner.gid };
}
