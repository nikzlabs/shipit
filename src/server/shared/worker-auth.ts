import crypto from "node:crypto";

export const WORKER_AUTH_HEADER = "x-shipit-worker-token";
export const WORKER_TOKEN_ENV = "SHIPIT_WORKER_TOKEN";

// A token does not grant access to the agent's local-only routes.
export const LOOPBACK_ONLY_PREFIXES: readonly string[] = [
  "/agent-ops/",
  "/present-files/",
];

// Require a token even on loopback to prevent accidental resident-agent teardown.
export const LIFECYCLE_PATHS: ReadonlySet<string> = new Set([
  "/agent/start",
  "/agent/interrupt",
  "/agent/kill",
  "/agent/spawn",
  "/agent/stdin",
  "/agent/message",
  "/agent/permission-mode",
  "/agent/compact",
  "/agent/permission/resolve",
]);

const UNAUTHENTICATED_PATHS: readonly string[] = ["/health"];

// Match find-my-way: strip absolute-form authority and ?/# suffixes, but not semicolons.
export function routerPathname(rawUrl: string): string {
  let path = rawUrl.length > 0 ? rawUrl : "/";
  if (path.charCodeAt(0) !== 47) path = path.replace(/^https?:\/\/.*?\//, "/");
  const cut = path.slice(1).search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut + 1);
}

function pathVariants(pathname: string): string[] {
  try {
    // The router uses decodeURI, which leaves encoded separators such as %2F intact.
    const decoded = decodeURI(pathname);
    return decoded === pathname ? [pathname] : [pathname, decoded];
  } catch {
    return [pathname];
  }
}

export function isLoopbackOnlyPath(pathname: string): boolean {
  return pathVariants(pathname).some((candidate) =>
    LOOPBACK_ONLY_PREFIXES.some((prefix) => candidate.startsWith(prefix)),
  );
}

export function isLifecyclePath(pathname: string): boolean {
  return pathVariants(pathname).some((candidate) => {
    const normalized = candidate.length > 1 && candidate.endsWith("/")
      ? candidate.slice(0, -1)
      : candidate;
    return LIFECYCLE_PATHS.has(normalized);
  });
}

export function normalizePeerAddress(remoteAddress: string | undefined | null): string | null {
  if (!remoteAddress) return null;
  return remoteAddress.replace(/^::ffff:/i, "").replace(/%.*$/, "");
}

/** Use the socket peer, never a caller-controlled forwarded header. */
export function isLoopbackAddress(remoteAddress: string | undefined | null): boolean {
  const ip = normalizePeerAddress(remoteAddress);
  if (!ip) return false;
  if (ip === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
}

export function generateWorkerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function tokensMatch(expected: string | undefined, presented: unknown): boolean {
  if (!expected || typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface WorkerRequestOrigin {
  /** Raw request.url, including query, fragment, and any authority. */
  url: string;
  remoteAddress: string | undefined | null;
  presentedToken: unknown;
  configuredToken: string | undefined;
}

export interface WorkerAuthDecision {
  allow: boolean;
  reason:
    | "unauthenticated-path"
    | "loopback"
    | "token"
    | "no-token-configured"
    | "loopback-only"
    | "lifecycle-needs-token"
    | "bad-token";
}

export function decideWorkerRequest(origin: WorkerRequestOrigin): WorkerAuthDecision {
  const pathname = routerPathname(origin.url);

  if (UNAUTHENTICATED_PATHS.includes(pathname)) {
    return { allow: true, reason: "unauthenticated-path" };
  }

  const loopback = isLoopbackAddress(origin.remoteAddress);

  if (isLoopbackOnlyPath(pathname)) {
    return loopback
      ? { allow: true, reason: "loopback" }
      : { allow: false, reason: "loopback-only" };
  }

  // Check before allowing loopback. Tokenless in-process test workers still use loopback.
  if (origin.configuredToken !== undefined && isLifecyclePath(pathname)) {
    return tokensMatch(origin.configuredToken, origin.presentedToken)
      ? { allow: true, reason: "token" }
      : { allow: false, reason: "lifecycle-needs-token" };
  }

  if (loopback) return { allow: true, reason: "loopback" };

  if (origin.configuredToken === undefined) {
    return { allow: false, reason: "no-token-configured" };
  }

  return tokensMatch(origin.configuredToken, origin.presentedToken)
    ? { allow: true, reason: "token" }
    : { allow: false, reason: "bad-token" };
}
