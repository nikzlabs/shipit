/**
 * SSH host destinations (docs/305-ssh-hosts).
 *
 * `SshHostPublic` is the ONLY shape any read path returns — browser CRUD,
 * settings reads, the container-facing identities route. The private key has no
 * field here, which is what keeps "the agent can never read it" (req 3) from
 * depending on remembering to redact at each call site.
 */
export interface SshHostPublic {
  id: string;
  label: string;
  /** Hostname or IP literal (req 12). */
  address: string;
  port: number;
  user: string;
  /** base64 of ShipIt's public-key blob, offered to `ssh` as an identity. */
  publicKeyBlob: string;
  /**
   * The client public-key file's contents — bare `ssh-ed25519 <blob> <comment>`.
   * OpenSSH's identity loader rejects anything with an options prefix.
   */
  identityLine: string;
  /** What the user installs on the server: the same key, with restrictions. */
  authorizedKeysLine: string;
  /** Of ShipIt's own key. */
  fingerprint: string;
  /** Of the server's recorded host key; absent until the first connection. */
  hostKeyFingerprint?: string;
  hostKeyType?: string;
  hostKeyRecordedAt?: string;
  createdAt: string;
}

export interface SshHostsView {
  hosts: SshHostPublic[];
}

export interface SessionSshHostsView {
  sessionId: string;
  /** Every destination in the registry, so the picker needs one request. */
  hosts: SshHostPublic[];
  /** IDs this session is granted. */
  granted: string[];
}

/** Why the orchestrator's own scan of the address produced no usable key. */
export type SshHostKeyScanFailureKind = "no-answer" | "timeout" | "scan-failed" | "unsupported-type";

/**
 * req 9 — the first connection records the server's key and shows its
 * fingerprint; a later key that does not match is refused and says so. req 13
 * adds the third kind: the orchestrator could not observe the presented key at
 * the configured address, so nothing was recorded. All are transcript content,
 * so all persist (docs/188).
 */
export interface SshHostKeyCard {
  cardId: string;
  hostId: string;
  label: string;
  address: string;
  kind: "recorded" | "mismatch" | "unverified";
  /** The key seen on this attempt. */
  fingerprint: string;
  keyType: string;
  /** Only for a mismatch: what was recorded and still stands. */
  recordedFingerprint?: string;
  /** Only for `unverified`: what the orchestrator's scan saw at the address. */
  scannedFingerprint?: string;
  /** Only for `unverified`, and only when the scan saw no key at all. */
  scanFailure?: SshHostKeyScanFailureKind;
  createdAt: string;
}
