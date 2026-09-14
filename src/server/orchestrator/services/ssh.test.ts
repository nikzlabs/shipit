import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  _resetSshRateLimits,
  listSshIdentities,
  signSshRequest,
  type SshServiceDeps,
  type SshSignRequest,
} from "./ssh.js";
import { ServiceError } from "./types.js";
import { generateSshHostKey, fingerprintOf } from "../ssh-hosts.js";
import {
  buildSessionBind,
  buildUserauthData,
  fakeEd25519ServerKey,
  type FakeServerKey,
} from "../ssh-test-helpers.js";
import type { SshHostPublic } from "../../shared/types.js";
import type { PersistedMessage } from "../chat-history.js";

const SESSION = "sess-1";
const SSH_SESSION_ID = Buffer.from("kex-exchange-hash");

interface Harness {
  deps: SshServiceDeps;
  host: SshHostPublic;
  privateKeyPem: string;
  server: FakeServerKey;
  appended: PersistedMessage[];
  recorded: () => string | undefined;
}

function harness(opts: { granted?: boolean; pinTo?: FakeServerKey } = {}): Harness {
  const generated = generateSshHostKey("shipit-prod");
  const server = fakeEd25519ServerKey();
  let hostKeyBlob: string | undefined = opts.pinTo?.blob;

  const host: SshHostPublic = {
    id: "ssh_1",
    label: "prod",
    address: "prod.example.com",
    port: 22,
    user: "deploy",
    publicKeyBlob: generated.publicKeyBlob,
    publicLine: generated.publicLine,
    fingerprint: generated.fingerprint,
    createdAt: "2026-09-14T00:00:00.000Z",
  };
  const appended: PersistedMessage[] = [];

  const deps: SshServiceDeps = {
    credentialStore: {
      listSshHosts: () => [{
        ...host,
        ...(hostKeyBlob ? { hostKeyFingerprint: fingerprintOf(hostKeyBlob), hostKeyType: "ssh-ed25519" } : {}),
      }],
      getSshHostSigningKey: (id) =>
        id === host.id
          ? { privateKeyPem: generated.privateKeyPem, ...(hostKeyBlob ? { hostKeyBlob } : {}) }
          : undefined,
      recordSshHostKey: (id, blob) => {
        if (id !== host.id || hostKeyBlob) return undefined;
        hostKeyBlob = blob;
        return host;
      },
    },
    sessionManager: {
      get: (id) => (id === SESSION
        ? {
            id: SESSION,
            title: "test",
            createdAt: "2026-09-14T00:00:00.000Z",
            lastUsedAt: "2026-09-14T00:00:00.000Z",
            remoteUrl: "",
            sshHosts: opts.granted === false ? [] : [host.id],
          }
        : undefined),
    },
    chatHistoryManager: {
      append: (_sessionId, message) => { appended.push(message); return appended.length; },
      replaceInProgress: () => undefined,
      hasInProgress: () => false,
    },
  };

  return {
    deps,
    host,
    privateKeyPem: generated.privateKeyPem,
    server,
    appended,
    recorded: () => hostKeyBlob,
  };
}

function validRequest(h: Harness, server?: FakeServerKey): SshSignRequest {
  const key = server ?? h.server;
  return {
    keyBlob: h.host.publicKeyBlob,
    data: buildUserauthData({
      sessionId: SSH_SESSION_ID,
      user: h.host.user,
      publicKeyBlob: h.host.publicKeyBlob,
    }),
    bind: buildSessionBind(key, SSH_SESSION_ID),
  };
}

function refusalOf(fn: () => unknown): ServiceError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ServiceError) return err;
    throw err;
  }
  throw new Error("expected a refusal, but the signer signed");
}

beforeEach(() => {
  _resetSshRateLimits();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listSshIdentities", () => {
  it("answers only the destinations this session is granted", () => {
    const h = harness();
    expect(listSshIdentities(h.deps, SESSION)).toEqual([
      { publicKeyBlob: h.host.publicKeyBlob, comment: "prod (deploy@prod.example.com)" },
    ]);
    expect(listSshIdentities(harness({ granted: false }).deps, SESSION)).toEqual([]);
    expect(listSshIdentities(h.deps, "other-session")).toEqual([]);
  });
});

