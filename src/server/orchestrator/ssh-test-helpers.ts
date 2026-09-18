/**
 * Builders for real SSH wire material, shared by the signer and socket tests.
 *
 * They produce genuine key exchanges rather than fixtures: a server key that
 * actually signs the session identifier, and a userauth request built the way
 * OpenSSH builds it. A fixture that could not be a real connection would let
 * every signer rule pass against bytes no server ever sends.
 */

import crypto from "node:crypto";
import { sshByte, sshString } from "../shared/ssh-wire.js";
import { SSH_MSG_USERAUTH_REQUEST } from "../shared/ssh-wire.js";

export interface FakeServerKey {
  /** base64 of the SSH host-key blob. */
  blob: string;
  sign(data: Buffer): Buffer;
}

export function fakeEd25519ServerKey(): FakeServerKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  return {
    blob: Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]).toString("base64"),
    sign: (data) =>
      Buffer.concat([sshString("ssh-ed25519"), sshString(crypto.sign(null, data, privateKey))]),
  };
}

export function fakeRsaServerKey(hash: "rsa-sha2-256" | "rsa-sha2-512"): FakeServerKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  const mpint = (b64url: string): Buffer => {
    let buf = Buffer.from(b64url, "base64url");
    while (buf.length > 1 && buf[0] === 0) buf = buf.subarray(1);
    return (buf[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), buf]) : buf;
  };
  return {
    blob: Buffer.concat([
      sshString("ssh-rsa"),
      sshString(mpint(jwk.e!)),
      sshString(mpint(jwk.n!)),
    ]).toString("base64"),
    sign: (data) => {
      const digest = hash === "rsa-sha2-512" ? "sha512" : "sha256";
      return Buffer.concat([sshString(hash), sshString(crypto.sign(digest, data, privateKey))]);
    },
  };
}

export function fakeEcdsaServerKey(): FakeServerKey {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const point = spki.subarray(spki.length - 65);
  return {
    blob: Buffer.concat([
      sshString("ecdsa-sha2-nistp256"),
      sshString("nistp256"),
      sshString(point),
    ]).toString("base64"),
    sign: (data) => {
      const der = crypto.sign("sha256", data, { key: privateKey, dsaEncoding: "der" });
      const { r, s } = parseDerSignature(der);
      return Buffer.concat([
        sshString("ecdsa-sha2-nistp256"),
        sshString(Buffer.concat([sshString(r), sshString(s)])),
      ]);
    },
  };
}

function parseDerSignature(der: Buffer): { r: Buffer; s: Buffer } {
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const readInt = (): Buffer => {
    i++; // tag
    const len = der[i++];
    const out = der.subarray(i, i + len);
    i += len;
    return out;
  };
  return { r: readInt(), s: readInt() };
}

/** `string hostkey, string session id, string signature, bool is_forwarding`. */
export function buildSessionBind(
  key: FakeServerKey,
  sessionId: Buffer,
  opts: { isForwarding?: boolean; signature?: Buffer } = {},
): string {
  return Buffer.concat([
    sshString(Buffer.from(key.blob, "base64")),
    sshString(sessionId),
    sshString(opts.signature ?? key.sign(sessionId)),
    Buffer.from([opts.isForwarding ? 1 : 0]),
  ]).toString("base64");
}

export function buildUserauthData(fields: {
  sessionId: Buffer;
  user: string;
  publicKeyBlob: string;
  algorithm?: string;
  service?: string;
  method?: string;
  hasSignature?: boolean;
  /** base64; present makes this the host-bound form OpenSSH 8.9+ prefers. */
  serverHostKeyBlob?: string;
}): string {
  const hostbound = fields.serverHostKeyBlob !== undefined;
  return Buffer.concat([
    sshString(fields.sessionId),
    sshByte(SSH_MSG_USERAUTH_REQUEST),
    sshString(fields.user),
    sshString(fields.service ?? "ssh-connection"),
    sshString(fields.method ?? (hostbound ? "publickey-hostbound-v00@openssh.com" : "publickey")),
    Buffer.from([fields.hasSignature === false ? 0 : 1]),
    sshString(fields.algorithm ?? "ssh-ed25519"),
    sshString(Buffer.from(fields.publicKeyBlob, "base64")),
    ...(hostbound ? [sshString(Buffer.from(fields.serverHostKeyBlob!, "base64"))] : []),
  ]).toString("base64");
}
