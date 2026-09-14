/**
 * The SSH signer (docs/305-ssh-hosts, plan.md "the signer contract").
 *
 * Everything that decides whether ShipIt will sign lives here, because the
 * docs/201 bridge-IP guard identifies the *session*, not the process inside it
 * (`api-container-guard.ts:187`): the agent can call the sign route directly and
 * the design permits that. So the worker's socket enforces nothing and this does
 * all five checks, in order, refusing with a named reason that goes into the one
 * audit line every attempt produces (req 10).
 */

import { randomUUID } from "node:crypto";
import type { CredentialStore } from "../credential-store.js";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { ChatHistoryManager } from "../chat-history.js";
import { emitChatCard } from "../chat-card-persistence.js";
import { ServiceError } from "./types.js";
import {
  fingerprintOf,
  parseSessionBind,
  parseUserauthRequest,
  signWithHostKey,
  verifyHostKeySignature,
} from "../ssh-hosts.js";
import { blobType } from "../../shared/ssh-wire.js";
import type { SshHostKeyCard, SshHostPublic } from "../../shared/types.js";

/**
 * Declared structurally rather than as the managers themselves: the signer
 * reads four methods, and naming them is what keeps `getSshHostSigningKey` — the
 * one accessor that yields a private key — visible at every call site.
 */
export interface SshServiceDeps {
  credentialStore: Pick<
    CredentialStore,
    "listSshHosts" | "getSshHostSigningKey" | "recordSshHostKey"
  >;
  sessionManager: Pick<SessionManager, "get">;
  runnerRegistry?: Pick<SessionRunnerRegistry, "get">;
  chatHistoryManager?: Pick<ChatHistoryManager, "append" | "replaceInProgress" | "hasInProgress">;
  now?: () => number;
}

export interface SshIdentity {
  /** base64 of the public-key blob `ssh` will offer. */
  publicKeyBlob: string;
  comment: string;
}

export type SshRefusalReason =
  | "not-granted"
  | "no-bind"
  | "bad-bind"
  | "forwarding"
  | "host-key-mismatch"
  | "not-userauth"
  | "session-id-mismatch"
  | "user-mismatch"
  | "rate-limited";

export interface SshSignRequest {
  /** base64 of the key blob whose private half is requested. */
  keyBlob: string;
  /** base64 of the bytes to sign. */
  data: string;
  /** base64 of the `session-bind@openssh.com` extension payload. */
  bind?: string;
}

/** Bounds a compromised agent to a nuisance rather than an oracle (rule 5). */
const RATE_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 60;
const MAX_CONCURRENT = 4;

interface RateState {
  attempts: number[];
  inFlight: number;
}

const rateBySession = new Map<string, RateState>();

/** Test hook; the map is process-lived by design. */
export function _resetSshRateLimits(): void {
  rateBySession.clear();
}

function takeRateSlot(sessionId: string, now: number): boolean {
  const state = rateBySession.get(sessionId) ?? { attempts: [], inFlight: 0 };
  rateBySession.set(sessionId, state);
  state.attempts = state.attempts.filter((t) => now - t < RATE_WINDOW_MS);
  if (state.attempts.length >= MAX_ATTEMPTS_PER_WINDOW) return false;
  if (state.inFlight >= MAX_CONCURRENT) return false;
  state.attempts.push(now);
  state.inFlight++;
  return true;
}

function releaseRateSlot(sessionId: string): void {
  const state = rateBySession.get(sessionId);
  if (state && state.inFlight > 0) state.inFlight--;
}

export function grantedSshHosts(deps: SshServiceDeps, sessionId: string): SshHostPublic[] {
  const granted = new Set(deps.sessionManager.get(sessionId)?.sshHosts ?? []);
  return deps.credentialStore.listSshHosts().filter((h) => granted.has(h.id));
}

/**
 * `IdentitiesOnly yes` in the provisioned config keeps `ssh` from offering keys
 * this session has no grant for, but the answer is authoritative regardless:
 * identities are resolved per request, so a revoked grant stops appearing with
 * no socket restart.
 */
export function listSshIdentities(deps: SshServiceDeps, sessionId: string): SshIdentity[] {
  return grantedSshHosts(deps, sessionId).map((h) => ({
    publicKeyBlob: h.publicKeyBlob,
    comment: `${h.label} (${h.user}@${h.address})`,
  }));
}

interface AuditFields {
  sessionId: string;
  host?: SshHostPublic;
  user?: string;
  outcome: "signed" | "refused";
  reason?: SshRefusalReason;
  detail?: string;
}

/**
 * One line per authentication attempt (req 10). It records an *attempt*: the
 * orchestrator never learns whether the server accepted the signature, so a
 * "signed" line followed by a failing `ssh` points at the server side.
 *
 * No signing input and no host record is ever in it — a signature or a key blob
 * in a log line is the leak this whole design exists to prevent.
 */
function audit(fields: AuditFields): void {
  const parts = [
    `session=${fields.sessionId}`,
    `destination=${fields.host ? `${fields.host.label}[${fields.host.id}]` : "unknown"}`,
    `address=${fields.host ? `${fields.host.address}:${fields.host.port}` : "unknown"}`,
    `user=${fields.user ?? fields.host?.user ?? "unknown"}`,
    `at=${new Date().toISOString()}`,
    `outcome=${fields.outcome}`,
  ];
  if (fields.reason) parts.push(`reason=${fields.reason}`);
  if (fields.detail) parts.push(`detail=${fields.detail}`);
  console.log(`[ssh-sign] ${parts.join(" ")}`);
}

