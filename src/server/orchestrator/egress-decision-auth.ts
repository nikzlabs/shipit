/**
 * planning#371 — authenticate the Tier C egress decision query, so the ONE route a
 * Compose service's namespace legitimately reaches is admitted by a secret the
 * service cannot read, rather than by the source IP it shares with that secret's
 * holder.
 *
 * ## Why an IP cannot decide this
 *
 * `GET /api/egress/decision` is queried by the SNI proxy sidecar
 * (`egress-proxy-install.ts`), which runs with `NetworkMode: container:<service>`
 * — it has no address of its own. Its packets leave from the service container's
 * IP, which `SessionContainerManager.getSessionByAnyContainerIp`
 * (`session-container.ts:1228`) resolves to the owning session, and
 * `api-container-guard.ts` therefore read as "a container of that session" and
 * admitted the session's whole container-accessible route table — including
 * `POST /api/sessions/:id/git/credential` (`api-routes-github.ts:479`), which
 * returns a real fetch credential. The session id was no obstacle: a service's
 * workspace mount is a volume subpath, so `/proc/self/mountinfo` names the full
 * session uuid.
 *
 * So the service IP is now denied outright at the guard, and this module is what
 * keeps the sidecar working across that denial.
 *
 * ## Why a secret in the sidecar's environment is not readable by the service
 *
 * This is the load-bearing property, and it is worth stating precisely because
 * "shares a namespace" reads like "shares everything". `launchEgressProxy` sets
 * `NetworkMode: container:<id>` and NOTHING else — no `PidMode`, no `IpcMode`, no
 * mounts. The sidecar is a separate container: its own filesystem, its own PID
 * namespace, its own `/proc`. The service cannot read `/proc/<proxy>/environ`
 * because that pid is not in its namespace, and cannot read the sidecar's image
 * or env any other way. What the two DO share is the network stack, so a service
 * with `NET_RAW` could sniff this token off the wire — `validateServiceSecurity`
 * (`compose-generator.ts:693`) rejects `cap_add` for a contained service, and the
 * residual is bounded by what the token unlocks: this one query-only route, for
 * the session that already owns it. It grants nothing (granting is the
 * browser-only `egress_decision` WS path), so the worst outcome is a card the
 * user is asked to approve.
 *
 * ## Why the registry can be rebuilt from Docker
 *
 * A token minted by a live orchestrator sits in a sidecar that outlives it. An
 * in-memory-only registry would therefore go blank on an orchestrator restart and
 * silently deny every allow-once query until each service was restarted — the
 * failure mode this area has shipped before. `worker-auth.ts` already answered
 * this class of problem: **the container's own environment is the source of
 * truth**, re-read with `docker inspect` rather than persisted beside the
 * process. {@link setEgressDecisionTokenRecovery} is that seam here; the
 * in-memory map is only the fast path.
 */

import crypto from "node:crypto";

/** Env var the SNI proxy reads its decision-query token from. */
export const EGRESS_DECISION_TOKEN_ENV = "EGRESS_PROXY_DECISION_TOKEN";

/** Header the SNI proxy presents it in. Lower-case: Fastify normalizes. */
export const EGRESS_DECISION_HEADER = "x-shipit-egress-token";

/** The one path this token authenticates. Nothing else accepts it. */
export const EGRESS_DECISION_PATH = "/api/egress/decision";

/** 32 bytes, hex — the shape {@link plausibleToken} pre-filters on. */
const TOKEN_BYTES = 32;

/**
 * How many tokens a session keeps. A session mints one per proxy launch, and a
 * proxy is relaunched on every allowlist reload and every service recreation, so
 * an unbounded set would grow for the session's whole life. The old sidecar is
 * removed before the new one starts, so in practice only the newest is live;
 * the slack covers a reload racing a `compose up` on a multi-service stack.
 */
const MAX_TOKENS_PER_SESSION = 16;

/** Don't re-inspect Docker more often than this per session on a token miss. */
const RECOVERY_INTERVAL_MS = 5_000;

/** sessionId → tokens this orchestrator minted or recovered, newest last. */
const tokensBySession = new Map<string, string[]>();

/** sessionId → when Docker was last consulted for this session's tokens. */
const lastRecoveryAt = new Map<string, number>();

/** Rebuilds a session's token set from the live sidecars. See the docstring. */
export type EgressDecisionTokenRecovery = (sessionId: string) => Promise<string[]>;

let recover: EgressDecisionTokenRecovery | undefined;

/**
 * Install the Docker-backed recovery seam. Called once at boot where a Docker
 * handle exists; without it the registry is memory-only, which is correct for
 * tests and local mode (no sidecars exist there to have tokens).
 */
