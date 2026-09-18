/**
 * Observing a destination's host key from the orchestrator's own network
 * (docs/305-ssh-hosts req 13).
 *
 * The `session-bind@openssh.com` message a session posts proves a key exchange
 * with whoever holds the supplied host key — it does NOT tie that key to the
 * destination's configured address, because the server signs only the session
 * identifier. So before the signer pins a key it asks this module what is
 * actually answering at the configured address and port, and pins only an exact
 * match. Everything here is public material: a host key and a fingerprint.
 *
 * The address and port come from the registry, never from the request.
 */

import { spawn } from "node:child_process";
import { killChild } from "../shared/kill-child.js";

/** Long enough for `-T 5` to expire on its own; the killer is the backstop. */
const SCAN_TIMEOUT_MS = 10_000;
const KEYSCAN_CONNECT_TIMEOUT_S = 5;

export type SshHostKeyScanFailure = "no-answer" | "timeout" | "scan-failed" | "unsupported-type";

export interface SshHostKeyScanResult {
  /** base64 key blobs the address answered with, in the order printed. */
  keys: string[];
  /** Why nothing usable came back; absent when `keys` is non-empty. */
  failure?: SshHostKeyScanFailure;
}

export interface SshHostKeyScanTarget {
  address: string;
  port: number;
  /** The SSH blob type of the key to look for, e.g. `ssh-ed25519`. */
  keyType: string;
}

export type SshHostKeyScanner = (target: SshHostKeyScanTarget) => Promise<SshHostKeyScanResult>;

/**
 * `ssh-keyscan -t` names a key *family*, not a blob type, so `ssh-ed25519` has
 * to become `ed25519`. OpenSSH 9.x happens to accept both, older ones do not.
 * An unmappable type never reaches here in practice — the bind's host-key
 * signature has already verified, and that only succeeds for these three — but
 * it is refused rather than passed through, since this value came off the wire.
 */
function keyscanType(blobType: string): string | undefined {
  if (blobType === "ssh-ed25519") return "ed25519";
  if (blobType === "ssh-rsa" || blobType.startsWith("rsa-sha2-")) return "rsa";
  if (blobType.startsWith("ecdsa-sha2-nistp")) return "ecdsa";
  return undefined;
}

/**
 * Each answer line is `<host> <keytype> <base64 blob>`; comments start with `#`
 * and normally go to stderr anyway. Only the blob is returned — the caller
 * compares it byte for byte against the key the session presented.
 */
export function parseKeyscanOutput(stdout: string): string[] {
  const keys: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length >= 3 && fields[2]) keys.push(fields[2]);
  }
  return keys;
}

export function scanSshHostKey(target: SshHostKeyScanTarget): Promise<SshHostKeyScanResult> {
  const type = keyscanType(target.keyType);
  if (!type) return Promise.resolve({ keys: [], failure: "unsupported-type" });

  const args = [
    "-p", String(target.port),
    "-T", String(KEYSCAN_CONNECT_TIMEOUT_S),
    "-t", type,
    target.address,
  ];

  return new Promise((resolve) => {
    let proc;
    try {
      // No shell: the address is validated at creation, but an argv spawn is
      // what makes that a defence in depth rather than the only one.
      proc = spawn("ssh-keyscan", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ keys: [], failure: "scan-failed" });
      return;
    }

    let stdout = "";
    let timedOut = false;
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(0, 16_384);
    });
    proc.stderr.on("data", () => undefined);

    const timer = setTimeout(() => {
      timedOut = true;
      killChild(proc, "SIGKILL");
    }, SCAN_TIMEOUT_MS);

    // A missing binary (local mode has no openssh-client) lands here.
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ keys: [], failure: "scan-failed" });
    });
    proc.on("close", () => {
      clearTimeout(timer);
      const keys = parseKeyscanOutput(stdout);
      if (keys.length > 0) {
        resolve({ keys });
        return;
      }
      resolve({ keys: [], failure: timedOut ? "timeout" : "no-answer" });
    });
  });
}