function emitHostKeyCard(
  deps: SshServiceDeps,
  sessionId: string,
  card: SshHostKeyCard,
): void {
  const persisted = { role: "assistant" as const, text: "", sshHostKey: card };
  const history = deps.chatHistoryManager;
  if (!history) return;
  const runner = deps.runnerRegistry?.get(sessionId);
  if (!runner) {
    history.append(sessionId, persisted);
    return;
  }
  emitChatCard(
    runner,
    { type: "ssh_host_key_card", sessionId, card },
    persisted,
    { chatHistoryManager: history, sessionId },
  );
}

function refuse(
  deps: SshServiceDeps,
  fields: Omit<AuditFields, "outcome">,
  message: string,
): never {
  audit({ ...fields, outcome: "refused" });
  throw new ServiceError(403, message);
}

/**
 * Sign, or refuse. Returns base64 of the SSH signature blob.
 *
 * The endpoint is stateless: the bind travels with every request, so nothing
 * here depends on which socket connection the worker held it on.
 */
export function signSshRequest(
  deps: SshServiceDeps,
  sessionId: string,
  request: SshSignRequest,
): { signature: string } {
  const now = deps.now?.() ?? Date.now();

  // Rule 1 — the session's grant includes the destination whose key is asked for.
  const host = grantedSshHosts(deps, sessionId).find((h) => h.publicKeyBlob === request.keyBlob);
  if (!host) {
    refuse(
      deps,
      { sessionId, reason: "not-granted" },
      "This session is not granted an SSH destination with that key.",
    );
  }

  // Rule 5 first among the cheap checks: a flood must not cost a verification.
  if (!takeRateSlot(sessionId, now)) {
    refuse(
      deps,
      { sessionId, host, reason: "rate-limited" },
      "Too many SSH authentication attempts from this session; try again shortly.",
    );
  }

  try {
    // Rule 2 — a real key exchange with a real server, not a forwarded agent.
    if (!request.bind) {
      refuse(
        deps,
        { sessionId, host, reason: "no-bind" },
        "ShipIt signs only for a connection bound to its server's host key.",
      );
    }
    const bind = parseSessionBind(Buffer.from(request.bind, "base64"));
    if (!bind) {
      refuse(
        deps,
        { sessionId, host, reason: "bad-bind" },
        "The session binding was not a well-formed session-bind@openssh.com message.",
      );
    }
    if (bind.isForwarding) {
      refuse(
        deps,
        { sessionId, host, reason: "forwarding" },
        "ShipIt refuses to sign for a forwarded agent connection.",
      );
    }
    if (!verifyHostKeySignature(bind)) {
      refuse(
        deps,
        { sessionId, host, reason: "bad-bind", detail: "host-key-signature" },
        "The server's signature over the session identifier did not verify.",
      );
    }

    // Rule 3 — the host key is the recorded one, or this bind records it (TOFU).
    const seenFingerprint = fingerprintOf(bind.hostKeyBlob);
    const keyType = blobType(Buffer.from(bind.hostKeyBlob, "base64")) ?? "unknown";
    const pinned = deps.credentialStore.getSshHostSigningKey(host.id);
    if (!pinned) {
      refuse(
        deps,
        { sessionId, host, reason: "not-granted", detail: "destination-removed" },
        "That SSH destination no longer exists.",
      );
    }
    if (!pinned.hostKeyBlob) {
      const recorded = deps.credentialStore.recordSshHostKey(host.id, bind.hostKeyBlob, {
        fingerprint: seenFingerprint,
        keyType,
      });
      if (recorded) {
        emitHostKeyCard(deps, sessionId, {
          cardId: `ssh-host-key-${randomUUID()}`,
          hostId: host.id,
          label: host.label,
          address: host.address,
          kind: "recorded",
          fingerprint: seenFingerprint,
          keyType,
          createdAt: new Date().toISOString(),
        });
      }
    } else if (pinned.hostKeyBlob !== bind.hostKeyBlob) {
      emitHostKeyCard(deps, sessionId, {
        cardId: `ssh-host-key-${randomUUID()}`,
        hostId: host.id,
        label: host.label,
        address: host.address,
        kind: "mismatch",
        fingerprint: seenFingerprint,
        keyType,
        ...(host.hostKeyFingerprint ? { recordedFingerprint: host.hostKeyFingerprint } : {}),
        createdAt: new Date().toISOString(),
      });
      refuse(
        deps,
        { sessionId, host, reason: "host-key-mismatch", detail: seenFingerprint },
        `The host key ${host.address} presented does not match the one ShipIt recorded.`,
      );
    }

    // Rule 4 — userauth publickey only, for this connection, as this user.
    const parsed = parseUserauthRequest(Buffer.from(request.data, "base64"));
    if (parsed?.service !== "ssh-connection" || parsed.method !== "publickey"
      || !parsed.hasSignature || parsed.publicKeyBlob !== host.publicKeyBlob) {
      refuse(
        deps,
        { sessionId, host, reason: "not-userauth" },
        "ShipIt signs only an SSH publickey authentication request for this destination.",
      );
    }
    if (!parsed.sessionId.equals(bind.sessionId)) {
      refuse(
        deps,
        { sessionId, host, reason: "session-id-mismatch" },
        "The request to sign belongs to a different SSH connection than the bound one.",
      );
    }
    if (parsed.user !== host.user) {
      refuse(
        deps,
        { sessionId, host, user: parsed.user, reason: "user-mismatch" },
        `This destination authenticates as ${host.user}, not ${parsed.user}.`,
      );
    }

    const signature = signWithHostKey(pinned.privateKeyPem, Buffer.from(request.data, "base64"));
    audit({ sessionId, host, user: parsed.user, outcome: "signed" });
    return { signature: signature.toString("base64") };
  } finally {
    releaseRateSlot(sessionId);
  }
}
