import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  AUTHORIZED_KEYS_RESTRICTIONS,
  fingerprintOf,
  generateSshHostKey,
  ipLiteralCidr,
  isIpLiteral,
  knownHostsLine,
  parseSessionBind,
  parseUserauthRequest,
  signWithHostKey,
  sshPublicKeyToKeyObject,
  verifyHostKeySignature,
} from "./ssh-hosts.js";
import { SshReader, sshString, sshByte } from "../shared/ssh-wire.js";
import {
  buildSessionBind,
  buildUserauthData,
  fakeEcdsaServerKey,
  fakeEd25519ServerKey,
  fakeRsaServerKey,
} from "./ssh-test-helpers.js";

function haveSshKeygen(): boolean {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (err) {
    // `-?` is not a real flag: it exits non-zero but only if the binary ran.
    return (err as { code?: string }).code !== "ENOENT";
  }
}

/**
 * `ssh-keygen -e` is the load OpenSSH's own identity loader performs, and it is
 * the assertion that matters here. An earlier version of this test used
 * `ssh-keygen -l`, which accepts an `authorized_keys` line — so it passed while
 * the provisioned `IdentityFile` was one OpenSSH refuses outright, and the
 * feature could not authenticate at all.
 */
function loadsAsAnIdentity(line: string): { ok: boolean; error: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-host-"));
  const file = path.join(dir, "id.pub");
  try {
    fs.writeFileSync(file, `${line}\n`, { mode: 0o600 });
    execFileSync("ssh-keygen", ["-e", "-f", file], { stdio: ["ignore", "ignore", "pipe"] });
    return { ok: true, error: "" };
  } catch (err) {
    return { ok: false, error: String((err as { stderr?: Buffer }).stderr ?? err) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("generateSshHostKey", () => {
  it("derives both lines, with the restrictions only on the server's", () => {
    const key = generateSshHostKey("shipit-prod");
    expect(key.identityLine).toBe(`ssh-ed25519 ${key.publicKeyBlob} shipit-prod`);
    expect(key.authorizedKeysLine).toBe(`${AUTHORIZED_KEYS_RESTRICTIONS} ${key.identityLine}`);
    expect(key.fingerprint).toBe(fingerprintOf(key.publicKeyBlob));
  });

  // The whole feature rests on this: with `IdentitiesOnly yes`, a file OpenSSH
  // cannot load leaves the session with no identity to offer.
  it("produces an identity line OpenSSH's own loader accepts", () => {
    if (!haveSshKeygen()) return;
    const key = generateSshHostKey("shipit-prod");
    expect(loadsAsAnIdentity(key.identityLine)).toEqual({ ok: true, error: "" });
  });

  // Guards the bug directly: provisioning the server-side line as the identity
  // file is what broke authentication, and `ssh-keygen -l` could not see it.
  it("and the authorized_keys line is NOT one, which is why they are separate", () => {
    if (!haveSshKeygen()) return;
    const key = generateSshHostKey("shipit-prod");
    const outcome = loadsAsAnIdentity(key.authorizedKeysLine);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/libcrypto|invalid format/i);
  });

  it("is read back by ssh-keygen with our fingerprint", () => {
    if (!haveSshKeygen()) return;
    const key = generateSshHostKey("shipit-prod");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-host-"));
    const file = path.join(dir, "id.pub");
    fs.writeFileSync(file, `${key.identityLine}\n`);
    const out = execFileSync("ssh-keygen", ["-l", "-f", file], { encoding: "utf8" });
    expect(out).toContain(key.fingerprint);
    expect(out).toContain("(ED25519)");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the private half out of every derived public field", () => {
    const key = generateSshHostKey("shipit-prod");
    const secretBody = key.privateKeyPem.replace(/-----[A-Z ]+-----|\s/g, "");
    for (const field of [key.publicKeyBlob, key.identityLine, key.authorizedKeysLine, key.fingerprint]) {
      expect(field).not.toContain(secretBody);
    }
  });
});

describe("signWithHostKey", () => {
  it("produces a blob whose signature verifies under the derived public key", () => {
    const key = generateSshHostKey("shipit-prod");
    const data = Buffer.from("the bytes a userauth request covers");
    const blob = signWithHostKey(key.privateKeyPem, data);

    const r = new SshReader(blob);
    expect(r.readText()).toBe("ssh-ed25519");
    const signature = r.readString();
    const publicKey = sshPublicKeyToKeyObject(Buffer.from(key.publicKeyBlob, "base64"));
    expect(crypto.verify(null, data, publicKey, signature)).toBe(true);
    expect(crypto.verify(null, Buffer.from("other bytes"), publicKey, signature)).toBe(false);
  });
});

describe("verifyHostKeySignature", () => {
  const sessionId = Buffer.from("exchange-hash-stand-in");

  it.each([
    ["ed25519", fakeEd25519ServerKey],
    ["rsa-sha2-256", () => fakeRsaServerKey("rsa-sha2-256")],
    ["rsa-sha2-512", () => fakeRsaServerKey("rsa-sha2-512")],
    ["ecdsa-nistp256", fakeEcdsaServerKey],
  ])("accepts a real %s host-key signature", (_name, make) => {
    const bind = parseSessionBind(Buffer.from(buildSessionBind(make(), sessionId), "base64"));
    expect(bind).not.toBeNull();
    expect(verifyHostKeySignature(bind!)).toBe(true);
  });

  it("rejects a signature made over different bytes", () => {
    const key = fakeEd25519ServerKey();
    const bind = parseSessionBind(
      Buffer.from(
        buildSessionBind(key, sessionId, { signature: key.sign(Buffer.from("not the session id")) }),
        "base64",
      ),
    );
    expect(verifyHostKeySignature(bind!)).toBe(false);
  });

  it("rejects a signature made by a different server", () => {
    const other = fakeEd25519ServerKey();
    const bind = parseSessionBind(
      Buffer.from(
        buildSessionBind(fakeEd25519ServerKey(), sessionId, { signature: other.sign(sessionId) }),
        "base64",
      ),
    );
    expect(verifyHostKeySignature(bind!)).toBe(false);
  });
});

describe("parseSessionBind", () => {
  it("reads is_forwarding as sent", () => {
    const key = fakeEd25519ServerKey();
    const sid = Buffer.from("sid");
    expect(parseSessionBind(Buffer.from(buildSessionBind(key, sid), "base64"))!.isForwarding)
      .toBe(false);
    expect(
      parseSessionBind(
        Buffer.from(buildSessionBind(key, sid, { isForwarding: true }), "base64"),
      )!.isForwarding,
    ).toBe(true);
  });

  it("returns null for a truncated or empty message", () => {
    expect(parseSessionBind(Buffer.alloc(0))).toBeNull();
    expect(parseSessionBind(Buffer.from([0, 0, 0, 4, 1, 2]))).toBeNull();
  });
});

describe("parseUserauthRequest", () => {
  const key = generateSshHostKey("shipit-prod");

  it("reads every field of a real request", () => {
    const data = buildUserauthData({
      sessionId: Buffer.from("sid"),
      user: "deploy",
      publicKeyBlob: key.publicKeyBlob,
    });
    const parsed = parseUserauthRequest(Buffer.from(data, "base64"));
    expect(parsed).toMatchObject({
      user: "deploy",
      service: "ssh-connection",
      method: "publickey",
      hasSignature: true,
      publicKeyBlob: key.publicKeyBlob,
    });
    expect(parsed!.sessionId.toString()).toBe("sid");
  });

  // Rule 4 is what stops the endpoint being a general signing oracle, so
  // anything that is not exactly a userauth request must not parse.
  it("returns null for a non-userauth message type", () => {
    const data = Buffer.concat([
      sshString(Buffer.from("sid")),
      sshByte(20), // SSH_MSG_KEXINIT
      sshString("deploy"),
      sshString("ssh-connection"),
      sshString("publickey"),
      Buffer.from([1]),
      sshString("ssh-ed25519"),
      sshString(Buffer.from(key.publicKeyBlob, "base64")),
    ]);
    expect(parseUserauthRequest(data)).toBeNull();
  });

  it("returns null when bytes trail the request", () => {
    const data = Buffer.concat([
      Buffer.from(
        buildUserauthData({ sessionId: Buffer.from("sid"), user: "deploy", publicKeyBlob: key.publicKeyBlob }),
        "base64",
      ),
      Buffer.from("trailing"),
    ]);
    expect(parseUserauthRequest(data)).toBeNull();
  });

  it("returns null for arbitrary bytes", () => {
    expect(parseUserauthRequest(Buffer.from("please sign this"))).toBeNull();
  });
});

describe("knownHostsLine", () => {
  const key = fakeEd25519ServerKey();

  it("writes the bare host on port 22 and the bracketed form otherwise", () => {
    expect(knownHostsLine("prod.example.com", 22, key.blob))
      .toBe(`prod.example.com ssh-ed25519 ${key.blob}`);
    expect(knownHostsLine("prod.example.com", 2222, key.blob))
      .toBe(`[prod.example.com]:2222 ssh-ed25519 ${key.blob}`);
  });
});

describe("isIpLiteral", () => {
  it("separates addresses that issue no DNS query from names that do", () => {
    expect(isIpLiteral("100.83.12.47")).toBe(true);
    expect(isIpLiteral("10.0.0.1")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
    expect(isIpLiteral("prod.example.com")).toBe(false);
    expect(isIpLiteral("999.1.1.1")).toBe(false);
    expect(isIpLiteral("010.1.1.1")).toBe(false);
  });

  it("gives each family the single-host prefix the firewall admits it by", () => {
    expect(ipLiteralCidr("100.83.12.47")).toBe("100.83.12.47/32");
    expect(ipLiteralCidr("2001:db8::1")).toBe("2001:db8::1/128");
  });
});