describe("the signer contract", () => {
  it("signs a complete, bound, correctly-shaped request", () => {
    const h = harness();
    const { signature } = signSshRequest(h.deps, SESSION, validRequest(h));
    expect(Buffer.from(signature, "base64").length).toBeGreaterThan(0);
  });

  // Rule 1 — the grant gate.
  it("refuses a key the session is not granted", () => {
    const h = harness({ granted: false });
    expect(refusalOf(() => signSshRequest(h.deps, SESSION, validRequest(h))).statusCode).toBe(403);
  });

  it("refuses a key blob that is not this destination's", () => {
    const h = harness();
    const stranger = generateSshHostKey("someone-else");
    expect(() =>
      signSshRequest(h.deps, SESSION, { ...validRequest(h), keyBlob: stranger.publicKeyBlob }),
    ).toThrow(/not granted an SSH destination/);
  });

  // Rule 2 — a real key exchange, not a forwarded agent.
  it("refuses when no session binding is present", () => {
    const h = harness();
    const { bind: _omitted, ...unbound } = validRequest(h);
    expect(() => signSshRequest(h.deps, SESSION, unbound)).toThrow(/bound to its server's host key/);
  });

  it("refuses a forwarded agent connection", () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      bind: buildSessionBind(h.server, SSH_SESSION_ID, { isForwarding: true }),
    };
    expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/forwarded agent/);
  });

  it("refuses a binding whose host-key signature does not verify", () => {
    const h = harness();
    const impostor = fakeEd25519ServerKey();
    const request = {
      ...validRequest(h),
      // The blob claims one server; the signature is another's. Only the real
      // host private key can produce this pair, which is what a relay lacks.
      bind: buildSessionBind(h.server, SSH_SESSION_ID, { signature: impostor.sign(SSH_SESSION_ID) }),
    };
    expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/did not verify/);
  });

  it("refuses a malformed binding", () => {
    const h = harness();
    expect(() => signSshRequest(h.deps, SESSION, { ...validRequest(h), bind: "Zm9v" }))
      .toThrow(/well-formed session-bind/);
  });

  // Rule 3 — trust on first use, then pinned.
  it("records the host key on the first bind and shows its fingerprint", () => {
    const h = harness();
    expect(h.recorded()).toBeUndefined();
    signSshRequest(h.deps, SESSION, validRequest(h));
    expect(h.recorded()).toBe(h.server.blob);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].sshHostKey).toMatchObject({
      kind: "recorded",
      hostId: "ssh_1",
      fingerprint: fingerprintOf(h.server.blob),
      keyType: "ssh-ed25519",
    });
  });

  it("refuses a host key that differs from the recorded one, with a warning card", () => {
    const h = harness();
    signSshRequest(h.deps, SESSION, validRequest(h));
    h.appended.length = 0;

    const rebuilt = fakeEd25519ServerKey();
    expect(() => signSshRequest(h.deps, SESSION, validRequest(h, rebuilt)))
      .toThrow(/does not match the one ShipIt recorded/);
    expect(h.appended[0].sshHostKey).toMatchObject({
      kind: "mismatch",
      fingerprint: fingerprintOf(rebuilt.blob),
      recordedFingerprint: fingerprintOf(h.server.blob),
    });
    // The pin does not move on a mismatch; the original key still authenticates.
    expect(h.recorded()).toBe(h.server.blob);
    expect(() => signSshRequest(h.deps, SESSION, validRequest(h))).not.toThrow();
  });

  // Rule 4 — userauth only, this connection, this user.
  it("refuses data that is not a userauth publickey request", () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: Buffer.from("sign this arbitrary challenge").toString("base64"),
    };
    expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/only an SSH publickey/);
  });

  it("refuses a userauth request for a different service or method", () => {
    const h = harness();
    for (const override of [{ service: "ssh-userauth" }, { method: "password" }]) {
      const request = {
        ...validRequest(h),
        data: buildUserauthData({
          sessionId: SSH_SESSION_ID,
          user: h.host.user,
          publicKeyBlob: h.host.publicKeyBlob,
          ...override,
        }),
      };
      expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/only an SSH publickey/);
    }
  });

  it("refuses a request that advertises a different public key", () => {
    const h = harness();
    const stranger = generateSshHostKey("someone-else");
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: h.host.user,
        publicKeyBlob: stranger.publicKeyBlob,
      }),
    };
    expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/only an SSH publickey/);
  });

  it("refuses a request belonging to a different SSH connection", () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: Buffer.from("a different connection's exchange hash"),
        user: h.host.user,
        publicKeyBlob: h.host.publicKeyBlob,
      }),
    };
    expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/different SSH connection/);
  });

  it("refuses a request that authenticates as another user", () => {
    const h = harness();
    const request = {
      ...validRequest(h),
      data: buildUserauthData({
        sessionId: SSH_SESSION_ID,
        user: "root",
        publicKeyBlob: h.host.publicKeyBlob,
      }),
    };
    expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/authenticates as deploy, not root/);
  });

  // Rule 5 — the per-session bound.
  it("refuses once the per-session attempt rate is exceeded", () => {
    const h = harness();
    const request = validRequest(h);
    for (let i = 0; i < 60; i++) signSshRequest(h.deps, SESSION, request);
    expect(() => signSshRequest(h.deps, SESSION, request)).toThrow(/Too many SSH authentication/);
  });

  it("lets the rate window pass", () => {
    const h = harness();
    const request = validRequest(h);
    let now = 1_000_000;
    const timed: SshServiceDeps = { ...h.deps, now: () => now };
    for (let i = 0; i < 60; i++) signSshRequest(timed, SESSION, request);
    expect(() => signSshRequest(timed, SESSION, request)).toThrow(/Too many SSH authentication/);
    now += 61_000;
    expect(() => signSshRequest(timed, SESSION, request)).not.toThrow();
  });
});

describe("the audit line", () => {
  it("records one line per attempt with the outcome, and no signing input", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness();
    const request = validRequest(h);
    signSshRequest(h.deps, SESSION, request);
    expect(() => signSshRequest(harness({ granted: false }).deps, SESSION, request)).toThrow();

    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[ssh-sign]"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`session=${SESSION}`);
    expect(lines[0]).toContain("destination=prod[ssh_1]");
    expect(lines[0]).toContain("address=prod.example.com:22");
    expect(lines[0]).toContain("user=deploy");
    expect(lines[0]).toContain("outcome=signed");
    expect(lines[1]).toContain("outcome=refused");
    expect(lines[1]).toContain("reason=not-granted");

    // A signature, a key blob or the data being signed in a log line is exactly
    // the leak this design exists to prevent.
    for (const line of lines) {
      expect(line).not.toContain(request.data);
      expect(line).not.toContain(request.keyBlob);
      expect(line).not.toContain(request.bind);
      expect(line).not.toContain(h.privateKeyPem.split("\n")[1]);
    }
  });
});
