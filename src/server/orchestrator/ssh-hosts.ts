/**
 * Key material and signature handling for SSH host destinations
 * (docs/305-ssh-hosts).
 *
 * Three jobs, all orchestrator-side because the private half never leaves it:
 * generate a destination's ed25519 key and derive the `authorized_keys` line
 * the user installs; sign a userauth request with it; and verify the *server's*
 * `session-bind@openssh.com` signature, which is what proves the connection
 * being authenticated really reached the pinned host.
 *
 * Node cannot parse SSH key formats, so the conversions from an SSH public-key
 * blob to a `KeyObject` are done here by hand. Import of an existing private key
 * is out of scope for the same reason (requirements.md req 5): Node cannot read
 * the OpenSSH private-key container at all.
 */

import crypto from "node:crypto";
import {
  SshReader,
  SSH_MSG_USERAUTH_REQUEST,
  blobType,
  sshFingerprint,
  sshString,
} from "../shared/ssh-wire.js";
import { isValidIp } from "./egress-firewall.js";

export const SSH_ED25519 = "ssh-ed25519";

/** Only the private half is secret; every other field is public material. */
export interface GeneratedSshKey {
  privateKeyPem: string;
  /** base64 of the SSH public-key blob. */
  publicKeyBlob: string;
  /**
   * The CLIENT's public-key file: `ssh-ed25519 <blob> <comment>` and nothing
   * else. This is what `IdentityFile` names, and it must stay bare — OpenSSH's
   * identity loader parses the first field as the key type, so an
   * `authorized_keys` options prefix makes it fail with "error in libcrypto"
   * and, under `IdentitiesOnly yes`, leaves the session with no usable identity.
   */
  identityLine: string;
  /** What the user installs on the SERVER: the same key, with restrictions. */
  authorizedKeysLine: string;
  fingerprint: string;
}

/**
 * The restrictions ShipIt prints with the line the user installs on the server.
 * They are advisory — the server enforces them, and a user who edits them out
 * gets what they asked for. They belong ONLY on that line: `authorized_keys`
 * options are not part of a client public-key file.
 */
export const AUTHORIZED_KEYS_RESTRICTIONS =
  "no-agent-forwarding,no-port-forwarding,no-X11-forwarding";

const sha256 = (b: Buffer): Buffer => crypto.createHash("sha256").update(b).digest();

export function fingerprintOf(blobB64: string): string {
  return sshFingerprint(Buffer.from(blobB64, "base64"), sha256);
}

export function generateSshHostKey(comment: string): GeneratedSshKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  // The 32 raw bytes are the tail of the fixed-shape ed25519 SPKI encoding.
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  const blob = Buffer.concat([sshString(SSH_ED25519), sshString(raw)]);
  const blobB64 = blob.toString("base64");
  const identityLine = `${SSH_ED25519} ${blobB64}${comment ? ` ${comment}` : ""}`;
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyBlob: blobB64,
    identityLine,
    authorizedKeysLine: `${AUTHORIZED_KEYS_RESTRICTIONS} ${identityLine}`,
    fingerprint: sshFingerprint(blob, sha256),
  };
}

/** ed25519 signature blob: `string "ssh-ed25519" || string sig`. */
export function signWithHostKey(privateKeyPem: string, data: Buffer): Buffer {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, data, key);
  return Buffer.concat([sshString(SSH_ED25519), sshString(sig)]);
}

export interface SessionBind {
  /** base64 of the server's host-key blob. */
  hostKeyBlob: string;
  sessionId: Buffer;
  signature: Buffer;
  isForwarding: boolean;
}

/** `string hostkey, string session identifier, string signature, bool is_forwarding`. */
export function parseSessionBind(payload: Buffer): SessionBind | null {
  try {
    const r = new SshReader(payload);
    const hostKey = r.readString();
    const sessionId = r.readString();
    const signature = r.readString();
    const isForwarding = r.readBool();
    if (hostKey.length === 0 || sessionId.length === 0 || signature.length === 0) return null;
    return {
      hostKeyBlob: hostKey.toString("base64"),
      sessionId: Buffer.from(sessionId),
      signature: Buffer.from(signature),
      isForwarding,
    };
  } catch {
    return null;
  }
}

export const USERAUTH_PUBLICKEY = "publickey";

/**
 * OpenSSH 8.9+ prefers this over plain `publickey` whenever the server
 * advertises it, which every sshd of that vintage does. It appends the server's
 * host key to the signed request, binding the signature to the host as well as
 * the session — so it is the form a modern connection actually uses, and
 * refusing it means refusing to authenticate at all.
 */
export const USERAUTH_PUBLICKEY_HOSTBOUND = "publickey-hostbound-v00@openssh.com";

export interface UserauthRequest {
  sessionId: Buffer;
  user: string;
  service: string;
  method: typeof USERAUTH_PUBLICKEY | typeof USERAUTH_PUBLICKEY_HOSTBOUND;
  hasSignature: boolean;
  algorithm: string;
  /** base64 of the public-key blob the request authenticates with. */
  publicKeyBlob: string;
  /** base64 of the server host key, on the host-bound form only. */
  serverHostKeyBlob?: string;
}

/**
 * The only two shapes the signer will ever sign (plan.md, rule 4, extended for
 * the host-bound form). Anything else — an unknown method, a different message
 * type, trailing bytes — parses as null, so the endpoint cannot be used as a
 * general signing oracle.
 */
