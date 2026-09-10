// The proxy shares a service's IP, so authenticate its query with a sidecar-only secret.
// Recover tokens from live sidecar environments after orchestrator restart.
import crypto from "node:crypto";

export const EGRESS_DECISION_TOKEN_ENV = "EGRESS_PROXY_DECISION_TOKEN";
export const EGRESS_DECISION_HEADER = "x-shipit-egress-token";
export const EGRESS_DECISION_PATH = "/api/egress/decision";

const TOKEN_BYTES = 32;
// Must exceed the live proxy count, or recovery repeatedly evicts still-valid tokens.
const MAX_TOKENS_PER_SESSION = 512;
const RECOVERY_INTERVAL_MS = 5_000;

const tokensBySession = new Map<string, string[]>();
const lastRecoveryAt = new Map<string, number>();

export type EgressDecisionTokenRecovery = (sessionId: string) => Promise<string[]>;

let recover: EgressDecisionTokenRecovery | undefined;

export function setEgressDecisionTokenRecovery(
  fn: EgressDecisionTokenRecovery | undefined,
): void {
  recover = fn;
}

export function mintEgressDecisionToken(sessionId: string): string {
  const token = crypto.randomBytes(TOKEN_BYTES).toString("hex");
  registerToken(sessionId, token);
  return token;
}

export function clearEgressDecisionTokens(sessionId: string): void {
  tokensBySession.delete(sessionId);
  lastRecoveryAt.delete(sessionId);
}

export function clearAllEgressDecisionTokens(): void {
  tokensBySession.clear();
  lastRecoveryAt.clear();
  recover = undefined;
}

export function isEgressDecisionPath(pathname: string): boolean {
  return pathname === EGRESS_DECISION_PATH;
}

export function presentedEgressDecisionToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const value = headers[EGRESS_DECISION_HEADER];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function verifyEgressDecisionToken(
  sessionId: string,
  presented: string,
): Promise<boolean> {
  if (!plausibleToken(presented)) return false;
  if (matches(sessionId, presented)) return true;
  if (!recover) return false;

  // Bound Docker inspections triggered by container-supplied tokens.
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

function matches(sessionId: string, presented: string): boolean {
  const known = tokensBySession.get(sessionId);
  if (!known || known.length === 0) return false;
  const presentedBuf = Buffer.from(presented, "utf8");
  let found = false;
  for (const token of known) {
    const tokenBuf = Buffer.from(token, "utf8");
    // Compare every candidate so timing does not reveal which token matched.
    if (tokenBuf.length === presentedBuf.length
      && crypto.timingSafeEqual(tokenBuf, presentedBuf)) {
      found = true;
    }
  }
  return found;
}

function plausibleToken(value: string): boolean {
  return new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`).test(value);
}
