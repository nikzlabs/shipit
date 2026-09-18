import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  SshReader,
  blobType,
  frame,
  sshByte,
  sshFingerprint,
  sshString,
  u32,
} from "./ssh-wire.js";

describe("ssh-wire", () => {
  it("round-trips the primitives it frames", () => {
    const payload = Buffer.concat([
      sshByte(13),
      sshString("ssh-ed25519"),
      sshString(Buffer.from([1, 2, 3])),
      u32(7),
    ]);
    const framed = frame(payload);
    expect(framed.readUInt32BE(0)).toBe(payload.length);

    const r = new SshReader(framed.subarray(4));
    expect(r.readByte()).toBe(13);
    expect(r.readText()).toBe("ssh-ed25519");
    expect([...r.readString()]).toEqual([1, 2, 3]);
    expect(r.readUint32()).toBe(7);
    expect(r.atEnd).toBe(true);
  });

  // The bytes come from a process the agent controls; a short read that returned
  // a truncated field would be a field the signer then checks against nothing.
  it("throws rather than returning a short field", () => {
    expect(() => new SshReader(Buffer.from([0, 0, 0])).readUint32()).toThrow(/truncated/);
    expect(() => new SshReader(Buffer.from([0, 0, 0, 9, 1])).readString()).toThrow(/truncated/);
    expect(() => new SshReader(Buffer.alloc(0)).readByte()).toThrow(/truncated/);
  });

  it("reads an algorithm name off a blob and null off a malformed one", () => {
    expect(blobType(Buffer.concat([sshString("ssh-rsa"), sshString("x")]))).toBe("ssh-rsa");
    expect(blobType(Buffer.from([0, 0]))).toBeNull();
  });

  it("produces OpenSSH's unpadded SHA256 fingerprint", () => {
    const blob = Buffer.from("hello");
    const expected = crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    expect(sshFingerprint(blob, (b) => crypto.createHash("sha256").update(b).digest()))
      .toBe(`SHA256:${expected}`);
  });
});
