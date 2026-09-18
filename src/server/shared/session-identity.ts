import fs from "node:fs";
import path from "node:path";

export interface SessionIdentity {
  uid: number;
  gid: number;
}

interface Roots {
  sessionsRoot: string;
  credentialsSessionsRoot?: string;
  fallbackIdentity?: SessionIdentity;
}

let roots: Roots | null = null;

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

function firstSegmentUnder(root: string, p: string): string | null {
  const rel = path.relative(root, path.resolve(p));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [first] = rel.split(path.sep);
  return first ? first : null;
}

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

export function sessionDirFor(sessionId: string): string | null {
  return roots === null ? null : path.join(roots.sessionsRoot, sessionId);
}

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
 * Read the orchestrator-owned session directory, never the mutable workspace.
 * A root-owned directory has no identity record; use the configured fallback.
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
