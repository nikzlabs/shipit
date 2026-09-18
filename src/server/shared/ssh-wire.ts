/**
 * SSH wire format primitives, shared by the worker's agent socket and the
 * orchestrator's signer (docs/305-ssh-hosts).
 *
 * Every length-prefixed read is bounds-checked and throws rather than returning
 * a short buffer: the bytes come from a process the agent controls, and a
 * silently truncated field would be a field the signer then checks against
 * nothing.
 */

export const SSH_AGENT_FAILURE = 5;
export const SSH_AGENT_SUCCESS = 6;
export const SSH_AGENTC_REQUEST_IDENTITIES = 11;
export const SSH_AGENT_IDENTITIES_ANSWER = 12;
export const SSH_AGENTC_SIGN_REQUEST = 13;
export const SSH_AGENT_SIGN_RESPONSE = 14;
export const SSH_AGENTC_EXTENSION = 27;
export const SSH_AGENT_EXTENSION_FAILURE = 28;

export const SESSION_BIND_EXTENSION = "session-bind@openssh.com";

/** SSH2_MSG_USERAUTH_REQUEST — the only message type the signer will sign over. */
export const SSH_MSG_USERAUTH_REQUEST = 50;

export class SshReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  get atEnd(): boolean {
    return this.offset >= this.buf.length;
  }

  readByte(): number {
    if (this.remaining < 1) throw new Error("ssh-wire: truncated byte");
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readBool(): boolean {
    return this.readByte() !== 0;
  }

  readUint32(): number {
    if (this.remaining < 4) throw new Error("ssh-wire: truncated uint32");
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readString(): Buffer {
    const len = this.readUint32();
    if (this.remaining < len) throw new Error("ssh-wire: truncated string");
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readText(): string {
    return this.readString().toString("utf8");
  }

  readRest(): Buffer {
    const out = this.buf.subarray(this.offset);
    this.offset = this.buf.length;
    return out;
  }
}

export function u32(value: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(value >>> 0, 0);
  return b;
}

export function sshString(value: Buffer | string): Buffer {
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([u32(body.length), body]);
}

export function sshByte(value: number): Buffer {
  return Buffer.from([value & 0xff]);
}

/** Frame an agent-protocol message: uint32 length || payload. */
export function frame(payload: Buffer): Buffer {
  return Buffer.concat([u32(payload.length), payload]);
}

/** The algorithm name a public-key or signature blob leads with. */
export function blobType(blob: Buffer): string | null {
  try {
    return new SshReader(blob).readText();
  } catch {
    return null;
  }
}

/** OpenSSH's `SHA256:<base64, unpadded>` form, over the raw key blob. */
export function sshFingerprint(blob: Buffer, digest: (b: Buffer) => Buffer): string {
  return `SHA256:${digest(blob).toString("base64").replace(/=+$/, "")}`;
}
