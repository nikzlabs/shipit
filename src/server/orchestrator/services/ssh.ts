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
  SSH_ED25519,
  USERAUTH_PUBLICKEY_HOSTBOUND,
  fingerprintOf,
  parseSessionBind,
  parseUserauthRequest,
  signWithHostKey,
  verifyHostKeySignature,
} from "../ssh-hosts.js";
import { blobType } from "../../shared/ssh-wire.js";
import {
  scanSshHostKey,
  type SshHostKeyScanResult,
  type SshHostKeyScanner,
} from "../ssh-keyscan.js";
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
  /** Injected in tests; production spawns `ssh-keyscan` (req 13). */
  scanHostKey?: SshHostKeyScanner;
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
  | "host-key-unverified"
  | "not-userauth"
  | "wrong-algorithm"
  | "hostbound-mismatch"
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

/**
 * Rule 5 — bound a compromised agent to a nuisance rather than an oracle.
 *
 * The rate slot is taken synchronously, before the one step that can suspend
 * (the req 13 host-key scan), so a flood is bounded whether or not requests
 * interleave. Concurrency is bounded where it can actually cost something: the
 * scan is deduplicated per destination by {@link scansInFlight}, so N concurrent
 * first connections spawn one `ssh-keyscan`, not N. Every other step is
 * synchronous, and the stretch from re-reading the pin to recording it contains
 * no `await` — which is what makes the check-then-record atomic.
 */
const RATE_WINDOW_MS = 60_000;
const MAX_ATTEMPTS_PER_WINDOW = 60;

const attemptsBySession = new Map<string, number[]>();

/** Test hook; the map is process-lived by design. */
export function _resetSshRateLimits(): void {
  attemptsBySession.clear();
}