export function setEgressDecisionTokenRecovery(
  fn: EgressDecisionTokenRecovery | undefined,
): void {
  recover = fn;
}

/**
 * Mint and register a decision-query token for `sessionId`.
 *
 * Called by {@link launchEgressProxy} for every proxy that is given a decision
 * URL — the agent's own and each Compose service's. A proxy WITHOUT one (the
 * plugin CLI / install namespaces, `plugin-egress.ts`) gets no token, because it
 * makes no query: req 19 denies it that whole surface, and nothing here changes
 * that.
 */
export function mintEgressDecisionToken(sessionId: string): string {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  registerToken(sessionId, token);
  return token;
}

/** Forget a session's tokens — its containers, and their sidecars, are gone. */
export function clearEgressDecisionTokens(sessionId: string): void {
  tokensBySession.delete(sessionId);
  lastRecoveryAt.delete(sessionId);
}

/** Test seam — the registry is process-wide, like the sidecars it describes. */
export function clearAllEgressDecisionTokens(): void {
  tokensBySession.clear();
  lastRecoveryAt.clear();
  recover = undefined;
}

/** Whether `pathname` is the one route a sidecar token authenticates. */
export function isEgressDecisionPath(pathname: string): boolean {
  return pathname === EGRESS_DECISION_PATH;
}

/**
 * Read the presented token out of a request's headers. Returns `undefined` for
 * an absent or non-string value (a duplicated header arrives as an array, which
 * is not a token any sidecar of ours sent).
 */
export function presentedEgressDecisionToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers[EGRESS_DECISION_HEADER];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Is `presented` a token this session's proxy sidecar was launched with?
 *
 * Compared in constant time, against this session's tokens only — a token is
 * never valid for another session, so the own-session scope the IP guard used to
 * provide is carried by the token itself.
 *
 * On a miss, and at most once per {@link RECOVERY_INTERVAL_MS}, the session's
 * live sidecars are re-read (see the module docstring). The throttle matters:
 * the caller is reachable from a container, so an unthrottled miss would be a
 * way to make the orchestrator inspect Docker in a loop.
 */
export async function verifyEgressDecisionToken(
  sessionId: string,
  presented: string,
): Promise<boolean> {
  if (!plausibleToken(presented)) return false;
  if (matches(sessionId, presented)) return true;
  if (!recover) return false;

  const now = Date.now();
  if (now - (lastRecoveryAt.get(sessionId) ?? 0) < RECOVERY_INTERVAL_MS) return false;
  lastRecoveryAt.set(sessionId, now);
  let recovered: string[];
  try {
    recovered = await recover(sessionId);
  } catch (error) {
    console.warn(`[egress-decision:${sessionId}] could not re-read sidecar tokens:`, error);
    return false;
  }
  for (const token of recovered) {
    if (plausibleToken(token)) registerToken(sessionId, token);
  }
  return matches(sessionId, presented);
}

/**
 * Pull the token out of a container's `Config.Env` (the `KEY=value` array
 * `docker inspect` returns) — the same shape `workerTokenFromContainerEnv`
 * reads, for the same reason.
 */
export function tokenFromContainerEnv(env: string[] | undefined): string | undefined {
  if (!env) return undefined;
  const prefix = `${EGRESS_DECISION_TOKEN_ENV}=`;
  for (const entry of env) {
    if (entry.startsWith(prefix)) {
      const value = entry.slice(prefix.length);
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function registerToken(sessionId: string, token: string): void {
  const existing = tokensBySession.get(sessionId) ?? [];
  if (existing.includes(token)) return;
  const next = [...existing, token];
  tokensBySession.set(sessionId, next.slice(-MAX_TOKENS_PER_SESSION));
}

/** Constant-time membership test over this session's tokens. */
function matches(sessionId: string, presented: string): boolean {
  const known = tokensBySession.get(sessionId);
  if (!known || known.length === 0) return false;
  const presentedBuf = Buffer.from(presented, "utf8");
  let found = false;
  for (const token of known) {
    const tokenBuf = Buffer.from(token, "utf8");
    // Compare every candidate — no early exit, so the answer's timing does not
    // depend on WHICH token matched.
    if (tokenBuf.length === presentedBuf.length
      && crypto.timingSafeEqual(tokenBuf, presentedBuf)) {
      found = true;
    }
  }
  return found;
}

/** Cheap shape check, so a junk header never reaches the Docker recovery path. */
function plausibleToken(value: string): boolean {
  return new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(value);
}