export function parseUserauthRequest(data: Buffer): UserauthRequest | null {
  try {
    const r = new SshReader(data);
    const sessionId = r.readString();
    const messageType = r.readByte();
    if (messageType !== SSH_MSG_USERAUTH_REQUEST) return null;
    const user = r.readText();
    const service = r.readText();
    const method = r.readText();
    if (method !== USERAUTH_PUBLICKEY && method !== USERAUTH_PUBLICKEY_HOSTBOUND) return null;
    const hasSignature = r.readBool();
    const algorithm = r.readText();
    const publicKey = r.readString();
    const serverHostKey = method === USERAUTH_PUBLICKEY_HOSTBOUND ? r.readString() : null;
    if (!r.atEnd) return null;
    return {
      sessionId: Buffer.from(sessionId),
      user,
      service,
      method,
      hasSignature,
      algorithm,
      publicKeyBlob: publicKey.toString("base64"),
      ...(serverHostKey ? { serverHostKeyBlob: serverHostKey.toString("base64") } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Verify the server's signature over the session identifier with the host key
 * it presented. A valid one needs the server's host *private* key, so the agent
 * cannot forge it and a relay through another machine cannot produce it.
 */
export function verifyHostKeySignature(bind: SessionBind): boolean {
  let key: crypto.KeyObject;
  try {
    key = sshPublicKeyToKeyObject(Buffer.from(bind.hostKeyBlob, "base64"));
  } catch {
    return false;
  }
  const alg = blobType(bind.signature);
  if (!alg) return false;
  try {
    const r = new SshReader(bind.signature);
    r.readText();
    const raw = r.readString();
    if (alg === SSH_ED25519) {
      return crypto.verify(null, bind.sessionId, key, raw);
    }
    if (alg === "ssh-rsa" || alg === "rsa-sha2-256" || alg === "rsa-sha2-512") {
      const hash = alg === "rsa-sha2-512" ? "sha512" : alg === "rsa-sha2-256" ? "sha256" : "sha1";
      return crypto.verify(hash, bind.sessionId, key, raw);
    }
    const curve = ECDSA_HASH[alg];
    if (curve) {
      const inner = new SshReader(raw);
      const der = derSequence(Buffer.concat([derInteger(inner.readString()), derInteger(inner.readString())]));
      return crypto.verify(curve, bind.sessionId, { key, dsaEncoding: "der" }, der);
    }
    return false;
  } catch {
    return false;
  }
}

const ECDSA_HASH: Record<string, string | undefined> = {
  "ecdsa-sha2-nistp256": "sha256",
  "ecdsa-sha2-nistp384": "sha384",
  "ecdsa-sha2-nistp521": "sha512",
};

// SPKI wrappers whose only variable part is the trailing point/key bytes.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ECDSA_SPKI_PREFIX: Record<string, Buffer | undefined> = {
  nistp256: Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
  nistp384: Buffer.from("3076301006072a8648ce3d020106052b81040022036200", "hex"),
  nistp521: Buffer.from("30819b301006072a8648ce3d020106052b8104002303818600", "hex"),
};

export function sshPublicKeyToKeyObject(blob: Buffer): crypto.KeyObject {
  const r = new SshReader(blob);
  const type = r.readText();
  if (type === SSH_ED25519) {
    const raw = r.readString();
    if (raw.length !== 32) throw new Error("ssh-ed25519 key is not 32 bytes");
    return crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  }
  if (type === "ssh-rsa") {
    const e = r.readString();
    const n = r.readString();
    return crypto.createPublicKey({
      key: derSequence(Buffer.concat([derInteger(n), derInteger(e)])),
      format: "der",
      type: "pkcs1",
    });
  }
  if (type.startsWith("ecdsa-sha2-")) {
    const curve = r.readText();
    const prefix = ECDSA_SPKI_PREFIX[curve];
    if (!prefix || `ecdsa-sha2-${curve}` !== type) throw new Error(`unsupported ECDSA curve ${curve}`);
    return crypto.createPublicKey({
      key: Buffer.concat([prefix, r.readString()]),
      format: "der",
      type: "spki",
    });
  }
  throw new Error(`unsupported host key type ${type}`);
}

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let v = len;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derSequence(content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLength(content.length), content]);
}

// An mpint is already minimal two's-complement; normalize anyway, since these
// bytes come off the wire rather than from our own encoder.
function derInteger(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0 && (value[start + 1] & 0x80) === 0) start++;
  let body = value.subarray(start);
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0] & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return Buffer.concat([Buffer.from([0x02]), derLength(body.length), body]);
}

/**
 * Whether a destination address is an IP literal (req 12). It decides which
 * half of the egress policy the destination lands in: a name is resolved and
 * pinned by the Tier B resolver, while a literal issues no DNS query at all and
 * has to enter the firewall's CIDR input instead.
 *
 * Shares the firewall's own validator, so an address this accepts is one the
 * ipset will take.
 */
export function isIpLiteral(address: string): boolean {
  return isValidIp(address.trim());
}

/** The single-host CIDR the firewall admits an IP destination by. */
export function ipLiteralCidr(address: string): string {
  const addr = address.trim();
  return `${addr}/${addr.includes(":") ? 128 : 32}`;
}

/**
 * The `known_hosts` line for a recorded host key. A non-default port is written
 * in the bracketed form OpenSSH looks the host up under.
 */
export function knownHostsLine(address: string, port: number, hostKeyBlobB64: string): string {
  const host = port === 22 ? address : `[${address}]:${port}`;
  const type = blobType(Buffer.from(hostKeyBlobB64, "base64")) ?? "";
  return `${host} ${type} ${hostKeyBlobB64}`;
}