function takeRateSlot(sessionId: string, now: number): boolean {
  const recent = (attemptsBySession.get(sessionId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  attemptsBySession.set(sessionId, recent);
  if (recent.length >= MAX_ATTEMPTS_PER_WINDOW) return false;
  recent.push(now);
  return true;
}

/**
 * One scan in flight per *scan*, not per destination: the key is everything
 * that decides what a scan answers — address, port and key family. Sharing
 * across any of those would hand one request an answer about a different
 * question: a different family's keys, or the endpoint the destination had
 * before it was edited.
 *
 * Cleared when it settles, and the result is never cached: a scan that saw
 * nothing must be retried on the next connection rather than remembered as a
 * verdict.
 */
const scansInFlight = new Map<string, Promise<SshHostKeyScanResult>>();

/** Test hook; the map is process-lived by design. */
export function _resetSshScanState(): void {
  scansInFlight.clear();
}

function scanOnce(
  deps: SshServiceDeps,
  host: SshHostPublic,
  keyType: string,
): Promise<SshHostKeyScanResult> {
  const key = `${host.id} ${host.address} ${String(host.port)} ${keyType}`;
  const existing = scansInFlight.get(key);
  if (existing) return existing;
  const scanner = deps.scanHostKey ?? scanSshHostKey;
  const pending = scanner({ address: host.address, port: host.port, keyType })
    .catch((): SshHostKeyScanResult => ({ keys: [], failure: "scan-failed" }))
    .finally(() => scansInFlight.delete(key));
  scansInFlight.set(key, pending);
  return pending;
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
 * One field of the audit line. Two of the values are attacker-influenceable —
 * the `user` comes off the wire on a mismatch refusal, and the destination's
 * label is free text the user typed — and the line is whitespace-delimited, so
 * an unescaped newline would forge a whole second entry in the very log that
 * exists to explain a refusal.
 */
function auditField(value: string | number): string {
  return String(value).replace(/[^\x20-\x7e]/g, "?").replace(/\s/g, "_");
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
    `session=${auditField(fields.sessionId)}`,
    `destination=${fields.host ? `${auditField(fields.host.label)}[${auditField(fields.host.id)}]` : "unknown"}`,
    `address=${fields.host ? `${auditField(fields.host.address)}:${auditField(fields.host.port)}` : "unknown"}`,
    `user=${auditField(fields.user ?? fields.host?.user ?? "unknown")}`,
    `at=${new Date().toISOString()}`,
    `outcome=${fields.outcome}`,
  ];
  if (fields.reason) parts.push(`reason=${fields.reason}`);
  if (fields.detail) parts.push(`detail=${auditField(fields.detail)}`);
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

/** Reached from both sides of the scan, so the pin cannot move under a race. */
function refuseHostKeyMismatch(
  deps: SshServiceDeps,
  sessionId: string,
  host: SshHostPublic,
  seenFingerprint: string,
  keyType: string,
  recordedFingerprint = host.hostKeyFingerprint,
): never {
  emitHostKeyCard(deps, sessionId, {
    cardId: `ssh-host-key-${randomUUID()}`,
    hostId: host.id,
    label: host.label,
    address: host.address,
    kind: "mismatch",
    fingerprint: seenFingerprint,
    keyType,
    ...(recordedFingerprint ? { recordedFingerprint } : {}),
    createdAt: new Date().toISOString(),
  });
  refuse(
    deps,
    { sessionId, host, reason: "host-key-mismatch", detail: seenFingerprint },
    `The host key ${host.address} presented does not match the one ShipIt recorded.`,
  );
}

/**
 * Sign, or refuse. Returns base64 of the SSH signature blob.
 *
 * The endpoint is stateless: the bind travels with every request, so nothing
 * here depends on which socket connection the worker held it on.
 */
export async function signSshRequest(
  deps: SshServiceDeps,
  sessionId: string,
  request: SshSignRequest,
): Promise<{ signature: string }> {
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

  // Rule 3 — the host key is the recorded one, or this bind is a candidate for
  // the first recording, which the orchestrator's own scan decides (req 13).
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
  // Recording is DEFERRED to the end of this function, after rule 4 has passed
  // and the scan has confirmed the key. The pin is account-wide and permanent,
  // and a request that is about to be refused must not be able to set it.
  //
  // "Pinned" and "observed" are different questions (req 13). A pin recorded
  // before req 13 shipped was whatever key the first bind carried, so an
  // upgrade must not inherit it as verified: it still has to survive a scan
  // before it authorizes anything. A different key against such a pin is a
  // mismatch as before — only the pinned key itself gets to be confirmed.
  const recordPinNow = !pinned.hostKeyBlob || !pinned.hostKeyObservedAt;
  if (pinned.hostKeyBlob && pinned.hostKeyBlob !== bind.hostKeyBlob) {
    refuseHostKeyMismatch(deps, sessionId, host, seenFingerprint, keyType);
  }

  // Rule 4 — userauth publickey only, for this connection, as this user.
  const parsed = parseUserauthRequest(Buffer.from(request.data, "base64"));
  if (parsed?.service !== "ssh-connection"
    || !parsed.hasSignature || parsed.publicKeyBlob !== host.publicKeyBlob) {
    refuse(
      deps,
      { sessionId, host, reason: "not-userauth" },
      "ShipIt signs only an SSH publickey authentication request for this destination.",
    );
  }
  // The destination's key is always ed25519, so any other algorithm name means
  // the bytes are not a request this key could authenticate — and an unchecked
  // field is free space in what we sign.
  if (parsed.algorithm !== SSH_ED25519) {
    refuse(
      deps,
      { sessionId, host, reason: "wrong-algorithm" },
      `ShipIt signs only ${SSH_ED25519} authentication requests.`,
    );
  }
  // The host-bound form names the server again inside the signed bytes; it must
  // be the same host the bind proved, or the signature would cover a claim about
  // a machine this connection never reached.
  if (parsed.method === USERAUTH_PUBLICKEY_HOSTBOUND
    && parsed.serverHostKeyBlob !== bind.hostKeyBlob) {
    refuse(
      deps,
      { sessionId, host, reason: "hostbound-mismatch" },
      "The host-bound request names a different server than the bound connection.",
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

  // req 13 — the first recording. The scan is sequenced here, after every other
  // rule, so a request that is going to be refused anyway spawns no process.
  if (recordPinNow) {
    const scan = await scanOnce(deps, host, keyType);

    // The scan is the only step that suspends, and every rule above read state
    // the user can change while it waits: the grant can be revoked, the
    // destination deleted, its address, port or user edited, a concurrent
    // request can record a key. So re-read all of it and refuse on any
    // difference, rather than authenticating against a configuration that no
    // longer holds. Everything from here to the record is synchronous.
    const current = grantedSshHosts(deps, sessionId).find((h) => h.id === host.id);
    const afterScan = deps.credentialStore.getSshHostSigningKey(host.id);
    if (!current || !afterScan) {
      refuse(
        deps,
        { sessionId, host, reason: "not-granted", detail: "revoked-during-scan" },
        "That SSH destination is no longer granted to this session.",
      );
    }
    // Rule 4 compared the request's user against the one configured before the
    // scan; signing now would authenticate as an account just taken away.
    if (current.user !== host.user) {
      refuse(
        deps,
        { sessionId, host: current, user: parsed.user, reason: "user-mismatch", detail: "user-changed-during-scan" },
        `That SSH destination's user changed while ShipIt was verifying its host key; it now authenticates as ${current.user}.`,
      );
    }
    // A key observed at the old endpoint says nothing about the new one, so the
    // scan's answer is void — whatever it found, and whichever request started
    // it. The card is what makes this visible: `ssh` reports only a generic
    // agent failure, and without it the refusal has no explanation anywhere the
    // user looks (req 13, "the user can see why").
    if (current.address !== host.address || current.port !== host.port) {
      emitHostKeyCard(deps, sessionId, {
        cardId: `ssh-host-key-${randomUUID()}`,
        hostId: host.id,
        label: current.label,
        address: current.address,
        kind: "unverified",
        fingerprint: seenFingerprint,
        keyType,
        scanFailure: "endpoint-changed",
        createdAt: new Date().toISOString(),
      });
      refuse(
        deps,
        { sessionId, host: current, reason: "host-key-unverified", detail: "endpoint-changed-during-scan" },
        "That SSH destination's address changed while ShipIt was verifying its host key; try again.",
      );
    }
    if (afterScan.hostKeyBlob && afterScan.hostKeyBlob !== bind.hostKeyBlob) {
      refuseHostKeyMismatch(
        deps, sessionId, host, seenFingerprint, keyType,
        host.hostKeyFingerprint ?? fingerprintOf(afterScan.hostKeyBlob),
      );
    }
    if (!afterScan.hostKeyBlob || !afterScan.hostKeyObservedAt) {
      if (!scan.keys.includes(bind.hostKeyBlob)) {
        const scanned = scan.keys[0];
        const scannedFingerprint = scanned ? fingerprintOf(scanned) : undefined;
        emitHostKeyCard(deps, sessionId, {
          cardId: `ssh-host-key-${randomUUID()}`,
          hostId: host.id,
          label: host.label,
          address: host.address,
          kind: "unverified",
          fingerprint: seenFingerprint,
          keyType,
          ...(scannedFingerprint ? { scannedFingerprint } : {}),
          ...(scanned ? { scannedKeyType: blobType(Buffer.from(scanned, "base64")) ?? "unknown" } : {}),
          ...(scan.failure ? { scanFailure: scan.failure } : {}),
          createdAt: new Date().toISOString(),
        });
        refuse(
          deps,
          {
            sessionId,
            host,
            reason: "host-key-unverified",
            detail: scannedFingerprint
              ? `scanned=${scannedFingerprint}`
              : `scan=${scan.failure ?? "no-answer"}`,
          },
          `ShipIt could not observe that host key at ${host.address}:${String(host.port)}, so it will not record it.`,
        );
      }
      if (deps.credentialStore.recordSshHostKey(host.id, bind.hostKeyBlob, {
        fingerprint: seenFingerprint,
        keyType,
      })) {
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
    }
  }

  const signature = signWithHostKey(pinned.privateKeyPem, Buffer.from(request.data, "base64"));
  audit({ sessionId, host, user: parsed.user, outcome: "signed" });
  return { signature: signature.toString("base64") };
}
